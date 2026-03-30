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
