'use client'

import { useState, useEffect } from 'react'
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, BarChart, Bar,
} from 'recharts'
import type { PricePoint } from '@/lib/types/api'
import { ChartSkeleton } from '@/components/ui/loading-skeleton'

interface Props {
  data: PricePoint[]
  ticker: string
}

function formatDate(dateStr: string) {
  const d = new Date(dateStr)
  return d.toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: '2-digit' })
}

function formatPrice(value: number) {
  return `Rp${value.toLocaleString('id-ID')}`
}

function formatVolume(value: number) {
  if (value >= 1e9) return `${(value / 1e9).toFixed(1)}M`
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}Jt`
  if (value >= 1e3) return `${(value / 1e3).toFixed(0)}K`
  return String(value)
}

const PERIODS = [
  { label: '1M', days: 21 },
  { label: '3M', days: 63 },
  { label: '6M', days: 126 },
  { label: '1Y', days: 252 },
] as const

export function PriceHistoryChart({ data, ticker }: Props) {
  const [mounted, setMounted] = useState(false)
  const [period, setPeriod] = useState<number>(252)

  useEffect(() => setMounted(true), [])

  if (!mounted) return <ChartSkeleton height={320} />
  if (data.length === 0) {
    return (
      <div className="bg-white rounded-2xl border border-[#E5E4E1] shadow-[0_2px_12px_rgba(26,25,24,0.06)] p-6 flex items-center justify-center h-40">
        <p className="text-sm text-[#9C9B99]">No price data available. Run the daily_prices scraper first.</p>
      </div>
    )
  }

  const sliced = data.slice(-period)
  const prices = sliced.map((p) => p.close).filter((v): v is number => v != null)
  const minPrice = Math.min(...prices)
  const maxPrice = Math.max(...prices)
  const priceRange = maxPrice - minPrice
  const yMin = Math.floor((minPrice - priceRange * 0.05) / 10) * 10
  const yMax = Math.ceil((maxPrice + priceRange * 0.05) / 10) * 10

  const firstClose = sliced[0]?.close ?? null
  const lastClose = sliced[sliced.length - 1]?.close ?? null
  const pctChange = firstClose && lastClose ? ((lastClose - firstClose) / firstClose) * 100 : null
  const isPositive = pctChange != null && pctChange >= 0

  const tickCount = sliced.length > 100 ? 6 : 4

  return (
    <div className="bg-white rounded-2xl border border-[#E5E4E1] shadow-[0_2px_12px_rgba(26,25,24,0.06)] p-6">
      <div className="flex items-start justify-between mb-5 flex-wrap gap-3">
        <div>
          <h2 className="text-sm font-semibold text-[#1A1918]">Price History</h2>
          {pctChange != null && (
            <p className={`text-xs mt-0.5 font-medium ${isPositive ? 'text-[#3D8A5A]' : 'text-red-500'}`}>
              {isPositive ? '+' : ''}{pctChange.toFixed(2)}% over period
            </p>
          )}
        </div>
        <div className="flex gap-1">
          {PERIODS.map(({ label, days }) => (
            <button
              key={label}
              onClick={() => setPeriod(days)}
              className={`px-3 py-1 text-xs rounded-lg font-medium transition-colors ${
                period === days
                  ? 'bg-[#3D8A5A] text-white'
                  : 'bg-[#EDECEA] text-[#6D6C6A] hover:bg-[#E5E4E1]'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Price chart */}
      <ResponsiveContainer width="100%" height={220}>
        <AreaChart data={sliced} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="priceGradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#3D8A5A" stopOpacity={0.15} />
              <stop offset="95%" stopColor="#3D8A5A" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="#F5F4F1" vertical={false} />
          <XAxis
            dataKey="date"
            tickFormatter={formatDate}
            tick={{ fontSize: 10, fill: '#9C9B99' }}
            tickLine={false}
            axisLine={false}
            interval="preserveStartEnd"
            tickCount={tickCount}
          />
          <YAxis
            domain={[yMin, yMax]}
            tickFormatter={(v) => `${(v / 1000).toFixed(0)}K`}
            tick={{ fontSize: 10, fill: '#9C9B99' }}
            tickLine={false}
            axisLine={false}
            width={44}
          />
          <Tooltip
            formatter={(value: number) => [formatPrice(value), 'Close']}
            labelFormatter={formatDate}
            contentStyle={{ fontSize: 12, borderRadius: 12, border: '1px solid #E5E4E1', background: '#fff', color: '#1A1918' }}
          />
          <Area
            type="monotone"
            dataKey="close"
            stroke="#3D8A5A"
            strokeWidth={1.5}
            fill="url(#priceGradient)"
            dot={false}
            activeDot={{ r: 4, fill: '#3D8A5A' }}
            connectNulls
          />
        </AreaChart>
      </ResponsiveContainer>

      {/* Volume chart */}
      <ResponsiveContainer width="100%" height={60}>
        <BarChart data={sliced} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
          <XAxis dataKey="date" hide />
          <YAxis hide />
          <Tooltip
            formatter={(value: number) => [formatVolume(value), 'Volume']}
            labelFormatter={formatDate}
            contentStyle={{ fontSize: 11, borderRadius: 12, border: '1px solid #E5E4E1', background: '#fff' }}
          />
          <Bar dataKey="volume" fill="#EDECEA" radius={[2, 2, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
      <p className="text-xs text-[#9C9B99] mt-1">Volume ({ticker})</p>
    </div>
  )
}
