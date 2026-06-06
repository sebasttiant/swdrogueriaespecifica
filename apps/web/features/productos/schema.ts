import { z } from "zod";

// Validación del alta de producto (catálogo). Los números llegan como string
// desde el FormData, por eso se coercionan.
export const productCreateSchema = z.object({
  code: z.string().trim().min(1, "El código es obligatorio").max(40),
  name: z.string().trim().min(1, "El nombre es obligatorio").max(120),
  unit: z.string().trim().min(1, "La unidad es obligatoria").max(20),
  minStock: z.coerce.number().int().min(0).default(0),
  reorderQty: z.coerce.number().int().min(0).default(0),
});

export type ProductCreateInput = z.infer<typeof productCreateSchema>;
