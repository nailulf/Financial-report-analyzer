import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { applyScreenerFilters, type ScreenerFilters } from '@/lib/queries/stocks'

type RouteParams = { params: Promise<{ id: string }> }

// GET /api/strategies/[id]/count — count matching stocks for a strategy's filters
export async function GET(_req: NextRequest, { params }: RouteParams) {
  const { id } = await params
  const supabase = await createClient()

  // Fetch the strategy to get its filters
  const { data: strategy, error: fetchErr } = await supabase
    .from('strategies')
    .select('filters')
    .eq('id', id)
    .single()

  if (fetchErr || !strategy) {
    return NextResponse.json({ error: 'Strategy not found' }, { status: 404 })
  }

  const filters = strategy.filters as ScreenerFilters

  let query = supabase
    .from('stocks')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'Active')

  query = applyScreenerFilters(query, filters)

  const { count, error } = await query
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ count: count ?? 0 })
}
