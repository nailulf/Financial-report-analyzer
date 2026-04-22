'use client'

import { useState, useEffect, useRef } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import type { Strategy } from '@/lib/types/database'

// ---------------------------------------------------------------------------
// StrategyBar — list saved strategies, click to apply filters to screener
// ---------------------------------------------------------------------------

interface StrategyWithCount extends Strategy {
  matchCount?: number
}

export function StrategyBar() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [mounted, setMounted] = useState(false)
  const [strategies, setStrategies] = useState<StrategyWithCount[]>([])
  const [loading, setLoading] = useState(true)

  // Inline editing
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const editInputRef = useRef<HTMLInputElement>(null)

  // Creating new
  const [creatingNew, setCreatingNew] = useState(false)
  const [newName, setNewName] = useState('')
  const newInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    setMounted(true)
    fetchStrategies()
    const handler = () => fetchStrategies()
    window.addEventListener('strategy-change', handler)
    return () => window.removeEventListener('strategy-change', handler)
  }, [])

  useEffect(() => {
    if (editingId) editInputRef.current?.focus()
  }, [editingId])

  useEffect(() => {
    if (creatingNew) newInputRef.current?.focus()
  }, [creatingNew])

  async function fetchStrategies() {
    try {
      const res = await fetch('/api/strategies')
      if (!res.ok) return
      const data: Strategy[] = await res.json()
      setStrategies(data)
      // Fetch match counts in background
      fetchMatchCounts(data)
    } catch {
      // silent
    } finally {
      setLoading(false)
    }
  }

  async function fetchMatchCounts(strats: Strategy[]) {
    const updated = await Promise.all(
      strats.map(async (s) => {
        const filters = s.filters as Record<string, string>
        const params = new URLSearchParams()
        for (const [k, v] of Object.entries(filters)) {
          if (v != null && v !== '') params.set(k, String(v))
        }
        try {
          // Reuse the screener page with head-only count via a lightweight fetch
          const res = await fetch(`/api/strategies/${s.id}/count`)
          if (res.ok) {
            const { count } = await res.json()
            return { ...s, matchCount: count as number }
          }
        } catch {
          // silent
        }
        return s
      })
    )
    setStrategies(updated)
  }

  // Detect which strategy is currently active based on URL params
  function getActiveStrategyId(): string | null {
    const fromParam = searchParams.get('strategy')
    if (fromParam) return fromParam
    return null
  }

  function applyStrategy(s: Strategy) {
    const filters = s.filters as Record<string, string>
    const params = new URLSearchParams()
    for (const [k, v] of Object.entries(filters)) {
      if (v != null && v !== '') params.set(k, String(v))
    }
    params.set('strategy', s.id)
    router.push(`/?${params.toString()}`)
  }

  async function handleCreate() {
    const name = newName.trim()
    if (!name) return
    // Gather current screener filters from URL
    const filters: Record<string, string> = {}
    searchParams.forEach((v, k) => {
      if (k !== 'page' && k !== 'sort' && k !== 'dir' && k !== 'strategy') {
        filters[k] = v
      }
    })
    try {
      const res = await fetch('/api/strategies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, filters }),
      })
      if (res.ok) {
        setNewName('')
        setCreatingNew(false)
        fetchStrategies()
      }
    } catch {
      // silent
    }
  }

  async function handleRename(id: string) {
    const name = editName.trim()
    if (!name) {
      setEditingId(null)
      return
    }
    try {
      await fetch(`/api/strategies/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      })
      setEditingId(null)
      setEditName('')
      fetchStrategies()
    } catch {
      // silent
    }
  }

  async function handleDelete(id: string) {
    try {
      await fetch(`/api/strategies/${id}`, { method: 'DELETE' })
      fetchStrategies()
      // If the deleted strategy was active, clear filters
      if (getActiveStrategyId() === id) {
        router.push('/')
      }
    } catch {
      // silent
    }
  }

  function clearActiveStrategy() {
    router.push('/')
  }

  if (!mounted) return null

  const activeId = getActiveStrategyId()

  if (loading) {
    return (
      <div className="mb-5 p-3 bg-gray-50 border border-gray-200 rounded-xl animate-pulse">
        <div className="h-4 w-32 bg-gray-200 rounded" />
      </div>
    )
  }

  // Describe filters for display
  function describeFilters(filters: Record<string, unknown>): string {
    const parts: string[] = []
    const labels: Record<string, string> = {
      sector: 'Sector', board: 'Board', phase: 'Phase',
      minRoe: 'ROE>=', maxPe: 'PE<=', maxPbv: 'PBV<=',
      minNetMargin: 'Margin>=', minDivYield: 'Yield>=',
      minMktCap: 'Cap>=', macdCross: 'MACD',
      minRsi: 'RSI>=', maxRsi: 'RSI<=',
    }
    for (const [k, v] of Object.entries(filters)) {
      if (v == null || v === '') continue
      const label = labels[k]
      if (label) {
        parts.push(`${label}${v}`)
      }
    }
    if (parts.length === 0) return 'No filters'
    if (parts.length > 4) return parts.slice(0, 4).join(', ') + ` +${parts.length - 4}`
    return parts.join(', ')
  }

  return (
    <div className="mb-5">
      {/* Header */}
      <div className="flex items-center gap-2 mb-2">
        <svg className="w-4 h-4 text-indigo-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" />
        </svg>
        <span className="text-sm font-semibold text-gray-700">Strategies</span>

        {/* Create button */}
        {creatingNew ? (
          <div className="flex items-center gap-1.5">
            <input
              ref={newInputRef}
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCreate()
                if (e.key === 'Escape') { setCreatingNew(false); setNewName('') }
              }}
              placeholder="Strategy name..."
              className="px-2 py-1 text-xs border border-indigo-300 rounded-lg outline-none focus:ring-1 focus:ring-indigo-400 w-36"
            />
            <button
              onClick={handleCreate}
              className="px-2 py-1 text-xs font-medium text-white bg-indigo-500 hover:bg-indigo-600 rounded-lg transition-colors"
            >
              Save
            </button>
            <button
              onClick={() => { setCreatingNew(false); setNewName('') }}
              className="px-1.5 py-1 text-xs text-gray-400 hover:text-gray-600 transition-colors"
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            onClick={() => setCreatingNew(true)}
            className="px-2 py-1 text-xs font-medium text-indigo-600 hover:bg-indigo-50 rounded-lg transition-colors"
          >
            + Save current filters
          </button>
        )}

        {/* Clear active strategy */}
        {activeId && (
          <button
            onClick={clearActiveStrategy}
            className="ml-auto px-2 py-1 text-xs text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
          >
            Clear
          </button>
        )}
      </div>

      {/* Strategy chips */}
      {strategies.length > 0 && (
        <div className="flex gap-2 flex-wrap">
          {strategies.map((s) => {
            const isActive = s.id === activeId
            return (
              <div
                key={s.id}
                className={`group relative inline-flex items-center gap-1.5 pl-3 pr-1.5 py-1.5 rounded-lg border text-xs transition-colors cursor-pointer ${
                  isActive
                    ? 'bg-indigo-50 border-indigo-300 text-indigo-800'
                    : 'bg-white border-gray-200 text-gray-700 hover:border-indigo-200 hover:bg-indigo-50/50'
                }`}
              >
                {editingId === s.id ? (
                  <input
                    ref={editInputRef}
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleRename(s.id)
                      if (e.key === 'Escape') setEditingId(null)
                    }}
                    onBlur={() => handleRename(s.id)}
                    onClick={(e) => e.stopPropagation()}
                    className="px-1 py-0 border border-indigo-300 rounded text-xs outline-none focus:ring-1 focus:ring-indigo-400 w-24"
                  />
                ) : (
                  <>
                    <button
                      onClick={() => applyStrategy(s)}
                      className="font-medium"
                    >
                      {s.name}
                    </button>
                    {s.matchCount != null && (
                      <span className={`px-1.5 py-0.5 rounded-full text-[10px] font-semibold leading-none ${
                        isActive ? 'bg-indigo-200 text-indigo-700' : 'bg-gray-100 text-gray-500'
                      }`}>
                        {s.matchCount}
                      </span>
                    )}
                    {/* Hover actions */}
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        setEditingId(s.id)
                        setEditName(s.name)
                      }}
                      className="opacity-0 group-hover:opacity-100 p-0.5 text-gray-400 hover:text-gray-600 transition-opacity"
                      aria-label="Rename"
                    >
                      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                      </svg>
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        handleDelete(s.id)
                      }}
                      className="opacity-0 group-hover:opacity-100 p-0.5 text-gray-400 hover:text-red-500 transition-opacity"
                      aria-label="Delete"
                    >
                      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                      </svg>
                    </button>
                  </>
                )}
              </div>
            )
          })}
        </div>
      )}

      {strategies.length === 0 && !creatingNew && (
        <p className="text-xs text-gray-400">
          Set filters on the screener below, then save them as a strategy.
        </p>
      )}
    </div>
  )
}
