'use client'

import { useRouter, usePathname, useSearchParams } from 'next/navigation'

const SECTOR_OPTIONS = [
  { label: 'Financials', value: 'Financials' },
  { label: 'Energy', value: 'Energy' },
  { label: 'Basic Materials', value: 'Basic Materials' },
  { label: 'Consumer Staples', value: 'Barang Konsumen Primer' },
  { label: 'Consumer Discretionary', value: 'Barang Konsumen Non-Primer' },
  { label: 'Industrials', value: 'Industrials' },
  { label: 'Property & Real Estate', value: 'Property & Real Estate' },
  { label: 'Technology', value: 'Technology' },
  { label: 'Infrastructure', value: 'Infrastructure' },
  { label: 'Transportation & Logistics', value: 'Transportation & Logistics' },
  { label: 'Healthcare', value: 'Healthcare' },
] as const

function isActiveSector(current: string | undefined, value: string) {
  if (!current) return false
  if (current === value) return true
  if (value === 'Barang Konsumen Primer' && current === 'Consumer Staples') return true
  if (value === 'Barang Konsumen Non-Primer' && current === 'Consumer Discretionary') return true
  return false
}

export function SectorFilter({ current }: { current?: string }) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  function setSector(sector: string | undefined) {
    const params = new URLSearchParams(searchParams.toString())
    if (sector) params.set('sector', sector)
    else params.delete('sector')
    params.delete('page')
    router.push(`${pathname}?${params.toString()}`)
  }

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <button
        onClick={() => setSector(undefined)}
        className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
          !current ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
        }`}
      >
        All
      </button>
      {SECTOR_OPTIONS.map(({ label, value }) => (
        <button
          key={value}
          onClick={() => setSector(value)}
          className={`px-3 py-1 rounded-full text-xs font-medium transition-colors whitespace-nowrap ${
            isActiveSector(current, value) ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  )
}
