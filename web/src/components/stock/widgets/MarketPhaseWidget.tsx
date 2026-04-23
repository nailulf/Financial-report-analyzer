'use client'

import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import type { PricePoint, MarketPhase, MarketPhaseType, MarketPhaseResponse, TechnicalSignalPoint } from '@/lib/types/api'
import { ChartSkeleton } from '@/components/ui/loading-skeleton'
import { fmtNumID } from '@/lib/calculations/formatters'

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

function formatDateMed(dateStr: string) {
  const d = new Date(dateStr + 'T00:00:00+07:00')
  return d.toLocaleDateString('id-ID', {
    day: 'numeric', month: 'short', year: 'numeric',
    timeZone: 'Asia/Jakarta',
  })
}

function formatPriceCompact(value: number) {
  return fmtNumID(value)
}

function clarityColor(clarity: number): string {
  if (clarity >= 70) return '#1D9E75'
  if (clarity >= 45) return '#D4A843'
  return '#E24B4A'
}

function trendLabel(strength: string): string {
  if (strength === 'strong') return 'Kuat'
  if (strength === 'weak') return 'Lemah'
  return 'Sideways'
}

function alignmentBadge(alignment: string | null) {
  if (!alignment) return null
  const colors: Record<string, string> = {
    confirms: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    contradicts: 'bg-red-50 text-red-700 border-red-200',
    neutral: 'bg-gray-50 text-gray-500 border-gray-200',
  }
  const labels: Record<string, string> = {
    confirms: 'Konfirmasi',
    contradicts: 'Bertentangan',
    neutral: 'Netral',
  }
  return (
    <span className={`inline-block px-1.5 py-0.5 text-[10px] font-medium rounded border ${colors[alignment] ?? colors.neutral}`}>
      {labels[alignment] ?? alignment}
    </span>
  )
}

function dateToUnix(dateStr: string): number {
  return Math.floor(new Date(dateStr + 'T00:00:00Z').getTime() / 1000)
}

