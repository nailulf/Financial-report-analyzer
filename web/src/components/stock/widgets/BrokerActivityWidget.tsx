'use client'

import { useState, useEffect, useCallback } from 'react'
import type { StockBrokerSummary, StockBrokerBucket } from '@/lib/queries/broker'
import { formatIDRCompact } from '@/lib/calculations/formatters'

/* ─── constants ─────────────────────────────────────────────────────── */

const DURATION_PRESETS = [
  { label: '5D',  days: 5  },
  { label: '10D', days: 10 },
  { label: '20D', days: 20 },
  { label: '30D', days: 30 },
]

const TABS = [
  { key: 'daily',    label: 'Aliran broker harian' },
  { key: 'cum',      label: 'Kumulatif net flow' },
  { key: 'identify', label: 'Identifikasi broker bandar' },
  { key: 'insider',  label: 'Insider Filings' },
] as const

type TabKey = (typeof TABS)[number]['key']

/* ─── summary card ──────────────────────────────────────────────────── */

function SummaryCard({
  label,
  value,
  sub,
  valueClass,
  dot,
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

/* ─── broker table (right panel) ────────────────────────────────────── */

function BrokerTable({ buckets, netForeignFlow }: { buckets: StockBrokerBucket[]; netForeignFlow: number }) {
  return (
    <div className="bg-white border-l border-[#E0E0E5] flex flex-col min-h-full">
      {/* title */}
      <div className="px-5 py-3">
        <span className="font-mono text-[13px] font-bold tracking-[0.5px] text-[#1A1A1A]">
          TOP BROKER ACTIVITY
        </span>
      </div>

      {/* column headers */}
      <div className="flex items-center px-3 py-2 border-y border-[#E0E0E5] bg-[#F5F5F8]">
        <span className="font-mono text-[11px] font-bold text-[#888888] tracking-[0.5px] flex-1">BROKER</span>
        <span className="font-mono text-[11px] font-bold text-[#888888] tracking-[0.5px] w-[104px] text-right">BUY VOL</span>
        <span className="font-mono text-[11px] font-bold text-[#888888] tracking-[0.5px] w-[104px] text-right">SELL VOL</span>
        <span className="font-mono text-[11px] font-bold text-[#888888] tracking-[0.5px] w-[104px] text-right">NET</span>
      </div>

      {/* rows */}
      <div className="flex-1">
        {buckets.map((b, i) => {
          const net = b.total_net_value
          const netColor = net > 0 ? 'text-[#00FF88]' : net < 0 ? 'text-red-400' : 'text-[#888888]'
          return (
            <div key={i} className="flex items-center px-3 py-2.5 border-b border-[#E0E0E5] last:border-0">
              <span className="font-mono text-[12px] font-semibold text-[#1A1A1A] flex-1 truncate">
                {b.broker_name ?? b.broker_code}
              </span>
              <span className="font-mono text-[12px] text-[#00FF88] w-[104px] text-right">
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
        })}
      </div>

      {/* footer */}
      <div className="flex items-center justify-between px-3 py-3 border-t border-[#E0E0E5] bg-[#F5F5F8]">
        <span className="font-mono text-[12px] font-bold text-[#888888]">NET FOREIGN FLOW</span>
        <span className={`font-mono text-[13px] font-bold ${netForeignFlow >= 0 ? 'text-[#00FF88]' : 'text-red-400'}`}>
          {netForeignFlow >= 0 ? '+' : ''}{formatIDRCompact(netForeignFlow)}
        </span>
      </div>
    </div>
  )
}

/* ─── skeleton ──────────────────────────────────────────────────────── */

function Skeleton() {
  return (
    <div className="flex gap-2 animate-pulse">
      <div className="flex-1 flex flex-col gap-4 p-6">
        <div className="flex gap-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="flex-1 h-[98px] bg-[#F0F0F0] rounded" />
          ))}
        </div>
        <div className="h-[280px] bg-[#F0F0F0] rounded" />
      </div>
      <div className="w-[480px] flex flex-col gap-2 p-4">
        {Array.from({ length: 7 }).map((_, i) => (
          <div key={i} className="h-8 bg-[#F0F0F0] rounded" />
        ))}
      </div>
    </div>
  )
}

/* ─── main widget ───────────────────────────────────────────────────── */

interface Props {
  ticker: string
  initialData: StockBrokerSummary | null
}

export function BrokerActivityWidget({ ticker, initialData }: Props) {
  const [data, setData] = useState<StockBrokerSummary | null>(initialData)
  const [days, setDays] = useState(10)
  const [endDate, setEndDate] = useState('')
  const [loading, setLoading] = useState(false)
  const [activeTab, setActiveTab] = useState<TabKey>('daily')

  const fetchData = useCallback(async (d: number, ed: string) => {
    setLoading(true)
    try {
      const params = new URLSearchParams({ days: String(d) })
      if (ed) params.set('endDate', ed)
      const res = await fetch(`/api/stocks/${ticker}/broker?${params}`)
      const json = await res.json()
      setData(json)
    } catch {
      // keep current data on error
    } finally {
      setLoading(false)
    }
  }, [ticker])

  const [mounted, setMounted] = useState(false)
  useEffect(() => { setMounted(true) }, [])
  useEffect(() => {
    if (!mounted) return
    fetchData(days, endDate)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days, endDate, mounted])

  // Compute aggregates from available data
  const allBuckets = data ? mergeBuckets(data) : []
  const topBuckets = allBuckets.slice(0, 8)
  const totalNet = allBuckets.reduce((s, b) => s + b.total_net_value, 0)
  const totalBuy = allBuckets.reduce((s, b) => s + b.total_buy_value, 0)
  const totalSell = allBuckets.reduce((s, b) => s + b.total_sell_value, 0)
  const netFlow = totalBuy - totalSell

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
                onClick={() => setDays(p.days)}
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
              onChange={(e) => setEndDate(e.target.value)}
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
                valueClass={!data ? 'text-[#888888]' : netFlow >= 0 ? 'text-[#00FF88]' : 'text-red-400'}
              />
              <SummaryCard
                label={`TOTAL BELI (${data?.daysCount ?? days}D)`}
                value={data ? formatIDRCompact(totalBuy) : '—'}
                sub="Total nilai pembelian"
                valueClass={data ? 'text-[#00FF88]' : 'text-[#888888]'}
              />
              <SummaryCard
                label={`TOTAL JUAL (${data?.daysCount ?? days}D)`}
                value={data ? formatIDRCompact(totalSell) : '—'}
                sub="Total nilai penjualan"
                valueClass={data ? 'text-red-400' : 'text-[#888888]'}
              />
              <SummaryCard
                label="SINYAL GABUNGAN"
                value="—"
                sub="Segera hadir"
                dot="#888888"
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

            {/* chart area */}
            <div className="px-6">
              {activeTab === 'daily' ? (
                <div className="flex flex-col gap-2">
                  <span className="font-mono text-[10px] text-[#888888] leading-relaxed">
                    Net flow harian (Rp juta) — Visualisasi aliran dana broker berdasarkan periode yang dipilih
                  </span>
                  {/* chart placeholder */}
                  <div className="h-[280px] border border-dashed border-[#E0E0E5] flex items-center justify-center bg-[#FAFAFA]">
                    <div className="flex flex-col items-center gap-2">
                      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#CCCCCC" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                        <line x1="18" y1="20" x2="18" y2="10" /><line x1="12" y1="20" x2="12" y2="4" /><line x1="6" y1="20" x2="6" y2="14" />
                      </svg>
                      <span className="font-mono text-[11px] text-[#AAAAAA]">Grafik aliran broker — segera hadir</span>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="h-[280px] border border-dashed border-[#E0E0E5] flex items-center justify-center bg-[#FAFAFA]">
                  <span className="font-mono text-[11px] text-[#AAAAAA]">Segera hadir</span>
                </div>
              )}
            </div>

            {/* bottom info section */}
            <div className="px-6 py-5">
              <div className="border border-[#E0E0E5] px-5 py-4 flex flex-col gap-3">
                <span className="font-mono text-[13px] font-bold text-[#1A1A1A]">
                  Keunggulan metode ini vs 1% shareholder
                </span>
                <div className="flex gap-4">
                  <div className="flex-1 flex flex-col gap-1.5 border-l-2 border-[#1A1A1A] pl-4">
                    <span className="font-mono text-[12px] font-bold text-[#1A1A1A]">Broker summary</span>
                    <span className="font-mono text-[11px] text-[#888888] leading-relaxed">
                      Deteksi real-time harian dari data broker summary IDX.
                      Menangkap akumulasi/distribusi broker bandar sebelum
                      pergerakan harga signifikan terjadi.
                    </span>
                  </div>
                  <div className="flex-1 flex flex-col gap-1.5 border-l-2 border-red-400 pl-4">
                    <span className="font-mono text-[12px] font-bold text-[#1A1A1A]">Insider filing</span>
                    <span className="font-mono text-[11px] text-[#888888] leading-relaxed">
                      Konfirmasi legal dari laporan transaksi insider ke OJK.
                      Memberikan sinyal konfirmasi ketika pola broker summary sudah
                      terdeteksi.
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* ── right panel ────────────────────────────────── */}
          <div className="w-[480px]">
            <BrokerTable buckets={topBuckets} netForeignFlow={totalNet} />
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
      // data is already aggregated, same broker across lists has same values
    }
  }
  merge(data.topBuyers)
  merge(data.topSellers)
  merge(data.topNetBuyers)
  merge(data.topNetSellers)
  return Array.from(map.values()).sort((a, b) => Math.abs(b.total_net_value) - Math.abs(a.total_net_value))
}
