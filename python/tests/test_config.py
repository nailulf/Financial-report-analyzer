"""Tests for shared scoring config loading."""

import json
import os
import pytest

# Add project root to path for imports
import sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from scripts.scoring.config import (
    get_scoring_config,
    get_macro_context,
    health_thresholds,
    smart_money_config,
    valuation_config,
    scoring_params,
    min_peers_for_zscore,
    ready_for_ai_thresholds,
    METRIC_MAP,
    VALUATION_METRICS,
)


class TestScoringConfigLoad:
    def test_loads_successfully(self):
        config = get_scoring_config()
        assert isinstance(config, dict)

    def test_has_all_top_level_keys(self):
        config = get_scoring_config()
        assert "health_thresholds" in config
        assert "smart_money" in config
        assert "valuation" in config
        assert "scoring" in config

    def test_health_thresholds_complete(self):
        ht = health_thresholds()
        expected_metrics = ["roe", "net_margin", "gross_margin", "roa", "current_ratio", "debt_to_equity", "fcf"]
        for metric in expected_metrics:
            assert metric in ht, f"Missing health threshold for {metric}"

    def test_health_green_exceeds_yellow(self):
        ht = health_thresholds()
        for metric in ["roe", "net_margin", "gross_margin", "roa"]:
            assert ht[metric]["green"] > ht[metric]["yellow"], f"{metric}: green should exceed yellow"

    def test_debt_to_equity_inverted(self):
        ht = health_thresholds()
        assert ht["debt_to_equity"].get("invert") is True
        assert ht["debt_to_equity"]["green"] < ht["debt_to_equity"]["yellow"]

    def test_valuation_constants(self):
        vc = valuation_config()
        assert vc["risk_free_rate"] == 6.75
        assert vc["base_wacc"] == 13.0
        assert vc["terminal_growth"] == 3.0
        assert vc["graham_constant"] == 22.5
        assert vc["scenario_variation"] == 0.10

    def test_smart_money_tiers(self):
        sm = smart_money_config()
        assert sm["broker_magnitude_max"] == 25
        assert len(sm["broker_magnitude_tiers"]) == 4
        assert len(sm["broker_magnitude_scores"]) == 5  # one more than tiers (else clause)
        assert sm["strength_labels"][0]["min"] == 80  # highest first

    def test_scoring_weights_sum(self):
        sp = scoring_params()
        rel_weights = sp["reliability_weights"]
        conf_weights = sp["confidence_weights"]
        assert sum(rel_weights.values()) == 100
        assert sum(conf_weights.values()) == 100

    def test_min_peers_for_zscore(self):
        assert min_peers_for_zscore() == 8

    def test_ready_for_ai_thresholds(self):
        rfa = ready_for_ai_thresholds()
        assert rfa["min_reliability"] == 45
        assert rfa["min_confidence"] == 40
        assert rfa["min_clean_years"] == 3
        assert rfa["max_anomaly_pct"] == 0.30


class TestMacroContext:
    def test_loads_successfully(self):
        ctx = get_macro_context()
        assert isinstance(ctx, dict)

    def test_has_required_fields(self):
        ctx = get_macro_context()
        required = ["as_of", "bi_rate", "bi_rate_direction", "usd_idr", "foreign_flow_regime", "key_events"]
        for field in required:
            assert field in ctx, f"Missing macro context field: {field}"

    def test_bi_rate_is_numeric(self):
        ctx = get_macro_context()
        assert isinstance(ctx["bi_rate"], (int, float))
        assert 0 < ctx["bi_rate"] < 20  # sanity range

    def test_key_events_is_list(self):
        ctx = get_macro_context()
        assert isinstance(ctx["key_events"], list)
        assert len(ctx["key_events"]) > 0


class TestMetricMap:
    def test_has_20_metrics(self):
        assert len(METRIC_MAP) == 20

    def test_each_metric_has_col_and_unit(self):
        for name, mapping in METRIC_MAP.items():
            assert "col" in mapping, f"{name}: missing 'col'"
            assert "unit" in mapping, f"{name}: missing 'unit'"

    def test_units_are_valid(self):
        valid_units = {"idr", "ratio", "percent", "multiple"}
        for name, mapping in METRIC_MAP.items():
            assert mapping["unit"] in valid_units, f"{name}: invalid unit '{mapping['unit']}'"

    def test_computed_metrics_flagged(self):
        assert METRIC_MAP["dps"]["col"].startswith("_computed")
        assert METRIC_MAP["fcf_to_net_income"]["col"].startswith("_computed")

    def test_valuation_metrics_subset(self):
        for m in VALUATION_METRICS:
            assert m in METRIC_MAP, f"Valuation metric '{m}' not in METRIC_MAP"