function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r},${g},${b},${alpha})`
}

// ---------------------------------------------------------------------------
// Phase overlay position
// ---------------------------------------------------------------------------

interface OverlayRect {
  id: number
  left: number
  width: number
  color: string
  label: string
  clarity: number
  phaseType: MarketPhaseType
}

type LCModule = typeof import('lightweight-charts')

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

interface Props {
  ticker: string
  priceHistory: PricePoint[]
  technicalSignals?: TechnicalSignalPoint[]
}

export function MarketPhaseWidget({ ticker, priceHistory, technicalSignals = [] }: Props) {
  const [mounted, setMounted] = useState(false)
  const [period, setPeriod] = useState<number>(252)
  const [showPhases, setShowPhases] = useState(true)
  const [selectedPhaseId, setSelectedPhaseId] = useState<number | null>(null)
  const [phaseData, setPhaseData] = useState<MarketPhaseResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [lcModule, setLcModule] = useState<LCModule | null>(null)
  const [overlayRects, setOverlayRects] = useState<OverlayRect[]>([])

  const chartWrapperRef = useRef<HTMLDivElement>(null)
  const chartContainerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<any>(null)

  useEffect(() => { setMounted(true) }, [])

  // Dynamic import
  useEffect(() => {
    import('lightweight-charts').then(setLcModule)
  }, [])

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
        // Phase data not available
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [ticker])

  const sliced = useMemo(() => priceHistory.slice(-period), [priceHistory, period])

  // Build a date→signal lookup, then create date-aligned arrays that use
  // the SAME date axis as the price chart. This ensures logical index N
  // maps to the same calendar date across all three charts.
  const signalsByDate = useMemo(() => {
    const map = new Map<string, TechnicalSignalPoint>()
    for (const s of technicalSignals) map.set(s.date, s)
    return map
  }, [technicalSignals])

  const slicedSignals = useMemo(() => {
    if (!signalsByDate.size || !sliced.length) return []
    return sliced.map((p) => signalsByDate.get(p.date) ?? null)
  }, [signalsByDate, sliced])

  // Price dates as unix timestamps (shared across all charts)
  const priceDates = useMemo(
    () => sliced.filter((p) => p.close != null).map((p) => dateToUnix(p.date)),
    [sliced],
  )

  const visiblePhases = useMemo(() => {
    if (!phaseData?.phases.length || !sliced.length) return []
    const firstDate = sliced[0].date
    const lastDate = sliced[sliced.length - 1].date
    return phaseData.phases.filter(
      (p) => p.end_date >= firstDate && p.start_date <= lastDate,
    )
  }, [phaseData, sliced])

  const currentPhase = phaseData?.currentPhase ?? null

  // ── Calculate overlay positions from chart timeScale ──────────
  const recalcOverlays = useCallback(() => {
    const chart = chartRef.current
    if (!chart || !showPhases || !visiblePhases.length) {
      setOverlayRects([])
      return
    }

    const timeScale = chart.timeScale()
    const rects: OverlayRect[] = []

    for (const phase of visiblePhases) {
      const x1 = timeScale.timeToCoordinate(dateToUnix(phase.start_date) as any)
      const x2 = timeScale.timeToCoordinate(dateToUnix(phase.end_date) as any)

      if (x1 == null || x2 == null) continue
      const left = Math.min(x1, x2)
      const width = Math.abs(x2 - x1)
      if (width < 2) continue

      rects.push({
        id: phase.id,
        left,
        width,
        color: PHASE_COLORS[phase.phase_type],
        label: PHASE_SHORT[phase.phase_type],
        clarity: phase.phase_clarity,
        phaseType: phase.phase_type,
      })
    }

    setOverlayRects(rects)
  }, [showPhases, visiblePhases])

  const hasSignals = slicedSignals.some((s) => s != null)

  // ── Single unified chart with stacked price scales ────────────
  useEffect(() => {
    if (!mounted || !lcModule || !chartContainerRef.current || !sliced.length) return

    if (chartRef.current) { chartRef.current.remove(); chartRef.current = null }

    // Vertical layout via scaleMargins (percentage of chart height):
    //   With signals:    Price 0–55%, Volume 50–58%, MACD 60–78%, RSI 80–98%
    //   Without signals: Price 0–85%, Volume 85–100%
    const chart = lcModule.createChart(chartContainerRef.current, {
      layout: {
        background: { color: '#FFFFFF' },
        textColor: '#9C9B99',
        fontFamily: 'monospace',
        fontSize: 10,
      },
      grid: {
        vertLines: { visible: false },
        horzLines: { color: '#F5F4F1' },
      },
      rightPriceScale: {
        borderVisible: false,
        scaleMargins: { top: 0, bottom: hasSignals ? 0.45 : 0.15 },
      },
      timeScale: { borderVisible: false, timeVisible: false, rightOffset: 5 },
      crosshair: {
        horzLine: { color: '#E0E0E5', labelBackgroundColor: '#1A1A1A' },
        vertLine: { color: '#E0E0E5', labelBackgroundColor: '#1A1A1A' },
      },
    })

    chartRef.current = chart

    // ── Candlestick ──
    const candleSeries = chart.addSeries(lcModule.CandlestickSeries, {
      upColor: '#1D9E75', downColor: '#E24B4A',
      wickUpColor: '#1D9E75', wickDownColor: '#E24B4A',
      borderUpColor: '#1D9E75', borderDownColor: '#E24B4A',
    })
    candleSeries.setData(
      sliced.filter((p) => p.close != null).map((p) => ({
        time: dateToUnix(p.date) as any,
        open: p.open ?? p.close!, high: p.high ?? p.close!,
        low: p.low ?? p.close!, close: p.close!,
      })),
    )

    // ── Volume ──
    const volumeSeries = chart.addSeries(lcModule.HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceScaleId: 'volume',
      lastValueVisible: false,
      priceLineVisible: false,
    })
    chart.priceScale('volume').applyOptions({
      scaleMargins: { top: hasSignals ? 0.50 : 0.85, bottom: hasSignals ? 0.42 : 0 },
    })
    volumeSeries.setData(
      sliced.filter((p) => p.volume != null && p.close != null).map((p) => ({
        time: dateToUnix(p.date) as any,
        value: p.volume!,
        color: (p.close! >= (p.open ?? p.close!)) ? 'rgba(29,158,117,0.3)' : 'rgba(226,75,74,0.3)',
      })),
    )

    // ── MACD + RSI (only if signal data exists) ──
    if (hasSignals) {
      // Build date-aligned data arrays
      const histData: any[] = []
      const macdLineData: any[] = []
      const signalLineData: any[] = []
      const rsiData: any[] = []

      for (let i = 0; i < sliced.length; i++) {
        const p = sliced[i]
        if (p.close == null) continue
        const s = slicedSignals[i]
        const time = dateToUnix(p.date) as any
        if (s?.macd_histogram != null)
          histData.push({ time, value: s.macd_histogram, color: s.macd_histogram >= 0 ? 'rgba(29,158,117,0.5)' : 'rgba(226,75,74,0.5)' })
        if (s?.macd_line != null)
          macdLineData.push({ time, value: s.macd_line })
        if (s?.macd_signal != null)
          signalLineData.push({ time, value: s.macd_signal })
        if (s?.rsi_14 != null)
          rsiData.push({ time, value: s.rsi_14 })
      }

      // MACD pane — scaleMargins: 60%–78%
      const macdHistSeries = chart.addSeries(lcModule.HistogramSeries, {
        priceScaleId: 'macd',
        priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
        lastValueVisible: false, priceLineVisible: false,
      })
      chart.priceScale('macd').applyOptions({
        scaleMargins: { top: 0.60, bottom: 0.22 },
        borderVisible: false,
      })
      macdHistSeries.setData(histData)

      chart.addSeries(lcModule.LineSeries, {
        color: '#3B82F6', lineWidth: 2,
        priceScaleId: 'macd',
        priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
        lastValueVisible: false, priceLineVisible: false,
      }).setData(macdLineData)

      chart.addSeries(lcModule.LineSeries, {
        color: '#FF6B6B', lineWidth: 1, lineStyle: 2,
        priceScaleId: 'macd',
        priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
        lastValueVisible: false, priceLineVisible: false,
      }).setData(signalLineData)

      // RSI pane — scaleMargins: 80%–98%
      chart.addSeries(lcModule.LineSeries, {
        color: '#8B5CF6', lineWidth: 2,
        priceScaleId: 'rsi',
        priceFormat: { type: 'price', precision: 1, minMove: 0.1 },
      }).setData(rsiData)

      chart.priceScale('rsi').applyOptions({
        scaleMargins: { top: 0.80, bottom: 0.02 },
        borderVisible: false,
      })

      // RSI reference lines at 30 and 70
      if (rsiData.length >= 2) {
        const first = rsiData[0].time
        const last = rsiData[rsiData.length - 1].time
        for (const [val, clr] of [[70, 'rgba(226,75,74,0.3)'], [30, 'rgba(29,158,117,0.3)']] as const) {
          chart.addSeries(lcModule.LineSeries, {
            color: clr, lineWidth: 1, lineStyle: 2,
            priceScaleId: 'rsi',
            crosshairMarkerVisible: false, lastValueVisible: false, priceLineVisible: false,
          }).setData([{ time: first, value: val }, { time: last, value: val }])
        }
      }
    }

    chart.timeScale().fitContent()
    chart.timeScale().subscribeVisibleLogicalRangeChange(() => recalcOverlays())
    requestAnimationFrame(() => recalcOverlays())

    return () => { chart.remove(); chartRef.current = null }
  }, [mounted, lcModule, sliced, slicedSignals, hasSignals, recalcOverlays])

  // Recalc overlays when phase visibility or selection changes
  useEffect(() => {
    recalcOverlays()
  }, [recalcOverlays, selectedPhaseId])

  // ── Resize handler ────────────────────────────────────────────
  useEffect(() => {
    if (!chartRef.current || !chartContainerRef.current) return
    const observer = new ResizeObserver(() => {
      if (chartRef.current && chartContainerRef.current) {
        chartRef.current.applyOptions({ width: chartContainerRef.current.clientWidth })
        requestAnimationFrame(() => recalcOverlays())
      }
    })
    observer.observe(chartContainerRef.current)
    return () => observer.disconnect()
  }, [mounted, lcModule, recalcOverlays])

  if (!mounted) return <ChartSkeleton height={500} />

  if (priceHistory.length === 0) {
    return (
      <div className="bg-white border border-[#E0E0E5] p-6">
        <p className="text-sm text-[#888888]">Data harga tidak tersedia.</p>
      </div>
    )
  }

  return (
    <div className="bg-white border border-[#E0E0E5]">
      {/* ── Header bar ────────────────────────────────────────────── */}
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
      {/* ── Chart with HTML overlay divs ───────────────────────────── */}
      <div className="px-4 pt-3 pb-1">
        <div ref={chartWrapperRef} className="relative overflow-hidden" style={{ height: hasSignals ? 620 : 380 }}>
          {/* Lightweight-charts canvas */}
          <div ref={chartContainerRef} style={{ height: hasSignals ? 620 : 380, width: '100%' }} />

          {/* Phase overlay divs — positioned absolutely on top of chart */}
          {showPhases && overlayRects.map((rect) => (
            <div
              key={rect.id}
              onClick={() => setSelectedPhaseId(selectedPhaseId === rect.id ? null : rect.id)}
              style={{
                position: 'absolute',
                top: 0,
                left: rect.left,
                width: rect.width,
                height: hasSignals ? '55%' : '100%',
                backgroundColor: hexToRgba(rect.color, selectedPhaseId === rect.id ? 0.20 : 0.10),
                borderTop: `2px solid ${hexToRgba(rect.color, 0.5)}`,
                pointerEvents: 'none',
                zIndex: 1,
              }}
            >
              {rect.width > 35 && (
                <span
                  style={{
                    position: 'absolute',
                    top: 4,
                    left: 4,
                    fontSize: 9,
                    fontFamily: 'monospace',
                    fontWeight: 600,
                    color: hexToRgba(rect.color, 0.85),
                    whiteSpace: 'nowrap',
                    pointerEvents: 'none',
                  }}
                >
                  {rect.label} {rect.clarity}%
                </span>
              )}
            </div>
          ))}
        </div>

        {/* Phase legend */}
        {showPhases && (
          <div className="flex items-center gap-4 mt-1 px-1">
            {(Object.keys(PHASE_COLORS) as MarketPhaseType[]).map((type) => (
              <div key={type} className="flex items-center gap-1">
                <div className="w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: PHASE_COLORS[type], opacity: 0.7 }} />
                <span className="text-[10px] text-[#888888] font-mono">{PHASE_LABELS[type]}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Technical indicator legends ────────────────────────────── */}
      {hasSignals && (
        <div className="flex items-center gap-6 px-5 pb-1">
          <div className="flex items-center gap-2">
            <span className="font-mono text-[10px] font-bold text-[#888888]">MACD (5,20,9)</span>
            <div className="flex items-center gap-1"><div className="w-3 h-0.5 bg-[#3B82F6]" /><span className="text-[9px] text-[#888888] font-mono">MACD</span></div>
            <div className="flex items-center gap-1"><div className="w-3 h-0" style={{ borderTop: '1px dashed #FF6B6B' }} /><span className="text-[9px] text-[#888888] font-mono">Signal</span></div>
          </div>
          <div className="flex items-center gap-2">
            <span className="font-mono text-[10px] font-bold text-[#888888]">RSI (14)</span>
            <div className="flex items-center gap-1"><div className="w-3 h-0.5 bg-[#8B5CF6]" /><span className="text-[9px] text-[#888888] font-mono">RSI</span></div>
            <span className="text-[9px] text-[#AAAAAA] font-mono">30/70</span>
          </div>
        </div>
      )}

      {/* ── Current phase detail banner ────────────────────────────── */}
      {currentPhase && (
        <div className="border-t border-[#E0E0E5]">
          <div className="px-5 py-2.5 border-b border-[#E0E0E5] bg-[#FAFAFA] flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 rounded-full" style={{ backgroundColor: PHASE_COLORS[currentPhase.phase_type] }} />
              <span className="font-mono text-[13px] font-bold" style={{ color: PHASE_COLORS[currentPhase.phase_type] }}>
                Current: {PHASE_LABELS[currentPhase.phase_type]}
              </span>
            </div>
            <span className="font-mono text-[12px] font-bold" style={{ color: clarityColor(currentPhase.phase_clarity) }}>
              {currentPhase.phase_clarity}% conf.
            </span>
          </div>

          <div className="grid grid-cols-3 gap-px bg-[#E0E0E5]">
            <div className="bg-white px-5 py-3">
              <div className="font-mono text-[10px] text-[#888888] tracking-[0.3px] mb-1">PERIOD</div>
              <div className="font-mono text-[12px] text-[#1A1A1A] font-medium">
                {formatDateMed(currentPhase.start_date)} &rarr; {formatDateMed(currentPhase.end_date)}
              </div>
              <div className="font-mono text-[11px] text-[#6D6C6A] mt-0.5">{currentPhase.days} hari</div>
            </div>
            <div className="bg-white px-5 py-3">
              <div className="font-mono text-[10px] text-[#888888] tracking-[0.3px] mb-1">PRICE</div>
              <div className="font-mono text-[12px] text-[#1A1A1A] font-medium">
                {formatPriceCompact(currentPhase.open_price)} &rarr; {formatPriceCompact(currentPhase.close_price)}
              </div>
              <div className={`font-mono text-[11px] font-medium mt-0.5 ${
                currentPhase.change_pct >= 0 ? 'text-[#1D9E75]' : 'text-[#E24B4A]'
              }`}>
                {currentPhase.change_pct >= 0 ? '+' : ''}{currentPhase.change_pct.toFixed(1)}%
              </div>
            </div>
            <div className="bg-white px-5 py-3">
              <div className="font-mono text-[10px] text-[#888888] tracking-[0.3px] mb-1">SMART MONEY</div>
              <div className="flex items-center gap-2 flex-wrap">
                {currentPhase.broker_flow_alignment
                  ? alignmentBadge(currentPhase.broker_flow_alignment)
                  : <span className="text-[11px] text-[#CCCCCC] font-mono">No data</span>
                }
                {currentPhase.bandar_signal_mode && (
                  <span className="inline-block px-1.5 py-0.5 text-[10px] font-medium rounded border border-purple-200 bg-purple-50 text-purple-700">
                    {currentPhase.bandar_signal_mode}
                  </span>
                )}
              </div>
              {currentPhase.smart_money_alignment != null && (
                <div className="flex items-center gap-1.5 mt-1.5">
                  <div className="w-16 h-1.5 bg-[#EDECEA] rounded-full overflow-hidden">
                    <div className="h-full rounded-full" style={{
                      width: `${currentPhase.smart_money_alignment}%`,
                      backgroundColor: clarityColor(currentPhase.smart_money_alignment),
                    }} />
                  </div>
                  <span className="font-mono text-[10px] text-[#6D6C6A]">SM {currentPhase.smart_money_alignment}</span>
                </div>
              )}
            </div>
            <div className="bg-white px-5 py-3">
              <div className="font-mono text-[10px] text-[#888888] tracking-[0.3px] mb-1">TREND</div>
              <div className="font-mono text-[12px] text-[#1A1A1A] font-medium">{trendLabel(currentPhase.trend_strength)}</div>
            </div>
            <div className="bg-white px-5 py-3">
              <div className="font-mono text-[10px] text-[#888888] tracking-[0.3px] mb-1">RANGE (L — H)</div>
              <div className="font-mono text-[12px] text-[#1A1A1A] font-medium">
                {formatPriceCompact(currentPhase.range_low)} — {formatPriceCompact(currentPhase.range_high)}
              </div>
            </div>
            <div className="bg-white px-5 py-3">
              <div className="font-mono text-[10px] text-[#888888] tracking-[0.3px] mb-1">INSIDER</div>
              {currentPhase.insider_activity ? (
                <div className="font-mono text-[12px] text-[#1A1A1A]">
                  <span className="text-[#1D9E75]">{currentPhase.insider_activity.buys} buy</span>
                  {' / '}
                  <span className="text-[#E24B4A]">{currentPhase.insider_activity.sells} sell</span>
                </div>
              ) : (
                <span className="font-mono text-[11px] text-[#CCCCCC]">No data</span>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Phase history table ────────────────────────────────────── */}
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
                  <th className="px-4 py-2 font-mono text-[10px] font-bold text-[#888888] tracking-[0.3px]">FASE</th>
                  <th className="px-4 py-2 font-mono text-[10px] font-bold text-[#888888] tracking-[0.3px]">PERIODE</th>
                  <th className="px-4 py-2 font-mono text-[10px] font-bold text-[#888888] tracking-[0.3px] text-right">HARI</th>
                  <th className="px-4 py-2 font-mono text-[10px] font-bold text-[#888888] tracking-[0.3px] text-right">OPEN &rarr; CLOSE</th>
                  <th className="px-4 py-2 font-mono text-[10px] font-bold text-[#888888] tracking-[0.3px] text-right">RANGE (L-H)</th>
                  <th className="px-4 py-2 font-mono text-[10px] font-bold text-[#888888] tracking-[0.3px] text-right">CHANGE</th>
                  <th className="px-4 py-2 font-mono text-[10px] font-bold text-[#888888] tracking-[0.3px]">TREND</th>
                  <th className="px-4 py-2 font-mono text-[10px] font-bold text-[#888888] tracking-[0.3px] text-right">CONF.</th>
                  <th className="px-4 py-2 font-mono text-[10px] font-bold text-[#888888] tracking-[0.3px]">SMART MONEY</th>
                </tr>
              </thead>
              <tbody>
                {[...visiblePhases].reverse().map((phase) => (
                  <tr
                    key={phase.id}
                    onClick={() => setSelectedPhaseId(selectedPhaseId === phase.id ? null : phase.id)}
                    className={`border-b border-[#F0F0F2] cursor-pointer transition-colors ${
                      selectedPhaseId === phase.id ? 'bg-[#F0F3FF]' : 'hover:bg-[#FAFAFA]'
                    }`}
                  >
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-1.5">
                        <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: PHASE_COLORS[phase.phase_type] }} />
                        <span className="font-mono text-[11px] font-medium" style={{ color: PHASE_COLORS[phase.phase_type] }}>
                          {PHASE_LABELS[phase.phase_type]}
                        </span>
                        {phase.is_current && (
                          <span className="text-[8px] font-bold bg-[#1A1A1A] text-white px-1 py-0.5 rounded tracking-wider">NOW</span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-2.5 font-mono text-[11px] text-[#6D6C6A] whitespace-nowrap">
                      {formatDateMed(phase.start_date)} &rarr; {formatDateMed(phase.end_date)}
                    </td>
                    <td className="px-4 py-2.5 font-mono text-[11px] text-[#6D6C6A] text-right">{phase.days}d</td>
                    <td className="px-4 py-2.5 font-mono text-[11px] text-[#1A1A1A] text-right whitespace-nowrap">
                      {formatPriceCompact(phase.open_price)} &rarr; {formatPriceCompact(phase.close_price)}
                    </td>
                    <td className="px-4 py-2.5 font-mono text-[11px] text-[#6D6C6A] text-right whitespace-nowrap">
                      {formatPriceCompact(phase.range_low)} - {formatPriceCompact(phase.range_high)}
                    </td>
                    <td className={`px-4 py-2.5 font-mono text-[11px] font-medium text-right ${
                      phase.change_pct >= 0 ? 'text-[#1D9E75]' : 'text-[#E24B4A]'
                    }`}>
                      {phase.change_pct >= 0 ? '+' : ''}{phase.change_pct.toFixed(1)}%
                    </td>
                    <td className="px-4 py-2.5 font-mono text-[11px] text-[#6D6C6A]">{trendLabel(phase.trend_strength)}</td>
                    <td className="px-4 py-2.5 text-right">
                      <div className="flex items-center justify-end gap-1.5">
                        <div className="w-12 h-1.5 bg-[#EDECEA] rounded-full overflow-hidden">
                          <div className="h-full rounded-full" style={{
                            width: `${phase.phase_clarity}%`,
                            backgroundColor: clarityColor(phase.phase_clarity),
                          }} />
                        </div>
                        <span className="font-mono text-[10px] font-medium" style={{ color: clarityColor(phase.phase_clarity) }}>
                          {phase.phase_clarity}%
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-1 flex-wrap">
                        {phase.broker_flow_alignment && alignmentBadge(phase.broker_flow_alignment)}
                        {phase.bandar_signal_mode && (
                          <span className="text-[10px] font-mono text-purple-600 font-medium">{phase.bandar_signal_mode}</span>
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

      {/* ── Disclaimer ─────────────────────────────────────────────── */}
      <div className="px-5 py-2 border-t border-[#E0E0E5] bg-[#FAFAFA]">
        <p className="font-mono text-[9px] text-[#AAAAAA] leading-relaxed">
          Indikator berbasis SMA(20/50) crossover + ATR. Bukan analisis Wyckoff struktural.
          Bukan sinyal beli/jual. Gunakan sebagai konteks tambahan, bukan dasar keputusan.
        </p>
      </div>
    </div>
  )
}
