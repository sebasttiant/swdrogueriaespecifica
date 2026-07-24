// --------------------------------------------------------------------------
// Zona del cliente (seguimiento de entrega).
//
// La zona se escribe a mano, pero NO se guarda tal cual: se canoniza. Sin esto
// "norte", "Norte" y "  NORTE " son tres zonas distintas para un GROUP BY, y el
// reporte por zona que pide gerencia queda inservible desde el primer mes.
//
// Se guarda UNA sola forma canónica (a diferencia de `MissingReport`, que
// conserva `rawName` además de `normalizedName`): en un nombre de zona no hay
// información que valga la pena preservar más allá de su forma limpia.
// --------------------------------------------------------------------------

// Palabras que no se capitalizan dentro del nombre: "Barrio de la Cruz" se lee
// como lo escribiría una persona, no "Barrio De La Cruz". La primera palabra
// siempre se capitaliza, aunque esté en esta lista.
const LOWERCASE_WORDS = new Set(["de", "del", "la", "las", "los", "el", "y"]);

// Cota de cordura: un nombre de zona es "Norte", "Centro", "Vía La Calera".
// Frena un pegado accidental de texto, no un nombre legítimo.
export const MAX_ZONE_LENGTH = 60;

/**
 * Forma canónica de una zona: sin caracteres de control, sin espacios
 * sobrantes, y capitalizada de manera estable.
 *
 * Devuelve null cuando no queda contenido (vacío, solo espacios o solo
 * caracteres de control): la zona es opcional y un string vacío no es un dato.
 */
export function normalizeZone(value: string): string | null {
  const cleaned = value
    // Caracteres de control: invisibles, romperían el agrupado en silencio.
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .trim()
    .replace(/\s+/g, " ");

  if (cleaned.length === 0) return null;

  return cleaned
    .toLocaleLowerCase("es-CO")
    .split(" ")
    .map((word, index) =>
      index > 0 && LOWERCASE_WORDS.has(word)
        ? word
        : word.charAt(0).toLocaleUpperCase("es-CO") + word.slice(1),
    )
    .join(" ");
}
