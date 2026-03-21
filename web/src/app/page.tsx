import { Suspense } from 'react'
import { getScreenerRows } from '@/lib/queries/stocks'
import { StockTable } from '@/components/home/stock-table'
import { SectorFilter } from '@/components/home/sector-filter'
import { ScreenerFilters } from '@/components/home/screener-filters'
import { WatchlistBar } from '@/components/home/watchlist-bar'
import { PAGE_SIZE } from '@/lib/constants'

interface PageProps {
  searchParams: Promise<{
    sector?: string; page?: string; sort?: string; dir?: string
    minRoe?: string; maxPe?: string; maxPbv?: string
    minNetMargin?: string; minDivYield?: string; board?: string
  }>
}

export default async function HomePage({ searchParams }: PageProps) {
  const sp = await searchParams
  const page    = Math.max(1, Number(sp.page ?? 1))
  const sortBy  = sp.sort ?? 'ticker'
  const sortDir = (sp.dir === 'asc' ? 'asc' : sp.dir === 'desc' ? 'desc' : sp.sort ? 'desc' : 'asc') as 'asc' | 'desc'

  const filters = {
    sector:       sp.sector,
    board:        sp.board,
    minRoe:       sp.minRoe       ? Number(sp.minRoe)       : undefined,
    maxPe:        sp.maxPe        ? Number(sp.maxPe)        : undefined,
    maxPbv:       sp.maxPbv       ? Number(sp.maxPbv)       : undefined,
    minNetMargin: sp.minNetMargin ? Number(sp.minNetMargin) : undefined,
    minDivYield:  sp.minDivYield  ? Number(sp.minDivYield)  : undefined,
    sortBy,
    sortDir,
  }

  const { rows, total } = await getScreenerRows(filters, page)
  const totalPages = Math.ceil(total / PAGE_SIZE)

  // baseParams: all active filters except sort/dir/page (for sort header link building)
  const baseParams: Record<string, string> = {}
  if (sp.sector)       baseParams.sector       = sp.sector
  if (sp.board)        baseParams.board        = sp.board
  if (sp.minRoe)       baseParams.minRoe       = sp.minRoe
  if (sp.maxPe)        baseParams.maxPe        = sp.maxPe
  if (sp.maxPbv)       baseParams.maxPbv       = sp.maxPbv
  if (sp.minNetMargin) baseParams.minNetMargin = sp.minNetMargin
  if (sp.minDivYield)  baseParams.minDivYield  = sp.minDivYield

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
