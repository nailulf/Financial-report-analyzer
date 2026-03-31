"""
Shared pytest fixtures for Phase 6 AI pipeline tests.

Provides:
- Realistic financial data fixtures (bank, cyclical, minimal)
- Stock profile fixtures
- Mock Supabase client
"""

from __future__ import annotations

import json
import pytest
from datetime import date
from typing import Any
from unittest.mock import MagicMock


# ---------------------------------------------------------------------------
# Financial data fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def sample_financials_bank() -> list[dict]:
    """
    BBCA-like: 10 years of annual data for a premium bank.
    Strong revenue growth, high margins, D/E=0 (Stockbit banking quirk).
    """
    base_revenue = 50_000_000_000_000  # 50T IDR in 2016
    rows = []
    for i, year in enumerate(range(2016, 2027)):
        growth = 1.08 if year != 2020 else 0.95  # COVID dip
        if i > 0:
            base_revenue = int(base_revenue * growth)

        ni = int(base_revenue * 0.48)
        oi = int(base_revenue * 0.55)
        source = "stockbit_keystats" if year >= 2026 else "stockbit"
        is_ttm = year >= 2026 and "keystats" in source

        rows.append({
            "id": 1000 + i,
            "ticker": "TESTBANK",
            "year": year,
            "quarter": 0,
            "is_ttm": is_ttm,
            "period_end": f"{year}-12-31",
            "revenue": base_revenue,
            "cost_of_revenue": int(base_revenue * 0.12),
            "gross_profit": int(base_revenue * 0.88),
            "operating_expense": int(base_revenue * 0.33),
            "operating_income": oi,
            "interest_expense": int(base_revenue * 0.15),
            "income_before_tax": int(ni * 1.25),
            "tax_expense": int(ni * 0.25),
            "net_income": ni,
            "eps": round(ni / 123_000_000_000, 2),  # ~123B shares
            "total_assets": int(base_revenue * 15),
            "current_assets": None,  # banks don't report this way
            "total_liabilities": int(base_revenue * 12),
            "current_liabilities": None,
            "total_equity": int(base_revenue * 3),
            "total_debt": 0,  # banks: structural
            "cash_and_equivalents": int(base_revenue * 0.2),
            "book_value_per_share": round(base_revenue * 3 / 123_000_000_000, 2),
            "operating_cash_flow": int(ni * 1.3),
            "capex": int(ni * -0.05),
            "free_cash_flow": int(ni * 1.25),
            "dividends_paid": int(ni * -0.65) if year < 2026 else None,
            "gross_margin": 88.0,
            "operating_margin": 55.0,
            "net_margin": 48.0 + i * 0.3,
            "roe": 20.0 + (i - 5) * 0.2,
            "roa": 3.5 + (i - 5) * 0.05,
            "current_ratio": 0.0,        # Stockbit stores 0 for banks
            "debt_to_equity": 0.0,        # Stockbit stores 0 for banks
            "interest_coverage": 0.0,     # Stockbit stores 0 for banks
            "pe_ratio": 18.0 - i * 0.3 if year < 2026 else 14.5,
            "pbv_ratio": 3.5 - i * 0.05 if year < 2026 else 2.97,
            "dividend_yield": 3.0 + i * 0.2 if year < 2026 else 5.0,
            "payout_ratio": 65.0,
            "source": source,
            "last_updated": f"{year}-12-31T00:00:00+00:00",
        })
    return rows


@pytest.fixture
def sample_financials_cyclical() -> list[dict]:
    """
    ADRO-like: 10 years of volatile cyclical commodity company.
    Revenue and earnings swing wildly. Positive debt. Non-banking.
    """
    # Revenue pattern: grows, spikes in 2022, collapses after
    revenue_pattern = [
        15e12, 18e12, 25e12, 20e12, 16e12,  # 2016-2020
        22e12, 55e12, 45e12, 32e12, 30e12,  # 2021-2025
        30e12,                                # 2026 (TTM)
    ]
    rows = []
    for i, year in enumerate(range(2016, 2027)):
        rev = int(revenue_pattern[i])
        margin = 0.30 if year not in (2022, 2023) else 0.45
        ni = int(rev * margin * (0.6 if year != 2020 else 0.3))
        source = "stockbit_keystats" if year >= 2026 else "stockbit"
        is_ttm = year >= 2026 and "keystats" in source

        rows.append({
            "id": 2000 + i,
            "ticker": "TESTCYCL",
            "year": year,
            "quarter": 0,
            "is_ttm": is_ttm,
            "period_end": f"{year}-12-31",
            "revenue": rev,
            "cost_of_revenue": int(rev * 0.65),
            "gross_profit": int(rev * 0.35),
            "operating_expense": int(rev * 0.10),
            "operating_income": int(rev * 0.25),
            "interest_expense": int(rev * 0.02),
            "income_before_tax": int(ni * 1.2),
            "tax_expense": int(ni * 0.2),
            "net_income": ni,
            "eps": round(ni / 31_000_000_000, 2),  # ~31B shares
            "total_assets": int(rev * 3),
            "current_assets": int(rev * 1.2),
            "total_liabilities": int(rev * 1.5),
            "current_liabilities": int(rev * 0.8),
            "total_equity": int(rev * 1.5),
            "total_debt": int(rev * 0.3),
            "cash_and_equivalents": int(rev * 0.4),
            "book_value_per_share": round(rev * 1.5 / 31_000_000_000, 2),
            "operating_cash_flow": int(ni * 1.1),
            "capex": int(ni * -0.4),
            "free_cash_flow": int(ni * 0.7) if year != 2025 else int(ni * -0.5),
            "dividends_paid": int(ni * -0.5) if year < 2026 else None,
            "gross_margin": 35.0 if year not in (2022, 2023) else 45.0,
            "operating_margin": 25.0,
            "net_margin": margin * 60 if year != 2020 else margin * 30,
            "roe": round(ni / (rev * 1.5) * 100, 2),
            "roa": round(ni / (rev * 3) * 100, 2),
            "current_ratio": round(rev * 1.2 / (rev * 0.8), 2),
            "debt_to_equity": round(rev * 0.3 / (rev * 1.5), 2),
            "interest_coverage": round(rev * 0.25 / (rev * 0.02), 2) if rev * 0.02 > 0 else None,
            "pe_ratio": round(3100 / (ni / 31_000_000_000), 2) if ni > 0 else None,
            "pbv_ratio": round(3100 / (rev * 1.5 / 31_000_000_000), 2),
            "dividend_yield": round(ni * 0.5 / 31_000_000_000 / 3100 * 100, 2) if ni > 0 else 0,
            "payout_ratio": 50.0,
            "source": source,
            "last_updated": f"{year}-12-31T00:00:00+00:00",
        })
    return rows


