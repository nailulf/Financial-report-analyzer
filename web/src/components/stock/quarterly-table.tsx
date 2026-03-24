'use client'

import { useState } from 'react'
import type { QuarterlyFinancial } from '@/lib/types/api'
import { formatIDRCompact, formatPercent, formatNumber, formatMultiple } from '@/lib/calculations/formatters'

// ── Helpers ──────────────────────────────────────────────────────────────────

function colLabel(r: QuarterlyFinancial, mode: 'quarterly' | 'annual') {
  if (mode === 'annual') return String(r.year)
  return `Q${r.quarter} '${String(r.year).slice(2)}`
}

function growthColor(current: number | null, prev: number | null): string {
  if (current == null || prev == null || prev === 0) return 'text-[#1A1918]'
  return current > prev ? 'text-[#3D8A5A]' : 'text-red-500'
}

function growthBadge(current: number | null, prev: number | null): string {
  if (current == null || prev == null || prev === 0) return ''
  const pct = ((current - prev) / Math.abs(prev)) * 100
  return ` ${pct >= 0 ? '+' : ''}${pct.toFixed(0)}%`
}

type Fmt = 'idr' | 'pct' | 'num' | 'mult' | 'x'
type AccessorFn = (r: QuarterlyFinancial) => number | null

interface MetricDef {
  label: string
  fn: AccessorFn
  fmt: Fmt
  growth?: boolean
}

interface SectionDef {
  title: string
  metrics: MetricDef[]
}

const SECTIONS: SectionDef[] = [
  {
    title: 'Income Statement',
    metrics: [
      { label: 'Revenue',      fn: (r) => r.revenue,      fmt: 'idr', growth: true },
      { label: 'Gross Profit', fn: (r) => r.gross_profit, fmt: 'idr', growth: true },
      { label: 'Net Income',   fn: (r) => r.net_income,   fmt: 'idr', growth: true },
      { label: 'EPS',          fn: (r) => r.eps,           fmt: 'num' },
    ],
  },
  {
    title: 'Margins',
    metrics: [
      { label: 'Gross Margin',     fn: (r) => r.gross_margin,     fmt: 'pct' },
      { label: 'Operating Margin', fn: (r) => r.operating_margin, fmt: 'pct' },
      { label: 'Net Margin',       fn: (r) => r.net_margin,       fmt: 'pct' },
    ],
  },
  {
    title: 'Returns',
    metrics: [
      { label: 'ROE',               fn: (r) => r.roe,               fmt: 'pct' },
      { label: 'ROA',               fn: (r) => r.roa,               fmt: 'pct' },
      { label: 'ROCE',              fn: (r) => r.roce,              fmt: 'pct' },
      { label: 'Interest Coverage', fn: (r) => r.interest_coverage, fmt: 'x' },
    ],
  },
  {
    title: 'Balance Sheet',
    metrics: [
      { label: 'Total Assets',    fn: (r) => r.total_assets,         fmt: 'idr' },
      { label: 'Total Equity',    fn: (r) => r.total_equity,         fmt: 'idr' },
      { label: 'Cash',            fn: (r) => r.cash_and_equivalents, fmt: 'idr' },
      { label: 'Net Debt',        fn: (r) => r.net_debt,             fmt: 'idr' },
      { label: 'Total Debt',      fn: (r) => r.total_debt,           fmt: 'idr' },
      { label: 'Working Capital', fn: (r) => r.working_capital,      fmt: 'idr' },
      { label: 'BV / Share',      fn: (r) => r.book_value_per_share, fmt: 'num' },
    ],
  },
  {
    title: 'Cash Flow',
    metrics: [
      { label: 'Operating CF', fn: (r) => r.operating_cash_flow, fmt: 'idr', growth: true },
      { label: 'CapEx',        fn: (r) => r.capex,               fmt: 'idr' },
      { label: 'Free CF',      fn: (r) => r.free_cash_flow,      fmt: 'idr', growth: true },
    ],
  },
  {
    title: 'Solvency',
    metrics: [
      { label: 'Current Ratio',     fn: (r) => r.current_ratio,      fmt: 'x' },
      { label: 'Debt / Equity',     fn: (r) => r.debt_to_equity,     fmt: 'num' },
      { label: 'LT Debt / Equity',  fn: (r) => r.lt_debt_to_equity,  fmt: 'num' },
      { label: 'Financial Leverage',fn: (r) => r.financial_leverage, fmt: 'x' },
      { label: 'Debt / Assets',     fn: (r) => r.debt_to_assets,     fmt: 'num' },
    ],
  },
]

