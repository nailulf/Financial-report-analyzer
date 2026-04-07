import { createClient } from '@/lib/supabase/server'
import { PAGE_SIZE } from '@/lib/constants'
import { parseBigInt } from '@/lib/calculations/formatters'
import type { ScreenerRow, SearchResult, StockHeader } from '@/lib/types/api'

const VALID_SORT_COLS = ['ticker', 'market_cap', 'current_price', 'pe_ratio', 'pbv_ratio', 'roe', 'net_margin', 'dividend_yield'] as const
type SortCol = typeof VALID_SORT_COLS[number]

export interface ScreenerFilters {
  sector?: string
  board?: string
  phase?: string
  minRoe?: number
  maxPe?: number
  maxPbv?: number
  minNetMargin?: number
  minDivYield?: number
  minDivAvg3yr?: number
  minDivAvg5yr?: number
  minRevCagr3yr?: number
  minRevCagr5yr?: number
  minPriceCagr3yr?: number
  minPriceCagr5yr?: number
  minMktCap?: number
  minCompleteness?: number
  minConfidence?: number
  sortBy?: string
  sortDir?: 'asc' | 'desc'
}

// Map legacy "price" sort param → denormalized column name
function resolveSortCol(raw?: string): SortCol {
  if (raw === 'price') return 'current_price'
  if (VALID_SORT_COLS.includes(raw as SortCol)) return raw as SortCol
  return 'market_cap'
}

