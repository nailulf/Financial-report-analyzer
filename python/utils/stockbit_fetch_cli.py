#!/usr/bin/env python3
"""
CLI wrapper for Stockbit financial data fetch.

Uses two Stockbit APIs:
  1. findata-view  — full quarterly & annual IS / BS / CF statements
  2. keystats      — current snapshot (TTM valuation, dividend, margins)

Called by the Next.js API route via child_process.spawn.

Usage:
    python stockbit_fetch_cli.py --ticker BBRI --bearer-token <token> \
        --year-from 2019 --year-to 2024

Outputs a single JSON object to stdout:
    { "rows": [...], "snapshot": {...} }

Errors are printed to stderr and the script exits with code 1.
"""

from __future__ import annotations

import argparse
import datetime
import json
import sys
from html.parser import HTMLParser
from typing import Any

# Completed fiscal years only — Stockbit labels the TTM column with the current
# calendar year (e.g. "12M26"), which is NOT a real FY and must be excluded.
_CURRENT_YEAR: int = datetime.date.today().year


# ── DB column sets ────────────────────────────────────────────────────────────

# BIGINT columns — store raw IDR integer amounts
INT_COLS: set[str] = {
    "revenue", "gross_profit", "operating_income", "net_income",
    "total_assets", "current_assets",
    "total_liabilities", "current_liabilities", "total_equity",
    "cash_and_equivalents", "short_term_debt", "long_term_debt",
    "total_debt", "net_debt", "working_capital",
    "operating_cash_flow", "investing_cash_flow", "financing_cash_flow",
    "capex", "free_cash_flow",
}


# ── Label → DB column maps ────────────────────────────────────────────────────

IS_MAP: dict[str, str] = {
    # Core P&L
    "Total Revenue":                            "revenue",
    "Gross Profit":                             "gross_profit",
    "Income From Operations":                   "operating_income",
    "Net Income For The Period":                "net_income",
    # Per-share
    "EPS (Quarter)":                            "eps",
    "EPS (Annual)":                             "eps",
    "EPS (TTM)":                                "eps",
    "EPS (TTM YoY Growth)":                     "eps",
    # Profitability ratios (available on IS statement)
    "Return on Assets (Quarter)":               "roa",
    "Return on Equity (Quarter)":               "roe",
    "Return on Capital Employed (Quarter)":     "roce",
    "Interest Coverage (Quarter)":              "interest_coverage",
    "PE Ratio (Quarter)":                       "pe_ratio",
    "Price to Sales (Quarter)":                 "ps_ratio",
    # Annual variants
    "Return on Assets (Annual)":                "roa",
    "Return on Equity (Annual)":                "roe",
    "Return on Capital Employed (Annual)":      "roce",
    "Interest Coverage (Annual)":               "interest_coverage",
    "PE Ratio (Annual)":                        "pe_ratio",
    "Price to Sales (Annual)":                  "ps_ratio",
    # TTM variants (statement_type=3 / Cash Flow view)
    "Return on Assets (TTM)":                   "roa",
    "Return on Equity (TTM)":                   "roe",
    "Return on Capital Employed (TTM)":         "roce",
    "Interest Coverage (TTM)":                  "interest_coverage",
    "PE Ratio (TTM)":                           "pe_ratio",
    "Price to Sales (TTM)":                     "ps_ratio",
}

BS_MAP: dict[str, str] = {
    # Balance sheet totals (header/summary rows)
    "Assets":                                   "total_assets",
    "Current Assets":                           "current_assets",
    "Liabilities":                              "total_liabilities",
    "Current Liabilities":                      "current_liabilities",
    "Equity":                                   "total_equity",
    # Balance sheet line items
    "Cash And Cash Equivalents":                "cash_and_equivalents",
    # Computed metrics (Quarter)
    "Short-term Debt (Quarter)":                "short_term_debt",
    "Long-term Debt (Quarter)":                 "long_term_debt",
    "Total Debt (Quarter)":                     "total_debt",
    "Net Debt (Quarter)":                       "net_debt",
    "Working Capital (Quarter)":                "working_capital",
    "Book Value Per Share (Quarter)":           "book_value_per_share",
    "Price to Book Value (Quarter)":            "pbv_ratio",
    "Current Ratio (Quarter)":                  "current_ratio",
    "Quick Ratio (Quarter)":                    "quick_ratio",
    "Debt to Equity Ratio (Quarter)":           "debt_to_equity",
    "Financial Leverage (Quarter)":             "financial_leverage",
    "LT Debt/Equity (Quarter)":                 "lt_debt_to_equity",
    "Total Debt/Total Assets (Quarter)":        "debt_to_assets",
    "Total Liabilities/Equity (Quarter)":       "total_liabilities_to_equity",
    "Asset Turnover (Quarter)":                 "asset_turnover",
    "Inventory Turnover (Quarter)":             "inventory_turnover",
}

