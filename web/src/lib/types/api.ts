// Shaped types consumed by components — derived from raw DB types

export interface SearchResult {
  ticker: string
  name: string | null
  sector: string | null
}

export interface ScreenerRow {
  ticker: string
  name: string | null
  sector: string | null
  board: string | null
  is_lq45: boolean
  is_idx30: boolean
  market_cap: number | null      // parsed from string
  price: number | null
  pe_ratio: number | null
  pbv_ratio: number | null
  roe: number | null
  net_margin: number | null
  dividend_yield: number | null
  completeness_score: number | null
  confidence_score: number | null
}

export interface StockHeader {
  ticker: string
  name: string | null
  sector: string | null
  subsector: string | null
  board: string | null
  is_lq45: boolean
  is_idx30: boolean
  market_cap: number | null
  listed_shares: number | null
  status: string
}

export interface StockMetrics {
  price: number | null
  pe_ratio: number | null
  pbv_ratio: number | null
  roe: number | null
  dividend_yield: number | null
  eps: number | null
  book_value_per_share: number | null
  market_cap: number | null
  financial_year: number | null
}

// One row per year for charts and tables
export interface FinancialYear {
  year: number
  revenue: number | null
  gross_profit: number | null
  net_income: number | null
  operating_income: number | null
  gross_margin: number | null
  operating_margin: number | null
  net_margin: number | null
  roe: number | null
  roa: number | null
  current_ratio: number | null
  debt_to_equity: number | null
  operating_cash_flow: number | null
  capex: number | null
  free_cash_flow: number | null
  total_debt: number | null
  cash_and_equivalents: number | null
  total_equity: number | null
  dividends_paid: number | null
}

export interface CAGRResult {
  metric: string
  label: string
  cagr_3yr: number | null
  cagr_5yr: number | null
}

export type HealthStatus = 'green' | 'yellow' | 'red' | 'na'

export interface HealthScore {
  metric: string
  label: string
  value: number | null
  formatted: string
  status: HealthStatus
  description: string
}

export interface PricePoint {
  date: string
  close: number | null
  volume: number | null
  foreign_net: number | null
}

export interface QuarterlyFinancial {
  year: number
  quarter: number
  // Income Statement
  revenue: number | null
  gross_profit: number | null
  net_income: number | null
  eps: number | null
  // Margins
  gross_margin: number | null
  operating_margin: number | null
  net_margin: number | null
  // Returns
  roe: number | null
  roa: number | null
  roce: number | null
  interest_coverage: number | null
  // Balance Sheet
  total_assets: number | null
  total_equity: number | null
  cash_and_equivalents: number | null
  net_debt: number | null
  total_debt: number | null
  working_capital: number | null
  book_value_per_share: number | null
  // Cash Flow
  operating_cash_flow: number | null
  capex: number | null
  free_cash_flow: number | null
  // Solvency
  current_ratio: number | null
  debt_to_equity: number | null
  lt_debt_to_equity: number | null
  financial_leverage: number | null
  debt_to_assets: number | null
}

export interface CompanyProfileData {
  description: string | null
  website: string | null
  address: string | null
  phone: string | null
  email: string | null
}

export interface Officer {
  name: string
  role: string | null
  title: string | null
  is_independent: boolean
}

export interface Shareholder {
  holder_name: string
  holder_type: string | null
  percentage: number | null
  shares_held: number | null
  report_date: string | null   // 'YYYY-MM-DD' snapshot date; null for IDX API source
}

// Raw view row from v_data_completeness
export interface DataCompleteness {
  ticker: string
  completeness_score: number
  price_score: number
  annual_coverage_score: number
  annual_quality_score: number
  quarterly_score: number
  profile_score: number
  board_score: number
  shareholder_score: number
  derived_metrics_score: number
  quarterly_reports_score: number
  annual_reports_score: number
  corporate_events_score: number
  // Raw counts for tooltips
  price_days_count: number
  annual_years_count: number
  quarterly_rows_count: number
  shareholders_count: number
  annual_fields_present: number
  derived_fields_count: number
  quarterly_docs_count: number
  annual_docs_count: number
  expose_events_count: number
  agm_events_count: number
  latest_price_date: string | null
  latest_financial_year: number | null
}

// Shaped breakdown category used in DataQualityPanel
export interface QualityCategory {
  score: number
  max: number
  detail: string
}

