export const CHART_COLORS = {
  blue: '#3B82F6',
  green: '#10B981',
  purple: '#8B5CF6',
  red: '#EF4444',
  amber: '#F59E0B',
  gray: '#6B7280',
  teal: '#14B8A6',
} as const

export const PAGE_SIZE = 50

export const SECTORS = [
  'Financials',
  'Energy',
  'Basic Materials',
  'Consumer Staples',
  'Consumer Discretionary',
  'Industrials',
  'Property & Real Estate',
  'Technology',
  'Infrastructure',
  'Transportation & Logistics',
  'Healthcare',
] as const

// Health score thresholds — values are stored as plain numbers (e.g. 15.5 = 15.5%)
export const HEALTH_THRESHOLDS = {
  roe:            { green: 15,  yellow: 8  },   // > green = green, > yellow = yellow, else red
  net_margin:     { green: 10,  yellow: 5  },
  current_ratio:  { green: 1.5, yellow: 1.0 },
  debt_to_equity: { green: 1.0, yellow: 2.0, invert: true },  // lower is better
  gross_margin:   { green: 30,  yellow: 15 },
  roa:            { green: 8,   yellow: 4  },
} as const
