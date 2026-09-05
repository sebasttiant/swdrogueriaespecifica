import { z } from "zod";

import { parseBogotaExpiry } from "@/lib/datetime/bogota";

// Texto opcional que llega desde FormData: se normaliza vacío/espacios a
// `undefined` para no persistir cadenas vacías como si fueran datos.
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((value) => (value && value.length > 0 ? value : undefined));

/**
 * Una versión declarada por el formulario.
 *
 * NO se usa `z.coerce.number()`. `FormData.get` devuelve `null` cuando el campo
 * no viaja, y `Number(null)` es `0` —un valor perfectamente válido, y además la
 * versión que tiene todo producto que nadie editó nunca—. Es decir: un
 * formulario al que le falte el campo declararía "vi la versión 0", el
 * compare-and-set coincidiría, y la entrada pasaría sin que nadie haya
 * declarado nada. Un control que se satisface solo no controla.
 *
 * Exigir una cadena de dígitos hace que la ausencia sea un rechazo, no un cero.
 */
const declaredVersion = z
  .string({ error: "Falta la versión del producto" })
  .trim()
  .regex(/^\d+$/, "La versión del producto no es válida")
  .transform(Number);

// Validación del alta de una entrada de inventario. La cantidad llega como
// string desde el FormData, por eso se coerciona. `productId` y `batchCode`
// son obligatorios; `expiresAt` es REQUERIDO (ProductBatch.expiresAt NOT NULL).
// Productos sin fecha de vencimiento están fuera del alcance de este slice.
export const inventoryEntryCreateSchema = z.object({
  productId: z.string().trim().min(1, "Elegí un producto"),
  quantity: z.coerce
    .number()
    .int("La cantidad debe ser un número entero")
    .min(1, "La cantidad debe ser al menos 1"),
  batchCode: z.string().trim().min(1, "Ingresá el código de lote"),
  // Fecha de vencimiento obligatoria. Llega como string de un <input
  // type="date"> SIN timezone ni hora; se ancla al comienzo de ese día en
  // Colombia. Un vencimiento es un DÍA, no un instante: pedirle la hora a
  // bodega era pedirle un dato que el remito no trae y que nadie usa.
  expiresAt: z
    .string({ error: "Indicá la fecha de vencimiento" })
    .transform((value, ctx) => {
      const parsed = parseBogotaExpiry(value);
      if (parsed === null) {
        ctx.addIssue({
          code: "custom",
          message: "Indicá una fecha de vencimiento válida",
        });
        return z.NEVER;
      }
      return parsed;
    }),
  note: optionalText(280),
  // Laboratorio OBSERVADO al recibir. Los DOS campos son opcionales: no saber
  // qué laboratorio llegó no puede trabar la recepción de una caja. El id llega
  // cuando se eligió de la lista; el nombre, cuando se escribió sin elegir, y la
  // action lo resuelve. Es el mismo par que ya usa el alta de faltantes.
  receivedLaboratoryId: optionalText(64),
  receivedLaboratoryName: optionalText(120),
  idempotencyKey: z.string().uuid(),
  // ------------------------------------------------------------------------
  // La fotografia del producto que la pantalla le MOSTRO a la persona.
  //
  // OBLIGATORIAS. Este es el unico camino por el que una persona registra una
  // entrada, y una entrada sin fotografia declarada es exactamente lo que este
  // slice viene a impedir: mercaderia cargada contra una identidad que ya
  // cambio y que nadie puede reconstruir despues.
  //
  // Enteras, no fechas. `updatedAt` dice CUANDO paso algo, no en que ORDEN, y
  // dos escrituras rapidas pueden compartir milisegundo.
  // ------------------------------------------------------------------------
  expectedIdentityVersion: declaredVersion,
  expectedCatalogVersion: declaredVersion,
  // El SKU y la presentacion TAL COMO SE VIERON. No deciden nada: el servidor
  // lee los suyos de la fila bajo lock. Viajan para que la auditoria pueda
  // decir que tenia delante la persona cuando confirmo, que es una pregunta
  // distinta de que decia el catalogo.
  displayedSku: optionalText(64),
  displayedPresentation: optionalText(40),
});

export type InventoryEntryCreateInput = z.infer<
  typeof inventoryEntryCreateSchema
>;
