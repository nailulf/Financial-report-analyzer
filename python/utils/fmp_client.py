from __future__ import annotations

"""
FMP (Financial Modeling Prep) API client.

Documentation: https://financialmodelingprep.com/developer/docs
Free tier:     250 requests/day (~10 req/min safe)
IDX tickers:   Append .JK suffix (e.g. BBRI → BBRI.JK)

All values returned by FMP are in the stock's reporting currency.
For IDX stocks this is IDR — actual rupiah, no scaling.

Rate limit strategy:
  RATE_LIMIT_FMP_SECONDS (default 6.0) gives ~10 req/min headroom.
  Each ticker needs up to 6 calls (IS + BS + CF × 2 periods).
  At 250 req/day and 6 per ticker: ~41 tickers/day on free tier.
  Upgrade to Starter ($14/mo) for effectively unlimited.

Usage:
    client = FMPClient()
    income_rows = client.get_income_statement("BBRI", period="annual", limit=5)
"""

import time
import logging
from typing import Any

import requests as http_requests
from tenacity import retry, stop_after_attempt, wait_exponential, retry_if_exception_type

from config import FMP_API_KEY, RATE_LIMIT_FMP_SECONDS, FMP_ANNUAL_LIMIT, FMP_QUARTERLY_LIMIT

logger = logging.getLogger(__name__)

_BASE = "https://financialmodelingprep.com/api/v3"


class FMPClient:
    """
    Thin wrapper around the FMP REST API.

    All methods return the raw FMP list response (list of period dicts).
    Normalization to the canonical financials schema is done in financials_fallback.py.

    Raises EnvironmentError if FMP_API_KEY is not configured.
    """

    def __init__(self) -> None:
        if not FMP_API_KEY:
            raise EnvironmentError(
                "FMP_API_KEY not set. Add it to .env to enable FMP fallback. "
                "Get a free key at https://financialmodelingprep.com/register"
            )
        self._key = FMP_API_KEY
        self._last_at: float = 0.0

    # ------------------------------------------------------------------
    # Internal
    # ------------------------------------------------------------------

    def _wait(self) -> None:
        elapsed = time.time() - self._last_at
        if elapsed < RATE_LIMIT_FMP_SECONDS:
            time.sleep(RATE_LIMIT_FMP_SECONDS - elapsed)

    @retry(
        retry=retry_if_exception_type(Exception),
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=1, min=2, max=15),
        reraise=True,
    )
    def _get(self, path: str, params: dict | None = None) -> Any:
        self._wait()
        url = f"{_BASE}/{path}"
        p = {"apikey": self._key, **(params or {})}
        logger.debug("FMP GET %s params=%s", path, {k: v for k, v in p.items() if k != "apikey"})
        resp = http_requests.get(url, params=p, timeout=20)
        self._last_at = time.time()
        resp.raise_for_status()
        data = resp.json()
        # FMP returns {"Error Message": "..."} for invalid tickers/API issues
        if isinstance(data, dict) and "Error Message" in data:
            logger.debug("FMP error for %s: %s", path, data["Error Message"])
            return []
        return data

    # ------------------------------------------------------------------
    # Financial statements — each returns a list of period dicts
    # ------------------------------------------------------------------

    def get_income_statement(
        self,
        ticker: str,
        period: str = "annual",
        limit: int = FMP_ANNUAL_LIMIT,
    ) -> list[dict]:
        """
        Income statement for a single IDX ticker.

        Args:
            ticker: IDX code WITHOUT .JK suffix (e.g. 'BBRI')
            period: 'annual' or 'quarter'
            limit:  Number of periods to fetch

        Key fields returned:
            date, calendarYear, period (FY / Q1-Q4),
            revenue, costOfRevenue, grossProfit, grossProfitRatio,
            operatingExpenses, operatingIncome, operatingIncomeRatio,
            interestExpense, incomeBeforeTax, incomeTaxExpense,
            netIncome, netIncomeRatio, eps, epsdiluted
        """
        return self._get(
            f"income-statement/{ticker}.JK",
            {"period": period, "limit": limit},
        ) or []

    def get_balance_sheet(
        self,
        ticker: str,
        period: str = "annual",
        limit: int = FMP_ANNUAL_LIMIT,
    ) -> list[dict]:
        """
        Balance sheet for a single IDX ticker.

        Key fields returned:
            totalAssets, totalCurrentAssets, totalNonCurrentAssets,
            totalLiabilities, totalCurrentLiabilities,
            totalStockholdersEquity, totalEquity,
            totalDebt, cashAndCashEquivalents, bookValuePerShare
        """
        return self._get(
            f"balance-sheet-statement/{ticker}.JK",
            {"period": period, "limit": limit},
        ) or []

    def get_cash_flow(
        self,
        ticker: str,
        period: str = "annual",
        limit: int = FMP_ANNUAL_LIMIT,
    ) -> list[dict]:
        """
        Cash flow statement for a single IDX ticker.

        Key fields returned:
            operatingCashFlow, capitalExpenditure, freeCashFlow,
            dividendsPaid, netCashProvidedByOperatingActivities
        """
        return self._get(
            f"cash-flow-statement/{ticker}.JK",
            {"period": period, "limit": limit},
        ) or []

    # ------------------------------------------------------------------
    # Convenience: fetch all three statements in one call sequence
    # ------------------------------------------------------------------

    def get_all_statements(
        self,
        ticker: str,
        period: str = "annual",
        limit: int = FMP_ANNUAL_LIMIT,
    ) -> tuple[list[dict], list[dict], list[dict]]:
        """
        Fetch income, balance, and cash flow statements in one call.
        Returns (income_rows, balance_rows, cashflow_rows).
        Each row list is ordered newest-first.
        """
        income   = self.get_income_statement(ticker, period=period, limit=limit)
        balance  = self.get_balance_sheet(ticker, period=period, limit=limit)
        cashflow = self.get_cash_flow(ticker, period=period, limit=limit)
        return income, balance, cashflow
