"""
check_specific_tickers.py — inspect financials coverage for a small ticker list.

Shows the most recent 6 (year, quarter) rows for each ticker, with which core
fields are populated, the source, and last_updated. Useful for spot-checking
whether the DB matches what's visible on Stockbit.

Run: cd python && python -m scripts.check_specific_tickers
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from utils.supabase_client import get_client

TICKERS = ["AADI", "ADMR", "ADRO", "BBRI", "BMRI", "BBCA"]


def fmt_period(year: int, quarter: int) -> str:
    return f"{year} FY" if quarter == 0 else f"{year} Q{quarter}"


def main() -> None:
    db = get_client()

    for t in TICKERS:
        rows = (
            db.table("financials")
            .select("year, quarter, period_end, revenue, net_income, "
                    "operating_cash_flow, source, is_ttm, last_updated")
            .eq("ticker", t)
            .order("year", desc=True)
            .order("quarter", desc=True)
            .limit(8)
            .execute()
            .data
            or []
        )

        print(f"\n=== {t} ===")
        if not rows:
            print("  (no financials rows)")
            continue

        print(f"  {'period':<10} {'period_end':<12} {'rev?':<5} {'NI?':<5} {'OCF?':<5} "
              f"{'TTM':<5} {'source':<18} last_updated")
        for r in rows:
            period = fmt_period(r["year"], r["quarter"])
            rev = "Y" if r.get("revenue") is not None else "—"
            ni = "Y" if r.get("net_income") is not None else "—"
            ocf = "Y" if r.get("operating_cash_flow") is not None else "—"
            ttm = "Y" if r.get("is_ttm") else "—"
            src = (r.get("source") or "")[:18]
            pe = (r.get("period_end") or "")[:10]
            lu = (r.get("last_updated") or "")[:10]
            print(f"  {period:<10} {pe:<12} {rev:<5} {ni:<5} {ocf:<5} {ttm:<5} {src:<18} {lu}")


if __name__ == "__main__":
    main()
