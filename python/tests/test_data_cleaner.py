"""Tests for Stage 1: Data Cleaner — 13 cleaning rules."""

import os
import sys
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from scripts.scoring.data_cleaner import DataCleaner


@pytest.fixture
def cleaner():
    return DataCleaner()


# ---------------------------------------------------------------------------
# Rule 1: COVID year
# ---------------------------------------------------------------------------

class TestCovidFlag:
    def test_year_2020_flagged(self, cleaner, sample_financials_bank, sample_stock_bank):
        _, flags, _ = cleaner.clean_ticker(sample_financials_bank, sample_stock_bank)
        assert 2020 in flags
        assert flags[2020].is_covid_year is True
        assert flags[2020].has_one_time_items is True
        assert flags[2020].usability_flag == "minor_issues"

    def test_non_2020_not_flagged(self, cleaner, sample_financials_bank, sample_stock_bank):
        _, flags, _ = cleaner.clean_ticker(sample_financials_bank, sample_stock_bank)
        assert flags[2021].is_covid_year is False


# ---------------------------------------------------------------------------
# Rule 10: IPO partial year exclusion
# ---------------------------------------------------------------------------

class TestIPOExclusion:
    def test_ipo_year_excluded(self, cleaner, sample_stock_ipo):
        """Stock listed 2023-06-15: year 2023 should be excluded."""
        financials = [
            {"ticker": "TESTIPO", "year": 2023, "quarter": 0,
             "revenue": 100e9, "net_income": 10e9, "total_assets": 500e9, "source": "yfinance"},
            {"ticker": "TESTIPO", "year": 2024, "quarter": 0,
             "revenue": 200e9, "net_income": 20e9, "total_assets": 600e9, "source": "yfinance"},
            {"ticker": "TESTIPO", "year": 2025, "quarter": 0,
             "revenue": 250e9, "net_income": 30e9, "total_assets": 700e9, "source": "yfinance"},
        ]
        clean_rows, flags, result = cleaner.clean_ticker(financials, sample_stock_ipo)
        assert flags[2023].is_ipo_year is True
        assert flags[2023].usability_flag == "exclude"
        assert result.ipo_excluded is True
        assert len(clean_rows) == 2  # 2024, 2025 only

    def test_non_ipo_not_excluded(self, cleaner, sample_financials_bank, sample_stock_bank):
        """TESTBANK listed 2000: no IPO year in 2016-2026 range."""
        _, flags, result = cleaner.clean_ticker(sample_financials_bank, sample_stock_bank)
        assert result.ipo_excluded is False
        assert not any(f.is_ipo_year for f in flags.values())


# ---------------------------------------------------------------------------
# Rule 4: Scale detection
# ---------------------------------------------------------------------------

class TestScaleDetection:
    def test_revenue_below_1b_flagged(self, cleaner, sample_stock_cyclical):
        financials = [
            {"ticker": "TESTCYCL", "year": 2024, "quarter": 0,
             "revenue": 500_000_000, "net_income": 50_000_000, "total_assets": 2e12, "source": "stockbit"},
        ]
        _, flags, _ = cleaner.clean_ticker(financials, sample_stock_cyclical)
        assert flags[2024].scale_warning is True
        assert flags[2024].usability_flag == "use_with_caution"

    def test_revenue_above_1b_ok(self, cleaner, sample_stock_cyclical):
        financials = [
            {"ticker": "TESTCYCL", "year": 2024, "quarter": 0,
             "revenue": 5_000_000_000_000, "net_income": 500e9, "total_assets": 20e12, "source": "stockbit"},
        ]
        _, flags, _ = cleaner.clean_ticker(financials, sample_stock_cyclical)
        assert flags[2024].scale_warning is False


# ---------------------------------------------------------------------------
# Rule 11: Banking zero-override
# ---------------------------------------------------------------------------

