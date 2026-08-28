import { z } from "zod";

// Validación del alta de producto (catálogo). Los números llegan como string
// desde el FormData, por eso se coercionan.
export const productCreateSchema = z.object({
  code: z.string().trim().min(1, "El código es obligatorio").max(40),
  name: z.string().trim().min(1, "El nombre es obligatorio").max(120),
  unit: z.string().trim().min(1, "La unidad es obligatoria").max(20),
  minStock: z.coerce.number().int().min(0).default(0),
  reorderQty: z.coerce.number().int().min(0).default(0),
  laboratoryId: z.string().trim().optional(),
});

export type ProductCreateInput = z.infer<typeof productCreateSchema>;

// --------------------------------------------------------------------------
// Vínculo del producto con su código Orion.
//
// El dominio (`normalizeOrionCode`) vuelve a validar todo esto, así que acá no
// se gana seguridad: se gana el MENSAJE. Un código con un espacio adentro sale
// del dominio como `MISSING_EXACT_IDENTITY`, que al operador no le explica
// nada. Atajarlo en el formulario permite decirle qué escribió mal.
//
// `expectedVersion` es la versión de identidad que la pantalla le MOSTRÓ al
// operador. Viaja para que el servidor pueda rechazar la escritura si alguien
// llegó antes: el vínculo es un compare-and-set, no un pisotón.
// --------------------------------------------------------------------------

export const orionLinkSchema = z.object({
  productId: z
    .string()
    .trim()
    .min(1, { error: "Falta el producto." }),
  // Sin `toUpperCase` ni nada por el estilo: la identidad es EXACTA y el
  // código se guarda tal como vino de Orion.
  orionCode: z
    .string()
    .trim()
    .min(1, { error: "Escribí el SKU (código de Orion)." })
    .max(80, { error: "El SKU (código de Orion) es demasiado largo." })
    .refine((value) => !/\s/.test(value), {
      error: "El SKU (código de Orion) no puede llevar espacios.",
    }),
  // Solo dígitos, y NUNCA `z.coerce.number()`. La coerción corre
  // `Number(valor)` antes de mirar `.int()` y `.min(0)`, y tanto `Number("")`
  // como `Number(null)` dan 0. Así, un campo vacío —o ausente, porque
  // `formData.get()` devuelve `null`— entraba como "vi la versión 0": justo la
  // afirmación que el compare-and-set existe para hacer con honestidad. Y el
  // pase libre alcanzaba a casi todo el catálogo, porque un producto que nadie
  // tocó está en la versión 0.
  expectedVersion: z
    .string({ error: "La versión de identidad no es válida." })
    .trim()
    .regex(/^\d+$/, { error: "La versión de identidad no es válida." })
    .transform(Number),
});

export type OrionLinkInput = z.infer<typeof orionLinkSchema>;
