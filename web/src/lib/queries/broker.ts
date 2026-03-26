import { createClient } from '@/lib/supabase/server'
import { parseBigInt } from '@/lib/calculations/formatters'

export interface StockBrokerBucket {
  broker_code: string
  broker_name: string | null
  broker_type: string | null   // Lokal, Asing, Pemerintah
  total_buy_value: number
  total_sell_value: number
  total_net_value: number
  total_buy_volume: number
  total_sell_volume: number
}

export interface StockBrokerSummary {
  topBuyers: StockBrokerBucket[]
  topSellers: StockBrokerBucket[]
  topNetBuyers: StockBrokerBucket[]
  topNetSellers: StockBrokerBucket[]
  dateRange: string | null
  daysCount: number
  bandarSignal: BandarSignalRow | null
}

export interface BandarSignalRow {
  ticker: string
  trade_date: string
  broker_accdist: string | null
  top1_accdist: string | null
  top3_accdist: string | null
  top5_accdist: string | null
  top10_accdist: string | null
  total_buyer: number | null
  total_seller: number | null
  total_value: number | null
  total_volume: number | null
}

export interface InsiderTransactionRow {
  insider_name: string
  transaction_date: string
  action: 'BUY' | 'SELL'
  share_change: number
  shares_before: number | null
  shares_after: number | null
  ownership_before_pct: number | null
  ownership_after_pct: number | null
  ownership_change_pct: number | null
  nationality: string | null
  price: number | null
  total_value: number | null
}

/** Daily flow grouped by broker type — one row per (date, type) */
export interface DailyFlowByType {
  trade_date: string
  asing_net: number
  lokal_net: number
  pemerintah_net: number
  asing_buy: number
  asing_sell: number
  lokal_buy: number
  lokal_sell: number
  close_price: number | null
}

/** Broker row for identification table with concentration % */
export interface BrokerConcentrationRow {
  broker_code: string
  broker_type: string | null
  total_buy_value: number
  total_sell_value: number
  total_net_value: number
  concentration_pct: number    // % of total volume this broker represents
  status: 'kandidat_bandar' | 'asing' | 'retail'
}

/** Extended summary with daily flow data for charts */
export interface SmartMoneyData {
  summary: StockBrokerSummary
  dailyFlow: DailyFlowByType[]
  concentration: BrokerConcentrationRow[]
  asingNetFlow: number
  lokal_netFlow: number
  insiderSummary: {
    buyCount: number
    sellCount: number
    netAction: 'buy' | 'sell' | 'mixed' | 'none'
    totalBuyValue: number
    totalSellValue: number
  }
}

/**
 * Fetch broker_flow rows in batches to avoid Supabase's PostgREST max_rows cap
 * (default 1000). Each batch queries a subset of dates to keep row counts
 * within the cap (~50 brokers per date × 20 dates = 1000 rows).
 */
async function _fetchBrokerFlowBatched<T>(
  supabase: Awaited<ReturnType<typeof createClient>>,
  ticker: string,
  uniqueDates: string[],
  select: string,
): Promise<T[]> {
  const DATES_PER_BATCH = 20 // ~50 brokers/date × 20 = 1000, within PostgREST cap
  const results: T[] = []

  for (let i = 0; i < uniqueDates.length; i += DATES_PER_BATCH) {
    const batch = uniqueDates.slice(i, i + DATES_PER_BATCH)
    const { data } = await supabase
      .from('broker_flow')
      .select(select)
      .eq('ticker', ticker)
      .in('trade_date', batch)

    if (data) results.push(...(data as T[]))
  }

  return results
}

/**
 * Efficiently fetch the N most recent unique trade dates for a ticker.
 *
 * Uses bandar_signal (1 row per date) instead of broker_flow (~25-50 rows per date)
 * to avoid hitting Supabase's PostgREST max_rows cap (default 1000) which silently
 * truncates results and causes fewer unique dates to be returned for liquid stocks.
 *
 * Falls back to broker_flow if bandar_signal has no data.
 */
