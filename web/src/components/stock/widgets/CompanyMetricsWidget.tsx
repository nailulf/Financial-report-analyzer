import type { StockMetrics, FinancialYear, CAGRResult, HealthScore } from '@/lib/types/api'
import type { PeerPercentiles, PercentileRank } from '@/lib/calculations/percentile'
import { formatPercent, formatMultiple, formatNumber } from '@/lib/calculations/formatters'

/* ── Types ─────────────────────────────────────────────────────── */

interface MetricRow {
  label: string
  value: string
  comparison: string
  comparisonColor: string
  tooltip?: string
}

interface Props {
  ticker: string
  metrics: StockMetrics | null
  latestYear: FinancialYear | null
  cagr: CAGRResult[]
  health: HealthScore[]
  peerPercentiles: PeerPercentiles | null
}

/* ── Helpers ───────────────────────────────────────────────────── */

function fmtCagr(v: number | null): string {
  if (v === null) return '—'
  return `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`
}

function cagrRankLabel(v: number | null): { label: string; color: string } {
  if (v === null) return { label: 'N/A', color: '#888888' }
  if (v >= 20) return { label: 'Very High', color: '#166534' }
  if (v >= 10) return { label: 'High',      color: '#65A30D' }
  if (v >= 5)  return { label: 'Medium',    color: '#F59E0B' }
  if (v >= 0)  return { label: 'Low',       color: '#EA580C' }
  return { label: 'Negative', color: '#DC2626' }
}

function peerToRow(pr: PercentileRank, subsector: string): MetricRow {
  return {
    label: `${pr.label}: ${pr.formatted}`,
    value: pr.formatted,
    comparison: pr.rankLabel,
    comparisonColor: pr.rankColor,
    tooltip: `Persentil ${pr.percentile ?? '—'}% dari ${pr.peerCount} emiten di ${subsector}`,
  }
}

/* ── Sub-components ────────────────────────────────────────────── */

function InfoIcon({ tooltip }: { tooltip: string }) {
  return (
    <span className="relative group cursor-help">
      <span className="inline-flex items-center justify-center w-3.5 h-3.5 rounded-full border border-[#E0E0E5] text-[#AAAAAA] font-mono text-[8px] leading-none select-none">
        ?
      </span>
      <span className="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 hidden group-hover:block z-50 w-max max-w-[220px] px-2.5 py-1.5 bg-[#1A1A1A] text-white font-mono text-[10px] leading-[1.4] rounded shadow-lg whitespace-normal">
        {tooltip}
      </span>
    </span>
  )
}

function MetricRowView({ row }: { row: MetricRow }) {
  return (
    <div className="flex items-center justify-between py-2.5 border-b border-[#F5F5F8] last:border-b-0 gap-3">
      <div className="flex items-center gap-1.5 min-w-0">
        <span className="font-mono text-[12px] font-medium text-[#1A1A1A] truncate">{row.label}</span>
        {row.tooltip && <InfoIcon tooltip={row.tooltip} />}
      </div>
      <span
        className="font-mono text-[11px] font-semibold whitespace-nowrap shrink-0"
        style={{ color: row.comparisonColor }}
      >
        {row.comparison}
      </span>
    </div>
  )
}

function ColumnCard({ title, tooltip, rows }: {
  title: string
  tooltip?: string
  rows: MetricRow[]
}) {
  if (rows.length === 0) return null
  return (
    <div className="flex-1 border border-[#E0E0E5] flex flex-col">
      <div className="px-4 py-2.5 border-b border-[#E0E0E5] flex items-center gap-1.5">
        <span className="font-mono text-[11px] font-bold tracking-[0.5px] text-[#1A1A1A]">{title}</span>
        {tooltip && <InfoIcon tooltip={tooltip} />}
      </div>
      <div className="px-4 flex-1">
        {rows.map((row) => (
          <MetricRowView key={row.label} row={row} />
        ))}
      </div>
    </div>
  )
}

/* ── Main Component ────────────────────────────────────────────── */

