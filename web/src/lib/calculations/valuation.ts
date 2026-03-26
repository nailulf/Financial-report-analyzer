// ─── Graham Number ──────────────────────────────────────────────────────────
// Formula: √(22.5 × EPS × BVPS)
// Requires EPS > 0 and BVPS > 0

export interface GrahamResult {
  grahamNumber: number | null
  marginOfSafety: number | null   // % — positive = undervalued
  verdict: 'undervalued' | 'fairly-valued' | 'overvalued' | 'na'
}

export function computeGrahamNumber(
  eps: number | null,
  bvps: number | null,
  currentPrice: number | null,
): GrahamResult {
  if (!eps || eps <= 0 || !bvps || bvps <= 0) {
    return { grahamNumber: null, marginOfSafety: null, verdict: 'na' }
  }

  const grahamNumber = Math.sqrt(22.5 * eps * bvps)
  const marginOfSafety =
    currentPrice && currentPrice > 0
      ? ((grahamNumber - currentPrice) / grahamNumber) * 100
      : null

  const verdict =
    marginOfSafety === null ? 'na'
    : marginOfSafety > 30   ? 'undervalued'
    : marginOfSafety > 0    ? 'fairly-valued'
    : 'overvalued'

  return { grahamNumber, marginOfSafety, verdict }
}


// ─── IDX Market Assumptions ─────────────────────────────────────────────────
// Used for automated WACC estimation (simplified CAPM, beta = 1)
export const IDX_RISK_FREE_RATE = 6.75      // Indonesia 10Y govt bond yield (6.5–7% range)
export const IDX_EQUITY_RISK_PREMIUM = 6.25 // Emerging-market equity risk premium
export const IDX_BASE_WACC = 13.0           // risk-free + ERP (simplified, no beta)
export const IDX_TERMINAL_GROWTH = 3.0      // Long-term IDX nominal GDP growth proxy
export const SCENARIO_VARIATION = 0.10      // ±10% for bullish / bearish scenarios


// ─── DCF (Discounted Cash Flow) ──────────────────────────────────────────────
// Projects FCF for 10 years at growth rate, adds terminal value,
// discounts everything back at the discount rate.

export interface DCFInputs {
  fcf: number            // latest free cash flow (IDR)
  shares: number         // shares outstanding
  growthRate: number     // % per year for projection period
  terminalGrowthRate: number  // % perpetuity growth rate after year 10
  discountRate: number   // % WACC / required return
}

export interface DCFResult {
  intrinsicValuePerShare: number | null
  totalPV: number | null
  marginOfSafety: number | null   // % vs current price
  verdict: 'undervalued' | 'fairly-valued' | 'overvalued' | 'na'
  breakdown: { year: number; fcf: number; pv: number }[]
}

export function computeDCF(inputs: DCFInputs, currentPrice: number | null): DCFResult {
  const { fcf, shares, growthRate, terminalGrowthRate, discountRate } = inputs

  if (!fcf || fcf <= 0 || !shares || shares <= 0 || discountRate <= terminalGrowthRate) {
    return { intrinsicValuePerShare: null, totalPV: null, marginOfSafety: null, verdict: 'na', breakdown: [] }
  }

  const g = growthRate / 100
  const gt = terminalGrowthRate / 100
  const r = discountRate / 100

  const breakdown: { year: number; fcf: number; pv: number }[] = []
  let totalPV = 0

  // Years 1–10
  for (let t = 1; t <= 10; t++) {
    const projectedFCF = fcf * Math.pow(1 + g, t)
    const pv = projectedFCF / Math.pow(1 + r, t)
    breakdown.push({ year: t, fcf: projectedFCF, pv })
    totalPV += pv
  }

  // Terminal value (Gordon Growth Model on year 10 FCF)
  const fcf10 = fcf * Math.pow(1 + g, 10)
  const terminalValue = (fcf10 * (1 + gt)) / (r - gt)
  const terminalPV = terminalValue / Math.pow(1 + r, 10)
  totalPV += terminalPV

  const intrinsicValuePerShare = totalPV / shares

  const marginOfSafety =
    currentPrice && currentPrice > 0
      ? ((intrinsicValuePerShare - currentPrice) / intrinsicValuePerShare) * 100
      : null

  const verdict =
    marginOfSafety === null  ? 'na'
    : marginOfSafety > 30    ? 'undervalued'
    : marginOfSafety > 0     ? 'fairly-valued'
    : 'overvalued'

  return { intrinsicValuePerShare, totalPV, marginOfSafety, verdict, breakdown }
}


// ─── DCF Mode ───────────────────────────────────────────────────────────────
// For non-financial companies: project Free Cash Flow
// For banks / financials:     project Dividends (DDM) or Earnings (EPS-based)
export type DCFMode = 'fcf' | 'dividend' | 'eps'

export const DCF_MODE_LABELS: Record<DCFMode, { short: string; long: string; baseLabel: string }> = {
  fcf:      { short: 'FCF',      long: 'Free Cash Flow',     baseLabel: 'Latest FCF' },
  dividend: { short: 'Dividend', long: 'Dividend Discount',  baseLabel: 'Dividends Paid' },
  eps:      { short: 'EPS',      long: 'Earnings-Based',     baseLabel: 'Net Income' },
}


// ─── DCF Scenario Analysis ──────────────────────────────────────────────────
// Generates bullish / base / bearish scenarios using ±10% on growth & WACC.

export type ScenarioLabel = 'bullish' | 'base' | 'bearish'

export interface DCFScenario {
  label: ScenarioLabel
  growthRate: number     // % used
  discountRate: number   // % used
  result: DCFResult
}

/**
 * Compute 3 DCF scenarios from a base growth rate and WACC.
 *
 * - **Bullish**:  growth × 1.10, WACC × 0.90
 * - **Base**:     growth × 1.00, WACC × 1.00
 * - **Bearish**:  growth × 0.90, WACC × 1.10
 */
export function computeDCFScenarios(
  fcf: number,
  shares: number,
  baseGrowthRate: number,
  currentPrice: number | null,
  baseWACC: number = IDX_BASE_WACC,
  terminalGrowthRate: number = IDX_TERMINAL_GROWTH,
): DCFScenario[] {
  const configs: Array<{ label: ScenarioLabel; gMul: number; wMul: number }> = [
    { label: 'bearish',  gMul: 1 - SCENARIO_VARIATION, wMul: 1 + SCENARIO_VARIATION },
    { label: 'base',     gMul: 1,                      wMul: 1 },
    { label: 'bullish',  gMul: 1 + SCENARIO_VARIATION, wMul: 1 - SCENARIO_VARIATION },
  ]

  return configs.map(({ label, gMul, wMul }) => {
    const growthRate = +(baseGrowthRate * gMul).toFixed(2)
    const discountRate = +(baseWACC * wMul).toFixed(2)
    const result = computeDCF(
      { fcf, shares, growthRate, terminalGrowthRate, discountRate },
      currentPrice,
    )
    return { label, growthRate, discountRate, result }
  })
}
