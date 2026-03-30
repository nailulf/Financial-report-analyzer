import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

interface RouteParams {
  params: Promise<{ ticker: string }>
}

async function triggerGithubWorkflow(
  ticker: string,
  jobId: number,
): Promise<{ ok: boolean; error?: string }> {
  const token = process.env.GITHUB_ACTIONS_TOKEN
  const repo = process.env.GITHUB_REPO
  if (!token || !repo) {
    return { ok: false, error: 'GITHUB_ACTIONS_TOKEN or GITHUB_REPO env var not set' }
  }

  const url = `https://api.github.com/repos/${repo}/actions/workflows/scraper.yml/dispatches`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      ref: 'main',
      inputs: {
        mode: 'ai-full',
        ticker,
        job_id: String(jobId),
        ai_model: 'gpt-4o-mini',
      },
    }),
  })

  if (!res.ok) {
    const body = await res.text()
    console.error('[trigger-ai] GitHub dispatch failed:', res.status, body)
    return { ok: false, error: `GitHub dispatch failed: ${res.status}` }
  }
  return { ok: true }
}

export async function POST(_req: Request, { params }: RouteParams) {
  const { ticker } = await params
  const t = ticker.toUpperCase()

  const supabase = await createClient()

  // Create a refresh job to track progress
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

  const jobId = jobData.id

  // Seed Phase 6 scraper progress rows
  const phase6Scrapers = [
    'data_cleaner', 'data_normalizer', 'scoring_engine',
    'context_builder', 'ai_analyst',
  ]

  await supabase.from('refresh_scraper_progress').upsert(
    phase6Scrapers.map((scraper) => ({
      request_id: jobId,
      scraper_name: scraper,
      status: 'pending',
    })),
    { onConflict: 'request_id,scraper_name' },
  )

  // Dispatch GitHub Actions workflow
  const dispatch = await triggerGithubWorkflow(t, jobId)

  if (!dispatch.ok) {
    // Non-fatal — job is created, user can run manually
    return NextResponse.json({
      job_id: jobId,
      status: 'queued',
      dispatch_ok: false,
      dispatch_error: dispatch.error,
      manual_command: `cd python && OPENAI_API_KEY=sk-... python run_all.py --ai-full --ticker ${t} --ai-model gpt-4o-mini --job-id ${jobId}`,
    })
  }

  return NextResponse.json({ job_id: jobId, status: 'queued', dispatch_ok: true })
}
