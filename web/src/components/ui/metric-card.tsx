interface MetricCardProps {
  label: string
  value: string
  sub?: string
  highlight?: boolean
}

export function MetricCard({ label, value, sub, highlight }: MetricCardProps) {
  return (
    <div className={`rounded-2xl border p-5 ${highlight
      ? 'bg-[#C8F0D8] border-[#3D8A5A]/20'
      : 'bg-white border-[#E5E4E1] shadow-[0_2px_12px_rgba(26,25,24,0.06)]'
    }`}>
      <p className="text-xs font-medium text-[#9C9B99] uppercase tracking-wide mb-1">{label}</p>
      <p className={`text-2xl font-bold font-mono tabular-nums ${highlight ? 'text-[#3D8A5A]' : 'text-[#1A1918]'}`}>{value}</p>
      {sub && <p className="text-xs text-[#9C9B99] mt-1">{sub}</p>}
    </div>
  )
}
