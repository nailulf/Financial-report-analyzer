-- =============================================================================
-- Schema v2 Migration — Data Completeness & Confidence Score (Phase 1)
-- Apply in Supabase SQL Editor after the original schema.sql
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Add score columns to stocks table
-- -----------------------------------------------------------------------------

ALTER TABLE stocks
    ADD COLUMN IF NOT EXISTS completeness_score  INTEGER,
    ADD COLUMN IF NOT EXISTS confidence_score    INTEGER,
    ADD COLUMN IF NOT EXISTS score_version       TEXT DEFAULT 'v1',
    ADD COLUMN IF NOT EXISTS scores_updated_at   TIMESTAMPTZ;

-- -----------------------------------------------------------------------------
-- 2. Replace v_data_completeness with updated weights and new categories
--
-- Weight breakdown (Phase 1 — max achievable: 80/100):
--   Price History            15 pts  (price_days / 1250)
--   Annual Coverage          12 pts  (annual_years / 5)
--   Annual Quality           10 pts  (7 core fields present)
--   Quarterly Financials     10 pts  (quarterly_rows / 8)
--   Company Profile           7 pts  (description+website+address+phone+email)
--   Board & Commissioners     8 pts  (directors present + commissioners present)
--   Shareholders ≥1%          8 pts  (count ≥ 3, snapshot freshness)
--   Derived Metrics          10 pts  (10 ratio fields non-null)
--   Quarterly Report PDFs     0 pts  (Phase 2 — company_documents table)
--   Annual Report PDFs        0 pts  (Phase 2)
--   Corporate Events          0 pts  (Phase 2 — corporate_events table)
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
        (CASE WHEN revenue             IS NOT NULL THEN 1 ELSE 0 END
       + CASE WHEN net_income          IS NOT NULL THEN 1 ELSE 0 END
       + CASE WHEN total_assets        IS NOT NULL THEN 1 ELSE 0 END
       + CASE WHEN total_equity        IS NOT NULL THEN 1 ELSE 0 END
       + CASE WHEN operating_cash_flow IS NOT NULL THEN 1 ELSE 0 END
       + CASE WHEN free_cash_flow      IS NOT NULL THEN 1 ELSE 0 END
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
        COUNT(*)         AS shareholder_count,
        MAX(snapshot_date) AS latest_snapshot
    FROM shareholders
    WHERE percentage >= 1.0
    GROUP BY ticker
),

-- 8. Derived ratio fields on latest annual row (10 fields × 1 pt each)
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
)

SELECT
    s.ticker,

    -- -------------------------------------------------------------------------
    -- Component scores (for breakdown display)
    -- -------------------------------------------------------------------------
    ROUND(LEAST(COALESCE(ps.price_days, 0)        / 1250.0, 1.0) * 15)::INTEGER  AS price_score,
    ROUND(LEAST(COALESCE(an.annual_years, 0)       / 5.0,   1.0) * 12)::INTEGER  AS annual_coverage_score,
    ROUND(COALESCE(la.fields_present, 0)           / 7.0    * 10)::INTEGER       AS annual_quality_score,
    ROUND(LEAST(COALESCE(qs.quarterly_rows, 0)     / 8.0,   1.0) * 10)::INTEGER  AS quarterly_score,
    COALESCE(prof.profile_pts, 0)                                                 AS profile_score,
    COALESCE(bs.board_pts, 0)                                                     AS board_score,

    -- Shareholders: 5 pts for ≥3, 2 pts for ≥1, + 3 pts if snapshot < 180 days
    (CASE WHEN COALESCE(sh.shareholder_count, 0) >= 3 THEN 5
          WHEN COALESCE(sh.shareholder_count, 0) >= 1 THEN 2
          ELSE 0 END
   + CASE WHEN sh.latest_snapshot IS NOT NULL
               AND sh.latest_snapshot >= CURRENT_DATE - INTERVAL '180 days' THEN 3
          ELSE 0 END)                                                              AS shareholder_score,

    COALESCE(dm.derived_fields, 0)                                                AS derived_metrics_score,

    -- Phase 2 placeholders (always 0 until tables + scrapers are built)
    0                                                                             AS quarterly_reports_score,
    0                                                                             AS annual_reports_score,
    0                                                                             AS corporate_events_score,

    -- -------------------------------------------------------------------------
    -- Total completeness score (1–100)
    -- Phase 1 max achievable: 80 pts (20 reserved for Phase 2 categories)
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
    ))                                                                            AS completeness_score,

    -- -------------------------------------------------------------------------
    -- Raw counts (used for detail tooltips)
    -- -------------------------------------------------------------------------
    COALESCE(ps.price_days, 0)       AS price_days_count,
    COALESCE(an.annual_years, 0)     AS annual_years_count,
    COALESCE(qs.quarterly_rows, 0)   AS quarterly_rows_count,
    COALESCE(sh.shareholder_count,0) AS shareholders_count,
    COALESCE(la.fields_present, 0)   AS annual_fields_present,
    COALESCE(dm.derived_fields, 0)   AS derived_fields_count,
    ps.latest_price_date,
    an.latest_financial_year

FROM stocks s
LEFT JOIN price_stats       ps   ON ps.ticker   = s.ticker
LEFT JOIN annual_stats      an   ON an.ticker   = s.ticker
LEFT JOIN latest_annual     la   ON la.ticker   = s.ticker
LEFT JOIN quarterly_stats   qs   ON qs.ticker   = s.ticker
LEFT JOIN profile_stats     prof ON prof.ticker  = s.ticker
LEFT JOIN board_stats       bs   ON bs.ticker   = s.ticker
LEFT JOIN shareholder_stats sh   ON sh.ticker   = s.ticker
LEFT JOIN derived_stats     dm   ON dm.ticker   = s.ticker;
