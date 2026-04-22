-- schema-v20-cashflow-cagr.sql
-- Add Operating Cash Flow CAGR columns to stocks table for screener filtering.
-- Backfilled from normalized_metrics (same pattern as revenue CAGR in v16).

ALTER TABLE stocks
  ADD COLUMN IF NOT EXISTS ocf_cagr_3yr DECIMAL(10,4),
  ADD COLUMN IF NOT EXISTS ocf_cagr_5yr DECIMAL(10,4);

-- Backfill from normalized_metrics (values stored as decimals, e.g. 0.12 = 12%)
UPDATE stocks s
SET ocf_cagr_3yr = nm.cagr_3yr * 100,
    ocf_cagr_5yr = nm.cagr_5yr * 100
FROM normalized_metrics nm
WHERE nm.ticker = s.ticker AND nm.metric_name = 'operating_cash_flow';
