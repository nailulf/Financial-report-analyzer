import type { StockHeader as StockHeaderType } from '@/lib/types/api'
import { formatIDRCompact } from '@/lib/calculations/formatters'

export function StockHeader({ stock }: { stock: StockHeaderType }) {
  return (
    <div className="py-8 flex items-start justify-between gap-6 flex-wrap">
      {/* Left: Ticker + Name + Classification */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-3 mb-3 flex-wrap">
          <span className="inline-flex items-center px-3 py-1.5 rounded-xl bg-[#C8F0D8] text-[#3D8A5A] text-sm font-bold font-mono tracking-widest">
            {stock.ticker}
          </span>
          {stock.is_lq45 && (
            <span className="inline-flex items-center px-2.5 py-1 rounded-lg bg-amber-100 text-amber-700 text-xs font-semibold">LQ45</span>
          )}
          {stock.is_idx30 && (
            <span className="inline-flex items-center px-2.5 py-1 rounded-lg bg-purple-100 text-purple-700 text-xs font-semibold">IDX30</span>
          )}
          {stock.status !== 'Active' && (
            <span className="inline-flex items-center px-2.5 py-1 rounded-lg bg-red-100 text-red-700 text-xs font-semibold">{stock.status}</span>
          )}
        </div>
        <h1 className="text-2xl font-semibold text-[#1A1918] leading-snug mb-2">
          {stock.name}
        </h1>
        <div className="flex items-center gap-2 flex-wrap">
          {stock.sector && (
            <span className="inline-flex items-center px-2.5 py-1 rounded-lg bg-[#EDECEA] text-[#6D6C6A] text-xs font-medium">
              {stock.sector}
            </span>
          )}
          {stock.subsector && (
            <span className="text-xs text-[#9C9B99]">{stock.subsector}</span>
          )}
          {stock.board && (
            <span className="text-xs text-[#9C9B99]">· {stock.board} Board</span>
          )}
        </div>
      </div>

      {/* Right: Market Cap */}
      {stock.market_cap && (
        <div className="shrink-0 text-right">
          <p className="text-xs text-[#9C9B99] uppercase tracking-wide mb-1">Market Cap</p>
          <p className="text-2xl font-bold font-mono text-[#1A1918]">
            {formatIDRCompact(stock.market_cap)}
          </p>
        </div>
      )}
    </div>
  )
}
