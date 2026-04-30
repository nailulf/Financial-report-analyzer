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
  minOcfCagr3yr?: number
  minOcfCagr5yr?: number
  minMktCap?: number
  minCompleteness?: number
  minConfidence?: number
  maxPhaseDays?: number
  // Technical signals
  minRsi?: number
  maxRsi?: number
  macdCross?: string           // 'golden_cross' | 'death_cross'
  maxMacdCrossDays?: number
  minVolChangePct?: number
  minVolAvg?: number             // 20-day avg volume (in millions)
  // Wyckoff signals (v1 — flat-pass detector denorm columns)
  wyckoffEvent?: string          // comma-separated event types
  wyckoffPhase?: string
  maxWyckoffDays?: number
  minWyckoffConf?: number
  // Wyckoff signals (v2 — FSM detector denorm columns)
  wyckoffEventV2?: string        // comma-separated event types
  wyckoffPhaseV2?: string        // accumulation|markup|distribution|markdown
  wyckoffFsmPhaseV2?: string     // fine-grained FSM phase (accumulation_a/b/c/d, etc.)
  maxWyckoffDaysV2?: number
  minWyckoffConfV2?: number
  sortBy?: string
  sortDir?: 'asc' | 'desc'
}

// Map legacy "price" sort param → denormalized column name
function resolveSortCol(raw?: string): SortCol {
  if (raw === 'price') return 'current_price'
  if (VALID_SORT_COLS.includes(raw as SortCol)) return raw as SortCol
  return 'market_cap'
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function applyScreenerFilters<Q extends { eq: any; gte: any; lte: any; or: any }>(
  query: Q,
  filters: ScreenerFilters,
): Q {
  if (filters.sector) query = query.eq('sector', filters.sector)
  if (filters.board) query = query.eq('board', filters.board)
  if (filters.phase) {
    const phases = String(filters.phase).split(',').filter(Boolean)
    if (phases.length === 1) {
      query = query.eq('current_phase', phases[0])
    } else if (phases.length > 1) {
      const orClause = phases.map((p: string) => `current_phase.eq.${p}`).join(',')
      query = query.or(orClause)
    }
  }
  if (filters.minRoe != null) query = query.gte('roe', filters.minRoe)
  if (filters.maxPe != null) query = query.lte('pe_ratio', filters.maxPe)
  if (filters.maxPbv != null) query = query.lte('pbv_ratio', filters.maxPbv)
  if (filters.minNetMargin != null) query = query.gte('net_margin', filters.minNetMargin)
  if (filters.minDivYield != null) query = query.gte('dividend_yield', filters.minDivYield)
  if (filters.minDivAvg3yr != null) query = query.gte('div_yield_avg_3yr', filters.minDivAvg3yr)
  if (filters.minDivAvg5yr != null) query = query.gte('div_yield_avg_5yr', filters.minDivAvg5yr)
  if (filters.minRevCagr3yr != null) query = query.gte('revenue_cagr_3yr', filters.minRevCagr3yr)
  if (filters.minRevCagr5yr != null) query = query.gte('revenue_cagr_5yr', filters.minRevCagr5yr)
  if (filters.minPriceCagr3yr != null) query = query.gte('price_cagr_3yr', filters.minPriceCagr3yr)
  if (filters.minPriceCagr5yr != null) query = query.gte('price_cagr_5yr', filters.minPriceCagr5yr)
  if (filters.minOcfCagr3yr != null) query = query.gte('ocf_cagr_3yr', filters.minOcfCagr3yr)
  if (filters.minOcfCagr5yr != null) query = query.gte('ocf_cagr_5yr', filters.minOcfCagr5yr)
  if (filters.minMktCap != null) {
    query = query.gte('market_cap', filters.minMktCap * 1_000_000_000_000)
  }
  if (filters.minCompleteness != null) query = query.gte('completeness_score', filters.minCompleteness)
  if (filters.minConfidence != null) query = query.gte('confidence_score', filters.minConfidence)
  if (filters.maxPhaseDays != null) {
    const days = Number(filters.maxPhaseDays)
    if (!isNaN(days)) query = query.lte('current_phase_days', days)
  }
  if (filters.minRsi != null) query = query.gte('rsi_14', filters.minRsi)
  if (filters.maxRsi != null) query = query.lte('rsi_14', filters.maxRsi)
  if (filters.macdCross) query = query.eq('macd_cross_signal', filters.macdCross)
  if (filters.maxMacdCrossDays != null) query = query.lte('macd_cross_days_ago', filters.maxMacdCrossDays)
  if (filters.minVolChangePct != null) query = query.gte('volume_change_pct', filters.minVolChangePct)
  if (filters.minVolAvg != null) {
    query = query.gte('volume_avg_20d', filters.minVolAvg * 1_000_000)
  }
  // ── Wyckoff filters (denormalized on stocks via schema-v24) ─────────
  if (filters.wyckoffEvent) {
    const evts = String(filters.wyckoffEvent).split(',').filter(Boolean)
    if (evts.length === 1) {
      query = query.eq('current_wyckoff_event', evts[0])
    } else if (evts.length > 1) {
      const orClause = evts.map((e: string) => `current_wyckoff_event.eq.${e}`).join(',')
      query = query.or(orClause)
    }
  }
  if (filters.wyckoffPhase) query = query.eq('current_wyckoff_phase', filters.wyckoffPhase)
  if (filters.maxWyckoffDays != null) {
    const days = Number(filters.maxWyckoffDays)
    if (!isNaN(days)) {
      const cutoff = new Date()
      cutoff.setDate(cutoff.getDate() - days)
      query = query.gte('current_wyckoff_event_date', cutoff.toISOString().slice(0, 10))
    }
  }
  if (filters.minWyckoffConf != null) {
    query = query.gte('current_wyckoff_confidence', filters.minWyckoffConf)
  }
  // ── Wyckoff v2 filters (denormalized via schema-v25 *_v2 columns) ───
  if (filters.wyckoffEventV2) {
    const evts = String(filters.wyckoffEventV2).split(',').filter(Boolean)
    if (evts.length === 1) {
      query = query.eq('current_wyckoff_event_v2', evts[0])
    } else if (evts.length > 1) {
      const orClause = evts.map((e: string) => `current_wyckoff_event_v2.eq.${e}`).join(',')
      query = query.or(orClause)
    }
  }
  if (filters.wyckoffPhaseV2) query = query.eq('current_wyckoff_phase_v2', filters.wyckoffPhaseV2)
  if (filters.wyckoffFsmPhaseV2) query = query.eq('current_wyckoff_fsm_phase_v2', filters.wyckoffFsmPhaseV2)
  if (filters.maxWyckoffDaysV2 != null) {
    const days = Number(filters.maxWyckoffDaysV2)
    if (!isNaN(days)) {
      const cutoff = new Date()
      cutoff.setDate(cutoff.getDate() - days)
      query = query.gte('current_wyckoff_event_date_v2', cutoff.toISOString().slice(0, 10))
    }
  }
  if (filters.minWyckoffConfV2 != null) {
    query = query.gte('current_wyckoff_confidence_v2', filters.minWyckoffConfV2)
  }
  return query
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

  const SCREENER_COLS = 'ticker, name, sector, subsector, board, is_lq45, is_idx30, listing_date, listed_shares, market_cap, current_price, pe_ratio, pbv_ratio, roe, net_margin, dividend_yield, current_phase, current_phase_clarity, current_phase_days, revenue_cagr_3yr, revenue_cagr_5yr, price_cagr_3yr, price_cagr_5yr, ocf_cagr_3yr, ocf_cagr_5yr, div_yield_avg_3yr, div_yield_avg_5yr, completeness_score, confidence_score, rsi_14, macd_histogram, macd_cross_signal, macd_cross_days_ago, volume_change_pct, volume_avg_20d, current_wyckoff_event, current_wyckoff_event_date, current_wyckoff_phase, current_wyckoff_confidence, current_wyckoff_event_v2, current_wyckoff_event_date_v2, current_wyckoff_phase_v2, current_wyckoff_confidence_v2, current_wyckoff_fsm_phase_v2'

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
  dataQuery = applyScreenerFilters(dataQuery, filters)
  countQuery = applyScreenerFilters(countQuery, filters)

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
    ocf_cagr_3yr: number | null
    ocf_cagr_5yr: number | null
    div_yield_avg_3yr: number | null
    div_yield_avg_5yr: number | null
    completeness_score: number | null
    confidence_score: number | null
    rsi_14: number | null
    macd_histogram: number | null
    macd_cross_signal: string | null
    macd_cross_days_ago: number | null
    volume_change_pct: number | null
    volume_avg_20d: string | null   // BIGINT → string
    current_wyckoff_event: string | null
    current_wyckoff_event_date: string | null
    current_wyckoff_phase: string | null
    current_wyckoff_confidence: number | null
    current_wyckoff_event_v2: string | null
    current_wyckoff_event_date_v2: string | null
    current_wyckoff_phase_v2: string | null
    current_wyckoff_confidence_v2: number | null
    current_wyckoff_fsm_phase_v2: string | null
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
    ocf_cagr_3yr: r.ocf_cagr_3yr,
    ocf_cagr_5yr: r.ocf_cagr_5yr,
    div_yield_avg_3yr: r.div_yield_avg_3yr,
    div_yield_avg_5yr: r.div_yield_avg_5yr,
    completeness_score: r.completeness_score ?? null,
    confidence_score: r.confidence_score ?? null,
    rsi_14: r.rsi_14 ?? null,
    macd_histogram: r.macd_histogram ?? null,
    macd_cross_signal: (r.macd_cross_signal as ScreenerRow['macd_cross_signal']) ?? null,
    macd_cross_days_ago: r.macd_cross_days_ago ?? null,
    volume_change_pct: r.volume_change_pct ?? null,
    volume_avg_20d: parseBigInt(r.volume_avg_20d),
    current_wyckoff_event: r.current_wyckoff_event as ScreenerRow['current_wyckoff_event'],
    current_wyckoff_event_date: r.current_wyckoff_event_date,
    current_wyckoff_phase: r.current_wyckoff_phase as ScreenerRow['current_wyckoff_phase'],
    current_wyckoff_confidence: r.current_wyckoff_confidence ?? null,
    current_wyckoff_event_v2: r.current_wyckoff_event_v2 as ScreenerRow['current_wyckoff_event_v2'],
    current_wyckoff_event_date_v2: r.current_wyckoff_event_date_v2,
    current_wyckoff_phase_v2: r.current_wyckoff_phase_v2 as ScreenerRow['current_wyckoff_phase_v2'],
    current_wyckoff_confidence_v2: r.current_wyckoff_confidence_v2 ?? null,
    current_wyckoff_fsm_phase_v2: r.current_wyckoff_fsm_phase_v2 ?? null,
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
