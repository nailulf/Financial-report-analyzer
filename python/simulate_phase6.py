#!/usr/bin/env python3
"""
Phase 6 Pipeline Simulation — end-to-end dry run against live Supabase data.

Runs all 4 pre-AI stages for a single ticker and outputs:
  1. Cleaning results (data_quality_flags equivalent)
  2. Normalized metrics (20 metrics with trends)
  3. Scoring results (reliability + confidence + composite)
  4. Final AI context bundle (the JSON Claude would receive)

Usage:
  python simulate_phase6.py BBCA
  python simulate_phase6.py BBRI --output bundle.json
"""

import json
import math
import os
import sys
from collections import defaultdict
from dataclasses import dataclass, field, asdict
from datetime import date, datetime, timezone
from typing import Optional

# ---------------------------------------------------------------------------
# Supabase connection
# ---------------------------------------------------------------------------

def get_sb():
    """Connect to Supabase using web/.env.local credentials."""
    try:
        from supabase import create_client
    except ImportError:
        sys.exit("pip install supabase first")

    env_path = os.path.join(os.path.dirname(__file__), "..", "web", ".env.local")
    if os.path.exists(env_path):
        for line in open(env_path):
            line = line.strip()
            if "=" in line and not line.startswith("#"):
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip())

    url = os.environ.get("NEXT_PUBLIC_SUPABASE_URL")
    key = os.environ.get("NEXT_PUBLIC_SUPABASE_ANON_KEY")
    if not url or not key:
        sys.exit("Missing SUPABASE credentials in web/.env.local")
    return create_client(url, key)


# ---------------------------------------------------------------------------
# Shared config (mirrors shared/scoring-config.json from FRD Section 5.4)
# ---------------------------------------------------------------------------

HEALTH_THRESHOLDS = {
    "roe":            {"green": 15,  "yellow": 8},
    "net_margin":     {"green": 10,  "yellow": 5},
    "gross_margin":   {"green": 30,  "yellow": 15},
    "roa":            {"green": 8,   "yellow": 4},
    "current_ratio":  {"green": 1.5, "yellow": 1.0},
    "debt_to_equity": {"green": 1.0, "yellow": 2.0, "invert": True},
}

VALUATION = {
    "risk_free_rate":      6.75,
    "equity_risk_premium": 6.25,
    "base_wacc":           13.0,
    "terminal_growth":     3.0,
    "scenario_variation":  0.10,
    "graham_constant":     22.5,
}

STRENGTH_LABELS = [
    (80, "Sangat Kuat"), (60, "Kuat"), (40, "Sedang"),
    (20, "Lemah"), (0, "Sangat Lemah"),
]

MIN_PEERS_FOR_ZSCORE = 8

# The 20 tracked metrics — canonical names → financials column mapping
METRIC_MAP = {
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
    "fcf_to_net_income":  {"col": "_computed_fcf_ni",   "unit": "ratio"},
    "pe_ratio":           {"col": "pe_ratio",            "unit": "multiple"},
    "pb_ratio":           {"col": "pbv_ratio",           "unit": "multiple"},
    "dividend_yield":     {"col": "dividend_yield",      "unit": "percent"},
}


# ===========================================================================
# STAGE 1: Data Cleaner
# ===========================================================================

@dataclass
class YearFlag:
    year: int
    is_covid_year: bool = False
    is_ipo_year: bool = False
    has_anomaly: bool = False
    anomaly_metrics: list = field(default_factory=list)
    has_one_time_items: bool = False
    scale_warning: bool = False
    source_conflict: bool = False
    usability_flag: str = "clean"      # clean|minor_issues|use_with_caution|exclude
    notes: list = field(default_factory=list)


