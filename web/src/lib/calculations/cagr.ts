import type { FinancialYear, CAGRResult } from '@/lib/types/api'

/**
 * Standard CAGR: (end / start)^(1/years) - 1
 * Only valid when both start and end are positive.
 */
function cagr(start: number | null, end: number | null, years: number): number | null {
  if (start == null || end == null || years <= 0) return null
  if (start <= 0 || end <= 0) return null
  return (Math.pow(end / start, 1 / years) - 1) * 100
}

/**
 * Growth rate for metrics that can go negative (e.g., net_income).
 * Uses absolute start as base so negative-to-positive transitions
 * produce a meaningful positive growth number.
 *
 *   -100 → +200 over 3 years = ((200 - (-100)) / |-100|)^(1/3) - 1
 *
 * Returns null if start is zero (division by zero).
 */
function growthRate(start: number | null, end: number | null, years: number): number | null {
  if (start == null || end == null || years <= 0) return null
  if (start === 0) return null
  // Both positive — use standard CAGR
  if (start > 0 && end > 0) return cagr(start, end, years)
  // Both negative and getting worse — negative growth
  // Both negative and improving — positive growth
  // Mixed signs — use absolute-value-based annualized growth
  const totalGrowth = (end - start) / Math.abs(start)
  // Annualize: (1 + totalGrowth)^(1/years) - 1, but only if 1+totalGrowth > 0
  const base = 1 + totalGrowth
  if (base <= 0) return null
  return (Math.pow(base, 1 / years) - 1) * 100
}

interface MetricDef {
  key: keyof FinancialYear
  label: string
  /** Use growthRate instead of strict CAGR (for metrics that can be negative) */
  allowNegative?: boolean
}

const METRICS: MetricDef[] = [
  // Income Statement
  { key: 'revenue',            label: 'Pendapatan' },
  { key: 'gross_profit',       label: 'Laba Kotor' },
  { key: 'operating_income',   label: 'Laba Operasi',       allowNegative: true },
  { key: 'net_income',         label: 'Laba Bersih',        allowNegative: true },
  // Cash Flow
  { key: 'operating_cash_flow', label: 'Arus Kas Operasi',  allowNegative: true },
  { key: 'free_cash_flow',     label: 'Free Cash Flow',     allowNegative: true },
  // Balance Sheet
  { key: 'total_equity',       label: 'Ekuitas' },
  { key: 'total_debt',         label: 'Total Utang' },
]

export function computeCAGR(series: FinancialYear[]): CAGRResult[] {
  if (series.length < 2) return []

  const last = series[series.length - 1]
  const idx3 = series.length >= 4 ? series[series.length - 4] : null
  const idx5 = series.length >= 6 ? series[series.length - 6] : null

  const results: CAGRResult[] = []

  for (const { key, label, allowNegative } of METRICS) {
    const endVal = last[key] as number | null
    const startVal3 = idx3 ? (idx3[key] as number | null) : null
    const startVal5 = idx5 ? (idx5[key] as number | null) : null

    const fn = allowNegative ? growthRate : cagr
    const cagr3 = startVal3 != null ? fn(startVal3, endVal, 3) : null
    const cagr5 = startVal5 != null ? fn(startVal5, endVal, 5) : null

    // Only include if at least one period has data
    if (cagr3 != null || cagr5 != null) {
      results.push({ metric: key, label, cagr_3yr: cagr3, cagr_5yr: cagr5 })
    }
  }

  return results
}
