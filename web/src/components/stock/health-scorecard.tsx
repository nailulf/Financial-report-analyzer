import type { HealthScore } from '@/lib/types/api'
import { Card } from '@/components/ui/card'
import { TrafficLight } from '@/components/ui/traffic-light'

export function HealthScorecard({ scores }: { scores: HealthScore[] }) {
  const green  = scores.filter((s) => s.status === 'green').length
  const yellow = scores.filter((s) => s.status === 'yellow').length
  const red    = scores.filter((s) => s.status === 'red').length

  return (
    <Card title="Health Scorecard">
      <div className="px-5 py-3 border-b border-gray-100 flex items-center gap-4 text-xs text-gray-500">
        <span className="text-green-600 font-medium">{green} Good</span>
        <span className="text-amber-600 font-medium">{yellow} Fair</span>
        <span className="text-red-600 font-medium">{red} Weak</span>
      </div>
      <div className="divide-y divide-gray-100">
        {scores.map((s) => (
          <div key={s.metric} className="px-5 py-3 flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-gray-800">{s.label}</p>
              <p className="text-xs text-gray-400">{s.description}</p>
            </div>
            <div className="flex items-center gap-4">
              <span className="text-sm font-semibold text-gray-700">{s.formatted}</span>
              <TrafficLight status={s.status} />
            </div>
          </div>
        ))}
      </div>
    </Card>
  )
}
