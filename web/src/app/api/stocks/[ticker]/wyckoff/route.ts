import { getWyckoffEvents } from '@/lib/queries/wyckoff-events'

export async function GET(
  req: Request,
  { params }: { params: Promise<{ ticker: string }> },
) {
  const { ticker } = await params
  const url = new URL(req.url)
  const minConfidence = parseInt(url.searchParams.get('minConfidence') ?? '0', 10)
  const versionParam = url.searchParams.get('version')
  const version: '1.0' | '2.0' = versionParam === '2.0' ? '2.0' : '1.0'

  const t = ticker.toUpperCase()
  const data = await getWyckoffEvents(t, minConfidence, version)
  return Response.json(data)
}
