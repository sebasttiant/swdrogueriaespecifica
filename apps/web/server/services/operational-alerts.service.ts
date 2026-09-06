import type { AlertCounts } from "@/lib/alertas/signature";
import { getExpiringBatchCounts } from "@/server/services/product-batch.service";
import {
  countOverduePendings,
  countUpcomingPendings,
} from "@/server/repositories/pending.repository";
import { countOverdueMissingItems } from "@/server/repositories/missing-item.repository";
import { countStockoutProducts } from "@/server/services/stockout.service";

const EMPTY_COUNTS: AlertCounts = {
  expiredBatches: 0,
  criticalBatches: 0,
  warningBatches: 0,
  overdueDeliveries: 0,
  upcomingDeliveries: 0,
  criticalMissing: 0,
  stockoutProducts: 0,
};

/**
 * A quién le habla cada aviso.
 *
 * `global` es gerencia: ve el estado de toda la droguería —lotes vencidos,
 * stock crítico, faltantes atrasados y las entregas de todos.
 *
 * `owner` es el vendedor: ve SOLO las entregas que él prometió. Lo demás no es
 * suyo. Un lote por vencer no lo resuelve él, y un faltante lo reporta y lo
 * deja: "coloco mi nombre y dejo que Andrés y don Guillermo hagan lo que
 * quieran con eso".
 *
 * `warehouse` es bodega. Durante un tiempo no recibió NINGÚN aviso, y con
 * razón: lo que había eran entregas a clientes y lotes por vencer, trabajo
 * ajeno. Pero hay un hecho que solo ella puede resolver — un producto que la
 * droguería SÍ lleva se quedó sin con qué cubrir lo prometido. Antes de
 * comprarlo hay que mirar el depósito: la caja puede estar recibida y sin
 * cargar. Ese es su aviso, y es el único.
 *
 * `none` queda para quien no tiene ninguna de las anteriores.
 */
export type AlertScope =
  | { kind: "global" }
  | { kind: "owner"; ownerId: string }
  | { kind: "warehouse" }
  | { kind: "none" };

export async function getOperationalAlerts(
  now: Date = new Date(),
  scope: AlertScope = { kind: "global" },
): Promise<AlertCounts> {
  if (scope.kind === "none") return EMPTY_COUNTS;

  if (scope.kind === "warehouse") {
    return { ...EMPTY_COUNTS, stockoutProducts: await countStockoutProducts() };
  }

  if (scope.kind === "owner") {
    const [overdueDeliveries, upcomingDeliveries] = await Promise.all([
      countOverduePendings(now, scope.ownerId),
      countUpcomingPendings(now, scope.ownerId),
    ]);
    return { ...EMPTY_COUNTS, overdueDeliveries, upcomingDeliveries };
  }

  const [
    expiringCounts,
    overdueDeliveries,
    upcomingDeliveries,
    criticalMissing,
    stockoutProducts,
  ] = await Promise.all([
    getExpiringBatchCounts(now),
    countOverduePendings(now),
    countUpcomingPendings(now),
    countOverdueMissingItems(now),
    // Gerencia también lo ve: un quiebre con clientes esperando es la señal
    // más temprana de que hay que comprar, antes de que el faltante venza.
    countStockoutProducts(),
  ]);

  return {
    expiredBatches: expiringCounts.expired,
    criticalBatches: expiringCounts.critical,
    warningBatches: expiringCounts.warning,
    overdueDeliveries,
    upcomingDeliveries,
    criticalMissing,
    stockoutProducts,
  };
}

// Versión cacheada (60s) para la AlertBar, que se renderiza en CADA navegación
// desde el AppShell. Estos avisos son advisory (posponibles 8h), así que 60s de
// desfase es irrelevante y evita recomputar ~5 count-queries por página. La
// alerta de gerencia (crítica) NO se cachea: se mantiene siempre en vivo.
// Sin caché, a propósito.
//
// Antes esto envolvía las consultas en `unstable_cache`. Al acotar los avisos
// por persona hubo que meter el alcance en la clave, y eso obligó a construir
// el wrapper en CADA request en vez de una vez por módulo: justo lo que Next
// no espera, y con la aplicación quedando colgada en "Guardando…" cuando el
// aviso se re-renderizaba dentro de una Server Action.
//
// Son cuatro `count()` sobre columnas indexadas para una droguería con un
// puñado de usuarios. El caché ahorraba milisegundos y costaba que el aviso
// mintiera hasta un minuto después de cada entrega, de cada cancelación y de
// cada reset de datos. Mal negocio.
export function getOperationalAlertsCached(
  scope: AlertScope = { kind: "global" },
): Promise<AlertCounts> {
  return getOperationalAlerts(new Date(), scope);
}
