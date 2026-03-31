-- =============================================================================
-- Migration v12: Add is_ttm column to financials table
-- =============================================================================
-- Problem: Stockbit keystats scraper stores TTM (trailing twelve months)
-- estimates as year=current_year, quarter=0 — indistinguishable from real
-- published annual reports. This misleads screener, AI analyst, and charts.
--
-- Fix: Add is_ttm BOOLEAN column to explicitly flag TTM estimate rows.
-- Views updated to exclude TTM by default.
--
-- Apply in Supabase SQL Editor.
-- =============================================================================

-- 1. Add column (default FALSE = all existing rows are non-TTM by default)
ALTER TABLE financials ADD COLUMN IF NOT EXISTS is_ttm BOOLEAN DEFAULT FALSE;

-- 2. Backfill: mark existing keystats current-year annual rows as TTM
UPDATE financials
SET is_ttm = TRUE
WHERE quarter = 0
  AND year >= EXTRACT(YEAR FROM CURRENT_DATE)
  AND source ILIKE '%keystats%';

-- 3. Partial index for quick TTM lookups
CREATE INDEX IF NOT EXISTS idx_financials_is_ttm
  ON financials(ticker, year DESC)
  WHERE is_ttm = TRUE;

-- 4. Update v_latest_annual_financials to exclude TTM
--    Adding is_ttm column to financials changed the f.* expansion, so
--    CREATE OR REPLACE fails (column position shift). Must DROP first.
--    v_screener depends on this view (base schema), so drop it first.
DROP VIEW IF EXISTS v_screener;
DROP VIEW IF EXISTS v_latest_annual_financials;

CREATE VIEW v_latest_annual_financials AS
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
WHERE f.quarter = 0
  AND (f.is_ttm IS NOT TRUE)
ORDER BY f.ticker, f.year DESC;

-- 5. Recreate v_screener (LATERAL version from v6) excluding TTM
CREATE VIEW v_screener AS
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
    p.close          AS price,
    p.date           AS price_date,
    p.foreign_net    AS latest_foreign_net,

    -- Latest annual financials (excluding TTM)
    f.year           AS financial_year,
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

LEFT JOIN LATERAL (
    SELECT close, date, foreign_net
    FROM daily_prices
    WHERE ticker = s.ticker
    ORDER BY date DESC
    LIMIT 1
) p ON true

LEFT JOIN LATERAL (
    SELECT
        year, revenue, gross_profit, operating_income, net_income,
        total_assets, total_equity, total_debt, cash_and_equivalents,
        operating_cash_flow, free_cash_flow, dividends_paid, eps, book_value_per_share,
        gross_margin, operating_margin, net_margin, roe, roa,
        current_ratio, debt_to_equity, pe_ratio, pbv_ratio, dividend_yield, payout_ratio
    FROM financials
    WHERE ticker = s.ticker
      AND quarter = 0
      AND (is_ttm IS NOT TRUE)
    ORDER BY year DESC
    LIMIT 1
) f ON true

WHERE s.status = 'Active';

-- 6. Update v_data_completeness CTEs to exclude TTM
--    Must DROP first because column layout differs from CREATE OR REPLACE.
--    No other views depend on v_data_completeness.
DROP VIEW IF EXISTS v_data_completeness;

CREATE VIEW v_data_completeness AS
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

-- 2. Annual financials coverage (exclude TTM)
annual_stats AS (
    SELECT
        ticker,
        COUNT(DISTINCT year) AS annual_years,
        MAX(year)            AS latest_financial_year
    FROM financials
    WHERE quarter = 0
      AND (is_ttm IS NOT TRUE)
    GROUP BY ticker
),

-- 3. Core field quality on latest annual row — 7 fields (exclude TTM)
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
      AND (is_ttm IS NOT TRUE)
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

-- 7. Shareholders >=1% — presence (5 pts) + snapshot freshness (3 pts)
shareholder_stats AS (
    SELECT
        ticker,
        COUNT(*)           AS shareholder_count,
        MAX(snapshot_date) AS latest_snapshot
    FROM shareholders
    WHERE percentage >= 1.0
    GROUP BY ticker
),

-- 8. Derived ratio fields on latest annual row — 10 fields x 1 pt (exclude TTM)
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
      AND (is_ttm IS NOT TRUE)
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
      AND (period_year * 10 + period_quarter) >= (
            (EXTRACT(YEAR FROM CURRENT_DATE)::INTEGER - 1) * 10 + 1
          )
    GROUP BY ticker
),

-- 10. Annual report PDFs (max 5 pts: >=2 = 5, >=1 = 3, 0 = 0)
annual_doc_stats AS (
    SELECT
        ticker,
        COUNT(*) AS annual_doc_count
    FROM company_documents
    WHERE doc_type = 'annual_report'
    GROUP BY ticker
),

-- 11. Corporate events (max 7 pts: public_expose=4, agm/egm=3)
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

    -- Component scores
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

    LEAST(ROUND(COALESCE(qd.q_doc_count, 0) / 4.0 * 8)::INTEGER, 8)             AS quarterly_reports_score,

    CASE WHEN COALESCE(ad.annual_doc_count, 0) >= 2 THEN 5
         WHEN COALESCE(ad.annual_doc_count, 0) = 1  THEN 3
         ELSE 0 END                                                               AS annual_reports_score,

    (CASE WHEN COALESCE(ev.expose_count, 0) >= 1 THEN 4 ELSE 0 END
   + CASE WHEN COALESCE(ev.agm_count,    0) >= 1 THEN 3 ELSE 0 END)             AS corporate_events_score,

    -- Total completeness score (1-100, Phase 2 max: 100)
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

    -- Raw counts (for tooltip details)
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

-- 7. Re-run stocks denormalization from real annual data (exclude TTM)
UPDATE stocks s
SET
    pe_ratio       = sub.pe_ratio,
    pbv_ratio      = sub.pbv_ratio,
    roe            = sub.roe,
    net_margin     = sub.net_margin,
    dividend_yield = sub.dividend_yield
FROM (
    SELECT DISTINCT ON (ticker)
        ticker, pe_ratio, pbv_ratio, roe, net_margin, dividend_yield
    FROM financials
    WHERE quarter = 0 AND (is_ttm IS NOT TRUE)
    ORDER BY ticker, year DESC
) sub
WHERE s.ticker = sub.ticker;
