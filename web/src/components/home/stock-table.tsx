'use client'

import { useState, useEffect, useRef } from 'react'
import Link from 'next/link'
import type { ScreenerRow, MarketPhaseType } from '@/lib/types/api'
import { Badge } from '@/components/ui/badge'
import { fmtNumID, formatIDRCompact, formatPercent, formatMultiple } from '@/lib/calculations/formatters'
import { WatchlistStar } from '@/components/home/watchlist-star'

// ---------------------------------------------------------------------------
// Phase badge config
// ---------------------------------------------------------------------------

const PHASE_BADGE: Record<MarketPhaseType, { label: string; variant: 'blue' | 'red' | 'green' | 'amber' }> = {
  uptrend:          { label: 'Uptrend',    variant: 'blue'  },
  downtrend:        { label: 'Downtrend',  variant: 'red'   },
  sideways_bullish: { label: 'Sideways ↑', variant: 'green' },
  sideways_bearish: { label: 'Sideways ↓', variant: 'amber' },
}

// ---------------------------------------------------------------------------
// Column definitions
// ---------------------------------------------------------------------------

type ColumnKey =
  | 'company' | 'subsector' | 'sector' | 'board' | 'phase' | 'phase_clarity'
  | 'listing_date' | 'listed_shares' | 'price'
  | 'pe_ratio' | 'pbv_ratio' | 'roe' | 'net_margin' | 'dividend_yield'
  | 'revenue_cagr_3yr' | 'revenue_cagr_5yr'
  | 'price_cagr_3yr' | 'price_cagr_5yr'
  | 'div_yield_avg_3yr' | 'div_yield_avg_5yr'
  | 'market_cap' | 'completeness' | 'confidence'
  | 'rsi_14' | 'macd_cross' | 'volume_change' | 'volume_avg'

interface ColumnDef {
  key: ColumnKey
  label: string
  shortLabel?: string          // for the picker if label is long
  align: 'left' | 'right'
  sortCol?: string             // if sortable
  renderHead?: boolean         // false = plain th (default true via sortCol presence)
  render: (row: ScreenerRow) => React.ReactNode
}

const DEFAULT_VISIBLE: ColumnKey[] = [
  'sector', 'phase', 'price', 'pe_ratio', 'pbv_ratio', 'market_cap',
]

const STORAGE_KEY = 'screener-visible-cols'

function cagrCell(value: number | null) {
  if (value == null) return <span className="text-gray-400">—</span>
  const color = value >= 10 ? 'text-green-600' : value >= 0 ? 'text-gray-700' : 'text-red-500'
  return <span className={color}>{value.toFixed(1)}%</span>
}

