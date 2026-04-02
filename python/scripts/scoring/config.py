"""
Shared scoring configuration loader.

Reads thresholds and constants from shared/scoring-config.json and
shared/macro-context.json. Both TypeScript and Python use the same
source file so thresholds stay in sync.
"""

from __future__ import annotations

import json
import os
from typing import Any, Optional

_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
_SCORING_CONFIG_PATH = os.path.join(_ROOT, "shared", "scoring-config.json")
_MACRO_CONTEXT_PATH = os.path.join(_ROOT, "shared", "macro-context.json")

# Module-level cache
_scoring_config: Optional[dict] = None
_macro_context: Optional[dict] = None


def _load_json(path: str) -> dict:
    with open(path, "r") as f:
        return json.load(f)


def get_scoring_config() -> dict:
    """Load and cache shared/scoring-config.json."""
    global _scoring_config
    if _scoring_config is None:
        _scoring_config = _load_json(_SCORING_CONFIG_PATH)
    return _scoring_config


def get_macro_context() -> dict:
    """Load and cache shared/macro-context.json."""
    global _macro_context
    if _macro_context is None:
        _macro_context = _load_json(_MACRO_CONTEXT_PATH)
    return _macro_context


# ---------------------------------------------------------------------------
# Convenience accessors
# ---------------------------------------------------------------------------

def health_thresholds() -> dict:
    return get_scoring_config()["health_thresholds"]


def smart_money_config() -> dict:
    return get_scoring_config()["smart_money"]


def valuation_config() -> dict:
    return get_scoring_config()["valuation"]


def scoring_params() -> dict:
    return get_scoring_config()["scoring"]


def min_peers_for_zscore() -> int:
    return scoring_params()["min_peers_for_zscore"]


def ready_for_ai_thresholds() -> dict:
    return scoring_params()["ready_for_ai"]


def reliability_grades() -> dict:
    return scoring_params()["reliability_grades"]


def confidence_grades() -> dict:
    return scoring_params()["confidence_grades"]


# ---------------------------------------------------------------------------
# 20 tracked metrics — canonical names → financials column mapping
# ---------------------------------------------------------------------------

METRIC_MAP: dict[str, dict[str, str]] = {
    "revenue":            {"col": "revenue",             "unit": "idr"},
    "net_income":         {"col": "net_income",          "unit": "idr"},
    "operating_income":   {"col": "operating_income",    "unit": "idr"},
    "free_cash_flow":     {"col": "free_cash_flow",      "unit": "idr"},
    "operating_cash_flow":{"col": "operating_cash_flow", "unit": "idr"},
    "cash":               {"col": "cash_and_equivalents","unit": "idr"},
    "gross_margin":       {"col": "gross_margin",        "unit": "percent"},
    "net_margin":         {"col": "net_margin",          "unit": "percent"},
    "roe":                {"col": "roe",                 "unit": "percent"},
    "roa":                {"col": "roa",                 "unit": "percent"},
    "debt_to_equity":     {"col": "debt_to_equity",      "unit": "ratio"},
    "current_ratio":      {"col": "current_ratio",       "unit": "ratio"},
    "interest_coverage":  {"col": "interest_coverage",   "unit": "ratio"},
    "eps":                {"col": "eps",                 "unit": "idr"},
    "bvps":               {"col": "book_value_per_share","unit": "idr"},
    "dps":                {"col": "_computed_dps",       "unit": "idr"},
    "fcf_to_net_income":  {"col": "_computed_fcf_ni",    "unit": "ratio"},
    "pe_ratio":           {"col": "pe_ratio",            "unit": "multiple"},
    "pb_ratio":           {"col": "pbv_ratio",           "unit": "multiple"},
    "dividend_yield":     {"col": "dividend_yield",      "unit": "percent"},
    "total_equity":       {"col": "total_equity",        "unit": "idr"},
}

# Metrics where TTM (keystats) value should be used as latest display value
VALUATION_METRICS = {"pe_ratio", "pb_ratio", "dividend_yield", "eps", "bvps"}
