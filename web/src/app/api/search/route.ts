import { NextRequest, NextResponse } from 'next/server'
import { searchStocks } from '@/lib/queries/stocks'

export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams.get('q') ?? ''
  if (q.length < 1) return NextResponse.json([])

  try {
    const results = await searchStocks(q)
    return NextResponse.json(results)
  } catch {
    return NextResponse.json([], { status: 500 })
  }
}
