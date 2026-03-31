'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import type { DataQuality, QualityCategory, StockbitPreviewRow, RefreshJob, RefreshScraperProgress, CategoryFreshness } from '@/lib/types/api'
import { AlternativeSources } from '@/components/stock/alternative-sources'
import { useToast } from '@/components/ui/toast'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function scoreBand(score: number): { label: string; textColor: string; barColor: string } {
  if (score >= 80) return { label: 'Good',    textColor: 'text-green-600', barColor: 'bg-green-500' }
  if (score >= 50) return { label: 'Partial', textColor: 'text-amber-500', barColor: 'bg-amber-400' }
  return              { label: 'Thin',    textColor: 'text-red-500',   barColor: 'bg-red-500'   }
}

/** SSR-safe: returns static placeholder until client-side hydration. */
function relativeTime(iso: string | null, isMounted: boolean): string {
  if (!iso) return 'never'
  if (!isMounted) return '—'
  const diffDays = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000)
  if (diffDays === 0) return 'today'
  if (diffDays === 1) return '1 day ago'
  if (diffDays < 30)  return `${diffDays} days ago`
  const months = Math.floor(diffDays / 30)
  return `${months} month${months > 1 ? 's' : ''} ago`
}

function formatIDR(n: number | null | undefined): string {
  if (n == null) return '-'
  const abs = Math.abs(n)
  if (abs >= 1e12) return `${(n / 1e12).toFixed(1)}T`
  if (abs >= 1e9)  return `${(n / 1e9).toFixed(1)}B`
  if (abs >= 1e6)  return `${(n / 1e6).toFixed(1)}M`
  const sign = n < 0 ? '-' : ''
  const withSep = String(Math.round(abs)).replace(/\B(?=(\d{3})+(?!\d))/g, '.')
  return `${sign}${withSep}`
}

const CATEGORY_LABELS: Record<string, string> = {
  price_history:        'Price History',
  annual_coverage:      'Annual Financials Coverage',
  annual_quality:       'Annual Financials Quality',
  quarterly_financials: 'Quarterly Financials',
  quarterly_reports:    'Quarterly Report PDFs',
  annual_reports:       'Annual Report PDFs',
  company_profile:      'Company Profile',
  board_commissioners:  'Board & Commissioners',
  shareholders:         'Shareholders ≥1%',
  corporate_events:     'Corporate Events',
  derived_metrics:      'Derived Metrics',
}

// ---------------------------------------------------------------------------
// Sub-components (unchanged)
// ---------------------------------------------------------------------------

function ScoreBar({ score, max, barColor }: { score: number; max: number; barColor: string }) {
  const pct = max > 0 ? Math.round((score / max) * 100) : 0
  return (
    <div className="h-1.5 w-full bg-[#EDECEA] rounded-full overflow-hidden">
      <div className={`h-full rounded-full transition-all ${barColor}`} style={{ width: `${pct}%` }} />
    </div>
  )
}

function ScoreLine({
  label,
  score,
  max = 100,
  showFraction = false,
}: {
  label: string
  score: number | null
  max?: number
  showFraction?: boolean
}) {
  if (score == null) {
    return (
      <div className="space-y-1">
        <div className="flex items-center justify-between text-sm">
          <span className="text-[#6D6C6A]">{label}</span>
          <span className="text-[#9C9B99] text-xs">Not computed yet</span>
        </div>
        <div className="h-1.5 w-full bg-[#EDECEA] rounded-full" />
      </div>
    )
  }

  const { label: bandLabel, textColor, barColor } = scoreBand((score / max) * 100)
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-sm">
        <span className="text-[#6D6C6A]">{label}</span>
        <div className="flex items-center gap-2">
          {showFraction && (
            <span className="text-xs text-[#9C9B99]">{score} / {max}</span>
          )}
          <span className={`font-semibold tabular-nums ${textColor}`}>{score}</span>
          <span className={`text-xs ${textColor}`}>{bandLabel}</span>
        </div>
      </div>
      <ScoreBar score={score} max={max} barColor={barColor} />
    </div>
  )
}

function CategoryRow({ name, cat }: { name: string; cat: QualityCategory }) {
  const pct = cat.max > 0 ? Math.round((cat.score / cat.max) * 100) : 0
  const { barColor } = scoreBand(pct)

  return (
    <tr className="border-b border-[#E5E4E1] last:border-0">
      <td className="py-2 pr-4 text-sm text-[#1A1918] whitespace-nowrap">
        {CATEGORY_LABELS[name] ?? name}
      </td>
      <td className="py-2 pr-3 w-32">
        <ScoreBar score={cat.score} max={cat.max} barColor={barColor} />
      </td>
      <td className="py-2 text-right text-sm tabular-nums text-[#6D6C6A] whitespace-nowrap">
        {cat.score} / {cat.max}
      </td>
      <td className="py-2 pl-4 text-xs text-[#9C9B99] hidden sm:table-cell">
        {cat.detail}
      </td>
    </tr>
  )
}

// ---------------------------------------------------------------------------
// Comprehensive Refresh Wizard
// ---------------------------------------------------------------------------

