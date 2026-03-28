import { getStockBrokerSummary, getSmartMoneyData } from '@/lib/queries/broker'

export async function GET(
  req: Request,
  { params }: { params: Promise<{ ticker: string }> },
) {
  const { ticker } = await params
  const url = new URL(req.url)
  const days = Math.min(parseInt(url.searchParams.get('days') ?? '10', 10), 200)
  const endDate = url.searchParams.get('endDate') ?? undefined
  const mode = url.searchParams.get('mode')

  const t = ticker.toUpperCase()

  if (mode === 'smart-money') {
    const data = await getSmartMoneyData(t, days, endDate)
    return Response.json(data)
  }

  const data = await getStockBrokerSummary(t, days, endDate)
  return Response.json(data)
}
