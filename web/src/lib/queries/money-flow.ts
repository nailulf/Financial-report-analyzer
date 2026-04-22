import { createClient } from '@/lib/supabase/server'
import { parseBigInt } from '@/lib/calculations/formatters'

export interface FlowRow {
  ticker: string
  name: string | null
  asing_net: number       // net foreign flow IDR (from broker_flow)
}

export interface BrokerRow {
  broker_code: string
  broker_name: string | null
  total_value: number | null    // buy value
  total_volume: number | null   // buy volume (lots × 100)
  frequency: number | null
  net_value?: number | null     // populated in range mode
  sell_value?: number | null    // populated in range mode
}

export interface VolumeAnomalyRow {
  ticker: string
  name: string | null
  latest_date: string
  today_volume: number
  avg_vol_20d: number
  volume_ratio: number
  latest_close: number | null
}

export interface FlowScoreRow {
  ticker: string
  name: string | null
  flow_score: number
  foreign_score: number
  volume_score: number
  price_score: number
  foreign_percentile: number
  pct_change_5d: number | null
  volume_ratio: number | null
  asing_net: number | null
}

// ─── Default date helpers ─────────────────────────────────────────────────────

export function defaultDateRange(): { from: string; to: string } {
  const to = new Date()
  const from = new Date()
  from.setDate(from.getDate() - 5)
  const fmt = (d: Date) => d.toISOString().split('T')[0]
  return { from: fmt(from), to: fmt(to) }
}

// ─── Foreign flow leaderboard (from Stockbit broker_flow) ────────────────────
// Aggregates net_value from broker_flow WHERE broker_type = 'Asing'
// across the given date range. Always uses broker_flow as sole data source.

export async function getForeignFlowLeaderboard(
  topN = 15,
  from?: string,
  to?: string,
): Promise<{ buyers: FlowRow[]; sellers: FlowRow[] }> {
  const supabase = await createClient()

  // Use defaults if not provided
  const { from: defaultFrom, to: defaultTo } = defaultDateRange()
  const dateFrom = from ?? defaultFrom
  const dateTo   = to   ?? defaultTo

  const { data, error } = await supabase
    .from('broker_flow')
    .select('ticker, broker_type, net_value')
    .eq('broker_type', 'Asing')
    .gte('trade_date', dateFrom)
    .lte('trade_date', dateTo)
    .limit(100_000)

  if (error || !data || data.length === 0) return { buyers: [], sellers: [] }

  // Aggregate net_value per ticker
  const totals = new Map<string, number>()
  for (const row of data as any[]) {
    const n = parseBigInt(row.net_value) ?? 0
    totals.set(row.ticker, (totals.get(row.ticker) ?? 0) + n)
  }

  const sorted = Array.from(totals.entries())
    .map(([ticker, net]) => ({ ticker, asing_net: net }))
    .sort((a, b) => b.asing_net - a.asing_net)

  if (sorted.length === 0) return { buyers: [], sellers: [] }

  const topBuyers  = sorted.filter((r) => r.asing_net > 0).slice(0, topN)
  const topSellers = sorted.filter((r) => r.asing_net < 0).slice(-topN).reverse()
  const allTickers = [...topBuyers, ...topSellers].map((r) => r.ticker)

  const { data: stocks } = await supabase
    .from('stocks').select('ticker, name').in('ticker', allTickers)
  const nameMap = new Map((stocks as any[] ?? []).map((s: any) => [s.ticker, s.name]))

  const enrich = (rows: typeof sorted): FlowRow[] =>
    rows.map((r) => ({ ...r, name: nameMap.get(r.ticker) ?? null }))

  return { buyers: enrich(topBuyers), sellers: enrich(topSellers) }
}

// ─── Broker dates (for single-day date pills) ─────────────────────────────────

