from __future__ import annotations

"""
score_calculator.py — Compute data completeness and confidence scores for IDX stocks.

Completeness score (1–100):
    Read from v_data_completeness SQL view (computed in SQL for consistency).
    Phase 1 max: 80 pts (20 pts reserved for Phase 2 categories).

Confidence score (0–100):
    Computed in Python for flexibility. Five factors:
    1. Data freshness        (25 pts)
    2. Source reliability    (20 pts)
    3. Sanity checks         (30 pts, 10 checks × 3 pts)
    4. Cross-source          (15 pts — Phase 1: 7 pts default, single source)
    5. Scraper success rate  (10 pts)

Both scores are persisted to stocks.completeness_score and stocks.confidence_score
after every scraper run.
"""

import logging
from datetime import date, datetime, timezone

logger = logging.getLogger(__name__)

SCORE_VERSION = "v1"

# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _today() -> date:
    return date.today()


def _days_since_date(d: date | None) -> int | None:
    if d is None:
        return None
    return (_today() - d).days


def _days_since_iso(iso: str | None) -> int | None:
    if not iso:
        return None
    dt = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    return (datetime.now(timezone.utc) - dt).days


# ===========================================================================
# Factor 1: Data Freshness (max 25 pts)
# ===========================================================================

def _freshness_score(ticker: str) -> tuple[int, str]:
    from utils.supabase_client import get_client
    client = get_client()
    pts = 0
    parts: list[str] = []

    # Price freshness — 10 pts
    price_resp = (
        client.table("daily_prices")
        .select("date")
        .eq("ticker", ticker)
        .order("date", desc=True)
        .limit(1)
        .execute()
    )
    if price_resp.data:
        latest = date.fromisoformat(price_resp.data[0]["date"])
        age = (_today() - latest).days
        if age <= 2:
            pts += 10
        elif age <= 7:
            pts += 6
        elif age <= 30:
            pts += 3
        parts.append(f"price {age}d ago")
    else:
        parts.append("no price")

    # Annual financials freshness — 8 pts
    fin_resp = (
        client.table("financials")
        .select("year")
        .eq("ticker", ticker)
        .eq("quarter", 0)
        .order("year", desc=True)
        .limit(1)
        .execute()
    )
    if fin_resp.data:
        yr = fin_resp.data[0]["year"]
        current_yr = _today().year
        if yr >= current_yr - 1:
            pts += 8
        elif yr >= current_yr - 2:
            pts += 4
        parts.append(f"annual {yr}")
    else:
        parts.append("no annual")

    # Quarterly financials freshness — 4 pts
    q_resp = (
        client.table("financials")
        .select("year, quarter, period_end")
        .eq("ticker", ticker)
        .gt("quarter", 0)
        .order("year", desc=True)
        .order("quarter", desc=True)
        .limit(1)
        .execute()
    )
    if q_resp.data:
        row = q_resp.data[0]
        if row.get("period_end"):
            period_end = date.fromisoformat(row["period_end"])
            # Full score if we have data within 90 days of its period end
            age = (_today() - period_end).days
            if age <= 90:
                pts += 4
            elif age <= 180:
                pts += 2
            parts.append(f"Q{row['quarter']}/{row['year']}")
        else:
            pts += 2  # have data, no period_end
            parts.append(f"Q{row['quarter']}/{row['year']} (no period_end)")
    else:
        parts.append("no quarterly")

    # Company profile freshness — 3 pts
    prof_resp = (
        client.table("company_profiles")
        .select("last_updated")
        .eq("ticker", ticker)
        .execute()
    )
    if prof_resp.data and prof_resp.data[0].get("last_updated"):
        age = _days_since_iso(prof_resp.data[0]["last_updated"])
        if age is not None:
            if age <= 180:
                pts += 3
            elif age <= 365:
                pts += 1
        parts.append(f"profile {age}d ago")
    else:
        parts.append("no profile")

    return min(pts, 25), "; ".join(parts)


# ===========================================================================
# Factor 2: Source Reliability (max 20 pts)
# ===========================================================================

def _source_score(ticker: str) -> tuple[int, str]:
    from utils.supabase_client import get_client
    client = get_client()

    resp = (
        client.table("financials")
        .select("source, year")
        .eq("ticker", ticker)
        .eq("quarter", 0)
        .order("year", desc=True)
        .limit(5)
        .execute()
    )
    rows = resp.data or []
    if not rows:
        return 0, "no financial data"

    sources = {r["source"] for r in rows if r.get("source")}
    years = len(rows)

    if "idx" in sources:
        return 20, f"IDX official (years={years})"
    if years >= 3:
        return 14, f"yfinance ≥3yr (years={years})"
    if years >= 1:
        return 8, f"yfinance <3yr (years={years})"
    return 0, "no financial data"


# ===========================================================================
# Factor 3: Sanity Checks (max 30 pts — 10 checks × 3 pts each)
# ===========================================================================

