// --------------------------------------------------------------------------
// PERTENENCIA EXACTA a una lista de clases de CSS.
//
// Existe por una guarda que se creía guarda y no lo era. Para excluir
// `text-danger` sin confundirlo con `text-danger-solid-foreground` se había
// escrito `not.toMatch(/\btext-danger\b/)`, y en una expresión regular el
// GUION no es un carácter de palabra: es un borde. Así que `\b` cae justo
// entre `danger` y `-solid`, la regex matchea la clase que venía a distinguir,
// y el test falla —o peor, pasa— por la razón equivocada.
//
// Una clase de CSS no es una subcadena del atributo: es un ELEMENTO de una
// lista separada por espacios. Se compara como elemento, y `toContain` sobre
// un arreglo compara por igualdad, no por inclusión de texto.
//
// Vive en `lib/testing` y no dentro de un `*.test.ts` a propósito: el error
// que arregla apareció en dos archivos distintos, así que copiarlo sería
// reabrirle la puerta.
// --------------------------------------------------------------------------

/** Las clases del atributo, sin vacíos, listas para comparar por igualdad. */
export function classTokens(className: string | null | undefined): string[] {
  return (className ?? "").split(/\s+/).filter(Boolean);
}

/**
 * Las clases del ÚNICO elemento de un fragmento renderizado. Sirve para los
 * componentes de una sola raíz; si hay varios elementos, buscá el tuyo con el
 * DOM y pasale `getAttribute("class")` a `classTokens`.
 */
export function rootClassTokens(html: string): string[] {
  return classTokens(/class="([^"]*)"/.exec(html)?.[1]);
}
