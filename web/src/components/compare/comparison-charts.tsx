import type { ComparisonStock } from '@/lib/types/api'
import { Card } from '@/components/ui/card'
import { ComparisonBarChart } from '@/components/charts/comparison-bar-chart'

export function ComparisonCharts({ stocks }: { stocks: ComparisonStock[] }) {
  return (
    <Card title="Visual Comparison">
      <div className="p-5">
        <ComparisonBarChart stocks={stocks} />
      </div>
    </Card>
  )
}
