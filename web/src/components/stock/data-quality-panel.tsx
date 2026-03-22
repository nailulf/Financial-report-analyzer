'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import type { DataQuality, QualityCategory, StockbitPreviewRow } from '@/lib/types/api'
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

function formatIDR(n: number | null | undefined): string {
  if (n == null) return '-'
  const abs = Math.abs(n)
  if (abs >= 1e12) return `${(n / 1e12).toFixed(1)}T`
  if (abs >= 1e9)  return `${(n / 1e9).toFixed(1)}B`
  if (abs >= 1e6)  return `${(n / 1e6).toFixed(1)}M`
  return n.toLocaleString('id-ID')
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
// Stockbit Refresh Modal
// ---------------------------------------------------------------------------

type ModalPhase =
  | 'token'     // Step 1: enter bearer token
  | 'config'    // Step 2: select year range
  | 'fetching'  // Loading: calling Stockbit API
  | 'preview'   // Show data preview
  | 'saving'    // Loading: upserting
  | 'saved'     // Done
  | 'error'     // Any error

const CURRENT_YEAR = new Date().getFullYear()
const YEAR_OPTIONS = Array.from({ length: CURRENT_YEAR - 2014 }, (_, i) => 2015 + i)

function StockbitRefreshModal({
  ticker,
  onClose,
}: {
  ticker: string
  onClose: () => void
}) {
  const [phase, setPhase] = useState<ModalPhase>('token')
  const [token, setToken]           = useState('')
  const [yearFrom, setYearFrom]     = useState(CURRENT_YEAR - 5)
  const [yearTo, setYearTo]         = useState(CURRENT_YEAR)
  const [rows, setRows]             = useState<StockbitPreviewRow[]>([])
  const [upsertedCount, setUpsertedCount] = useState(0)
  const [errorMsg, setErrorMsg]     = useState('')

  const handleFetch = useCallback(async () => {
    if (!token.trim()) return
    setPhase('fetching')
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
        setPhase('error')
        return
      }
      setRows(body.rows ?? [])
      setPhase('preview')
    } catch (e: unknown) {
      setErrorMsg(e instanceof Error ? e.message : 'Network error')
      setPhase('error')
    }
  }, [ticker, token, yearFrom, yearTo])

  const handleSave = useCallback(async () => {
    setPhase('saving')
    try {
      const res = await fetch(`/api/stocks/${ticker}/stockbit/upsert`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows }),
      })
      const body = await res.json() as { upserted?: number; error?: string }
      if (!res.ok || body.error) {
        setErrorMsg(body.error ?? `HTTP ${res.status}`)
        setPhase('error')
        return
      }
      setUpsertedCount(body.upserted ?? rows.length)
      setPhase('saved')
    } catch (e: unknown) {
      setErrorMsg(e instanceof Error ? e.message : 'Network error')
      setPhase('error')
    }
  }, [ticker, rows])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm p-4">
      <div className="bg-white rounded-xl border border-gray-200 shadow-xl w-full max-w-lg flex flex-col max-h-[90vh]">

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 shrink-0">
          <h3 className="text-sm font-semibold text-gray-800">
            Refresh from Stockbit — <span className="text-blue-600">{ticker}</span>
          </h3>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 text-lg leading-none transition-colors"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        {/* Body */}
        <div className="overflow-y-auto flex-1 px-5 py-4">

          {/* Step 1: Token */}
          {phase === 'token' && (
            <div className="space-y-4">
              <p className="text-xs text-gray-500 leading-relaxed">
                Get your token from{' '}
                <span className="font-medium text-gray-600">stockbit.com</span>:
              </p>
              <ol className="text-xs text-gray-500 space-y-1 list-decimal pl-4">
                <li>Open stockbit.com and log in</li>
                <li>DevTools → Network → any <code className="bg-gray-100 px-1 rounded">api.stockbit.com</code> request</li>
                <li>Headers → <span className="font-medium text-gray-600">Authorization</span></li>
                <li>Copy the value <span className="font-medium text-red-500">after</span> <code className="bg-gray-100 px-1 rounded">Bearer </code> — just the token itself</li>
              </ol>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-gray-600">Bearer Token</label>
                <input
                  type="password"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder="eyJhbGciOiJSUzI1NiIs..."
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-xs text-gray-700 placeholder-gray-300 focus:outline-none focus:ring-1 focus:ring-blue-400 font-mono"
                  onKeyDown={(e) => e.key === 'Enter' && token.trim() && setPhase('config')}
                  autoFocus
                />
              </div>
            </div>
          )}

          {/* Step 2: Config */}
          {phase === 'config' && (
            <div className="space-y-4">
              <p className="text-xs text-gray-500">
                Select the year range to fetch financial data for. Annual + quarterly rows will be included.
              </p>
              <div className="flex items-center gap-3">
                <div className="space-y-1 flex-1">
                  <label className="text-xs font-medium text-gray-600">From year</label>
                  <select
                    value={yearFrom}
                    onChange={(e) => setYearFrom(parseInt(e.target.value, 10))}
                    className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-xs text-gray-700 focus:outline-none focus:ring-1 focus:ring-blue-400"
                  >
                    {YEAR_OPTIONS.map((y) => (
                      <option key={y} value={y}>{y}</option>
                    ))}
                  </select>
                </div>
                <span className="text-gray-400 text-xs mt-4">→</span>
                <div className="space-y-1 flex-1">
                  <label className="text-xs font-medium text-gray-600">To year</label>
                  <select
                    value={yearTo}
                    onChange={(e) => setYearTo(parseInt(e.target.value, 10))}
                    className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-xs text-gray-700 focus:outline-none focus:ring-1 focus:ring-blue-400"
                  >
                    {YEAR_OPTIONS.map((y) => (
                      <option key={y} value={y}>{y}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="bg-gray-50 rounded-lg px-3 py-2 text-xs text-gray-500 border border-gray-100">
                <span className="font-medium text-gray-600">Metrics fetched:</span> Revenue, Net Income, EPS (all
                periods) + current ratios/margins/balance sheet (most recent annual row)
              </div>
            </div>
          )}

          {/* Loading: fetching */}
          {phase === 'fetching' && (
            <div className="flex flex-col items-center justify-center py-8 gap-3">
              <div className="w-6 h-6 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
              <p className="text-xs text-gray-500">Fetching data from Stockbit…</p>
            </div>
          )}

          {/* Preview */}
          {phase === 'preview' && (() => {
            const snapshotRow = rows.find((r) => r.quarter === 0)
            const snapshotGroups: { label: string; items: { label: string; value: string }[] }[] = [
              {
                label: 'Income Statement',
                items: [
                  { label: 'Revenue (TTM)',    value: formatIDR(snapshotRow?.revenue) },
                  { label: 'Gross Profit',     value: formatIDR(snapshotRow?.gross_profit) },
                  { label: 'Net Income (TTM)', value: formatIDR(snapshotRow?.net_income) },
                  { label: 'EPS (TTM)',        value: snapshotRow?.eps != null ? snapshotRow.eps.toFixed(2) : '-' },
                ],
              },
              {
                label: 'Balance Sheet',
                items: [
                  { label: 'Total Assets',      value: formatIDR(snapshotRow?.total_assets) },
                  { label: 'Total Liabilities', value: formatIDR(snapshotRow?.total_liabilities) },
                  { label: 'Total Equity',      value: formatIDR(snapshotRow?.total_equity) },
                  { label: 'Total Debt',        value: formatIDR(snapshotRow?.total_debt) },
                  { label: 'Cash',              value: formatIDR(snapshotRow?.cash_and_equivalents) },
                  { label: 'Net Debt',          value: formatIDR(snapshotRow?.net_debt) },
                  { label: 'BVPS',              value: snapshotRow?.book_value_per_share != null ? snapshotRow.book_value_per_share.toFixed(0) : '-' },
                ],
              },
              {
                label: 'Cash Flow',
                items: [
                  { label: 'Operating CF',     value: formatIDR(snapshotRow?.operating_cash_flow) },
                  { label: 'CapEx',            value: formatIDR(snapshotRow?.capex) },
                  { label: 'Free Cash Flow',   value: formatIDR(snapshotRow?.free_cash_flow) },
                  { label: 'Investing CF',     value: formatIDR(snapshotRow?.investing_cash_flow) },
                  { label: 'Financing CF',     value: formatIDR(snapshotRow?.financing_cash_flow) },
                ],
              },
              {
                label: 'Profitability',
                items: [
                  { label: 'Gross Margin',     value: snapshotRow?.gross_margin != null ? `${snapshotRow.gross_margin.toFixed(1)}%` : '-' },
                  { label: 'Operating Margin', value: snapshotRow?.operating_margin != null ? `${snapshotRow.operating_margin.toFixed(1)}%` : '-' },
                  { label: 'Net Margin',       value: snapshotRow?.net_margin != null ? `${snapshotRow.net_margin.toFixed(1)}%` : '-' },
                  { label: 'ROE',              value: snapshotRow?.roe != null ? `${snapshotRow.roe.toFixed(1)}%` : '-' },
                  { label: 'ROA',              value: snapshotRow?.roa != null ? `${snapshotRow.roa.toFixed(1)}%` : '-' },
                  { label: 'ROCE',             value: snapshotRow?.roce != null ? `${snapshotRow.roce.toFixed(1)}%` : '-' },
                  { label: 'ROIC',             value: snapshotRow?.roic != null ? `${snapshotRow.roic.toFixed(1)}%` : '-' },
                ],
              },
              {
                label: 'Management Effectiveness',
                items: [
                  { label: 'Asset Turnover',     value: snapshotRow?.asset_turnover != null ? snapshotRow.asset_turnover.toFixed(2) : '-' },
                  { label: 'Inventory Turnover', value: snapshotRow?.inventory_turnover != null ? snapshotRow.inventory_turnover.toFixed(2) : '-' },
                  { label: 'Interest Coverage',  value: snapshotRow?.interest_coverage != null ? snapshotRow.interest_coverage.toFixed(2) : '-' },
                ],
              },
              {
                label: 'Assets & Debts',
                items: [
                  { label: 'Current Ratio',     value: snapshotRow?.current_ratio != null ? snapshotRow.current_ratio.toFixed(2) : '-' },
                  { label: 'Quick Ratio',       value: snapshotRow?.quick_ratio != null ? snapshotRow.quick_ratio.toFixed(2) : '-' },
                  { label: 'D/E',               value: snapshotRow?.debt_to_equity != null ? snapshotRow.debt_to_equity.toFixed(2) : '-' },
                  { label: 'LT D/E',            value: snapshotRow?.lt_debt_to_equity != null ? snapshotRow.lt_debt_to_equity.toFixed(2) : '-' },
                  { label: 'Debt/Assets',       value: snapshotRow?.debt_to_assets != null ? snapshotRow.debt_to_assets.toFixed(2) : '-' },
                  { label: 'Fin. Leverage',     value: snapshotRow?.financial_leverage != null ? snapshotRow.financial_leverage.toFixed(2) : '-' },
                ],
              },
            ]

            return (
              <div className="space-y-4">
                {/* Summary */}
                <p className="text-xs text-gray-500">
                  <span className="font-medium text-gray-700">{rows.length} rows</span> ready to save —{' '}
                  {rows.filter((r) => r.quarter === 0).length} annual,{' '}
                  {rows.filter((r) => r.quarter > 0).length} quarterly.
                  Snapshot metrics merged into most recent annual row.
                </p>

                {/* History table */}
                <div>
                  <p className="text-xs font-medium text-gray-600 mb-1.5">Historical Series</p>
                  <div className="overflow-x-auto rounded-lg border border-gray-100">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="bg-gray-50 border-b border-gray-100">
                          {['Year', 'Q', 'Revenue', 'Net Income', 'EPS'].map((h) => (
                            <th key={h} className={`py-2 px-3 font-medium text-gray-500 ${h === 'Year' || h === 'Q' ? 'text-left' : 'text-right'}`}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((r) => (
                          <tr key={`${r.year}_${r.quarter}`} className="border-b border-gray-50 last:border-0 hover:bg-gray-50">
                            <td className="py-1.5 px-3 text-gray-700 tabular-nums">{r.year}</td>
                            <td className="py-1.5 px-3 text-gray-400">{r.quarter === 0 ? 'FY' : `Q${r.quarter}`}</td>
                            <td className="py-1.5 px-3 text-right text-gray-600 tabular-nums">{formatIDR(r.revenue)}</td>
                            <td className="py-1.5 px-3 text-right text-gray-600 tabular-nums">{formatIDR(r.net_income)}</td>
                            <td className="py-1.5 px-3 text-right text-gray-600 tabular-nums">{r.eps != null ? r.eps.toFixed(2) : '-'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* Snapshot metrics grid */}
                {snapshotRow && (
                  <div>
                    <p className="text-xs font-medium text-gray-600 mb-1.5">
                      Current Snapshot — {snapshotRow.year} FY
                    </p>
                    <div className="space-y-3">
                      {snapshotGroups.map((group) => (
                        <div key={group.label} className="rounded-lg border border-gray-100 overflow-hidden">
                          <div className="bg-gray-50 px-3 py-1.5 text-xs font-medium text-gray-500 border-b border-gray-100">
                            {group.label}
                          </div>
                          <div className="grid grid-cols-2 divide-x divide-gray-50">
                            {group.items.map((item) => (
                              <div key={item.label} className="px-3 py-1.5 flex items-center justify-between gap-2 border-b border-gray-50">
                                <span className="text-xs text-gray-400">{item.label}</span>
                                <span className="text-xs font-medium text-gray-700 tabular-nums">{item.value}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )
          })()}

          {/* Loading: saving */}
          {phase === 'saving' && (
            <div className="flex flex-col items-center justify-center py-8 gap-3">
              <div className="w-6 h-6 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
              <p className="text-xs text-gray-500">Saving {rows.length} rows to database…</p>
            </div>
          )}

          {/* Done */}
          {phase === 'saved' && (
            <div className="flex flex-col items-center justify-center py-8 gap-2 text-center">
              <div className="w-10 h-10 rounded-full bg-green-50 flex items-center justify-center text-green-500 text-lg">
                ✓
              </div>
              <p className="text-sm font-medium text-gray-700">
                {upsertedCount} rows saved successfully
              </p>
              <p className="text-xs text-gray-400">Reload the page to see updated charts.</p>
            </div>
          )}

          {/* Error */}
          {phase === 'error' && (
            <div className="flex flex-col items-center justify-center py-6 gap-3 text-center">
              <div className="w-10 h-10 rounded-full bg-red-50 flex items-center justify-center text-red-400 text-lg">
                ✗
              </div>
              <p className="text-xs text-red-500 max-w-xs">{errorMsg}</p>
            </div>
          )}
        </div>

        {/* Footer actions */}
        <div className="px-5 py-4 border-t border-gray-100 flex justify-between items-center shrink-0">
          {/* Back navigation */}
          <div>
            {phase === 'config' && (
              <button
                onClick={() => setPhase('token')}
                className="text-xs text-gray-400 hover:text-gray-600 transition-colors"
              >
                ← Back
              </button>
            )}
            {phase === 'preview' && (
              <button
                onClick={() => setPhase('config')}
                className="text-xs text-gray-400 hover:text-gray-600 transition-colors"
              >
                ← Back
              </button>
            )}
            {phase === 'error' && (
              <button
                onClick={() => setPhase(rows.length > 0 ? 'preview' : 'config')}
                className="text-xs text-gray-400 hover:text-gray-600 transition-colors"
              >
                ← Back
              </button>
            )}
          </div>

          {/* Primary CTA */}
          <div className="flex gap-2">
            {(phase === 'saved') && (
              <button
                onClick={onClose}
                className="px-4 py-1.5 text-xs text-white bg-blue-500 rounded-lg hover:bg-blue-600 transition-colors"
              >
                Done
              </button>
            )}
            {phase === 'token' && (
              <button
                disabled={!token.trim()}
                onClick={() => setPhase('config')}
                className="px-4 py-1.5 text-xs text-white bg-blue-500 rounded-lg hover:bg-blue-600 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Next →
              </button>
            )}
            {phase === 'config' && (
              <button
                disabled={yearFrom > yearTo}
                onClick={handleFetch}
                className="px-4 py-1.5 text-xs text-white bg-blue-500 rounded-lg hover:bg-blue-600 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Fetch Preview
              </button>
            )}
            {phase === 'preview' && (
              <button
                onClick={handleSave}
                className="px-4 py-1.5 text-xs text-white bg-green-500 rounded-lg hover:bg-green-600 transition-colors"
              >
                Save to Database ({rows.length} rows)
              </button>
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

  if (!data) return null

  const { completeness_score, confidence_score, scores_updated_at, last_scraped_at, missing_categories } = data
  const timestamp          = scores_updated_at ?? last_scraped_at
  const hasMissing         = missing_categories.length > 0
  const isLowCompleteness  = completeness_score < 50

  return (
    <>
      {modalOpen && (
        <StockbitRefreshModal ticker={ticker} onClose={() => setModalOpen(false)} />
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
              {hasMissing && (
                <span className="text-xs text-amber-500">
                  {missing_categories.length} categor{missing_categories.length === 1 ? 'y' : 'ies'} missing
                </span>
              )}
              <button
                onClick={() => setModalOpen(true)}
                className={`text-xs px-2.5 py-1 rounded-lg border transition-colors ${
                  isLowCompleteness
                    ? 'border-amber-300 text-amber-600 hover:bg-amber-50'
                    : 'border-gray-200 text-gray-500 hover:bg-gray-50'
                }`}
              >
                ↺ Refresh Data
              </button>
            </div>
          </div>
        </div>

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
                  Confidence score has not been computed yet. Use{' '}
                  <span className="font-medium text-gray-500">↺ Refresh Data</span>{' '}
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
