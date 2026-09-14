import { describe, expect, it } from "vitest";

import { inventoryEntryCreateSchema } from "./schema";

// Payload mínimo válido: lo que el formulario manda hoy, sin laboratorio. Es el
// que prueba que el campo nuevo NO volvió obligatoria una entrada que antes
// pasaba — la recepción de una caja no puede quedar trabada porque nadie sepa
// el laboratorio.
const BASE = {
  productId: "prod-1",
  quantity: "10",
  batchCode: "LOTE-001",
  expiresAt: "2027-01-01T10:00",
  idempotencyKey: "00000000-0000-4000-8000-000000000001",
  // Toda entrada declara la fotografía del producto que la pantalla mostró.
  expectedIdentityVersion: "0",
  expectedCatalogVersion: "0",
};

describe("inventoryEntryCreateSchema · laboratorio recibido", () => {
  it("acepta una entrada SIN laboratorio", () => {
    const parsed = inventoryEntryCreateSchema.safeParse(BASE);

    expect(parsed.success).toBe(true);
    expect(parsed.data?.receivedLaboratoryId).toBeUndefined();
    expect(parsed.data?.receivedLaboratoryName).toBeUndefined();
  });

  it("acepta el id del laboratorio cuando la persona eligió uno de la lista", () => {
    const parsed = inventoryEntryCreateSchema.safeParse({
      ...BASE,
      receivedLaboratoryId: "lab-mk",
    });

    expect(parsed.success).toBe(true);
    expect(parsed.data?.receivedLaboratoryId).toBe("lab-mk");
  });

  it("acepta SOLO el nombre cuando lo escribió sin elegir de la lista", () => {
    const parsed = inventoryEntryCreateSchema.safeParse({
      ...BASE,
      receivedLaboratoryName: "MK",
    });

    expect(parsed.success).toBe(true);
    expect(parsed.data?.receivedLaboratoryName).toBe("MK");
  });

  // FormData manda cadenas vacías, no `undefined`, cuando un campo se dejó en
  // blanco. Persistirlas sería registrar "" como si fuera un laboratorio.
  it("normaliza vacío y espacios a undefined, no a cadena vacía", () => {
    const parsed = inventoryEntryCreateSchema.safeParse({
      ...BASE,
      receivedLaboratoryId: "",
      receivedLaboratoryName: "   ",
    });

    expect(parsed.success).toBe(true);
    expect(parsed.data?.receivedLaboratoryId).toBeUndefined();
    expect(parsed.data?.receivedLaboratoryName).toBeUndefined();
  });

  it("sigue exigiendo lo que ya era obligatorio", () => {
    expect(inventoryEntryCreateSchema.safeParse({
      ...BASE,
      productId: "",
      receivedLaboratoryName: "MK",
    }).success).toBe(false);
  });
});

// --------------------------------------------------------------------------
// El lote es OPCIONAL: una caja puede llegar sin número impreso.
//
// Lo que NO puede llegar es el código reservado escrito a mano. Ese código lo
// deriva el sistema y lleva el vencimiento adentro; escrito a mano, el lote
// termina afirmando un vencimiento que no es el suyo.
// --------------------------------------------------------------------------
describe("inventoryEntryCreateSchema · código de lote", () => {
  const RESERVADO = /reservado/i;

  it("acepta una entrada SIN código de lote", () => {
    const parsed = inventoryEntryCreateSchema.safeParse({
      ...BASE,
      batchCode: "",
    });

    expect(parsed.success).toBe(true);
    expect(parsed.data?.batchCode).toBeUndefined();
  });

  it("acepta que el campo no viaje en absoluto", () => {
    const { batchCode: _sinLote, ...sinCampo } = BASE;

    const parsed = inventoryEntryCreateSchema.safeParse(sinCampo);

    expect(parsed.success).toBe(true);
    expect(parsed.data?.batchCode).toBeUndefined();
  });

  it.each([
    ["SIN LOTE"],
    ["sin lote"],
    ["  SIN   LOTE  "],
    ["SIN LOTE 2027-01-15"],
  ])("rechaza el código reservado escrito a mano: %s", (batchCode) => {
    const parsed = inventoryEntryCreateSchema.safeParse({ ...BASE, batchCode });

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toMatch(RESERVADO);
  });

  // El rechazo es la forma EXACTA, no un prefijo: estos dos son códigos que
  // alguien puede tener impresos en una caja de verdad.
  it.each([["L-2027-001"], ["SIN LOTES DEL PROVEEDOR"]])(
    "acepta un código real: %s",
    (batchCode) => {
      const parsed = inventoryEntryCreateSchema.safeParse({ ...BASE, batchCode });

      expect(parsed.success).toBe(true);
      expect(parsed.data?.batchCode).toBe(batchCode);
    },
  );
});

// --------------------------------------------------------------------------
// El vencimiento llega SIN hora desde el 2026-10-04. El schema sigue aceptando
// el formato viejo para no invalidar un envío en vuelo durante el despliegue.
// --------------------------------------------------------------------------
describe("inventoryEntryCreateSchema · fecha de vencimiento", () => {
  it("acepta la fecha sin hora que manda el formulario", () => {
    const parsed = inventoryEntryCreateSchema.safeParse({
      ...BASE,
      expiresAt: "2027-01-01",
    });

    expect(parsed.success).toBe(true);
    // 00:00 en Bogotá (UTC-5) es 05:00 UTC: el instante cae dentro del día que
    // la persona eligió, que es lo que después lee `expiryLevel`.
    expect(parsed.data?.expiresAt?.toISOString()).toBe("2027-01-01T05:00:00.000Z");
  });

  it("sigue aceptando el formato viejo con hora", () => {
    const parsed = inventoryEntryCreateSchema.safeParse(BASE);

    expect(parsed.success).toBe(true);
    expect(parsed.data?.expiresAt?.toISOString()).toBe("2027-01-01T15:00:00.000Z");
  });

  it("rechaza una fecha que no existe", () => {
    const parsed = inventoryEntryCreateSchema.safeParse({
      ...BASE,
      expiresAt: "2027-02-30",
    });

    expect(parsed.success).toBe(false);
  });

  // El vencimiento es OPCIONAL: hay mercadería que no vence, y hay cajas que no
  // lo traen impreso. Vacío es NULL —desconocido—, nunca una fecha inventada.
  it("acepta una entrada SIN vencimiento y la deja en null", () => {
    const parsed = inventoryEntryCreateSchema.safeParse({
      ...BASE,
      expiresAt: "",
    });

    expect(parsed.success).toBe(true);
    expect(parsed.data?.expiresAt).toBeNull();
  });

  it("acepta que el campo no viaje en absoluto", () => {
    const { expiresAt: _sinFecha, ...sinCampo } = BASE;

    const parsed = inventoryEntryCreateSchema.safeParse(sinCampo);

    expect(parsed.success).toBe(true);
    expect(parsed.data?.expiresAt).toBeNull();
  });
});