CF_MAP: dict[str, str] = {
    # Computed quarter-specific amounts (preferred over raw YTD items)
    "Operating Cash Flow (Quarter)":            "operating_cash_flow",
    "Capital expenditure (Quarter)":            "capex",
    "Free cash flow (Quarter)":                 "free_cash_flow",
    # Raw section totals (fallback)
    "Cash From Operating":                      "operating_cash_flow",
    "Cash From Investing":                      "investing_cash_flow",
    "Cash From Financing":                      "financing_cash_flow",
}

# Current-snapshot fields from keystats (TTM / current valuation)
SNAPSHOT_MAP: dict[str, str] = {
    "Revenue (TTM)":                            "revenue",
    "Gross Profit (TTM)":                       "gross_profit",
    "Net Income (TTM)":                         "net_income",
    "Current EPS (TTM)":                        "eps",
    "Current EPS (Annualised)":                 "eps",
    "Current Book Value Per Share":             "book_value_per_share",
    "Cash (Quarter)":                           "cash_and_equivalents",
    "Total Assets (Quarter)":                   "total_assets",
    "Total Liabilities (Quarter)":              "total_liabilities",
    "Total Equity":                             "total_equity",
    "Common Equity":                            "total_equity",
    "Total Debt (Quarter)":                     "total_debt",
    "Working Capital (Quarter)":                "working_capital",
    "Long-term Debt (Quarter)":                 "long_term_debt",
    "Short-term Debt (Quarter)":                "short_term_debt",
    "Net Debt (Quarter)":                       "net_debt",
    "Cash From Operations (TTM)":               "operating_cash_flow",
    "Cash From Investing (TTM)":                "investing_cash_flow",
    "Cash From Financing (TTM)":                "financing_cash_flow",
    "Capital expenditure (TTM)":                "capex",
    "Free cash flow (TTM)":                     "free_cash_flow",
    "Gross Profit Margin (Quarter)":            "gross_margin",
    "Operating Profit Margin (Quarter)":        "operating_margin",
    "Net Profit Margin (Quarter)":              "net_margin",
    "Return on Equity (TTM)":                   "roe",
    "Return on Assets (TTM)":                   "roa",
    "Return on Capital Employed (TTM)":         "roce",
    "Return On Invested Capital (TTM)":         "roic",
    "Asset Turnover (TTM)":                     "asset_turnover",
    "Inventory Turnover (TTM)":                 "inventory_turnover",
    "Interest Coverage (TTM)":                  "interest_coverage",
    "Current Ratio (Quarter)":                  "current_ratio",
    "Quick Ratio (Quarter)":                    "quick_ratio",
    "Debt to Equity Ratio (Quarter)":           "debt_to_equity",
    "LT Debt/Equity (Quarter)":                 "lt_debt_to_equity",
    "Total Liabilities/Equity (Quarter)":       "total_liabilities_to_equity",
    "Total Debt/Total Assets (Quarter)":        "debt_to_assets",
    "Financial Leverage (Quarter)":             "financial_leverage",
    "Current PE Ratio (TTM)":                   "pe_ratio",
    "Current PE Ratio (Annualised)":            "pe_ratio",
    "Current Price to Book Value":              "pbv_ratio",
    "Current Price to Sales (TTM)":             "ps_ratio",
    "EV to EBITDA (TTM)":                       "ev_ebitda",
    "Earnings Yield (TTM)":                     "earnings_yield",
    "Dividend Yield":                           "dividend_yield",
    "Payout Ratio":                             "payout_ratio",
}
SNAPSHOT_INT_COLS = INT_COLS  # same set


# ── HTML table parser ─────────────────────────────────────────────────────────

