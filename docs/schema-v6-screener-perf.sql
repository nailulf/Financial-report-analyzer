-- =============================================================================
-- Schema v6 — Fix v_screener performance
--
-- Problem: v_screener joins v_latest_prices AND v_latest_annual_financials,
-- which itself also joins v_latest_prices internally. PostgreSQL materialises
-- the expensive DISTINCT ON … ORDER BY ticker, date DESC scan over the entire
-- daily_prices table TWICE per request (~600 k+ rows). Even with the index on
-- (ticker, date DESC) present, the planner chooses a full sequential scan when
-- computing the view for all 800+ stocks, causing statement timeouts on the
-- Supabase free tier.
--
-- Fix: replace the nested-view joins with LATERAL subqueries + LIMIT 1.
-- LATERAL forces the planner to execute one indexed seek per ticker instead of
-- materialising the whole table. The existing indexes are used correctly:
--   • idx_daily_prices_ticker_date  ON daily_prices(ticker, date DESC)
--   • idx_financials_ticker_year    ON financials(ticker, year DESC, quarter DESC)
--
-- v_latest_prices and v_latest_annual_financials are NOT touched — they are
-- still used by the comparison and financials pages (single-ticker queries
-- where they are already fast).
--
-- Apply in Supabase SQL Editor.
-- =============================================================================

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

    -- Latest price — one indexed seek per ticker
    p.close          AS price,
    p.date           AS price_date,
    p.foreign_net    AS latest_foreign_net,

    -- Latest annual financials — one indexed seek per ticker
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
    ORDER BY year DESC
    LIMIT 1
) f ON true

WHERE s.status = 'Active';
