from __future__ import annotations

"""
Stockbit unofficial API client.

Stockbit (https://stockbit.com) is Indonesia's largest retail stock platform.
It provides IDX fundamental data, financial reports, and ratios with good
coverage of small/mid-cap stocks that yfinance sometimes misses.

Authentication (March 2026):
    Stockbit's login API requires WebSocket 2FA — no automated login.
    Token lifecycle is managed by utils/token_manager.py:
      - Cached in ~/.stockbit_token (auto-prompted when missing/expired)
      - JWT expiry is decoded and checked before each session
      - On 401, cached token is cleared and next run re-prompts
      - Falls back to STOCKBIT_BEARER_TOKEN env var for CI/non-interactive

    With a valid token, all endpoints are accessible:
        fundamental/basicinfo/{ticker}          — profile + market data (public)
        fundamental/ttm/{ticker}                — trailing-twelve-month ratios (public)
        financial-report/is/{ticker}/{period}   — income statement (auth required)
        financial-report/bs/{ticker}/{period}   — balance sheet (auth required)
        financial-report/cf/{ticker}/{period}   — cash flow statement (auth required)

    Without a token, only the two public endpoints above are available.

Browser impersonation:
    curl_cffi with Chrome impersonation — Stockbit's CDN blocks plain requests.

Usage:
    client = StockbitClient()
    info = client.get_basic_info("BBRI")      # always works, no auth
    ttm  = client.get_ttm_ratios("BBRI")      # always works, no auth

    # With STOCKBIT_BEARER_TOKEN set:
    income, balance, cashflow = client.get_all_statements("BBRI", period="annual", limit=5)
"""

import time
import logging
from typing import Any

from curl_cffi import requests as cffi_requests
from tenacity import retry, stop_after_attempt, wait_exponential, retry_if_exception_type

from config import RATE_LIMIT_STOCKBIT_SECONDS
from utils.token_manager import get_stockbit_token, clear_cached_token

logger = logging.getLogger(__name__)

# Stockbit checks the client version on every request. These headers mirror
# what the current Stockbit mobile app sends. Update _APP_VERSION if login
# starts failing again with an "update app" message.
_APP_VERSION = "8.28.0"
_BASE = "https://api.stockbit.com/v2.4"
_EXODUS_BASE = "https://exodus.stockbit.com"

# Mobile app headers — required so the backend doesn't reject as outdated client
_HEADERS_MOBILE = {
    "User-Agent": f"Stockbit/{_APP_VERSION} (com.stockbit.android; Android 14; sdk_gphone_x86_64 Build/UE1A.230829.036)",
    "X-App-Version": _APP_VERSION,
    "X-Platform": "android",
    "Content-Type": "application/json",
    "Accept": "application/json",
    "Accept-Language": "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
    "Origin": "https://stockbit.com",
    "Referer": "https://stockbit.com/",
}

# Web app headers — fallback if mobile headers fail
_HEADERS_WEB = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "X-App-Version": _APP_VERSION,
    "Content-Type": "application/json",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "id-ID,id;q=0.9,en-US;q=0.8",
    "Origin": "https://stockbit.com",
    "Referer": "https://stockbit.com/",
    "X-Requested-With": "XMLHttpRequest",
}

# Use mobile headers as default for all requests
_HEADERS = _HEADERS_MOBILE


