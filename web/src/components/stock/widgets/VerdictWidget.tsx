// Data verdik — ganti dengan sinyal analis/AI yang sebenarnya saat tersedia
const MOCK_BREAKDOWN = [
  { label: 'Fundamental', score: 0 },
  { label: 'Valuasi',     score: 0 },
  { label: 'Momentum',    score: 0 },
  { label: 'Risiko',      score: 0 },
]

interface Props {
  ticker: string
}

export function VerdictWidget({ ticker }: Props) {
  return (
    <div className="flex gap-2 px-12 py-2">
      {/* Left: signal + rationale + TP/Entry/SL */}
      <div className="flex-1 flex items-center justify-between bg-[#00FF8820] border border-[#00FF8840] px-5 py-4">
        <div className="flex items-center gap-4">
          <span className="font-mono text-[12px] font-bold tracking-[1px] text-[#00FF88] bg-[#00FF8825] border border-[#00FF8840] px-[10px] py-1">
            —
          </span>
          <div className="flex flex-col gap-0.5">
            <span className="font-mono text-[13px] font-bold text-[#1A1A1A] tracking-[0.5px]">
              {ticker} — VERDIK
            </span>
            <span className="font-mono text-[13px] text-[#555555]">
              Hubungkan sumber sinyal AI atau analis untuk mengisi verdik
            </span>
          </div>
        </div>
        <div className="flex items-center gap-8">
          {(['TARGET', 'MASUK', 'STOP LOSS'] as const).map((lbl) => (
            <div key={lbl} className="flex flex-col items-center gap-0.5">
              <span className="font-mono text-[11px] font-medium tracking-[0.5px] text-[#888888] uppercase">{lbl}</span>
              <span className="font-mono text-sm font-semibold text-[#1A1A1A]">—</span>
            </div>
          ))}
        </div>
      </div>

      {/* Right: score circle + breakdown */}
      <div className="w-[360px] flex items-center gap-5 bg-white border border-[#E0E0E5] px-5 py-4">
        <div className="w-16 h-16 rounded-full bg-[#00FF8820] border-2 border-[#00FF88] flex flex-col items-center justify-center shrink-0">
          <span className="font-display text-xl font-bold text-[#00FF88] leading-none">—</span>
        </div>
        <div className="flex flex-col gap-2 flex-1">
          <span className="font-mono text-[13px] font-bold text-[#1A1A1A] tracking-[0.5px]">SKOR KESELURUHAN</span>
          <div className="flex flex-col gap-1.5">
            {MOCK_BREAKDOWN.map((b) => (
              <div key={b.label} className="flex items-center gap-2">
                <span className="font-mono text-[11px] text-[#888888] w-20">{b.label}</span>
                <div className="flex-1 h-1 bg-[#E0E0E5]">
                  <div className="h-full bg-[#E0E0E5]" style={{ width: `${b.score}%` }} />
                </div>
                <span className="font-mono text-[11px] text-[#888888] w-4 text-right">—</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
