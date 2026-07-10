-- Additive: Laboratory entity and optional link from Product.
-- No existing rows broken: laboratoryId is nullable.

CREATE TABLE "laboratories" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "email" TEXT,

    CONSTRAINT "laboratories_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "laboratories_name_key" ON "laboratories"("name");

ALTER TABLE "products" ADD COLUMN "laboratoryId" TEXT;
ALTER TABLE "products" ADD CONSTRAINT "products_laboratoryId_fkey" 
  FOREIGN KEY ("laboratoryId") REFERENCES "laboratories"("id") ON DELETE SET NULL ON UPDATE CASCADE;
