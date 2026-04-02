"""
Dataclasses for the Phase 6 AI pipeline.

These mirror the database tables and provide typed containers
for passing data between pipeline stages.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional


# ---------------------------------------------------------------------------
# Stage 1: Data Cleaner output
# ---------------------------------------------------------------------------

@dataclass
class YearFlag:
    """Per-year cleaning flags. Maps to one row in data_quality_flags table."""
    year: int
    is_covid_year: bool = False
    is_ipo_year: bool = False
    is_restated: bool = False           # DEFERRED v1: always False
    has_anomaly: bool = False
    anomaly_metrics: List[str] = field(default_factory=list)
    anomaly_scores: Dict[str, float] = field(default_factory=dict)
    has_one_time_items: bool = False
    scale_warning: bool = False
    scale_factor_applied: Optional[int] = None
    source_conflict: bool = False
    conflict_metric: Optional[List[str]] = None
    conflict_magnitude: Optional[float] = None
    resolution: Optional[str] = None
    usability_flag: str = "clean"       # clean|minor_issues|use_with_caution|exclude
    notes: List[str] = field(default_factory=list)


@dataclass
class CleaningResult:
    """Summary of cleaning a single ticker."""
    ticker: str
    years_processed: int
    years_excluded: int
    flags_set: List[str] = field(default_factory=list)
    source_conflicts: int = 0
    overall_quality: str = "clean"      # clean|minor_issues|use_with_caution
    ipo_excluded: bool = False


# ---------------------------------------------------------------------------
# Stage 2: Data Normalizer output
# ---------------------------------------------------------------------------

@dataclass
class NormalizedMetric:
    """Per-metric normalization result. Maps to one row in normalized_metrics table."""
    metric_name: str
    unit: str                           # idr|ratio|percent|multiple
    latest_value: Optional[float] = None
    latest_year: Optional[int] = None
    cagr_full: Optional[float] = None
    cagr_3yr: Optional[float] = None
    cagr_5yr: Optional[float] = None
    trend_direction: str = "insufficient_data"
    trend_r2: Optional[float] = None
    trend_slope_pct: Optional[float] = None
    volatility: Optional[float] = None
    z_score_vs_sector: Optional[float] = None
    percentile_vs_sector: Optional[float] = None
    peer_group_level: Optional[str] = None  # subsector|sector|None
    peer_count: int = 0
    anomaly_years: List[int] = field(default_factory=list)
    missing_years: List[int] = field(default_factory=list)
    data_years_count: int = 0
    years: List[int] = field(default_factory=list)
    values: List[float] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Stage 3: Scoring Engine output
# ---------------------------------------------------------------------------

@dataclass
class StockScore:
    """Decomposed reliability + confidence scores. Maps to stock_scores table."""
    ticker: str = ""

    # Reliability (data quality gate)
    reliability_total: float = 0
    reliability_grade: str = "F"
    reliability_completeness: float = 0
    reliability_consistency: float = 0
    reliability_freshness: float = 0
    reliability_source: float = 0
    reliability_penalties: float = 0

    # Confidence (signal strength)
    confidence_total: float = 0
    confidence_grade: str = "VERY LOW"
    confidence_signal: float = 0
    confidence_trend: float = 0
    confidence_depth: float = 0
    confidence_peers: float = 0
    confidence_valuation: float = 0
    confidence_penalty: float = 0

    # Composite
    composite_score: float = 0
    ready_for_ai: bool = False

    # Signals
    bullish_signals: List[str] = field(default_factory=list)
    bearish_signals: List[str] = field(default_factory=list)
    neutral_signals: List[str] = field(default_factory=list)
    data_gap_flags: List[str] = field(default_factory=list)

    # Metadata
    data_years_available: int = 0
    primary_source: str = ""
    auditor_tier: Optional[str] = None
    missing_metrics: List[str] = field(default_factory=list)
    anomalous_metrics: List[str] = field(default_factory=list)
    sector_peers_count: int = 0


# ---------------------------------------------------------------------------
# Stage 4: Context Builder output
# ---------------------------------------------------------------------------

@dataclass
class ContextBundle:
    """The full AI context bundle. Maps to ai_context_cache table."""
    ticker: str
    context: Dict[str, Any] = field(default_factory=dict)  # the 8-block JSON
    token_estimate: int = 0
    ready_for_ai: bool = False
    build_duration_ms: int = 0
    context_version: str = "1.0"


# ---------------------------------------------------------------------------
# Stage 5: AI Analyst output
# ---------------------------------------------------------------------------

@dataclass
class AIAnalysisResult:
    """Result from Claude API call."""
    ticker: str
    success: bool = False
    error: Optional[str] = None

    # Classification
    lynch_category: Optional[str] = None
    buffett_moat: Optional[str] = None
    analyst_verdict: Optional[str] = None
    confidence_level: Optional[int] = None

    # Scenarios (stored as dicts)
    bull_case: Optional[Dict[str, Any]] = None
    bear_case: Optional[Dict[str, Any]] = None
    neutral_case: Optional[Dict[str, Any]] = None

    # Cost tracking
    prompt_tokens: int = 0
    output_tokens: int = 0
    cost_usd_estimate: float = 0
