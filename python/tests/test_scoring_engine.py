"""Tests for Stage 3: Scoring Engine — reliability, confidence, composite, ready_for_ai."""

import os
import sys
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from scripts.scoring.scoring_engine import ScoringPipeline
from scripts.scoring.data_cleaner import DataCleaner
from scripts.scoring.data_normalizer import DataNormalizer
from scripts.scoring.schema import YearFlag, NormalizedMetric


@pytest.fixture
def pipeline():
    return ScoringPipeline()


@pytest.fixture
def cleaner():
    return DataCleaner()


@pytest.fixture
def normalizer():
    return DataNormalizer()


def _make_metric(name="revenue", value=100e12, r2=0.9, years=10, peers=0, unit="idr"):
    """Helper to create a NormalizedMetric with sensible defaults."""
    return NormalizedMetric(
        metric_name=name, unit=unit, latest_value=value,
        latest_year=2025, cagr_full=0.08, cagr_3yr=0.10,
        trend_direction="strong_up", trend_r2=r2,
        data_years_count=years, peer_count=peers,
    )


def _make_flags(n_years=10, n_anomalies=0, n_scale=0):
    """Helper to create YearFlag dict."""
    flags = {}
    for i in range(n_years):
        yr = 2016 + i
        f = YearFlag(year=yr)
        if i < n_anomalies:
            f.has_anomaly = True
        if i < n_scale:
            f.scale_warning = True
        flags[yr] = f
    return flags


def _make_clean_rows(n=10, source="stockbit"):
    """Helper to create clean financial rows."""
    return [
        {"year": 2016 + i, "quarter": 0, "source": source,
         "revenue": int(50e12 * 1.08**i), "net_income": int(25e12 * 1.08**i)}
        for i in range(n)
    ]


# ---------------------------------------------------------------------------
# Reliability
# ---------------------------------------------------------------------------

class TestReliabilityCompleteness:
    def test_all_20_populated(self, pipeline):
        metrics = [_make_metric(name=f"m{i}") for i in range(20)]
        score = pipeline._reliability_completeness(metrics)
        assert score == 30.0  # 20/20 * 30

    def test_half_populated(self, pipeline):
        metrics = [_make_metric(name=f"m{i}") for i in range(10)]
        metrics += [NormalizedMetric(metric_name=f"m{i+10}", unit="idr") for i in range(10)]
        score = pipeline._reliability_completeness(metrics)
        assert score == 15.0  # 10/20 * 30

    def test_none_populated(self, pipeline):
        metrics = [NormalizedMetric(metric_name=f"m{i}", unit="idr") for i in range(20)]
        score = pipeline._reliability_completeness(metrics)
        assert score == 0.0


class TestReliabilityConsistency:
    def test_all_clean(self, pipeline):
        flags = _make_flags(10)
        score = pipeline._reliability_consistency(flags)
        assert score == 25.0

    def test_half_excluded(self, pipeline):
        flags = _make_flags(10)
        for yr in list(flags.keys())[:5]:
            flags[yr].usability_flag = "exclude"
        score = pipeline._reliability_consistency(flags)
        assert score == 12.5  # 5/10 * 25


class TestReliabilityPenalties:
    def test_no_anomalies(self, pipeline):
        flags = _make_flags(10)
        assert pipeline._reliability_penalties(flags) == 0

    def test_three_anomalies(self, pipeline):
        flags = _make_flags(10, n_anomalies=3)
        assert pipeline._reliability_penalties(flags) == 9.0  # 3 * 3

    def test_scale_issues(self, pipeline):
        flags = _make_flags(10, n_scale=2)
        assert pipeline._reliability_penalties(flags) == 10.0  # 2 * 5

    def test_capped_at_15(self, pipeline):
        flags = _make_flags(10, n_anomalies=5, n_scale=3)
        assert pipeline._reliability_penalties(flags) == 15.0  # capped


class TestReliabilityGrades:
    def test_grade_a(self, pipeline):
        metrics = [_make_metric(name=f"m{i}") for i in range(20)]
        flags = _make_flags(10)
        rows = _make_clean_rows(10)
        total, grade, *_ = pipeline.compute_reliability(metrics, flags, rows)
        assert grade == "A"
        assert total >= 80

    def test_grade_f_no_data(self, pipeline):
        metrics = [NormalizedMetric(metric_name=f"m{i}", unit="idr") for i in range(20)]
        flags = {}
        rows = []
        total, grade, *_ = pipeline.compute_reliability(metrics, flags, rows)
        assert grade == "F"


# ---------------------------------------------------------------------------
# Confidence
# ---------------------------------------------------------------------------