export async function getBrokerDates(ticker: string): Promise<string[]> {
  const supabase = await createClient()
  const t = ticker.toUpperCase()

  // Try broker_flow first (Stockbit data)
  const { data: flowDates } = await supabase
    .from('broker_flow')
    .select('trade_date')
    .eq('ticker', t)
    .order('trade_date', { ascending: false })
    .limit(50)

  if (flowDates && flowDates.length > 0) {
    const seen = new Set<string>()
    const dates: string[] = []
    for (const row of flowDates as any[]) {
      if (!seen.has(row.trade_date)) {
        seen.add(row.trade_date)
        dates.push(row.trade_date)
      }
      if (dates.length >= 5) break
    }
    return dates
  }

  // Fallback to broker_summary
  const { data, error } = await supabase
    .from('broker_summary')
    .select('date')
    .eq('ticker', t)
    .order('date', { ascending: false })
    .limit(50)

  if (error || !data) return []

  const seen = new Set<string>()
  const dates: string[] = []
  for (const row of data as any[]) {
    if (!seen.has(row.date)) {
      seen.add(row.date)
      dates.push(row.date)
    }
    if (dates.length >= 5) break
  }
  return dates
}

// ─── Broker activity — single date ───────────────────────────────────────────

export async function getBrokerActivity(ticker: string, date: string): Promise<BrokerRow[]> {
  const supabase = await createClient()
  const t = ticker.toUpperCase()

  // Try broker_flow first
  const { data: flowData } = await supabase
    .from('broker_flow')
    .select('broker_code, broker_type, buy_value, sell_value, net_value, buy_lot, sell_lot, frequency')
    .eq('ticker', t)
    .eq('trade_date', date)
    .order('buy_value', { ascending: false, nullsFirst: false })
    .limit(30)

  if (flowData && flowData.length > 0) {
    return (flowData as any[]).map((r) => ({
      broker_code: r.broker_code,
      broker_name: r.broker_type ?? null,
      total_value: parseBigInt(r.buy_value),
      sell_value: parseBigInt(r.sell_value),
      net_value: parseBigInt(r.net_value),
      total_volume: parseBigInt(r.buy_lot),
      frequency: r.frequency ?? null,
    }))
  }

  // Fallback to broker_summary
  const { data, error } = await supabase
    .from('broker_summary')
    .select('broker_code, broker_name, buy_value, buy_volume, frequency')
    .eq('ticker', t)
    .eq('date', date)
    .order('buy_value', { ascending: false, nullsFirst: false })
    .limit(30)

  if (error || !data) return []

  return (data as any[]).map((r) => ({
    broker_code: r.broker_code,
    broker_name: r.broker_name ?? null,
    total_value: parseBigInt(r.buy_value),
    total_volume: parseBigInt(r.buy_volume),
    frequency: r.frequency ?? null,
  }))
}

// ─── Broker activity — date range (aggregated) ───────────────────────────────

export async function getBrokerActivityRange(
  ticker: string,
  from: string,
  to: string,
): Promise<BrokerRow[]> {
  const supabase = await createClient()
  const t = ticker.toUpperCase()

  // Try broker_flow first
  const { data: flowData } = await supabase
    .from('broker_flow')
    .select('broker_code, broker_type, buy_value, sell_value, net_value, buy_lot, sell_lot, frequency')
    .eq('ticker', t)
    .gte('trade_date', from)
    .lte('trade_date', to)
    .limit(50_000)

  const rawData = (flowData && flowData.length > 0)
    ? flowData
    : await supabase
        .from('broker_summary')
        .select('broker_code, broker_name, buy_value, buy_volume, sell_value, sell_volume, net_value, frequency')
        .eq('ticker', t)
        .gte('date', from)
        .lte('date', to)
        .limit(50_000)
        .then((r) => r.data)

  if (!rawData || rawData.length === 0) return []

  const usesFlow = flowData && flowData.length > 0

  const map = new Map<string, {
    broker_code: string
    broker_name: string | null
    buy: number
    sell: number
    net: number
    volume: number
    freq: number
  }>()

  for (const row of rawData as any[]) {
    const code: string = row.broker_code
    const entry = map.get(code) ?? {
      broker_code: code,
      broker_name: usesFlow ? (row.broker_type ?? null) : (row.broker_name ?? null),
      buy: 0, sell: 0, net: 0, volume: 0, freq: 0,
    }
    entry.buy    += parseBigInt(row.buy_value)   ?? 0
    entry.sell   += parseBigInt(row.sell_value)  ?? 0
    entry.net    += parseBigInt(row.net_value)   ?? 0
    entry.volume += parseBigInt(usesFlow ? row.buy_lot : row.buy_volume) ?? 0
    entry.freq   += (row.frequency as number)    ?? 0
    map.set(code, entry)
  }

  return Array.from(map.values())
    .sort((a, b) => Math.abs(b.net) - Math.abs(a.net))
    .slice(0, 30)
    .map((e) => ({
      broker_code: e.broker_code,
      broker_name: e.broker_name,
      total_value:  e.buy  > 0 ? e.buy  : null,
      sell_value:   e.sell > 0 ? e.sell : null,
      net_value:    e.net,
      total_volume: e.volume > 0 ? e.volume : null,
      frequency:    e.freq  > 0 ? e.freq  : null,
    }))
}

