'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import type { FlowScoreRow } from '@/lib/queries/money-flow'
import { ChartSkeleton } from '@/components/ui/loading-skeleton'
import { formatIDRCompact } from '@/lib/calculations/formatters'

// ─── Score badge ─────────────────────────────────────────────────────────────

export function FlowScoreBadge({ score, size = 'sm' }: { score: number; size?: 'sm' | 'lg' }) {
  const { label, bg, text } =
    score >= 70 ? { label: 'Kuat',      bg: 'bg-green-100',  text: 'text-green-700' } :
    score >= 51 ? { label: 'Akumulasi', bg: 'bg-emerald-50', text: 'text-emerald-600' } :
    score >= 40 ? { label: 'Netral',    bg: 'bg-gray-100',   text: 'text-gray-500' } :
    score >= 25 ? { label: 'Lemah',     bg: 'bg-orange-50',  text: 'text-orange-600' } :
                  { label: 'Distribusi',bg: 'bg-red-50',     text: 'text-red-600' }

  if (size === 'lg') {
    return (
      <div className={`inline-flex flex-col items-center rounded-xl px-4 py-2 ${bg}`}>
        <span className={`text-2xl font-bold tabular-nums ${text}`}>{score}</span>
        <span className={`text-xs font-semibold uppercase tracking-wide ${text}`}>{label}</span>
      </div>
    )
  }

  return (
    <span className={`inline-flex items-center gap-1 text-xs font-semibold rounded-full px-2 py-0.5 ${bg} ${text}`}>
      <span className="tabular-nums">{score}</span>
      <span>{label}</span>
    </span>
  )
}

// ─── Score bar (visual 0–100 indicator) ──────────────────────────────────────

function ScoreBar({ score }: { score: number }) {
  const color =
    score >= 70 ? 'bg-green-500' :
    score >= 51 ? 'bg-emerald-400' :
    score >= 40 ? 'bg-gray-300' :
    score >= 25 ? 'bg-orange-400' :
    'bg-red-500'

  return (
    <div className="w-16 h-1.5 bg-gray-100 rounded-full overflow-hidden">
      <div className={`h-full rounded-full ${color}`} style={{ width: `${score}%` }} />
    </div>
  )
}

// ─── Component breakdown tooltip ─────────────────────────────────────────────

function ScoreBreakdown({ row }: { row: FlowScoreRow }) {
  return (
    <div className="flex items-center gap-3 text-xs text-gray-400">
      <span title="Foreign flow score">
        🌍 <span className="tabular-nums">{row.foreign_score}</span>
      </span>
      <span title="Volume × price score">
        📊 <span className="tabular-nums">{row.volume_score}</span>
      </span>
      <span title="Price momentum score">
        📈 <span className="tabular-nums">{row.price_score}</span>
      </span>
    </div>
  )
}

// ─── Row in the leaderboard ───────────────────────────────────────────────────

function ScoreRow({ row, rank }: { row: FlowScoreRow; rank: number }) {
  return (
    <tr className="hover:bg-gray-50">
      <td className="py-2 pr-3 text-xs text-gray-300 tabular-nums">{rank}</td>
      <td className="py-2 pr-4">
        <Link
          href={`/stock/${row.ticker}`}
          className="font-mono font-bold text-blue-600 hover:underline text-sm"
        >
          {row.ticker}
        </Link>
        {row.name && (
          <div className="text-xs text-gray-400 truncate max-w-[120px]">{row.name}</div>
        )}
      </td>
      <td className="py-2 pr-4">
        <div className="flex flex-col gap-1">
          <ScoreBar score={row.flow_score} />
          <ScoreBreakdown row={row} />
        </div>
      </td>
      <td className="py-2 pr-4 text-right">
        <FlowScoreBadge score={row.flow_score} />
      </td>
      <td className="py-2 pr-3 text-right font-mono text-xs tabular-nums">
        {row.pct_change_5d != null ? (
          <span className={row.pct_change_5d >= 0 ? 'text-green-600' : 'text-red-500'}>
            {row.pct_change_5d >= 0 ? '+' : ''}{row.pct_change_5d.toFixed(1)}%
          </span>
        ) : '—'}
      </td>
      <td className="py-2 text-right font-mono text-xs text-gray-500 tabular-nums">
        {row.foreign_net_5d != null ? formatIDRCompact(row.foreign_net_5d) : '—'}
      </td>
    </tr>
  )
}

