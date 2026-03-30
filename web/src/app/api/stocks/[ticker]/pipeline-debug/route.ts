import { NextResponse } from 'next/server'
import { getPipelineDebug } from '@/lib/queries/ai-analysis'

interface RouteParams {
  params: Promise<{ ticker: string }>
}

export async function GET(_req: Request, { params }: RouteParams) {
  const { ticker } = await params
  const debug = await getPipelineDebug(ticker.toUpperCase())

  if (!debug) {
    return NextResponse.json(
      { error: 'No pipeline data found' },
      { status: 404 },
    )
  }

  return NextResponse.json(debug)
}
