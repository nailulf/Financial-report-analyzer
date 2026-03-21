interface MetricCardProps {
  label: string
  value: string
  sub?: string
  highlight?: boolean
}

export function MetricCard({ label, value, sub, highlight }: MetricCardProps) {
  return (
    <div className={`rounded-xl border p-5 ${highlight ? 'bg-blue-50 border-blue-200' : 'bg-white border-gray-200'}`}>
      <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">{label}</p>
      <p className={`text-2xl font-bold ${highlight ? 'text-blue-700' : 'text-gray-900'}`}>{value}</p>
      {sub && <p className="text-xs text-gray-400 mt-1">{sub}</p>}
    </div>
  )
}
