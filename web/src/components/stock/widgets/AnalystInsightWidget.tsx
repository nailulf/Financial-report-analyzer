'use client'

import { useState, useEffect, useCallback } from 'react'
import { fmtNumID } from '@/lib/calculations/formatters'

/* ── Types ─────────────────────────────────────────────────────── */

interface RecommendationSummary {
  period: string
  strongBuy: number
  buy: number
  hold: number
  sell: number
  strongSell: number
}

interface UpgradeDowngrade {
  GradeDate?: string
  Firm?: string
  ToGrade?: string
  FromGrade?: string
  Action?: string
}

interface AnalystData {
  ticker: string
  current_price: number | null
  target_high: number | null
  target_low: number | null
  target_mean: number | null
  target_median: number | null
  recommendation_key: string | null
  recommendation_mean: number | null
  number_of_analysts: number | null
  recommendations_summary: RecommendationSummary[]
  upgrades_downgrades: UpgradeDowngrade[]
}

/* ── Helpers ───────────────────────────────────────────────────── */

function formatPrice(v: number | null): string {
  if (v == null) return '—'
  return fmtNumID(Math.round(v))
}

function formatPriceDecimal(v: number | null): string {
  if (v == null) return '—'
  return fmtNumID(v, 2)
}

function upsidePercent(current: number | null, target: number | null): string {
  if (!current || !target) return '—'
  const pct = ((target - current) / current) * 100
  const sign = pct >= 0 ? '+' : ''
  return `${sign}${pct.toFixed(1)}%`
}

function upsideColor(current: number | null, target: number | null): string {
  if (!current || !target) return '#888888'
  return target >= current ? '#00FF88' : '#EF4444'
}

/** Convert period offset like "0m", "-1m", "-2m" to a month label */
function periodToMonth(period: string): string {
  const offset = parseInt(period.replace('m', ''), 10)
  if (isNaN(offset)) return period
  const d = new Date()
  d.setMonth(d.getMonth() + offset)
  return d.toLocaleDateString('en-US', { month: 'short' })
}

function formatGradeDate(iso: string | undefined): string {
  if (!iso) return '—'
  try {
    const d = new Date(iso)
    const day = String(d.getDate()).padStart(2, '0')
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
    return `${day} ${months[d.getMonth()]} ${d.getFullYear()}`
  } catch {
    return iso
  }
}

/* ── Stacked bar colors ────────────────────────────────────────── */

const REC_COLORS = {
  strongBuy:  '#166534',  // dark green
  buy:        '#65A30D',  // olive green
  hold:       '#EAB308',  // yellow
  sell:       '#EA580C',  // orange (underperform)
  strongSell: '#DC2626',  // red
} as const

const REC_LABELS = {
  strongBuy:  'Strong Buy',
  buy:        'Buy',
  hold:       'Hold',
  sell:       'Underperform',
  strongSell: 'Sell',
} as const

const REC_KEYS: (keyof typeof REC_COLORS)[] = ['strongBuy', 'buy', 'hold', 'sell', 'strongSell']

/* ── Component ─────────────────────────────────────────────────── */

interface Props {
  ticker: string
}