type WizardStep =
  | 'token'      // Step 1: enter Stockbit bearer token
  | 'freshness'  // Step 2: data freshness check + scraper selection
  | 'config'     // Step 3: configure financial period + broker days (conditional)
  | 'fetching'   // Loading: calling Stockbit API for preview
  | 'preview'    // Step 4: show data preview + confirm (conditional)
  | 'running'    // Step 5: executing scrapers (polling for progress)
  | 'done'       // Step 6: all scrapers finished
  | 'error'      // Any error

// Use a fixed year constant to avoid SSR/client hydration mismatch at year boundary
const CURRENT_YEAR = 2026
const DEFAULT_YEAR_TO = CURRENT_YEAR - 1
const YEAR_OPTIONS = Array.from({ length: CURRENT_YEAR - 2014 }, (_, i) => 2015 + i)
const BROKER_DAY_OPTIONS = [10, 20, 30, 45, 60]

const SCRAPER_LABELS: Record<string, string> = {
  stock_universe:      'Info Emiten',
  financials_fallback: 'Data Keuangan (Stockbit)',
  company_profiles:    'Profil Perusahaan',
  document_links:      'Dokumen Publik',
  corporate_events:    'Aksi Korporasi',
  daily_prices:        'Harga Harian',
  money_flow:          'Arus Dana Asing',
  dividend_scraper:    'Riwayat Dividen',
  broker_backfill:     'Broker Summary',
}

function freshnessIcon(status: string): { icon: string; color: string; bg: string } {
  switch (status) {
    case 'fresh':   return { icon: '✓', color: '#3D8A5A', bg: '#C8F0D8' }
    case 'stale':   return { icon: '⚠', color: '#D97706', bg: '#FEF3C7' }
    default:        return { icon: '✗', color: '#DC2626', bg: '#FEE2E2' }
  }
}

function scraperStatusIcon(status: string): { icon: string; color: string; bg: string } {
  switch (status) {
    case 'done':    return { icon: '✓', color: '#3D8A5A', bg: '#C8F0D8' }
    case 'running': return { icon: '↻', color: '#D97706', bg: '#FEF3C7' }
    case 'failed':  return { icon: '✗', color: '#DC2626', bg: '#FEE2E2' }
    default:        return { icon: '·', color: '#9C9B99', bg: '#F5F4F1' }
  }
}

