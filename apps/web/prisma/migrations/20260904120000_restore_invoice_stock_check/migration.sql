-- No se factura lo que no llegó. La base vuelve a sostenerlo.
--
-- HISTORIA. El CHECK original exigía `invoicedQuantity <= inventoryReadyQuantity`.
-- La migración `20260731010000_invoice_before_arrival` lo quitó a propósito, con
-- el argumento de que factura la persona mirando su caja y el software se entera
-- después. El resultado en producción fue el opuesto al buscado: gerencia veía
-- el botón "Facturar" sobre pendientes sin una sola unidad en bodega, y facturar
-- lo que no llegó descuadra la entrega. El negocio revirtió la decisión el
-- 2026-10-04.
--
-- POR QUÉ LA GUARDA DE ESTADO. Reponer la restricción tal cual habría fallado:
-- producción tiene 22 filas anteriores a esta regla con
-- `invoicedQuantity > inventoryReadyQuantity`. Las 22 son TERMINALES —18
-- ENTREGADO y 4 CANCELADO— o sea, ventas que ya ocurrieron de verdad.
--
-- Esas filas NO se corrigen. Subirles `inventoryReadyQuantity` falsificaría el
-- inventario y bajarles `invoicedQuantity` borraría facturas reales; las dos
-- cosas inventan una historia que no pasó. Son evidencia, y quedan como están.
--
-- Entonces la restricción exime a los pendientes cerrados y aplica solo sobre
-- los abiertos, que son los únicos donde todavía se puede facturar. Con eso:
--
--   1. La migración VALIDA sin fallar, porque las 22 violaciones son terminales.
--   2. No hay que usar `NOT VALID`, que además habría sido una trampa: PostgreSQL
--      igual evalúa un CHECK NOT VALID en cada UPDATE, así que cualquier
--      corrección futura sobre esas 22 filas habría reventado.
--   3. Un pendiente abierto no puede facturarse sin stock, ni desde la
--      aplicación ni por SQL directo.
--
-- PREFLIGHT. Antes de aplicar, confirmar que ninguna fila ABIERTA viola la
-- regla. Debe devolver 0; si devuelve más, alguien facturó sin stock con el
-- código viejo todavía corriendo y hay que revisar esas filas antes de seguir:
--
--   SELECT count(*) FROM pendings
--   WHERE status NOT IN ('ENTREGADO','CANCELADO','CLOSED_PARTIAL')
--     AND "invoicedQuantity" > "inventoryReadyQuantity";
--
-- Aditiva y forward-only: no modifica ninguna fila.

ALTER TABLE "pendings" DROP CONSTRAINT IF EXISTS "pendings_quantities_check";

ALTER TABLE "pendings" ADD CONSTRAINT "pendings_quantities_check" CHECK (
  "inventoryReadyQuantity" >= 0
  AND "inventoryReadyQuantity" <= "quantity"
  AND "reservedInventoryQuantity" >= 0
  AND "reservedInventoryQuantity" <= "inventoryReadyQuantity"
  AND "invoicedQuantity" >= 0
  AND "invoicedQuantity" <= "quantity"
  AND "deliveredQuantity" >= 0
  AND "deliveredQuantity" <= "invoicedQuantity"
  -- La regla que vuelve. Solo sobre pendientes abiertos: ver la nota de arriba
  -- sobre las 22 filas terminales que la preceden.
  AND (
    "status" IN ('ENTREGADO', 'CANCELADO', 'CLOSED_PARTIAL')
    OR "invoicedQuantity" <= "inventoryReadyQuantity"
  )
);
