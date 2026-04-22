'use client'

import { useState, useTransition, useEffect, useRef, useCallback } from 'react'
import { useRouter, usePathname, useSearchParams } from 'next/navigation'

const BOARDS = ['Main', 'Development', 'Acceleration'] as const

const PHASES = [
  { value: 'uptrend',          label: 'Uptrend' },
  { value: 'downtrend',        label: 'Downtrend' },
  { value: 'sideways_bullish', label: 'Sideways ↑' },
  { value: 'sideways_bearish', label: 'Sideways ↓' },
] as const

// All filter keys that map to URL params
const MACD_CROSS_OPTIONS = [
  { value: 'golden_cross', label: 'Golden Cross' },
  { value: 'death_cross',  label: 'Death Cross' },
] as const

const SECTORS = [
  { value: 'Financials',                label: 'Financials' },
  { value: 'Energy',                    label: 'Energy' },
  { value: 'Basic Materials',           label: 'Basic Materials' },
  { value: 'Barang Konsumen Primer',    label: 'Consumer Staples' },
  { value: 'Barang Konsumen Non-Primer', label: 'Consumer Discretionary' },
  { value: 'Industrials',              label: 'Industrials' },
  { value: 'Property & Real Estate',   label: 'Property & Real Estate' },
  { value: 'Technology',               label: 'Technology' },
  { value: 'Infrastructure',           label: 'Infrastructure' },
  { value: 'Transportation & Logistics', label: 'Transportation & Logistics' },
  { value: 'Healthcare',               label: 'Healthcare' },
] as const

const FILTER_KEYS = [
  'minRoe', 'maxPe', 'maxPbv', 'minNetMargin', 'minDivYield',
  'minDivAvg3yr', 'minDivAvg5yr',
  'minRevCagr3yr', 'minRevCagr5yr', 'minPriceCagr3yr', 'minPriceCagr5yr', 'minOcfCagr3yr', 'minOcfCagr5yr',
  'minMktCap', 'minCompleteness', 'minConfidence',
  'maxPhaseDays',
  'sector', 'board', 'phase',
  'minRsi', 'maxRsi', 'macdCross', 'maxMacdCrossDays', 'minVolChangePct', 'minVolAvg',
] as const

type FilterKey = typeof FILTER_KEYS[number]
type FilterState = Record<FilterKey, string>

const EMPTY_FILTERS: FilterState = Object.fromEntries(FILTER_KEYS.map((k) => [k, ''])) as FilterState

function readFilters(params: URLSearchParams): FilterState {
  const f = { ...EMPTY_FILTERS }
  for (const key of FILTER_KEYS) f[key] = params.get(key) ?? ''
  return f
}

function hasActiveFilters(f: FilterState) {
  return Object.values(f).some(Boolean)
}

// Shared input class
const inputCls = 'w-full px-2 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-400'
const selectCls = `${inputCls} bg-white`

function NumInput({ label, placeholder, value, onChange }: {
  label: string; placeholder: string; value: string; onChange: (v: string) => void
}) {
  return (
    <div>
      <label className="block text-xs text-gray-500 mb-1">{label}</label>
      <input type="number" placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} className={inputCls} />
    </div>
  )
}

function MultiSelect({ label, options, value, onChange }: {
  label: string
  options: readonly { value: string; label: string }[]
  value: string   // comma-separated
  onChange: (v: string) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const selected = new Set(value ? value.split(',') : [])

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    if (open) document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [open])

  function toggle(v: string) {
    const next = new Set(selected)
    if (next.has(v)) next.delete(v)
    else next.add(v)
    onChange([...next].join(','))
  }

  const display = selected.size === 0
    ? 'Any'
    : options.filter((o) => selected.has(o.value)).map((o) => o.label).join(', ')

  return (
    <div ref={ref} className="relative">
      <label className="block text-xs text-gray-500 mb-1">{label}</label>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`${inputCls} bg-white text-left truncate flex items-center justify-between gap-1`}
      >
        <span className="truncate">{display}</span>
        <svg className="w-3 h-3 shrink-0 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && (
        <div className="absolute left-0 top-full mt-1 z-20 w-48 bg-white border border-gray-200 rounded-lg shadow-lg p-1">
          {options.map((o) => (
            <label key={o.value} className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-gray-50 cursor-pointer text-sm text-gray-700">
              <input
                type="checkbox"
                checked={selected.has(o.value)}
                onChange={() => toggle(o.value)}
                className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
              />
              {o.label}
            </label>
          ))}
        </div>
      )}
    </div>
  )
}

