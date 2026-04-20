-- =============================================================================
-- schema-v17-technical-signals.sql
-- Phase 8: Technical Signals (MACD, RSI, Volume Change)
--
-- Pre-computed technical analysis indicators from daily_prices data.
-- Used for rebound detection screener (MACD golden cross + RSI range + volume).
--
-- Depends on: schema.sql (stocks table with ticker PK)
-- =============================================================================


-- =============================================================================
-- 1. technical_signals — One row per ticker per trading day.
--    Stores RSI(14), MACD(12,26,9), and volume change indicators.
-- =============================================================================

CREATE TABLE IF NOT EXISTS technical_signals (
    ticker              TEXT NOT NULL REFERENCES stocks(ticker) ON DELETE CASCADE,
    date                DATE NOT NULL,

    -- RSI (14-period Wilder's smoothed)
    rsi_14              DECIMAL(6,2),

    -- MACD (12, 26, 9)
    macd_line           DECIMAL(12,4),       -- EMA(12) - EMA(26)
    macd_signal         DECIMAL(12,4),       -- EMA(9) of macd_line
    macd_histogram      DECIMAL(12,4),       -- macd_line - macd_signal

    -- Volume vs 20-day average
    volume_sma_20       BIGINT,              -- 20-day simple moving average of volume
    volume_change_pct   DECIMAL(8,2),        -- (volume / volume_sma_20) * 100

    -- Metadata
    computed_at         TIMESTAMPTZ DEFAULT NOW(),

    PRIMARY KEY (ticker, date)
);

-- Indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_ts_ticker  ON technical_signals(ticker);
CREATE INDEX IF NOT EXISTS idx_ts_date    ON technical_signals(date DESC);


-- =============================================================================
-- 2. RLS policies — allow anon key read access (NextJS frontend)
-- =============================================================================

ALTER TABLE technical_signals ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow public read" ON technical_signals FOR SELECT USING (true);


-- =============================================================================
-- 3. Denormalized columns on stocks table for screener filtering
-- =============================================================================

ALTER TABLE stocks
  ADD COLUMN IF NOT EXISTS rsi_14              DECIMAL(6,2),
  ADD COLUMN IF NOT EXISTS macd_histogram      DECIMAL(12,4),
  ADD COLUMN IF NOT EXISTS macd_cross_signal   TEXT DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS macd_cross_days_ago INTEGER,
  ADD COLUMN IF NOT EXISTS volume_change_pct   DECIMAL(8,2),
  ADD COLUMN IF NOT EXISTS volume_avg_20d      BIGINT;
