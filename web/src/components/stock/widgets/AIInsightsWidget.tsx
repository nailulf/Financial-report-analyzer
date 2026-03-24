// Insight AI — ganti dengan integrasi layanan AI yang sebenarnya saat tersedia
const MOCK_INSIGHTS = [
  { text: 'Ekspansi NIM didorong oleh suku bunga pinjaman yang lebih tinggi dan biaya dana yang stabil. Margin terbaik di antara emiten berkapitalisasi besar.', high: true },
  { text: 'Transformasi digital menjadi katalis pertumbuhan signifikan untuk pendapatan komisi dan akuisisi nasabah di masa depan.', high: true },
  { text: 'Valuasi saat ini berada di level wajar dengan potensi kenaikan berdasarkan pertumbuhan laba ke depan.', high: false },
  { text: 'Risiko utama: potensi kompresi NIM jika bank sentral menurunkan suku bunga acuan.', high: false },
]

const MOCK_SIGNALS = ['CASA KUAT', 'NPL RENDAH', 'PERTUMBUHAN DIGITAL', 'MARGIN STABIL']

interface Props {
  ticker: string
}

export function AIInsightsWidget({ ticker: _ticker }: Props) {
  return (
    <div className="px-12 py-2">
      <div className="bg-white border border-[#E0E0E5] p-5 flex flex-col gap-3">
        <span className="font-mono text-[13px] font-bold tracking-[0.5px] text-[#1A1A1A]">
          ANALISIS AI — DIDUKUNG OLEH DAISY
        </span>

        <div className="flex flex-col gap-1.5">
          {MOCK_INSIGHTS.map((ins, i) => (
            <div key={i} className="flex items-start gap-2">
              <span
                className={`font-mono text-[11px] font-bold tracking-[0.5px] px-1.5 py-0.5 shrink-0 mt-0.5 ${
                  ins.high
                    ? 'bg-[#00FF8820] text-[#00FF88] border border-[#00FF8840]'
                    : 'bg-[#F5F5F8] text-[#888888] border border-[#E0E0E5]'
                }`}
              >
                {ins.high ? 'TINGGI' : 'SEDANG'}
              </span>
              <span className="font-mono text-[13px] text-[#555555] leading-[1.5]">{ins.text}</span>
            </div>
          ))}
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {MOCK_SIGNALS.map((sig) => (
            <span
              key={sig}
              className="font-mono text-[11px] font-bold tracking-[0.5px] text-[#00FF88] bg-[#00FF8818] border border-[#00FF8830] px-2 py-0.5"
            >
              {sig}
            </span>
          ))}
        </div>

        <span className="font-mono text-[11px] text-[#888888]">
          * Analisis ilustratif — hubungkan layanan AI untuk menghasilkan insight nyata
        </span>
      </div>
    </div>
  )
}
