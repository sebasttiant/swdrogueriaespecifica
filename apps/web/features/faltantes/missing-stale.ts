// --------------------------------------------------------------------------
// EL EJE DE DEMORA: los faltantes de estantería que llevan demasiado esperando.
//
// Existe porque el aviso de gerencia prometía algo que la pantalla no cumplía.
// El banner dice "86 faltantes llevan más de 8 h sin cerrarse" y enlazaba a la
// cola PELADA: caías en "Por pedir 126", paginado de a 20 —siete páginas— con
// los 86 mezclados adentro. Y peor: la cola ordena por fecha DESCENDENTE, así
// que los más viejos, que son exactamente los que el aviso reclama, quedaban
// al final. El aviso mandaba a buscarlos justo donde la pantalla los esconde.
//
// Un aviso es una promesa: "hay N de esto, tocá para verlos". Si el destino no
// muestra esos N, la barra miente, y una barra que miente se ignora entera.
//
// LAS HORAS VIVEN ACÁ, no en el servicio de reportes, y ese movimiento es el
// punto: el número que dispara el aviso y el que filtra la lista tienen que ser
// EL MISMO. Escritos en dos archivos divergen al primer cambio, y ahí el aviso
// cuenta con un umbral y la pantalla filtra con otro.
//
// PURO: sin Prisma, sin React. Se prueba con un string y una fecha.
// --------------------------------------------------------------------------

import { MISSING_QUEUE_PATH } from "./missing-scope";

/** Cuántas horas sin cerrarse convierten a un faltante en trabajo atrasado. */
export const UNCLOSED_MISSING_ALERT_HOURS = 8;

const MS_PER_HOUR = 60 * 60 * 1000;

/**
 * El parámetro en la URL. Se llama `demora` y no `stale` porque quien lee esta
 * dirección —y a veces la manda por WhatsApp— habla castellano.
 *
 * NO puede llamarse `scope`, `view` ni `cursor`: esos ya son de la cola. Ver la
 * nota de `MissingBoardRoute` sobre colisiones de nombres en la misma URL.
 */
export const STALE_PARAM = "demora";
const STALE_VALUE = "8h";

/** Lo que TODO enlace de la cola tiene que arrastrar mientras el filtro está
 *  puesto. Sin esto, tocar "Ver más" o cambiar de layout lo apaga en silencio
 *  y la persona vuelve a los 126 sin haber pedido nada. */
export const STALE_PERSISTENT_PARAMS: Readonly<Record<string, string>> = {
  [STALE_PARAM]: STALE_VALUE,
};

/**
 * Resuelve el `?demora=` de la URL. Cualquier otro valor apaga el filtro: el
 * parámetro es input del usuario y no puede romper la página.
 */
export function resolveStaleOnly(param?: string | null): boolean {
  return param === STALE_VALUE;
}

/** La frontera: creado antes de esto es trabajo atrasado. */
export function staleThreshold(now: Date): Date {
  return new Date(now.getTime() - UNCLOSED_MISSING_ALERT_HOURS * MS_PER_HOUR);
}

/**
 * La cola de estantería, recortada a lo atrasado. Es el destino del aviso de
 * gerencia, y sale de una función y no de un string suelto para que el aviso no
 * pueda quedar apuntando a un filtro que la pantalla ya no entiende.
 */
export function staleMissingHref(): string {
  return `${MISSING_QUEUE_PATH}?${STALE_PARAM}=${STALE_VALUE}`;
}
