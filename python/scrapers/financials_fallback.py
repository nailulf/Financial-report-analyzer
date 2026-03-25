from __future__ import annotations

"""
financials_fallback.py — Stockbit-based financial data (PRIMARY source).

Fetches financial data from Stockbit keystats & statement endpoints:
  - Current snapshot: TTM ratios, margins, balance sheet, cash flow figures
    → applied to the most recent annual row (quarter=0)
  - Historical revenue/net_income/eps per year+quarter (up to 10 years)
  - Full IS/BS/CF statements when a bearer token is available

Source priority: Stockbit (this file) > yfinance (financials.py fills gaps).

When run in the pipeline (--quarterly / --full), this runs FIRST.
yfinance then fills any remaining NULL fields. The merge strategy ensures
existing data is never overwritten by a secondary source.

Requires a Stockbit bearer token for full statement endpoints.
Token is managed by utils/token_manager.py — you'll be prompted
interactively when the token is missing or expired.

Run:
    cd python && python -m scrapers.financials_fallback
    cd python && python -m scrapers.financials_fallback --ticker BBRI
    cd python && python -m scrapers.financials_fallback --only-missing
    cd python && python -m scrapers.financials_fallback --dry-run
"""

import argparse
import logging
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

sys.path.insert(0, str(Path(__file__).parent.parent))

from utils.helpers import RunResult, setup_logging, safe_int, safe_float, compute_ratio
from utils.supabase_client import get_client, bulk_upsert, fetch_column, start_run, finish_run
logger = logging.getLogger(__name__)

SourceType = Literal["stockbit"]


# ===========================================================================
# Stockbit field aliases → canonical schema
#
# ⚠ These field names are inferred from community reverse-engineering of the
#   Stockbit app's network traffic. Update the alias dicts below if actual
#   API responses use different key names.
# ===========================================================================

# Income Statement field aliases: Stockbit key → canonical key
_STOCKBIT_IS_FIELDS: dict[str, str] = {
    "revenue":           "revenue",
    "pendapatan":        "revenue",          # Indonesian variant
    "cost_of_revenue":   "cost_of_revenue",
    "beban_pokok":       "cost_of_revenue",
    "gross_profit":      "gross_profit",
    "laba_kotor":        "gross_profit",
    "operating_expense": "operating_expense",
    "operating_income":  "operating_income",
    "laba_operasi":      "operating_income",
    "interest_expense":  "interest_expense",
    "pretax_income":     "income_before_tax",
    "income_before_tax": "income_before_tax",
    "income_tax":        "tax_expense",
    "tax_expense":       "tax_expense",
    "net_income":        "net_income",
    "laba_bersih":       "net_income",
    "eps":               "eps",
    "eps_basic":         "eps",
    "eps_diluted":       "eps",
}

# Balance Sheet field aliases
_STOCKBIT_BS_FIELDS: dict[str, str] = {
    "total_assets":        "total_assets",
    "aset_total":          "total_assets",
    "current_assets":      "current_assets",
    "aset_lancar":         "current_assets",
    "total_liabilities":   "total_liabilities",
    "liabilitas_total":    "total_liabilities",
    "current_liabilities": "current_liabilities",
    "liabilitas_lancar":   "current_liabilities",
    "total_equity":        "total_equity",
    "ekuitas_total":       "total_equity",
    "total_debt":          "total_debt",
    "utang_total":         "total_debt",
    "cash":                "cash_and_equivalents",
    "cash_equivalents":    "cash_and_equivalents",
    "kas":                 "cash_and_equivalents",
    "book_value":          "book_value_per_share",
    "book_value_per_share": "book_value_per_share",
}

# Cash Flow field aliases
_STOCKBIT_CF_FIELDS: dict[str, str] = {
    "operating_cashflow":           "operating_cash_flow",
    "operating_cash_flow":          "operating_cash_flow",
    "arus_kas_operasi":             "operating_cash_flow",
    "capex":                        "capex",
    "capital_expenditure":          "capex",
    "belanja_modal":                "capex",
    "free_cashflow":                "free_cash_flow",
    "free_cash_flow":               "free_cash_flow",
    "dividends_paid":               "dividends_paid",
    "dividen_dibayar":              "dividends_paid",
}

