// Investment thesis — replace with real analyst/AI data when available
const MOCK_THESIS =
  'Franchise terdepan di industri dengan jaringan distribusi dan kepercayaan merek yang tak tertandingi. Rasio CASA yang unggul memberikan keunggulan biaya dana yang signifikan dibanding kompetitor, memungkinkan margin bunga bersih yang lebih baik di berbagai siklus suku bunga.'

const MOCK_CATALYSTS = [
  { label: 'Perbankan Digital',   desc: 'Percepatan akuisisi nasabah melalui platform mobile yang mendorong pertumbuhan pendapatan komisi.' },
  { label: 'Komisi & Wealth',     desc: 'Cross-selling asuransi, wealth management, dan produk pembayaran ke basis nasabah yang ada.' },
  { label: 'Ekspansi UKM',        desc: 'Pertumbuhan portofolio kredit UKM dengan imbal hasil tinggi sambil menjaga disiplin kualitas kredit.' },
]

const MOCK_RISKS = [
  { label: 'Risiko Penurunan Suku Bunga', desc: 'Kompresi NIM jika bank sentral menurunkan suku bunga acuan di H2 2026.' },
  { label: 'Kualitas Kredit',              desc: 'Potensi kenaikan NPL di segmen konsumer dan UKM di tengah perlambatan ekonomi.' },
]

export function InvestmentThesisWidget() {
  return (
    <div className="bg-white border border-[#E0E0E5] flex flex-col h-full">
      {/* Header */}
      <div className="px-5 py-3 border-b border-[#E0E0E5]">
        <span className="font-mono text-[13px] font-bold tracking-[0.5px] text-[#1A1A1A]">TESIS INVESTASI</span>
      </div>

      <div className="p-5 flex flex-col gap-5 flex-1">
        {/* Thesis */}
        <div className="flex flex-col gap-1.5">
          <p className="font-mono text-[13px] text-[#555555] leading-[1.5]">{MOCK_THESIS}</p>
          <span className="font-mono text-[11px] text-[#888888]">* Ilustrasi — hubungkan sumber data analis</span>
        </div>

        {/* Divider */}
        <div className="h-px bg-[#E0E0E5]" />

        {/* Catalysts */}
        <div className="flex flex-col gap-2">
          <span className="font-mono text-[11px] font-bold tracking-[0.5px] text-[#888888] uppercase">KATALIS UTAMA</span>
          <div className="flex flex-col gap-2">
            {MOCK_CATALYSTS.map((c, i) => (
              <div key={i} className="flex items-start gap-2">
                <span className="font-mono text-[12px] font-bold text-[#00FF88] mt-0.5 shrink-0">+</span>
                <div>
                  <span className="font-mono text-[13px] font-semibold text-[#1A1A1A]">{c.label} — </span>
                  <span className="font-mono text-[13px] text-[#555555]">{c.desc}</span>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Divider */}
        <div className="h-px bg-[#E0E0E5]" />

        {/* Risks */}
        <div className="flex flex-col gap-2">
          <span className="font-mono text-[11px] font-bold tracking-[0.5px] text-[#888888] uppercase">RISIKO UTAMA</span>
          <div className="flex flex-col gap-2">
            {MOCK_RISKS.map((r, i) => (
              <div key={i} className="flex items-start gap-2">
                <span className="font-mono text-[12px] font-bold text-red-400 mt-0.5 shrink-0">!</span>
                <div>
                  <span className="font-mono text-[13px] font-semibold text-[#1A1A1A]">{r.label} — </span>
                  <span className="font-mono text-[13px] text-[#555555]">{r.desc}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
