'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'

const KEY = 'idx_watchlist'

function getWatchlist(): string[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '[]')
  } catch {
    return []
  }
}

export function WatchlistBar() {
  const [tickers, setTickers] = useState<string[]>([])

  useEffect(() => {
    setTickers(getWatchlist())
    const handler = () => setTickers(getWatchlist())
    window.addEventListener('watchlist-change', handler)
    return () => window.removeEventListener('watchlist-change', handler)
  }, [])

  if (tickers.length === 0) return null

  return (
    <div className="mb-5 p-3 bg-amber-50 border border-amber-100 rounded-xl">
      <div className="flex items-center gap-3 flex-wrap">
        <span className="text-xs font-semibold text-amber-700 shrink-0">★ Watchlist</span>
        <div className="flex gap-2 flex-wrap">
          {tickers.map((t) => (
            <Link
              key={t}
              href={`/stock/${t}`}
              className="px-2.5 py-1 bg-white border border-amber-200 rounded-lg text-xs font-mono font-medium text-amber-800 hover:bg-amber-100 transition-colors"
            >
              {t}
            </Link>
          ))}
        </div>
      </div>
    </div>
  )
}
