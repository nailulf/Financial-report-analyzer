-- =============================================================================
-- Schema v21: Add detailed cash flow line items to financials table
--
-- Adds three categories of CF detail:
--   • share_buybacks      — treasury stock repurchases (cash outflow)
--   • debt_issuance       — proceeds from new borrowings (cash inflow)
--   • debt_repayment      — payments to retire debt (cash outflow)
--   • net_change_in_cash  — net period change in cash & equivalents
--
-- All values stored as raw IDR integers. Sign convention matches yfinance:
-- outflows negative, inflows positive.
--
-- Run in Supabase SQL Editor.
-- =============================================================================

ALTER TABLE financials
  ADD COLUMN IF NOT EXISTS share_buybacks     BIGINT,
  ADD COLUMN IF NOT EXISTS debt_issuance      BIGINT,
  ADD COLUMN IF NOT EXISTS debt_repayment     BIGINT,
  ADD COLUMN IF NOT EXISTS net_change_in_cash BIGINT;
