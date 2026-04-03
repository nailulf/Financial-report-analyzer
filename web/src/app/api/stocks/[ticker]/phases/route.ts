import { getMarketPhases } from '@/lib/queries/market-phases'

export async function GET(
  req: Request,
  { params }: { params: Promise<{ ticker: string }> },
) {
  const { ticker } = await params
  const url = new URL(req.url)
  const minClarity = parseInt(url.searchParams.get('minClarity') ?? '0', 10)

  const t = ticker.toUpperCase()
  const data = await getMarketPhases(t, minClarity)
  return Response.json(data)
}
