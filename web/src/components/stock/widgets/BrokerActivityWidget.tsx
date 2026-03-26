'use client'

import React, { useState, useEffect, useCallback, useMemo } from 'react'
import {
  BarChart, Bar, LineChart, Line, XAxis, YAxis, Tooltip, Legend,
  ResponsiveContainer, ReferenceLine, ComposedChart,
} from 'recharts'
import type {
  StockBrokerSummary, StockBrokerBucket, BandarSignalRow,
  InsiderTransactionRow, DailyFlowByType, BrokerConcentrationRow,
  SmartMoneyData,
} from '@/lib/queries/broker'
import { formatIDRCompact, formatNumber, fmtNumID } from '@/lib/calculations/formatters'

/* ─── constants ─────────────────────────────────────────────────────── */

const DURATION_PRESETS = [
  { label: '10D', days: 10 },
  { label: '20D', days: 20 },
  { label: '30D', days: 30 },
  { label: '60D', days: 60 },
]

const TABS = [
  { key: 'daily',    label: 'Aliran broker harian' },
  { key: 'cum',      label: 'Kumulatif net flow' },
  { key: 'identify', label: 'Identifikasi broker bandar' },
  { key: 'insider',  label: 'Insider Filings' },
] as const

type TabKey = (typeof TABS)[number]['key']

/* ─── combined signal logic (truth table from FRD) ─────────────────── */

type BrokerDirection = 'net_beli' | 'netral' | 'net_jual'
type InsiderAction = 'buy' | 'sell' | 'mixed' | 'none'

interface CombinedSignal {
  signal: string
  label: string
  color: string
  bgColor: string
  description: string
}

const SIGNAL_MAP: Record<string, CombinedSignal> = {
  'net_beli:buy':   { signal: 'STRONG_BUY',    label: 'Beli kuat',         color: '#006633', bgColor: '#D4EDDA', description: 'Broker + insider aligned' },
  'net_beli:none':  { signal: 'ACCUMULATION',   label: 'Akumulasi',         color: '#155724', bgColor: '#D4EDDA', description: 'Broker beli, insider diam' },
  'net_beli:sell':  { signal: 'CONFLICT',       label: 'Konflik',           color: '#856404', bgColor: '#FFF3CD', description: 'Sinyal berlawanan' },
  'net_beli:mixed': { signal: 'CONFLICT',       label: 'Konflik',           color: '#856404', bgColor: '#FFF3CD', description: 'Sinyal berlawanan' },
  'netral:buy':     { signal: 'EARLY_SIGNAL',   label: 'Sinyal awal',       color: '#856404', bgColor: '#FFF3CD', description: 'Insider mulai masuk' },
  'netral:none':    { signal: 'NEUTRAL',        label: 'Tidak ada sinyal',  color: '#666666', bgColor: '#F0F0F0', description: 'Tidak ada pergerakan' },
  'netral:sell':    { signal: 'CAUTION',        label: 'Waspada',           color: '#856404', bgColor: '#FFF3CD', description: 'Insider jual, broker diam' },
  'netral:mixed':   { signal: 'CAUTION',        label: 'Waspada',           color: '#856404', bgColor: '#FFF3CD', description: 'Insider jual, broker diam' },
  'net_jual:buy':   { signal: 'TRAP',           label: 'Potensi jebakan',   color: '#856404', bgColor: '#FFF3CD', description: 'Broker jual, insider beli?' },
  'net_jual:none':  { signal: 'DISTRIBUTION',   label: 'Distribusi',        color: '#721C24', bgColor: '#F8D7DA', description: 'Broker jual, belum konfirmasi' },
  'net_jual:sell':  { signal: 'DANGER',         label: 'Bahaya',            color: '#721C24', bgColor: '#F8D7DA', description: 'Broker + insider confirmed' },
  'net_jual:mixed': { signal: 'DANGER',         label: 'Bahaya',            color: '#721C24', bgColor: '#F8D7DA', description: 'Broker + insider confirmed' },
}

function computeBrokerDirection(netFlow: number, threshold = 5_000_000): BrokerDirection {
  if (netFlow > threshold) return 'net_beli'
  if (netFlow < -threshold) return 'net_jual'
  return 'netral'
}

function computeInsiderAction(insiders: InsiderTransactionRow[], days: number): InsiderAction {
  if (insiders.length === 0) return 'none'
  const hasBuy = insiders.some((t) => t.action === 'BUY')
  const hasSell = insiders.some((t) => t.action === 'SELL')
  if (hasBuy && hasSell) return 'mixed'
  if (hasSell) return 'sell'
  if (hasBuy) return 'buy'
  return 'none'
}

function getCombinedSignal(brokerDir: BrokerDirection, insiderAction: InsiderAction): CombinedSignal {
  return SIGNAL_MAP[`${brokerDir}:${insiderAction}`] ?? SIGNAL_MAP['netral:none']!
}

/* ─── insider helpers ──────────────────────────────────────────────── */

function getInitials(name: string): string {
  return name.split(' ').map((w) => w[0]).filter(Boolean).slice(0, 2).join('').toUpperCase()
}

function initialsColor(action: 'BUY' | 'SELL'): string {
  return action === 'BUY' ? '#006633' : '#CC3333'
}

