import type { HealthScore } from '@/lib/types/api'

type Status = 'green' | 'yellow' | 'red' | 'na'

const STATUS_DOT: Record<Status, string> = {
  green:  'bg-[#00FF88]',
  yellow: 'bg-amber-400',
  red:    'bg-red-400',
  na:     'bg-[#E0E0E5]',
}
const STATUS_TEXT: Record<Status, string> = {
  green:  'text-[#00FF88]',
  yellow: 'text-amber-500',
  red:    'text-red-400',
  na:     'text-[#888888]',
}
const STATUS_LABEL: Record<Status, string> = {
  green: 'Good', yellow: 'Fair', red: 'Weak', na: 'N/A',
}

function StatusPill({ status }: { status: Status }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`w-2 h-2 rounded-full flex-shrink-0 ${STATUS_DOT[status]}`} />
      <span className={`font-mono text-[11px] font-medium ${STATUS_TEXT[status]}`}>{STATUS_LABEL[status]}</span>
    </span>
  )
}

export function HealthScorecard({ scores }: { scores: HealthScore[] }) {
  const green  = scores.filter((s) => s.status === 'green').length
  const yellow = scores.filter((s) => s.status === 'yellow').length
  const red    = scores.filter((s) => s.status === 'red').length

  return (
    <div className="flex flex-col">
      {/* Summary pills */}
      <div className="px-4 py-2.5 border-b border-[#E0E0E5] flex items-center gap-5">
        <span className="font-mono text-[11px] font-bold text-[#00FF88]">{green} Good</span>
        <span className="font-mono text-[11px] font-bold text-amber-500">{yellow} Fair</span>
        <span className="font-mono text-[11px] font-bold text-red-400">{red} Weak</span>
      </div>

      {/* Score rows */}
      {scores.map((s) => (
        <div key={s.metric} className="px-4 py-3 flex items-center justify-between border-b border-[#F5F5F8] last:border-b-0">
          <div className="flex flex-col gap-0.5">
            <span className="font-mono text-[13px] font-medium text-[#1A1A1A]">{s.label}</span>
            <span className="font-mono text-[10px] text-[#888888]">{s.description}</span>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <span className="font-mono text-[13px] font-semibold text-[#1A1A1A]">{s.formatted}</span>
            <StatusPill status={s.status as Status} />
          </div>
        </div>
      ))}
    </div>
  )
}
