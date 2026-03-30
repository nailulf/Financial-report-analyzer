'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import type { AIAnalysis } from '@/lib/types/api'

interface Props {
  ticker: string
}

// ---------------------------------------------------------------------------
// Tooltip — renders via portal to avoid overflow clipping
// ---------------------------------------------------------------------------

function Tooltip({ children, text }: { children: React.ReactNode; text: string }) {
  const [show, setShow] = useState(false)
  const [coords, setCoords] = useState({ top: 0, left: 0 })
  const ref = useRef<HTMLSpanElement>(null)
  const [mounted, setMounted] = useState(false)

  useEffect(() => setMounted(true), [])

  const handleEnter = useCallback(() => {
    if (ref.current) {
      const rect = ref.current.getBoundingClientRect()
      setCoords({
        top: rect.top + window.scrollY - 8,
        left: rect.left + rect.width / 2,
      })
    }
    setShow(true)
  }, [])

  return (
    <span
      ref={ref}
      className="inline-block cursor-help"
      onMouseEnter={handleEnter}
      onMouseLeave={() => setShow(false)}
    >
      {children}
      {show && mounted && createPortal(
        <span
          className="fixed z-[9999] pointer-events-none"
          style={{ top: coords.top, left: coords.left, transform: 'translate(-50%, -100%)' }}
        >
          <span className="block px-3 py-2.5 rounded-lg bg-white text-[#1A1918] text-[11px] font-mono leading-[1.6] w-[280px] text-left shadow-2xl border border-[#E0E0E5]">
            {text}
          </span>
          <span className="block w-0 h-0 mx-auto border-[6px] border-transparent border-t-white" style={{ marginTop: '-1px' }} />
        </span>,
        document.body,
      )}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Badge components with tooltips
// ---------------------------------------------------------------------------

const LYNCH_TOOLTIPS: Record<string, string> = {
  stalwart:    'Stalwart (Peter Lynch): Perusahaan besar berkualitas dengan pertumbuhan 10-12%. Tahan resesi, kenaikan moderat 15-50%. Cocok sebagai core holding.',
  slow_grower: 'Slow Grower (Peter Lynch): Perusahaan besar dan matang, pertumbuhan 2-4%. Dibeli untuk dividen, bukan capital gain.',
  fast_grower: 'Fast Grower (Peter Lynch): Perusahaan kecil/menengah agresif, pertumbuhan 20%+. Potensi keuntungan tertinggi tapi berisiko.',
  cyclical:    'Cyclical (Peter Lynch): Pendapatan naik-turun mengikuti siklus ekonomi atau komoditas. Timing lebih penting dari valuasi. PE rendah bisa berarti puncak siklus.',
  turnaround:  'Turnaround (Peter Lynch): Perusahaan dalam krisis atau pemulihan. Hasil bisa binary — sangat untung atau rugi total.',
  asset_play:  'Asset Play (Peter Lynch): Perusahaan dengan aset berharga (tanah, kas, IP, anak usaha) yang belum tercermin di harga saham.',
}

const MOAT_TOOLTIPS: Record<string, string> = {
  wide:   'Wide Moat (Warren Buffett): Keunggulan kompetitif yang kuat dan tahan lama — pricing power, switching cost tinggi, network effect, atau keunggulan biaya struktural. Sulit ditiru kompetitor.',
  narrow: 'Narrow Moat (Warren Buffett): Keunggulan kompetitif ada tapi terbatas — bisa dari skala, lokasi, atau regulasi. Perlu dipantau karena bisa terkikis seiring waktu.',
  none:   'No Moat (Warren Buffett): Tidak ada keunggulan kompetitif yang jelas. Perusahaan bersaing di harga — margin bisa tertekan kapan saja oleh kompetitor.',
}

function LynchBadge({ category }: { category: string }) {
  const styles: Record<string, string> = {
    stalwart:    'bg-blue-500/20 text-blue-300 border-blue-500/30',
    slow_grower: 'bg-gray-500/20 text-gray-300 border-gray-500/30',
    fast_grower: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30',
    cyclical:    'bg-amber-500/20 text-amber-300 border-amber-500/30',
    turnaround:  'bg-purple-500/20 text-purple-300 border-purple-500/30',
    asset_play:  'bg-teal-500/20 text-teal-300 border-teal-500/30',
  }
  const labels: Record<string, string> = {
    stalwart: 'STALWART', slow_grower: 'SLOW GROWER', fast_grower: 'FAST GROWER',
    cyclical: 'CYCLICAL', turnaround: 'TURNAROUND', asset_play: 'ASSET PLAY',
  }
  return (
    <Tooltip text={LYNCH_TOOLTIPS[category] ?? 'Kategori saham menurut Peter Lynch.'}>
      <span className={`font-mono text-[10px] font-bold tracking-[0.5px] px-2 py-0.5 border rounded ${styles[category] ?? 'bg-gray-500/20 text-gray-300 border-gray-500/30'}`}>
        {labels[category] ?? category.toUpperCase()}
      </span>
    </Tooltip>
  )
}

function MoatBadge({ moat }: { moat: string }) {
  const styles: Record<string, string> = {
    wide:   'bg-emerald-500/20 text-emerald-300 border-emerald-500/30',
    narrow: 'bg-amber-500/20 text-amber-300 border-amber-500/30',
    none:   'bg-red-500/20 text-red-400 border-red-500/30',
  }
  return (
    <Tooltip text={MOAT_TOOLTIPS[moat] ?? 'Penilaian moat menurut Warren Buffett.'}>
      <span className={`font-mono text-[10px] font-bold tracking-[0.5px] px-2 py-0.5 border rounded ${styles[moat] ?? 'bg-gray-500/20 text-gray-300 border-gray-500/30'}`}>
        MOAT: {moat.toUpperCase()}
      </span>
    </Tooltip>
  )
}

function VerdictBadge({ verdict }: { verdict: string }) {
  const styles: Record<string, string> = {
    strong_buy:  'bg-emerald-500 text-white shadow-emerald-500/30 shadow-lg',
    buy:         'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30',
    hold:        'bg-amber-500/20 text-amber-300 border border-amber-500/30',
    avoid:       'bg-red-500/20 text-red-400 border border-red-500/30',
    strong_avoid:'bg-red-500 text-white shadow-red-500/30 shadow-lg',
  }
  const labels: Record<string, string> = {
    strong_buy: 'STRONG BUY', buy: 'BUY', hold: 'HOLD', avoid: 'AVOID', strong_avoid: 'STRONG AVOID',
  }
  return (
    <span className={`font-mono text-[11px] font-bold tracking-[0.5px] px-3 py-1 rounded ${styles[verdict] ?? 'bg-gray-500/20 text-gray-300'}`}>
      {labels[verdict] ?? verdict.toUpperCase()}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Scenario card (for bull/bear/neutral)
// ---------------------------------------------------------------------------

function ProbabilityBadge({ probability }: { probability: string }) {
  const styles: Record<string, string> = {
    high:   'bg-emerald-500/20 text-emerald-300 border-emerald-500/30',
    medium: 'bg-amber-500/20 text-amber-300 border-amber-500/30',
    low:    'bg-red-500/20 text-red-400 border-red-500/30',
  }
  return (
    <span className={`font-mono text-[9px] font-bold tracking-[0.5px] px-1.5 py-0.5 rounded border ${styles[probability] ?? 'bg-gray-500/20 text-gray-300 border-gray-500/30'}`}>
      {probability.toUpperCase()}
    </span>
  )
}

function fmtPrice(n: number | null | undefined): string {
  if (n == null) return '—'
  return `Rp ${n.toLocaleString('en')}`
}

function ScenarioCard({ label, borderColor, icon, scenario, drivers, priceLabel, priceValue, timeframe, probability, signals }: {
  label: string
  borderColor: string
  icon: string
  scenario: string
  drivers: string[]
  priceLabel: string
  priceValue: string
  timeframe: string
  probability: string
  signals: string[]
}) {
  return (
    <div className={`border rounded-lg overflow-hidden bg-white/5 ${borderColor}`}>
      <div className="px-4 py-2.5 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-sm">{icon}</span>
          <span className="font-mono text-[11px] font-bold tracking-[0.5px] text-white/90">{label}</span>
        </div>
        <div className="flex items-center gap-2">
          <ProbabilityBadge probability={probability} />
          <span className="font-mono text-[10px] text-white/40">{timeframe}</span>
        </div>
      </div>
      <div className="px-4 pb-3">
        <p className="font-mono text-[11px] text-white/70 leading-[1.6] mb-2">{scenario}</p>
        <div className="flex items-center gap-2 mb-2">
          <span className="font-mono text-[10px] text-white/40">{priceLabel}:</span>
          <span className="font-mono text-[12px] font-bold text-white/90">{priceValue}</span>
        </div>
        {drivers.length > 0 && (
          <div className="flex flex-col gap-0.5 mb-2">
            <span className="font-mono text-[9px] font-bold tracking-[0.5px] text-white/30 uppercase">Faktor Pendorong</span>
            {drivers.map((d, i) => (
              <div key={i} className="flex items-start gap-1.5">
                <span className="font-mono text-[10px] text-white/30 mt-0.5 shrink-0">•</span>
                <span className="font-mono text-[10px] text-white/60 leading-[1.4]">{d}</span>
              </div>
            ))}
          </div>
        )}
        {signals.length > 0 && (
          <div className="flex flex-col gap-0.5">
            <span className="font-mono text-[9px] font-bold tracking-[0.5px] text-white/30 uppercase">Tanda Awal</span>
            {signals.map((s, i) => (
              <div key={i} className="flex items-start gap-1.5">
                <span className="font-mono text-[10px] text-white/30 mt-0.5 shrink-0">▸</span>
                <span className="font-mono text-[10px] text-white/60 leading-[1.4]">{s}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Collapsible thesis section
// ---------------------------------------------------------------------------

function ThesisSection({ bull, neutral, bear }: {
  bull: AIAnalysis['bullCase']
  neutral: AIAnalysis['neutralCase']
  bear: AIAnalysis['bearCase']
}) {
  const [open, setOpen] = useState(false)
  if (!bull && !neutral && !bear) return null

  return (
    <div className="px-6 py-4">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between group"
      >
        <span className="font-mono text-[11px] font-bold tracking-[1px] text-white/40 uppercase group-hover:text-white/60 transition-colors">
          Tesis Investasi — 3 Skenario
        </span>
        <span className="font-mono text-[10px] text-white/25 group-hover:text-white/50 transition-colors">
          {open ? '▲ Tutup' : '▼ Lihat Detail'}
        </span>
      </button>

      {open && (
        <div className="flex flex-col gap-3 mt-4">
          {bull && (
            <ScenarioCard
              label="BULL CASE"
              borderColor="border-emerald-500/20"
              icon="📈"
              scenario={bull.scenario}
              drivers={bull.drivers ?? []}
              priceLabel="Target"
              priceValue={fmtPrice(bull.price_target)}
              timeframe={bull.timeframe ?? ''}
              probability={bull.probability ?? 'low'}
              signals={bull.early_signs ?? []}
            />
          )}
          {neutral && (
            <ScenarioCard
              label="NEUTRAL — MOST LIKELY"
              borderColor="border-white/10"
              icon="➡️"
              scenario={neutral.scenario}
              drivers={neutral.drivers ?? []}
              priceLabel="Range"
              priceValue={`${fmtPrice(neutral.price_range_low)} – ${fmtPrice(neutral.price_range_high)}`}
              timeframe={neutral.timeframe ?? ''}
              probability={neutral.probability ?? 'high'}
              signals={neutral.what_breaks_it ?? []}
            />
          )}
          {bear && (
            <ScenarioCard
              label="BEAR CASE"
              borderColor="border-red-500/20"
              icon="📉"
              scenario={bear.scenario}
              drivers={bear.drivers ?? []}
              priceLabel="Target"
              priceValue={fmtPrice(bear.price_target)}
              timeframe={bear.timeframe ?? ''}
              probability={bear.probability ?? 'medium'}
              signals={bear.early_signs ?? []}
            />
          )}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main widget
// ---------------------------------------------------------------------------

export function AIInsightsWidget({ ticker }: Props) {
  const [data, setData] = useState<AIAnalysis | null>(null)
  const [loading, setLoading] = useState(true)
  const [generating, setGenerating] = useState(false)
  const [genStatus, setGenStatus] = useState<string | null>(null)

  useEffect(() => {
    fetch(`/api/stocks/${ticker}/ai-analysis`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setData(d))
      .catch(() => null)
      .finally(() => setLoading(false))
  }, [ticker])

  const handleGenerate = useCallback(async () => {
    setGenerating(true)
    setGenStatus('Memulai pipeline...')
    try {
      // Step 1: Trigger the pipeline via GitHub Actions
      const triggerRes = await fetch(`/api/stocks/${ticker}/trigger-ai-analysis`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      const triggerBody = await triggerRes.json().catch(() => ({}))

      if (!triggerRes.ok) {
        setGenStatus(`Gagal: ${triggerBody.error ?? 'unknown error'}`)
        setGenerating(false)
        return
      }

      if (triggerBody.dispatch_ok === false) {
        // GitHub dispatch failed — show manual command
        setGenStatus(triggerBody.manual_command
          ? `GitHub Actions tidak tersedia. Jalankan manual:\n${triggerBody.manual_command}`
          : `Dispatch gagal: ${triggerBody.dispatch_error ?? 'unknown'}`)
        setGenerating(false)
        return
      }

      setGenStatus('Pipeline berjalan via GitHub Actions — proses memerlukan 1-3 menit...')

      // Step 2: Poll for result (check every 10s, max 3 minutes)
      let attempts = 0
      const maxAttempts = 18
      const poll = async (): Promise<'done' | 'not_ready' | 'waiting'> => {
        // Check if AI analysis exists
        const aiRes = await fetch(`/api/stocks/${ticker}/ai-analysis`)
        if (aiRes.ok) {
          const result = await aiRes.json()
          if (result && result.analystVerdict) {
            setData(result)
            setGenStatus(null)
            return 'done'
          }
        }

        // Check if pipeline ran but stock wasn't eligible
        const qualityRes = await fetch(`/api/stocks/${ticker}/context-quality`)
        if (qualityRes.ok) {
          const quality = await qualityRes.json()
          if (quality && quality.readyForAI === false && quality.compositeScore != null) {
            // Pipeline ran, but stock didn't pass the gate
            setGenStatus(
              `Data saham ini belum memenuhi syarat untuk analisis AI.\n` +
              `Reliability: ${quality.reliabilityGrade ?? '?'} (${quality.reliabilityScore ?? 0}/100)\n` +
              `Confidence: ${quality.confidenceGrade ?? '?'} (${quality.confidenceScore ?? 0}/100)\n` +
              `Composite: ${quality.compositeScore}/100\n\n` +
              `Syarat minimum: Reliability ≥ 45, Confidence ≥ 40, minimal 3 tahun data bersih.\n` +
              (quality.dataGapFlags?.length ? `Data gaps: ${quality.dataGapFlags.join(', ')}` : '')
            )
            return 'not_ready'
          }
        }

        return 'waiting'
      }

      const interval = setInterval(async () => {
        attempts++
        if (attempts > maxAttempts) {
          clearInterval(interval)
          setGenStatus('Timeout — cek GitHub Actions log atau jalankan manual:\npython run_all.py --ai-full --ticker ' + ticker + ' --ai-model gpt-4o-mini')
          setGenerating(false)
          return
        }
        try {
          const status = await poll()
          if (status === 'done' || status === 'not_ready') {
            clearInterval(interval)
            setGenerating(false)
          } else if (attempts > 6) {
            setGenStatus(`Pipeline berjalan... (${attempts * 10}s)`)
          }
        } catch {
          // ignore transient errors
        }
      }, 10000)

    } catch (e) {
      setGenStatus(`Error: ${e instanceof Error ? e.message : 'unknown'}`)
      setGenerating(false)
    }
  }, [ticker])

  if (loading) {
    return (
      <div className="px-12 py-2">
        <div className="bg-[#0F0F10] rounded-xl p-6 animate-pulse">
          <div className="h-4 bg-white/10 rounded w-48 mb-4" />
          <div className="h-32 bg-white/5 rounded" />
        </div>
      </div>
    )
  }

  // Empty state — show generate button
  if (!data) {
    return (
      <div className="px-12 py-2">
        <div className="bg-[#0F0F10] rounded-xl p-6 border border-white/5">
          <div className="flex items-center gap-2 mb-4">
            <span className="text-sm">&#10024;</span>
            <span className="font-mono text-[13px] font-bold tracking-[0.5px] text-white/90">AI ANALYSIS</span>
          </div>

          {generating ? (
            <div className="flex flex-col items-center py-6 gap-3">
              <div className="w-6 h-6 border-2 border-emerald-400 border-t-transparent rounded-full animate-spin" />
              <p className="font-mono text-[12px] text-white/50 text-center">{genStatus}</p>
            </div>
          ) : genStatus ? (
            <div className="flex flex-col gap-3">
              <pre className="font-mono text-[11px] text-amber-400/70 whitespace-pre-wrap break-all bg-white/5 rounded-lg p-3">{genStatus}</pre>
              <button
                onClick={handleGenerate}
                className="self-start font-mono text-[11px] font-bold px-4 py-2 rounded-lg bg-white/10 text-white/70 hover:bg-white/15 hover:text-white transition-colors border border-white/10"
              >
                Coba Lagi
              </button>
            </div>
          ) : (
            <div className="flex flex-col items-center py-4 gap-4">
              <p className="font-mono text-[12px] text-white/40 text-center max-w-md">
                Analisis AI belum tersedia untuk saham ini. Generate analisis investasi lengkap
                dengan 3 skenario (bull/neutral/bear), klasifikasi Lynch, dan rekomendasi strategi.
              </p>
              <button
                onClick={handleGenerate}
                className="font-mono text-[12px] font-bold px-5 py-2.5 rounded-lg bg-gradient-to-r from-emerald-500 to-teal-500 text-white hover:from-emerald-400 hover:to-teal-400 transition-all shadow-lg shadow-emerald-500/20"
              >
                &#10024; Generate AI Analysis
              </button>
              <p className="font-mono text-[10px] text-white/20">
                Estimasi biaya: ~$0.03 per saham (GPT-4o-mini)
              </p>
            </div>
          )}
        </div>
      </div>
    )
  }

  const bull = data.bullCase
  const bear = data.bearCase
  const neutral = data.neutralCase

  return (
    <div className="px-12 py-2">
      <div className="bg-[#0F0F10] rounded-xl border border-white/[0.06] overflow-hidden shadow-2xl shadow-black/20">

        {/* ── Header ── */}
        <div className="px-6 pt-5 pb-4 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <span className="text-base">&#10024;</span>
            <span className="font-mono text-[14px] font-bold tracking-[1px] text-white/90">AI ANALYSIS</span>
            <span className="font-mono text-[10px] text-white/20 ml-1">POWERED BY AI</span>
          </div>
          <div className="flex items-center gap-2">
            <LynchBadge category={data.lynchCategory} />
            {data.buffettMoat && <MoatBadge moat={data.buffettMoat} />}
            <VerdictBadge verdict={data.analystVerdict} />
          </div>
        </div>

        {/* ── Business narrative ── */}
        <div className="px-6 pb-4">
          {data.businessNarrative && (
            <p className="font-mono text-[12px] text-white/60 leading-[1.7]">
              {data.businessNarrative}
            </p>
          )}
        </div>

        {/* ── Strategy + What to Watch row ── */}
        <div className="px-6 pb-4 grid grid-cols-2 gap-4">
          {/* Strategy */}
          {data.strategyFit && (
            <div className="bg-white/[0.04] rounded-lg px-4 py-3 border border-white/[0.06]">
              <div className="flex items-center gap-2 mb-1.5">
                <span className="font-mono text-[9px] font-bold tracking-[1px] text-white/30 uppercase">Strategi</span>
                <span className="font-mono text-[11px] font-semibold text-white/80">
                  {data.strategyFit.primary.replace(/_/g, ' ').toUpperCase()}
                </span>
              </div>
              <p className="font-mono text-[10px] text-white/50 leading-[1.5]">{data.strategyFit.ideal_investor}</p>
              <span className={`inline-block font-mono text-[9px] font-bold tracking-[0.5px] px-2 py-0.5 rounded mt-2 ${
                data.strategyFit.position_sizing === 'full_position' ? 'bg-emerald-500/20 text-emerald-300' :
                data.strategyFit.position_sizing === 'half_position' ? 'bg-blue-500/20 text-blue-300' :
                data.strategyFit.position_sizing === 'small_speculative' ? 'bg-amber-500/20 text-amber-300' :
                'bg-red-500/20 text-red-400'
              }`}>
                {data.strategyFit.position_sizing.replace(/_/g, ' ').toUpperCase()}
              </span>
            </div>
          )}

          {/* What to watch */}
          {data.whatToWatch && data.whatToWatch.length > 0 && (
            <div className="bg-white/[0.04] rounded-lg px-4 py-3 border border-white/[0.06]">
              <span className="font-mono text-[9px] font-bold tracking-[1px] text-white/30 uppercase">Yang Perlu Dipantau</span>
              <div className="flex flex-col gap-1.5 mt-1.5">
                {data.whatToWatch.slice(0, 4).map((w, i) => (
                  <div key={i} className="flex items-start gap-2">
                    <span className="font-mono text-[10px] text-emerald-400/60 mt-0.5 shrink-0">▸</span>
                    <span className="font-mono text-[10px] text-white/50 leading-[1.4]">{w}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* ── Divider ── */}
        <div className="mx-6 h-px bg-white/[0.06]" />

        {/* ── Investment Thesis: 3 Scenarios (collapsible) ── */}
        <ThesisSection bull={bull} neutral={neutral} bear={bear} />

        {/* ── Conclusion: Target / Masuk / Stop Loss ── */}
        {(bull || neutral || bear) && (
          <>
            <div className="mx-6 h-px bg-white/[0.06]" />
            <div className="px-6 py-5">
              <span className="font-mono text-[11px] font-bold tracking-[1px] text-white/40 uppercase mb-4 block">Kesimpulan</span>
              <div className="grid grid-cols-3 gap-3">
                {/* Target (from bull case) */}
                <div className="bg-emerald-500/[0.08] border border-emerald-500/20 rounded-lg px-4 py-3 text-center">
                  <span className="font-mono text-[9px] font-bold tracking-[1px] text-emerald-400/50 uppercase block mb-1">Target</span>
                  <span className="font-mono text-[20px] font-bold text-emerald-300 block">
                    {bull?.price_target ? fmtPrice(bull.price_target) : '—'}
                  </span>
                  <span className="font-mono text-[10px] text-emerald-400/40 block mt-0.5">
                    {bull?.timeframe ?? ''}
                  </span>
                </div>

                {/* Masuk / Entry (from neutral low range) */}
                <div className="bg-blue-500/[0.08] border border-blue-500/20 rounded-lg px-4 py-3 text-center">
                  <span className="font-mono text-[9px] font-bold tracking-[1px] text-blue-400/50 uppercase block mb-1">Masuk</span>
                  <span className="font-mono text-[20px] font-bold text-blue-300 block">
                    {neutral?.price_range_low ? fmtPrice(neutral.price_range_low) : '—'}
                  </span>
                  {neutral?.price_range_high && (
                    <span className="font-mono text-[10px] text-blue-400/40 block mt-0.5">
                      s/d {fmtPrice(neutral.price_range_high)}
                    </span>
                  )}
                </div>

                {/* Stop Loss (from bear case) */}
                <div className="bg-red-500/[0.08] border border-red-500/20 rounded-lg px-4 py-3 text-center">
                  <span className="font-mono text-[9px] font-bold tracking-[1px] text-red-400/50 uppercase block mb-1">Stop Loss</span>
                  <span className="font-mono text-[20px] font-bold text-red-400 block">
                    {bear?.price_target ? fmtPrice(bear.price_target) : '—'}
                  </span>
                  <span className="font-mono text-[10px] text-red-400/40 block mt-0.5">
                    {bear?.timeframe ?? ''}
                  </span>
                </div>
              </div>
            </div>
          </>
        )}

        {/* ── Caveats + Data Gaps ── */}
        {((data.caveats && data.caveats.length > 0) || (data.dataGapsAcknowledged && data.dataGapsAcknowledged.length > 0)) && (
          <>
            <div className="mx-6 h-px bg-white/[0.06]" />
            <div className="px-6 py-4 grid grid-cols-2 gap-4">
              {data.caveats && data.caveats.length > 0 && (
                <div>
                  <span className="font-mono text-[9px] font-bold tracking-[1px] text-white/25 uppercase">Catatan</span>
                  {data.caveats.map((c, i) => (
                    <p key={i} className="font-mono text-[10px] text-white/35 leading-[1.5] mt-1">{c}</p>
                  ))}
                </div>
              )}
              {data.dataGapsAcknowledged && data.dataGapsAcknowledged.length > 0 && (
                <div>
                  <span className="font-mono text-[9px] font-bold tracking-[1px] text-white/25 uppercase">Keterbatasan Data</span>
                  {data.dataGapsAcknowledged.map((g, i) => (
                    <p key={i} className="font-mono text-[10px] text-white/35 leading-[1.5] mt-1">{g}</p>
                  ))}
                </div>
              )}
            </div>
          </>
        )}

        {/* ── Footer ── */}
        <div className="px-6 py-3 bg-white/[0.02] border-t border-white/[0.04] flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="font-mono text-[10px] text-white/25">Confidence: {data.confidenceLevel}/10</span>
            {data.lynchRationale && (
              <span className="font-mono text-[10px] text-white/20 italic max-w-[400px] truncate">
                "{data.lynchRationale}"
              </span>
            )}
          </div>
          <span className="font-mono text-[10px] text-white/20">
            {data.modelUsed} • {data.generatedAt ? new Date(data.generatedAt).toLocaleDateString() : ''}
          </span>
        </div>

      </div>
    </div>
  )
}
