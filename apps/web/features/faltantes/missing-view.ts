// --------------------------------------------------------------------------
// Vista de la cola de faltantes (Mejora 3): "completa" (la de siempre, con
// badges/acciones/detalle) o "compacta" (solo producto, laboratorio, cantidad).
// El toggle viaja en la URL (?view=compact), igual que el scope de pendientes:
// server-rendered, sin estado de cliente, y con URL compartible. Cualquier valor
// que no sea exactamente "compact" cae en la vista completa.
// --------------------------------------------------------------------------

export type MissingView = "full" | "compact";

export function resolveMissingView(param?: string | null): MissingView {
  return param === "compact" ? "compact" : "full";
}
