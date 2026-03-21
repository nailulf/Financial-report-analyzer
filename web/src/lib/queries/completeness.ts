import { createClient } from '@/lib/supabase/server'
import type { DataQuality } from '@/lib/types/api'

export async function getDataQuality(ticker: string): Promise<DataQuality | null> {
  const supabase = await createClient()

  const [complRes, stockRes] = await Promise.all([
    supabase
      .from('v_data_completeness')
      .select('*')
      .eq('ticker', ticker)
      .single(),
    supabase
      .from('stocks')
      .select('confidence_score, score_version, scores_updated_at, last_updated')
      .eq('ticker', ticker)
      .single(),
  ])

  if (complRes.error || !complRes.data) return null

  const c = complRes.data
  const s = stockRes.data

  const breakdown = {
    price_history: {
      score:  c.price_score             ?? 0,
      max:    15,
      detail: `${c.price_days_count ?? 0} / 1250 trading days`,
    },
    annual_coverage: {
      score:  c.annual_coverage_score   ?? 0,
      max:    12,
      detail: `${c.annual_years_count ?? 0} / 5 annual years`,
    },
    annual_quality: {
      score:  c.annual_quality_score    ?? 0,
      max:    10,
      detail: `${c.annual_fields_present ?? 0} / 7 core fields in latest annual`,
    },
    quarterly_financials: {
      score:  c.quarterly_score         ?? 0,
      max:    10,
      detail: `${c.quarterly_rows_count ?? 0} / 8 quarterly periods`,
    },
    quarterly_reports: {
      score:  c.quarterly_reports_score ?? 0,
      max:    8,
      detail: `${c.quarterly_docs_count ?? 0} / 4 recent quarter PDFs`,
    },
    annual_reports: {
      score:  c.annual_reports_score    ?? 0,
      max:    5,
      detail: `${c.annual_docs_count ?? 0} annual report PDF(s)`,
    },
    company_profile: {
      score:  c.profile_score           ?? 0,
      max:    7,
      detail: 'description, website, address, phone, email',
    },
    board_commissioners: {
      score:  c.board_score             ?? 0,
      max:    8,
      detail: 'directors and commissioners on record',
    },
    shareholders: {
      score:  c.shareholder_score       ?? 0,
      max:    8,
      detail: `${c.shareholders_count ?? 0} shareholders ≥1% on record`,
    },
    corporate_events: {
      score:  c.corporate_events_score  ?? 0,
      max:    7,
      detail: `${c.expose_events_count ?? 0} public expose, ${c.agm_events_count ?? 0} AGM/EGM`,
    },
    derived_metrics: {
      score:  c.derived_metrics_score   ?? 0,
      max:    10,
      detail: `${c.derived_fields_count ?? 0} / 10 ratio fields populated`,
    },
  }

  // All categories with score=0 are eligible to appear in missing list
  const missingCategories = Object.entries(breakdown)
    .filter(([, v]) => v.score === 0)
    .map(([key]) => key)

  return {
    ticker,
    completeness_score:  c.completeness_score ?? 1,
    confidence_score:    s?.confidence_score  ?? null,
    score_version:       s?.score_version     ?? 'v1',
    scores_updated_at:   s?.scores_updated_at ?? null,
    last_scraped_at:     s?.last_updated      ?? null,
    missing_categories:  missingCategories,
    completeness_breakdown: breakdown,
  }
}