_ALL_STOCKBIT_FIELDS = {**_STOCKBIT_IS_FIELDS, **_STOCKBIT_BS_FIELDS, **_STOCKBIT_CF_FIELDS}


def _normalize_stockbit_period(row: dict) -> tuple[int, int]:
    """
    Map Stockbit period fields to (year, quarter).

    Stockbit uses:
      period="FY" or quarter=4 → annual (quarter=0)
      period="Q1".."Q4" or quarter=1..3 → respective quarter
    """
    year = int(row.get("year", 0))
    period_str = str(row.get("period", "")).upper()
    q_raw = row.get("quarter")

    period_map = {"FY": 0, "Q1": 1, "Q2": 2, "Q3": 3, "Q4": 4}
    if period_str in period_map:
        return year, period_map[period_str]

    # Fall back to raw quarter field — Stockbit may use 4 for annual
    if q_raw is not None:
        q = int(q_raw)
        # Convention: if quarter=4 and period isn't specified quarterly, treat as annual
        return year, 0 if q == 4 else q

    return year, 0


def _apply_aliases(raw: dict, alias_map: dict[str, str]) -> dict:
    """Map raw Stockbit field names to canonical names using the alias dict."""
    out: dict = {}
    for raw_key, canonical_key in alias_map.items():
        if raw_key in raw and raw.get(raw_key) is not None:
            # Don't overwrite if already set from a higher-priority alias
            if canonical_key not in out:
                out[canonical_key] = raw[raw_key]
    return out


def _normalize_stockbit_row(
    income_row: dict,
    balance_row: dict | None,
    cashflow_row: dict | None,
) -> dict | None:
    """
    Normalize three Stockbit statement dicts (same period) into one
    canonical financials row.
    """
    if not income_row:
        return None

    year, quarter = _normalize_stockbit_period(income_row)
    ticker = str(income_row.get("emitent_code", "")).upper()
    if not ticker or not year:
        return None

    # Merge all statement rows into one flat dict (income wins ties)
    merged_raw = {}
    for src in (cashflow_row or {}, balance_row or {}, income_row):
        merged_raw.update({k: v for k, v in src.items() if v is not None})

    # Apply alias mapping to get canonical field names
    canonical = _apply_aliases(merged_raw, _ALL_STOCKBIT_FIELDS)

    # Type-cast fields
    int_fields = [
        "revenue", "cost_of_revenue", "gross_profit", "operating_expense",
        "operating_income", "interest_expense", "income_before_tax",
        "tax_expense", "net_income", "total_assets", "current_assets",
        "total_liabilities", "current_liabilities", "total_equity",
        "total_debt", "cash_and_equivalents", "operating_cash_flow",
        "capex", "free_cash_flow", "dividends_paid",
    ]
    float_fields = ["eps", "book_value_per_share"]

    row: dict = {
        "ticker":  ticker,
        "year":    year,
        "quarter": quarter,
    }

    # period_end: prefer explicit date, fall back to constructing from year/quarter
    if merged_raw.get("period_end") or merged_raw.get("date"):
        row["period_end"] = merged_raw.get("period_end") or merged_raw.get("date")

    for f in int_fields:
        if f in canonical:
            row[f] = safe_int(canonical[f])

    for f in float_fields:
        if f in canonical:
            row[f] = safe_float(canonical[f])

    # Compute ratios from the raw data we just collected
    row["gross_margin"]    = compute_ratio(row.get("gross_profit"),    row.get("revenue"),     scale=100)
    row["operating_margin"]= compute_ratio(row.get("operating_income"),row.get("revenue"),     scale=100)
    row["net_margin"]      = compute_ratio(row.get("net_income"),      row.get("revenue"),     scale=100)
    row["roe"]             = compute_ratio(row.get("net_income"),      row.get("total_equity"),scale=100)
    row["roa"]             = compute_ratio(row.get("net_income"),      row.get("total_assets"),scale=100)
    row["current_ratio"]   = compute_ratio(row.get("current_assets"),  row.get("current_liabilities"))
    row["debt_to_equity"]  = compute_ratio(row.get("total_debt"),      row.get("total_equity"))

    # FCF derivation if missing
    if row.get("free_cash_flow") is None and row.get("operating_cash_flow") is not None:
        capex = row.get("capex") or 0
        row["free_cash_flow"] = safe_int(row["operating_cash_flow"] - abs(capex))

    if all(row.get(f) is None for f in ["revenue", "total_assets", "net_income"]):
        return None

    row["source"] = "stockbit"
    row["last_updated"] = datetime.now(timezone.utc).isoformat()
    return row


