import { notFound } from 'next/navigation'
import { getStockHeader } from '@/lib/queries/stocks'
import {
  getFinancialSeries,
  getLatestMetrics,
  getQuarterlySeries,
  getAnnualSeriesForTable,
} from '@/lib/queries/financials'
import { getPriceHistory } from '@/lib/queries/prices'
import {
  getCompanyProfile,
  getOfficers,
  getShareholders,
  getMajorShareholders,
  getMajorShareholderHistory,
} from '@/lib/queries/company'
import { getDataQuality } from '@/lib/queries/completeness'
import { getStockBrokerSummary } from '@/lib/queries/broker'
import { computeCAGR } from '@/lib/calculations/cagr'
import { computeHealthScores } from '@/lib/calculations/health-score'
import { StockPageClient } from '@/components/stock/StockPageClient'

export default async function StockPage({
  params,
}: {
  params: Promise<{ ticker: string }>
}) {
  const { ticker } = await params
  const t = ticker.toUpperCase()

  const [
    header,
    metrics,
    series,
    quarterly,
    annualTable,
    priceHistory,
    profile,
    officers,
    shareholders,
    majorShareholders,
    shareholderHistory,
    brokerSummary,
  ] = await Promise.all([
    getStockHeader(t),
    getLatestMetrics(t),
    getFinancialSeries(t),
    getQuarterlySeries(t),
    getAnnualSeriesForTable(t),
    getPriceHistory(t, 252),
    getCompanyProfile(t),
    getOfficers(t),
    getShareholders(t),
    getMajorShareholders(t),
    getMajorShareholderHistory(t),
    getStockBrokerSummary(t),
  ])

  if (!header) notFound()

  // Data quality fetched separately so a missing view row doesn't block the page
  const quality = await getDataQuality(t).catch(() => null)

  const cagr   = computeCAGR(series)
  const latest = series.at(-1) ?? null
  const health = latest ? computeHealthScores(latest) : []

  return (
    <StockPageClient
      header={header}
      metrics={metrics}
      series={series}
      quarterly={quarterly}
      annualTable={annualTable}
      priceHistory={priceHistory}
      profile={profile}
      officers={officers}
      shareholders={shareholders}
      majorShareholders={majorShareholders}
      shareholderHistory={shareholderHistory}
      quality={quality}
      cagr={cagr}
      health={health}
      brokerSummary={brokerSummary}
    />
  )
}
