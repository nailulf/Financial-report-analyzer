import type { FinancialYear } from '@/lib/types/api'
import { ChartsSection } from '@/components/stock/charts-section'

interface Props {
  series: FinancialYear[]
}

export function FinancialChartsWidget({ series }: Props) {
  if (series.length === 0) return null

  return (
    <div className="px-12 py-2">
      <div className="bg-white border border-[#E0E0E5] flex flex-col">
        <div className="px-5 py-3 border-b border-[#E0E0E5]">
          <span className="font-mono text-[13px] font-bold tracking-[0.5px] text-[#1A1A1A]">
            KINERJA KEUANGAN
          </span>
        </div>
        <div className="p-5">
          <ChartsSection data={series} />
        </div>
      </div>
    </div>
  )
}
