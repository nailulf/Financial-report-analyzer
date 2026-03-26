import { createClient } from '@/lib/supabase/server'

export interface DividendRow {
  ticker: string
  ex_date: string
  amount: number
}

export interface AnnualDPS {
  year: number
  dps: number       // total DPS for that year (sum of all ex_date payments)
  payments: number   // how many payments in that year
}

/**
 * Fetch dividend history from the dividend_history table, grouped by year.
 * Returns annual DPS sorted ascending by year (oldest first).
 * Returns empty array if the table doesn't exist yet.
 */
export async function getDividendHistory(ticker: string): Promise<AnnualDPS[]> {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from('dividend_history')
    .select('ticker, ex_date, amount')
    .eq('ticker', ticker)
    .order('ex_date', { ascending: true })

  // Table may not exist yet — gracefully return empty
  if (error || !data || data.length === 0) return []

  // Group by year and sum DPS
  const yearMap = new Map<number, { dps: number; payments: number }>()
  for (const row of data as DividendRow[]) {
    const year = parseInt(row.ex_date.slice(0, 4), 10)
    const amt = Number(row.amount) || 0
    if (amt <= 0) continue
    const entry = yearMap.get(year) ?? { dps: 0, payments: 0 }
    entry.dps += amt
    entry.payments += 1
    yearMap.set(year, entry)
  }

  return Array.from(yearMap.entries())
    .map(([year, { dps, payments }]) => ({ year, dps: Math.round(dps * 100) / 100, payments }))
    .sort((a, b) => a.year - b.year)
}
