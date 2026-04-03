'use client'

import { useState, useEffect, useMemo } from 'react'
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceArea,
} from 'recharts'
import type { PricePoint, MarketPhase, MarketPhaseType, MarketPhaseResponse } from '@/lib/types/api'
import { ChartSkeleton } from '@/components/ui/loading-skeleton'
import { fmtNumID, formatPercent } from '@/lib/calculations/formatters'

// ---------------------------------------------------------------------------
// Phase colors & labels
// ---------------------------------------------------------------------------

const PHASE_COLORS: Record<MarketPhaseType, string> = {
  uptrend:          '#378ADD',
  downtrend:        '#E24B4A',
  sideways_bullish: '#1D9E75',
  sideways_bearish: '#D85A30',
}

const PHASE_LABELS: Record<MarketPhaseType, string> = {
  uptrend:          'Uptrend',
  downtrend:        'Downtrend',
  sideways_bullish: 'Sideways ↑',
  sideways_bearish: 'Sideways ↓',
}

const PHASE_LABELS_ID: Record<MarketPhaseType, string> = {
  uptrend:          'Tren Naik',
  downtrend:        'Tren Turun',
  sideways_bullish: 'Sideways Bullish',
  sideways_bearish: 'Sideways Bearish',
}

const PHASE_SHORT: Record<MarketPhaseType, string> = {
  uptrend:          'UP',
  downtrend:        'DN',
  sideways_bullish: 'SB',
  sideways_bearish: 'SX',
}

const PERIODS = [
  { label: '3M', days: 63 },
  { label: '6M', days: 126 },
  { label: '1Y', days: 252 },
  { label: '2Y', days: 504 },
  { label: 'All', days: 9999 },
] as const

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDate(dateStr: string) {
  const d = new Date(dateStr)
  return d.toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: '2-digit' })
}

function formatPrice(value: number) {
  return `Rp${fmtNumID(value)}`
}

function clarityColor(clarity: number): string {
  if (clarity >= 70) return '#1D9E75'
  if (clarity >= 45) return '#D4A843'
  return '#E24B4A'
}

