import Link from 'next/link'
import type { VolumeAnomalyRow } from '@/lib/queries/money-flow'

function formatVolume(v: number): string {
  if (v >= 1e9) return `${(v / 1e9).toFixed(1)}M lot`
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}Jt lot`
  if (v >= 1e3) return `${(v / 1e3).toFixed(0)}K lot`
  return `${v.toLocaleString('id-ID')} lot`
}

function RatioBar({ ratio }: { ratio: number }) {
  // Bar fills to max=6x, capped visually
  const pct = Math.min((ratio / 6) * 100, 100)
  const color =
    ratio >= 5 ? 'bg-red-500' :
    ratio >= 3 ? 'bg-orange-400' :
    'bg-amber-300'

  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 max-w-[80px] h-1.5 bg-gray-100 rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className={`text-xs font-bold tabular-nums ${
        ratio >= 5 ? 'text-red-600' : ratio >= 3 ? 'text-orange-600' : 'text-amber-600'
      }`}>
        {ratio.toFixed(1)}×
      </span>
    </div>
  )
}

interface Props {
  rows: VolumeAnomalyRow[]
}

export function VolumeAnomalyTable({ rows }: Props) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-6">
      <div className="flex items-start justify-between mb-5">
        <div>
          <h2 className="text-sm font-semibold text-gray-700">Volume Anomaly</h2>
          <p className="text-xs text-gray-400 mt-0.5">
            Stocks trading at ≥2× their 20-day average volume today
          </p>
        </div>
        <span className="text-xs text-gray-400 bg-gray-50 border border-gray-100 rounded px-2 py-1">
          {rows.length} stocks
        </span>
      </div>

      {rows.length === 0 ? (
        <div className="py-10 text-center text-gray-400 text-sm">
          No volume anomalies today — all stocks trading within normal range.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100">
                <th className="text-left py-2 pr-4 text-xs font-semibold text-gray-500 uppercase tracking-wide w-8">#</th>
                <th className="text-left py-2 pr-4 text-xs font-semibold text-gray-500 uppercase tracking-wide">Ticker</th>
                <th className="text-right py-2 px-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Vol Today</th>
                <th className="text-right py-2 px-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">20D Avg</th>
                <th className="text-left py-2 pl-4 text-xs font-semibold text-gray-500 uppercase tracking-wide w-36">Ratio</th>
                <th className="text-right py-2 pl-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Price</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {rows.map((row, i) => (
                <tr key={row.ticker} className="hover:bg-gray-50">
                  <td className="py-2 pr-4 text-xs text-gray-300 tabular-nums">{i + 1}</td>
                  <td className="py-2 pr-4">
                    <Link
                      href={`/stock/${row.ticker}`}
                      className="font-mono font-bold text-blue-600 hover:underline text-sm"
                    >
                      {row.ticker}
                    </Link>
                    {row.name && (
                      <div className="text-xs text-gray-400 truncate max-w-[140px]">{row.name}</div>
                    )}
                  </td>
                  <td className="py-2 px-3 text-right font-mono text-xs text-gray-700">
                    {formatVolume(row.today_volume / 100)}
                  </td>
                  <td className="py-2 px-3 text-right font-mono text-xs text-gray-400">
                    {formatVolume(row.avg_vol_20d / 100)}
                  </td>
                  <td className="py-2 pl-4">
                    <RatioBar ratio={row.volume_ratio} />
                  </td>
                  <td className="py-2 pl-3 text-right font-mono text-xs text-gray-700">
                    {row.latest_close != null
                      ? row.latest_close.toLocaleString('id-ID')
                      : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
