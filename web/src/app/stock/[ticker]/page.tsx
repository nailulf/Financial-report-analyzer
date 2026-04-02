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
import { getDividendHistory } from '@/lib/queries/dividends'
import { getStockBrokerSummary, getInsiderTransactions, getDailyBrokerFlowByType, getBrokerConcentration } from '@/lib/queries/broker'
import { computeCAGR } from '@/lib/calculations/cagr'
import { computeHealthScores } from '@/lib/calculations/health-score'
import { getSubsectorPeers, getPeerCAGR } from '@/lib/queries/sector'
import { computePeerPercentiles, computeGrowthPercentiles } from '@/lib/calculations/percentile'
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
    insiderTransactions,
    dailyBrokerFlow,
    brokerConcentration,
    dividendHistory,
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
    getStockBrokerSummary(t, 30),
    getInsiderTransactions(t),
    getDailyBrokerFlowByType(t, 30),
    getBrokerConcentration(t, 30),
    getDividendHistory(t),
  ])

  if (!header) notFound()

  // Data quality fetched separately so a missing view row doesn't block the page
  const quality = await getDataQuality(t).catch(() => null)

  const cagr   = computeCAGR(series)
  const latest = series.at(-1) ?? null
  const health = latest ? computeHealthScores(latest) : []

  // Sector peer percentiles
  const subsectorLabel = header.subsector ?? header.sector ?? 'Unknown'
  const [sectorPeers, peerCAGR] = await Promise.all([
    getSubsectorPeers(header.subsector, header.sector),
    getPeerCAGR(header.subsector, header.sector),
  ])
  const peerPercentiles = computePeerPercentiles(t, sectorPeers, subsectorLabel)

  // Merge growth percentiles into peerPercentiles (if we have peer CAGR data)
  if (peerPercentiles && peerCAGR.size > 0) {
    peerPercentiles.growth = computeGrowthPercentiles(t, cagr, peerCAGR, subsectorLabel)
  }

  // Pre-compute DCF inputs server-side for reliable serialization
  const latestPrice = priceHistory.at(-1)?.close ?? metrics?.price ?? null
  const dcfFcf = latest?.free_cash_flow
    ?? (latest?.operating_cash_flow != null
      ? latest.operating_cash_flow - Math.abs(latest.capex ?? 0)
      : null)
  const dcfShares = header?.listed_shares
    ?? (header?.market_cap && latestPrice && latestPrice > 0
      ? header.market_cap / latestPrice
      : null)
    ?? (metrics?.eps && metrics.eps > 0 && latest?.net_income
      ? Math.round(latest.net_income / metrics.eps)
      : null)

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
      insiderTransactions={insiderTransactions}
      dailyBrokerFlow={dailyBrokerFlow}
      brokerConcentration={brokerConcentration}
      dividendHistory={dividendHistory}
      peerPercentiles={peerPercentiles}
      dcfFcf={dcfFcf}
      dcfDividends={(() => {
        // Latest year (TTM) often has null dividends — fall back to most recent year with data
        const divRow = [...series].reverse().find((r) => r.dividends_paid != null)
        return divRow?.dividends_paid != null ? Math.abs(divRow.dividends_paid) : null
      })()}
      dcfNetIncome={latest?.net_income ?? null}
      dcfShares={dcfShares}
    />
  )
}
