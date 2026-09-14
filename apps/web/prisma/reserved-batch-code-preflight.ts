/**
 * Chequeo de datos del código de lote RESERVADO.
 *
 * `lib/inventory/reserved-batch-code.ts` le da un significado al código
 * "SIN LOTE [fecha]": es la representación interna de una caja que llegó sin
 * número de lote. Desde entonces, una fila de `product_batches` que tenga ese
 * código y NO sea la que el sistema habría derivado es una fila que afirma un
 * vencimiento que no le corresponde. Puede venir de antes —alguien lo escribió
 * a mano cuando todavía no significaba nada— o de un guion que lo armó solo.
 *
 * Esas filas importan por dos razones: se leen en pantalla como "Sin lote"
 * ocultando el código real, y `upsertBatchQuantity` RECHAZA cualquier entrada
 * nueva sobre ellas, así que una caja legítima de ese lote no se puede recibir
 * hasta que alguien arregle la fila.
 *
 * Es de SOLO LECTURA e idempotente: se puede correr las veces que haga falta,
 * contra producción, sin consecuencias. No migra, no escribe y no arregla nada
 * por su cuenta: cuál es el código correcto de una caja que ya está en el
 * estante es una decisión de negocio, no de un guion.
 *
 * CÓMO SE REPARTE EL TRABAJO. La base solo NARRA: busca las filas cuyo código
 * tiene la forma reservada, con el MISMO patrón y la MISMA normalización que el
 * código de la aplicación. Quién de esas filas está mal lo decide TypeScript,
 * con la MISMA derivación que usa el repositorio. La fecha de Bogotá se calcula
 * con `Intl`, como en todo el resto del proyecto: no hay una sola conversión de
 * zona horaria en SQL en este repositorio y este chequeo no viene a inventar la
 * primera.
 */
import { bogotaDayKey } from "@/lib/datetime/bogota";
import {
  RESERVED_BATCH_CODE_SQL_PATTERN,
  deriveReservedBatchCode,
} from "@/lib/inventory/reserved-batch-code";

/** Lo mínimo que este módulo necesita de un cliente Prisma o de una transacción. */
export type SqlRunner = {
  $queryRawUnsafe<T>(query: string): Promise<T>;
};

/** Una fila de lote cuyo código tiene la forma reservada. */
export type ReservedBatchCodeRow = {
  batchCode: string;
  expiresAt: Date | null;
  quantity: number;
  productName: string;
  productCode: string;
};

// El `[[:space:]]` de PostgreSQL, escrito carácter por carácter y NO como `\s`.
// Es el mismo conjunto que usa `normalizeBatchCode`; la razón de escribirlo así
// está documentada ahí (el `\s` de JavaScript es más ancho que el del motor).
const SQL_WHITESPACE_CLASS = "[ \\t\\n\\v\\f\\r]+";

/**
 * La consulta que NARRA las filas con forma reservada.
 *
 * Normaliza igual que `normalizeBatchCode`: colapsa las corridas de espacios a
 * uno, recorta y sube a mayúsculas —en ese orden, porque colapsar primero deja
 * los extremos con un solo espacio que `btrim` ya se lleva—. El patrón viene
 * importado: escrito de nuevo acá, divergiría en el primer cambio y el chequeo
 * dejaría de ver justo lo que busca.
 *
 * El `JOIN` es interno y no un `LEFT JOIN`: `productId` es una clave foránea
 * obligatoria, así que toda fila de lote tiene su producto.
 */
export function reservedShapedBatchCodeSql(): string {
  return `
    SELECT pb."batchCode"      AS "batchCode",
           pb."expiresAt"      AS "expiresAt",
           pb.quantity         AS quantity,
           p.name              AS "productName",
           p.code              AS "productCode"
      FROM product_batches pb
      JOIN products p ON p.id = pb."productId"
     WHERE upper(btrim(regexp_replace(pb."batchCode", '${SQL_WHITESPACE_CLASS}', ' ', 'g')))
           ~ '${RESERVED_BATCH_CODE_SQL_PATTERN}'
     ORDER BY p.name, pb."batchCode"
  `;
}

/**
 * De las filas con forma reservada, las que el sistema NO habría escrito.
 *
 * La regla es la misma que la del chokepoint (`upsertBatchQuantity`): un código
 * con forma reservada tiene que ser EXACTAMENTE lo que la derivación produce
 * para el vencimiento de esa fila. Se comparte la función, no la lógica
 * copiada: si la derivación cambia, este chequeo cambia con ella.
 */
export function nonCanonicalReservedRows(
  rows: ReservedBatchCodeRow[],
): ReservedBatchCodeRow[] {
  return rows.filter(
    (row) => row.batchCode !== deriveReservedBatchCode(row.expiresAt),
  );
}

/**
 * Busca filas de lote con la forma reservada mal escrita.
 *
 * Devuelve `[]` cuando la tabla todavía no existe (instalación nueva): sin
 * filas no hay conflicto posible, y eso es un preflight exitoso.
 */
export async function findReservedBatchCodeConflicts(
  runner: SqlRunner,
): Promise<ReservedBatchCodeRow[]> {
  const [table] = await runner.$queryRawUnsafe<{ present: boolean }[]>(
    `SELECT to_regclass('product_batches') IS NOT NULL AS present`,
  );
  if (!table?.present) return [];

  const rows = await runner.$queryRawUnsafe<ReservedBatchCodeRow[]>(
    reservedShapedBatchCodeSql(),
  );
  return nonCanonicalReservedRows(rows);
}

/**
 * Arma el informe para quien tiene que resolver las filas a mano.
 *
 * Solo lo que sirve para encontrar la caja: producto, código impreso, cantidad
 * y la fecha registrada. Nada de ids internos —el informe termina en el log del
 * despliegue y un cuid no ayuda a nadie a ir al estante.
 */
export function formatReservedBatchCodeReport(
  rows: ReservedBatchCodeRow[],
): string {
  const lines = rows.map((row) => {
    const vence = row.expiresAt ? bogotaDayKey(row.expiresAt) : "sin fecha";
    return `  ${JSON.stringify(row.batchCode)} — ${row.productName} (${row.productCode}), ${row.quantity} u., vence: ${vence}`;
  });

  return [
    `Hay ${rows.length} lote(s) con el código reservado mal escrito en 'product_batches'.`,
    "«SIN LOTE [fecha]» lo escribe el sistema para una caja SIN número de lote, y la",
    "fecha del código tiene que ser la del lote. Estas filas no cumplen eso:",
    "",
    ...lines,
    "",
    "Qué pasa si se dejan así: en pantalla se leen como «Sin lote» —tapando el código",
    "que tengan— y ninguna entrada nueva sobre ese lote se puede registrar, porque el",
    "repositorio la rechaza para no mezclar mercadería bajo un vencimiento ajeno.",
    "",
    "Qué hacer: decidí a mano el código de cada caja. Si trae número de lote impreso,",
    "corregí el código; si no lo trae, el correcto es el que deriva el sistema para su",
    "vencimiento. Ni este chequeo ni ninguna migración eligen o reescriben filas.",
  ].join("\n");
}
