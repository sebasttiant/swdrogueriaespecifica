-- Identidad canónica de producto (T1.1). ADITIVA: solo agrega columnas nulas
-- e índices. No toca ninguna fila existente ni ninguna columna en uso.
--
-- El catálogo histórico queda con las tres columnas en NULL: sigue
-- identificándose por `code` como hasta hoy, y el flujo nuevo convive.

-- CreateEnum
CREATE TYPE "SkuStatus" AS ENUM ('PROVISIONAL_REVIEW', 'CONFIRMED');

-- AlterTable
ALTER TABLE "products"
  ADD COLUMN "orionCode" TEXT,
  ADD COLUMN "internalSku" TEXT,
  ADD COLUMN "skuStatus" "SkuStatus";

-- CreateIndex
-- Unicidad de identidad. En Postgres varios NULL no colisionan entre sí, así
-- que el catálogo histórico entra completo sin violar la restricción.
CREATE UNIQUE INDEX "products_orionCode_key" ON "products"("orionCode");

-- CreateIndex
CREATE UNIQUE INDEX "products_internalSku_key" ON "products"("internalSku");

-- CreateIndex
-- La cola de revisión de identidad se lee por este estado.
CREATE INDEX "products_skuStatus_idx" ON "products"("skuStatus");
