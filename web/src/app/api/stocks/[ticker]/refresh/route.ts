import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

interface RouteParams {
  params: Promise<{ ticker: string }>
}

const SCRAPERS = [
  'stock_universe',
  'financials_fallback',
  'company_profiles',
  'document_links',
  'corporate_events',
  'daily_prices',
  'money_flow',
  'dividend_scraper',
  'broker_backfill',
  'ratio_enricher',
  'market_phases',
  'technical_signals',
]

// ---------------------------------------------------------------------------
// GET /api/stocks/[ticker]/refresh
// Returns the most recent active (pending/running) job for this ticker, or null.
// Used by the UI on mount to resume polling after a page navigation.
// ---------------------------------------------------------------------------

export async function GET(_req: NextRequest, { params }: RouteParams) {
  const { ticker } = await params
  const upperTicker = ticker.toUpperCase()

  const supabase = await createClient()

  const { data } = await supabase
    .from('stock_refresh_requests')
    .select('id, status')
    .eq('ticker', upperTicker)
    .in('status', ['pending', 'running'])
    .order('requested_at', { ascending: false })
    .limit(1)
    .single()

  if (!data) {
    return NextResponse.json({ job_id: null }, { headers: { 'Cache-Control': 'no-store' } })
  }

  return NextResponse.json(
    { job_id: data.id, status: data.status },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}

// ---------------------------------------------------------------------------
// Trigger GitHub Actions workflow_dispatch to run the Python scraper.
// Fires-and-forgets — failure to dispatch is non-fatal (job still queued).
// ---------------------------------------------------------------------------

async function triggerGithubWorkflow(
  ticker: string,
  jobId: number,
  scrapers: string[] = [],
): Promise<{ ok: boolean; status: number; error?: string }> {
  const token = process.env.GITHUB_ACTIONS_TOKEN
  const repo  = process.env.GITHUB_REPO
  if (!token || !repo) {
    return { ok: false, status: 0, error: 'GITHUB_ACTIONS_TOKEN or GITHUB_REPO env var not set' }
  }

  const url = `https://api.github.com/repos/${repo}/actions/workflows/scraper.yml/dispatches`
  const inputs: Record<string, string> = {
    mode: 'full',
    ticker,
    job_id: String(jobId),
  }
  if (scrapers.length > 0) {
    inputs.scrapers = scrapers.join(',')
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization:  `Bearer ${token}`,
      Accept:         'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ref: 'main', inputs }),
  })
  if (!res.ok) {
    const body = await res.text()
    console.error('[refresh] GitHub dispatch failed:', res.status, body)
    return { ok: false, status: res.status, error: body }
  }
  return { ok: true, status: res.status }
}

// ---------------------------------------------------------------------------
// POST /api/stocks/[ticker]/refresh
// Creates a refresh request row, seeds per-scraper progress rows,
// and triggers a GitHub Actions workflow to run the Python scraper.
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest, { params }: RouteParams) {
  const { ticker } = await params
  const upperTicker = ticker.toUpperCase()
  const body = await req.json().catch(() => ({})) as { scrapers?: string[] }

  // Use provided scrapers (validated against known list) or default to all
  const scrapersToRun = body.scrapers?.length
    ? body.scrapers.filter((s: string) => SCRAPERS.includes(s))
    : SCRAPERS

  const supabase = await createClient()

  // Verify the ticker exists
  const { data: stock, error: stockError } = await supabase
    .from('stocks')
    .select('ticker, completeness_score, confidence_score')
    .eq('ticker', upperTicker)
    .single()

  if (stockError || !stock) {
    return NextResponse.json({ error: 'Ticker not found' }, { status: 404 })
  }

  // Return existing active job if one is already pending or running for this ticker
  const { data: existing } = await supabase
    .from('stock_refresh_requests')
    .select('id')
    .eq('ticker', upperTicker)
    .in('status', ['pending', 'running'])
    .order('requested_at', { ascending: false })
    .limit(1)
    .single()

  if (existing) {
    // Re-trigger dispatch in case the previous attempt failed (e.g. bad token)
    const dispatch = await triggerGithubWorkflow(upperTicker, existing.id)
    return NextResponse.json({
      job_id: existing.id,
      dispatch: { ok: dispatch.ok, status: dispatch.status, error: dispatch.error ?? null },
    }, { status: 202 })
  }

  // Create the refresh request row
  const { data: job, error: jobError } = await supabase
    .from('stock_refresh_requests')
    .insert({
      ticker:               upperTicker,
      status:               'pending',
      completeness_before:  stock.completeness_score ?? null,
      confidence_before:    stock.confidence_score   ?? null,
    })
    .select('id')
    .single()

  if (jobError || !job) {
    console.error('[refresh] insert stock_refresh_requests failed:', jobError)
    return NextResponse.json(
      { error: jobError?.message ?? 'Failed to create refresh job' },
      { status: 500 }
    )
  }

  // Seed per-scraper progress rows (status = 'waiting') for selected scrapers only
  const progressRows = scrapersToRun.map((name) => ({
    request_id:   job.id,
    scraper_name: name,
    status:       'waiting',
  }))

  await supabase.from('refresh_scraper_progress').insert(progressRows)

  // Dispatch to GitHub Actions — works on both local and Vercel
  const dispatch = await triggerGithubWorkflow(upperTicker, job.id, scrapersToRun)

  return NextResponse.json({
    job_id: job.id,
    dispatch: { ok: dispatch.ok, status: dispatch.status, error: dispatch.error ?? null },
  }, { status: 202 })
}
