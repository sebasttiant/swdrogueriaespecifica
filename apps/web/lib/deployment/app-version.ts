// --------------------------------------------------------------------------
// La identidad de ESTE build, en un solo lugar.
//
// `NEXT_PUBLIC_APP_VERSION` se resuelve en tiempo de compilación, así que el
// valor queda incrustado tanto en el bundle del cliente como en el del
// servidor. Eso es lo que hace detectable el desfase: una pestaña abierta antes
// del despliegue sigue afirmando la versión con la que se compiló, mientras el
// servidor ya responde con otra.
//
// Leerlo del entorno en runtime NO serviría para el cliente: cuando el
// navegador ejecuta el bundle, ese bundle ya está compilado y no tiene acceso
// al entorno del contenedor.
//
// En desarrollo el valor es `development` y NUNCA compara como desfase: ahí no
// hay despliegue del que desfasarse, y un guard que interrumpe mientras se
// trabaja se termina apagando — con él, la protección entera.
// --------------------------------------------------------------------------

/** Producción sin versión: un despliegue mal armado. Es un error, no un valor. */
export const UNKNOWN_VERSION = "unknown";

/** Fuera de producción no hay despliegue del que desfasarse. Se nombra en vez
 *  de dejar `unknown`: leer "development" en un log dice qué pasa; leer
 *  "unknown" obliga a averiguar si falta configuración o si es local. */
export const DEVELOPMENT_VERSION = "development";

/** Las dos son "no comparable", por motivos distintos. */
const NOT_COMPARABLE = new Set([UNKNOWN_VERSION, DEVELOPMENT_VERSION]);

export const APP_VERSION =
  process.env.NEXT_PUBLIC_APP_VERSION ??
  (process.env.NODE_ENV === "production" ? UNKNOWN_VERSION : DEVELOPMENT_VERSION);

/**
 * Una imagen de producción sin versión no es un detalle: es el guard entero
 * apagado en silencio. `isStale` trata `unknown` como "no sé" y nunca marca
 * desfase, así que un despliegue mal armado se vería idéntico a uno sano —
 * hasta que alguien facture desde una pestaña vieja.
 *
 * Falla en el arranque, que es cuando todavía se puede corregir. En desarrollo
 * no aplica: ahí no hay despliegue del que desfasarse.
 */
export function assertVersionConfigured(
  version: string = APP_VERSION,
  nodeEnv: string | undefined = process.env.NODE_ENV,
): void {
  if (nodeEnv !== "production") return;
  if (version !== UNKNOWN_VERSION) return;
  throw new Error(
    "NEXT_PUBLIC_APP_VERSION no llegó al build. Sin ella la detección de " +
      "desfase de versión queda apagada: pasá APP_VERSION como build-arg.",
  );
}

/**
 * Si dos versiones representan builds distintos.
 *
 * `unknown` NUNCA marca desfase, de ningún lado. En desarrollo no hay
 * despliegue del que desfasarse, y si por un error de configuración la variable
 * no llegara al build, el guard tiene que quedarse callado en vez de bloquear
 * todas las mutaciones de la aplicación por un dato que falta.
 */
export function isStale(client: string, server: string): boolean {
  if (NOT_COMPARABLE.has(client) || NOT_COMPARABLE.has(server)) return false;
  return client !== server;
}
