"""
Stage 4: Context Builder — Assemble the 8-block AI context bundle.

Combines cleaned/normalized/scored data with smart money signals,
valuation computations, health scores, shareholders, sector context,
and macro context into a single self-contained JSON payload.

Includes Python ports of:
- signal-confidence.ts → smart money phase detection
- health-score.ts → 7-metric health system
- valuation.ts → Graham number + DCF 3-scenario

FRD reference: Section 4 (AI Context Bundle), Section 5 (context_builder.py)
"""

from __future__ import annotations

import json
import math
import logging
import os
import time
from datetime import date, datetime, timezone
from typing import Any, Dict, List, Optional

from scripts.scoring.schema import NormalizedMetric, StockScore, ContextBundle
from scripts.scoring.config import (
    health_thresholds,
    valuation_config,
    get_macro_context,
    METRIC_MAP,
)

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Health score (Python port of health-score.ts)
# ---------------------------------------------------------------------------

def compute_health_score(latest_annual: dict, is_bank: bool = False) -> dict:
    """
    Compute 7-metric health score. Returns {total, grade, components}.
    Port of web/src/lib/calculations/health-score.ts
    """
    ht = health_thresholds()
    components = {}

    def _score_metric(metric: str, value, invert: bool = False) -> dict:
        if value is None:
            return {"value": None, "score": None, "flag": "na"}
        t = ht.get(metric)
        if t is None:
            return {"value": value, "score": None, "flag": "na"}
        if not invert:
            if value >= t["green"]:
                flag = "green"
            elif value >= t["yellow"]:
                flag = "yellow"
            else:
                flag = "red"
        else:
            if value <= t["green"]:
                flag = "green"
            elif value <= t["yellow"]:
                flag = "yellow"
            else:
                flag = "red"
        score_val = {"green": 15, "yellow": 10, "red": 3}.get(flag, 0)
        return {"value": round(value, 2) if value else value, "score": score_val, "max": 15, "flag": flag}

    for metric in ["roe", "net_margin", "gross_margin", "roa"]:
        val = latest_annual.get(metric)
        components[metric] = _score_metric(metric, val)

    # Current ratio — exempt for banks
    if is_bank:
        components["current_ratio"] = {"value": None, "score": None, "exempt": True}
    else:
        components["current_ratio"] = _score_metric("current_ratio", latest_annual.get("current_ratio"))

    # Debt/equity — inverted (lower is better), exempt display for banks but still scored if available
    de_val = latest_annual.get("debt_to_equity")
    if is_bank and de_val is None:
        components["debt_to_equity"] = {"value": None, "score": None, "exempt": True}
    else:
        components["debt_to_equity"] = _score_metric("debt_to_equity", de_val, invert=True)

    # Free cash flow — sign-based
    fcf = latest_annual.get("free_cash_flow")
    if fcf is None:
        components["free_cash_flow"] = {"value": None, "score": None, "flag": "na"}
    else:
        flag = "green" if fcf >= 0 else "red"
        components["free_cash_flow"] = {"value": fcf, "score": 15 if flag == "green" else 0, "max": 20, "flag": flag}

    # Total
    total_score = sum(c.get("score", 0) or 0 for c in components.values())
    max_score = sum(c.get("max", 15) for c in components.values() if not c.get("exempt"))
    health_pct = round(total_score / max_score * 100) if max_score > 0 else 0

    if health_pct >= 80:
        grade = "Sehat"
    elif health_pct >= 60:
        grade = "Cukup Sehat"
    elif health_pct >= 40:
        grade = "Perlu Perhatian"
    else:
        grade = "Tidak Sehat"

    return {"total": health_pct, "grade": grade, "components": components}


# ---------------------------------------------------------------------------
# Valuation (Python port of valuation.ts)
# ---------------------------------------------------------------------------

def compute_graham_number(eps: Optional[float], bvps: Optional[float]) -> Optional[float]:
    """Graham Number = sqrt(22.5 × EPS × BVPS). Returns None if inputs invalid."""
    vc = valuation_config()
    if not eps or eps <= 0 or not bvps or bvps <= 0:
        return None
    return math.sqrt(vc["graham_constant"] * eps * bvps)


