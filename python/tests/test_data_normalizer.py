"""Tests for Stage 2: Data Normalizer — 20 metrics with trends and z-scores."""

import os
import sys
import pytest
import math

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from scripts.scoring.data_normalizer import (
    DataNormalizer,
    compute_cagr,
    compute_linear_trend,
    compute_volatility,
    compute_zscore_and_percentile,
)
from scripts.scoring.data_cleaner import DataCleaner


@pytest.fixture
def normalizer():
    return DataNormalizer()


@pytest.fixture
def cleaner():
    return DataCleaner()


# ---------------------------------------------------------------------------
# CAGR computation
# ---------------------------------------------------------------------------

class TestCAGR:
    def test_known_values(self):
        # 100 → 200 in 5 years = ~14.87% CAGR
        result = compute_cagr(100, 200, 5)
        assert result is not None
        assert abs(result - 0.148698) < 0.001

    def test_no_growth(self):
        result = compute_cagr(100, 100, 5)
        assert result == 0.0

    def test_negative_start_returns_none(self):
        assert compute_cagr(-100, 200, 5) is None

    def test_zero_years_returns_none(self):
        assert compute_cagr(100, 200, 0) is None

    def test_zero_start_returns_none(self):
        assert compute_cagr(0, 200, 5) is None


# ---------------------------------------------------------------------------
# Linear trend
# ---------------------------------------------------------------------------

class TestLinearTrend:
    def test_strong_up(self):
        values = [100, 120, 140, 160, 180, 200]  # perfect linear growth
        direction, r2, slope_pct = compute_linear_trend(values)
        assert direction == "strong_up"
        assert r2 is not None and r2 > 0.95

    def test_strong_down(self):
        values = [200, 170, 140, 110, 80, 50]
        direction, r2, _ = compute_linear_trend(values)
        assert direction == "strong_down"
        assert r2 is not None and r2 > 0.95

    def test_flat(self):
        # Small consistent increase: slope_pct ~0.5%/yr → within ±1% = flat, R² high
        values = [100, 100.5, 101, 101.5, 102, 102.5, 103]
        direction, r2, slope = compute_linear_trend(values)
        assert direction == "flat"
        assert r2 is not None and r2 > 0.9

    def test_volatile(self):
        values = [100, 200, 50, 180, 30, 150]  # wild swings
        direction, r2, _ = compute_linear_trend(values)
        assert direction == "volatile"
        assert r2 is not None and r2 < 0.3

    def test_insufficient_data(self):
        direction, r2, slope = compute_linear_trend([100, 200])
        assert direction == "insufficient_data"
        assert r2 is None
        assert slope is None

    def test_empty_returns_insufficient(self):
        direction, _, _ = compute_linear_trend([])
        assert direction == "insufficient_data"

    def test_constant_values_flat(self):
        direction, r2, _ = compute_linear_trend([100, 100, 100, 100])
        assert direction == "flat"
        assert r2 == 1.0


# ---------------------------------------------------------------------------
# Volatility
# ---------------------------------------------------------------------------

class TestVolatility:
    def test_stable_growth(self):
        year_vals = [(2020 + i, 100 * (1.10 ** i)) for i in range(5)]
        vol = compute_volatility(year_vals)
        assert vol is not None
        assert vol < 0.01  # very low volatility for consistent 10% growth

    def test_high_volatility(self):
        year_vals = [(2020, 100), (2021, 200), (2022, 50), (2023, 180), (2024, 30)]
        vol = compute_volatility(year_vals)
        assert vol is not None
        assert vol > 0.5  # high volatility

    def test_insufficient_data(self):
        assert compute_volatility([(2024, 100), (2025, 110)]) is None


# ---------------------------------------------------------------------------
# Z-score and percentile
# ---------------------------------------------------------------------------

class TestZScorePercentile:
    def test_above_mean(self):
        z, pct = compute_zscore_and_percentile(150, [50, 75, 100, 125])
        assert z is not None and z > 0
        assert pct is not None and pct == 100.0  # above all peers

    def test_below_mean(self):
        z, pct = compute_zscore_and_percentile(50, [75, 100, 125, 150])
        assert z is not None and z < 0
        assert pct is not None and pct == 0.0  # below all peers

    def test_at_mean(self):
        z, pct = compute_zscore_and_percentile(100, [80, 90, 100, 110, 120])
        assert z is not None
        assert abs(z) < 0.1  # near zero

    def test_insufficient_peers(self):
        z, pct = compute_zscore_and_percentile(100, [50])
        assert z is None
        assert pct is None

    def test_empty_peers(self):
        z, pct = compute_zscore_and_percentile(100, [])
        assert z is None
        assert pct is None

    def test_identical_peers(self):
        z, pct = compute_zscore_and_percentile(100, [100, 100, 100])
        assert z == 0.0
        assert pct == 50.0  # no one is below, convention


