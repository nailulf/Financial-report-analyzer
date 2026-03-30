import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

interface RouteParams {
  params: Promise<{ ticker: string }>
}

export async function GET(_req: Request, { params }: RouteParams) {
  const { ticker } = await params
  const supabase = await createClient()

  const { data, error } = await supabase
    .from('stock_notes')
    .select('ticker, domain_notes, updated_at')
    .eq('ticker', ticker.toUpperCase())
    .single()

  if (error || !data) {
    return NextResponse.json({ ticker: ticker.toUpperCase(), domainNotes: null, updatedAt: null })
  }

  return NextResponse.json({
    ticker: data.ticker,
    domainNotes: data.domain_notes,
    updatedAt: data.updated_at,
  })
}

export async function POST(req: Request, { params }: RouteParams) {
  const { ticker } = await params
  const t = ticker.toUpperCase()
  const body = await req.json()
  const domainNotes = (body.domainNotes ?? body.domain_notes ?? '') as string

  const supabase = await createClient()
  const { error } = await supabase
    .from('stock_notes')
    .upsert({
      ticker: t,
      domain_notes: domainNotes || null,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'ticker' })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ ticker: t, saved: true })
}