def compute_dcf_scenarios(
    fcf: float,
    shares: int,
    base_growth_pct: float,
    current_price: Optional[float] = None,
) -> Dict[str, Optional[int]]:
    """
    Compute 3-scenario DCF (bear/base/bull).
    Returns {dcf_bear, dcf_base, dcf_bull, dcf_base_mos}.
    """
    vc = valuation_config()
    if not fcf or fcf <= 0 or not shares or shares <= 0:
        return {"dcf_bear": None, "dcf_base": None, "dcf_bull": None, "dcf_base_mos": None}

    wacc = vc["base_wacc"]
    tg = vc["terminal_growth"]
    var = vc["scenario_variation"]
    proj_years = vc["dcf_projection_years"]

    results = {}
    for label, g_mul, w_mul in [("bear", 1 - var, 1 + var), ("base", 1, 1), ("bull", 1 + var, 1 - var)]:
        g = base_growth_pct * g_mul / 100
        r = wacc * w_mul / 100
        gt = tg / 100

        if r <= gt:
            results[f"dcf_{label}"] = None
            continue

        total_pv = 0
        for t in range(1, proj_years + 1):
            proj_fcf = fcf * (1 + g) ** t
            total_pv += proj_fcf / (1 + r) ** t

        fcf_terminal = fcf * (1 + g) ** proj_years
        tv = (fcf_terminal * (1 + gt)) / (r - gt)
        total_pv += tv / (1 + r) ** proj_years

        results[f"dcf_{label}"] = round(total_pv / shares)

    # Margin of safety for base case
    dcf_base = results.get("dcf_base")
    if dcf_base and current_price and current_price > 0:
        results["dcf_base_mos"] = round((dcf_base - current_price) / dcf_base, 4)
    else:
        results["dcf_base_mos"] = None

    return results


# ---------------------------------------------------------------------------
# Smart money phase detection (simplified port of signal-confidence.ts)
# ---------------------------------------------------------------------------

def detect_smart_money_phase(
    asing_net: float,
    lokal_net: float,
    pemerintah_net: float,
) -> str:
    """Detect akumulasi / distribusi / netral from 30-day net flows."""
    net_flow = asing_net + lokal_net + pemerintah_net
    if net_flow > 0 and asing_net > 0:
        return "akumulasi"
    elif net_flow < 0 and asing_net < 0:
        return "distribusi"
    return "netral"


# ---------------------------------------------------------------------------
# IDR rounding for token reduction
# ---------------------------------------------------------------------------

def _round_idr_billions(val: Optional[float]) -> Optional[float]:
    if val is None:
        return None
    return round(val / 1e9, 1)


# ---------------------------------------------------------------------------
# Main context builder
# ---------------------------------------------------------------------------

