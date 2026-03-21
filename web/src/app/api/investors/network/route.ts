import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import type { GraphNode, GraphLink, InvestorGraphData } from '@/lib/types/network'

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const sector = searchParams.get('sector') ?? null

  const supabase = await createClient()

  // 1. Get the latest available report date
  const { data: latestRow, error: dateError } = await supabase
    .from('shareholders_major')
    .select('report_date')
    .order('report_date', { ascending: false })
    .limit(1)
    .maybeSingle()      // maybeSingle() returns null (not an error) when 0 rows found

  if (dateError) {
    // Surface the real error — most likely cause: schema-v7 migration not applied yet
    console.error('[investors/network] date query failed:', dateError)
    return NextResponse.json(
      { error: dateError.message, hint: 'Have you applied docs/schema-v7-shareholders-major.sql in Supabase?' },
      { status: 500 }
    )
  }

  if (!latestRow) {
    return NextResponse.json<InvestorGraphData>({ nodes: [], links: [], report_date: null })
  }

  const reportDate: string = (latestRow as any).report_date

  // 2. Fetch all holder rows for this date — paginate to bypass PostgREST max_rows cap
  const BATCH = 1000
  const allHolders: any[] = []
  let from = 0

  while (true) {
    const { data: batch, error: batchError } = await supabase
      .from('shareholders_major')
      .select('holder_name, holder_type, ticker, percentage')
      .eq('report_date', reportDate)
      .range(from, from + BATCH - 1)

    if (batchError) {
      console.error('[investors/network] holders query failed:', batchError)
      return NextResponse.json({ error: batchError.message }, { status: 500 })
    }

    if (!batch || batch.length === 0) break
    allHolders.push(...batch)
    if (batch.length < BATCH) break
    from += BATCH
  }

  const holders = allHolders

  if (holders.length === 0) {
    return NextResponse.json<InvestorGraphData>({ nodes: [], links: [], report_date: reportDate })
  }

  // 3. Fetch stock metadata separately (name + sector) for all tickers in this snapshot
  const tickers = [...new Set((holders as any[]).map((h) => h.ticker as string))]

  const { data: stockRows, error: stocksError } = await supabase
    .from('stocks')
    .select('ticker, name, sector')
    .in('ticker', tickers)
    .range(0, 1999)

  if (stocksError) {
    console.error('[investors/network] stocks query failed:', stocksError)
    // Non-fatal — we'll just show nodes without name/sector
  }

  const stockMeta = new Map<string, { name: string | null; sector: string | null }>()
  for (const s of (stockRows ?? []) as any[]) {
    stockMeta.set(s.ticker, { name: s.name ?? null, sector: s.sector ?? null })
  }

  // 4. Build graph
  const investorMap = new Map<string, {
    holder_type: string | null
    stock_count: number
    total_pct: number
  }>()

  const stockMap = new Map<string, {
    name: string | null
    sector: string | null
    investor_count: number
  }>()

  const links: GraphLink[] = []

  for (const h of holders as any[]) {
    const invName: string = h.holder_name
    const ticker: string  = h.ticker
    const pct: number     = Number(h.percentage)
    const meta            = stockMeta.get(ticker) ?? { name: null, sector: null }

    if (sector && meta.sector !== sector) continue

    if (!investorMap.has(invName)) {
      investorMap.set(invName, { holder_type: h.holder_type ?? null, stock_count: 0, total_pct: 0 })
    }
    const inv = investorMap.get(invName)!
    inv.stock_count++
    inv.total_pct = Math.round((inv.total_pct + pct) * 10000) / 10000

    if (!stockMap.has(ticker)) {
      stockMap.set(ticker, { name: meta.name, sector: meta.sector, investor_count: 0 })
    }
    stockMap.get(ticker)!.investor_count++

    links.push({ source: `inv:${invName}`, target: `stk:${ticker}`, percentage: pct })
  }

  const nodes: GraphNode[] = [
    ...Array.from(investorMap.entries()).map(([name, d]): GraphNode => ({
      id: `inv:${name}`, label: name, type: 'investor',
      holder_type: d.holder_type, stock_count: d.stock_count, total_pct: d.total_pct,
    })),
    ...Array.from(stockMap.entries()).map(([ticker, d]): GraphNode => ({
      id: `stk:${ticker}`, label: ticker, type: 'stock',
      sector: d.sector, stock_name: d.name, investor_count: d.investor_count,
    })),
  ]

  console.log(`[investors/network] ${nodes.length} nodes, ${links.length} links, date=${reportDate}`)

  return NextResponse.json<InvestorGraphData>({ nodes, links, report_date: reportDate })
}
