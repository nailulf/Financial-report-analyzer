'use client'

import { useState, useEffect } from 'react'
import { isTickerInActiveWatchlist, toggleTickerInActive } from '@/lib/watchlists'
import { track } from '@/lib/analytics'

export function WatchlistStar({ ticker }: { ticker: string }) {
  const [starred, setStarred] = useState(false)

  useEffect(() => {
    setStarred(isTickerInActiveWatchlist(ticker))

    const handler = () => setStarred(isTickerInActiveWatchlist(ticker))
    window.addEventListener('watchlist-change', handler)
    return () => window.removeEventListener('watchlist-change', handler)
  }, [ticker])

  function toggle(e: React.MouseEvent) {
    e.preventDefault()
    e.stopPropagation()
    const nowStarred = toggleTickerInActive(ticker)
    setStarred(nowStarred)
    track.watchlistToggle(ticker, nowStarred)
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