const COLUMNS: ColumnDef[] = [
  // ── Identity ──
  {
    key: 'company', label: 'Company', align: 'left',
    render: (r) => <span className="text-gray-700 max-w-[180px] truncate block">{r.name ?? '—'}</span>,
  },
  {
    key: 'sector', label: 'Sector', align: 'left',
    render: (r) => r.sector ? <Badge variant="blue">{r.sector}</Badge> : null,
  },
  {
    key: 'subsector', label: 'Subsector', align: 'left',
    render: (r) => r.subsector ? <span className="text-gray-600 text-xs">{r.subsector}</span> : <span className="text-gray-400">—</span>,
  },
  {
    key: 'board', label: 'Board', align: 'left',
    render: (r) => r.board ? <Badge variant="gray" size="xs">{r.board}</Badge> : <span className="text-gray-400">—</span>,
  },
  {
    key: 'listing_date', label: 'Listed', align: 'right',
    render: (r) => r.listing_date ? <span className="text-gray-600 text-xs font-mono">{r.listing_date}</span> : <span className="text-gray-400">—</span>,
  },
  // ── Phase ──
  {
    key: 'phase', label: 'Phase', align: 'left',
    render: (r) => r.current_phase
      ? (
        <div className="flex items-center gap-1.5">
          <Badge variant={PHASE_BADGE[r.current_phase].variant} size="xs">{PHASE_BADGE[r.current_phase].label}</Badge>
          {r.current_phase_days != null && (
            <span className="text-[10px] font-mono text-gray-400">{r.current_phase_days}d</span>
          )}
        </div>
      )
      : <span className="text-gray-400">—</span>,
  },
  {
    key: 'phase_clarity', label: 'Phase Clarity', align: 'right',
    render: (r) => {
      const v = r.current_phase_clarity
      if (v == null) return <span className="text-gray-400">—</span>
      const c = v >= 70 ? 'text-green-600' : v >= 45 ? 'text-amber-600' : 'text-red-500'
      return <span className={`font-medium ${c}`}>{v}</span>
    },
  },
  // ── Price & Valuation ──
  {
    key: 'price', label: 'Price', align: 'right', sortCol: 'price',
    render: (r) => r.price != null
      ? <span className="font-medium text-gray-900">Rp{fmtNumID(r.price)}</span>
      : <span className="text-gray-400">—</span>,
  },
  {
    key: 'pe_ratio', label: 'P/E', align: 'right', sortCol: 'pe_ratio',
    render: (r) => <span className="text-gray-600">{formatMultiple(r.pe_ratio)}</span>,
  },
  {
    key: 'pbv_ratio', label: 'P/BV', align: 'right', sortCol: 'pbv_ratio',
    render: (r) => <span className="text-gray-600">{formatMultiple(r.pbv_ratio)}</span>,
  },
  {
    key: 'market_cap', label: 'Mkt Cap', align: 'right', sortCol: 'market_cap',
    render: (r) => <span className="text-gray-600">{formatIDRCompact(r.market_cap)}</span>,
  },
  {
    key: 'listed_shares', label: 'Shares', align: 'right',
    render: (r) => r.listed_shares != null ? <span className="text-gray-600">{formatIDRCompact(r.listed_shares)}</span> : <span className="text-gray-400">—</span>,
  },
  // ── Fundamentals ──
  {
    key: 'roe', label: 'ROE', align: 'right', sortCol: 'roe',
    render: (r) => {
      const c = r.roe != null && r.roe >= 15 ? 'text-green-600'
        : r.roe != null && r.roe >= 8 ? 'text-amber-600'
        : r.roe != null ? 'text-red-500' : 'text-gray-400'
      return <span className={`font-medium ${c}`}>{formatPercent(r.roe)}</span>
    },
  },
  {
    key: 'net_margin', label: 'Net Margin', align: 'right', sortCol: 'net_margin',
    render: (r) => {
      const c = r.net_margin != null && r.net_margin >= 10 ? 'text-green-600'
        : r.net_margin != null && r.net_margin >= 5 ? 'text-amber-600'
        : r.net_margin != null ? 'text-red-500' : 'text-gray-400'
      return <span className={c}>{formatPercent(r.net_margin)}</span>
    },
  },
  // ── Dividends ──
  {
    key: 'dividend_yield', label: 'Div Yield', align: 'right', sortCol: 'dividend_yield',
    render: (r) => <span className="text-gray-600">{formatPercent(r.dividend_yield)}</span>,
  },
  {
    key: 'div_yield_avg_3yr', label: 'Div Avg 3Y', align: 'right',
    render: (r) => <span className="text-gray-600">{formatPercent(r.div_yield_avg_3yr)}</span>,
  },
  {
    key: 'div_yield_avg_5yr', label: 'Div Avg 5Y', align: 'right',
    render: (r) => <span className="text-gray-600">{formatPercent(r.div_yield_avg_5yr)}</span>,
  },
  // ── Growth (CAGR) ──
  {
    key: 'revenue_cagr_3yr', label: 'Rev CAGR 3Y', align: 'right',
    render: (r) => cagrCell(r.revenue_cagr_3yr),
  },
  {
    key: 'revenue_cagr_5yr', label: 'Rev CAGR 5Y', align: 'right',
    render: (r) => cagrCell(r.revenue_cagr_5yr),
  },
  {
    key: 'price_cagr_3yr', label: 'Price CAGR 3Y', align: 'right',
    render: (r) => cagrCell(r.price_cagr_3yr),
  },
  {
    key: 'price_cagr_5yr', label: 'Price CAGR 5Y', align: 'right',
    render: (r) => cagrCell(r.price_cagr_5yr),
  },
  // ── Technical Signals ──
  {
    key: 'rsi_14', label: 'RSI (14)', shortLabel: 'RSI', align: 'right',
    render: (r) => {
      const v = r.rsi_14
      if (v == null) return <span className="text-gray-400">—</span>
      const c = v >= 70 ? 'text-red-500' : v <= 30 ? 'text-green-600' : 'text-gray-700'
      return <span className={`font-medium ${c}`}>{v.toFixed(1)}</span>
    },
  },
  {
    key: 'macd_cross', label: 'MACD Cross', shortLabel: 'MACD', align: 'left',
    render: (r) => {
      const sig = r.macd_cross_signal
      if (!sig || sig === 'none') return <span className="text-gray-400">—</span>
      const isGolden = sig === 'golden_cross'
      return (
        <div className="flex items-center gap-1.5">
          <Badge variant={isGolden ? 'green' : 'red'} size="xs">
            {isGolden ? 'Golden' : 'Death'}
          </Badge>
          {r.macd_cross_days_ago != null && (
            <span className="text-[10px] font-mono text-gray-400">{r.macd_cross_days_ago}d</span>
          )}
        </div>
      )
    },
  },
  {
    key: 'volume_change', label: 'Vol vs Avg', shortLabel: 'Vol%', align: 'right',
    render: (r) => {
      const v = r.volume_change_pct
      if (v == null) return <span className="text-gray-400">—</span>
      const c = v >= 200 ? 'text-blue-600 font-medium' : v >= 150 ? 'text-blue-500' : 'text-gray-600'
      return <span className={c}>{v.toFixed(0)}%</span>
    },
  },
  {
    key: 'volume_avg', label: 'Avg Vol (20d)', shortLabel: 'Avg Vol', align: 'right',
    render: (r) => {
      const v = r.volume_avg_20d
      if (v == null) return <span className="text-gray-400">—</span>
      return <span className="text-gray-600">{formatIDRCompact(v)}</span>
    },
  },
  // ── Data Quality ──
  {
    key: 'completeness', label: 'Completeness', align: 'right',
    render: (r) => {
      const v = r.completeness_score
      if (v == null) return <span className="text-gray-400">—</span>
      const c = v >= 80 ? 'text-green-600' : v >= 60 ? 'text-amber-600' : 'text-red-500'
      return <span className={`font-medium ${c}`}>{v}</span>
    },
  },
  {
    key: 'confidence', label: 'Confidence', align: 'right',
    render: (r) => {
      const v = r.confidence_score
      if (v == null) return <span className="text-gray-400">—</span>
      const c = v >= 70 ? 'text-green-600' : v >= 45 ? 'text-amber-600' : 'text-red-500'
      return <span className={`font-medium ${c}`}>{v}</span>
    },
  },
]

