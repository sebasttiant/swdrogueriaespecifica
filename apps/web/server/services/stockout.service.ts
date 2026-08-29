import { prisma } from "@/lib/db/prisma";

// --------------------------------------------------------------------------
// QUIEBRE DE STOCK: un producto QUE LA DROGUERÍA LLEVA se quedó sin con qué
// cubrir lo que ya se le prometió a un cliente.
//
// Es un aviso para BODEGA, y es distinto de todo lo demás:
//
//   - No es un faltante de estantería. Eso lo decide y lo compra gerencia.
//   - No es "el producto no existe". El producto ESTÁ en el catálogo: lo
//     vendemos, normalmente lo tenemos, y hoy no alcanza.
//   - No es la cola de recepción. Ahí ya hay una orden puesta; acá todavía no.
//
// Por qué bodega y no gerencia: cuando un producto que sí llevamos llega a
// cero teniendo clientes esperando, lo primero no es comprar — es MIRAR EL
// DEPÓSITO. La caja puede estar recibida y sin cargar, o cargada a otro
// producto. Bodega es la única que puede resolver eso, y hasta hoy era la
// única que no recibía ningún aviso.
//
// Se mide contra el DÉFICIT ya calculado en el pendiente
// (`quantity - inventoryReadyQuantity`), no recontando lotes: ese número lo
// fijó `claimableStockForPending` bajo lock al registrar el pendiente, y es el
// mismo que alimenta la reserva. Recalcularlo acá abriría la puerta a que el
// aviso y la reserva discrepen.
// --------------------------------------------------------------------------

export type StockoutProduct = {
  productId: string;
  productName: string;
  /** El código de Orion. `null` mientras el producto no tenga identidad. */
  orionCode: string | null;
  unit: string;
  /** Cuántas unidades faltan para cubrir todo lo prometido. */
  missingQuantity: number;
  /** Cuántos clientes están esperando este producto. Nunca quiénes. */
  waitingCount: number;
  /** Desde cuándo espera el más viejo. Es la antigüedad del quiebre. */
  oldestSince: Date;
};

/** Tope defensivo: la pantalla es una lista de trabajo, no un reporte. */
const STOCKOUT_LIMIT = 50;

/**
 * Los productos en quiebre, del más viejo al más nuevo.
 *
 * MINIMIZADO A PROPÓSITO, igual que la cola de recepción: nombre de producto,
 * código, cuánto falta y desde cuándo. Ni cliente, ni teléfono, ni quién
 * vendió. Bodega necesita saber QUÉ buscar en el depósito y hace cuánto que
 * alguien lo espera; no necesita saber para quién es.
 */
export async function listStockoutProducts(): Promise<StockoutProduct[]> {
  const filas = await prisma.$queryRaw<
    {
      productId: string;
      productName: string;
      orionCode: string | null;
      unit: string;
      missingQuantity: bigint;
      waitingCount: bigint;
      oldestSince: Date;
    }[]
  >`
    SELECT p."productId",
           pr.name        AS "productName",
           pr."orionCode",
           pr.unit,
           SUM(p.quantity - p."inventoryReadyQuantity") AS "missingQuantity",
           COUNT(*)                                     AS "waitingCount",
           MIN(p."createdAt")                           AS "oldestSince"
      FROM pendings p
      JOIN products pr ON pr.id = p."productId"
     WHERE p.status::text NOT IN ('ENTREGADO', 'CANCELADO', 'CLOSED_PARTIAL')
       -- El déficit: lo prometido menos lo que ya quedó reservado para él.
       AND p.quantity > p."inventoryReadyQuantity"
       -- Solo productos VIGENTES del catálogo: un producto dado de baja no es
       -- un quiebre, es una decisión ya tomada.
       AND pr.active = true
     GROUP BY p."productId", pr.name, pr."orionCode", pr.unit
     ORDER BY MIN(p."createdAt") ASC, p."productId" ASC
     LIMIT ${STOCKOUT_LIMIT}
  `;

  // `SUM` y `COUNT` de PostgreSQL vuelven como BigInt: sin este casteo el
  // número llega al componente como un tipo que React no sabe pintar.
  return filas.map((fila) => ({
    productId: fila.productId,
    productName: fila.productName,
    orionCode: fila.orionCode,
    unit: fila.unit,
    missingQuantity: Number(fila.missingQuantity),
    waitingCount: Number(fila.waitingCount),
    oldestSince: fila.oldestSince,
  }));
}

/**
 * Cuántos PRODUCTOS distintos están en quiebre.
 *
 * Cuenta productos y no pendientes a propósito: es el número de cosas que
 * bodega tiene que ir a buscar al depósito. Tres clientes esperando el mismo
 * producto son UNA búsqueda, no tres.
 *
 * Usa EXACTAMENTE el mismo criterio que la lista, en la misma forma. El
 * déficit es una comparación COLUMNA contra COLUMNA, y expresarla con el
 * `having` de Prisma obligaba a comparar una suma contra una columna suelta:
 * dos consultas distintas que un día iban a decir cosas distintas, con el
 * contador prometiendo trabajo que la pantalla no mostraba.
 */
export async function countStockoutProducts(): Promise<number> {
  const [fila] = await prisma.$queryRaw<{ total: bigint }[]>`
    SELECT COUNT(DISTINCT p."productId") AS total
      FROM pendings p
      JOIN products pr ON pr.id = p."productId"
     WHERE p.status::text NOT IN ('ENTREGADO', 'CANCELADO', 'CLOSED_PARTIAL')
       AND p.quantity > p."inventoryReadyQuantity"
       AND pr.active = true
  `;
  return Number(fila?.total ?? 0);
}
