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
  EN_BODEGA: "En bodega",
  RECIBIDO: "Recibido",
  CANCELADO: "Cancelado",
};

export type MissingExportRow = {
  nombre: string;
  laboratorio: string;
  cantidad: number | "";
  codigoVendedor: string;
  estado: string;
  proveedor: string;
};

// Orden y encabezados de las columnas, fuente única para CSV y Excel.
export const MISSING_EXPORT_COLUMNS = [
  { key: "nombre", header: "Nombre" },
  { key: "laboratorio", header: "Laboratorio" },
  { key: "cantidad", header: "Cantidad" },
  { key: "codigoVendedor", header: "Código vendedor" },
  { key: "estado", header: "Estado" },
  { key: "proveedor", header: "Proveedor" },
] as const satisfies readonly { key: keyof MissingExportRow; header: string }[];

export type MissingExportColumn = { key: keyof MissingExportRow; header: string };

/**
 * Columnas del export según quién lo descarga. Sin `canViewSupplierIdentity`
 * la columna "Proveedor" NO EXISTE en el archivo: no va vacía, va ausente.
 *
 * Fuente única para CSV y Excel: ambos recorren esta lista, así que no pueden
 * quedar desalineados y filtrar la columna en uno de los dos formatos.
 */
export function missingExportColumns(
  canViewSupplierIdentity: boolean,
): readonly MissingExportColumn[] {
  return canViewSupplierIdentity
    ? MISSING_EXPORT_COLUMNS
    : MISSING_EXPORT_COLUMNS.filter((column) => column.key !== "proveedor");
}

/**
 * `canViewSupplierIdentity` es REQUERIDO, sin default: olvidarlo tiene que ser
 * un error de tipos y no una fuga silenciosa. Cuando es false el nombre del
 * proveedor nunca entra a la fila, ni siquiera para descartarse después.
 */
export function buildMissingExportRows(
  items: readonly MissingItemListItem[],
  canViewSupplierIdentity: boolean,
): MissingExportRow[] {
  return items.map((item) => ({
    nombre: item.product.name,
    laboratorio: item.product.laboratory?.name ?? "",
    cantidad: item.originId === null ? "" : item.quantity,
    codigoVendedor: item.originId === null ? (item.sellerCode ?? "") : "",
    estado: MISSING_STATUS_LABEL[item.status],
    proveedor: canViewSupplierIdentity ? (item.supplier?.name ?? "") : "",
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

export function buildMissingCsv(
  rows: readonly MissingExportRow[],
  canViewSupplierIdentity: boolean,
): string {
  const columns = missingExportColumns(canViewSupplierIdentity);
  const header = columns.map((column) => csvCell(column.header));
  const lines = [header.join(",")];

  for (const row of rows) {
    const cells = columns.map((column) => csvCell(row[column.key]));
    lines.push(cells.join(","));
  }

  return CSV_BOM + lines.join("\r\n");
}

// Colores de marca para el encabezado (ARGB, sin '#'), como en reports-export.
const HEADER_FILL = "FF0B66C3"; // primary
const HEADER_FONT = "FFFFFFFF"; // blanco

export async function buildMissingWorkbookBuffer(
  rows: readonly MissingExportRow[],
  canViewSupplierIdentity: boolean,
  generatedAt: Date = new Date(),
): Promise<Buffer> {
  // Import dinámico: mantiene exceljs fuera del grafo estático (test liviano).
  const ExcelJS = (await import("exceljs")).default;

  const wb = new ExcelJS.Workbook();
  wb.creator = "Droguería Específica";
  wb.created = generatedAt;

  const columns = missingExportColumns(canViewSupplierIdentity);

  // Anchos por columna, indexados por `key`, para que quitar "Proveedor" no
  // desplace los anchos del resto.
  const COLUMN_WIDTH: Record<keyof MissingExportRow, number> = {
    nombre: 36,
    laboratorio: 24,
    cantidad: 10,
    codigoVendedor: 18,
    estado: 14,
    proveedor: 24,
  };

  const ws = wb.addWorksheet("Faltantes");
  ws.columns = columns.map((column) => ({ width: COLUMN_WIDTH[column.key] }));

  const header = ws.addRow(columns.map((column) => column.header));
  header.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: HEADER_FONT } };
    cell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: HEADER_FILL },
    };
  });

  for (const row of rows) {
    ws.addRow(columns.map((column) => row[column.key]));
  }

  const buffer = await wb.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
