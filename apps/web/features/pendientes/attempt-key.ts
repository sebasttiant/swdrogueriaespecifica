// --------------------------------------------------------------------------
// Clave del intento de registro (idempotencia, lado cliente).
//
// Identifica UN intento de cargar un pendiente. Se mantiene igual mientras el
// registro siga fallando —para que el reintento caiga sobre la misma fila en vez
// de crear una segunda— y se renueva cuando el alta sale bien.
//
// POR QUÉ NO `crypto.randomUUID()`:
//
// Esa API solo existe en contextos seguros. El acceso normal es por HTTPS (túnel
// de Cloudflare con dominio propio), así que ahí estaría disponible — pero el
// puerto 3132 del VPS sigue publicado y se entra por `http://<ip>:3132` para
// soporte y pruebas. En ese camino `crypto.randomUUID` es `undefined` y usarla
// tiraría un TypeError en pleno submit.
//
// `crypto.getRandomValues` no tiene esa restricción y funciona en los dos casos,
// así que no hay motivo para preferir la que falla en uno. El valor solo tiene
// que ser único, no impredecible: el servidor valida la forma y la unicidad la
// garantiza el índice único de la columna.
// --------------------------------------------------------------------------

function randomBytes(count: number): Uint8Array {
  const bytes = new Uint8Array(count);
  const webCrypto = globalThis.crypto;
  if (webCrypto && typeof webCrypto.getRandomValues === "function") {
    webCrypto.getRandomValues(bytes);
    return bytes;
  }
  // Último recurso. Peor calidad, pero un intento sin clave sería un intento sin
  // protección contra duplicados, que es exactamente lo que hay que evitar.
  for (let i = 0; i < count; i += 1) {
    bytes[i] = Math.floor(Math.random() * 256);
  }
  return bytes;
}

/**
 * UUID v4 en la forma que el servidor valida.
 *
 * Se arma a mano en vez de usar `randomUUID` por la razón de arriba. Los bits de
 * versión (4) y variante (10xx) se fijan explícitamente para que el resultado
 * pase la validación de forma del servidor.
 */
export function newAttemptKey(): string {
  const bytes = randomBytes(16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}