class TestConfidenceTrend:
    def test_high_r2(self, pipeline):
        metrics = [_make_metric(name=f"m{i}", r2=0.9) for i in range(10)]
        score = pipeline._confidence_trend(metrics)
        assert score == 22.5  # 0.9 * 25

    def test_low_r2(self, pipeline):
        metrics = [_make_metric(name=f"m{i}", r2=0.2) for i in range(10)]
        score = pipeline._confidence_trend(metrics)
        assert score == 5.0  # 0.2 * 25

    def test_no_r2(self, pipeline):
        metrics = [NormalizedMetric(metric_name=f"m{i}", unit="idr") for i in range(10)]
        score = pipeline._confidence_trend(metrics)
        assert score == 0


class TestConfidenceDepth:
    def test_10_years(self, pipeline):
        metrics = [_make_metric(years=10)]
        score = pipeline._confidence_depth(metrics)
        assert score == 20.0  # 10/10 * 20

    def test_5_years(self, pipeline):
        metrics = [_make_metric(years=5)]
        score = pipeline._confidence_depth(metrics)
        assert score == 10.0

    def test_no_data(self, pipeline):
        metrics = [NormalizedMetric(metric_name="x", unit="idr")]
        score = pipeline._confidence_depth(metrics)
        assert score == 0


class TestConfidencePeers:
    def test_with_peers(self, pipeline):
        metrics = [_make_metric(peers=20)]
        score = pipeline._confidence_peers(metrics)
        assert score == 15.0  # 20/20 * 15

    def test_no_peers(self, pipeline):
        metrics = [_make_metric(peers=0)]
        score = pipeline._confidence_peers(metrics)
        assert score == 0


class TestConfidenceValuation:
    def test_all_anchors(self, pipeline):
        metrics = [
            _make_metric(name="pe_ratio", value=15.0, unit="multiple"),
            _make_metric(name="pb_ratio", value=2.0, unit="multiple"),
            _make_metric(name="free_cash_flow", value=50e12),
        ]
        score = pipeline._confidence_valuation(metrics)
        assert score == 15.0

    def test_no_anchors(self, pipeline):
        metrics = [_make_metric(name="revenue")]
        score = pipeline._confidence_valuation(metrics)
        assert score == 0


class TestConfidenceGrades:
    def test_high(self, pipeline):
        metrics = [_make_metric(name=f"m{i}", r2=0.9, years=10, peers=20) for i in range(20)]
        # Add valuation metrics
        metrics[0] = _make_metric(name="pe_ratio", value=15.0, r2=0.5, unit="multiple")
        metrics[1] = _make_metric(name="pb_ratio", value=2.0, r2=0.5, unit="multiple")
        metrics[2] = _make_metric(name="free_cash_flow", value=50e12, r2=0.9)
        total, grade, *_ = pipeline.compute_confidence(metrics)
        assert grade == "HIGH"
        assert total >= 70


# ---------------------------------------------------------------------------
# Composite
# ---------------------------------------------------------------------------

class TestComposite:
    def test_normal_blend(self, pipeline):
        result = pipeline.compute_composite(80.0, 60.0)
        assert result == 70.0  # 80*0.5 + 60*0.5

    def test_low_reliability_caps(self, pipeline):
        result = pipeline.compute_composite(30.0, 80.0)
        assert result <= 30.0  # capped because reliability < 40

    def test_zero_reliability(self, pipeline):
        result = pipeline.compute_composite(0.0, 50.0)
        assert result == 15.0  # min(30, 50*0.3)


# ---------------------------------------------------------------------------
# ready_for_ai gate
# ---------------------------------------------------------------------------

class TestReadyForAI:
    def test_passes_good_data(self, pipeline):
        flags = _make_flags(10)
        metrics = [_make_metric(name="revenue", value=100e12)]
        assert pipeline.check_ready_for_ai(80.0, 60.0, flags, metrics) is True

    def test_fails_low_reliability(self, pipeline):
        flags = _make_flags(10)
        metrics = [_make_metric(name="revenue", value=100e12)]
        assert pipeline.check_ready_for_ai(40.0, 60.0, flags, metrics) is False

    def test_fails_low_confidence(self, pipeline):
        flags = _make_flags(10)
        metrics = [_make_metric(name="revenue", value=100e12)]
        assert pipeline.check_ready_for_ai(80.0, 35.0, flags, metrics) is False

    def test_fails_few_clean_years(self, pipeline):
        flags = _make_flags(3)
        for yr in list(flags.keys())[:1]:
            flags[yr].usability_flag = "exclude"  # only 2 clean years
        metrics = [_make_metric(name="revenue", value=100e12)]
        assert pipeline.check_ready_for_ai(80.0, 60.0, flags, metrics) is False

    def test_fails_no_revenue(self, pipeline):
        flags = _make_flags(10)
        metrics = [_make_metric(name="net_income", value=50e12)]  # no revenue metric
        assert pipeline.check_ready_for_ai(80.0, 60.0, flags, metrics) is False

    def test_fails_too_many_anomalies(self, pipeline):
        flags = _make_flags(10, n_anomalies=4)  # 40% > 30% threshold
        metrics = [_make_metric(name="revenue", value=100e12)]
        assert pipeline.check_ready_for_ai(80.0, 60.0, flags, metrics) is False


