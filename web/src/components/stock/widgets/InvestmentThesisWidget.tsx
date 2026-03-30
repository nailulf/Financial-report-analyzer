'use client'

import { useState, useEffect } from 'react'
import type { AIAnalysis } from '@/lib/types/api'

interface Props {
  ticker: string
}

function ProbabilityBadge({ probability }: { probability: string }) {
  const colors: Record<string, string> = {
    high:   'bg-green-100 text-green-700 border-green-200',
    medium: 'bg-amber-100 text-amber-700 border-amber-200',
    low:    'bg-red-100 text-red-600 border-red-200',
  }
  return (
    <span className={`font-mono text-[9px] font-bold tracking-[0.5px] px-1.5 py-0.5 rounded border ${colors[probability] ?? 'bg-gray-100 text-gray-600 border-gray-200'}`}>
      {probability.toUpperCase()}
    </span>
  )
}

function fmtPrice(n: number | null | undefined): string {
  if (n == null) return '—'
  return `Rp ${n.toLocaleString('en')}`
}

function ScenarioCard({ label, color, icon, scenario, drivers, priceLabel, priceValue, timeframe, probability, signals }: {
  label: string
  color: string
  icon: string
  scenario: string
  drivers: string[]
  priceLabel: string
  priceValue: string
  timeframe: string
  probability: string
  signals: string[]
}) {
  return (
    <div className={`border rounded-lg overflow-hidden ${color}`}>
      {/* Header */}
      <div className="px-4 py-2 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-sm">{icon}</span>
          <span className="font-mono text-[12px] font-bold tracking-[0.5px] text-[#1A1A1A]">{label}</span>
        </div>
        <div className="flex items-center gap-2">
          <ProbabilityBadge probability={probability} />
          <span className="font-mono text-[10px] text-[#888888]">{timeframe}</span>
        </div>
      </div>

      {/* Scenario narrative */}
      <div className="px-4 pb-3">
        <p className="font-mono text-[12px] text-[#555555] leading-[1.6] mb-2">{scenario}</p>

        {/* Price target */}
        <div className="flex items-center gap-2 mb-2">
          <span className="font-mono text-[10px] text-[#888888]">{priceLabel}:</span>
          <span className="font-mono text-[12px] font-bold text-[#1A1A1A]">{priceValue}</span>
        </div>

        {/* Drivers */}
        {drivers.length > 0 && (
          <div className="flex flex-col gap-1">
            <span className="font-mono text-[9px] font-bold tracking-[0.5px] text-[#AAAAAA] uppercase">Faktor Pendorong</span>
            {drivers.map((d, i) => (
              <div key={i} className="flex items-start gap-1.5">
                <span className="font-mono text-[10px] text-[#888888] mt-0.5 shrink-0">•</span>
                <span className="font-mono text-[11px] text-[#666666] leading-[1.4]">{d}</span>
              </div>
            ))}
          </div>
        )}

        {/* Early signs / what breaks it */}
        {signals.length > 0 && (
          <div className="flex flex-col gap-1 mt-2">
            <span className="font-mono text-[9px] font-bold tracking-[0.5px] text-[#AAAAAA] uppercase">Tanda Awal</span>
            {signals.map((s, i) => (
              <div key={i} className="flex items-start gap-1.5">
                <span className="font-mono text-[10px] text-[#888888] mt-0.5 shrink-0">▸</span>
                <span className="font-mono text-[11px] text-[#666666] leading-[1.4]">{s}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

export function InvestmentThesisWidget({ ticker }: Props) {
  const [data, setData] = useState<AIAnalysis | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch(`/api/stocks/${ticker}/ai-analysis`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setData(d))
      .catch(() => null)
      .finally(() => setLoading(false))
  }, [ticker])

  if (loading) {
    return (
      <div className="bg-white border border-[#E0E0E5] flex flex-col h-full">
        <div className="px-5 py-3 border-b border-[#E0E0E5]">
          <span className="font-mono text-[13px] font-bold tracking-[0.5px] text-[#1A1A1A]">TESIS INVESTASI</span>
        </div>
        <div className="p-5 animate-pulse space-y-3">
          <div className="h-24 bg-[#F5F4F1] rounded" />
          <div className="h-24 bg-[#F5F4F1] rounded" />
          <div className="h-24 bg-[#F5F4F1] rounded" />
        </div>
      </div>
    )
  }

  if (!data) {
    return (
      <div className="bg-white border border-[#E0E0E5] flex flex-col h-full">
        <div className="px-5 py-3 border-b border-[#E0E0E5]">
          <span className="font-mono text-[13px] font-bold tracking-[0.5px] text-[#1A1A1A]">TESIS INVESTASI</span>
        </div>
        <div className="p-5">
          <p className="font-mono text-[12px] text-[#888888]">
            Belum tersedia — jalankan pipeline AI untuk menghasilkan tesis investasi dengan 3 skenario.
          </p>
        </div>
      </div>
    )
  }

  const bull = data.bullCase
  const bear = data.bearCase
  const neutral = data.neutralCase

  return (
    <div className="bg-white border border-[#E0E0E5] flex flex-col h-full">
      {/* Header */}
      <div className="px-5 py-3 border-b border-[#E0E0E5]">
        <span className="font-mono text-[13px] font-bold tracking-[0.5px] text-[#1A1A1A]">TESIS INVESTASI</span>
      </div>

      <div className="p-5 flex flex-col gap-4 flex-1">

        {/* Lynch rationale */}
        {data.lynchRationale && (
          <p className="font-mono text-[12px] text-[#555555] leading-[1.5] italic">
            "{data.lynchRationale}"
          </p>
        )}

        {/* 3 Scenarios */}
        {bull && (
          <ScenarioCard
            label="BULL CASE"
            color="border-green-200 bg-green-50/30"
            icon="📈"
            scenario={bull.scenario}
            drivers={bull.drivers ?? []}
            priceLabel="Target"
            priceValue={fmtPrice(bull.price_target)}
            timeframe={bull.timeframe ?? ''}
            probability={bull.probability ?? 'low'}
            signals={bull.early_signs ?? []}
          />
        )}

        {neutral && (
          <ScenarioCard
            label="NEUTRAL CASE (MOST LIKELY)"
            color="border-[#E0E0E5] bg-[#FAFAF9]"
            icon="➡️"
            scenario={neutral.scenario}
            drivers={neutral.drivers ?? []}
            priceLabel="Range"
            priceValue={`${fmtPrice(neutral.price_range_low)} – ${fmtPrice(neutral.price_range_high)}`}
            timeframe={neutral.timeframe ?? ''}
            probability={neutral.probability ?? 'high'}
            signals={neutral.what_breaks_it ?? []}
          />
        )}

        {bear && (
          <ScenarioCard
            label="BEAR CASE"
            color="border-red-200 bg-red-50/30"
            icon="📉"
            scenario={bear.scenario}
            drivers={bear.drivers ?? []}
            priceLabel="Target"
            priceValue={fmtPrice(bear.price_target)}
            timeframe={bear.timeframe ?? ''}
            probability={bear.probability ?? 'medium'}
            signals={bear.early_signs ?? []}
          />
        )}

        {/* Key risks */}
        {data.dataGapsAcknowledged && data.dataGapsAcknowledged.length > 0 && (
          <div className="border-t border-[#E0E0E5] pt-3">
            <span className="font-mono text-[10px] font-bold tracking-[0.5px] text-[#AAAAAA] uppercase">
              KETERBATASAN DATA
            </span>
            {data.dataGapsAcknowledged.map((g, i) => (
              <p key={i} className="font-mono text-[11px] text-[#999999] leading-[1.4] mt-1">{g}</p>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
