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
// `unknown` en desarrollo. Dos `unknown` comparan iguales, así que el guard no
// molesta mientras se trabaja — que es exactamente lo que se quiere.
// --------------------------------------------------------------------------

export const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? "unknown";

/**
 * Si dos versiones representan builds distintos.
 *
 * `unknown` NUNCA marca desfase, de ningún lado. En desarrollo no hay
 * despliegue del que desfasarse, y si por un error de configuración la variable
 * no llegara al build, el guard tiene que quedarse callado en vez de bloquear
 * todas las mutaciones de la aplicación por un dato que falta.
 */
export function isStale(client: string, server: string): boolean {
  if (client === "unknown" || server === "unknown") return false;
  return client !== server;
}
