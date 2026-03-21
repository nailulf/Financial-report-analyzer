'use client'

import { useMemo } from 'react'
import type { GraphNode, InvestorGraphData, InvestorDetail, StockDetail, CoInvestor } from '@/lib/types/network'

interface Props {
  node: GraphNode
  data: InvestorGraphData
  onClose: () => void
  onSelectNode: (node: GraphNode) => void
}

// ─── Badge helpers ────────────────────────────────────────────────────────────

function TypeBadge({ type }: { type: string | null | undefined }) {
  const map: Record<string, string> = {
    government:  'bg-blue-50 text-blue-700',
    institution: 'bg-purple-50 text-purple-700',
    individual:  'bg-amber-50 text-amber-700',
    public:      'bg-gray-100 text-gray-600',
    foreign:     'bg-teal-50 text-teal-700',
  }
  const label: Record<string, string> = {
    government: 'Gov', institution: 'Inst', individual: 'Ind', public: 'Public', foreign: 'Foreign',
  }
  if (!type) return null
  const cls = map[type] ?? 'bg-gray-100 text-gray-600'
  return (
    <span className={`text-xs px-2 py-0.5 rounded font-medium ${cls}`}>
      {label[type] ?? type}
    </span>
  )
}

function SectorBadge({ sector }: { sector: string | null | undefined }) {
  if (!sector) return null
  return (
    <span className="text-xs px-2 py-0.5 rounded bg-emerald-50 text-emerald-700 font-medium">
      {sector}
    </span>
  )
}

// ─── Compute detail objects from graph data ───────────────────────────────────

function nodeId(ref: string | GraphNode): string {
  return typeof ref === 'string' ? ref : ref.id
}

function buildInvestorDetail(node: GraphNode, data: InvestorGraphData): InvestorDetail {
  // Find all stock links for this investor
  const links = data.links.filter((lk) => nodeId(lk.source) === node.id)
  const ownedStockIds = new Set(links.map((lk) => nodeId(lk.target)))

  const holdings = links
    .map((lk) => {
      const stockId = nodeId(lk.target)
      const stockNode = data.nodes.find((n) => n.id === stockId)
      return {
        ticker:     stockNode?.label ?? stockId.replace('stk:', ''),
        stock_name: stockNode?.stock_name ?? null,
        sector:     stockNode?.sector ?? null,
        percentage: lk.percentage,
      }
    })
    .sort((a, b) => b.percentage - a.percentage)

  // Co-investors: other investors connected to any of the same stocks
  const coMap = new Map<string, Set<string>>()
  for (const lk of data.links) {
    const src = nodeId(lk.source)
    const tgt = nodeId(lk.target)
    if (src !== node.id && ownedStockIds.has(tgt)) {
      if (!coMap.has(src)) coMap.set(src, new Set())
      coMap.get(src)!.add(tgt.replace('stk:', ''))
    }
  }

  const co_investors: CoInvestor[] = Array.from(coMap.entries())
    .map(([invId, tickers]) => ({
      name:          invId.replace('inv:', ''),
      shared_tickers: Array.from(tickers),
      shared_count:   tickers.size,
    }))
    .sort((a, b) => b.shared_count - a.shared_count)
    .slice(0, 20)

  return {
    name:        node.label,
    holder_type: node.holder_type ?? null,
    total_pct:   node.total_pct ?? 0,
    stock_count: node.stock_count ?? 0,
    holdings,
    co_investors,
  }
}

function buildStockDetail(node: GraphNode, data: InvestorGraphData): StockDetail {
  const links = data.links.filter((lk) => nodeId(lk.target) === node.id)
  const investors = links
    .map((lk) => {
      const invId   = nodeId(lk.source)
      const invNode = data.nodes.find((n) => n.id === invId)
      return {
        name:        invNode?.label ?? invId.replace('inv:', ''),
        holder_type: invNode?.holder_type ?? null,
        percentage:  lk.percentage,
      }
    })
    .sort((a, b) => b.percentage - a.percentage)

  return {
    ticker:         node.label,
    stock_name:     node.stock_name ?? null,
    sector:         node.sector ?? null,
    investor_count: node.investor_count ?? 0,
    investors,
  }
}

// ─── Sub-panels ───────────────────────────────────────────────────────────────

function InvestorView({
  detail, data, onSelectNode,
}: {
  detail: InvestorDetail
  data: InvestorGraphData
  onSelectNode: (n: GraphNode) => void
}) {
  return (
    <div className="space-y-5">
      {/* Holdings */}
      <section>
        <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
          Holdings ({detail.stock_count} stocks)
        </h3>
        <div className="space-y-1.5">
          {detail.holdings.map((h) => (
            <button
              key={h.ticker}
              onClick={() => {
                const n = data.nodes.find((nd) => nd.id === `stk:${h.ticker}`)
                if (n) onSelectNode(n)
              }}
              className="w-full flex items-center justify-between text-left px-2 py-1.5 rounded hover:bg-gray-50 group"
            >
              <div className="flex-1 min-w-0">
                <span className="text-sm font-medium text-gray-900 group-hover:text-blue-600">
                  {h.ticker}
                </span>
                {h.stock_name && (
                  <span className="text-xs text-gray-400 ml-1.5 truncate">{h.stock_name}</span>
                )}
                {h.sector && (
                  <div className="mt-0.5">
                    <SectorBadge sector={h.sector} />
                  </div>
                )}
              </div>
              <div className="shrink-0 ml-2 text-right">
                <span className="text-sm font-semibold text-gray-700">
                  {h.percentage.toFixed(2)}%
                </span>
                <div className="mt-0.5 h-1 w-16 bg-gray-100 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-emerald-500 rounded-full"
                    style={{ width: `${Math.min(h.percentage * 2, 100)}%` }}
                  />
                </div>
              </div>
            </button>
          ))}
        </div>
      </section>

      {/* Co-investors */}
      {detail.co_investors.length > 0 && (
        <section>
          <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
            Co-investors — share ≥1 stock
          </h3>
          <div className="space-y-1">
            {detail.co_investors.map((co) => (
              <button
                key={co.name}
                onClick={() => {
                  const n = data.nodes.find((nd) => nd.id === `inv:${co.name}`)
                  if (n) onSelectNode(n)
                }}
                className="w-full flex items-center justify-between text-left px-2 py-1.5 rounded hover:bg-purple-50 group"
              >
                <span className="text-sm text-gray-800 group-hover:text-purple-700 truncate">
                  {co.name}
                </span>
                <span className="shrink-0 ml-2 text-xs text-purple-600 font-medium bg-purple-50 px-1.5 py-0.5 rounded">
                  {co.shared_count} shared
                </span>
              </button>
            ))}
          </div>
          <p className="text-xs text-gray-400 mt-2">
            Click any co-investor to explore their network.
          </p>
        </section>
      )}
    </div>
  )
}