export interface SanityCategory extends QualityCategory {
  failed_checks: string[]
}

// Full data quality object consumed by DataQualityPanel
export interface DataQuality {
  ticker: string
  completeness_score: number      // 1–100
  confidence_score: number | null // 0–100, null until Python script has run
  score_version: string
  scores_updated_at: string | null
  last_scraped_at: string | null
  missing_categories: string[]    // category keys with score = 0

  completeness_breakdown: {
    price_history:        QualityCategory
    annual_coverage:      QualityCategory
    annual_quality:       QualityCategory
    quarterly_financials: QualityCategory
    quarterly_reports:    QualityCategory
    annual_reports:       QualityCategory
    company_profile:      QualityCategory
    board_commissioners:  QualityCategory
    shareholders:         QualityCategory
    corporate_events:     QualityCategory
    derived_metrics:      QualityCategory
  }
}

export interface RefreshScraperProgress {
  scraper: string
  status: 'waiting' | 'running' | 'done' | 'failed'
  rows_added: number | null
  duration_ms: number | null
  error_msg: string | null
}

export interface RefreshJob {
  job_id: number
  ticker: string
  status: 'pending' | 'running' | 'done' | 'failed'
  no_new_data: boolean
  completeness_before: number | null
  completeness_after: number | null
  confidence_before: number | null
  confidence_after: number | null
  progress: RefreshScraperProgress[]
  error_message: string | null
  finished_at: string | null
}

// Stockbit-sourced financial row used in preview & upsert
export interface StockbitPreviewRow {
  ticker: string
  year: number
  quarter: number  // 0 = annual, 1–4 = quarterly
  // ── Income Statement (historical + snapshot TTM) ──────────────────────────
  revenue: number | null
  net_income: number | null
  eps: number | null
  gross_profit?: number | null
  operating_income?: number | null
  // ── Balance Sheet (snapshot latest quarter) ───────────────────────────────
  total_assets?: number | null
  total_liabilities?: number | null
  total_equity?: number | null
  total_debt?: number | null
  cash_and_equivalents?: number | null
  working_capital?: number | null
  long_term_debt?: number | null
  short_term_debt?: number | null
  net_debt?: number | null
  book_value_per_share?: number | null
  // ── Cash Flow (snapshot TTM) ──────────────────────────────────────────────
  operating_cash_flow?: number | null
  investing_cash_flow?: number | null
  financing_cash_flow?: number | null
  capex?: number | null
  free_cash_flow?: number | null
  // ── Profitability (snapshot latest quarter) ───────────────────────────────
  gross_margin?: number | null
  operating_margin?: number | null
  net_margin?: number | null
  // ── Management Effectiveness (snapshot TTM) ───────────────────────────────
  roe?: number | null
  roa?: number | null
  roce?: number | null
  roic?: number | null
  asset_turnover?: number | null
  inventory_turnover?: number | null
  interest_coverage?: number | null
  // ── Solvency / Assets & Debts ─────────────────────────────────────────────
  current_ratio?: number | null
  quick_ratio?: number | null
  debt_to_equity?: number | null
  lt_debt_to_equity?: number | null
  total_liabilities_to_equity?: number | null
  debt_to_assets?: number | null
  financial_leverage?: number | null
  // ── Valuation ─────────────────────────────────────────────────────────────
  pe_ratio?: number | null
  pbv_ratio?: number | null
  ps_ratio?: number | null
  ev_ebitda?: number | null
  earnings_yield?: number | null
  // ── Dividend ──────────────────────────────────────────────────────────────
  dividend_yield?: number | null
  payout_ratio?: number | null
}

export interface ScraperJobStatus {
  id: number
  scraper_name: string
  status: 'running' | 'success' | 'partial' | 'failed'
  started_at: string
  finished_at: string | null
  stocks_processed: number
  stocks_failed: number
  error_message: string | null
}

export interface ComparisonStock {
  ticker: string
  name: string | null
  sector: string | null
  price: number | null
  pe_ratio: number | null
  pbv_ratio: number | null
  roe: number | null
  roa: number | null
  net_margin: number | null
  debt_to_equity: number | null
  current_ratio: number | null
  dividend_yield: number | null
  revenue: number | null
  net_income: number | null
  market_cap: number | null
}
