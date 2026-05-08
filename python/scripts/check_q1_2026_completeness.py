"""
check_q1_2026_completeness.py — count active stocks missing Q1 2026 financials.

Three buckets are reported:
  • MISSING_ROW       — no row exists at (year=2026, quarter=1)
  • EMPTY_CORE        — row exists but revenue and net_income are both NULL
  • OK                — row exists with at least one core field populated

Run: cd python && python -m scripts.check_q1_2026_completeness
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from utils.supabase_client import get_client


TARGET_YEAR = 2026
TARGET_QUARTER = 1


def main() -> None:
    db = get_client()

    active = db.table("stocks").select("ticker").eq("status", "Active").execute().data or []
    active_tickers = {r["ticker"] for r in active}
    total = len(active_tickers)

    rows: list[dict] = []
    page = 0
    while True:
        resp = (
            db.table("financials")
            .select("ticker, revenue, net_income, total_assets, operating_cash_flow")
            .eq("year", TARGET_YEAR)
            .eq("quarter", TARGET_QUARTER)
            .range(page * 1000, page * 1000 + 999)
            .execute()
        )
        chunk = resp.data or []
        rows.extend(chunk)
        if len(chunk) < 1000:
            break
        page += 1

    by_ticker = {r["ticker"]: r for r in rows}

    missing_row: list[str] = []
    empty_core: list[str] = []
    ok: list[str] = []

    for t in sorted(active_tickers):
        r = by_ticker.get(t)
        if r is None:
            missing_row.append(t)
            continue
        if r.get("revenue") is None and r.get("net_income") is None:
            empty_core.append(t)
            continue
        ok.append(t)

    print(f"Active stocks:           {total}")
    print(f"Has full Q1 2026 row:    {len(ok)}  ({len(ok) * 100 / total:.1f}%)")
    print(f"Row exists but empty:    {len(empty_core)}")
    print(f"Row missing entirely:    {len(missing_row)}")
    print(f"TOTAL incomplete:        {len(missing_row) + len(empty_core)}")
    print()

    if empty_core:
        print(f"--- {len(empty_core)} stocks with empty Q1 2026 row ---")
        print(", ".join(empty_core[:50]) + ("…" if len(empty_core) > 50 else ""))
        print()

    if missing_row:
        print(f"--- {len(missing_row)} stocks with no Q1 2026 row ---")
        print(", ".join(missing_row[:50]) + ("…" if len(missing_row) > 50 else ""))


if __name__ == "__main__":
    main()
