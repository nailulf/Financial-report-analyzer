import type { CAGRResult, HealthScore } from '@/lib/types/api'
import { CAGRTable } from '@/components/stock/cagr-table'
import { HealthScorecard } from '@/components/stock/health-scorecard'

interface Props {
  cagr: CAGRResult[]
  health: HealthScore[]
}

export function GrowthHealthWidget({ cagr, health }: Props) {
  if (cagr.length === 0 && health.length === 0) return null

  return (
    <div className="px-12 py-2">
      <div className="grid grid-cols-2 gap-2">
        {cagr.length > 0 && (
          <div className="bg-white border border-[#E0E0E5] flex flex-col">
            <div className="px-5 py-3 border-b border-[#E0E0E5]">
              <span className="font-mono text-[13px] font-bold tracking-[0.5px] text-[#1A1A1A]">
                TINGKAT PERTUMBUHAN (CAGR)
              </span>
            </div>
            <div className="p-5">
              <CAGRTable results={cagr} />
            </div>
          </div>
        )}
        {health.length > 0 && (
          <div className="bg-white border border-[#E0E0E5] flex flex-col">
            <div className="px-5 py-3 border-b border-[#E0E0E5]">
              <span className="font-mono text-[13px] font-bold tracking-[0.5px] text-[#1A1A1A]">
                KESEHATAN KEUANGAN
              </span>
            </div>
            <div className="p-5">
              <HealthScorecard scores={health} />
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
