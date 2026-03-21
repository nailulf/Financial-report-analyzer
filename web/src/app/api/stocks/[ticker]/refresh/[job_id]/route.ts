import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import type { RefreshJob, RefreshScraperProgress } from '@/lib/types/api'

interface RouteParams {
  params: Promise<{ ticker: string; job_id: string }>
}

// ---------------------------------------------------------------------------
// GET /api/stocks/[ticker]/refresh/[job_id]
// Returns the current status of a refresh job, including per-scraper progress.
// ---------------------------------------------------------------------------

export async function GET(_req: NextRequest, { params }: RouteParams) {
  const { ticker, job_id } = await params
  const upperTicker = ticker.toUpperCase()
  const jobId = parseInt(job_id, 10)

  if (isNaN(jobId)) {
    return NextResponse.json({ error: 'Invalid job_id' }, { status: 400 })
  }

  const supabase = await createClient()

  const [jobRes, progressRes] = await Promise.all([
    supabase
      .from('stock_refresh_requests')
      .select('*')
      .eq('id', jobId)
      .eq('ticker', upperTicker)
      .single(),
    supabase
      .from('refresh_scraper_progress')
      .select('scraper_name, status, rows_added, duration_ms, error_msg')
      .eq('request_id', jobId)
      .order('id', { ascending: true }),
  ])

  if (jobRes.error || !jobRes.data) {
    return NextResponse.json({ error: 'Job not found' }, { status: 404 })
  }

  const j = jobRes.data
  const rawProgress = progressRes.data ?? []

  const progress: RefreshScraperProgress[] = rawProgress.map((p) => ({
    scraper:    p.scraper_name,
    status:     p.status as RefreshScraperProgress['status'],
    rows_added: p.rows_added  ?? null,
    duration_ms: p.duration_ms ?? null,
    error_msg:  p.error_msg   ?? null,
  }))

  const body: RefreshJob = {
    job_id:              j.id,
    ticker:              j.ticker,
    status:              j.status as RefreshJob['status'],
    no_new_data:         j.no_new_data       ?? false,
    completeness_before: j.completeness_before ?? null,
    completeness_after:  j.completeness_after  ?? null,
    confidence_before:   j.confidence_before   ?? null,
    confidence_after:    j.confidence_after    ?? null,
    progress,
    error_message:       j.error_message       ?? null,
    finished_at:         j.finished_at         ?? null,
  }

  // Cache-control: short-lived while running, longer when terminal
  const isTerminal = j.status === 'done' || j.status === 'failed'
  const headers = {
    'Cache-Control': isTerminal ? 'public, max-age=60' : 'no-store',
  }

  return NextResponse.json(body, { headers })
}