def stage1_clean(financials: list[dict], stock: dict) -> tuple[list[dict], dict[int, YearFlag]]:
    """Apply cleaning rules. Returns (clean_rows, flags_by_year)."""
    flags: dict[int, YearFlag] = {}
    listing_year = None
    if stock.get("listing_date"):
        try:
            listing_year = int(stock["listing_date"][:4])
        except (ValueError, TypeError):
            pass

    is_bank = (stock.get("subsector") or "").lower() in ("bank", "banks") or \
              "finance" in (stock.get("sector") or "").lower()

    current_year = date.today().year

    # Sort by year ascending
    rows = sorted(financials, key=lambda r: r["year"])

    for row in rows:
        yr = row["year"]
        f = YearFlag(year=yr)

        # Rule NEW: TTM/keystats data for current year — not published annual
        source = (row.get("source") or "").lower()
        if yr >= current_year and "keystats" in source:
            f.usability_flag = "use_with_caution"
            f.notes.append(f"ttm_estimate_{yr}: keystats data, not published annual report")

        # Rule 1: COVID
        if yr == 2020:
            f.is_covid_year = True
            f.has_one_time_items = True
            f.notes.append("covid_year_2020")

        # Rule 10: IPO partial year
        if listing_year and yr == listing_year:
            f.is_ipo_year = True
            f.usability_flag = "exclude"
            f.notes.append(f"ipo_year_{yr}: partial financial data")

        # Rule 4: Scale detection
        rev = row.get("revenue")
        if rev is not None and rev > 0 and rev < 1_000_000_000:
            f.scale_warning = True
            f.notes.append(f"scale_warning: revenue {rev:,} < 1B IDR")
            f.usability_flag = "use_with_caution"

        # Rule 8: Missing critical fields
        if row.get("revenue") is None and row.get("net_income") is None and row.get("total_assets") is None:
            f.usability_flag = "exclude"
            f.notes.append(f"missing_critical_fields_{yr}")

        # Rule 9: One-time items (NI/OI ratio) — exempt for banks
        oi = row.get("operating_income")
        ni = row.get("net_income")
        if not is_bank and oi and ni and oi != 0 and yr != 2020:
            ratio = abs(ni / oi - 1)
            if ratio > 0.40:
                f.has_one_time_items = True
                f.notes.append(f"one_time_{yr}: NI/OI ratio = {ni/oi:.2f}x")

        # Rule 7: Negative equity
        eq = row.get("total_equity")
        if eq is not None and eq < 0:
            f.usability_flag = "use_with_caution"
            f.notes.append(f"negative_equity_{yr}")

        # Rule NEW: Banking zero-override
        # Stockbit stores D/E=0, current_ratio=0, interest_coverage=0 for banks.
        # Override to None so normalizer doesn't compute meaningless trends on constant zeros.
        if is_bank:
            for bank_metric in ["debt_to_equity", "current_ratio", "interest_coverage"]:
                if row.get(bank_metric) == 0 or row.get(bank_metric) == 0.0:
                    row[bank_metric] = None

        if f.is_covid_year and f.usability_flag == "clean":
            f.usability_flag = "minor_issues"

        flags[yr] = f

    # Rule 5+6: Income anomaly + FCF anomaly (IQR on YoY changes)
    for metric_key in ["net_income", "free_cash_flow"]:
        values = [(r["year"], r.get(metric_key)) for r in rows if r.get(metric_key) is not None]
        if len(values) >= 3:
            yoy_changes = []
            for i in range(1, len(values)):
                prev_val = values[i-1][1]
                curr_val = values[i][1]
                if prev_val != 0:
                    yoy_changes.append((values[i][0], (curr_val - prev_val) / abs(prev_val)))

            if len(yoy_changes) >= 3:
                changes_only = [c[1] for c in yoy_changes]
                changes_only.sort()
                q1 = changes_only[len(changes_only) // 4]
                q3 = changes_only[3 * len(changes_only) // 4]
                iqr = q3 - q1
                if iqr > 0:
                    for yr, change in yoy_changes:
                        z = abs(change - (q1 + q3) / 2) / iqr
                        if z > 2.5 and abs(change) > 0.20:
                            if yr in flags:
                                flags[yr].has_anomaly = True
                                flags[yr].anomaly_metrics.append(metric_key)
                                flags[yr].notes.append(f"anomaly_{yr}_{metric_key}: z={z:.1f}")

    # Filter to clean rows (exclude rows with usability_flag='exclude')
    clean_rows = [r for r in rows if flags.get(r["year"], YearFlag(year=0)).usability_flag != "exclude"]

    return clean_rows, flags


# ===========================================================================
# STAGE 2: Data Normalizer
# ===========================================================================

def _cagr(first: float, last: float, years: int) -> Optional[float]:
    if years <= 0 or first <= 0 or last <= 0:
        return None
    return (last / first) ** (1 / years) - 1


def _linear_trend(values: list[float]) -> tuple[Optional[str], Optional[float], Optional[float]]:
    """Compute trend direction, R², slope_pct from a time series."""
    n = len(values)
    if n < 3:
        return "insufficient_data", None, None

    xs = list(range(n))
    x_mean = sum(xs) / n
    y_mean = sum(values) / n

    ss_xy = sum((x - x_mean) * (y - y_mean) for x, y in zip(xs, values))
    ss_xx = sum((x - x_mean) ** 2 for x in xs)
    ss_yy = sum((y - y_mean) ** 2 for y in values)

    if ss_xx == 0 or ss_yy == 0:
        return "flat", 1.0, 0.0

    slope = ss_xy / ss_xx
    r2 = (ss_xy ** 2) / (ss_xx * ss_yy)
    r2 = max(0, min(1, r2))

    # Slope as annualized % change
    slope_pct = (slope / abs(y_mean)) if y_mean != 0 else 0

    # Direction classification
    if r2 < 0.3:
        direction = "volatile"
    elif slope_pct > 0.05:
        direction = "strong_up"
    elif slope_pct > 0.01:
        direction = "mild_up"
    elif slope_pct > -0.01:
        direction = "flat"
    elif slope_pct > -0.05:
        direction = "mild_down"
    else:
        direction = "strong_down"

    return direction, round(r2, 4), round(slope_pct, 6)


def stage2_normalize(clean_rows: list[dict], flags: dict[int, YearFlag],
                     stock: dict, sector_peers_data: list[dict]) -> list[dict]:
    """Compute normalized metrics for one ticker. Returns list of metric dicts."""
    listed_shares = stock.get("listed_shares") or 0
    metrics_out = []

    for metric_name, mapping in METRIC_MAP.items():
        col = mapping["col"]
        unit = mapping["unit"]

        # Extract time series
        year_vals = []
        anomaly_years = []
        missing_years = []
        current_year = date.today().year

        for row in clean_rows:
            yr = row["year"]

            # Skip TTM/keystats rows for trend computation (they duplicate prior year)
            source = (row.get("source") or "").lower()
            is_ttm = yr >= current_year and "keystats" in source

            # Computed metrics
            if col == "_computed_dps":
                dp = row.get("dividends_paid")
                # dividends_paid is often NULL for TTM rows — skip those
                val = abs(dp) / listed_shares if dp and listed_shares > 0 else None
            elif col == "_computed_fcf_ni":
                fcf = row.get("free_cash_flow")
                ni = row.get("net_income")
                val = fcf / ni if fcf is not None and ni and ni > 0 else None
            else:
                val = row.get(col)

            if val is not None and not is_ttm:
                year_vals.append((yr, float(val)))
            elif val is not None and is_ttm:
                # Keep TTM as "latest_value" reference but exclude from trend
                pass  # will be handled below
            else:
                missing_years.append(yr)

            yf = flags.get(yr)
            if yf and (yf.has_anomaly or yf.is_covid_year):
                anomaly_years.append(yr)

        if not year_vals:
            metrics_out.append({
                "metric_name": metric_name, "unit": unit,
                "latest_value": None, "latest_year": None,
                "data_years_count": 0, "trend_direction": "insufficient_data",
                "cagr_full": None, "cagr_3yr": None, "trend_r2": None,
                "trend_slope_pct": None, "volatility": None,
                "z_score_vs_sector": None, "percentile_vs_sector": None,
                "peer_group_level": None, "peer_count": 0,
                "anomaly_years": [], "missing_years": [],
                "years": [], "values": [],
            })
            continue

        # For valuation multiples (PE, PB, yield), use TTM as latest_value if available
        # (more current than last published annual), but still exclude from trend
        ttm_override = None
        valuation_metrics = {"pe_ratio", "pb_ratio", "dividend_yield", "eps", "bvps"}
        if metric_name in valuation_metrics:
            for row in reversed(clean_rows):
                src = (row.get("source") or "").lower()
                if row["year"] >= current_year and "keystats" in src:
                    v = row.get(col if not col.startswith("_") else None)
                    if v is not None:
                        ttm_override = (row["year"], float(v))
                    break

        # Exclude anomaly years from trend computation
        trend_vals = [(yr, v) for yr, v in year_vals if yr not in anomaly_years]
        if len(trend_vals) < 3:
            trend_vals = year_vals  # fall back to including anomalies if too few

        latest_year = year_vals[-1][0]
        latest_value = year_vals[-1][1]

        # Apply TTM override for latest display value (but trend uses published annual)
        if ttm_override:
            latest_year = ttm_override[0]
            latest_value = ttm_override[1]

        # CAGRs
        years_span = year_vals[-1][0] - year_vals[0][0]
        cagr_full = _cagr(year_vals[0][1], year_vals[-1][1], years_span) if years_span > 0 else None

        # 3-year CAGR
        recent_3 = [(yr, v) for yr, v in year_vals if yr >= latest_year - 3]
        cagr_3yr = None
        if len(recent_3) >= 2:
            span3 = recent_3[-1][0] - recent_3[0][0]
            cagr_3yr = _cagr(recent_3[0][1], recent_3[-1][1], span3) if span3 > 0 else None

        # Trend
        trend_values_only = [v for _, v in trend_vals]
        direction, r2, slope_pct = _linear_trend(trend_values_only)

        # Volatility (std dev of YoY changes)
        yoy = []
        for i in range(1, len(year_vals)):
            prev = year_vals[i-1][1]
            if prev != 0:
                yoy.append((year_vals[i][1] - prev) / abs(prev))
        volatility = None
        if len(yoy) >= 2:
            mean_yoy = sum(yoy) / len(yoy)
            volatility = math.sqrt(sum((y - mean_yoy)**2 for y in yoy) / len(yoy))

        # Z-score vs sector (simplified: compare latest_value against sector peers)
        z_score = None
        percentile = None
        peer_group_level = None
        peer_count = 0

        peer_values = []
        for peer in sector_peers_data:
            for pr in peer.get("financials", []):
                if pr["year"] == latest_year:
                    pv = pr.get(mapping["col"] if not col.startswith("_") else None)
                    if pv is not None:
                        peer_values.append(float(pv))
                    break

        if len(peer_values) >= MIN_PEERS_FOR_ZSCORE:
            peer_count = len(peer_values)
            peer_group_level = "subsector"
            mean_p = sum(peer_values) / len(peer_values)
            std_p = math.sqrt(sum((v - mean_p)**2 for v in peer_values) / len(peer_values))
            if std_p > 0:
                z_score = round((latest_value - mean_p) / std_p, 4)
                # Percentile: count how many peers are below this value
                below = sum(1 for v in peer_values if v < latest_value)
                percentile = round(below / len(peer_values) * 100, 2)

        metrics_out.append({
            "metric_name": metric_name,
            "unit": unit,
            "latest_value": latest_value,
            "latest_year": latest_year,
            "cagr_full": round(cagr_full, 6) if cagr_full is not None else None,
            "cagr_3yr": round(cagr_3yr, 6) if cagr_3yr is not None else None,
            "trend_direction": direction,
            "trend_r2": r2,
            "trend_slope_pct": slope_pct,
            "volatility": round(volatility, 6) if volatility is not None else None,
            "z_score_vs_sector": z_score,
            "percentile_vs_sector": percentile,
            "peer_group_level": peer_group_level,
            "peer_count": peer_count,
            "anomaly_years": sorted(set(anomaly_years)),
            "missing_years": sorted(missing_years),
            "data_years_count": len(year_vals),
            "years": [yr for yr, _ in year_vals],
            "values": [v for _, v in year_vals],
        })

    return metrics_out


# ===========================================================================
# STAGE 3: Scoring Engine
# ===========================================================================

@dataclass
class StockScore:
    # Reliability
    reliability_total: float = 0
    reliability_grade: str = "F"
    reliability_completeness: float = 0
    reliability_consistency: float = 0
    reliability_freshness: float = 0
    reliability_source: float = 0
    reliability_penalties: float = 0
    # Confidence
    confidence_total: float = 0
    confidence_grade: str = "VERY LOW"
    confidence_signal: float = 0
    confidence_trend: float = 0
    confidence_depth: float = 0
    confidence_peers: float = 0
    confidence_valuation: float = 0
    # Composite
    composite_score: float = 0
    ready_for_ai: bool = False
    # Signals
    bullish_signals: list = field(default_factory=list)
    bearish_signals: list = field(default_factory=list)
    data_gap_flags: list = field(default_factory=list)
    missing_metrics: list = field(default_factory=list)


def stage3_score(metrics: list[dict], flags: dict[int, YearFlag],
                 clean_rows: list[dict], stock: dict) -> StockScore:
    """Compute reliability + confidence scores."""
    s = StockScore()

    # --- Reliability ---

    # Completeness: how many of 20 metrics have data?
    metrics_with_data = sum(1 for m in metrics if m["latest_value"] is not None)
    s.reliability_completeness = round(metrics_with_data / 20 * 30, 2)  # max 30
    s.missing_metrics = [m["metric_name"] for m in metrics if m["latest_value"] is None]

    # Consistency: how many years are clean?
    total_years = len(flags)
    clean_years = sum(1 for f in flags.values() if f.usability_flag == "clean")
    s.reliability_consistency = round(clean_years / max(total_years, 1) * 25, 2)  # max 25

    # Freshness: latest financial year
    latest_fin_year = max((r["year"] for r in clean_rows), default=0)
    current_year = date.today().year
    if latest_fin_year >= current_year - 1:
        s.reliability_freshness = 25
    elif latest_fin_year >= current_year - 2:
        s.reliability_freshness = 15
    else:
        s.reliability_freshness = 5

    # Source quality
    sources = set(r.get("source", "unknown") for r in clean_rows)
    if "stockbit" in sources or "stockbit_keystats" in sources:
        s.reliability_source = 20
    elif "idx" in sources:
        s.reliability_source = 15
    elif "yfinance" in sources:
        s.reliability_source = 10
    else:
        s.reliability_source = 5

    # Penalties
    anomaly_count = sum(1 for f in flags.values() if f.has_anomaly)
    scale_issues = sum(1 for f in flags.values() if f.scale_warning)
    s.reliability_penalties = min(15, anomaly_count * 3 + scale_issues * 5)

    s.reliability_total = round(min(100, max(0,
        s.reliability_completeness + s.reliability_consistency +
        s.reliability_freshness + s.reliability_source - s.reliability_penalties
    )), 2)

    # Grade
    if s.reliability_total >= 80: s.reliability_grade = "A"
    elif s.reliability_total >= 65: s.reliability_grade = "B"
    elif s.reliability_total >= 50: s.reliability_grade = "C"
    elif s.reliability_total >= 35: s.reliability_grade = "D"
    else: s.reliability_grade = "F"

    # --- Confidence ---

    # Trend stability: average R² across metrics with trends
    r2_values = [m["trend_r2"] for m in metrics if m.get("trend_r2") is not None]
    avg_r2 = sum(r2_values) / len(r2_values) if r2_values else 0
    s.confidence_trend = round(avg_r2 * 25, 2)  # max 25

    # Data depth
    data_years = max((m["data_years_count"] for m in metrics), default=0)
    s.confidence_depth = round(min(data_years / 10, 1.0) * 20, 2)  # max 20

    # Peer availability
    peer_counts = [m["peer_count"] for m in metrics if m["peer_count"] > 0]
    avg_peers = sum(peer_counts) / len(peer_counts) if peer_counts else 0
    s.confidence_peers = round(min(avg_peers / 20, 1.0) * 15, 2)  # max 15

    # Valuation anchor
    has_pe = any(m["metric_name"] == "pe_ratio" and m["latest_value"] is not None for m in metrics)
    has_pb = any(m["metric_name"] == "pb_ratio" and m["latest_value"] is not None for m in metrics)
    has_fcf = any(m["metric_name"] == "free_cash_flow" and m["latest_value"] is not None for m in metrics)
    val_pts = (5 if has_pe else 0) + (5 if has_pb else 0) + (5 if has_fcf else 0)
    s.confidence_valuation = min(15, val_pts)  # max 15

    # Signal strength (placeholder — will use smart money data in Stage 4)
    s.confidence_signal = 5  # default, overridden by context builder

    s.confidence_total = round(min(100, max(0,
        s.confidence_signal + s.confidence_trend + s.confidence_depth +
        s.confidence_peers + s.confidence_valuation
    )), 2)

    # Grade
    if s.confidence_total >= 70: s.confidence_grade = "HIGH"
    elif s.confidence_total >= 50: s.confidence_grade = "MEDIUM"
    elif s.confidence_total >= 30: s.confidence_grade = "LOW"
    else: s.confidence_grade = "VERY LOW"

    # --- Composite ---
    if s.reliability_total < 40:
        s.composite_score = round(min(30, s.confidence_total * 0.3), 2)
    else:
        s.composite_score = round(s.reliability_total * 0.5 + s.confidence_total * 0.5, 2)

    # --- ready_for_ai gate ---
    clean_year_count = sum(1 for f in flags.values() if f.usability_flag in ("clean", "minor_issues"))
    has_revenue = any(m["metric_name"] == "revenue" and m["latest_value"] and m["latest_value"] > 0 for m in metrics)
    anomaly_pct = anomaly_count / max(total_years, 1)

    s.ready_for_ai = (
        s.reliability_total >= 45 and
        s.confidence_total >= 40 and
        clean_year_count >= 3 and
        has_revenue and
        anomaly_pct <= 0.30
    )

    # --- Signals ---
    for m in metrics:
        if m.get("cagr_3yr") is not None and m.get("cagr_full") is not None:
            if m["cagr_3yr"] > m["cagr_full"] and m["cagr_3yr"] > 0:
                if m["metric_name"] in ("revenue", "net_income", "eps"):
                    s.bullish_signals.append(f"{m['metric_name']}_growth_accelerating")
        if m.get("trend_direction") == "strong_down" and m["metric_name"] in ("roe", "net_margin"):
            s.bearish_signals.append(f"{m['metric_name']}_declining")

    # Data gaps
    if s.missing_metrics:
        s.data_gap_flags.append(f"missing_metrics: {', '.join(s.missing_metrics)}")
    for m in metrics:
        if m.get("peer_count", 0) == 0 and m["latest_value"] is not None:
            s.data_gap_flags.append(f"no_sector_comparison: {m['metric_name']}")
            break  # one flag is enough

    return s


# ===========================================================================
# STAGE 4: Context Builder
# ===========================================================================

def _round_idr_billions(val):
    """Round IDR to nearest billion for token reduction."""
    if val is None:
        return None
    return round(val / 1e9, 1)


def _health_score_item(metric: str, value, thresholds: dict) -> dict:
    if value is None:
        return {"value": None, "score": None, "flag": "na", "exempt": False}

    t = thresholds.get(metric)
    if t is None:
        # FCF: sign-based
        if metric == "free_cash_flow":
            flag = "green" if value >= 0 else "red"
            return {"value": value, "score": 15 if flag == "green" else 0, "max": 20, "flag": flag}
        return {"value": value, "score": None, "flag": "na"}

    invert = t.get("invert", False)
    if not invert:
        if value >= t["green"]:  flag = "green"
        elif value >= t["yellow"]: flag = "yellow"
        else: flag = "red"
    else:
        if value <= t["green"]:  flag = "green"
        elif value <= t["yellow"]: flag = "yellow"
        else: flag = "red"

    score_val = {"green": 15, "yellow": 10, "red": 3}.get(flag, 0)
    return {"value": round(value, 2), "score": score_val, "max": 15, "flag": flag}


def stage4_build_context(
    ticker: str,
    stock: dict,
    metrics: list[dict],
    score: StockScore,
    flags: dict[int, YearFlag],
    clean_rows: list[dict],
    latest_price: dict,
    broker_flow_30d: list[dict],
    bandar_latest: Optional[dict],
    insider_90d: list[dict],
    shareholders: list[dict],
    sector_scores: list[dict],
) -> dict:
    """Assemble the full AI context bundle."""

    is_bank = (stock.get("subsector") or "").lower() in ("bank", "banks")

    # --- data_quality block ---
    anomalous_years = sorted(set(yr for yr, f in flags.items() if f.has_anomaly or f.is_covid_year))
    flagged_issues = []
    for yr, f in sorted(flags.items()):
        for note in f.notes:
            flagged_issues.append(note)

    data_quality = {
        "reliability_score": score.reliability_total,
        "reliability_grade": score.reliability_grade,
        "confidence_score": score.confidence_total,
        "confidence_grade": score.confidence_grade,
        "composite_score": score.composite_score,
        "ready_for_ai": score.ready_for_ai,
        "data_years_available": max((m["data_years_count"] for m in metrics), default=0),
        "primary_source": list(set(r.get("source", "unknown") for r in clean_rows[:3])),
        "missing_metrics": score.missing_metrics,
        "anomalous_years": anomalous_years,
        "flagged_issues": flagged_issues,
        "data_gap_flags": score.data_gap_flags,
        "banking_exemptions_applied": is_bank,
    }

    # --- fundamentals block ---
    latest_year = max((r["year"] for r in clean_rows), default=None)
    metrics_dict = {}
    for m in metrics:
        entry = {
            "value": m["latest_value"],
            "unit": m["unit"],
            "cagr_full": m.get("cagr_full"),
            "cagr_3yr": m.get("cagr_3yr"),
            "trend": m.get("trend_direction"),
            "trend_r2": m.get("trend_r2"),
            "vs_sector_pct": m.get("percentile_vs_sector"),
            "peer_group": m.get("peer_group_level"),
            "peer_count": m.get("peer_count", 0),
            "anomaly_years": m.get("anomaly_years", []),
        }
        # Round IDR values to billions in the bundle
        if m["unit"] == "idr" and m["latest_value"] is not None:
            entry["value_display"] = f"{_round_idr_billions(m['latest_value'])} Rp Billion"
        metrics_dict[m["metric_name"]] = entry

    # Key signals
    rev_m = next((m for m in metrics if m["metric_name"] == "revenue"), None)
    nm_m = next((m for m in metrics if m["metric_name"] == "net_margin"), None)
    de_m = next((m for m in metrics if m["metric_name"] == "debt_to_equity"), None)
    fcf_ni = next((m for m in metrics if m["metric_name"] == "fcf_to_net_income"), None)
    dy_m = next((m for m in metrics if m["metric_name"] == "dividend_yield"), None)

    key_signals = {
        "revenue_growth_acceleration": bool(
            rev_m and rev_m.get("cagr_3yr") is not None and rev_m.get("cagr_full") is not None
            and rev_m["cagr_3yr"] > rev_m["cagr_full"]
        ),
        "margin_compression": bool(
            nm_m and nm_m.get("trend_direction") in ("mild_down", "strong_down")
        ),
        "deleveraging": bool(
            de_m and de_m.get("trend_direction") in ("mild_down", "strong_down")
        ),
        "fcf_quality_concern": bool(
            fcf_ni and fcf_ni.get("latest_value") is not None and fcf_ni["latest_value"] < 0.70
        ),
        "dividend_growth": bool(
            dy_m and dy_m.get("trend_direction") in ("mild_up", "strong_up")
        ),
    }

    fundamentals = {
        "latest_year": latest_year,
        "metrics": metrics_dict,
        "key_signals": key_signals,
    }

    # --- valuation block ---
    close = latest_price.get("close") if latest_price else None
    price_date = latest_price.get("date") if latest_price else None
    eps_val = next((m["latest_value"] for m in metrics if m["metric_name"] == "eps"), None)
    bvps_val = next((m["latest_value"] for m in metrics if m["metric_name"] == "bvps"), None)
    pe_val = next((m["latest_value"] for m in metrics if m["metric_name"] == "pe_ratio"), None)
    pb_val = next((m["latest_value"] for m in metrics if m["metric_name"] == "pb_ratio"), None)
    fcf_val = next((m["latest_value"] for m in metrics if m["metric_name"] == "free_cash_flow"), None)
    listed_shares = stock.get("listed_shares") or 0

    # Graham number
    graham = None
    graham_mos = None
    if eps_val and eps_val > 0 and bvps_val and bvps_val > 0:
        graham = math.sqrt(VALUATION["graham_constant"] * eps_val * bvps_val)
        if close and close > 0:
            graham_mos = round((graham - close) / graham, 4)

    # DCF scenarios
    dcf_bear = dcf_base = dcf_bull = None
    if fcf_val and fcf_val > 0 and listed_shares > 0:
        rev_cagr = rev_m.get("cagr_3yr") if rev_m else None
        base_growth = (rev_cagr * 100) if rev_cagr else 8.0  # fallback 8%
        wacc = VALUATION["base_wacc"]
        tg = VALUATION["terminal_growth"]
        var = VALUATION["scenario_variation"]

        for scenario, g_mul, w_mul in [("bear", 1-var, 1+var), ("base", 1, 1), ("bull", 1+var, 1-var)]:
            g = base_growth * g_mul / 100
            r = wacc * w_mul / 100
            gt = tg / 100
            if r <= gt:
                continue
            total_pv = 0
            for t in range(1, 11):
                proj_fcf = fcf_val * (1 + g) ** t
                total_pv += proj_fcf / (1 + r) ** t
            fcf10 = fcf_val * (1 + g) ** 10
            tv = (fcf10 * (1 + gt)) / (r - gt)
            total_pv += tv / (1 + r) ** 10
            per_share = round(total_pv / listed_shares)
            if scenario == "bear": dcf_bear = per_share
            elif scenario == "base": dcf_base = per_share
            else: dcf_bull = per_share

    valuation = {
        "current_price": close,
        "price_date": price_date,
        "market_cap": stock.get("market_cap"),
        "pe_ratio": round(pe_val, 2) if pe_val else None,
        "pb_ratio": round(pb_val, 2) if pb_val else None,
        "graham_number": round(graham) if graham else None,
        "graham_margin_of_safety": graham_mos,
        "dcf_bear": dcf_bear,
        "dcf_base": dcf_base,
        "dcf_bull": dcf_bull,
        "dcf_base_margin_of_safety": round((dcf_base - close) / dcf_base, 4) if dcf_base and close else None,
    }

    # --- smart_money block ---
    asing_net = sum(r.get("net_value", 0) for r in broker_flow_30d if r.get("broker_type") == "Asing")
    lokal_net = sum(r.get("net_value", 0) for r in broker_flow_30d if r.get("broker_type") == "Lokal")
    pemerintah_net = sum(r.get("net_value", 0) for r in broker_flow_30d if r.get("broker_type") == "Pemerintah")
    total_buy = sum(r.get("buy_value", 0) for r in broker_flow_30d)
    total_sell = sum(r.get("sell_value", 0) for r in broker_flow_30d)
    net_flow = asing_net + lokal_net + pemerintah_net

    # Phase detection
    if net_flow > 0 and asing_net > 0:
        phase = "akumulasi"
    elif net_flow < 0 and asing_net < 0:
        phase = "distribusi"
    else:
        phase = "netral"

    insider_buys = sum(1 for t in insider_90d if t.get("action") == "BUY")
    insider_sells = sum(1 for t in insider_90d if t.get("action") == "SELL")

    smart_money = {
        "window_days": 30,
        "phase": phase,
        "asing_net_30d": asing_net,
        "lokal_net_30d": lokal_net,
        "pemerintah_net_30d": pemerintah_net,
        "bandar_latest_date": bandar_latest.get("trade_date") if bandar_latest else None,
        "bandar_accdist": bandar_latest.get("broker_accdist") if bandar_latest else None,
        "bandar_top5_accdist": bandar_latest.get("top5_accdist") if bandar_latest else None,
        "insider_window_days": 90,
        "insider_net_direction": "buy" if insider_buys > insider_sells else ("sell" if insider_sells > insider_buys else "neutral"),
        "insider_buy_count": insider_buys,
        "insider_sell_count": insider_sells,
    }

    # --- shareholders block ---
    shareholders_block = {
        "top_holders": [
            {"name": s["holder_name"], "type": s.get("holder_type"), "pct": s.get("percentage")}
            for s in (shareholders or [])[:5]
        ],
        "public_float_pct": next((s.get("percentage") for s in shareholders if s.get("holder_type") == "public"), None),
    }

    # --- health_score block ---
    latest_annual = clean_rows[-1] if clean_rows else {}
    health_components = {}
    for metric in ["roe", "net_margin", "gross_margin", "roa", "current_ratio", "debt_to_equity"]:
        val = latest_annual.get(metric)
        if is_bank and metric in ("current_ratio", "interest_coverage"):
            health_components[metric] = {"value": None, "score": None, "exempt": True}
        else:
            health_components[metric] = _health_score_item(metric, val, HEALTH_THRESHOLDS)

    fcf_raw = latest_annual.get("free_cash_flow")
    health_components["free_cash_flow"] = _health_score_item("free_cash_flow", fcf_raw, {})

    total_health = sum(c.get("score", 0) or 0 for c in health_components.values())
    max_health = sum(c.get("max", 15) for c in health_components.values() if not c.get("exempt"))
    health_pct = round(total_health / max_health * 100) if max_health > 0 else 0

    health_grade = "Sehat" if health_pct >= 80 else "Cukup Sehat" if health_pct >= 60 else "Perlu Perhatian" if health_pct >= 40 else "Tidak Sehat"

    health_score = {
        "total": health_pct,
        "grade": health_grade,
        "components": health_components,
    }

    # --- sector_context block ---
    sector_context = {
        "sector": stock.get("sector"),
        "sub_sector": stock.get("subsector"),
        "peers_count": len(sector_scores),
        "top_peers": sector_scores[:3],
    }

    # --- Assemble ---
    bundle = {
        "ticker": ticker,
        "name": stock.get("name"),
        "sector": stock.get("sector"),
        "sub_sector": stock.get("subsector"),
        "is_lq45": stock.get("is_lq45", False),
        "is_idx30": stock.get("is_idx30", False),
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "data_as_of": price_date,
        "data_quality": data_quality,
        "fundamentals": fundamentals,
        "valuation": valuation,
        "smart_money": smart_money,
        "shareholders": shareholders_block,
        "health_score": health_score,
        "sector_context": sector_context,
    }

    # Token estimate
    token_estimate = len(json.dumps(bundle)) // 4

    return bundle, token_estimate


# ===========================================================================
# Main — orchestrate all 4 stages
# ===========================================================================

def fetch_all_data(sb, ticker: str):
    """Fetch all raw data from Supabase for one ticker."""
    print(f"\n{'='*60}")
    print(f"  PHASE 6 SIMULATION: {ticker}")
    print(f"{'='*60}")

    # Stock profile
    stock = (sb.table("stocks").select("*").eq("ticker", ticker).execute().data or [{}])[0]
    print(f"\n[fetch] Stock: {stock.get('name')} | {stock.get('sector')} > {stock.get('subsector')}")

    # Annual financials
    fin = sb.table("financials").select("*").eq("ticker", ticker).eq("quarter", 0).order("year").execute()
    financials = fin.data or []
    years = [r["year"] for r in financials]
    print(f"[fetch] Annual financials: {len(financials)} rows ({min(years) if years else '?'}–{max(years) if years else '?'})")

    # Latest price
    price = (sb.table("daily_prices").select("date, close, foreign_net")
             .eq("ticker", ticker).order("date", desc=True).limit(1).execute().data or [{}])[0]
    print(f"[fetch] Latest price: {price.get('close')} on {price.get('date')}")

    # Broker flow (last 30 days)
    from datetime import timedelta
    cutoff_30d = (date.today() - timedelta(days=30)).isoformat()
    bf = sb.table("broker_flow").select("trade_date, broker_code, broker_type, buy_value, sell_value, net_value") \
           .eq("ticker", ticker).gte("trade_date", cutoff_30d).execute()
    print(f"[fetch] Broker flow (30d): {len(bf.data or [])} rows")

    # Bandar signal (latest)
    bs = (sb.table("bandar_signal").select("trade_date, broker_accdist, top5_accdist")
            .eq("ticker", ticker).order("trade_date", desc=True).limit(1).execute().data or [None])[0]
    print(f"[fetch] Bandar signal: {bs.get('broker_accdist') if bs else 'none'} ({bs.get('trade_date') if bs else ''})")

    # Insider transactions (90 days)
    cutoff_90d = (date.today() - timedelta(days=90)).isoformat()
    ins = sb.table("insider_transactions").select("transaction_date, insider_name, action, ownership_change_pct") \
            .eq("ticker", ticker).gte("transaction_date", cutoff_90d).execute()
    print(f"[fetch] Insider transactions (90d): {len(ins.data or [])} rows")

    # Shareholders
    sh = sb.table("shareholders").select("holder_name, holder_type, percentage") \
           .eq("ticker", ticker).order("percentage", desc=True).limit(5).execute()
    print(f"[fetch] Shareholders: {len(sh.data or [])} entries")

    return stock, financials, price, bf.data or [], bs, ins.data or [], sh.data or []


def main():
    ticker = sys.argv[1] if len(sys.argv) > 1 else "BBCA"
    output_file = None
    if "--output" in sys.argv:
        idx = sys.argv.index("--output")
        output_file = sys.argv[idx + 1] if idx + 1 < len(sys.argv) else "bundle.json"

    sb = get_sb()

    # Fetch data
    stock, financials, price, broker_flow, bandar, insiders, shareholders = fetch_all_data(sb, ticker)

    if not financials:
        sys.exit(f"No annual financials found for {ticker}")

    # ── STAGE 1: Clean ──
    print(f"\n{'─'*60}")
    print("  STAGE 1: Data Cleaner")
    print(f"{'─'*60}")
    clean_rows, flags = stage1_clean(financials, stock)
    excluded = sum(1 for f in flags.values() if f.usability_flag == "exclude")
    flagged = sum(1 for f in flags.values() if f.notes)
    print(f"  {len(financials)} years → {len(clean_rows)} clean ({excluded} excluded)")
    print(f"  Flagged years: {flagged}")
    for yr, f in sorted(flags.items()):
        if f.notes:
            print(f"    {yr}: {', '.join(f.notes)} → {f.usability_flag}")

    # ── STAGE 2: Normalize ──
    print(f"\n{'─'*60}")
    print("  STAGE 2: Data Normalizer")
    print(f"{'─'*60}")
    # Simplified: no full sector peer data in simulation (would need querying all peers)
    metrics = stage2_normalize(clean_rows, flags, stock, [])
    populated = sum(1 for m in metrics if m["latest_value"] is not None)
    print(f"  20 metrics computed, {populated} populated, {20 - populated} missing")
    for m in metrics:
        if m["latest_value"] is not None:
            val_str = f"{m['latest_value']:,.0f}" if m["unit"] == "idr" else f"{m['latest_value']:.2f}"
            trend = m.get("trend_direction", "?")
            r2 = f" R²={m['trend_r2']:.2f}" if m.get("trend_r2") else ""
            cagr3 = f" 3yr={m['cagr_3yr']*100:.1f}%" if m.get("cagr_3yr") else ""
            print(f"    {m['metric_name']:<22} {val_str:>20}  {trend:<12}{r2}{cagr3}")
        else:
            print(f"    {m['metric_name']:<22} {'—':>20}  missing")

    # ── STAGE 3: Score ──
    print(f"\n{'─'*60}")
    print("  STAGE 3: Scoring Engine")
    print(f"{'─'*60}")
    score = stage3_score(metrics, flags, clean_rows, stock)
    print(f"  Reliability: {score.reliability_total}/100 ({score.reliability_grade})")
    print(f"    completeness={score.reliability_completeness} consistency={score.reliability_consistency} "
          f"freshness={score.reliability_freshness} source={score.reliability_source} penalties=-{score.reliability_penalties}")
    print(f"  Confidence:  {score.confidence_total}/100 ({score.confidence_grade})")
    print(f"    signal={score.confidence_signal} trend={score.confidence_trend} depth={score.confidence_depth} "
          f"peers={score.confidence_peers} valuation={score.confidence_valuation}")
    print(f"  Composite:   {score.composite_score}/100")
    print(f"  Ready for AI: {'YES ✓' if score.ready_for_ai else 'NO ✗'}")
    if score.bullish_signals:
        print(f"  Bullish: {', '.join(score.bullish_signals)}")
    if score.bearish_signals:
        print(f"  Bearish: {', '.join(score.bearish_signals)}")
    if score.data_gap_flags:
        print(f"  Gaps: {', '.join(score.data_gap_flags)}")

    # ── STAGE 4: Build Context ──
    print(f"\n{'─'*60}")
    print("  STAGE 4: Context Builder")
    print(f"{'─'*60}")
    bundle, token_est = stage4_build_context(
        ticker=ticker,
        stock=stock,
        metrics=metrics,
        score=score,
        flags=flags,
        clean_rows=clean_rows,
        latest_price=price,
        broker_flow_30d=broker_flow,
        bandar_latest=bandar,
        insider_90d=insiders,
        shareholders=shareholders,
        sector_scores=[],  # simplified for simulation
    )
    print(f"  Bundle assembled: ~{token_est} tokens")
    print(f"  Blocks: {', '.join(bundle.keys())}")

    # Health score summary
    hs = bundle["health_score"]
    print(f"  Health: {hs['total']}/100 ({hs['grade']})")
    for k, v in hs["components"].items():
        if v.get("exempt"):
            print(f"    {k:<20} EXEMPT")
        elif v.get("value") is not None:
            print(f"    {k:<20} {v['value']:>10}  {v['flag']}")

    # Valuation summary
    val = bundle["valuation"]
    print(f"  Valuation:")
    print(f"    Price: {val['current_price']}  PE: {val.get('pe_ratio')}  PB: {val.get('pb_ratio')}")
    print(f"    Graham: {val.get('graham_number')} (MoS: {val.get('graham_margin_of_safety')})")
    print(f"    DCF: bear={val.get('dcf_bear')} base={val.get('dcf_base')} bull={val.get('dcf_bull')}")

    # Smart money summary
    sm = bundle["smart_money"]
    print(f"  Smart Money: {sm['phase']}")
    print(f"    Asing: {sm['asing_net_30d']:,.0f}  Lokal: {sm['lokal_net_30d']:,.0f}")
    print(f"    Bandar: {sm.get('bandar_accdist')} / top5: {sm.get('bandar_top5_accdist')}")
    print(f"    Insider: {sm['insider_buy_count']} buys, {sm['insider_sell_count']} sells ({sm['insider_net_direction']})")

    # Output
    if output_file:
        with open(output_file, "w") as f:
            json.dump(bundle, f, indent=2, default=str)
        print(f"\n  Bundle written to {output_file}")

    print(f"\n{'='*60}")
    print(f"  SIMULATION COMPLETE — {ticker}")
    print(f"  ready_for_ai={score.ready_for_ai}  composite={score.composite_score}")
    print(f"  token_estimate={token_est}")
    print(f"{'='*60}\n")

    return bundle


if __name__ == "__main__":
    main()
