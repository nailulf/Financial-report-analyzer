"""Tests for Stage 5: AI Analyst — validation, prompt construction, provider abstraction."""

import os
import sys
import json
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from scripts.scoring.ai_analyst import (
    validate_output,
    build_user_prompt,
    get_provider,
    SYSTEM_PROMPT,
    VALID_LYNCH,
    VALID_VERDICT,
)


# ---------------------------------------------------------------------------
# Valid output fixture
# ---------------------------------------------------------------------------

@pytest.fixture
def valid_output():
    return {
        "lynch_category": "stalwart",
        "lynch_rationale": "Steady 10% growth with strong margins.",
        "buffett_moat": "wide",
        "buffett_moat_source": "CASA franchise and switching costs.",
        "business_narrative": "A premium bank compounding at 10-12% with durable advantages.",
        "financial_health_signal": "stable",
        "bull_case": {
            "scenario": "Rate cuts expand NIM, foreign flows reverse.",
            "drivers": ["BI rate cuts", "Foreign reversal", "Credit growth"],
            "price_target": 8000,
            "timeframe": "12-18 months",
            "probability": "medium",
            "early_signs": ["NIM expanding QoQ", "Foreign inflows 3+ months"],
        },
        "bear_case": {
            "scenario": "IDR weakens, NPLs spike from commodity downturn.",
            "drivers": ["IDR crisis", "NPL cycle", "Political lending"],
            "price_target": 4000,
            "timeframe": "12-18 months",
            "probability": "low",
            "early_signs": ["NPL above 2.5%", "IDR above 17,000"],
        },
        "neutral_case": {
            "scenario": "Modest rate cuts, 8-10% earnings growth, range-bound.",
            "drivers": ["Moderate credit growth", "Stable asset quality"],
            "price_range_low": 5000,
            "price_range_high": 6500,
            "timeframe": "12 months",
            "probability": "high",
            "what_breaks_it": ["NIM expansion + foreign reversal", "NPL spike or IDR crisis"],
        },
        "strategy_fit": {
            "primary": "dividend_income",
            "ideal_investor": "Income-oriented, 3-5 year horizon.",
            "position_sizing": "full_position",
        },
        "what_to_watch": ["NIM trend: expansion above 5.5%", "NPL ratio below 1.8%", "Foreign flow direction"],
        "analyst_verdict": "buy",
        "confidence_level": 7,
        "data_gaps_acknowledged": ["No NIM/CASA data in bundle"],
        "caveats": ["BUMN governance risk remains structural"],
    }


# ---------------------------------------------------------------------------
# Validation: structural checks
# ---------------------------------------------------------------------------

class TestValidationStructural:
    def test_valid_output_passes(self, valid_output):
        errors = validate_output(valid_output, current_price=6000)
        assert len(errors) == 0

    def test_missing_lynch_category(self, valid_output):
        del valid_output["lynch_category"]
        errors = validate_output(valid_output)
        assert any("missing_field" in e for e in errors)

    def test_missing_analyst_verdict(self, valid_output):
        del valid_output["analyst_verdict"]
        errors = validate_output(valid_output)
        assert any("missing_field" in e for e in errors)

    def test_invalid_lynch_category(self, valid_output):
        valid_output["lynch_category"] = "growth_monster"
        errors = validate_output(valid_output)
        assert any("invalid_lynch_category" in e for e in errors)

    def test_invalid_verdict(self, valid_output):
        valid_output["analyst_verdict"] = "super_buy"
        errors = validate_output(valid_output)
        assert any("invalid_analyst_verdict" in e for e in errors)

    def test_invalid_health_signal(self, valid_output):
        valid_output["financial_health_signal"] = "declining"
        errors = validate_output(valid_output)
        assert any("invalid_health_signal" in e for e in errors)

    def test_confidence_normalized_from_percentage(self, valid_output):
        """45.98 (0-100 scale) should be normalized to 5 (1-10 scale)."""
        valid_output["confidence_level"] = 45.98
        errors = validate_output(valid_output)
        assert len([e for e in errors if "confidence" in e]) == 0
        assert valid_output["confidence_level"] == 5  # 45.98/10 → 5

    def test_confidence_normalized_from_decimal(self, valid_output):
        """0.7 (0-1 scale) should be normalized to 7."""
        valid_output["confidence_level"] = 0.7
        errors = validate_output(valid_output)
        assert len([e for e in errors if "confidence" in e]) == 0
        assert valid_output["confidence_level"] == 7

    def test_confidence_clamped_to_max_10(self, valid_output):
        """150 should be clamped to 10."""
        valid_output["confidence_level"] = 150
        errors = validate_output(valid_output)
        assert len([e for e in errors if "confidence" in e]) == 0
        assert valid_output["confidence_level"] == 10

    def test_confidence_string_fails(self, valid_output):
        valid_output["confidence_level"] = "high"
        errors = validate_output(valid_output)
        assert any("confidence_level_out_of_range" in e for e in errors)


# ---------------------------------------------------------------------------
# Validation: scenario consistency
# ---------------------------------------------------------------------------

class TestValidationScenarios:
    def test_bull_less_than_bear_fails(self, valid_output):
        valid_output["bull_case"]["price_target"] = 3000
        valid_output["bear_case"]["price_target"] = 5000
        errors = validate_output(valid_output, current_price=6000)
        assert any("scenario_ordering" in e for e in errors)

    def test_neutral_range_inverted_fails(self, valid_output):
        valid_output["neutral_case"]["price_range_low"] = 7000
        valid_output["neutral_case"]["price_range_high"] = 5000
        errors = validate_output(valid_output)
        assert any("neutral_range_inverted" in e for e in errors)

    def test_price_too_high_fails(self, valid_output):
        valid_output["bull_case"]["price_target"] = 100000  # 16x current
        errors = validate_output(valid_output, current_price=6000)
        assert any("unrealistic" in e for e in errors)

    def test_price_too_low_fails(self, valid_output):
        valid_output["bear_case"]["price_target"] = 10  # <1% of current
        errors = validate_output(valid_output, current_price=6000)
        assert any("unrealistic" in e for e in errors)


