import type { CAGRResult } from '@/lib/types/api'
import { Card } from '@/components/ui/card'

function cagrClass(v: number | null) {
  if (v === null) return 'text-[#9C9B99]'
  if (v >= 10) return 'text-[#3D8A5A] font-semibold'
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
            <tr className="border-b border-[#E5E4E1] bg-[#F5F4F1]">
              <th className="text-left px-6 py-3 text-xs font-semibold text-[#9C9B99] uppercase tracking-wide">Metric</th>
              <th className="text-right px-6 py-3 text-xs font-semibold text-[#9C9B99] uppercase tracking-wide">3-Year</th>
              <th className="text-right px-6 py-3 text-xs font-semibold text-[#9C9B99] uppercase tracking-wide">5-Year</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#E5E4E1]">
            {results.map((r) => (
              <tr key={r.metric} className="hover:bg-[#F5F4F1]/60 transition-colors">
                <td className="px-6 py-3.5 font-medium text-[#1A1918]">{r.label}</td>
                <td className={`px-6 py-3.5 text-right font-mono ${cagrClass(r.cagr_3yr)}`}>{fmt(r.cagr_3yr)}</td>
                <td className={`px-6 py-3.5 text-right font-mono ${cagrClass(r.cagr_5yr)}`}>{fmt(r.cagr_5yr)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  )
}