export async function getScreenerRows(
  filters: ScreenerFilters = {},
  page = 1,
): Promise<{ rows: ScreenerRow[]; total: number }> {
  const supabase = await createClient()
  const offset = (page - 1) * PAGE_SIZE

  const sortCol = resolveSortCol(filters.sortBy)
  const ascending = filters.sortDir === 'asc'

  // ── Both data and count now query the stocks table directly ──
  // All screener metrics are denormalized onto stocks (see schema-v10).
  // No views, no joins — just a simple indexed table scan.

  const SCREENER_COLS = 'ticker, name, sector, subsector, board, is_lq45, is_idx30, listing_date, listed_shares, market_cap, current_price, pe_ratio, pbv_ratio, roe, net_margin, dividend_yield, current_phase, current_phase_clarity, current_phase_days, revenue_cagr_3yr, revenue_cagr_5yr, price_cagr_3yr, price_cagr_5yr, div_yield_avg_3yr, div_yield_avg_5yr, completeness_score, confidence_score'

  let dataQuery = supabase
    .from('stocks')
    .select(SCREENER_COLS)
    .eq('status', 'Active')
    .order(sortCol, { ascending, nullsFirst: false })
    .range(offset, offset + PAGE_SIZE - 1)

  let countQuery = supabase
    .from('stocks')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'Active')

  // Apply filters to both queries
  if (filters.sector) {
    dataQuery = dataQuery.eq('sector', filters.sector)
    countQuery = countQuery.eq('sector', filters.sector)
  }
  if (filters.board) {
    dataQuery = dataQuery.eq('board', filters.board)
    countQuery = countQuery.eq('board', filters.board)
  }
  if (filters.phase) {
    dataQuery = dataQuery.eq('current_phase', filters.phase)
    countQuery = countQuery.eq('current_phase', filters.phase)
  }
  if (filters.minRoe != null) {
    dataQuery = dataQuery.gte('roe', filters.minRoe)
    countQuery = countQuery.gte('roe', filters.minRoe)
  }
  if (filters.maxPe != null) {
    dataQuery = dataQuery.lte('pe_ratio', filters.maxPe)
    countQuery = countQuery.lte('pe_ratio', filters.maxPe)
  }
  if (filters.maxPbv != null) {
    dataQuery = dataQuery.lte('pbv_ratio', filters.maxPbv)
    countQuery = countQuery.lte('pbv_ratio', filters.maxPbv)
  }
  if (filters.minNetMargin != null) {
    dataQuery = dataQuery.gte('net_margin', filters.minNetMargin)
    countQuery = countQuery.gte('net_margin', filters.minNetMargin)
  }
  if (filters.minDivYield != null) {
    dataQuery = dataQuery.gte('dividend_yield', filters.minDivYield)
    countQuery = countQuery.gte('dividend_yield', filters.minDivYield)
  }
  if (filters.minDivAvg3yr != null) {
    dataQuery = dataQuery.gte('div_yield_avg_3yr', filters.minDivAvg3yr)
    countQuery = countQuery.gte('div_yield_avg_3yr', filters.minDivAvg3yr)
  }
  if (filters.minDivAvg5yr != null) {
    dataQuery = dataQuery.gte('div_yield_avg_5yr', filters.minDivAvg5yr)
    countQuery = countQuery.gte('div_yield_avg_5yr', filters.minDivAvg5yr)
  }
  if (filters.minRevCagr3yr != null) {
    dataQuery = dataQuery.gte('revenue_cagr_3yr', filters.minRevCagr3yr)
    countQuery = countQuery.gte('revenue_cagr_3yr', filters.minRevCagr3yr)
  }
  if (filters.minRevCagr5yr != null) {
    dataQuery = dataQuery.gte('revenue_cagr_5yr', filters.minRevCagr5yr)
    countQuery = countQuery.gte('revenue_cagr_5yr', filters.minRevCagr5yr)
  }
  if (filters.minPriceCagr3yr != null) {
    dataQuery = dataQuery.gte('price_cagr_3yr', filters.minPriceCagr3yr)
    countQuery = countQuery.gte('price_cagr_3yr', filters.minPriceCagr3yr)
  }
  if (filters.minPriceCagr5yr != null) {
    dataQuery = dataQuery.gte('price_cagr_5yr', filters.minPriceCagr5yr)
    countQuery = countQuery.gte('price_cagr_5yr', filters.minPriceCagr5yr)
  }
  if (filters.minMktCap != null) {
    // Input is in triliun (T), DB stores raw IDR
    dataQuery = dataQuery.gte('market_cap', filters.minMktCap * 1_000_000_000_000)
    countQuery = countQuery.gte('market_cap', filters.minMktCap * 1_000_000_000_000)
  }
  if (filters.minCompleteness != null) {
    dataQuery = dataQuery.gte('completeness_score', filters.minCompleteness)
    countQuery = countQuery.gte('completeness_score', filters.minCompleteness)
  }
  if (filters.minConfidence != null) {
    dataQuery = dataQuery.gte('confidence_score', filters.minConfidence)
    countQuery = countQuery.gte('confidence_score', filters.minConfidence)
  }

  const [{ data, error }, { count, error: countError }] = await Promise.all([dataQuery, countQuery])

  if (error) {
    console.error('[getScreenerRows] stocks query failed:', error.message, error.details)
    return { rows: [], total: 0 }
  }
  if (countError) {
    console.warn('[getScreenerRows] count query failed:', countError.message)
  }

  type StocksRow = {
    ticker: string
    name: string | null
    sector: string | null
    subsector: string | null
    board: string | null
    is_lq45: boolean
    is_idx30: boolean
    listing_date: string | null
    listed_shares: string | null
    market_cap: string | null
    current_price: number | null
    pe_ratio: number | null
    pbv_ratio: number | null
    roe: number | null
    net_margin: number | null
    dividend_yield: number | null
    current_phase: string | null
    current_phase_clarity: number | null
    current_phase_days: number | null
    revenue_cagr_3yr: number | null
    revenue_cagr_5yr: number | null
    price_cagr_3yr: number | null
    price_cagr_5yr: number | null
    div_yield_avg_3yr: number | null
    div_yield_avg_5yr: number | null
    completeness_score: number | null
    confidence_score: number | null
  }

  const rows: ScreenerRow[] = ((data ?? []) as StocksRow[]).map((r) => ({
    ticker: r.ticker,
    name: r.name,
    sector: r.sector,
    subsector: r.subsector,
    board: r.board,
    is_lq45: r.is_lq45,
    is_idx30: r.is_idx30,
    listing_date: r.listing_date,
    listed_shares: parseBigInt(r.listed_shares),
    market_cap: parseBigInt(r.market_cap),
    price: r.current_price,
    pe_ratio: r.pe_ratio,
    pbv_ratio: r.pbv_ratio,
    roe: r.roe,
    net_margin: r.net_margin,
    dividend_yield: r.dividend_yield,
    current_phase: r.current_phase as ScreenerRow['current_phase'],
    current_phase_clarity: r.current_phase_clarity ?? null,
    current_phase_days: r.current_phase_days ?? null,
    revenue_cagr_3yr: r.revenue_cagr_3yr,
    revenue_cagr_5yr: r.revenue_cagr_5yr,
    price_cagr_3yr: r.price_cagr_3yr,
    price_cagr_5yr: r.price_cagr_5yr,
    div_yield_avg_3yr: r.div_yield_avg_3yr,
    div_yield_avg_5yr: r.div_yield_avg_5yr,
    completeness_score: r.completeness_score ?? null,
    confidence_score: r.confidence_score ?? null,
  }))

  return { rows, total: count ?? rows.length }
}

export async function searchStocks(q: string): Promise<SearchResult[]> {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('stocks')
    .select('ticker, name, sector')
    .or(`ticker.ilike.%${q}%,name.ilike.%${q}%`)
    .eq('status', 'Active')
    .limit(10)

  if (error) return []
  return data as SearchResult[]
}

export async function getStockHeader(ticker: string): Promise<StockHeader | null> {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('stocks')
    .select('ticker, name, sector, subsector, board, is_lq45, is_idx30, market_cap, listed_shares, status')
    .eq('ticker', ticker.toUpperCase())
    .single()

  if (error || !data) return null
  return {
    ...data,
    market_cap: parseBigInt(data.market_cap),
    listed_shares: parseBigInt(data.listed_shares),
  } as StockHeader
}
