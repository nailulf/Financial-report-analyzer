'use client'

import { useState, useTransition, useEffect } from 'react'
import { useRouter, usePathname, useSearchParams } from 'next/navigation'

const BOARDS = ['Main', 'Development', 'Acceleration'] as const

const PHASES = [
  { value: 'uptrend',          label: 'Uptrend' },
  { value: 'downtrend',        label: 'Downtrend' },
  { value: 'sideways_bullish', label: 'Sideways ↑' },
  { value: 'sideways_bearish', label: 'Sideways ↓' },
] as const

// All filter keys that map to URL params
const FILTER_KEYS = [
  'minRoe', 'maxPe', 'maxPbv', 'minNetMargin', 'minDivYield',
  'minDivAvg3yr', 'minDivAvg5yr',
  'minRevCagr3yr', 'minRevCagr5yr', 'minPriceCagr3yr', 'minPriceCagr5yr',
  'minMktCap', 'minCompleteness', 'minConfidence',
  'board', 'phase',
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

export function ScreenerFilters() {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [open, setOpen] = useState(() => hasActiveFilters(readFilters(searchParams)))
  const [filters, setFilters] = useState<FilterState>(() => readFilters(searchParams))
  const [, startTransition] = useTransition()

  useEffect(() => {
    const fromUrl = readFilters(searchParams)
    setFilters(fromUrl)
    if (hasActiveFilters(fromUrl)) setOpen(true)
  }, [searchParams])

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

  const active = hasActiveFilters(readFilters(searchParams))

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
            <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
              <NumInput label="ROE ≥ (%)" placeholder="15" value={filters.minRoe} onChange={set('minRoe')} />
              <NumInput label="P/E ≤" placeholder="20" value={filters.maxPe} onChange={set('maxPe')} />
              <NumInput label="P/BV ≤" placeholder="3" value={filters.maxPbv} onChange={set('maxPbv')} />
              <NumInput label="Net Margin ≥ (%)" placeholder="10" value={filters.minNetMargin} onChange={set('minNetMargin')} />
              <NumInput label="Mkt Cap ≥ (T)" placeholder="1" value={filters.minMktCap} onChange={set('minMktCap')} />
              <div>
                <label className="block text-xs text-gray-500 mb-1">Board</label>
                <select value={filters.board} onChange={(e) => set('board')(e.target.value)} className={selectCls}>
                  <option value="">Any</option>
                  {BOARDS.map((b) => <option key={b} value={b}>{b}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Phase</label>
                <select value={filters.phase} onChange={(e) => set('phase')(e.target.value)} className={selectCls}>
                  <option value="">Any</option>
                  {PHASES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
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
            </div>
          </div>

          {/* Row 4: Data Quality */}
          <div>
            <div className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-2">Data Quality</div>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
              <NumInput label="Completeness ≥" placeholder="80" value={filters.minCompleteness} onChange={set('minCompleteness')} />
              <NumInput label="Confidence ≥" placeholder="70" value={filters.minConfidence} onChange={set('minConfidence')} />
            </div>
          </div>

          <div className="flex gap-2">
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
          </div>
        </div>
      )}
    </div>
  )
}