/* ─── bandar signal helpers ──────────────────────────────────────────── */

function signalColor(signal: string | null): string {
  if (!signal) return '#888888'
  const s = signal.toLowerCase()
  if (s.includes('big acc'))   return '#00CC66'
  if (s.includes('acc'))       return '#00FF88'
  if (s.includes('big dist'))  return '#CC3333'
  if (s.includes('dist'))      return '#FF6666'
  return '#888888'
}

function signalLabel(signal: string | null): string {
  if (!signal) return '—'
  const s = signal.toLowerCase()
  if (s.includes('big acc'))   return 'Akumulasi Kuat'
  if (s.includes('acc'))       return 'Akumulasi'
  if (s.includes('big dist'))  return 'Distribusi Kuat'
  if (s.includes('dist'))      return 'Distribusi'
  if (s.includes('normal'))    return 'Normal'
  return signal
}

/* ─── chart tooltip formatter ──────────────────────────────────────── */

function ChartTooltip({ active, payload, label }: any) {
  if (!active || !payload) return null
  return (
    <div className="bg-white border border-[#E0E0E5] px-3 py-2 shadow-sm font-mono text-[11px]">
      <div className="font-bold text-[#1A1A1A] mb-1">{label}</div>
      {payload.map((p: any) => (
        <div key={p.dataKey} className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: p.color }} />
          <span className="text-[#888888]">{p.name}:</span>
          <span style={{ color: p.color }}>{formatIDRCompact(p.value)}</span>
        </div>
      ))}
    </div>
  )
}

/* ─── summary card ──────────────────────────────────────────────────── */

function SummaryCard({
  label, value, sub, valueClass, dot,
}: {
  label: string
  value: string
  sub: string
  valueClass?: string
  dot?: string
}) {
  return (
    <div className="flex-1 border border-[#E0E0E5] px-4 py-3 flex flex-col gap-1">
      <span className="font-mono text-[10px] font-bold tracking-[0.5px] text-[#888888] uppercase">
        {label}
      </span>
      <div className="flex items-center gap-1.5">
        {dot && <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: dot }} />}
        <span className={`font-mono text-[18px] font-bold tracking-[-0.5px] ${valueClass ?? 'text-[#1A1A1A]'}`}>
          {value}
        </span>
      </div>
      <span className="font-mono text-[10px] text-[#888888]">{sub}</span>
    </div>
  )
}

/* ─── daily flow bar chart (Tab 1) ──────────────────────────────────── */

function DailyFlowChart({ data }: { data: DailyFlowByType[] }) {
  const [mounted, setMounted] = useState(false)
  useEffect(() => { setMounted(true) }, [])

  const chartData = useMemo(() =>
    data.map((d) => ({
      date: d.trade_date.slice(5), // MM-DD
      asing: d.asing_net / 1e6,
      lokal: d.lokal_net / 1e6,
      pemerintah: d.pemerintah_net / 1e6,
      harga: d.close_price,
    })),
    [data],
  )

  if (!mounted) {
    return <div className="h-[300px] bg-[#F0F0F0] rounded animate-pulse" />
  }

  if (chartData.length === 0) {
    return (
      <div className="h-[300px] border border-dashed border-[#E0E0E5] flex items-center justify-center bg-[#FAFAFA]">
        <span className="font-mono text-[11px] text-[#AAAAAA]">Belum ada data broker flow</span>
      </div>
    )
  }

  return (
    <ResponsiveContainer width="100%" height={300}>
      <ComposedChart data={chartData} margin={{ top: 5, right: 50, left: 5, bottom: 5 }}>
        <XAxis
          dataKey="date"
          tick={{ fontSize: 10, fontFamily: 'monospace', fill: '#888' }}
          tickLine={false}
          axisLine={{ stroke: '#E0E0E5' }}
        />
        <YAxis
          yAxisId="flow"
          tick={{ fontSize: 10, fontFamily: 'monospace', fill: '#888' }}
          tickLine={false}
          axisLine={false}
          tickFormatter={(v: number) => `${v}jt`}
        />
        <YAxis
          yAxisId="price"
          orientation="right"
          tick={{ fontSize: 10, fontFamily: 'monospace', fill: '#888' }}
          tickLine={false}
          axisLine={false}
          tickFormatter={(v: number) => `Rp ${fmtNumID(v)}`}
        />
        <Tooltip content={<ChartTooltip />} />
        <Legend
          wrapperStyle={{ fontSize: 10, fontFamily: 'monospace' }}
          iconType="square"
          iconSize={8}
        />
        <ReferenceLine yAxisId="flow" y={0} stroke="#E0E0E5" />
        <Bar yAxisId="flow" dataKey="lokal" name="Bandar broker" fill="#4A7CBA" stackId="flow" />
        <Bar yAxisId="flow" dataKey="asing" name="Asing" fill="#2EAE7B" stackId="flow" />
        <Bar yAxisId="flow" dataKey="pemerintah" name="Dom. ritel" fill="#BBBBBB" stackId="flow" />
        <Line
          yAxisId="price" dataKey="harga" name="Harga"
          stroke="#CC3333" strokeWidth={2} dot={false} type="monotone"
        />
      </ComposedChart>
    </ResponsiveContainer>
  )
}