class _FinTableParser(HTMLParser):
    """Parses first <table> in a Stockbit findata-view HTML fragment."""

    def __init__(self) -> None:
        super().__init__()
        self.headers: list[str] = []           # period labels e.g. Q121, 12M24
        self.rows: list[tuple[str, list[tuple[str, str]]]] = []  # (full_label, [(raw, idr), ...])
        self._in_thead = False
        self._in_tbody = False
        self._headers_locked = False           # freeze headers after first thead
        self._cur_label: str = ""
        self._cur_vals: list[tuple[str, str]] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        d = dict(attrs)
        if tag == "thead":
            self._in_thead = True
        elif tag == "tbody":
            self._in_tbody = True
            self._in_thead = False
        elif tag == "tr" and self._in_tbody:
            self._cur_label = ""
            self._cur_vals = []
        elif tag == "th" and self._in_thead and "periods-list" in (d.get("class") or ""):
            if not self._headers_locked:
                lbl = d.get("data-label") or ""
                if lbl:
                    self.headers.append(lbl)
        elif tag == "span" and "acc-name" in (d.get("class") or ""):
            self._cur_label = d.get("data-lang-1-full") or d.get("data-lang-1") or ""
        elif tag == "td" and (
            "rowval" in (d.get("class") or "")
            or "row-ratio-val" in (d.get("class") or "")
        ):
            raw = d.get("data-raw") or "-"
            idr = d.get("data-value-idr") or "0"
            self._cur_vals.append((raw, idr))

    def handle_endtag(self, tag: str) -> None:
        if tag == "thead":
            self._in_thead = False
            self._headers_locked = True        # only capture periods from first table
        elif tag == "tbody":
            self._in_tbody = False
        elif tag == "tr" and self._in_tbody:
            if self._cur_label and self._cur_vals:
                self.rows.append((self._cur_label, list(self._cur_vals)))


def _parse_period(label: str) -> tuple[int, int] | None:
    """Q121 → (2021, 1),  12M24 → (2024, 0),  else None."""
    if label.startswith("Q") and len(label) >= 4:
        try:
            quarter = int(label[1])
            year    = 2000 + int(label[2:])
            return year, quarter
        except ValueError:
            return None
    if label.startswith("12M") and len(label) >= 5:
        try:
            year = 2000 + int(label[3:])
            return year, 0
        except ValueError:
            return None
    return None


def parse_findata_html(
    html: str,
    label_map: dict[str, str],
) -> dict[str, dict[str, Any]]:
    """Parse findata-view HTML → {period_key: {field: value}}."""
    parser = _FinTableParser()
    parser.feed(html)

    result: dict[str, dict[str, Any]] = {}
    seen_cols: dict[str, set[str]] = {}  # period_key → already-written cols (first-write wins)

    for full_label, vals in parser.rows:
        col = label_map.get(full_label)
        if not col:
            continue
        for i, (raw, idr) in enumerate(vals):
            if i >= len(parser.headers):
                break
            if raw == "-":
                continue
            parsed = _parse_period(parser.headers[i])
            if parsed is None:
                continue
            yr, q = parsed
            pk = f"{yr}_{q}"

            if pk not in result:
                result[pk] = {"year": yr, "quarter": q}
                seen_cols[pk] = set()

            # First-write wins (e.g. prefer "(Quarter)" over "(Annual)" fallbacks)
            if col in seen_cols[pk]:
                continue
            seen_cols[pk].add(col)

            if col in INT_COLS:
                # idr is sometimes a float string (e.g. "-4570156788168.000000")
                try:
                    val: Any = int(idr)
                except ValueError:
                    try:
                        val = round(float(idr))
                    except ValueError:
                        continue
            else:
                try:
                    val = round(float(raw), 4)
                except ValueError:
                    continue
            result[pk][col] = val

    return result


# ── Keystats snapshot parser ──────────────────────────────────────────────────

def _parse_snap_value(raw: str | None) -> float | None:
    if not raw:
        return None
    s = str(raw).strip()
    if s in ("-", "—", "N/A", ""):
        return None
    neg = s.startswith("(") and s.endswith(")")
    if neg:
        s = s[1:-1]
    s = s.replace(",", "")
    mult = 1.0
    if s.endswith(" B"):
        s, mult = s[:-2], 1e9
    elif s.endswith("%"):
        s = s[:-1]
    try:
        v = float(s) * mult
        return -v if neg else v
    except ValueError:
        return None


