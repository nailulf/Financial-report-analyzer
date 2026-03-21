import type { StockMetrics } from '@/lib/types/api'
import { MetricCard } from '@/components/ui/metric-card'
import { formatIDRCompact, formatPercent, formatMultiple, formatNumber } from '@/lib/calculations/formatters'

export function MetricsRow({ metrics }: { metrics: StockMetrics }) {
  const price = metrics.price != null
    ? `Rp${metrics.price.toLocaleString('id-ID')}`
    : '—'

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4 mb-6">
      <MetricCard
        label="Price"
        value={price}
        sub={metrics.financial_year ? `FY${metrics.financial_year} data` : undefined}
        highlight
      />
      <MetricCard
        label="P/E Ratio"
        value={formatMultiple(metrics.pe_ratio)}
        sub="Price / Earnings"
      />
      <MetricCard
        label="P/BV Ratio"
        value={formatMultiple(metrics.pbv_ratio)}
        sub="Price / Book Value"
      />
      <MetricCard
        label="ROE"
        value={formatPercent(metrics.roe)}
        sub="Return on Equity"
      />
      <MetricCard
        label="Div. Yield"
        value={formatPercent(metrics.dividend_yield)}
        sub="Annual dividend / price"
      />
    </div>
  )
}
