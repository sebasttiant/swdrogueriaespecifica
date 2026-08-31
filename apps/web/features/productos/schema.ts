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
  // El SKU al ALTA, no después.
  //
  // Sin este campo todo producto nuevo nacía sin identidad: caía en la cola de
  // "Revisión de identidad" y bloqueaba la entrada cuando llegaba la caja. El
  // alta fabricaba el problema que el rechazo de la entrada atajaba. Quien da
  // de alta casi siempre tiene el código delante —en la caja o en la factura—.
  //
  // Opcional: el producto nuevo sin código todavía existe (`NEW_PRODUCT` es un
  // motivo válido de aplazamiento) y exigirlo cerraría un alta legítima.
  //
  // Vacío se normaliza a `undefined`, NUNCA a "": `orionCode` es único en la
  // base, así que una cadena vacía guardada ocuparía el índice y el segundo
  // producto sin código chocaría contra el primero.
  //
  // Mismas reglas que `orionLinkSchema`: la identidad es EXACTA y el código se
  // guarda tal como vino de Orion. Un espacio adentro casi siempre es un pegado
  // con basura y crearía una identidad que no coincide con la del otro sistema.
  orionCode: z
    .string()
    .trim()
    .max(80, { error: "El SKU (código de Orión) es demasiado largo." })
    .refine((value) => !/\s/.test(value), {
      error: "El SKU (código de Orión) no puede llevar espacios.",
    })
    .optional()
    .transform((value) => (value === undefined || value === "" ? undefined : value)),
});

export type ProductCreateInput = z.infer<typeof productCreateSchema>;

// --------------------------------------------------------------------------
// Edición de un producto del CATÁLOGO.
//
// Lo que se edita acá es IDENTIDAD: cómo se llama el producto, cómo viene y
// cuándo hay que reponerlo. Las CANTIDADES no están y no van a estar: el stock
// se mueve con entradas, salidas y ajustes, que dejan un movimiento auditable
// detrás. Un `stock = 20` escrito a mano convierte cualquier cuadre posterior
// en una ficción, porque nadie puede reconstruir de dónde salió ese número.
//
// El SKU (código de Orión) TAMPOCO está acá, y no es un olvido. Tiene su
// propio circuito con control de concurrencia —`orionLinkSchema` para
// vincularlo cuando falta, y la corrección explícita cuando ya existe—, porque
// mover una identidad que el inventario entero referencia no puede ser un
// campo más de un formulario largo. Se edita desde la tarjeta de identidad.
// --------------------------------------------------------------------------
export const productUpdateSchema = z.object({
  id: z.string().trim().min(1, { error: "Falta el producto." }),
  code: z.string().trim().min(1, "El código es obligatorio").max(40),
  name: z.string().trim().min(1, "El nombre es obligatorio").max(120),
  // "Presentación" en pantalla: frasco, sobre, caja, blíster, ampolla. La
  // columna se sigue llamando `unit` porque la usa el inventario entero.
  unit: z.string().trim().min(1, "La presentación es obligatoria").max(20),
  minStock: z.coerce.number().int().min(0).default(0),
  reorderQty: z.coerce.number().int().min(0).default(0),
  // Vacío = sin laboratorio. Se distingue de "no lo mandaron" a propósito:
  // desvincular el laboratorio es una edición válida.
  laboratoryId: z
    .string()
    .trim()
    .optional()
    .transform((value) => (value === undefined || value === "" ? null : value)),
  /**
   * El texto que quedó ESCRITO en el buscador de laboratorio.
   *
   * Hace falta porque el buscador suelta la selección en cuanto alguien
   * escribe algo distinto de lo elegido (`laboratory-search.tsx`): manda el id
   * vacío y el nombre tipeado. Sin leer este campo, "escribí Genfar y guardé"
   * se traducía en "quitá el laboratorio", con la pantalla mostrando Genfar.
   */
  laboratoryName: z.string().trim().max(120).optional(),
  /**
   * Cuándo se leyó el producto que se está editando.
   *
   * Es el testigo de concurrencia. Este formulario manda TODOS los campos, así
   * que dos personas editando cosas distintas del mismo producto se pisan: la
   * última en guardar reescribe con los valores viejos de su propia pantalla lo
   * que la otra acababa de corregir, y encima el `before` de la auditoría no
   * describe lo que realmente reemplazó.
   */
  expectedUpdatedAt: z
    .string()
    .trim()
    .min(1, { error: "Falta la versión del producto." })
    .refine((value) => !Number.isNaN(Date.parse(value)), {
      error: "La versión del producto no es válida.",
    })
    .transform((value) => new Date(value)),
  // Una casilla no marcada NO viaja en el FormData: por eso el default es
  // `false` y no `true`. Leerlo al revés desactivaría productos en silencio.
  active: z
    .union([z.literal("on"), z.literal("true"), z.literal("false")])
    .optional()
    .transform((value) => value === "on" || value === "true"),
});

export type ProductUpdateInput = z.infer<typeof productUpdateSchema>;

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
    .min(1, { error: "Escribí el SKU (código de Orión)." })
    .max(80, { error: "El SKU (código de Orión) es demasiado largo." })
    .refine((value) => !/\s/.test(value), {
      error: "El SKU (código de Orión) no puede llevar espacios.",
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
