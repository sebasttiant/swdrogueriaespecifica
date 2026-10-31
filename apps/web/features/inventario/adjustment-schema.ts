import { z } from "zod";

import {
  ADJUSTMENT_REASONS,
  isAdjustmentReason,
} from "@/features/inventario/adjustment-reason";

// --------------------------------------------------------------------------
// Validación del formulario de ajuste de inventario.
//
// La cantidad FINAL (lo que el conteo encontró) viaja como string desde
// FormData. El delta se calcula en el servicio DESPUÉS del lock: mandar un
// delta precalculado contra la cantidad que la pantalla mostraba aplicaría un
// cambio viejo si alguien ajustó el mismo lote en el medio.
// --------------------------------------------------------------------------

const optionalNote = z
  .string()
  .trim()
  .max(500, "La nota no puede superar 500 caracteres")
  .optional()
  .transform((value) => (value && value.length > 0 ? value : undefined));

export const inventoryAdjustmentSchema = z.object({
  batchId: z.string().trim().min(1, "Falta el lote"),
  productId: z.string().trim().min(1, "Falta el producto"),
  targetQuantity: z
    .string({ error: "Indicá la cantidad contada" })
    .trim()
    .regex(/^\d+$/, "La cantidad debe ser un número entero")
    .transform(Number)
    .refine((value) => value >= 0, "La cantidad no puede ser negativa"),
  reason: z
    .string({ error: "Elegí un motivo" })
    .refine(isAdjustmentReason, {
      message: `El motivo debe ser uno de: ${ADJUSTMENT_REASONS.join(", ")}`,
    }),
  note: optionalNote,
  idempotencyKey: z.string().trim().min(8, "Falta la clave del intento"),
});

export type InventoryAdjustmentInput = z.infer<typeof inventoryAdjustmentSchema>;
