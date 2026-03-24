import { getStockBrokerSummary } from '@/lib/queries/broker'

export async function GET(
  req: Request,
  { params }: { params: Promise<{ ticker: string }> },
) {
  const { ticker } = await params
  const url = new URL(req.url)
  const days = Math.min(parseInt(url.searchParams.get('days') ?? '10', 10), 60)
  const endDate = url.searchParams.get('endDate') ?? undefined

  const data = await getStockBrokerSummary(ticker.toUpperCase(), days, endDate)
  return Response.json(data)
}
