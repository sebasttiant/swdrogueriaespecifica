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
      batchCode: "",
      receivedLaboratoryName: "MK",
    }).success).toBe(false);
  });
});
