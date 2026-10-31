// --------------------------------------------------------------------------
// La forma canónica del código de Orión.
//
// En Orión todo producto se identifica con la letra A pegada a su número:
// `A15637`. Pero en la droguería cada persona lo tipea a su manera —`15637`,
// `a-15637`, `SKU15637`— y hasta ahora el sistema guardaba literalmente lo que
// recibía. El resultado, medido en producción el 31/10/2026: 1115 de 1122
// productos con el código mal escrito y 139 productos partidos en hasta CINCO
// copias, cada una con su stock, sus pendientes y sus faltantes.
//
// De ahí salieron los tres incidentes que parecían distintos —SEDATIF, VALCOTE
// y PROBIOESEENS— y que eran el mismo: el mostrador cargaba contra una copia y
// bodega miraba la otra.
//
// Dos conceptos separados a propósito:
//
//   núcleo    los dígitos que identifican al producto, sin prefijo. Es lo que
//             se COMPARA: `15637`, `a-15637` y `SKU15637` tienen el mismo.
//   canónico  cómo se GUARDA de ahora en más: `A` + núcleo.
//
// Lo que NO hace: adivinar. Si al quitar el prefijo no queda un número, el
// código se respeta tal cual. `ABC123` no es `A` + `BC123`: es un código que
// no sigue la convención, y recortarle la A inventaría una identidad que nadie
// escribió.
// --------------------------------------------------------------------------

/** Prefijos que la droguería escribe indistintamente delante del número. */
const ORION_PREFIX = /^(?:sku|a-?)/i;

function isDigits(value: string): boolean {
  return /^[0-9]+$/.test(value);
}

/**
 * Los dígitos que identifican al producto, sin importar cómo se escribió.
 *
 * Es la clave de COMPARACIÓN: dos códigos con el mismo núcleo son el mismo
 * producto de Orión. Para un código que no sigue la convención devuelve el
 * texto en mayúsculas, que sigue siendo comparable consigo mismo.
 */
export function orionNumericCore(raw: string): string {
  const code = raw.trim();
  const stripped = code.replace(ORION_PREFIX, "");
  return isDigits(stripped) ? stripped : code.toUpperCase();
}

/**
 * Cómo se guarda el código de ahora en más: `A` + número, como lo muestra
 * Orión.
 *
 * Un código fuera de la convención se devuelve TAL CUAL, solo recortado. No se
 * pasa a mayúsculas: `Ori-8842a` y `ORI-8842A` podrían ser dos códigos
 * distintos en un sistema que no conocemos, y cambiarle la caja a una
 * identidad es inventarla. El pasaje a mayúsculas de `orionNumericCore` existe
 * solo para COMPARAR, que es otra cosa.
 */
export function canonicalOrionCode(raw: string): string {
  const code = raw.trim();
  const stripped = code.replace(ORION_PREFIX, "");
  return isDigits(stripped) ? `A${stripped}` : code;
}

/** Si dos códigos escritos distinto señalan al mismo producto de Orión. */
export function isSameOrionIdentity(a: string, b: string): boolean {
  return orionNumericCore(a) === orionNumericCore(b);
}

/**
 * Todas las formas en que este número pudo haberse guardado.
 *
 * Existe para poder buscar las copias con una consulta normal de Prisma en vez
 * de SQL crudo: el conjunto es chico y enumerable, así que no hace falta
 * recortar prefijos dentro de la base. Se comparan sin distinguir mayúsculas,
 * y por eso la lista no repite `a-` ni `sku` en minúscula.
 *
 * Para un código fuera de la convención la única forma posible es él mismo.
 */
export function orionCodeVariants(raw: string): string[] {
  const core = orionNumericCore(raw);
  if (!isDigits(core)) return [core];
  return [core, `A${core}`, `A-${core}`, `SKU${core}`];
}
