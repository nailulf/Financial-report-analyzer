"""Tests for Stage 4: Context Builder — 8-block JSON bundle assembly."""

import os
import sys
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from scripts.scoring.context_builder import (
    ContextBuilder,
    compute_health_score,
    compute_graham_number,
    compute_dcf_scenarios,
    detect_smart_money_phase,
)
from scripts.scoring.data_cleaner import DataCleaner
from scripts.scoring.data_normalizer import DataNormalizer
from scripts.scoring.scoring_engine import ScoringPipeline


@pytest.fixture
def builder():
    return ContextBuilder()

@pytest.fixture
def cleaner():
    return DataCleaner()

@pytest.fixture
def normalizer():
    return DataNormalizer()

@pytest.fixture
def pipeline():
    return ScoringPipeline()


# ---------------------------------------------------------------------------
# Health score (port of health-score.ts)
# ---------------------------------------------------------------------------

class TestHealthScore:
    def test_all_green(self):
        annual = {"roe": 20, "net_margin": 15, "gross_margin": 40, "roa": 10,
                  "current_ratio": 2.0, "debt_to_equity": 0.5, "free_cash_flow": 1e12}
        result = compute_health_score(annual)
        assert result["grade"] == "Sehat"
        assert result["total"] >= 80
        for k, v in result["components"].items():
            if v.get("flag"):
                assert v["flag"] == "green"

    def test_all_red(self):
        annual = {"roe": 2, "net_margin": 1, "gross_margin": 5, "roa": 1,
                  "current_ratio": 0.5, "debt_to_equity": 5.0, "free_cash_flow": -1e12}
        result = compute_health_score(annual)
        assert result["grade"] == "Tidak Sehat"
        assert result["total"] < 40

    def test_banking_exemptions(self):
        annual = {"roe": 20, "net_margin": 40, "gross_margin": 80, "roa": 3,
                  "current_ratio": None, "debt_to_equity": None, "free_cash_flow": 50e12}
        result = compute_health_score(annual, is_bank=True)
        assert result["components"]["current_ratio"].get("exempt") is True

    def test_null_values_na(self):
        annual = {}
        result = compute_health_score(annual)
        for v in result["components"].values():
            assert v["flag"] == "na" or v.get("exempt")


# ---------------------------------------------------------------------------
# Graham number (port of valuation.ts)
# ---------------------------------------------------------------------------

class TestGrahamNumber:
    def test_known_values(self):
        # sqrt(22.5 * 100 * 500) = sqrt(1,125,000) ≈ 1060.66
        result = compute_graham_number(100, 500)
        assert result is not None
        assert abs(result - 1060.66) < 1

    def test_negative_eps_returns_none(self):
        assert compute_graham_number(-10, 500) is None

    def test_zero_bvps_returns_none(self):
        assert compute_graham_number(100, 0) is None

    def test_null_returns_none(self):
        assert compute_graham_number(None, 500) is None


# ---------------------------------------------------------------------------
# DCF scenarios (port of valuation.ts)
# ---------------------------------------------------------------------------

class TestDCFScenarios:
    def test_bear_less_than_base_less_than_bull(self):
        result = compute_dcf_scenarios(1e12, 10_000_000_000, 10.0, 5000)
        assert result["dcf_bear"] is not None
        assert result["dcf_base"] is not None
        assert result["dcf_bull"] is not None
        assert result["dcf_bear"] < result["dcf_base"] < result["dcf_bull"]

    def test_negative_fcf_returns_none(self):
        result = compute_dcf_scenarios(-1e12, 10_000_000_000, 10.0)
        assert result["dcf_bear"] is None
        assert result["dcf_base"] is None
        assert result["dcf_bull"] is None

    def test_mos_computed_with_price(self):
        result = compute_dcf_scenarios(1e12, 10_000_000_000, 10.0, 5000)
        assert result["dcf_base_mos"] is not None

    def test_mos_none_without_price(self):
        result = compute_dcf_scenarios(1e12, 10_000_000_000, 10.0)
        assert result["dcf_base_mos"] is None


# ---------------------------------------------------------------------------
# Smart money phase detection
# ---------------------------------------------------------------------------