class TestBankingZeroOverride:
    def test_bank_de_zero_becomes_null(self, cleaner, sample_financials_bank, sample_stock_bank):
        clean_rows, flags, _ = cleaner.clean_ticker(sample_financials_bank, sample_stock_bank)
        # All clean rows should have D/E = None (was 0.0)
        for row in clean_rows:
            assert row.get("debt_to_equity") is None
            assert row.get("current_ratio") is None
            assert row.get("interest_coverage") is None

    def test_non_bank_de_zero_preserved(self, cleaner, sample_stock_cyclical):
        """Non-bank with D/E=0 should keep the value."""
        financials = [
            {"ticker": "TESTCYCL", "year": 2024, "quarter": 0,
             "revenue": 10e12, "net_income": 1e12, "total_assets": 20e12,
             "debt_to_equity": 0.0, "current_ratio": 0.0, "source": "stockbit"},
        ]
        clean_rows, _, _ = cleaner.clean_ticker(financials, sample_stock_cyclical)
        assert clean_rows[0]["debt_to_equity"] == 0.0
        assert clean_rows[0]["current_ratio"] == 0.0


# ---------------------------------------------------------------------------
# Rule 12: TTM/keystats handling
# ---------------------------------------------------------------------------

class TestTTMHandling:
    def test_keystats_current_year_flagged(self, cleaner, sample_financials_bank, sample_stock_bank):
        _, flags, _ = cleaner.clean_ticker(sample_financials_bank, sample_stock_bank)
        # 2026 row has source=stockbit_keystats
        assert 2026 in flags
        assert flags[2026].usability_flag == "use_with_caution"
        assert any("ttm_estimate" in n for n in flags[2026].notes)

    def test_non_keystats_not_flagged(self, cleaner, sample_financials_bank, sample_stock_bank):
        _, flags, _ = cleaner.clean_ticker(sample_financials_bank, sample_stock_bank)
        assert flags[2025].usability_flag != "use_with_caution" or flags[2025].is_covid_year


# ---------------------------------------------------------------------------
# Rule 5/6: IQR anomaly detection
# ---------------------------------------------------------------------------

class TestIQRAnomaly:
    def test_income_anomaly_detected(self, cleaner, sample_stock_cyclical):
        """Variable growth with one extreme spike should trigger IQR anomaly."""
        # Varying growth rates so IQR is non-zero, then one extreme spike
        ni_pattern = [
            1.0e12, 1.15e12, 1.05e12, 1.25e12, 0.9e12,   # 2016-2020: varied
            1.1e12, 1.3e12, 15e12,    1.2e12, 1.35e12,    # 2021-2025: spike at 2023
        ]
        financials = []
        for i, year in enumerate(range(2016, 2026)):
            ni = int(ni_pattern[i])
            financials.append({
                "ticker": "TESTCYCL", "year": year, "quarter": 0,
                "revenue": ni * 2, "net_income": ni, "total_assets": ni * 5,
                "operating_income": int(ni * 1.2), "source": "stockbit",
            })
        _, flags, _ = cleaner.clean_ticker(financials, sample_stock_cyclical)
        anomaly_years = [yr for yr, f in flags.items() if f.has_anomaly and "net_income" in f.anomaly_metrics]
        assert len(anomaly_years) > 0, f"Expected anomaly. YoY changes produced IQR=0?"

    def test_stable_data_no_anomaly(self, cleaner, sample_stock_cyclical):
        """Steady 10% growth should not trigger anomaly."""
        financials = []
        base = 1e12
        for i, year in enumerate(range(2016, 2026)):
            base = int(base * 1.10)
            financials.append({
                "ticker": "TESTCYCL", "year": year, "quarter": 0,
                "revenue": base * 2, "net_income": base, "total_assets": base * 5,
                "operating_income": int(base * 1.2), "source": "stockbit",
            })
        _, flags, _ = cleaner.clean_ticker(financials, sample_stock_cyclical)
        anomaly_years = [yr for yr, f in flags.items() if f.has_anomaly]
        assert len(anomaly_years) == 0


# ---------------------------------------------------------------------------
# Rule 9: One-time items
# ---------------------------------------------------------------------------