/* ─── cumulative flow line chart (Tab 2) ────────────────────────────── */

function CumulativeFlowChart({ data }: { data: DailyFlowByType[] }) {
  const [mounted, setMounted] = useState(false)
  useEffect(() => { setMounted(true) }, [])

  const chartData = useMemo(() => {
    let cumAging = 0, cumLokal = 0, cumDom = 0
    return data.map((d) => {
      cumLokal += d.lokal_net
      cumAging += d.asing_net
      cumDom += d.pemerintah_net
      return {
        date: d.trade_date.slice(5),
        lokal: cumLokal / 1e6,
        asing: cumAging / 1e6,
        domestik: cumDom / 1e6,
        harga: d.close_price,
      }
    })
  }, [data])

  if (!mounted) {
    return <div className="h-[300px] bg-[#F0F0F0] rounded animate-pulse" />
  }

  if (chartData.length === 0) {
    return (
      <div className="h-[300px] border border-dashed border-[#E0E0E5] flex items-center justify-center bg-[#FAFAFA]">
        <span className="font-mono text-[11px] text-[#AAAAAA]">Belum ada data kumulatif</span>
      </div>
    )
  }

  return (
    <ResponsiveContainer width="100%" height={300}>
      <ComposedChart data={chartData} margin={{ top: 5, right: 50, left: 5, bottom: 5 }}>
        <XAxis
          dataKey="date"
          tick={{ fontSize: 10, fontFamily: 'monospace', fill: '#888' }}
          tickLine={false}
          axisLine={{ stroke: '#E0E0E5' }}
        />
        <YAxis
          yAxisId="flow"
          tick={{ fontSize: 10, fontFamily: 'monospace', fill: '#888' }}
          tickLine={false}
          axisLine={false}
          tickFormatter={(v: number) => `${v}jt`}
        />
        <YAxis
          yAxisId="price"
          orientation="right"
          tick={{ fontSize: 10, fontFamily: 'monospace', fill: '#888' }}
          tickLine={false}
          axisLine={false}
          tickFormatter={(v: number) => `Rp ${fmtNumID(v)}`}
        />
        <Tooltip content={<ChartTooltip />} />
        <Legend
          wrapperStyle={{ fontSize: 10, fontFamily: 'monospace' }}
          iconType="line"
          iconSize={12}
        />
        <ReferenceLine yAxisId="flow" y={0} stroke="#E0E0E5" />
        <Line
          yAxisId="flow" dataKey="lokal" name="Bandar broker"
          stroke="#4A7CBA" strokeWidth={2} dot={false} type="monotone"
        />
        <Line
          yAxisId="flow" dataKey="asing" name="Asing"
          stroke="#2EAE7B" strokeWidth={2} dot={false} type="monotone"
        />
        <Line
          yAxisId="flow" dataKey="domestik" name="Dom. ritel"
          stroke="#999999" strokeWidth={1.5} dot={false} type="monotone"
        />
        <Line
          yAxisId="price" dataKey="harga" name="Harga"
          stroke="#CC3333" strokeWidth={2} dot={false} type="monotone"
        />
      </ComposedChart>
    </ResponsiveContainer>
  )
}

/* ─── broker identification table (Tab 3) ──────────────────────────── */

