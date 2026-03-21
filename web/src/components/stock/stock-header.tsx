import type { StockHeader as StockHeaderType } from '@/lib/types/api'
import { Badge } from '@/components/ui/badge'
import { formatIDRCompact } from '@/lib/calculations/formatters'

export function StockHeader({ stock }: { stock: StockHeaderType }) {
  return (
    <div className="mb-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-3 mb-1">
            <h1 className="text-3xl font-bold text-gray-900 font-mono">{stock.ticker}</h1>
            {stock.is_lq45 && <Badge variant="amber">LQ45</Badge>}
            {stock.is_idx30 && <Badge variant="purple">IDX30</Badge>}
            {stock.status !== 'Active' && <Badge variant="red">{stock.status}</Badge>}
          </div>
          <p className="text-lg text-gray-600">{stock.name}</p>
        </div>
        <div className="text-right">
          {stock.sector && <Badge variant="blue">{stock.sector}</Badge>}
          {stock.subsector && <p className="text-xs text-gray-400 mt-1">{stock.subsector}</p>}
          {stock.board && <p className="text-xs text-gray-400">{stock.board} Board</p>}
        </div>
      </div>
      {stock.market_cap && (
        <p className="text-sm text-gray-500 mt-2">
          Market Cap: <span className="font-medium text-gray-700">{formatIDRCompact(stock.market_cap)}</span>
        </p>
      )}
    </div>
  )
}
