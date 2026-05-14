// Types for the investor–stock network graph

export interface GraphNode {
  id: string                   // 'inv:DANAREKSA' | 'stk:BBRI'
  label: string                // investor name or ticker
  type: 'investor' | 'stock'

  // investor-only
  holder_type?: string | null  // 'institution', 'government', etc.
  stock_count?: number
  total_pct?: number           // sum of all holdings %

  // stock-only
  sector?: string | null
  stock_name?: string | null
  investor_count?: number

  // injected at runtime by react-force-graph-2d
  x?: number
  y?: number
  vx?: number
  vy?: number
  fx?: number
  fy?: number
  index?: number
}

export interface GraphLink {
  source: string | GraphNode   // may be mutated to node object by force simulation
  target: string | GraphNode
  percentage: number
  // % held in the previous snapshot. `null` means new position (didn't exist
  // before); `0` on `percentage` with a non-null `prevPercentage` means the
  // position was exited this quarter.
  prevPercentage?: number | null
}

export interface InvestorGraphData {
  nodes: GraphNode[]
  links: GraphLink[]
  report_date: string | null
  previous_report_date?: string | null
}

// Detail data computed client-side when an investor is selected
export interface CoInvestor {
  name: string
  shared_tickers: string[]
  shared_count: number
}

export interface InvestorDetail {
  name: string
  holder_type: string | null
  total_pct: number
  stock_count: number
  prev_total_pct?: number | null    // sum of % in the previous snapshot
  prev_stock_count?: number | null  // # of positions in the previous snapshot
  holdings: Array<{
    ticker: string
    stock_name: string | null
    sector: string | null
    percentage: number
    prevPercentage?: number | null  // % in the previous snapshot (null = NEW)
  }>
  co_investors: CoInvestor[]
}

export interface StockDetail {
  ticker: string
  stock_name: string | null
  sector: string | null
  investor_count: number
  prev_investor_count?: number | null
  investors: Array<{
    name: string
    holder_type: string | null
    percentage: number
    prevPercentage?: number | null  // % in the previous snapshot (null = NEW)
  }>
}