def parse_keystats_snapshot(raw_data: dict) -> dict[str, Any]:
    snapshot: dict[str, Any] = {}
    for group in raw_data.get("closure_fin_items_results") or []:
        for entry in group.get("fin_name_results") or []:
            fitem     = entry.get("fitem") or {}
            col       = SNAPSHOT_MAP.get(fitem.get("name", ""))
            if not col or col in snapshot:
                continue
            val = _parse_snap_value(fitem.get("value"))
            if val is None:
                continue
            snapshot[col] = round(val) if col in SNAPSHOT_INT_COLS else round(val, 4)
    return snapshot


# ── Reusable core logic ──────────────────────────────────────────────────────

def fetch_full_financials(
    ticker: str,
    year_from: int,
    year_to: int,
    client: Any = None,
) -> tuple[list[dict], dict]:
    """
    Fetch complete financial data for a ticker using findata-view + keystats.

    Uses the same rich endpoints as the Stockbit web UI:
    - findata-view HTML tables (IS, BS, CF — quarterly + annual)
    - keystats current snapshot (TTM valuation, margins, ratios)
    - Derives annual BS from Q4, annual IS/CF by summing quarters
    - Computes margins from raw P&L values

    Args:
        ticker:    IDX ticker code (e.g. 'BBRI')
        year_from: Earliest fiscal year to include
        year_to:   Latest fiscal year to include
        client:    StockbitClient instance (optional, created if None)

    Returns:
        (rows, snapshot) where rows is a list of period dicts sorted newest-first,
        and snapshot is the current TTM/valuation dict.
    """
    if client is None:
        from utils.stockbit_client import StockbitClient
        client = StockbitClient(prompt_for_token=False)

    current_year = _CURRENT_YEAR

    # ── Fetch all HTML statement tables ─────────────────────────────────────
    is_q_html = client.get_findata_html(ticker, report_type=1, statement_type=1)  # IS quarterly
    is_a_html = client.get_findata_html(ticker, report_type=1, statement_type=2)  # IS annual
    bs_q_html = client.get_findata_html(ticker, report_type=2, statement_type=1)  # BS quarterly
    cf_q_html = client.get_findata_html(ticker, report_type=3, statement_type=1)  # CF quarterly

    # ── Parse each statement ────────────────────────────────────────────────
    is_q = parse_findata_html(is_q_html, IS_MAP)
    is_a = parse_findata_html(is_a_html, IS_MAP)
    bs_q = parse_findata_html(bs_q_html, BS_MAP)
    cf_q = parse_findata_html(cf_q_html, CF_MAP)

    # ── Fetch keystats for current snapshot ─────────────────────────────────
    snapshot = client.get_keystats(ticker)

    # ── Merge into unified period dict ──────────────────────────────────────
    period_data: dict[str, dict[str, Any]] = {}
    completed_annual_years: set[int] = set()
    for source in (is_q, bs_q, cf_q):
        for fields in source.values():
            if fields.get("quarter") == 4:
                completed_annual_years.add(fields["year"])

    def merge_into(source: dict[str, dict[str, Any]]) -> None:
        for pk, fields in source.items():
            yr = fields["year"]
            q = fields["quarter"]
            if not (year_from <= yr <= year_to):
                continue
            if q == 0 and yr >= current_year and yr not in completed_annual_years:
                continue
            if pk not in period_data:
                period_data[pk] = {"ticker": ticker, "year": yr, "quarter": q}
            for k, v in fields.items():
                if k in ("year", "quarter"):
                    continue
                period_data[pk].setdefault(k, v)

    # Priority: IS quarterly > IS annual > BS quarterly > CF quarterly
    merge_into(is_q)
    merge_into(is_a)
    merge_into(bs_q)
    merge_into(cf_q)

    # ── Derive annual BS from Q4 balance sheet ──────────────────────────────
    bs_annual_cols = set(BS_MAP.values())
    for yr in range(year_from, year_to + 1):
        ann_pk = f"{yr}_0"
        q4_pk = f"{yr}_4"
        if q4_pk in period_data and ann_pk in period_data:
            q4 = period_data[q4_pk]
            ann = period_data[ann_pk]
            for col in bs_annual_cols:
                if col in q4:
                    ann.setdefault(col, q4[col])

    # ── Derive annual IS from quarterly sums ────────────────────────────────
    is_sum_cols = {"revenue", "gross_profit", "operating_income", "net_income"}
    for yr in range(year_from, year_to + 1):
        ann_pk = f"{yr}_0"
        if ann_pk not in period_data:
            continue
        ann = period_data[ann_pk]
        for col in is_sum_cols:
            if ann.get(col) is not None:
                continue
            q_vals = [
                period_data.get(f"{yr}_{q}", {}).get(col)
                for q in range(1, 5)
            ]
            q_vals_filled = [v for v in q_vals if v is not None]
            if len(q_vals_filled) == 4:
                ann[col] = sum(q_vals_filled)

    # ── Derive annual CF from quarterly sums ────────────────────────────────
    cf_sum_cols = {"operating_cash_flow", "capex", "free_cash_flow",
                   "investing_cash_flow", "financing_cash_flow"}
    for yr in range(year_from, year_to + 1):
        ann_pk = f"{yr}_0"
        if ann_pk not in period_data:
            continue
        ann = period_data[ann_pk]
        for col in cf_sum_cols:
            if col in ann:
                continue
            q_vals = [
                period_data.get(f"{yr}_{q}", {}).get(col)
                for q in range(1, 5)
            ]
            q_vals = [v for v in q_vals if v is not None]
            if q_vals:
                ann[col] = sum(q_vals)

    # ── Derive margins from raw P&L ─────────────────────────────────────────
    for row in period_data.values():
        rev = row.get("revenue")
        if not rev:
            continue
        if "gross_margin" not in row and row.get("gross_profit") is not None:
            row["gross_margin"] = round(row["gross_profit"] / rev * 100, 4)
        if "operating_margin" not in row and row.get("operating_income") is not None:
            row["operating_margin"] = round(row["operating_income"] / rev * 100, 4)
        if "net_margin" not in row and row.get("net_income") is not None:
            row["net_margin"] = round(row["net_income"] / rev * 100, 4)

    # ── Merge snapshot into most recent annual row ──────────────────────────
    rows = sorted(period_data.values(), key=lambda r: (-r["year"], -r["quarter"]))
    for row in rows:
        if row["quarter"] == 0:
            for k, v in snapshot.items():
                row.setdefault(k, v)
            break

    # ── Ensure required keys ────────────────────────────────────────────────
    for row in rows:
        row.setdefault("revenue", None)
        row.setdefault("net_income", None)
        row.setdefault("eps", None)

    return rows, snapshot