function formatVal(value: number | null, fmt: Fmt): string {
  if (value === null) return '—'
  switch (fmt) {
    case 'idr':  return formatIDRCompact(value)
    case 'pct':  return formatPercent(value)
    case 'num':  return formatNumber(value)
    case 'mult': return formatMultiple(value)
    case 'x':    return `${formatNumber(value, 2)}x`
  }
}

// ── Component ─────────────────────────────────────────────────────────────────

interface Props {
  quarterlyData: QuarterlyFinancial[]
  annualData: QuarterlyFinancial[]
}

export function QuarterlyTable({ quarterlyData, annualData }: Props) {
  const [mode, setMode] = useState<'quarterly' | 'annual'>(
    quarterlyData.length > 0 ? 'quarterly' : 'annual'
  )

  const rows = mode === 'quarterly' ? quarterlyData : annualData

  if (rows.length === 0 && quarterlyData.length === 0 && annualData.length === 0) {
    return (
      <div className="bg-white rounded-2xl border border-[#E5E4E1] shadow-[0_2px_12px_rgba(26,25,24,0.06)] p-6">
        <h2 className="text-sm font-semibold text-[#1A1918] mb-3">Financials</h2>
        <p className="text-sm text-[#9C9B99]">No financial data available.</p>
      </div>
    )
  }

  return (
    <div className="bg-white rounded-2xl border border-[#E5E4E1] shadow-[0_2px_12px_rgba(26,25,24,0.06)] p-6">
      {/* Header + toggle */}
      <div className="flex items-center justify-between mb-5">
        <h2 className="text-sm font-semibold text-[#1A1918]">Financial Highlights</h2>
        <div className="flex rounded-xl border border-[#E5E4E1] overflow-hidden text-xs font-medium">
          <button
            onClick={() => setMode('quarterly')}
            disabled={quarterlyData.length === 0}
            className={`px-3 py-1.5 transition-colors ${
              mode === 'quarterly'
                ? 'bg-[#3D8A5A] text-white'
                : 'text-[#6D6C6A] hover:bg-[#F5F4F1] disabled:opacity-40 disabled:cursor-not-allowed'
            }`}
          >
            Quarterly
          </button>
          <button
            onClick={() => setMode('annual')}
            disabled={annualData.length === 0}
            className={`px-3 py-1.5 border-l border-[#E5E4E1] transition-colors ${
              mode === 'annual'
                ? 'bg-[#3D8A5A] text-white'
                : 'text-[#6D6C6A] hover:bg-[#F5F4F1] disabled:opacity-40 disabled:cursor-not-allowed'
            }`}
          >
            Annual
          </button>
        </div>
      </div>

      {rows.length === 0 ? (
        <p className="text-sm text-[#9C9B99]">No {mode} data available.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[#E5E4E1]">
                <th className="text-left py-2 pr-6 font-medium text-[#9C9B99] whitespace-nowrap w-36">
                  Metric
                </th>
                {rows.map((r) => (
                  <th
                    key={`${r.year}-${r.quarter}`}
                    className="text-right py-2 px-3 font-semibold text-[#1A1918] whitespace-nowrap font-mono"
                  >
                    {colLabel(r, mode)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {SECTIONS.flatMap((section) => [
                <tr key={`${section.title}__hdr`} className="bg-[#F5F4F1]">
                  <td
                    colSpan={rows.length + 1}
                    className="py-1.5 px-0 text-xs font-semibold text-[#9C9B99] uppercase tracking-wide"
                  >
                    {section.title}
                  </td>
                </tr>,
                ...section.metrics.map((metric) => (
                  <tr
                    key={`${section.title}__${metric.label}`}
                    className="border-b border-[#F5F4F1] hover:bg-[#F5F4F1]/60"
                  >
                    <td className="py-2 pr-6 text-[#6D6C6A] whitespace-nowrap">{metric.label}</td>
                    {rows.map((r, i) => {
                      const val   = metric.fn(r)
                      const prev  = metric.fn(rows[i + 1] ?? ({} as QuarterlyFinancial))
                      const color = metric.growth ? growthColor(val, prev) : 'text-[#1A1918]'
                      const badge = metric.growth ? growthBadge(val, prev) : ''
                      return (
                        <td
                          key={`${r.year}-${r.quarter}`}
                          className={`py-2 px-3 text-right font-mono whitespace-nowrap ${color}`}
                        >
                          {formatVal(val, metric.fmt)}
                          {badge && (
                            <span className="ml-1 text-xs font-normal opacity-70">{badge}</span>
                          )}
                        </td>
                      )
                    })}
                  </tr>
                )),
              ])}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
