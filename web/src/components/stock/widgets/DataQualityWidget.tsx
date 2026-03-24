import type { DataQuality } from '@/lib/types/api'
import { DataQualityPanel } from '@/components/stock/data-quality-panel'

interface Props {
  quality: DataQuality | null
  ticker: string
}

export function DataQualityWidget({ quality, ticker }: Props) {
  if (!quality) return null

  return (
    <div className="bg-white border border-[#E0E0E5] flex flex-col">
      <div className="px-5 py-3 border-b border-[#E0E0E5]">
        <span className="font-mono text-[13px] font-bold tracking-[0.5px] text-[#1A1A1A]">KUALITAS DATA</span>
      </div>
      <div className="p-5">
        <DataQualityPanel data={quality} ticker={ticker} />
      </div>
    </div>
  )
}
