// --------------------------------------------------------------------------
// Servicio de faltantes (server-only). Boundary de lectura: la página delega
// acá y nunca toca el repositorio directo. La creación automática de faltantes
// vive en `pending.service` porque es un efecto del caso de uso "registrar
// pendiente" (ver computeMissingQuantity).
// --------------------------------------------------------------------------

import { prisma } from "@/lib/db/prisma";
import type { Paginated } from "@/lib/pagination";
import {
  confirmMissingItem,
  countConfirmedMissingItems,
  countOpenMissingItems,
  countOrderedMissingItems,
  countOverdueMissingItems,
  createMissingItem,
  listMissingItems,
  discardMissingItem,
  lockMissingItemForUpdate,
  listOpenMissingItemsForExport,
  orderMissingItem as persistOrderedMissingItem,
  type MissingItemListItem,
} from "@/server/repositories/missing-item.repository";
import { reporterNamesByLinkedItemIds } from "@/server/repositories/missing-report.repository";
import {
  buildMissingExportRows,
  type MissingExportRow,
} from "@/server/services/missing-export.service";
import type { MissingItemStatus } from "@/lib/generated/prisma/client";
import { canDiscard, canTransitionToOrdered } from "@/features/faltantes/order-rules";
import {
  findSupplierById,
  upsertProductSupplierLink,
  upsertSupplierByName,
} from "@/server/repositories/supplier.repository";
import { findProductById } from "@/server/repositories/product.repository";

export type ConfirmMissingItemInput = {
  id: string;
  confirmedById: string;
  confirmedAt?: Date;
  note?: string;
};

export type ConfirmMissingItemResult = {
  item: {
    id: string;
    status: MissingItemStatus;
    confirmedAt: Date | null;
    confirmedById: string | null;
    confirmationNote: string | null;
  };
  changed: boolean;
};

// Rechazos de negocio esperados del pedido: se DEVUELVEN (no se lanzan), igual
// que `deliverPending`. La UI los mapea a un mensaje; nunca son un error 500.
export type OrderRejection =
  | "ALREADY_ORDERED"
  | "ALREADY_CONFIRMED"
  | "NOT_ORDERABLE"
  | "SUPPLIER_NOT_FOUND";

export type OrderMissingItemInput = {
  missingItemId: string;
  userId: string;
  // Cantidad que gerencia decide comprar. Definida en el formulario "Pedir" y
  // revalidada en la server action; el service solo la persiste con el pedido.
  orderedQuantity: number;
  supplier:
    | { kind: "existing"; supplierId: string }
    | { kind: "new"; name: string; phone?: string; address?: string; email?: string };
};

export type OrderMissingItemResult = {
  item: {
    id: string;
    status: MissingItemStatus;
    orderedAt: Date | null;
    supplierId: string | null;
  } | null;
  rejection: OrderRejection | null;
};

export type CreateManualMissingItemInput = {
  productId: string;
  createdById?: string | null;
  note?: string;
  sellerCode?: string | null;
};

// `MissingItem.quantity` remains mandatory because automatic shortages retain
// their calculated deficit. Manual catalog entries do not collect a deficit;
// management defines the purchase quantity later in `orderedQuantity`.
const MANUAL_MISSING_ITEM_QUANTITY = 1;

// Invariante: la confirmación ("OK gerencia") SOLO aplica a un faltante que
// sigue FALTANTE y sin confirmar. Una vez que el faltante pasó a PEDIDO, la
// confirmación NO debe setear `confirmedAt` (produciría el estado imposible
// PEDIDO + confirmedAt). El repositorio refuerza este mismo filtro en su CAS.
const CONFIRMABLE_STATUSES: MissingItemStatus[] = ["FALTANTE"];

// Faltante enriquecido con el nombre del solicitante (Mejora 5). `requestedByName`
// es derivado en el service —no vive en la fila de `MissingItem`—, así que se
// expone acá y no en el tipo del repositorio.
export type MissingItemListEntry = MissingItemListItem & {
  requestedByName: string | null;
};

