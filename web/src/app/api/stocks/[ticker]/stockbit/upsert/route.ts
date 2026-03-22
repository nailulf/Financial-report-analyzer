import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import type { StockbitPreviewRow } from '@/lib/types/api'

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ ticker: string }> },
) {
  const { ticker } = await params
  const { rows } = await req.json() as { rows: StockbitPreviewRow[] }

  if (!Array.isArray(rows) || rows.length === 0) {
    return NextResponse.json({ error: 'No rows to upsert' }, { status: 400 })
  }

  // Build upsert payload — only include non-null fields to avoid overwriting good data
  const upsertRows = rows.map((r) => {
    const row: Record<string, unknown> = {
      ticker: ticker.toUpperCase(),
      year: r.year,
      quarter: r.quarter,
    }
    // Only map fields that exist as columns in the financials table
    const optional: (keyof StockbitPreviewRow)[] = [
      // Income Statement
      'revenue', 'gross_profit', 'net_income', 'eps',
      // Balance Sheet
      'total_assets', 'total_liabilities', 'total_equity', 'total_debt',
      'cash_and_equivalents', 'book_value_per_share',
      'net_debt', 'working_capital', 'short_term_debt', 'long_term_debt',
      // Cash Flow
      'operating_cash_flow', 'investing_cash_flow', 'financing_cash_flow',
      'capex', 'free_cash_flow',
      // Profitability (computed from P&L)
      'gross_margin', 'operating_margin', 'net_margin',
      // Returns
      'roe', 'roa', 'roce', 'roic',
      'interest_coverage', 'asset_turnover', 'inventory_turnover',
      // Solvency
      'current_ratio', 'debt_to_equity', 'lt_debt_to_equity',
      'financial_leverage', 'debt_to_assets', 'total_liabilities_to_equity',
      // Valuation
      'pe_ratio', 'pbv_ratio', 'ps_ratio', 'ev_ebitda', 'earnings_yield',
      // Dividend
      'dividend_yield', 'payout_ratio',
    ]
    for (const key of optional) {
      const val = r[key]
      if (val != null) row[key] = val
    }
    return row
  })

  const supabase = await createClient()
  const { error, count } = await supabase
    .from('financials')
    .upsert(upsertRows, { onConflict: 'ticker,year,quarter', count: 'exact' })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ upserted: count ?? rows.length })
}
