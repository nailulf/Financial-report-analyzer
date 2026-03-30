-- =============================================================================
-- schema-v11-ai-pipeline.sql
-- Phase 6: AI-Ready Data Pipeline — 7 new tables
--
-- Creates tables for the data cleaning → normalization → scoring → AI context
-- pipeline. All tables are additive — no existing tables are modified.
--
-- Depends on: schema.sql (stocks table with ticker PK)
-- FRD reference: IDX_AI_Pipeline_FRD.docx v2.0, Sections 2.1, 3.2, 3.3, 4.1, 6.1, 8.5
-- =============================================================================


-- =============================================================================
-- 1. data_quality_flags — Stage 1: Data Cleaner output
--    One row per (ticker, year). Stores all cleaning decisions for auditability.
-- =============================================================================

CREATE TABLE IF NOT EXISTS data_quality_flags (
    ticker                TEXT NOT NULL REFERENCES stocks(ticker) ON DELETE CASCADE,
    year                  SMALLINT NOT NULL,

    -- Source conflict
    source_conflict       BOOLEAN DEFAULT FALSE,
    conflict_metric       TEXT,                    -- JSON array of conflicting metric names
    conflict_magnitude    DECIMAL(8,4),            -- max % difference between sources
    resolution            TEXT,                    -- 'stockbit_wins' | 'yfinance_wins' | 'averaged'

    -- Anomaly detection (IQR on YoY changes)
    has_anomaly           BOOLEAN DEFAULT FALSE,
    anomaly_metrics       TEXT,                    -- JSON array of affected metric names
    anomaly_scores        TEXT,                    -- JSON: {metric: iqr_z_score}

    -- Known structural flags
    is_covid_year         BOOLEAN DEFAULT FALSE,   -- 2020 always TRUE
    is_restated           BOOLEAN DEFAULT FALSE,   -- DEFERRED v1: always FALSE
    has_one_time_items    BOOLEAN DEFAULT FALSE,   -- large non-recurring items detected
    is_ipo_year           BOOLEAN DEFAULT FALSE,   -- TRUE if year == stocks.listing_date year

    -- Scale validation
    scale_warning         BOOLEAN DEFAULT FALSE,   -- suspected thousands/millions vs full IDR
    scale_factor_applied  DECIMAL(10,0),            -- 1 or 1000000

    -- Overall usability
    usability_flag        TEXT DEFAULT 'clean',     -- 'clean' | 'minor_issues' | 'use_with_caution' | 'exclude'
    cleaner_notes         TEXT,                     -- JSON array of human-readable notes

    created_at            TIMESTAMPTZ DEFAULT NOW(),
    updated_at            TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (ticker, year)
);

CREATE INDEX IF NOT EXISTS idx_dqf_ticker ON data_quality_flags(ticker);
CREATE INDEX IF NOT EXISTS idx_dqf_usability ON data_quality_flags(usability_flag);


-- =============================================================================
-- 2. normalized_metrics — Stage 2: Data Normalizer output
--    One row per (ticker, metric_name). 20 tracked metrics × ~960 tickers.
-- =============================================================================

