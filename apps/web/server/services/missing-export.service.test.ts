import { describe, expect, it } from "vitest";

import type { MissingItemListItem } from "@/server/repositories/missing-item.repository";

import { buildMissingCsv, buildMissingExportRows } from "./missing-export.service";

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
    const [row] = buildMissingExportRows([item()]);

    expect(row).toEqual({
      nombre: "Acetaminofén 500mg",
      laboratorio: "Genfar",
      cantidad: 4,
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
    ]);

    expect(row!.laboratorio).toBe("");
    expect(row!.proveedor).toBe("");
  });

  it("maps every status to its Spanish label", () => {
    const rows = buildMissingExportRows([
      item({ status: "FALTANTE" }),
      item({ status: "PEDIDO" }),
      item({ status: "RECIBIDO" }),
      item({ status: "CANCELADO" }),
    ]);

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
    const csv = buildMissingCsv([]);

    expect(csv.charCodeAt(0)).toBe(0xfeff);
  });

  it("writes the header row with the five columns", () => {
    const csv = buildMissingCsv([]);
    const firstLine = csv.slice(1).split("\r\n")[0];

    expect(firstLine).toBe(
      '"Nombre","Laboratorio","Cantidad","Estado","Proveedor"',
    );
  });

  it("writes one CRLF-separated line per row with quoted cells", () => {
    const csv = buildMissingCsv(
      buildMissingExportRows([item({ product: { id: "p", name: "Aspirina", code: "A", unit: "u", laboratory: { id: "l", name: "Bayer" } } })]),
    );
    const lines = csv.slice(1).split("\r\n");

    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe('"Aspirina","Bayer","4","Faltante","Distribuidora Norte"');
  });

  // CSV injection: un valor que empieza con '=' no debe evaluarse en Excel.
  it("neutralizes values Excel would treat as a formula", () => {
    const csv = buildMissingCsv([
      { nombre: "=SUM(A1:A9)", laboratorio: "Lab", cantidad: 1, estado: "Faltante", proveedor: "" },
    ]);
    const dataLine = csv.slice(1).split("\r\n")[1];

    expect(dataLine).toBe('"\'=SUM(A1:A9)","Lab","1","Faltante",""');
  });

  // Una coma o una comilla en el nombre no debe romper la estructura del CSV.
  it("escapes commas and double quotes inside a field", () => {
    const csv = buildMissingCsv([
      { nombre: 'Suero, "grande"', laboratorio: "Lab", cantidad: 1, estado: "Faltante", proveedor: "" },
    ]);
    const dataLine = csv.slice(1).split("\r\n")[1];

    expect(dataLine).toBe('"Suero, ""grande""","Lab","1","Faltante",""');
  });
});
