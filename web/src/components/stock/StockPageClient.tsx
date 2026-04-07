'use client'

import type {
  StockHeader,
  StockMetrics,
  FinancialYear,
  QuarterlyFinancial,
  CAGRResult,
  HealthScore,
  PricePoint,
  CompanyProfileData,
  Officer,
  Shareholder,
  DataQuality,
} from '@/lib/types/api'
import type { StockBrokerSummary, InsiderTransactionRow, DailyFlowByType, BrokerConcentrationRow } from '@/lib/queries/broker'
import type { AnnualDPS } from '@/lib/queries/dividends'
import type { PeerPercentiles } from '@/lib/calculations/percentile'

import { HeroBar }                  from './widgets/HeroBar'
import { NavTabs }                  from './widgets/NavTabs'
import { AIInsightsWidget }         from './widgets/AIInsightsWidget'
import { BrokerActivityWidget }     from './widgets/BrokerActivityWidget'
import { PriceWidget }               from './widgets/PriceWidget'
import { ShareholdersWidget }       from './widgets/ShareholdersWidget'
import { FinancialStatementsWidget } from './widgets/FinancialStatementsWidget'
import { CompanyMetricsWidget }      from './widgets/CompanyMetricsWidget'
import { FinancialHighlightsWidget } from './widgets/FinancialHighlightsWidget'
import { ValuationWidget }          from './widgets/ValuationWidget'
import { DividendWidget }           from './widgets/DividendWidget'
import { CompanyProfileWidget }     from './widgets/CompanyProfileWidget'
import { DataQualityWidget }        from './widgets/DataQualityWidget'
import { PipelineDebugWidget }     from './widgets/PipelineDebugWidget'
import { AnalystInsightWidget }     from './widgets/AnalystInsightWidget'
import { SectionDivider }           from './widgets/SectionDivider'
import { MarketPhaseWidget }        from './widgets/MarketPhaseWidget'

export interface StockPageProps {
  header:             StockHeader
  metrics:            StockMetrics | null
  series:             FinancialYear[]
  quarterly:          QuarterlyFinancial[]
  annualTable:        QuarterlyFinancial[]
  priceHistory:       PricePoint[]
  profile:            CompanyProfileData | null
  officers:           Officer[]
  shareholders:       Shareholder[]
  majorShareholders:  Shareholder[]
  shareholderHistory: Shareholder[][]
  quality:            DataQuality | null
  cagr:               CAGRResult[]
  health:             HealthScore[]
  brokerSummary:      StockBrokerSummary | null
  insiderTransactions: InsiderTransactionRow[]
  dailyBrokerFlow:    DailyFlowByType[]
  brokerConcentration: BrokerConcentrationRow[]
  dividendHistory:    AnnualDPS[]
  peerPercentiles:    PeerPercentiles | null
  // Pre-computed DCF inputs (server-side, avoids serialization issues)
  dcfFcf:             number | null
  dcfDividends:       number | null   // abs(dividends_paid) — for DDM
  dcfNetIncome:       number | null   // net_income — for earnings-based DCF
  dcfShares:          number | null
}

