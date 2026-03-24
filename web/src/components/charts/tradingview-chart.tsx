'use client'

import { useEffect, useRef, useState } from 'react'

interface TradingViewChartProps {
  ticker: string
}

export function TradingViewChart({ ticker }: TradingViewChartProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
  }, [])

  useEffect(() => {
    if (!mounted || !containerRef.current) return

    // Clear any previous widget instance
    containerRef.current.innerHTML = ''

    const widgetDiv = document.createElement('div')
    widgetDiv.id = `tradingview_${ticker}`
    widgetDiv.style.height = '100%'
    widgetDiv.style.width = '100%'
    containerRef.current.appendChild(widgetDiv)

    const script = document.createElement('script')
    script.src = 'https://s3.tradingview.com/tv.js'
    script.async = true
    script.onload = () => {
      if (typeof window.TradingView === 'undefined') return
      new window.TradingView.widget({
        autosize: true,
        symbol: `IDX:${ticker}`,
        interval: 'D',
        timezone: 'Asia/Jakarta',
        theme: 'light',
        style: '1',           // candlestick
        locale: 'en',
        toolbar_bg: '#F5F4F1',
        enable_publishing: false,
        allow_symbol_change: false,
        save_image: false,
        container_id: `tradingview_${ticker}`,
        hide_side_toolbar: false,
        studies: ['Volume@tv-basicstudies'],
      })
    }
    containerRef.current.appendChild(script)

    return () => {
      if (containerRef.current) {
        containerRef.current.innerHTML = ''
      }
    }
  }, [mounted, ticker])

  if (!mounted) {
    return (
      <div className="bg-white rounded-2xl border border-[#E5E4E1] shadow-[0_2px_12px_rgba(26,25,24,0.06)] overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-[#E5E4E1]">
          <div className="h-4 w-24 bg-[#EDECEA] rounded animate-pulse" />
        </div>
        <div className="h-[500px] bg-[#F5F4F1] animate-pulse" />
      </div>
    )
  }

  return (
    <div className="bg-white rounded-2xl border border-[#E5E4E1] shadow-[0_2px_12px_rgba(26,25,24,0.06)] overflow-hidden">
      <div className="flex items-center justify-between px-6 py-4 border-b border-[#E5E4E1]">
        <h2 className="text-sm font-semibold text-[#1A1918]">Live Chart</h2>
        <span className="text-xs text-[#9C9B99]">Powered by TradingView</span>
      </div>
      <div
        ref={containerRef}
        className="w-full"
        style={{ height: 500 }}
      />
    </div>
  )
}
