'use client'

import Link from 'next/link'

export default function StockError({ reset }: { reset: () => void }) {
  return (
    <main className="max-w-7xl mx-auto px-4 py-24 text-center">
      <h1 className="text-xl font-semibold text-gray-700 mb-2">Something went wrong</h1>
      <p className="text-gray-500 mb-6">Failed to load stock data.</p>
      <div className="flex justify-center gap-3">
        <button onClick={reset} className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700">Retry</button>
        <Link href="/" className="px-4 py-2 border border-gray-300 rounded-lg text-sm hover:bg-gray-50">Back to screener</Link>
      </div>
    </main>
  )
}