async function _getUniqueBrokerDates(
  supabase: Awaited<ReturnType<typeof createClient>>,
  ticker: string,
  days: number,
  endDate?: string,
): Promise<string[]> {
  // Primary: bandar_signal has exactly 1 row per ticker per date
  let bq = supabase
    .from('bandar_signal')
    .select('trade_date')
    .eq('ticker', ticker)
    .order('trade_date', { ascending: false })
    .limit(days)

  if (endDate) bq = bq.lte('trade_date', endDate)

  const { data: bandarRows } = await bq
  if (bandarRows && bandarRows.length > 0) {
    return bandarRows.map((r) => r.trade_date as string)
  }

  // Fallback: deduplicate from broker_flow (works for small day counts)
  let fq = supabase
    .from('broker_flow')
    .select('trade_date')
    .eq('ticker', ticker)
    .order('trade_date', { ascending: false })
    .limit(days * 100)

  if (endDate) fq = fq.lte('trade_date', endDate)

  const { data: flowRows } = await fq
  if (!flowRows || flowRows.length === 0) return []

  return [...new Set(flowRows.map((r) => r.trade_date as string))].slice(0, days)
}

/**
 * Aggregate broker activity for a single ticker.
 *
 * Reads from broker_flow (Stockbit data with buy/sell split) as primary source.
 * Falls back to broker_summary (IDX API, combined totals only) when broker_flow
 * has no data for the ticker.
 */
export async function getStockBrokerSummary(
  ticker: string,
  days: number = 10,
  endDate?: string,
): Promise<StockBrokerSummary | null> {
  const supabase = await createClient()

  // Try broker_flow first (has buy/sell split)
  const result = await _fromBrokerFlow(supabase, ticker, days, endDate)
  if (result) return result

  // Fallback to broker_summary (legacy, combined totals)
  return _fromBrokerSummary(supabase, ticker, days, endDate)
}

// ── broker_flow (Stockbit data) ──────────────────────────────────────────────

async function _fromBrokerFlow(
  supabase: Awaited<ReturnType<typeof createClient>>,
  ticker: string,
  days: number,
  endDate?: string,
): Promise<StockBrokerSummary | null> {
  const uniqueDates = await _getUniqueBrokerDates(supabase, ticker, days, endDate)
  if (uniqueDates.length === 0) return null

  const rows = await _fetchBrokerFlowBatched<any>(
    supabase, ticker, uniqueDates,
    'broker_code, broker_type, buy_value, sell_value, net_value, buy_lot, sell_lot',
  )
  if (rows.length === 0) return null

  const map = new Map<string, StockBrokerBucket>()
  for (const row of rows) {
    const key = row.broker_code as string
    const b = map.get(key) ?? {
      broker_code: key,
      broker_name: null,
      broker_type: (row.broker_type as string) ?? null,
      total_buy_value: 0,
      total_sell_value: 0,
      total_net_value: 0,
      total_buy_volume: 0,
      total_sell_volume: 0,
    }
    b.total_buy_value  += parseBigInt(row.buy_value)  ?? 0
    b.total_sell_value += parseBigInt(row.sell_value) ?? 0
    b.total_net_value  += parseBigInt(row.net_value)  ?? 0
    b.total_buy_volume  += parseBigInt(row.buy_lot)   ?? 0
    b.total_sell_volume += parseBigInt(row.sell_lot)  ?? 0
    if (!b.broker_type && row.broker_type) b.broker_type = row.broker_type as string
    map.set(key, b)
  }

  const all = Array.from(map.values())
  const topN = (arr: StockBrokerBucket[], key: keyof StockBrokerBucket, n = 5) =>
    [...arr].sort((a, b) => (b[key] as number) - (a[key] as number)).slice(0, n)

  // Fetch the latest bandar signal within the date range
  const latestDate = uniqueDates[0]
  const bandarSignal = await getBandarSignal(ticker, latestDate)

  return {
    topBuyers:   topN(all, 'total_buy_value'),
    topSellers:  topN(all, 'total_sell_value'),
    topNetBuyers: topN(all.filter((b) => b.total_net_value > 0), 'total_net_value'),
    topNetSellers: [...all.filter((b) => b.total_net_value < 0)]
      .sort((a, b) => a.total_net_value - b.total_net_value)
      .slice(0, 5),
    dateRange: `${uniqueDates.at(-1)} – ${uniqueDates[0]}`,
    daysCount: uniqueDates.length,
    bandarSignal,
  }
}

