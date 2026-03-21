// Raw database row types — column names and types match the schema exactly.
// NOTE: PostgreSQL BIGINT columns are returned as strings by @supabase/supabase-js
// to avoid JS 53-bit integer precision loss. Always parse with Number() before math.

export interface Stock {
  ticker: string
  name: string | null
  sector: string | null
  subsector: string | null
  listing_date: string | null
  listed_shares: string | null   // BIGINT → string
  market_cap: string | null      // BIGINT → string
  board: string | null
  is_lq45: boolean
  is_idx30: boolean
  status: string
  last_updated: string
}

export interface DailyPrice {
  id: string
  ticker: string
  date: string
  open: number | null
  high: number | null
  low: number | null
  close: number | null
  volume: string | null          // BIGINT → string
  value: string | null           // BIGINT → string
  frequency: number | null
  foreign_buy: string | null     // BIGINT → string
  foreign_sell: string | null    // BIGINT → string
  foreign_net: string | null     // BIGINT → string
  last_updated: string
}

export interface Financials {
  id: number
  ticker: string
  year: number
  quarter: number                // 0 = annual, 1–4 = quarterly
  period_end: string | null
  // Income Statement
  revenue: string | null         // BIGINT → string
  cost_of_revenue: string | null
  gross_profit: string | null
  operating_expense: string | null
  operating_income: string | null
  interest_expense: string | null
  income_before_tax: string | null
  tax_expense: string | null
  net_income: string | null
  eps: number | null
  // Balance Sheet
  total_assets: string | null
  current_assets: string | null
  total_liabilities: string | null
  current_liabilities: string | null
  total_equity: string | null
  total_debt: string | null
  cash_and_equivalents: string | null
  book_value_per_share: number | null
  // Cash Flow
  operating_cash_flow: string | null
  capex: string | null
  free_cash_flow: string | null
  dividends_paid: string | null
  // Ratios (stored as plain numbers, e.g. 15.5 means 15.5%)
  gross_margin: number | null
  operating_margin: number | null
  net_margin: number | null
  roe: number | null
  roa: number | null
  current_ratio: number | null
  debt_to_equity: number | null
  pe_ratio: number | null
  pbv_ratio: number | null
  dividend_yield: number | null
  payout_ratio: number | null
  source: string
  last_updated: string
}

export interface CompanyProfile {
  ticker: string
  description: string | null
  website: string | null
  address: string | null
  phone: string | null
  email: string | null
  npwp: string | null
  listing_date: string | null
  registry_agency: string | null
  last_updated: string
}

export interface CompanyOfficer {
  id: number
  ticker: string
  name: string
  role: string | null
  title: string | null
  is_independent: boolean
  last_updated: string
}

export interface Shareholder {
  id: number
  ticker: string
  holder_name: string
  holder_type: string | null
  shares_held: string | null     // BIGINT → string
  percentage: number | null
  snapshot_date: string | null
  last_updated: string
}

export interface BrokerSummary {
  id: string
  ticker: string
  date: string
  broker_code: string
  broker_name: string | null
  buy_volume: string | null      // BIGINT → string (total, not buy-only)
  buy_value: string | null       // BIGINT → string (total, not buy-only)
  sell_volume: string | null     // always NULL from IDX API
  sell_value: string | null      // always NULL from IDX API
  net_volume: string | null      // always NULL from IDX API
  net_value: string | null       // always NULL from IDX API
  frequency: number | null
  last_updated: string
}

export interface ScraperRun {
  id: number
  scraper_name: string
  started_at: string
  finished_at: string | null
  stocks_processed: number
  stocks_failed: number
  stocks_skipped: number
  status: 'running' | 'success' | 'partial' | 'failed'
  error_message: string | null
  metadata: Record<string, unknown> | null
}

export interface VDataCompleteness {
  ticker: string
  // Component scores
  price_score: number
  annual_coverage_score: number
  annual_quality_score: number
  quarterly_score: number
  profile_score: number
  foreign_flow_score: number
  broker_score: number
  // Total
  completeness_score: number
  // Raw stats
  price_days_count: number
  annual_years_count: number
  quarterly_rows_count: number
  latest_price_date: string | null
  latest_financial_year: number | null
}

// ---- View row types ----

export interface VLatestPrice {
  ticker: string
  date: string
  close: number | null
  open: number | null
  high: number | null
  low: number | null
  volume: string | null
  value: string | null
  foreign_net: string | null
}

export interface VLatestAnnualFinancials extends Financials {
  name: string | null
  sector: string | null
  subsector: string | null
  market_cap: string | null
  listed_shares: string | null
  current_price: number | null
}

export interface VScreenerRow {
  ticker: string
  name: string | null
  sector: string | null
  subsector: string | null
  board: string | null
  is_lq45: boolean
  is_idx30: boolean
  market_cap: string | null
  listed_shares: string | null
  status: string
  price: number | null
  price_date: string | null
  latest_foreign_net: string | null
  financial_year: number | null
  revenue: string | null
  gross_profit: string | null
  operating_income: string | null
  net_income: string | null
  total_assets: string | null
  total_equity: string | null
  total_debt: string | null
  cash_and_equivalents: string | null
  operating_cash_flow: string | null
  free_cash_flow: string | null
  dividends_paid: string | null
  eps: number | null
  book_value_per_share: number | null
  gross_margin: number | null
  operating_margin: number | null
  net_margin: number | null
  roe: number | null
  roa: number | null
  current_ratio: number | null
  debt_to_equity: number | null
  pe_ratio: number | null
  pbv_ratio: number | null
  dividend_yield: number | null
  payout_ratio: number | null
}
