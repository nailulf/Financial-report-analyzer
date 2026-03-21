'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { NetworkGraph } from '@/components/investors/network-graph'
import { InvestorPanel } from '@/components/investors/investor-panel'
import type { GraphNode, InvestorGraphData } from '@/lib/types/network'

export default function InvestorsPage() {
  const [mounted, setMounted]           = useState(false)
  const [data, setData]                 = useState<InvestorGraphData | null>(null)
  const [loading, setLoading]           = useState(true)
  const [error, setError]               = useState<string | null>(null)
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null)
  const [search, setSearch]             = useState('')
  const [view, setView]                 = useState<'graph' | 'list'>('list')

  useEffect(() => { setMounted(true) }, [])

  // Fetch graph data
  useEffect(() => {
    setLoading(true)
    setError(null)
    setSelectedNode(null)
    fetch('/api/investors/network')
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json() })
      .then((d: InvestorGraphData) => { setData(d); setLoading(false) })
      .catch((e) => { setError(e.message); setLoading(false) })
  }, [])

  // Search: find node and select it (NetworkGraph handles the zoom)
  const handleSearch = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault()
      if (!data || !search.trim()) return
      const q = search.trim().toLowerCase()
      const found = data.nodes.find(
        (n) =>
          n.label.toLowerCase().includes(q) ||
          (n.stock_name ?? '').toLowerCase().includes(q)
      )
      if (found) {
        setSelectedNode(found)
        setView('graph')
      }
    },
    [data, search]
  )

  const handleSelectNode = useCallback((node: GraphNode | null) => {
    setSelectedNode(node)
    if (node) setView('graph')
    setSearch('')
  }, [])

  // Derived
  const investors = data?.nodes.filter((n) => n.type === 'investor') ?? []
  const stockCount = data?.nodes.filter((n) => n.type === 'stock').length ?? 0

  const filteredInvestors = search.trim()
    ? investors.filter((n) => n.label.toLowerCase().includes(search.toLowerCase()))
    : investors

  if (!mounted) {
    return (
      <div className="flex flex-col" style={{ height: 'calc(100vh - 56px)' }}>
        <div className="shrink-0 h-12 bg-white border-b border-gray-200 animate-pulse" />
        <div className="flex-1 bg-gray-50" />
      </div>
    )
  }

  return (
    <div className="flex flex-col" style={{ height: 'calc(100vh - 56px)' }}>

      {/* ── Controls bar ── */}
      <div className="shrink-0 flex items-center gap-3 px-4 py-2.5 bg-white border-b border-gray-200 flex-wrap">

        {/* View toggle */}
        <div className="flex rounded-lg border border-gray-200 overflow-hidden">
          <button
            onClick={() => setView('list')}
            className={`text-xs px-3 py-1.5 transition-colors ${view === 'list' ? 'bg-blue-600 text-white' : 'text-gray-600 hover:bg-gray-50'}`}
          >
            List
          </button>
          <button
            onClick={() => setView('graph')}
            className={`text-xs px-3 py-1.5 transition-colors ${view === 'graph' ? 'bg-blue-600 text-white' : 'text-gray-600 hover:bg-gray-50'}`}
          >
            Network
          </button>
        </div>

        {/* Search */}
        <form onSubmit={handleSearch} className="flex items-center gap-2">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={view === 'list' ? 'Filter investors…' : 'Search investor or ticker…'}
            className="text-sm border border-gray-200 rounded-lg px-3 py-1.5 w-52 focus:outline-none focus:ring-2 focus:ring-blue-200"
          />
          {view === 'graph' && (
            <button type="submit" className="text-sm px-3 py-1.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700">
              Go
            </button>
          )}
        </form>

        {/* Stats */}
        {!loading && data && (
          <div className="ml-auto flex items-center gap-4 text-xs text-gray-400">
            <span><span className="font-semibold text-blue-600">{investors.length}</span> investors</span>
            <span><span className="font-semibold text-emerald-600">{stockCount}</span> stocks</span>
            {data.report_date && (
              <span>as of <span className="font-medium text-gray-600">{data.report_date}</span></span>
            )}
          </div>
        )}
      </div>

      {/* ── Main area ── */}
      <div className="flex-1 flex overflow-hidden relative">

        {/* ── LIST VIEW ── */}
        {view === 'list' && (
          <div className="flex-1 overflow-y-auto bg-white">
            {loading && (
              <div className="flex items-center justify-center h-40">
                <div className="flex gap-2">
                  {[0,1,2].map(i => (
                    <div key={i} className="w-2.5 h-2.5 rounded-full bg-blue-400 animate-bounce" style={{ animationDelay: `${i * 0.15}s` }} />
                  ))}
                </div>
              </div>
            )}
            {!loading && filteredInvestors.length === 0 && (
              <div className="flex items-center justify-center h-40 text-sm text-gray-400">
                {data ? 'No investors match your filter.' : 'No data loaded.'}
              </div>
            )}
            {!loading && filteredInvestors.length > 0 && (
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-white border-b border-gray-100 z-10">
                  <tr>
                    <th className="text-left text-xs font-semibold text-gray-500 px-4 py-2.5">#</th>
                    <th className="text-left text-xs font-semibold text-gray-500 px-4 py-2.5">Investor</th>
                    <th className="text-left text-xs font-semibold text-gray-500 px-4 py-2.5">Type</th>
                    <th className="text-right text-xs font-semibold text-gray-500 px-4 py-2.5">Stocks</th>
                    <th className="text-right text-xs font-semibold text-gray-500 px-4 py-2.5">Total %</th>
                    <th className="px-4 py-2.5" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {filteredInvestors
                    .sort((a, b) => (b.stock_count ?? 0) - (a.stock_count ?? 0))
                    .map((inv, i) => (
                      <tr
                        key={inv.id}
                        className="hover:bg-blue-50 cursor-pointer transition-colors"
                        onClick={() => handleSelectNode(inv)}
                      >
                        <td className="px-4 py-2.5 text-gray-400 text-xs">{i + 1}</td>
                        <td className="px-4 py-2.5 font-medium text-gray-900">{inv.label}</td>
                        <td className="px-4 py-2.5">
                          {inv.holder_type && (
                            <TypeBadge type={inv.holder_type} />
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-right text-gray-700 font-medium">{inv.stock_count}</td>
                        <td className="px-4 py-2.5 text-right text-gray-500">{(inv.total_pct ?? 0).toFixed(1)}%</td>
                        <td className="px-4 py-2.5 text-right">
                          <span className="text-xs text-blue-600 hover:underline">View network →</span>
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            )}
          </div>
        )}

        {/* ── GRAPH VIEW ── */}
        {view === 'graph' && (
          <div className="flex-1 relative">
            {loading && (
              <div className="absolute inset-0 bg-gray-50/80 z-10 flex items-center justify-center">
                <div className="flex gap-2">
                  {[0,1,2].map(i => (
                    <div key={i} className="w-2.5 h-2.5 rounded-full bg-blue-400 animate-bounce" style={{ animationDelay: `${i * 0.15}s` }} />
                  ))}
                </div>
              </div>
            )}
            {error && (
              <div className="absolute inset-0 flex items-center justify-center">
                <p className="text-sm text-red-500">Error: {error}</p>
              </div>
            )}
            <NetworkGraph data={data} selectedNode={selectedNode} onNodeClick={handleSelectNode} />
          </div>
        )}

        {/* ── Detail panel ── */}
        {selectedNode && data && (
          <InvestorPanel
            node={selectedNode}
            data={data}
            onClose={() => setSelectedNode(null)}
            onSelectNode={handleSelectNode}
          />
        )}

        {/* Legend (graph view only, only when a node is selected) */}
        {view === 'graph' && selectedNode && (
          <div className="absolute bottom-4 left-4 bg-white/90 backdrop-blur-sm border border-gray-200 rounded-xl px-4 py-3 text-xs text-gray-600 space-y-1.5 shadow-sm pointer-events-none">
            <div className="flex items-center gap-2"><span className="w-3 h-3 rounded-full bg-amber-500 inline-block" />Selected</div>
            <div className="flex items-center gap-2"><span className="w-3 h-3 rounded-full bg-blue-500 inline-block" />Investor</div>
            <div className="flex items-center gap-2"><span className="w-3 h-3 rounded-full bg-emerald-500 inline-block" />Stock</div>
            <p className="text-gray-400 pt-1 border-t border-gray-100">Click node to explore · Drag to pan</p>
          </div>
        )}
      </div>
    </div>
  )
}

// ── inline badge (no import needed) ──────────────────────────────────────────

function TypeBadge({ type }: { type: string }) {
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
  return (
    <span className={`text-xs px-2 py-0.5 rounded font-medium ${map[type] ?? 'bg-gray-100 text-gray-600'}`}>
      {label[type] ?? type}
    </span>
  )
}