@pytest.fixture
def sample_financials_minimal() -> list[dict]:
    """
    Minimal data: only 2 years, missing many fields.
    Should fail ready_for_ai gate.
    """
    return [
        {
            "ticker": "TESTMIN",
            "year": 2024,
            "quarter": 0,
            "is_ttm": False,
            "revenue": 500_000_000_000,
            "net_income": 50_000_000_000,
            "total_assets": 2_000_000_000_000,
            "total_equity": 800_000_000_000,
            "source": "yfinance",
        },
        {
            "ticker": "TESTMIN",
            "year": 2025,
            "quarter": 0,
            "is_ttm": False,
            "revenue": 550_000_000_000,
            "net_income": 60_000_000_000,
            "total_assets": 2_200_000_000_000,
            "total_equity": 900_000_000_000,
            "source": "yfinance",
        },
    ]


# ---------------------------------------------------------------------------
# Stock profile fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def sample_stock_bank() -> dict:
    """Stock profile for a bank."""
    return {
        "ticker": "TESTBANK",
        "name": "PT Test Bank Tbk.",
        "sector": "Financials",
        "subsector": "Bank",
        "listing_date": "2000-01-15",
        "listed_shares": 123_000_000_000,
        "market_cap": 824_000_000_000_000,
        "board": "Main",
        "is_lq45": True,
        "is_idx30": True,
        "status": "Active",
    }


@pytest.fixture
def sample_stock_cyclical() -> dict:
    """Stock profile for a cyclical commodity company."""
    return {
        "ticker": "TESTCYCL",
        "name": "PT Test Mining Tbk.",
        "sector": "Energy",
        "subsector": "Minyak, Gas & Batu Bara",
        "listing_date": "2008-07-10",
        "listed_shares": 31_000_000_000,
        "market_cap": 35_000_000_000_000,
        "board": "Main",
        "is_lq45": True,
        "is_idx30": False,
        "status": "Active",
    }


@pytest.fixture
def sample_stock_ipo() -> dict:
    """Stock profile for a recently listed company (IPO 2023)."""
    return {
        "ticker": "TESTIPO",
        "name": "PT Test New Tbk.",
        "sector": "Technology",
        "subsector": "Perangkat Lunak & Jasa TI",
        "listing_date": "2023-06-15",
        "listed_shares": 5_000_000_000,
        "market_cap": 3_000_000_000_000,
        "board": "Development",
        "is_lq45": False,
        "is_idx30": False,
        "status": "Active",
    }


# ---------------------------------------------------------------------------
# Mock Supabase client
# ---------------------------------------------------------------------------

@pytest.fixture
def mock_sb():
    """
    Mock Supabase client that returns empty results by default.
    Tests can configure specific table responses via mock_sb.configure().
    """
    client = MagicMock()

    # Default: all queries return empty
    table_mock = MagicMock()
    table_mock.select.return_value = table_mock
    table_mock.eq.return_value = table_mock
    table_mock.gt.return_value = table_mock
    table_mock.gte.return_value = table_mock
    table_mock.in_.return_value = table_mock
    table_mock.order.return_value = table_mock
    table_mock.limit.return_value = table_mock
    table_mock.range.return_value = table_mock
    table_mock.single.return_value = table_mock
    table_mock.execute.return_value = MagicMock(data=[], count=0)
    table_mock.upsert.return_value = table_mock

    client.table.return_value = table_mock
    return client


# ---------------------------------------------------------------------------
# Shared config fixture
# ---------------------------------------------------------------------------

@pytest.fixture
def scoring_config() -> dict:
    """Load the shared scoring config (or provide test defaults)."""
    import os
    config_path = os.path.join(
        os.path.dirname(__file__), "..", "shared", "scoring-config.json"
    )
    if os.path.exists(config_path):
        with open(config_path) as f:
            return json.load(f)

    # Fallback test defaults matching FRD spec
    return {
        "health_thresholds": {
            "roe":            {"green": 15,  "yellow": 8},
            "net_margin":     {"green": 10,  "yellow": 5},
            "gross_margin":   {"green": 30,  "yellow": 15},
            "roa":            {"green": 8,   "yellow": 4},
            "current_ratio":  {"green": 1.5, "yellow": 1.0},
            "debt_to_equity": {"green": 1.0, "yellow": 2.0, "invert": True},
            "fcf":            {"type": "sign", "green": 0},
        },
        "valuation": {
            "risk_free_rate":      6.75,
            "equity_risk_premium": 6.25,
            "base_wacc":           13.0,
            "terminal_growth":     3.0,
            "scenario_variation":  0.10,
            "graham_constant":     22.5,
            "mos_undervalued":     30,
            "mos_fairly_valued":   0,
        },
    }
