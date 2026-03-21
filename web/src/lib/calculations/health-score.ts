import type { FinancialYear, HealthScore, HealthStatus } from '@/lib/types/api'
import { HEALTH_THRESHOLDS } from '@/lib/constants'
import { formatPercent, formatNumber } from './formatters'

function score(value: number | null, green: number, yellow: number, invert = false): HealthStatus {
  if (value === null) return 'na'
  if (!invert) {
    if (value >= green)  return 'green'
    if (value >= yellow) return 'yellow'
    return 'red'
  } else {
    // Lower is better (e.g. D/E)
    if (value <= green)  return 'green'
    if (value <= yellow) return 'yellow'
    return 'red'
  }
}

export function computeHealthScores(latest: FinancialYear): HealthScore[] {
  const t = HEALTH_THRESHOLDS

  const items: HealthScore[] = [
    {
      metric: 'roe',
      label: 'Return on Equity',
      value: latest.roe,
      formatted: formatPercent(latest.roe),
      status: score(latest.roe, t.roe.green, t.roe.yellow),
      description: `Green ≥${t.roe.green}% / Yellow ≥${t.roe.yellow}%`,
    },
    {
      metric: 'net_margin',
      label: 'Net Margin',
      value: latest.net_margin,
      formatted: formatPercent(latest.net_margin),
      status: score(latest.net_margin, t.net_margin.green, t.net_margin.yellow),
      description: `Green ≥${t.net_margin.green}% / Yellow ≥${t.net_margin.yellow}%`,
    },
    {
      metric: 'gross_margin',
      label: 'Gross Margin',
      value: latest.gross_margin,
      formatted: formatPercent(latest.gross_margin),
      status: score(latest.gross_margin, t.gross_margin.green, t.gross_margin.yellow),
      description: `Green ≥${t.gross_margin.green}% / Yellow ≥${t.gross_margin.yellow}%`,
    },
    {
      metric: 'roa',
      label: 'Return on Assets',
      value: latest.roa,
      formatted: formatPercent(latest.roa),
      status: score(latest.roa, t.roa.green, t.roa.yellow),
      description: `Green ≥${t.roa.green}% / Yellow ≥${t.roa.yellow}%`,
    },
    {
      metric: 'current_ratio',
      label: 'Current Ratio',
      value: latest.current_ratio,
      formatted: formatNumber(latest.current_ratio),
      status: score(latest.current_ratio, t.current_ratio.green, t.current_ratio.yellow),
      description: `Green ≥${t.current_ratio.green} / Yellow ≥${t.current_ratio.yellow}`,
    },
    {
      metric: 'debt_to_equity',
      label: 'Debt / Equity',
      value: latest.debt_to_equity,
      formatted: formatNumber(latest.debt_to_equity),
      status: score(latest.debt_to_equity, t.debt_to_equity.green, t.debt_to_equity.yellow, true),
      description: `Green ≤${t.debt_to_equity.green} / Yellow ≤${t.debt_to_equity.yellow}`,
    },
    {
      metric: 'free_cash_flow',
      label: 'Free Cash Flow',
      value: latest.free_cash_flow,
      formatted: latest.free_cash_flow !== null
        ? (latest.free_cash_flow >= 0 ? 'Positive' : 'Negative')
        : '—',
      status: latest.free_cash_flow === null ? 'na' : latest.free_cash_flow >= 0 ? 'green' : 'red',
      description: 'Positive = green',
    },
  ]

  return items
}
