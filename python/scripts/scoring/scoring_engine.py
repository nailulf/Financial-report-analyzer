"""
Stage 3: Scoring Engine — Compute reliability + confidence scores.

Produces two decomposed scores:
- Reliability (data quality gate): completeness, consistency, freshness, source, penalties
- Confidence (signal strength): signal, trend, depth, peers, valuation

Plus a composite score and ready_for_ai boolean gate.

FRD reference: Section 3.3 (stock_scores table), Section 10 (data quality rules)
"""

from __future__ import annotations

import logging
from datetime import date
from typing import Dict, List

from scripts.scoring.schema import YearFlag, NormalizedMetric, StockScore
from scripts.scoring.config import scoring_params, ready_for_ai_thresholds

logger = logging.getLogger(__name__)


class ScoringPipeline:
    """
    Compute reliability + confidence + composite scores for one ticker.
    """

    def __init__(self):
        self._params = scoring_params()
        self._rfa = ready_for_ai_thresholds()

    # =====================================================================
    # Reliability (data quality gate, max 100)
    # =====================================================================

    def _reliability_completeness(self, metrics: List[NormalizedMetric]) -> float:
        """Max 30: proportion of 20 metrics that have data."""
        max_pts = self._params["reliability_weights"]["completeness"]
        populated = sum(1 for m in metrics if m.latest_value is not None)
        return round(populated / 20 * max_pts, 2)

    def _reliability_consistency(self, flags: Dict[int, YearFlag]) -> float:
        """Max 25: proportion of years that are clean or minor_issues."""
        max_pts = self._params["reliability_weights"]["consistency"]
        total = len(flags)
        if total == 0:
            return 0
        clean = sum(
            1 for f in flags.values()
            if f.usability_flag in ("clean", "minor_issues")
        )
        return round(clean / total * max_pts, 2)

    def _reliability_freshness(self, clean_rows: List[dict]) -> float:
        """Max 25: how recent is the latest published annual financial year."""
        max_pts = self._params["reliability_weights"]["freshness"]
        if not clean_rows:
            return 0

        current_year = date.today().year
        # Find latest non-TTM year
        published_years = [
            r["year"] for r in clean_rows
            if not r.get("is_ttm")
        ]
        if not published_years:
            return 0

        latest = max(published_years)
        age = current_year - latest

        if age <= 1:
            return max_pts
        elif age <= 2:
            return round(max_pts * 0.6, 2)
        else:
            return round(max_pts * 0.2, 2)

    def _reliability_source(self, clean_rows: List[dict]) -> float:
        """Max 20: quality of data source (stockbit > idx > yfinance)."""
        max_pts = self._params["reliability_weights"]["source"]
        sources = set(
            (r.get("source") or "unknown").lower()
            for r in clean_rows
        )
        if any("stockbit" in s for s in sources):
            return max_pts
        elif any("idx" in s for s in sources):
            return round(max_pts * 0.75, 2)
        elif any("yfinance" in s for s in sources):
            return round(max_pts * 0.50, 2)
        return round(max_pts * 0.25, 2)

    def _reliability_penalties(self, flags: Dict[int, YearFlag]) -> float:
        """Deductions for anomalies, scale issues, etc. Returned as positive number."""
        anomaly_count = sum(1 for f in flags.values() if f.has_anomaly)
        scale_count = sum(1 for f in flags.values() if f.scale_warning)
        penalty = anomaly_count * 3 + scale_count * 5
        return min(penalty, 15.0)

    def compute_reliability(
        self,
        metrics: List[NormalizedMetric],
        flags: Dict[int, YearFlag],
        clean_rows: List[dict],
    ) -> tuple:
        """Returns (total, grade, completeness, consistency, freshness, source, penalties)."""
        completeness = self._reliability_completeness(metrics)
        consistency = self._reliability_consistency(flags)
        freshness = self._reliability_freshness(clean_rows)
        source = self._reliability_source(clean_rows)
        penalties = self._reliability_penalties(flags)

        total = round(min(100, max(0,
            completeness + consistency + freshness + source - penalties
        )), 2)

        # Grade
        grades = self._params["reliability_grades"]
        if total >= grades["A"]:
            grade = "A"
        elif total >= grades["B"]:
            grade = "B"
        elif total >= grades["C"]:
            grade = "C"
        elif total >= grades["D"]:
            grade = "D"
        else:
            grade = "F"

        return total, grade, completeness, consistency, freshness, source, penalties

    # =====================================================================
    # Confidence (signal strength, max 100)
    # =====================================================================

    def _confidence_signal(self) -> float:
        """
        Max 25: smart money signal agreement.
        Placeholder — will be overridden by context_builder when smart money data is available.
        """
        return 5.0  # default without smart money data

    def _confidence_trend(self, metrics: List[NormalizedMetric]) -> float:
        """Max 25: average R² across metrics with computed trends."""
        max_pts = self._params["confidence_weights"]["trend"]
        r2_values = [m.trend_r2 for m in metrics if m.trend_r2 is not None]
        if not r2_values:
            return 0
        avg_r2 = sum(r2_values) / len(r2_values)
        return round(avg_r2 * max_pts, 2)

    def _confidence_depth(self, metrics: List[NormalizedMetric]) -> float:
        """Max 20: years of data available (capped at 10 years = full score)."""
        max_pts = self._params["confidence_weights"]["depth"]
        max_years = max((m.data_years_count for m in metrics), default=0)
        return round(min(max_years / 10, 1.0) * max_pts, 2)

    def _confidence_peers(self, metrics: List[NormalizedMetric]) -> float:
        """Max 15: average peer count across metrics that have peer data."""
        max_pts = self._params["confidence_weights"]["peers"]
        peer_counts = [m.peer_count for m in metrics if m.peer_count > 0]
        if not peer_counts:
            return 0
        avg_peers = sum(peer_counts) / len(peer_counts)
        return round(min(avg_peers / 20, 1.0) * max_pts, 2)

    def _confidence_valuation(self, metrics: List[NormalizedMetric]) -> float:
        """Max 15: are valuation anchors computable? (PE, PB, FCF each worth 5pts)."""
        max_pts = self._params["confidence_weights"]["valuation"]
        has_pe = any(m.metric_name == "pe_ratio" and m.latest_value is not None for m in metrics)
        has_pb = any(m.metric_name == "pb_ratio" and m.latest_value is not None for m in metrics)
        has_fcf = any(m.metric_name == "free_cash_flow" and m.latest_value is not None for m in metrics)
        pts = (5 if has_pe else 0) + (5 if has_pb else 0) + (5 if has_fcf else 0)
        return min(float(pts), max_pts)

    def compute_confidence(
        self,
        metrics: List[NormalizedMetric],
    ) -> tuple:
        """Returns (total, grade, signal, trend, depth, peers, valuation, penalty)."""
        signal = self._confidence_signal()
        trend = self._confidence_trend(metrics)
        depth = self._confidence_depth(metrics)
        peers = self._confidence_peers(metrics)
        valuation = self._confidence_valuation(metrics)
        penalty = 0.0  # reserved for future deductions

        total = round(min(100, max(0,
            signal + trend + depth + peers + valuation - penalty
        )), 2)

        # Grade
        grades = self._params["confidence_grades"]
        if total >= grades["HIGH"]:
            grade = "HIGH"
        elif total >= grades["MEDIUM"]:
            grade = "MEDIUM"
        elif total >= grades["LOW"]:
            grade = "LOW"
        else:
            grade = "VERY LOW"

        return total, grade, signal, trend, depth, peers, valuation, penalty

    # =====================================================================
    # Composite + ready_for_ai
    # =====================================================================

    def compute_composite(self, reliability: float, confidence: float) -> float:
        """Composite score: reliability gates confidence."""
        floor = self._params["composite_reliability_floor"]
        cap = self._params["composite_low_reliability_cap"]
        if reliability < floor:
            return round(min(cap, confidence * 0.3), 2)
        return round(reliability * 0.5 + confidence * 0.5, 2)

    def check_ready_for_ai(
        self,
        reliability: float,
        confidence: float,
        flags: Dict[int, YearFlag],
        metrics: List[NormalizedMetric],
    ) -> bool:
        """Check all eligibility criteria for AI analysis."""
        rfa = self._rfa

        # Min scores
        if reliability < rfa["min_reliability"]:
            return False
        if confidence < rfa["min_confidence"]:
            return False

        # Min clean years
        clean_years = sum(
            1 for f in flags.values()
            if f.usability_flag in ("clean", "minor_issues")
        )
        if clean_years < rfa["min_clean_years"]:
            return False

        # Revenue must be present and positive
        has_revenue = any(
            m.metric_name == "revenue" and m.latest_value is not None and m.latest_value > 0
            for m in metrics
        )
        if not has_revenue:
            return False

        # Anomaly year limit
        total_years = len(flags)
        anomaly_count = sum(1 for f in flags.values() if f.has_anomaly)
        if total_years > 0 and anomaly_count / total_years > rfa["max_anomaly_pct"]:
            return False

        return True

    # =====================================================================
    # Signal detection
    # =====================================================================

    def detect_signals(self, metrics: List[NormalizedMetric]) -> tuple:
        """Detect bullish, bearish, and neutral signals from metric trends."""
        bullish: List[str] = []
        bearish: List[str] = []
        neutral: List[str] = []

        for m in metrics:
            # Revenue/earnings growth acceleration
            if (m.metric_name in ("revenue", "net_income", "eps")
                    and m.cagr_3yr is not None and m.cagr_full is not None
                    and m.cagr_3yr > m.cagr_full and m.cagr_3yr > 0):
                bullish.append(f"{m.metric_name}_growth_accelerating")

            # Revenue/earnings deceleration
            if (m.metric_name in ("revenue", "net_income")
                    and m.cagr_3yr is not None and m.cagr_full is not None
                    and m.cagr_3yr < m.cagr_full * 0.5 and m.cagr_full > 0):
                bearish.append(f"{m.metric_name}_growth_decelerating")

            # Margin compression
            if m.metric_name in ("net_margin", "gross_margin", "roe"):
                if m.trend_direction in ("mild_down", "strong_down"):
                    bearish.append(f"{m.metric_name}_declining")
                elif m.trend_direction in ("mild_up", "strong_up"):
                    bullish.append(f"{m.metric_name}_improving")

            # Deleveraging
            if m.metric_name == "debt_to_equity" and m.trend_direction in ("mild_down", "strong_down"):
                bullish.append("deleveraging")

            # FCF quality concern
            fcf_ni = next((x for x in metrics if x.metric_name == "fcf_to_net_income"), None)
            if (m.metric_name == "fcf_to_net_income"
                    and m.latest_value is not None and m.latest_value < 0.70):
                bearish.append("fcf_quality_concern")

            # Dividend growth
            if m.metric_name == "dps" and m.trend_direction in ("mild_up", "strong_up"):
                bullish.append("dividend_growth")

        # Deduplicate
        return list(set(bullish)), list(set(bearish)), list(set(neutral))

    # =====================================================================
    # Data gap detection
    # =====================================================================

    def detect_data_gaps(self, metrics: List[NormalizedMetric]) -> List[str]:
        """Identify data gaps that should be passed to AI prompt."""
        gaps = []

        # Missing metrics
        missing = [m.metric_name for m in metrics if m.latest_value is None]
        if missing:
            gaps.append(f"missing_metrics: {', '.join(missing)}")

        # No sector comparison
        has_peer = any(m.peer_count > 0 for m in metrics)
        if not has_peer:
            gaps.append("no_sector_comparison: peer data not available for any metric")

        # Insufficient data depth
        max_years = max((m.data_years_count for m in metrics), default=0)
        if max_years < 5:
            gaps.append(f"limited_history: only {max_years} years of data (5+ recommended)")

        return gaps

    # =====================================================================
    # Main entry point
    # =====================================================================

    def run(
        self,
        metrics: List[NormalizedMetric],
        flags: Dict[int, YearFlag],
        clean_rows: List[dict],
        stock: dict,
    ) -> StockScore:
        """
        Full scoring pipeline for one ticker.

        Returns a StockScore with all components filled.
        """
        ticker = stock.get("ticker", "UNKNOWN")

        # Reliability
        (rel_total, rel_grade, rel_compl, rel_cons,
         rel_fresh, rel_src, rel_pen) = self.compute_reliability(metrics, flags, clean_rows)

        # Confidence
        (conf_total, conf_grade, conf_sig, conf_trend,
         conf_depth, conf_peers, conf_val, conf_pen) = self.compute_confidence(metrics)

        # Composite
        composite = self.compute_composite(rel_total, conf_total)

        # ready_for_ai
        ready = self.check_ready_for_ai(rel_total, conf_total, flags, metrics)

        # Signals
        bullish, bearish, neutral = self.detect_signals(metrics)

        # Data gaps
        data_gaps = self.detect_data_gaps(metrics)

        # Missing metrics
        missing_metrics = [m.metric_name for m in metrics if m.latest_value is None]
        anomalous_metrics = list(set(
            m.metric_name for m in metrics if m.anomaly_years
        ))

        # Primary source
        sources = set((r.get("source") or "unknown").lower() for r in clean_rows[:5])
        primary = "stockbit" if any("stockbit" in s for s in sources) else \
                  "idx" if any("idx" in s for s in sources) else \
                  "yfinance" if any("yfinance" in s for s in sources) else "unknown"

        # Data years
        data_years = max((m.data_years_count for m in metrics), default=0)

        # Sector peers
        peer_counts = [m.peer_count for m in metrics if m.peer_count > 0]
        sector_peers = max(peer_counts) if peer_counts else 0

        return StockScore(
            ticker=ticker,
            reliability_total=rel_total,
            reliability_grade=rel_grade,
            reliability_completeness=rel_compl,
            reliability_consistency=rel_cons,
            reliability_freshness=rel_fresh,
            reliability_source=rel_src,
            reliability_penalties=rel_pen,
            confidence_total=conf_total,
            confidence_grade=conf_grade,
            confidence_signal=conf_sig,
            confidence_trend=conf_trend,
            confidence_depth=conf_depth,
            confidence_peers=conf_peers,
            confidence_valuation=conf_val,
            confidence_penalty=conf_pen,
            composite_score=composite,
            ready_for_ai=ready,
            bullish_signals=bullish,
            bearish_signals=bearish,
            neutral_signals=neutral,
            data_gap_flags=data_gaps,
            data_years_available=data_years,
            primary_source=primary,
            missing_metrics=missing_metrics,
            anomalous_metrics=anomalous_metrics,
            sector_peers_count=sector_peers,
        )