# ===========================================================================
# Merge layer — fill NULLs from secondary source, never overwrite
# ===========================================================================

# Fields that should never be overwritten by a secondary source
_IMMUTABLE_FIELDS = {"ticker", "year", "quarter"}

# Fields we actively try to fill via fallback
_FILLABLE_FIELDS = {
    "period_end",
    # Income Statement
    "revenue", "cost_of_revenue", "gross_profit", "operating_expense",
    "operating_income", "interest_expense", "income_before_tax",
    "tax_expense", "net_income", "eps",
    # Balance Sheet
    "total_assets", "current_assets", "total_liabilities", "current_liabilities",
    "total_equity", "total_debt", "cash_and_equivalents", "book_value_per_share",
    "short_term_debt", "long_term_debt", "net_debt", "working_capital",
    # Cash Flow
    "operating_cash_flow", "capex", "free_cash_flow", "dividends_paid",
    "investing_cash_flow", "financing_cash_flow",
    # Profitability
    "gross_margin", "operating_margin", "net_margin",
    # Returns & efficiency
    "roe", "roa", "roce", "roic",
    "interest_coverage", "asset_turnover", "inventory_turnover",
    # Solvency
    "current_ratio", "debt_to_equity",
    "lt_debt_to_equity", "financial_leverage", "debt_to_assets",
    "total_liabilities_to_equity",
    # Valuation
    "pe_ratio", "pbv_ratio", "ps_ratio", "ev_ebitda", "earnings_yield",
    # Dividend
    "dividend_yield", "payout_ratio",
}


def _merge(existing: dict | None, incoming: dict, incoming_source: str) -> dict | None:
    """
    Merge incoming row into existing (DB) row — fill NULL fields only.

    Returns a dict of fields to UPDATE (only the newly filled ones + metadata),
    or None if nothing changed.
    """
    if existing is None:
        # No existing row — incoming is a fresh insert
        return incoming

    updates: dict = {}
    for field in _FILLABLE_FIELDS:
        existing_val = existing.get(field)
        incoming_val = incoming.get(field)
        if existing_val is None and incoming_val is not None:
            updates[field] = incoming_val

    if not updates:
        return None  # nothing new to add

    # Update source to reflect multi-source contribution
    current_source = existing.get("source") or "unknown"
    if incoming_source not in current_source:
        updates["source"] = f"{current_source}+{incoming_source}"

    updates["last_updated"] = datetime.now(timezone.utc).isoformat()
    # Carry identity fields so callers can key the update
    updates["ticker"]  = existing["ticker"]
    updates["year"]    = existing["year"]
    updates["quarter"] = existing["quarter"]
    return updates


# ===========================================================================
# Period alignment helpers
# ===========================================================================

def _index_by_period(rows: list[dict]) -> dict[tuple[int, int], dict]:
    """Index a list of statement dicts by (year, quarter)."""
    out: dict = {}
    for r in rows:
        key = (int(r.get("year", 0)), int(r.get("quarter", 0)))
        if key[0]:
            out[key] = r
    return out


