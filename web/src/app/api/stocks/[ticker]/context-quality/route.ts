import { NextResponse } from 'next/server'
import { getContextQuality } from '@/lib/queries/ai-analysis'

interface RouteParams {
  params: Promise<{ ticker: string }>
}

export async function GET(_req: Request, { params }: RouteParams) {
  const { ticker } = await params
  const quality = await getContextQuality(ticker.toUpperCase())

  if (!quality) {
    return NextResponse.json(
      { error: 'No context quality data found for this ticker' },
      { status: 404 },
    )
  }

  return NextResponse.json(quality)
}
