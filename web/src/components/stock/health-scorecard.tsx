import type { HealthScore } from '@/lib/types/api'
import { Card } from '@/components/ui/card'

type Status = 'green' | 'yellow' | 'red' | 'na'

const STATUS_DOT: Record<Status, string> = {
  green:  'bg-[#3D8A5A]',
  yellow: 'bg-amber-400',
  red:    'bg-red-500',
  na:     'bg-[#E5E4E1]',
}
const STATUS_TEXT: Record<Status, string> = {
  green:  'text-[#3D8A5A]',
  yellow: 'text-amber-600',
  red:    'text-red-600',
  na:     'text-[#9C9B99]',
}
const STATUS_LABEL: Record<Status, string> = {
  green: 'Good', yellow: 'Fair', red: 'Weak', na: 'N/A',
}

function StatusPill({ status }: { status: Status }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`w-2 h-2 rounded-full flex-shrink-0 ${STATUS_DOT[status]}`} />
      <span className={`text-xs font-medium ${STATUS_TEXT[status]}`}>{STATUS_LABEL[status]}</span>
    </span>
  )
}

export function HealthScorecard({ scores }: { scores: HealthScore[] }) {
  const green  = scores.filter((s) => s.status === 'green').length
  const yellow = scores.filter((s) => s.status === 'yellow').length
  const red    = scores.filter((s) => s.status === 'red').length

  return (
    <Card title="Health Scorecard">
      <div className="px-6 py-3 border-b border-[#E5E4E1] flex items-center gap-6 text-xs">
        <span className="text-[#3D8A5A] font-semibold">{green} Good</span>
        <span className="text-amber-600 font-semibold">{yellow} Fair</span>
        <span className="text-red-600 font-semibold">{red} Weak</span>
      </div>
      <div className="divide-y divide-[#E5E4E1]">
        {scores.map((s) => (
          <div key={s.metric} className="px-6 py-3.5 flex items-center justify-between hover:bg-[#F5F4F1]/60 transition-colors">
            <div>
              <p className="text-sm font-medium text-[#1A1918]">{s.label}</p>
              <p className="text-xs text-[#9C9B99]">{s.description}</p>
            </div>
            <div className="flex items-center gap-4 shrink-0">
              <span className="text-sm font-semibold font-mono text-[#1A1918]">{s.formatted}</span>
              <StatusPill status={s.status as Status} />
            </div>
          </div>
        ))}
      </div>
    </Card>
  )
}