// ─── Main section ─────────────────────────────────────────────────────────────

interface Props {
  bullish: FlowScoreRow[]
  bearish: FlowScoreRow[]
}

const SCORE_LEGEND = [
  { range: '70–100', label: 'Kuat',       desc: 'Strong accumulation', color: 'bg-green-500' },
  { range: '51–69',  label: 'Akumulasi',  desc: 'Mild accumulation',   color: 'bg-emerald-400' },
  { range: '40–50',  label: 'Netral',     desc: 'No clear signal',     color: 'bg-gray-300' },
  { range: '25–39',  label: 'Lemah',      desc: 'Mild distribution',   color: 'bg-orange-400' },
  { range: '0–24',   label: 'Distribusi', desc: 'Strong distribution', color: 'bg-red-500' },
]

function ScoreTable({ rows, title, emptyMsg }: { rows: FlowScoreRow[]; title: string; emptyMsg: string }) {
  return (
    <div>
      <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">{title}</h3>
      {rows.length === 0 ? (
        <div className="h-32 flex items-center justify-center text-sm text-gray-400">{emptyMsg}</div>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100">
              <th className="text-left py-1.5 pr-3 text-xs font-semibold text-gray-400 w-6">#</th>
              <th className="text-left py-1.5 pr-4 text-xs font-semibold text-gray-400">Ticker</th>
              <th className="text-left py-1.5 pr-4 text-xs font-semibold text-gray-400">Signal</th>
              <th className="text-right py-1.5 pr-4 text-xs font-semibold text-gray-400">Score</th>
              <th className="text-right py-1.5 pr-3 text-xs font-semibold text-gray-400">5D Chg</th>
              <th className="text-right py-1.5 text-xs font-semibold text-gray-400">Foreign 5D</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {rows.map((row, i) => (
              <ScoreRow key={row.ticker} row={row} rank={i + 1} />
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

export function FlowScoreSection({ bullish, bearish }: Props) {
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  if (!mounted) return <ChartSkeleton height={400} />

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-6">
      <div className="flex items-start justify-between flex-wrap gap-4 mb-5">
        <div>
          <h2 className="text-sm font-semibold text-gray-700">Flow Score</h2>
          <p className="text-xs text-gray-400 mt-0.5">
            Composite accumulation/distribution signal — foreign flow (50%) + volume (25%) + price (25%)
          </p>
        </div>
        {/* Legend */}
        <div className="flex items-center gap-3 flex-wrap">
          {SCORE_LEGEND.map(({ range, label, color }) => (
            <div key={range} className="flex items-center gap-1.5 text-xs text-gray-500">
              <div className={`w-2 h-2 rounded-full ${color}`} />
              <span className="font-medium">{label}</span>
              <span className="text-gray-300">{range}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        <div>
          <div className="flex items-center gap-2 mb-3">
            <div className="w-3 h-3 rounded-full bg-green-500" />
            <span className="text-xs font-semibold text-green-700">Top Accumulation</span>
          </div>
          <ScoreTable
            rows={bullish}
            title=""
            emptyMsg="No bullish signals"
          />
        </div>
        <div>
          <div className="flex items-center gap-2 mb-3">
            <div className="w-3 h-3 rounded-full bg-red-500" />
            <span className="text-xs font-semibold text-red-600">Top Distribution</span>
          </div>
          <ScoreTable
            rows={bearish}
            title=""
            emptyMsg="No bearish signals"
          />
        </div>
      </div>
    </div>
  )
}