class TestSmartMoneyPhase:
    def test_akumulasi(self):
        assert detect_smart_money_phase(1e12, 0.5e12, 0.1e12) == "akumulasi"

    def test_distribusi(self):
        assert detect_smart_money_phase(-1e12, -0.5e12, 0.1e12) == "distribusi"

    def test_netral_mixed(self):
        assert detect_smart_money_phase(-1e12, 2e12, 0) == "netral"

    def test_netral_zero(self):
        assert detect_smart_money_phase(0, 0, 0) == "netral"


# ---------------------------------------------------------------------------
# Full context bundle
# ---------------------------------------------------------------------------

class TestFullBundle:
    def _build_bundle(self, builder, cleaner, normalizer, pipeline,
                      financials, stock, price=None, domain_notes=None):
        clean_rows, flags, _ = cleaner.clean_ticker(financials, stock)
        metrics = normalizer.normalize(clean_rows, flags, stock)
        score = pipeline.run(metrics, flags, clean_rows, stock)
        return builder.build(
            ticker=stock["ticker"],
            stock=stock,
            metrics=metrics,
            score=score,
            flags=flags,
            clean_rows=clean_rows,
            latest_price=price or {"close": 6700, "date": "2026-03-27"},
            domain_notes=domain_notes,
        )

    def test_has_all_8_blocks(self, builder, cleaner, normalizer, pipeline,
                               sample_financials_bank, sample_stock_bank):
        bundle = self._build_bundle(builder, cleaner, normalizer, pipeline,
                                     sample_financials_bank, sample_stock_bank)
        ctx = bundle.context
        for block in ["data_quality", "fundamentals", "valuation", "smart_money",
                      "shareholders", "health_score", "sector_context", "macro_context"]:
            assert block in ctx, f"Missing block: {block}"

    def test_has_top_level_fields(self, builder, cleaner, normalizer, pipeline,
                                   sample_financials_bank, sample_stock_bank):
        bundle = self._build_bundle(builder, cleaner, normalizer, pipeline,
                                     sample_financials_bank, sample_stock_bank)
        ctx = bundle.context
        assert ctx["ticker"] == "TESTBANK"
        assert ctx["sector"] == "Financials"
        assert "generated_at" in ctx

    def test_fundamentals_has_20_metrics(self, builder, cleaner, normalizer, pipeline,
                                          sample_financials_bank, sample_stock_bank):
        bundle = self._build_bundle(builder, cleaner, normalizer, pipeline,
                                     sample_financials_bank, sample_stock_bank)
        metrics = bundle.context["fundamentals"]["metrics"]
        assert len(metrics) == 20

    def test_fundamentals_key_signals(self, builder, cleaner, normalizer, pipeline,
                                       sample_financials_bank, sample_stock_bank):
        bundle = self._build_bundle(builder, cleaner, normalizer, pipeline,
                                     sample_financials_bank, sample_stock_bank)
        signals = bundle.context["fundamentals"]["key_signals"]
        assert isinstance(signals, dict)
        assert "revenue_growth_acceleration" in signals

    def test_valuation_graham(self, builder, cleaner, normalizer, pipeline,
                               sample_financials_bank, sample_stock_bank):
        bundle = self._build_bundle(builder, cleaner, normalizer, pipeline,
                                     sample_financials_bank, sample_stock_bank)
        val = bundle.context["valuation"]
        assert val["current_price"] == 6700
        # Graham should be computed (bank has positive EPS and BVPS)
        assert val["graham_number"] is not None

    def test_health_score_banking(self, builder, cleaner, normalizer, pipeline,
                                   sample_financials_bank, sample_stock_bank):
        bundle = self._build_bundle(builder, cleaner, normalizer, pipeline,
                                     sample_financials_bank, sample_stock_bank)
        health = bundle.context["health_score"]
        assert health["grade"] in ("Sehat", "Cukup Sehat", "Perlu Perhatian", "Tidak Sehat")
        assert health["components"]["current_ratio"].get("exempt") is True

    def test_smart_money_defaults(self, builder, cleaner, normalizer, pipeline,
                                   sample_financials_bank, sample_stock_bank):
        bundle = self._build_bundle(builder, cleaner, normalizer, pipeline,
                                     sample_financials_bank, sample_stock_bank)
        sm = bundle.context["smart_money"]
        assert sm["window_days"] == 30
        assert sm["phase"] in ("akumulasi", "distribusi", "netral")

    def test_macro_context_loaded(self, builder, cleaner, normalizer, pipeline,
                                   sample_financials_bank, sample_stock_bank):
        bundle = self._build_bundle(builder, cleaner, normalizer, pipeline,
                                     sample_financials_bank, sample_stock_bank)
        macro = bundle.context["macro_context"]
        assert "bi_rate" in macro

    def test_domain_notes_injected(self, builder, cleaner, normalizer, pipeline,
                                    sample_financials_bank, sample_stock_bank):
        bundle = self._build_bundle(builder, cleaner, normalizer, pipeline,
                                     sample_financials_bank, sample_stock_bank,
                                     domain_notes="Premium CASA franchise bank.")
        assert bundle.context.get("domain_notes") == "Premium CASA franchise bank."

    def test_domain_notes_absent(self, builder, cleaner, normalizer, pipeline,
                                  sample_financials_bank, sample_stock_bank):
        bundle = self._build_bundle(builder, cleaner, normalizer, pipeline,
                                     sample_financials_bank, sample_stock_bank)
        assert "domain_notes" not in bundle.context

    def test_token_estimate_reasonable(self, builder, cleaner, normalizer, pipeline,
                                       sample_financials_bank, sample_stock_bank):
        bundle = self._build_bundle(builder, cleaner, normalizer, pipeline,
                                     sample_financials_bank, sample_stock_bank)
        assert bundle.token_estimate > 500
        assert bundle.token_estimate < 10000

    def test_idr_values_have_display(self, builder, cleaner, normalizer, pipeline,
                                     sample_financials_bank, sample_stock_bank):
        bundle = self._build_bundle(builder, cleaner, normalizer, pipeline,
                                     sample_financials_bank, sample_stock_bank)
        rev = bundle.context["fundamentals"]["metrics"]["revenue"]
        assert "value_display" in rev
        assert "Rp Billion" in rev["value_display"]

    def test_data_quality_block(self, builder, cleaner, normalizer, pipeline,
                                 sample_financials_bank, sample_stock_bank):
        bundle = self._build_bundle(builder, cleaner, normalizer, pipeline,
                                     sample_financials_bank, sample_stock_bank)
        dq = bundle.context["data_quality"]
        assert dq["reliability_grade"] in ("A", "B", "C", "D", "F")
        assert isinstance(dq["ready_for_ai"], bool)
        assert dq["banking_exemptions_applied"] is True

    def test_shareholders_capped_at_5(self, builder, cleaner, normalizer, pipeline,
                                       sample_financials_bank, sample_stock_bank):
        holders = [{"holder_name": f"Holder {i}", "percentage": 10 - i, "holder_type": "institution"}
                   for i in range(10)]
        clean_rows, flags, _ = cleaner.clean_ticker(sample_financials_bank, sample_stock_bank)
        metrics = normalizer.normalize(clean_rows, flags, sample_stock_bank)
        score = pipeline.run(metrics, flags, clean_rows, sample_stock_bank)
        bundle = builder.build(
            ticker="TESTBANK", stock=sample_stock_bank, metrics=metrics,
            score=score, flags=flags, clean_rows=clean_rows,
            latest_price={"close": 6700, "date": "2026-03-27"},
            shareholders=holders,
        )
        assert len(bundle.context["shareholders"]["top_holders"]) == 5

    def test_cyclical_bundle(self, builder, cleaner, normalizer, pipeline,
                              sample_financials_cyclical, sample_stock_cyclical):
        bundle = self._build_bundle(builder, cleaner, normalizer, pipeline,
                                     sample_financials_cyclical, sample_stock_cyclical,
                                     price={"close": 3100, "date": "2026-03-27"})
        ctx = bundle.context
        assert ctx["sector"] == "Energy"
        assert ctx["health_score"]["components"]["current_ratio"].get("exempt") is not True