export async function getMissingItems(params: {
  cursor?: string | null;
  take?: number;
  // Requerido (sin default): que falte el flag debe ser un error de tipos,
  // nunca una fuga silenciosa de PII. `false` fuerza la minimización abajo.
  canViewCustomerIdentity: boolean;
  // Idem para la identidad del proveedor. Requerido por la misma razón: un
  // default permisivo convertiría un olvido del llamador en una fuga silenciosa.
  canViewSupplierIdentity: boolean;
}): Promise<Paginated<MissingItemListEntry>> {
  const { canViewCustomerIdentity, canViewSupplierIdentity, ...listParams } = params;
  const { items, nextCursor } = await listMissingItems(listParams);

  // El solicitante real: si el faltante nació de un reporte de vendedor, su
  // `createdBy` es gerencia (quien lo vinculó), así que el vendedor está en el
  // `reporter` del reporte. Una consulta por lote (índice `linkedMissingItemId`)
  // resuelve toda la página sin N+1.
  const reporterNames = await reporterNamesByLinkedItemIds(items.map((item) => item.id));

  // Minimización server-side: el nombre del cliente nunca llega al cliente
  // (ni siquiera serializado en el HTML) para roles sin esta capability.
  // Nunca mutamos las filas del repositorio; devolvemos objetos nuevos.
  const enrichedItems = items.map((item) => {
    const withoutCustomer = canViewCustomerIdentity
      ? item
      : {
          ...item,
          origin: item.origin ? { ...item.origin, customerName: null } : null,
        };
    // Identidad del proveedor: se corta acá, en el servidor, por la misma razón
    // que el nombre del cliente. Si solo se ocultara la columna en el render, el
    // nombre viajaría igual dentro del payload y cualquiera lo leería desde el
    // inspector del navegador. `supplierId` se anula junto con el nombre: el id
    // solo también identifica al proveedor si se cruza con otra pantalla.
    const base = canViewSupplierIdentity
      ? withoutCustomer
      : { ...withoutCustomer, supplier: null, supplierId: null };
    // Reporte → reporter; si no, quien lo creó (vendedor del pendiente o
    // gerencia en el alta manual). Nombre de staff, no PII de cliente.
    const requestedByName =
      reporterNames.get(item.id) ?? item.createdBy?.name ?? null;
    return { ...base, requestedByName };
  });

  return { items: enrichedItems, nextCursor };
}

// Export (Mejora 3): filas ya aplanadas de TODOS los faltantes abiertos, para
// que la ruta las vuelque a CSV/Excel. No pagina —el export es la lista
// completa, no una página— y no toca PII (las columnas son producto,
// laboratorio, cantidad, estado, proveedor).
export async function getMissingItemsForExport(
  canViewSupplierIdentity: boolean,
): Promise<MissingExportRow[]> {
  const items = await listOpenMissingItemsForExport();
  return buildMissingExportRows(items, canViewSupplierIdentity);
}

export async function createManualMissingItem(input: CreateManualMissingItemInput) {
  const product = await findProductById(input.productId);
  if (!product || !product.active) throw new Error("Product not found");

  return createMissingItem({
    productId: input.productId,
    quantity: MANUAL_MISSING_ITEM_QUANTITY,
    originId: null,
    createdById: input.createdById ?? null,
    note: input.note,
    sellerCode: input.sellerCode ?? null,
  });
}

// Conteo de faltantes abiertos para el KPI del dashboard.
export function getOpenMissingCount(): Promise<number> {
  return countOpenMissingItems();
}

export type MissingItemsSummary = {
  open: number;
  overdue: number;
  ordered: number;
  confirmed: number;
};

// Métricas GLOBALES (no derivadas de la página actual, que está paginada por
// cursor). `overdue` es un SUBCONJUNTO de `open` (además exige confirmedAt:
// null + status abierto + promesa vencida) — la UI debe dejarlo claro.
// `now` inyectable para tests deterministas.
export async function getMissingItemsSummary(
  now: Date = new Date(),
): Promise<MissingItemsSummary> {
  const [open, overdue, ordered, confirmed] = await Promise.all([
    countOpenMissingItems(),
    countOverdueMissingItems(now),
    countOrderedMissingItems(),
    countConfirmedMissingItems(),
  ]);
  return { open, overdue, ordered, confirmed };
}