// ── broker_summary (IDX legacy fallback) ─────────────────────────────────────

async function _fromBrokerSummary(
  supabase: Awaited<ReturnType<typeof createClient>>,
  ticker: string,
  days: number,
  endDate?: string,
): Promise<StockBrokerSummary | null> {
  let q = supabase
    .from('broker_summary')
    .select('date')
    .eq('ticker', ticker)
    .order('date', { ascending: false })
    .limit(days * 100)

  if (endDate) q = q.lte('date', endDate)

  const { data: dateRows, error: dateErr } = await q
  if (dateErr || !dateRows || dateRows.length === 0) return null

  const uniqueDates = [...new Set(dateRows.map((r) => r.date as string))].slice(0, days)
  if (uniqueDates.length === 0) return null

  const { data: rows, error: rowErr } = await supabase
    .from('broker_summary')
    .select('broker_code, broker_name, buy_value, sell_value, net_value, buy_volume, sell_volume')
    .eq('ticker', ticker)
    .in('date', uniqueDates)

  if (rowErr || !rows || rows.length === 0) return null

  const map = new Map<string, StockBrokerBucket>()
  for (const row of rows) {
    const key = row.broker_code as string
    const b = map.get(key) ?? {
      broker_code: key,
      broker_name: row.broker_name as string | null,
      broker_type: null,
      total_buy_value: 0,
      total_sell_value: 0,
      total_net_value: 0,
      total_buy_volume: 0,
      total_sell_volume: 0,
    }
    b.total_buy_value  += parseBigInt(row.buy_value)  ?? 0
    b.total_sell_value += parseBigInt(row.sell_value) ?? 0
    b.total_net_value  += parseBigInt(row.net_value)  ?? 0
    b.total_buy_volume  += parseBigInt(row.buy_volume)  ?? 0
    b.total_sell_volume += parseBigInt(row.sell_volume) ?? 0
    map.set(key, b)
  }

  const all = Array.from(map.values())
  const topN = (arr: StockBrokerBucket[], key: keyof StockBrokerBucket, n = 5) =>
    [...arr].sort((a, b) => (b[key] as number) - (a[key] as number)).slice(0, n)

  return {
    topBuyers:   topN(all, 'total_buy_value'),
    topSellers:  topN(all, 'total_sell_value'),
    topNetBuyers: topN(all.filter((b) => b.total_net_value > 0), 'total_net_value'),
    topNetSellers: [...all.filter((b) => b.total_net_value < 0)]
      .sort((a, b) => a.total_net_value - b.total_net_value)
      .slice(0, 5),
    dateRange: `${uniqueDates.at(-1)} – ${uniqueDates[0]}`,
    daysCount: uniqueDates.length,
    bandarSignal: null,
  }
}

// ── Bandar signal query ──────────────────────────────────────────────────────

