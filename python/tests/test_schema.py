"""Tests for pipeline dataclasses."""

import os
import sys
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from scripts.scoring.schema import (
    YearFlag,
    CleaningResult,
    NormalizedMetric,
    StockScore,
    ContextBundle,
    AIAnalysisResult,
)


class TestYearFlag:
    def test_defaults(self):
        f = YearFlag(year=2024)
        assert f.year == 2024
        assert f.usability_flag == "clean"
        assert f.is_covid_year is False
        assert f.notes == []

    def test_mutable_defaults_isolated(self):
        """Ensure mutable default fields don't share state across instances."""
        a = YearFlag(year=2020)
        b = YearFlag(year=2021)
        a.notes.append("test")
        assert len(b.notes) == 0


class TestCleaningResult:
    def test_creation(self):
        r = CleaningResult(ticker="BBCA", years_processed=10, years_excluded=1)
        assert r.ticker == "BBCA"
        assert r.overall_quality == "clean"
        assert r.ipo_excluded is False


class TestNormalizedMetric:
    def test_defaults(self):
        m = NormalizedMetric(metric_name="revenue", unit="idr")
        assert m.latest_value is None
        assert m.trend_direction == "insufficient_data"
        assert m.peer_count == 0
        assert m.data_years_count == 0

    def test_full_population(self):
        m = NormalizedMetric(
            metric_name="roe",
            unit="percent",
            latest_value=20.44,
            latest_year=2025,
            cagr_full=0.011,
            cagr_3yr=0.006,
            trend_direction="mild_up",
            trend_r2=0.52,
            data_years_count=10,
        )
        assert m.latest_value == 20.44
        assert m.trend_direction == "mild_up"


class TestStockScore:
    def test_defaults(self):
        s = StockScore(ticker="BBCA")
        assert s.reliability_total == 0
        assert s.reliability_grade == "F"
        assert s.confidence_grade == "VERY LOW"
        assert s.ready_for_ai is False
        assert s.bullish_signals == []

    def test_composite_computation_concept(self):
        """Verify the score can hold computed values."""
        s = StockScore(
            ticker="BBCA",
            reliability_total=85.0,
            reliability_grade="A",
            confidence_total=65.0,
            confidence_grade="MEDIUM",
            composite_score=75.0,
            ready_for_ai=True,
        )
        assert s.ready_for_ai is True
        assert s.composite_score == 75.0


class TestContextBundle:
    def test_defaults(self):
        b = ContextBundle(ticker="BBCA")
        assert b.context == {}
        assert b.token_estimate == 0
        assert b.context_version == "1.0"


class TestAIAnalysisResult:
    def test_defaults(self):
        r = AIAnalysisResult(ticker="BBCA")
        assert r.success is False
        assert r.error is None
        assert r.lynch_category is None
        assert r.prompt_tokens == 0
