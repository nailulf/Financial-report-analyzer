import { createClient } from '@/lib/supabase/server'
import { PAGE_SIZE } from '@/lib/constants'
import { parseBigInt } from '@/lib/calculations/formatters'
import type { ScreenerRow, SearchResult, StockHeader } from '@/lib/types/api'
import type { VScreenerRow } from '@/lib/types/database'

const VALID_SORT_COLS = ['ticker', 'market_cap', 'price', 'pe_ratio', 'pbv_ratio', 'roe', 'net_margin', 'dividend_yield'] as const
type SortCol = typeof VALID_SORT_COLS[number]

export interface ScreenerFilters {
  sector?: string
  board?: string
  minRoe?: number
  maxPe?: number
  maxPbv?: number
  minNetMargin?: number
  minDivYield?: number
  sortBy?: string
  sortDir?: 'asc' | 'desc'
}

export async function getScreenerRows(
  filters: ScreenerFilters = {},
  page = 1,
): Promise<{ rows: ScreenerRow[]; total: number }> {
  const supabase = await createClient()
  const offset = (page - 1) * PAGE_SIZE

  const sortCol: SortCol = VALID_SORT_COLS.includes(filters.sortBy as SortCol)
    ? (filters.sortBy as SortCol)
    : 'market_cap'
  const ascending = filters.sortDir === 'asc'

  // Whether financial metric filters are active (require reading v_screener for count).
  // Sector/board live on the stocks table and can be counted cheaply there.
  const hasMetricFilters = (
    filters.minRoe != null || filters.maxPe != null || filters.maxPbv != null ||
    filters.minNetMargin != null || filters.minDivYield != null
  )

  // ── Data query (no count — LIMIT/OFFSET makes this fast regardless of view complexity) ──
  let dataQuery = supabase
    .from('v_screener')
    .select('ticker, name, sector, board, is_lq45, is_idx30, market_cap, price, pe_ratio, pbv_ratio, roe, net_margin, dividend_yield')
    .order(sortCol, { ascending, nullsFirst: false })
    .range(offset, offset + PAGE_SIZE - 1)

  if (filters.sector)               dataQuery = dataQuery.eq('sector', filters.sector)
  if (filters.board)                dataQuery = dataQuery.eq('board', filters.board)
  if (filters.minRoe != null)       dataQuery = dataQuery.gte('roe', filters.minRoe)
  if (filters.maxPe != null)        dataQuery = dataQuery.lte('pe_ratio', filters.maxPe)
  if (filters.maxPbv != null)       dataQuery = dataQuery.lte('pbv_ratio', filters.maxPbv)
  if (filters.minNetMargin != null)  dataQuery = dataQuery.gte('net_margin', filters.minNetMargin)
  if (filters.minDivYield != null)   dataQuery = dataQuery.gte('dividend_yield', filters.minDivYield)

  // ── Count query (runs in parallel with data query) ──
  // When only sector/board filters are active, count from the stocks table (simple,
  // indexed, no joins). Only hit v_screener for metric filters — those WHERE clauses
  // are selective enough to keep COUNT(*) fast.
  let countQuery
  if (!hasMetricFilters) {
    let q = supabase.from('stocks').select('*', { count: 'exact', head: true })
    if (filters.sector) q = q.eq('sector', filters.sector)
    if (filters.board)  q = q.eq('board', filters.board)
    countQuery = q
  } else {
    let q = supabase.from('v_screener').select('*', { count: 'exact', head: true })
    if (filters.sector)               q = q.eq('sector', filters.sector)
    if (filters.board)                q = q.eq('board', filters.board)
    if (filters.minRoe != null)       q = q.gte('roe', filters.minRoe)
    if (filters.maxPe != null)        q = q.lte('pe_ratio', filters.maxPe)
    if (filters.maxPbv != null)       q = q.lte('pbv_ratio', filters.maxPbv)
    if (filters.minNetMargin != null)  q = q.gte('net_margin', filters.minNetMargin)
    if (filters.minDivYield != null)   q = q.gte('dividend_yield', filters.minDivYield)
    countQuery = q
  }

  const [{ data, error }, { count, error: countError }] = await Promise.all([dataQuery, countQuery])

  if (error) {
    console.error('[getScreenerRows] v_screener query failed:', error.message, error.details)
    return { rows: [], total: 0 }
  }
  if (countError) {
    console.warn('[getScreenerRows] count query failed:', countError.message)
  }

  const tickers = (data as VScreenerRow[]).map((r) => r.ticker)
  const { data: scoreRows, error: scoreError } = tickers.length > 0
    ? await supabase
        .from('stocks')
        .select('ticker, completeness_score, confidence_score')
        .in('ticker', tickers)
    : { data: [], error: null }

  if (scoreError) {
    console.warn('[getScreenerRows] scores query failed:', scoreError.message)
  }

  const scoreMap = new Map(
    (scoreRows ?? []).map((s) => [s.ticker, {
      completeness_score: s.completeness_score,
      confidence_score: s.confidence_score,
    }]),
  )

  const rows: ScreenerRow[] = (data as VScreenerRow[]).map((r) => ({
    ticker: r.ticker,
    name: r.name,
    sector: r.sector,
    board: r.board,
    is_lq45: r.is_lq45,
    is_idx30: r.is_idx30,
    market_cap: parseBigInt(r.market_cap),
    price: r.price,
    pe_ratio: r.pe_ratio,
    pbv_ratio: r.pbv_ratio,
    roe: r.roe,
    net_margin: r.net_margin,
    dividend_yield: r.dividend_yield,
    completeness_score: scoreMap.get(r.ticker)?.completeness_score ?? null,
    confidence_score: scoreMap.get(r.ticker)?.confidence_score ?? null,
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
