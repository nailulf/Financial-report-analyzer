'use client'

import { useState } from 'react'
import { computeGrahamNumber, computeDCF } from '@/lib/calculations/valuation'
import { formatIDRCompact } from '@/lib/calculations/formatters'

interface Props {
  eps: number | null
  bvps: number | null
  fcf: number | null
  currentPrice: number | null
  shares: number | null            // shares outstanding (estimated)
  defaultGrowthRate: number        // suggested from revenue CAGR
}

function VerdictBadge({ verdict }: { verdict: string }) {
  const styles: Record<string, string> = {
    'undervalued':   'bg-green-100 text-green-700',
    'fairly-valued': 'bg-amber-100 text-amber-700',
    'overvalued':    'bg-red-100 text-red-600',
    'na':            'bg-gray-100 text-gray-500',
  }
  const labels: Record<string, string> = {
    'undervalued':   'Undervalued',
    'fairly-valued': 'Fairly Valued',
    'overvalued':    'Overvalued',
    'na':            'N/A',
  }
  return (
    <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${styles[verdict] ?? styles.na}`}>
      {labels[verdict] ?? '—'}
    </span>
  )
}

function MoSBar({ mos }: { mos: number | null }) {
  if (mos === null) return null
  const clamped = Math.max(-100, Math.min(100, mos))
  const isPositive = mos >= 0
  return (
    <div className="mt-2">
      <div className="flex justify-between text-xs text-gray-400 mb-0.5">
        <span>Overvalued</span>
        <span>Undervalued</span>
      </div>
      <div className="h-2 bg-gray-100 rounded-full overflow-hidden relative">
        <div className="absolute inset-y-0 left-1/2 w-px bg-gray-300 z-10" />
        {isPositive ? (
          <div
            className="absolute inset-y-0 bg-green-400 rounded-full"
            style={{ left: '50%', width: `${(clamped / 2).toFixed(1)}%` }}
          />
        ) : (
          <div
            className="absolute inset-y-0 bg-red-400 rounded-full"
            style={{ right: '50%', width: `${(-clamped / 2).toFixed(1)}%` }}
          />
        )}
      </div>
      <p className={`text-sm font-semibold mt-1 ${isPositive ? 'text-green-600' : 'text-red-500'}`}>
        {mos > 0 ? '+' : ''}{mos.toFixed(1)}% margin of safety
      </p>
    </div>
  )
}

function SliderInput({
  label, value, min, max, step, unit, onChange,
}: {
  label: string; value: number; min: number; max: number; step: number; unit: string
  onChange: (v: number) => void
}) {
  return (
    <div>
      <div className="flex justify-between items-center mb-1">
        <label className="text-xs text-gray-500">{label}</label>
        <span className="text-xs font-medium text-gray-700">{value}{unit}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full h-1.5 bg-gray-200 rounded-full appearance-none cursor-pointer accent-blue-600"
      />
      <div className="flex justify-between text-xs text-gray-300 mt-0.5">
        <span>{min}{unit}</span>
        <span>{max}{unit}</span>
      </div>
    </div>
  )
}

export function ValuationCalculator({ eps, bvps, fcf, currentPrice, shares, defaultGrowthRate }: Props) {
  const [growthRate, setGrowthRate] = useState(Math.min(Math.max(defaultGrowthRate, 3), 25))
  const [terminalGrowthRate, setTerminalGrowthRate] = useState(3)
  const [discountRate, setDiscountRate] = useState(10)

  const graham = computeGrahamNumber(eps, bvps, currentPrice)

  const dcfResult = (fcf && fcf > 0 && shares && shares > 0)
    ? computeDCF({ fcf, shares, growthRate, terminalGrowthRate, discountRate }, currentPrice)
    : null

  const hasAnyData = eps || bvps || fcf

  if (!hasAnyData) return null

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-6">
      <div className="mb-5">
        <h2 className="text-sm font-semibold text-gray-700">Valuation</h2>
        <p className="text-xs text-gray-400 mt-0.5">Estimates only — not financial advice</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Graham Number */}
        <div className="p-4 bg-gray-50 rounded-xl border border-gray-100">
          <div className="flex items-center justify-between mb-3">
            <div>
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Graham Number</p>
              <p className="text-xs text-gray-400">√(22.5 × EPS × BVPS)</p>
            </div>
            {graham.verdict !== 'na' && <VerdictBadge verdict={graham.verdict} />}
          </div>

          {graham.grahamNumber ? (
            <>
              <p className="text-2xl font-bold text-gray-900 font-mono">
                Rp{graham.grahamNumber.toLocaleString('id-ID', { maximumFractionDigits: 0 })}
              </p>
              {currentPrice && (
                <p className="text-xs text-gray-500 mt-1">
                  Current: Rp{currentPrice.toLocaleString('id-ID')}
                </p>
              )}
              <MoSBar mos={graham.marginOfSafety} />

              <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-gray-500">
                <div>EPS: <span className="font-mono text-gray-700">{eps != null ? eps.toFixed(2) : '—'}</span></div>
                <div>BVPS: <span className="font-mono text-gray-700">{bvps != null ? bvps.toFixed(2) : '—'}</span></div>
              </div>
            </>
          ) : (
            <p className="text-sm text-gray-400 mt-2">
              Requires positive EPS and Book Value per Share.
            </p>
          )}
        </div>

        {/* DCF */}
        <div className="p-4 bg-gray-50 rounded-xl border border-gray-100">
          <div className="flex items-center justify-between mb-3">
            <div>
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">DCF (10-Year)</p>
              <p className="text-xs text-gray-400">Discounted Free Cash Flow</p>
            </div>
            {dcfResult && dcfResult.verdict !== 'na' && <VerdictBadge verdict={dcfResult.verdict} />}
          </div>

          {dcfResult && dcfResult.intrinsicValuePerShare ? (
            <>
              <p className="text-2xl font-bold text-gray-900 font-mono">
                Rp{dcfResult.intrinsicValuePerShare.toLocaleString('id-ID', { maximumFractionDigits: 0 })}
              </p>
              {currentPrice && (
                <p className="text-xs text-gray-500 mt-1">
                  Current: Rp{currentPrice.toLocaleString('id-ID')}
                </p>
              )}
              <MoSBar mos={dcfResult.marginOfSafety} />

              <div className="mt-3 text-xs text-gray-500">
                Total PV: <span className="font-mono text-gray-700">{formatIDRCompact(dcfResult.totalPV)}</span>
              </div>

              <div className="mt-4 space-y-3 pt-4 border-t border-gray-200">
                <SliderInput
                  label="Growth Rate (10-yr)"
                  value={growthRate}
                  min={0} max={30} step={1} unit="%"
                  onChange={setGrowthRate}
                />
                <SliderInput
                  label="Terminal Growth Rate"
                  value={terminalGrowthRate}
                  min={0} max={8} step={0.5} unit="%"
                  onChange={setTerminalGrowthRate}
                />
                <SliderInput
                  label="Discount Rate (WACC)"
                  value={discountRate}
                  min={6} max={25} step={0.5} unit="%"
                  onChange={setDiscountRate}
                />
              </div>
            </>
          ) : fcf && fcf <= 0 ? (
            <p className="text-sm text-gray-400 mt-2">
              DCF requires positive Free Cash Flow. Latest FCF: {formatIDRCompact(fcf)}
            </p>
          ) : (
            <p className="text-sm text-gray-400 mt-2">
              Free Cash Flow data not available.
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
