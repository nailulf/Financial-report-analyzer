// Peer data — replace with real peer comparison data from getComparisonStocks()
const MOCK_PEERS = [
  { ticker: 'BBRI', name: 'BRI',       pe: 8.2,  pbv: 1.9, roe: 20.1 },
  { ticker: 'BMRI', name: 'Mandiri',   pe: 9.1,  pbv: 2.1, roe: 18.5 },
  { ticker: 'BBNI', name: 'BNI',       pe: 7.8,  pbv: 1.6, roe: 16.2 },
  { ticker: 'BNGA', name: 'CIMB',      pe: 6.9,  pbv: 1.0, roe: 14.8 },
  { ticker: 'MEGA', name: 'Mega',      pe: 11.2, pbv: 1.8, roe: 17.3 },
  { ticker: 'PNBN', name: 'Panin',     pe: 5.4,  pbv: 0.7, roe: 12.1 },
  { ticker: 'NISP', name: 'OCBC NISP', pe: 7.1,  pbv: 0.9, roe: 11.4 },
]

interface Props {
  ticker: string
  sector: string | null
}

export function PeersWidget({ ticker, sector }: Props) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="font-mono text-[13px] font-bold tracking-[0.5px] text-[#1A1A1A]">
          PERINGKAT TERATAS DI {sector?.toUpperCase() ?? 'SEKTOR'}
        </span>
        <span className="font-mono text-[11px] text-[#888888]">
          * Ilustratif — hubungkan getComparisonStocks() untuk data langsung
        </span>
      </div>

      <div className="flex gap-2 overflow-x-auto pb-1">
        {/* Current stock first */}
        <div className="flex-1 min-w-[120px] flex flex-col items-center gap-1 px-4 py-3 bg-[#00FF8820] border border-[#00FF8840]">
          <span className="font-display text-base font-bold text-[#00FF88]">{ticker}</span>
          <span className="font-mono text-[11px] text-[#888888]">(saham ini)</span>
          {[
            { label: 'P/E',  value: '—' },
            { label: 'P/BV', value: '—' },
            { label: 'ROE',  value: '—' },
          ].map((m) => (
            <div key={m.label} className="flex flex-col items-center">
              <span className="font-mono text-[12px] font-semibold text-[#1A1A1A]">{m.value}</span>
              <span className="font-mono text-[10px] text-[#888888]">{m.label}</span>
            </div>
          ))}
        </div>

        {/* Peers */}
        {MOCK_PEERS.map((peer) => (
          <div
            key={peer.ticker}
            className="flex-1 min-w-[120px] flex flex-col items-center gap-1 px-4 py-3 bg-white border border-[#E0E0E5] cursor-pointer hover:bg-[#F5F5F8] transition-colors"
          >
            <span className="font-display text-base font-bold text-[#1A1A1A]">{peer.ticker}</span>
            <span className="font-mono text-[11px] text-[#888888]">{peer.name}</span>
            {[
              { label: 'P/E',  value: `${peer.pe.toFixed(1)}x` },
              { label: 'P/BV', value: `${peer.pbv.toFixed(1)}x` },
              { label: 'ROE',  value: `${peer.roe.toFixed(1)}%` },
            ].map((m) => (
              <div key={m.label} className="flex flex-col items-center">
                <span className="font-mono text-[12px] font-semibold text-[#1A1A1A]">{m.value}</span>
                <span className="font-mono text-[10px] text-[#888888]">{m.label}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}
