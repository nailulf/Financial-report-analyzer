'use client'

import { useState, useEffect, useRef } from 'react'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell,
} from 'recharts'

// Segmen pendapatan — ganti dengan data segmen aktual saat tersedia
const MOCK_SEGMENTS = [
  { name: 'Pendapatan Bunga',   value: 68, color: '#00FF88' },
  { name: 'Fee & Komisi',       value: 18, color: '#3B82F6' },
  { name: 'Pendapatan Trading', value:  8, color: '#8B5CF6' },
  { name: 'Digital / Lainnya',  value:  6, color: '#F59E0B' },
]

// Definisi diagram alur Mermaid
const FLOW_CHART = `graph LR
  A["Simpanan<br/>CASA 80%"] -->|Dana murah| B["Penyaluran Kredit"]
  A -->|Biaya pemrosesan| C["Layanan Fee"]
  B -->|Spread bunga| D["Pend. Bunga Bersih"]
  C -->|Komisi| E["Pend. Non-Bunga"]
  D --> F["Pendapatan Bersih"]
  E --> F
  G["Perbankan Digital"] -->|Transaksi| C
  style A fill:#1a1a1a,stroke:#00FF88,color:#00FF88
  style F fill:#00FF8815,stroke:#00FF88,color:#1a1a1a`

function MermaidDiagram({ chart }: { chart: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
    let cancelled = false

    import('mermaid').then((m) => {
      if (cancelled) return
      m.default.initialize({
        startOnLoad: false,
        theme: 'base',
        themeVariables: {
          primaryColor: '#f5f5f8',
          primaryTextColor: '#1a1a1a',
          primaryBorderColor: '#E0E0E5',
          lineColor: '#888888',
          background: '#ffffff',
          fontFamily: 'JetBrains Mono, monospace',
          fontSize: '11px',
        },
      })
      const id = `mermaid-${Math.random().toString(36).slice(2)}`
      m.default
        .render(id, chart)
        .then(({ svg }) => {
          if (!cancelled && ref.current) ref.current.innerHTML = svg
        })
        .catch(() => {
          if (!cancelled && ref.current)
            ref.current.innerHTML =
              '<span style="font-family:monospace;font-size:11px;color:#888">Diagram tidak tersedia — pasang mermaid</span>'
        })
    })

    return () => { cancelled = true }
  }, [chart])

  if (!mounted) return <div className="h-40 bg-[#F5F5F8] animate-pulse rounded" />
  return <div ref={ref} className="flex justify-center overflow-auto" />
}

export function ProductsWidget() {
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  return (
    <div className="px-12 py-2">
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <span className="font-mono text-[13px] font-bold tracking-[0.5px] text-[#1A1A1A]">
            PRODUK, SEGMEN &amp; MODEL BISNIS
          </span>
          <span className="font-mono text-[11px] text-[#888888] tracking-[0.5px]">
            BAGAIMANA PERUSAHAAN MENGHASILKAN PENDAPATAN
          </span>
        </div>

        <div className="flex gap-2">
          {/* Flow diagram card */}
          <div className="flex-1 bg-white border border-[#E0E0E5] p-5 flex flex-col gap-3">
            <span className="font-mono text-[12px] font-bold text-[#888888] tracking-[0.5px] uppercase">
              ALUR PENDAPATAN
            </span>
            <MermaidDiagram chart={FLOW_CHART} />
            <span className="font-mono text-[11px] text-[#888888]">
              * Alur ilustrasi — perbarui sesuai model bisnis aktual
            </span>
          </div>

          {/* Revenue segments bar chart */}
          <div className="w-[520px] bg-white border border-[#E0E0E5] p-5 flex flex-col gap-3">
            <span className="font-mono text-[12px] font-bold text-[#888888] tracking-[0.5px] uppercase">
              SEGMEN PENDAPATAN (%)
            </span>
            {mounted ? (
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={MOCK_SEGMENTS} layout="vertical" margin={{ left: 8, right: 24 }}>
                  <XAxis
                    type="number"
                    domain={[0, 100]}
                    tick={{ fontFamily: 'JetBrains Mono', fontSize: 10, fill: '#888888' }}
                    tickFormatter={(v) => `${v}%`}
                  />
                  <YAxis
                    type="category"
                    dataKey="name"
                    width={110}
                    tick={{ fontFamily: 'JetBrains Mono', fontSize: 10, fill: '#555555' }}
                  />
                  <Tooltip
                    formatter={(v: number) => [`${v}%`, 'Porsi']}
                    contentStyle={{ fontFamily: 'JetBrains Mono', fontSize: 10, border: '1px solid #E0E0E5' }}
                  />
                  <Bar dataKey="value" radius={[0, 2, 2, 0]}>
                    {MOCK_SEGMENTS.map((entry, i) => (
                      <Cell key={i} fill={entry.color} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-[200px] bg-[#F5F5F8] animate-pulse" />
            )}
            <span className="font-mono text-[11px] text-[#888888]">
              * Rincian ilustrasi — ganti dengan data segmen aktual
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}
