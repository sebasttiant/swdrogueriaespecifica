import type { PendingViewer } from "./fulfillment-notice";

// --------------------------------------------------------------------------
// Lectores de referencia para los tests de render.
//
// Existen para que cada test NOMBRE la autoridad que está probando en vez de
// armar un objeto suelto. Un `viewer` mal construido —alcance global donde
// correspondía el del dueño— haría pasar un test que en producción muestra un
// botón de más, y ese es exactamente el defecto que estas pruebas cuidan.
// --------------------------------------------------------------------------

/** El dueño de referencia de las filas de prueba. */
export const OWNER_ID = "user-vendedor";

/**
 * Sin autoridad: no se le ofrece facturar nada. Es el equivalente del viejo
 * `canContactOrInvoice = false` y el default de los tests que no prueban
 * permisos.
 */
export const noAuthorityViewer: PendingViewer = {
  invoiceScope: "none",
  contactScope: "none",
  userId: "user-sin-autoridad",
};

/** Alcance GLOBAL: SUPERADMIN, ADMIN y SUPERVISOR. Factura cualquier fila. */
export function globalViewer(userId = "user-gerencia"): PendingViewer {
  return { invoiceScope: "all", contactScope: "all", userId };
}

/** Alcance acotado al dueño: OPERADOR y BODEGA. Solo sus propias filas. */
export function ownerViewer(userId = OWNER_ID): PendingViewer {
  return { invoiceScope: "own", contactScope: "own", userId };
}