def _align_statements(
    income_rows: list[dict],
    balance_rows: list[dict],
    cashflow_rows: list[dict],
) -> list[tuple[dict, dict, dict]]:
    """
    Align three statement row lists by (year, quarter).
    Returns list of (income, balance, cashflow) tuples for each period
    that has at least an income row.
    """
    # Index each list by (year, quarter).

    def _period_key(row: dict) -> tuple[int, int]:
        """Extract (year, quarter) from a row."""
        if "year" in row:
            return _normalize_stockbit_period(row)
        return (0, 0)

    income_idx   = {_period_key(r): r for r in income_rows}
    balance_idx  = {_period_key(r): r for r in balance_rows}
    cashflow_idx = {_period_key(r): r for r in cashflow_rows}

    result = []
    for key, inc in income_idx.items():
        if key == (0, 0):
            continue
        result.append((inc, balance_idx.get(key, {}), cashflow_idx.get(key, {})))

    return result


# ===========================================================================
# Source fetch helpers
# ===========================================================================


_TTM_RATIO_ALIASES: dict[str, str] = {
    "pe":               "pe_ratio",
    "pe_ratio":         "pe_ratio",
    "pbv":              "pbv_ratio",
    "pbv_ratio":        "pbv_ratio",
    "roe":              "roe",
    "roa":              "roa",
    "net_margin":       "net_margin",
    "operating_margin": "operating_margin",
    "gross_margin":     "gross_margin",
    "eps":              "eps",
    "eps_ttm":          "eps",
    "current_ratio":    "current_ratio",
    "debt_to_equity":   "debt_to_equity",
    "dividend_yield":   "dividend_yield",
}


def _fetch_stockbit(ticker: str, client=None) -> list[dict]:
    """
    Fetch Stockbit data for one ticker via the keystats endpoint.

    Makes a single HTTP call via get_keystats_and_history() which returns:
      - current snapshot: TTM/current ratios, margins, and financial figures
        → stored as the most recent annual row (current_year, quarter=0)
      - historical rows: revenue, net_income, eps per year + quarter
        → stored against their matching (year, quarter) periods

    Falls back to the legacy fundamental/ttm endpoint if keystats fails.

    Returns a list of canonical row dicts (one per period), newest first.
    """
    from utils.stockbit_client import StockbitClient
    if client is None:
        client = StockbitClient()

    current_snapshot, history_rows = client.get_keystats_and_history(ticker)

    # Fall back to legacy TTM endpoint if keystats returned nothing
    if not current_snapshot:
        ttm = client.get_ttm_ratios(ticker)
        for raw_key, canonical in _TTM_RATIO_ALIASES.items():
            val = ttm.get(raw_key)
            if val is not None:
                current_snapshot[canonical] = safe_float(val, 4)

    if not current_snapshot and not history_rows:
        return []

    import datetime as _dt
    now_iso = datetime.now(timezone.utc).isoformat()
    current_year = _dt.date.today().year

    rows: list[dict] = []

    # Current snapshot → most recent annual row
    if current_snapshot:
        snap = dict(current_snapshot)
        snap.update({
            "ticker":       ticker,
            "year":         current_year,
            "quarter":      0,
            "source":       "stockbit_keystats",
            "last_updated": now_iso,
        })
        rows.append(snap)

    # Historical rows — revenue, net_income, eps per period
    for hr in history_rows:
        year, quarter = hr["year"], hr["quarter"]
        # Skip current year annual (already covered by snapshot above)
        if year == current_year and quarter == 0:
            continue
        row = {
            "ticker":       ticker,
            "year":         year,
            "quarter":      quarter,
            "source":       "stockbit_keystats",
            "last_updated": now_iso,
        }
        for field in ("revenue", "net_income", "eps"):
            if field in hr:
                row[field] = hr[field]
        rows.append(row)

    return rows


# Keep old name as alias for backward compat with any external callers
def _fetch_stockbit_ttm(ticker: str, client=None) -> dict | None:
    rows = _fetch_stockbit(ticker, client=client)
    # Return the first (most recent annual) row for callers that expect a single dict
    return rows[0] if rows else None


