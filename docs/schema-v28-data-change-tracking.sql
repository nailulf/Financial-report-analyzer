-- =============================================================
-- schema-v28-data-change-tracking.sql
--
-- Adds a per-ticker "last data change" timestamp on `stocks` so
-- the AI Analysis widget can show a Re-analyze button only when
-- material upstream data (financials, fallback rows, etc.) has
-- been added or updated since the last AI analysis run.
--
-- Compared against `ai_analysis.generated_at` to gate the button.
-- =============================================================

ALTER TABLE stocks
  ADD COLUMN IF NOT EXISTS last_data_change_at TIMESTAMPTZ;

-- Backfill: seed every existing ticker with NOW() so already-analyzed
-- tickers don't all immediately appear stale. The daily pipeline will
-- update this going forward whenever new financial rows land.
UPDATE stocks
SET last_data_change_at = NOW()
WHERE last_data_change_at IS NULL;

-- Index — used by the staleness comparison join in the AI analysis
-- API. Partial index keeps it small (only Active tickers are scored).
CREATE INDEX IF NOT EXISTS idx_stocks_last_data_change
  ON stocks(last_data_change_at)
  WHERE status = 'Active';

COMMENT ON COLUMN stocks.last_data_change_at IS
  'Set by --daily scrapers when new financial periods or material '
  'fills land for this ticker. Compared against ai_analysis.generated_at '
  'to decide whether the Re-analyze button should be shown.';
