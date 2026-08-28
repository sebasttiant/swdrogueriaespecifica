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
import {
  MAX_IDENTITY_DEFERRAL_NOTE_LENGTH,
  PENDING_IDENTITY_DEFERRAL_REASONS,
  type PendingIdentityDeferralReason,
} from "@/features/pendientes/identity-deferral";
// Se importa el normalizador del DOMINIO en vez de reescribir la regla acá.
// Es una función pura (no toca Prisma) y tener dos definiciones de qué es un
// código válido es exactamente cómo nace un validador que acepta lo que la
// base rechaza: el incidente de `totalAmount` de agosto de 2026, otra vez.
import { normalizeOrionCode } from "@/server/domain/catalog/sku-identity";

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
//
// El piso se pasa por parámetro porque los dos montos del pendiente NO tienen la
// misma regla, y tratarlos igual fue un incidente real: ver `totalAmount` abajo.
const optionalAmount = (options: { min: number; belowMin: string }) =>
  z.preprocess(
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
      .min(options.min, { error: options.belowMin })
      .max(MAX_PENDING_AMOUNT, { error: "El monto supera el máximo permitido." })
      .optional(),
  );

// --------------------------------------------------------------------------
// Valor total: cero significa "todavía no sé el precio".
//
// La base guarda `"totalAmount" IS NULL OR > 0` (CHECK
// `pendings_total_amount_positive`): o no se sabe, o es un monto real. Cero no
// es un valor admitido.
//
// Acá había un desacuerdo que rompía el registro en producción: el validador
// aceptaba cero (`nonnegative`) y la base lo rechazaba. Un operador que escribía
// "0" en el valor total —lo natural cuando todavía no se sabe el precio de algo
// que hay que conseguir— pasaba la validación, llegaba al INSERT y recibía un
// error genérico de "no se pudo registrar". Reintentar no servía: el dato era el
// problema, no el momento. Ese fue el incidente de agosto de 2026.
//
// La salida NO es rechazar el cero, es traducirlo. En el mostrador hay un cliente
// esperando, y "cero pesos" no es un precio que alguien quiera cobrar: es la
// forma en que la gente escribe "no sé cuánto sale". Se guarda como NULL, que es
// exactamente lo que significa, y el pendiente entra sin fricción.
//
// Un negativo SÍ se rechaza: eso no es "no sé", es un dato imposible.
// --------------------------------------------------------------------------
const optionalTotalAmount = optionalAmount({
  min: 0,
  belowMin: "El valor total no puede ser negativo.",
}).transform((value) => (value === 0 ? undefined : value));

// El abono SÍ puede ser cero: es la verdad de un cliente que no dejó plata.
// La base lo permite explícitamente (`pendings_paid_amount_nonneg` es >= 0).
const optionalPaidAmount = optionalAmount({
  min: 0,
  belowMin: "El abono no puede ser negativo.",
});

// --------------------------------------------------------------------------
// Identidad Orion resuelta de un envío de captura.
//
// Es una unión DISCRIMINADA, no tres campos opcionales: quien la consume tiene
// que decidir explícitamente qué rama atiende, y el compilador no lo deja leer
// un código de un aplazamiento. `undefined` significa "este envío no trajo
// identidad", caso legítimo cuando el producto del catálogo ya tiene la suya.
// --------------------------------------------------------------------------
export type PendingCaptureIdentity =
  | { kind: "CODE"; orionCode: string }
  | { kind: "DEFERRED"; reason: PendingIdentityDeferralReason; note?: string };

