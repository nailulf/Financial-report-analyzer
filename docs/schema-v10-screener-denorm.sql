-- =============================================================================
-- schema-v10-screener-denorm.sql
-- Denormalize screener-critical metrics into the stocks table.
--
-- WHY: v_screener view joins v_latest_prices (DISTINCT ON over entire
--      daily_prices) twice — once directly and once via v_latest_annual_financials.
--      PostgreSQL cannot push WHERE clauses through DISTINCT ON, so every
--      screener query materialises all price history before filtering.
--      This causes statement timeouts on Supabase free tier.
--
-- FIX: Store the 6 screener-critical fields directly on the stocks table.
--      Python scrapers update them during each run.  The screener query
--      reads the stocks table only — no views, no joins, instant results.
--
-- Depends on: schema.sql (stocks table)
-- =============================================================================

-- 1. Add denormalised screener columns to the stocks table
ALTER TABLE stocks ADD COLUMN IF NOT EXISTS current_price    DECIMAL(12,2);
ALTER TABLE stocks ADD COLUMN IF NOT EXISTS price_date       DATE;
ALTER TABLE stocks ADD COLUMN IF NOT EXISTS pe_ratio         DECIMAL(10,4);
ALTER TABLE stocks ADD COLUMN IF NOT EXISTS pbv_ratio        DECIMAL(10,4);
ALTER TABLE stocks ADD COLUMN IF NOT EXISTS roe              DECIMAL(10,4);
ALTER TABLE stocks ADD COLUMN IF NOT EXISTS net_margin       DECIMAL(10,4);
ALTER TABLE stocks ADD COLUMN IF NOT EXISTS dividend_yield   DECIMAL(10,4);

-- 2. Index for default screener sort (market_cap DESC NULLS LAST)
CREATE INDEX IF NOT EXISTS idx_stocks_market_cap ON stocks(market_cap DESC NULLS LAST)
  WHERE status = 'Active';

-- 3. Composite index for filtered screener queries
CREATE INDEX IF NOT EXISTS idx_stocks_screener ON stocks(status, sector, board);

-- 4. Back-fill from existing data (one-time, safe to re-run)
--    Pulls the latest annual financials ratios into stocks.
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
    WHERE quarter = 0
    ORDER BY ticker, year DESC
) sub
WHERE s.ticker = sub.ticker;

--    Pulls the latest closing price into stocks.
UPDATE stocks s
SET
    current_price = sub.close,
    price_date    = sub.date
FROM (
    SELECT DISTINCT ON (ticker)
        ticker, close, date
    FROM daily_prices
    ORDER BY ticker, date DESC
) sub
WHERE s.ticker = sub.ticker;
