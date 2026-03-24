interface SkeletonProps {
  className?: string
}

export function Skeleton({ className = '' }: SkeletonProps) {
  return <div className={`animate-pulse bg-[#EDECEA] rounded ${className}`} />
}

export function MetricCardSkeleton() {
  return (
    <div className="rounded-2xl border border-[#E5E4E1] bg-white p-5 shadow-[0_2px_12px_rgba(26,25,24,0.06)]">
      <Skeleton className="h-3 w-20 mb-2" />
      <Skeleton className="h-8 w-28" />
    </div>
  )
}

export function TableRowSkeleton({ cols = 7 }: { cols?: number }) {
  return (
    <tr>
      {Array.from({ length: cols }).map((_, i) => (
        <td key={i} className="px-4 py-3">
          <Skeleton className="h-4 w-full" />
        </td>
      ))}
    </tr>
  )
}

export function ChartSkeleton({ height = 300 }: { height?: number }) {
  return <div className="animate-pulse bg-[#EDECEA] rounded-2xl w-full" style={{ height }} />
}
