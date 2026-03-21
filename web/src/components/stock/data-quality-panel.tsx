'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import type { DataQuality, QualityCategory, RefreshJob } from '@/lib/types/api'
import { AlternativeSources } from '@/components/stock/alternative-sources'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function scoreBand(score: number): { label: string; textColor: string; barColor: string } {
  if (score >= 80) return { label: 'Good',    textColor: 'text-green-600', barColor: 'bg-green-500' }
  if (score >= 50) return { label: 'Partial', textColor: 'text-amber-500', barColor: 'bg-amber-400' }
  return              { label: 'Thin',    textColor: 'text-red-500',   barColor: 'bg-red-500'   }
}

function relativeTime(iso: string | null): string {
  if (!iso) return 'never'
  const diffDays = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000)
  if (diffDays === 0) return 'today'
  if (diffDays === 1) return '1 day ago'
  if (diffDays < 30)  return `${diffDays} days ago`
  const months = Math.floor(diffDays / 30)
  return `${months} month${months > 1 ? 's' : ''} ago`
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

const SCRAPER_LABELS: Record<string, string> = {
  stock_universe:   'Stock Universe',
  daily_prices:     'Daily Prices',
  financials:       'Financials',
  company_profiles: 'Company Profiles',
  document_links:   'Document Links',
  corporate_events: 'Corporate Events',
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function ScoreBar({ score, max, barColor }: { score: number; max: number; barColor: string }) {
  const pct = max > 0 ? Math.round((score / max) * 100) : 0
  return (
    <div className="h-1.5 w-full bg-gray-100 rounded-full overflow-hidden">
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
          <span className="text-gray-500">{label}</span>
          <span className="text-gray-400 text-xs">Not computed yet</span>
        </div>
        <div className="h-1.5 w-full bg-gray-100 rounded-full" />
      </div>
    )
  }

  const { label: bandLabel, textColor, barColor } = scoreBand((score / max) * 100)
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-sm">
        <span className="text-gray-600">{label}</span>
        <div className="flex items-center gap-2">
          {showFraction && (
            <span className="text-xs text-gray-400">{score} / {max}</span>
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
    <tr className="border-b border-gray-50 last:border-0">
      <td className="py-2 pr-4 text-sm text-gray-700 whitespace-nowrap">
        {CATEGORY_LABELS[name] ?? name}
      </td>
      <td className="py-2 pr-3 w-32">
        <ScoreBar score={cat.score} max={cat.max} barColor={barColor} />
      </td>
      <td className="py-2 text-right text-sm tabular-nums text-gray-500 whitespace-nowrap">
        {cat.score} / {cat.max}
      </td>
      <td className="py-2 pl-4 text-xs text-gray-400 hidden sm:table-cell">
        {cat.detail}
      </td>
    </tr>
  )
}

// ---------------------------------------------------------------------------
// Refresh helpers
// ---------------------------------------------------------------------------

type RefreshPhase = 'idle' | 'confirm' | 'running' | 'done' | 'failed'

function ScraperStatusIcon({ status }: { status: string }) {
  if (status === 'done')    return <span className="text-green-500">✓</span>
  if (status === 'failed')  return <span className="text-red-500">✗</span>
  if (status === 'running') return <span className="text-blue-400 animate-pulse">⟳</span>
  return <span className="text-gray-300">○</span>
}

function ScoreDiff({
  label,
  before,
  after,
}: {
  label: string
  before: number | null
  after: number | null
}) {
  if (before == null || after == null) return null
  const delta = after - before
  const color = delta > 0 ? 'text-green-600' : delta < 0 ? 'text-red-500' : 'text-gray-400'
  const sign  = delta > 0 ? '+' : ''
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-gray-600">{label}</span>
      <span className="tabular-nums">
        <span className="text-gray-500">{before}</span>
        <span className="text-gray-300 mx-1">→</span>
        <span className="font-semibold text-gray-700">{after}</span>
        {delta !== 0 && (
          <span className={`ml-1.5 text-xs font-medium ${color}`}>
            ({sign}{delta})
          </span>
        )}
      </span>
    </div>
  )
}