CREATE TABLE IF NOT EXISTS normalized_metrics (
    ticker               TEXT NOT NULL REFERENCES stocks(ticker) ON DELETE CASCADE,
    metric_name          TEXT NOT NULL,             -- e.g. 'revenue', 'roe', 'pe_ratio'
    unit                 TEXT,                      -- 'idr' | 'ratio' | 'percent' | 'multiple'

    -- Latest value
    latest_value         DECIMAL(24,6),
    latest_year          SMALLINT,

    -- Trend analysis
    cagr_full            DECIMAL(10,6),             -- full-period CAGR
    cagr_3yr             DECIMAL(10,6),             -- 3-year CAGR
    trend_direction      TEXT,                      -- strong_up|mild_up|flat|mild_down|strong_down|volatile|insufficient_data
    trend_r2             DECIMAL(6,4),              -- 0-1, linear fit quality
    trend_slope_pct      DECIMAL(10,6),             -- annualized % change from linear fit
    volatility           DECIMAL(10,6),             -- std dev of YoY changes

    -- Sector comparison (NULL if peer_count < 8)
    z_score_vs_sector    DECIMAL(8,4),
    percentile_vs_sector DECIMAL(6,2),              -- 0-100
    peer_group_level     TEXT,                      -- 'subsector' | 'sector' | NULL (insufficient)
    peer_count           SMALLINT,                  -- actual number of peers used

    -- Data coverage
    anomaly_years        TEXT,                      -- JSON array: [2020]
    missing_years        TEXT,                      -- JSON array: [2018]
    data_years_count     SMALLINT,
    years_json           TEXT,                      -- JSON array for inspection
    values_json          TEXT,                      -- JSON array of raw values

    updated_at           TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (ticker, metric_name)
);

CREATE INDEX IF NOT EXISTS idx_nm_ticker ON normalized_metrics(ticker);


-- =============================================================================
-- 3. stock_scores — Stage 3: Scoring Engine output
--    One row per ticker. Decomposed reliability + confidence scores.
-- =============================================================================

CREATE TABLE IF NOT EXISTS stock_scores (
    ticker                   TEXT PRIMARY KEY REFERENCES stocks(ticker) ON DELETE CASCADE,

    -- Reliability (data quality gate, max 100)
    reliability_total        DECIMAL(6,2),
    reliability_grade        TEXT,                   -- A|B|C|D|F
    reliability_completeness DECIMAL(6,2),           -- max 30: metrics with data / 20
    reliability_consistency  DECIMAL(6,2),           -- max 25: clean years / total years
    reliability_freshness    DECIMAL(6,2),           -- max 25: latest financial year recency
    reliability_source       DECIMAL(6,2),           -- max 20: stockbit > idx > yfinance
    reliability_penalties    DECIMAL(6,2),           -- deductions for anomalies, scale issues

    -- Confidence (signal strength, max 100)
    confidence_total         DECIMAL(6,2),
    confidence_grade         TEXT,                   -- HIGH|MEDIUM|LOW|VERY LOW
    confidence_signal        DECIMAL(6,2),           -- max 25: smart money signal agreement
    confidence_trend         DECIMAL(6,2),           -- max 25: average R² of metric trends
    confidence_depth         DECIMAL(6,2),           -- max 20: years of data available
    confidence_peers         DECIMAL(6,2),           -- max 15: sector peer availability
    confidence_valuation     DECIMAL(6,2),           -- max 15: valuation anchor strength
    confidence_penalty       DECIMAL(6,2),           -- deductions

    -- Composite
    composite_score          DECIMAL(6,2),           -- blended: reliability gates confidence
    ready_for_ai             BOOLEAN,                -- eligibility gate for AI analysis

    -- Signal inventory (JSON arrays)
    bullish_signals          TEXT,
    bearish_signals          TEXT,
    neutral_signals          TEXT,
    data_gap_flags           TEXT,                   -- passed verbatim to AI prompt context

    -- Metadata
    data_years_available     SMALLINT,
    primary_source           TEXT,
    auditor_tier             TEXT,
    missing_metrics          TEXT,                   -- JSON array
    anomalous_metrics        TEXT,                   -- JSON array
    sector_peers_count       SMALLINT DEFAULT 0,     -- peers in subsector with financials
    computed_at              TIMESTAMPTZ DEFAULT NOW()
);


-- =============================================================================
-- 4. ai_context_cache — Stage 4: Context Builder output
--    One row per ticker. The full JSON bundle passed to Claude API.
-- =============================================================================

