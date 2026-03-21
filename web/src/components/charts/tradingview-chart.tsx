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
        toolbar_bg: '#f8f9fa',
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
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
          <div className="h-4 w-24 bg-gray-200 rounded animate-pulse" />
        </div>
        <div className="h-[500px] bg-gray-100 animate-pulse" />
      </div>
    )
  }

  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
        <h2 className="text-base font-semibold text-gray-800">Live Chart</h2>
        <span className="text-xs text-gray-400">Powered by TradingView</span>
      </div>
      <div
        ref={containerRef}
        className="w-full"
        style={{ height: 500 }}
      />
    </div>
  )
}
