// Paginación de la cola de revisión de reportes.
//
// Vive en su propia ruta, separada de `/faltantes`, porque las dos colas
// paginan distinto: los faltantes por CURSOR (`?cursor=`) y esta por OFFSET
// (`?page=`), ya que agrupa con `groupBy` y Prisma no admite cursor ahí.
// Mantenerlas en URLs distintas evita que ambos parámetros convivan y se pisen.

export const REVIEW_QUEUE_PATH = "/revision-faltantes";

// Techo del número de página. Sin él, un `?page` absurdo se traduce en un OFFSET
// enorme y un scan caro. La cola es admin-only y el `take` ya está acotado, así
// que esto es defensa en profundidad, no una regla de negocio.
export const MAX_REVIEW_QUEUE_PAGE = 1000;

/**
 * Número de página desde el search param. Es input del usuario: cualquier valor
 * inválido, cero o negativo cae en la primera página, nunca en un offset
 * negativo ni en NaN.
 */
export function parseReportQueuePage(raw: string | undefined): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return 1;
  return Math.min(MAX_REVIEW_QUEUE_PAGE, Math.max(1, Math.trunc(parsed)));
}

/** URL de una página de la cola. La primera queda en la ruta limpia. */
export function reportQueueHref(page: number, scope?: string): string {
  const safePage = Math.max(1, Math.trunc(page));
  const params = new URLSearchParams();
  // "pending" es la vista por defecto: no ensucia la URL que el gerente guarda.
  if (scope && scope !== "pending") params.set("scope", scope);
  if (safePage > 1) params.set("page", String(safePage));
  const query = params.toString();
  return query ? `${REVIEW_QUEUE_PATH}?${query}` : REVIEW_QUEUE_PATH;
}
