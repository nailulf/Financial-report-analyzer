'use client'

import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import {
  ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts'
import type { QuarterlyFinancial } from '@/lib/types/api'
import { CHART_COLORS } from '@/lib/constants'
import { formatIDRCompact, formatPercent, formatMultiple } from '@/lib/calculations/formatters'
import { ChartSkeleton } from '@/components/ui/loading-skeleton'

/* ─── metric configuration ──────────────────────────────────────────── */

type StatementType = 'is' | 'cs' | 'bs'

interface MetricDef {
  key: string
  label: string
  color: string
  format: 'idr' | 'pct' | 'x'
}

const STATEMENTS: Record<StatementType, { title: string; metrics: MetricDef[]; defaults: string[] }> = {
  is: {
    title: 'LABA RUGI',
    metrics: [
      { key: 'revenue',          label: 'Pendapatan',     color: CHART_COLORS.blue,   format: 'idr' },
      { key: 'gross_profit',     label: 'Laba Kotor',     color: CHART_COLORS.amber,  format: 'idr' },
      { key: 'net_income',       label: 'Laba Bersih',    color: CHART_COLORS.green,  format: 'idr' },
      { key: 'gross_margin',     label: 'Margin Kotor',   color: '#EC4899',           format: 'pct' },
      { key: 'operating_margin', label: 'Margin Operasi', color: CHART_COLORS.gray,   format: 'pct' },
      { key: 'net_margin',       label: 'Margin Bersih',  color: CHART_COLORS.teal,   format: 'pct' },
    ],
    defaults: ['revenue', 'gross_profit', 'net_income'],
  },
  cs: {
    title: 'ARUS KAS',
    metrics: [
      { key: 'free_cash_flow',      label: 'Arus Kas Bebas',   color: CHART_COLORS.green,  format: 'idr' },
      { key: 'operating_cash_flow', label: 'Arus Kas Operasi', color: CHART_COLORS.blue,   format: 'idr' },
      { key: 'capex',               label: 'Belanja Modal',    color: CHART_COLORS.red,    format: 'idr' },
    ],
    defaults: ['free_cash_flow'],
  },
  bs: {
    title: 'NERACA',
    metrics: [
      { key: 'total_assets',         label: 'Total Aset',       color: CHART_COLORS.blue,   format: 'idr' },
      { key: 'total_liabilities',    label: 'Total Liabilitas', color: CHART_COLORS.red,    format: 'idr' },
      { key: 'total_equity',         label: 'Total Ekuitas',    color: CHART_COLORS.green,  format: 'idr' },
      { key: 'total_debt',           label: 'Total Utang',      color: CHART_COLORS.amber,  format: 'idr' },
      { key: 'cash_and_equivalents', label: 'Kas & Setara Kas', color: CHART_COLORS.teal,   format: 'idr' },
      { key: 'working_capital',      label: 'Modal Kerja',      color: CHART_COLORS.purple, format: 'idr' },
      { key: 'current_ratio',        label: 'Current Ratio',    color: '#EC4899',           format: 'x'   },
      { key: 'debt_to_equity',       label: 'Debt/Equity',      color: CHART_COLORS.gray,   format: 'x'   },
    ],
    defaults: ['total_assets', 'total_liabilities'],
  },
}

/* ─── helpers ───────────────────────────────────────────────────────── */

type ChartRow = Record<string, string | number | null>

function buildRows(rows: QuarterlyFinancial[], mode: 'annual' | 'quarterly'): ChartRow[] {
  return rows
    .filter((r) => (mode === 'annual' ? r.quarter === 0 : r.quarter > 0))
    .sort((a, b) => a.year - b.year || a.quarter - b.quarter)
    .map((r) => ({
      label: mode === 'annual' ? String(r.year) : `Q${r.quarter} '${String(r.year).slice(2)}`,
      revenue: r.revenue,
      gross_profit: r.gross_profit,
      net_income: r.net_income,
      gross_margin: r.gross_margin,
      operating_margin: r.operating_margin,
      net_margin: r.net_margin,
      operating_cash_flow: r.operating_cash_flow,
      capex: r.capex,
      free_cash_flow: r.free_cash_flow,
      total_assets: r.total_assets,
      total_liabilities:
        r.total_assets != null && r.total_equity != null ? r.total_assets - r.total_equity : null,
      total_equity: r.total_equity,
      total_debt: r.total_debt,
      cash_and_equivalents: r.cash_and_equivalents,
      working_capital: r.working_capital,
      current_ratio: r.current_ratio,
      debt_to_equity: r.debt_to_equity,
    }))
}

function fmtTooltip(value: number | null | undefined, format: 'idr' | 'pct' | 'x'): string {
  if (value == null) return '—'
  if (format === 'pct') return formatPercent(value)
  if (format === 'x') return formatMultiple(value)
  return formatIDRCompact(value)
}

function fmtAxis(value: number | null | undefined, format: 'idr' | 'pct' | 'x'): string {
  if (value == null) return ''
  if (format === 'pct') return `${value.toFixed(0)}%`
  if (format === 'x') return `${value.toFixed(1)}x`
  return formatIDRCompact(value)
}

/* ─── dropdown ──────────────────────────────────────────────────────── */

function MetricDropdown({
  metrics,
  selected,
  onToggle,
  open,
  onOpenChange,
}: {
  metrics: MetricDef[]
  selected: Set<string>
  onToggle: (key: string) => void
  open: boolean
  onOpenChange: (v: boolean) => void
}) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function handle(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onOpenChange(false)
    }
    document.addEventListener('mousedown', handle)
    return () => document.removeEventListener('mousedown', handle)
  }, [open, onOpenChange])

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => onOpenChange(!open)}
        className="font-mono text-[11px] text-[#888888] hover:text-[#1A1A1A] transition-colors flex items-center gap-1"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
        </svg>
        Metrik
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 bg-white border border-[#E0E0E5] shadow-lg z-50 min-w-[200px]">
          {metrics.map((m) => (
            <button
              key={m.key}
              type="button"
              onClick={() => onToggle(m.key)}
              className="flex items-center gap-2.5 px-3 py-2 hover:bg-[#F5F5F8] cursor-pointer w-full text-left"
            >
              <span
                className={`w-3.5 h-3.5 border flex items-center justify-center shrink-0 ${
                  selected.has(m.key)
                    ? 'bg-[#1A1A1A] border-[#1A1A1A]'
                    : 'border-[#E0E0E5]'
                }`}
              >
                {selected.has(m.key) && (
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                )}
              </span>
              <span className="font-mono text-[12px] text-[#1A1A1A]">{m.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/* ─── single chart card ─────────────────────────────────────────────── */

function StatementCard({
  type,
  data,
  selected,
  onToggleMetric,
  expanded,
  onToggleExpand,
  dropdownOpen,
  onDropdownChange,
}: {
  type: StatementType
  data: ChartRow[]
  selected: Set<string>
  onToggleMetric: (key: string) => void
  expanded: boolean
  onToggleExpand: () => void
  dropdownOpen: boolean
  onDropdownChange: (v: boolean) => void
}) {
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  const config = STATEMENTS[type]
  const activeMetrics = config.metrics.filter((m) => selected.has(m.key))
  const idrMetrics = activeMetrics.filter((m) => m.format === 'idr')
  const pctMetrics = activeMetrics.filter((m) => m.format === 'pct' || m.format === 'x')
  const hasDualAxis = idrMetrics.length > 0 && pctMetrics.length > 0

  const chartH = expanded ? 340 : 220

  return (
    <div className={['bg-white border border-[#E0E0E5] flex flex-col overflow-visible', dropdownOpen && 'relative z-10'].filter(Boolean).join(' ')}>
      {/* card header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-[#E0E0E5]">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[11px] font-bold tracking-[0.5px] text-[#1A1A1A]">{config.title}</span>
          <span className="font-mono text-[10px] text-[#888888] uppercase">{type}</span>
        </div>
        <div className="flex items-center gap-2">
          <MetricDropdown
            metrics={config.metrics}
            selected={selected}
            onToggle={onToggleMetric}
            open={dropdownOpen}
            onOpenChange={onDropdownChange}
          />
          <button
            onClick={onToggleExpand}
            className="text-[#888888] hover:text-[#1A1A1A] transition-colors"
            title={expanded ? 'Perkecil' : 'Perbesar'}
          >
            {expanded ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="4 14 10 14 10 20" /><polyline points="20 10 14 10 14 4" /><line x1="14" y1="10" x2="21" y2="3" /><line x1="3" y1="21" x2="10" y2="14" />
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="15 3 21 3 21 9" /><polyline points="9 21 3 21 3 15" /><line x1="21" y1="3" x2="14" y2="10" /><line x1="3" y1="21" x2="10" y2="14" />
              </svg>
            )}
          </button>
        </div>
      </div>

      {/* chart area */}
      <div className="px-4 pt-3 pb-2">
        {!mounted ? (
          <ChartSkeleton height={chartH} />
        ) : activeMetrics.length === 0 ? (
          <div className="flex items-center justify-center text-[#888888] font-mono text-[12px]" style={{ height: chartH }}>
            Pilih metrik untuk ditampilkan
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={chartH}>
            <ComposedChart data={data} margin={{ top: 5, right: hasDualAxis ? 10 : 5, left: 0, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#F0F0F0" />
              <XAxis
                dataKey="label"
                tick={{ fontSize: 10, fontFamily: 'monospace', fill: '#888888' }}
                tickLine={false}
                axisLine={{ stroke: '#E0E0E5' }}
              />
              <YAxis
                yAxisId="left"
                tickFormatter={(v) => fmtAxis(v, idrMetrics.length > 0 ? 'idr' : pctMetrics[0]?.format ?? 'idr')}
                tick={{ fontSize: 10, fontFamily: 'monospace', fill: '#888888' }}
                tickLine={false}
                axisLine={false}
                width={55}
              />
              {hasDualAxis && (
                <YAxis
                  yAxisId="right"
                  orientation="right"
                  tickFormatter={(v) => fmtAxis(v, pctMetrics[0]?.format ?? 'pct')}
                  tick={{ fontSize: 10, fontFamily: 'monospace', fill: '#888888' }}
                  tickLine={false}
                  axisLine={false}
                  width={40}
                />
              )}
              <Tooltip
                contentStyle={{ fontFamily: 'monospace', fontSize: 11, border: '1px solid #E0E0E5' }}
                formatter={(value: number, name: string) => {
                  const m = activeMetrics.find((am) => am.label === name)
                  return [fmtTooltip(value, m?.format ?? 'idr'), name]
                }}
                labelStyle={{ fontWeight: 700, fontSize: 12 }}
              />
              {idrMetrics.map((m) => (
                <Bar
                  key={m.key}
                  yAxisId="left"
                  dataKey={m.key}
                  name={m.label}
                  fill={m.color}
                  radius={[2, 2, 0, 0]}
                  maxBarSize={expanded ? 40 : 24}
                />
              ))}
              {pctMetrics.map((m) => (
                <Line
                  key={m.key}
                  yAxisId={hasDualAxis ? 'right' : 'left'}
                  type="monotone"
                  dataKey={m.key}
                  name={m.label}
                  stroke={m.color}
                  strokeWidth={2}
                  dot={{ r: 3, fill: m.color }}
                  activeDot={{ r: 5 }}
                />
              ))}
            </ComposedChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* legend */}
      {activeMetrics.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 pb-3">
          {activeMetrics.map((m) => (
            <div key={m.key} className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ backgroundColor: m.color }} />
              <span className="font-mono text-[10px] text-[#555555]">{m.label}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/* ─── main widget ───────────────────────────────────────────────────── */

interface Props {
  annual: QuarterlyFinancial[]
  quarterly: QuarterlyFinancial[]
}

export function FinancialStatementsWidget({ annual, quarterly }: Props) {
  const [mode, setMode] = useState<'annual' | 'quarterly'>('annual')
  const [expanded, setExpanded] = useState<StatementType | null>(null)
  const [openDropdown, setOpenDropdown] = useState<StatementType | null>(null)
  const [selectedMetrics, setSelectedMetrics] = useState<Record<StatementType, Set<string>>>({
    is: new Set(STATEMENTS.is.defaults),
    cs: new Set(STATEMENTS.cs.defaults),
    bs: new Set(STATEMENTS.bs.defaults),
  })

  const data = useMemo(() => buildRows(mode === 'annual' ? annual : quarterly, mode), [annual, quarterly, mode])

  const toggleMetric = useCallback((type: StatementType, key: string) => {
    setSelectedMetrics((prev) => {
      const next = new Set(prev[type])
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return { ...prev, [type]: next }
    })
  }, [])

  if (annual.length === 0 && quarterly.length === 0) return null

  const types: StatementType[] = ['is', 'cs', 'bs']

  const renderCard = (type: StatementType) => (
    <StatementCard
      key={type}
      type={type}
      data={data}
      selected={selectedMetrics[type]}
      onToggleMetric={(k) => toggleMetric(type, k)}
      expanded={expanded === type}
      onToggleExpand={() => setExpanded((prev) => (prev === type ? null : type))}
      dropdownOpen={openDropdown === type}
      onDropdownChange={(v) => setOpenDropdown(v ? type : null)}
    />
  )

  return (
    <div className="px-12 py-2">
      <div className="bg-white border border-[#E0E0E5] flex flex-col">
        {/* header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-[#E0E0E5]">
          <span className="font-mono text-[13px] font-bold tracking-[0.5px] text-[#1A1A1A]">
            LAPORAN KEUANGAN
          </span>
          <div className="flex items-center gap-0">
            {(['annual', 'quarterly'] as const).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={`font-mono text-[11px] font-bold tracking-[0.5px] px-3 py-1.5 transition-colors ${
                  mode === m
                    ? 'bg-[#1A1A1A] text-white'
                    : 'bg-[#F5F5F8] text-[#888888] hover:text-[#555555]'
                }`}
              >
                {m === 'annual' ? 'Tahunan' : 'Kuartalan'}
              </button>
            ))}
          </div>
        </div>

        {/* chart grid */}
        <div className="p-4">
          {data.length === 0 ? (
            <div className="flex items-center justify-center h-48 font-mono text-[12px] text-[#888888]">
              Tidak ada data {mode === 'annual' ? 'tahunan' : 'kuartalan'}
            </div>
          ) : expanded ? (
            <div className="flex flex-col gap-2">
              {/* expanded chart — full width */}
              {renderCard(expanded)}
              {/* remaining two — half & half */}
              <div className="grid grid-cols-2 gap-2">
                {types.filter((t) => t !== expanded).map(renderCard)}
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-3 gap-2">
              {types.map(renderCard)}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
