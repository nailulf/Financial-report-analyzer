// Prospek sektor — ganti dengan data makro/sektor saat tersedia
const MOCK_OUTLOOK = [
  {
    title: 'SEKTOR PERBANKAN',
    trend: 'STABIL',
    desc: 'NIM tertekan namun kualitas kredit tetap sehat di bank-bank berkapitalisasi besar.',
    color: '#00FF88',
  },
  {
    title: 'PEMBAYARAN DIGITAL',
    trend: 'TUMBUH',
    desc: 'Volume transaksi tumbuh 25%+ YoY di platform pembayaran digital utama.',
    color: '#00FF88',
  },
  {
    title: 'LINGKUNGAN MAKRO',
    trend: 'PANTAU',
    desc: 'Ekspektasi penurunan suku bunga dapat menekan NIM di H2 2026.',
    color: '#F59E0B',
  },
  {
    title: 'REGULASI',
    trend: 'NETRAL',
    desc: 'Persyaratan permodalan OJK stabil. Tidak ada perubahan kebijakan besar dalam waktu dekat.',
    color: '#888888',
  },
  {
    title: 'PERTUMBUHAN KREDIT',
    trend: 'MODERAT',
    desc: 'Pertumbuhan kredit sistem ~8–10% didorong oleh ekspansi segmen konsumer dan UMKM.',
    color: '#00FF88',
  },
  {
    title: 'ARUS DANA ASING',
    trend: 'MASUK',
    desc: 'Pembelian bersih asing di sektor perbankan berlanjut selama 20 hari terakhir.',
    color: '#00FF88',
  },
]

export function SectorOutlookWidget() {
  return (
    <div className="px-12 py-2">
      <div className="flex flex-col gap-3">
        <span className="font-mono text-[13px] font-bold tracking-[0.5px] text-[#1A1A1A]">
          PROSPEK SEKTOR &amp; INDUSTRI
        </span>
        <div className="grid grid-cols-3 gap-2">
          {MOCK_OUTLOOK.map((item) => (
            <div key={item.title} className="bg-white border border-[#E0E0E5] p-4 flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <span className="font-mono text-[12px] font-bold text-[#1A1A1A] tracking-[0.5px]">
                  {item.title}
                </span>
                <span
                  className="font-mono text-[11px] font-bold px-1.5 py-0.5"
                  style={{
                    color: item.color,
                    backgroundColor: `${item.color}15`,
                    border: `1px solid ${item.color}40`,
                  }}
                >
                  {item.trend}
                </span>
              </div>
              <p className="font-mono text-[12px] text-[#555555] leading-[1.4]">{item.desc}</p>
            </div>
          ))}
        </div>
        <span className="font-mono text-[11px] text-[#888888]">
          * Data ilustrasi — hubungkan sumber data makro/sektor
        </span>
      </div>
    </div>
  )
}