function ConfirmModal({
  ticker,
  onConfirm,
  onCancel,
}: {
  ticker: string
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm">
      <div className="bg-white rounded-xl border border-gray-200 shadow-xl max-w-sm w-full mx-4 p-6">
        <h3 className="text-sm font-semibold text-gray-800 mb-2">Refresh data for {ticker}?</h3>
        <p className="text-xs text-gray-500 leading-relaxed mb-5">
          This will trigger a scraper run via GitHub Actions. All data sources will be
          re-fetched and scores recalculated. Takes ~2–5 minutes.
        </p>
        <div className="flex gap-2 justify-end">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 text-xs text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="px-3 py-1.5 text-xs text-white bg-blue-500 rounded-lg hover:bg-blue-600 transition-colors"
          >
            Start Refresh
          </button>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Refresh status block (running / done / failed)
// ---------------------------------------------------------------------------

function RefreshStatusBlock({
  phase,
  job,
  submitError,
  ticker,
  missingCategories,
}: {
  phase: RefreshPhase
  job: RefreshJob | null
  submitError: string | null
  ticker: string
  missingCategories: string[]
}) {
  if (submitError) {
    return (
      <div className="border-t border-gray-100 px-5 py-4">
        <p className="text-xs text-red-500">{submitError}</p>
      </div>
    )
  }

  if (!job && phase === 'running') {
    return (
      <div className="border-t border-gray-100 px-5 py-4">
        <p className="text-xs text-gray-400 animate-pulse">Creating refresh job…</p>
      </div>
    )
  }

  if (!job) return null

  const isDone   = phase === 'done'
  const isFailed = phase === 'failed'

  return (
    <div className="border-t border-gray-100 px-5 py-4 space-y-3">
      {/* Per-scraper progress log */}
      <div className="space-y-1.5">
        {job.progress.map((p) => (
          <div key={p.scraper} className="flex items-center gap-2 text-xs">
            <ScraperStatusIcon status={p.status} />
            <span className={p.status === 'waiting' ? 'text-gray-300' : 'text-gray-600'}>
              {SCRAPER_LABELS[p.scraper] ?? p.scraper}
            </span>
            {p.status === 'running' && (
              <span className="text-blue-400">running…</span>
            )}
            {p.status === 'done' && p.rows_added != null && (
              <span className="text-gray-400">+{p.rows_added} rows</span>
            )}
            {p.status === 'failed' && p.error_msg && (
              <span className="text-red-400 truncate max-w-[180px]" title={p.error_msg}>
                {p.error_msg}
              </span>
            )}
          </div>
        ))}
      </div>

      {/* Success with score diff */}
      {isDone && !job.no_new_data && (
        <div className="pt-2 border-t border-gray-50 space-y-1.5">
          <p className="text-xs font-medium text-green-600">✓ Refresh complete. Scores updated.</p>
          <ScoreDiff label="Completeness" before={job.completeness_before} after={job.completeness_after} />
          <ScoreDiff label="Confidence"   before={job.confidence_before}   after={job.confidence_after}   />
          <p className="text-xs text-gray-400 pt-1">Reload the page to see updated data.</p>
        </div>
      )}

      {/* No new data — show alternative sources */}
      {isDone && job.no_new_data && (
        <div className="pt-2 border-t border-gray-50">
          <p className="text-xs text-gray-500 mb-3">
            ℹ No new data found since last run. The scraper returned the same data as before.
          </p>
          {missingCategories.length > 0 && (
            <AlternativeSources missingCategories={missingCategories} ticker={ticker} />
          )}
        </div>
      )}

      {/* Failed */}
      {isFailed && job.error_message && (
        <div className="pt-2 border-t border-gray-50">
          <p className="text-xs text-red-500">✗ Refresh failed: {job.error_message}</p>
        </div>
      )}
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

const POLL_INTERVAL_MS = 3000

export function DataQualityPanel({ data, ticker }: DataQualityPanelProps) {
  const [expanded,    setExpanded]    = useState(false)
  const [phase,       setPhase]       = useState<RefreshPhase>('idle')
  const [job,         setJob]         = useState<RefreshJob | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const poll = useCallback(async (id: number) => {
    try {
      const res = await fetch(`/api/stocks/${ticker}/refresh/${id}`)
      if (!res.ok) return
      const j: RefreshJob = await res.json()
      setJob(j)
      if (j.status === 'done' || j.status === 'failed') {
        setPhase(j.status)
        return
      }
      pollRef.current = setTimeout(() => poll(id), POLL_INTERVAL_MS)
    } catch {
      pollRef.current = setTimeout(() => poll(id), POLL_INTERVAL_MS)
    }
  }, [ticker])

  // On mount: resume polling if there's already an active job for this ticker
  useEffect(() => {
    let cancelled = false
    async function resumeIfActive() {
      try {
        const res = await fetch(`/api/stocks/${ticker}/refresh`)
        if (!res.ok || cancelled) return
        const { job_id } = await res.json() as { job_id: number | null }
        if (!job_id) return
        const statusRes = await fetch(`/api/stocks/${ticker}/refresh/${job_id}`)
        if (!statusRes.ok || cancelled) return
        const j: RefreshJob = await statusRes.json()
        if (j.status === 'pending' || j.status === 'running') {
          setPhase('running')
          setJob(j)
          pollRef.current = setTimeout(() => poll(job_id), POLL_INTERVAL_MS)
        }
      } catch { /* no active job — stay idle */ }
    }
    resumeIfActive()
    return () => {
      cancelled = true
      if (pollRef.current) clearTimeout(pollRef.current)
    }
  }, [ticker, poll])

  const startRefresh = useCallback(async () => {
    setPhase('running')
    setSubmitError(null)
    setJob(null)
    try {
      const res = await fetch(`/api/stocks/${ticker}/refresh`, { method: 'POST' })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setSubmitError((body as { error?: string }).error ?? 'Failed to start refresh')
        setPhase('failed')
        return
      }
      const { job_id } = await res.json() as { job_id: number }
      pollRef.current = setTimeout(() => poll(job_id), POLL_INTERVAL_MS)
    } catch {
      setSubmitError('Network error — could not start refresh')
      setPhase('failed')
    }
  }, [ticker, poll])

  const resetRefresh = () => {
    if (pollRef.current) clearTimeout(pollRef.current)
    setPhase('idle')
    setJob(null)
    setSubmitError(null)
  }

  if (!data) return null

  const { completeness_score, confidence_score, scores_updated_at, last_scraped_at, missing_categories } = data
  const timestamp  = scores_updated_at ?? last_scraped_at
  const hasMissing = missing_categories.length > 0
  const isLowCompleteness = completeness_score < 50

  return (
    <>
      {phase === 'confirm' && (
        <ConfirmModal
          ticker={ticker}
          onConfirm={() => { setPhase('idle'); startRefresh() }}
          onCancel={() => setPhase('idle')}
        />
      )}

      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-100">
          <h2 className="text-sm font-semibold text-gray-700">Data Quality</h2>
          <button
            onClick={() => setExpanded((v) => !v)}
            className="text-xs text-blue-500 hover:text-blue-700 transition-colors"
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
            <span className="text-xs text-gray-400">
              {timestamp ? `Updated ${relativeTime(timestamp)}` : 'Never updated'}
            </span>
            <div className="flex items-center gap-2">
              {hasMissing && phase === 'idle' && (
                <span className="text-xs text-amber-500">
                  {missing_categories.length} categor{missing_categories.length === 1 ? 'y' : 'ies'} missing
                </span>
              )}
              {phase === 'idle' && (
                <button
                  onClick={() => setPhase('confirm')}
                  className={`text-xs px-2.5 py-1 rounded-lg border transition-colors ${
                    isLowCompleteness
                      ? 'border-amber-300 text-amber-600 hover:bg-amber-50'
                      : 'border-gray-200 text-gray-500 hover:bg-gray-50'
                  }`}
                >
                  ↺ Refresh Data
                </button>
              )}
              {phase === 'running' && (
                <span className="text-xs text-blue-500 animate-pulse">Refreshing…</span>
              )}
              {(phase === 'done' || phase === 'failed') && (
                <button
                  onClick={resetRefresh}
                  className="text-xs text-gray-400 hover:text-gray-600 transition-colors"
                >
                  ✕ Dismiss
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Refresh progress / result panel */}
        {phase !== 'idle' && phase !== 'confirm' && (
          <RefreshStatusBlock
            phase={phase}
            job={job}
            submitError={submitError}
            ticker={ticker}
            missingCategories={missing_categories}
          />
        )}

        {/* Expanded breakdown */}
        {expanded && (
          <div className="border-t border-gray-100">
            <div className="px-5 py-4">
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">
                Completeness Breakdown
                <span className="ml-1.5 font-normal text-gray-400 normal-case">
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
                <p className="text-xs text-gray-400 bg-gray-50 rounded px-3 py-2 border border-gray-100">
                  Confidence score has not been computed yet. Use the{' '}
                  <span className="font-medium text-gray-500">↺ Refresh Data</span>{' '}
                  button above to trigger a full scraper run.
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