# ── CLI entry point ──────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--ticker",        required=True)
    parser.add_argument("--bearer-token",  required=True)
    parser.add_argument("--year-from",     type=int, required=True)
    parser.add_argument("--year-to",       type=int, required=True)
    args = parser.parse_args()

    ticker    = args.ticker.upper()
    token     = args.bearer_token.strip()
    if token.lower().startswith("bearer "):
        token = token[7:].strip()
    year_from = args.year_from
    year_to   = args.year_to

    try:
        from curl_cffi import requests as cffi_requests
    except ImportError:
        print(json.dumps({"error": "curl_cffi not installed — run: pip install curl-cffi"}))
        sys.exit(1)

    session = cffi_requests.Session(impersonate="chrome120")
    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
            "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
        ),
        "Accept":           "application/json, text/plain, */*",
        "Accept-Language":  "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
        "Authorization":    f"Bearer {token}",
        "Origin":           "https://stockbit.com",
        "Referer":          "https://stockbit.com/",
        "X-App-Version":    "8.28.0",
        "X-Requested-With": "XMLHttpRequest",
    }

    def get(url: str) -> dict:
        try:
            resp = session.get(url, headers=headers, timeout=20)
        except Exception as e:
            print(json.dumps({"error": f"Network error: {e}"}))
            sys.exit(1)
        if resp.status_code == 401:
            print(json.dumps({
                "error": (
                    f"Stockbit rejected the token (401). Token length: {len(token)} chars. "
                    "Make sure to copy only the token value — not the 'Bearer ' prefix."
                )
            }))
            sys.exit(1)
        if resp.status_code != 200:
            print(json.dumps({"error": f"Stockbit returned HTTP {resp.status_code} for {url}"}))
            sys.exit(1)
        try:
            return resp.json()
        except Exception as e:
            print(json.dumps({"error": f"Failed to parse JSON from {url}: {e}"}))
            sys.exit(1)

    base_url = "https://exodus.stockbit.com/findata-view/company/financial"

    def findata(report_type: int, statement_type: int) -> str:
        url = (
            f"{base_url}?symbol={ticker}"
            f"&data_type=1&report_type={report_type}&statement_type={statement_type}"
        )
        data = get(url).get("data") or {}
        return data.get("html_report") or ""

    is_q_html = findata(report_type=1, statement_type=1)
    is_a_html = findata(report_type=1, statement_type=2)
    bs_q_html = findata(report_type=2, statement_type=1)
    cf_q_html = findata(report_type=3, statement_type=1)

    is_q = parse_findata_html(is_q_html, IS_MAP)
    is_a = parse_findata_html(is_a_html, IS_MAP)
    bs_q = parse_findata_html(bs_q_html, BS_MAP)
    cf_q = parse_findata_html(cf_q_html, CF_MAP)

    ks_raw = get(f"https://exodus.stockbit.com/keystats/ratio/v1/{ticker}?year_limit=10")
    ks_data = ks_raw.get("data") or {}
    snapshot = parse_keystats_snapshot(ks_data)

    # Reuse the same merge/derive logic via inline processing
    # (CLI keeps its own session for the web API route call path)
    period_data: dict[str, dict[str, Any]] = {}
    completed_annual_years: set[int] = set()
    for source in (is_q, bs_q, cf_q):
        for fields in source.values():
            if fields.get("quarter") == 4:
                completed_annual_years.add(fields["year"])

    def merge_into(source: dict[str, dict[str, Any]]) -> None:
        for pk, fields in source.items():
            yr, q = fields["year"], fields["quarter"]
            if not (year_from <= yr <= year_to):
                continue
            if q == 0 and yr >= _CURRENT_YEAR and yr not in completed_annual_years:
                continue
            if pk not in period_data:
                period_data[pk] = {"ticker": ticker, "year": yr, "quarter": q}
            for k, v in fields.items():
                if k not in ("year", "quarter"):
                    period_data[pk].setdefault(k, v)

    merge_into(is_q); merge_into(is_a); merge_into(bs_q); merge_into(cf_q)

    bs_annual_cols = set(BS_MAP.values())
    for yr in range(year_from, year_to + 1):
        ann_pk, q4_pk = f"{yr}_0", f"{yr}_4"
        if q4_pk in period_data and ann_pk in period_data:
            for col in bs_annual_cols:
                if col in period_data[q4_pk]:
                    period_data[ann_pk].setdefault(col, period_data[q4_pk][col])

    for yr in range(year_from, year_to + 1):
        ann_pk = f"{yr}_0"
        if ann_pk not in period_data:
            continue
        ann = period_data[ann_pk]
        for col in {"revenue", "gross_profit", "operating_income", "net_income"}:
            if ann.get(col) is not None:
                continue
            qv = [period_data.get(f"{yr}_{q}", {}).get(col) for q in range(1, 5)]
            qv = [v for v in qv if v is not None]
            if len(qv) == 4:
                ann[col] = sum(qv)
        for col in {"operating_cash_flow", "capex", "free_cash_flow", "investing_cash_flow", "financing_cash_flow"}:
            if col in ann:
                continue
            qv = [period_data.get(f"{yr}_{q}", {}).get(col) for q in range(1, 5)]
            qv = [v for v in qv if v is not None]
            if qv:
                ann[col] = sum(qv)

    for row in period_data.values():
        rev = row.get("revenue")
        if not rev:
            continue
        if "gross_margin" not in row and row.get("gross_profit") is not None:
            row["gross_margin"] = round(row["gross_profit"] / rev * 100, 4)
        if "operating_margin" not in row and row.get("operating_income") is not None:
            row["operating_margin"] = round(row["operating_income"] / rev * 100, 4)
        if "net_margin" not in row and row.get("net_income") is not None:
            row["net_margin"] = round(row["net_income"] / rev * 100, 4)

    rows = sorted(period_data.values(), key=lambda r: (-r["year"], -r["quarter"]))
    for row in rows:
        if row["quarter"] == 0:
            for k, v in snapshot.items():
                row.setdefault(k, v)
            break

    for row in rows:
        row.setdefault("revenue", None)
        row.setdefault("net_income", None)
        row.setdefault("eps", None)

    print(json.dumps({"rows": rows, "snapshot": snapshot}))


if __name__ == "__main__":
    main()