# ---------------------------------------------------------------------------
# Signal detection
# ---------------------------------------------------------------------------

class TestSignals:
    def test_growth_acceleration_detected(self, pipeline):
        metrics = [NormalizedMetric(
            metric_name="revenue", unit="idr", latest_value=100e12,
            cagr_full=0.07, cagr_3yr=0.10,  # 3yr > full → accelerating
            trend_direction="strong_up",
        )]
        bullish, bearish, _ = pipeline.detect_signals(metrics)
        assert "revenue_growth_accelerating" in bullish

    def test_margin_decline_detected(self, pipeline):
        metrics = [NormalizedMetric(
            metric_name="net_margin", unit="percent", latest_value=10.0,
            trend_direction="strong_down",
        )]
        _, bearish, _ = pipeline.detect_signals(metrics)
        assert "net_margin_declining" in bearish

    def test_deleveraging_detected(self, pipeline):
        metrics = [NormalizedMetric(
            metric_name="debt_to_equity", unit="ratio", latest_value=0.5,
            trend_direction="strong_down",
        )]
        bullish, _, _ = pipeline.detect_signals(metrics)
        assert "deleveraging" in bullish


# ---------------------------------------------------------------------------
# Data gap detection
# ---------------------------------------------------------------------------

class TestDataGaps:
    def test_missing_metrics_flagged(self, pipeline):
        metrics = [
            _make_metric(name="revenue"),
            NormalizedMetric(metric_name="pe_ratio", unit="multiple"),  # None value
        ]
        gaps = pipeline.detect_data_gaps(metrics)
        assert any("missing_metrics" in g for g in gaps)

    def test_no_peers_flagged(self, pipeline):
        metrics = [_make_metric(name="revenue", peers=0)]
        gaps = pipeline.detect_data_gaps(metrics)
        assert any("no_sector_comparison" in g for g in gaps)


# ---------------------------------------------------------------------------
# Full pipeline integration
# ---------------------------------------------------------------------------

class TestFullPipeline:
    def test_bank_full_scoring(self, pipeline, cleaner, normalizer,
                                sample_financials_bank, sample_stock_bank):
        clean_rows, flags, _ = cleaner.clean_ticker(sample_financials_bank, sample_stock_bank)
        metrics = normalizer.normalize(clean_rows, flags, sample_stock_bank)
        score = pipeline.run(metrics, flags, clean_rows, sample_stock_bank)

        assert score.ticker == "TESTBANK"
        assert score.reliability_grade in ("A", "B")
        assert score.reliability_total > 70
        assert score.confidence_total > 0
        assert score.composite_score > 0
        assert isinstance(score.ready_for_ai, bool)
        assert score.primary_source == "stockbit"

    def test_cyclical_full_scoring(self, pipeline, cleaner, normalizer,
                                    sample_financials_cyclical, sample_stock_cyclical):
        clean_rows, flags, _ = cleaner.clean_ticker(sample_financials_cyclical, sample_stock_cyclical)
        metrics = normalizer.normalize(clean_rows, flags, sample_stock_cyclical)
        score = pipeline.run(metrics, flags, clean_rows, sample_stock_cyclical)

        assert score.ticker == "TESTCYCL"
        assert score.reliability_total > 0
        # Cyclical data typically has lower confidence (volatile trends → low R²)
        assert score.data_years_available > 0

    def test_minimal_data_not_ready(self, pipeline, normalizer, sample_stock_cyclical,
                                     sample_financials_minimal):
        """2 years of data should fail ready_for_ai."""
        metrics = normalizer.normalize(sample_financials_minimal, {}, sample_stock_cyclical)
        flags = {2024: YearFlag(year=2024), 2025: YearFlag(year=2025)}
        score = pipeline.run(metrics, flags, sample_financials_minimal, sample_stock_cyclical)
        assert score.ready_for_ai is False