def _fetch_stockbit_statements(
    ticker: str,
    periods: list[str],
    limits: dict[str, int],
    client=None,
) -> list[dict]:
    """
    Fetch full IS+BS+CF statements from Stockbit when a Bearer token is configured.

    Returns list of canonical row dicts (one per period), or [] if no token is set
    or statements are unavailable.
    """
    from utils.stockbit_client import StockbitClient
    if client is None:
        client = StockbitClient()

    if not client.is_authenticated:
        return []

    rows: list[dict] = []
    for period in periods:
        limit = limits.get(period, 5)
        sb_period = "quarterly" if period == "quarterly" else "annual"
        try:
            income, balance, cashflow = client.get_all_statements(ticker, period=sb_period, limit=limit)
        except Exception as e:
            logger.warning("Stockbit statements failed for %s (%s): %s", ticker, period, e)
            continue

        aligned = _align_statements(income, balance, cashflow)
        for inc, bal, cf in aligned:
            row = _normalize_stockbit_row(inc, bal, cf)
            if row:
                rows.append(row)

    if rows:
        logger.debug("%s: Stockbit full statements returned %d rows", ticker, len(rows))
    return rows


# ===========================================================================
# Per-ticker orchestration
# ===========================================================================

def _get_existing_rows(client_db, ticker: str) -> dict[tuple[int, int], dict]:
    """
    Fetch all existing financials rows for ticker from DB, indexed by (year, quarter).

    Selects every fillable field so that _merge can correctly determine which
    fields are genuinely NULL vs. just not-selected. Without this, _merge would
    see unselected fields as None and incorrectly overwrite populated values.
    """
    fields = ",".join([
        "ticker", "year", "quarter", "source",
        # Income statement
        "period_end", "revenue", "cost_of_revenue", "gross_profit",
        "operating_expense", "operating_income", "interest_expense",
        "income_before_tax", "tax_expense", "net_income", "eps",
        # Balance sheet
        "total_assets", "current_assets", "total_liabilities",
        "current_liabilities", "total_equity", "total_debt",
        "cash_and_equivalents", "book_value_per_share",
        # Cash flow
        "operating_cash_flow", "capex", "free_cash_flow", "dividends_paid",
        # Ratios
        "gross_margin", "operating_margin", "net_margin",
        "roe", "roa", "current_ratio", "debt_to_equity",
        "pe_ratio", "pbv_ratio", "dividend_yield",
    ])
    resp = (
        client_db.table("financials")
        .select(fields)
        .eq("ticker", ticker)
        .execute()
    )
    return {(r["year"], r["quarter"]): r for r in (resp.data or [])}


def _has_core_data(row: dict) -> bool:
    """True if the row has at least one of the three core financial values."""
    return any(row.get(f) is not None for f in ["revenue", "total_assets", "net_income"])


