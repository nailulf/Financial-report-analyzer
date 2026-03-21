'use client'

import { useState, useEffect } from 'react'
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer
} from 'recharts'
import type { FinancialYear } from '@/lib/types/api'
import { CHART_COLORS } from '@/lib/constants'
import { ChartSkeleton } from '@/components/ui/loading-skeleton'

interface Props { data: FinancialYear[] }

export function MarginTrendChart({ data }: Props) {
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  if (!mounted) return <ChartSkeleton height={260} />
  if (!data.length) return <div className="flex items-center justify-center h-64 text-gray-400 text-sm">No data available</div>

  return (
    <ResponsiveContainer width="100%" height={260}>
      <LineChart data={data} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
        <XAxis dataKey="year" tick={{ fontSize: 12 }} />
        <YAxis tickFormatter={(v) => `${v}%`} tick={{ fontSize: 11 }} domain={['auto', 'auto']} />
        <Tooltip formatter={(v) => [`${Number(v).toFixed(1)}%`]} labelStyle={{ fontWeight: 600 }} />
        <Legend />
        <Line dataKey="gross_margin"     name="Gross Margin"     stroke={CHART_COLORS.blue}   strokeWidth={2} dot={{ r: 3 }} type="monotone" connectNulls />
        <Line dataKey="operating_margin" name="Operating Margin" stroke={CHART_COLORS.purple} strokeWidth={2} dot={{ r: 3 }} type="monotone" connectNulls />
        <Line dataKey="net_margin"       name="Net Margin"       stroke={CHART_COLORS.green}  strokeWidth={2} dot={{ r: 3 }} type="monotone" connectNulls />
      </LineChart>
    </ResponsiveContainer>
  )
}
