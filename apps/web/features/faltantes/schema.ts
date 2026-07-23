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

// Tope de la cantidad a pedir. Cota de cordura contra un tipeo accidental
// (p. ej. un código de barras en el campo cantidad), no un límite comercial.
// El CHECK aditivo de la migración solo refuerza `> 0`; el máximo vive acá y
// en el servidor para dar un mensaje claro en vez de un error de base.
export const MAX_ORDERED_QUANTITY = 100_000;

// Cantidad entera positiva a pedir, definida por gerencia al realizar el
// pedido. `coerce` acepta el string del FormData; `int().positive()` rechaza
// vacío, cero, negativos y decimales, y `finite()` descarta NaN/Infinity.
const orderedQuantitySchema = z.coerce
  .number({ error: "Ingresá la cantidad a pedir." })
  .finite({ error: "La cantidad a pedir no es válida." })
  .int({ error: "La cantidad a pedir debe ser un número entero." })
  .positive({ error: "La cantidad a pedir debe ser mayor a cero." })
  .max(MAX_ORDERED_QUANTITY, { error: "La cantidad a pedir supera el máximo permitido." });

// Pedido de un faltante a un proveedor. `supplierId` vacío/ausente significa
// "proveedor nuevo": en esa rama el nombre es obligatorio. La rama la decide el
// servidor según si `supplierId` llegó con valor, nunca una prop de la UI.
export const orderMissingItemSchema = z
  .object({
    missingItemId: z
      .string()
      .trim()
      .min(1, { error: "Falta el id del faltante." }),
    orderedQuantity: orderedQuantitySchema,
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

// Límite de longitud del nombre reportado por un vendedor. Sigue la convención
// de topes por-campo del proyecto (nota 300, proveedor 120): un nombre de
// producto pegado desde Orión entra holgado en 200, y el tope frena un pegado
// accidental de un bloque de texto. La normalización (minúsculas, NFC, colapso
// de espacios, control chars) vive en el service, no acá: el schema solo valida
// presencia y longitud de `rawName`, que se conserva tal cual para mostrar.
export const MAX_MISSING_REPORT_NAME_LENGTH = 200;

export const missingReportSubmitSchema = z.object({
  rawName: z
    .string()
    .trim()
    .min(1, { error: "Escribí el nombre del producto." })
    .max(MAX_MISSING_REPORT_NAME_LENGTH, {
      error: "El nombre del producto es demasiado largo.",
    }),
});

export type MissingReportSubmitInput = z.infer<typeof missingReportSubmitSchema>;
