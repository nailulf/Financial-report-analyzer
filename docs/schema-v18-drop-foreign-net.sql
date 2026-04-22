-- =============================================================================
-- schema-v18-drop-foreign-net.sql
-- Remove unreliable IDX API foreign flow columns from daily_prices.
--
-- The IDX GetTradingInfoSS endpoint returns ForeignBuy/ForeignSell in an
-- unknown unit (not IDR, not lots). Values are unreliable: wrong magnitude,
-- wrong direction, and frequently NULL. Foreign flow is now sourced from
-- Stockbit broker_flow (broker_type='Asing') which has confirmed IDR values.
--
-- Depends on: schema.sql, schema-v5-phase3-views.sql, schema-v12-is-ttm.sql
-- =============================================================================


-- =============================================================================
-- 1. Drop views that depend on foreign_net (CASCADE order)
-- =============================================================================

DROP VIEW IF EXISTS v_foreign_flow_summary CASCADE;
DROP VIEW IF EXISTS v_screener CASCADE;
DROP VIEW IF EXISTS v_latest_annual_financials CASCADE;
DROP VIEW IF EXISTS v_latest_prices CASCADE;


-- =============================================================================
-- 2. Drop foreign flow columns from daily_prices
-- =============================================================================

ALTER TABLE daily_prices
  DROP COLUMN IF EXISTS foreign_buy,
  DROP COLUMN IF EXISTS foreign_sell,
  DROP COLUMN IF EXISTS foreign_net;


-- =============================================================================
-- 3. Recreate v_latest_prices WITHOUT foreign_net
-- =============================================================================

CREATE OR REPLACE VIEW v_latest_prices AS
SELECT DISTINCT ON (ticker)
    ticker,
    date,
    close,
    open,
    high,
    low,
    volume,
    value
FROM daily_prices
ORDER BY ticker, date DESC;


-- =============================================================================
-- 4. Recreate v_latest_annual_financials (from schema-v12, unchanged)
-- =============================================================================

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


-- =============================================================================
-- 5. Recreate v_screener WITHOUT latest_foreign_net (from schema-v12)
-- =============================================================================

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
    SELECT close, date
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


-- =============================================================================
-- 6. Update v_flow_score to remove dependency on v_foreign_flow_summary.
--    Foreign score defaults to neutral (25/50) since daily_prices foreign data
--    was unreliable. TODO: compute from broker_flow Asing in a future version.
-- =============================================================================

CREATE OR REPLACE VIEW v_flow_score AS
WITH vol_data AS (
  SELECT
    ticker,
    date,
    volume,
    close,
    ROW_NUMBER() OVER (PARTITION BY ticker ORDER BY date DESC) AS rn
  FROM daily_prices
  WHERE volume IS NOT NULL AND volume > 0
),
latest_price AS (
  SELECT ticker, close AS latest_close, volume AS latest_volume
  FROM vol_data WHERE rn = 1
),
price_5d_ago AS (
  SELECT ticker, close AS close_5d_ago
  FROM vol_data WHERE rn = 6
),
avg_volume AS (
  SELECT
    ticker,
    AVG(volume) AS avg_vol_20d
  FROM vol_data
  WHERE rn BETWEEN 2 AND 21
  GROUP BY ticker
  HAVING COUNT(*) >= 5
),
base AS (
  SELECT
    lp.ticker,
    lp.latest_close,
    lp.latest_volume,
    p5.close_5d_ago,
    av.avg_vol_20d,
    CASE
      WHEN av.avg_vol_20d > 0
        THEN ROUND((lp.latest_volume::numeric / av.avg_vol_20d), 2)
      ELSE NULL
    END AS volume_ratio,
    CASE
      WHEN p5.close_5d_ago > 0
        THEN ROUND(((lp.latest_close - p5.close_5d_ago) / p5.close_5d_ago * 100)::numeric, 2)
      ELSE NULL
    END AS pct_change_5d
  FROM latest_price lp
  LEFT JOIN price_5d_ago p5    USING (ticker)
  LEFT JOIN avg_volume av       USING (ticker)
)
SELECT
  ticker,
  latest_close,
  latest_volume,
  avg_vol_20d,
  volume_ratio,
  pct_change_5d,
  50 AS foreign_percentile,
  25 AS foreign_score,

  ROUND(CASE
    WHEN volume_ratio IS NULL              THEN 12
    WHEN volume_ratio >= 2 AND pct_change_5d > 0 THEN 25
    WHEN volume_ratio >= 2 AND pct_change_5d < 0 THEN 0
    WHEN volume_ratio >= 1.5 AND pct_change_5d > 0 THEN 20
    WHEN volume_ratio >= 1.5 AND pct_change_5d < 0 THEN 5
    WHEN pct_change_5d > 0                THEN 15
    WHEN pct_change_5d < 0                THEN 10
    ELSE 12
  END)::integer AS volume_score,

  ROUND(CASE
    WHEN pct_change_5d IS NULL  THEN 12
    WHEN pct_change_5d > 10     THEN 25
    WHEN pct_change_5d > 5      THEN 20
    WHEN pct_change_5d > 2      THEN 17
    WHEN pct_change_5d > 0      THEN 14
    WHEN pct_change_5d > -2     THEN 11
    WHEN pct_change_5d > -5     THEN 7
    WHEN pct_change_5d > -10    THEN 4
    ELSE 1
  END)::integer AS price_score,

  LEAST(100, GREATEST(0,
    25
    +
    ROUND(CASE
      WHEN volume_ratio IS NULL              THEN 12
      WHEN volume_ratio >= 2 AND pct_change_5d > 0 THEN 25
      WHEN volume_ratio >= 2 AND pct_change_5d < 0 THEN 0
      WHEN volume_ratio >= 1.5 AND pct_change_5d > 0 THEN 20
      WHEN volume_ratio >= 1.5 AND pct_change_5d < 0 THEN 5
      WHEN pct_change_5d > 0                THEN 15
      WHEN pct_change_5d < 0                THEN 10
      ELSE 12
    END)::integer
    +
    ROUND(CASE
      WHEN pct_change_5d IS NULL  THEN 12
      WHEN pct_change_5d > 10     THEN 25
      WHEN pct_change_5d > 5      THEN 20
      WHEN pct_change_5d > 2      THEN 17
      WHEN pct_change_5d > 0      THEN 14
      WHEN pct_change_5d > -2     THEN 11
      WHEN pct_change_5d > -5     THEN 7
      WHEN pct_change_5d > -10    THEN 4
      ELSE 1
    END)::integer
  ))::integer AS flow_score

FROM base;
