-- The monthly summary on Workstations (src/monthly_summary.ts) is computed from
-- usage already recorded; this keeps only which month's summary was dismissed.

ALTER TABLE tenants ADD COLUMN summary_dismissed_month TEXT;
