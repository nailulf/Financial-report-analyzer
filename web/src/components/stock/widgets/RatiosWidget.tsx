import type { StockMetrics, FinancialYear } from '@/lib/types/api'
import { formatMultiple, formatPercent, formatNumber } from '@/lib/calculations/formatters'

interface Props {
  ticker: string
  metrics: StockMetrics | null
  latestYear: FinancialYear | null
}

interface RatioRow {
  metric: string
  stock: string
  industry: string
  market: string
}

export function RatiosWidget({ ticker, metrics, latestYear }: Props) {
  const rows: RatioRow[] = [
    {
      metric: 'P/E RATIO',
      stock: metrics?.pe_ratio ? formatMultiple(metrics.pe_ratio) : '—',
      industry: '—', market: '—',
    },
    {
      metric: 'P/BV RATIO',
      stock: metrics?.pbv_ratio ? formatMultiple(metrics.pbv_ratio) : '—',
      industry: '—', market: '—',
    },
    {
      metric: 'ROE',
      stock: (latestYear?.roe ?? metrics?.roe) != null
        ? formatPercent(latestYear?.roe ?? metrics!.roe!)
        : '—',
      industry: '—', market: '—',
    },
    {
      metric: 'ROA',
      stock: latestYear?.roa ? formatPercent(latestYear.roa) : '—',
      industry: '—', market: '—',
    },
    {
      metric: 'NET MARGIN',
      stock: latestYear?.net_margin ? formatPercent(latestYear.net_margin) : '—',
      industry: '—', market: '—',
    },
    {
      metric: 'GROSS MARGIN',
      stock: latestYear?.gross_margin ? formatPercent(latestYear.gross_margin) : '—',
      industry: '—', market: '—',
    },
    {
      metric: 'DEBT / EQUITY',
      stock: latestYear?.debt_to_equity ? formatNumber(latestYear.debt_to_equity) : '—',
      industry: '—', market: '—',
    },
    {
      metric: 'CURRENT RATIO',
      stock: latestYear?.current_ratio ? formatNumber(latestYear.current_ratio) : '—',
      industry: '—', market: '—',
    },
    {
      metric: 'DIVIDEND YIELD',
      stock: metrics?.dividend_yield ? formatPercent(metrics.dividend_yield) : '—',
      industry: '—', market: '—',
    },
  ]

  return (
    <div className="px-8 py-2">
      <div className="bg-white border border-[#E0E0E5] flex flex-col">
        <div className="px-5 py-3 border-b border-[#E0E0E5]">
          <span className="font-mono text-[11px] font-bold tracking-[0.5px] text-[#1A1A1A]">
            KEY RATIOS — {ticker} vs INDUSTRY vs MARKET
          </span>
        </div>

        {/* Column headers */}
        <div className="flex items-center bg-[#F5F5F8] px-3 py-2">
          <span className="font-mono text-[9px] font-bold text-[#888888] tracking-[0.5px] flex-1">METRIC</span>
          <span className="font-mono text-[9px] font-bold text-[#888888] tracking-[0.5px] w-24 text-right">{ticker}</span>
          <span className="font-mono text-[9px] font-bold text-[#888888] tracking-[0.5px] w-28 text-right">INDUSTRY AVG</span>
          <span className="font-mono text-[9px] font-bold text-[#888888] tracking-[0.5px] w-24 text-right">MARKET</span>
        </div>

        {rows.map((row, i) => (
          <div key={i} className="flex items-center px-3 py-2 border-b border-[#E0E0E5] last:border-0">
            <span className="font-mono text-[11px] text-[#555555] tracking-[0.5px] flex-1">{row.metric}</span>
            <span className={`font-mono text-[11px] w-24 text-right ${
              row.stock !== '—' ? 'font-semibold text-[#1A1A1A]' : 'text-[#888888]'
            }`}>
              {row.stock}
            </span>
            <span className="font-mono text-[11px] text-[#888888] w-28 text-right">{row.industry}</span>
            <span className="font-mono text-[11px] text-[#888888] w-24 text-right">{row.market}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
