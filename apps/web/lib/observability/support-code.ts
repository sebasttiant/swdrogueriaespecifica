// --------------------------------------------------------------------------
// Support code — el identificador que une lo que ve el operador con el log.
//
// Cuando un registro falla, el operador ve `PND-K7M2QX` en pantalla y nos lo
// dicta por teléfono. Ese mismo string es el `correlationId` de TODOS los
// eventos de ese intento en el servidor, así que encontrarlo es un grep, no una
// búsqueda por hora aproximada cruzando datos del cliente.
//
// Un solo identificador, no dos: un código para mostrar y un uuid interno
// obligarían a mantener la traducción entre ambos, y en el momento en que esa
// traducción se pierde el código deja de servir para lo único que existe.
//
// ALFABETO: sin I, L, O, U, 0 ni 1. El código se DICTA por teléfono, y esos
// caracteres se confunden al hablar ("o" / "cero", "i" / "ele" / "uno"). La U se
// excluye además para no formar palabras ofensivas por casualidad.
// --------------------------------------------------------------------------

const ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LENGTH = 6;

/** Prefijo del módulo: distingue un código de pendientes de uno de otro flujo. */
export const SUPPORT_CODE_PREFIX = "PND";

const SUPPORT_CODE_PATTERN = new RegExp(
  `^${SUPPORT_CODE_PREFIX}-[${ALPHABET}]{${CODE_LENGTH}}$`,
);

/**
 * Genera un código de soporte nuevo, ej. `PND-K7M2QX`.
 *
 * 30^6 ≈ 729 millones de combinaciones. No es un identificador único global ni
 * pretende serlo: solo necesita ser irrepetible dentro de la ventana de logs que
 * se consulta (horas, a lo sumo días). Para eso sobra.
 *
 * Usa `crypto.getRandomValues` y no `Math.random` porque el código termina en un
 * log que alguien puede intentar adivinar para leer el intento de otra persona.
 */
export function newSupportCode(): string {
  const bytes = new Uint8Array(CODE_LENGTH);
  crypto.getRandomValues(bytes);
  let code = "";
  for (const byte of bytes) {
    // Sesgo despreciable (256 % 30 = 16): el código no es material criptográfico,
    // solo tiene que ser difícil de adivinar y fácil de dictar.
    code += ALPHABET[byte % ALPHABET.length];
  }
  return `${SUPPORT_CODE_PREFIX}-${code}`;
}

/** Valida la forma de un código antes de usarlo para filtrar logs. */
export function isSupportCode(value: string): boolean {
  return SUPPORT_CODE_PATTERN.test(value);
}