function StockView({
  detail, data, onSelectNode,
}: {
  detail: StockDetail
  data: InvestorGraphData
  onSelectNode: (n: GraphNode) => void
}) {
  return (
    <div className="space-y-4">
      <section>
        <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
          Major investors ({detail.investor_count})
        </h3>
        <div className="space-y-1.5">
          {detail.investors.map((inv) => (
            <button
              key={inv.name}
              onClick={() => {
                const n = data.nodes.find((nd) => nd.id === `inv:${inv.name}`)
                if (n) onSelectNode(n)
              }}
              className="w-full flex items-center justify-between text-left px-2 py-1.5 rounded hover:bg-blue-50 group"
            >
              <div className="flex-1 min-w-0">
                <p className="text-sm text-gray-800 group-hover:text-blue-700 truncate">{inv.name}</p>
                {inv.holder_type && (
                  <div className="mt-0.5">
                    <TypeBadge type={inv.holder_type} />
                  </div>
                )}
              </div>
              <div className="shrink-0 ml-2 text-right">
                <span className="text-sm font-semibold text-gray-700">
                  {inv.percentage.toFixed(2)}%
                </span>
                <div className="mt-0.5 h-1 w-16 bg-gray-100 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-blue-500 rounded-full"
                    style={{ width: `${Math.min(inv.percentage * 2, 100)}%` }}
                  />
                </div>
              </div>
            </button>
          ))}
        </div>
      </section>
    </div>
  )
}

// ─── Main panel ───────────────────────────────────────────────────────────────

export function InvestorPanel({ node, data, onClose, onSelectNode }: Props) {
  const detail = useMemo(() => {
    if (node.type === 'investor') return buildInvestorDetail(node, data)
    return buildStockDetail(node, data)
  }, [node, data])

  const isInvestor = node.type === 'investor'
  const inv        = isInvestor ? (detail as InvestorDetail) : null
  const stk        = !isInvestor ? (detail as StockDetail) : null

  return (
    <div className="w-80 h-full flex flex-col bg-white border-l border-gray-200 shadow-lg overflow-hidden shrink-0">
      {/* Header */}
      <div className={`p-4 border-b border-gray-100 ${isInvestor ? 'bg-blue-50' : 'bg-emerald-50'}`}>
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0">
            <p className={`text-xs font-medium mb-1 ${isInvestor ? 'text-blue-500' : 'text-emerald-600'}`}>
              {isInvestor ? 'INVESTOR' : 'STOCK'}
            </p>
            <h2 className="text-base font-bold text-gray-900 leading-tight break-words">
              {node.label}
            </h2>
            {stk?.stock_name && (
              <p className="text-xs text-gray-500 mt-0.5">{stk.stock_name}</p>
            )}
            <div className="flex flex-wrap gap-1.5 mt-2">
              {isInvestor && <TypeBadge type={node.holder_type} />}
              {!isInvestor && <SectorBadge sector={node.sector} />}
            </div>
          </div>
          <button
            onClick={onClose}
            className="shrink-0 p-1 rounded hover:bg-white/60 text-gray-400 hover:text-gray-600"
          >
            ✕
          </button>
        </div>

        {/* Summary stats */}
        <div className="flex gap-4 mt-3 text-xs text-gray-500">
          {isInvestor && inv && (
            <>
              <span><span className="font-semibold text-gray-700">{inv.stock_count}</span> stocks</span>
              <span><span className="font-semibold text-gray-700">{inv.total_pct.toFixed(1)}%</span> total</span>
              <span><span className="font-semibold text-gray-700">{inv.co_investors.length}</span> co-investors</span>
            </>
          )}
          {!isInvestor && stk && (
            <span><span className="font-semibold text-gray-700">{stk.investor_count}</span> major investors</span>
          )}
        </div>
      </div>

      {/* Scrollable body */}
      <div className="flex-1 overflow-y-auto p-4">
        {isInvestor && inv ? (
          <InvestorView detail={inv} data={data} onSelectNode={onSelectNode} />
        ) : stk ? (
          <StockView detail={stk} data={data} onSelectNode={onSelectNode} />
        ) : null}
      </div>

      {/* Footer hint */}
      <div className="p-3 border-t border-gray-100 bg-gray-50">
        <p className="text-xs text-gray-400 text-center">
          Click any item above to jump to its node in the graph
        </p>
      </div>
    </div>
  )
}
