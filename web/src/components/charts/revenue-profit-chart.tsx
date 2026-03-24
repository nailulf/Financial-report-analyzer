'use client'

import { useState, useEffect } from 'react'
import {
  ComposedChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer
} from 'recharts'
import type { FinancialYear } from '@/lib/types/api'
import { CHART_COLORS } from '@/lib/constants'
import { formatIDRCompact } from '@/lib/calculations/formatters'
import { ChartSkeleton } from '@/components/ui/loading-skeleton'

interface Props { data: FinancialYear[] }

export function RevenueProfitChart({ data }: Props) {
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  if (!mounted) return <ChartSkeleton height={300} />
  if (!data.length) return <div className="flex items-center justify-center h-64 text-[#9C9B99] text-sm">No data available</div>

  return (
    <ResponsiveContainer width="100%" height={300}>
      <ComposedChart data={data} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#F5F4F1" />
        <XAxis dataKey="year" tick={{ fontSize: 12 }} />
        <YAxis tickFormatter={(v) => formatIDRCompact(v)} tick={{ fontSize: 11 }} width={60} />
        <Tooltip
          formatter={(value, name) => [formatIDRCompact(Number(value)), String(name)]}
          labelStyle={{ fontWeight: 600 }}
        />
        <Legend />
        <Bar dataKey="revenue"      name="Revenue"      fill={CHART_COLORS.blue}  radius={[3, 3, 0, 0]} />
        <Bar dataKey="gross_profit" name="Gross Profit" fill={CHART_COLORS.amber}  radius={[3, 3, 0, 0]} />
        <Bar dataKey="net_income"   name="Net Income"   fill={CHART_COLORS.green} radius={[3, 3, 0, 0]} />
      </ComposedChart>
    </ResponsiveContainer>
  )
}
