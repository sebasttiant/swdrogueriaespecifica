import { describe, expect, it } from "vitest";

import {
  RESERVED_BATCH_CODE,
  RESERVED_BATCH_CODE_SQL_PATTERN,
  deriveReservedBatchCode,
  hasReservedBatchCodeShape,
  normalizeBatchCode,
} from "./reserved-batch-code";

// --------------------------------------------------------------------------
// La representación interna de "esta caja no trae lote".
//
// El código reservado se DERIVA, nunca se escribe a mano. Estas pruebas fijan
// las dos mitades de esa regla: qué deriva el sistema, y qué formas cuentan
// como reservadas cuando hay que rechazar una escritura manual.
// --------------------------------------------------------------------------

describe("normalizeBatchCode", () => {
  it("recorta los extremos", () => {
    expect(normalizeBatchCode("  L-2027-001  ")).toBe("L-2027-001");
  });

  it("colapsa los espacios internos a uno solo", () => {
    expect(normalizeBatchCode("SIN   LOTE")).toBe("SIN LOTE");
    expect(normalizeBatchCode("SIN\tLOTE")).toBe("SIN LOTE");
  });

  it("compara en mayúsculas", () => {
    expect(normalizeBatchCode("sin lote")).toBe("SIN LOTE");
  });

  it("deja intacto un código real", () => {
    expect(normalizeBatchCode("l-2027-001")).toBe("L-2027-001");
  });
});

describe("hasReservedBatchCodeShape", () => {
  it("reconoce la forma pelada", () => {
    expect(hasReservedBatchCodeShape("SIN LOTE")).toBe(true);
  });

  it("reconoce la forma con fecha", () => {
    expect(hasReservedBatchCodeShape("SIN LOTE 2027-01-15")).toBe(true);
  });

  // El rechazo es la forma EXACTA, no un prefijo: "SIN LOTES DEL PROVEEDOR" es
  // un código que alguien puede tener impreso en una caja de verdad.
  it("no reconoce un código que solo EMPIEZA parecido", () => {
    expect(hasReservedBatchCodeShape("SIN LOTES DEL PROVEEDOR")).toBe(false);
    expect(hasReservedBatchCodeShape("SIN LOTE X")).toBe(false);
    expect(hasReservedBatchCodeShape("SIN LOTE 2027-01")).toBe(false);
  });

  it("no reconoce un código real", () => {
    expect(hasReservedBatchCodeShape("L-2027-001")).toBe(false);
  });
});

describe("deriveReservedBatchCode", () => {
  it("con vencimiento conocido lleva la fecha adentro", () => {
    // 00:00 del 15 de enero en Bogotá (UTC-5) es 05:00 UTC.
    const expiresAt = new Date("2027-01-15T05:00:00.000Z");

    expect(deriveReservedBatchCode(expiresAt)).toBe("SIN LOTE 2027-01-15");
  });

  // La fecha es el DÍA de Bogotá, no el de UTC: un instante de la tarde de
  // Bogotá cae en el día siguiente en UTC, y el lote diría otra fecha que la
  // que la persona eligió.
  it("usa el día de calendario de Bogotá, no el de UTC", () => {
    const tardeEnBogota = new Date("2027-01-15T23:00:00.000Z"); // 18:00 Bogotá

    expect(deriveReservedBatchCode(tardeEnBogota)).toBe("SIN LOTE 2027-01-15");
  });

  it("sin vencimiento es la forma pelada", () => {
    expect(deriveReservedBatchCode(null)).toBe(RESERVED_BATCH_CODE);
    expect(deriveReservedBatchCode(null)).toBe("SIN LOTE");
  });

  it("lo que deriva SIEMPRE tiene la forma reservada", () => {
    expect(hasReservedBatchCodeShape(deriveReservedBatchCode(null))).toBe(true);
    expect(
      hasReservedBatchCodeShape(
        deriveReservedBatchCode(new Date("2027-01-15T05:00:00.000Z")),
      ),
    ).toBe(true);
  });
});

// El chequeo de datos corre en PostgreSQL y tiene que reconocer EXACTAMENTE las
// mismas formas que el código. Si los dos patrones se escribieran por separado,
// divergirían en el primer cambio y el chequeo dejaría de ver justo las filas
// que existe para encontrar.
describe("RESERVED_BATCH_CODE_SQL_PATTERN", () => {
  it("es el mismo patrón que usa el predicado", () => {
    const sql = new RegExp(RESERVED_BATCH_CODE_SQL_PATTERN);

    expect(sql.test("SIN LOTE")).toBe(true);
    expect(sql.test("SIN LOTE 2027-01-15")).toBe(true);
    expect(sql.test("SIN LOTES DEL PROVEEDOR")).toBe(false);
    expect(sql.test("L-2027-001")).toBe(false);
  });
});