def _sanity_checks(ticker: str, listed_shares: int | None) -> tuple[int, list[str]]:
    from utils.supabase_client import get_client
    client = get_client()

    resp = (
        client.table("financials")
        .select(
            "year, revenue, net_income, total_assets, total_liabilities, total_equity, "
            "eps, free_cash_flow, operating_cash_flow, capex, pe_ratio, pbv_ratio, period_end"
        )
        .eq("ticker", ticker)
        .eq("quarter", 0)
        .order("year", desc=True)
        .limit(5)
        .execute()
    )
    rows = resp.data or []
    passed = 0
    failed: list[str] = []

    # S1: Revenue positive
    if rows:
        rev_neg = [r["year"] for r in rows if r.get("revenue") is not None and r["revenue"] <= 0]
        if not rev_neg:
            passed += 1
        else:
            failed.append(f"S1: revenue ≤0 in {rev_neg}")
    else:
        passed += 1

    # S2: |net_income| ≤ revenue
    if rows:
        fail_yrs = [
            r["year"] for r in rows
            if r.get("revenue") and r.get("net_income") is not None
            and abs(r["net_income"]) > abs(r["revenue"])
        ]
        if not fail_yrs:
            passed += 1
        else:
            failed.append(f"S2: |net_income| > revenue in {fail_yrs}")
    else:
        passed += 1

    # S3: Balance sheet identity (assets ≈ liabilities + equity, within 5%)
    if rows:
        fail_yrs = []
        for r in rows:
            a = r.get("total_assets")
            l_ = r.get("total_liabilities")
            e = r.get("total_equity")
            if a and l_ is not None and e is not None and a > 0:
                diff_pct = abs(a - (l_ + e)) / a
                if diff_pct > 0.05:
                    fail_yrs.append(f"{r['year']}({diff_pct:.0%})")
        if not fail_yrs:
            passed += 1
        else:
            failed.append(f"S3: balance sheet off >5%: {fail_yrs}")
    else:
        passed += 1

    # S4: EPS consistent with net_income / listed_shares (within 10%)
    if rows and listed_shares and listed_shares > 0:
        fail_yrs = []
        for r in rows:
            eps = r.get("eps")
            ni = r.get("net_income")
            if eps and ni and eps != 0:
                computed = ni / listed_shares
                if abs(eps - computed) / abs(eps) > 0.10:
                    fail_yrs.append(r["year"])
        if not fail_yrs:
            passed += 1
        else:
            failed.append(f"S4: EPS inconsistent with net_income/shares in {fail_yrs}")
    else:
        passed += 1  # can't check without shares data

    # S5: Financial year sequence — no gap > 2 years
    if len(rows) >= 2:
        years = sorted([r["year"] for r in rows])
        gaps = [years[i + 1] - years[i] for i in range(len(years) - 1)]
        if all(1 <= g <= 2 for g in gaps):
            passed += 1
        else:
            failed.append(f"S5: year gaps in financial history: {gaps}")
    else:
        passed += 1

    # S6: No duplicate periods (enforced by DB UNIQUE constraint — always passes)
    passed += 1

    # S7: P/E ratio in realistic range (0, 500) if not null
    if rows:
        pe = rows[0].get("pe_ratio")
        if pe is None or 0 < pe < 500:
            passed += 1
        else:
            failed.append(f"S7: P/E {pe} outside (0, 500)")
    else:
        passed += 1

    # S8: P/BV ratio in realistic range (0, 100) if not null
    if rows:
        pbv = rows[0].get("pbv_ratio")
        if pbv is None or 0 < pbv < 100:
            passed += 1
        else:
            failed.append(f"S8: P/BV {pbv} outside (0, 100)")
    else:
        passed += 1

    # S9: Equity non-negative in latest annual (flag only)
    if rows:
        equity = rows[0].get("total_equity")
        if equity is None or equity > 0:
            passed += 1
        else:
            failed.append(f"S9: negative equity ({equity:,})")
    else:
        passed += 1

    # S10: FCF derivable from operating_cash_flow − capex (within 10%)
    if rows:
        fail_yrs = []
        for r in rows:
            fcf = r.get("free_cash_flow")
            ocf = r.get("operating_cash_flow")
            cap = r.get("capex")
            if fcf and ocf is not None and cap is not None and fcf != 0:
                # capex may be stored as negative or positive
                for sign in (1, -1):
                    computed = ocf + sign * abs(cap)
                    if abs(fcf - computed) / abs(fcf) <= 0.10:
                        break
                else:
                    fail_yrs.append(r["year"])
        if not fail_yrs:
            passed += 1
        else:
            failed.append(f"S10: FCF ≠ OCF−CAPEX in {fail_yrs}")
    else:
        passed += 1

    return min(passed * 3, 30), failed


# ===========================================================================
# Factor 4: Cross-Source Consistency (max 15 pts)
# Phase 1: single source (yfinance), award 7 pts by default
# ===========================================================================

def _cross_source_score(_ticker: str) -> tuple[int, str]:
    return 7, "single source — no cross-validation available yet"


# ===========================================================================
# Factor 5: Scraper Success Rate (max 10 pts — 2 pts per scraper)
# ===========================================================================

