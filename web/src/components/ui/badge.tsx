interface BadgeProps {
  children: React.ReactNode
  variant?: 'default' | 'green' | 'blue' | 'purple' | 'amber' | 'red' | 'gray'
  size?: 'sm' | 'xs'
}

const VARIANTS = {
  default: 'bg-[#EDECEA] text-[#6D6C6A]',
  green:   'bg-[#C8F0D8] text-[#3D8A5A]',
  blue:    'bg-blue-100 text-blue-700',
  purple:  'bg-purple-100 text-purple-700',
  amber:   'bg-amber-100 text-amber-700',
  red:     'bg-red-100 text-red-700',
  gray:    'bg-[#EDECEA] text-[#9C9B99]',
}

export function Badge({ children, variant = 'default', size = 'sm' }: BadgeProps) {
  return (
    <span className={`inline-flex items-center rounded-lg font-medium ${
      size === 'xs' ? 'px-2 py-0.5 text-xs' : 'px-2.5 py-1 text-xs'
    } ${VARIANTS[variant]}`}>
      {children}
    </span>
  )
}
