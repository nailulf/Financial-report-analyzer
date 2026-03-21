import { notFound } from 'next/navigation'
import { getStockHeader } from '@/lib/queries/stocks'
import { getFinancialSeries, getLatestMetrics, getQuarterlySeries } from '@/lib/queries/financials'
import { getPriceHistory } from '@/lib/queries/prices'
import { getCompanyProfile, getOfficers, getShareholders } from '@/lib/queries/company'
import { getDataQuality } from '@/lib/queries/completeness'
import { computeCAGR } from '@/lib/calculations/cagr'
import { computeHealthScores } from '@/lib/calculations/health-score'
import { StockHeader } from '@/components/stock/stock-header'
import { DataQualityPanel } from '@/components/stock/data-quality-panel'
import { MetricsRow } from '@/components/stock/metrics-row'
import { HealthScorecard } from '@/components/stock/health-scorecard'
import { CAGRTable } from '@/components/stock/cagr-table'
import { ChartsSection } from '@/components/stock/charts-section'
import { PriceHistoryChart } from '@/components/charts/price-history-chart'
import { TradingViewChart } from '@/components/charts/tradingview-chart'
import { QuarterlyTable } from '@/components/stock/quarterly-table'
import { CompanyProfileSection } from '@/components/stock/company-profile-section'
import { ValuationCalculator } from '@/components/stock/valuation-calculator'

interface PageProps {
  params: Promise<{ ticker: string }>
}

export async function generateMetadata({ params }: PageProps) {
  const { ticker } = await params
  return { title: `${ticker.toUpperCase()} — IDX Analyzer` }
}

export default async function StockPage({ params }: PageProps) {
  const { ticker: tickerParam } = await params
  const ticker = tickerParam.toUpperCase()

  const [stock, metrics, series, quarterlyData, priceHistory, profile, officers, shareholders, dataQuality] =
    await Promise.all([
      getStockHeader(ticker),
      getLatestMetrics(ticker),
      getFinancialSeries(ticker),
      getQuarterlySeries(ticker),
      getPriceHistory(ticker),
      getCompanyProfile(ticker),
      getOfficers(ticker),
      getShareholders(ticker),
      getDataQuality(ticker),
    ])

  if (!stock) notFound()

  const cagrResults  = computeCAGR(series)
  const latestYear   = series.at(-1) ?? null
  const healthScores = latestYear ? computeHealthScores(latestYear) : []

  // Valuation inputs
  const latestFCF      = latestYear?.free_cash_flow ?? null
  const sharesEst      = (metrics?.market_cap && metrics?.price && metrics.price > 0)
    ? metrics.market_cap / metrics.price
    : null
  const revenueCAGR3yr = cagrResults.find((r) => r.metric === 'revenue')?.cagr_3yr ?? 10
  const defaultGrowth  = Math.min(Math.max(Math.round(revenueCAGR3yr), 3), 25)

  return (
    <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">
      <StockHeader stock={stock} />

      <DataQualityPanel data={dataQuality} ticker={ticker} />

      {metrics ? (
        <MetricsRow metrics={metrics} />
      ) : (
        <div className="p-4 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-700">
          Financial data not yet available for {ticker}. Run the financials scraper first.
        </div>
      )}

      {/* Live TradingView chart */}
      <TradingViewChart ticker={ticker} />

      {/* Price history (stored data) */}
      <PriceHistoryChart data={priceHistory} ticker={ticker} />

      {/* Annual financials */}
      {series.length > 0 ? (
        <div className="space-y-6">
          <ChartsSection data={series} />
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {cagrResults.length > 0 && <CAGRTable results={cagrResults} />}
            {healthScores.length > 0 && <HealthScorecard scores={healthScores} />}
          </div>
        </div>
      ) : (
        <div className="p-8 text-center text-gray-400 bg-white rounded-xl border border-gray-200">
          <p>No historical financial data available for {ticker}.</p>
          <p className="text-sm mt-1">Run <code className="bg-gray-100 px-1 rounded">python run_all.py --ticker {ticker}</code> to populate data.</p>
        </div>
      )}

      {/* Valuation */}
      <ValuationCalculator
        eps={metrics?.eps ?? null}
        bvps={metrics?.book_value_per_share ?? null}
        fcf={latestFCF}
        currentPrice={metrics?.price ?? null}
        shares={sharesEst}
        defaultGrowthRate={defaultGrowth}
      />

      {/* Quarterly financials */}
      {quarterlyData.length > 0 && <QuarterlyTable data={quarterlyData} />}

      {/* Company profile */}
      <CompanyProfileSection
        profile={profile}
        officers={officers}
        shareholders={shareholders}
      />
    </main>
  )
}
