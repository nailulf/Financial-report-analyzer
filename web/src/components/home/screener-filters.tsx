'use client'

import { useState, useTransition } from 'react'
import { useRouter, usePathname, useSearchParams } from 'next/navigation'

const BOARDS = ['Main', 'Development', 'Acceleration'] as const

interface FilterState {
  minRoe: string
  maxPe: string
  maxPbv: string
  minNetMargin: string
  minDivYield: string
  board: string
}

function readFilters(params: URLSearchParams): FilterState {
  return {
    minRoe: params.get('minRoe') ?? '',
    maxPe: params.get('maxPe') ?? '',
    maxPbv: params.get('maxPbv') ?? '',
    minNetMargin: params.get('minNetMargin') ?? '',
    minDivYield: params.get('minDivYield') ?? '',
    board: params.get('board') ?? '',
  }
}

function hasActiveFilters(f: FilterState) {
  return Object.values(f).some(Boolean)
}

export function ScreenerFilters() {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [open, setOpen] = useState(() => hasActiveFilters(readFilters(searchParams)))
  const [filters, setFilters] = useState<FilterState>(() => readFilters(searchParams))
  const [, startTransition] = useTransition()

  function applyFilters() {
    const params = new URLSearchParams(searchParams.toString())
    const fields: (keyof FilterState)[] = ['minRoe', 'maxPe', 'maxPbv', 'minNetMargin', 'minDivYield', 'board']
    for (const key of fields) {
      if (filters[key]) params.set(key, filters[key])
      else params.delete(key)
    }
    params.delete('page')
    startTransition(() => router.push(`${pathname}?${params.toString()}`))
  }

  function clearFilters() {
    const params = new URLSearchParams(searchParams.toString())
    for (const key of ['minRoe', 'maxPe', 'maxPbv', 'minNetMargin', 'minDivYield', 'board']) {
      params.delete(key)
    }
    params.delete('page')
    setFilters({ minRoe: '', maxPe: '', maxPbv: '', minNetMargin: '', minDivYield: '', board: '' })
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
        <div className="mt-3 p-4 bg-white border border-gray-200 rounded-xl shadow-sm">
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            <div>
              <label className="block text-xs text-gray-500 mb-1">ROE ≥ (%)</label>
              <input
                type="number"
                placeholder="e.g. 15"
                value={filters.minRoe}
                onChange={(e) => setFilters((f) => ({ ...f, minRoe: e.target.value }))}
                className="w-full px-2 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-400"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">P/E ≤</label>
              <input
                type="number"
                placeholder="e.g. 20"
                value={filters.maxPe}
                onChange={(e) => setFilters((f) => ({ ...f, maxPe: e.target.value }))}
                className="w-full px-2 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-400"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">P/BV ≤</label>
              <input
                type="number"
                placeholder="e.g. 3"
                value={filters.maxPbv}
                onChange={(e) => setFilters((f) => ({ ...f, maxPbv: e.target.value }))}
                className="w-full px-2 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-400"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Net Margin ≥ (%)</label>
              <input
                type="number"
                placeholder="e.g. 10"
                value={filters.minNetMargin}
                onChange={(e) => setFilters((f) => ({ ...f, minNetMargin: e.target.value }))}
                className="w-full px-2 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-400"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Div Yield ≥ (%)</label>
              <input
                type="number"
                placeholder="e.g. 3"
                value={filters.minDivYield}
                onChange={(e) => setFilters((f) => ({ ...f, minDivYield: e.target.value }))}
                className="w-full px-2 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-400"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Board</label>
              <select
                value={filters.board}
                onChange={(e) => setFilters((f) => ({ ...f, board: e.target.value }))}
                className="w-full px-2 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-400 bg-white"
              >
                <option value="">Any</option>
                {BOARDS.map((b) => <option key={b} value={b}>{b}</option>)}
              </select>
            </div>
          </div>

          <div className="flex gap-2 mt-3">
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
