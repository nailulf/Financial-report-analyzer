import type { HealthStatus } from '@/lib/types/api'

interface TrafficLightProps {
  status: HealthStatus
  label?: string
}

const DOT = {
  green:  'bg-green-500',
  yellow: 'bg-amber-400',
  red:    'bg-red-500',
  na:     'bg-[#E5E4E1]',
}

const TEXT = {
  green:  'text-green-700',
  yellow: 'text-amber-600',
  red:    'text-red-600',
  na:     'text-[#9C9B99]',
}

const LABEL = {
  green:  'Good',
  yellow: 'Fair',
  red:    'Weak',
  na:     'N/A',
}

export function TrafficLight({ status, label }: TrafficLightProps) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`w-2 h-2 rounded-full flex-shrink-0 ${DOT[status]}`} />
      <span className={`text-xs font-medium ${TEXT[status]}`}>{label ?? LABEL[status]}</span>
    </span>
  )
}