# ---------------------------------------------------------------------------
# Full normalization with peer comparison
# ---------------------------------------------------------------------------

class TestNormalizerWithPeers:
    def test_zscore_with_sufficient_peers(self, normalizer, cleaner, sample_financials_bank, sample_stock_bank):
        clean_rows, flags, _ = cleaner.clean_ticker(sample_financials_bank, sample_stock_bank)
        peer_metrics = {"revenue": [50e12, 60e12, 70e12, 80e12, 90e12, 100e12, 110e12, 120e12]}  # 8 peers
        metrics = normalizer.normalize(
            clean_rows, flags, sample_stock_bank,
            sector_peer_metrics=peer_metrics,
            sector_peer_count=8,
            peer_group_level="subsector",
        )
        rev = next(m for m in metrics if m.metric_name == "revenue")
        assert rev.z_score_vs_sector is not None
        assert rev.percentile_vs_sector is not None
        assert rev.peer_group_level == "subsector"
        assert rev.peer_count == 8

    def test_zscore_null_with_insufficient_peers(self, normalizer, cleaner, sample_financials_bank, sample_stock_bank):
        clean_rows, flags, _ = cleaner.clean_ticker(sample_financials_bank, sample_stock_bank)
        peer_metrics = {"revenue": [50e12, 60e12, 70e12]}  # only 3 peers
        metrics = normalizer.normalize(
            clean_rows, flags, sample_stock_bank,
            sector_peer_metrics=peer_metrics,
            sector_peer_count=3,
            peer_group_level="subsector",
        )
        rev = next(m for m in metrics if m.metric_name == "revenue")
        assert rev.z_score_vs_sector is None
        assert rev.percentile_vs_sector is None
        assert rev.peer_count == 0


# ---------------------------------------------------------------------------
# DPS and FCF/NI computed metrics
# ---------------------------------------------------------------------------

class TestComputedMetrics:
    def test_dps_computation(self, normalizer, cleaner, sample_financials_bank, sample_stock_bank):
        clean_rows, flags, _ = cleaner.clean_ticker(sample_financials_bank, sample_stock_bank)
        metrics = normalizer.normalize(clean_rows, flags, sample_stock_bank)
        dps = next(m for m in metrics if m.metric_name == "dps")
        # TESTBANK has dividends_paid and 123B listed_shares
        assert dps.latest_value is not None
        assert dps.latest_value > 0
        assert dps.data_years_count > 0

    def test_dps_null_when_no_dividends(self, normalizer, sample_stock_cyclical):
        """Stock with dividends_paid=None for all years → DPS is missing."""
        rows = [
            {"year": 2024, "quarter": 0, "revenue": 10e12, "net_income": 1e12,
             "total_assets": 20e12, "dividends_paid": None, "source": "stockbit"},
            {"year": 2025, "quarter": 0, "revenue": 11e12, "net_income": 1.1e12,
             "total_assets": 22e12, "dividends_paid": None, "source": "stockbit"},
        ]
        metrics = normalizer.normalize(rows, {}, sample_stock_cyclical)
        dps = next(m for m in metrics if m.metric_name == "dps")
        assert dps.latest_value is None

    def test_fcf_to_ni_positive(self, normalizer, cleaner, sample_financials_bank, sample_stock_bank):
        clean_rows, flags, _ = cleaner.clean_ticker(sample_financials_bank, sample_stock_bank)
        metrics = normalizer.normalize(clean_rows, flags, sample_stock_bank)
        fcf_ni = next(m for m in metrics if m.metric_name == "fcf_to_net_income")
        assert fcf_ni.latest_value is not None
        assert fcf_ni.latest_value > 0  # bank FCF > NI in our fixture

    def test_fcf_to_ni_null_when_ni_negative(self, normalizer, sample_stock_cyclical):
        rows = [
            {"year": 2024, "quarter": 0, "revenue": 10e12,
             "net_income": -1e12, "free_cash_flow": 500e9,
             "total_assets": 20e12, "source": "stockbit"},
        ]
        metrics = normalizer.normalize(rows, {}, sample_stock_cyclical)
        fcf_ni = next(m for m in metrics if m.metric_name == "fcf_to_net_income")
        assert fcf_ni.latest_value is None


