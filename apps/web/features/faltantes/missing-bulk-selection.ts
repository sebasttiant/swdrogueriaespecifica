// --------------------------------------------------------------------------
// Id compartido del <form> de selección masiva.
//
// En modo masivo, la casilla de cada fila vive FUERA del formulario que la
// procesa: cada fila ya monta los dos <form> de `MissingQuickActions` (pedido
// y descarte), y los formularios HTML no se anidan. La solución es el
// atributo `form`, que asocia un input a un <form> que no es su ancestro —
// pero exige que el valor sea EXACTAMENTE el mismo en la barra que declara el
// <form> (`MissingBulkActions`) y en cada fila que lo usa (`missing-list.tsx`).
// Un string suelto copiado en varios archivos es la forma en que esa igualdad
// se rompe en silencio el día que alguien toque uno solo de los dos.
// --------------------------------------------------------------------------
export const MISSING_BULK_FORM_ID = "missing-bulk-form";
