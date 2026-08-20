-- T5.1: outbox de notificaciones al dueño.
--
-- Cola transaccional de avisos: una transición de disponibilidad
-- (parcial/completa) encola EXACTAMENTE un evento por transición, en la misma
-- transacción que cambió el pendiente. Sin proveedor externo (D5) la bandeja
-- in-app lee los eventos del destinatario directo: `status`, `attempts` y
-- `lastError` describen a un transporte externo que todavía no existe.
--
-- Aditiva y forward-only: no toca ninguna tabla existente. La unicidad es por
-- TRANSICIÓN del agregado (recipientId, aggregateType, aggregateId,
-- transitionKey): reintentar la misma transición no duplica el evento. El
-- `eventType` y el payload van en el `fingerprint`: la misma transición con
-- otro contenido es un error del llamador.
CREATE TYPE "NotificationOutboxStatus" AS ENUM ('PENDING', 'SENT', 'FAILED');

CREATE TABLE "notification_outbox" (
    "id" TEXT NOT NULL,
    "recipientId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "aggregateType" TEXT NOT NULL,
    "aggregateId" TEXT NOT NULL,
    "transitionKey" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "NotificationOutboxStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "sentAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_outbox_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "notification_outbox_transition_unique"
    ON "notification_outbox"("recipientId", "aggregateType", "aggregateId", "transitionKey");

-- El drenador del transporte externo: PENDING por antigüedad.
CREATE INDEX "notification_outbox_status_createdAt_idx"
    ON "notification_outbox"("status", "createdAt");

-- La bandeja in-app: lo de una persona, de lo más nuevo a lo más viejo. El
-- índice único arranca por "recipientId" pero sigue por "aggregateType", así que
-- no sirve para ordenar por fecha; y el de estado arranca por una columna de
-- tres valores. Sin este índice la bandeja recorre la tabla entera.
CREATE INDEX "notification_outbox_recipientId_createdAt_idx"
    ON "notification_outbox"("recipientId", "createdAt");

ALTER TABLE "notification_outbox"
    ADD CONSTRAINT "notification_outbox_recipientId_fkey"
    FOREIGN KEY ("recipientId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;