import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

interface RouteParams {
  params: Promise<{ ticker: string }>
}

export async function POST(req: Request, { params }: RouteParams) {
  const { ticker } = await params
  const t = ticker.toUpperCase()

  const supabase = await createClient()

  // Create or reuse a refresh job for this ticker
  const body = await req.json().catch(() => ({}))
  const existingJobId = body.job_id as number | undefined

  let jobId = existingJobId

  if (!jobId) {
    // Create a new refresh job row
    const { data: jobData, error: jobError } = await supabase
      .from('stock_refresh_requests')
      .insert({
        ticker: t,
        status: 'pending',
        requested_at: new Date().toISOString(),
      })
      .select('id')
      .single()

    if (jobError || !jobData) {
      return NextResponse.json(
        { error: `Failed to create job: ${jobError?.message}` },
        { status: 500 },
      )
    }
    jobId = jobData.id
  }

  // Seed Phase 6 scraper progress rows
  const phase6Scrapers = [
    'data_cleaner', 'data_normalizer', 'scoring_engine',
    'context_builder', 'ai_analyst',
  ]

  const progressRows = phase6Scrapers.map((scraper) => ({
    request_id: jobId,
    scraper_name: scraper,
    status: 'pending',
    rows_added: null,
    duration_ms: null,
    error_msg: null,
  }))

  await supabase.from('refresh_scraper_progress').upsert(progressRows, {
    onConflict: 'request_id,scraper_name',
  })

  // Trigger the pipeline (local execution)
  // In production, this would dispatch to a worker or GitHub Actions
  try {
    const localRes = await fetch(
      `${process.env.NEXT_PUBLIC_SUPABASE_URL ? '' : 'http://localhost:3000'}/api/stocks/${t}/refresh/local`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          job_id: jobId,
          scrapers: ['ai_pipeline'],
          mode: 'ai-full',
        }),
      },
    ).catch(() => null)

    // Fire-and-forget — the pipeline runs asynchronously
  } catch {
    // Non-fatal: pipeline might be triggered manually
  }

  return NextResponse.json({ job_id: jobId, status: 'queued' })
}
