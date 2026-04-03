-- =============================================================================
-- schema-v14-market-phases.sql
-- Phase 7: Market Phase Detection (Fase Pasar)
--
-- Detects market cycle phases (uptrend, downtrend, sideways-bullish,
-- sideways-bearish) from SMA crossover + ATR volatility + volume patterns.
-- Enriched with broker flow, bandar signal, and insider confirmation.
--
-- NOTE: This is an MA-based trend indicator, NOT Wyckoff structural analysis.
-- Phase labels describe trend state, not institutional behavior.
--
-- Depends on: schema.sql (stocks table with ticker PK)
-- =============================================================================


-- =============================================================================
-- 1. market_phases — One row per detected phase per ticker.
--    Phases are contiguous and non-overlapping for a given ticker.
-- =============================================================================

CREATE TABLE IF NOT EXISTS market_phases (
    id                SERIAL PRIMARY KEY,
    ticker            TEXT NOT NULL REFERENCES stocks(ticker) ON DELETE CASCADE,

    -- Phase classification
    phase_type        TEXT NOT NULL CHECK (phase_type IN (
                        'uptrend', 'downtrend', 'sideways_bullish', 'sideways_bearish'
                      )),
    start_date        DATE NOT NULL,
    end_date          DATE NOT NULL,
    days              INTEGER NOT NULL,

    -- Price statistics within the phase
    open_price        INTEGER NOT NULL,          -- IDR, full integer (first open)
    close_price       INTEGER NOT NULL,          -- IDR, full integer (last close)
    range_low         INTEGER NOT NULL,          -- min(low) across phase
    range_high        INTEGER NOT NULL,          -- max(high) across phase
    change_pct        DECIMAL(6,2) NOT NULL,     -- (close - open) / open * 100

    -- Phase detection clarity (price + volume only, available for ALL tickers)
    phase_clarity     SMALLINT NOT NULL DEFAULT 30 CHECK (phase_clarity BETWEEN 0 AND 100),
    trend_strength    TEXT DEFAULT 'sideways' CHECK (trend_strength IN ('strong', 'weak', 'sideways')),

    -- Smart money alignment (only meaningful when broker/bandar data exists)
    smart_money_alignment  SMALLINT CHECK (smart_money_alignment BETWEEN 0 AND 100),  -- NULL = no data
    broker_flow_alignment  TEXT,                  -- 'confirms' | 'contradicts' | 'neutral' | NULL
    bandar_signal_mode     TEXT,                  -- most frequent bandar_accdist during phase
    insider_activity       JSONB,                 -- {buys: N, sells: N, net_shares: N} or NULL

    -- Current phase flag
    is_current        BOOLEAN DEFAULT FALSE,      -- exactly one TRUE per ticker

    -- Metadata
    detection_version TEXT DEFAULT '1.0',
    detected_at       TIMESTAMPTZ DEFAULT NOW(),

    UNIQUE (ticker, start_date)
);

-- Indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_mp_ticker       ON market_phases(ticker);
CREATE INDEX IF NOT EXISTS idx_mp_current      ON market_phases(ticker) WHERE is_current = TRUE;
CREATE INDEX IF NOT EXISTS idx_mp_phase_type   ON market_phases(phase_type);
CREATE INDEX IF NOT EXISTS idx_mp_detected_at  ON market_phases(detected_at);


-- =============================================================================
-- 2. RLS policies — allow anon key read access (NextJS frontend)
-- =============================================================================

ALTER TABLE market_phases ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow public read" ON market_phases FOR SELECT USING (true);
