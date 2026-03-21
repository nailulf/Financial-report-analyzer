import { Suspense } from 'react'
import { getComparisonStocks } from '@/lib/queries/comparison'
import { TickerSelector } from '@/components/compare/ticker-selector'
import { ComparisonMetricsGrid } from '@/components/compare/comparison-metrics-grid'
import { ComparisonCharts } from '@/components/compare/comparison-charts'
import { Card } from '@/components/ui/card'

interface PageProps {
  searchParams: Promise<{ tickers?: string }>
}

export default async function ComparePage({ searchParams }: PageProps) {
  const { tickers: tickersParam } = await searchParams
  const tickers = (tickersParam ?? '')
    .split(',')
    .map((t) => t.trim().toUpperCase())
    .filter(Boolean)
    .slice(0, 5)

  const stocks = tickers.length >= 1 ? await getComparisonStocks(tickers) : []

  return (
    <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Peer Comparison</h1>
        <p className="text-sm text-gray-500 mt-1">Compare key metrics side by side</p>
      </div>

      <Suspense>
        <TickerSelector selected={tickers} />
      </Suspense>

      {stocks.length >= 2 ? (
        <div className="space-y-6">
          <Card title="Key Metrics">
            <ComparisonMetricsGrid stocks={stocks} />
          </Card>
          <ComparisonCharts stocks={stocks} />
        </div>
      ) : stocks.length === 1 ? (
        <p className="text-sm text-gray-400 mt-4">Add at least one more stock to compare.</p>
      ) : null}
    </main>
  )
}
