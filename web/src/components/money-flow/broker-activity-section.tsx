import Link from 'next/link'
import {
  getBrokerDates,
  getBrokerActivity,
  getBrokerActivityRange,
} from '@/lib/queries/money-flow'
import { BrokerSearchForm } from './broker-search-form'
import { DateRangePicker } from './date-range-picker'
import { formatIDRCompact } from '@/lib/calculations/formatters'

function DateButton({ date, active, ticker, from, to }: {
  date: string
  active: boolean
  ticker: string
  from: string
  to: string
}) {
  const label = new Date(date + 'T00:00:00').toLocaleDateString('id-ID', {
    day: 'numeric', month: 'short',
  })
  const params = new URLSearchParams({ ticker, date, from, to })
  return (
    <Link
      href={`/money-flow?${params.toString()}`}
      className={`px-3 py-1 text-xs rounded-lg font-medium transition-colors ${
        active
          ? 'bg-blue-600 text-white'
          : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
      }`}
    >
      {label}
    </Link>
  )
}

interface Props {
  ticker?: string
  date?: string
  from: string
  to: string
}

// ── Range mode table (aggregated buy/sell/net per broker) ─────────────────────
function RangeTable({ rows }: { rows: Awaited<ReturnType<typeof getBrokerActivityRange>> }) {
  if (rows.length === 0) return (
    <div className="py-8 text-center text-gray-400 text-sm">No broker data for this date range</div>
  )

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-gray-100">
            <th className="text-left py-2 pr-4 text-xs font-semibold text-gray-500 uppercase tracking-wide">Broker</th>
            <th className="text-left py-2 pr-4 text-xs font-semibold text-gray-500 uppercase tracking-wide">Name</th>
            <th className="text-right py-2 px-3 text-xs font-semibold text-green-600 uppercase tracking-wide">Buy</th>
            <th className="text-right py-2 px-3 text-xs font-semibold text-red-500 uppercase tracking-wide">Sell</th>
            <th className="text-right py-2 px-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Net</th>
            <th className="text-right py-2 pl-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Freq</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-50">
          {rows.map((row, i) => {
            const net = row.net_value ?? 0
            return (
              <tr key={row.broker_code} className="hover:bg-gray-50">
                <td className="py-2 pr-4">
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-gray-300 w-4">{i + 1}</span>
                    <span className="font-mono font-bold text-gray-800">{row.broker_code}</span>
                  </div>
                </td>
                <td className="py-2 pr-4 text-gray-600 max-w-[180px] truncate text-xs">{row.broker_name ?? '—'}</td>
                <td className="py-2 px-3 text-right font-mono text-xs text-green-600">
                  {row.total_value != null ? formatIDRCompact(row.total_value) : '—'}
                </td>
                <td className="py-2 px-3 text-right font-mono text-xs text-red-500">
                  {row.sell_value != null ? formatIDRCompact(row.sell_value) : '—'}
                </td>
                <td className={`py-2 px-3 text-right font-mono text-xs font-semibold ${
                  net > 0 ? 'text-green-600' : net < 0 ? 'text-red-500' : 'text-gray-400'
                }`}>
                  {net !== 0 ? (net > 0 ? '+' : '') + formatIDRCompact(net) : '—'}
                </td>
                <td className="py-2 pl-3 text-right text-gray-500 text-xs">
                  {row.frequency != null ? row.frequency.toLocaleString('id-ID') : '—'}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ── Single-day table ──────────────────────────────────────────────────────────
function SingleDayTable({ rows }: { rows: Awaited<ReturnType<typeof getBrokerActivity>> }) {
  if (rows.length === 0) return (
    <div className="py-8 text-center text-gray-400 text-sm">No broker data for this date</div>
  )

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-gray-100">
            <th className="text-left py-2 pr-4 text-xs font-semibold text-gray-500 uppercase tracking-wide">Broker</th>
            <th className="text-left py-2 pr-4 text-xs font-semibold text-gray-500 uppercase tracking-wide">Name</th>
            <th className="text-right py-2 px-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Value (IDR)</th>
            <th className="text-right py-2 px-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Volume</th>
            <th className="text-right py-2 pl-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Frequency</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-50">
          {rows.map((row, i) => (
            <tr key={row.broker_code} className="hover:bg-gray-50">
              <td className="py-2 pr-4">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-gray-300 w-4">{i + 1}</span>
                  <span className="font-mono font-bold text-gray-800">{row.broker_code}</span>
                </div>
              </td>
              <td className="py-2 pr-4 text-gray-600 max-w-[200px] truncate text-xs">{row.broker_name ?? '—'}</td>
              <td className="py-2 px-3 text-right font-medium text-gray-900 font-mono">
                {formatIDRCompact(row.total_value)}
              </td>
              <td className="py-2 px-3 text-right text-gray-600 font-mono text-xs">
                {row.total_volume != null ? (row.total_volume / 100).toLocaleString('id-ID') : '—'}
                <span className="text-gray-400 ml-0.5">lot</span>
              </td>
              <td className="py-2 pl-3 text-right text-gray-500 text-xs">
                {row.frequency != null ? row.frequency.toLocaleString('id-ID') : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export async function BrokerActivitySection({ ticker, date, from, to }: Props) {
  const isMultiDay = from !== to

  if (!ticker) {
    return (
      <div className="bg-white rounded-xl border border-gray-200 p-6">
        <div className="flex items-start justify-between flex-wrap gap-4 mb-4">
          <div>
            <h2 className="text-sm font-semibold text-gray-700">Broker Activity</h2>
            <p className="text-xs text-gray-400 mt-0.5">Per-stock broker transaction breakdown</p>
          </div>
          <BrokerSearchForm />
        </div>
        <div className="mb-4">
          <DateRangePicker from={from} to={to} fromParam="broker_from" toParam="broker_to" />
        </div>
        <div className="py-8 text-center text-gray-400 text-sm">
          Enter a ticker above to view broker activity for this period
        </div>
      </div>
    )
  }

  const upperTicker = ticker.toUpperCase()

  // Range mode: aggregate over date range
  if (isMultiDay) {
    const brokerData = await getBrokerActivityRange(upperTicker, from, to)
    return (
      <div className="bg-white rounded-xl border border-gray-200 p-6">
        <div className="flex items-start justify-between flex-wrap gap-4 mb-2">
          <div>
            <h2 className="text-sm font-semibold text-gray-700">
              Broker Activity —{' '}
              <Link href={`/stock/${upperTicker}`} className="font-mono text-blue-600 hover:underline">
                {upperTicker}
              </Link>
            </h2>
            <p className="text-xs text-gray-400 mt-0.5">
              Aggregated buy / sell / net — sorted by absolute net activity
            </p>
          </div>
          <BrokerSearchForm currentTicker={upperTicker} />
        </div>
        <div className="mb-5">
          <DateRangePicker from={from} to={to} ticker={upperTicker} fromParam="broker_from" toParam="broker_to" />
        </div>
        <RangeTable rows={brokerData} />
      </div>
    )
  }

  // Single-day mode: show date pills + single day table
  const [dates, brokers] = await Promise.all([
    getBrokerDates(upperTicker),
    date ? getBrokerActivity(upperTicker, date) : Promise.resolve([]),
  ])

  const activeDate = date ?? dates[0] ?? null
  const brokerData = activeDate && !date
    ? await getBrokerActivity(upperTicker, activeDate)
    : brokers

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-6">
      <div className="flex items-start justify-between flex-wrap gap-4 mb-2">
        <div>
          <h2 className="text-sm font-semibold text-gray-700">
            Broker Activity —{' '}
            <Link href={`/stock/${upperTicker}`} className="font-mono text-blue-600 hover:underline">
              {upperTicker}
            </Link>
          </h2>
          <p className="text-xs text-gray-400 mt-0.5">Top brokers by buy transaction value</p>
        </div>
        <BrokerSearchForm currentTicker={upperTicker} />
      </div>
      <div className="mb-4">
        <DateRangePicker from={from} to={to} ticker={upperTicker} fromParam="broker_from" toParam="broker_to" />
      </div>

      {dates.length > 0 ? (
        <div className="flex gap-1.5 mb-5 flex-wrap">
          {dates.map((d) => (
            <DateButton key={d} date={d} active={d === activeDate} ticker={upperTicker} from={from} to={to} />
          ))}
        </div>
      ) : (
        <p className="text-sm text-amber-600 mb-4">
          No broker data for {upperTicker}. Run{' '}
          <code className="bg-gray-100 px-1 rounded text-xs">
            python run_all.py --daily --ticker {upperTicker}
          </code>{' '}
          first.
        </p>
      )}

      <SingleDayTable rows={brokerData} />
    </div>
  )
}