function StockbitRefreshModal({
  ticker,
  visible,
  onClose,
}: {
  ticker: string
  visible: boolean
  onClose: () => void
}) {
  const [step, setStep]               = useState<WizardStep>('token')
  const [token, setToken]             = useState('')
  const [freshness, setFreshness]     = useState<CategoryFreshness[]>([])
  const [selectedScrapers, setSelectedScrapers] = useState<Set<string>>(new Set())
  const [loadingFreshness, setLoadingFreshness] = useState(false)
  const [yearFrom, setYearFrom]       = useState(CURRENT_YEAR - 5)
  const [yearTo, setYearTo]           = useState(DEFAULT_YEAR_TO)
  const [brokerDays, setBrokerDays]   = useState(30)
  const [rows, setRows]               = useState<StockbitPreviewRow[]>([])
  const [errorMsg, setErrorMsg]       = useState('')
  const [job, setJob]                 = useState<RefreshJob | null>(null)
  const [dispatchFailed, setDispatchFailed] = useState(false)
  const [manualCmd, setManualCmd]     = useState('')
  const [modalClosed, setModalClosed] = useState(false)
  const pollingRef                    = useRef<ReturnType<typeof setInterval> | null>(null)
  const { addToast }                  = useToast()

  // Allow closing the modal while pipeline runs — polling continues in background
  const handleClose = useCallback(() => {
    if (step === 'running') {
      setModalClosed(true)
      addToast({
        message: `Refresh ${ticker} sedang berjalan`,
        detail: 'Notifikasi akan muncul saat selesai',
        variant: 'info',
        duration: 4000,
      })
    }
    onClose()
  }, [step, ticker, onClose, addToast])

  // When job finishes (modal open or closed), show toast + reload if data changed
  useEffect(() => {
    if (!job || (job.status !== 'done' && job.status !== 'failed')) return
    if (job.status === 'done') {
      const total = (job.progress ?? []).reduce((sum, p) => sum + (p.rows_added ?? 0), 0)
      if (modalClosed) {
        addToast({
          message: `Refresh ${ticker} selesai`,
          detail: job.no_new_data
            ? 'Tidak ada data baru ditemukan'
            : `${total} baris ditambahkan — halaman akan di-reload`,
          variant: job.no_new_data ? 'warning' : 'success',
          duration: job.no_new_data ? 5000 : 4000,
        })
      }
      // Only auto-reload if new data was actually inserted
      if (!job.no_new_data && total > 0) {
        setTimeout(() => { window.location.reload() }, modalClosed ? 2500 : 1500)
      }
    } else if (job.status === 'failed' && modalClosed) {
      addToast({
        message: `Refresh ${ticker} gagal`,
        detail: job.error_message ?? 'Cek log untuk detail',
        variant: 'error',
        duration: 8000,
      })
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.status])

  useEffect(() => {
    return () => { if (pollingRef.current) clearInterval(pollingRef.current) }
  }, [])

  // Derived: what the user selected
  const needsFinancials = selectedScrapers.has('financials_fallback')
  const needsBroker     = selectedScrapers.has('broker_backfill')
  const needsConfig     = needsFinancials || needsBroker
  const allFresh        = freshness.length > 0 && freshness.every((c) => c.status === 'fresh')

  // ── Token → Freshness: fetch per-category recency ──
  const handleCheckFreshness = useCallback(async () => {
    setLoadingFreshness(true)
    setStep('freshness')
    try {
      const res = await fetch(`/api/stocks/${ticker}/freshness`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const body = await res.json() as { categories: CategoryFreshness[] }
      setFreshness(body.categories)
      // Smart defaults: pre-select stale + missing
      const defaultSelected = new Set<string>()
      for (const cat of body.categories) {
        if (cat.status !== 'fresh') {
          for (const s of cat.scrapers) defaultSelected.add(s)
        }
      }
      setSelectedScrapers(defaultSelected)
    } catch {
      // Fallback: select all scrapers if freshness check fails
      setFreshness([])
      setSelectedScrapers(new Set([
        'daily_prices', 'money_flow', 'financials_fallback', 'stock_universe',
        'company_profiles', 'broker_backfill', 'dividend_scraper',
        'document_links', 'corporate_events',
      ]))
    } finally {
      setLoadingFreshness(false)
    }
  }, [ticker])

  // Toggle a category's scrapers
  const toggleCategory = useCallback((cat: CategoryFreshness) => {
    setSelectedScrapers((prev) => {
      const next = new Set(prev)
      const allSelected = cat.scrapers.every((s) => next.has(s))
      for (const s of cat.scrapers) {
        if (allSelected) next.delete(s)
        else next.add(s)
      }
      return next
    })
  }, [])

  // ── Freshness → next step ──
  const handleFreshnessNext = useCallback(() => {
    if (needsConfig) {
      setStep('config')
    } else if (selectedScrapers.size > 0) {
      // No financial/broker config needed, go straight to running
      handleTriggerPipeline()
    }
  }, [needsConfig, selectedScrapers])

  // ── Config → Fetch preview (only if financials selected) ──
  const handleFetch = useCallback(async () => {
    if (!token.trim()) return
    setStep('fetching')
    setErrorMsg('')
    try {
      const res = await fetch(`/api/stocks/${ticker}/stockbit/fetch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bearer_token: token.trim(), year_from: yearFrom, year_to: yearTo }),
      })
      const body = await res.json() as { rows?: StockbitPreviewRow[]; error?: string }
      if (!res.ok || body.error) {
        setErrorMsg(body.error ?? `HTTP ${res.status}`)
        setStep('error')
        return
      }
      setRows(body.rows ?? [])
      setStep('preview')
    } catch (e: unknown) {
      setErrorMsg(e instanceof Error ? e.message : 'Network error')
      setStep('error')
    }
  }, [ticker, token, yearFrom, yearTo])

  // ── Trigger the pipeline (with or without financial upsert) ──
  const handleTriggerPipeline = useCallback(async () => {
    setStep('running')
    setErrorMsg('')
    try {
      // 1. If financials are selected + preview data exists, upsert first
      if (needsFinancials && rows.length > 0) {
        const upsertRes = await fetch(`/api/stocks/${ticker}/stockbit/upsert`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rows }),
        })
        const upsertBody = await upsertRes.json() as { upserted?: number; error?: string }
        if (!upsertRes.ok || upsertBody.error) {
          setErrorMsg(upsertBody.error ?? `Upsert failed: HTTP ${upsertRes.status}`)
          setStep('error')
          return
        }
      }

      // 2. Create refresh job (seeds progress rows in DB)
      const scraperList = Array.from(selectedScrapers)
      const refreshRes = await fetch(`/api/stocks/${ticker}/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scrapers: scraperList }),
      })
      const refreshBody = await refreshRes.json() as {
        job_id?: number; error?: string
      }
      if (!refreshRes.ok || !refreshBody.job_id) {
        setErrorMsg(`Pipeline trigger failed: ${refreshBody.error ?? 'unknown'}`)
        setStep('error')
        return
      }

      const jobId = refreshBody.job_id

      // 3. Always run locally — local execution has the bearer token from step 1.
      //    GitHub Actions is for scheduled batch jobs, not interactive refreshes.
      try {
        const localRes = await fetch(`/api/stocks/${ticker}/refresh/local`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            job_id: jobId,
            scrapers: scraperList,
            broker_days: brokerDays,
            bearer_token: token.trim() || undefined,
          }),
        })
        if (!localRes.ok) {
          const flags = ['--broker-backfill', `--backfill-days ${brokerDays}`, `--ticker ${ticker}`, `--job-id ${jobId}`]
          setManualCmd(`cd python && python run_all.py ${flags.join(' ')}`)
          setDispatchFailed(true)
        }
      } catch {
        setDispatchFailed(true)
      }

      // 4. Start polling
      const poll = async () => {
        try {
          const res = await fetch(`/api/stocks/${ticker}/refresh/${jobId}`)
          if (!res.ok) return
          const data = await res.json() as RefreshJob
          setJob(data)
          if (data.status === 'done' || data.status === 'failed') {
            if (pollingRef.current) clearInterval(pollingRef.current)
            setStep('done')
          }
        } catch { /* ignore transient errors */ }
      }
      await poll()
      pollingRef.current = setInterval(poll, 3000)
    } catch (e: unknown) {
      setErrorMsg(e instanceof Error ? e.message : 'Network error')
      setStep('error')
    }
  }, [ticker, token, brokerDays, rows, selectedScrapers, needsFinancials])

  // ── Step indicator ──
  const stepLabels = [
    { key: 'token',     label: '1. Token' },
    { key: 'freshness', label: '2. Cek Data' },
    ...(needsConfig ? [{ key: 'config', label: '3. Konfigurasi' }] : []),
    ...(needsFinancials ? [{ key: 'preview', label: `${needsConfig ? '4' : '3'}. Preview` }] : []),
    { key: 'running',   label: `${needsFinancials ? (needsConfig ? '5' : '4') : (needsConfig ? '4' : '3')}. Eksekusi` },
  ]
  const activeIdx = stepLabels.findIndex((s) =>
    s.key === step ||
    (step === 'fetching' && s.key === 'config') ||
    (step === 'done' && s.key === 'running') ||
    (step === 'error' && s.key === (rows.length > 0 ? 'preview' : 'config'))
  )

  // When hidden, keep component alive (polling continues) but render nothing
  if (!visible) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm p-4">
      <div className="bg-white rounded-2xl border border-[#E5E4E1] shadow-[0_4px_24px_rgba(26,25,24,0.12)] w-full max-w-lg flex flex-col max-h-[90vh]">

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-[#E5E4E1] shrink-0">
          <h3 className="text-sm font-semibold text-[#1A1918]">
            Refresh Data — <span className="text-[#3D8A5A]">{ticker}</span>
          </h3>
          <button onClick={handleClose} className="text-[#9C9B99] hover:text-[#6D6C6A] text-lg leading-none transition-colors" aria-label="Close">×</button>
        </div>

        {/* Step indicator */}
        <div className="px-5 py-2 border-b border-[#E5E4E1] flex items-center gap-1 shrink-0">
          {stepLabels.map((s, i) => (
            <div key={s.key} className="flex items-center gap-1 flex-1">
              <div className={`h-1 flex-1 rounded-full transition-colors ${i <= activeIdx ? 'bg-[#3D8A5A]' : 'bg-[#E5E4E1]'}`} />
              <span className={`text-[10px] font-medium whitespace-nowrap ${i <= activeIdx ? 'text-[#3D8A5A]' : 'text-[#9C9B99]'}`}>{s.label}</span>
            </div>
          ))}
        </div>

        {/* Body */}
        <div className="overflow-y-auto flex-1 px-5 py-4">

          {/* ── Step 1: Token ── */}
          {step === 'token' && (
            <div className="space-y-4">
              <p className="text-xs text-[#6D6C6A] leading-relaxed">
                Token diperlukan untuk mengambil data keuangan dan broker dari{' '}
                <span className="font-medium text-[#1A1918]">stockbit.com</span>.
              </p>
              <ol className="text-xs text-[#6D6C6A] space-y-1 list-decimal pl-4">
                <li>Buka stockbit.com dan login</li>
                <li>DevTools → Network → request ke <code className="bg-[#EDECEA] px-1 rounded">api.stockbit.com</code></li>
                <li>Headers → <span className="font-medium text-[#1A1918]">Authorization</span></li>
                <li>Copy nilai <span className="font-medium text-red-500">setelah</span> <code className="bg-[#EDECEA] px-1 rounded">Bearer </code></li>
              </ol>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-[#6D6C6A]">Bearer Token</label>
                <input
                  type="password"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder="eyJhbGciOiJSUzI1NiIs..."
                  className="w-full border border-[#E5E4E1] rounded-lg px-3 py-2 text-xs text-[#1A1918] placeholder-[#9C9B99] focus:outline-none focus:ring-1 focus:ring-[#3D8A5A] font-mono"
                  onKeyDown={(e) => e.key === 'Enter' && token.trim() && handleCheckFreshness()}
                  autoFocus
                />
              </div>
            </div>
          )}

          {/* ── Step 2: Freshness Check ── */}
          {step === 'freshness' && (
            <div className="space-y-4">
              {loadingFreshness ? (
                <div className="flex flex-col items-center justify-center py-8 gap-3">
                  <div className="w-6 h-6 border-2 border-[#3D8A5A] border-t-transparent rounded-full animate-spin" />
                  <p className="text-xs text-[#6D6C6A]">Memeriksa data yang tersedia…</p>
                </div>
              ) : (
                <>
                  {allFresh && (
                    <div className="bg-[#C8F0D8] border border-[#3D8A5A]/20 rounded-lg px-3 py-2 text-xs text-[#3D8A5A]">
                      Semua data sudah terbaru! Centang kategori di bawah jika ingin tetap refresh.
                    </div>
                  )}

                  <div className="flex items-center justify-between">
                    <p className="text-xs text-[#6D6C6A]">Pilih data yang ingin di-refresh:</p>
                    <div className="flex gap-2">
                      <button
                        onClick={() => {
                          const all = new Set<string>()
                          for (const c of freshness) for (const s of c.scrapers) all.add(s)
                          setSelectedScrapers(all)
                        }}
                        className="text-[10px] text-[#3D8A5A] hover:underline"
                      >
                        Pilih semua
                      </button>
                      <button
                        onClick={() => setSelectedScrapers(new Set())}
                        className="text-[10px] text-[#9C9B99] hover:underline"
                      >
                        Reset
                      </button>
                    </div>
                  </div>

                  <div className="rounded-lg border border-[#E5E4E1] overflow-hidden divide-y divide-[#E5E4E1]">
                    {freshness.map((cat) => {
                      const { icon, color, bg } = freshnessIcon(cat.status)
                      const isSelected = cat.scrapers.every((s) => selectedScrapers.has(s))
                      return (
                        <label key={cat.category} className="flex items-center gap-3 px-3 py-2.5 cursor-pointer hover:bg-[#F5F4F1] transition-colors">
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={() => toggleCategory(cat)}
                            className="w-3.5 h-3.5 rounded border-[#E5E4E1] text-[#3D8A5A] focus:ring-[#3D8A5A] accent-[#3D8A5A]"
                          />
                          <div className="w-5 h-5 rounded-full flex items-center justify-center text-[10px] shrink-0"
                            style={{ backgroundColor: bg, color }}>{icon}</div>
                          <div className="flex-1 min-w-0">
                            <p className="text-xs font-medium text-[#1A1918]">{cat.label}</p>
                            <p className="text-[10px] text-[#9C9B99]">
                              {cat.status === 'missing'
                                ? 'Tidak ada data'
                                : cat.status === 'fresh'
                                  ? `Terbaru ${cat.daysSince === 0 ? 'hari ini' : `${cat.daysSince} hari lalu`}`
                                  : `Terakhir update ${cat.daysSince} hari lalu`}
                            </p>
                          </div>
                          <span className={`text-[10px] font-medium uppercase ${
                            cat.status === 'fresh' ? 'text-[#3D8A5A]' :
                            cat.status === 'stale' ? 'text-[#D97706]' :
                            'text-[#DC2626]'
                          }`}>
                            {cat.status === 'fresh' ? 'Terbaru' : cat.status === 'stale' ? 'Perlu update' : 'Belum ada'}
                          </span>
                        </label>
                      )
                    })}
                  </div>

                  <p className="text-xs text-[#9C9B99] text-center">
                    {selectedScrapers.size > 0
                      ? `${selectedScrapers.size} scraper akan dijalankan`
                      : 'Pilih minimal 1 kategori'}
                  </p>
                </>
              )}
            </div>
          )}

          {/* ── Step 3: Config (conditional) ── */}
          {step === 'config' && (
            <div className="space-y-4">
              {needsFinancials && (
                <div>
                  <p className="text-xs font-medium text-[#1A1918] mb-2">Periode Data Keuangan</p>
                  <p className="text-xs text-[#6D6C6A] mb-2">Annual + quarterly rows dari Stockbit.</p>
                  <div className="flex items-center gap-3">
                    <div className="space-y-1 flex-1">
                      <label className="text-xs font-medium text-[#6D6C6A]">Dari tahun</label>
                      <select value={yearFrom} onChange={(e) => setYearFrom(parseInt(e.target.value, 10))}
                        className="w-full border border-[#E5E4E1] rounded-lg px-3 py-1.5 text-xs text-[#1A1918] focus:outline-none focus:ring-1 focus:ring-[#3D8A5A]">
                        {YEAR_OPTIONS.map((y) => <option key={y} value={y}>{y}</option>)}
                      </select>
                    </div>
                    <span className="text-[#9C9B99] text-xs mt-4">→</span>
                    <div className="space-y-1 flex-1">
                      <label className="text-xs font-medium text-[#6D6C6A]">Sampai tahun</label>
                      <select value={yearTo} onChange={(e) => setYearTo(parseInt(e.target.value, 10))}
                        className="w-full border border-[#E5E4E1] rounded-lg px-3 py-1.5 text-xs text-[#1A1918] focus:outline-none focus:ring-1 focus:ring-[#3D8A5A]">
                        {YEAR_OPTIONS.map((y) => <option key={y} value={y}>{y}</option>)}
                      </select>
                    </div>
                  </div>
                </div>
              )}

              {needsBroker && (
                <div>
                  <p className="text-xs font-medium text-[#1A1918] mb-2">Periode Broker Summary</p>
                  <p className="text-xs text-[#6D6C6A] mb-2">Broker flow + bandar signal (maks 60 hari).</p>
                  <div className="flex items-center gap-2">
                    {BROKER_DAY_OPTIONS.map((d) => (
                      <button key={d} onClick={() => setBrokerDays(d)}
                        className={`flex-1 px-2 py-1.5 text-xs font-medium border rounded-lg transition-colors ${
                          brokerDays === d ? 'bg-[#1A1918] text-white border-[#1A1918]' : 'bg-white text-[#6D6C6A] border-[#E5E4E1] hover:border-[#1A1918]'
                        }`}>{d}D</button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ── Loading: Fetching preview ── */}
          {step === 'fetching' && (
            <div className="flex flex-col items-center justify-center py-8 gap-3">
              <div className="w-6 h-6 border-2 border-[#3D8A5A] border-t-transparent rounded-full animate-spin" />
              <p className="text-xs text-[#6D6C6A]">Mengambil preview dari Stockbit…</p>
            </div>
          )}

          {/* ── Step 4: Preview (only when financials selected) ── */}
          {step === 'preview' && (() => {
            const snapshotRow = rows.find((r) => r.quarter === 0)
            return (
              <div className="space-y-4">
                <p className="text-xs text-[#6D6C6A]">
                  <span className="font-medium text-[#1A1918]">{rows.length} baris</span> data keuangan siap disimpan —{' '}
                  {rows.filter((r) => r.quarter === 0).length} annual,{' '}
                  {rows.filter((r) => r.quarter > 0).length} quarterly.
                </p>
                <div>
                  <p className="text-xs font-medium text-[#6D6C6A] mb-1.5">Preview Data Keuangan</p>
                  <div className="overflow-x-auto rounded-lg border border-[#E5E4E1]">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="bg-[#F5F4F1] border-b border-[#E5E4E1]">
                          {['Year', 'Q', 'Revenue', 'Net Income', 'EPS'].map((h) => (
                            <th key={h} className={`py-2 px-3 font-medium text-[#9C9B99] ${h === 'Year' || h === 'Q' ? 'text-left' : 'text-right'}`}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {rows.slice(0, 12).map((r) => (
                          <tr key={`${r.year}_${r.quarter}`} className="border-b border-[#E5E4E1] last:border-0 hover:bg-[#F5F4F1]">
                            <td className="py-1.5 px-3 text-[#1A1918] tabular-nums">{r.year}</td>
                            <td className="py-1.5 px-3 text-[#9C9B99]">{r.quarter === 0 ? (r.is_ttm ? 'TTM' : 'FY') : `Q${r.quarter}`}</td>
                            <td className="py-1.5 px-3 text-right text-[#6D6C6A] tabular-nums">{formatIDR(r.revenue)}</td>
                            <td className="py-1.5 px-3 text-right text-[#6D6C6A] tabular-nums">{formatIDR(r.net_income)}</td>
                            <td className="py-1.5 px-3 text-right text-[#6D6C6A] tabular-nums">{r.eps != null ? r.eps.toFixed(2) : '-'}</td>
                          </tr>
                        ))}
                        {rows.length > 12 && (
                          <tr><td colSpan={5} className="py-1.5 px-3 text-center text-[#9C9B99]">…{rows.length - 12} baris lagi</td></tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
                {snapshotRow && (
                  <div className="rounded-lg border border-[#E5E4E1] overflow-hidden">
                    <div className="bg-[#F5F4F1] px-3 py-1.5 text-xs font-medium text-[#9C9B99] border-b border-[#E5E4E1]">Snapshot {snapshotRow.year} FY</div>
                    <div className="grid grid-cols-3 divide-x divide-[#E5E4E1]">
                      {[
                        { label: 'Revenue',    value: formatIDR(snapshotRow.revenue) },
                        { label: 'Net Income', value: formatIDR(snapshotRow.net_income) },
                        { label: 'EPS',        value: snapshotRow.eps != null ? snapshotRow.eps.toFixed(2) : '-' },
                        { label: 'ROE',        value: snapshotRow.roe != null ? `${snapshotRow.roe.toFixed(1)}%` : '-' },
                        { label: 'D/E',        value: snapshotRow.debt_to_equity != null ? snapshotRow.debt_to_equity.toFixed(2) : '-' },
                        { label: 'Net Margin', value: snapshotRow.net_margin != null ? `${snapshotRow.net_margin.toFixed(1)}%` : '-' },
                      ].map((item) => (
                        <div key={item.label} className="px-3 py-1.5 flex items-center justify-between gap-2 border-b border-[#E5E4E1]">
                          <span className="text-xs text-[#9C9B99]">{item.label}</span>
                          <span className="text-xs font-medium text-[#1A1918] tabular-nums">{item.value}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )
          })()}

          {/* ── Step 5: Running / Done ── */}
          {(step === 'running' || step === 'done') && (
            <div className="space-y-4">
              <p className="text-xs text-[#6D6C6A]">
                {step === 'running' ? 'Pipeline sedang berjalan…'
                  : job?.status === 'failed' ? 'Pipeline selesai dengan error.'
                  : job?.no_new_data ? 'Pipeline selesai — tidak ada data baru.'
                  : 'Pipeline selesai!'}
              </p>

              {/* Dispatch failure: show manual command */}
              {dispatchFailed && step === 'running' && (
                <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 space-y-1.5">
                  <p className="text-xs font-medium text-amber-700">
                    GitHub Actions tidak bisa dipicu. Jalankan manual di terminal:
                  </p>
                  <code className="block text-[10px] text-amber-900 bg-amber-100 rounded px-2 py-1.5 break-all font-mono select-all">
                    {manualCmd}
                  </code>
                  <p className="text-[10px] text-amber-600">Progress akan update otomatis setelah pipeline berjalan.</p>
                </div>
              )}

              <div className="rounded-lg border border-[#E5E4E1] overflow-hidden divide-y divide-[#E5E4E1]">
                {/* Financial upsert row (only if financials were refreshed) */}
                {needsFinancials && rows.length > 0 && (
                  <div className="flex items-center gap-3 px-3 py-2">
                    <div className="w-5 h-5 rounded-full flex items-center justify-center text-[10px] shrink-0" style={{ backgroundColor: '#C8F0D8', color: '#3D8A5A' }}>✓</div>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium text-[#1A1918]">Data Keuangan (Stockbit)</p>
                      <p className="text-[10px] text-[#9C9B99]">{rows.length} baris disimpan</p>
                    </div>
                  </div>
                )}

                {(job?.progress ?? []).map((p) => {
                  const { icon, color, bg } = scraperStatusIcon(p.status)
                  return (
                    <div key={p.scraper} className="flex items-center gap-3 px-3 py-2">
                      <div className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] shrink-0 ${p.status === 'running' ? 'animate-spin' : ''}`}
                        style={{ backgroundColor: bg, color }}>{icon}</div>
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-medium text-[#1A1918]">{SCRAPER_LABELS[p.scraper] ?? p.scraper}</p>
                        {p.status === 'done' && p.rows_added != null && (
                          <p className="text-[10px] text-[#9C9B99]">{p.rows_added} baris{p.duration_ms != null ? ` · ${(p.duration_ms / 1000).toFixed(1)}s` : ''}</p>
                        )}
                        {p.status === 'failed' && p.error_msg && (
                          <p className="text-[10px] text-red-500 truncate">{p.error_msg}</p>
                        )}
                      </div>
                      <span className={`text-[10px] font-medium uppercase ${
                        p.status === 'done' ? 'text-[#3D8A5A]' : p.status === 'failed' ? 'text-red-500' : p.status === 'running' ? 'text-[#D97706]' : 'text-[#9C9B99]'
                      }`}>{p.status}</span>
                    </div>
                  )
                })}
              </div>

              {step === 'done' && job && (job.completeness_after != null || job.confidence_after != null) && (
                <div className="bg-[#F5F4F1] rounded-lg px-3 py-2 text-xs border border-[#E5E4E1] flex items-center gap-4">
                  {job.completeness_before != null && job.completeness_after != null && (
                    <span className="text-[#6D6C6A]">Completeness: {job.completeness_before} → <span className="font-medium text-[#1A1918]">{job.completeness_after}</span></span>
                  )}
                  {job.confidence_before != null && job.confidence_after != null && (
                    <span className="text-[#6D6C6A]">Confidence: {job.confidence_before} → <span className="font-medium text-[#1A1918]">{job.confidence_after}</span></span>
                  )}
                </div>
              )}
            </div>
          )}

          {/* ── Error ── */}
          {step === 'error' && (
            <div className="flex flex-col items-center justify-center py-6 gap-3 text-center">
              <div className="w-10 h-10 rounded-full bg-red-50 flex items-center justify-center text-red-400 text-lg">✗</div>
              <p className="text-xs text-red-500 max-w-xs">{errorMsg}</p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-4 border-t border-[#E5E4E1] flex justify-between items-center shrink-0">
          <div>
            {step === 'freshness' && !loadingFreshness && (
              <button onClick={() => setStep('token')} className="text-xs text-[#9C9B99] hover:text-[#6D6C6A] transition-colors">← Back</button>
            )}
            {step === 'config' && (
              <button onClick={() => setStep('freshness')} className="text-xs text-[#9C9B99] hover:text-[#6D6C6A] transition-colors">← Back</button>
            )}
            {step === 'preview' && (
              <button onClick={() => setStep('config')} className="text-xs text-[#9C9B99] hover:text-[#6D6C6A] transition-colors">← Back</button>
            )}
            {step === 'error' && (
              <button onClick={() => setStep(rows.length > 0 ? 'preview' : needsConfig ? 'config' : 'freshness')} className="text-xs text-[#9C9B99] hover:text-[#6D6C6A] transition-colors">← Back</button>
            )}
          </div>
          <div className="flex gap-2">
            {step === 'token' && (
              <button disabled={!token.trim()} onClick={handleCheckFreshness}
                className="px-4 py-1.5 text-xs text-white bg-[#3D8A5A] rounded-lg hover:bg-[#2d6b45] transition-colors disabled:opacity-40 disabled:cursor-not-allowed">Lanjut →</button>
            )}
            {step === 'freshness' && !loadingFreshness && (
              <button disabled={selectedScrapers.size === 0} onClick={handleFreshnessNext}
                className="px-4 py-1.5 text-xs text-white bg-[#3D8A5A] rounded-lg hover:bg-[#2d6b45] transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
                {needsConfig ? 'Lanjut →' : 'Jalankan'}
              </button>
            )}
            {step === 'config' && needsFinancials && (
              <button disabled={yearFrom > yearTo} onClick={handleFetch}
                className="px-4 py-1.5 text-xs text-white bg-[#3D8A5A] rounded-lg hover:bg-[#2d6b45] transition-colors disabled:opacity-40 disabled:cursor-not-allowed">Fetch Preview</button>
            )}
            {step === 'config' && !needsFinancials && (
              <button onClick={handleTriggerPipeline}
                className="px-4 py-1.5 text-xs text-white bg-[#3D8A5A] rounded-lg hover:bg-[#2d6b45] transition-colors">Jalankan</button>
            )}
            {step === 'preview' && (
              <button onClick={handleTriggerPipeline}
                className="px-4 py-1.5 text-xs text-white bg-[#3D8A5A] rounded-lg hover:bg-[#2d6b45] transition-colors">Konfirmasi & Jalankan</button>
            )}
            {step === 'running' && (
              <button onClick={handleClose}
                className="px-4 py-1.5 text-xs text-[#6D6C6A] bg-[#F5F4F1] border border-[#E5E4E1] rounded-lg hover:bg-[#EDECEA] transition-colors">Tutup (jalan di background)</button>
            )}
            {step === 'done' && (
              job?.no_new_data ? (
                <button onClick={handleClose}
                  className="px-4 py-1.5 text-xs text-[#6D6C6A] bg-[#F5F4F1] border border-[#E5E4E1] rounded-lg hover:bg-[#EDECEA] transition-colors">Tutup</button>
              ) : (
                <button onClick={() => window.location.reload()}
                  className="px-4 py-1.5 text-xs text-white bg-[#3D8A5A] rounded-lg hover:bg-[#2d6b45] transition-colors">Selesai & Reload</button>
              )
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

interface DataQualityPanelProps {
  data: DataQuality | null
  ticker: string
}

export function DataQualityPanel({ data, ticker }: DataQualityPanelProps) {
  const [expanded,      setExpanded]      = useState(false)
  const [modalOpen,     setModalOpen]     = useState(false)
  const [modalMounted,  setModalMounted]  = useState(false) // stays true once opened, so polling survives close
  const [isMounted,     setIsMounted]     = useState(false)
  useEffect(() => setIsMounted(true), [])

  const openModal = useCallback(() => {
    setModalMounted(true)
    setModalOpen(true)
  }, [])

  if (!data) return null

  const { completeness_score, confidence_score, scores_updated_at, last_scraped_at, missing_categories } = data
  const timestamp          = scores_updated_at ?? last_scraped_at
  const hasMissing         = missing_categories.length > 0
  const isLowCompleteness  = completeness_score < 50

  return (
    <>
      {/* Modal stays mounted once opened so background polling survives close */}
      {modalMounted && (
        <StockbitRefreshModal ticker={ticker} visible={modalOpen} onClose={() => setModalOpen(false)} />
      )}

      <div className="bg-white rounded-2xl border border-[#E5E4E1] shadow-[0_2px_12px_rgba(26,25,24,0.06)] overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-[#E5E4E1]">
          <h2 className="text-sm font-semibold text-[#1A1918]">Data Quality</h2>
          <button
            onClick={() => setExpanded((v) => !v)}
            className="text-xs text-[#3D8A5A] hover:text-[#2d6b45] transition-colors"
          >
            {expanded ? 'Hide details ↑' : 'Show details ↓'}
          </button>
        </div>

        {/* Score bars */}
        <div className="px-5 py-4 space-y-4">
          <ScoreLine label="Completeness" score={completeness_score} max={100} showFraction />
          <ScoreLine label="Confidence"   score={confidence_score}   max={100} />

          {/* Footer row */}
          <div className="flex items-center justify-between pt-1">
            <span className="text-xs text-[#9C9B99]">
              {timestamp ? `Updated ${relativeTime(timestamp, isMounted)}` : 'Never updated'}
            </span>
            <div className="flex items-center gap-2">
              {hasMissing && (
                <span className="text-xs text-amber-500">
                  {missing_categories.length} categor{missing_categories.length === 1 ? 'y' : 'ies'} missing
                </span>
              )}
              <button
                onClick={openModal}
                className={`text-xs px-2.5 py-1 rounded-lg border transition-colors ${
                  isLowCompleteness
                    ? 'border-amber-300 text-amber-600 hover:bg-amber-50'
                    : 'border-[#E5E4E1] text-[#6D6C6A] hover:bg-[#F5F4F1]'
                }`}
              >
                ↺ Refresh Data
              </button>
            </div>
          </div>
        </div>

        {/* Expanded breakdown */}
        {expanded && (
          <div className="border-t border-[#E5E4E1]">
            <div className="px-5 py-4">
              <p className="text-xs font-semibold text-[#9C9B99] uppercase tracking-wide mb-3">
                Completeness Breakdown
                <span className="ml-1.5 font-normal text-[#9C9B99] normal-case">
                  ({completeness_score} / 100 pts)
                </span>
              </p>
              <table className="w-full">
                <tbody>
                  {Object.entries(data.completeness_breakdown).map(([key, cat]) => (
                    <CategoryRow key={key} name={key} cat={cat} />
                  ))}
                </tbody>
              </table>
            </div>

            {confidence_score == null && (
              <div className="px-5 pb-4">
                <p className="text-xs text-[#9C9B99] bg-[#F5F4F1] rounded px-3 py-2 border border-[#E5E4E1]">
                  Confidence score has not been computed yet. Use{' '}
                  <span className="font-medium text-[#6D6C6A]">↺ Refresh Data</span>{' '}
                  to pull data from Stockbit.
                </p>
              </div>
            )}

            {hasMissing && (
              <AlternativeSources
                missingCategories={missing_categories}
                ticker={ticker}
              />
            )}
          </div>
        )}
      </div>
    </>
  )
}
