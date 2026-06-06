-- CreateEnum
CREATE TYPE "BatchStatus" AS ENUM ('DISPONIBLE', 'CUARENTENA', 'RETENIDO');

-- CreateTable
CREATE TABLE "product_batches" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "batchCode" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "quantity" INTEGER NOT NULL,
    "location" TEXT,
    "status" "BatchStatus" NOT NULL DEFAULT 'DISPONIBLE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_batches_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "product_batches_expiresAt_idx" ON "product_batches"("expiresAt");

-- CreateIndex
CREATE INDEX "product_batches_productId_status_idx" ON "product_batches"("productId", "status");

-- CreateIndex
CREATE INDEX "product_batches_productId_expiresAt_id_idx" ON "product_batches"("productId", "expiresAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "product_batches_productId_batchCode_key" ON "product_batches"("productId", "batchCode");

-- AddForeignKey
ALTER TABLE "product_batches" ADD CONSTRAINT "product_batches_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