class StockbitClient:
    """
    Unofficial Stockbit API client.

    Important: This uses undocumented endpoints. Stockbit may change their API
    without notice. The client is designed to fail gracefully and never block
    the main pipeline when endpoints are unavailable.
    """

    def __init__(self, prompt_for_token: bool = True) -> None:
        self._session = cffi_requests.Session(impersonate="chrome120")
        self._last_at: float = 0.0
        self._token: str | None = get_stockbit_token(prompt=prompt_for_token)
        if self._token:
            logger.debug("Stockbit: Bearer token loaded — authenticated endpoints available")
        else:
            logger.debug("Stockbit: no token set — public endpoints only")

    @property
    def is_authenticated(self) -> bool:
        """True if a Bearer token is configured."""
        return bool(self._token)

    # ------------------------------------------------------------------
    # Internal request helper (public endpoints only — no auth header)
    # ------------------------------------------------------------------

    def _wait(self) -> None:
        elapsed = time.time() - self._last_at
        if elapsed < RATE_LIMIT_STOCKBIT_SECONDS:
            time.sleep(RATE_LIMIT_STOCKBIT_SECONDS - elapsed)

    @retry(
        retry=retry_if_exception_type(Exception),
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=1, min=2, max=10),
        reraise=True,
    )
    def _get_exodus(self, path: str, params: dict | None = None) -> Any:
        """
        GET from exodus.stockbit.com.

        Uses a fresh session per call to avoid cookie/header contamination from
        api.stockbit.com requests. Sends Bearer token upfront when available (some
        exodus endpoints return 400 rather than 401 when auth is missing).
        Falls back to no-auth attempt if token returns 400/401.
        """
        self._wait()
        url = f"{_EXODUS_BASE}/{path}"
        base_headers = {
            "Accept": "application/json",
            "Accept-Language": "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
            "Origin": "https://stockbit.com",
            "Referer": "https://stockbit.com/",
            "User-Agent": (
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/124.0.0.0 Safari/537.36"
            ),
        }
        logger.debug("Stockbit Exodus GET %s params=%s", path, params)

        # Use a fresh session to avoid shared state with api.stockbit.com
        session = cffi_requests.Session(impersonate="chrome120")

        # Send Bearer token upfront when available — some exodus endpoints return 400
        # (not 401) when auth is missing, so we can't detect the need from status code
        if self._token:
            headers = {**base_headers, "Authorization": f"Bearer {self._token}"}
        else:
            headers = base_headers

        resp = session.get(url, headers=headers, params=params or {}, timeout=20)
        self._last_at = time.time()

        # If auth failed, retry without token (endpoint may be truly public)
        if resp.status_code in (400, 401) and self._token:
            logger.debug("Stockbit Exodus %d with auth — retrying without token", resp.status_code)
            resp2 = session.get(url, headers=base_headers, params=params or {}, timeout=20)
            self._last_at = time.time()
            if resp2.status_code == 200:
                resp = resp2
            elif resp.status_code == 401:
                logger.warning(
                    "Stockbit Exodus 401 — token expired. "
                    "Run any scraper again to be prompted for a new token."
                )
                clear_cached_token()
                self._token = None

        resp.raise_for_status()
        return resp.json()

    @retry(
        retry=retry_if_exception_type(Exception),
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=1, min=2, max=10),
        reraise=True,
    )
    def _get(self, path: str, params: dict | None = None) -> Any:
        self._wait()
        url = f"{_BASE}/{path}"
        logger.debug("Stockbit GET %s params=%s", path, params)
        headers = dict(_HEADERS_MOBILE)
        if self._token:
            headers["Authorization"] = f"Bearer {self._token}"
        resp = self._session.get(url, headers=headers, params=params or {}, timeout=20)
        self._last_at = time.time()
        if resp.status_code == 401 and self._token:
            logger.warning(
                "Stockbit 401 Unauthorized — token expired. "
                "Run any scraper again to be prompted for a new token."
            )
            clear_cached_token()
            self._token = None
        resp.raise_for_status()
        return resp.json()

    # ------------------------------------------------------------------
    # Public endpoints — no authentication required
    # ------------------------------------------------------------------

    def get_basic_info(self, ticker: str) -> dict:
        """
        Fetch company profile + current market data.

        Response shape (best-effort — field names may vary by version):
            {
              "emitent_code": "BBRI",
              "name": "Bank Rakyat Indonesia (Persero) Tbk.",
              "sector": "Finance",
              "market_cap": 535000000000000,
              "price": 3490,
              "listed_shares": 153000000000,
              "pe": 12.5,
              "pbv": 2.1,
              "roe": 18.5,
              "net_margin": 22.3,
              ...
            }

        Useful for: enriching stocks.market_cap, stocks.listed_shares,
        and back-filling recent pe_ratio / pbv_ratio / roe when
        doesn't have the latest quarter yet.
        """
        try:
            data = self._get(f"fundamental/basicinfo/{ticker}")
            if isinstance(data, dict) and data.get("status") == "success":
                return data.get("data") or {}
        except Exception as e:
            logger.debug("Stockbit basic info failed for %s: %s", ticker, e)
        return {}

    def get_ttm_ratios(self, ticker: str) -> dict:
        """
        Trailing-twelve-month financial ratios.

        Provides: pe_ratio, pbv_ratio, roe, roa, net_margin, eps_ttm,
        revenue_ttm, net_income_ttm, operating_margin_ttm.

        These are useful for filling NULL ratio columns for recent periods
        when the full quarterly statement isn't available yet.
        """
        try:
            data = self._get(f"fundamental/ttm/{ticker}")
            if isinstance(data, dict) and data.get("status") == "success":
                return data.get("data") or {}
        except Exception as e:
            logger.debug("Stockbit TTM ratios failed for %s: %s", ticker, e)
        return {}

    # ------------------------------------------------------------------
    # Shared helpers for keystats parsing
    # ------------------------------------------------------------------

    # Map (keystats_name, fitem.name) → canonical field name
    _KEYSTATS_FIELD_MAP: dict[tuple[str, str], str] = {
        ("Current Valuation", "Current PE Ratio (TTM)"):          "pe_ratio",
        ("Current Valuation", "Current Price to Book Value"):      "pbv_ratio",
        ("Per Share",         "Current EPS (TTM)"):                "eps",
        ("Per Share",         "Current Book Value Per Share"):     "book_value_per_share",
        ("Management Effectiveness", "Return on Assets (TTM)"):   "roa",
        ("Management Effectiveness", "Return on Equity (TTM)"):   "roe",
        ("Profitability",     "Gross Profit Margin (Quarter)"):    "gross_margin",
        ("Profitability",     "Operating Profit Margin (Quarter)"):"operating_margin",
        ("Profitability",     "Net Profit Margin (Quarter)"):      "net_margin",
        ("Dividend",          "Dividend Yield"):                   "dividend_yield",
        ("Income Statement",  "Revenue (TTM)"):                    "revenue",
        ("Income Statement",  "Gross Profit (TTM)"):               "gross_profit",
        ("Income Statement",  "Net Income (TTM)"):                 "net_income",
        ("Balance Sheet",     "Cash (Quarter)"):                   "cash_and_equivalents",
        ("Balance Sheet",     "Total Assets (Quarter)"):           "total_assets",
        ("Balance Sheet",     "Total Liabilities (Quarter)"):      "total_liabilities",
        ("Balance Sheet",     "Total Equity"):                     "total_equity",
        ("Balance Sheet",     "Common Equity"):                    "total_equity",
        ("Cash Flow Statement","Cash From Operations (TTM)"):      "operating_cash_flow",
        ("Cash Flow Statement","Capital expenditure (TTM)"):       "capex",
        ("Cash Flow Statement","Free cash flow (TTM)"):            "free_cash_flow",
        ("Solvency",          "Current Ratio (Quarter)"):          "current_ratio",
        ("Solvency",          "Debt to Equity Ratio (Quarter)"):   "debt_to_equity",
    }
    # Fields stored as BIGINT (IDR amounts, multiplied from "B" suffix)
    _KEYSTATS_INT_FIELDS: frozenset[str] = frozenset({
        "revenue", "gross_profit", "net_income",
        "total_assets", "total_liabilities", "total_equity", "cash_and_equivalents",
        "operating_cash_flow", "capex", "free_cash_flow",
    })
    # fitem_name in financial_year_parent → canonical field
    _HISTORY_FIELD_MAP: dict[str, str] = {
        "Revenue":    "revenue",
        "Net Income": "net_income",
        "EPS":        "eps",
    }

    @staticmethod
    def _parse_stockbit_value(raw: str | None) -> float | None:
        """Parse a Stockbit formatted value string to a Python float.

        Handles:  "28,265 B"  →  28265000000000.0
                  "14.57%"    →  14.57
                  "(2,205 B)" →  -2205000000000.0  (parentheses = negative)
                  "-"         →  None
        """
        if raw is None or str(raw).strip() in ("-", "", "N/A", "—"):
            return None
        s = str(raw).strip()
        negative = s.startswith("(") and s.endswith(")")
        if negative:
            s = s[1:-1]
        s = s.replace(",", "")
        multiplier = 1.0
        if s.endswith(" B"):
            s = s[:-2]
            multiplier = 1e9
        elif s.endswith("%"):
            s = s[:-1]
        try:
            val = float(s) * multiplier
            return -val if negative else val
        except ValueError:
            return None

    def _fetch_keystats_raw(self, ticker: str) -> dict:
        """Fetch and return the raw keystats API response data block."""
        resp = self._get_exodus(f"keystats/ratio/v1/{ticker}", {"year_limit": 10})
        return resp.get("data") or {}

    def get_keystats(self, ticker: str) -> dict:
        """
        Fetch current/TTM key statistics from exodus.stockbit.com.

        Returns a flat dict of canonical field names → parsed numeric values
        representing the **most recent** snapshot (TTM or current quarter).

        Canonical fields returned (when available):
          pe_ratio, pbv_ratio, eps, book_value_per_share,
          roe, roa, gross_margin, operating_margin, net_margin,
          current_ratio, debt_to_equity, dividend_yield,
          revenue, gross_profit, net_income,
          total_assets, total_liabilities, total_equity, cash_and_equivalents,
          operating_cash_flow, capex, free_cash_flow

        For historical per-year/quarter data, use get_keystats_history().
        Both methods share one HTTP call via get_keystats_and_history().
        """
        try:
            data_block = self._fetch_keystats_raw(ticker)
            groups = data_block.get("closure_fin_items_results") or []
            if not groups:
                logger.warning(
                    "Stockbit keystats for %s: response OK but closure_fin_items_results is empty. "
                    "data keys: %s", ticker, list(data_block.keys()),
                )
                return {}
        except Exception as e:
            logger.warning("Stockbit keystats failed for %s: %s", ticker, e)
            return {}

        result: dict = {}
        for group in groups:
            group_name = group.get("keystats_name", "")
            for entry in group.get("fin_name_results") or []:
                fitem = entry.get("fitem") or {}
                key = (group_name, fitem.get("name", ""))
                canonical = self._KEYSTATS_FIELD_MAP.get(key)
                if not canonical or canonical in result:
                    continue
                val = self._parse_stockbit_value(fitem.get("value"))
                if val is None:
                    continue
                result[canonical] = int(val) if canonical in self._KEYSTATS_INT_FIELDS else round(val, 4)

        return result

    def get_keystats_history(self, ticker: str) -> list[dict]:
        """
        Fetch historical per-period financial data from exodus.stockbit.com.

        Returns a list of row dicts, one per (year, quarter), containing only
        the fields available in the financial_year_parent block:
          revenue, net_income, eps

        Each row has:
            ticker, year, quarter (0=annual, 1-4=quarterly), and the above fields.

        Annual rows have quarter=0, quarterly rows have quarter=1-4.
        This covers up to 10 years of history (year_limit=10).

        Combine with get_keystats() for the full picture, or use
        get_keystats_and_history() to do both in a single HTTP request.
        """
        try:
            data_block = self._fetch_keystats_raw(ticker)
            hist_groups = data_block.get("financial_year_parent", {}).get("financial_year_groups") or []
            if not hist_groups:
                logger.debug("Stockbit keystats history for %s: financial_year_parent is empty", ticker)
                return []
        except Exception as e:
            logger.warning("Stockbit keystats history failed for %s: %s", ticker, e)
            return []

        # Collect per-period values: {(year, quarter): {field: value}}
        period_data: dict[tuple[int, int], dict] = {}

        for group in hist_groups:
            fitem_name = group.get("fitem_name", "")
            canonical = self._HISTORY_FIELD_MAP.get(fitem_name)
            if not canonical:
                continue
            is_int = canonical in self._KEYSTATS_INT_FIELDS

            for yr_entry in group.get("financial_year_values") or []:
                try:
                    year = int(yr_entry.get("year", 0))
                except (ValueError, TypeError):
                    continue
                if not year:
                    continue

                # Annual row (quarter=0)
                ann_val = self._parse_stockbit_value(yr_entry.get("annualised_value"))
                if ann_val is not None:
                    key = (year, 0)
                    period_data.setdefault(key, {})[canonical] = int(ann_val) if is_int else round(ann_val, 4)

                # Quarterly rows
                q_map = {"Q1": 1, "Q2": 2, "Q3": 3, "Q4": 4}
                for pv in yr_entry.get("period_values") or []:
                    q_num = q_map.get(pv.get("period", ""))
                    if q_num is None:
                        continue
                    q_val = self._parse_stockbit_value(pv.get("quarter_value"))
                    if q_val is not None:
                        key = (year, q_num)
                        period_data.setdefault(key, {})[canonical] = int(q_val) if is_int else round(q_val, 4)

        rows = []
        for (year, quarter), fields in sorted(period_data.items(), reverse=True):
            row = {"ticker": ticker, "year": year, "quarter": quarter}
            row.update(fields)
            rows.append(row)

        return rows

    def get_keystats_and_history(self, ticker: str) -> tuple[dict, list[dict]]:
        """
        Fetch both current keystats snapshot and historical per-period rows
        in a single HTTP request.

        Returns:
            (current_snapshot, history_rows)
            where current_snapshot is the same as get_keystats()
            and history_rows is the same as get_keystats_history()
        """
        try:
            data_block = self._fetch_keystats_raw(ticker)
        except Exception as e:
            logger.warning("Stockbit keystats failed for %s: %s", ticker, e)
            return {}, []

        # Parse current snapshot
        current: dict = {}
        groups = data_block.get("closure_fin_items_results") or []
        for group in groups:
            group_name = group.get("keystats_name", "")
            for entry in group.get("fin_name_results") or []:
                fitem = entry.get("fitem") or {}
                key = (group_name, fitem.get("name", ""))
                canonical = self._KEYSTATS_FIELD_MAP.get(key)
                if not canonical or canonical in current:
                    continue
                val = self._parse_stockbit_value(fitem.get("value"))
                if val is None:
                    continue
                current[canonical] = int(val) if canonical in self._KEYSTATS_INT_FIELDS else round(val, 4)

        # Parse history
        period_data: dict[tuple[int, int], dict] = {}
        hist_groups = data_block.get("financial_year_parent", {}).get("financial_year_groups") or []
        for group in hist_groups:
            fitem_name = group.get("fitem_name", "")
            canonical = self._HISTORY_FIELD_MAP.get(fitem_name)
            if not canonical:
                continue
            is_int = canonical in self._KEYSTATS_INT_FIELDS
            for yr_entry in group.get("financial_year_values") or []:
                try:
                    year = int(yr_entry.get("year", 0))
                except (ValueError, TypeError):
                    continue
                if not year:
                    continue
                ann_val = self._parse_stockbit_value(yr_entry.get("annualised_value"))
                if ann_val is not None:
                    key = (year, 0)
                    period_data.setdefault(key, {})[canonical] = int(ann_val) if is_int else round(ann_val, 4)
                q_map = {"Q1": 1, "Q2": 2, "Q3": 3, "Q4": 4}
                for pv in yr_entry.get("period_values") or []:
                    q_num = q_map.get(pv.get("period", ""))
                    if q_num is None:
                        continue
                    q_val = self._parse_stockbit_value(pv.get("quarter_value"))
                    if q_val is not None:
                        key = (year, q_num)
                        period_data.setdefault(key, {})[canonical] = int(q_val) if is_int else round(q_val, 4)

        history = []
        for (year, quarter), fields in sorted(period_data.items(), reverse=True):
            row = {"ticker": ticker, "year": year, "quarter": quarter}
            row.update(fields)
            history.append(row)

        return current, history

    # ------------------------------------------------------------------
    # Findata-view — full HTML financial statements (same as web UI)
    # ------------------------------------------------------------------

    @retry(
        retry=retry_if_exception_type(Exception),
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=1, min=2, max=10),
        reraise=True,
    )
    def get_findata_html(
        self,
        ticker: str,
        report_type: int,
        statement_type: int,
    ) -> str:
        """
        Fetch findata-view HTML from exodus.stockbit.com.

        This is the same endpoint the Stockbit web UI uses to render
        financial statement tables. Returns rich HTML with all line items.

        Args:
            ticker:         IDX ticker code (e.g. 'BBRI')
            report_type:    1=Income Statement, 2=Balance Sheet, 3=Cash Flow
            statement_type: 1=Quarterly, 2=Annual (12M periods)

        Returns:
            Raw HTML string of the financial table, or "" on failure.
        """
        if not self._token:
            logger.debug("Stockbit findata-view skipped — no token")
            return ""

        self._wait()
        url = f"{_EXODUS_BASE}/findata-view/company/financial"
        params = {
            "symbol": ticker,
            "data_type": 1,
            "report_type": report_type,
            "statement_type": statement_type,
        }
        session = cffi_requests.Session(impersonate="chrome120")
        headers = {
            "Accept": "application/json",
            "Accept-Language": "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
            "Origin": "https://stockbit.com",
            "Referer": "https://stockbit.com/",
            "User-Agent": (
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/124.0.0.0 Safari/537.36"
            ),
            "Authorization": f"Bearer {self._token}",
        }
        logger.debug("Stockbit findata-view GET report_type=%d statement_type=%d ticker=%s",
                      report_type, statement_type, ticker)
        resp = session.get(url, headers=headers, params=params, timeout=20)
        self._last_at = time.time()

        if resp.status_code == 401:
            logger.warning("Stockbit findata-view 401 — token expired.")
            clear_cached_token()
            self._token = None
            return ""

        resp.raise_for_status()
        data = resp.json()
        return (data.get("data") or {}).get("html_report") or ""

    # ------------------------------------------------------------------
    # Broker distribution — buy/sell breakdown per broker
    # ------------------------------------------------------------------

    @retry(
        retry=retry_if_exception_type(Exception),
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=1, min=2, max=10),
        reraise=True,
    )
    def get_broker_distribution(
        self,
        ticker: str,
        date: str,
        data_type: str = "VALUE",
    ) -> dict:
        """
        Fetch broker buy/sell distribution for a ticker on a single date.

        Uses exodus.stockbit.com/order-trade/broker/distribution.
        Requires a valid bearer token.

        Args:
            ticker:    IDX ticker code (e.g. 'BMRI')
            date:      Trading date YYYY-MM-DD
            data_type: 'VALUE' (IDR amounts) or 'VOLUME' (share counts)

        Returns:
            {
              'top_broker_buy':  [{'code': 'BK', 'type': 'Asing', 'amount': 851695992000}, ...],
              'top_broker_sell': [{'code': 'ZP', 'type': 'Asing', 'amount': 345080728000}, ...],
            }
            or {} on failure / no token.
        """
        if not self._token:
            logger.debug("Stockbit broker distribution skipped — no token")
            return {}

        self._wait()
        url = f"{_EXODUS_BASE}/order-trade/broker/distribution"
        dt_enum = f"BROKER_DISTRIBUTION_DATA_TYPE_{data_type.upper()}"
        params = {
            "date": "",
            "symbol": ticker,
            "from": date,
            "to": date,
            "investor_type": "INVESTOR_TYPE_ALL",
            "market_board": "MARKET_TYPE_REGULER",
            "data_type": dt_enum,
        }
        session = cffi_requests.Session(impersonate="chrome120")
        headers = {
            "Accept": "application/json",
            "Accept-Language": "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
            "Origin": "https://stockbit.com",
            "Referer": "https://stockbit.com/",
            "User-Agent": (
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/124.0.0.0 Safari/537.36"
            ),
            "Authorization": f"Bearer {self._token}",
        }
        logger.debug("Stockbit broker distribution GET %s %s %s", ticker, date, data_type)
        resp = session.get(url, headers=headers, params=params, timeout=20)
        self._last_at = time.time()

        if resp.status_code == 401:
            logger.warning("Stockbit broker distribution 401 — token expired.")
            clear_cached_token()
            self._token = None
            return {}

        resp.raise_for_status()
        data = resp.json().get("data") or {}

        # Extract the relevant bucket (by_value or by_volume)
        bucket_key = "by_value" if data_type.upper() == "VALUE" else "by_volume"
        bucket = data.get(bucket_key) or {}

        # Flatten to simple lists of {code, type, amount}
        buy_list = [b["detail"] for b in bucket.get("top_broker_buy") or []]
        sell_list = [b["detail"] for b in bucket.get("top_broker_sell") or []]
        return {"top_broker_buy": buy_list, "top_broker_sell": sell_list}

    # ------------------------------------------------------------------
    # Market detector — broker flow + bandar signals (single call)
    # ------------------------------------------------------------------

    def get_market_detector(
        self,
        ticker: str,
        date: str | None = None,
        limit: int = 25,
    ) -> dict:
        """
        Fetch broker summary + bandar detector signals from marketdetectors.

        Single call replaces the 2-call get_broker_distribution() approach.
        Returns both broker buy/sell arrays and pre-computed bandar signals.

        Endpoint: exodus.stockbit.com/marketdetectors/{ticker}

        Args:
            ticker: IDX ticker code (e.g. 'ADRO')
            date:   Trading date YYYY-MM-DD (None = latest)
            limit:  Max brokers to return (default 25)

        Returns:
            {
              'bandar_detector': { 'broker_accdist': ..., 'top1_accdist': ..., ... },
              'broker_summary': {
                'brokers_buy':  [{'code':'BK', 'blot':'53268', 'bval':'5.48e+08', ...}],
                'brokers_sell': [{'code':'ZP', 'slot':'-42000', 'sval':'-4.2e+08', ...}],
              }
            }
            or {} on failure.
        """
        if not self._token:
            logger.debug("Stockbit market detector skipped — no token")
            return {}

        params: dict[str, Any] = {
            "transaction_type": "TRANSACTION_TYPE_NET",
            "market_board": "MARKET_BOARD_REGULER",
            "investor_type": "INVESTOR_TYPE_ALL",
            "limit": limit,
        }
        if date:
            params["from"] = date
            params["to"] = date

        try:
            data = self._get_exodus(f"marketdetectors/{ticker}", params=params)
            return data.get("data") or {}
        except Exception as e:
            logger.warning("Stockbit market detector failed for %s: %s", ticker, e)
            return {}

    # ------------------------------------------------------------------
    # Insider / major holder movements (KSEI data)
    # ------------------------------------------------------------------

    def get_insider_movements(
        self,
        ticker: str,
        page: int = 1,
        limit: int = 20,
        action_type: str = "ACTION_TYPE_UNSPECIFIED",
        source_type: str = "SOURCE_TYPE_UNSPECIFIED",
    ) -> dict:
        """
        Fetch KSEI major shareholder movements.

        Endpoint: exodus.stockbit.com/insider/company/majorholder

        Args:
            ticker:      IDX ticker code
            page:        Page number (1-based)
            limit:       Results per page
            action_type: Filter by action (ACTION_TYPE_UNSPECIFIED = all)
            source_type: Filter by source (SOURCE_TYPE_UNSPECIFIED = all)

        Returns:
            {'movement': [...], ...} or {} on failure.
        """
        if not self._token:
            logger.debug("Stockbit insider movements skipped — no token")
            return {}

        params = {
            "symbols": ticker,
            "page": page,
            "limit": limit,
            "action_type": action_type,
            "source_type": source_type,
        }

        try:
            data = self._get_exodus("insider/company/majorholder", params=params)
            return data.get("data") or {}
        except Exception as e:
            logger.warning("Stockbit insider movements failed for %s: %s", ticker, e)
            return {}

    # ------------------------------------------------------------------
    # Authenticated endpoints — require STOCKBIT_BEARER_TOKEN
    # ------------------------------------------------------------------

    def get_financial_report(
        self,
        ticker: str,
        statement: str,
        period: str = "annual",
        limit: int = 5,
    ) -> list[dict]:
        """
        Fetch a single financial statement for a ticker.

        Requires STOCKBIT_BEARER_TOKEN to be set. Returns [] without a token.

        Args:
            ticker:    IDX ticker code without .JK suffix (e.g. 'BBRI')
            statement: 'is' (income), 'bs' (balance sheet), or 'cf' (cash flow)
            period:    'annual' or 'quarterly'
            limit:     Number of periods to return

        Response shape varies by Stockbit version — normalization is done
        in scrapers/financials_fallback.py using the _STOCKBIT_*_FIELDS alias dicts.
        """
        if not self._token:
            logger.debug(
                "Stockbit get_financial_report skipped — no token set. "
                "Set STOCKBIT_BEARER_TOKEN in .env to enable statement endpoints."
            )
            return []

        # NOTE: The endpoint path below is a best-guess based on common Stockbit API
        # patterns. If this returns 0 rows, the path may be wrong.
        # To find the real path: open stockbit.com → browse to a stock's financials →
        # DevTools → Network tab → filter XHR → find the request fetching IS/BS/CF data.
        # Update _STATEMENT_PATHS below to match what DevTools shows.
        _STATEMENT_PATHS = {
            "is": f"financial-report/is/{ticker}",
            "bs": f"financial-report/bs/{ticker}",
            "cf": f"financial-report/cf/{ticker}",
        }
        path = _STATEMENT_PATHS.get(statement, f"financial-report/{statement}/{ticker}")

        try:
            params = {"period": period, "limit": limit}
            logger.debug("Stockbit statement request: GET %s/%s params=%s", _BASE, path, params)
            data = self._get(path, params=params)
            if isinstance(data, dict) and data.get("status") == "success":
                payload = data.get("data") or {}
                if isinstance(payload, list):
                    return payload
                for key in ("list", "items", "data", "result"):
                    if isinstance(payload.get(key), list):
                        return payload[key]
                # Unknown shape — log it so we can map it
                logger.warning(
                    "Stockbit %s/%s for %s: got status=success but unrecognized payload shape. "
                    "Keys: %s — update the key list in get_financial_report to extract the rows.",
                    statement, period, ticker, list(payload.keys()) if isinstance(payload, dict) else type(payload),
                )
                return []
            elif isinstance(data, dict):
                logger.warning(
                    "Stockbit %s/%s for %s: unexpected response status=%r. "
                    "Full response keys: %s",
                    statement, period, ticker, data.get("status"), list(data.keys()),
                )
        except Exception as e:
            logger.warning(
                "Stockbit %s/%s failed for %s: %s — "
                "endpoint path may be wrong. Check DevTools Network tab on stockbit.com "
                "to find the correct URL for financial statements.",
                statement, period, ticker, e,
            )
        return []

    def probe_endpoints(self, ticker: str) -> None:
        """
        Test a set of candidate Stockbit statement endpoint paths and print
        which ones return a valid response. Use this to discover the actual
        API path when get_financial_report returns 0 rows.

        Usage:
            from utils.stockbit_client import StockbitClient
            StockbitClient().probe_endpoints("BRIS")
        """
        candidates = [
            f"financial-report/is/{ticker}",
            f"financial-report/bs/{ticker}",
            f"financial-report/cf/{ticker}",
            f"company/financial/{ticker}",
            f"emitent/financial/{ticker}",
            f"fundamental/financial/{ticker}",
            f"fundamental/financialreport/{ticker}",
            f"financialreport/{ticker}",
            f"report/financial/{ticker}",
            f"company/{ticker}/financial",
        ]
        print(f"\nProbing {len(candidates)} endpoint candidates for {ticker}:")
        print(f"Base URL: {_BASE}\n")
        for path in candidates:
            try:
                resp = self._session.get(
                    f"{_BASE}/{path}",
                    headers={**dict(_HEADERS_MOBILE), "Authorization": f"Bearer {self._token}"},
                    params={"period": "annual", "limit": 1},
                    timeout=10,
                )
                status = resp.status_code
                try:
                    body = resp.json()
                    api_status = body.get("status", "?") if isinstance(body, dict) else "non-dict"
                    keys = list(body.keys()) if isinstance(body, dict) else []
                except Exception:
                    api_status = "non-json"
                    keys = []
                marker = "✓" if status == 200 else "✗"
                print(f"  {marker} [{status}] {path}  →  status={api_status!r}  keys={keys}")
            except Exception as e:
                print(f"  ✗ [ERR] {path}  →  {e}")
        print()

    def get_all_statements(
        self,
        ticker: str,
        period: str = "annual",
        limit: int = 5,
    ) -> tuple[list[dict], list[dict], list[dict]]:
        """
        Fetch income, balance, and cash flow statements in one sequence.

        Requires STOCKBIT_BEARER_TOKEN. Returns three empty lists without a token.

        Returns:
            (income_rows, balance_rows, cashflow_rows) — each newest-first.
        """
        income   = self.get_financial_report(ticker, "is", period=period, limit=limit)
        balance  = self.get_financial_report(ticker, "bs", period=period, limit=limit)
        cashflow = self.get_financial_report(ticker, "cf", period=period, limit=limit)
        return income, balance, cashflow
