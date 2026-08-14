// Paleta de reportería. Los colores de ESTADO son semánticos y reservados: cada
// estado mantiene su color en toda la app (no se cicla por posición). Vienen de
// los tokens de tema en globals.css, mapeados a hex concreto porque recharts
// pinta con SVG y no resuelve variables CSS de forma confiable.
//
// Dentro de una misma dona los colores son distinguibles entre sí; PENDIENTE y
// PEDIDO comparten ámbar pero nunca aparecen en la misma leyenda (donas
// separadas de pendientes vs faltantes).

export const STATUS_COLORS: Record<string, string> = {
  // Pendientes
  PENDIENTE: "#f59e0b", // warning — abierto, esperando
  PARCIAL: "#0b66c3", // primary — en progreso
  ENTREGADO: "#16a34a", // success — cerrado OK
  // Faltantes
  FALTANTE: "#dc2626", // danger — crítico, sin gestionar
  PEDIDO: "#f59e0b", // warning — pedido al proveedor
  RECIBIDO: "#16a34a", // success — resuelto
  // Compartido
  CANCELADO: "#54708c", // muted — descartado
};

// Serie categórica de la tendencia (2 entidades). Color por entidad, no por rango.
export const SERIES_COLORS = {
  pendings: "#0b66c3", // primary
  missing: "#dc2626", // danger
} as const;

// Chrome del gráfico: grilla, líneas de eje, etiquetas y cursor del tooltip.
//
// A diferencia de los colores de ESTADO —que son semánticos y valen igual en
// claro y en oscuro—, estos son colores de interfaz y DEBEN seguir al tema. Con
// los hex claros que tenían antes, la grilla y los ejes desaparecían sobre el
// fondo oscuro.
//
// Van como `var()` y no como clases porque recharts no acepta className en
// estas props; el navegador resuelve la variable al pintar el SVG.
export const CHART_CHROME = {
  // Token propio: en claro vale exactamente el `#e6eef7` que tenía antes, así
  // que el gráfico no cambia ni un pixel; en oscuro sube para verse.
  grid: "var(--color-chart-grid)",
  axisLine: "var(--color-border)",
  tick: "var(--color-muted-foreground)",
  cursor: "var(--color-primary)",
} as const;
