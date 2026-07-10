-- Additive: Supplier, ProductSupplier, and order flow fields on MissingItem.
-- No existing rows broken: all new columns nullable.

CREATE TABLE "suppliers" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "address" TEXT,
    "email" TEXT,

    CONSTRAINT "suppliers_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "suppliers_name_key" ON "suppliers"("name");

CREATE TABLE "product_suppliers" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "isRecurrent" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "product_suppliers_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "product_suppliers_productId_supplierId_key" ON "product_suppliers"("productId", "supplierId");

ALTER TABLE "product_suppliers" ADD CONSTRAINT "product_suppliers_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "product_suppliers" ADD CONSTRAINT "product_suppliers_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "missing_items" ADD COLUMN "orderedAt" TIMESTAMP(3);
ALTER TABLE "missing_items" ADD COLUMN "orderedById" TEXT;
ALTER TABLE "missing_items" ADD COLUMN "supplierId" TEXT;

ALTER TABLE "missing_items" ADD CONSTRAINT "missing_items_orderedById_fkey" FOREIGN KEY ("orderedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "missing_items" ADD CONSTRAINT "missing_items_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
