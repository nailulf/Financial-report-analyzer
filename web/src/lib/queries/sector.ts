import { createClient } from '@/lib/supabase/server'

/**
 * Raw row from v_latest_annual_financials — only the columns we need
 * for peer percentile ranking.
 */
export interface SectorPeerRow {
  ticker: string
  name: string | null
  subsector: string | null
  pe_ratio: number | null
  pbv_ratio: number | null
  roe: number | null
  roa: number | null
  net_margin: number | null
  gross_margin: number | null
  operating_margin: number | null
  debt_to_equity: number | null
  current_ratio: number | null
  dividend_yield: number | null
  revenue: string | null       // BIGINT comes as string
  net_income: string | null
  market_cap: string | null
}

/**
 * Fetch all stocks in the same subsector (or sector as fallback) that have
 * at least one non-null financial ratio. This gives us the peer universe
 * for percentile ranking.
 *
 * Only returns stocks with "comprehensive data" — defined as having at least
 * 3 of the 7 key ratios (PE, PBV, ROE, ROA, net_margin, D/E, DY) non-null.
 */
export async function getSubsectorPeers(
  subsector: string | null,
  sector: string | null,
): Promise<SectorPeerRow[]> {
  // Need at least one grouping dimension
  if (!subsector && !sector) return []

  const supabase = await createClient()

  const columns = [
    'ticker', 'name', 'subsector',
    'pe_ratio', 'pbv_ratio', 'roe', 'roa',
    'net_margin', 'gross_margin', 'operating_margin',
    'debt_to_equity', 'current_ratio', 'dividend_yield',
    'revenue', 'net_income', 'market_cap',
  ].join(', ')

  // Prefer subsector (more specific), fall back to sector
  const filterCol = subsector ? 'subsector' : 'sector'
  const filterVal = subsector ?? sector!

  const { data, error } = await supabase
    .from('v_latest_annual_financials')
    .select(columns)
    .eq(filterCol, filterVal)

  if (error) {
    console.error('[getSubsectorPeers]', error.message, error.details)
    return []
  }

  if (!data) return []

  // Filter to stocks with comprehensive data: at least 3 of 7 key ratios present
  return (data as unknown as SectorPeerRow[]).filter((row) => {
    const keyRatios = [
      row.pe_ratio,
      row.pbv_ratio,
      row.roe,
      row.roa,
      row.net_margin,
      row.debt_to_equity,
      row.dividend_yield,
    ]
    const nonNull = keyRatios.filter((v) => v !== null).length
    return nonNull >= 3
  })
}

/* ── Peer CAGR from normalized_metrics ──────────────────────────── */

/**
 * One peer's CAGR values for a single metric, pre-computed by the Python
 * data normalizer pipeline and stored in normalized_metrics.
 */
export interface PeerCAGRRow {
  ticker: string
  metric_name: string
  cagr_3yr: number | null
  cagr_5yr: number | null
}

/** Per-peer CAGR values for a single metric. */
export interface PeerCAGRValues {
  cagr_3yr: number | null
  cagr_5yr: number | null
}

/**
 * Fetch cagr_3yr and cagr_5yr for all peers in a subsector (or sector
 * fallback) from the normalized_metrics table.
 *
 * Returns a map: metric_name → Map<ticker, { cagr_3yr, cagr_5yr }>
 */
export async function getPeerCAGR(
  subsector: string | null,
  sector: string | null,
): Promise<Map<string, Map<string, PeerCAGRValues>>> {
  if (!subsector && !sector) return new Map()

  const supabase = await createClient()

  // The metrics the growth widget cares about
  const growthMetrics = [
    'revenue', 'net_income', 'operating_cash_flow', 'free_cash_flow', 'total_equity',
  ]

  const filterCol = subsector ? 'subsector' : 'sector'
  const filterVal = subsector ?? sector!

  // Join normalized_metrics with stocks to filter by subsector/sector
  const { data, error } = await supabase
    .from('normalized_metrics')
    .select('ticker, metric_name, cagr_3yr, cagr_5yr, stocks!inner(ticker)')
    .eq(`stocks.${filterCol}`, filterVal)
    .in('metric_name', growthMetrics)

  if (error) {
    console.error('[getPeerCAGR]', error.message, error.details)
    return new Map()
  }

  if (!data) return new Map()

  // Build: metric_name → Map<ticker, { cagr_3yr, cagr_5yr }>
  const result = new Map<string, Map<string, PeerCAGRValues>>()
  for (const row of data as unknown as PeerCAGRRow[]) {
    // Skip rows where both are null
    if (row.cagr_3yr === null && row.cagr_5yr === null) continue
    let metricMap = result.get(row.metric_name)
    if (!metricMap) {
      metricMap = new Map()
      result.set(row.metric_name, metricMap)
    }
    metricMap.set(row.ticker, { cagr_3yr: row.cagr_3yr, cagr_5yr: row.cagr_5yr })
  }

  return result
}