def _process_ticker(
    db_client,
    ticker: str,
    source: SourceType,
    periods: list[str],
    limits: dict[str, int],
    only_missing: bool,
    dry_run: bool,
    stockbit_client=None,
    year_from: int | None = None,
    year_to: int | None = None,
) -> tuple[int, int, str]:
    """
    Fetch and upsert financial data for one ticker from Stockbit.
    Returns (rows_checked, rows_updated, reason).

    reason is one of:
      "ok"           — data fetched and upserted
      "no_data"      — source(s) returned no usable rows
      "skipped"      — skipped by only_missing filter
    """
    now_iso = datetime.now(timezone.utc).isoformat()
    allowed = _FILLABLE_FIELDS | _IMMUTABLE_FIELDS | {"source", "last_updated"}

    # ── only_missing: quick check if we should skip this ticker ─────────
    if only_missing:
        existing = _get_existing_rows(db_client, ticker)
        if existing:
            has_annual = any(q == 0 and _has_core_data(r) for (_, q), r in existing.items())
            has_quarterly = any(q > 0 and _has_core_data(r) for (_, q), r in existing.items())
            if has_annual and has_quarterly:
                has_any_null = any(
                    r.get(field) is None
                    for r in existing.values()
                    for field in _FILLABLE_FIELDS
                )
                if not has_any_null:
                    logger.debug("%s: all fields populated — skipping (use --all to override)", ticker)
                    return 0, 0, "skipped"

    # ── Fetch from Stockbit ─────────────────────────────────────────────
    upsert_rows: list[dict] = []

    if source in ("stockbit", "both"):
        # Try findata-view first (full HTML statements — same as web UI refresh)
        if stockbit_client and stockbit_client.is_authenticated:
            try:
                import datetime as _dt
                from utils.stockbit_fetch_cli import fetch_full_financials
                _yr_to = year_to or _dt.date.today().year
                _yr_from = year_from or (_yr_to - 10)
                fd_rows, _ = fetch_full_financials(
                    ticker, year_from=_yr_from, year_to=_yr_to, client=stockbit_client,
                )
                if fd_rows:
                    for r in fd_rows:
                        r["source"] = "stockbit"
                        r["last_updated"] = now_iso
                        # Strip fields that don't exist in the DB
                        for k in list(r.keys()):
                            if k not in allowed:
                                del r[k]
                    upsert_rows.extend(fd_rows)
                    logger.info("%s: Stockbit findata-view → %d period rows", ticker, len(fd_rows))
            except Exception as e:
                logger.warning("%s: Stockbit findata-view failed, falling back to keystats: %s", ticker, e)

        # Fall back to keystats-only if findata didn't produce rows
        if not upsert_rows:
            try:
                sb_rows = _fetch_stockbit(ticker, client=stockbit_client)
                if sb_rows:
                    upsert_rows.extend(sb_rows)
                    logger.info("%s: Stockbit keystats → %d period rows", ticker, len(sb_rows))
                else:
                    logger.info("%s: Stockbit keystats returned no data", ticker)
            except Exception as e:
                logger.info("Stockbit keystats unavailable for %s: %s", ticker, e)

    if not upsert_rows:
        return 0, 0, "no_data"

    # ── Direct upsert — same as web refresh flow (no merge, just write) ─
    if not dry_run:
        bulk_upsert("financials", upsert_rows, on_conflict="ticker,year,quarter")

    return len(upsert_rows), len(upsert_rows), "ok"


# ===========================================================================
# Public entry point
# ===========================================================================

