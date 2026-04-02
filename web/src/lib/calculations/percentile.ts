import type { SectorPeerRow, PeerCAGRValues } from '@/lib/queries/sector'
import type { CAGRResult } from '@/lib/types/api'

/**
 * A single metric's percentile ranking within a peer group.
 */
export interface PercentileRank {
  metric: string
  label: string
  value: number | null            // the stock's own value
  formatted: string               // human-readable value
  percentile: number | null       // 0–100, higher = better in context
  peerCount: number               // how many peers had data for this metric
  rankLabel: string               // e.g. "High (top 25%)"
  rankColor: string               // CSS color
}

/**
 * Three groups of percentile-ranked metrics.
 */
export interface PeerPercentiles {
  subsector: string
  peerCount: number               // total peers with comprehensive data
  growth: PercentileRank[]
  strength: PercentileRank[]
  value: PercentileRank[]
}

/* ── Helpers ───────────────────────────────────────────────────── */

/**
 * Compute percentile rank of `val` within `arr` (higher = better).
 * Returns 0–100. If invert=true, lower raw value = higher percentile (e.g. PE, D/E).
 */
function computePercentile(val: number, arr: number[], invert = false): number {
  if (arr.length === 0) return 50
  const sorted = [...arr].sort((a, b) => a - b)
  // Count how many values this stock beats
  const below = sorted.filter((v) => (invert ? v > val : v < val)).length
  const equal = sorted.filter((v) => v === val).length
  // Percentile = (below + 0.5 * equal) / total * 100
  return Math.round(((below + 0.5 * equal) / sorted.length) * 100)
}

function rankLabel(pct: number | null): { label: string; color: string } {
  if (pct === null) return { label: 'N/A', color: '#888888' }
  if (pct >= 80) return { label: `Very High (top ${100 - pct}%)`, color: '#166534' }
  if (pct >= 60) return { label: `High (top ${100 - pct}%)`, color: '#65A30D' }
  if (pct >= 40) return { label: `Medium (top ${100 - pct}%)`, color: '#F59E0B' }
  if (pct >= 20) return { label: `Low (bottom ${100 - pct}%)`, color: '#EA580C' }
  return { label: `Very Low (bottom ${100 - pct}%)`, color: '#DC2626' }
}

function fmtPct(v: number | null): string {
  if (v === null) return '—'
  return `${v.toFixed(1)}%`
}

function fmtMultiple(v: number | null): string {
  if (v === null) return '—'
  return `${v.toFixed(1)}x`
}

function fmtNum(v: number | null, decimals = 2): string {
  if (v === null) return '—'
  return v.toFixed(decimals)
}

function extractValues(peers: SectorPeerRow[], key: keyof SectorPeerRow): number[] {
  return peers
    .map((p) => {
      const v = p[key]
      if (v === null || v === undefined) return null
      const n = typeof v === 'string' ? Number(v) : v
      return isNaN(n as number) ? null : (n as number)
    })
    .filter((v): v is number => v !== null)
}

/* ── Main computation ──────────────────────────────────────────── */

/**
 * Compute percentile rankings for a stock against its subsector peers.
 *
 * `stockRow` is the current stock's data within the peers array.
 * We compare against all peers (including the stock itself — standard practice).
 */
export function computePeerPercentiles(
  ticker: string,
  peers: SectorPeerRow[],
  subsectorLabel: string,
): PeerPercentiles | null {
  if (peers.length < 3) return null   // need meaningful peer group

  const stock = peers.find((p) => p.ticker === ticker)
  if (!stock) return null

  function rank(
    metric: string,
    label: string,
    key: keyof SectorPeerRow,
    formatter: (v: number | null) => string,
    invert = false,
  ): PercentileRank {
    const allVals = extractValues(peers, key)
    const stockVal = stock![key]
    const numVal = stockVal !== null && stockVal !== undefined
      ? (typeof stockVal === 'string' ? Number(stockVal) : stockVal as number)
      : null
    const validNum = numVal !== null && !isNaN(numVal) ? numVal : null

    const pct = validNum !== null && allVals.length >= 3
      ? computePercentile(validNum, allVals, invert)
      : null
    const rl = rankLabel(pct)

    return {
      metric,
      label,
      value: validNum,
      formatted: formatter(validNum),
      percentile: pct,
      peerCount: allVals.length,
      rankLabel: rl.label,
      rankColor: rl.color,
    }
  }

  // ── Strength metrics (higher = better, except D/E and FCF sign) ──
  const strength: PercentileRank[] = [
    rank('gross_margin',    'Gross Margin',       'gross_margin',     fmtPct),
    rank('operating_margin','Operating Margin',   'operating_margin', fmtPct),
    rank('net_margin',      'Net Margin',         'net_margin',       fmtPct),
    rank('roe',             'ROE',                'roe',              fmtPct),
    rank('roa',             'ROA',                'roa',              fmtPct),
    rank('debt_to_equity',  'Debt to Equity',     'debt_to_equity',   fmtNum, true),  // lower = better
    rank('current_ratio',   'Current Ratio',      'current_ratio',    fmtNum),
  ]

  // ── Value metrics (lower PE/PBV = better, higher DY = better) ──
  const value: PercentileRank[] = [
    rank('pe_ratio',        'PE Ratio',           'pe_ratio',         fmtMultiple, true),  // lower = better
    rank('pbv_ratio',       'PBV Ratio',          'pbv_ratio',        fmtMultiple, true),  // lower = better
    rank('dividend_yield',  'Dividend Yield',     'dividend_yield',   fmtPct),
  ]

  // ── Growth metrics: ranked via peerCAGR if available (see computeGrowthPercentiles) ──
  const growth: PercentileRank[] = []

  return {
    subsector: subsectorLabel,
    peerCount: peers.length,
    growth,
    strength,
    value,
  }
}

