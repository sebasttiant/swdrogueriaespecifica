// --------------------------------------------------------------------------
// Teléfono del cliente en un pendiente.
//
// En el mostrador el número se dicta y se escribe como sale: "300 123 4567",
// "300-123-4567", "(601) 234 5678". Todas esas formas son el mismo teléfono, y
// guardarlas tal cual haría imposible buscar un cliente por su número.
//
// Se guarda la forma canónica: solo dígitos, conservando el "+" inicial cuando
// el número es internacional. La validación es de FORMA, no de existencia: el
// software no puede saber si el número atiende, pero sí puede frenar un tipeo
// de tres dígitos antes de que llegue a la base.
// --------------------------------------------------------------------------

// Un fijo colombiano son 7 dígitos; un celular, 10. El tope de 15 es el máximo
// que define E.164 para cualquier número del mundo, así que no recorta ningún
// número legítimo y sí frena un pegado accidental.
const MIN_PHONE_DIGITS = 7;
const MAX_PHONE_DIGITS = 15;

// Tope del texto que se acepta ANTES de limpiar. Deja lugar de sobra para
// separadores y paréntesis sin permitir un bloque de texto.
export const MAX_PHONE_INPUT_LENGTH = 40;

/**
 * Forma canónica de un teléfono, o null si no tiene forma de teléfono.
 *
 * Descarta espacios, guiones, puntos y paréntesis —decoración de lectura— y
 * conserva un "+" solo si abre el número. Un "+" en el medio no se ignora en
 * silencio: hace que el valor se rechace, porque significa que el texto no era
 * un teléfono y adivinar cuál quiso escribir sería inventar el dato.
 */
export function normalizePhone(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_PHONE_INPUT_LENGTH) return null;

  const international = trimmed.startsWith("+");
  const body = international ? trimmed.slice(1) : trimmed;

  // Solo se descarta lo que es separador visual. Cualquier otro carácter
  // (letras, un "+" interno) invalida el número en vez de limpiarse.
  if (/[^\d\s().-]/.test(body)) return null;

  const digits = body.replace(/[\s().-]/g, "");
  if (digits.length < MIN_PHONE_DIGITS || digits.length > MAX_PHONE_DIGITS) {
    return null;
  }

  return international ? `+${digits}` : digits;
}

/**
 * Teléfono para mostrar. El celular colombiano (10 dígitos) se agrupa 3-3-4,
 * que es como lo lee y lo dicta la gente. El resto se muestra tal cual: agrupar
 * un formato que no conocemos lo haría más difícil de leer, no menos.
 */
export function formatPhone(phone: string): string {
  if (phone.length === 10 && /^\d+$/.test(phone)) {
    return `${phone.slice(0, 3)} ${phone.slice(3, 6)} ${phone.slice(6)}`;
  }
  return phone;
}
