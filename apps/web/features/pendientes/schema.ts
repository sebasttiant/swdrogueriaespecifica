import { z } from "zod";

// Texto opcional que llega desde FormData: se normaliza vacío/espacios a
// `undefined` para no persistir cadenas vacías como si fueran datos.
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((value) => (value && value.length > 0 ? value : undefined));

// Validación del alta de un pendiente (solicitud de cliente). La cantidad llega
// como string desde el FormData, por eso se coerciona. `productId` es obligatorio
// porque un pendiente siempre refiere a un producto del catálogo.
export const pendingCreateSchema = z.object({
  productId: z.string().trim().min(1, "Elegí un producto"),
  quantity: z.coerce
    .number()
    .int("La cantidad debe ser un número entero")
    .min(1, "La cantidad debe ser al menos 1"),
  customerName: optionalText(120),
  note: optionalText(280),
});

export type PendingCreateInput = z.infer<typeof pendingCreateSchema>;
