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

// Unidad por defecto de un producto manual cuando el operador no la especifica.
const MANUAL_UNIT_FALLBACK = "unidad";

// Validación del alta de un pendiente (solicitud de cliente). La cantidad llega
// como string desde el FormData, por eso se coerciona. El producto puede venir
// de dos formas EXCLUYENTES:
//   1. `productId` → un producto ya existente en el catálogo.
//   2. `manualName` (+ `manualUnit` opcional) → un producto que NO está en el
//      catálogo; el service lo creará al vuelo marcado para revisión de un ADMIN.
// Exactamente una de las dos debe venir (XOR): ni ambas (ambiguo) ni ninguna.
export const pendingCreateSchema = z
  .object({
    productId: z
      .string()
      .trim()
      .optional()
      .transform((value) => (value && value.length > 0 ? value : undefined)),
    manualName: optionalText(120),
    manualUnit: optionalText(40),
    quantity: z.coerce
      .number()
      .int("La cantidad debe ser un número entero")
      .min(1, "La cantidad debe ser al menos 1"),
    // Promesa de entrega obligatoria. Llega como string de un <input
    // datetime-local> SIN timezone; se interpreta como hora de Colombia (no la
    // del server) y se persiste el UTC correcto. Ausencia/null/vacío/inválido fallan.
    promisedAt: z
      .string({ error: "Indicá la fecha y hora prometida" })
      .transform((value, ctx) => {
        const parsed = parseBogotaWallTime(value);
        if (parsed === null) {
          ctx.addIssue({ code: "custom", message: "Indicá una fecha y hora válida" });
          return z.NEVER;
        }
        return parsed;
      }),
    customerName: optionalText(120),
    note: optionalText(280),
  })
  .superRefine((data, ctx) => {
    const hasCatalog = Boolean(data.productId);
    const hasManual = Boolean(data.manualName);
    if (hasCatalog === hasManual) {
      ctx.addIssue({
        code: "custom",
        path: ["productId"],
        message: "Elegí un producto del catálogo o cargá uno manual",
      });
    }
  })
  .transform((data) => {
    const base = {
      quantity: data.quantity,
      promisedAt: data.promisedAt,
      customerName: data.customerName,
      note: data.note,
    };
    // Rama catálogo: referimos al producto existente, sin producto manual.
    if (data.productId) {
      return { ...base, productId: data.productId, manual: undefined } as const;
    }
    // Rama manual: el nombre está garantizado por el superRefine (XOR).
    return {
      ...base,
      productId: undefined,
      manual: {
        name: data.manualName as string,
        unit: data.manualUnit ?? MANUAL_UNIT_FALLBACK,
      },
    } as const;
  });

export type PendingCreateInput = z.infer<typeof pendingCreateSchema>;
