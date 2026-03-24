/**
 * Deterministic Indonesian number formatter — avoids SSR/client hydration
 * mismatch caused by Intl.NumberFormat / toLocaleString locale differences
 * between Node.js and browser.
 *
 * Uses `.` as thousand separator (Indonesian convention).
 */
export function fmtNumID(n: number, fractionDigits = 0): string {
  const fixed = Math.abs(n).toFixed(fractionDigits)
  const [intPart, decPart] = fixed.split('.')
  const withSep = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, '.')
  const sign = n < 0 ? '-' : ''
  return decPart ? `${sign}${withSep},${decPart}` : `${sign}${withSep}`
}

// IDR formatter — handles string (BIGINT from Supabase), number, or null
export function formatIDR(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '—'
  const n = Number(value)
  if (isNaN(n)) return '—'
  return `Rp ${fmtNumID(Math.round(n))}`
}

// Compact IDR: 1.2T, 500M, 50Jt
export function formatIDRCompact(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '—'
  const n = Number(value)
  if (isNaN(n)) return '—'
  const abs = Math.abs(n)
  const sign = n < 0 ? '-' : ''
  if (abs >= 1e12) return `${sign}${(abs / 1e12).toFixed(1)}T`
  if (abs >= 1e9)  return `${sign}${(abs / 1e9).toFixed(1)}M`
  if (abs >= 1e6)  return `${sign}${(abs / 1e6).toFixed(1)}Jt`
  return formatIDR(n)
}

export function formatPercent(value: number | null | undefined, decimals = 1): string {
  if (value === null || value === undefined) return '—'
  return `${value.toFixed(decimals)}%`
}

export function formatNumber(value: number | null | undefined, decimals = 2): string {
  if (value === null || value === undefined) return '—'
  return value.toFixed(decimals)
}

export function formatMultiple(value: number | null | undefined, decimals = 1): string {
  if (value === null || value === undefined) return '—'
  return `${value.toFixed(decimals)}x`
}

// Parse BIGINT string from Supabase to number
export function parseBigInt(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null
  const n = Number(value)
  return isNaN(n) ? null : n
}
