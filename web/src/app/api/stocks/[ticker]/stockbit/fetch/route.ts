import { NextRequest, NextResponse } from 'next/server'
import { spawn } from 'child_process'
import path from 'path'
import type { StockbitPreviewRow } from '@/lib/types/api'

// Project root is one level above `web/`
const PROJECT_ROOT  = path.join(process.cwd(), '..')
const PYTHON_SCRIPT = path.join(PROJECT_ROOT, 'python', 'utils', 'stockbit_fetch_cli.py')
// Use the venv Python so curl_cffi is available
const PYTHON_BIN    = path.join(PROJECT_ROOT, '.venv', 'bin', 'python3')

function runPython(
  args: string[],
  timeoutMs = 30_000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const [bin, ...rest] = args
    const proc = spawn(bin, rest, { env: process.env })

    let stdout = ''
    let stderr = ''

    proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })

    const timer = setTimeout(() => {
      proc.kill()
      reject(new Error('Python script timed out after 30s'))
    }, timeoutMs)

    proc.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) {
        // stdout may still contain a JSON error message from the script
        reject(new Error(stdout.trim() || stderr.trim() || `Python exited with code ${code}`))
      } else {
        resolve(stdout.trim())
      }
    })

    proc.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ ticker: string }> },
) {
  const { ticker } = await params
  const body = await req.json() as {
    bearer_token: string
    year_from: number
    year_to: number
  }
  const { bearer_token, year_from, year_to } = body

  if (!bearer_token?.trim()) {
    return NextResponse.json({ error: 'Bearer token is required' }, { status: 400 })
  }

  let stdout: string
  try {
    stdout = await runPython([
      PYTHON_BIN,
      PYTHON_SCRIPT,
      '--ticker',       ticker.toUpperCase(),
      '--bearer-token', bearer_token.trim(),
      '--year-from',    String(year_from),
      '--year-to',      String(year_to),
    ])
  } catch (e: unknown) {
    const raw = e instanceof Error ? e.message : String(e)
    // Try to parse a JSON error the Python script may have printed to stdout
    try {
      const parsed = JSON.parse(raw) as { error?: string }
      if (parsed.error) {
        const status = parsed.error.includes('401') ? 401 : 502
        return NextResponse.json({ error: parsed.error }, { status })
      }
    } catch { /* not JSON — fall through */ }
    return NextResponse.json({ error: `Stockbit fetch failed: ${raw}` }, { status: 502 })
  }

  let result: { rows?: StockbitPreviewRow[]; snapshot?: Record<string, number>; error?: string }
  try {
    result = JSON.parse(stdout)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON from Python script' }, { status: 502 })
  }

  if (result.error) {
    const status = result.error.includes('401') ? 401 : 502
    return NextResponse.json({ error: result.error }, { status })
  }

  return NextResponse.json({ rows: result.rows ?? [], snapshot: result.snapshot ?? {} })
}
