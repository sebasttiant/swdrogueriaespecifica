import { z } from "zod";


import { compactCopInput } from "@/lib/format/currency";
import { parseBogotaWallTime } from "@/lib/datetime/bogota";
import {
  MANAGEMENT_ELIGIBLE_STATUSES,
  MANAGEMENT_STATUSES,
} from "@/features/pendientes/management-status";
import { MAX_ZONE_LENGTH, normalizeZone } from "@/features/pendientes/zone";
import {
  MAX_PHONE_INPUT_LENGTH,
  normalizePhone,
} from "@/features/pendientes/phone";

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

// Cota de cordura de un monto: cien millones de pesos. No es un límite
// comercial, frena un tipeo accidental (ej. un código de barras en el campo).
export const MAX_PENDING_AMOUNT = 100_000_000;

// Monto en PESOS colombianos tal como lo escribe el operador en el mostrador.
// La limpieza del texto vive en `compactCopInput`, compartida con la pantalla:
// ver ahí por qué la coma decimal se rechaza en vez de adivinarse.
const optionalAmount = z.preprocess(
  (value) => {
    if (typeof value !== "string") return value ?? undefined;
    const compact = compactCopInput(value);
    return compact.length > 0 ? compact : undefined;
  },
  z.coerce
    .number({ error: "Ingresá un monto válido en pesos." })
    // `finite` descarta el NaN que deja cualquier carácter que no supimos leer.
    .finite({ error: "Ingresá un monto válido en pesos." })
    .int({ error: "El monto va en pesos enteros, sin centavos." })
    .nonnegative({ error: "El monto no puede ser negativo." })
    .max(MAX_PENDING_AMOUNT, { error: "El monto supera el máximo permitido." })
    .optional(),
);

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
    // Nombre y teléfono del cliente: OBLIGATORIOS desde julio de 2026. Un
    // pendiente es un compromiso con una persona concreta; sin nombre no se
    // sabe a quién se le prometió y sin teléfono no se le puede avisar que
    // llegó. La columna sigue siendo nullable para no falsear la historia
    // anterior (ver la migración), pero por acá ya no pasa uno sin ellos.
    customerName: z
      .string({ error: "Escribí el nombre del cliente." })
      .trim()
      .min(1, { error: "Escribí el nombre del cliente." })
      .max(120, { error: "El nombre del cliente es demasiado largo." }),
    customerPhone: z
      .string({ error: "Escribí el teléfono del cliente." })
      .trim()
      .min(1, { error: "Escribí el teléfono del cliente." })
      .max(MAX_PHONE_INPUT_LENGTH, { error: "El teléfono no es válido." })
      // Se guarda la forma canónica, no lo tipeado: ver `phone.ts`.
      .transform((value, ctx) => {
        const normalized = normalizePhone(value);
        if (normalized === null) {
          ctx.addIssue({
            code: "custom",
            message: "El teléfono no es válido. Ej: 300 123 4567",
          });
          return z.NEVER;
        }
        return normalized;
      }),
    // Dirección de entrega: opcional, texto libre acotado.
    customerAddress: optionalText(200),
    note: optionalText(280),
    // Seguimiento del cliente: zona de entrega y estado de pago.
    zone: optionalText(MAX_ZONE_LENGTH),
    totalAmount: optionalAmount,
    paidAmount: optionalAmount,
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

    // Al CARGAR el dato, un abono mayor al total es un typo con certeza
    // práctica, así que se rechaza con un mensaje claro. La lectura sí es
    // tolerante (ver `derivePaymentState`): filas históricas o correcciones
    // posteriores pueden tener un excedente legítimo a favor del cliente.
    if (
      data.totalAmount !== undefined &&
      data.paidAmount !== undefined &&
      data.paidAmount > data.totalAmount
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["paidAmount"],
        message: "El abono no puede superar el valor total.",
      });
    }
  })
  .transform((data) => {
    const base = {
      quantity: data.quantity,
      promisedAt: data.promisedAt,
      customerName: data.customerName,
      customerPhone: data.customerPhone,
      customerAddress: data.customerAddress,
      note: data.note,
      // Se persiste la forma canónica, no lo que se tipeó: ver `zone.ts`.
      zone: data.zone ? (normalizeZone(data.zone) ?? undefined) : undefined,
      totalAmount: data.totalAmount,
      // Sin abono es cero, no "desconocido": el cliente no dejó plata.
      paidAmount: data.paidAmount ?? 0,
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

// --------------------------------------------------------------------------
// Ciclo de vida de entrega (Slice A): entregas parciales + cancelación.
// --------------------------------------------------------------------------

export const pendingDeliverSchema = z.object({
  id: z.string().trim().min(1, "Falta el id del pendiente"),
  quantity: z.coerce
    .number()
    .int("La cantidad debe ser un número entero")
    .min(1, "La cantidad debe ser al menos 1"),
});

export type PendingDeliverInput = z.infer<typeof pendingDeliverSchema>;

export const pendingCancelSchema = z.object({
  id: z.string().trim().min(1, "Falta el id del pendiente"),
  reason: optionalText(280),
});

export type PendingCancelInput = z.infer<typeof pendingCancelSchema>;

// --------------------------------------------------------------------------
// Estado de gestión (Mejora 2): gerencia/compras fija uno de los cuatro
// términos sobre un pendiente abierto. `status` DEBE ser un estado de gestión;
// no se permite forzar PENDIENTE/PARCIAL/ENTREGADO/CANCELADO por esta vía.
// --------------------------------------------------------------------------

export const pendingManagementStatusSchema = z.object({
  id: z.string().trim().min(1, "Falta el id del pendiente"),
  status: z.enum(MANAGEMENT_STATUSES),
  // Estado que la pantalla OBSERVÓ al renderizar. El compare-and-set lo exige,
  // así dos gerentes mirando la misma lista no se pisan: si uno marcó AGOTADO,
  // el "Ya lo pedí" del otro no lo sobrescribe. Cualquier estado elegible, no
  // solo PENDIENTE: cambiar de "Solicitado" a "Agotado" necesita la misma
  // protección.
  // `POR_PEDIR` es el "todavía sin gestionar" del eje de COMPRAS, y es lo que
  // la pantalla observa hoy. Faltaba acá: el formulario lo posteaba, Zod lo
  // rechazaba, y gerencia recibía "No se pudo identificar el pendiente o el
  // estado" en TODOS los pendientes. `PENDIENTE` se sigue aceptando porque es
  // el valor que muestran las filas anteriores a la separación de ejes.
  expectedStatus: z
    .enum(["POR_PEDIR", ...MANAGEMENT_ELIGIBLE_STATUSES])
    .optional(),
});

export type PendingManagementStatusInput = z.infer<
  typeof pendingManagementStatusSchema
>;

// --------------------------------------------------------------------------
// Edición de un pendiente por parte de quien administra.
//
// Es la potestad de gerencia sobre cualquier pendiente: corregir lo que el
// vendedor cargó mal, cambiar la promesa que se renegoció con el cliente, o
// ajustar el producto cuando se pidió el que no era.
//
// A diferencia del alta, acá el producto SIEMPRE es del catálogo: crear uno al
// vuelo es parte de registrar, no de corregir. Si hace falta uno nuevo, se carga
// al catálogo y se elige.
// --------------------------------------------------------------------------
export const pendingUpdateSchema = z
  .object({
    id: z.string().trim().min(1, "Falta el id del pendiente"),
    productId: z.string().trim().min(1, { error: "Elegí un producto." }),
    quantity: z.coerce
      .number()
      .int("La cantidad debe ser un número entero")
      .min(1, "La cantidad debe ser al menos 1"),
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
    customerName: z
      .string({ error: "Escribí el nombre del cliente." })
      .trim()
      .min(1, { error: "Escribí el nombre del cliente." })
      .max(120, { error: "El nombre del cliente es demasiado largo." }),
    customerPhone: z
      .string({ error: "Escribí el teléfono del cliente." })
      .trim()
      .min(1, { error: "Escribí el teléfono del cliente." })
      .max(MAX_PHONE_INPUT_LENGTH, { error: "El teléfono no es válido." })
      .transform((value, ctx) => {
        const normalized = normalizePhone(value);
        if (normalized === null) {
          ctx.addIssue({
            code: "custom",
            message: "El teléfono no es válido. Ej: 300 123 4567",
          });
          return z.NEVER;
        }
        return normalized;
      }),
    customerAddress: optionalText(200),
    note: optionalText(280),
    zone: optionalText(MAX_ZONE_LENGTH),
    totalAmount: optionalAmount,
    paidAmount: optionalAmount,
  })
  .superRefine((data, ctx) => {
    if (
      data.totalAmount !== undefined &&
      data.paidAmount !== undefined &&
      data.paidAmount > data.totalAmount
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["paidAmount"],
        message: "El abono no puede superar el valor total.",
      });
    }
  });

export type PendingUpdateInput = z.infer<typeof pendingUpdateSchema>;
