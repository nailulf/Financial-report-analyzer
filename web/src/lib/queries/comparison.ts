import { createClient } from '@/lib/supabase/server'
import { parseBigInt } from '@/lib/calculations/formatters'
import type { ComparisonStock } from '@/lib/types/api'

export async function getComparisonStocks(tickers: string[]): Promise<ComparisonStock[]> {
  if (!tickers.length) return []
  const supabase = await createClient()

  const upper = tickers.map((t) => t.toUpperCase())

  const [metricsRes, pricesRes, stocksRes] = await Promise.all([
    supabase
      .from('v_latest_annual_financials')
      .select('ticker, pe_ratio, pbv_ratio, roe, roa, net_margin, debt_to_equity, current_ratio, dividend_yield, revenue, net_income, market_cap')
      .in('ticker', upper),
    supabase
      .from('v_latest_prices')
      .select('ticker, close')
      .in('ticker', upper),
    supabase
      .from('stocks')
      .select('ticker, name, sector')
      .in('ticker', upper),
  ])

  const priceMap = new Map((pricesRes.data ?? []).map((p: { ticker: string; close: number | null }) => [p.ticker, p.close]))
  const stockMap = new Map((stocksRes.data ?? []).map((s: { ticker: string; name: string | null; sector: string | null }) => [s.ticker, s]))

  return (metricsRes.data ?? []).map((m: {
    ticker: string
    pe_ratio: number | null
    pbv_ratio: number | null
    roe: number | null
    roa: number | null
    net_margin: number | null
    debt_to_equity: number | null
    current_ratio: number | null
    dividend_yield: number | null
    revenue: string | null
    net_income: string | null
    market_cap: string | null
  }) => {
    const stock = stockMap.get(m.ticker)
    return {
      ticker: m.ticker,
      name: stock?.name ?? null,
      sector: stock?.sector ?? null,
      price: priceMap.get(m.ticker) ?? null,
      pe_ratio: m.pe_ratio,
      pbv_ratio: m.pbv_ratio,
      roe: m.roe,
      roa: m.roa,
      net_margin: m.net_margin,
      debt_to_equity: m.debt_to_equity,
      current_ratio: m.current_ratio,
      dividend_yield: m.dividend_yield,
      revenue: parseBigInt(m.revenue),
      net_income: parseBigInt(m.net_income),
      market_cap: parseBigInt(m.market_cap),
    }
  })
}
