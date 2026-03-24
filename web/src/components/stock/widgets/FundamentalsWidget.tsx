import type { StockMetrics, FinancialYear } from '@/lib/types/api'
import { formatMultiple, formatPercent, formatNumber, fmtNumID } from '@/lib/calculations/formatters'

interface Props {
  ticker:     string
  metrics:    StockMetrics | null
  latestYear: FinancialYear | null
}

interface Row {
  label:    string
  stock:    string
  industry: string
  market:   string
}

export function FundamentalsWidget({ ticker, metrics, latestYear }: Props) {
  const rows: Row[] = [
    {
      label:    'P/E RATIO',
      stock:    metrics?.pe_ratio            ? formatMultiple(metrics.pe_ratio)            : '—',
      industry: '—', market: '—',
    },
    {
      label:    'P/BV RATIO',
      stock:    metrics?.pbv_ratio           ? formatMultiple(metrics.pbv_ratio)           : '—',
      industry: '—', market: '—',
    },
    {
      label:    'EPS',
      stock:    metrics?.eps                 ? `Rp ${fmtNumID(metrics.eps)}` : '—',
      industry: '—', market: '—',
    },
    {
      label:    'NILAI BUKU / LBR',
      stock:    metrics?.book_value_per_share ? `Rp ${fmtNumID(metrics.book_value_per_share)}` : '—',
      industry: '—', market: '—',
    },
    {
      label:    'ROE',
      stock:    (latestYear?.roe ?? metrics?.roe) != null
                  ? formatPercent(latestYear?.roe ?? metrics!.roe!)
                  : '—',
      industry: '—', market: '—',
    },
    {
      label:    'ROA',
      stock:    latestYear?.roa              ? formatPercent(latestYear.roa)               : '—',
      industry: '—', market: '—',
    },
    {
      label:    'MARGIN BERSIH',
      stock:    latestYear?.net_margin       ? formatPercent(latestYear.net_margin)        : '—',
      industry: '—', market: '—',
    },
    {
      label:    'MARGIN KOTOR',
      stock:    latestYear?.gross_margin     ? formatPercent(latestYear.gross_margin)      : '—',
      industry: '—', market: '—',
    },
    {
      label:    'RASIO LANCAR',
      stock:    latestYear?.current_ratio    ? formatNumber(latestYear.current_ratio)      : '—',
      industry: '—', market: '—',
    },
    {
      label:    'D/E RATIO',
      stock:    latestYear?.debt_to_equity   ? formatNumber(latestYear.debt_to_equity)     : '—',
      industry: '—', market: '—',
    },
    {
      label:    'DIVIDEN YIELD',
      stock:    metrics?.dividend_yield      ? formatPercent(metrics.dividend_yield)       : '—',
      industry: '—', market: '—',
    },
  ]

  return (
    <div className="bg-white border border-[#E0E0E5] flex flex-col">
      {/* Header */}
      <div className="px-5 py-3 border-b border-[#E0E0E5] flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[13px] font-bold tracking-[0.5px] text-[#1A1A1A]">METRIK UTAMA</span>
          {metrics?.financial_year && (
            <span className="font-mono text-[11px] text-[#888888]">FY{metrics.financial_year}</span>
          )}
        </div>
        <span className="font-mono text-[11px] text-[#888888]">{ticker} vs INDUSTRI vs PASAR</span>
      </div>

      {/* Column headers */}
      <div className="flex items-center bg-[#F5F5F8] px-3 py-2">
        <span className="font-mono text-[11px] font-bold text-[#888888] tracking-[0.5px] flex-1">METRIK</span>
        <span className="font-mono text-[11px] font-bold text-[#888888] tracking-[0.5px] w-28 text-right">{ticker}</span>
        <span className="font-mono text-[11px] font-bold text-[#888888] tracking-[0.5px] w-28 text-right">INDUSTRI</span>
        <span className="font-mono text-[11px] font-bold text-[#888888] tracking-[0.5px] w-20 text-right">PASAR</span>
      </div>

      {/* Rows */}
      {rows.map((row) => (
        <div key={row.label} className="flex items-center px-3 py-2 border-b border-[#E0E0E5] last:border-0">
          <span className="font-mono text-[12px] text-[#555555] tracking-[0.5px] uppercase flex-1">{row.label}</span>
          <span className={`font-mono text-[13px] w-28 text-right ${
            row.stock !== '—' ? 'font-semibold text-[#1A1A1A]' : 'text-[#888888]'
          }`}>
            {row.stock}
          </span>
          <span className="font-mono text-[13px] text-[#888888] w-28 text-right">{row.industry}</span>
          <span className="font-mono text-[13px] text-[#888888] w-20 text-right">{row.market}</span>
        </div>
      ))}
    </div>
  )
}