// Se lanza cuando el compare-and-set no escribe ninguna fila. Con el lock de
// fila tomado es inalcanzable: existe para que un llamador futuro que se saltee
// `lockMissingItemForUpdate` aborte la transacción en vez de pisar el estado.
class MissingItemConcurrentModificationError extends Error {
  constructor(id: string) {
    super(`Missing item ${id} changed concurrently; transaction rolled back`);
    this.name = "MissingItemConcurrentModificationError";
  }
}

/**
 * Confirma un faltante ("OK gerencia"). Corre bajo el MISMO lock de fila que
 * `orderMissingItem`: sin él, una confirmación cuya lectura quedó obsoleta
 * escribiría `confirmedAt` sobre un faltante que un pedido concurrente acaba de
 * pasar a PEDIDO, produciendo el estado imposible PEDIDO + confirmedAt.
 *
 * Invariante: solo se confirma un faltante que sigue FALTANTE y sin confirmar.
 * Un PEDIDO (o cualquier estado cerrado) vuelve con `changed: false` y sin
 * escrituras, incluso si `confirmedAt` aún es null — justamente la carrera en
 * la que el pedido ganó el lock y dejó la fila en PEDIDO + confirmedAt: null.
 * El CAS del repositorio vuelve a reforzar `status: "FALTANTE"` por si un
 * llamador futuro se saltea el lock.
 *
 * Idempotente: un faltante ya confirmado (o en un estado no confirmable) vuelve
 * con `changed: false` y sin escrituras.
 */
export async function confirmMissingItemOk(
  input: ConfirmMissingItemInput,
): Promise<ConfirmMissingItemResult> {
  return prisma.$transaction(async (tx): Promise<ConfirmMissingItemResult> => {
    const current = await lockMissingItemForUpdate(tx, input.id);
    if (!current) throw new Error("Missing item not found");

    if (
      current.confirmedAt !== null ||
      !CONFIRMABLE_STATUSES.includes(current.status)
    ) {
      return { item: current, changed: false };
    }

    const confirmedAt = input.confirmedAt ?? new Date();
    const written = await confirmMissingItem(tx, { ...input, confirmedAt });
    if (written !== 1) {
      throw new MissingItemConcurrentModificationError(current.id);
    }

    return {
      item: {
        id: current.id,
        status: current.status,
        confirmedAt,
        confirmedById: input.confirmedById,
        confirmationNote: input.note ?? null,
      },
      changed: true,
    };
  });
}

