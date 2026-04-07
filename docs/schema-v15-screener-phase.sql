-- schema-v15-screener-phase.sql
-- Denormalize current market phase onto stocks table for screener display & filtering.

ALTER TABLE stocks
  ADD COLUMN IF NOT EXISTS current_phase TEXT,
  ADD COLUMN IF NOT EXISTS current_phase_clarity SMALLINT,
  ADD COLUMN IF NOT EXISTS current_phase_days SMALLINT;

-- Backfill from existing market_phases data.
-- Uses the latest phase per ticker (by end_date) as fallback when is_current is not set.
UPDATE stocks s
SET current_phase = mp.phase_type,
    current_phase_clarity = mp.phase_clarity,
    current_phase_days = mp.days
FROM (
  SELECT DISTINCT ON (ticker)
    ticker, phase_type, phase_clarity, days
  FROM market_phases
  ORDER BY ticker, end_date DESC
) mp
WHERE mp.ticker = s.ticker;

-- Index for phase filter in screener
CREATE INDEX IF NOT EXISTS idx_stocks_current_phase ON stocks (current_phase)
  WHERE current_phase IS NOT NULL;
