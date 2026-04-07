import { Suspense } from 'react'
import { getScreenerRows } from '@/lib/queries/stocks'
import { StockTable } from '@/components/home/stock-table'
import { SectorFilter } from '@/components/home/sector-filter'
import { ScreenerFilters } from '@/components/home/screener-filters'
import { WatchlistBar } from '@/components/home/watchlist-bar'
import { PAGE_SIZE } from '@/lib/constants'

// All filter param keys (excluding sort/dir/page/sector which are handled separately)
const NUMERIC_PARAMS = [
  'minRoe', 'maxPe', 'maxPbv', 'minNetMargin', 'minDivYield',
  'minDivAvg3yr', 'minDivAvg5yr',
  'minRevCagr3yr', 'minRevCagr5yr', 'minPriceCagr3yr', 'minPriceCagr5yr',
  'minMktCap', 'minCompleteness', 'minConfidence',
] as const

const STRING_PARAMS = ['sector', 'board', 'phase'] as const

interface PageProps {
  searchParams: Promise<Record<string, string | undefined>>
}

export default async function HomePage({ searchParams }: PageProps) {
  const sp = await searchParams
  const page    = Math.max(1, Number(sp.page ?? 1))
  const sortBy  = sp.sort ?? 'ticker'
  const sortDir = (sp.dir === 'asc' ? 'asc' : sp.dir === 'desc' ? 'desc' : sp.sort ? 'desc' : 'asc') as 'asc' | 'desc'

  // Build filters object
  const filters: Record<string, string | number | undefined> = { sortBy, sortDir }
  for (const key of STRING_PARAMS) {
    if (sp[key]) filters[key] = sp[key]
  }
  for (const key of NUMERIC_PARAMS) {
    if (sp[key]) filters[key] = Number(sp[key])
  }

  const { rows, total } = await getScreenerRows(filters, page)
  const totalPages = Math.ceil(total / PAGE_SIZE)

  // baseParams: all active filters except sort/dir/page (for sort header link building)
  const baseParams: Record<string, string> = {}
  for (const key of [...STRING_PARAMS, ...NUMERIC_PARAMS]) {
    if (sp[key]) baseParams[key] = sp[key]!
  }

  const paginationParams = { ...baseParams, sort: sortBy, dir: sortDir }

  return (
    <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">IDX Stock Screener</h1>
        <p className="text-sm text-gray-500 mt-1">{total.toLocaleString()} stocks</p>
      </div>

      <Suspense>
        <WatchlistBar />
      </Suspense>

      <div className="mb-4">
        <Suspense>
          <SectorFilter current={sp.sector} />
        </Suspense>
      </div>

      <Suspense>
        <ScreenerFilters />
      </Suspense>

      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <StockTable
          rows={rows}
          sortBy={sortBy}
          sortDir={sortDir}
          baseParams={baseParams}
          page={page}
          total={total}
          totalPages={totalPages}
          paginationParams={paginationParams}
        />
      </div>
    </main>
  )
}
