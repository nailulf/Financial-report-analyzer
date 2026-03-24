import { createClient } from '@/lib/supabase/server'
import { parseBigInt } from '@/lib/calculations/formatters'

export interface StockBrokerBucket {
  broker_code: string
  broker_name: string | null
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
}

/**
 * Aggregate broker activity for a single ticker.
 * @param ticker  IDX ticker without .JK suffix
 * @param days    Number of trading days to look back (default 10)
 * @param endDate YYYY-MM-DD upper bound for dates (default: latest available)
 */
export async function getStockBrokerSummary(
  ticker: string,
  days: number = 10,
  endDate?: string,
): Promise<StockBrokerSummary | null> {
  const supabase = await createClient()

  // Collect the latest N unique dates ≤ endDate for this ticker
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

  // Aggregate by broker across all selected dates
  const map = new Map<string, StockBrokerBucket>()
  for (const row of rows) {
    const key = row.broker_code as string
    const b = map.get(key) ?? {
      broker_code: key,
      broker_name: row.broker_name as string | null,
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
    topNetSellers: topN(
      all.filter((b) => b.total_net_value < 0).map((b) => ({
        ...b,
        total_net_value: Math.abs(b.total_net_value),
      })),
      'total_net_value',
    ),
    dateRange: `${uniqueDates.at(-1)} – ${uniqueDates[0]}`,
    daysCount: uniqueDates.length,
  }
}