function BrokerIdentificationTable({
  rows,
  daysCount,
}: {
  rows: BrokerConcentrationRow[]
  daysCount: number
}) {
  if (rows.length === 0) {
    return (
      <div className="flex items-center justify-center py-12">
        <span className="font-mono text-[11px] text-[#AAAAAA]">Belum ada data broker</span>
      </div>
    )
  }

  function StatusBadge({ status }: { status: BrokerConcentrationRow['status'] }) {
    const config = {
      kandidat_bandar: { label: 'Kandidat bandar', bg: 'bg-red-50', text: 'text-red-700', dot: 'bg-red-500' },
      asing:           { label: 'Asing',           bg: 'bg-emerald-50', text: 'text-emerald-700', dot: 'bg-emerald-500' },
      retail:          { label: 'Retail/domestik',  bg: 'bg-gray-50', text: 'text-gray-600', dot: 'bg-gray-400' },
    }
    const c = config[status]
    return (
      <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold font-mono ${c.bg} ${c.text}`}>
        <span className={`w-1.5 h-1.5 rounded-full ${c.dot}`} />
        {c.label}
      </span>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      <span className="font-mono text-[10px] text-[#888888] leading-relaxed">
        Top broker berdasarkan total flow {daysCount} hari — broker dengan net sell dominan + selalu muncul di hari volume tinggi = kandidat bandar
      </span>
      <div className="overflow-x-auto max-h-[360px] overflow-y-auto">
        <table className="w-full text-[12px] font-mono">
          <thead className="sticky top-0 z-10">
            <tr className="border-b border-[#E0E0E5] bg-[#F5F5F8]">
              <th className="text-left px-3 py-2 font-bold text-[#888888] text-[11px]">KODE BROKER</th>
              <th className="text-right px-3 py-2 font-bold text-[#888888] text-[11px]">TOTAL BELI</th>
              <th className="text-right px-3 py-2 font-bold text-[#888888] text-[11px]">TOTAL JUAL</th>
              <th className="text-right px-3 py-2 font-bold text-[#888888] text-[11px]">NET FLOW</th>
              <th className="text-right px-3 py-2 font-bold text-[#888888] text-[11px]">KONSENTRASI%</th>
              <th className="text-right px-3 py-2 font-bold text-[#888888] text-[11px]">STATUS</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const netColor = r.total_net_value > 0 ? 'text-emerald-600' : r.total_net_value < 0 ? 'text-red-500' : 'text-[#888888]'
              return (
                <tr key={r.broker_code} className="border-b border-[#E0E0E5] last:border-0">
                  <td className="px-3 py-2.5 font-bold text-[#1A1A1A]">{r.broker_code}</td>
                  <td className="px-3 py-2.5 text-right text-[#888888]">{formatIDRCompact(r.total_buy_value)}</td>
                  <td className="px-3 py-2.5 text-right text-[#888888]">{formatIDRCompact(r.total_sell_value)}</td>
                  <td className={`px-3 py-2.5 text-right font-semibold ${netColor}`}>
                    {r.total_net_value > 0 ? '+' : ''}{formatIDRCompact(r.total_net_value)}
                  </td>
                  <td className="px-3 py-2.5 text-right text-[#1A1A1A]">{r.concentration_pct.toFixed(1)}%</td>
                  <td className="px-3 py-2.5 text-right"><StatusBadge status={r.status} /></td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <div className="border border-[#E0E0E5] bg-[#FAFAFA] px-4 py-3 mt-1">
        <span className="font-mono text-[11px] text-[#888888] leading-relaxed">
          Cara kerja: broker dengan net sell dominan + selalu muncul di hari volume tinggi = bandar.
          Konfirmasi dengan melihat apakah kode ini juga dominan di periode akumulasi (net buy besar saat harga rendah).
        </span>
      </div>
    </div>
  )
}

/* ─── insider filings table (Tab 4) ────────────────────────────────── */

function InsiderFilingsTab({ rows }: { rows: InsiderTransactionRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="flex items-center justify-center py-12">
        <span className="font-mono text-[11px] text-[#AAAAAA]">Belum ada data insider filing</span>
      </div>
    )
  }

  const sellTxns = rows.filter((r) => r.action === 'SELL')
  const buyTxns = rows.filter((r) => r.action === 'BUY')
  const totalSellLots = sellTxns.reduce((s, r) => s + r.share_change, 0)
  const totalBuyLots = buyTxns.reduce((s, r) => s + r.share_change, 0)
  const totalSellValue = sellTxns.reduce((s, r) => s + (r.total_value ?? 0), 0)
  const totalBuyValue = buyTxns.reduce((s, r) => s + (r.total_value ?? 0), 0)

  return (
    <div className="flex flex-col gap-2">
      <span className="font-mono text-[10px] text-[#888888] leading-relaxed">
        Filing transaksi orang dalam (OJK) — {rows.length} transaksi terakhir
      </span>

      <div className="overflow-x-auto max-h-[360px] overflow-y-auto">
        <table className="w-full text-[12px] font-mono">
          <thead className="sticky top-0 z-10">
            <tr className="border-b border-[#E0E0E5] bg-[#F5F5F8]">
              <th className="text-left px-3 py-2 font-bold text-[#888888] text-[11px]">TANGGAL</th>
              <th className="text-left px-3 py-2 font-bold text-[#888888] text-[11px]">NAMA</th>
              <th className="text-center px-3 py-2 font-bold text-[#888888] text-[11px]">AKSI</th>
              <th className="text-right px-3 py-2 font-bold text-[#888888] text-[11px]">SAHAM</th>
              <th className="text-right px-3 py-2 font-bold text-[#888888] text-[11px]">HARGA</th>
              <th className="text-right px-3 py-2 font-bold text-[#888888] text-[11px]">NILAI</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={`${r.insider_name}-${r.transaction_date}-${i}`} className="border-b border-[#E0E0E5] last:border-0">
                <td className="px-3 py-2 text-[#888888] whitespace-nowrap">{r.transaction_date}</td>
                <td className="px-3 py-2 text-[#1A1A1A] font-semibold truncate max-w-[200px]">{r.insider_name}</td>
                <td className="px-3 py-2 text-center">
                  <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                    r.action === 'BUY' ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'
                  }`}>
                    {r.action}
                  </span>
                </td>
                <td className="px-3 py-2 text-right text-[#1A1A1A]">{fmtNumID(r.share_change)}</td>
                <td className="px-3 py-2 text-right text-[#888888]">{r.price != null ? fmtNumID(r.price) : '—'}</td>
                <td className="px-3 py-2 text-right text-[#1A1A1A]">{r.total_value != null ? formatIDRCompact(r.total_value) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Pattern detection box */}
      {(sellTxns.length > 0 || buyTxns.length > 0) && (
        <div className="border border-[#E0E0E5] bg-[#FAFAFA] px-4 py-3 mt-1">
          <span className="font-mono text-[11px] font-bold text-[#1A1A1A]">Pola: </span>
          <span className="font-mono text-[11px] text-[#888888]">
            {sellTxns.length > 0 && buyTxns.length === 0 && (
              <>Insider menjual total <strong className="text-[#1A1A1A]">{fmtNumID(totalSellLots)} lot</strong>{totalSellValue > 0 && <> ({formatIDRCompact(totalSellValue)})</>}. Tidak ada insider buy — sinyal distribusi.</>
            )}
            {buyTxns.length > 0 && sellTxns.length === 0 && (
              <>Insider membeli total <strong className="text-[#1A1A1A]">{fmtNumID(totalBuyLots)} lot</strong>{totalBuyValue > 0 && <> ({formatIDRCompact(totalBuyValue)})</>}. Tidak ada insider sell — sinyal akumulasi.</>
            )}
            {buyTxns.length > 0 && sellTxns.length > 0 && (
              <>Campuran: {sellTxns.length} jual ({fmtNumID(totalSellLots)} lot) + {buyTxns.length} beli ({fmtNumID(totalBuyLots)} lot).</>
            )}
          </span>
        </div>
      )}
    </div>
  )
}

