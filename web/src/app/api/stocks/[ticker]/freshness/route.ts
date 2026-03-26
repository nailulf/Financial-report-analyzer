import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import type { CategoryFreshness, FreshnessStatus } from '@/lib/types/api'

interface RouteParams {
  params: Promise<{ ticker: string }>
}

// Thresholds (in days) for each category to be considered "fresh"
const THRESHOLDS: Record<string, number> = {
  daily_prices:     3,    // covers weekends
  money_flow:       3,
  financials:       90,   // quarterly cadence
  company_profiles: 90,
  document_links:   90,
  corporate_events: 90,
  dividend_history: 30,
  broker_flow:      7,
  stock_universe:   30,
}

function computeStatus(lastDate: string | null, thresholdDays: number): { status: FreshnessStatus; daysSince: number | null } {
  if (!lastDate) return { status: 'missing', daysSince: null }
  const diffMs = Date.now() - new Date(lastDate).getTime()
  const daysSince = Math.floor(diffMs / 86_400_000)
  return {
    status: daysSince <= thresholdDays ? 'fresh' : 'stale',
    daysSince,
  }
}

export async function GET(_req: NextRequest, { params }: RouteParams) {
  const { ticker } = await params
  const t = ticker.toUpperCase()
  const supabase = await createClient()

  // Run all queries in parallel — each returns at most 1 row
  const [priceRes, financialsRes, profileRes, brokerRes, dividendRes, stockRes, docsRes, eventsRes] = await Promise.all([
    supabase.from('daily_prices').select('date').eq('ticker', t).order('date', { ascending: false }).limit(1),
    supabase.from('financials').select('last_updated').eq('ticker', t).order('last_updated', { ascending: false }).limit(1),
    supabase.from('company_profiles').select('last_updated').eq('ticker', t).limit(1),
    supabase.from('broker_flow').select('trade_date').eq('ticker', t).order('trade_date', { ascending: false }).limit(1),
    supabase.from('dividend_history').select('last_updated').eq('ticker', t).order('last_updated', { ascending: false }).limit(1),
    supabase.from('stocks').select('last_updated').eq('ticker', t).limit(1),
    // These tables may not exist yet — errors are treated as "missing"
    supabase.from('document_links').select('fetched_at').eq('ticker', t).order('fetched_at', { ascending: false }).limit(1),
    supabase.from('corporate_events').select('fetched_at').eq('ticker', t).order('fetched_at', { ascending: false }).limit(1),
  ])

  const extract = (res: { data: any[] | null; error: any }, field: string): string | null => {
    if (res.error || !res.data || res.data.length === 0) return null
    return res.data[0]?.[field] ?? null
  }

  const priceDate    = extract(priceRes, 'date')
  const finDate      = extract(financialsRes, 'last_updated')
  const profileDate  = extract(profileRes, 'last_updated')
  const brokerDate   = extract(brokerRes, 'trade_date')
  const dividendDate = extract(dividendRes, 'last_updated')
  const stockDate    = extract(stockRes, 'last_updated')
  const docsDate     = extract(docsRes, 'fetched_at')
  const eventsDate   = extract(eventsRes, 'fetched_at')

  const categories: CategoryFreshness[] = [
    {
      category: 'daily_prices',
      label: 'Harga Harian',
      lastUpdated: priceDate,
      ...computeStatus(priceDate, THRESHOLDS.daily_prices),
      scrapers: ['daily_prices'],
    },
    {
      category: 'money_flow',
      label: 'Arus Dana Asing',
      lastUpdated: priceDate, // money_flow writes to daily_prices.foreign_net
      ...computeStatus(priceDate, THRESHOLDS.money_flow),
      scrapers: ['money_flow'],
    },
    {
      category: 'financials',
      label: 'Data Keuangan',
      lastUpdated: finDate,
      ...computeStatus(finDate, THRESHOLDS.financials),
      scrapers: ['financials_fallback'],
    },
    {
      category: 'company_profiles',
      label: 'Profil Perusahaan',
      lastUpdated: profileDate,
      ...computeStatus(profileDate, THRESHOLDS.company_profiles),
      scrapers: ['stock_universe', 'company_profiles'],
    },
    {
      category: 'broker_flow',
      label: 'Broker Summary',
      lastUpdated: brokerDate,
      ...computeStatus(brokerDate, THRESHOLDS.broker_flow),
      scrapers: ['broker_backfill'],
    },
    {
      category: 'dividend_history',
      label: 'Riwayat Dividen',
      lastUpdated: dividendDate,
      ...computeStatus(dividendDate, THRESHOLDS.dividend_history),
      scrapers: ['dividend_scraper'],
    },
    {
      category: 'documents',
      label: 'Dokumen & Aksi Korporasi',
      lastUpdated: docsDate ?? eventsDate,
      ...computeStatus(docsDate ?? eventsDate, THRESHOLDS.document_links),
      scrapers: ['document_links', 'corporate_events'],
    },
  ]

  return NextResponse.json({ categories }, { headers: { 'Cache-Control': 'no-store' } })
}
