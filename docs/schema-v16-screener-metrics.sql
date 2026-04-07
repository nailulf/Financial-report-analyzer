-- schema-v16-screener-metrics.sql
-- Add Revenue CAGR, Price CAGR, and Dividend Yield Average columns to stocks table.

ALTER TABLE stocks
  ADD COLUMN IF NOT EXISTS revenue_cagr_3yr DECIMAL(10,4),
  ADD COLUMN IF NOT EXISTS revenue_cagr_5yr DECIMAL(10,4),
  ADD COLUMN IF NOT EXISTS price_cagr_3yr   DECIMAL(10,4),
  ADD COLUMN IF NOT EXISTS price_cagr_5yr   DECIMAL(10,4),
  ADD COLUMN IF NOT EXISTS div_yield_avg_3yr DECIMAL(10,4),
  ADD COLUMN IF NOT EXISTS div_yield_avg_5yr DECIMAL(10,4);

-- 1. Backfill Revenue CAGR from normalized_metrics (values stored as decimals, e.g. 0.12 = 12%)
UPDATE stocks s
SET revenue_cagr_3yr = nm.cagr_3yr * 100,
    revenue_cagr_5yr = nm.cagr_5yr * 100
FROM normalized_metrics nm
WHERE nm.ticker = s.ticker AND nm.metric_name = 'revenue';

-- 2. Backfill Price CAGR from daily_prices
--    Uses most recent close vs close ~3/5 years ago.
WITH price_endpoints AS (
  SELECT
    s.ticker,
    s.current_price,
    (SELECT dp.close FROM daily_prices dp
     WHERE dp.ticker = s.ticker
       AND dp.date <= CURRENT_DATE - INTERVAL '3 years'
     ORDER BY dp.date DESC LIMIT 1) AS price_3yr_ago,
    (SELECT dp.close FROM daily_prices dp
     WHERE dp.ticker = s.ticker
       AND dp.date <= CURRENT_DATE - INTERVAL '5 years'
     ORDER BY dp.date DESC LIMIT 1) AS price_5yr_ago
  FROM stocks s
  WHERE s.current_price IS NOT NULL AND s.current_price > 0
)
UPDATE stocks s
SET price_cagr_3yr = CASE
      WHEN pe.price_3yr_ago > 0 THEN
        (POWER(pe.current_price / pe.price_3yr_ago, 1.0 / 3) - 1) * 100
      END,
    price_cagr_5yr = CASE
      WHEN pe.price_5yr_ago > 0 THEN
        (POWER(pe.current_price / pe.price_5yr_ago, 1.0 / 5) - 1) * 100
      END
FROM price_endpoints pe
WHERE pe.ticker = s.ticker;

-- 3. Backfill Dividend Yield Average from financials (annual = quarter 0)
WITH div_avgs AS (
  SELECT
    ticker,
    AVG(CASE WHEN year >= EXTRACT(YEAR FROM CURRENT_DATE) - 3 THEN dividend_yield END) AS avg_3yr,
    AVG(CASE WHEN year >= EXTRACT(YEAR FROM CURRENT_DATE) - 5 THEN dividend_yield END) AS avg_5yr
  FROM financials
  WHERE quarter = 0
    AND dividend_yield IS NOT NULL
    AND dividend_yield > 0
  GROUP BY ticker
)
UPDATE stocks s
SET div_yield_avg_3yr = da.avg_3yr,
    div_yield_avg_5yr = da.avg_5yr
FROM div_avgs da
WHERE da.ticker = s.ticker;
