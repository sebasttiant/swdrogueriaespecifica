-- Facturar no depende de que la mercancía ya esté cargada al sistema.
--
-- La restricción anterior exigía `invoicedQuantity <= inventoryReadyQuantity`,
-- es decir: no podés facturar más de lo que el sistema ya vio llegar. En la
-- droguería el orden es al revés —factura la persona, mirando su caja, y el
-- software se entera después—, así que el vendedor recibía "No se pudo
-- registrar la factura" en todo pendiente cuya mercancía no estuviera cargada.
--
-- El techo correcto es lo que el cliente pidió.
--
-- Lo que NO se relaja: `deliveredQuantity <= invoicedQuantity`. Facturar antes
-- de entregar es una regla del negocio y la base la sigue sosteniendo, para que
-- no dependa de que la aplicación se acuerde de comprobarla.
--
-- Aditiva y forward-only: no cambia ninguna fila. Toda fila que cumplía la
-- restricción vieja cumple la nueva, porque `inventoryReadyQuantity <= quantity`
-- ya era parte de la misma comprobación.
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
);
