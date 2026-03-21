import type { QuarterlyFinancial } from '@/lib/types/api'
import { formatIDRCompact, formatPercent, formatNumber } from '@/lib/calculations/formatters'

function qLabel(year: number, quarter: number) {
  return `Q${quarter} ${year}`
}

function growthColor(current: number | null, prev: number | null): string {
  if (current == null || prev == null || prev === 0) return 'text-gray-500'
  return current > prev ? 'text-green-600' : 'text-red-500'
}

function growthPct(current: number | null, prev: number | null): string {
  if (current == null || prev == null || prev === 0) return ''
  const pct = ((current - prev) / Math.abs(prev)) * 100
  const sign = pct >= 0 ? '+' : ''
  return ` (${sign}${pct.toFixed(0)}%)`
}

interface Props {
  data: QuarterlyFinancial[]
}

export function QuarterlyTable({ data }: Props) {
  if (data.length === 0) {
    return (
      <div className="bg-white rounded-xl border border-gray-200 p-6">
        <h2 className="text-sm font-semibold text-gray-700 mb-3">Quarterly Financials</h2>
        <p className="text-sm text-gray-400">No quarterly data available.</p>
      </div>
    )
  }

  // data is newest-first from query; display newest left
  const rows = data

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-6">
      <h2 className="text-sm font-semibold text-gray-700 mb-4">Quarterly Financials</h2>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100">
              <th className="text-left py-2 pr-4 font-medium text-gray-500 whitespace-nowrap">Metric</th>
              {rows.map((r) => (
                <th key={`${r.year}-${r.quarter}`} className="text-right py-2 px-3 font-medium text-gray-700 whitespace-nowrap">
                  {qLabel(r.year, r.quarter)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            <tr>
              <td className="py-2 pr-4 text-gray-500 whitespace-nowrap">Revenue</td>
              {rows.map((r, i) => (
                <td key={i} className={`py-2 px-3 text-right font-mono whitespace-nowrap ${growthColor(r.revenue, rows[i + 1]?.revenue ?? null)}`}>
                  {formatIDRCompact(r.revenue)}
                  <span className="text-xs font-normal">{growthPct(r.revenue, rows[i + 1]?.revenue ?? null)}</span>
                </td>
              ))}
            </tr>
            <tr>
              <td className="py-2 pr-4 text-gray-500 whitespace-nowrap">Gross Profit</td>
              {rows.map((r, i) => (
                <td key={i} className={`py-2 px-3 text-right font-mono whitespace-nowrap ${growthColor(r.gross_profit, rows[i + 1]?.gross_profit ?? null)}`}>
                  {formatIDRCompact(r.gross_profit)}
                </td>
              ))}
            </tr>
            <tr>
              <td className="py-2 pr-4 text-gray-500 whitespace-nowrap">Net Income</td>
              {rows.map((r, i) => (
                <td key={i} className={`py-2 px-3 text-right font-mono whitespace-nowrap ${growthColor(r.net_income, rows[i + 1]?.net_income ?? null)}`}>
                  {formatIDRCompact(r.net_income)}
                  <span className="text-xs font-normal">{growthPct(r.net_income, rows[i + 1]?.net_income ?? null)}</span>
                </td>
              ))}
            </tr>
            <tr>
              <td className="py-2 pr-4 text-gray-500 whitespace-nowrap">Net Margin</td>
              {rows.map((r, i) => (
                <td key={i} className={`py-2 px-3 text-right font-mono whitespace-nowrap ${growthColor(r.net_margin, rows[i + 1]?.net_margin ?? null)}`}>
                  {formatPercent(r.net_margin)}
                </td>
              ))}
            </tr>
            <tr>
              <td className="py-2 pr-4 text-gray-500 whitespace-nowrap">ROE</td>
              {rows.map((r, i) => (
                <td key={i} className={`py-2 px-3 text-right font-mono whitespace-nowrap ${growthColor(r.roe, rows[i + 1]?.roe ?? null)}`}>
                  {formatPercent(r.roe)}
                </td>
              ))}
            </tr>
            <tr>
              <td className="py-2 pr-4 text-gray-500 whitespace-nowrap">EPS</td>
              {rows.map((r) => (
                <td key={`${r.year}-${r.quarter}`} className="py-2 px-3 text-right font-mono text-gray-700 whitespace-nowrap">
                  {formatNumber(r.eps)}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  )
}
