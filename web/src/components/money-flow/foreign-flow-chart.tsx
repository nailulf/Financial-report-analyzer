'use client'

import { useState, useEffect } from 'react'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Cell, ReferenceLine,
} from 'recharts'
import type { FlowRow } from '@/lib/queries/money-flow'
import { ChartSkeleton } from '@/components/ui/loading-skeleton'

interface Props {
  buyers: FlowRow[]
  sellers: FlowRow[]
  /** When set, hides the 5D/20D toggle and shows this label instead */
  rangeLabel?: string
}

function formatFlow(value: number) {
  const abs = Math.abs(value)
  const sign = value < 0 ? '-' : '+'
  if (abs >= 1e12) return `${sign}${(abs / 1e12).toFixed(1)}T`
  if (abs >= 1e9)  return `${sign}${(abs / 1e9).toFixed(1)}M`
  if (abs >= 1e6)  return `${sign}${(abs / 1e6).toFixed(1)}Jt`
  return `${sign}${abs.toLocaleString('id-ID')}`
}

function FlowBar({
  data,
  title,
  color,
  dataKey,
}: {
  data: FlowRow[]
  title: string
  color: string
  dataKey: 'foreign_net_5d' | 'foreign_net_20d'
}) {
  const chartData = data.map((r) => ({
    ticker: r.ticker,
    name: r.name ?? r.ticker,
    value: r[dataKey] ?? 0,
  }))

  return (
    <div>
      <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">{title}</h3>
      {chartData.length === 0 ? (
        <div className="h-48 flex items-center justify-center text-sm text-gray-400">No data</div>
      ) : (
        <ResponsiveContainer width="100%" height={chartData.length * 28 + 20}>
          <BarChart
            layout="vertical"
            data={chartData}
            margin={{ top: 0, right: 60, left: 8, bottom: 0 }}
          >
            <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#f0f0f0" />
            <XAxis
              type="number"
              tickFormatter={(v) => formatFlow(v)}
              tick={{ fontSize: 10, fill: '#9CA3AF' }}
              tickLine={false}
              axisLine={false}
            />
            <YAxis
              type="category"
              dataKey="ticker"
              tick={{ fontSize: 11, fill: '#374151', fontFamily: 'monospace', fontWeight: 600 }}
              tickLine={false}
              axisLine={false}
              width={48}
            />
            <Tooltip
              formatter={(value: number) => [formatFlow(value), 'Foreign Net']}
              labelFormatter={(label) => {
                const row = chartData.find((r) => r.ticker === label)
                return `${label}${row?.name ? ` — ${row.name}` : ''}`
              }}
              contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid #E5E7EB' }}
            />
            <ReferenceLine x={0} stroke="#D1D5DB" />
            <Bar dataKey="value" radius={[0, 3, 3, 0]} barSize={14}>
              {chartData.map((_, i) => (
                <Cell key={i} fill={color} fillOpacity={0.85} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      )}
    </div>
  )
}

export function ForeignFlowChart({ buyers, sellers, rangeLabel }: Props) {
  const [mounted, setMounted] = useState(false)
  const [period, setPeriod] = useState<'foreign_net_5d' | 'foreign_net_20d'>('foreign_net_5d')

  useEffect(() => setMounted(true), [])

  if (!mounted) return <ChartSkeleton height={400} />

  // In range mode always use foreign_net_5d (which holds the range total)
  const activePeriod = rangeLabel ? 'foreign_net_5d' : period
  const sortedBuyers  = [...buyers].sort((a, b) => (b[activePeriod] ?? 0) - (a[activePeriod] ?? 0))
  const sortedSellers = [...sellers].sort((a, b) => (a[activePeriod] ?? 0) - (b[activePeriod] ?? 0))

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-6">
      <div className="flex items-center justify-between mb-5">
        <div>
          <h2 className="text-sm font-semibold text-gray-700">Foreign Flow Leaderboard</h2>
          <p className="text-xs text-gray-400 mt-0.5">Net foreign buy/sell value (IDR)</p>
        </div>
        {rangeLabel ? (
          <span className="text-xs font-medium text-blue-600 bg-blue-50 border border-blue-100 rounded px-2 py-1">
            {rangeLabel}
          </span>
        ) : (
          <div className="flex gap-1">
            {([['foreign_net_5d', '5D'], ['foreign_net_20d', '20D']] as const).map(([key, label]) => (
              <button
                key={key}
                onClick={() => setPeriod(key)}
                className={`px-3 py-1 text-xs rounded-md font-medium transition-colors ${
                  period === key
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        <div>
          <div className="flex items-center gap-2 mb-3">
            <div className="w-3 h-3 rounded-full bg-green-500" />
            <span className="text-xs font-semibold text-green-700">Top Net Buyers</span>
          </div>
          <FlowBar
            data={sortedBuyers}
            title=""
            color="#10B981"
            dataKey={activePeriod}
          />
        </div>
        <div>
          <div className="flex items-center gap-2 mb-3">
            <div className="w-3 h-3 rounded-full bg-red-500" />
            <span className="text-xs font-semibold text-red-600">Top Net Sellers</span>
          </div>
          <FlowBar
            data={sortedSellers}
            title=""
            color="#EF4444"
            dataKey={activePeriod}
          />
        </div>
      </div>
    </div>
  )
}
