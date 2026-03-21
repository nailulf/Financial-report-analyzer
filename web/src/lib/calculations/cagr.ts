import type { FinancialYear, CAGRResult } from '@/lib/types/api'

function cagr(start: number | null, end: number | null, years: number): number | null {
  if (!start || !end || start <= 0 || years <= 0) return null
  return (Math.pow(end / start, 1 / years) - 1) * 100
}

export function computeCAGR(series: FinancialYear[]): CAGRResult[] {
  if (series.length < 2) return []

  const last = series[series.length - 1]
  const idx3 = series.length >= 4 ? series[series.length - 4] : null
  const idx5 = series.length >= 6 ? series[series.length - 6] : null

  const metrics: Array<{ key: keyof FinancialYear; label: string }> = [
    { key: 'revenue',    label: 'Revenue' },
    { key: 'net_income', label: 'Net Income' },
    { key: 'total_equity', label: 'Equity' },
  ]

  return metrics.map(({ key, label }) => ({
    metric: key,
    label,
    cagr_3yr: idx3 ? cagr(idx3[key] as number | null, last[key] as number | null, 3) : null,
    cagr_5yr: idx5 ? cagr(idx5[key] as number | null, last[key] as number | null, 5) : null,
  }))
}
