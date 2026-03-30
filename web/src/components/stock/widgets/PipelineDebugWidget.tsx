'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import type { PipelineDebugData, SectorTemplate, StockNote, AIAnalysis } from '@/lib/types/api'

// ---------------------------------------------------------------------------
// Collapsible section wrapper
// ---------------------------------------------------------------------------

function Section({ title, defaultOpen = false, children }: {
  title: string; defaultOpen?: boolean; children: React.ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="border border-[#E5E4E1] rounded-lg overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-4 py-2.5 bg-[#F5F4F1] hover:bg-[#EDECEA] transition-colors text-left"
      >
        <span className="text-xs font-semibold text-[#1A1918] uppercase tracking-wide">{title}</span>
        <span className="text-xs text-[#9C9B99]">{open ? '▲' : '▼'}</span>
      </button>
      {open && <div className="p-4 space-y-3">{children}</div>}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Badge helper
// ---------------------------------------------------------------------------

function Badge({ label, color }: { label: string; color: 'green' | 'amber' | 'red' | 'gray' | 'blue' }) {
  const colors = {
    green: 'bg-green-100 text-green-700 border-green-200',
    amber: 'bg-amber-100 text-amber-700 border-amber-200',
    red: 'bg-red-100 text-red-700 border-red-200',
    gray: 'bg-gray-100 text-gray-600 border-gray-200',
    blue: 'bg-blue-100 text-blue-700 border-blue-200',
  }
  return (
    <span className={`inline-block px-2 py-0.5 text-[10px] font-medium rounded border ${colors[color]}`}>
      {label}
    </span>
  )
}

function gradeBadge(grade: string | null) {
  if (!grade) return <Badge label="—" color="gray" />
  const map: Record<string, 'green' | 'amber' | 'red' | 'gray'> = {
    A: 'green', B: 'green', C: 'amber', D: 'red', F: 'red',
    HIGH: 'green', MEDIUM: 'amber', LOW: 'red', 'VERY LOW': 'red',
  }
  return <Badge label={grade} color={map[grade] ?? 'gray'} />
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

interface Props {
  ticker: string
  subsector: string | null
}

export function PipelineDebugWidget({ ticker, subsector }: Props) {
  const [expanded, setExpanded] = useState(false)
  const loadedRef = useRef(false)
  const [data, setData] = useState<PipelineDebugData | null>(null)
  const [loading, setLoading] = useState(false)
  const [notes, setNotes] = useState('')
  const [notesSaved, setNotesSaved] = useState(false)
  const [template, setTemplate] = useState<SectorTemplate | null>(null)
  const [macro, setMacro] = useState<Record<string, unknown> | null>(null)
  const [rawTable, setRawTable] = useState('financials')
  const [rawRows, setRawRows] = useState<unknown[]>([])
  const [rawTotal, setRawTotal] = useState(0)

  // Load pipeline debug data
  const loadData = useCallback(async () => {
    setLoading(true)
    try {
      const [debugRes, notesRes, templateRes, macroRes] = await Promise.all([
        fetch(`/api/stocks/${ticker}/pipeline-debug`).then((r) => r.ok ? r.json() : null),
        fetch(`/api/stocks/${ticker}/domain-notes`).then((r) => r.json()),
        subsector
          ? fetch(`/api/admin/sector-template/${encodeURIComponent(subsector)}`).then((r) => r.json())
          : Promise.resolve(null),
        fetch('/api/admin/macro-context').then((r) => r.ok ? r.json() : null),
      ])
      setData(debugRes)
      setNotes(notesRes?.domainNotes ?? '')
      setTemplate(templateRes)
      setMacro(macroRes)
    } catch (e) {
      console.error('Pipeline debug load failed:', e)
    } finally {
      setLoading(false)
    }
  }, [ticker, subsector])

  // Lazy load: only fetch when first expanded
  useEffect(() => {
    if (expanded && !loadedRef.current) {
      loadedRef.current = true
      loadData()
    }
  }, [expanded, loadData])

  // Load raw data
  const loadRawData = useCallback(async (table: string) => {
    setRawTable(table)
    try {
      const res = await fetch(`/api/stocks/${ticker}/raw-data/${table}?limit=15`)
      if (res.ok) {
        const body = await res.json()
        setRawRows(body.rows ?? [])
        setRawTotal(body.total ?? 0)
      }
    } catch { /* ignore */ }
  }, [ticker])

  // Save domain notes
  const saveNotes = useCallback(async () => {
    try {
      await fetch(`/api/stocks/${ticker}/domain-notes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domainNotes: notes }),
      })
      setNotesSaved(true)
      setTimeout(() => setNotesSaved(false), 2000)
    } catch { /* ignore */ }
  }, [ticker, notes])

  return (
    <div className="bg-white border border-[#E0E0E5] rounded-lg overflow-hidden mt-2">
      {/* Collapsed header — always visible */}
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center justify-between px-5 py-3 hover:bg-[#F5F4F1] transition-colors"
      >
        <div className="flex items-center gap-2">
          <span className="font-mono text-[13px] font-bold tracking-[0.5px] text-[#1A1A1A]">AI PIPELINE</span>
          {data?.stockScore && (
            <>
              <Badge label={`Reliability ${data.stockScore.reliabilityGrade}`} color={
                data.stockScore.reliabilityGrade === 'A' ? 'green' : data.stockScore.reliabilityGrade === 'B' ? 'green' : 'amber'
              } />
              <Badge label={data.stockScore.readyForAI ? 'AI Ready' : 'Not Ready'} color={data.stockScore.readyForAI ? 'green' : 'red'} />
            </>
          )}
        </div>
        <div className="flex items-center gap-2">
          {loading && <span className="text-[10px] text-[#9C9B99]">Loading...</span>}
          <span className="text-xs text-[#9C9B99]">{expanded ? '▲' : '▼'}</span>
        </div>
      </button>

      {/* Expanded content */}
      {expanded && (
      <div className="border-t border-[#E0E0E5] p-4 space-y-3">
        {/* Refresh button */}
        <div className="flex justify-end">
          <button onClick={() => { loadedRef.current = false; loadData() }} className="text-[10px] text-[#3D8A5A] hover:underline">
            Refresh Data
          </button>
        </div>

        {/* ── Section A: Pipeline Stage Breakdown ── */}
        <Section title="A. Pipeline Stages" defaultOpen>

          {/* Stage 1: Data Quality Flags */}
          {data?.dataQualityFlags && data.dataQualityFlags.length > 0 && (
            <div>
              <p className="text-[10px] font-semibold text-[#9C9B99] mb-1">Stage 1 — Data Cleaner ({data.dataQualityFlags.length} years)</p>
              <div className="overflow-x-auto">
                <table className="w-full text-[10px]">
                  <thead>
                    <tr className="border-b border-[#E5E4E1]">
                      {['Year', 'Flag', 'COVID', 'IPO', 'Anomaly', 'OneTime', 'Scale', 'Notes'].map((h) => (
                        <th key={h} className="py-1 px-2 text-left text-[#9C9B99] font-medium">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {data.dataQualityFlags.map((f) => (
                      <tr key={f.year} className="border-b border-[#E5E4E1] last:border-0">
                        <td className="py-1 px-2 tabular-nums">{f.year}</td>
                        <td className="py-1 px-2">
                          <Badge
                            label={f.usability_flag}
                            color={f.usability_flag === 'clean' ? 'green' : f.usability_flag === 'exclude' ? 'red' : 'amber'}
                          />
                        </td>
                        <td className="py-1 px-2">{f.is_covid_year ? '●' : ''}</td>
                        <td className="py-1 px-2">{f.is_ipo_year ? '●' : ''}</td>
                        <td className="py-1 px-2">{f.has_anomaly ? '●' : ''}</td>
                        <td className="py-1 px-2">{f.has_one_time_items ? '●' : ''}</td>
                        <td className="py-1 px-2">{f.scale_warning ? '●' : ''}</td>
                        <td className="py-1 px-2 text-[#9C9B99] max-w-[200px] truncate">{f.cleaner_notes ?? ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Stage 2: Normalized Metrics */}
          {data?.normalizedMetrics && data.normalizedMetrics.length > 0 && (
            <div>
              <p className="text-[10px] font-semibold text-[#9C9B99] mb-1">Stage 2 — Normalized Metrics ({data.normalizedMetrics.length})</p>
              <div className="overflow-x-auto">
                <table className="w-full text-[10px]">
                  <thead>
                    <tr className="border-b border-[#E5E4E1]">
                      {['Metric', 'Value', 'Trend', 'R²', '3yr CAGR', 'Peers'].map((h) => (
                        <th key={h} className="py-1 px-2 text-left text-[#9C9B99] font-medium">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {data.normalizedMetrics.map((m) => (
                      <tr key={m.metric_name} className="border-b border-[#E5E4E1] last:border-0">
                        <td className="py-1 px-2 font-medium text-[#1A1918]">{m.metric_name}</td>
                        <td className="py-1 px-2 tabular-nums text-right">
                          {m.latest_value != null ? Number(m.latest_value).toLocaleString('en', { maximumFractionDigits: 2 }) : '—'}
                        </td>
                        <td className="py-1 px-2">
                          {m.trend_direction && (
                            <Badge
                              label={m.trend_direction}
                              color={m.trend_direction.includes('up') ? 'green' : m.trend_direction.includes('down') ? 'red' : 'gray'}
                            />
                          )}
                        </td>
                        <td className="py-1 px-2 tabular-nums text-right">{m.trend_r2?.toFixed(2) ?? '—'}</td>
                        <td className="py-1 px-2 tabular-nums text-right">
                          {m.cagr_3yr != null ? `${(m.cagr_3yr * 100).toFixed(1)}%` : '—'}
                        </td>
                        <td className="py-1 px-2 tabular-nums text-right">{m.peer_count || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Stage 3: Scoring */}
          {data?.stockScore && (
            <div>
              <p className="text-[10px] font-semibold text-[#9C9B99] mb-1">Stage 3 — Scoring</p>
              <div className="grid grid-cols-2 gap-3">
                <div className="bg-[#F5F4F1] rounded-lg p-3 space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] text-[#6D6C6A]">Reliability</span>
                    {gradeBadge(data.stockScore.reliabilityGrade)}
                  </div>
                  <p className="text-lg font-bold text-[#1A1918] tabular-nums">{data.stockScore.reliabilityTotal}</p>
                  <div className="text-[9px] text-[#9C9B99] space-y-0.5">
                    <div>Completeness: {data.stockScore.reliabilityCompleteness}</div>
                    <div>Consistency: {data.stockScore.reliabilityConsistency}</div>
                    <div>Freshness: {data.stockScore.reliabilityFreshness}</div>
                    <div>Source: {data.stockScore.reliabilitySource}</div>
                    <div>Penalties: -{data.stockScore.reliabilityPenalties}</div>
                  </div>
                </div>
                <div className="bg-[#F5F4F1] rounded-lg p-3 space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] text-[#6D6C6A]">Confidence</span>
                    {gradeBadge(data.stockScore.confidenceGrade)}
                  </div>
                  <p className="text-lg font-bold text-[#1A1918] tabular-nums">{data.stockScore.confidenceTotal}</p>
                  <div className="text-[9px] text-[#9C9B99] space-y-0.5">
                    <div>Signal: {data.stockScore.confidenceSignal}</div>
                    <div>Trend: {data.stockScore.confidenceTrend}</div>
                    <div>Depth: {data.stockScore.confidenceDepth}</div>
                    <div>Peers: {data.stockScore.confidencePeers}</div>
                    <div>Valuation: {data.stockScore.confidenceValuation}</div>
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-3 mt-2">
                <span className="text-[10px] text-[#6D6C6A]">Composite: <strong>{data.stockScore.compositeScore}</strong></span>
                <Badge
                  label={data.stockScore.readyForAI ? 'AI Ready' : 'Not AI Ready'}
                  color={data.stockScore.readyForAI ? 'green' : 'red'}
                />
              </div>
            </div>
          )}

          {/* Stage 4 & 5 */}
          {data?.contextCache && (
            <div className="flex items-center gap-4 text-[10px] text-[#6D6C6A]">
              <span>Stage 4 — Context: {data.contextCache.tokenEstimate} tokens, v{data.contextCache.contextVersion}</span>
              <span>Built: {data.contextCache.builtAt ? new Date(data.contextCache.builtAt).toLocaleDateString() : 'never'}</span>
            </div>
          )}
          {data?.aiAnalysis && (
            <div className="flex items-center gap-2 text-[10px]">
              <span className="text-[#6D6C6A]">Stage 5 — AI:</span>
              <Badge label={data.aiAnalysis.lynchCategory} color="blue" />
              <Badge label={data.aiAnalysis.analystVerdict} color={
                data.aiAnalysis.analystVerdict === 'buy' || data.aiAnalysis.analystVerdict === 'strong_buy' ? 'green' :
                data.aiAnalysis.analystVerdict === 'hold' ? 'amber' : 'red'
              } />
              <span className="text-[#9C9B99]">confidence: {data.aiAnalysis.confidenceLevel}/10</span>
            </div>
          )}
          {!data?.aiAnalysis && data?.stockScore && (
            <p className="text-[10px] text-[#9C9B99]">Stage 5 — AI analysis not yet generated.</p>
          )}
        </Section>

        {/* ── Section B: Context Layer Editor ── */}
        <Section title="B. Context Layers">
          {/* Macro (read-only) */}
          <div>
            <p className="text-[10px] font-semibold text-[#9C9B99] mb-1">Layer 1 — Macro Context (read-only)</p>
            {macro ? (
              <pre className="text-[9px] bg-[#F5F4F1] rounded p-2 overflow-x-auto max-h-32">
                {JSON.stringify(macro, null, 2)}
              </pre>
            ) : (
              <p className="text-[10px] text-[#9C9B99]">Not loaded</p>
            )}
          </div>

          {/* Sector template */}
          <div>
            <p className="text-[10px] font-semibold text-[#9C9B99] mb-1">
              Layer 2 — Sector Template ({subsector ?? 'unknown'})
            </p>
            {template ? (
              <pre className="text-[9px] bg-[#F5F4F1] rounded p-2 overflow-x-auto max-h-32">
                {JSON.stringify(template, null, 2)}
              </pre>
            ) : (
              <p className="text-[10px] text-amber-500">No template for this subsector. Create one via API.</p>
            )}
          </div>

          {/* Domain notes (editable) */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <p className="text-[10px] font-semibold text-[#9C9B99]">Layer 3 — Domain Notes</p>
              <div className="flex items-center gap-2">
                {notesSaved && <span className="text-[10px] text-green-600">Saved</span>}
                <button
                  onClick={saveNotes}
                  className="text-[10px] px-2 py-0.5 bg-[#1A1918] text-white rounded hover:bg-[#333]"
                >
                  Save
                </button>
              </div>
            </div>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Add 2-5 sentences about this company's business model, competitive position, and key differentiators..."
              className="w-full border border-[#E5E4E1] rounded-lg px-3 py-2 text-xs text-[#1A1918] placeholder-[#9C9B99] focus:outline-none focus:ring-1 focus:ring-amber-400 min-h-[80px] resize-y"
            />
            <p className="text-[9px] text-[#9C9B99] mt-0.5">{notes.length} chars (~{Math.ceil(notes.length / 4)} tokens)</p>
          </div>
        </Section>

        {/* ── Section D: Raw Data Inspector ── */}
        <Section title="D. Raw Data Inspector">
          <div className="flex items-center gap-2 mb-2">
            {['financials', 'daily_prices', 'broker_flow', 'bandar_signal', 'insider_transactions', 'data_quality_flags', 'normalized_metrics'].map((t) => (
              <button
                key={t}
                onClick={() => loadRawData(t)}
                className={`text-[10px] px-2 py-1 rounded border transition-colors ${
                  rawTable === t ? 'bg-[#1A1918] text-white border-[#1A1918]' : 'bg-white text-[#6D6C6A] border-[#E5E4E1] hover:border-[#1A1918]'
                }`}
              >
                {t}
              </button>
            ))}
          </div>
          {rawRows.length > 0 ? (
            <div className="overflow-x-auto max-h-48">
              <pre className="text-[9px] bg-[#F5F4F1] rounded p-2">
                {JSON.stringify(rawRows.slice(0, 5), null, 2)}
              </pre>
              <p className="text-[9px] text-[#9C9B99] mt-1">
                Showing {Math.min(5, rawRows.length)} of {rawTotal} rows
              </p>
            </div>
          ) : (
            <p className="text-[10px] text-[#9C9B99]">Click a table above to load data</p>
          )}
        </Section>

      </div>
      )}
    </div>
  )
}
