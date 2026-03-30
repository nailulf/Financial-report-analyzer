"""
Stage 2: Data Normalizer — Compute trend signals for 20 tracked metrics.

For each metric, computes:
- CAGR (full period + 3-year)
- Linear trend (direction, R², slope)
- Volatility (std dev of YoY changes)
- Z-score vs sector peers (min 8 peers, subsector→sector fallback)

FRD reference: Section 3 (Normalization & Scoring)
"""

from __future__ import annotations

import math
import logging
from datetime import date
from typing import Dict, List, Optional, Tuple

from scripts.scoring.schema import YearFlag, NormalizedMetric
from scripts.scoring.config import METRIC_MAP, VALUATION_METRICS, min_peers_for_zscore

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Math helpers
# ---------------------------------------------------------------------------

def compute_cagr(first: float, last: float, years: int) -> Optional[float]:
    """Compound Annual Growth Rate. Returns None if inputs are invalid."""
    if years <= 0 or first <= 0 or last <= 0:
        return None
    return round((last / first) ** (1 / years) - 1, 6)


def compute_linear_trend(values: List[float]) -> Tuple[str, Optional[float], Optional[float]]:
    """
    Compute trend direction, R², and annualized slope percentage.

    Returns:
        (direction, r2, slope_pct)
        direction: strong_up|mild_up|flat|mild_down|strong_down|volatile|insufficient_data
    """
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
    r2 = max(0.0, min(1.0, r2))

    slope_pct = (slope / abs(y_mean)) if y_mean != 0 else 0.0

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


def compute_volatility(year_vals: List[Tuple[int, float]]) -> Optional[float]:
    """Standard deviation of YoY change ratios."""
    if len(year_vals) < 3:
        return None

    yoy = []
    for i in range(1, len(year_vals)):
        prev = year_vals[i - 1][1]
        if prev != 0:
            yoy.append((year_vals[i][1] - prev) / abs(prev))

    if len(yoy) < 2:
        return None

    mean_yoy = sum(yoy) / len(yoy)
    variance = sum((y - mean_yoy) ** 2 for y in yoy) / len(yoy)
    return round(math.sqrt(variance), 6)


def compute_zscore_and_percentile(
    value: float,
    peer_values: List[float],
) -> Tuple[Optional[float], Optional[float]]:
    """
    Compute z-score and percentile rank against peer values.
    Returns (None, None) if insufficient data.
    """
    if not peer_values or len(peer_values) < 2:
        return None, None

    mean_p = sum(peer_values) / len(peer_values)
    std_p = math.sqrt(sum((v - mean_p) ** 2 for v in peer_values) / len(peer_values))

    if std_p == 0:
        return 0.0, 50.0

    z_score = round((value - mean_p) / std_p, 4)
    below = sum(1 for v in peer_values if v < value)
    percentile = round(below / len(peer_values) * 100, 2)

    return z_score, percentile


# ---------------------------------------------------------------------------
# Main normalizer
# ---------------------------------------------------------------------------