CREATE TABLE IF NOT EXISTS ai_context_cache (
    ticker           TEXT PRIMARY KEY REFERENCES stocks(ticker) ON DELETE CASCADE,
    context_json     JSONB NOT NULL,                -- the full 8-block AI context bundle
    context_version  TEXT DEFAULT '1.0',            -- bump when bundle schema changes
    token_estimate   INTEGER,                       -- estimated Claude API tokens (~len/4)
    ready_for_ai     BOOLEAN DEFAULT FALSE,         -- gates both reliability and confidence
    built_at         TIMESTAMPTZ DEFAULT NOW(),
    data_as_of       DATE                           -- latest date of any underlying data
);


-- =============================================================================
-- 5. ai_analysis — Stage 5: AI Analyst output
--    One row per ticker. 3-scenario investment thesis from Claude.
-- =============================================================================

CREATE TABLE IF NOT EXISTS ai_analysis (
    ticker                   TEXT PRIMARY KEY REFERENCES stocks(ticker) ON DELETE CASCADE,

    -- Classification (Lynch + Buffett)
    lynch_category           TEXT,                   -- slow_grower|stalwart|fast_grower|cyclical|turnaround|asset_play
    lynch_rationale          TEXT,
    buffett_moat             TEXT,                   -- none|narrow|wide
    buffett_moat_source      TEXT,
    business_narrative       TEXT,                   -- 3-4 sentence business story
    financial_health_signal  TEXT,                   -- improving|stable|deteriorating

    -- Three scenarios (stored as JSONB)
    bull_case                JSONB,                  -- {scenario, drivers[], price_target, timeframe, probability, early_signs[]}
    bear_case                JSONB,                  -- same structure
    neutral_case             JSONB,                  -- {scenario, drivers[], price_range_low, price_range_high, probability, what_breaks_it[]}

    -- Strategy
    strategy_fit             JSONB,                  -- {primary, ideal_investor, position_sizing}
    what_to_watch            TEXT,                   -- JSON array of metric+threshold strings
    analyst_verdict          TEXT,                   -- strong_buy|buy|hold|avoid|strong_avoid
    confidence_level         SMALLINT,               -- 1-10 (AI self-reported)

    -- Data quality acknowledgement
    data_gaps_acknowledged   TEXT,                   -- JSON array
    caveats                  TEXT,                   -- JSON array

    -- Metadata
    model_used               TEXT DEFAULT 'claude-sonnet-4-20250514',
    context_version          TEXT,                   -- from ai_context_cache.context_version
    prompt_tokens            INTEGER,
    output_tokens            INTEGER,
    generated_at             TIMESTAMPTZ DEFAULT NOW()
);


-- =============================================================================
-- 6. stock_notes — Layer 3 domain context (optional, user-written)
--    Free-text business context injected into AI prompt when available.
-- =============================================================================

CREATE TABLE IF NOT EXISTS stock_notes (
    ticker           TEXT PRIMARY KEY REFERENCES stocks(ticker) ON DELETE CASCADE,
    domain_notes     TEXT,                          -- 2-5 sentences of company-specific context
    updated_at       TIMESTAMPTZ DEFAULT NOW()
);


-- =============================================================================
-- 7. sector_templates — Layer 2 domain context (per-subsector analysis framework)
--    33 subsectors on IDX. Tells the AI which metrics matter and how to value.
-- =============================================================================

CREATE TABLE IF NOT EXISTS sector_templates (
    subsector        TEXT PRIMARY KEY,
    key_metrics      TEXT,                          -- JSON array: ["NIM", "CASA ratio", "NPL"]
    valuation_method TEXT,                          -- e.g. "PBV primary, PE secondary"
    cycle_context    TEXT,                          -- current position in sector cycle
    current_dynamics TEXT,                          -- what's happening in this sector now
    common_risks     TEXT,                          -- JSON array of sector-specific risks
    exemptions       TEXT,                          -- metrics to ignore (e.g. current_ratio for banks)
    bumn_note        TEXT,                          -- BUMN-specific guidance if applicable
    updated_at       TIMESTAMPTZ DEFAULT NOW()
);
