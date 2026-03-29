import { NextRequest, NextResponse } from 'next/server'
import { spawn } from 'child_process'
import path from 'path'

const PROJECT_ROOT  = path.join(process.cwd(), '..')
const PYTHON_SCRIPT = path.join(PROJECT_ROOT, 'python', 'utils', 'yfinance_analyst_cli.py')
const PYTHON_BIN    = path.join(PROJECT_ROOT, '.venv', 'bin', 'python3')

function runPython(args: string[], timeoutMs = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const [bin, ...rest] = args
    const proc = spawn(bin, rest, { env: process.env })

    let stdout = ''
    let stderr = ''

    proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })

    const timer = setTimeout(() => {
      proc.kill()
      reject(new Error('yfinance analyst fetch timed out after 30s'))
    }, timeoutMs)

    proc.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) {
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

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ ticker: string }> },
) {
  const { ticker } = await params
  const t = ticker.toUpperCase()

  let stdout: string
  try {
    stdout = await runPython([PYTHON_BIN, PYTHON_SCRIPT, '--ticker', t])
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: msg }, { status: 502 })
  }

  try {
    const data = JSON.parse(stdout)
    return NextResponse.json(data)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON from yfinance script' }, { status: 502 })
  }
}