export async function getBandarSignal(
  ticker: string,
  date?: string,
): Promise<BandarSignalRow | null> {
  const supabase = await createClient()

  let q = supabase
    .from('bandar_signal')
    .select('ticker, trade_date, broker_accdist, top1_accdist, top3_accdist, top5_accdist, top10_accdist, total_buyer, total_seller, total_value, total_volume')
    .eq('ticker', ticker)
    .order('trade_date', { ascending: false })
    .limit(1)

  if (date) q = q.lte('trade_date', date)

  const { data, error } = await q
  if (error || !data || data.length === 0) return null

  const r = data[0] as any
  if (!r.broker_accdist) return null

  return {
    ticker: r.ticker,
    trade_date: r.trade_date,
    broker_accdist: r.broker_accdist,
    top1_accdist: r.top1_accdist,
    top3_accdist: r.top3_accdist,
    top5_accdist: r.top5_accdist,
    top10_accdist: r.top10_accdist,
    total_buyer: r.total_buyer != null ? Number(r.total_buyer) : null,
    total_seller: r.total_seller != null ? Number(r.total_seller) : null,
    total_value: parseBigInt(r.total_value),
    total_volume: parseBigInt(r.total_volume),
  }
}

// ── Insider transactions query ───────────────────────────────────────────────

export async function getInsiderTransactions(
  ticker: string,
  limit: number = 20,
): Promise<InsiderTransactionRow[]> {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from('insider_transactions')
    .select('insider_name, transaction_date, action, share_change, shares_before, shares_after, ownership_before_pct, ownership_after_pct, ownership_change_pct, nationality, price')
    .eq('ticker', ticker)
    .order('transaction_date', { ascending: false })
    .limit(limit)

  if (error || !data || data.length === 0) return []

  return (data as any[]).map((r) => ({
    insider_name: r.insider_name,
    transaction_date: r.transaction_date,
    action: r.action,
    share_change: parseBigInt(r.share_change) ?? 0,
    shares_before: parseBigInt(r.shares_before),
    shares_after: parseBigInt(r.shares_after),
    ownership_before_pct: r.ownership_before_pct != null ? Number(r.ownership_before_pct) : null,
    ownership_after_pct: r.ownership_after_pct != null ? Number(r.ownership_after_pct) : null,
    ownership_change_pct: r.ownership_change_pct != null ? Number(r.ownership_change_pct) : null,
    nationality: r.nationality,
    price: parseBigInt(r.price),
    total_value: r.share_change && r.price
      ? (parseBigInt(r.share_change) ?? 0) * (parseBigInt(r.price) ?? 0)
      : null,
  }))
}

// ── Daily flow by broker type (for charts) ──────────────────────────────────

export async function getDailyBrokerFlowByType(
  ticker: string,
  days: number = 30,
  endDate?: string,
): Promise<DailyFlowByType[]> {
  const supabase = await createClient()

  // 1. Get unique trade dates (via bandar_signal for efficiency)
  const uniqueDates = await _getUniqueBrokerDates(supabase, ticker, days, endDate)
  if (uniqueDates.length === 0) return []

  // 2. Fetch all broker_flow rows for these dates (batched to avoid PostgREST row cap)
  const rows = await _fetchBrokerFlowBatched<any>(
    supabase, ticker, uniqueDates,
    'trade_date, broker_type, buy_value, sell_value, net_value',
  )
  if (rows.length === 0) return []

  // 3. Fetch close prices for these dates
  const { data: priceRows } = await supabase
    .from('daily_prices')
    .select('date, close')
    .eq('ticker', ticker)
    .in('date', uniqueDates)

  const priceMap = new Map<string, number>()
  for (const p of (priceRows ?? []) as any[]) {
    priceMap.set(p.date, Number(p.close))
  }

  // 4. Aggregate by date + broker_type
  const dateMap = new Map<string, DailyFlowByType>()
  for (const date of uniqueDates) {
    dateMap.set(date, {
      trade_date: date,
      asing_net: 0, lokal_net: 0, pemerintah_net: 0,
      asing_buy: 0, asing_sell: 0, lokal_buy: 0, lokal_sell: 0,
      close_price: priceMap.get(date) ?? null,
    })
  }

  for (const row of rows as any[]) {
    const d = dateMap.get(row.trade_date)
    if (!d) continue
    const net = parseBigInt(row.net_value) ?? 0
    const buy = parseBigInt(row.buy_value) ?? 0
    const sell = parseBigInt(row.sell_value) ?? 0
    const type = (row.broker_type as string)?.toLowerCase() ?? 'lokal'

    if (type === 'asing') {
      d.asing_net += net
      d.asing_buy += buy
      d.asing_sell += sell
    } else if (type === 'pemerintah') {
      d.pemerintah_net += net
    } else {
      d.lokal_net += net
      d.lokal_buy += buy
      d.lokal_sell += sell
    }
  }

  return uniqueDates.sort().map((d) => dateMap.get(d)!)
}

