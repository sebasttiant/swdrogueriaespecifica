import { z } from "zod";

// Helper local (misma convención duplicada por-archivo del proyecto, ver
// `features/entradas/schema.ts`): texto opcional recortado; vacío → undefined.
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((value) => (value && value.length > 0 ? value : undefined));

// Email opcional pero, cuando viene, con formato válido. Un valor vacío o
// ausente se normaliza a undefined (no es un error); cualquier otro texto debe
// ser un email válido o se rechaza con un mensaje en español.
const optionalEmail = z.preprocess(
  (value) => {
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim().toLowerCase();
    return trimmed.length > 0 ? trimmed : undefined;
  },
  z.email({ error: "Email inválido." }).max(160).optional(),
);

// Pedido de un faltante a un proveedor. `supplierId` vacío/ausente significa
// "proveedor nuevo": en esa rama el nombre es obligatorio. La rama la decide el
// servidor según si `supplierId` llegó con valor, nunca una prop de la UI.
export const orderMissingItemSchema = z
  .object({
    missingItemId: z
      .string()
      .trim()
      .min(1, { error: "Falta el id del faltante." }),
    supplierId: optionalText(60),
    name: optionalText(120),
    phone: optionalText(40),
    address: optionalText(200),
    email: optionalEmail,
  })
  .superRefine((value, ctx) => {
    // La rama la decide el SERVIDOR según si `supplierId` llegó con valor,
    // nunca una prop de la UI (el form postea FormData plano; no agregamos un
    // `mode`/discriminador que le daría a la UI el control de la rama). Por
    // eso ambas ramas deben ser mutuamente excluyentes acá: un payload con
    // `supplierId` Y datos de proveedor nuevo es ambiguo y se rechaza, en vez
    // de resolverse en silencio tomando la rama "existente" y descartando los
    // datos del proveedor nuevo.
    const hasNewSupplierFields = Boolean(
      value.name || value.phone || value.address || value.email,
    );
    if (value.supplierId && hasNewSupplierFields) {
      ctx.addIssue({
        code: "custom",
        path: ["supplierId"],
        message:
          "No se puede elegir un proveedor existente y cargar uno nuevo a la vez.",
      });
      return;
    }

    // Rama proveedor nuevo (sin `supplierId`): el nombre es obligatorio.
    if (!value.supplierId && !value.name) {
      ctx.addIssue({
        code: "custom",
        path: ["name"],
        message: "El nombre del proveedor es obligatorio.",
      });
    }
  });

export type OrderMissingItemFormInput = z.infer<typeof orderMissingItemSchema>;

export const manualMissingItemCreateSchema = z.object({
  productId: z.string().trim().min(1, { error: "Elegí un producto." }),
  quantity: z.coerce
    .number()
    .int({ error: "La cantidad debe ser un número entero." })
    .positive({ error: "Ingresá una cantidad mayor a cero." }),
  note: optionalText(300),
});

export type ManualMissingItemCreateInput = z.infer<
  typeof manualMissingItemCreateSchema
>;
