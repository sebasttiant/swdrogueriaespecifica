import { prisma } from "@/lib/db/prisma";
import type { MissingItemOrigin } from "@/server/repositories/missing-item.repository";

// --------------------------------------------------------------------------
// La cola de RECEPCIÓN: lo que bodega tiene que recibir.
//
// Sale de `MissingItem` —el faltante operativo—, NO de `MissingReport`, que es
// el reporte provisional de un vendedor esperando revisión de compras. Los dos
// tienen una vista llamada "En bodega" y son cosas distintas: mezclarlos haría
// que bodega marque llegadas sobre reportes que nadie compró todavía.
//
// Bodega ve DOS estados y ninguno más:
//
//   PEDIDO     compras ya lo compró; bodega lo espera.
//   EN_BODEGA  llegó físicamente; falta registrar la entrada.
//
// FALTANTE queda afuera porque nadie lo compró: mostrarlo invitaría a recibir
// mercadería que no se pidió. CANCELADO queda afuera porque ya no va a llegar.
//
// LA MINIMIZACIÓN VIVE ACÁ, no en la pantalla. Quien recibe una caja necesita
// saber qué producto es y cuánto falta; no necesita saber para qué cliente es.
// Mandar el nombre del cliente para que la pantalla lo esconda sería mandarlo
// igual: viaja por la red y queda en el payload.
// --------------------------------------------------------------------------

/** Los dos estados que bodega puede ver y operar. */
export const RECEIVER_STATUSES = ["PEDIDO", "EN_BODEGA"] as const;

export type ReceiverScope = (typeof RECEIVER_STATUSES)[number];

export type ReceiverItem = {
  id: string;
  /** El pendiente que lo originó, para trazar. Nunca sus datos comerciales. */
  originId: string | null;
  /** La identidad EXACTA. Nunca se resuelve por nombre. */
  productId: string;
  productName: string;
  /** `null` mientras el producto no tenga identidad en Orion. */
  orionCode: string | null;
  unit: string;
  laboratoryName: string | null;
  requestedLaboratoryName: string | null;
  /** Lo que compras pidió. `null` en filas anteriores a esa derivación. */
  orderedQuantity: number | null;
  receivedQuantity: number;
  /** Lo que todavía falta recibir. Es el número con el que bodega trabaja. */
  outstandingQuantity: number;
  status: ReceiverScope;
  orderedAt: Date | null;
};

const RECEIVER_PAGE_SIZE = 50;

/**
 * Lo que bodega tiene que recibir, en el estado pedido.
 *
 * El orden es FIFO por `orderedAt`: lo que se compró primero se espera desde
 * hace más tiempo, y esa es la cola real del depósito.
 */
export async function listReceiverQueue(
  scope: ReceiverScope,
  // Eje de ORIGEN. `shelf` es lo único que se recibe por esta cola: los pedidos
  // de clientes se reciben en Revisión de pendientes, donde bodega marca la
  // llegada Y carga la entrada sin cambiar de pantalla. El default es "all"
  // para no cambiar en silencio a un llamador que todavía no eligió eje.
  origin: MissingItemOrigin = "all",
): Promise<ReceiverItem[]> {
  const originWhere =
    origin === "shelf"
      ? { originId: null }
      : origin === "pending"
        ? { originId: { not: null } }
        : {};

  const rows = await prisma.missingItem.findMany({
    where: { status: scope, ...originWhere },
    orderBy: [{ orderedAt: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    take: RECEIVER_PAGE_SIZE,
    // El `select` es la minimización: lo que no se nombra acá no sale de la
    // base. Cliente, teléfono, dirección, notas y proveedor no están.
    select: {
      id: true,
      originId: true,
      productId: true,
      quantity: true,
      orderedQuantity: true,
      receivedQuantity: true,
      status: true,
      orderedAt: true,
      product: {
        select: {
          name: true,
          orionCode: true,
          unit: true,
          laboratory: { select: { name: true } },
        },
      },
      requestedLaboratory: { select: { name: true } },
    },
  });

  return rows.map((row) => {
    // Lo esperado es lo que compras pidió; sin eso, lo que el cliente pidió.
    const expected = row.orderedQuantity ?? row.quantity;
    return {
      id: row.id,
      originId: row.originId,
      productId: row.productId,
      productName: row.product.name,
      orionCode: row.product.orionCode,
      unit: row.product.unit,
      laboratoryName: row.product.laboratory?.name ?? null,
      requestedLaboratoryName: row.requestedLaboratory?.name ?? null,
      orderedQuantity: row.orderedQuantity,
      receivedQuantity: row.receivedQuantity,
      outstandingQuantity: Math.max(expected - row.receivedQuantity, 0),
      status: row.status as ReceiverScope,
      orderedAt: row.orderedAt,
    };
  });
}

/**
 * Traduce el `?scope=` de la URL al estado que bodega puede ver.
 *
 * Cualquier otro valor —`pending`, `discarded`, o algo inventado— cae en
 * `PEDIDO`. NO alcanza con esconder las pestañas: quien escribe la URL a mano
 * tiene que recibir la cola permitida, no un error que revele que existe otra.
 */
export function resolveReceiverScope(param?: string | null): ReceiverScope {
  return param === "arrived" ? "EN_BODEGA" : "PEDIDO";
}
