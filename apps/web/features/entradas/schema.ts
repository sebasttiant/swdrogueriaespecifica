import { z } from "zod";

import { parseBogotaWallTime } from "@/lib/datetime/bogota";

// Texto opcional que llega desde FormData: se normaliza vacío/espacios a
// `undefined` para no persistir cadenas vacías como si fueran datos.
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((value) => (value && value.length > 0 ? value : undefined));

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
  // type="datetime-local"> SIN timezone; se interpreta como hora de Colombia.
  expiresAt: z
    .string({ error: "Indicá la fecha de vencimiento" })
    .transform((value, ctx) => {
      const parsed = parseBogotaWallTime(value);
      if (parsed === null) {
        ctx.addIssue({
          code: "custom",
          message: "Indicá una fecha y hora de vencimiento válida",
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
});

export type InventoryEntryCreateInput = z.infer<
  typeof inventoryEntryCreateSchema
>;
