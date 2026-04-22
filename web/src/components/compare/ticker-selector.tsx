'use client'

import { useRouter, usePathname, useSearchParams } from 'next/navigation'
import { useState } from 'react'
import type { SearchResult } from '@/lib/types/api'
import { track } from '@/lib/analytics'

export function TickerSelector({ selected }: { selected: string[] }) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [open, setOpen] = useState(false)

  async function search(q: string) {
    setQuery(q)
    if (q.length < 1) { setResults([]); return }
    const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`)
    const data = await res.json()
    setResults(data)
    setOpen(true)
  }

  function add(ticker: string) {
    if (selected.includes(ticker) || selected.length >= 5) return
    const next = [...selected, ticker]
    setQuery('')
    setOpen(false)
    track.compareTickerAdded(ticker, next.length)
    const params = new URLSearchParams(searchParams.toString())
    params.set('tickers', next.join(','))
    router.push(`${pathname}?${params.toString()}`)
  }

  function remove(ticker: string) {
    const next = selected.filter((t) => t !== ticker)
    const params = new URLSearchParams(searchParams.toString())
    if (next.length) params.set('tickers', next.join(','))
    else params.delete('tickers')
    router.push(`${pathname}?${params.toString()}`)
  }

  return (
    <div className="mb-8">
      <div className="flex flex-wrap gap-2 mb-3">
        {selected.map((ticker) => (
          <span key={ticker} className="inline-flex items-center gap-1.5 bg-blue-50 text-blue-700 border border-blue-200 rounded-full px-3 py-1 text-sm font-mono font-bold">
            {ticker}
            <button onClick={() => remove(ticker)} className="text-blue-400 hover:text-blue-700 ml-1">×</button>
          </span>
        ))}
        {selected.length < 5 && (
          <div className="relative">
            <input
              type="text"
              value={query}
              onChange={(e) => search(e.target.value)}
              onBlur={() => setTimeout(() => setOpen(false), 150)}
              placeholder="Add ticker…"
              className="rounded-full border border-gray-300 px-3 py-1 text-sm w-36 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            {open && results.length > 0 && (
              <ul className="absolute z-50 top-full mt-1 left-0 w-64 bg-white border border-gray-200 rounded-lg shadow-lg overflow-hidden">
                {results.map((r) => (
                  <li key={r.ticker}>
                    <button
                      className="w-full text-left px-4 py-2 hover:bg-gray-50 flex items-center gap-2 text-sm"
                      onMouseDown={() => add(r.ticker)}
                      disabled={selected.includes(r.ticker)}
                    >
                      <span className="font-mono font-bold text-blue-600 w-14">{r.ticker}</span>
                      <span className="text-gray-600 truncate">{r.name}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
      {selected.length === 0 && (
        <p className="text-sm text-gray-400">Add 2–5 stocks to compare. Try: BBRI, BMRI, BBCA</p>
      )}
    </div>
  )
}
