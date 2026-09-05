
// --------------------------------------------------------------------------
// Reglas puras de la LISTA DE ESPERA.
//
// La lista de espera son los clientes que supieron que su producto demora y
// ACEPTARON esperarlo. No se deriva de cantidades ni de stock: es la respuesta
// de una persona, y por eso hay que registrarla. `Pending.waitlistDecision`
// guarda esa respuesta y es la ÚNICA fuente.
//
// No existe una segunda marca de "enviar a lista de espera", a propósito: dos
// columnas que significan lo mismo terminan contradiciéndose, y resolverlo
// obliga a inventar una regla de precedencia. Es el mismo error que ya costó la
// pestaña "Reportes" duplicando "Por pedir", y el que `review-axes.ts` advierte
// en su propio comentario.
//
// PURO: no toca Prisma ni el reloj. Lo usan el service —que vuelve a decidir
// por su cuenta— y la lista, que decide si ofrecer el gesto.
// --------------------------------------------------------------------------

// Estados desde los que tiene sentido preguntarle al cliente si espera.
//
// Es la cola ABIERTA menos AGOTADO. Un pendiente agotado no se consigue, así
// que no hay nada que esperar: su salida es que el vendedor le avise al cliente
// y lo rechace por el flujo normal. Es la misma exclusión, y por la misma
// razón, que hace `ALERT_STATUSES` en el repositorio —"mantenerlo en la alerta
// roja solo entrena a la gente a ignorarla"—. Meter AGOTADO acá llenaría la
// lista de espera de gente que no está esperando nada.
export const WAITLIST_STATUSES = [
  "PENDIENTE",
  "PARCIAL",
  "SOLICITADO",
  "BUSQUEDA",
  "COTIZANDO",
] as const;

export function acceptsWaitlistDecision(status: unknown): boolean {
  return (
    typeof status === "string" && (WAITLIST_STATUSES as readonly string[]).includes(status)
  );
}
