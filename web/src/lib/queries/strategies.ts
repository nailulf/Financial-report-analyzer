import { createClient } from '@/lib/supabase/server'
import { applyScreenerFilters, type ScreenerFilters } from '@/lib/queries/stocks'
import type { Strategy } from '@/lib/types/database'

export async function getStrategies(): Promise<Strategy[]> {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('strategies')
    .select('*')
    .order('created_at', { ascending: false })

  if (error) {
    console.error('[getStrategies] query failed:', error.message)
    return []
  }
  return data as Strategy[]
}

export async function getStrategyMatchCount(filters: ScreenerFilters): Promise<number> {
  const supabase = await createClient()
  let query = supabase
    .from('stocks')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'Active')

  query = applyScreenerFilters(query, filters)

  const { count, error } = await query
  if (error) {
    console.error('[getStrategyMatchCount] query failed:', error.message)
    return 0
  }
  return count ?? 0
}
