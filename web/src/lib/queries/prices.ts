import { createClient } from '@/lib/supabase/server'
import type { VLatestPrice } from '@/lib/types/database'
import type { PricePoint } from '@/lib/types/api'

export async function getPriceHistory(ticker: string, days = 252): Promise<PricePoint[]> {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('daily_prices')
    .select('date, open, high, low, close, volume, foreign_net')
    .eq('ticker', ticker.toUpperCase())
    .order('date', { ascending: false })
    .limit(days)

  if (error) return []

  return ((data as any[]) ?? []).reverse().map((r) => ({
    date: r.date,
    open: r.open != null ? Number(r.open) : null,
    high: r.high != null ? Number(r.high) : null,
    low: r.low != null ? Number(r.low) : null,
    close: r.close != null ? Number(r.close) : null,
    volume: r.volume != null ? Number(r.volume) : null,
    foreign_net: r.foreign_net != null ? Number(r.foreign_net) : null,
  }))
}

export async function getLatestPrice(ticker: string): Promise<{ close: number | null; date: string | null }> {
  const supabase = await createClient()
  const { data } = await supabase
    .from('v_latest_prices')
    .select('close, date')
    .eq('ticker', ticker.toUpperCase())
    .single()

  const d = data as VLatestPrice | null
  return { close: d?.close ?? null, date: d?.date ?? null }
}
