-- Additive: index for the management review queue, which filters PENDING_REVIEW
-- reports and groups/looks them up by normalizedName. No table or data change.
-- Rollback: DROP INDEX "missing_reports_status_normalizedName_idx".
CREATE INDEX "missing_reports_status_normalizedName_idx"
  ON "missing_reports"("status", "normalizedName");
