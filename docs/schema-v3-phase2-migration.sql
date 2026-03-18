-- =============================================================================
-- Schema v3 Migration — Phase 2: Document Links & Corporate Events
-- Apply in Supabase SQL Editor after schema-v2-migration.sql
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. company_documents — Annual reports, quarterly reports (PDF links from IDX)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS company_documents (
    id              SERIAL PRIMARY KEY,
    ticker          TEXT NOT NULL REFERENCES stocks(ticker) ON DELETE CASCADE,
    doc_type        TEXT NOT NULL,      -- 'annual_report' | 'quarterly_report'
    period_year     INTEGER NOT NULL,
    period_quarter  INTEGER NOT NULL,   -- 0 for annual, 1-4 for quarterly
    file_id         TEXT,               -- IDX internal file identifier
    doc_url         TEXT,               -- Constructed download URL
    doc_title       TEXT,
    published_date  DATE,
    fetched_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (ticker, doc_type, period_year, period_quarter)
);

CREATE INDEX IF NOT EXISTS idx_docs_ticker      ON company_documents(ticker);
CREATE INDEX IF NOT EXISTS idx_docs_ticker_type ON company_documents(ticker, doc_type);

-- -----------------------------------------------------------------------------
-- 2. corporate_events — Public expose, AGM, EGM records
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS corporate_events (
    id              SERIAL PRIMARY KEY,
    ticker          TEXT NOT NULL REFERENCES stocks(ticker) ON DELETE CASCADE,
    event_type      TEXT NOT NULL,      -- 'public_expose' | 'agm' | 'egm'
    event_date      DATE,
    title           TEXT,
    summary         TEXT,
    source_url      TEXT,
    fetched_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_events_ticker      ON corporate_events(ticker);
CREATE INDEX IF NOT EXISTS idx_events_ticker_type ON corporate_events(ticker, event_type);

-- -----------------------------------------------------------------------------
-- 3. Replace v_data_completeness — Phase 2 categories now fully scored
--
-- DROP first: CREATE OR REPLACE VIEW cannot rename/reorder existing columns,
-- only append new ones. No other views depend on v_data_completeness.
-- -----------------------------------------------------------------------------

DROP VIEW IF EXISTS v_data_completeness;

-- -----------------------------------------------------------------------------
-- 3 (cont). Recreate v_data_completeness — Phase 2 categories now fully scored
--
-- Weight breakdown (Phase 2 — max achievable: 100/100):
--   Price History            15 pts  (price_days / 1250)
--   Annual Coverage          12 pts  (annual_years / 5)
--   Annual Quality           10 pts  (7 core fields present)
--   Quarterly Financials     10 pts  (quarterly_rows / 8)
--   Company Profile           7 pts  (description+website+address+phone+email)
--   Board & Commissioners     8 pts  (directors + commissioners present)
--   Shareholders ≥1%          8 pts  (count ≥ 3, snapshot freshness)
--   Derived Metrics          10 pts  (10 ratio fields non-null)
--   Quarterly Report PDFs     8 pts  (docs for last 4 quarters / 4)
--   Annual Report PDFs        5 pts  (≥2 annual reports = 5, ≥1 = 3, 0 = 0)
--   Corporate Events          7 pts  (public_expose ≥1 = 4, agm ≥1 = 3)
-- -----------------------------------------------------------------------------

CREATE OR REPLACE VIEW v_data_completeness AS
WITH

-- 1. Price history
price_stats AS (
    SELECT
        ticker,
        COUNT(*)    AS price_days,
        MAX(date)   AS latest_price_date
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

-- 3. Core field quality on latest annual row (7 fields)
latest_annual AS (
    SELECT DISTINCT ON (ticker)
        ticker,
        (CASE WHEN revenue              IS NOT NULL THEN 1 ELSE 0 END
       + CASE WHEN net_income           IS NOT NULL THEN 1 ELSE 0 END
       + CASE WHEN total_assets         IS NOT NULL THEN 1 ELSE 0 END
       + CASE WHEN total_equity         IS NOT NULL THEN 1 ELSE 0 END
       + CASE WHEN operating_cash_flow  IS NOT NULL THEN 1 ELSE 0 END
       + CASE WHEN free_cash_flow       IS NOT NULL THEN 1 ELSE 0 END
       + CASE WHEN book_value_per_share IS NOT NULL THEN 1 ELSE 0 END) AS fields_present
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

-- 5. Company profile quality (max 7 pts)
profile_stats AS (
    SELECT
        ticker,
        (CASE WHEN description IS NOT NULL AND LENGTH(description) > 50 THEN 3 ELSE 0 END
       + CASE WHEN website     IS NOT NULL THEN 1 ELSE 0 END
       + CASE WHEN address     IS NOT NULL THEN 1 ELSE 0 END
       + CASE WHEN phone       IS NOT NULL THEN 1 ELSE 0 END
       + CASE WHEN email       IS NOT NULL THEN 1 ELSE 0 END) AS profile_pts
    FROM company_profiles
),

-- 6. Board & commissioners (max 8 pts)
board_stats AS (
    SELECT
        ticker,
        (CASE WHEN COUNT(*) FILTER (WHERE role = 'director')     > 0 THEN 4 ELSE 0 END
       + CASE WHEN COUNT(*) FILTER (WHERE role = 'commissioner') > 0 THEN 4 ELSE 0 END) AS board_pts
    FROM company_officers
    GROUP BY ticker
),

-- 7. Shareholders ≥1% — presence (5 pts) + snapshot freshness (3 pts)
shareholder_stats AS (
    SELECT
        ticker,
        COUNT(*)           AS shareholder_count,
        MAX(snapshot_date) AS latest_snapshot
    FROM shareholders
    WHERE percentage >= 1.0
    GROUP BY ticker
),

-- 8. Derived ratio fields on latest annual row (10 fields × 1 pt)
derived_stats AS (
    SELECT DISTINCT ON (ticker)
        ticker,
        (CASE WHEN pe_ratio       IS NOT NULL THEN 1 ELSE 0 END
       + CASE WHEN pbv_ratio      IS NOT NULL THEN 1 ELSE 0 END
       + CASE WHEN roe            IS NOT NULL THEN 1 ELSE 0 END
       + CASE WHEN roa            IS NOT NULL THEN 1 ELSE 0 END
       + CASE WHEN current_ratio  IS NOT NULL THEN 1 ELSE 0 END
       + CASE WHEN debt_to_equity IS NOT NULL THEN 1 ELSE 0 END
       + CASE WHEN net_margin     IS NOT NULL THEN 1 ELSE 0 END
       + CASE WHEN gross_margin   IS NOT NULL THEN 1 ELSE 0 END
       + CASE WHEN dividend_yield IS NOT NULL THEN 1 ELSE 0 END
       + CASE WHEN payout_ratio   IS NOT NULL THEN 1 ELSE 0 END) AS derived_fields
    FROM financials
    WHERE quarter = 0
    ORDER BY ticker, year DESC
),

-- 9. Quarterly report PDFs — score last 4 quarters available (max 8 pts)
quarterly_doc_stats AS (
    SELECT
        ticker,
        COUNT(DISTINCT (period_year, period_quarter)) AS q_doc_count
    FROM company_documents
    WHERE doc_type = 'quarterly_report'
      AND period_quarter > 0
      -- Last 4 complete quarters only (approx. 15 months back)
      AND (period_year * 10 + period_quarter) >= (
            (EXTRACT(YEAR FROM CURRENT_DATE)::INTEGER - 1) * 10 + 1
          )
    GROUP BY ticker
),

-- 10. Annual report PDFs (max 5 pts: ≥2 = 5, ≥1 = 3, 0 = 0)
annual_doc_stats AS (
    SELECT
        ticker,
        COUNT(*) AS annual_doc_count
    FROM company_documents
    WHERE doc_type = 'annual_report'
    GROUP BY ticker
),

-- 11. Corporate events (max 7 pts: public_expose ≥1 = 4, agm ≥1 = 3)
event_stats AS (
    SELECT
        ticker,
        COUNT(*) FILTER (WHERE event_type = 'public_expose') AS expose_count,
        COUNT(*) FILTER (WHERE event_type IN ('agm', 'egm')) AS agm_count
    FROM corporate_events
    GROUP BY ticker
)

SELECT
    s.ticker,

    -- -------------------------------------------------------------------------
    -- Component scores
    -- -------------------------------------------------------------------------
    ROUND(LEAST(COALESCE(ps.price_days, 0)        / 1250.0, 1.0) * 15)::INTEGER  AS price_score,
    ROUND(LEAST(COALESCE(an.annual_years, 0)       / 5.0,   1.0) * 12)::INTEGER  AS annual_coverage_score,
    ROUND(COALESCE(la.fields_present, 0)           / 7.0    * 10)::INTEGER       AS annual_quality_score,
    ROUND(LEAST(COALESCE(qs.quarterly_rows, 0)     / 8.0,   1.0) * 10)::INTEGER  AS quarterly_score,
    COALESCE(prof.profile_pts, 0)                                                 AS profile_score,
    COALESCE(bs.board_pts, 0)                                                     AS board_score,
    (CASE WHEN COALESCE(sh.shareholder_count, 0) >= 3 THEN 5
          WHEN COALESCE(sh.shareholder_count, 0) >= 1 THEN 2
          ELSE 0 END
   + CASE WHEN sh.latest_snapshot IS NOT NULL
               AND sh.latest_snapshot >= CURRENT_DATE - INTERVAL '180 days' THEN 3
          ELSE 0 END)                                                              AS shareholder_score,
    COALESCE(dm.derived_fields, 0)                                                AS derived_metrics_score,

    -- Quarterly report PDFs (max 8: proportional to 4 recent quarters covered)
    LEAST(ROUND(COALESCE(qd.q_doc_count, 0) / 4.0 * 8)::INTEGER, 8)             AS quarterly_reports_score,

    -- Annual report PDFs (max 5)
    CASE WHEN COALESCE(ad.annual_doc_count, 0) >= 2 THEN 5
         WHEN COALESCE(ad.annual_doc_count, 0) = 1  THEN 3
         ELSE 0 END                                                               AS annual_reports_score,

    -- Corporate events (max 7: public_expose=4, agm/egm=3)
    (CASE WHEN COALESCE(ev.expose_count, 0) >= 1 THEN 4 ELSE 0 END
   + CASE WHEN COALESCE(ev.agm_count,    0) >= 1 THEN 3 ELSE 0 END)             AS corporate_events_score,

    -- -------------------------------------------------------------------------
    -- Total completeness score (1–100, Phase 2 max: 100)
    -- -------------------------------------------------------------------------
    GREATEST(1, LEAST(100,
        ROUND(LEAST(COALESCE(ps.price_days, 0)      / 1250.0, 1.0) * 15)::INTEGER
      + ROUND(LEAST(COALESCE(an.annual_years, 0)    / 5.0,    1.0) * 12)::INTEGER
      + ROUND(COALESCE(la.fields_present, 0)        / 7.0     * 10)::INTEGER
      + ROUND(LEAST(COALESCE(qs.quarterly_rows, 0)  / 8.0,    1.0) * 10)::INTEGER
      + COALESCE(prof.profile_pts, 0)
      + COALESCE(bs.board_pts, 0)
      + (CASE WHEN COALESCE(sh.shareholder_count, 0) >= 3 THEN 5
              WHEN COALESCE(sh.shareholder_count, 0) >= 1 THEN 2
              ELSE 0 END
       + CASE WHEN sh.latest_snapshot IS NOT NULL
                   AND sh.latest_snapshot >= CURRENT_DATE - INTERVAL '180 days' THEN 3
              ELSE 0 END)
      + COALESCE(dm.derived_fields, 0)
      + LEAST(ROUND(COALESCE(qd.q_doc_count, 0) / 4.0 * 8)::INTEGER, 8)
      + CASE WHEN COALESCE(ad.annual_doc_count, 0) >= 2 THEN 5
             WHEN COALESCE(ad.annual_doc_count, 0) = 1  THEN 3
             ELSE 0 END
      + (CASE WHEN COALESCE(ev.expose_count, 0) >= 1 THEN 4 ELSE 0 END
       + CASE WHEN COALESCE(ev.agm_count,    0) >= 1 THEN 3 ELSE 0 END)
    ))                                                                            AS completeness_score,

    -- -------------------------------------------------------------------------
    -- Raw counts (for tooltip details)
    -- -------------------------------------------------------------------------
    COALESCE(ps.price_days, 0)        AS price_days_count,
    COALESCE(an.annual_years, 0)      AS annual_years_count,
    COALESCE(qs.quarterly_rows, 0)    AS quarterly_rows_count,
    COALESCE(sh.shareholder_count, 0) AS shareholders_count,
    COALESCE(la.fields_present, 0)    AS annual_fields_present,
    COALESCE(dm.derived_fields, 0)    AS derived_fields_count,
    COALESCE(qd.q_doc_count, 0)       AS quarterly_docs_count,
    COALESCE(ad.annual_doc_count, 0)  AS annual_docs_count,
    COALESCE(ev.expose_count, 0)      AS expose_events_count,
    COALESCE(ev.agm_count, 0)         AS agm_events_count,
    ps.latest_price_date,
    an.latest_financial_year

FROM stocks s
LEFT JOIN price_stats        ps   ON ps.ticker   = s.ticker
LEFT JOIN annual_stats       an   ON an.ticker   = s.ticker
LEFT JOIN latest_annual      la   ON la.ticker   = s.ticker
LEFT JOIN quarterly_stats    qs   ON qs.ticker   = s.ticker
LEFT JOIN profile_stats      prof ON prof.ticker  = s.ticker
LEFT JOIN board_stats        bs   ON bs.ticker   = s.ticker
LEFT JOIN shareholder_stats  sh   ON sh.ticker   = s.ticker
LEFT JOIN derived_stats      dm   ON dm.ticker   = s.ticker
LEFT JOIN quarterly_doc_stats qd  ON qd.ticker   = s.ticker
LEFT JOIN annual_doc_stats   ad   ON ad.ticker   = s.ticker
LEFT JOIN event_stats        ev   ON ev.ticker   = s.ticker;
