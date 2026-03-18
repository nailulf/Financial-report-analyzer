-- =============================================================================
-- IDX Stock Analyzer — Supabase Schema
-- Apply this in the Supabase SQL Editor (Database > SQL Editor > New query)
-- =============================================================================

-- Enable UUID extension (available by default in Supabase)
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- =============================================================================
-- LAYER 1: Stock Universe
-- =============================================================================

CREATE TABLE IF NOT EXISTS stocks (
    ticker          TEXT PRIMARY KEY,
    name            TEXT,
    sector          TEXT,
    subsector       TEXT,
    listing_date    DATE,
    listed_shares   BIGINT,
    market_cap      BIGINT,           -- IDR
    board           TEXT,             -- 'Main', 'Development', 'Acceleration'
    is_lq45         BOOLEAN DEFAULT FALSE,
    is_idx30        BOOLEAN DEFAULT FALSE,
    status          TEXT DEFAULT 'Active', -- 'Active', 'Suspended', 'Delisted'
    last_updated    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_stocks_sector ON stocks(sector);
CREATE INDEX IF NOT EXISTS idx_stocks_status ON stocks(status);

-- =============================================================================
-- LAYER 2: Daily Market Data
-- =============================================================================

CREATE TABLE IF NOT EXISTS daily_prices (
    id              BIGSERIAL PRIMARY KEY,
    ticker          TEXT NOT NULL REFERENCES stocks(ticker) ON DELETE CASCADE,
    date            DATE NOT NULL,
    open            DECIMAL(12, 2),
    high            DECIMAL(12, 2),
    low             DECIMAL(12, 2),
    close           DECIMAL(12, 2),
    volume          BIGINT,
    value           BIGINT,           -- Transaction value IDR
    frequency       INTEGER,          -- Number of transactions
    foreign_buy     BIGINT,           -- Foreign buy value IDR
    foreign_sell    BIGINT,           -- Foreign sell value IDR
    foreign_net     BIGINT,           -- Net foreign flow IDR (buy - sell)
    last_updated    TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (ticker, date)
);

CREATE INDEX IF NOT EXISTS idx_daily_prices_ticker ON daily_prices(ticker);
CREATE INDEX IF NOT EXISTS idx_daily_prices_date ON daily_prices(date);
CREATE INDEX IF NOT EXISTS idx_daily_prices_ticker_date ON daily_prices(ticker, date DESC);

-- =============================================================================
-- LAYER 3: Financial Statements
-- =============================================================================

CREATE TABLE IF NOT EXISTS financials (
    id                      SERIAL PRIMARY KEY,
    ticker                  TEXT NOT NULL REFERENCES stocks(ticker) ON DELETE CASCADE,
    year                    INTEGER NOT NULL,
    quarter                 INTEGER NOT NULL,   -- 0 = annual, 1-4 = quarterly
    period_end              DATE,

    -- Income Statement
    revenue                 BIGINT,
    cost_of_revenue         BIGINT,
    gross_profit            BIGINT,
    operating_expense       BIGINT,
    operating_income        BIGINT,             -- EBIT
    interest_expense        BIGINT,
    income_before_tax       BIGINT,
    tax_expense             BIGINT,
    net_income              BIGINT,
    eps                     DECIMAL(20, 4),

    -- Balance Sheet
    total_assets            BIGINT,
    current_assets          BIGINT,
    total_liabilities       BIGINT,
    current_liabilities     BIGINT,
    total_equity            BIGINT,
    total_debt              BIGINT,
    cash_and_equivalents    BIGINT,
    book_value_per_share    DECIMAL(20, 4),

    -- Cash Flow
    operating_cash_flow     BIGINT,
    capex                   BIGINT,
    free_cash_flow          BIGINT,
    dividends_paid          BIGINT,

    -- Computed Ratios (stored for query performance)
    -- DECIMAL(20,4): some IDX stocks have extreme ratios (e.g. near-zero equity → ROE in millions)
    gross_margin            DECIMAL(20, 4),     -- %
    operating_margin        DECIMAL(20, 4),     -- %
    net_margin              DECIMAL(20, 4),     -- %
    roe                     DECIMAL(20, 4),     -- %
    roa                     DECIMAL(20, 4),     -- %
    current_ratio           DECIMAL(20, 4),
    debt_to_equity          DECIMAL(20, 4),
    pe_ratio                DECIMAL(20, 4),
    pbv_ratio               DECIMAL(20, 4),
    dividend_yield          DECIMAL(20, 4),     -- %
    payout_ratio            DECIMAL(20, 4),     -- %

    source                  TEXT DEFAULT 'yfinance', -- 'yfinance', 'idx', 'manual'
    last_updated            TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (ticker, year, quarter)
);

CREATE INDEX IF NOT EXISTS idx_financials_ticker ON financials(ticker);
CREATE INDEX IF NOT EXISTS idx_financials_year_quarter ON financials(year, quarter);
CREATE INDEX IF NOT EXISTS idx_financials_ticker_year ON financials(ticker, year DESC, quarter DESC);

-- =============================================================================
-- LAYER 4: Company Profiles
-- =============================================================================

CREATE TABLE IF NOT EXISTS company_profiles (
    ticker              TEXT PRIMARY KEY REFERENCES stocks(ticker) ON DELETE CASCADE,
    description         TEXT,
    website             TEXT,
    address             TEXT,
    phone               TEXT,
    email               TEXT,
    npwp                TEXT,           -- Indonesian tax ID
    listing_date        DATE,
    registry_agency     TEXT,           -- Share registrar
    last_updated        TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS company_officers (
    id              SERIAL PRIMARY KEY,
    ticker          TEXT NOT NULL REFERENCES stocks(ticker) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    role            TEXT,               -- 'director', 'commissioner', 'committee'
    title           TEXT,               -- 'President Director', 'Independent Commissioner', etc.
    is_independent  BOOLEAN DEFAULT FALSE,
    last_updated    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_officers_ticker ON company_officers(ticker);

CREATE TABLE IF NOT EXISTS shareholders (
    id              SERIAL PRIMARY KEY,
    ticker          TEXT NOT NULL REFERENCES stocks(ticker) ON DELETE CASCADE,
    holder_name     TEXT NOT NULL,
    holder_type     TEXT,               -- 'institution', 'individual', 'government', 'public'
    shares_held     BIGINT,
    percentage      DECIMAL(8, 4),      -- Ownership %
    snapshot_date   DATE,
    last_updated    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_shareholders_ticker ON shareholders(ticker);

-- =============================================================================
-- LAYER 5: Money Flow & Broker Data
-- =============================================================================

-- NOTE: IDX API (GetBrokerSummary) provides total volume/value per broker only.
-- buy/sell split is NOT available. buy_volume/buy_value store the total.
-- sell_volume, sell_value, net_volume, net_value are always NULL.
CREATE TABLE IF NOT EXISTS broker_summary (
    id              BIGSERIAL PRIMARY KEY,
    ticker          TEXT NOT NULL REFERENCES stocks(ticker) ON DELETE CASCADE,
    date            DATE NOT NULL,
    broker_code     TEXT NOT NULL,      -- IDX broker code, e.g. 'YP', 'MS'
    broker_name     TEXT,
    buy_volume      BIGINT,             -- total volume (buy + sell combined)
    buy_value       BIGINT,             -- total value IDR (buy + sell combined)
    sell_volume     BIGINT,             -- NULL — not available from IDX API
    sell_value      BIGINT,             -- NULL — not available from IDX API
    net_volume      BIGINT,             -- NULL — not available from IDX API
    net_value       BIGINT,             -- NULL — not available from IDX API
    frequency       INTEGER,            -- total number of transactions
    last_updated    TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (ticker, date, broker_code)
);

-- Run this ALTER if schema was already applied before this fix:
-- ALTER TABLE broker_summary ADD COLUMN IF NOT EXISTS frequency INTEGER;

CREATE INDEX IF NOT EXISTS idx_broker_ticker ON broker_summary(ticker);
CREATE INDEX IF NOT EXISTS idx_broker_date ON broker_summary(date);
CREATE INDEX IF NOT EXISTS idx_broker_ticker_date ON broker_summary(ticker, date DESC);

-- =============================================================================
-- META: Scraper Run History
-- =============================================================================

CREATE TABLE IF NOT EXISTS scraper_runs (
    id                  SERIAL PRIMARY KEY,
    scraper_name        TEXT NOT NULL,          -- e.g., 'daily_prices', 'financials'
    started_at          TIMESTAMPTZ NOT NULL,
    finished_at         TIMESTAMPTZ,
    stocks_processed    INTEGER DEFAULT 0,
    stocks_failed       INTEGER DEFAULT 0,
    stocks_skipped      INTEGER DEFAULT 0,
    status              TEXT DEFAULT 'running',  -- 'running', 'success', 'partial', 'failed'
    error_message       TEXT,
    metadata            JSONB                   -- any extra context (e.g., date range scraped)
);

CREATE INDEX IF NOT EXISTS idx_scraper_runs_name ON scraper_runs(scraper_name);
CREATE INDEX IF NOT EXISTS idx_scraper_runs_started ON scraper_runs(started_at DESC);

-- =============================================================================
-- VIEWS — pre-joined queries for the NextJS app
-- Apply after tables are created and populated.
-- =============================================================================

-- Latest closing price per ticker (used everywhere)
CREATE OR REPLACE VIEW v_latest_prices AS
SELECT DISTINCT ON (ticker)
    ticker,
    date,
    close,
    open,
    high,
    low,
    volume,
    value,
    foreign_net
FROM daily_prices
ORDER BY ticker, date DESC;

-- Latest annual financials + computed ratios per ticker
CREATE OR REPLACE VIEW v_latest_annual_financials AS
SELECT DISTINCT ON (f.ticker)
    f.*,
    s.name,
    s.sector,
    s.subsector,
    s.market_cap,
    s.listed_shares,
    p.close AS current_price
FROM financials f
JOIN stocks s ON s.ticker = f.ticker
LEFT JOIN v_latest_prices p ON p.ticker = f.ticker
WHERE f.quarter = 0           -- annual only
ORDER BY f.ticker, f.year DESC;

-- Stock screener view: one row per stock with key metrics for filtering
-- Example query: SELECT * FROM v_screener WHERE roe > 15 AND debt_to_equity < 1
CREATE OR REPLACE VIEW v_screener AS
SELECT
    s.ticker,
    s.name,
    s.sector,
    s.subsector,
    s.board,
    s.is_lq45,
    s.is_idx30,
    s.market_cap,
    s.listed_shares,
    s.status,
    -- Latest price
    p.close       AS price,
    p.date        AS price_date,
    p.foreign_net AS latest_foreign_net,
    -- Latest annual financials
    f.year        AS financial_year,
    f.revenue,
    f.gross_profit,
    f.operating_income,
    f.net_income,
    f.total_assets,
    f.total_equity,
    f.total_debt,
    f.cash_and_equivalents,
    f.operating_cash_flow,
    f.free_cash_flow,
    f.dividends_paid,
    f.eps,
    f.book_value_per_share,
    -- Ratios
    f.gross_margin,
    f.operating_margin,
    f.net_margin,
    f.roe,
    f.roa,
    f.current_ratio,
    f.debt_to_equity,
    f.pe_ratio,
    f.pbv_ratio,
    f.dividend_yield,
    f.payout_ratio
FROM stocks s
LEFT JOIN v_latest_prices p ON p.ticker = s.ticker
LEFT JOIN v_latest_annual_financials f ON f.ticker = s.ticker
WHERE s.status = 'Active';

-- Foreign flow summary: last 5 and 20 trading days per ticker
CREATE OR REPLACE VIEW v_foreign_flow_summary AS
SELECT
    ticker,
    SUM(CASE WHEN date >= CURRENT_DATE - INTERVAL '5 days'  THEN foreign_net ELSE 0 END) AS foreign_net_5d,
    SUM(CASE WHEN date >= CURRENT_DATE - INTERVAL '20 days' THEN foreign_net ELSE 0 END) AS foreign_net_20d,
    SUM(foreign_net)                                                                       AS foreign_net_all,
    MAX(date)                                                                              AS latest_date
FROM daily_prices
WHERE foreign_net IS NOT NULL
GROUP BY ticker;

-- Top broker activity per stock per date (for money flow dashboard)
-- Usage: SELECT * FROM v_top_brokers WHERE ticker = 'BBRI' ORDER BY date DESC, abs(net_value) DESC
CREATE OR REPLACE VIEW v_top_brokers AS
SELECT
    ticker,
    date,
    broker_code,
    broker_name,
    buy_value,
    sell_value,
    net_value,
    net_volume,
    RANK() OVER (PARTITION BY ticker, date ORDER BY net_value DESC) AS rank_buyer,
    RANK() OVER (PARTITION BY ticker, date ORDER BY net_value ASC)  AS rank_seller
FROM broker_summary;

-- =============================================================================
-- DATA COMPLETENESS SCORE (0–100 per stock)
-- Score reflects how much data we have for a stock across the last 5 years.
--
-- Scoring breakdown:
--   Price History        30 pts  trading_days / 1250  (5yr × 250 days)
--   Annual Coverage      20 pts  annual_years / 5
--   Annual Field Quality 15 pts  7 core fields present in latest annual row
--   Quarterly Coverage   15 pts  quarterly_rows / 8
--   Company Profile      10 pts  description(4) + website(2) + address(2) + shareholders(2)
--   Money Flow           10 pts  recent foreign flow (5) + broker summary data (5)
--   ─────────────────────────────
--   Total               100 pts  (minimum 1 for any stock in the universe)
-- =============================================================================

CREATE OR REPLACE VIEW v_data_completeness AS
WITH
-- 1. Price history stats
price_stats AS (
    SELECT
        ticker,
        COUNT(*)                                                                                         AS price_days,
        MAX(date)                                                                                        AS latest_price_date,
        SUM(CASE WHEN date >= CURRENT_DATE - INTERVAL '30 days' AND foreign_net IS NOT NULL THEN 1 ELSE 0 END) AS recent_foreign_days
    FROM daily_prices
    GROUP BY ticker
),
-- 2. Annual financials coverage
annual_stats AS (
    SELECT
        ticker,
        COUNT(DISTINCT year) AS annual_years,
        MAX(year)            AS latest_financial_year
    FROM financials
    WHERE quarter = 0
    GROUP BY ticker
),
-- 3. Key field quality on latest annual record
--    Fields checked: revenue, net_income, total_assets, total_equity,
--                    operating_cash_flow, free_cash_flow, book_value_per_share
latest_annual AS (
    SELECT DISTINCT ON (ticker)
        ticker,
        (CASE WHEN revenue               IS NOT NULL THEN 1 ELSE 0 END
       + CASE WHEN net_income            IS NOT NULL THEN 1 ELSE 0 END
       + CASE WHEN total_assets          IS NOT NULL THEN 1 ELSE 0 END
       + CASE WHEN total_equity          IS NOT NULL THEN 1 ELSE 0 END
       + CASE WHEN operating_cash_flow   IS NOT NULL THEN 1 ELSE 0 END
       + CASE WHEN free_cash_flow        IS NOT NULL THEN 1 ELSE 0 END
       + CASE WHEN book_value_per_share  IS NOT NULL THEN 1 ELSE 0 END) AS fields_present
    FROM financials
    WHERE quarter = 0
    ORDER BY ticker, year DESC
),
-- 4. Quarterly coverage
quarterly_stats AS (
    SELECT
        ticker,
        COUNT(*) AS quarterly_rows
    FROM financials
    WHERE quarter > 0
    GROUP BY ticker
),
-- 5. Company profile quality
profile_stats AS (
    SELECT
        cp.ticker,
        (CASE WHEN cp.description IS NOT NULL AND LENGTH(cp.description) > 50 THEN 4 ELSE 0 END
       + CASE WHEN cp.website IS NOT NULL THEN 2 ELSE 0 END
       + CASE WHEN cp.address IS NOT NULL THEN 2 ELSE 0 END)  AS profile_pts,
        CASE WHEN sh.shareholder_count > 0 THEN 2 ELSE 0 END  AS shareholder_pts
    FROM company_profiles cp
    LEFT JOIN (
        SELECT ticker, COUNT(*) AS shareholder_count
        FROM shareholders
        GROUP BY ticker
    ) sh ON sh.ticker = cp.ticker
),
-- 6. Broker summary data
broker_stats AS (
    SELECT
        ticker,
        COUNT(DISTINCT date) AS broker_dates
    FROM broker_summary
    GROUP BY ticker
)
SELECT
    s.ticker,

    -- Component scores (for breakdown display)
    ROUND(LEAST(COALESCE(ps.price_days, 0)       / 1250.0, 1.0) * 30)::INTEGER  AS price_score,
    ROUND(LEAST(COALESCE(an.annual_years, 0)      / 5.0,   1.0) * 20)::INTEGER  AS annual_coverage_score,
    ROUND(COALESCE(la.fields_present, 0)          / 7.0    * 15)::INTEGER       AS annual_quality_score,
    ROUND(LEAST(COALESCE(qs.quarterly_rows, 0)   / 8.0,   1.0) * 15)::INTEGER  AS quarterly_score,
    COALESCE(prof.profile_pts, 0) + COALESCE(prof.shareholder_pts, 0)           AS profile_score,
    CASE
        WHEN COALESCE(ps.recent_foreign_days, 0) >= 5 THEN 5
        WHEN COALESCE(ps.recent_foreign_days, 0) >= 1 THEN 2
        ELSE 0
    END                                                                          AS foreign_flow_score,
    CASE
        WHEN COALESCE(br.broker_dates, 0) >= 5 THEN 5
        WHEN COALESCE(br.broker_dates, 0) >= 1 THEN 2
        ELSE 0
    END                                                                          AS broker_score,

    -- Total completeness score (1–100)
    GREATEST(1, LEAST(100,
        ROUND(LEAST(COALESCE(ps.price_days, 0)    / 1250.0, 1.0) * 30)::INTEGER
      + ROUND(LEAST(COALESCE(an.annual_years, 0)  / 5.0,   1.0) * 20)::INTEGER
      + ROUND(COALESCE(la.fields_present, 0)      / 7.0    * 15)::INTEGER
      + ROUND(LEAST(COALESCE(qs.quarterly_rows,0) / 8.0,   1.0) * 15)::INTEGER
      + COALESCE(prof.profile_pts, 0) + COALESCE(prof.shareholder_pts, 0)
      + CASE WHEN COALESCE(ps.recent_foreign_days, 0) >= 5 THEN 5
             WHEN COALESCE(ps.recent_foreign_days, 0) >= 1 THEN 2 ELSE 0 END
      + CASE WHEN COALESCE(br.broker_dates, 0) >= 5 THEN 5
             WHEN COALESCE(br.broker_dates, 0) >= 1 THEN 2 ELSE 0 END
    ))                                                                           AS completeness_score,

    -- Raw stats for debugging / tooltips
    COALESCE(ps.price_days, 0)        AS price_days_count,
    COALESCE(an.annual_years, 0)      AS annual_years_count,
    COALESCE(qs.quarterly_rows, 0)    AS quarterly_rows_count,
    ps.latest_price_date,
    an.latest_financial_year

FROM stocks s
LEFT JOIN price_stats     ps   ON ps.ticker   = s.ticker
LEFT JOIN annual_stats    an   ON an.ticker   = s.ticker
LEFT JOIN latest_annual   la   ON la.ticker   = s.ticker
LEFT JOIN quarterly_stats qs   ON qs.ticker   = s.ticker
LEFT JOIN profile_stats   prof ON prof.ticker = s.ticker
LEFT JOIN broker_stats    br   ON br.ticker   = s.ticker;
