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
import type { StockBrokerSummary } from '@/lib/queries/broker'

import { HeroBar }                  from './widgets/HeroBar'
import { NavTabs }                  from './widgets/NavTabs'
import { VerdictWidget }            from './widgets/VerdictWidget'
import { AIInsightsWidget }         from './widgets/AIInsightsWidget'
import { FundamentalsWidget }       from './widgets/FundamentalsWidget'
import { BrokerActivityWidget }     from './widgets/BrokerActivityWidget'
import { InvestmentThesisWidget }   from './widgets/InvestmentThesisWidget'
import { TechnicalWidget }          from './widgets/TechnicalWidget'
import { PriceWidget }              from './widgets/PriceWidget'
import { ShareholdersWidget }       from './widgets/ShareholdersWidget'
import { SentimentWidget }          from './widgets/SentimentWidget'
import { SectorOutlookWidget }      from './widgets/SectorOutlookWidget'
import { ProductsWidget }           from './widgets/ProductsWidget'
import { FinancialChartsWidget }    from './widgets/FinancialChartsWidget'
import { GrowthHealthWidget }       from './widgets/GrowthHealthWidget'
import { FinancialHighlightsWidget } from './widgets/FinancialHighlightsWidget'
import { ValuationWidget }          from './widgets/ValuationWidget'
import { StoriesWidget }            from './widgets/StoriesWidget'
import { DividendWidget }           from './widgets/DividendWidget'
import { PeersWidget }              from './widgets/PeersWidget'
import { CompanyProfileWidget }     from './widgets/CompanyProfileWidget'
import { DataQualityWidget }        from './widgets/DataQualityWidget'
import { SectionDivider }           from './widgets/SectionDivider'

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
}: StockPageProps) {
  const latestYear    = series.at(-1) ?? null
  const latestPrice   = priceHistory.at(-1)?.close ?? metrics?.price ?? null
  const shares        = header.market_cap && latestPrice && latestPrice > 0
    ? header.market_cap / latestPrice
    : null
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

        <VerdictWidget ticker={header.ticker} />

        <AIInsightsWidget ticker={header.ticker} />

        {/* Data grid: left = metrics + valuation | right = thesis */}
        <div className="px-12 py-2 flex gap-2 items-start">
          <div className="flex-1 flex flex-col gap-2">
            <FundamentalsWidget ticker={header.ticker} metrics={metrics} latestYear={latestYear} />
            <ValuationWidget
              eps={metrics?.eps ?? null}
              bvps={metrics?.book_value_per_share ?? null}
              fcf={latestYear?.free_cash_flow ?? null}
              currentPrice={latestPrice}
              shares={shares}
              defaultGrowthRate={defaultGrowth}
            />
          </div>
          <div className="w-[480px]">
            <InvestmentThesisWidget />
          </div>
        </div>
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
        <FinancialChartsWidget series={series} />
        <GrowthHealthWidget cagr={cagr} health={health} />
        <FinancialHighlightsWidget quarterly={quarterly} annual={annualTable} />
        <ProductsWidget />
        <div className="px-12 py-2">
          <DividendWidget />
        </div>
      </div>

      {/* ═══════════════════════════════════════════════════════════════
          MONEY FLOW
      ═══════════════════════════════════════════════════════════════ */}
      <SectionDivider
        id="money-flow"
        title="ARUS DANA"
        subtitle="Aktivitas broker, kepemilikan institusi, sentimen pasar, dan prospek sektor"
      />
      <div className="flex flex-col gap-0">
        <div className="px-12 py-2">
          <BrokerActivityWidget ticker={header.ticker} initialData={brokerSummary} />
        </div>
        <div className="py-2 px-12 flex gap-2 items-start">
          <div className="flex-1">
            <ShareholdersWidget
              shareholders={displayedShareholders}
              shareholderHistory={shareholderHistory}
            />
          </div>
          <div className="w-[480px]">
            <SentimentWidget />
          </div>
        </div>
        <SectorOutlookWidget />
      </div>

      {/* ═══════════════════════════════════════════════════════════════
          TECHNICAL
      ═══════════════════════════════════════════════════════════════ */}
      <SectionDivider
        id="technical"
        title="TEKNIKAL"
        subtitle="Level support dan resistance, moving average, dan pergerakan harga"
      />
      <div className="flex flex-col gap-0">
        <TechnicalWidget />
        <PriceWidget ticker={header.ticker} priceHistory={priceHistory} />
      </div>

      {/* ═══════════════════════════════════════════════════════════════
          ABOUT
      ═══════════════════════════════════════════════════════════════ */}
      <SectionDivider
        id="about"
        title="TENTANG"
        subtitle="Perbandingan emiten sejenis, profil perusahaan, manajemen, berita, dan kualitas data"
      />
      <div className="flex flex-col gap-0">
        <div className="py-2 px-12">
          <PeersWidget ticker={header.ticker} sector={header.sector} />
        </div>
        <div className="py-2 px-12">
          <CompanyProfileWidget profile={profile} officers={officers} />
        </div>
        <div className="py-2 px-12">
          <StoriesWidget />
        </div>
        <div className="py-2 px-12">
          <DataQualityWidget quality={quality} ticker={header.ticker} />
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
