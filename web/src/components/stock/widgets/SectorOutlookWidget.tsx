'use client'

import { useState } from 'react'

// Prospek sektor — ganti dengan data makro/sektor saat tersedia
const MOCK_OUTLOOK = [
  { title: 'SEKTOR PERBANKAN',    trend: 'STABIL',  desc: 'NIM tertekan namun kualitas kredit tetap sehat di bank-bank berkapitalisasi besar.', color: '#00FF88' },
  { title: 'PEMBAYARAN DIGITAL',  trend: 'TUMBUH',  desc: 'Volume transaksi tumbuh 25%+ YoY di platform pembayaran digital utama.',              color: '#00FF88' },
  { title: 'LINGKUNGAN MAKRO',    trend: 'PANTAU',  desc: 'Ekspektasi penurunan suku bunga dapat menekan NIM di H2 2026.',                       color: '#F59E0B' },
  { title: 'REGULASI',            trend: 'NETRAL',  desc: 'Persyaratan permodalan OJK stabil. Tidak ada perubahan kebijakan besar.',              color: '#888888' },
  { title: 'PERTUMBUHAN KREDIT',  trend: 'MODERAT', desc: 'Pertumbuhan kredit sistem ~8–10% didorong oleh segmen konsumer dan UMKM.',            color: '#00FF88' },
  { title: 'ARUS DANA ASING',    trend: 'MASUK',   desc: 'Pembelian bersih asing di sektor perbankan berlanjut selama 20 hari terakhir.',        color: '#00FF88' },
]

export function SectorOutlookWidget() {
  const [open, setOpen] = useState(false)

  return (
    <div className="px-12 py-2">
      <div className="bg-white border border-[#E0E0E5] flex flex-col">
        {/* Header */}
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="px-5 py-3 border-b border-[#E0E0E5] flex items-center justify-between w-full text-left hover:bg-[#F5F5F8] transition-colors"
        >
          <div className="flex items-center gap-2">
            <span className="font-mono text-[13px] font-bold tracking-[0.5px] text-[#1A1A1A]">
              PROSPEK SEKTOR &amp; INDUSTRI
            </span>
            <span className="font-mono text-[9px] text-[#888888] border border-[#E0E0E5] px-1.5 py-0.5">
              ILUSTRASI
            </span>
          </div>
          <span
            className="font-mono text-[12px] text-[#888888] transition-transform duration-200"
            style={{ transform: open ? 'rotate(180deg)' : 'rotate(0deg)' }}
          >
            ▾
          </span>
        </button>

        {/* Collapsible content */}
        <div
          className="overflow-hidden transition-[max-height] duration-300 ease-in-out"
          style={{ maxHeight: open ? '500px' : '0px' }}
        >
          <div className="p-4 grid grid-cols-3 gap-2">
            {MOCK_OUTLOOK.map((item) => (
              <div key={item.title} className="border border-[#E0E0E5] p-3 flex flex-col gap-1.5">
                <div className="flex items-center justify-between">
                  <span className="font-mono text-[11px] font-bold text-[#1A1A1A] tracking-[0.5px]">
                    {item.title}
                  </span>
                  <span
                    className="font-mono text-[9px] font-bold px-1.5 py-0.5"
                    style={{ color: item.color, backgroundColor: `${item.color}15`, border: `1px solid ${item.color}40` }}
                  >
                    {item.trend}
                  </span>
                </div>
                <p className="font-mono text-[11px] text-[#555555] leading-[1.4]">{item.desc}</p>
              </div>
            ))}
          </div>
          <div className="px-5 pb-3">
            <span className="font-mono text-[10px] text-[#AAAAAA]">
              * Data ilustrasi — akan diganti dengan data makro/sektor aktual saat tersedia
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}
