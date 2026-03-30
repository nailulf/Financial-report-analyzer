import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

interface RouteParams {
  params: Promise<{ subsector: string }>
}

export async function GET(_req: Request, { params }: RouteParams) {
  const { subsector } = await params
  const decoded = decodeURIComponent(subsector)
  const supabase = await createClient()

  const { data, error } = await supabase
    .from('sector_templates')
    .select('*')
    .eq('subsector', decoded)
    .single()

  if (error || !data) {
    return NextResponse.json({
      subsector: decoded,
      keyMetrics: null,
      valuationMethod: null,
      cycleContext: null,
      currentDynamics: null,
      commonRisks: null,
      exemptions: null,
      bumnNote: null,
    })
  }

  return NextResponse.json({
    subsector: data.subsector,
    keyMetrics: data.key_metrics,
    valuationMethod: data.valuation_method,
    cycleContext: data.cycle_context,
    currentDynamics: data.current_dynamics,
    commonRisks: data.common_risks,
    exemptions: data.exemptions,
    bumnNote: data.bumn_note,
  })
}

export async function POST(req: Request, { params }: RouteParams) {
  const { subsector } = await params
  const decoded = decodeURIComponent(subsector)
  const body = await req.json()

  const supabase = await createClient()
  const { error } = await supabase
    .from('sector_templates')
    .upsert({
      subsector: decoded,
      key_metrics: body.keyMetrics ?? body.key_metrics ?? null,
      valuation_method: body.valuationMethod ?? body.valuation_method ?? null,
      cycle_context: body.cycleContext ?? body.cycle_context ?? null,
      current_dynamics: body.currentDynamics ?? body.current_dynamics ?? null,
      common_risks: body.commonRisks ?? body.common_risks ?? null,
      exemptions: body.exemptions ?? null,
      bumn_note: body.bumnNote ?? body.bumn_note ?? null,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'subsector' })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ subsector: decoded, saved: true })
}
