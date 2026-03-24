import type { QuarterlyFinancial } from '@/lib/types/api'
import { QuarterlyTable } from '@/components/stock/quarterly-table'

interface Props {
  quarterly: QuarterlyFinancial[]
  annual: QuarterlyFinancial[]
}

export function FinancialHighlightsWidget({ quarterly, annual }: Props) {
  if (quarterly.length === 0 && annual.length === 0) return null

  return (
    <div className="px-12 py-2">
      <div className="bg-white border border-[#E0E0E5] flex flex-col">
        <div className="px-5 py-3 border-b border-[#E0E0E5]">
          <span className="font-mono text-[13px] font-bold tracking-[0.5px] text-[#1A1A1A]">
            SOROTAN KEUANGAN
          </span>
        </div>
        <div className="p-5">
          <QuarterlyTable quarterlyData={quarterly} annualData={annual} />
        </div>
      </div>
    </div>
  )
}
