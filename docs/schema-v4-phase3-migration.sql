-- =============================================================================
-- Schema v4 Migration — Phase 3: Refresh Request Queue
-- Apply in Supabase SQL Editor after schema-v3-phase2-migration.sql
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. stock_refresh_requests — user-triggered single-ticker scraper jobs
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS stock_refresh_requests (
    id                   SERIAL PRIMARY KEY,
    ticker               TEXT NOT NULL REFERENCES stocks(ticker) ON DELETE CASCADE,
    requested_at         TIMESTAMPTZ DEFAULT NOW(),
    status               TEXT NOT NULL DEFAULT 'pending',  -- 'pending'|'running'|'done'|'failed'
    completeness_before  INTEGER,
    confidence_before    INTEGER,
    completeness_after   INTEGER,
    confidence_after     INTEGER,
    no_new_data          BOOLEAN DEFAULT FALSE,
    error_message        TEXT,
    finished_at          TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_refresh_ticker        ON stock_refresh_requests(ticker);
CREATE INDEX IF NOT EXISTS idx_refresh_status        ON stock_refresh_requests(status);
CREATE INDEX IF NOT EXISTS idx_refresh_ticker_recent ON stock_refresh_requests(ticker, requested_at DESC);

-- -----------------------------------------------------------------------------
-- 2. refresh_scraper_progress — per-scraper progress rows for a refresh job
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS refresh_scraper_progress (
    id           SERIAL PRIMARY KEY,
    request_id   INTEGER NOT NULL REFERENCES stock_refresh_requests(id) ON DELETE CASCADE,
    scraper_name TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'waiting',  -- 'waiting'|'running'|'done'|'failed'
    rows_added   INTEGER,
    duration_ms  INTEGER,
    error_msg    TEXT,
    updated_at   TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (request_id, scraper_name)
);

CREATE INDEX IF NOT EXISTS idx_progress_request ON refresh_scraper_progress(request_id);

-- -----------------------------------------------------------------------------
-- 3. RLS — personal-use app: disable RLS on both new tables so the anon key
--    (used by the Next.js server) can read and write without auth policies.
-- -----------------------------------------------------------------------------

ALTER TABLE stock_refresh_requests    DISABLE ROW LEVEL SECURITY;
ALTER TABLE refresh_scraper_progress  DISABLE ROW LEVEL SECURITY;