function identityOf(data: {
  orionCode?: string;
  identitySkippedReason?: PendingIdentityDeferralReason;
  identitySkippedNote?: string;
}): PendingCaptureIdentity | undefined {
  if (data.orionCode !== undefined) {
    return { kind: "CODE", orionCode: data.orionCode };
  }
  if (data.identitySkippedReason !== undefined) {
    return {
      kind: "DEFERRED",
      reason: data.identitySkippedReason,
      note: data.identitySkippedNote,
    };
  }
  return undefined;
}

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
    totalAmount: optionalTotalAmount,
    paidAmount: optionalPaidAmount,
    // ----------------------------------------------------------------------
    // Identidad Orion del producto (S2b). Llegan EXCLUYENTES: o el código, o
    // el motivo por el que se aplaza. Ver el superRefine de abajo.
    // ----------------------------------------------------------------------
    //
    // El campo vacío NO es un error: el formulario lo manda siempre, y cuando
    // el producto elegido ya tiene código nadie escribe nada acá. Vacío
    // significa "no vino identidad", y quién puede permitirse eso lo decide la
    // acción contra la base, que es la única que sabe si el producto ya la tiene.
    orionCode: z
      .string()
      .optional()
      .transform((value, ctx) => {
        const raw = value?.trim();
        if (!raw) return undefined;
        try {
          return normalizeOrionCode(raw);
        } catch {
          ctx.addIssue({
            code: "custom",
            message:
              "El SKU (código de Orion) no puede llevar espacios y va hasta 80 caracteres.",
          });
          return z.NEVER;
        }
      }),
    // El desplegable que nadie tocó postea "", no ausencia. Sin este
    // preprocess el vacío no es "no vino" sino un valor inválido del enum, y
    // TODO envío con el desplegable intacto se rechazaría pidiéndole al
    // operador un motivo que justamente NO quiso elegir.
    identitySkippedReason: z.preprocess(
      (value) =>
        typeof value === "string" && value.trim() === "" ? undefined : value,
      z
        .enum(PENDING_IDENTITY_DEFERRAL_REASONS, {
          error: "Elegí un motivo de la lista para seguir sin el código.",
        })
        .optional(),
    ),
    // No usa `optionalText` porque necesita mensaje propio: el genérico de Zod
    // llega al mostrador como "Too big: expected string to have <=280
    // characters" y deja al operador sin saber qué campo recortar.
    identitySkippedNote: z
      .string()
      .trim()
      .max(MAX_IDENTITY_DEFERRAL_NOTE_LENGTH, {
        error: "La nota del aplazamiento es demasiado larga.",
      })
      .optional()
      .transform((value) => (value && value.length > 0 ? value : undefined)),
    // ------------------------------------------------------------------
    // Trazabilidad de laboratorio (T3): laboratorio solicitado por el cliente.
    // OPCIONAL, y es una decisión de negocio, no una concesión técnica.
    //
    // El vendedor tiene al cliente delante y muchas veces no sabe el
    // laboratorio. Frenar la venta por un dato que se puede completar después
    // es peor que guardar el pendiente sin él: el pedido se pierde, y con él
    // la razón de existir de la pantalla. Cuando SÍ lo informa se conserva
    // todo el comportamiento seguro —resolución idempotente, identidad
    // canónica de PostgreSQL—, que es lo que este campo protegía de verdad.
    //
    // Los dos campos se normalizan igual: el formulario SIEMPRE manda los dos
    // hidden, vacíos cuando no hay laboratorio, así que `""` y el texto de
    // solo espacios tienen que llegar como ausencia. Un nombre en blanco no es
    // "un laboratorio llamado ''": crearlo dejaría en el catálogo una fila que
    // después nadie puede buscar ni borrar.
    //
    // El ID viene vacío cuando el usuario escribió un nombre pero no clickeó
    // una sugerencia. El action lo resuelve: busca por nombre, crea si no
    // existe — y NO se ejecuta cuando no hay nombre.
    // ------------------------------------------------------------------
    requestedLaboratoryId: z
      .string()
      .trim()
      .optional()
      .transform((value) => (value && value.length > 0 ? value : undefined)),
    requestedLaboratoryName: z
      .string()
      .trim()
      .optional()
      .transform((value) => (value && value.length > 0 ? value : undefined)),
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

    // ----------------------------------------------------------------------
    // Identidad Orion: XOR entre el código y el aplazamiento.
    // ----------------------------------------------------------------------
    const hasCode = data.orionCode !== undefined;
    const hasDeferral = data.identitySkippedReason !== undefined;

    if (hasCode && hasDeferral) {
      ctx.addIssue({
        code: "custom",
        path: ["orionCode"],
        message:
          "O cargás el SKU (código de Orion) o continuás sin él, no las dos cosas.",
      });
    }

    // La nota EXPLICA un aplazamiento. Sin motivo no hay nada que explicar, y
    // guardarla igual dejaría una nota que nadie sabe a qué se refiere.
    if (data.identitySkippedNote !== undefined && !hasDeferral) {
      ctx.addIssue({
        code: "custom",
        path: ["identitySkippedNote"],
        message:
          "La nota acompaña un motivo; elegí primero por qué seguís sin el código.",
      });
    }

    // Acá NO se exige que la identidad venga, y no es un olvido.
    //
    // Que este envío pueda venir sin identidad depende de un dato que este
    // módulo no tiene: si el producto elegido YA tiene su código de Orion. Eso
    // solo lo sabe la base, y solo en el momento del envío. Un `required` acá
    // rechazaría toda captura de un producto ya identificado —la mayoría— por
    // no repetir un dato que el sistema ya sabe.
    //
    // La exigencia existe y es obligatoria; vive en `createPendingAction`, que
    // relee el producto y decide contra su identidad de hoy. Lo que se valida
    // acá es la FORMA de lo que llegue: qué es un código válido, qué motivos
    // existen, y que código y aplazamiento no vengan juntos.
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
      // La identidad sale ya resuelta como UN valor y no como tres campos
      // sueltos: así ningún consumidor puede leer el código y olvidarse del
      // aplazamiento, ni al revés. `undefined` = no vino identidad en este
      // envío, que en la rama catálogo es legítimo.
      identity: identityOf(data),
      // T3: laboratorio solicitado por el cliente.
      // El ID puede venir vacío si el usuario escribió nombre y no clickeó "Crear".
      // El action lo resuelve: busca por nombre, crea si no existe.
      requestedLaboratoryId: data.requestedLaboratoryId,
      requestedLaboratoryName: data.requestedLaboratoryName,
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
    totalAmount: optionalTotalAmount,
    paidAmount: optionalPaidAmount,
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
