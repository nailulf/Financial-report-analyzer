import type { StockHeader, StockMetrics, PricePoint } from '@/lib/types/api'
import { formatIDRCompact, formatPercent, formatMultiple, fmtNumID } from '@/lib/calculations/formatters'

interface Props {
  header: StockHeader
  metrics: StockMetrics | null
  priceHistory: PricePoint[]
}

function fmtVol(v: number | null): string {
  if (!v) return '—'
  return v >= 1_000_000 ? `${(v / 1_000_000).toFixed(1)}M` : `${(v / 1_000).toFixed(0)}K`
}

function fmtPrice(v: number | null): string {
  if (!v) return '—'
  return `Rp ${fmtNumID(v)}`
}

export function HeroBar({ header, metrics, priceHistory }: Props) {
  const latest  = priceHistory.at(-1)
  const prev    = priceHistory.at(-2)
  const price   = latest?.close ?? metrics?.price ?? null
  const prevPx  = prev?.close ?? null
  const delta   = price != null && prevPx != null ? price - prevPx : null
  const pct     = delta != null && prevPx ? (delta / prevPx) * 100 : null
  const pos     = (pct ?? 0) >= 0

  const closes  = priceHistory.map((p) => p.close).filter((c): c is number => c != null)
  const low52   = closes.length ? Math.min(...closes) : null
  const high52  = closes.length ? Math.max(...closes) : null

  const priceColor = pos ? 'text-[#00FF88]' : 'text-red-400'

  const stats = [
    { label: 'KAP. PASAR', value: header.market_cap ? formatIDRCompact(header.market_cap) : '—' },
    { label: 'VOL',         value: fmtVol(latest?.volume ?? null) },
    { label: 'P/E',         value: metrics?.pe_ratio  ? formatMultiple(metrics.pe_ratio)  : '—' },
    { label: 'ROE',         value: metrics?.roe        ? formatPercent(metrics.roe)        : '—' },
    { label: '52M',         value: low52 && high52 ? `${fmtNumID(low52)}–${fmtNumID(high52)}` : '—' },
    { label: 'BETA',        value: '—' },
  ]

  return (
    <div className="bg-white border-b border-[#E0E0E5] h-20 flex items-center justify-between px-12">
      {/* Ticker + name */}
      <div className="flex flex-col gap-0.5">
        <span className="font-display text-[32px] font-bold text-[#1A1A1A] tracking-[-1px] leading-none">
          {header.ticker}
        </span>
        <span className="font-mono text-[13px] font-medium text-[#555555] tracking-[0.5px] uppercase">
          {header.name}
        </span>
      </div>

      {/* Price + change */}
      <div className="flex flex-col items-end gap-1.5">
        <span className={`font-display text-[32px] font-bold tracking-[-1px] leading-none ${priceColor}`}>
          {fmtPrice(price)}
        </span>
        {delta != null && pct != null && (
          <span className={`font-mono text-[15px] font-semibold ${priceColor}`}>
            {delta >= 0 ? '+' : ''}{fmtNumID(delta)} ({pct >= 0 ? '+' : ''}{pct.toFixed(2)}%)
          </span>
        )}
      </div>

      {/* Quick stats row */}
      <div className="flex items-center gap-1">
        {stats.map((s, i) => (
          <span key={s.label} className="flex items-center gap-1 font-mono text-[13px] font-medium tracking-[0.5px]">
            <span className="text-[#555555]">{s.label}:</span>
            <span className="text-[#555555]">{s.value}</span>
            {i < stats.length - 1 && (
              <span className="text-[#2f2f2f] mx-1">|</span>
            )}
          </span>
        ))}
      </div>
    </div>
  )
}
