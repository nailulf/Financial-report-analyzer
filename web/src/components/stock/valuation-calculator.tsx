'use client'

import { useState, useMemo } from 'react'
import {
  computeGrahamNumber,
  computeDCFScenarios,
  IDX_BASE_WACC,
  IDX_TERMINAL_GROWTH,
  IDX_RISK_FREE_RATE,
  IDX_EQUITY_RISK_PREMIUM,
  DCF_MODE_LABELS,
  type DCFMode,
  type DCFScenario,
  type ScenarioLabel,
} from '@/lib/calculations/valuation'
import { formatIDRCompact, fmtNumID } from '@/lib/calculations/formatters'

interface Props {
  eps: number | null
  bvps: number | null
  fcf: number | null
  dividends: number | null
  netIncome: number | null
  currentPrice: number | null
  shares: number | null
  defaultGrowthRate: number
}

function VerdictBadge({ verdict }: { verdict: string }) {
  const styles: Record<string, string> = {
    'undervalued':   'bg-[#C8F0D8] text-[#3D8A5A]',
    'fairly-valued': 'bg-amber-100 text-amber-700',
    'overvalued':    'bg-red-100 text-red-600',
    'na':            'bg-[#EDECEA] text-[#9C9B99]',
  }
  const labels: Record<string, string> = {
    'undervalued':   'Undervalued',
    'fairly-valued': 'Fairly Valued',
    'overvalued':    'Overvalued',
    'na':            'N/A',
  }
  return (
    <span className={`px-2.5 py-1 rounded-lg text-xs font-semibold ${styles[verdict] ?? styles.na}`}>
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
      <div className="flex justify-between text-xs text-[#9C9B99] mb-0.5">
        <span>Overvalued</span>
        <span>Undervalued</span>
      </div>
      <div className="h-2 bg-[#EDECEA] rounded-full overflow-hidden relative">
        <div className="absolute inset-y-0 left-1/2 w-px bg-[#E5E4E1] z-10" />
        {isPositive ? (
          <div
            className="absolute inset-y-0 bg-[#3D8A5A] rounded-full"
            style={{ left: '50%', width: `${(clamped / 2).toFixed(1)}%` }}
          />
        ) : (
          <div
            className="absolute inset-y-0 bg-red-400 rounded-full"
            style={{ right: '50%', width: `${(-clamped / 2).toFixed(1)}%` }}
          />
        )}
      </div>
      <p className={`text-sm font-semibold mt-1 ${isPositive ? 'text-[#3D8A5A]' : 'text-red-500'}`}>
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
        <label className="text-xs text-[#6D6C6A]">{label}</label>
        <span className="text-xs font-semibold text-[#1A1918] font-mono">{value}{unit}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full h-1.5 bg-[#EDECEA] rounded-full appearance-none cursor-pointer accent-[#3D8A5A]"
      />
      <div className="flex justify-between text-xs text-[#9C9B99] mt-0.5">
        <span>{min}{unit}</span>
        <span>{max}{unit}</span>
      </div>
    </div>
  )
}

const scenarioStyle: Record<ScenarioLabel, { border: string; bg: string; label: string; accent: string }> = {
  bearish:  { border: 'border-red-200', bg: 'bg-red-50',   label: 'Bearish',  accent: 'text-red-600' },
  base:     { border: 'border-[#E5E4E1]', bg: 'bg-[#F5F4F1]', label: 'Base', accent: 'text-[#1A1918]' },
  bullish:  { border: 'border-emerald-200', bg: 'bg-emerald-50', label: 'Bullish', accent: 'text-[#3D8A5A]' },
}

function ScenarioCard({ scenario, currentPrice }: { scenario: DCFScenario; currentPrice: number | null }) {
  const s = scenarioStyle[scenario.label]
  const iv = scenario.result.intrinsicValuePerShare
  const mos = scenario.result.marginOfSafety

  return (
    <div className={`flex-1 p-3 rounded-lg border ${s.border} ${s.bg}`}>
      <p className={`text-xs font-semibold uppercase tracking-wide ${s.accent}`}>{s.label}</p>
      <p className={`text-lg font-bold font-mono mt-1 ${s.accent}`}>
        {iv != null ? `Rp${fmtNumID(Math.round(iv))}` : '—'}
      </p>
      {mos != null && (
        <p className={`text-xs font-semibold mt-0.5 ${mos >= 0 ? 'text-[#3D8A5A]' : 'text-red-500'}`}>
          {mos > 0 ? '+' : ''}{mos.toFixed(1)}% MoS
        </p>
      )}
      <div className="mt-2 space-y-0.5 text-[10px] text-[#6D6C6A]">
        <p>Growth: {scenario.growthRate.toFixed(1)}%</p>
        <p>WACC: {scenario.discountRate.toFixed(1)}%</p>
      </div>
    </div>
  )
}

export function ValuationCalculator({
  eps, bvps, fcf, dividends, netIncome, currentPrice, shares, defaultGrowthRate,
}: Props) {
  // Determine which DCF modes are available
  const availableModes = useMemo(() => {
    const modes: DCFMode[] = []
    if (fcf && fcf > 0) modes.push('fcf')
    if (dividends && dividends > 0) modes.push('dividend')
    if (netIncome && netIncome > 0) modes.push('eps')
    return modes
  }, [fcf, dividends, netIncome])

  const [dcfMode, setDcfMode] = useState<DCFMode>(availableModes[0] ?? 'fcf')
  const [growthRate, setGrowthRate] = useState(Math.min(Math.max(defaultGrowthRate, 3), 25))
  const [terminalGrowthRate, setTerminalGrowthRate] = useState(IDX_TERMINAL_GROWTH)
  const [discountRate, setDiscountRate] = useState(IDX_BASE_WACC)

  const graham = computeGrahamNumber(eps, bvps, currentPrice)

  // Pick the base cash flow value based on selected mode
  const activeMode = availableModes.includes(dcfMode) ? dcfMode : availableModes[0]
  const baseCashFlow = activeMode === 'fcf' ? fcf
    : activeMode === 'dividend' ? dividends
    : activeMode === 'eps' ? netIncome
    : null

  const scenarios = (baseCashFlow && baseCashFlow > 0 && shares && shares > 0)
    ? computeDCFScenarios(baseCashFlow, shares, growthRate, currentPrice, discountRate, terminalGrowthRate)
    : null

  const baseScenario = scenarios?.find((s) => s.label === 'base') ?? null

  const hasAnyData = eps || bvps || fcf || dividends || netIncome

  if (!hasAnyData) return null

  const modeLabel = activeMode ? DCF_MODE_LABELS[activeMode] : null

  return (
    <div className="bg-white rounded-2xl border border-[#E5E4E1] shadow-[0_2px_12px_rgba(26,25,24,0.06)] p-6">
      <div className="mb-6">
        <h2 className="text-sm font-semibold text-[#1A1918]">Valuation Models</h2>
        <p className="text-xs text-[#9C9B99] mt-0.5">Estimates only — not financial advice</p>
      </div>

      {/* Graham Number */}
      <div className="p-5 bg-[#F5F4F1] rounded-xl border border-[#E5E4E1] mb-4">
        <div className="flex items-center justify-between mb-3">
          <div>
            <p className="text-xs font-semibold text-[#9C9B99] uppercase tracking-wide">Graham Number</p>
            <p className="text-xs text-[#9C9B99]">&radic;(22.5 &times; EPS &times; BVPS)</p>
          </div>
          {graham.verdict !== 'na' && <VerdictBadge verdict={graham.verdict} />}
        </div>

        {graham.grahamNumber ? (
          <>
            <p className="text-2xl font-bold text-[#1A1918] font-mono">
              Rp{fmtNumID(Math.round(graham.grahamNumber))}
            </p>
            {currentPrice && (
              <p className="text-xs text-[#9C9B99] mt-1">
                Current: Rp{fmtNumID(currentPrice)}
              </p>
            )}
            <MoSBar mos={graham.marginOfSafety} />

            <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-[#6D6C6A]">
              <div>EPS: <span className="font-mono text-[#1A1918]">{eps != null ? eps.toFixed(2) : '—'}</span></div>
              <div>BVPS: <span className="font-mono text-[#1A1918]">{bvps != null ? bvps.toFixed(2) : '—'}</span></div>
            </div>
          </>
        ) : (
          <p className="text-sm text-[#9C9B99] mt-2">
            Requires positive EPS and Book Value per Share.
          </p>
        )}
      </div>

      {/* DCF Scenarios */}
      <div className="p-5 bg-[#F5F4F1] rounded-xl border border-[#E5E4E1]">
        <div className="flex items-center justify-between mb-3">
          <div>
            <p className="text-xs font-semibold text-[#9C9B99] uppercase tracking-wide">DCF (10-Year)</p>
            <p className="text-xs text-[#9C9B99]">
              {modeLabel ? modeLabel.long : 'Discounted Cash Flow'} — 3 scenarios
            </p>
          </div>
          {baseScenario && baseScenario.result.verdict !== 'na' && (
            <VerdictBadge verdict={baseScenario.result.verdict} />
          )}
        </div>

        {/* Mode toggle — only show when multiple modes available */}
        {availableModes.length > 1 && (
          <div className="flex gap-1 mb-4 p-0.5 bg-[#EDECEA] rounded-lg w-fit">
            {availableModes.map((m) => (
              <button
                key={m}
                onClick={() => setDcfMode(m)}
                className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors ${
                  activeMode === m
                    ? 'bg-white text-[#1A1918] shadow-sm'
                    : 'text-[#9C9B99] hover:text-[#6D6C6A]'
                }`}
              >
                {DCF_MODE_LABELS[m].short}
              </button>
            ))}
          </div>
        )}

        {scenarios ? (
          <>
            {/* Scenario cards */}
            <div className="flex gap-2 mb-3">
              {scenarios.map((s) => (
                <ScenarioCard key={s.label} scenario={s} currentPrice={currentPrice} />
              ))}
            </div>

            {/* Current price reference */}
            {currentPrice && (
              <p className="text-xs text-[#9C9B99] mb-1">
                Current: Rp{fmtNumID(currentPrice)}
              </p>
            )}

            {/* Margin of safety bar for base scenario */}
            <MoSBar mos={baseScenario?.result.marginOfSafety ?? null} />

            {/* Base value & Total PV */}
            <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-[#6D6C6A]">
              <div>{modeLabel?.baseLabel ?? 'Base'}: <span className="font-mono text-[#1A1918]">{formatIDRCompact(baseCashFlow)}</span></div>
              <div>Total PV (base): <span className="font-mono text-[#1A1918]">{formatIDRCompact(baseScenario?.result.totalPV ?? null)}</span></div>
            </div>

            {/* Sliders — adjust base scenario */}
            <div className="mt-4 space-y-3 pt-4 border-t border-[#E5E4E1]">
              <p className="text-xs font-semibold text-[#6D6C6A] mb-2">Adjust Base Assumptions</p>
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

            {/* Assumptions footnote */}
            <div className="mt-3 pt-3 border-t border-[#E5E4E1] space-y-1 text-[10px] text-[#9C9B99]">
              <p>WACC default: BI 10Y bond {IDX_RISK_FREE_RATE}% + ERP {IDX_EQUITY_RISK_PREMIUM}% = {IDX_BASE_WACC}%</p>
              <p>Scenarios: &plusmn;10% on growth rate &amp; WACC from base</p>
              <p>Terminal growth: {IDX_TERMINAL_GROWTH}% (long-term nominal GDP proxy)</p>
              {activeMode === 'dividend' && (
                <p>DDM: projects total dividends paid, discounts to present value</p>
              )}
              {activeMode === 'eps' && (
                <p>Earnings-based: projects net income as proxy for owner earnings</p>
              )}
            </div>
          </>
        ) : availableModes.length === 0 ? (
          <p className="text-sm text-[#9C9B99] mt-2">
            No positive cash flow, dividend, or earnings data available for DCF.
          </p>
        ) : (
          <p className="text-sm text-[#9C9B99] mt-2">
            Shares outstanding data not available.
          </p>
        )}
      </div>
    </div>
  )
}