export function StockPageClient({
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
  quality,
  cagr,
  health,
  brokerSummary,
  insiderTransactions,
  dailyBrokerFlow,
  brokerConcentration,
  dividendHistory,
  peerPercentiles,
  dcfFcf,
  dcfDividends,
  dcfNetIncome,
  dcfShares,
}: StockPageProps) {
  const latestYear    = series.at(-1) ?? null
  const latestPrice   = priceHistory.at(-1)?.close ?? metrics?.price ?? null
  const defaultGrowth = cagr.find((c) => c.metric === 'revenue')?.cagr_3yr ?? 10
  const displayedShareholders = majorShareholders.length > 0 ? majorShareholders : shareholders

  return (
    <div className="bg-[#F8F8FA] min-h-screen max-w-[1400px] mx-auto">

      {/* ── Stock identity bar ──────────────────────────────────────── */}
      <HeroBar header={header} metrics={metrics} priceHistory={priceHistory} />

      {/* ── Anchor navigation tabs ──────────────────────────────────── */}
      <NavTabs />

      {/* ═══════════════════════════════════════════════════════════════
          OVERVIEW  — verdict · AI insights · metrics · valuation · thesis
      ═══════════════════════════════════════════════════════════════ */}
      <div id="overview" className="scroll-mt-24 pt-2 flex flex-col gap-0">

        <AIInsightsWidget ticker={header.ticker} />

        {/* Valuation widget (full width — thesis now merged into AI Insights above) */}
        <div className="px-12 py-2">
          <ValuationWidget
            eps={metrics?.eps ?? null}
            bvps={metrics?.book_value_per_share ?? null}
            fcf={dcfFcf}
            dividends={dcfDividends}
            netIncome={dcfNetIncome}
            currentPrice={latestPrice}
            shares={dcfShares}
            defaultGrowthRate={defaultGrowth}
            peRatio={metrics?.pe_ratio ?? null}
            pbRatio={metrics?.pbv_ratio ?? null}
            annualHistory={annualTable}
          />
        </div>

        <div className="px-12 py-2">
          <AnalystInsightWidget ticker={header.ticker} />
        </div>

        <PriceWidget ticker={header.ticker} priceHistory={priceHistory} />
      </div>

      {/* ═══════════════════════════════════════════════════════════════
          FUNDAMENTALS
      ═══════════════════════════════════════════════════════════════ */}
      <SectionDivider
        id="fundamentals"
        title="FUNDAMENTAL"
        subtitle="Tren pendapatan, tingkat pertumbuhan, kesehatan keuangan, segmen bisnis, dan riwayat dividen"
      />
      <div className="flex flex-col gap-0">
        <FinancialStatementsWidget annual={annualTable} quarterly={quarterly} />
        <CompanyMetricsWidget ticker={header.ticker} metrics={metrics} latestYear={latestYear} cagr={cagr} health={health} peerPercentiles={peerPercentiles} />
        <FinancialHighlightsWidget quarterly={quarterly} annual={annualTable} />
        <div className="px-12 py-2">
          <DividendWidget
            dividendHistory={dividendHistory}
            series={series}
            dividendYield={metrics?.dividend_yield ?? null}
            price={metrics?.price ?? latestPrice}
          />
        </div>
      </div>

      {/* ═══════════════════════════════════════════════════════════════
          MONEY FLOW
      ═══════════════════════════════════════════════════════════════ */}
      <SectionDivider
        id="money-flow"
        title="ARUS DANA"
        subtitle="Aktivitas broker, kepemilikan institusi, dan sentimen pasar"
      />
      <div className="px-12 py-2 flex gap-3 items-start">
        <div className="w-[70%]">
          <BrokerActivityWidget
            ticker={header.ticker}
            initialData={brokerSummary}
            insiderTransactions={insiderTransactions}
            dailyBrokerFlow={dailyBrokerFlow}
            brokerConcentration={brokerConcentration}
          />
        </div>
        <div className="w-[30%]">
          <ShareholdersWidget
            shareholders={displayedShareholders}
            shareholderHistory={shareholderHistory}
          />
        </div>
      </div>

      {/* ═══════════════════════════════════════════════════════════════
          MARKET PHASE
      ═══════════════════════════════════════════════════════════════ */}
      <SectionDivider
        id="market-phase"
        title="FASE PASAR"
        subtitle="Deteksi siklus pasar dari pola harga dan volume"
      />
      <div className="px-12 py-2">
        <MarketPhaseWidget ticker={header.ticker} priceHistory={priceHistory} />
      </div>

      {/* ═══════════════════════════════════════════════════════════════
          ABOUT
      ═══════════════════════════════════════════════════════════════ */}
      <SectionDivider
        id="about"
        title="TENTANG"
        subtitle="Profil perusahaan, manajemen, berita, dan kualitas data"
      />
      <div className="flex flex-col gap-0">
        <div className="py-2 px-12">
          <CompanyProfileWidget profile={profile} officers={officers} />
        </div>
        <div className="py-2 px-12">
          <DataQualityWidget quality={quality} ticker={header.ticker} />
          <PipelineDebugWidget ticker={header.ticker} subsector={header.subsector ?? null} />
        </div>
      </div>

      {/* ── Footer ──────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between bg-white border-t border-[#E0E0E5] px-12 py-4 mt-4">
        <p className="font-mono text-[11px] text-[#888888] leading-[1.5] max-w-3xl">
          // DISCLAIMER: INI BUKAN SARAN KEUANGAN. DATA DISAJIKAN HANYA UNTUK TUJUAN INFORMASI.
          KINERJA MASA LALU TIDAK MENJAMIN HASIL DI MASA DEPAN.
        </p>
        <span className="font-mono text-[11px] text-[#888888] tracking-[0.5px]">IDX ANALYZER</span>
      </div>
    </div>
  )
}
