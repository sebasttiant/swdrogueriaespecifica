-- AlterTable
ALTER TABLE "users" ADD COLUMN "archivedAt" TIMESTAMP(3);
-- CreateIndex
CREATE INDEX "users_archivedAt_idx" ON "users"("archivedAt");