export function ScreenerFilters() {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  // Start closed on SSR; open after mount if URL has active filters (avoids hydration mismatch)
  const [open, setOpen] = useState(false)
  const [filters, setFilters] = useState<FilterState>(EMPTY_FILTERS)
  const [, startTransition] = useTransition()

  useEffect(() => {
    const fromUrl = readFilters(searchParams)
    setFilters(fromUrl)
    if (hasActiveFilters(fromUrl)) setOpen(true)
  }, [searchParams])

  // Strategy save state
  const [savingStrategy, setSavingStrategy] = useState(false)
  const [strategyName, setStrategyName] = useState('')
  const strategyInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (savingStrategy) strategyInputRef.current?.focus()
  }, [savingStrategy])

  const saveStrategy = useCallback(async () => {
    const name = strategyName.trim()
    if (!name) return
    // Collect active filters from URL
    const filterObj: Record<string, string> = {}
    for (const key of FILTER_KEYS) {
      const v = searchParams.get(key)
      if (v) filterObj[key] = v
    }

    try {
      const res = await fetch('/api/strategies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, filters: filterObj }),
      })
      if (res.ok) {
        setSavingStrategy(false)
        setStrategyName('')
        // Notify strategy bar to refresh
        window.dispatchEvent(new Event('strategy-change'))
      }
    } catch {
      // silent
    }
  }, [strategyName, searchParams])

  const set = (key: FilterKey) => (v: string) => setFilters((f) => ({ ...f, [key]: v }))

  function applyFilters() {
    const params = new URLSearchParams(searchParams.toString())
    for (const key of FILTER_KEYS) {
      if (filters[key]) params.set(key, filters[key])
      else params.delete(key)
    }
    params.delete('page')
    startTransition(() => router.push(`${pathname}?${params.toString()}`))
  }

  function clearFilters() {
    const params = new URLSearchParams(searchParams.toString())
    for (const key of FILTER_KEYS) params.delete(key)
    params.delete('page')
    setFilters({ ...EMPTY_FILTERS })
    startTransition(() => router.push(`${pathname}?${params.toString()}`))
  }

  const active = hasActiveFilters(filters)

  return (
    <div className="mb-4">
      <button
        onClick={() => setOpen((v) => !v)}
        className={`flex items-center gap-2 text-xs font-medium px-3 py-1.5 rounded-lg border transition-colors ${
          active
            ? 'bg-blue-50 border-blue-200 text-blue-700'
            : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50'
        }`}
      >
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4h18M7 8h10M11 12h2" />
        </svg>
        Filters
        {active && <span className="ml-1 px-1.5 py-0.5 bg-blue-600 text-white text-xs rounded-full leading-none">ON</span>}
      </button>

      {open && (
        <div className="mt-3 p-4 bg-white border border-gray-200 rounded-xl shadow-sm space-y-4">
          {/* Row 1: Fundamentals + Dropdowns */}
          <div>
            <div className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-2">Fundamentals & Classification</div>
            <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-3">
              <NumInput label="ROE ≥ (%)" placeholder="15" value={filters.minRoe} onChange={set('minRoe')} />
              <NumInput label="P/E ≤" placeholder="20" value={filters.maxPe} onChange={set('maxPe')} />
              <NumInput label="P/BV ≤" placeholder="3" value={filters.maxPbv} onChange={set('maxPbv')} />
              <NumInput label="Net Margin ≥ (%)" placeholder="10" value={filters.minNetMargin} onChange={set('minNetMargin')} />
              <NumInput label="Mkt Cap ≥ (T)" placeholder="1" value={filters.minMktCap} onChange={set('minMktCap')} />
              <div>
                <label className="block text-xs text-gray-500 mb-1">Sector</label>
                <select value={filters.sector} onChange={(e) => set('sector')(e.target.value)} className={selectCls}>
                  <option value="">All</option>
                  {SECTORS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Board</label>
                <select value={filters.board} onChange={(e) => set('board')(e.target.value)} className={selectCls}>
                  <option value="">Any</option>
                  {BOARDS.map((b) => <option key={b} value={b}>{b}</option>)}
                </select>
              </div>
            </div>
          </div>

          {/* Row 2: Dividends */}
          <div>
            <div className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-2">Dividends</div>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
              <NumInput label="Div Yield ≥ (%)" placeholder="3" value={filters.minDivYield} onChange={set('minDivYield')} />
              <NumInput label="Div Avg 3Y ≥ (%)" placeholder="3" value={filters.minDivAvg3yr} onChange={set('minDivAvg3yr')} />
              <NumInput label="Div Avg 5Y ≥ (%)" placeholder="3" value={filters.minDivAvg5yr} onChange={set('minDivAvg5yr')} />
            </div>
          </div>

          {/* Row 3: Growth */}
          <div>
            <div className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-2">Growth (CAGR)</div>
            <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-3">
              <NumInput label="Rev CAGR 3Y ≥ (%)" placeholder="10" value={filters.minRevCagr3yr} onChange={set('minRevCagr3yr')} />
              <NumInput label="Rev CAGR 5Y ≥ (%)" placeholder="10" value={filters.minRevCagr5yr} onChange={set('minRevCagr5yr')} />
              <NumInput label="Price CAGR 3Y ≥ (%)" placeholder="5" value={filters.minPriceCagr3yr} onChange={set('minPriceCagr3yr')} />
              <NumInput label="Price CAGR 5Y ≥ (%)" placeholder="5" value={filters.minPriceCagr5yr} onChange={set('minPriceCagr5yr')} />
              <NumInput label="OCF CAGR 3Y ≥ (%)" placeholder="10" value={filters.minOcfCagr3yr} onChange={set('minOcfCagr3yr')} />
              <NumInput label="OCF CAGR 5Y ≥ (%)" placeholder="10" value={filters.minOcfCagr5yr} onChange={set('minOcfCagr5yr')} />
            </div>
          </div>

          {/* Row 4: Technical Signals */}
          <div>
            <div className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-2">Technical Signals</div>
            <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-3">
              <MultiSelect label="Phase" options={PHASES} value={filters.phase} onChange={set('phase')} />
              <NumInput label="Phase Days ≤" placeholder="20" value={filters.maxPhaseDays} onChange={set('maxPhaseDays')} />
              <NumInput label="RSI ≥" placeholder="35" value={filters.minRsi} onChange={set('minRsi')} />
              <NumInput label="RSI ≤" placeholder="60" value={filters.maxRsi} onChange={set('maxRsi')} />
              <div>
                <label className="block text-xs text-gray-500 mb-1">MACD Cross</label>
                <select value={filters.macdCross} onChange={(e) => set('macdCross')(e.target.value)} className={selectCls}>
                  <option value="">Any</option>
                  {MACD_CROSS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </div>
              <NumInput label="Cross ≤ N days" placeholder="5" value={filters.maxMacdCrossDays} onChange={set('maxMacdCrossDays')} />
              <NumInput label="Vol Change ≥ (%)" placeholder="150" value={filters.minVolChangePct} onChange={set('minVolChangePct')} />
              <NumInput label="Avg Vol ≥ (Jt)" placeholder="1" value={filters.minVolAvg} onChange={set('minVolAvg')} />
            </div>
          </div>

          <div className="flex gap-2 items-center">
            <button
              onClick={applyFilters}
              className="px-4 py-1.5 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 transition-colors"
            >
              Apply
            </button>
            {active && (
              <button
                onClick={clearFilters}
                className="px-4 py-1.5 bg-white text-gray-600 text-sm rounded-lg border border-gray-200 hover:bg-gray-50 transition-colors"
              >
                Clear filters
              </button>
            )}
            {active && (
              <>
                <span className="w-px h-5 bg-gray-200" />
                {savingStrategy ? (
                  <div className="flex items-center gap-1.5">
                    <input
                      ref={strategyInputRef}
                      type="text"
                      value={strategyName}
                      onChange={(e) => setStrategyName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') saveStrategy()
                        if (e.key === 'Escape') { setSavingStrategy(false); setStrategyName('') }
                      }}
                      placeholder="Strategy name..."
                      className="px-2 py-1 text-xs border border-indigo-300 rounded-lg outline-none focus:ring-1 focus:ring-indigo-400 w-36"
                    />
                    <button
                      onClick={saveStrategy}
                      className="px-2 py-1 text-xs font-medium text-white bg-indigo-500 hover:bg-indigo-600 rounded-lg transition-colors"
                    >
                      Save
                    </button>
                    <button
                      onClick={() => { setSavingStrategy(false); setStrategyName('') }}
                      className="text-xs text-gray-400 hover:text-gray-600"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => setSavingStrategy(true)}
                    className="px-3 py-1.5 text-sm text-indigo-600 border border-indigo-200 rounded-lg hover:bg-indigo-50 transition-colors"
                  >
                    Save as Strategy
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