class ContextBuilder:
    """
    Assemble the 8-block AI context bundle for one ticker.

    Blocks: data_quality, fundamentals, valuation, smart_money,
    shareholders, health_score, sector_context, macro_context
    """

    def build(
        self,
        ticker: str,
        stock: dict,
        metrics: List[NormalizedMetric],
        score: StockScore,
        flags: Dict[int, Any],
        clean_rows: List[dict],
        latest_price: Optional[dict] = None,
        broker_flow_30d: Optional[List[dict]] = None,
        bandar_latest: Optional[dict] = None,
        insider_90d: Optional[List[dict]] = None,
        shareholders: Optional[List[dict]] = None,
        sector_peer_scores: Optional[List[dict]] = None,
        domain_notes: Optional[str] = None,
        sector_template: Optional[dict] = None,
    ) -> ContextBundle:
        """Build the full context bundle."""
        start = time.time()
        is_bank = (stock.get("subsector") or "").lower() in ("bank", "banks")

        # Defaults
        broker_flow_30d = broker_flow_30d or []
        insider_90d = insider_90d or []
        shareholders = shareholders or []
        sector_peer_scores = sector_peer_scores or []

        # ── Block 1: data_quality ────────────────────────────────
        anomalous_years = sorted(set(
            yr for yr, f in flags.items()
            if getattr(f, 'has_anomaly', False) or getattr(f, 'is_covid_year', False)
        ))
        flagged_issues = []
        for yr in sorted(flags.keys()):
            f = flags[yr]
            for note in getattr(f, 'notes', []):
                flagged_issues.append(note)

        data_quality = {
            "reliability_score": score.reliability_total,
            "reliability_grade": score.reliability_grade,
            "confidence_score": score.confidence_total,
            "confidence_grade": score.confidence_grade,
            "composite_score": score.composite_score,
            "ready_for_ai": score.ready_for_ai,
            "data_years_available": score.data_years_available,
            "primary_source": score.primary_source,
            "missing_metrics": score.missing_metrics,
            "anomalous_years": anomalous_years,
            "flagged_issues": flagged_issues,
            "data_gap_flags": score.data_gap_flags,
            "banking_exemptions_applied": is_bank,
        }

        # ── Block 2: fundamentals ────────────────────────────────
        published_rows = [r for r in clean_rows if not r.get("is_ttm")]
        latest_year = max((r["year"] for r in published_rows), default=None)
        metrics_dict = {}
        for m in metrics:
            entry = {
                "value": m.latest_value,
                "unit": m.unit,
                "cagr_full": m.cagr_full,
                "cagr_3yr": m.cagr_3yr,
                "trend": m.trend_direction,
                "trend_r2": m.trend_r2,
                "vs_sector_pct": m.percentile_vs_sector,
                "peer_group": m.peer_group_level,
                "peer_count": m.peer_count,
                "anomaly_years": m.anomaly_years,
            }
            if m.unit == "idr" and m.latest_value is not None:
                entry["value_display"] = f"{_round_idr_billions(m.latest_value)} Rp Billion"
            metrics_dict[m.metric_name] = entry

        # Key signals
        def _m(name):
            return next((x for x in metrics if x.metric_name == name), None)

        rev_m = _m("revenue")
        nm_m = _m("net_margin")
        de_m = _m("debt_to_equity")
        fcf_ni = _m("fcf_to_net_income")
        dy_m = _m("dividend_yield")

        key_signals = {
            "revenue_growth_acceleration": bool(
                rev_m and rev_m.cagr_3yr is not None and rev_m.cagr_full is not None
                and rev_m.cagr_3yr > rev_m.cagr_full
            ),
            "margin_compression": bool(
                nm_m and nm_m.trend_direction in ("mild_down", "strong_down")
            ),
            "deleveraging": bool(
                de_m and de_m.trend_direction in ("mild_down", "strong_down")
            ),
            "fcf_quality_concern": bool(
                fcf_ni and fcf_ni.latest_value is not None and fcf_ni.latest_value < 0.70
            ),
            "dividend_growth": bool(
                dy_m and dy_m.trend_direction in ("mild_up", "strong_up")
            ),
        }

        fundamentals = {
            "latest_year": latest_year,
            "metrics": metrics_dict,
            "key_signals": key_signals,
        }

        # ── Block 3: valuation ───────────────────────────────────
        close = latest_price.get("close") if latest_price else None
        price_date = latest_price.get("date") if latest_price else None
        eps_val = _m("eps")
        eps_v = eps_val.latest_value if eps_val else None
        bvps_val = _m("bvps")
        bvps_v = bvps_val.latest_value if bvps_val else None
        pe_m = _m("pe_ratio")
        pb_m = _m("pb_ratio")
        fcf_m = _m("free_cash_flow")
        fcf_v = fcf_m.latest_value if fcf_m else None
        listed_shares = stock.get("listed_shares") or 0

        graham = compute_graham_number(eps_v, bvps_v)
        graham_mos = None
        if graham and close and close > 0:
            graham_mos = round((graham - close) / graham, 4)

        # DCF — pick the best basis depending on stock type:
        #  1. FCF-based (default for non-financial companies with positive FCF)
        #  2. Dividend-based (for banks and high-yield stocks where FCF is meaningless)
        #  3. EPS-based (for companies with negative FCF but positive earnings)
        dcf = {"dcf_bear": None, "dcf_base": None, "dcf_bull": None, "dcf_base_mos": None}
        dcf_mode = None
        base_growth = (rev_m.cagr_3yr * 100) if rev_m and rev_m.cagr_3yr else 8.0

        # Get dividend and NI values for alternative bases
        latest_annual = published_rows[-1] if published_rows else {}
        dividends_paid = latest_annual.get("dividends_paid")
        ni_val = latest_annual.get("net_income")

        if fcf_v and fcf_v > 0 and listed_shares > 0 and not is_bank:
            # Option 1: FCF-based (best for non-financial companies)
            dcf = compute_dcf_scenarios(fcf_v, listed_shares, base_growth, close)
            dcf_mode = "fcf"
        elif dividends_paid and abs(dividends_paid) > 0 and listed_shares > 0:
            # Option 2: Dividend-based (DDM — best for banks and dividend payers)
            dps_annual = abs(dividends_paid) / listed_shares
            dcf = compute_dcf_scenarios(abs(dividends_paid), listed_shares, base_growth, close)
            dcf_mode = "dividend"
        elif ni_val and ni_val > 0 and listed_shares > 0:
            # Option 3: EPS-based (for negative FCF but profitable companies)
            dcf = compute_dcf_scenarios(ni_val, listed_shares, base_growth, close)
            dcf_mode = "eps"

        valuation = {
            "current_price": close,
            "price_date": price_date,
            "market_cap": stock.get("market_cap"),
            "pe_ratio": round(pe_m.latest_value, 2) if pe_m and pe_m.latest_value else None,
            "pb_ratio": round(pb_m.latest_value, 2) if pb_m and pb_m.latest_value else None,
            "graham_number": round(graham) if graham else None,
            "graham_margin_of_safety": graham_mos,
            "dcf_mode": dcf_mode,  # tells AI which basis was used
            **dcf,
        }

        # ── Block 4: smart_money ─────────────────────────────────
        asing_net = sum(r.get("net_value", 0) for r in broker_flow_30d if r.get("broker_type") == "Asing")
        lokal_net = sum(r.get("net_value", 0) for r in broker_flow_30d if r.get("broker_type") == "Lokal")
        pemerintah_net = sum(r.get("net_value", 0) for r in broker_flow_30d if r.get("broker_type") == "Pemerintah")

        phase = detect_smart_money_phase(asing_net, lokal_net, pemerintah_net)

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

        # ── Block 5: shareholders ────────────────────────────────
        shareholders_block = {
            "top_holders": [
                {"name": s.get("holder_name", ""), "type": s.get("holder_type"), "pct": s.get("percentage")}
                for s in shareholders[:5]
            ],
            "public_float_pct": next(
                (s.get("percentage") for s in shareholders if s.get("holder_type") == "public"), None
            ),
        }

        # ── Block 6: health_score ────────────────────────────────
        latest_annual = published_rows[-1] if published_rows else {}
        health = compute_health_score(latest_annual, is_bank=is_bank)

        # ── Block 7: sector_context ──────────────────────────────
        sector_context = {
            "sector": stock.get("sector"),
            "sub_sector": stock.get("subsector"),
            "peers_count": len(sector_peer_scores),
            "top_peers": sector_peer_scores[:3],
        }

        # ── Block 8: macro_context ───────────────────────────────
        try:
            macro = get_macro_context()
        except Exception:
            macro = {"as_of": "unknown", "note": "macro context file not found"}

        # ── Assemble top-level bundle ────────────────────────────
        context = {
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
            "health_score": health,
            "sector_context": sector_context,
            "macro_context": macro,
        }

        # Domain notes (injected if available)
        if domain_notes:
            context["domain_notes"] = domain_notes

        # Sector template (injected if available)
        if sector_template:
            context["sector_template"] = sector_template

        token_estimate = len(json.dumps(context, default=str)) // 4
        duration_ms = int((time.time() - start) * 1000)

        return ContextBundle(
            ticker=ticker,
            context=context,
            token_estimate=token_estimate,
            ready_for_ai=score.ready_for_ai,
            build_duration_ms=duration_ms,
        )