class TestOneTimeItems:
    def test_banking_exempt(self, cleaner, sample_financials_bank, sample_stock_bank):
        """Banks should NOT be flagged for NI/OI divergence."""
        _, flags, _ = cleaner.clean_ticker(sample_financials_bank, sample_stock_bank)
        for yr, f in flags.items():
            if yr != 2020:  # COVID always gets one_time
                # Check no NI/OI-based one_time flag
                oi_notes = [n for n in f.notes if "one_time" in n and "NI/OI" in n]
                assert len(oi_notes) == 0, f"Bank year {yr} should not have NI/OI flag"

    def test_non_bank_flagged(self, cleaner, sample_stock_cyclical):
        """Non-bank with NI/OI ratio > 1.4 should be flagged."""
        financials = [
            {"ticker": "TESTCYCL", "year": 2024, "quarter": 0,
             "revenue": 10e12, "net_income": 5e12, "operating_income": 2e12,
             "total_assets": 20e12, "source": "stockbit"},
        ]
        _, flags, _ = cleaner.clean_ticker(financials, sample_stock_cyclical)
        assert flags[2024].has_one_time_items is True


# ---------------------------------------------------------------------------
# Rule 8: Missing critical fields
# ---------------------------------------------------------------------------

class TestMissingCriticalFields:
    def test_all_null_excluded(self, cleaner, sample_stock_cyclical):
        financials = [
            {"ticker": "TESTCYCL", "year": 2024, "quarter": 0,
             "revenue": None, "net_income": None, "total_assets": None, "source": "stockbit"},
        ]
        clean_rows, flags, _ = cleaner.clean_ticker(financials, sample_stock_cyclical)
        assert flags[2024].usability_flag == "exclude"
        assert len(clean_rows) == 0


# ---------------------------------------------------------------------------
# Rule 7: Negative equity
# ---------------------------------------------------------------------------

class TestNegativeEquity:
    def test_negative_equity_flagged(self, cleaner, sample_stock_cyclical):
        financials = [
            {"ticker": "TESTCYCL", "year": 2024, "quarter": 0,
             "revenue": 10e12, "net_income": -1e12, "total_assets": 20e12,
             "total_equity": -5e12, "source": "stockbit"},
        ]
        _, flags, _ = cleaner.clean_ticker(financials, sample_stock_cyclical)
        assert flags[2024].usability_flag == "use_with_caution"
        assert any("negative_equity" in n for n in flags[2024].notes)


# ---------------------------------------------------------------------------
# get_clean_financials helper
# ---------------------------------------------------------------------------

class TestGetCleanFinancials:
    def test_excludes_flagged_rows(self, cleaner, sample_stock_ipo):
        financials = [
            {"ticker": "TESTIPO", "year": 2023, "quarter": 0,
             "revenue": 100e9, "net_income": 10e9, "total_assets": 500e9, "source": "yfinance"},
            {"ticker": "TESTIPO", "year": 2024, "quarter": 0,
             "revenue": 200e9, "net_income": 20e9, "total_assets": 600e9, "source": "yfinance"},
        ]
        clean = cleaner.get_clean_financials(financials, sample_stock_ipo)
        years = [r["year"] for r in clean]
        assert 2023 not in years  # IPO year excluded
        assert 2024 in years


# ---------------------------------------------------------------------------
# Full cleaning on realistic data
# ---------------------------------------------------------------------------

class TestFullCleaning:
    def test_bank_10_years(self, cleaner, sample_financials_bank, sample_stock_bank):
        """10-year bank data: COVID flagged, banking overrides applied, TTM flagged."""
        clean_rows, flags, result = cleaner.clean_ticker(sample_financials_bank, sample_stock_bank)
        assert result.years_processed == 11  # 2016-2026
        assert result.years_excluded == 0     # no IPO in range
        assert flags[2020].is_covid_year is True
        # Banking overrides applied
        for row in clean_rows:
            assert row.get("debt_to_equity") is None
        # TTM flagged
        assert flags[2026].usability_flag == "use_with_caution"

    def test_cyclical_10_years(self, cleaner, sample_financials_cyclical, sample_stock_cyclical):
        """Cyclical commodity data: volatile earnings, one-time items detected."""
        clean_rows, flags, result = cleaner.clean_ticker(
            sample_financials_cyclical, sample_stock_cyclical
        )
        assert result.years_processed == 11
        assert flags[2020].is_covid_year is True
        # D/E should be preserved (not a bank)
        non_ttm = [r for r in clean_rows if r["year"] < 2026]
        assert any(r.get("debt_to_equity") is not None and r["debt_to_equity"] > 0 for r in non_ttm)
