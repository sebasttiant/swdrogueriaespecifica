import { prisma } from "@/lib/db/prisma";
import { clientOrderMissingWhere } from "@/server/repositories/missing-item.repository";

// --------------------------------------------------------------------------
// LO QUE BODEGA TIENE QUE RESOLVER DE LOS PEDIDOS DE CLIENTES.
//
// Vive dentro de Revisión de pendientes y no en una pantalla aparte: un
// pendiente se completa en UN solo lugar. Bodega entra al mismo módulo que
// gerencia y ve otra proyección — la física, sin datos comerciales.
//
// NO EXIGE QUE NADIE HAYA APRETADO "PEDIDO". Esa es la regla de negocio que
// esta cola existe para respetar: cuando el vendedor registra el pendiente, el
// cliente YA PIDIÓ el producto. Atar la recepción al estado PEDIDO —que lo
// pone gerencia pensando en el proveedor— hacía que bodega no viera nunca el
// pedido de un cliente.
//
// "Pedido por el cliente" y "pedido al proveedor" no son lo mismo.
//
// LA MINIMIZACIÓN VIVE ACÁ, no en la pantalla. Quien recibe una caja necesita
// saber qué producto es, cuánto falta y si ya llegó; no necesita el nombre del
// cliente, ni el teléfono, ni la dirección, ni cuánto abonó. Mandarlo para que
// la pantalla lo esconda sería mandarlo igual: viaja por la red y queda en el
// payload.
// --------------------------------------------------------------------------

/** Estados en los que un pendiente todavía espera existencia física. */
const OPEN_STATUSES = ["FALTANTE", "PEDIDO", "EN_BODEGA"] as const;

export type PendingReceptionItem = {
  /** El `MissingItem` que actúa de riel. Es el id con el que se opera. */
  id: string;
  /** El pendiente que lo originó. Para trazar, nunca para mostrar. */
  pendingId: string;
  /** La identidad EXACTA. Nunca se resuelve por nombre. */
  productId: string;
  productName: string;
  /** `null` mientras el producto no tenga identidad en Orion. */
  orionCode: string | null;
  unit: string;
  laboratoryName: string | null;
  requestedLaboratoryName: string | null;
  /** Lo que el cliente pidió. */
  requestedQuantity: number;
  /** Lo que ya quedó reservado contra inventario. */
  reservedQuantity: number;
  /** Lo que todavía falta conseguir. Es el número con el que bodega trabaja. */
  outstandingQuantity: number;
  /** `true` cuando bodega ya confirmó que la mercadería está en la droguería. */
  hasArrived: boolean;
  /** Quién confirmó la llegada y cuándo. Auditoría visible. */
  arrivedByName: string | null;
  arrivedAt: Date | null;
  /** Desde cuándo espera. Ordena la cola: lo más viejo primero. */
  requestedAt: Date;
};

const PAGE_SIZE = 50;

/**
 * La cola física de los pedidos de clientes, del más viejo al más nuevo.
 *
 * FIFO por antigüedad del pendiente y no por fecha de compra: acá no hay
 * compra: hay una persona esperando desde hace días.
 */
export async function listPendingReception(params?: {
  // Solo los que ya se pasaron de la fecha prometida. Lo escribe el chip
  // "Faltantes críticos" de la barra de alertas, que cuenta exactamente eso.
  overdueOnly?: boolean;
  now?: Date;
}): Promise<PendingReceptionItem[]> {
  const rows = await prisma.missingItem.findMany({
    // Mismo `where` que el contador del chip. Ver `clientOrderMissingWhere`:
    // escribirlo acá otra vez es cómo el chip termina diciendo un número que
    // esta lista no muestra.
    where: clientOrderMissingWhere(params),
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: PAGE_SIZE,
    // El `select` es la minimización: lo que no se nombra acá no sale de la
    // base. Cliente, teléfono, dirección, abonos y proveedor NO están.
    select: {
      id: true,
      originId: true,
      productId: true,
      quantity: true,
      receivedQuantity: true,
      status: true,
      arrivedAt: true,
      createdAt: true,
      arrivedBy: { select: { name: true } },
      product: {
        select: {
          name: true,
          orionCode: true,
          unit: true,
          laboratory: { select: { name: true } },
        },
      },
      requestedLaboratory: { select: { name: true } },
      origin: {
        select: { quantity: true, inventoryReadyQuantity: true, createdAt: true },
      },
    },
  });

  return rows.map((row) => {
    // LOS TRES NÚMEROS SALEN DE LUGARES DISTINTOS, y confundirlos da una cuenta
    // que parece razonable y está mal:
    //
    //   pedido      del PENDIENTE — lo que el cliente encargó.
    //   reservado   del PENDIENTE — lo que ya quedó apartado contra inventario.
    //   por conseguir del RIEL    — `MissingItem.quantity` YA ES EL DÉFICIT, no
    //                               el total: se crea con `quantity - listo`.
    //
    // Restarle lo reservado al riel descuenta dos veces la misma reserva. Con
    // 5 en estante y un pedido de 12, el riel nace en 7 y la resta daba 2:
    // bodega salía a buscar cinco unidades de menos.
    const reserved = row.origin?.inventoryReadyQuantity ?? 0;
    const requested = row.origin?.quantity ?? row.quantity;
    return {
      id: row.id,
      // `originId` es no-nulo por el filtro de arriba; el `??` solo satisface
      // al tipo, que no puede saberlo.
      pendingId: row.originId ?? "",
      productId: row.productId,
      productName: row.product.name,
      orionCode: row.product.orionCode,
      unit: row.product.unit,
      laboratoryName: row.product.laboratory?.name ?? null,
      requestedLaboratoryName: row.requestedLaboratory?.name ?? null,
      requestedQuantity: requested,
      reservedQuantity: reserved,
      // Del riel: el déficit pendiente menos lo que ya se recibió contra él.
      // Nunca negativo — una entrada grande puede cubrir de más.
      outstandingQuantity: Math.max(row.quantity - row.receivedQuantity, 0),
      hasArrived: row.status === "EN_BODEGA",
      arrivedByName: row.arrivedBy?.name ?? null,
      arrivedAt: row.arrivedAt,
      requestedAt: row.origin?.createdAt ?? row.createdAt,
    };
  });
}

/** Cuántos pedidos de clientes esperan una acción física de bodega. */
export function countPendingReception(): Promise<number> {
  return prisma.missingItem.count({ where: clientOrderMissingWhere() });
}
