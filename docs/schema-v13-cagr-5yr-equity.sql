-- =============================================================================
-- Migration v13: Add cagr_5yr column + total_equity metric to normalized_metrics
-- =============================================================================
-- Enables peer-ranked 5Y growth (revenue, earnings) and 3Y equity growth
-- in the PERTUMBUHAN widget. Previously these used absolute thresholds only.
--
-- Apply in Supabase SQL Editor, then re-run the AI context pipeline to
-- populate the new column and total_equity rows.
-- =============================================================================

-- 1. Add cagr_5yr column
ALTER TABLE normalized_metrics
  ADD COLUMN IF NOT EXISTS cagr_5yr DECIMAL(10,6);

-- 2. Note: total_equity metric rows will be created automatically by the
--    Python pipeline after METRIC_MAP is updated. No schema change needed
--    since normalized_metrics uses (ticker, metric_name) as the key.
