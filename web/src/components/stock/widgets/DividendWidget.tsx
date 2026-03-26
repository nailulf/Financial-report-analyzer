'use client'

import { useState, useEffect, useMemo } from 'react'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'
import type { AnnualDPS } from '@/lib/queries/dividends'
import type { FinancialYear } from '@/lib/types/api'
import { fmtNumID, formatPercent } from '@/lib/calculations/formatters'

/* ─── props ──────────────────────────────────────────────────────── */

interface DividendWidgetProps {
  dividendHistory: AnnualDPS[]
  series: FinancialYear[]
  dividendYield: number | null
  price: number | null
}

/* ─── helpers ────────────────────────────────────────────────────── */

function computeCAGR(values: AnnualDPS[]): number | null {
  if (values.length < 2) return null
  const first = values[0].dps
  const last = values[values.length - 1].dps
  if (first <= 0 || last <= 0) return null
  const years = values[values.length - 1].year - values[0].year
  if (years <= 0) return null
  return (Math.pow(last / first, 1 / years) - 1) * 100
}

function computePayoutRatio(series: FinancialYear[]): number | null {
  // Find the most recent year where we have both dividends_paid and net_income
  for (let i = series.length - 1; i >= 0; i--) {
    const row = series[i]
    const dp = row.dividends_paid
    const ni = row.net_income
    if (dp != null && ni != null && ni > 0) {
      return (Math.abs(dp) / ni) * 100
    }
  }
  return null
}

/* ─── tooltip ────────────────────────────────────────────────────── */

function ChartTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null
  const v = payload[0]?.value ?? 0
  return (
    <div className="bg-white border border-[#E0E0E5] px-3 py-2 shadow-sm font-mono text-[11px]">
      <div className="font-bold text-[#1A1A1A] mb-1">{label}</div>
      <div className="flex items-center gap-2">
        <span className="w-2 h-2 rounded-full shrink-0 bg-[#00FF88]" />
        <span className="text-[#888888]">DPS:</span>
        <span className="text-[#1A1A1A]">Rp {fmtNumID(v)}</span>
      </div>
    </div>
  )
}

/* ─── widget ─────────────────────────────────────────────────────── */

export function DividendWidget({
  dividendHistory,
  series,
  dividendYield,
  price,
}: DividendWidgetProps) {
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  const hasData = dividendHistory.length > 0

  // Chart data — last 10 years max
  const chartData = useMemo(() => {
    return dividendHistory.slice(-10).map((d) => ({
      year: d.year.toString(),
      dps: d.dps,
    }))
  }, [dividendHistory])

  // Computed stats
  const latestDPS = hasData ? dividendHistory[dividendHistory.length - 1].dps : null
  const fiveYearData = dividendHistory.slice(-5)
  const cagr5y = fiveYearData.length >= 2 ? computeCAGR(fiveYearData) : null

  const payoutRatio = computePayoutRatio(series)

  // Compute yield from DPS/price if not provided by metrics
  const yieldTTM = dividendYield
    ?? (latestDPS != null && price != null && price > 0
      ? (latestDPS / price) * 100
      : null)

  const stats = [
    {
      label: 'DPS TERAKHIR',
      value: latestDPS != null ? `Rp ${fmtNumID(latestDPS)}` : '—',
    },
    {
      label: '5Y CAGR',
      value: cagr5y != null ? formatPercent(cagr5y) : '—',
      color: cagr5y != null ? (cagr5y > 0 ? '#006633' : '#CC3333') : undefined,
    },
    {
      label: 'PAYOUT RATIO',
      value: payoutRatio != null ? formatPercent(payoutRatio) : '—',
    },
    {
      label: 'YIELD TTM',
      value: yieldTTM != null ? formatPercent(yieldTTM) : '—',
      color: yieldTTM != null ? (yieldTTM >= 3 ? '#006633' : '#1A1A1A') : undefined,
    },
  ]

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
          {stats.map((s) => (
            <div key={s.label} className="bg-[#F5F5F8] p-3 flex flex-col gap-1">
              <span className="font-mono text-[11px] text-[#888888] tracking-[0.5px] uppercase">
                {s.label}
              </span>
              <span
                className="font-mono text-[15px] font-semibold"
                style={{ color: s.color ?? '#1A1A1A' }}
              >
                {s.value}
              </span>
            </div>
          ))}
        </div>

        {/* DPS bar chart */}
        {hasData ? (
          mounted ? (
            <ResponsiveContainer width="100%" height={160}>
              <BarChart data={chartData}>
                <XAxis
                  dataKey="year"
                  tick={{ fontFamily: 'JetBrains Mono', fontSize: 10, fill: '#888888' }}
                />
                <YAxis
                  tick={{ fontFamily: 'JetBrains Mono', fontSize: 10, fill: '#888888' }}
                  tickFormatter={(v: number) => fmtNumID(v)}
                />
                <Tooltip content={<ChartTooltip />} />
                <Bar dataKey="dps" fill="#00FF88" radius={[2, 2, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-40 bg-[#F5F5F8] animate-pulse" />
          )
        ) : (
          <div className="h-40 flex items-center justify-center bg-[#F5F5F8]">
            <span className="font-mono text-[12px] text-[#888888]">
              Belum ada data dividen — jalankan: python run_all.py --dividends --ticker [TICKER]
            </span>
          </div>
        )}

        {hasData && (
          <div className="flex items-center justify-between bg-[#00FF8818] border border-[#00FF8830] px-3 py-2.5">
            <span className="font-mono text-[12px] text-[#888888]">
              Rekam jejak dividen {chartData.length} tahun
            </span>
            <span className="font-mono text-[11px] text-[#888888]">
              Sumber: yfinance
            </span>
          </div>
        )}
      </div>
    </div>
  )
}
