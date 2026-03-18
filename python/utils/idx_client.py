from __future__ import annotations

"""
IDX API client — wraps all calls to idx.co.id unofficial endpoints.

Base URL: https://www.idx.co.id/primary
(Changed from /umbraco/Surface during IDX site redesign, ~2024)

Design principles:
- All HTTP goes through this single class. Scrapers never touch requests/curl_cffi directly.
- Built-in rate limiting and retry so callers don't have to think about it.
- Easy to extend: add a new endpoint by adding a method here.
- If IDX changes an endpoint, fix it in one place.

Verified endpoints (March 2026):
  GET /primary/ListedCompany/GetCompanyProfiles        — full stock list + profile data
  GET /primary/ListedCompany/GetTradingInfoSS          — daily trading data + foreign flow
  GET /primary/TradingSummary/GetBrokerSummary         — broker activity per stock per day
  GET /primary/ListedCompany/GetFinancialReport        — financial report document list
"""
import time
import logging
from typing import Any

from curl_cffi import requests as cffi_requests
from tenacity import retry, stop_after_attempt, wait_exponential, retry_if_exception_type

from config import IDX_BASE_URL, RATE_LIMIT_IDX_SECONDS

logger = logging.getLogger(__name__)

# Browser headers IDX expects
_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/120.0.0.0 Safari/537.36"
    ),
    "Referer": "https://www.idx.co.id/id/data-pasar/data-saham/daftar-saham/",
    "X-Requested-With": "XMLHttpRequest",
    "Accept": "application/json, text/javascript, */*; q=0.01",
    "Accept-Language": "en-US,en;q=0.9,id;q=0.8",
}


