'use client'

import { useState, useTransition } from 'react'
import { useRouter, usePathname, useSearchParams } from 'next/navigation'

export function BrokerSearchForm({ currentTicker }: { currentTicker?: string }) {
  const [ticker, setTicker] = useState(currentTicker ?? '')
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [, startTransition] = useTransition()

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const t = ticker.trim().toUpperCase()
    if (!t) return
    const params = new URLSearchParams(searchParams.toString())
    params.set('ticker', t)
    params.delete('date')
    startTransition(() => router.push(`${pathname}?${params.toString()}`))
  }

  return (
    <form onSubmit={handleSubmit} className="flex gap-2">
      <input
        type="text"
        value={ticker}
        onChange={(e) => setTicker(e.target.value.toUpperCase())}
        placeholder="Enter ticker, e.g. BBRI"
        maxLength={6}
        className="px-3 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-400 font-mono w-40 uppercase"
      />
      <button
        type="submit"
        className="px-4 py-1.5 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 transition-colors"
      >
        View
      </button>
    </form>
  )
}