function alignmentBadge(alignment: string | null) {
  if (!alignment) return null
  const colors: Record<string, string> = {
    confirms: 'bg-emerald-50 text-emerald-700',
    contradicts: 'bg-red-50 text-red-700',
    neutral: 'bg-gray-50 text-gray-500',
  }
  return (
    <span className={`inline-block px-1.5 py-0.5 text-[10px] font-medium rounded ${colors[alignment] ?? colors.neutral}`}>
      {alignment === 'confirms' ? 'Konfirmasi' : alignment === 'contradicts' ? 'Bertentangan' : 'Netral'}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface Props {
  ticker: string
  priceHistory: PricePoint[]
}

export function MarketPhaseWidget({ ticker, priceHistory }: Props) {
  const [mounted, setMounted] = useState(false)
  const [period, setPeriod] = useState<number>(252)
  const [showPhases, setShowPhases] = useState(true)
  const [selectedPhaseId, setSelectedPhaseId] = useState<number | null>(null)
  const [phaseData, setPhaseData] = useState<MarketPhaseResponse | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => setMounted(true), [])

  // Fetch phase data
  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const res = await fetch(`/api/stocks/${ticker}/phases`)
        if (!res.ok) throw new Error(`${res.status}`)
        const data: MarketPhaseResponse = await res.json()
        if (!cancelled) setPhaseData(data)
      } catch {
        // Phase data not available — widget still renders without overlays
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [ticker])

  // Slice price data by period
  const sliced = useMemo(() => priceHistory.slice(-period), [priceHistory, period])

  // Filter phases to visible date range
  const visiblePhases = useMemo(() => {
    if (!phaseData?.phases.length || !sliced.length) return []
    const firstDate = sliced[0].date
    const lastDate = sliced[sliced.length - 1].date
    return phaseData.phases.filter(
      (p) => p.end_date >= firstDate && p.start_date <= lastDate,
    )
  }, [phaseData, sliced])

  const currentPhase = phaseData?.currentPhase ?? null

  if (!mounted) return <ChartSkeleton height={400} />

  if (priceHistory.length === 0) {
    return (
      <div className="bg-white border border-[#E0E0E5] p-6">
        <p className="text-sm text-[#888888]">Data harga tidak tersedia.</p>
      </div>
    )
  }

  // Price range for Y axis
  const prices = sliced.map((p) => p.close).filter((v): v is number => v != null)
  const minPrice = Math.min(...prices)
  const maxPrice = Math.max(...prices)
  const priceRange = maxPrice - minPrice
  const yMin = Math.floor((minPrice - priceRange * 0.05) / 10) * 10
  const yMax = Math.ceil((maxPrice + priceRange * 0.05) / 10) * 10

  return (
    <div className="bg-white border border-[#E0E0E5]">
      {/* Header */}
      <div className="px-5 py-3 border-b border-[#E0E0E5] flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-3">
          <span className="font-mono text-[13px] font-bold tracking-[0.5px] text-[#1A1A1A]">
            FASE PASAR
          </span>
          <span className="font-mono text-[10px] text-[#888888] tracking-[0.3px]">
            Indikator berbasis moving average
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowPhases(!showPhases)}
            className={`px-2.5 py-1 text-[11px] font-medium rounded-md transition-colors ${
              showPhases
                ? 'bg-[#1A1A1A] text-white'
                : 'bg-[#EDECEA] text-[#6D6C6A] hover:bg-[#E5E4E1]'
            }`}
          >
            Fase {showPhases ? 'ON' : 'OFF'}
          </button>
          <div className="flex gap-0.5">
            {PERIODS.map(({ label, days }) => (
              <button
                key={label}
                onClick={() => setPeriod(days)}
                className={`px-2.5 py-1 text-[11px] font-medium rounded-md transition-colors ${
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
      </div>

      {/* Current phase banner */}
      {currentPhase && (
        <div className="px-5 py-2.5 border-b border-[#E0E0E5] bg-[#FAFAFA]">
          <div className="flex items-center gap-3 flex-wrap">
            <div className="flex items-center gap-1.5">
              <div
                className="w-2.5 h-2.5 rounded-full"
                style={{ backgroundColor: PHASE_COLORS[currentPhase.phase_type] }}
              />
              <span className="font-mono text-[12px] font-bold" style={{ color: PHASE_COLORS[currentPhase.phase_type] }}>
                {PHASE_LABELS[currentPhase.phase_type]}
              </span>
            </div>
            <span className="font-mono text-[11px] text-[#6D6C6A]">
              {currentPhase.days} hari
            </span>
            <span className={`font-mono text-[11px] font-medium ${currentPhase.change_pct >= 0 ? 'text-[#1D9E75]' : 'text-[#E24B4A]'}`}>
              {currentPhase.change_pct >= 0 ? '+' : ''}{currentPhase.change_pct.toFixed(1)}%
            </span>
            <span className="font-mono text-[11px]" style={{ color: clarityColor(currentPhase.phase_clarity) }}>
              Kejelasan {currentPhase.phase_clarity}%
            </span>
            {currentPhase.broker_flow_alignment && alignmentBadge(currentPhase.broker_flow_alignment)}
            {currentPhase.bandar_signal_mode && (
              <span className="inline-block px-1.5 py-0.5 text-[10px] font-medium rounded bg-purple-50 text-purple-700">
                Bandar: {currentPhase.bandar_signal_mode}
              </span>
            )}
          </div>
        </div>
      )}

      {/* Price chart with phase overlays */}
      <div className="p-4">
        <ResponsiveContainer width="100%" height={240}>
          <AreaChart data={sliced} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="phaseGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#3D8A5A" stopOpacity={0.12} />
                <stop offset="95%" stopColor="#3D8A5A" stopOpacity={0} />
              </linearGradient>
            </defs>

            {/* Phase overlays — rendered before Area so they appear behind */}
            {showPhases && visiblePhases.map((phase) => (
              <ReferenceArea
                key={phase.id}
                x1={phase.start_date < sliced[0].date ? sliced[0].date : phase.start_date}
                x2={phase.end_date > sliced[sliced.length - 1].date ? sliced[sliced.length - 1].date : phase.end_date}
                fill={PHASE_COLORS[phase.phase_type]}
                fillOpacity={selectedPhaseId === phase.id ? 0.22 : 0.08}
                stroke={PHASE_COLORS[phase.phase_type]}
                strokeOpacity={0.15}
                onClick={() => setSelectedPhaseId(selectedPhaseId === phase.id ? null : phase.id)}
                style={{ cursor: 'pointer' }}
                label={phase.days >= 20 ? {
                  value: `${PHASE_SHORT[phase.phase_type]} ${phase.phase_clarity}%`,
                  position: 'insideTopLeft',
                  fontSize: 9,
                  fontFamily: 'monospace',
                  fill: PHASE_COLORS[phase.phase_type],
                } : undefined}
              />
            ))}

            <CartesianGrid strokeDasharray="3 3" stroke="#F5F4F1" vertical={false} />
            <XAxis
              dataKey="date"
              tickFormatter={formatDate}
              tick={{ fontSize: 10, fill: '#9C9B99' }}
              tickLine={false}
              axisLine={false}
              interval="preserveStartEnd"
              tickCount={6}
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
              fill="url(#phaseGradient)"
              dot={false}
              activeDot={{ r: 3, fill: '#3D8A5A' }}
              connectNulls
            />
          </AreaChart>
        </ResponsiveContainer>

        {/* Phase legend */}
        {showPhases && (
          <div className="flex items-center gap-4 mt-2 px-1">
            {(Object.keys(PHASE_COLORS) as MarketPhaseType[]).map((type) => (
              <div key={type} className="flex items-center gap-1">
                <div className="w-2 h-2 rounded-sm" style={{ backgroundColor: PHASE_COLORS[type] }} />
                <span className="text-[10px] text-[#888888] font-mono">{PHASE_LABELS[type]}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Phase history table */}
      {!loading && visiblePhases.length > 0 && (
        <div className="border-t border-[#E0E0E5]">
          <div className="px-5 py-2.5 border-b border-[#E0E0E5]">
            <span className="font-mono text-[11px] font-bold tracking-[0.3px] text-[#1A1A1A]">
              RIWAYAT FASE ({visiblePhases.length})
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr className="border-b border-[#E0E0E5] bg-[#FAFAFA]">
                  <th className="px-4 py-2 font-mono text-[10px] font-bold text-[#888888] tracking-[0.3px]">Fase</th>
                  <th className="px-4 py-2 font-mono text-[10px] font-bold text-[#888888] tracking-[0.3px]">Periode</th>
                  <th className="px-4 py-2 font-mono text-[10px] font-bold text-[#888888] tracking-[0.3px] text-right">Hari</th>
                  <th className="px-4 py-2 font-mono text-[10px] font-bold text-[#888888] tracking-[0.3px] text-right">Perubahan</th>
                  <th className="px-4 py-2 font-mono text-[10px] font-bold text-[#888888] tracking-[0.3px] text-right">Kejelasan</th>
                  <th className="px-4 py-2 font-mono text-[10px] font-bold text-[#888888] tracking-[0.3px]">Smart Money</th>
                </tr>
              </thead>
              <tbody>
                {[...visiblePhases].reverse().map((phase) => (
                  <tr
                    key={phase.id}
                    onClick={() => setSelectedPhaseId(selectedPhaseId === phase.id ? null : phase.id)}
                    className={`border-b border-[#F0F0F2] cursor-pointer transition-colors ${
                      selectedPhaseId === phase.id ? 'bg-[#F5F5F7]' : 'hover:bg-[#FAFAFA]'
                    }`}
                  >
                    <td className="px-4 py-2">
                      <div className="flex items-center gap-1.5">
                        <div
                          className="w-2 h-2 rounded-full flex-shrink-0"
                          style={{ backgroundColor: PHASE_COLORS[phase.phase_type] }}
                        />
                        <span className="font-mono text-[11px] font-medium" style={{ color: PHASE_COLORS[phase.phase_type] }}>
                          {PHASE_LABELS[phase.phase_type]}
                        </span>
                        {phase.is_current && (
                          <span className="text-[9px] font-bold bg-[#1A1A1A] text-white px-1 py-0.5 rounded">NOW</span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-2 font-mono text-[11px] text-[#6D6C6A]">
                      {phase.start_date.slice(5)} — {phase.end_date.slice(5)}
                    </td>
                    <td className="px-4 py-2 font-mono text-[11px] text-[#6D6C6A] text-right">
                      {phase.days}
                    </td>
                    <td className={`px-4 py-2 font-mono text-[11px] font-medium text-right ${
                      phase.change_pct >= 0 ? 'text-[#1D9E75]' : 'text-[#E24B4A]'
                    }`}>
                      {phase.change_pct >= 0 ? '+' : ''}{phase.change_pct.toFixed(1)}%
                    </td>
                    <td className="px-4 py-2 text-right">
                      <div className="flex items-center justify-end gap-1.5">
                        <div className="w-12 h-1.5 bg-[#EDECEA] rounded-full overflow-hidden">
                          <div
                            className="h-full rounded-full"
                            style={{
                              width: `${phase.phase_clarity}%`,
                              backgroundColor: clarityColor(phase.phase_clarity),
                            }}
                          />
                        </div>
                        <span className="font-mono text-[10px]" style={{ color: clarityColor(phase.phase_clarity) }}>
                          {phase.phase_clarity}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-2">
                      <div className="flex items-center gap-1 flex-wrap">
                        {phase.broker_flow_alignment && alignmentBadge(phase.broker_flow_alignment)}
                        {phase.bandar_signal_mode && (
                          <span className="text-[10px] font-mono text-[#888888]">
                            {phase.bandar_signal_mode}
                          </span>
                        )}
                        {!phase.broker_flow_alignment && !phase.bandar_signal_mode && (
                          <span className="text-[10px] text-[#CCCCCC]">—</span>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Disclaimer */}
      <div className="px-5 py-2 border-t border-[#E0E0E5] bg-[#FAFAFA]">
        <p className="font-mono text-[9px] text-[#AAAAAA] leading-relaxed">
          Indikator berbasis SMA(20/50) crossover + ATR. Bukan analisis Wyckoff struktural.
          Bukan sinyal beli/jual. Gunakan sebagai konteks tambahan, bukan dasar keputusan.
        </p>
      </div>
    </div>
  )
}
