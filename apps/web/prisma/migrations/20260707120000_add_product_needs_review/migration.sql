-- Manual products created on the fly from a pending are flagged for admin review.
ALTER TABLE "products"
  ADD COLUMN "needsReview" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "products_needsReview_idx" ON "products"("needsReview");
