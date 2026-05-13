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
  if (n.type === 'investor') return Math.min(22, 5 + Math.sqrt(n.stock_count ?? 1) * 2)
  return Math.min(12, 4 + Math.sqrt(n.investor_count ?? 1) * 1.5)
}

// Multi-ring "zigzag" layout. Instead of fitting every neighbor on a
// single circle (which forces a huge radius for popular investors and
// makes labels collide at any zoom), distribute them across N concentric
// rings. Adjacent neighbors in index land on different rings, so their
// labels are vertically separated even when angular spacing is tight.
const ARC_PER_NEIGHBOR = 60  // min arc length per neighbor *per ring*
const RING_GAP         = 60  // radial spacing between consecutive rings

function neighborLayout(neighborCount: number) {
  const N = Math.max(1, neighborCount)
  // Add another ring for roughly every 25 neighbors, capped at 5.
  const ringCount  = Math.max(1, Math.min(5, Math.ceil(N / 25)))
  const baseRadius = Math.max(150, (N * ARC_PER_NEIGHBOR) / (2 * Math.PI * ringCount))
  return { ringCount, baseRadius, ringGap: RING_GAP }
}

function neighborPosition(i: number, total: number, layout: ReturnType<typeof neighborLayout>) {
  const angle  = (i * 2 * Math.PI) / Math.max(1, total) - Math.PI / 2
  const radius = layout.baseRadius + (i % layout.ringCount) * layout.ringGap
  return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius }
}

const C = {
  investor:   '#3B82F6',
  stock:      '#10B981',
  selected:   '#F59E0B',
  bg:         '#F9FAFB',
  edge:       'rgba(156,163,175,0.4)',
}

// ─── Build the subgraph for the selected node ─────────────────────────────────

// 1-hop subgraph: the selected node plus everything directly linked to it.
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