def _scraper_success_score(_ticker: str) -> tuple[int, str]:
    from utils.supabase_client import get_client
    client = get_client()

    scrapers = ["stock_universe", "daily_prices", "financials", "company_profiles", "money_flow"]

    resp = (
        client.table("scraper_runs")
        .select("scraper_name, status")
        .in_("scraper_name", scrapers)
        .order("started_at", desc=True)
        .limit(25)
        .execute()
    )

    # Latest status per scraper
    seen: dict[str, str] = {}
    for row in (resp.data or []):
        name = row["scraper_name"]
        if name not in seen:
            seen[name] = row["status"]

    pts = 0
    issues: list[str] = []
    for s in scrapers:
        status = seen.get(s, "never_run")
        if status == "success":
            pts += 2
        elif status == "partial":
            pts += 1
            issues.append(f"{s}(partial)")
        else:
            issues.append(f"{s}({status})")

    detail = f"{pts}/10 pts"
    if issues:
        detail += f"; issues: {', '.join(issues)}"
    return min(pts, 10), detail


# ===========================================================================
# Public API
# ===========================================================================

def compute_confidence_score(
    ticker: str,
    listed_shares: int | None = None,
) -> tuple[int, dict]:
    """
    Compute confidence score (0–100) for a single ticker.

    Returns:
        (total_score, breakdown_dict)
    """
    freshness_pts, freshness_detail   = _freshness_score(ticker)
    source_pts,    source_detail      = _source_score(ticker)
    sanity_pts,    failed_checks      = _sanity_checks(ticker, listed_shares)
    cross_pts,     cross_detail       = _cross_source_score(ticker)
    scraper_pts,   scraper_detail     = _scraper_success_score(ticker)

    total = freshness_pts + source_pts + sanity_pts + cross_pts + scraper_pts

    breakdown = {
        "freshness": {
            "score": freshness_pts, "max": 25, "detail": freshness_detail,
        },
        "source": {
            "score": source_pts, "max": 20, "detail": source_detail,
        },
        "sanity_checks": {
            "score": sanity_pts,
            "max": 30,
            "detail": f"{sanity_pts // 3}/10 checks passed",
            "failed_checks": failed_checks,
        },
        "cross_source": {
            "score": cross_pts, "max": 15, "detail": cross_detail,
        },
        "scraper_success": {
            "score": scraper_pts, "max": 10, "detail": scraper_detail,
        },
    }
    return total, breakdown


def update_scores_for_ticker(ticker: str) -> None:
    """
    Compute and persist completeness + confidence scores for a single ticker.
    Called after any per-ticker scraper run.
    """
    from utils.supabase_client import get_client
    client = get_client()

    # 1. Completeness from SQL view
    compl_resp = (
        client.table("v_data_completeness")
        .select("completeness_score")
        .eq("ticker", ticker)
        .execute()
    )
    completeness = 1
    if compl_resp.data:
        completeness = compl_resp.data[0].get("completeness_score") or 1

    # 2. listed_shares for EPS sanity check
    stock_resp = (
        client.table("stocks")
        .select("listed_shares")
        .eq("ticker", ticker)
        .execute()
    )
    listed_shares: int | None = None
    if stock_resp.data:
        listed_shares = stock_resp.data[0].get("listed_shares")

    # 3. Confidence
    confidence, _ = compute_confidence_score(ticker, listed_shares)

    # 4. Persist
    client.table("stocks").update({
        "completeness_score": completeness,
        "confidence_score":   confidence,
        "score_version":      SCORE_VERSION,
        "scores_updated_at":  datetime.now(timezone.utc).isoformat(),
    }).eq("ticker", ticker).execute()

    logger.info(
        "Scores updated for %s: completeness=%d confidence=%d",
        ticker, completeness, confidence,
    )


def update_all_scores(batch_size: int = 100) -> None:
    """
    Compute and persist scores for all active stocks.
    Called after a full pipeline run.
    """
    from utils.supabase_client import get_client, bulk_upsert
    client = get_client()

    stocks_resp = (
        client.table("stocks")
        .select("ticker, listed_shares")
        .eq("status", "Active")
        .execute()
    )
    stocks = stocks_resp.data or []
    logger.info("Computing scores for %d active stocks…", len(stocks))

    updates: list[dict] = []
    now_iso = datetime.now(timezone.utc).isoformat()

    for stock in stocks:
        ticker = stock["ticker"]
        listed_shares = stock.get("listed_shares")
        try:
            compl_resp = (
                client.table("v_data_completeness")
                .select("completeness_score")
                .eq("ticker", ticker)
                .execute()
            )
            completeness = 1
            if compl_resp.data:
                completeness = compl_resp.data[0].get("completeness_score") or 1

            confidence, _ = compute_confidence_score(ticker, listed_shares)

            updates.append({
                "ticker":              ticker,
                "completeness_score":  completeness,
                "confidence_score":    confidence,
                "score_version":       SCORE_VERSION,
                "scores_updated_at":   now_iso,
            })
        except Exception as exc:
            logger.warning("Failed to compute scores for %s: %s", ticker, exc)

    bulk_upsert("stocks", updates, "ticker", batch_size=batch_size)
    logger.info("Score update complete for %d stocks.", len(updates))
