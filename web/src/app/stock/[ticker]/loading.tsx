import { MetricCardSkeleton, Skeleton } from '@/components/ui/loading-skeleton'

export default function StockLoading() {
  return (
    <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <Skeleton className="h-8 w-32 mb-2" />
      <Skeleton className="h-5 w-64 mb-6" />
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4 mb-6">
        {[...Array(5)].map((_, i) => <MetricCardSkeleton key={i} />)}
      </div>
      <Skeleton className="w-full h-80 rounded-xl mb-6" />
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Skeleton className="h-64 rounded-xl" />
        <Skeleton className="h-64 rounded-xl" />
      </div>
    </main>
  )
}
