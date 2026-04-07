'use client'

import { useState } from 'react'
import type { PricePoint } from '@/lib/types/api'
import { TradingViewChart } from '@/components/charts/tradingview-chart'

interface Props {
  ticker: string
  priceHistory: PricePoint[]
}

export function PriceWidget({ ticker }: Props) {
  const [liveChartOpen, setLiveChartOpen] = useState(false)

  return (
    <div className="px-12 py-2">
      <div className="bg-white border border-[#E0E0E5]">
        <div
          className="px-5 py-3 border-b border-[#E0E0E5] flex items-center gap-3 cursor-pointer select-none"
          onClick={() => setLiveChartOpen(!liveChartOpen)}
        >
          <svg
            className={`w-3.5 h-3.5 text-[#888888] transition-transform ${liveChartOpen ? 'rotate-90' : ''}`}
            fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
          </svg>
          <span className="font-mono text-[13px] font-bold tracking-[0.5px] text-[#1A1A1A]">GRAFIK LANGSUNG</span>
        </div>
        {liveChartOpen && <TradingViewChart ticker={ticker} />}
      </div>
    </div>
  )
}
