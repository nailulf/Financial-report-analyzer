import Link from 'next/link'
import type { ScreenerRow } from '@/lib/types/api'
import { Badge } from '@/components/ui/badge'
import { formatIDRCompact, formatPercent, formatMultiple } from '@/lib/calculations/formatters'
import { WatchlistStar } from '@/components/home/watchlist-star'

interface StockTableProps {
  rows: ScreenerRow[]
  sortBy: string
  sortDir: 'asc' | 'desc'
  baseParams: Record<string, string>
  page: number
  total: number
  totalPages: number
  paginationParams: Record<string, string>
}

function SortHeader({
  col, label, sortBy, sortDir, baseParams,
}: {
  col: string; label: string; sortBy: string; sortDir: 'asc' | 'desc'; baseParams: Record<string, string>
}) {
  const isActive = sortBy === col
  const nextDir = isActive && sortDir === 'desc' ? 'asc' : 'desc'
  const params = new URLSearchParams({ ...baseParams, sort: col, dir: nextDir })
  const arrow = isActive ? (sortDir === 'desc' ? ' ↓' : ' ↑') : ''
  return (
    <th className="text-right px-4 py-3 text-xs font-semibold uppercase tracking-wide">
      <Link
        href={`/?${params.toString()}`}
        className={`hover:text-blue-600 transition-colors ${isActive ? 'text-blue-600' : 'text-gray-500'}`}
      >
        {label}{arrow}
      </Link>
    </th>
  )
}

export function StockTable({
  rows,
  sortBy,
  sortDir,
  baseParams,
  page,
  total,
  totalPages,
  paginationParams,
}: StockTableProps) {
  if (rows.length === 0) {
    return (
      <div className="text-center py-16 text-gray-400">
        <p className="text-lg">No stocks found</p>
        <p className="text-sm mt-1">Try adjusting your filters or search for a specific ticker</p>
      </div>
    )
  }

  const shProps = { sortBy, sortDir, baseParams }
  const pageStart = Math.max(1, page - 2)
  const pageEnd = Math.min(totalPages, page + 2)
  const pageNumbers = Array.from({ length: pageEnd - pageStart + 1 }, (_, i) => pageStart + i)

  return (
    <div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-gray-200 bg-gray-50">
            <th className="w-8 px-4 py-3"></th>
            <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Ticker</th>
            <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Company</th>
            <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Sector</th>
            <SortHeader col="price"      label="Price"      {...shProps} />
            <SortHeader col="pe_ratio"   label="P/E"        {...shProps} />
            <SortHeader col="pbv_ratio"  label="P/BV"       {...shProps} />
            <SortHeader col="roe"        label="ROE"        {...shProps} />
            <SortHeader col="net_margin" label="Net Margin" {...shProps} />
            <SortHeader col="market_cap" label="Mkt Cap"    {...shProps} />
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {rows.map((row) => (
            <tr key={row.ticker} className="hover:bg-gray-50 transition-colors">
              <td className="px-4 py-3">
                <WatchlistStar ticker={row.ticker} />
              </td>
              <td className="px-4 py-3">
                <div className="flex items-center gap-2">
                  <Link
                    href={`/stock/${row.ticker}`}
                    className="font-mono font-bold text-blue-600 hover:text-blue-800 hover:underline"
                  >
                    {row.ticker}
                  </Link>
                  {row.is_lq45 && <Badge variant="amber" size="xs">LQ45</Badge>}
                  {row.is_idx30 && <Badge variant="purple" size="xs">IDX30</Badge>}
                </div>
              </td>
              <td className="px-4 py-3 text-gray-700 max-w-[180px] truncate">{row.name ?? '—'}</td>
              <td className="px-4 py-3">
                {row.sector && <Badge variant="blue">{row.sector}</Badge>}
              </td>
              <td className="px-4 py-3 text-right font-medium text-gray-900">
                {row.price != null ? `Rp${row.price.toLocaleString('id-ID')}` : '—'}
              </td>
              <td className="px-4 py-3 text-right text-gray-600">{formatMultiple(row.pe_ratio)}</td>
              <td className="px-4 py-3 text-right text-gray-600">{formatMultiple(row.pbv_ratio)}</td>
              <td className={`px-4 py-3 text-right font-medium ${
                row.roe != null && row.roe >= 15 ? 'text-green-600' :
                row.roe != null && row.roe >= 8  ? 'text-amber-600' :
                row.roe != null                  ? 'text-red-500'   : 'text-gray-400'
              }`}>
                {formatPercent(row.roe)}
              </td>
              <td className={`px-4 py-3 text-right ${
                row.net_margin != null && row.net_margin >= 10 ? 'text-green-600' :
                row.net_margin != null && row.net_margin >= 5  ? 'text-amber-600' :
                row.net_margin != null                         ? 'text-red-500'   : 'text-gray-400'
              }`}>
                {formatPercent(row.net_margin)}
              </td>
              <td className="px-4 py-3 text-right text-gray-600">{formatIDRCompact(row.market_cap)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>

      {totalPages > 1 && (
        <div className="px-4 py-3 border-t border-gray-200 flex items-center justify-between text-sm text-gray-500">
          <span>Page {page} of {totalPages} ({total.toLocaleString()} stocks)</span>
          <div className="flex items-center gap-1.5">
            {page > 1 && (
              <Link
                href={`/?${new URLSearchParams({ ...paginationParams, page: String(page - 1) })}`}
                className="px-3 py-1.5 rounded-lg border border-gray-300 hover:bg-gray-50 transition-colors"
              >
                ← Prev
              </Link>
            )}

            {pageStart > 1 && (
              <>
                <Link
                  href={`/?${new URLSearchParams({ ...paginationParams, page: '1' })}`}
                  className="px-3 py-1.5 rounded-lg border border-gray-300 hover:bg-gray-50 transition-colors"
                >
                  1
                </Link>
                {pageStart > 2 && <span className="px-1 text-gray-400">…</span>}
              </>
            )}

            {pageNumbers.map((p) => (
              <Link
                key={p}
                href={`/?${new URLSearchParams({ ...paginationParams, page: String(p) })}`}
                className={`px-3 py-1.5 rounded-lg border transition-colors ${
                  p === page
                    ? 'border-blue-600 bg-blue-600 text-white'
                    : 'border-gray-300 hover:bg-gray-50'
                }`}
              >
                {p}
              </Link>
            ))}

            {pageEnd < totalPages && (
              <>
                {pageEnd < totalPages - 1 && <span className="px-1 text-gray-400">…</span>}
                <Link
                  href={`/?${new URLSearchParams({ ...paginationParams, page: String(totalPages) })}`}
                  className="px-3 py-1.5 rounded-lg border border-gray-300 hover:bg-gray-50 transition-colors"
                >
                  {totalPages}
                </Link>
              </>
            )}

            {page < totalPages && (
              <Link
                href={`/?${new URLSearchParams({ ...paginationParams, page: String(page + 1) })}`}
                className="px-3 py-1.5 rounded-lg border border-gray-300 hover:bg-gray-50 transition-colors"
              >
                Next →
              </Link>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
