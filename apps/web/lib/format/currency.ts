// --------------------------------------------------------------------------
// Formato de moneda colombiana (COP).
//
// El peso colombiano no usa centavos en la operación diaria: los montos se
// guardan y se muestran como enteros de pesos. Formatear con
// `maximumFractionDigits: 0` evita mostrar ",00" en todas las cifras.
//
// El separador de miles lo pone Intl con el locale es-CO (punto), que es lo que
// el operador lee en la droguería: 45.000, no 45,000.
// --------------------------------------------------------------------------

const COP_FORMATTER = new Intl.NumberFormat("es-CO", {
  style: "currency",
  currency: "COP",
  maximumFractionDigits: 0,
});

/**
 * Formatea un entero de pesos colombianos para mostrar. Redondea al peso: los
 * montos ya llegan enteros desde la base, así que un decimal acá sería un bug
 * del llamador y no queremos propagarlo a la pantalla.
 */
export function formatCop(pesos: number): string {
  return COP_FORMATTER.format(Math.round(pesos));
}

/**
 * Quita de un monto tipeado lo que es decoración: el símbolo, los espacios y el
 * punto de miles. NO interpreta nada más.
 *
 * Deliberadamente no toca la coma. En es-CO la coma es el separador DECIMAL, así
 * que borrarla convertiría "45.000,50" en 4500050 — cien veces el valor, guardado
 * sin que nadie lo note. Al dejarla, el resultado no es numérico y el validador
 * lo rechaza con un mensaje. Un error visible le gana a un monto equivocado.
 */
export function compactCopInput(value: string): string {
  return value.replace(/[\s$.]/g, "");
}

/**
 * Monto tipeado → entero de pesos, o null si no es un monto válido.
 *
 * Comparte `compactCopInput` con el validador del servidor a propósito: si la
 * pantalla y el servidor leyeran el mismo texto distinto, el operador vería un
 * saldo y se guardaría otro.
 */
export function parseCopInput(value: string): number | null {
  const compact = compactCopInput(value);
  if (compact.length === 0) return null;

  const parsed = Number(compact);
  if (!Number.isInteger(parsed) || parsed < 0) return null;
  return parsed;
}
