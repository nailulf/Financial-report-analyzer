import { createClient } from '@/lib/supabase/server'
import type { MarketPhase, MarketPhaseResponse, MarketPhaseType } from '@/lib/types/api'

const PHASE_TYPES: MarketPhaseType[] = [
  'uptrend', 'downtrend', 'sideways_bullish', 'sideways_bearish',
]

/**
 * Fetch all detected market phases for a ticker.
 * Returns shaped response with stats and current phase.
 */
export async function getMarketPhases(
  ticker: string,
  minClarity: number = 0,
): Promise<MarketPhaseResponse> {
  const sb = await createClient()

  const { data: rows } = await sb
    .from('market_phases')
    .select('*')
    .eq('ticker', ticker)
    .gte('phase_clarity', minClarity)
    .order('start_date', { ascending: true })

  const phases: MarketPhase[] = (rows ?? []).map((r) => ({
    id: r.id,
    ticker: r.ticker,
    phase_type: r.phase_type as MarketPhaseType,
    start_date: r.start_date,
    end_date: r.end_date,
    days: r.days,
    open_price: r.open_price,
    close_price: r.close_price,
    range_low: r.range_low,
    range_high: r.range_high,
    change_pct: Number(r.change_pct),
    phase_clarity: r.phase_clarity,
    trend_strength: r.trend_strength,
    smart_money_alignment: r.smart_money_alignment,
    broker_flow_alignment: r.broker_flow_alignment,
    bandar_signal_mode: r.bandar_signal_mode,
    insider_activity: r.insider_activity,
    is_current: r.is_current,
    detection_version: r.detection_version,
    detected_at: r.detected_at,
  }))

  const currentPhase = phases.find((p) => p.is_current) ?? null

  const phaseCounts = Object.fromEntries(
    PHASE_TYPES.map((t) => [t, phases.filter((p) => p.phase_type === t).length]),
  ) as Record<MarketPhaseType, number>

  const totalClarity = phases.reduce((s, p) => s + p.phase_clarity, 0)

  return {
    ticker,
    phases,
    currentPhase,
    detectedAt: phases.length > 0 ? phases[phases.length - 1].detected_at : null,
    stats: {
      totalPhases: phases.length,
      avgClarity: phases.length > 0 ? Math.round(totalClarity / phases.length) : 0,
      phaseCounts,
      coverageDays: phases.reduce((s, p) => s + p.days, 0),
    },
  }
}
