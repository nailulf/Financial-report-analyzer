"""
Stage 1: Data Cleaner — Validate and flag financial data quality issues.

Applies 13 deterministic cleaning rules (2 deferred) to annual financials.
Produces data_quality_flags rows and returns clean financials for downstream stages.

FRD reference: Section 2 (Data Cleaning Layer)
"""

from __future__ import annotations

import logging
from datetime import date
from typing import Dict, List, Optional, Tuple

from scripts.scoring.schema import YearFlag, CleaningResult

logger = logging.getLogger(__name__)


def _is_banking_stock(stock: dict) -> bool:
    """Check if stock is in banking/finance sector (applies exemptions)."""
    subsector = (stock.get("subsector") or "").lower()
    sector = (stock.get("sector") or "").lower()
    return subsector in ("bank", "banks") or "finance" in sector


def _get_listing_year(stock: dict) -> Optional[int]:
    """Extract listing year from stock profile."""
    ld = stock.get("listing_date")
    if not ld:
        return None
    try:
        return int(str(ld)[:4])
    except (ValueError, TypeError):
        return None


def _compute_iqr_anomalies(
    rows: List[dict],
    metric_key: str,
    z_threshold: float = 2.5,
    change_threshold: float = 0.20,
) -> Dict[int, float]:
    """
    Detect anomalous years using IQR on YoY change ratios.
    Returns dict of {year: z_score} for anomalous years.
    """
    values = [(r["year"], r.get(metric_key)) for r in rows if r.get(metric_key) is not None]
    if len(values) < 3:
        return {}

    yoy_changes: List[Tuple[int, float]] = []
    for i in range(1, len(values)):
        prev_val = values[i - 1][1]
        curr_val = values[i][1]
        if prev_val != 0:
            yoy_changes.append((values[i][0], (curr_val - prev_val) / abs(prev_val)))

    if len(yoy_changes) < 3:
        return {}

    changes_only = sorted([c[1] for c in yoy_changes])
    q1 = changes_only[len(changes_only) // 4]
    q3 = changes_only[3 * len(changes_only) // 4]
    iqr = q3 - q1

    if iqr <= 0:
        return {}

    median = (q1 + q3) / 2
    anomalies = {}
    for yr, change in yoy_changes:
        z = abs(change - median) / iqr
        if z > z_threshold and abs(change) > change_threshold:
            anomalies[yr] = round(z, 1)

    return anomalies


class DataCleaner:
    """
    Apply 13 cleaning rules to annual financials for a single ticker.

    Rules:
      1. COVID year (2020)
      2. Restatement detection (DEFERRED v1 — always FALSE)
      3. Source conflict
      4. Scale detection (revenue < 1B IDR)
      5. Income anomaly (IQR on YoY net_income)
      6. FCF anomaly (IQR on YoY free_cash_flow)
      7. Negative equity
      8. Missing critical fields
      9. One-time items (NI/OI ratio + revenue spike-drop)
     10. IPO partial year exclusion
     11. Banking zero-override (D/E, current_ratio, interest_coverage = 0 → NULL)
     12. TTM/keystats handling
     13. Stock split adjustment (DEFERRED v1 — flag only)
    """

    def clean_ticker(
        self,
        financials: List[dict],
        stock: dict,
    ) -> Tuple[List[dict], Dict[int, YearFlag], CleaningResult]:
        """
        Apply all cleaning rules to one ticker's annual financials.

        Args:
            financials: Annual financials rows (quarter=0) from Supabase
            stock: Stock profile row from stocks table

        Returns:
            (clean_rows, flags_by_year, cleaning_result)
        """
        ticker = stock.get("ticker", "UNKNOWN")
        is_bank = _is_banking_stock(stock)
        listing_year = _get_listing_year(stock)
        current_year = date.today().year

        # Sort by year ascending
        rows = sorted(financials, key=lambda r: r["year"])
        flags: Dict[int, YearFlag] = {}

        # ── Per-row rules ────────────────────────────────────────────────

        for row in rows:
            yr = row["year"]
            f = YearFlag(year=yr)

            # Rule 12: TTM/keystats data
            source = (row.get("source") or "").lower()
            if yr >= current_year and "keystats" in source:
                f.usability_flag = "use_with_caution"
                f.notes.append(f"ttm_estimate_{yr}: keystats data, not published annual report")

            # Rule 1: COVID year
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
                if f.usability_flag == "clean":
                    f.usability_flag = "use_with_caution"

            # Rule 8: Missing critical fields
            if (row.get("revenue") is None
                    and row.get("net_income") is None
                    and row.get("total_assets") is None):
                f.usability_flag = "exclude"
                f.notes.append(f"missing_critical_fields_{yr}")

            # Rule 9: One-time items (NI/OI ratio) — exempt for banks
            oi = row.get("operating_income")
            ni = row.get("net_income")
            if not is_bank and oi and ni and oi != 0 and yr != 2020:
                ratio = abs(ni / oi - 1)
                if ratio > 0.40:
                    f.has_one_time_items = True
                    f.notes.append(
                        f"one_time_{yr}: NI/OI ratio = {ni / oi:.2f}x"
                    )

            # Rule 7: Negative equity
            eq = row.get("total_equity")
            if eq is not None and eq < 0:
                if f.usability_flag == "clean":
                    f.usability_flag = "use_with_caution"
                f.notes.append(f"negative_equity_{yr}")

            # Rule 11: Banking zero-override
            if is_bank:
                for bank_metric in ("debt_to_equity", "current_ratio", "interest_coverage"):
                    val = row.get(bank_metric)
                    if val is not None and val == 0:
                        row[bank_metric] = None
                        if f"banking_zero_override_{bank_metric}" not in [n for n in f.notes]:
                            f.notes.append(
                                f"banking_zero_override: {bank_metric} set to NULL"
                            )

            # Rule 2: Restatement (DEFERRED — always FALSE)
            f.is_restated = False

            # Upgrade usability for COVID years if still clean
            if f.is_covid_year and f.usability_flag == "clean":
                f.usability_flag = "minor_issues"

            flags[yr] = f

        # ── Cross-row rules ──────────────────────────────────────────────

        # Rule 5: Income anomaly (IQR)
        ni_anomalies = _compute_iqr_anomalies(rows, "net_income")
        for yr, z in ni_anomalies.items():
            if yr in flags:
                flags[yr].has_anomaly = True
                flags[yr].anomaly_metrics.append("net_income")
                flags[yr].anomaly_scores["net_income"] = z
                flags[yr].notes.append(f"anomaly_{yr}_net_income: z={z}")

        # Rule 6: FCF anomaly (IQR)
        fcf_anomalies = _compute_iqr_anomalies(rows, "free_cash_flow")
        for yr, z in fcf_anomalies.items():
            if yr in flags:
                flags[yr].has_anomaly = True
                flags[yr].anomaly_metrics.append("free_cash_flow")
                flags[yr].anomaly_scores["free_cash_flow"] = z
                flags[yr].notes.append(f"anomaly_{yr}_free_cash_flow: z={z}")

        # Rule 9b: Revenue spike-and-drop pattern
        for i in range(1, len(rows) - 1):
            prev_rev = rows[i - 1].get("revenue")
            curr_rev = rows[i].get("revenue")
            next_rev = rows[i + 1].get("revenue")
            if prev_rev and curr_rev and next_rev and prev_rev > 0:
                yoy_up = (curr_rev - prev_rev) / prev_rev
                yoy_down = (next_rev - curr_rev) / curr_rev if curr_rev > 0 else 0
                if yoy_up > 1.0 and yoy_down < -0.50:
                    yr = rows[i]["year"]
                    if yr in flags:
                        flags[yr].has_one_time_items = True
                        flags[yr].notes.append(
                            f"revenue_spike_{yr}: +{yoy_up * 100:.0f}% YoY, "
                            f"followed by {yoy_down * 100:.0f}% in {yr + 1}"
                        )

        # Rule 3: Source conflict (simplified — single source in v1)
        sources = set(r.get("source", "unknown") for r in rows)
        if len(sources) > 1:
            # Flag overlapping years with different sources
            source_by_year = {r["year"]: r.get("source") for r in rows}
            # In v1, Stockbit is primary — just note it
            for yr, src in source_by_year.items():
                if yr in flags and src and "yfinance" in src.lower():
                    flags[yr].source_conflict = True
                    flags[yr].resolution = "stockbit_wins"

        # Rule 13: Stock split (DEFERRED — flag only)
        # Detect per-share discontinuities: EPS drops >40% while NI is flat/up
        for i in range(1, len(rows)):
            prev = rows[i - 1]
            curr = rows[i]
            prev_eps = prev.get("eps")
            curr_eps = curr.get("eps")
            prev_ni = prev.get("net_income")
            curr_ni = curr.get("net_income")
            if (prev_eps and curr_eps and prev_eps > 0 and curr_eps > 0
                    and prev_ni and curr_ni):
                eps_change = (curr_eps - prev_eps) / prev_eps
                ni_change = (curr_ni - prev_ni) / abs(prev_ni) if prev_ni != 0 else 0
                if eps_change < -0.40 and ni_change > -0.10:
                    yr = curr["year"]
                    if yr in flags:
                        flags[yr].notes.append(
                            f"possible_stock_split_{yr}: EPS {eps_change * 100:.0f}% "
                            f"while NI {ni_change * 100:+.0f}%"
                        )

        # ── Build clean rows and result ──────────────────────────────────

        clean_rows = [
            r for r in rows
            if flags.get(r["year"], YearFlag(year=0)).usability_flag != "exclude"
        ]

        excluded = sum(1 for f in flags.values() if f.usability_flag == "exclude")
        all_notes = []
        for f in flags.values():
            all_notes.extend(f.notes)

        # Determine overall quality
        caution_count = sum(1 for f in flags.values() if f.usability_flag == "use_with_caution")
        anomaly_count = sum(1 for f in flags.values() if f.has_anomaly)
        if caution_count > len(flags) * 0.3 or anomaly_count > len(flags) * 0.3:
            overall = "use_with_caution"
        elif caution_count > 0 or anomaly_count > 0:
            overall = "minor_issues"
        else:
            overall = "clean"

        result = CleaningResult(
            ticker=ticker,
            years_processed=len(rows),
            years_excluded=excluded,
            flags_set=list(set(all_notes)),
            source_conflicts=sum(1 for f in flags.values() if f.source_conflict),
            overall_quality=overall,
            ipo_excluded=any(f.is_ipo_year for f in flags.values()),
        )

        return clean_rows, flags, result

    def get_clean_financials(
        self,
        financials: List[dict],
        stock: dict,
    ) -> List[dict]:
        """
        Convenience method: returns only the clean rows (usability != 'exclude').
        Used by DataNormalizer as input.
        """
        clean_rows, _, _ = self.clean_ticker(financials, stock)
        return clean_rows
