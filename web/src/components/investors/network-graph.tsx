'use client'

import {
  useEffect, useRef, useState, useCallback, useMemo,
  type ComponentType,
} from 'react'
import type { GraphNode, GraphLink, InvestorGraphData } from '@/lib/types/network'

interface Props {
  data: InvestorGraphData | null
  selectedNode: GraphNode | null
  onNodeClick: (node: GraphNode | null) => void
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function nodeId(ref: string | GraphNode): string {
  return typeof ref === 'string' ? ref : (ref as any).id ?? String(ref)
}

function nodeRadius(n: GraphNode): number {
  if (n.type === 'investor') return 5 + Math.sqrt(n.stock_count ?? 1) * 2.5
  return 4 + Math.sqrt(n.investor_count ?? 1) * 2
}

const C = {
  investor:   '#3B82F6',
  stock:      '#10B981',
  selected:   '#F59E0B',
  bg:         '#F9FAFB',
  edge:       'rgba(156,163,175,0.4)',
}

// ─── Build the subgraph for the selected node ─────────────────────────────────

function buildSubgraph(
  data: InvestorGraphData,
  selectedNode: GraphNode
): { nodes: GraphNode[]; links: GraphLink[] } {
  const nodeSet = new Set<string>([selectedNode.id])
  const filteredLinks: GraphLink[] = []

  for (const lk of data.links) {
    const src = nodeId(lk.source)
    const tgt = nodeId(lk.target)
    if (src === selectedNode.id || tgt === selectedNode.id) {
      nodeSet.add(src)
      nodeSet.add(tgt)
      filteredLinks.push({ ...lk })
    }
  }

  return {
    nodes: data.nodes.filter((n) => nodeSet.has(n.id)).map((n) => ({ ...n })),
    links: filteredLinks,
  }
}

// ─── Collision force (no d3-force import needed) ──────────────────────────────

function makeCollisionForce(padding: number) {
  let nodes: any[] = []
  function force(alpha: number) {
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i], b = nodes[j]
        const dx = (b.x ?? 0) - (a.x ?? 0)
        const dy = (b.y ?? 0) - (a.y ?? 0)
        const dist = Math.sqrt(dx * dx + dy * dy) || 1
        const minDist = nodeRadius(a) + nodeRadius(b) + padding
        if (dist < minDist) {
          const push = ((minDist - dist) / dist) * alpha * 0.4
          a.x = (a.x ?? 0) - dx * push
          a.y = (a.y ?? 0) - dy * push
          b.x = (b.x ?? 0) + dx * push
          b.y = (b.y ?? 0) + dy * push
        }
      }
    }
  }
  force.initialize = (n: any[]) => { nodes = n }
  return force
}

// ─── Main component ───────────────────────────────────────────────────────────

