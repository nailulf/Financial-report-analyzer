import { createClient } from '@/lib/supabase/server'
import type {
  WyckoffEvent,
  WyckoffEventType,
  WyckoffPhase,
  WyckoffResponse,
} from '@/lib/types/api'

/**
 * Fetch Wyckoff structural events for a ticker, ordered by event_date.
 *
 * Wyckoff events are discrete single-day signals (Selling Climax, Spring,
 * Buying Climax, UTAD, etc.) — not contiguous bands like market_phases.
 * The frontend overlays these as markers on the price chart.
 */
export async function getWyckoffEvents(
  ticker: string,
  minConfidence: number = 0,
): Promise<WyckoffResponse> {
  const sb = await createClient()

  const { data: rows } = await sb
    .from('wyckoff_events')
    .select('*')
    .eq('ticker', ticker)
    .gte('confidence', minConfidence)
    .order('event_date', { ascending: true })

  const events: WyckoffEvent[] = (rows ?? []).map((r) => ({
    id: r.id,
    ticker: r.ticker,
    event_type: r.event_type as WyckoffEventType,
    event_date: r.event_date,
    price: r.price,
    volume: r.volume,
    volume_z: r.volume_z != null ? Number(r.volume_z) : null,
    range_z: r.range_z != null ? Number(r.range_z) : null,
    confidence: r.confidence,
    inferred_phase: r.inferred_phase as WyckoffPhase | null,
    notes: r.notes,
    detected_at: r.detected_at,
  }))

  // Latest event determines the "current" Wyckoff posture
  const latestEvent = events.length > 0 ? events[events.length - 1] : null
  const currentPhase: WyckoffPhase | null = latestEvent?.inferred_phase ?? null

  // Count events by type for summary
  const eventCounts: Record<string, number> = {}
  for (const e of events) {
    eventCounts[e.event_type] = (eventCounts[e.event_type] ?? 0) + 1
  }

  return {
    ticker,
    events,
    currentPhase,
    latestEvent,
    detectedAt: latestEvent?.detected_at ?? null,
    stats: {
      totalEvents: events.length,
      eventCounts,
      avgConfidence:
        events.length > 0
          ? Math.round(
              events.reduce((s, e) => s + e.confidence, 0) / events.length,
            )
          : 0,
    },
  }
}