export function CompanyMetricsWidget({ ticker, metrics, latestYear, cagr, health, peerPercentiles }: Props) {
  if (!metrics && !latestYear && cagr.length === 0 && health.length === 0) return null

  const hasPeers = peerPercentiles !== null
  const subsector = peerPercentiles?.subsector ?? ''
  const peerCount = peerPercentiles?.peerCount ?? 0

  // ── Growth column (CAGR — no peer data, use absolute thresholds) ──
  const cagrMetrics: { label: string; key: string; period: '3yr' | '5yr' }[] = [
    { label: 'Revenue Growth (3Y)',   key: 'revenue',            period: '3yr' },
    { label: 'Revenue Growth (5Y)',   key: 'revenue',            period: '5yr' },
    { label: 'Earnings Growth (3Y)',  key: 'net_income',         period: '3yr' },
    { label: 'Earnings Growth (5Y)',  key: 'net_income',         period: '5yr' },
    { label: 'OCF Growth (3Y)',       key: 'operating_cash_flow', period: '3yr' },
    { label: 'FCF Growth (3Y)',       key: 'free_cash_flow',     period: '3yr' },
    { label: 'Equity Growth (3Y)',    key: 'total_equity',       period: '3yr' },
  ]

  const growthRows: MetricRow[] = cagrMetrics.map((m) => {
    const entry = cagr.find((c) => c.metric === m.key)
    const val = entry ? (m.period === '3yr' ? entry.cagr_3yr : entry.cagr_5yr) : null
    const rl = cagrRankLabel(val)
    return {
      label: `${m.label}: ${fmtCagr(val)}`,
      value: fmtCagr(val),
      comparison: rl.label,
      comparisonColor: rl.color,
      tooltip: '≥20% Very High · ≥10% High · ≥5% Medium · ≥0% Low · <0% Negative',
    }
  })

  // ── Strength column ──
  const strengthRows: MetricRow[] = hasPeers
    ? peerPercentiles!.strength.map((pr) => peerToRow(pr, subsector))
    : (() => {
        const healthMap = new Map(health.map((h) => [h.metric, h]))
        const keys = ['roe', 'net_margin', 'gross_margin', 'roa', 'current_ratio', 'debt_to_equity', 'free_cash_flow'] as const
        return keys.map((k) => {
          const h = healthMap.get(k)
          if (!h) return null
          const statusColor: Record<string, string> = { green: '#166534', yellow: '#F59E0B', red: '#DC2626', na: '#888888' }
          const statusLabel: Record<string, string> = { green: 'Good', yellow: 'Fair', red: 'Weak', na: 'N/A' }
          return {
            label: `${h.label}: ${h.formatted}`,
            value: h.formatted,
            comparison: statusLabel[h.status] ?? 'N/A',
            comparisonColor: statusColor[h.status] ?? '#888888',
            tooltip: h.description,
          } as MetricRow
        }).filter((r): r is MetricRow => r !== null)
      })()

  // ── Value column ──
  const valueRows: MetricRow[] = hasPeers
    ? peerPercentiles!.value.map((pr) => peerToRow(pr, subsector))
    : (() => {
        const pe  = metrics?.pe_ratio ?? null
        const pbv = metrics?.pbv_ratio ?? null
        const dy  = metrics?.dividend_yield ?? null
        const defs: { label: string; value: string; rankFn: () => { label: string; color: string }; threshold: string }[] = [
          {
            label: 'PE Ratio', value: pe !== null ? formatMultiple(pe) : '—',
            rankFn: () => pe === null ? { label: 'N/A', color: '#888888' } : pe <= 10 ? { label: 'Good', color: '#166534' } : pe <= 20 ? { label: 'Fair', color: '#F59E0B' } : { label: 'Expensive', color: '#DC2626' },
            threshold: 'Good ≤10x · Fair ≤20x · >20x Expensive',
          },
          {
            label: 'PBV Ratio', value: pbv !== null ? formatMultiple(pbv) : '—',
            rankFn: () => pbv === null ? { label: 'N/A', color: '#888888' } : pbv <= 1 ? { label: 'Good', color: '#166534' } : pbv <= 3 ? { label: 'Fair', color: '#F59E0B' } : { label: 'Expensive', color: '#DC2626' },
            threshold: 'Good ≤1x · Fair ≤3x · >3x Expensive',
          },
          {
            label: 'Dividend Yield', value: dy !== null ? formatPercent(dy) : '—',
            rankFn: () => dy === null ? { label: 'N/A', color: '#888888' } : dy >= 4 ? { label: 'High', color: '#166534' } : dy >= 2 ? { label: 'Medium', color: '#F59E0B' } : { label: 'Low', color: '#DC2626' },
            threshold: 'High ≥4% · Medium ≥2% · <2% Low',
          },
        ]
        return defs.map((d) => {
          const rl = d.rankFn()
          return {
            label: `${d.label}: ${d.value}`,
            value: d.value,
            comparison: rl.label,
            comparisonColor: rl.color,
            tooltip: d.threshold,
          }
        })
      })()

  return (
    <div className="px-12 py-2">
      <div className="bg-white border border-[#E0E0E5] flex flex-col">
        {/* Header */}
        <div className="px-5 py-3 border-b border-[#E0E0E5] flex items-center justify-between">
          <span className="font-mono text-[13px] font-bold tracking-[0.5px] text-[#1A1A1A]">
            METRIK PERUSAHAAN
          </span>
          <div className="flex items-center gap-3">
            {hasPeers ? (
              <span className="font-mono text-[10px] text-[#00FF88] font-medium border border-[#00FF8840] bg-[#00FF8810] px-2 py-0.5">
                VS {peerCount} EMITEN DI {subsector.toUpperCase()}
              </span>
            ) : (
              <span className="font-mono text-[10px] text-[#888888] font-medium border border-[#E0E0E5] px-2 py-0.5">
                THRESHOLD ABSOLUT
              </span>
            )}
          </div>
        </div>

        {/* Three-column layout */}
        <div className="p-4 flex gap-3">
          <ColumnCard
            title="PERTUMBUHAN"
            tooltip={hasPeers
              ? 'CAGR historis — data peer belum tersedia, menggunakan threshold absolut'
              : 'CAGR historis — threshold absolut'}
            rows={growthRows}
          />
          <ColumnCard
            title="KEKUATAN KEUANGAN"
            tooltip={hasPeers
              ? `Peringkat persentil terhadap ${peerCount} emiten di subsector ${subsector} dengan data lengkap`
              : 'Threshold absolut — data peer tidak tersedia'}
            rows={strengthRows}
          />
          <ColumnCard
            title="VALUASI"
            tooltip={hasPeers
              ? `Peringkat persentil terhadap ${peerCount} emiten di subsector ${subsector} dengan data lengkap`
              : 'Threshold absolut — data peer tidak tersedia'}
            rows={valueRows}
          />
        </div>
      </div>
    </div>
  )
}
