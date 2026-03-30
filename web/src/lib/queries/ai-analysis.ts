import { createClient } from '@/lib/supabase/server'
import type { AIAnalysis, ContextQuality, StockScore, PipelineDebugData, SectorTemplate, StockNote } from '@/lib/types/api'

// ---------------------------------------------------------------------------
// AI Analysis (from ai_analysis table)
// ---------------------------------------------------------------------------

export async function getAIAnalysis(ticker: string): Promise<AIAnalysis | null> {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('ai_analysis')
    .select('*')
    .eq('ticker', ticker)
    .single()

  if (error || !data) return null

  return {
    ticker: data.ticker,
    lynchCategory: data.lynch_category,
    lynchRationale: data.lynch_rationale,
    buffettMoat: data.buffett_moat,
    buffettMoatSource: data.buffett_moat_source,
    businessNarrative: data.business_narrative,
    financialHealthSignal: data.financial_health_signal,
    bullCase: data.bull_case,
    bearCase: data.bear_case,
    neutralCase: data.neutral_case,
    strategyFit: data.strategy_fit,
    whatToWatch: data.what_to_watch ? JSON.parse(data.what_to_watch) : [],
    analystVerdict: data.analyst_verdict,
    confidenceLevel: data.confidence_level,
    dataGapsAcknowledged: data.data_gaps_acknowledged ? JSON.parse(data.data_gaps_acknowledged) : [],
    caveats: data.caveats ? JSON.parse(data.caveats) : [],
    modelUsed: data.model_used,
    generatedAt: data.generated_at,
  }
}

// ---------------------------------------------------------------------------
// Context Quality (from ai_context_cache + stock_scores)
// ---------------------------------------------------------------------------

export async function getContextQuality(ticker: string): Promise<ContextQuality | null> {
  const supabase = await createClient()

  const [cacheRes, scoreRes] = await Promise.all([
    supabase
      .from('ai_context_cache')
      .select('ready_for_ai, token_estimate, built_at, context_version, context_json')
      .eq('ticker', ticker)
      .single(),
    supabase
      .from('stock_scores')
      .select('*')
      .eq('ticker', ticker)
      .single(),
  ])

  if (scoreRes.error || !scoreRes.data) return null

  const s = scoreRes.data
  const c = cacheRes.data

  // Extract data_quality block from context_json if available
  const dq = c?.context_json?.data_quality ?? {}

  return {
    readyForAI: c?.ready_for_ai ?? false,
    compositeScore: s.composite_score,
    reliabilityScore: s.reliability_total,
    reliabilityGrade: s.reliability_grade,
    confidenceScore: s.confidence_total,
    confidenceGrade: s.confidence_grade,
    dataYearsAvailable: s.data_years_available,
    primarySource: s.primary_source,
    missingMetrics: s.missing_metrics ? JSON.parse(s.missing_metrics) : [],
    anomalousYears: dq.anomalous_years ?? [],
    flaggedIssues: dq.flagged_issues ?? [],
    dataGapFlags: s.data_gap_flags ? JSON.parse(s.data_gap_flags) : [],
    builtAt: c?.built_at ?? null,
  }
}

// ---------------------------------------------------------------------------
// Stock Score (from stock_scores table)
// ---------------------------------------------------------------------------

export async function getStockScore(ticker: string): Promise<StockScore | null> {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('stock_scores')
    .select('*')
    .eq('ticker', ticker)
    .single()

  if (error || !data) return null

  return {
    ticker: data.ticker,
    reliabilityTotal: data.reliability_total,
    reliabilityGrade: data.reliability_grade,
    reliabilityCompleteness: data.reliability_completeness,
    reliabilityConsistency: data.reliability_consistency,
    reliabilityFreshness: data.reliability_freshness,
    reliabilitySource: data.reliability_source,
    reliabilityPenalties: data.reliability_penalties,
    confidenceTotal: data.confidence_total,
    confidenceGrade: data.confidence_grade,
    confidenceSignal: data.confidence_signal,
    confidenceTrend: data.confidence_trend,
    confidenceDepth: data.confidence_depth,
    confidencePeers: data.confidence_peers,
    confidenceValuation: data.confidence_valuation,
    compositeScore: data.composite_score,
    readyForAI: data.ready_for_ai,
    bullishSignals: data.bullish_signals ? JSON.parse(data.bullish_signals) : [],
    bearishSignals: data.bearish_signals ? JSON.parse(data.bearish_signals) : [],
    dataGapFlags: data.data_gap_flags ? JSON.parse(data.data_gap_flags) : [],
    missingMetrics: data.missing_metrics ? JSON.parse(data.missing_metrics) : [],
    computedAt: data.computed_at,
  }
}

