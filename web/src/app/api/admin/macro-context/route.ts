import { NextResponse } from 'next/server'
import { promises as fs } from 'fs'
import path from 'path'

const MACRO_PATH = path.join(process.cwd(), '..', 'shared', 'macro-context.json')

export async function GET() {
  try {
    const content = await fs.readFile(MACRO_PATH, 'utf-8')
    const data = JSON.parse(content)
    return NextResponse.json(data)
  } catch {
    return NextResponse.json(
      { error: 'macro-context.json not found', as_of: 'unknown' },
      { status: 404 },
    )
  }
}
