// --------------------------------------------------------------------------
// Readiness: ¿la aplicación puede ATENDER, o solo está encendida?
//
// Son dos preguntas distintas y hasta ahora había una sola respuesta.
// `/api/health` contesta "el proceso web responde" y NO toca la base a
// propósito —está escrito en su comentario—, para poder distinguir "la web se
// cayó" de "la base se cayó". Ese endpoint no cambia: es el que mira el
// healthcheck de Docker, y meterle una consulta haría que un hipo de Postgres
// marcara el contenedor como enfermo y lo reiniciara. Un reinicio no arregla
// una base caída; solo agrega una caída más.
//
// Lo que faltaba es la otra mitad: saber si la aplicación LLEGA a la base. Sin
// eso, un despliegue con la `DATABASE_URL` mal escrita se ve perfectamente sano
// hasta que una persona intenta cargar un pendiente.
//
// Este módulo es la regla, sin Next y sin Prisma: recibe una sonda y decide.
// Así se puede probar el vencimiento y el fallo sin una base y sin un servidor.
// --------------------------------------------------------------------------

/**
 * Cuánto se espera a la base antes de declararla inalcanzable.
 *
 * Tres segundos: un readiness que tarda más deja de servir para decidir —quien
 * pregunta ya tomó su decisión— y una consulta trivial que no vuelve en ese
 * tiempo es un problema, tarde o temprano.
 */
export const READINESS_TIMEOUT_MS = 3_000;

export type ReadinessResult =
  | { ready: true }
  /**
   * `reason` es una CATEGORÍA, nunca el error.
   *
   * "unavailable" y "timeout" le dicen a quien opera qué mirar sin publicar
   * nada: el mensaje de un error de conexión de PostgreSQL trae el host, el
   * puerto, la base y el usuario, y este endpoint responde sin autenticación.
   */
  | { ready: false; reason: "unavailable" | "timeout" };

export type ReadinessOptions = {
  timeoutMs?: number;
  /**
   * Dónde va el error de verdad: al log del servidor, que sí es privado.
   *
   * Existe para no tener que elegir entre tragarse el fallo y publicarlo. Un
   * `catch` que no deja rastro es lo que convierte una caída en un misterio.
   */
  onError?: (error: unknown) => void;
};

/**
 * Corre la sonda con un límite de tiempo y traduce el resultado.
 *
 * No propaga nunca: un readiness que explota no informa nada. Lo que decide es
 * si la sonda TERMINÓ bien, no qué devolvió.
 */
export async function checkReadiness(
  probe: () => Promise<unknown>,
  { timeoutMs = READINESS_TIMEOUT_MS, onError }: ReadinessOptions = {},
): Promise<ReadinessResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const vencimiento = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });

  try {
    // La sonda puede fallar DESPUÉS de que ganó el vencimiento. Sin este
    // `catch`, ese rechazo tardío queda sin manejar y —según la configuración
    // del runtime— puede tumbar el proceso: el chequeo de salud terminaría
    // causando la caída que vino a detectar.
    const sonda = probe().then(
      () => "ok" as const,
      (error: unknown) => {
        onError?.(error);
        return "error" as const;
      },
    );

    const resultado = await Promise.race([sonda, vencimiento]);

    if (resultado === "ok") return { ready: true };
    if (resultado === "error") return { ready: false, reason: "unavailable" };
    return { ready: false, reason: "timeout" };
  } catch (error) {
    // Que ni siquiera se haya podido LLAMAR a la sonda —un cliente que no se
    // construye porque falta configuración— también es "no está lista".
    onError?.(error);
    return { ready: false, reason: "unavailable" };
  } finally {
    // Sin esto, el temporizador mantiene vivo el event loop hasta 3 segundos
    // después de cada consulta.
    if (timer) clearTimeout(timer);
  }
}