class DataNormalizer:
    """
    Normalize 20 tracked metrics for a single ticker.

    For each metric:
    1. Extract time series from cleaned financials
    2. Compute CAGR (full + 3yr), trend, volatility
    3. Compute z-score vs sector peers (if enough peers available)
    """

    def normalize(
        self,
        clean_rows: List[dict],
        flags: Dict[int, YearFlag],
        stock: dict,
        sector_peer_metrics: Optional[Dict[str, List[float]]] = None,
        sector_peer_count: int = 0,
        peer_group_level: Optional[str] = None,
    ) -> List[NormalizedMetric]:
        """
        Compute normalized metrics for one ticker.

        Args:
            clean_rows: Annual financials after cleaning (sorted by year asc)
            flags: YearFlag per year from DataCleaner
            stock: Stock profile row
            sector_peer_metrics: {metric_name: [peer_latest_values]} for z-score
            sector_peer_count: Number of peers in the comparison group
            peer_group_level: 'subsector' or 'sector' or None

        Returns:
            List of 20 NormalizedMetric objects
        """
        listed_shares = stock.get("listed_shares") or 0
        current_year = date.today().year
        min_peers = min_peers_for_zscore()
        sector_peer_metrics = sector_peer_metrics or {}

        metrics_out: List[NormalizedMetric] = []

        for metric_name, mapping in METRIC_MAP.items():
            col = mapping["col"]
            unit = mapping["unit"]

            # ── Extract time series ──────────────────────────────────
            year_vals: List[Tuple[int, float]] = []
            anomaly_years: List[int] = []
            missing_years: List[int] = []
            ttm_value: Optional[Tuple[int, float]] = None

            for row in clean_rows:
                yr = row["year"]
                source = (row.get("source") or "").lower()
                is_ttm = yr >= current_year and "keystats" in source

                # Compute derived metrics
                if col == "_computed_dps":
                    dp = row.get("dividends_paid")
                    val = abs(dp) / listed_shares if dp and listed_shares > 0 else None
                elif col == "_computed_fcf_ni":
                    fcf = row.get("free_cash_flow")
                    ni = row.get("net_income")
                    val = fcf / ni if fcf is not None and ni and ni > 0 else None
                else:
                    val = row.get(col)

                if val is None:
                    missing_years.append(yr)
                    continue

                val = float(val)

                if is_ttm:
                    ttm_value = (yr, val)
                else:
                    year_vals.append((yr, val))

                # Track anomaly years
                yf = flags.get(yr)
                if yf and (yf.has_anomaly or yf.is_covid_year):
                    anomaly_years.append(yr)

            # ── Handle empty data ────────────────────────────────────
            if not year_vals:
                metrics_out.append(NormalizedMetric(
                    metric_name=metric_name,
                    unit=unit,
                    anomaly_years=sorted(set(anomaly_years)),
                    missing_years=sorted(missing_years),
                ))
                continue

            # ── Latest value (TTM override for valuation metrics) ────
            latest_year = year_vals[-1][0]
            latest_value = year_vals[-1][1]

            if metric_name in VALUATION_METRICS and ttm_value:
                latest_year = ttm_value[0]
                latest_value = ttm_value[1]

            # ── Trend computation (exclude anomaly years) ────────────
            trend_vals = [(yr, v) for yr, v in year_vals if yr not in anomaly_years]
            if len(trend_vals) < 3:
                trend_vals = year_vals  # fallback: include anomalies

            trend_values_only = [v for _, v in trend_vals]
            direction, r2, slope_pct = compute_linear_trend(trend_values_only)

            # ── CAGR ─────────────────────────────────────────────────
            years_span = year_vals[-1][0] - year_vals[0][0]
            cagr_full = compute_cagr(year_vals[0][1], year_vals[-1][1], years_span)

            recent_3 = [(yr, v) for yr, v in year_vals if yr >= year_vals[-1][0] - 3]
            cagr_3yr = None
            if len(recent_3) >= 2:
                span3 = recent_3[-1][0] - recent_3[0][0]
                if span3 > 0:
                    cagr_3yr = compute_cagr(recent_3[0][1], recent_3[-1][1], span3)

            # ── Volatility ───────────────────────────────────────────
            volatility = compute_volatility(year_vals)

            # ── Z-score vs sector ────────────────────────────────────
            z_score = None
            percentile = None
            effective_peer_level = None
            effective_peer_count = 0

            peer_values = sector_peer_metrics.get(metric_name, [])
            if len(peer_values) >= min_peers and latest_value is not None:
                z_score, percentile = compute_zscore_and_percentile(latest_value, peer_values)
                effective_peer_level = peer_group_level
                effective_peer_count = len(peer_values)

            # ── Build result ─────────────────────────────────────────
            metrics_out.append(NormalizedMetric(
                metric_name=metric_name,
                unit=unit,
                latest_value=latest_value,
                latest_year=latest_year,
                cagr_full=cagr_full,
                cagr_3yr=cagr_3yr,
                trend_direction=direction,
                trend_r2=r2,
                trend_slope_pct=slope_pct,
                volatility=volatility,
                z_score_vs_sector=z_score,
                percentile_vs_sector=percentile,
                peer_group_level=effective_peer_level,
                peer_count=effective_peer_count,
                anomaly_years=sorted(set(anomaly_years)),
                missing_years=sorted(missing_years),
                data_years_count=len(year_vals),
                years=[yr for yr, _ in year_vals],
                values=[v for _, v in year_vals],
            ))

        return metrics_out