// ── Broker concentration for identification table ───────────────────────────

export async function getBrokerConcentration(
  ticker: string,
  days: number = 30,
  endDate?: string,
): Promise<BrokerConcentrationRow[]> {
  const supabase = await createClient()

  // 1. Get unique trade dates (via bandar_signal for efficiency)
  const uniqueDates = await _getUniqueBrokerDates(supabase, ticker, days, endDate)
  if (uniqueDates.length === 0) return []

  // 2. Fetch all broker_flow rows (batched to avoid PostgREST row cap)
  const rows = await _fetchBrokerFlowBatched<any>(
    supabase, ticker, uniqueDates,
    'broker_code, broker_type, buy_value, sell_value, net_value',
  )
  if (rows.length === 0) return []

  // 3. Aggregate per broker
  const map = new Map<string, {
    broker_code: string
    broker_type: string | null
    buy: number
    sell: number
    net: number
  }>()

  let totalVolume = 0

  for (const row of rows as any[]) {
    const code = row.broker_code as string
    const buy = parseBigInt(row.buy_value) ?? 0
    const sell = parseBigInt(row.sell_value) ?? 0
    const net = parseBigInt(row.net_value) ?? 0
    totalVolume += buy + sell

    const entry = map.get(code) ?? {
      broker_code: code,
      broker_type: row.broker_type ?? null,
      buy: 0, sell: 0, net: 0,
    }
    entry.buy += buy
    entry.sell += sell
    entry.net += net
    if (!entry.broker_type && row.broker_type) entry.broker_type = row.broker_type
    map.set(code, entry)
  }

  // 4. Compute concentration % and classify
  return Array.from(map.values())
    .sort((a, b) => Math.abs(b.net) - Math.abs(a.net))
    .slice(0, 15)
    .map((e) => {
      const brokerVolume = e.buy + e.sell
      const concentration = totalVolume > 0 ? (brokerVolume / totalVolume) * 100 : 0
      const type = e.broker_type?.toLowerCase() ?? 'lokal'

      let status: BrokerConcentrationRow['status'] = 'retail'
      if (type === 'asing') {
        status = 'asing'
      } else if (concentration >= 10 && Math.abs(e.net) > 0) {
        status = 'kandidat_bandar'
      }

      return {
        broker_code: e.broker_code,
        broker_type: e.broker_type,
        total_buy_value: e.buy,
        total_sell_value: e.sell,
        total_net_value: e.net,
        concentration_pct: Math.round(concentration * 10) / 10,
        status,
      }
    })
}

// ── Full smart money data (combines all queries) ────────────────────────────

export async function getSmartMoneyData(
  ticker: string,
  days: number = 30,
  endDate?: string,
): Promise<SmartMoneyData | null> {
  const [summary, dailyFlow, concentration] = await Promise.all([
    getStockBrokerSummary(ticker, days, endDate),
    getDailyBrokerFlowByType(ticker, days, endDate),
    getBrokerConcentration(ticker, days, endDate),
  ])

  if (!summary) return null

  // Compute aggregated asing/lokal net flow
  const asingNetFlow = dailyFlow.reduce((s, d) => s + d.asing_net, 0)
  const lokal_netFlow = dailyFlow.reduce((s, d) => s + d.lokal_net + d.pemerintah_net, 0)

  return {
    summary,
    dailyFlow,
    concentration,
    asingNetFlow,
    lokal_netFlow,
    insiderSummary: { buyCount: 0, sellCount: 0, netAction: 'none', totalBuyValue: 0, totalSellValue: 0 },
  }
}
