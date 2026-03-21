-- =============================================================================
-- Schema v7 — Major Shareholders (≥1%) Historical Snapshots
-- Apply in Supabase SQL Editor after schema-v6-screener-perf.sql
--
-- Purpose: Store bulk-uploaded 1%+ shareholder data from periodic PDF/Excel
-- reports. Unlike the `shareholders` table (which overwrites on each IDX API
-- scrape), this table accumulates one row per (ticker, holder_name, report_date)
-- so every upload creates a new historical snapshot.
-- =============================================================================

CREATE TABLE IF NOT EXISTS shareholders_major (
    id              BIGSERIAL PRIMARY KEY,
    ticker          TEXT NOT NULL REFERENCES stocks(ticker) ON DELETE CASCADE,

    -- Report date = the "as-of" date stated in the source document
    -- Used as the snapshot key. All rows from one upload share the same date.
    report_date     DATE NOT NULL,

    holder_name     TEXT NOT NULL,
    holder_type     TEXT,               -- 'institution', 'individual', 'government', 'public', 'foreign'
    shares_held     BIGINT,             -- Number of shares
    percentage      DECIMAL(8, 4),     -- Ownership %, e.g. 15.32 means 15.32%

    -- Source tracking
    source          TEXT DEFAULT 'pdf_upload',   -- 'pdf_upload', 'excel_upload', 'idx_api'
    uploaded_at     TIMESTAMPTZ DEFAULT NOW(),
    last_updated    TIMESTAMPTZ DEFAULT NOW(),

    -- One holder per stock per report date — safe to re-upload the same file
    UNIQUE (ticker, holder_name, report_date)
);

CREATE INDEX IF NOT EXISTS idx_shareholders_major_ticker
    ON shareholders_major (ticker);

CREATE INDEX IF NOT EXISTS idx_shareholders_major_ticker_date
    ON shareholders_major (ticker, report_date DESC);

CREATE INDEX IF NOT EXISTS idx_shareholders_major_report_date
    ON shareholders_major (report_date DESC);

-- =============================================================================
-- Convenience view: latest snapshot per ticker
-- Returns the most recent report_date's data for each ticker.
-- =============================================================================

CREATE OR REPLACE VIEW v_shareholders_major_latest AS
WITH latest_dates AS (
    SELECT ticker, MAX(report_date) AS latest_date
    FROM shareholders_major
    GROUP BY ticker
)
SELECT sm.*
FROM shareholders_major sm
JOIN latest_dates ld ON sm.ticker = ld.ticker AND sm.report_date = ld.latest_date
ORDER BY sm.ticker, sm.percentage DESC NULLS LAST;

-- =============================================================================
-- Convenience view: available report dates (for UI history selector)
-- =============================================================================

CREATE OR REPLACE VIEW v_shareholders_major_snapshots AS
SELECT
    report_date,
    COUNT(DISTINCT ticker) AS stocks_covered,
    COUNT(*)               AS total_holders,
    MAX(uploaded_at)       AS uploaded_at
FROM shareholders_major
GROUP BY report_date
ORDER BY report_date DESC;
