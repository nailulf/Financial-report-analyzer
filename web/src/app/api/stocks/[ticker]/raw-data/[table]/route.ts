import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

interface RouteParams {
  params: Promise<{ ticker: string; table: string }>
}

// Allowed tables for the raw data inspector (prevent arbitrary table access)
const ALLOWED_TABLES = new Set([
  'financials',
  'daily_prices',
  'broker_flow',
  'bandar_signal',
  'insider_transactions',
  'shareholders',
  'shareholders_major',
  'data_quality_flags',
  'normalized_metrics',
])

export async function GET(req: NextRequest, { params }: RouteParams) {
  const { ticker, table } = await params
  const t = ticker.toUpperCase()

  if (!ALLOWED_TABLES.has(table)) {
    return NextResponse.json(
      { error: `Table '${table}' is not allowed. Valid: ${[...ALLOWED_TABLES].join(', ')}` },
      { status: 400 },
    )
  }

  const limit = Math.min(
    parseInt(req.nextUrl.searchParams.get('limit') ?? '20', 10),
    100,
  )
  const offset = parseInt(req.nextUrl.searchParams.get('offset') ?? '0', 10)

  const supabase = await createClient()
  const { data, error, count } = await supabase
    .from(table)
    .select('*', { count: 'exact' })
    .eq('ticker', t)
    .order(table === 'financials' ? 'year' : table === 'daily_prices' ? 'date' : 'ticker', { ascending: false })
    .range(offset, offset + limit - 1)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ rows: data ?? [], total: count ?? 0, table, ticker: t })
}
