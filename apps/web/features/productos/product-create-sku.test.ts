import { describe, expect, it } from "vitest";

import { productCreateSchema } from "./schema";

// --------------------------------------------------------------------------
// Un producto tiene que poder NACER con su SKU.
//
// Hoy el alta pide código interno, nombre, unidad, mínimos y laboratorio, y
// nada más. `product.actions.ts` nunca lee `orionCode`. Consecuencia: TODO
// producto que se crea nace sin identidad, cae en la cola de "Revisión de
// identidad" y bloquea la entrada cuando llega la caja.
//
// Es decir: el alta FABRICA el problema que el rechazo de la entrada existe
// para atajar. Quien da de alta un producto casi siempre tiene el código
// delante —está en la caja o en la factura del proveedor—; no ofrecerle el
// campo es obligarlo a volver después por una segunda pantalla.
//
// Opcional, no obligatorio: el producto nuevo sin código todavía existe
// (`NEW_PRODUCT` es un motivo válido de aplazamiento) y exigirlo acá cerraría
// un alta legítima.
// --------------------------------------------------------------------------

const BASE = {
  code: "ACE-1",
  name: "Acetaminofén",
  unit: "unidad",
  minStock: "0",
  reorderQty: "0",
};

describe("alta de producto · SKU (código de Orion)", () => {
  it("acepta el SKU cuando se escribe", () => {
    const parsed = productCreateSchema.safeParse({ ...BASE, orionCode: "ORN-4412" });

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.orionCode).toBe("ORN-4412");
  });

  it("deja crear el producto SIN SKU: el producto nuevo sin código existe", () => {
    const parsed = productCreateSchema.safeParse(BASE);

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.orionCode).toBeUndefined();
  });

  // Un campo que se dejó vacío no es "el SKU es la cadena vacía": es que no hay
  // SKU. Guardarlo como "" ocuparía el índice único y el segundo producto sin
  // código chocaría contra el primero.
  it("un campo vacío NO es un SKU", () => {
    const parsed = productCreateSchema.safeParse({ ...BASE, orionCode: "   " });

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.orionCode).toBeUndefined();
  });

  // La identidad es EXACTA: el código se guarda tal como vino de Orion. Un
  // espacio adentro casi siempre es un pegado con basura, y dejarlo pasar crea
  // una identidad que no coincide con la del otro sistema.
  it("rechaza un SKU con espacios adentro", () => {
    const parsed = productCreateSchema.safeParse({ ...BASE, orionCode: "ORN 4412" });

    expect(parsed.success).toBe(false);
  });

  it("recorta los espacios de los extremos", () => {
    const parsed = productCreateSchema.safeParse({ ...BASE, orionCode: "  ORN-4412  " });

    expect(parsed.success && parsed.data.orionCode).toBe("ORN-4412");
  });

  it("rechaza un SKU demasiado largo", () => {
    const parsed = productCreateSchema.safeParse({
      ...BASE,
      orionCode: "X".repeat(81),
    });

    expect(parsed.success).toBe(false);
  });
});