def run(
    tickers: list[str] | None = None,
    source: SourceType = "stockbit",
    only_missing: bool = True,
    annual: bool = True,
    quarterly: bool = True,
    dry_run: bool = False,
    year_from: int | None = None,
    year_to: int | None = None,
) -> RunResult:
    """
    Fetch financial data from Stockbit and upsert into the financials table.

    Args:
        tickers:      Limit to these tickers. None = all active stocks.
        source:       Data source — currently only 'stockbit'.
        only_missing: If True, skip tickers that already have complete data.
        annual:       Fetch annual periods.
        quarterly:    Fetch quarterly periods.
        dry_run:      Preview only, do not write to the database.
        year_from:    Earliest fiscal year to fetch (default: current_year - 10).
        year_to:      Latest fiscal year to fetch (default: current_year).
    """
    result = RunResult("financials_fallback")
    run_id = start_run(
        "financials_fallback",
        metadata={
            "source": source,
            "only_missing": only_missing,
            "annual": annual,
            "quarterly": quarterly,
            "dry_run": dry_run,
        },
    )

    db_client = get_client()

    if tickers:
        ticker_list = [t.upper() for t in tickers]
    else:
        ticker_list = fetch_column("stocks", "ticker", filters={"status": "Active"})
        if not ticker_list:
            logger.error("No active stocks found. Run stock_universe.py first.")
            finish_run(run_id, "failed", error_message="stocks table empty")
            return result

    periods = []
    if annual:
        periods.append("annual")
    if quarterly:
        periods.append("quarterly")

    limits = {"annual": 10, "quarterly": 8}

    logger.info(
        "Financials fallback: %d tickers, source=%s, periods=%s%s%s",
        len(ticker_list), source, periods,
        " [only-missing]" if only_missing else "",
        " [DRY RUN]" if dry_run else "",
    )

    stockbit_client = None
    if source in ("stockbit", "both"):
        try:
            from utils.stockbit_client import StockbitClient
            stockbit_client = StockbitClient()
            logger.info(
                "Stockbit: using keystats endpoint (exodus.stockbit.com) — "
                "ratios, margins, and TTM/Quarter financial figures"
            )
        except Exception as e:
            logger.debug("Stockbit client init failed: %s", e)

    total_checked = 0
    total_updated = 0

    for i, ticker in enumerate(ticker_list, 1):
        try:
            checked, updated, reason = _process_ticker(
                db_client=db_client,
                ticker=ticker,
                source=source,
                periods=periods,
                limits=limits,
                only_missing=only_missing,
                dry_run=dry_run,
                stockbit_client=stockbit_client,
                year_from=year_from,
                year_to=year_to,
            )
            total_checked += checked
            total_updated += updated

            if reason == "ok":
                logger.info(
                    "[%d/%d] %s: filled %d/%d period rows",
                    i, len(ticker_list), ticker, updated, checked,
                )
                result.ok(ticker)
            elif reason == "complete":
                logger.info("[%d/%d] %s: already complete — no new fields to fill", i, len(ticker_list), ticker)
                result.ok(ticker)
            elif reason == "no_data":
                logger.info("[%d/%d] %s: source(s) returned no usable rows", i, len(ticker_list), ticker)
                result.skip(ticker, "no data from source(s)")
            else:  # "skipped"
                logger.debug("[%d/%d] %s: skipped by only_missing filter", i, len(ticker_list), ticker)
                result.skip(ticker, "already has annual+quarterly data")

        except Exception as e:
            logger.warning("Failed %s: %s", ticker, e)
            result.fail(ticker, str(e))

        # Brief pause between tickers
        if i % 50 == 0:
            time.sleep(1.0)

    logger.info(
        "Fallback complete: %d periods checked, %d periods enriched across %d tickers",
        total_checked, total_updated, len(ticker_list),
    )

    result.print_summary()
    finish_run(run_id, **result.to_db_kwargs())
    return result


# ===========================================================================
# Entry point
# ===========================================================================

if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Financial data fallback — Stockbit backfill for incomplete IDX stocks",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python -m scrapers.financials_fallback                   # all stocks
  python -m scrapers.financials_fallback --ticker BBRI ASII
  python -m scrapers.financials_fallback --only-missing    # skip already-complete tickers
  python -m scrapers.financials_fallback --annual-only     # skip quarterly
  python -m scrapers.financials_fallback --dry-run         # compute merges, no writes
        """,
    )
    parser.add_argument("--ticker", nargs="+", help="Limit to specific tickers")
    parser.add_argument(
        "--only-missing",
        action="store_true",
        default=True,
        help="Skip tickers that already have complete data (default: True)",
    )
    parser.add_argument(
        "--all",
        dest="only_missing",
        action="store_false",
        help="Process all tickers even if data already exists",
    )
    parser.add_argument("--annual-only", action="store_true", help="Fetch annual data only")
    parser.add_argument("--quarterly-only", action="store_true", help="Fetch quarterly data only")
    parser.add_argument("--dry-run", action="store_true", help="Preview only, do not write to DB")
    parser.add_argument("--year-from", type=int, default=None, help="Earliest fiscal year (default: current - 10)")
    parser.add_argument("--year-to", type=int, default=None, help="Latest fiscal year (default: current)")
    args = parser.parse_args()

    setup_logging("financials_fallback")
    run(
        tickers=args.ticker,
        source="stockbit",
        only_missing=args.only_missing,
        annual=not args.quarterly_only,
        quarterly=not args.annual_only,
        dry_run=args.dry_run,
        year_from=args.year_from,
        year_to=args.year_to,
    )
