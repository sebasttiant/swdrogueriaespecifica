import { z } from "zod";

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
    .min(1, { error: "Escribí el código de Orion." })
    .max(80, { error: "El código de Orion es demasiado largo." })
    .refine((value) => !/\s/.test(value), {
      error: "El código de Orion no puede llevar espacios.",
    }),
  expectedVersion: z.coerce
    .number({ error: "La versión de identidad no es válida." })
    .int({ error: "La versión de identidad no es válida." })
    .min(0, { error: "La versión de identidad no es válida." }),
});

export type OrionLinkInput = z.infer<typeof orionLinkSchema>;
