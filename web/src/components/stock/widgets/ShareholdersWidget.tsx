'use client'

import { useState } from 'react'
import type { Shareholder } from '@/lib/types/api'

const MONTHS = ['Jan','Feb','Mar','Apr','Mei','Jun','Jul','Agu','Sep','Okt','Nov','Des']

function fmtDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  return d ? `${d} ${MONTHS[m - 1]} ${y}` : `${MONTHS[m - 1]} ${y}`
}

function typeLabel(t: string | null): string {
  switch (t) {
    case 'government':  return 'PEM'
    case 'institution': return 'INST'
    case 'individual':  return 'IND'
    case 'public':      return 'PUBLIK'
    default:            return t?.toUpperCase() ?? '—'
  }
}

function typeBg(t: string | null): string {
  switch (t) {
    case 'government':  return 'bg-blue-50 text-blue-700 border-blue-200'
    case 'institution': return 'bg-purple-50 text-purple-700 border-purple-200'
    case 'individual':  return 'bg-amber-50 text-amber-700 border-amber-200'
    default:            return 'bg-[#F5F5F8] text-[#888888] border-[#E0E0E5]'
  }
}

interface Props {
  shareholders: Shareholder[]
  shareholderHistory?: Shareholder[][]
}

export function ShareholdersWidget({ shareholders, shareholderHistory = [] }: Props) {
  const historyDates = shareholderHistory
    .map((snap) => snap[0]?.report_date ?? null)
    .filter(Boolean) as string[]

  const [selectedIdx, setSelectedIdx] = useState(0)

  const displayed =
    shareholderHistory.length > 0
      ? (shareholderHistory[selectedIdx] ?? shareholders)
      : shareholders

  const snapshotDate = displayed[0]?.report_date ?? null
  const total = displayed.reduce((sum, s) => sum + (s.percentage ?? 0), 0)

  if (displayed.length === 0) {
    return (
      <div className="bg-white border border-[#E0E0E5] px-5 py-4">
        <span className="font-mono text-[13px] text-[#888888]">Tidak ada data pemegang saham</span>
      </div>
    )
  }

  return (
    <div className="bg-white border border-[#E0E0E5] flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-3 border-b border-[#E0E0E5]">
        <div className="flex flex-col gap-0.5">
          <span className="font-mono text-[13px] font-bold tracking-[0.5px] text-[#1A1A1A]">PEMEGANG SAHAM</span>
          {snapshotDate && (
            <span className="font-mono text-[11px] text-[#888888]">Per tanggal {fmtDate(snapshotDate)}</span>
          )}
        </div>
        {historyDates.length > 1 && (
          <select
            value={selectedIdx}
            onChange={(e) => setSelectedIdx(Number(e.target.value))}
            className="font-mono text-[12px] border border-[#E0E0E5] px-2 py-1 text-[#555555] bg-white focus:outline-none"
          >
            {historyDates.map((d, i) => (
              <option key={d} value={i}>
                {fmtDate(d)}{i === 0 ? ' (terbaru)' : ''}
              </option>
            ))}
          </select>
        )}
      </div>

      {/* Column headers */}
      <div className="flex items-center bg-[#F5F5F8] px-3 py-2">
        <span className="font-mono text-[11px] font-bold text-[#888888] tracking-[0.5px] flex-1">PEMEGANG SAHAM</span>
        <span className="font-mono text-[11px] font-bold text-[#888888] tracking-[0.5px] w-14">TIPE</span>
        <span className="font-mono text-[11px] font-bold text-[#888888] tracking-[0.5px] w-14 text-right">%</span>
      </div>

      {/* Rows */}
      {displayed.map((s, i) => (
        <div key={i} className="px-3 py-2 border-b border-[#E0E0E5] last:border-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="font-mono text-[13px] text-[#1A1A1A] flex-1 truncate">{s.holder_name}</span>
            {s.holder_type && (
              <span className={`font-mono text-[11px] font-bold px-1.5 py-0.5 border ${typeBg(s.holder_type)}`}>
                {typeLabel(s.holder_type)}
              </span>
            )}
            <span className="font-mono text-[13px] font-semibold text-[#1A1A1A] w-14 text-right">
              {s.percentage != null ? `${s.percentage.toFixed(2)}%` : '—'}
            </span>
          </div>
          {s.percentage != null && (
            <div className="h-1 bg-[#E0E0E5]">
              <div
                className="h-full bg-[#00FF88]"
                style={{ width: `${Math.min(s.percentage, 100)}%` }}
              />
            </div>
          )}
        </div>
      ))}

      {/* Summary footer */}
      <div className="flex items-center justify-between bg-[#F5F5F8] px-3 py-2.5">
        <span className="font-mono text-[12px] text-[#888888]">{displayed.length} pemegang saham ditampilkan (≥1%)</span>
        <span className="font-mono text-[12px] font-semibold text-[#1A1A1A]">
          Ditampilkan: {total.toFixed(2)}%
        </span>
      </div>
    </div>
  )
}
