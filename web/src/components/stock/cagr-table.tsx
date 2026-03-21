import type { CAGRResult } from '@/lib/types/api'
import { Card } from '@/components/ui/card'

function cagrClass(v: number | null) {
  if (v === null) return 'text-gray-400'
  if (v >= 10) return 'text-green-600 font-semibold'
  if (v >= 5)  return 'text-amber-600 font-medium'
  return 'text-red-600'
}

function fmt(v: number | null) {
  if (v === null) return '—'
  return `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`
}

export function CAGRTable({ results }: { results: CAGRResult[] }) {
  if (results.length === 0) return null

  return (
    <Card title="Growth (CAGR)">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100 bg-gray-50">
              <th className="text-left px-5 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Metric</th>
              <th className="text-right px-5 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">3-Year CAGR</th>
              <th className="text-right px-5 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">5-Year CAGR</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {results.map((r) => (
              <tr key={r.metric}>
                <td className="px-5 py-3 font-medium text-gray-700">{r.label}</td>
                <td className={`px-5 py-3 text-right ${cagrClass(r.cagr_3yr)}`}>{fmt(r.cagr_3yr)}</td>
                <td className={`px-5 py-3 text-right ${cagrClass(r.cagr_5yr)}`}>{fmt(r.cagr_5yr)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  )
}
