'use client'

import Link from 'next/link'

export default function StockError({ reset }: { reset: () => void }) {
  return (
    <main className="max-w-7xl mx-auto px-4 py-24 text-center">
      <h1 className="text-xl font-semibold text-[#1A1918] mb-2">Something went wrong</h1>
      <p className="text-[#6D6C6A] mb-6">Failed to load stock data.</p>
      <div className="flex justify-center gap-3">
        <button onClick={reset} className="px-4 py-2 bg-[#3D8A5A] text-white rounded-xl text-sm hover:bg-[#2d6b45] transition-colors">Retry</button>
        <Link href="/" className="px-4 py-2 border border-[#E5E4E1] rounded-xl text-sm text-[#6D6C6A] hover:bg-[#F5F4F1] transition-colors">Back to screener</Link>
      </div>
    </main>
  )
}
