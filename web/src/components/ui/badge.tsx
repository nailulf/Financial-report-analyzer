interface BadgeProps {
  children: React.ReactNode
  variant?: 'default' | 'green' | 'blue' | 'purple' | 'amber' | 'red' | 'gray'
  size?: 'sm' | 'xs'
}

const VARIANTS = {
  default: 'bg-gray-100 text-gray-700',
  green:   'bg-green-100 text-green-700',
  blue:    'bg-blue-100 text-blue-700',
  purple:  'bg-purple-100 text-purple-700',
  amber:   'bg-amber-100 text-amber-700',
  red:     'bg-red-100 text-red-700',
  gray:    'bg-gray-100 text-gray-500',
}

export function Badge({ children, variant = 'default', size = 'sm' }: BadgeProps) {
  return (
    <span className={`inline-flex items-center rounded-full font-medium ${size === 'xs' ? 'px-2 py-0.5 text-xs' : 'px-2.5 py-0.5 text-xs'} ${VARIANTS[variant]}`}>
      {children}
    </span>
  )
}
