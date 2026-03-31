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
--    Consumers: v_screener, getLatestMetrics(), getSubsectorPeers(), getComparisonStocks()
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
WHERE f.quarter = 0
  AND (f.is_ttm IS NOT TRUE)
ORDER BY f.ticker, f.year DESC;

-- 5. Update v_screener (LATERAL version from v6) to exclude TTM
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
--    (Only the annual_stats and latest_annual CTEs need updating)
CREATE OR REPLACE VIEW v_data_completeness AS
WITH
price_stats AS (
    SELECT
        ticker,
        COUNT(*)                                                                                         AS price_days,
        MAX(date)                                                                                        AS latest_price_date,
        SUM(CASE WHEN date >= CURRENT_DATE - INTERVAL '30 days' AND foreign_net IS NOT NULL THEN 1 ELSE 0 END) AS recent_foreign_days
    FROM daily_prices
    GROUP BY ticker
),
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
      AND (is_ttm IS NOT TRUE)
    ORDER BY ticker, year DESC
),
quarterly_stats AS (
    SELECT
        ticker,
        COUNT(*) AS quarterly_rows
    FROM financials
    WHERE quarter > 0
    GROUP BY ticker
),
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
broker_stats AS (
    SELECT
        ticker,
        COUNT(DISTINCT date) AS broker_days
    FROM broker_summary
    GROUP BY ticker
)
SELECT
    s.ticker,
    s.name,
    s.status,
    COALESCE(ps.price_days, 0)                AS price_days,
    ps.latest_price_date,
    COALESCE(ps.recent_foreign_days, 0)       AS recent_foreign_days,
    COALESCE(ans.annual_years, 0)             AS annual_years,
    ans.latest_financial_year,
    COALESCE(la.fields_present, 0)            AS latest_annual_fields,
    COALESCE(qs.quarterly_rows, 0)            AS quarterly_rows,
    COALESCE(prs.profile_pts, 0)              AS profile_pts,
    COALESCE(prs.shareholder_pts, 0)          AS shareholder_pts,
    COALESCE(bs.broker_days, 0)               AS broker_days,
    -- Composite score (max 100)
    LEAST(100,
        -- Price data (max 20)
        LEAST(20, COALESCE(ps.price_days, 0) / 50.0 * 15
            + CASE WHEN ps.latest_price_date >= CURRENT_DATE - INTERVAL '7 days' THEN 5 ELSE 0 END)
        -- Annual financials (max 30)
      + LEAST(30, COALESCE(ans.annual_years, 0) * 3
            + COALESCE(la.fields_present, 0) * 1.5)
        -- Quarterly data (max 15)
      + LEAST(15, COALESCE(qs.quarterly_rows, 0) * 1.5)
        -- Profile & shareholders (max 10)
      + COALESCE(prs.profile_pts, 0) + COALESCE(prs.shareholder_pts, 0)
        -- Foreign flow (max 10)
      + LEAST(10, COALESCE(ps.recent_foreign_days, 0) * 0.5)
        -- Broker summary (max 15)
      + LEAST(15, COALESCE(bs.broker_days, 0) * 0.5)
    )                                         AS completeness_score
FROM stocks s
LEFT JOIN price_stats ps    ON ps.ticker = s.ticker
LEFT JOIN annual_stats ans  ON ans.ticker = s.ticker
LEFT JOIN latest_annual la  ON la.ticker = s.ticker
LEFT JOIN quarterly_stats qs ON qs.ticker = s.ticker
LEFT JOIN profile_stats prs ON prs.ticker = s.ticker
LEFT JOIN broker_stats bs   ON bs.ticker = s.ticker;

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
