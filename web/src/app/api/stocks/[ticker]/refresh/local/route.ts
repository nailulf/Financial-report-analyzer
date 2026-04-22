import { NextRequest, NextResponse } from 'next/server'
import { spawn } from 'child_process'
import path from 'path'

interface RouteParams {
  params: Promise<{ ticker: string }>
}

const PROJECT_ROOT = path.join(process.cwd(), '..')
const PYTHON_BIN   = path.join(PROJECT_ROOT, '.venv', 'bin', 'python3')
const RUN_ALL      = path.join(PROJECT_ROOT, 'python', 'run_all.py')

/**
 * Map scraper names to their run_all.py CLI flags.
 * Each scraper uses the exact same flags as running it from terminal.
 */
const SCRAPER_FLAGS: Record<string, string[]> = {
  stock_universe:      ['--weekly'],
  financials_fallback: ['--quarterly'],
  company_profiles:    ['--quarterly'],
  document_links:      ['--quarterly'],
  corporate_events:    ['--quarterly'],
  daily_prices:        ['--daily'],
  money_flow:          ['--daily'],
  dividend_scraper:    ['--dividends'],
  ratio_enricher:      ['--enrich-ratios'],
  market_phases:       ['--detect-phases'],
  technical_signals:   ['--compute-signals'],
  // broker_backfill handled separately (needs --backfill-days)
}

/**
 * POST /api/stocks/[ticker]/refresh/local
 *
 * Spawns `run_all.py` as a detached background process on the local machine.
 * Builds CLI flags that match direct terminal execution (no --full --scrapers indirection).
 */
export async function POST(req: NextRequest, { params }: RouteParams) {
  const { ticker } = await params
  const upperTicker = ticker.toUpperCase()
  const body = await req.json().catch(() => ({})) as {
    job_id: number
    scrapers?: string[]
    broker_days?: number
    bearer_token?: string
  }

  if (!body.job_id) {
    return NextResponse.json({ error: 'job_id is required' }, { status: 400 })
  }

  const scrapers = body.scrapers ?? []

  // Build CLI args by collecting unique flags for the selected scrapers
  const flagSet = new Set<string>()
  for (const s of scrapers) {
    const flags = SCRAPER_FLAGS[s]
    if (flags) {
      for (const f of flags) flagSet.add(f)
    }
  }

  const args = [RUN_ALL]

  // Add collected mode flags (deduplicated: --daily, --weekly, --quarterly, --dividends)
  for (const f of flagSet) args.push(f)

  // Broker backfill needs special handling
  if (scrapers.includes('broker_backfill')) {
    args.push('--broker-backfill', '--backfill-days', String(body.broker_days ?? 30))
  }

  // If no modes were added (shouldn't happen, but safety), use --full
  if (flagSet.size === 0 && !scrapers.includes('broker_backfill')) {
    args.push('--full')
  }

  args.push('--ticker', upperTicker)
  args.push('--job-id', String(body.job_id))

  try {
    // Pass bearer token as env var so token_manager picks it up without interactive prompt
    const env = { ...process.env }
    if (body.bearer_token) {
      env.STOCKBIT_BEARER_TOKEN = body.bearer_token
    }

    const proc = spawn(PYTHON_BIN, args, {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
      cwd: path.join(PROJECT_ROOT, 'python'),
    })

    // Pipe output to Next.js console so errors are visible in dev
    proc.stdout?.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n').filter(Boolean)) {
        console.log(`[refresh/local:${upperTicker}] ${line}`)
      }
    })
    proc.stderr?.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n').filter(Boolean)) {
        console.log(`[refresh/local:${upperTicker}] ${line}`)
      }
    })

    proc.unref()

    console.log(`[refresh/local] Spawned: python ${args.join(' ')} (PID=${proc.pid})`)

    return NextResponse.json({ ok: true, pid: proc.pid, cmd: `python ${args.join(' ')}` })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('[refresh/local] Failed to spawn:', msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