// Pide un faltante a un proveedor. TODO el caso de uso (lock + resolución del
// proveedor + enlace producto↔proveedor + escritura del pedido) corre en UNA
// sola transacción interactiva, igual que `deliverPending`. `now` inyectable
// para tests deterministas. Solo lanza si el faltante no existe o si el CAS no
// escribe; los rechazos de negocio se devuelven.
export async function orderMissingItem(
  input: OrderMissingItemInput,
  now: Date = new Date(),
): Promise<OrderMissingItemResult> {
  return prisma.$transaction(async (tx): Promise<OrderMissingItemResult> => {
    // El lock de fila serializa dos gerentes pidiendo el mismo faltante: el
    // segundo espera, relee PEDIDO y se lleva ALREADY_ORDERED en vez de pisar
    // el proveedor del primero.
    const current = await lockMissingItemForUpdate(tx, input.missingItemId);
    if (!current) throw new Error("Missing item not found");

    // Precedencia de rechazo, determinística cuando aplica más de una regla:
    //   1) ALREADY_ORDERED   — status ya es PEDIDO (el pedido ya se registró).
    //   2) ALREADY_CONFIRMED — confirmedAt tiene valor: es la señal de CIERRE
    //      ("OK gerencia"), independiente del status. Un faltante confirmado
    //      queda fuera del scope "active" de `listMissingItems` pero puede
    //      llegar acá por un formulario obsoleto o reenviado; sin este check
    //      terminaría en el estado imposible PEDIDO + confirmedAt seteado.
    //   3) NOT_ORDERABLE     — cualquier otro estado no ordenable (RECIBIDO,
    //      CANCELADO).
    if (current.status === "PEDIDO") {
      return { item: null, rejection: "ALREADY_ORDERED" };
    }
    if (current.confirmedAt !== null) {
      return { item: null, rejection: "ALREADY_CONFIRMED" };
    }
    if (!canTransitionToOrdered(current.status)) {
      return { item: null, rejection: "NOT_ORDERABLE" };
    }

    // Resolvemos el proveedor: existente (lookup) o nuevo (upsert por nombre).
    let supplierId: string;
    if (input.supplier.kind === "existing") {
      const supplier = await findSupplierById(input.supplier.supplierId, tx);
      if (!supplier) {
        return { item: null, rejection: "SUPPLIER_NOT_FOUND" };
      }
      supplierId = supplier.id;
    } else {
      const created = await upsertSupplierByName(tx, {
        name: input.supplier.name.trim(),
        phone: input.supplier.phone ?? null,
        address: input.supplier.address ?? null,
        email: input.supplier.email ?? null,
      });
      supplierId = created.id;
    }

    // Enlazamos producto↔proveedor (idempotente por la unique compuesta).
    await upsertProductSupplierLink(tx, {
      productId: current.productId,
      supplierId,
    });

    const written = await persistOrderedMissingItem(tx, input.missingItemId, {
      supplierId,
      orderedById: input.userId,
      orderedAt: now,
      orderedQuantity: input.orderedQuantity,
    });
    // Rollback: el proveedor creado al vuelo y el enlace producto↔proveedor se
    // revierten con la transacción, así que no queda un proveedor huérfano.
    if (written !== 1) {
      throw new MissingItemConcurrentModificationError(current.id);
    }

    return {
      item: { id: current.id, status: "PEDIDO", orderedAt: now, supplierId },
      rejection: null,
    };
  });
}

// --------------------------------------------------------------------------
// Acciones masivas de gerencia sobre la cola de faltantes.
//
// Dos vendedores anotan el mismo producto, o gerencia ya lo compró por fuera
// del sistema: en ambos casos la cola queda con filas que no representan
// trabajo pendiente. Cerrarlas de a una es el cuello de botella que se pidió
// resolver.
//
// Se procesa fila por fila, cada una con SU lock y su resultado: un lote no es
// una transacción única. Si lo fuera, un solo faltante que otro gerente tocó
// medio segundo antes haría fallar las otras cuatro, y el operador tendría que
// adivinar cuál fue y rehacer la selección entera.
// --------------------------------------------------------------------------

export type BulkDiscardInput = {
  ids: readonly string[];
  discardedById: string;
  reason?: string;
};

export type BulkResult = {
  // Filas efectivamente escritas por esta llamada.
  discarded: string[];
  // Ya no estaban FALTANTE al tomar el lock: otro las pidió o descartó primero.
  // No es un error: es el resultado honesto de una carrera.
  skipped: string[];
};

export async function discardMissingItems(
  input: BulkDiscardInput,
  now: Date = new Date(),
): Promise<BulkResult> {
  const discarded: string[] = [];
  const skipped: string[] = [];

  for (const id of input.ids) {
    // Una transacción POR FALTANTE: el lock se toma y se suelta por fila, así
    // un lote grande no bloquea la cola entera mientras corre.
    const written = await prisma.$transaction(async (tx) => {
      const locked = await lockMissingItemForUpdate(tx, id);
      // Fila inexistente o ya fuera de FALTANTE: nada que descartar.
      if (!locked || !canDiscard(locked.status)) return 0;

      return discardMissingItem(tx, id, {
        discardedById: input.discardedById,
        discardedAt: now,
        reason: input.reason,
      });
    });

    (written > 0 ? discarded : skipped).push(id);
  }

  return { discarded, skipped };
}