// 3-hop subgraph for a stock — four conceptual layers radiating outward:
//   L1: the selected stock itself           (hub)
//   L2: direct shareholders                  (inner ring)
//   L3: each shareholder's other holdings    (middle ring, clustered per shareholder)
//   L4: those secondary stocks' other major  (outer ring, clustered per secondary stock)
//       shareholders (excluding L2 dupes)
// Layout hints are returned so the caller can place nodes by sector / sub-sector.
function buildStockSubgraph(
  data: InvestorGraphData,
  selectedStock: GraphNode,
  perShareholderCap: number,
  perSecondaryStockCap: number,
): {
  nodes: GraphNode[]
  links: GraphLink[]
  shareholderIds: string[]
  secondaryByShareholder: Map<string, string[]>
  tertiaryBySecondaryStock: Map<string, string[]>
} {
  // L2 — direct shareholders, sorted by their stake in the selected stock.
  const sharePct = new Map<string, number>()
  for (const lk of data.links) {
    if (nodeId(lk.target) === selectedStock.id) {
      sharePct.set(nodeId(lk.source), lk.percentage)
    }
  }
  const shareholderIds = Array.from(sharePct.keys())
    .sort((a, b) => (sharePct.get(b) ?? 0) - (sharePct.get(a) ?? 0))

  // L3 — for each shareholder, their top other holdings. A secondary stock
  // is clustered under its first (highest-stake) shareholder so layout is
  // deterministic.
  const secondaryByShareholder = new Map<string, string[]>()
  const placedSecondary = new Set<string>()
  for (const shId of shareholderIds) {
    const candidates: Array<{ id: string; pct: number }> = []
    for (const lk of data.links) {
      if (nodeId(lk.source) !== shId) continue
      const tgt = nodeId(lk.target)
      if (tgt === selectedStock.id) continue
      candidates.push({ id: tgt, pct: lk.percentage })
    }
    candidates.sort((a, b) => b.pct - a.pct)
    const assigned: string[] = []
    for (const c of candidates) {
      if (assigned.length >= perShareholderCap) break
      if (placedSecondary.has(c.id)) continue
      placedSecondary.add(c.id)
      assigned.push(c.id)
    }
    secondaryByShareholder.set(shId, assigned)
  }

  // L4 — for each secondary stock, its top OTHER major shareholders.
  // We skip any investor already in L2 (the inner ring) so we don't render
  // duplicates; same-investor connections still show as cross-edges.
  const tertiaryBySecondaryStock = new Map<string, string[]>()
  const placedTertiary = new Set<string>(shareholderIds)
  for (const stockIds of secondaryByShareholder.values()) {
    for (const stockId of stockIds) {
      if (tertiaryBySecondaryStock.has(stockId)) continue
      const candidates: Array<{ id: string; pct: number }> = []
      for (const lk of data.links) {
        if (nodeId(lk.target) !== stockId) continue
        const src = nodeId(lk.source)
        if (placedTertiary.has(src)) continue
        candidates.push({ id: src, pct: lk.percentage })
      }
      candidates.sort((a, b) => b.pct - a.pct)
      const assigned: string[] = []
      for (const c of candidates) {
        if (assigned.length >= perSecondaryStockCap) break
        if (placedTertiary.has(c.id)) continue
        placedTertiary.add(c.id)
        assigned.push(c.id)
      }
      tertiaryBySecondaryStock.set(stockId, assigned)
    }
  }

  const nodeSet = new Set<string>([selectedStock.id, ...shareholderIds])
  for (const ids of secondaryByShareholder.values()) for (const id of ids) nodeSet.add(id)
  for (const ids of tertiaryBySecondaryStock.values()) for (const id of ids) nodeSet.add(id)

  const nodes = data.nodes.filter((n) => nodeSet.has(n.id)).map((n) => ({ ...n }))
  // Keep every link whose endpoints are both in the subgraph — this draws
  // the cross-edges from a secondary stock to every inner-ring shareholder
  // that owns it, making shared ownership immediately visible.
  const links = data.links
    .filter((lk) => nodeSet.has(nodeId(lk.source)) && nodeSet.has(nodeId(lk.target)))
    .map((lk) => ({ ...lk }))

  return { nodes, links, shareholderIds, secondaryByShareholder, tertiaryBySecondaryStock }
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

  const graphData = useMemo(() => {
    if (!data || !selectedNode) return null

    // ── Stock-centric: flower layout (hub + inner shareholders + outer petals)
    if (selectedNode.type === 'stock') {
      // Cap secondary stocks per shareholder so the outer ring stays
      // navigable. Fewer secondaries when there are many shareholders, since
      // each sector gets a smaller angular slice.
      const tentativeM = Array.from(
        new Set(
          data.links
            .filter((lk) => nodeId(lk.target) === selectedNode.id)
            .map((lk) => nodeId(lk.source))
        )
      ).length
      const perShareholderCap     = Math.max(3, Math.min(6, Math.floor(70 / Math.max(1, tentativeM))))
      const perSecondaryStockCap  = 2  // top-2 other major shareholders per secondary stock (L4)
      const sub = buildStockSubgraph(data, selectedNode, perShareholderCap, perSecondaryStockCap)
      const M   = sub.shareholderIds.length

      // Pin hub at origin
      for (const n of sub.nodes) {
        if (n.id === selectedNode.id) {
          ;(n as any).fx = 0
          ;(n as any).fy = 0
        }
      }

      if (M === 0) return { nodes: sub.nodes, links: sub.links }

      // Inner ring of shareholders, evenly spaced.
      const innerR = Math.max(170, (M * 70) / (2 * Math.PI))
      const sectorSize = (2 * Math.PI) / M
      // Outer ring radius: large enough that the busiest shareholder's
      // secondary stocks fit comfortably inside its angular sector.
      const maxK = Math.max(
        1,
        ...Array.from(sub.secondaryByShareholder.values()).map((arr) => arr.length),
      )
      const sectorArc = sectorSize * 0.78   // leave ~22% breathing room
      const outerR   = Math.max(innerR + 130, (maxK * 60) / Math.max(0.05, sectorArc))

      // L4 (tertiary) ring radius — far enough from the L3 stocks that
      // their labels don't collide. Computed from the busiest sub-sector.
      const tertiaryK   = Math.max(1, perSecondaryStockCap)
      const tertiaryR   = outerR + 140 + tertiaryK * 18

      sub.shareholderIds.forEach((shId, i) => {
        const angle = i * sectorSize - Math.PI / 2
        const node  = sub.nodes.find((nd) => nd.id === shId)
        if (node) {
          ;(node as any).fx = Math.cos(angle) * innerR
          ;(node as any).fy = Math.sin(angle) * innerR
        }

        // L3: fan this shareholder's other stocks across its sector.
        const stocks = sub.secondaryByShareholder.get(shId) ?? []
        const K = stocks.length
        const subSectorWidth = K > 0 ? sectorArc / K : 0
        stocks.forEach((stockId, j) => {
          const offset = K === 1 ? 0 : (j / (K - 1) - 0.5) * sectorArc
          const stockAngle = angle + offset
          const stockNode = sub.nodes.find((nd) => nd.id === stockId)
          if (stockNode) {
            ;(stockNode as any).fx = Math.cos(stockAngle) * outerR
            ;(stockNode as any).fy = Math.sin(stockAngle) * outerR
          }

          // L4: tertiary shareholders fan around this stock within its
          // sub-sector. Width capped to a fraction of the sub-sector so
          // adjacent stocks' L4 clusters don't overlap.
          const tertiaries = sub.tertiaryBySecondaryStock.get(stockId) ?? []
          const T = tertiaries.length
          const subSubArc = Math.max(0.05, subSectorWidth * 0.7)
          tertiaries.forEach((tertId, t) => {
            const tOffset = T === 1 ? 0 : (t / (T - 1) - 0.5) * subSubArc
            const tAngle  = stockAngle + tOffset
            const tNode   = sub.nodes.find((nd) => nd.id === tertId)
            if (tNode) {
              ;(tNode as any).fx = Math.cos(tAngle) * tertiaryR
              ;(tNode as any).fy = Math.sin(tAngle) * tertiaryR
            }
          })
        })
      })

      // Only forward {nodes, links} to react-force-graph — extra props like
      // the Map of layout hints can trip up its prop diffing / re-init.
      return { nodes: sub.nodes, links: sub.links }
    }

    // ── Investor-centric: existing 1-hop concentric-ring layout
    const sub = buildSubgraph(data, selectedNode)
    const neighbors = sub.nodes.filter((n) => n.id !== selectedNode.id)
    const layout = neighborLayout(neighbors.length)
    for (const n of sub.nodes) {
      if (n.id === selectedNode.id) {
        ;(n as any).fx = 0
        ;(n as any).fy = 0
      }
    }
    neighbors.forEach((n, i) => {
      const pos = neighborPosition(i, neighbors.length, layout)
      ;(n as any).fx = pos.x
      ;(n as any).fy = pos.y
    })
    return sub
  }, [data, selectedNode])

  // Re-fit the camera whenever the subgraph changes. Nodes are pinned at
  // explicit fx/fy, so the layout is settled the moment graphData hits the
  // engine — we don't need to wait for onEngineStop to maybe fire.
  useEffect(() => {
    if (!graphRef.current || !graphData) return
    const t = setTimeout(() => {
      try { graphRef.current?.zoomToFit(400, 100) } catch { /* ignore */ }
    }, 50)
    return () => clearTimeout(t)
  }, [graphData])

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

      // Constant-screen-size labels: zigzag layout already prevents
      // collisions, so we want labels to stay readable at every zoom level.
      const fontSize   = Math.max(8, 11 / globalScale)
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

  // Larger transparent hit-target around each node so the graph is forgiving
  // of small nodes / dense rings. The painted area is invisible — only used
  // by react-force-graph's pointer hit-testing.
  const paintNodePointerArea = useCallback(
    (node: any, color: string, ctx: CanvasRenderingContext2D) => {
      const r = Math.max(14, nodeRadius(node as GraphNode) * 2.4)
      ctx.fillStyle = color
      ctx.beginPath()
      ctx.arc(node.x, node.y, r, 0, 2 * Math.PI)
      ctx.fill()
    },
    [],
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
        nodePointerAreaPaint={paintNodePointerArea}
        linkColor={() => C.edge}
        linkWidth={(lk: any) => Math.max(0.5, (lk.percentage ?? 0) / 10)}
        onNodeClick={(node: any, evt: MouseEvent) => {
          evt.stopPropagation()
          // Keep the existing selection if user re-clicks the hub — toggling
          // off into the empty state mid-exploration is jarring. Use the
          // panel's ✕ button (or List view) to clear.
          if (selectedNode?.id !== node.id) onNodeClick(node as GraphNode)
        }}
        onNodeDragEnd={(node: any) => {
          // Pin node at dropped position so it stays put
          node.fx = node.x
          node.fy = node.y
        }}
        onEngineStop={() => {
          try { graphRef.current?.zoomToFit(400, 80) } catch { /* ignore */ }
        }}
        // Nodes are pinned via fx/fy, so the simulation has nothing to
        // converge — burn just a handful of ticks and stop, so navigation
        // between selections stays snappy.
        cooldownTicks={30}
        d3AlphaDecay={0.05}
        d3VelocityDecay={0.4}
        enableNodeDrag
        nodeRelSize={1}
      />
    </div>
  )
}