export function NetworkGraph({ data, selectedNode, onNodeClick }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const graphRef     = useRef<any>(null)
  const [FG, setFG]  = useState<ComponentType<any> | null>(null)
  const [dims, setDims] = useState({ width: 1200, height: 800 })

  useEffect(() => {
    import('react-force-graph-2d').then((m) => setFG(() => m.default))
  }, [])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    if (rect.width > 0) setDims({ width: rect.width, height: rect.height })
    const ro = new ResizeObserver((entries) => {
      const r = entries[0].contentRect
      if (r.width > 0) setDims({ width: r.width, height: r.height })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Zoom to fit after selection changes
  useEffect(() => {
    if (!graphRef.current) return
    setTimeout(() => {
      try { graphRef.current.zoomToFit(400, 80) } catch { /* ignore */ }
    }, 500)
  }, [selectedNode])

  // Tune forces when selection changes
  useEffect(() => {
    if (!graphRef.current || !graphData) return
    // Collision: nodes can't overlap + 16px breathing room
    graphRef.current.d3Force('collision', makeCollisionForce(16))
    // Stronger repulsion spreads nodes further apart
    graphRef.current.d3Force('charge')?.strength(-200)
    // Longer link distance so connected nodes aren't crammed together
    graphRef.current.d3Force('link')?.distance(100)
    graphRef.current.d3ReheatSimulation()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedNode])

  const graphData = useMemo(() => {
    if (!data || !selectedNode) return null
    return buildSubgraph(data, selectedNode)
  }, [data, selectedNode])

  const paintNode = useCallback(
    (node: any, ctx: CanvasRenderingContext2D, globalScale: number) => {
      const r          = nodeRadius(node as GraphNode)
      const isSelected = node.id === selectedNode?.id

      // Glow ring on selected hub
      if (isSelected) {
        ctx.beginPath()
        ctx.arc(node.x, node.y, r + 5, 0, 2 * Math.PI)
        ctx.fillStyle = 'rgba(245,158,11,0.25)'
        ctx.fill()
      }

      // Node circle
      ctx.beginPath()
      ctx.arc(node.x, node.y, r, 0, 2 * Math.PI)
      ctx.fillStyle = isSelected ? C.selected
        : node.type === 'investor' ? C.investor
        : C.stock
      ctx.fill()

      // Label below the node with white pill background
      const fontSize  = Math.max(8, 11 / globalScale)
      const fontWeight = isSelected ? '700' : '500'
      ctx.font = `${fontWeight} ${fontSize}px Inter,system-ui,sans-serif`
      ctx.textAlign    = 'center'
      ctx.textBaseline = 'middle'

      const raw   = node.label as string
      const label = raw.length > 16 ? raw.slice(0, 15) + '…' : raw
      const textW = ctx.measureText(label).width
      const pad   = 2.5
      const textY = node.y + r + fontSize + 2

      // White pill behind text for legibility
      ctx.fillStyle = 'rgba(255,255,255,0.88)'
      ctx.beginPath()
      const bx = node.x - textW / 2 - pad
      const by = textY - fontSize / 2 - pad
      const bw = textW + pad * 2
      const bh = fontSize + pad * 2
      const br = 3
      ctx.moveTo(bx + br, by)
      ctx.lineTo(bx + bw - br, by)
      ctx.arcTo(bx + bw, by, bx + bw, by + bh, br)
      ctx.lineTo(bx + bw, by + bh - br)
      ctx.arcTo(bx + bw, by + bh, bx, by + bh, br)
      ctx.lineTo(bx + br, by + bh)
      ctx.arcTo(bx, by + bh, bx, by, br)
      ctx.lineTo(bx, by + br)
      ctx.arcTo(bx, by, bx + bw, by, br)
      ctx.closePath()
      ctx.fill()

      ctx.fillStyle = '#1f2937'
      ctx.fillText(label, node.x, textY)
    },
    [selectedNode]
  )

  // ── Render states ─────────────────────────────────────────────────────────

  if (!FG) {
    return (
      <div ref={containerRef} className="w-full h-full bg-gray-50 flex items-center justify-center">
        <p className="text-sm text-gray-400 animate-pulse">Loading graph engine…</p>
      </div>
    )
  }

  if (!data || data.nodes.length === 0) {
    return (
      <div ref={containerRef} className="w-full h-full bg-gray-50 flex flex-col items-center justify-center gap-3">
        <p className="text-gray-500 font-medium">No shareholder data</p>
        <p className="text-sm text-gray-400">The shareholders_major table is empty.</p>
      </div>
    )
  }

  if (!selectedNode || !graphData) {
    return (
      <div ref={containerRef} className="w-full h-full bg-gray-50 flex flex-col items-center justify-center gap-2">
        <div className="w-12 h-12 rounded-full bg-blue-100 flex items-center justify-center mb-2">
          <span className="text-2xl">↖</span>
        </div>
        <p className="text-gray-600 font-medium">Select an investor or stock</p>
        <p className="text-sm text-gray-400">
          Click a row in the list, or search above, to explore their ownership network.
        </p>
      </div>
    )
  }

  return (
    <div ref={containerRef} className="w-full h-full relative" style={{ background: C.bg }}>
      <FG
        ref={graphRef}
        graphData={graphData}
        width={dims.width}
        height={dims.height}
        nodeId="id"
        nodeLabel={(n: any) =>
          n.type === 'investor'
            ? `${n.label} · ${n.stock_count} stocks`
            : `${n.label}${n.stock_name ? ' — ' + n.stock_name : ''} · ${n.investor_count} investors`
        }
        nodeCanvasObject={paintNode}
        nodeCanvasObjectMode={() => 'replace'}
        linkColor={() => C.edge}
        linkWidth={(lk: any) => Math.max(0.5, (lk.percentage ?? 0) / 10)}
        onNodeClick={(node: any, evt: MouseEvent) => {
          evt.stopPropagation()
          onNodeClick(selectedNode?.id === node.id ? null : (node as GraphNode))
        }}
        onBackgroundClick={() => onNodeClick(null)}
        onNodeDragEnd={(node: any) => {
          // Pin node at dropped position so it stays put
          node.fx = node.x
          node.fy = node.y
        }}
        cooldownTicks={150}
        d3AlphaDecay={0.02}
        d3VelocityDecay={0.25}
        enableNodeDrag
        nodeRelSize={1}
      />
    </div>
  )
}
