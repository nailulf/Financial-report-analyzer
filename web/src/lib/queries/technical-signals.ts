import { createClient } from '@/lib/supabase/server'
import type { TechnicalSignalPoint } from '@/lib/types/api'

export async function getTechnicalSignals(ticker: string, days = 252): Promise<TechnicalSignalPoint[]> {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('technical_signals')
    .select('date, rsi_14, macd_line, macd_signal, macd_histogram')
    .eq('ticker', ticker.toUpperCase())
    .order('date', { ascending: false })
    .limit(days)

  if (error) return []

  return ((data as any[]) ?? []).reverse().map((r) => ({
    date: r.date,
    rsi_14: r.rsi_14 != null ? Number(r.rsi_14) : null,
    macd_line: r.macd_line != null ? Number(r.macd_line) : null,
    macd_signal: r.macd_signal != null ? Number(r.macd_signal) : null,
    macd_histogram: r.macd_histogram != null ? Number(r.macd_histogram) : null,
  }))
}
