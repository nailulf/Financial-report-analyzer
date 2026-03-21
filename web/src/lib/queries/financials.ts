import { createClient } from '@/lib/supabase/server'
import { parseBigInt } from '@/lib/calculations/formatters'
import type { FinancialYear, StockMetrics, QuarterlyFinancial } from '@/lib/types/api'
import type { Financials, VLatestAnnualFinancials } from '@/lib/types/database'

export async function getFinancialSeries(ticker: string): Promise<FinancialYear[]> {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('financials')
    .select(`year, revenue, gross_profit, net_income, operating_income,
             gross_margin, operating_margin, net_margin, roe, roa, current_ratio,
             debt_to_equity, operating_cash_flow, capex, free_cash_flow,
             total_debt, cash_and_equivalents, total_equity, dividends_paid`)
    .eq('ticker', ticker.toUpperCase())
    .eq('quarter', 0)
    .order('year', { ascending: false })
    .limit(10)

  if (error) return []

  // Reverse so charts render oldest → newest (left to right)
  return ((data as Financials[]).reverse()).map((r) => ({
    year: r.year,
    revenue: parseBigInt(r.revenue),
    gross_profit: parseBigInt(r.gross_profit),
    net_income: parseBigInt(r.net_income),
    operating_income: parseBigInt(r.operating_income),
    gross_margin: r.gross_margin,
    operating_margin: r.operating_margin,
    net_margin: r.net_margin,
    roe: r.roe,
    roa: r.roa,
    current_ratio: r.current_ratio,
    debt_to_equity: r.debt_to_equity,
    operating_cash_flow: parseBigInt(r.operating_cash_flow),
    capex: parseBigInt(r.capex),
    free_cash_flow: parseBigInt(r.free_cash_flow),
    total_debt: parseBigInt(r.total_debt),
    cash_and_equivalents: parseBigInt(r.cash_and_equivalents),
    total_equity: parseBigInt(r.total_equity),
    dividends_paid: parseBigInt(r.dividends_paid),
  }))
}

export async function getQuarterlySeries(ticker: string): Promise<QuarterlyFinancial[]> {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('financials')
    .select('year, quarter, revenue, gross_profit, net_income, net_margin, roe, eps')
    .eq('ticker', ticker.toUpperCase())
    .neq('quarter', 0)
    .order('year', { ascending: false })
    .order('quarter', { ascending: false })
    .limit(8)

  if (error) return []

  return ((data as any[]) ?? []).map((r) => ({
    year: r.year,
    quarter: r.quarter,
    revenue: parseBigInt(r.revenue),
    gross_profit: parseBigInt(r.gross_profit),
    net_income: parseBigInt(r.net_income),
    net_margin: r.net_margin,
    roe: r.roe,
    eps: r.eps,
  }))
}

export async function getLatestMetrics(ticker: string): Promise<StockMetrics | null> {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('v_latest_annual_financials')
    .select('pe_ratio, pbv_ratio, roe, dividend_yield, eps, book_value_per_share, market_cap, year, current_price')
    .eq('ticker', ticker.toUpperCase())
    .single()

  if (error || !data) return null

  const d = data as VLatestAnnualFinancials & { current_price: number | null }
  return {
    price: d.current_price,
    pe_ratio: d.pe_ratio,
    pbv_ratio: d.pbv_ratio,
    roe: d.roe,
    dividend_yield: d.dividend_yield,
    eps: d.eps,
    book_value_per_share: (d as any).book_value_per_share != null ? Number((d as any).book_value_per_share) : null,
    market_cap: parseBigInt(d.market_cap),
    financial_year: d.year,
  }
}
