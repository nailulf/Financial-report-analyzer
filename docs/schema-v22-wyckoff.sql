-- =============================================================================
-- schema-v22-wyckoff.sql
-- Phase 7b: Wyckoff Structural Event Detection
--
-- Detects classical Wyckoff events (Selling Climax, Buying Climax, Spring,
-- Upthrust After Distribution, Sign of Strength/Weakness, etc.) as ADDITIONAL
-- annotations on top of the SMA-based market_phases table.
--
-- Wyckoff produces discrete events, not contiguous phases. Each event is a
-- single-day signal with confidence 0-100. The frontend can show:
--   - SMA-based phase bands (default, current behaviour)
--   - Wyckoff event markers
--   - Combined view
--
-- Reference: Hank Pruden — "The Three Skills of Top Trading"
--            David Weis — "Trades About to Happen"
--            Anna Coulling — "A Complete Guide to Volume Price Analysis"
--
-- Depends on: schema.sql (stocks), schema-v14-market-phases.sql (market_phases)
-- =============================================================================


-- =============================================================================
-- 1. wyckoff_events — One row per detected event per ticker.
--    Multiple events per day are allowed (e.g. SC + climax volume marker).
-- =============================================================================

CREATE TABLE IF NOT EXISTS wyckoff_events (
    id              SERIAL PRIMARY KEY,
    ticker          TEXT NOT NULL REFERENCES stocks(ticker) ON DELETE CASCADE,

    -- Event classification
    event_type      TEXT NOT NULL CHECK (event_type IN (
                       -- Accumulation events
                       'PS',          -- Preliminary Support
                       'SC',          -- Selling Climax
                       'AR_up',       -- Automatic Rally (after SC)
                       'ST_low',      -- Secondary Test (of SC low)
                       'Spring',      -- Failed breakdown
                       'SOS',         -- Sign of Strength
                       'LPS',         -- Last Point of Support
                       -- Distribution events
                       'PSY',         -- Preliminary Supply
                       'BC',          -- Buying Climax
                       'AR_down',     -- Automatic Reaction (after BC)
                       'ST_high',     -- Secondary Test (of BC high)
                       'UTAD',        -- Upthrust After Distribution
                       'SOW',         -- Sign of Weakness
                       'LPSY',        -- Last Point of Supply
                       -- Effort/Result anomalies
                       'absorption',  -- High volume, narrow range = institutions absorbing
                       'no_demand',   -- Low volume up bar = weak demand
                       'no_supply'    -- Low volume down bar = sellers exhausted
                    )),
    event_date      DATE NOT NULL,

    -- Bar context at event
    price           INTEGER NOT NULL,         -- close on event day, IDR
    volume          BIGINT,                   -- volume on event day
    volume_z        DECIMAL(6,2),             -- z-score vs 50-day rolling
    range_z         DECIMAL(6,2),             -- range z-score vs 50-day rolling

    -- Detection confidence 0-100
    confidence      SMALLINT NOT NULL DEFAULT 50 CHECK (confidence BETWEEN 0 AND 100),

    -- Phase context (which Wyckoff phase this event belongs to)
    -- A,B,C,D,E for accumulation; A,B,C,D,E for distribution
    -- (NULL until phase is later inferred from event sequence)
    inferred_phase  TEXT,                     -- 'accumulation' | 'markup' | 'distribution' | 'markdown'

    -- Optional human-readable note for tooltip display
    notes           TEXT,

    -- Metadata
    detection_version TEXT DEFAULT '1.0',
    detected_at       TIMESTAMPTZ DEFAULT NOW(),

    UNIQUE (ticker, event_date, event_type)
);

CREATE INDEX IF NOT EXISTS idx_we_ticker_date ON wyckoff_events(ticker, event_date DESC);
CREATE INDEX IF NOT EXISTS idx_we_event_type  ON wyckoff_events(event_type);
CREATE INDEX IF NOT EXISTS idx_we_phase       ON wyckoff_events(inferred_phase);


-- =============================================================================
-- 2. Augment market_phases with Wyckoff-derived metadata
--    (so the existing phase rows can carry a wyckoff suggestion alongside the
--     SMA-based label, without restructuring the table)
-- =============================================================================

ALTER TABLE market_phases
    ADD COLUMN IF NOT EXISTS wyckoff_phase     TEXT,         -- 'accumulation'|'markup'|'distribution'|'markdown'|NULL
    ADD COLUMN IF NOT EXISTS wyckoff_events    JSONB,        -- [{type, date, confidence}, ...] for THIS phase
    ADD COLUMN IF NOT EXISTS absorption_score  SMALLINT      -- 0-100, effort-vs-result anomaly rate
        CHECK (absorption_score IS NULL OR absorption_score BETWEEN 0 AND 100);


-- =============================================================================
-- 3. RLS policies
-- =============================================================================

ALTER TABLE wyckoff_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow public read" ON wyckoff_events FOR SELECT USING (true);