// ---------------------------------------------------------------------------
// Column picker dropdown
// ---------------------------------------------------------------------------

function ColumnPicker({
  visible,
  onChange,
}: {
  visible: Set<ColumnKey>
  onChange: (next: Set<ColumnKey>) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    if (open) document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [open])

  function toggle(key: ColumnKey) {
    const next = new Set(visible)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    onChange(next)
  }

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg border border-gray-200 bg-white text-gray-600 hover:bg-gray-50 transition-colors"
      >
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7" />
        </svg>
        Columns
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 z-20 w-56 bg-white border border-gray-200 rounded-xl shadow-lg max-h-[70vh] overflow-y-auto">
          {[
            { group: 'Identity', keys: ['company', 'sector', 'subsector', 'board', 'listing_date'] },
            { group: 'Phase', keys: ['phase', 'phase_clarity'] },
            { group: 'Valuation', keys: ['price', 'pe_ratio', 'pbv_ratio', 'market_cap', 'listed_shares'] },
            { group: 'Fundamentals', keys: ['roe', 'net_margin'] },
            { group: 'Dividends', keys: ['dividend_yield', 'div_yield_avg_3yr', 'div_yield_avg_5yr'] },
            { group: 'Growth', keys: ['revenue_cagr_3yr', 'revenue_cagr_5yr', 'price_cagr_3yr', 'price_cagr_5yr'] },
            { group: 'Technical', keys: ['rsi_14', 'macd_cross', 'volume_change', 'volume_avg'] },
            { group: 'Data Quality', keys: ['completeness', 'confidence'] },
          ].map(({ group, keys }) => (
            <div key={group}>
              <div className="px-3 pt-2 pb-1 text-[10px] font-semibold text-gray-400 uppercase tracking-wider">{group}</div>
              {keys.map((k) => {
                const col = COLUMNS.find((c) => c.key === k)
                if (!col) return null
                return (
                  <label
                    key={col.key}
                    className="flex items-center gap-2 px-3 py-1.5 hover:bg-gray-50 cursor-pointer text-sm text-gray-700"
                  >
                    <input
                      type="checkbox"
                      checked={visible.has(col.key)}
                      onChange={() => toggle(col.key)}
                      className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                    />
                    {col.label}
                  </label>
                )
              })}
            </div>
          ))}
          <div className="border-t border-gray-100 mt-1 p-2">
            <button
              onClick={() => onChange(new Set(DEFAULT_VISIBLE))}
              className="w-full text-left px-2 py-1.5 text-xs text-blue-600 hover:bg-blue-50 rounded-lg"
            >
              Reset to defaults
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Sort header
// ---------------------------------------------------------------------------

function SortHeader({
  col, label, align, sortBy, sortDir, baseParams,
}: {
  col: string; label: string; align: 'left' | 'right'; sortBy: string; sortDir: 'asc' | 'desc'; baseParams: Record<string, string>
}) {
  const isActive = sortBy === col
  const nextDir = isActive && sortDir === 'desc' ? 'asc' : 'desc'
  const params = new URLSearchParams({ ...baseParams, sort: col, dir: nextDir })
  const arrow = isActive ? (sortDir === 'desc' ? ' ↓' : ' ↑') : ''
  return (
    <th className={`${align === 'left' ? 'text-left' : 'text-right'} px-4 py-3 text-xs font-semibold uppercase tracking-wide`}>
      <Link
        href={`/?${params.toString()}`}
        className={`hover:text-blue-600 transition-colors ${isActive ? 'text-blue-600' : 'text-gray-500'}`}
      >
        {label}{arrow}
      </Link>
    </th>
  )
}

// ---------------------------------------------------------------------------
// Main table
// ---------------------------------------------------------------------------

interface StockTableProps {
  rows: ScreenerRow[]
  sortBy: string
  sortDir: 'asc' | 'desc'
  baseParams: Record<string, string>
  page: number
  total: number
  totalPages: number
  paginationParams: Record<string, string>
}

export function StockTable({
  rows,
  sortBy,
  sortDir,
  baseParams,
  page,
  total,
  totalPages,
  paginationParams,
}: StockTableProps) {
  // SSR-safe: start with defaults, load from localStorage after mount
  const [visibleCols, setVisibleCols] = useState<Set<ColumnKey>>(() => new Set(DEFAULT_VISIBLE))
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY)
      if (stored) {
        const parsed = JSON.parse(stored) as string[]
        if (Array.isArray(parsed) && parsed.length > 0) {
          setVisibleCols(new Set(parsed as ColumnKey[]))
        }
      }
    } catch { /* ignore */ }
    setMounted(true)
  }, [])

  function handleColumnsChange(next: Set<ColumnKey>) {
    setVisibleCols(next)
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...next]))
  }

  const activeCols = COLUMNS.filter((c) => visibleCols.has(c.key))

  if (rows.length === 0) {
    return (
      <div className="text-center py-16 text-gray-400">
        <p className="text-lg">No stocks found</p>
        <p className="text-sm mt-1">Try adjusting your filters or search for a specific ticker</p>
      </div>
    )
  }

  const shProps = { sortBy, sortDir, baseParams }
  const pageStart = Math.max(1, page - 2)
  const pageEnd = Math.min(totalPages, page + 2)
  const pageNumbers = Array.from({ length: pageEnd - pageStart + 1 }, (_, i) => pageStart + i)

  return (
    <div>
      {/* Column picker row */}
      <div className="relative px-4 py-2 border-b border-gray-100 flex justify-end">
        {mounted && <ColumnPicker visible={visibleCols} onChange={handleColumnsChange} />}
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-200 bg-gray-50">
              {/* Always-visible: star + ticker */}
              <th className="w-8 px-4 py-3"></th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Ticker</th>
              {/* Togglable columns */}
              {activeCols.map((col) =>
                col.sortCol ? (
                  <SortHeader key={col.key} col={col.sortCol} label={col.label} align={col.align} {...shProps} />
                ) : (
                  <th key={col.key} className={`${col.align === 'left' ? 'text-left' : 'text-right'} px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide`}>
                    {col.label}
                  </th>
                )
              )}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {rows.map((row) => (
              <tr key={row.ticker} className="hover:bg-gray-50 transition-colors">
                <td className="px-4 py-3">
                  <WatchlistStar ticker={row.ticker} />
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    <Link
                      href={`/stock/${row.ticker}`}
                      className="font-mono font-bold text-blue-600 hover:text-blue-800 hover:underline"
                    >
                      {row.ticker}
                    </Link>
                    {row.is_lq45 && <Badge variant="amber" size="xs">LQ45</Badge>}
                    {row.is_idx30 && <Badge variant="purple" size="xs">IDX30</Badge>}
                  </div>
                </td>
                {activeCols.map((col) => (
                  <td key={col.key} className={`px-4 py-3 ${col.align === 'right' ? 'text-right' : ''}`}>
                    {col.render(row)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className="px-4 py-3 border-t border-gray-200 flex items-center justify-between text-sm text-gray-500">
          <span>Page {page} of {totalPages} ({fmtNumID(total)} stocks)</span>
          <div className="flex items-center gap-1.5">
            {page > 1 && (
              <Link
                href={`/?${new URLSearchParams({ ...paginationParams, page: String(page - 1) })}`}
                className="px-3 py-1.5 rounded-lg border border-gray-300 hover:bg-gray-50 transition-colors"
              >
                ← Prev
              </Link>
            )}

            {pageStart > 1 && (
              <>
                <Link
                  href={`/?${new URLSearchParams({ ...paginationParams, page: '1' })}`}
                  className="px-3 py-1.5 rounded-lg border border-gray-300 hover:bg-gray-50 transition-colors"
                >
                  1
                </Link>
                {pageStart > 2 && <span className="px-1 text-gray-400">…</span>}
              </>
            )}

            {pageNumbers.map((p) => (
              <Link
                key={p}
                href={`/?${new URLSearchParams({ ...paginationParams, page: String(p) })}`}
                className={`px-3 py-1.5 rounded-lg border transition-colors ${
                  p === page
                    ? 'border-blue-600 bg-blue-600 text-white'
                    : 'border-gray-300 hover:bg-gray-50'
                }`}
              >
                {p}
              </Link>
            ))}

            {pageEnd < totalPages && (
              <>
                {pageEnd < totalPages - 1 && <span className="px-1 text-gray-400">…</span>}
                <Link
                  href={`/?${new URLSearchParams({ ...paginationParams, page: String(totalPages) })}`}
                  className="px-3 py-1.5 rounded-lg border border-gray-300 hover:bg-gray-50 transition-colors"
                >
                  {totalPages}
                </Link>
              </>
            )}

            {page < totalPages && (
              <Link
                href={`/?${new URLSearchParams({ ...paginationParams, page: String(page + 1) })}`}
                className="px-3 py-1.5 rounded-lg border border-gray-300 hover:bg-gray-50 transition-colors"
              >
                Next →
              </Link>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