class IDXClient:
    """
    Client for IDX unofficial API endpoints.

    Usage:
        client = IDXClient()
        page = client.get_company_profiles_page(start=0, length=100)
        records = page["data"]  # list of company dicts
    """

    def __init__(self, rate_limit_seconds: float = RATE_LIMIT_IDX_SECONDS):
        self._rate_limit = rate_limit_seconds
        self._last_request_at: float = 0.0
        self._session = cffi_requests.Session(impersonate="chrome120")

    # ------------------------------------------------------------------
    # Internal request helper
    # ------------------------------------------------------------------

    def _wait(self) -> None:
        elapsed = time.time() - self._last_request_at
        if elapsed < self._rate_limit:
            time.sleep(self._rate_limit - elapsed)

    @retry(
        retry=retry_if_exception_type(Exception),
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=1, min=2, max=10),
        reraise=True,
    )
    def _get(self, url: str, params: dict | None = None) -> Any:
        """Rate-limited GET with browser impersonation and retry."""
        self._wait()
        logger.debug("GET %s params=%s", url, params)
        resp = self._session.get(url, headers=_HEADERS, params=params, timeout=20)
        self._last_request_at = time.time()
        resp.raise_for_status()
        return resp.json()

    # ------------------------------------------------------------------
    # Company profiles / stock universe
    # (Single endpoint covers both — stock list AND full profile data)
    # ------------------------------------------------------------------

    def get_company_profiles_page(self, start: int = 0, length: int = 100) -> dict:
        """
        Fetch a paginated page of company profiles.

        This is the primary source for BOTH the stock universe (ticker list)
        and company profile data (address, website, officers, shareholders).

        Response shape:
            {
              "recordsTotal": 957,
              "data": [
                {
                  "KodeEmiten": "BBRI",
                  "NamaEmiten": "Bank Rakyat Indonesia (Persero) Tbk.",
                  "Sektor": "Keuangan",
                  "SubSektor": "Bank",
                  "Industri": "...",
                  "SubIndustri": "...",
                  "PapanPencatatan": "Utama",          ← board
                  "TanggalPencatatan": "2003-11-10T...",
                  "Alamat": "...",                      ← address
                  "Telepon": "...",                     ← phone
                  "Fax": "...",
                  "Email": "...",
                  "Website": "...",
                  "NPWP": "...",
                  "BAE": "PT. Datindo Entrycom",        ← registry_agency
                  "KegiatanUsahaUtama": "...",          ← business description
                  "Status": "0",                       ← "0" = Active
                }
              ]
            }

        Endpoint: GET /primary/ListedCompany/GetCompanyProfiles
        """
        url = f"{IDX_BASE_URL}/ListedCompany/GetCompanyProfiles"
        return self._get(url, params={"start": start, "length": length})

    def get_company_profile(self, ticker: str) -> dict | None:
        """
        Fetch profile for a single ticker. Returns the raw record dict or None.

        Strategy:
        1. Try search[value] filter first (fast path — works if IDX search indexes KodeEmiten).
        2. Fall back to fetching all records in one call and scanning locally.
           IDX has ~1000 stocks so a single length=1000 call is acceptable.
        """
        url = f"{IDX_BASE_URL}/ListedCompany/GetCompanyProfiles"
        ticker_upper = ticker.upper()

        # Fast path: try search filter
        data = self._get(url, params={"start": 0, "length": 20, "search[value]": ticker})
        for r in data.get("data", []):
            if r.get("KodeEmiten", "").upper() == ticker_upper:
                return r

        # Slow path: fetch all and scan (search[value] may not filter by KodeEmiten)
        data = self._get(url, params={"start": 0, "length": 1200})
        for r in data.get("data", []):
            if r.get("KodeEmiten", "").upper() == ticker_upper:
                return r
        return None

    # ------------------------------------------------------------------
    # Trading data + foreign flow
    # ------------------------------------------------------------------

    def get_trading_info(self, ticker: str, days: int = 30) -> list[dict]:
        """
        Fetch recent daily trading data for a ticker.

        Includes OHLCV, Value, Frequency, ForeignBuy, ForeignSell per day.

        Response shape:
            {
              "KodeEmiten": "BBRI",
              "replies": [
                {
                  "Date": "2026-03-13T00:00:00",
                  "StockCode": "BBRI",
                  "OpenPrice": "3560.0",
                  "High": "3590.0", "Low": "3490.0", "Close": "3490.0",
                  "Change": "-80.0",
                  "Volume": "...", "Value": "...", "Frequency": "...",
                  "ForeignBuy": "...", "ForeignSell": "...",
                  "ListedShares": "...",
                }
              ]
            }

        Endpoint: GET /primary/ListedCompany/GetTradingInfoSS
        """
        url = f"{IDX_BASE_URL}/ListedCompany/GetTradingInfoSS"
        data = self._get(url, params={"code": ticker, "length": days})
        return data.get("replies", []) if isinstance(data, dict) else []

    # ------------------------------------------------------------------
    # Broker summary
    # ------------------------------------------------------------------

    def get_broker_summary(self, ticker: str, date: str) -> list[dict]:
        """
        Fetch broker-level trading activity for a ticker on a given date.

        NOTE: IDX API returns total volume/value per broker (buy + sell combined).
        There is no separate buy/sell breakdown available from this endpoint.

        Response shape:
            {
              "recordsTotal": 88,
              "data": [
                {
                  "IDFirm": "YP",
                  "FirmName": "Indo Premier Sekuritas",
                  "Volume": 12345678.0,    ← total (buy + sell)
                  "Value": 99887766.0,     ← total IDR (buy + sell)
                  "Frequency": 1234.0,
                }
              ]
            }

        Args:
            ticker: Stock code, e.g. 'BBRI'
            date:   Trading date in 'YYYY-MM-DD' format

        Endpoint: GET /primary/TradingSummary/GetBrokerSummary
        """
        url = f"{IDX_BASE_URL}/TradingSummary/GetBrokerSummary"
        data = self._get(url, params={"date": date, "stockCode": ticker, "board": ""})
        return data.get("data", []) if isinstance(data, dict) else []

    # ------------------------------------------------------------------
    # Financial reports (document list, for future XBRL parsing)
    # ------------------------------------------------------------------

    def get_financial_report_list(
        self,
        ticker: str,
        year: int,
        quarter: int,
        page_size: int = 5,
    ) -> list[dict]:
        """
        Fetch list of available quarterly financial report documents for a ticker/period.

        quarter mapping: 0 → 'Tahunan', 1 → 'TW1', 2 → 'TW2', 3 → 'TW3', 4 → 'TW4'
        reportType: 'rdf' = quarterly/annual financial statement

        Endpoint: GET /primary/ListedCompany/GetFinancialReport
        """
        periode_map = {0: "Tahunan", 1: "TW1", 2: "TW2", 3: "TW3", 4: "TW4"}
        url = f"{IDX_BASE_URL}/ListedCompany/GetFinancialReport"
        params = {
            "indexFrom": 0,
            "pageSize": page_size,
            "year": year,
            "reportType": "rdf",
            "periode": periode_map[quarter],
            "kodeEmiten": ticker,
        }
        data = self._get(url, params)
        return data.get("Results", []) if isinstance(data, dict) else []

    def get_annual_report_list(
        self,
        ticker: str,
        year: int,
        page_size: int = 5,
    ) -> list[dict]:
        """
        Fetch list of annual report (laporan tahunan) documents for a ticker/year.

        Uses the same endpoint as get_financial_report_list but with:
            reportType='arr'  (Annual Report)
            periode='Tahunan'

        Response shape identical to get_financial_report_list.

        Endpoint: GET /primary/ListedCompany/GetFinancialReport
        """
        url = f"{IDX_BASE_URL}/ListedCompany/GetFinancialReport"
        params = {
            "indexFrom": 0,
            "pageSize": page_size,
            "year": year,
            "reportType": "arr",
            "periode": "Tahunan",
            "kodeEmiten": ticker,
        }
        data = self._get(url, params)
        return data.get("Results", []) if isinstance(data, dict) else []

    # ------------------------------------------------------------------
    # Corporate events — public expose, AGM
    # ------------------------------------------------------------------

    def get_public_expose_list(
        self,
        ticker: str,
        page_size: int = 20,
    ) -> list[dict]:
        """
        Fetch list of public expose events for a ticker.

        Response shape (best-effort — IDX does not publish official API docs):
            {
              "recordsTotal": N,
              "data": [
                {
                  "KodeEmiten": "BBRI",
                  "NamaEmiten": "...",
                  "Judul": "Public Expose BBRI 2025",
                  "TanggalPublikasi": "2025-11-15T00:00:00",
                  "LinkFile": "...",
                }
              ]
            }

        Endpoint: GET /primary/PublicExpose/GetPublicExpose
        Returns empty list if the endpoint is unavailable or returns no data.
        """
        url = f"{IDX_BASE_URL}/PublicExpose/GetPublicExpose"
        params = {
            "kodeEmiten": ticker,
            "indexFrom": 0,
            "pageSize": page_size,
        }
        try:
            data = self._get(url, params)
            return data.get("data", []) if isinstance(data, dict) else []
        except Exception:
            logger.debug("Public expose endpoint unavailable for %s", ticker)
            return []

    def get_agm_list(
        self,
        ticker: str,
        page_size: int = 10,
    ) -> list[dict]:
        """
        Fetch list of AGM/RUPS (General Shareholder Meeting) disclosures for a ticker.

        Attempts two common endpoint patterns — returns empty list on failure.

        Endpoint: GET /primary/ListedCompany/GetAnnouncement (type=RUPS)
        """
        url = f"{IDX_BASE_URL}/ListedCompany/GetAnnouncement"
        params = {
            "kodeEmiten": ticker,
            "type": "RUPS",
            "indexFrom": 0,
            "pageSize": page_size,
        }
        try:
            data = self._get(url, params)
            if isinstance(data, dict):
                return data.get("data", []) or data.get("Results", [])
            return []
        except Exception:
            logger.debug("AGM announcement endpoint unavailable for %s", ticker)
            return []
