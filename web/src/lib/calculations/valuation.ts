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
