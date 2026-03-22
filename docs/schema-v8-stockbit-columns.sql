-- =============================================================================
-- Schema v8: Add Stockbit-sourced financial columns to financials table
-- Run in Supabase SQL Editor (Dashboard → SQL Editor → New query)
-- =============================================================================

-- ── New ratio columns ─────────────────────────────────────────────────────────
ALTER TABLE financials
  ADD COLUMN IF NOT EXISTS roce                   DECIMAL(20, 4),  -- Return on Capital Employed %
  ADD COLUMN IF NOT EXISTS roic                   DECIMAL(20, 4),  -- Return on Invested Capital %
  ADD COLUMN IF NOT EXISTS interest_coverage      DECIMAL(20, 4),  -- EBIT / Interest Expense (x)
  ADD COLUMN IF NOT EXISTS asset_turnover         DECIMAL(20, 4),  -- Revenue / Total Assets (x)
  ADD COLUMN IF NOT EXISTS inventory_turnover     DECIMAL(20, 4),  -- COGS / Inventory (x)
  ADD COLUMN IF NOT EXISTS lt_debt_to_equity      DECIMAL(20, 4),  -- LT Debt / Equity
  ADD COLUMN IF NOT EXISTS total_liabilities_to_equity DECIMAL(20, 4),
  ADD COLUMN IF NOT EXISTS debt_to_assets         DECIMAL(20, 4),  -- Total Debt / Total Assets
  ADD COLUMN IF NOT EXISTS financial_leverage     DECIMAL(20, 4),  -- Total Assets / Equity (x)
  ADD COLUMN IF NOT EXISTS ps_ratio               DECIMAL(20, 4),  -- Price / Sales
  ADD COLUMN IF NOT EXISTS ev_ebitda              DECIMAL(20, 4),  -- EV / EBITDA
  ADD COLUMN IF NOT EXISTS earnings_yield         DECIMAL(20, 4);  -- EPS / Price %

-- ── New balance sheet columns ─────────────────────────────────────────────────
ALTER TABLE financials
  ADD COLUMN IF NOT EXISTS net_debt               BIGINT,          -- Total Debt - Cash
  ADD COLUMN IF NOT EXISTS working_capital        BIGINT,          -- Current Assets - Current Liabilities
  ADD COLUMN IF NOT EXISTS short_term_debt        BIGINT,
  ADD COLUMN IF NOT EXISTS long_term_debt         BIGINT;

-- ── New cash flow columns ─────────────────────────────────────────────────────
ALTER TABLE financials
  ADD COLUMN IF NOT EXISTS investing_cash_flow    BIGINT,
  ADD COLUMN IF NOT EXISTS financing_cash_flow    BIGINT;
