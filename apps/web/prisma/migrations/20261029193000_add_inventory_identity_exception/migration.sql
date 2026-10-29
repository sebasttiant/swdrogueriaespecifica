-- Una recepción física no debe quedar fuera del inventario solamente porque el
-- producto todavía no tiene código de Orión. La excepción queda como evidencia
-- permanente sobre la entrada; resolver la identidad después no borra historia.
ALTER TABLE "inventory_entries"
  ADD COLUMN "identityExceptionReason" "PendingIdentityDeferral",
  ADD COLUMN "identityExceptionNote" TEXT;

-- Una nota sin motivo sería evidencia huérfana e imposible de agrupar.
ALTER TABLE "inventory_entries"
  ADD CONSTRAINT "inventory_entries_identity_exception_note_requires_reason"
  CHECK (
    "identityExceptionNote" IS NULL
    OR "identityExceptionReason" IS NOT NULL
  );

-- La cola consulta excepciones todavía abiertas por producto y, para usuarios
-- no globales, por creador. Son parciales para no inflar el camino normal.
CREATE INDEX "inventory_entries_identity_exception_product_idx"
  ON "inventory_entries" ("productId")
  WHERE "identityExceptionReason" IS NOT NULL;

CREATE INDEX "inventory_entries_identity_exception_creator_product_idx"
  ON "inventory_entries" ("createdById", "productId")
  WHERE "identityExceptionReason" IS NOT NULL;
