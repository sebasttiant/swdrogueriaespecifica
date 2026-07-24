// --------------------------------------------------------------------------
// Exportación de la cola de faltantes (Mejora 3). Mismo esqueleto que
// `reports-export.service.ts`:
//
//  - `buildMissingExportRows`: PURO. Aplana cada faltante a las columnas de
//    export (Nombre, Laboratorio, Cantidad, Estado, Proveedor). Testeable.
//  - `buildMissingCsv`: PURO. CSV RFC-4180 con BOM UTF-8 para que Excel en
//    español lo abra sin romper acentos ni el separador.
//  - `buildMissingWorkbookBuffer`: render con exceljs (import DINÁMICO, así la
//    librería queda fuera del grafo estático y el test no la carga).
//
// El PDF NO vive acá: se genera con la impresión nativa del navegador
// (window.print), igual que en reportes. Sin dependencias.
// --------------------------------------------------------------------------

import type {
  MissingItemListItem,
} from "@/server/repositories/missing-item.repository";
import type { MissingItemStatus } from "@/lib/generated/prisma/client";

// Etiquetas de estado para el export. Coinciden con los badges de la lista.
const MISSING_STATUS_LABEL: Record<MissingItemStatus, string> = {
  FALTANTE: "Faltante",
  PEDIDO: "Pedido",
  RECIBIDO: "Recibido",
  CANCELADO: "Cancelado",
};

export type MissingExportRow = {
  nombre: string;
  laboratorio: string;
  cantidad: number;
  estado: string;
  proveedor: string;
};

// Orden y encabezados de las columnas, fuente única para CSV y Excel.
export const MISSING_EXPORT_COLUMNS = [
  { key: "nombre", header: "Nombre" },
  { key: "laboratorio", header: "Laboratorio" },
  { key: "cantidad", header: "Cantidad" },
  { key: "estado", header: "Estado" },
  { key: "proveedor", header: "Proveedor" },
] as const satisfies readonly { key: keyof MissingExportRow; header: string }[];

export function buildMissingExportRows(
  items: readonly MissingItemListItem[],
): MissingExportRow[] {
  return items.map((item) => ({
    nombre: item.product.name,
    laboratorio: item.product.laboratory?.name ?? "",
    cantidad: item.quantity,
    estado: MISSING_STATUS_LABEL[item.status],
    proveedor: item.supplier?.name ?? "",
  }));
}

// Escapa un campo CSV RFC-4180: siempre entre comillas (seguro para comas,
// saltos de línea y comillas), duplicando las comillas internas.
//
// Mitigación de CSV injection (OWASP): si el valor empieza con un carácter que
// Excel/Sheets interpretaría como fórmula, se antepone un apóstrofo. El dato es
// interno (catálogo), pero un producto MANUAL lo escribe un vendedor y podría
// empezar con '=' y evaluarse al abrir el archivo.
function csvCell(value: string | number): string {
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) {
    text = `'${text}`;
  }
  return `"${text.replace(/"/g, '""')}"`;
}

// BOM UTF-8: sin él, Excel en Windows abre el CSV en la codificación local y
// rompe los acentos. CRLF entre filas: el estándar de Excel.
const CSV_BOM = "﻿";

export function buildMissingCsv(rows: readonly MissingExportRow[]): string {
  const header = MISSING_EXPORT_COLUMNS.map((column) => csvCell(column.header));
  const lines = [header.join(",")];

  for (const row of rows) {
    const cells = MISSING_EXPORT_COLUMNS.map((column) => csvCell(row[column.key]));
    lines.push(cells.join(","));
  }

  return CSV_BOM + lines.join("\r\n");
}

// Colores de marca para el encabezado (ARGB, sin '#'), como en reports-export.
const HEADER_FILL = "FF0B66C3"; // primary
const HEADER_FONT = "FFFFFFFF"; // blanco

export async function buildMissingWorkbookBuffer(
  rows: readonly MissingExportRow[],
  generatedAt: Date = new Date(),
): Promise<Buffer> {
  // Import dinámico: mantiene exceljs fuera del grafo estático (test liviano).
  const ExcelJS = (await import("exceljs")).default;

  const wb = new ExcelJS.Workbook();
  wb.creator = "Droguería Específica";
  wb.created = generatedAt;

  const ws = wb.addWorksheet("Faltantes");
  ws.columns = [
    { width: 36 },
    { width: 24 },
    { width: 10 },
    { width: 14 },
    { width: 24 },
  ];

  const header = ws.addRow(MISSING_EXPORT_COLUMNS.map((column) => column.header));
  header.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: HEADER_FONT } };
    cell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: HEADER_FILL },
    };
  });

  for (const row of rows) {
    ws.addRow([row.nombre, row.laboratorio, row.cantidad, row.estado, row.proveedor]);
  }

  const buffer = await wb.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
