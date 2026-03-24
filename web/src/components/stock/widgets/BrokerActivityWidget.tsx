'use client'

import { useState, useEffect, useCallback } from 'react'
import type { StockBrokerSummary, StockBrokerBucket } from '@/lib/queries/broker'
import { formatIDRCompact } from '@/lib/calculations/formatters'

const DURATION_PRESETS = [
  { label: '5D',  days: 5  },
  { label: '10D', days: 10 },
  { label: '20D', days: 20 },
  { label: '30D', days: 30 },
]

interface Props {
  ticker:      string
  initialData: StockBrokerSummary | null
}

function BrokerTable({
  title,
  rows,
  accentClass,
}: {
  title:       string
  rows:        Array<{ broker_code: string; broker_name: string | null; value: number }>
  accentClass: string
}) {
  return (
    <div>
      <div className="bg-[#F5F5F8] px-3 py-2">
        <span className="font-mono text-[11px] font-bold tracking-[0.5px] text-[#888888] uppercase">{title}</span>
      </div>
      {rows.map((row, i) => (
        <div key={i} className="flex items-center px-3 py-2 border-b border-[#E0E0E5] last:border-0">
          <span className="font-mono text-[13px] font-bold text-[#1A1A1A] w-10 shrink-0">{row.broker_code}</span>
          <span className="font-mono text-[12px] text-[#888888] flex-1 mx-2 truncate">{row.broker_name ?? ''}</span>
          <span className={`font-mono text-[13px] font-semibold ${accentClass}`}>
            {formatIDRCompact(row.value)}
          </span>
        </div>
      ))}
    </div>
  )
}

function toBuyerRows(buckets: StockBrokerBucket[]) {
  return buckets.map((b) => ({ broker_code: b.broker_code, broker_name: b.broker_name, value: b.total_buy_value }))
}
function toSellerRows(buckets: StockBrokerBucket[]) {
  return buckets.map((b) => ({ broker_code: b.broker_code, broker_name: b.broker_name, value: b.total_sell_value }))
}

function Skeleton() {
  return (
    <div className="px-3 py-3 flex flex-col gap-2 animate-pulse">
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="flex items-center gap-2">
          <div className="w-10 h-3 bg-[#E0E0E5] rounded" />
          <div className="flex-1 h-3 bg-[#E0E0E5] rounded" />
          <div className="w-16 h-3 bg-[#E0E0E5] rounded" />
        </div>
      ))}
    </div>
  )
}

export function BrokerActivityWidget({ ticker, initialData }: Props) {
  const [data,    setData]    = useState<StockBrokerSummary | null>(initialData)
  const [days,    setDays]    = useState(10)
  const [endDate, setEndDate] = useState('')
  const [loading, setLoading] = useState(false)

  const fetchData = useCallback(async (d: number, ed: string) => {
    setLoading(true)
    try {
      const params = new URLSearchParams({ days: String(d) })
      if (ed) params.set('endDate', ed)
      const res  = await fetch(`/api/stocks/${ticker}/broker?${params}`)
      const json = await res.json()
      setData(json)
    } catch {
      // keep current data on error
    } finally {
      setLoading(false)
    }
  }, [ticker])

  // Re-fetch whenever days or endDate changes (skip on mount — use initialData)
  const [mounted, setMounted] = useState(false)
  useEffect(() => { setMounted(true) }, [])
  useEffect(() => {
    if (!mounted) return
    fetchData(days, endDate)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days, endDate, mounted])

  return (
    <div className="bg-white border border-[#E0E0E5] flex flex-col">
      {/* Header */}
      <div className="px-5 py-3 border-b border-[#E0E0E5] flex items-center justify-between gap-2 flex-wrap">
        <span className="font-mono text-[13px] font-bold tracking-[0.5px] text-[#1A1A1A]">AKTIVITAS BROKER</span>

        <div className="flex items-center gap-2">
          {/* Duration presets */}
          <div className="flex items-center gap-1">
            {DURATION_PRESETS.map((p) => (
              <button
                key={p.days}
                onClick={() => setDays(p.days)}
                className={`font-mono text-[11px] font-bold px-2 py-1 border transition-colors ${
                  days === p.days
                    ? 'bg-[#1A1A1A] text-[#00FF88] border-[#1A1A1A]'
                    : 'bg-white text-[#888888] border-[#E0E0E5] hover:border-[#1A1A1A] hover:text-[#1A1A1A]'
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>

          {/* End date picker */}
          <input
            type="date"
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
            className="font-mono text-[11px] text-[#1A1A1A] border border-[#E0E0E5] px-2 py-1 bg-white focus:outline-none focus:border-[#1A1A1A] w-[110px]"
          />

          {/* Date range label */}
          {data?.dateRange && !loading && (
            <span className="font-mono text-[11px] text-[#888888] whitespace-nowrap">
              {data.daysCount}D: {data.dateRange}
            </span>
          )}
        </div>
      </div>

      {/* Body */}
      {loading ? (
        <>
          <Skeleton />
          <div className="h-px bg-[#E0E0E5]" />
          <Skeleton />
        </>
      ) : !data ? (
        <div className="px-5 py-4">
          <span className="font-mono text-[13px] text-[#888888]">Tidak ada data broker untuk saham ini</span>
        </div>
      ) : (
        <>
          <BrokerTable
            title="PEMBELI TERBESAR (NILAI)"
            rows={toBuyerRows(data.topBuyers)}
            accentClass="text-[#00FF88]"
          />
          <div className="h-px bg-[#E0E0E5]" />
          <BrokerTable
            title="PENJUAL TERBESAR (NILAI)"
            rows={toSellerRows(data.topSellers)}
            accentClass="text-red-400"
          />
        </>
      )}
    </div>
  )
}
