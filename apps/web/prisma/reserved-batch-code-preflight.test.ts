import { describe, expect, it } from "vitest";

import { RESERVED_BATCH_CODE_SQL_PATTERN } from "@/lib/inventory/reserved-batch-code";

import {
  formatReservedBatchCodeReport,
  nonCanonicalReservedRows,
  reservedShapedBatchCodeSql,
  type ReservedBatchCodeRow,
} from "./reserved-batch-code-preflight";

// --------------------------------------------------------------------------
// El chequeo de datos del código reservado.
//
// Lo que se prueba acá sin base: que la consulta use el MISMO patrón que el
// código —si se escribiera aparte, dejaría de ver justo las filas que existe
// para encontrar— y que la decisión de qué fila está mal la tome la MISMA
// derivación que usa el repositorio.
// --------------------------------------------------------------------------

const ENERO_15 = new Date("2027-01-15T05:00:00.000Z"); // 00:00 Bogotá

function fila(overrides: Partial<ReservedBatchCodeRow> = {}): ReservedBatchCodeRow {
  return {
    batchCode: "SIN LOTE 2027-01-15",
    expiresAt: ENERO_15,
    quantity: 10,
    productName: "Acetaminofén 500mg",
    productCode: "P-001",
    ...overrides,
  };
}

describe("reservedShapedBatchCodeSql", () => {
  it("busca con el patrón COMPARTIDO, no con uno propio", () => {
    expect(reservedShapedBatchCodeSql()).toContain(
      RESERVED_BATCH_CODE_SQL_PATTERN,
    );
  });

  it("normaliza en la base igual que en el código: recorta, colapsa y sube", () => {
    const sql = reservedShapedBatchCodeSql();

    expect(sql).toContain("upper(");
    expect(sql).toContain("btrim(");
    expect(sql).toContain("regexp_replace(");
  });

  // Un preflight que escribe no es un preflight.
  it("solo lee", () => {
    const sql = reservedShapedBatchCodeSql().toUpperCase();

    for (const verbo of ["INSERT", "UPDATE", "DELETE", "ALTER", "DROP", "CREATE"]) {
      expect(sql).not.toContain(verbo);
    }
  });
});

describe("nonCanonicalReservedRows", () => {
  it("no denuncia una fila que el sistema mismo escribió", () => {
    expect(nonCanonicalReservedRows([fila()])).toEqual([]);
  });

  it("no denuncia la forma pelada sin vencimiento", () => {
    expect(
      nonCanonicalReservedRows([fila({ batchCode: "SIN LOTE", expiresAt: null })]),
    ).toEqual([]);
  });

  it("denuncia una fila cuya fecha NO es la del código", () => {
    const mala = fila({ expiresAt: new Date("2027-06-01T05:00:00.000Z") });

    expect(nonCanonicalReservedRows([mala])).toEqual([mala]);
  });

  it("denuncia la forma pelada con vencimiento", () => {
    const mala = fila({ batchCode: "SIN LOTE" });

    expect(nonCanonicalReservedRows([mala])).toEqual([mala]);
  });

  it("denuncia la forma con fecha sin vencimiento", () => {
    const mala = fila({ expiresAt: null });

    expect(nonCanonicalReservedRows([mala])).toEqual([mala]);
  });

  it("denuncia una variante que se lee igual pero no es la canónica", () => {
    const mala = fila({ batchCode: "sin lote 2027-01-15" });

    expect(nonCanonicalReservedRows([mala])).toEqual([mala]);
  });
});

describe("formatReservedBatchCodeReport", () => {
  it("nombra el producto y el lote para poder encontrar la fila", () => {
    const informe = formatReservedBatchCodeReport([fila({ batchCode: "SIN LOTE" })]);

    expect(informe).toContain("Acetaminofén 500mg");
    expect(informe).toContain("P-001");
    expect(informe).toContain("SIN LOTE");
  });

  // El informe termina en el log del despliegue: no lleva ids internos ni nada
  // que no sirva para encontrar la caja en el estante.
  it("no expone ids internos", () => {
    const informe = formatReservedBatchCodeReport([
      fila({ batchCode: "SIN LOTE" }),
    ]);

    expect(informe).not.toContain("productId");
    expect(informe).not.toContain("cuid");
  });
});