# ---------------------------------------------------------------------------
# TTM handling
# ---------------------------------------------------------------------------

class TestTTMHandling:
    def test_ttm_excluded_from_trend(self, normalizer, cleaner, sample_financials_bank, sample_stock_bank):
        clean_rows, flags, _ = cleaner.clean_ticker(sample_financials_bank, sample_stock_bank)
        metrics = normalizer.normalize(clean_rows, flags, sample_stock_bank)
        rev = next(m for m in metrics if m.metric_name == "revenue")
        # 2026 is TTM — should not be in the trend values
        assert 2026 not in rev.years

    def test_ttm_used_for_valuation_latest(self, normalizer, cleaner, sample_financials_bank, sample_stock_bank):
        clean_rows, flags, _ = cleaner.clean_ticker(sample_financials_bank, sample_stock_bank)
        metrics = normalizer.normalize(clean_rows, flags, sample_stock_bank)
        pe = next(m for m in metrics if m.metric_name == "pe_ratio")
        # PE should use TTM (2026) as latest_value since it's a valuation metric
        if pe.latest_value is not None:
            assert pe.latest_year == 2026


# ---------------------------------------------------------------------------
# Anomaly year exclusion
# ---------------------------------------------------------------------------

class TestAnomalyExclusion:
    def test_anomaly_years_tracked(self, normalizer, cleaner, sample_financials_bank, sample_stock_bank):
        clean_rows, flags, _ = cleaner.clean_ticker(sample_financials_bank, sample_stock_bank)
        metrics = normalizer.normalize(clean_rows, flags, sample_stock_bank)
        rev = next(m for m in metrics if m.metric_name == "revenue")
        # 2020 (COVID) should be in anomaly_years
        assert 2020 in rev.anomaly_years


# ---------------------------------------------------------------------------
# All 20 metrics mapped
# ---------------------------------------------------------------------------

class TestAllMetrics:
    def test_produces_20_metrics(self, normalizer, cleaner, sample_financials_bank, sample_stock_bank):
        clean_rows, flags, _ = cleaner.clean_ticker(sample_financials_bank, sample_stock_bank)
        metrics = normalizer.normalize(clean_rows, flags, sample_stock_bank)
        assert len(metrics) == 20

    def test_metric_names_match_config(self, normalizer, cleaner, sample_financials_bank, sample_stock_bank):
        from scripts.scoring.config import METRIC_MAP
        clean_rows, flags, _ = cleaner.clean_ticker(sample_financials_bank, sample_stock_bank)
        metrics = normalizer.normalize(clean_rows, flags, sample_stock_bank)
        output_names = {m.metric_name for m in metrics}
        expected_names = set(METRIC_MAP.keys())
        assert output_names == expected_names

    def test_bank_has_null_banking_metrics(self, normalizer, cleaner, sample_financials_bank, sample_stock_bank):
        """Banking D/E, current_ratio, interest_coverage should be NULL (cleaned by Stage 1)."""
        clean_rows, flags, _ = cleaner.clean_ticker(sample_financials_bank, sample_stock_bank)
        metrics = normalizer.normalize(clean_rows, flags, sample_stock_bank)
        de = next(m for m in metrics if m.metric_name == "debt_to_equity")
        cr = next(m for m in metrics if m.metric_name == "current_ratio")
        ic = next(m for m in metrics if m.metric_name == "interest_coverage")
        # All should have no data (banking zero-override made them NULL)
        assert de.latest_value is None
        assert cr.latest_value is None
        assert ic.latest_value is None

    def test_cyclical_has_real_de(self, normalizer, cleaner, sample_financials_cyclical, sample_stock_cyclical):
        """Non-bank should have real D/E values."""
        clean_rows, flags, _ = cleaner.clean_ticker(sample_financials_cyclical, sample_stock_cyclical)
        metrics = normalizer.normalize(clean_rows, flags, sample_stock_cyclical)
        de = next(m for m in metrics if m.metric_name == "debt_to_equity")
        assert de.latest_value is not None
        assert de.latest_value > 0
