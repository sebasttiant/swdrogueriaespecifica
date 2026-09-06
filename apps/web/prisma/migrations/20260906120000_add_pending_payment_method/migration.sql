-- Medio de pago del abono en pendientes.
--
-- ADITIVA y sin backfill: la columna nace NULL para todos. A los pendientes
-- anteriores no se les inventa un medio de pago —"efectivo" por defecto sería
-- una afirmación falsa sobre plata real que nadie podría distinguir de un dato
-- verdadero—. La regla aplica hacia adelante; la historia queda como fue.
CREATE TYPE "PendingPaymentMethod" AS ENUM (
  'EFECTIVO',
  'TRANSFERENCIA',
  'TARJETA_DEBITO',
  'TARJETA_CREDITO'
);

ALTER TABLE "pendings" ADD COLUMN "paymentMethod" "PendingPaymentMethod";

-- Un medio de pago sin plata no describe nada: alguien eligió "transferencia" y
-- después corrigió el abono a cero, y la fila queda afirmando una transferencia
-- que no existió.
--
-- Se restringe SOLO esta mitad. La recíproca —si hay abono, tiene que haber
-- medio— NO puede vivir acá: hay pendientes con `paidAmount > 0` creados antes
-- de que la columna existiera, y todos tienen medio NULL. Un CHECK que los
-- incluya no aplica; y forzarlo con NOT VALID es peor, porque PostgreSQL igual
-- lo evalúa cuando esa fila se ACTUALIZA, así que el día que alguien entregue
-- un pendiente viejo con abono, la entrega falla por una columna que no tiene
-- nada que ver con la entrega. Esa mitad se exige en el formulario, igual que
-- el nombre y el teléfono del cliente.
--
-- Tal como está, toda fila existente lo cumple (medio NULL), así que entra
-- validado y sin bloquear ninguna edición del pasado.
ALTER TABLE "pendings"
  ADD CONSTRAINT "pendings_payment_method_needs_paid"
  CHECK ("paymentMethod" IS NULL OR "paidAmount" > 0);
