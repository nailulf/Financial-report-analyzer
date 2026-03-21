'use client'

import { useState, useEffect } from 'react'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer
} from 'recharts'
import type { ComparisonStock } from '@/lib/types/api'
import { CHART_COLORS } from '@/lib/constants'
import { formatPercent, formatMultiple } from '@/lib/calculations/formatters'
import { ChartSkeleton } from '@/components/ui/loading-skeleton'

interface Props { stocks: ComparisonStock[] }

const METRICS = [
  { key: 'roe',           label: 'ROE (%)',     fmt: (v: number) => `${v?.toFixed(1)}%` },
  { key: 'net_margin',    label: 'Net Margin (%)', fmt: (v: number) => `${v?.toFixed(1)}%` },
  { key: 'debt_to_equity', label: 'D/E',        fmt: (v: number) => v?.toFixed(2) },
  { key: 'pe_ratio',      label: 'P/E',         fmt: (v: number) => v?.toFixed(1) },
]

const COLORS = [CHART_COLORS.blue, CHART_COLORS.green, CHART_COLORS.purple, CHART_COLORS.amber, CHART_COLORS.red]

export function ComparisonBarChart({ stocks }: Props) {
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  if (!mounted) return <ChartSkeleton height={400} />

  return (
    <div className="space-y-6">
      {METRICS.map((m) => {
        const chartData = stocks.map((s) => ({
          ticker: s.ticker,
          value: (s as unknown as Record<string, number | null>)[m.key],
        })).filter((d) => d.value !== null)

        if (!chartData.length) return null

        return (
          <div key={m.key}>
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">{m.label}</p>
            <ResponsiveContainer width="100%" height={160}>
              <BarChart data={chartData} layout="vertical" margin={{ left: 10, right: 30 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" horizontal={false} />
                <XAxis type="number" tick={{ fontSize: 11 }} tickFormatter={m.fmt} />
                <YAxis type="category" dataKey="ticker" tick={{ fontSize: 12, fontFamily: 'monospace' }} width={50} />
                <Tooltip formatter={(v) => [m.fmt(Number(v)), m.label]} />
                <Bar dataKey="value" name={m.label} radius={[0, 3, 3, 0]}>
                  {chartData.map((_, i) => (
                    <rect key={i} fill={COLORS[i % COLORS.length]} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        )
      })}
    </div>
  )
}