/* ─── bandar signal detail ───────────────────────────────────────────── */

function BandarSignalDetail({ signal }: { signal: BandarSignalRow }) {
  const levels = [
    { label: 'Overall', value: signal.broker_accdist },
    { label: 'Top 1',   value: signal.top1_accdist },
    { label: 'Top 3',   value: signal.top3_accdist },
    { label: 'Top 5',   value: signal.top5_accdist },
    { label: 'Top 10',  value: signal.top10_accdist },
  ]

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-4 flex-wrap">
        {levels.map((l) => (
          <div key={l.label} className="flex items-center gap-1.5">
            <span className="font-mono text-[10px] text-[#888888]">{l.label}:</span>
            <span
              className="font-mono text-[11px] font-bold px-2 py-0.5 rounded"
              style={{ color: signalColor(l.value), backgroundColor: `${signalColor(l.value)}15` }}
            >
              {signalLabel(l.value)}
            </span>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-4 text-[11px] font-mono text-[#888888]">
        <span>Buyer: {signal.total_buyer ?? '—'}</span>
        <span>Seller: {signal.total_seller ?? '—'}</span>
        <span>Data: {signal.trade_date}</span>
      </div>
    </div>
  )
}

/* ─── signal matrix (3x3 grid) ─────────────────────────────────────── */

function SignalMatrix({ currentBroker, currentInsider }: {
  currentBroker: BrokerDirection
  currentInsider: InsiderAction
}) {
  const brokerLabels: { key: BrokerDirection; label: string }[] = [
    { key: 'net_beli', label: 'Broker net beli' },
    { key: 'netral',   label: 'Broker netral' },
    { key: 'net_jual', label: 'Broker net jual' },
  ]
  const insiderLabels: { key: InsiderAction; label: string }[] = [
    { key: 'buy',  label: 'Insider beli' },
    { key: 'none', label: 'Tidak ada' },
    { key: 'sell', label: 'Insider jual' },
  ]

  return (
    <div className="flex flex-col gap-2">
      <span className="font-mono text-[11px] font-bold text-[#1A1A1A]">
        Semua kombinasi — sinyal gabungan
      </span>
      <div className="grid grid-cols-4 gap-0">
        {/* Header row */}
        <div />
        {insiderLabels.map((il) => (
          <div key={il.key} className="text-center font-mono text-[10px] font-bold text-[#888888] py-2">
            {il.label}
          </div>
        ))}

        {/* Data rows */}
        {brokerLabels.map((bl) => (
          <React.Fragment key={bl.key}>
            <div className="flex items-center font-mono text-[10px] font-bold text-[#888888] pr-2">
              {bl.label}
            </div>
            {insiderLabels.map((il) => {
              const sig = getCombinedSignal(bl.key, il.key)
              const isCurrent = bl.key === currentBroker && il.key === currentInsider
              return (
                <div
                  key={`${bl.key}-${il.key}`}
                  className={`px-2 py-2 border ${isCurrent ? 'border-[#1A1A1A] border-2' : 'border-[#E0E0E5]'}`}
                  style={{ backgroundColor: sig.bgColor }}
                >
                  <div className="font-mono text-[11px] font-bold" style={{ color: sig.color }}>
                    {sig.label}
                  </div>
                  <div className="font-mono text-[9px] text-[#888888]">
                    {sig.description}
                  </div>
                </div>
              )
            })}
          </React.Fragment>
        ))}
      </div>
    </div>
  )
}

/* ─── skeleton ──────────────────────────────────────────────────────── */

function Skeleton() {
  return (
    <div className="flex flex-col gap-4 animate-pulse p-6">
      <div className="flex gap-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="flex-1 h-[90px] bg-[#F0F0F0] rounded" />
        ))}
      </div>
      <div className="h-[300px] bg-[#F0F0F0] rounded" />
    </div>
  )
}

/* ─── broker table (right panel) ────────────────────────────────────── */

function BrokerTable({ buckets, netBrokerFlow }: { buckets: StockBrokerBucket[]; netBrokerFlow: number }) {
  return (
    <div className="bg-white flex flex-col min-h-full">
      <div className="px-5 py-3">
        <span className="font-mono text-[13px] font-bold tracking-[0.5px] text-[#1A1A1A]">
          TOP BROKER ACTIVITY
        </span>
      </div>

      <div className="flex items-center px-3 py-2 border-y border-[#E0E0E5] bg-[#F5F5F8]">
        <span className="font-mono text-[11px] font-bold text-[#888888] tracking-[0.5px] flex-1">BROKER</span>
        <span className="font-mono text-[11px] font-bold text-[#888888] tracking-[0.5px] w-[104px] text-right">BUY VOL</span>
        <span className="font-mono text-[11px] font-bold text-[#888888] tracking-[0.5px] w-[104px] text-right">SELL VOL</span>
        <span className="font-mono text-[11px] font-bold text-[#888888] tracking-[0.5px] w-[104px] text-right">NET</span>
      </div>

      <div className="flex-1">
        {buckets.length > 0 ? (
          buckets.map((b) => {
            const net = b.total_net_value
            const netColor = net > 0 ? 'text-emerald-500' : net < 0 ? 'text-red-400' : 'text-[#888888]'
            return (
              <div key={b.broker_code} className="flex items-center px-3 py-2.5 border-b border-[#E0E0E5] last:border-0">
                <span className="font-mono text-[12px] font-semibold text-[#1A1A1A] flex-1 truncate flex items-center gap-1.5">
                  {b.broker_code}
                  <TypeBadge type={b.broker_type} />
                </span>
                <span className="font-mono text-[12px] text-emerald-500 w-[104px] text-right">
                  {formatIDRCompact(b.total_buy_value)}
                </span>
                <span className="font-mono text-[12px] text-red-400 w-[104px] text-right">
                  {formatIDRCompact(b.total_sell_value)}
                </span>
                <span className={`font-mono text-[12px] font-semibold w-[104px] text-right ${netColor}`}>
                  {net > 0 ? '+' : ''}{formatIDRCompact(net)}
                </span>
              </div>
            )
          })
        ) : (
          <div className="flex items-center justify-center py-12">
            <span className="font-mono text-[11px] text-[#AAAAAA]">Belum ada data broker</span>
          </div>
        )}
      </div>

      <div className="flex items-center justify-between px-3 py-3 border-t border-[#E0E0E5] bg-[#F5F5F8]">
        <span className="font-mono text-[12px] font-bold text-[#888888]">NET BROKER FLOW</span>
        <span className={`font-mono text-[13px] font-bold ${
          buckets.length === 0 ? 'text-[#888888]' : netBrokerFlow >= 0 ? 'text-emerald-500' : 'text-red-400'
        }`}>
          {buckets.length === 0 ? '—' : `${netBrokerFlow >= 0 ? '+' : ''}${formatIDRCompact(netBrokerFlow)}`}
        </span>
      </div>
    </div>
  )
}

/* ─── broker type badge ──────────────────────────────────────────────── */

function TypeBadge({ type }: { type: string | null }) {
  if (!type) return null
  const colors: Record<string, string> = {
    'Asing':       'bg-blue-100 text-blue-700',
    'Lokal':       'bg-gray-100 text-gray-600',
    'Pemerintah':  'bg-amber-100 text-amber-700',
  }
  return (
    <span className={`font-mono text-[9px] font-bold px-1.5 py-0.5 rounded ${colors[type] ?? 'bg-gray-100 text-gray-500'}`}>
      {type === 'Asing' ? 'F' : type === 'Pemerintah' ? 'G' : 'D'}
    </span>
  )
}

/* ─── main widget ───────────────────────────────────────────────────── */

interface Props {
  ticker: string
  initialData: StockBrokerSummary | null
  insiderTransactions: InsiderTransactionRow[]
  dailyBrokerFlow: DailyFlowByType[]
  brokerConcentration: BrokerConcentrationRow[]
}

export function BrokerActivityWidget({
  ticker,
  initialData,
  insiderTransactions,
  dailyBrokerFlow: initialDailyFlow,
  brokerConcentration: initialConcentration,
}: Props) {
  const [data, setData] = useState<StockBrokerSummary | null>(initialData)
  const [dailyFlow, setDailyFlow] = useState<DailyFlowByType[]>(initialDailyFlow)
  const [concentration, setConcentration] = useState<BrokerConcentrationRow[]>(initialConcentration)
  const [days, setDays] = useState(30)
  const [endDate, setEndDate] = useState('')
  const [loading, setLoading] = useState(false)
  const [activeTab, setActiveTab] = useState<TabKey>('daily')

  const fetchData = useCallback(async (d: number, ed: string) => {
    setLoading(true)
    try {
      const params = new URLSearchParams({ days: String(d), mode: 'smart-money' })
      if (ed) params.set('endDate', ed)
      const res = await fetch(`/api/stocks/${ticker}/broker?${params}`)
      if (!res.ok) throw new Error(`Broker API ${res.status}`)
      const json: SmartMoneyData | null = await res.json()
      if (json) {
        setData(json.summary)
        setDailyFlow(json.dailyFlow)
        setConcentration(json.concentration)
      }
    } catch {
      // keep current data on error
    } finally {
      setLoading(false)
    }
  }, [ticker])

  // Track whether user has changed filters
  const [mounted, setMounted] = useState(false)
  const [userChanged, setUserChanged] = useState(false)
  useEffect(() => { setMounted(true) }, [])
  useEffect(() => {
    if (!mounted) return
    if (!userChanged) return
    fetchData(days, endDate)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days, endDate, mounted, userChanged])

  // Compute aggregates
  const allBuckets = data ? mergeBuckets(data) : []
  const topBuckets = allBuckets.slice(0, 8)
  const totalBuy = allBuckets.reduce((s, b) => s + b.total_buy_value, 0)
  const totalSell = allBuckets.reduce((s, b) => s + b.total_sell_value, 0)
  const netFlow = totalBuy - totalSell

  // Compute asing flow from daily data
  const asingNetFlow = dailyFlow.reduce((s, d) => s + d.asing_net, 0)

  // Filter insider transactions to match broker data date range
  const insidersInRange = useMemo(() => {
    if (dailyFlow.length === 0) return insiderTransactions
    const earliest = dailyFlow[0]?.trade_date
    const latest = dailyFlow[dailyFlow.length - 1]?.trade_date
    if (!earliest || !latest) return insiderTransactions
    const from = earliest < latest ? earliest : latest
    const to = earliest < latest ? latest : earliest
    return insiderTransactions.filter((t) => t.transaction_date >= from && t.transaction_date <= to)
  }, [insiderTransactions, dailyFlow])

  // Compute insider summary (only transactions within broker data period)
  const insiderBuyCount = insidersInRange.filter((t) => t.action === 'BUY').length
  const insiderSellCount = insidersInRange.filter((t) => t.action === 'SELL').length
  const insiderAction = computeInsiderAction(insidersInRange, days)

  // Compute combined signal
  const brokerDirection = computeBrokerDirection(netFlow)
  const combinedSignal = getCombinedSignal(brokerDirection, insiderAction)

  const bandar = data?.bandarSignal ?? null

  return (
    <div className="bg-white border border-[#E0E0E5] flex flex-col">
      {/* header */}
      <div className="px-5 py-3 border-b border-[#E0E0E5] flex items-center justify-between gap-2 flex-wrap">
        <span className="font-mono text-[13px] font-bold tracking-[0.5px] text-[#1A1A1A]">AKTIVITAS BROKER</span>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1">
            {DURATION_PRESETS.map((p) => (
              <button
                key={p.days}
                onClick={() => { setUserChanged(true); setDays(p.days) }}
                className={`font-mono text-[11px] font-bold px-2 py-1 border transition-colors ${
                  days === p.days
                    ? 'bg-[#1A1A1A] text-[#00FF88] border-[#1A1A1A]'
                    : 'bg-white text-[#888888] border-[#E0E0E5] hover:border-[#1A1A1A] hover:text-[#1A1A1A]'
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
          {mounted && (
            <input
              type="date"
              value={endDate}
              onChange={(e) => { setUserChanged(true); setEndDate(e.target.value) }}
              className="font-mono text-[11px] text-[#1A1A1A] border border-[#E0E0E5] px-2 py-1 bg-white focus:outline-none focus:border-[#1A1A1A] w-[110px]"
            />
          )}
          {data?.dateRange && !loading && (
            <span className="font-mono text-[11px] text-[#888888] whitespace-nowrap">
              {data.daysCount}D: {data.dateRange}
            </span>
          )}
        </div>
      </div>

      {/* body */}
      {loading ? (
        <Skeleton />
      ) : (
        <div className="flex">
          {/* ── left panel ─────────────────────────────────── */}
          <div className="flex-1 flex flex-col gap-0 border-r border-[#E0E0E5]">
            {/* summary cards */}
            <div className="flex gap-3 px-6 py-5">
              <SummaryCard
                label={`NET FLOW (${data?.daysCount ?? days}D)`}
                value={data ? `${netFlow >= 0 ? '+' : ''}${formatIDRCompact(netFlow)}` : '—'}
                sub={!data ? 'Belum ada data' : netFlow < 0 ? 'Distribusi aktif' : 'Akumulasi aktif'}
                valueClass={!data ? 'text-[#888888]' : netFlow >= 0 ? 'text-emerald-600' : 'text-red-500'}
              />
              <SummaryCard
                label={`NET ASING (${data?.daysCount ?? days}D)`}
                value={dailyFlow.length > 0 ? `${asingNetFlow >= 0 ? '+' : ''}${formatIDRCompact(asingNetFlow)}` : '—'}
                sub={dailyFlow.length === 0 ? 'Belum ada data' : asingNetFlow >= 0 ? 'Masih beli — exit liquidity' : 'Net jual asing'}
                valueClass={dailyFlow.length === 0 ? 'text-[#888888]' : asingNetFlow >= 0 ? 'text-emerald-600' : 'text-red-500'}
              />
              <SummaryCard
                label={`INSIDER FILING (${data?.daysCount ?? days}D)`}
                value={insidersInRange.length > 0
                  ? `${insiderSellCount > 0 ? `${insiderSellCount} SELL` : ''}${insiderSellCount > 0 && insiderBuyCount > 0 ? ' / ' : ''}${insiderBuyCount > 0 ? `${insiderBuyCount} BUY` : ''}`
                  : '—'}
                sub={insidersInRange.length === 0 ? 'Tidak ada filing dalam periode ini' :
                  insiderSellCount > 0 && insiderBuyCount === 0 ? 'Konfirmasi distribusi' :
                  insiderBuyCount > 0 && insiderSellCount === 0 ? 'Konfirmasi akumulasi' :
                  'Sinyal campuran'}
                valueClass={insidersInRange.length === 0 ? 'text-[#888888]' :
                  insiderSellCount > 0 && insiderBuyCount === 0 ? 'text-red-500' :
                  insiderBuyCount > 0 && insiderSellCount === 0 ? 'text-emerald-600' : 'text-[#1A1A1A]'}
              />
              <SummaryCard
                label="SINYAL GABUNGAN"
                value={data ? combinedSignal.label : '—'}
                sub={data ? combinedSignal.description : 'Belum ada data'}
                valueClass={data ? '' : 'text-[#888888]'}
                dot={data ? combinedSignal.color : undefined}
              />
            </div>

            {/* tabs */}
            <div className="flex items-center gap-2 px-6 pb-4">
              {TABS.map((t) => (
                <button
                  key={t.key}
                  onClick={() => setActiveTab(t.key)}
                  className={`font-mono text-[11px] font-bold px-3 py-1.5 border transition-colors ${
                    activeTab === t.key
                      ? 'bg-[#1A1A1A] text-white border-[#1A1A1A]'
                      : 'bg-white text-[#888888] border-[#E0E0E5] hover:border-[#1A1A1A] hover:text-[#1A1A1A]'
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>

            {/* tab content */}
            <div className="px-6 pb-4">
              {activeTab === 'daily' ? (
                <div className="flex flex-col gap-2">
                  <span className="font-mono text-[10px] text-[#888888] leading-relaxed">
                    Net flow harian (Rp juta) — biru = bandar broker, hijau = asing, abu = domestik ritel
                  </span>
                  <DailyFlowChart data={dailyFlow} />
                </div>
              ) : activeTab === 'cum' ? (
                <div className="flex flex-col gap-2">
                  <span className="font-mono text-[10px] text-[#888888] leading-relaxed">
                    Kumulatif net flow (Rp juta) — kapan bandar mulai balik arah
                  </span>
                  <CumulativeFlowChart data={dailyFlow} />
                </div>
              ) : activeTab === 'identify' ? (
                <div className="flex flex-col gap-3 pb-2">
                  <BrokerIdentificationTable rows={concentration} daysCount={data?.daysCount ?? days} />
                </div>
              ) : activeTab === 'insider' ? (
                <InsiderFilingsTab rows={insiderTransactions} />
              ) : null}
            </div>

            {/* bottom info section */}
            <div className="px-6 py-4">
              <div className="border border-[#E0E0E5] px-5 py-4 flex flex-col gap-3">
                <span className="font-mono text-[13px] font-bold text-[#1A1A1A]">
                  Keunggulan metode ini vs 1% shareholder
                </span>
                <div className="flex gap-4">
                  <div className="flex-1 flex flex-col gap-1.5 border-l-2 border-[#1A1A1A] pl-4">
                    <span className="font-mono text-[12px] font-bold text-[#1A1A1A]">Broker summary</span>
                    <span className="font-mono text-[11px] text-[#888888] leading-relaxed">
                      Real-time harian. Bisa deteksi akumulasi 2-4 minggu sebelum
                      harga bergerak. Tidak perlu tunggu disclosure bulanan.
                    </span>
                  </div>
                  <div className="flex-1 flex flex-col gap-1.5 border-l-2 border-red-400 pl-4">
                    <span className="font-mono text-[12px] font-bold text-[#1A1A1A]">Insider filing</span>
                    <span className="font-mono text-[11px] text-[#888888] leading-relaxed">
                      Konfirmasi legal. Kalau broker signal dan insider filing arahnya
                      sama, probabilitas sinyal benar sangat tinggi.
                    </span>
                  </div>
                </div>
              </div>
            </div>

            {/* Signal matrix */}
            {data && (
              <div className="px-6 pb-6">
                <SignalMatrix currentBroker={brokerDirection} currentInsider={insiderAction} />
              </div>
            )}
          </div>

          {/* ── right panel ────────────────────────────────── */}
          <div className="w-[480px] flex flex-col self-stretch">
            <BrokerTable buckets={topBuckets} netBrokerFlow={netFlow} />
          </div>
        </div>
      )}
    </div>
  )
}

/* ─── helpers ───────────────────────────────────────────────────────── */

/** Merge top buyers & sellers into a single deduplicated list sorted by absolute net value */
function mergeBuckets(data: StockBrokerSummary): StockBrokerBucket[] {
  const map = new Map<string, StockBrokerBucket>()
  const merge = (list: StockBrokerBucket[]) => {
    for (const b of list) {
      const existing = map.get(b.broker_code)
      if (!existing) {
        map.set(b.broker_code, { ...b })
      }
    }
  }
  merge(data.topBuyers)
  merge(data.topSellers)
  merge(data.topNetBuyers)
  merge(data.topNetSellers)
  return Array.from(map.values()).sort((a, b) => Math.abs(b.total_net_value) - Math.abs(a.total_net_value))
}
