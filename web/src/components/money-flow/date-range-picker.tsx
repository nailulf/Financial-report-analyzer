'use client'

import { useRouter, usePathname } from 'next/navigation'
import { useState } from 'react'

const PRESETS = [
  { label: '5D',  days: 5 },
  { label: '1W',  days: 7 },
  { label: '1M',  days: 30 },
  { label: '3M',  days: 90 },
  { label: '6M',  days: 180 },
] as const

function toISODate(d: Date): string {
  return d.toISOString().split('T')[0]
}

function subtractDays(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() - days)
  return toISODate(d)
}

function todayStr(): string {
  return toISODate(new Date())
}

function formatDisplay(from: string, to: string): string {
  const f = new Date(from + 'T00:00:00')
  const t = new Date(to + 'T00:00:00')
  const fmt = (d: Date) => d.toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: '2-digit' })
  return `${fmt(f)} – ${fmt(t)}`
}

interface Props {
  from: string
  to: string
  ticker?: string
  /** URL param name for the start date. Defaults to 'from'. */
  fromParam?: string
  /** URL param name for the end date. Defaults to 'to'. */
  toParam?: string
  /** Extra URL params to preserve on navigation (in addition to ticker). */
  preserveParams?: string[]
}

export function DateRangePicker({
  from,
  to,
  ticker,
  fromParam = 'from',
  toParam = 'to',
  preserveParams = [],
}: Props) {
  const router = useRouter()
  const pathname = usePathname()
  const [showCustom, setShowCustom] = useState(false)
  const [customFrom, setCustomFrom] = useState(from)
  const [customTo, setCustomTo] = useState(to)

  const activePreset = PRESETS.find(
    (p) => from === subtractDays(p.days) && to === todayStr()
  )?.days

  const navigate = (newFrom: string, newTo: string) => {
    // Read current search params from window to preserve all other params
    const current = typeof window !== 'undefined'
      ? new URLSearchParams(window.location.search)
      : new URLSearchParams()
    current.set(fromParam, newFrom)
    current.set(toParam, newTo)
    if (ticker) current.set('ticker', ticker)
    router.push(`${pathname}?${current.toString()}`)
  }

  const applyPreset = (days: number) => {
    navigate(subtractDays(days), todayStr())
    setShowCustom(false)
  }

  const applyCustom = () => {
    if (customFrom && customTo && customFrom <= customTo) {
      navigate(customFrom, customTo)
      setShowCustom(false)
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-1.5 flex-wrap">
        {PRESETS.map((p) => (
          <button
            key={p.days}
            onClick={() => applyPreset(p.days)}
            className={`px-3 py-1 text-xs rounded-lg font-medium transition-colors ${
              activePreset === p.days
                ? 'bg-blue-600 text-white'
                : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}
          >
            {p.label}
          </button>
        ))}
        <button
          onClick={() => setShowCustom(!showCustom)}
          className={`px-3 py-1 text-xs rounded-lg font-medium transition-colors ${
            showCustom || (!activePreset)
              ? 'bg-gray-200 text-gray-700'
              : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
          }`}
        >
          Custom
        </button>
      </div>

      {showCustom ? (
        <div className="flex items-center gap-2 flex-wrap">
          <input
            type="date"
            value={customFrom}
            max={customTo}
            onChange={(e) => setCustomFrom(e.target.value)}
            className="text-xs border border-gray-200 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-400"
          />
          <span className="text-xs text-gray-400">→</span>
          <input
            type="date"
            value={customTo}
            min={customFrom}
            max={todayStr()}
            onChange={(e) => setCustomTo(e.target.value)}
            className="text-xs border border-gray-200 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-400"
          />
          <button
            onClick={applyCustom}
            disabled={!customFrom || !customTo || customFrom > customTo}
            className="px-3 py-1.5 text-xs bg-blue-600 text-white rounded-lg font-medium disabled:opacity-40 hover:bg-blue-700 transition-colors"
          >
            Apply
          </button>
        </div>
      ) : (
        <p className="text-xs text-gray-400">
          {formatDisplay(from, to)}
        </p>
      )}
    </div>
  )
}
