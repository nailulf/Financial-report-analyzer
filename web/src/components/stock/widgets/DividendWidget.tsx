'use client'

import { useState, useEffect } from 'react'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'

// Riwayat dividen — ganti dengan data dividen aktual saat tersedia
const MOCK_DATA = [
  { year: '2021', dps: 0 },
  { year: '2022', dps: 0 },
  { year: '2023', dps: 0 },
  { year: '2024', dps: 0 },
  { year: '2025', dps: 0 },
]

const SUMMARY_STATS = [
  { label: 'DPS TERAKHIR', value: 'Rp —' },
  { label: '5Y CAGR',      value: '—' },
  { label: 'PAYOUT RATIO', value: '—' },
  { label: 'YIELD TTM',    value: '—' },
]

export function DividendWidget() {
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  return (
    <div className="bg-white border border-[#E0E0E5] flex flex-col">
      <div className="px-5 py-3 border-b border-[#E0E0E5]">
        <span className="font-mono text-[13px] font-bold tracking-[0.5px] text-[#1A1A1A]">
          RIWAYAT &amp; YIELD DIVIDEN
        </span>
      </div>

      <div className="p-5 flex flex-col gap-3">
        {/* Summary stats */}
        <div className="grid grid-cols-4 gap-2">
          {SUMMARY_STATS.map((s) => (
            <div key={s.label} className="bg-[#F5F5F8] p-3 flex flex-col gap-1">
              <span className="font-mono text-[11px] text-[#888888] tracking-[0.5px] uppercase">{s.label}</span>
              <span className="font-mono text-[15px] font-semibold text-[#1A1A1A]">{s.value}</span>
            </div>
          ))}
        </div>

        {/* DPS bar chart */}
        {mounted ? (
          <ResponsiveContainer width="100%" height={160}>
            <BarChart data={MOCK_DATA}>
              <XAxis
                dataKey="year"
                tick={{ fontFamily: 'JetBrains Mono', fontSize: 10, fill: '#888888' }}
              />
              <YAxis tick={{ fontFamily: 'JetBrains Mono', fontSize: 10, fill: '#888888' }} />
              <Tooltip
                contentStyle={{ fontFamily: 'JetBrains Mono', fontSize: 10, border: '1px solid #E0E0E5' }}
                formatter={(v: number) => [`Rp ${v.toLocaleString('id-ID')}`, 'DPS']}
              />
              <Bar dataKey="dps" fill="#00FF88" radius={[2, 2, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        ) : (
          <div className="h-40 bg-[#F5F5F8] animate-pulse" />
        )}

        <div className="flex items-center justify-between bg-[#00FF8818] border border-[#00FF8830] px-3 py-2.5">
          <span className="font-mono text-[12px] text-[#888888]">Rekam jejak dividen 5 tahun</span>
          <span className="font-mono text-[11px] text-[#888888]">
            * Data ilustrasi — hubungkan sumber data dividen
          </span>
        </div>
      </div>
    </div>
  )
}
