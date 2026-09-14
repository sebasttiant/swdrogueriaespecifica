// --------------------------------------------------------------------------
// El código de lote RESERVADO — funciones puras (sin DB, sin I/O).
//
// Una caja puede llegar sin número de lote impreso. `ProductBatch` identifica
// al lote por `(productId, batchCode)`, así que "sin lote" necesita un valor:
// sin uno, dos cajas sin lote del mismo producto serían el mismo lote y su
// stock se sumaría en una fila que no describe ninguna de las dos.
//
// Ese valor lo DERIVA el sistema y nunca lo escribe una persona:
//
//   sin lote + vence el 2027-01-15  →  "SIN LOTE 2027-01-15"
//   sin lote + sin vencimiento      →  "SIN LOTE"  (y `expiresAt` NULL)
//
// Lleva la fecha adentro a propósito: dos cajas sin lote con vencimientos
// distintos son dos lotes distintos, y tienen que quedar en dos filas con su
// propia fecha. Sin la fecha en el código, la segunda recepción caería en la
// fila de la primera y heredaría su vencimiento en silencio.
//
// Por eso mismo el código reservado tiene que estar PROTEGIDO: si alguien lo
// escribe a mano, el lote afirma un vencimiento que no es el suyo. La
// validación del formulario lo rechaza y el repositorio lo vuelve a chequear
// en el único punto por el que pasan todas las escrituras.
//
// Las etiquetas en español para la pantalla ("Sin lote", "Sin vencimiento")
// viven en `features/productos/batch-labels.ts` — lib queda sin idioma, igual
// que `batch-status.ts`.
// --------------------------------------------------------------------------

import { bogotaDayKey } from "@/lib/datetime/bogota";

/** La forma pelada: sin lote y sin vencimiento. */
export const RESERVED_BATCH_CODE = "SIN LOTE";

// Los espacios, escritos uno por uno en vez de `\s`.
//
// `\s` de JavaScript es MÁS ANCHO que el de PostgreSQL: incluye el espacio
// duro (U+00A0) y otros espacios Unicode que `[[:space:]]` no reconoce. Este
// repositorio ya se quemó con esa diferencia en la identidad canónica de
// laboratorios: la normalización de la aplicación y la del motor no coincidían,
// y una fila que el código consideraba duplicada la base no.
//
// Acá la normalización la usan las dos mitades —la validación en TypeScript y
// el chequeo de datos en SQL— y tienen que decidir exactamente lo mismo. Esta
// clase es, carácter por carácter, el `[[:space:]]` de PostgreSQL.
const SQL_WHITESPACE = " \\t\\n\\v\\f\\r";

const WHITESPACE_RUN = new RegExp(`[${SQL_WHITESPACE}]+`, "g");

/**
 * El patrón de la forma reservada, como TEXTO, para que el predicado de
 * TypeScript y el chequeo de datos en SQL compartan una sola definición.
 *
 * Sin clases de caracteres abreviadas (`\d`) ni banderas: es POSIX y
 * JavaScript a la vez, así que `~` de PostgreSQL y `RegExp` de JavaScript
 * reconocen las mismas cadenas. Se aplica SIEMPRE sobre un código ya
 * normalizado.
 */
export const RESERVED_BATCH_CODE_SQL_PATTERN =
  "^SIN LOTE( [0-9]{4}-[0-9]{2}-[0-9]{2})?$";

const RESERVED_SHAPE = new RegExp(RESERVED_BATCH_CODE_SQL_PATTERN);

/**
 * La forma canónica de un código de lote para COMPARAR.
 *
 * Recorta los extremos, colapsa los espacios internos a uno solo y pasa a
 * mayúsculas. No es lo que se guarda —un lote real se guarda tal como vino—:
 * es la forma en que se decide si dos códigos son el mismo, y si uno es el
 * reservado.
 */
export function normalizeBatchCode(raw: string): string {
  return raw.trim().replace(WHITESPACE_RUN, " ").toUpperCase();
}

/**
 * ¿Este código YA NORMALIZADO tiene la forma reservada?
 *
 * La forma es exacta, no un prefijo: "SIN LOTES DEL PROVEEDOR" es un código
 * que alguien puede tener impreso en una caja de verdad y no se le puede
 * rechazar. Solo "SIN LOTE", opcionalmente seguido de una fecha YYYY-MM-DD,
 * es del sistema.
 */
export function hasReservedBatchCodeShape(normalized: string): boolean {
  return RESERVED_SHAPE.test(normalized);
}

/**
 * El código que le corresponde a una recepción SIN número de lote.
 *
 * La fecha es el día de calendario de Bogotá del instante guardado, no el de
 * UTC: `expiresAt` se ancla a las 00:00 de Bogotá (ver `parseBogotaDateOnly`),
 * y leerlo en UTC correría el día en las recepciones cargadas de tarde.
 */
export function deriveReservedBatchCode(expiresAt: Date | null): string {
  if (expiresAt === null) return RESERVED_BATCH_CODE;
  return `${RESERVED_BATCH_CODE} ${bogotaDayKey(expiresAt)}`;
}
