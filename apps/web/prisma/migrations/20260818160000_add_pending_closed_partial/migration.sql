-- T2.2b: cierre parcial de un pendiente de entrega.
--
-- Cuando solo llegó una parte, el vendedor despacha eso y le pregunta al
-- cliente. Si el cliente dice que ya no espera el resto, el pendiente se
-- cerraba como ENTREGADO y la única huella de lo no entregado era texto libre
-- en `cancelReason`. A partir de ahora ese cierre tiene estado propio
-- (CLOSED_PARTIAL) y `cancelledQuantity` registra lo que el cliente ya no
-- espera: la ecuación `deliveredQuantity + cancelledQuantity = quantity`
-- permite saber cuánto se perdió del pedido original.
--
-- Aditiva y forward-only: agrega el valor del enum y la columna con default 0.
-- Las filas existentes no cambian (ninguna cerró parcial con la ecuación nueva;
-- las que se cerraron "con lo entregado" quedaron como ENTREGADO históricos).
--
-- AlterEnum: PostgreSQL 18 permite ADD VALUE dentro de una transacción; ya se
-- usó así en 20260724120000_add_pending_management_states.
ALTER TYPE "PendingStatus" ADD VALUE 'CLOSED_PARTIAL';

-- Default 0: los pendientes históricos no tienen cierre parcial registrado.
ALTER TABLE "pendings" ADD COLUMN "cancelledQuantity" INTEGER NOT NULL DEFAULT 0;