export function AnalystInsightWidget({ ticker }: Props) {
  const [data, setData] = useState<AnalystData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchData = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/stocks/${encodeURIComponent(ticker)}/analyst`)
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || `HTTP ${res.status}`)
      }
      const json = await res.json()
      setData(json)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to fetch analyst data')
    } finally {
      setLoading(false)
    }
  }, [ticker])

  useEffect(() => { fetchData() }, [fetchData])

  const hasData = data && data.number_of_analysts != null && data.number_of_analysts > 0

  return (
    <div className="bg-white border border-[#E0E0E5] flex flex-col">
      {/* Header */}
      <div className="px-5 py-3 border-b border-[#E0E0E5] flex items-center justify-between">
        <span className="font-mono text-[13px] font-bold tracking-[0.5px] text-[#1A1A1A]">KONSENSUS ANALIS</span>
        <span className="font-mono text-[11px] text-[#888888]">
          {hasData ? `${data!.number_of_analysts} analis · ` : ''}via Yahoo Finance
        </span>
      </div>

      <div className="p-5">
        {/* Loading */}
        {loading && (
          <div className="flex items-center gap-2 py-4">
            <div className="w-3 h-3 border-2 border-[#E0E0E5] border-t-[#888888] rounded-full animate-spin" />
            <span className="font-mono text-[12px] text-[#888888]">Memuat data analis...</span>
          </div>
        )}

        {/* Error */}
        {!loading && error && (
          <div className="py-3">
            <span className="font-mono text-[12px] text-red-400">Gagal memuat: {error}</span>
          </div>
        )}

        {/* No coverage */}
        {!loading && !error && !hasData && (
          <div className="py-3">
            <span className="font-mono text-[12px] text-[#888888]">
              Tidak ada cakupan analis untuk {ticker}. Biasanya hanya tersedia untuk saham berkapitalisasi besar.
            </span>
          </div>
        )}

        {/* Data available */}
        {!loading && !error && hasData && data && (
          <div className="flex flex-col gap-4">

            {/* ── Two-panel row: Price Targets (left) + Recommendations (right) ── */}
            <div className="flex gap-4 items-stretch">

              {/* LEFT: Analyst Price Targets */}
              <div className="flex-1 border border-[#E0E0E5] p-4 flex flex-col justify-between">
                <span className="font-mono text-[12px] font-bold tracking-[0.5px] text-[#1A1A1A] mb-3">
                  TARGET HARGA ANALIS
                </span>

                <div className="flex-1 flex flex-col items-center justify-center gap-3">
                  {/* Average label on top */}
                  <div className="flex flex-col items-center">
                    <span className="font-mono text-[16px] font-bold text-[#1A1A1A]">
                      {formatPriceDecimal(data.target_mean)}
                    </span>
                    <span className="font-mono text-[10px] text-[#888888]">Rata-rata</span>
                  </div>

                  {/* Horizontal range bar */}
                  <div className="w-full flex items-center gap-2">
                    <div className="w-2 h-2 rounded-full bg-[#555555] shrink-0" />
                    <div className="flex-1 relative h-[6px] bg-[#E0E0E5] rounded-full">
                      {data.target_low != null && data.target_high != null && data.target_high > data.target_low && (
                        <>
                          {/* Current price marker */}
                          {data.current_price != null && (
                            <div
                              className="absolute top-1/2 -translate-y-1/2 w-3 h-3 rounded-full bg-[#1A1A1A] border-2 border-white z-10"
                              style={{
                                left: `${Math.max(0, Math.min(100, ((data.current_price - data.target_low) / (data.target_high - data.target_low)) * 100))}%`,
                                transform: 'translate(-50%, -50%)',
                              }}
                            />
                          )}
                          {/* Mean marker */}
                          {data.target_mean != null && (
                            <div
                              className="absolute top-1/2 -translate-y-1/2 w-2.5 h-2.5 rounded-full bg-[#3B82F6] border-2 border-white z-10"
                              style={{
                                left: `${((data.target_mean - data.target_low) / (data.target_high - data.target_low)) * 100}%`,
                                transform: 'translate(-50%, -50%)',
                              }}
                            />
                          )}
                        </>
                      )}
                    </div>
                    <div className="w-2 h-2 rounded-full bg-[#555555] shrink-0" />
                  </div>

                  {/* Low / Current / High labels */}
                  <div className="w-full flex items-start justify-between">
                    <div className="flex flex-col items-start">
                      <span className="font-mono text-[13px] font-semibold text-[#1A1A1A]">
                        {formatPriceDecimal(data.target_low)}
                      </span>
                      <span className="font-mono text-[10px] text-[#888888]">Low</span>
                    </div>
                    <div className="flex flex-col items-center">
                      <span className="font-mono text-[13px] font-semibold text-[#1A1A1A] border border-[#E0E0E5] px-2 py-0.5">
                        {formatPriceDecimal(data.current_price)}
                      </span>
                      <span className="font-mono text-[10px] text-[#888888]">Current</span>
                    </div>
                    <div className="flex flex-col items-end">
                      <span className="font-mono text-[13px] font-semibold text-[#1A1A1A]">
                        {formatPriceDecimal(data.target_high)}
                      </span>
                      <span className="font-mono text-[10px] text-[#888888]">High</span>
                    </div>
                  </div>

                  {/* Upside badge */}
                  <div className="flex items-center gap-2 mt-1">
                    <span className="font-mono text-[11px] text-[#888888]">Upside ke rata-rata:</span>
                    <span
                      className="font-mono text-[13px] font-bold"
                      style={{ color: upsideColor(data.current_price, data.target_mean) }}
                    >
                      {upsidePercent(data.current_price, data.target_mean)}
                    </span>
                  </div>
                </div>
              </div>

              {/* RIGHT: Analyst Recommendations stacked bars */}
              <div className="flex-1 border border-[#E0E0E5] p-4 flex flex-col">
                <span className="font-mono text-[12px] font-bold tracking-[0.5px] text-[#1A1A1A] mb-3">
                  REKOMENDASI ANALIS
                </span>

                {data.recommendations_summary && data.recommendations_summary.length > 0 ? (
                  <div className="flex-1 flex items-end gap-3">
                    {/* Stacked bars */}
                    <div className="flex-1 flex items-end justify-around gap-2">
                      {/* Reverse so oldest is on the left */}
                      {[...data.recommendations_summary].reverse().map((month) => {
                        const total = month.strongBuy + month.buy + month.hold + month.sell + month.strongSell
                        if (total === 0) return null
                        return (
                          <div key={month.period} className="flex flex-col items-center gap-1.5 flex-1">
                            {/* Total count */}
                            <span className="font-mono text-[11px] font-bold text-[#1A1A1A]">{total}</span>
                            {/* Stacked bar */}
                            <div className="w-full flex flex-col rounded overflow-hidden" style={{ height: 140 }}>
                              {REC_KEYS.map((key) => {
                                const count = month[key]
                                if (count === 0) return null
                                const pct = (count / total) * 100
                                return (
                                  <div
                                    key={key}
                                    className="w-full flex items-center justify-center"
                                    style={{
                                      height: `${pct}%`,
                                      backgroundColor: REC_COLORS[key],
                                      minHeight: count > 0 ? 18 : 0,
                                    }}
                                  >
                                    <span className="font-mono text-[11px] font-bold text-white leading-none">
                                      {count}
                                    </span>
                                  </div>
                                )
                              })}
                            </div>
                            {/* Month label */}
                            <span className="font-mono text-[11px] text-[#888888]">
                              {periodToMonth(month.period)}
                            </span>
                          </div>
                        )
                      })}
                    </div>

                    {/* Legend */}
                    <div className="flex flex-col gap-1.5 pl-3 shrink-0">
                      {REC_KEYS.map((key) => (
                        <div key={key} className="flex items-center gap-1.5">
                          <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: REC_COLORS[key] }} />
                          <span className="font-mono text-[10px] text-[#555555] whitespace-nowrap">{REC_LABELS[key]}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="flex-1 flex items-center justify-center">
                    <span className="font-mono text-[11px] text-[#888888]">Tidak ada data rekomendasi</span>
                  </div>
                )}
              </div>
            </div>

            {/* ── Upgrades / Downgrades table ── */}
            {data.upgrades_downgrades && data.upgrades_downgrades.length > 0 && (
              <div className="flex flex-col gap-2">
                <span className="font-mono text-[11px] font-bold tracking-[0.5px] text-[#888888] uppercase">
                  UPGRADE / DOWNGRADE TERBARU
                </span>
                <div className="flex flex-col">
                  {/* Table header */}
                  <div className="flex items-center gap-2 py-1.5 border-b border-[#E0E0E5]">
                    <span className="font-mono text-[10px] text-[#888888] w-[90px]">Tanggal</span>
                    <span className="font-mono text-[10px] text-[#888888] flex-1">Firma</span>
                    <span className="font-mono text-[10px] text-[#888888] w-[110px]">Dari</span>
                    <span className="font-mono text-[10px] text-[#888888] w-[20px]" />
                    <span className="font-mono text-[10px] text-[#888888] w-[110px]">Ke</span>
                  </div>
                  {data.upgrades_downgrades.slice(0, 5).map((ud, i) => {
                    const isUpgrade = ud.Action === 'up' || ud.Action === 'init' || ud.Action === 'main'
                    return (
                      <div key={i} className="flex items-center gap-2 py-1.5 border-b border-[#F5F5F8]">
                        <span className="font-mono text-[11px] text-[#888888] w-[90px]">
                          {formatGradeDate(ud.GradeDate)}
                        </span>
                        <span className="font-mono text-[11px] text-[#1A1A1A] flex-1 truncate">
                          {ud.Firm || '—'}
                        </span>
                        <span className="font-mono text-[11px] text-[#888888] w-[110px] truncate">
                          {ud.FromGrade || '—'}
                        </span>
                        <span
                          className="font-mono text-[11px] font-bold w-[20px] text-center"
                          style={{ color: isUpgrade ? '#00FF88' : '#EF4444' }}
                        >
                          →
                        </span>
                        <span
                          className="font-mono text-[11px] font-semibold w-[110px] truncate"
                          style={{ color: isUpgrade ? '#00FF88' : '#EF4444' }}
                        >
                          {ud.ToGrade || '—'}
                        </span>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