# ---------------------------------------------------------------------------
# Validation: data quality alignment
# ---------------------------------------------------------------------------

class TestValidationDataQuality:
    def test_gaps_not_acknowledged(self, valid_output):
        valid_output["data_gaps_acknowledged"] = []
        errors = validate_output(valid_output, data_gap_flags=["missing: NIM data"])
        assert any("data_gaps_not_acknowledged" in e for e in errors)

    def test_gaps_acknowledged_passes(self, valid_output):
        valid_output["data_gaps_acknowledged"] = ["NIM data missing"]
        errors = validate_output(valid_output, data_gap_flags=["missing: NIM data"])
        gap_errors = [e for e in errors if "data_gaps" in e]
        assert len(gap_errors) == 0

    def test_high_confidence_low_reliability_warns(self, valid_output):
        valid_output["confidence_level"] = 9
        errors = validate_output(valid_output, reliability_grade="D")
        assert any("confidence_too_high" in e for e in errors)

    def test_no_caveats_fails(self, valid_output):
        valid_output["caveats"] = []
        errors = validate_output(valid_output)
        assert any("no_caveats" in e for e in errors)


# ---------------------------------------------------------------------------
# Prompt construction
# ---------------------------------------------------------------------------

class TestPromptConstruction:
    def test_includes_context_json(self):
        prompt = build_user_prompt({"ticker": "BBCA", "data_quality": {}})
        assert "BBCA" in prompt
        assert "STOCK DATA BUNDLE" in prompt

    def test_includes_macro_context(self):
        prompt = build_user_prompt(
            {"ticker": "BBCA"},
            macro_context={"as_of": "2026-03", "bi_rate": 5.75, "usd_idr": 16200,
                           "bi_rate_direction": "easing", "idx_composite_ytd": -3.2,
                           "foreign_flow_regime": "net_outflow"},
        )
        assert "5.75" in prompt
        assert "MACRO CONTEXT" in prompt

    def test_includes_sector_template(self):
        prompt = build_user_prompt(
            {"ticker": "BBCA"},
            sector_template={"subsector": "Bank", "key_metrics": "NIM, CASA, NPL",
                             "valuation_method": "PBV primary"},
        )
        assert "SECTOR TEMPLATE" in prompt
        assert "NIM, CASA, NPL" in prompt

    def test_includes_domain_notes(self):
        prompt = build_user_prompt(
            {"ticker": "BBCA"},
            domain_notes="Premium CASA franchise bank.",
        )
        assert "DOMAIN CONTEXT (user-provided)" in prompt
        assert "Premium CASA" in prompt

    def test_flags_no_domain_notes(self):
        prompt = build_user_prompt({"ticker": "BBCA"})
        assert "None available" in prompt
        assert "Flag conclusions" in prompt

    def test_includes_output_schema(self):
        prompt = build_user_prompt({"ticker": "BBCA"})
        assert "lynch_category" in prompt
        assert "bull_case" in prompt
        assert "bear_case" in prompt

    def test_system_prompt_has_frameworks(self):
        assert "Buffett" in SYSTEM_PROMPT or "BUFFETT" in SYSTEM_PROMPT
        assert "Lynch" in SYSTEM_PROMPT or "LYNCH" in SYSTEM_PROMPT
        assert "slow_grower" in SYSTEM_PROMPT
        assert "cyclical" in SYSTEM_PROMPT


# ---------------------------------------------------------------------------
# Provider abstraction
# ---------------------------------------------------------------------------

class TestProviderFactory:
    def test_openai_default(self):
        provider = get_provider("openai")
        assert provider.model == "gpt-4o-mini"

    def test_openai_custom_model(self):
        provider = get_provider("openai", model="gpt-4o-mini")
        assert provider.model == "gpt-4o-mini"

    def test_anthropic_provider(self):
        provider = get_provider("anthropic")
        assert provider.model == "claude-sonnet-4-20250514"

    def test_anthropic_custom_model(self):
        provider = get_provider("anthropic", model="claude-haiku-4-5-20251001")
        assert provider.model == "claude-haiku-4-5-20251001"

    def test_unknown_provider_raises(self):
        with pytest.raises(ValueError, match="Unknown provider"):
            get_provider("gemini")

    def test_openai_base_url(self):
        provider = get_provider("openai", base_url="http://localhost:8080/v1")
        assert provider.base_url == "http://localhost:8080/v1"


# ---------------------------------------------------------------------------
# Valid enum values
# ---------------------------------------------------------------------------

class TestEnums:
    def test_lynch_categories(self):
        assert "slow_grower" in VALID_LYNCH
        assert "stalwart" in VALID_LYNCH
        assert "fast_grower" in VALID_LYNCH
        assert "cyclical" in VALID_LYNCH
        assert "turnaround" in VALID_LYNCH
        assert "asset_play" in VALID_LYNCH
        assert len(VALID_LYNCH) == 6

    def test_verdict_values(self):
        assert "strong_buy" in VALID_VERDICT
        assert "buy" in VALID_VERDICT
        assert "hold" in VALID_VERDICT
        assert "avoid" in VALID_VERDICT
        assert "strong_avoid" in VALID_VERDICT
        assert len(VALID_VERDICT) == 5