// ─── Volume anomaly leaderboard ───────────────────────────────────────────────

export async function getVolumeAnomalies(topN = 20): Promise<VolumeAnomalyRow[]> {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from('v_volume_anomalies')
    .select('ticker, latest_date, today_volume, avg_vol_20d, volume_ratio, latest_close')
    .gte('volume_ratio', 2)
    .order('volume_ratio', { ascending: false })
    .limit(topN)

  if (error || !data || data.length === 0) return []

  const tickers = (data as any[]).map((r) => r.ticker)
  const { data: stocks } = await supabase
    .from('stocks').select('ticker, name').in('ticker', tickers)
  const nameMap = new Map((stocks as any[] ?? []).map((s: any) => [s.ticker, s.name]))

  return (data as any[]).map((r) => ({
    ticker: r.ticker,
    name: nameMap.get(r.ticker) ?? null,
    latest_date: r.latest_date,
    today_volume: Number(r.today_volume),
    avg_vol_20d: Number(r.avg_vol_20d),
    volume_ratio: Number(r.volume_ratio),
    latest_close: r.latest_close != null ? Number(r.latest_close) : null,
  }))
}

// ─── Flow score leaderboard ───────────────────────────────────────────────────

export async function getFlowScoreLeaderboard(topN = 15): Promise<{
  bullish: FlowScoreRow[]
  bearish: FlowScoreRow[]
}> {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from('v_flow_score')
    .select('ticker, flow_score, foreign_score, volume_score, price_score, foreign_percentile, pct_change_5d, volume_ratio')
    .not('flow_score', 'is', null)

  if (error || !data || data.length === 0) return { bullish: [], bearish: [] }

  const sorted = (data as any[])
    .map((r) => ({
      ticker: r.ticker as string,
      flow_score: Number(r.flow_score),
      foreign_score: Number(r.foreign_score ?? 0),
      volume_score: Number(r.volume_score ?? 0),
      price_score: Number(r.price_score ?? 0),
      foreign_percentile: Number(r.foreign_percentile ?? 50),
      pct_change_5d: r.pct_change_5d != null ? Number(r.pct_change_5d) : null,
      volume_ratio: r.volume_ratio != null ? Number(r.volume_ratio) : null,
      asing_net: null as number | null,
    }))
    .sort((a, b) => b.flow_score - a.flow_score)

  const topBullish = sorted.slice(0, topN)
  const topBearish = sorted.slice(-topN).reverse()
  const allTickers = [...topBullish, ...topBearish].map((r) => r.ticker)

  const { data: stocks } = await supabase
    .from('stocks').select('ticker, name').in('ticker', allTickers)
  const nameMap = new Map((stocks as any[] ?? []).map((s: any) => [s.ticker, s.name]))

  const enrich = (rows: typeof sorted): FlowScoreRow[] =>
    rows.map((r) => ({ ...r, name: nameMap.get(r.ticker) ?? null }))

  return { bullish: enrich(topBullish), bearish: enrich(topBearish) }
}
