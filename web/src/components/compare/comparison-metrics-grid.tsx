import type { ComparisonStock } from '@/lib/types/api'
import { formatPercent, formatMultiple, formatIDRCompact, formatNumber } from '@/lib/calculations/formatters'

interface Props { stocks: ComparisonStock[] }

const ROWS: Array<{ label: string; key: keyof ComparisonStock; fmt: (v: number) => string }> = [
  { label: 'Price',           key: 'price',          fmt: (v) => `Rp${v.toLocaleString('id-ID')}` },
  { label: 'P/E',             key: 'pe_ratio',       fmt: (v) => formatMultiple(v) },
  { label: 'P/BV',            key: 'pbv_ratio',      fmt: (v) => formatMultiple(v) },
  { label: 'ROE',             key: 'roe',            fmt: (v) => formatPercent(v) },
  { label: 'ROA',             key: 'roa',            fmt: (v) => formatPercent(v) },
  { label: 'Net Margin',      key: 'net_margin',     fmt: (v) => formatPercent(v) },
  { label: 'Debt / Equity',   key: 'debt_to_equity', fmt: (v) => formatNumber(v) },
  { label: 'Current Ratio',   key: 'current_ratio',  fmt: (v) => formatNumber(v) },
  { label: 'Dividend Yield',  key: 'dividend_yield', fmt: (v) => formatPercent(v) },
  { label: 'Revenue',         key: 'revenue',        fmt: (v) => formatIDRCompact(v) },
  { label: 'Net Income',      key: 'net_income',     fmt: (v) => formatIDRCompact(v) },
  { label: 'Market Cap',      key: 'market_cap',     fmt: (v) => formatIDRCompact(v) },
]

function bestValue(values: (number | null)[], key: string, invert = false): number | null {
  const nums = values.filter((v): v is number => v !== null)
  if (!nums.length) return null
  return invert ? Math.min(...nums) : Math.max(...nums)
}

const INVERT_BETTER = new Set(['debt_to_equity', 'pe_ratio', 'pbv_ratio'])

export function ComparisonMetricsGrid({ stocks }: Props) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-gray-200 bg-gray-50">
            <th className="text-left px-5 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide w-36">Metric</th>
            {stocks.map((s) => (
              <th key={s.ticker} className="text-right px-5 py-3 text-xs font-semibold text-gray-700 uppercase tracking-wide">
                <div className="font-mono">{s.ticker}</div>
                <div className="text-gray-400 font-normal normal-case">{s.sector}</div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {ROWS.map(({ label, key, fmt }) => {
            const values = stocks.map((s) => s[key] as number | null)
            const best = bestValue(values, key, INVERT_BETTER.has(key))
            return (
              <tr key={key} className="hover:bg-gray-50">
                <td className="px-5 py-3 font-medium text-gray-600">{label}</td>
                {stocks.map((s, i) => {
                  const v = s[key] as number | null
                  const isBest = v !== null && v === best && stocks.length > 1
                  return (
                    <td key={s.ticker} className={`px-5 py-3 text-right font-medium ${isBest ? 'text-green-600' : 'text-gray-700'}`}>
                      {v !== null ? fmt(v) : '—'}
                    </td>
                  )
                })}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
