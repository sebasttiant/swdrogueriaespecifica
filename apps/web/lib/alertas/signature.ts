export type AlertCounts = {
  expiredBatches: number;
  criticalBatches: number;
  /**
   * Lotes que vencen entre 31 y 90 días — el aviso con tres meses de
   * antelación.
   *
   * `countExpiringBatches` ya devolvía esta franja y el KPI del Dashboard ya la
   * mostraba, pero no existía acá: la barra de alertas pagaba la consulta y
   * descartaba el resultado. Tres meses es la ventana en la que todavía se
   * puede devolver al proveedor o rotar el lote; a 30 días ya suele ser tarde.
   */
  warningBatches: number;
  overdueDeliveries: number;
  upcomingDeliveries: number;
  criticalMissing: number;
  /** Productos del catálogo sin con qué cubrir lo ya prometido. Aviso de bodega. */
  stockoutProducts: number;
};

export function alertSignature(counts: AlertCounts): string {
  return [
    `exp:${counts.expiredBatches}`,
    `crit:${counts.criticalBatches}`,
    `warn:${counts.warningBatches}`,
    `over:${counts.overdueDeliveries}`,
    `up:${counts.upcomingDeliveries}`,
    `miss:${counts.criticalMissing}`,
    `stockout:${counts.stockoutProducts}`,
  ].join("|");
}
