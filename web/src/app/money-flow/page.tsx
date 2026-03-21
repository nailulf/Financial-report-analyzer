import { Suspense } from 'react'
import {
  getForeignFlowLeaderboard,
  getVolumeAnomalies,
  getFlowScoreLeaderboard,
  defaultDateRange,
} from '@/lib/queries/money-flow'
import { ForeignFlowChart } from '@/components/money-flow/foreign-flow-chart'
import { BrokerActivitySection } from '@/components/money-flow/broker-activity-section'
import { VolumeAnomalyTable } from '@/components/money-flow/volume-anomaly-table'
import { FlowScoreSection } from '@/components/money-flow/flow-score-section'
import { DateRangePicker } from '@/components/money-flow/date-range-picker'
import { ChartSkeleton } from '@/components/ui/loading-skeleton'

export const metadata = { title: 'Money Flow — IDX Analyzer' }

interface PageProps {
  searchParams: Promise<{
    ticker?: string
    date?: string
    from?: string
    to?: string
    broker_from?: string
    broker_to?: string
  }>
}

function formatRangeLabel(from: string, to: string): string {
  const f = new Date(from + 'T00:00:00')
  const t = new Date(to + 'T00:00:00')
  const fmt = (d: Date) =>
    d.toLocaleDateString('id-ID', { day: 'numeric', month: 'short' })
  return `${fmt(f)} – ${fmt(t)}`
}

export default async function MoneyFlowPage({ searchParams }: PageProps) {
  const { ticker, date, from: fromParam, to: toParam, broker_from, broker_to } = await searchParams

  // Global range (affects foreign flow leaderboard)
  const { from: defaultFrom, to: defaultTo } = defaultDateRange()
  const from = fromParam ?? defaultFrom
  const to   = toParam   ?? defaultTo
  const isRangeFiltered = fromParam != null || toParam != null
  const rangeLabel = formatRangeLabel(from, to)

  // Broker-specific range (independent — falls back to global range)
  const brokerFrom = broker_from ?? from
  const brokerTo   = broker_to   ?? to
  const brokerRangeLabel = formatRangeLabel(brokerFrom, brokerTo)

  const [
    { buyers, sellers, isRangeMode },
    anomalies,
    { bullish, bearish },
  ] = await Promise.all([
    getForeignFlowLeaderboard(15, isRangeFiltered ? from : undefined, isRangeFiltered ? to : undefined),
    getVolumeAnomalies(25),
    getFlowScoreLeaderboard(15),
  ])

  const hasForeignData = buyers.length > 0 || sellers.length > 0

  return (
    <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">

      {/* Page header + date range picker */}
      <div className="flex items-start justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Money Flow</h1>
          <p className="text-sm text-gray-500 mt-1">
            Foreign investor flow, volume anomalies, and composite flow scores across IDX
          </p>
        </div>
        <DateRangePicker from={from} to={to} ticker={ticker} />
      </div>

      {/* Flow Score Leaderboard — always shows current signals */}
      <div>
        <p className="text-xs text-gray-400 mb-2 flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-gray-300 inline-block" />
          Flow Score reflects current market signals (not affected by date range filter)
        </p>
        <FlowScoreSection bullish={bullish} bearish={bearish} />
      </div>

      {/* Volume Anomaly — always shows current trading day */}
      <div>
        <p className="text-xs text-gray-400 mb-2 flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-gray-300 inline-block" />
          Volume anomaly always shows the most recent trading day
        </p>
        <VolumeAnomalyTable rows={anomalies} />
      </div>

      {/* Foreign Flow — respects date range */}
      {hasForeignData ? (
        <ForeignFlowChart
          buyers={buyers}
          sellers={sellers}
          rangeLabel={isRangeMode ? rangeLabel : undefined}
        />
      ) : (
        <div className="bg-white rounded-xl border border-gray-200 p-10 text-center text-gray-400">
          <p className="text-sm">No foreign flow data for this period.</p>
          <p className="text-xs mt-1">
            Run{' '}
            <code className="bg-gray-100 px-1 rounded">python run_all.py --daily</code>{' '}
            to populate data.
          </p>
        </div>
      )}

      {/* Broker Activity — independent date range filter */}
      <Suspense fallback={<ChartSkeleton height={300} />}>
        <BrokerActivitySection
          ticker={ticker?.toUpperCase()}
          date={date}
          from={brokerFrom}
          to={brokerTo}
          rangeLabel={brokerRangeLabel}
        />
      </Suspense>
    </main>
  )
}