/* ── Growth percentile ranking from normalized_metrics CAGR ────── */

/** Minimum peers with non-null CAGR to show a percentile rank. */
const MIN_GROWTH_PEERS = 5

/**
 * Growth metrics to rank against peers.
 * metric: matches `metric_name` in normalized_metrics AND `CAGRResult.metric`
 * period: which CAGR field to extract from the peer data
 */
const GROWTH_METRICS: { metric: string; label: string; period: '3yr' | '5yr' }[] = [
  { metric: 'revenue',             label: 'Revenue Growth (3Y)',  period: '3yr' },
  { metric: 'revenue',             label: 'Revenue Growth (5Y)',  period: '5yr' },
  { metric: 'net_income',          label: 'Earnings Growth (3Y)', period: '3yr' },
  { metric: 'net_income',          label: 'Earnings Growth (5Y)', period: '5yr' },
  { metric: 'operating_cash_flow', label: 'OCF Growth (3Y)',      period: '3yr' },
  { metric: 'free_cash_flow',      label: 'FCF Growth (3Y)',      period: '3yr' },
  { metric: 'total_equity',        label: 'Equity Growth (3Y)',   period: '3yr' },
]

/**
 * Compute percentile-ranked growth metrics for a stock using pre-computed
 * CAGR values from normalized_metrics.
 *
 * @param ticker       The stock to rank
 * @param cagr         The stock's own CAGR results (computed client-side from financials)
 * @param peerCAGR     Map<metric_name, Map<ticker, PeerCAGRValues>> from getPeerCAGR()
 * @param subsector    Label for tooltips
 */
export function computeGrowthPercentiles(
  ticker: string,
  cagr: CAGRResult[],
  peerCAGR: Map<string, Map<string, PeerCAGRValues>>,
  subsector: string,
): PercentileRank[] {
  const results: PercentileRank[] = []

  for (const { metric, label, period } of GROWTH_METRICS) {
    const peerMap = peerCAGR.get(metric)
    const stockCAGR = cagr.find((c) => c.metric === metric)
    const stockVal = stockCAGR
      ? (period === '3yr' ? stockCAGR.cagr_3yr : stockCAGR.cagr_5yr)
      : null

    // Extract the relevant period's values from peers, filtering nulls
    const peerVals: number[] = []
    if (peerMap) {
      for (const pv of peerMap.values()) {
        const v = period === '3yr' ? pv.cagr_3yr : pv.cagr_5yr
        if (v !== null) peerVals.push(v)
      }
    }

    // Compute percentile if enough peers and stock has data
    if (peerVals.length >= MIN_GROWTH_PEERS && stockVal !== null) {
      const pct = computePercentile(stockVal, peerVals)
      const rl = rankLabel(pct)

      results.push({
        metric: `${metric}_${period}`,
        label,
        value: stockVal,
        formatted: fmtPct(stockVal),
        percentile: pct,
        peerCount: peerVals.length,
        rankLabel: rl.label,
        rankColor: rl.color,
      })
    } else {
      // Not enough peers — fall back to null percentile
      results.push({
        metric: `${metric}_${period}`,
        label,
        value: stockVal,
        formatted: fmtPct(stockVal),
        percentile: null,
        peerCount: peerVals.length,
        rankLabel: 'N/A',
        rankColor: '#888888',
      })
    }
  }

  return results
}
