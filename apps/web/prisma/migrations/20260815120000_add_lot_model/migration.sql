-- Modelo canónico de lote (T1.2).
--
-- ADITIVA: crea una tabla nueva y su enum. No toca `product_batches`, que es el
-- modelo legado y sigue en uso hasta el cutover; no migra datos ni cambia
-- ninguna fila existente.
--
-- Rollback:
--   DROP TABLE "lots";
--   DROP TYPE "LotStatus";

-- CreateEnum
-- VENCIDO no está: se deriva comparando `expiresAt` con el momento de la
-- consulta. Un estado guardado se desincroniza el día que nadie corre el
-- proceso que lo actualiza.
CREATE TYPE "LotStatus" AS ENUM ('AVAILABLE', 'QUARANTINED');

-- CreateTable
CREATE TABLE "lots" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "lotNumber" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "onHand" INTEGER NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "LotStatus" NOT NULL DEFAULT 'AVAILABLE',
    "location" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- Identidad del lote: el mismo número puede repetirse entre productos, nunca
-- dentro del mismo producto.
CREATE UNIQUE INDEX "lots_productId_lotNumber_key" ON "lots"("productId", "lotNumber");

-- CreateIndex
CREATE INDEX "lots_expiresAt_idx" ON "lots"("expiresAt");

-- CreateIndex
CREATE INDEX "lots_productId_status_idx" ON "lots"("productId", "status");

-- CreateIndex
-- Orden FEFO por producto (where + orderBy).
CREATE INDEX "lots_productId_expiresAt_id_idx" ON "lots"("productId", "expiresAt", "id");

-- AddForeignKey
ALTER TABLE "lots" ADD CONSTRAINT "lots_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Integridad de datos: la cantidad de un lote nunca puede ser negativa. 0 es
-- válido (lote agotado). Negativo solo podría venir de un bug de
-- sobre-descuento; esta red lo atrapa en la base, sin importar el código.
-- (Prisma no soporta CHECK en el DSL del schema; por eso va como SQL crudo.)
ALTER TABLE "lots"
  ADD CONSTRAINT "lots_onHand_nonneg" CHECK ("onHand" >= 0);
