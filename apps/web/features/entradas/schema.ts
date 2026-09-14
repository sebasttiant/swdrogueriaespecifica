import { z } from "zod";

import { parseBogotaExpiry } from "@/lib/datetime/bogota";
import {
  hasReservedBatchCodeShape,
  normalizeBatchCode,
} from "@/lib/inventory/reserved-batch-code";

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
// string desde el FormData, por eso se coerciona. `productId` es el único dato
// obligatorio de la mercadería: el lote y el vencimiento son OPCIONALES, porque
// hay cajas que no los traen impresos y una recepción real no puede quedar
// trabada por un dato que nadie tiene en la mano.
export const inventoryEntryCreateSchema = z.object({
  productId: z.string().trim().min(1, "Elegí un producto"),
  quantity: z.coerce
    .number()
    .int("La cantidad debe ser un número entero")
    .min(1, "La cantidad debe ser al menos 1"),
  // Código de lote OPCIONAL. Vacío no es un lote llamado "": es la ausencia de
  // lote, y el servicio deriva el código reservado que la representa.
  //
  // Lo único que se rechaza es ese código reservado escrito a mano. Lo deriva
  // el sistema y lleva el vencimiento adentro; escrito a mano, el lote afirma
  // un vencimiento que no es el suyo y la mercadería se mezcla con otra caja.
  batchCode: z
    .string()
    .trim()
    .optional()
    .transform((value) => (value && value.length > 0 ? value : undefined))
    .refine(
      (value) =>
        value === undefined || !hasReservedBatchCodeShape(normalizeBatchCode(value)),
      {
        message:
          "«SIN LOTE» es un código reservado del sistema. Si la caja no trae lote, dejá el campo vacío.",
      },
    ),
  // Fecha de vencimiento OPCIONAL. Llega como string de un <input type="date">
  // SIN timezone ni hora; se ancla al comienzo de ese día en Colombia. Un
  // vencimiento es un DÍA, no un instante: pedirle la hora a bodega era pedirle
  // un dato que el remito no trae y que nadie usa.
  //
  // Vacío es `null` —DESCONOCIDO—, y eso es distinto de vencido: un lote sin
  // fecha se sigue vendiendo y se consume al final. Poner una fecha por defecto
  // sería inventar el dato que justamente no se tiene.
  expiresAt: z
    .string()
    .optional()
    .transform((value, ctx) => {
      const raw = value?.trim();
      if (!raw) return null;
      const parsed = parseBogotaExpiry(raw);
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
