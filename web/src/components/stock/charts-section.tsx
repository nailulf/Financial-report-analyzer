import type { FinancialYear } from '@/lib/types/api'
import { Card } from '@/components/ui/card'
import { RevenueProfitChart } from '@/components/charts/revenue-profit-chart'
import { MarginTrendChart } from '@/components/charts/margin-trend-chart'
import { CashFlowChart } from '@/components/charts/cash-flow-chart'

export function ChartsSection({ data }: { data: FinancialYear[] }) {
  return (
    <div className="space-y-6">
      <Card title="Revenue & Net Profit">
        <div className="p-6">
          <RevenueProfitChart data={data} />
        </div>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card title="Margin Trends">
          <div className="p-6">
            <MarginTrendChart data={data} />
          </div>
        </Card>
        <Card title="Cash Flow">
          <div className="p-6">
            <CashFlowChart data={data} />
          </div>
        </Card>
      </div>
    </div>
  )
}
