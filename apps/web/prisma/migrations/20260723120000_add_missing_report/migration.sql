-- Additive: MissingReport, the provisional seller-side report of an
-- uncatalogued missing product. No existing table or row is touched, and no
-- Product/MissingItem is created here. Rollback: DROP TABLE "missing_reports"
-- then DROP TYPE "MissingReportStatus".

-- CreateEnum
CREATE TYPE "MissingReportStatus" AS ENUM ('PENDING_REVIEW');

-- CreateTable
CREATE TABLE "missing_reports" (
    "id" TEXT NOT NULL,
    "rawName" TEXT NOT NULL,
    "normalizedName" TEXT NOT NULL,
    "reporterId" TEXT NOT NULL,
    "status" "MissingReportStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "missing_reports_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
-- RESTRICT: reporterId is NOT NULL, so a user with reports cannot be hard-deleted
-- out from under them. (Users are archived, not deleted, in this system.)
ALTER TABLE "missing_reports" ADD CONSTRAINT "missing_reports_reporterId_fkey" FOREIGN KEY ("reporterId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