// ---------------------------------------------------------------------------
// Pipeline Debug Data (aggregates all Stage 1-5 data for one ticker)
// ---------------------------------------------------------------------------

export async function getPipelineDebug(ticker: string): Promise<PipelineDebugData | null> {
  const supabase = await createClient()

  const [flagsRes, metricsRes, scoreRes, cacheRes, analysisRes] = await Promise.all([
    supabase
      .from('data_quality_flags')
      .select('year, usability_flag, is_covid_year, is_ipo_year, has_anomaly, has_one_time_items, scale_warning, cleaner_notes')
      .eq('ticker', ticker)
      .order('year'),
    supabase
      .from('normalized_metrics')
      .select('metric_name, latest_value, trend_direction, trend_r2, cagr_3yr, peer_count')
      .eq('ticker', ticker),
    supabase
      .from('stock_scores')
      .select('*')
      .eq('ticker', ticker)
      .single(),
    supabase
      .from('ai_context_cache')
      .select('token_estimate, ready_for_ai, built_at, context_version')
      .eq('ticker', ticker)
      .single(),
    supabase
      .from('ai_analysis')
      .select('*')
      .eq('ticker', ticker)
      .single(),
  ])

  const score = scoreRes.data ? {
    ticker,
    reliabilityTotal: scoreRes.data.reliability_total,
    reliabilityGrade: scoreRes.data.reliability_grade,
    reliabilityCompleteness: scoreRes.data.reliability_completeness,
    reliabilityConsistency: scoreRes.data.reliability_consistency,
    reliabilityFreshness: scoreRes.data.reliability_freshness,
    reliabilitySource: scoreRes.data.reliability_source,
    reliabilityPenalties: scoreRes.data.reliability_penalties,
    confidenceTotal: scoreRes.data.confidence_total,
    confidenceGrade: scoreRes.data.confidence_grade,
    confidenceSignal: scoreRes.data.confidence_signal,
    confidenceTrend: scoreRes.data.confidence_trend,
    confidenceDepth: scoreRes.data.confidence_depth,
    confidencePeers: scoreRes.data.confidence_peers,
    confidenceValuation: scoreRes.data.confidence_valuation,
    compositeScore: scoreRes.data.composite_score,
    readyForAI: scoreRes.data.ready_for_ai,
    bullishSignals: scoreRes.data.bullish_signals ? JSON.parse(scoreRes.data.bullish_signals) : [],
    bearishSignals: scoreRes.data.bearish_signals ? JSON.parse(scoreRes.data.bearish_signals) : [],
    dataGapFlags: scoreRes.data.data_gap_flags ? JSON.parse(scoreRes.data.data_gap_flags) : [],
    missingMetrics: scoreRes.data.missing_metrics ? JSON.parse(scoreRes.data.missing_metrics) : [],
    computedAt: scoreRes.data.computed_at,
  } as StockScore : null

  return {
    dataQualityFlags: flagsRes.data ?? [],
    normalizedMetrics: metricsRes.data ?? [],
    stockScore: score,
    contextCache: cacheRes.data ? {
      tokenEstimate: cacheRes.data.token_estimate,
      readyForAI: cacheRes.data.ready_for_ai,
      builtAt: cacheRes.data.built_at,
      contextVersion: cacheRes.data.context_version,
    } : null,
    aiAnalysis: analysisRes.data ? await getAIAnalysis(ticker) : null,
  }
}

// ---------------------------------------------------------------------------
// Sector Template
// ---------------------------------------------------------------------------

export async function getSectorTemplate(subsector: string): Promise<SectorTemplate | null> {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('sector_templates')
    .select('*')
    .eq('subsector', subsector)
    .single()

  if (error || !data) return null

  return {
    subsector: data.subsector,
    keyMetrics: data.key_metrics,
    valuationMethod: data.valuation_method,
    cycleContext: data.cycle_context,
    currentDynamics: data.current_dynamics,
    commonRisks: data.common_risks,
    exemptions: data.exemptions,
    bumnNote: data.bumn_note,
  }
}

// ---------------------------------------------------------------------------
// Stock Notes (domain context)
// ---------------------------------------------------------------------------

export async function getStockNotes(ticker: string): Promise<StockNote | null> {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('stock_notes')
    .select('*')
    .eq('ticker', ticker)
    .single()

  if (error || !data) return null

  return {
    ticker: data.ticker,
    domainNotes: data.domain_notes,
    updatedAt: data.updated_at,
  }
}
