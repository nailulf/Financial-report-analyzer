import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

// GET /api/strategies — list all strategies
export async function GET() {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('strategies')
    .select('*')
    .order('created_at', { ascending: false })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json(data)
}

// POST /api/strategies — create a new strategy
export async function POST(req: NextRequest) {
  const body = await req.json()
  const { name, filters } = body as { name?: string; filters?: Record<string, unknown> }

  if (!name?.trim()) {
    return NextResponse.json({ error: 'name is required' }, { status: 400 })
  }

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('strategies')
    .insert({ name: name.trim(), filters: filters ?? {} })
    .select()
    .single()

  if (error) {
    console.error('[POST /api/strategies]', error.message, error.details, error.hint)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json(data, { status: 201 })
}
