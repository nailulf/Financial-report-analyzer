'use client'

import { useState, useEffect } from 'react'

const KEY = 'idx_watchlist'

function getWatchlist(): string[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '[]')
  } catch {
    return []
  }
}

function saveWatchlist(list: string[]) {
  localStorage.setItem(KEY, JSON.stringify(list))
  window.dispatchEvent(new Event('watchlist-change'))
}

export function WatchlistStar({ ticker }: { ticker: string }) {
  const [starred, setStarred] = useState(false)

  useEffect(() => {
    setStarred(getWatchlist().includes(ticker))
  }, [ticker])

  function toggle(e: React.MouseEvent) {
    e.preventDefault()
    e.stopPropagation()
    const list = getWatchlist()
    const next = list.includes(ticker)
      ? list.filter((t) => t !== ticker)
      : [...list, ticker]
    saveWatchlist(next)
    setStarred(next.includes(ticker))
  }

  return (
    <button
      onClick={toggle}
      aria-label={starred ? 'Remove from watchlist' : 'Add to watchlist'}
      className={`text-base leading-none transition-colors ${starred ? 'text-amber-400 hover:text-amber-500' : 'text-gray-200 hover:text-amber-300'}`}
    >
      ★
    </button>
  )
}
