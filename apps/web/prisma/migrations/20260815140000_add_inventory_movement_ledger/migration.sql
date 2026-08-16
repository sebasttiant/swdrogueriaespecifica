-- Ledger inmutable de movimientos + store de comandos (T1.3).
--
-- ADITIVA: crea dos tablas nuevas y un enum. No toca `product_batches`,
-- `audit_logs` ni `pending_inventory_reservations`; no migra datos.
--
-- Las dos tablas van juntas porque `inventory_movements.commandId` es NOT NULL:
-- todo movimiento nace de un comando, así que el ledger no puede existir sin el
-- store.
--
-- Rollback:
--   DROP TABLE "inventory_movements";
--   DROP TABLE "operational_commands";
--   DROP TYPE "InventoryMovementType";

-- CreateEnum
CREATE TYPE "InventoryMovementType" AS ENUM ('RECEIPT', 'RESERVATION', 'RELEASE', 'DELIVERY', 'ADJUSTMENT', 'RETURN', 'EXPIRY');

-- CreateTable
CREATE TABLE "operational_commands" (
    "id" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "commandType" TEXT NOT NULL,
    "commandKey" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "result" JSONB,
    "error" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "operational_commands_pkey" PRIMARY KEY ("id")
);

-- CreateTable
-- Sin `updatedAt`: el asiento no se edita. La inmutabilidad la sostienen el
-- diseño de la API del repositorio (no expone update ni delete) y el RESTRICT
-- de las claves foráneas.
CREATE TABLE "inventory_movements" (
    "id" TEXT NOT NULL,
    "lotId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "type" "InventoryMovementType" NOT NULL,
    "quantity" INTEGER NOT NULL,
    "actorId" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "commandId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_movements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- Identidad del comando: mismo actor, mismo tipo, misma clave = un comando.
CREATE UNIQUE INDEX "operational_commands_actorId_commandType_commandKey_key" ON "operational_commands"("actorId", "commandType", "commandKey");

-- CreateIndex
CREATE INDEX "operational_commands_actorId_createdAt_idx" ON "operational_commands"("actorId", "createdAt");

-- CreateIndex
-- Un comando asienta UNA vez: previene el doble asiento por reintento.
CREATE UNIQUE INDEX "inventory_movements_commandId_key" ON "inventory_movements"("commandId");

-- CreateIndex
CREATE INDEX "inventory_movements_lotId_idx" ON "inventory_movements"("lotId");

-- CreateIndex
CREATE INDEX "inventory_movements_productId_occurredAt_idx" ON "inventory_movements"("productId", "occurredAt");

-- CreateIndex
CREATE INDEX "inventory_movements_productId_type_idx" ON "inventory_movements"("productId", "type");

-- AddForeignKey
-- RESTRICT, NO cascade: el ledger es permanente (D4). Un lote con movimientos
-- no se puede borrar; el producto se desactiva, no se elimina.
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "lots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_commandId_fkey" FOREIGN KEY ("commandId") REFERENCES "operational_commands"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Un comando terminó con resultado o con error. Sin ninguno de los dos no
-- terminó, y guardarlo dejaría un registro que no se puede replicar.
ALTER TABLE "operational_commands"
  ADD CONSTRAINT "operational_commands_outcome_present" CHECK ("result" IS NOT NULL OR "error" IS NOT NULL);
