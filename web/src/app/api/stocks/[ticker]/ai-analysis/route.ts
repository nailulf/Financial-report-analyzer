import { NextResponse } from 'next/server'
import { getAIAnalysis } from '@/lib/queries/ai-analysis'

interface RouteParams {
  params: Promise<{ ticker: string }>
}

export async function GET(_req: Request, { params }: RouteParams) {
  const { ticker } = await params
  const analysis = await getAIAnalysis(ticker.toUpperCase())

  if (!analysis) {
    return NextResponse.json(
      { error: 'No AI analysis found for this ticker' },
      { status: 404 },
    )
  }

  return NextResponse.json(analysis)
}
