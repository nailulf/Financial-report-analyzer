import { createClient } from '@/lib/supabase/server'
import { PAGE_SIZE } from '@/lib/constants'
import { parseBigInt } from '@/lib/calculations/formatters'
import type { ScreenerRow, SearchResult, StockHeader } from '@/lib/types/api'
import type { VScreenerRow } from '@/lib/types/database'

const VALID_SORT_COLS = ['market_cap', 'price', 'pe_ratio', 'pbv_ratio', 'roe', 'net_margin', 'dividend_yield'] as const
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

  let query = supabase
    .from('v_screener')
    .select(
      'ticker, name, sector, board, is_lq45, is_idx30, market_cap, price, pe_ratio, pbv_ratio, roe, net_margin, dividend_yield',
      { count: 'exact' },
    )
    .order(sortCol, { ascending, nullsFirst: false })
    .range(offset, offset + PAGE_SIZE - 1)

  if (filters.sector)         query = query.eq('sector', filters.sector)
  if (filters.board)          query = query.eq('board', filters.board)
  if (filters.minRoe != null)      query = query.gte('roe', filters.minRoe)
  if (filters.maxPe != null)       query = query.lte('pe_ratio', filters.maxPe)
  if (filters.maxPbv != null)      query = query.lte('pbv_ratio', filters.maxPbv)
  if (filters.minNetMargin != null) query = query.gte('net_margin', filters.minNetMargin)
  if (filters.minDivYield != null)  query = query.gte('dividend_yield', filters.minDivYield)

  const { data, count, error } = await query

  if (error) return { rows: [], total: 0 }

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
  }))

  return { rows, total: count ?? 0 }
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
    .select('ticker, name, sector, subsector, board, is_lq45, is_idx30, market_cap, status')
    .eq('ticker', ticker.toUpperCase())
    .single()

  if (error || !data) return null
  return {
    ...data,
    market_cap: parseBigInt(data.market_cap),
  } as StockHeader
}
