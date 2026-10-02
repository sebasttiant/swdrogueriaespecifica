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
 * Sin autoridad de cliente: no se le ofrece facturar, contactar ni corregir
 * nada. Es el equivalente del viejo `canContactOrInvoice = false` y el default
 * de los tests que no prueban permisos.
 *
 * Entrega y cancelación van con alcance "all" A PROPÓSITO: en esos tests las
 * decide el booleano de capacidad (`canDeliver`/`canCancel`) que el test pasa,
 * igual que antes de que existiera el recorte por fila. El recorte por dueño
 * se prueba con `ownerViewer` y con los lectores reales de
 * `pending-row-scope.render.test.ts`.
 */
export const noAuthorityViewer: PendingViewer = {
  invoiceScope: "none",
  contactScope: "none",
  deliverScope: "all",
  cancelScope: "all",
  editScope: "none",
  userId: "user-sin-autoridad",
};

/** Alcance GLOBAL: SUPERADMIN, ADMIN y SUPERVISOR. Opera cualquier fila. */
export function globalViewer(userId = "user-gerencia"): PendingViewer {
  return {
    invoiceScope: "all",
    contactScope: "all",
    deliverScope: "all",
    cancelScope: "all",
    editScope: "all",
    userId,
  };
}

/**
 * Alcance acotado al dueño: OPERADOR y BODEGA. Opera solo sus propias filas,
 * pero CORRIGE cualquiera (`canEditAllPendings`).
 */
export function ownerViewer(userId = OWNER_ID): PendingViewer {
  return {
    invoiceScope: "own",
    contactScope: "own",
    deliverScope: "own",
    cancelScope: "own",
    editScope: "all",
    userId,
  };
}
