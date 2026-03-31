import type { QuarterlyFinancial } from '@/lib/types/api'
import { ValuationCalculator } from '@/components/stock/valuation-calculator'

interface Props {
  eps: number | null
  bvps: number | null
  fcf: number | null
  dividends: number | null
  netIncome: number | null
  currentPrice: number | null
  shares: number | null
  defaultGrowthRate: number
  peRatio: number | null
  pbRatio: number | null
  annualHistory: QuarterlyFinancial[]
}

export function ValuationWidget({
  eps, bvps, fcf, dividends, netIncome, currentPrice, shares, defaultGrowthRate,
  peRatio, pbRatio, annualHistory,
}: Props) {
  if (!eps && !bvps && !fcf && !dividends && !netIncome) return null

  return (
    <div className="bg-white border border-[#E0E0E5] flex flex-col">
      <div className="px-5 py-3 border-b border-[#E0E0E5]">
        <span className="font-mono text-[13px] font-bold tracking-[0.5px] text-[#1A1A1A]">
          ANALISIS VALUASI
        </span>
      </div>
      <div className="p-4">
        <ValuationCalculator
          eps={eps}
          bvps={bvps}
          fcf={fcf}
          dividends={dividends}
          netIncome={netIncome}
          currentPrice={currentPrice}
          shares={shares}
          defaultGrowthRate={defaultGrowthRate}
          peRatio={peRatio}
          pbRatio={pbRatio}
          annualHistory={annualHistory}
        />
      </div>
    </div>
  )
}
