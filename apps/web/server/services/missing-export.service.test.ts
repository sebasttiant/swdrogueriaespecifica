import { describe, expect, it } from "vitest";

import type { MissingItemListItem } from "@/server/repositories/missing-item.repository";

import {
  buildMissingCsv,
  buildMissingExportRows,
  missingExportColumns,
} from "./missing-export.service";

function item(overrides: Partial<MissingItemListItem> = {}): MissingItemListItem {
  return {
    id: "m-1",
    quantity: 4,
    orderedQuantity: null,
    note: null,
    status: "FALTANTE",
    originId: null,
    confirmedAt: null,
    confirmedById: null,
    confirmationNote: null,
    orderedAt: null,
    orderedById: null,
    supplierId: null,
    sellerCode: null,
    createdAt: new Date("2026-07-01T00:00:00.000Z"),
    product: {
      id: "p-1",
      name: "Acetaminofén 500mg",
      code: "ACE-500",
      unit: "unidad",
      laboratory: { id: "lab-1", name: "Genfar" },
    },
    origin: null,
    supplier: { id: "sup-1", name: "Distribuidora Norte" },
    confirmedBy: null,
    createdBy: null,
    ...overrides,
  };
}

describe("buildMissingExportRows", () => {
  it("maps each item to the export columns", () => {
    const [row] = buildMissingExportRows([item()], true);

    expect(row).toEqual({
      nombre: "Acetaminofén 500mg",
      laboratorio: "Genfar",
      cantidad: "",
      codigoVendedor: "",
      estado: "Faltante",
      proveedor: "Distribuidora Norte",
    });
  });

  it("uses empty strings when laboratory or supplier are missing", () => {
    const [row] = buildMissingExportRows([
      item({
        product: {
          id: "p-2",
          name: "Sin lab",
          code: "X-1",
          unit: "unidad",
          laboratory: null,
        },
        supplier: null,
      }),
    ], true);

    expect(row!.laboratorio).toBe("");
    expect(row!.proveedor).toBe("");
  });

  it("exports seller code instead of the manual quantity sentinel", () => {
    const [manual, automatic] = buildMissingExportRows([
      item({ originId: null, quantity: 1, sellerCode: "VEN-12" }),
      item({ originId: "pending-1", quantity: 4, sellerCode: null }),
    ], true);

    expect(manual).toMatchObject({ cantidad: "", codigoVendedor: "VEN-12" });
    expect(automatic).toMatchObject({ cantidad: 4, codigoVendedor: "" });
  });

  it("maps every status to its Spanish label", () => {
    const rows = buildMissingExportRows([
      item({ status: "FALTANTE" }),
      item({ status: "PEDIDO" }),
      item({ status: "RECIBIDO" }),
      item({ status: "CANCELADO" }),
    ], true);

    expect(rows.map((r) => r.estado)).toEqual([
      "Faltante",
      "Pedido",
      "Recibido",
      "Cancelado",
    ]);
  });
});

describe("buildMissingCsv", () => {
  it("starts with a UTF-8 BOM so Excel keeps the accents", () => {
    const csv = buildMissingCsv([], true);

    expect(csv.charCodeAt(0)).toBe(0xfeff);
  });

  it("writes the header row with quantity and seller code columns", () => {
    const csv = buildMissingCsv([], true);
    const firstLine = csv.slice(1).split("\r\n")[0];

    expect(firstLine).toBe(
      '"Nombre","Laboratorio","Cantidad","Código vendedor","Estado","Proveedor"',
    );
  });

  it("writes one CRLF-separated line per row with quoted cells", () => {
    const csv = buildMissingCsv(
      buildMissingExportRows([item({ product: { id: "p", name: "Aspirina", code: "A", unit: "u", laboratory: { id: "l", name: "Bayer" } } })], true),
      true,
    );
    const lines = csv.slice(1).split("\r\n");

    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe('"Aspirina","Bayer","","","Faltante","Distribuidora Norte"');
  });

  // CSV injection: un valor que empieza con '=' no debe evaluarse en Excel.
  it("neutralizes values Excel would treat as a formula", () => {
    const csv = buildMissingCsv([
      { nombre: "=SUM(A1:A9)", laboratorio: "Lab", cantidad: 1, codigoVendedor: "", estado: "Faltante", proveedor: "" },
    ], true);
    const dataLine = csv.slice(1).split("\r\n")[1];

    expect(dataLine).toBe('"\'=SUM(A1:A9)","Lab","1","","Faltante",""');
  });

  // Una coma o una comilla en el nombre no debe romper la estructura del CSV.
  it("escapes commas and double quotes inside a field", () => {
    const csv = buildMissingCsv([
      { nombre: 'Suero, "grande"', laboratorio: "Lab", cantidad: 1, codigoVendedor: "", estado: "Faltante", proveedor: "" },
    ], true);
    const dataLine = csv.slice(1).split("\r\n")[1];

    expect(dataLine).toBe('"Suero, ""grande""","Lab","1","","Faltante",""');
  });
});

// Un archivo descargado se reenvía por WhatsApp y se guarda en un celular. La
// identidad del proveedor tiene que quedar fuera del BYTE, no de la pantalla.
describe("export · el proveedor no viaja en el archivo del vendedor", () => {
  const rows = () =>
    buildMissingExportRows(
      [
        item({
          product: {
            id: "p",
            name: "Loratadina 10mg",
            code: "MED-003",
            unit: "caja",
            laboratory: { id: "l", name: "Genfar" },
          },
        }),
      ],
      false,
    );

  it("no arma la columna Proveedor: va ausente, no vacía", () => {
    expect(missingExportColumns(false).map((column) => column.key)).toEqual([
      "nombre",
      "laboratorio",
      "cantidad",
      "codigoVendedor",
      "estado",
    ]);
    expect(missingExportColumns(true).map((column) => column.key)).toContain(
      "proveedor",
    );
  });

  it("no mete el nombre del proveedor en la fila, ni para descartarlo después", () => {
    expect(rows()[0]!.proveedor).toBe("");
  });

  it("el CSV no trae ni el encabezado ni el dato", () => {
    const csv = buildMissingCsv(rows(), false);

    expect(csv).not.toContain("Proveedor");
    expect(csv).not.toContain("Distribuidora Norte");
    // Lo operativo sigue estando.
    expect(csv).toContain("Loratadina 10mg");
  });

  it("el CSV de gerencia sí lo trae", () => {
    const managementRows = buildMissingExportRows(
      [
        item({
          product: {
            id: "p",
            name: "Loratadina 10mg",
            code: "MED-003",
            unit: "caja",
            laboratory: { id: "l", name: "Genfar" },
          },
        }),
      ],
      true,
    );
    const csv = buildMissingCsv(managementRows, true);

    expect(csv).toContain("Proveedor");
    expect(csv).toContain("Distribuidora Norte");
  });
});
