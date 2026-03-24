// Sentimen pasar — ganti dengan integrasi umpan data
const METRICS = [
  'SENTIMEN RITEL',
  'KONSENSUS ANALIS',
  'ARUS INSTITUSI',
  'SHORT INTEREST',
  'AKTIVITAS OPSI',
]

export function SentimentWidget() {
  return (
    <div className="bg-white border border-[#E0E0E5] flex flex-col">
      <div className="px-5 py-3 border-b border-[#E0E0E5]">
        <span className="font-mono text-[13px] font-bold tracking-[0.5px] text-[#1A1A1A]">SENTIMEN PASAR</span>
      </div>

      {/* Foreign net flow bar */}
      <div className="flex flex-col gap-2 px-5 py-3 border-b border-[#E0E0E5]">
        <div className="flex items-center justify-between">
          <span className="font-mono text-[12px] text-[#888888] tracking-[0.5px] uppercase">ARUS DANA ASING BERSIH (5H)</span>
          <span className="font-mono text-[13px] font-semibold text-[#888888]">—</span>
        </div>
        <div className="h-2 bg-[#E0E0E5] relative">
          <div className="absolute left-1/2 top-0 bottom-0 w-px bg-[#888888] opacity-40" />
        </div>
        <div className="flex justify-between">
          <span className="font-mono text-[11px] text-[#888888]">JUAL</span>
          <span className="font-mono text-[11px] text-[#888888]">BELI</span>
        </div>
      </div>

      {/* Sentiment metrics */}
      {METRICS.map((m) => (
        <div
          key={m}
          className="flex items-center justify-between px-5 py-2.5 border-b border-[#E0E0E5] last:border-0"
        >
          <span className="font-mono text-[12px] text-[#888888] tracking-[0.5px] uppercase">{m}</span>
          <span className="font-mono text-[13px] font-semibold text-[#888888]">—</span>
        </div>
      ))}
    </div>
  )
}
