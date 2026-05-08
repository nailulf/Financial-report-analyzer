"""Inspect RIGS financials rows to understand TTM vs Q1 2026 gap."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from utils.supabase_client import get_client


def main() -> None:
    db = get_client()
    rows = (
        db.table("financials")
        .select("year, quarter, period_end, is_ttm, source, last_updated, "
                "revenue, net_income, operating_cash_flow")
        .eq("ticker", "RIGS")
        .order("year", desc=True)
        .order("quarter", desc=True)
        .limit(20)
        .execute()
        .data
        or []
    )
    print(f"RIGS — {len(rows)} rows")
    print(f"  {'period':<10} {'period_end':<12} {'TTM':<5} {'src':<18} {'last_upd':<12} "
          f"{'revenue':>16} {'net_income':>14}")
    for r in rows:
        period = f"{r['year']} FY" if r["quarter"] == 0 else f"{r['year']} Q{r['quarter']}"
        ttm = "Y" if r.get("is_ttm") else "—"
        src = (r.get("source") or "")[:18]
        pe = (r.get("period_end") or "")[:10]
        lu = (r.get("last_updated") or "")[:10]
        rev = r.get("revenue")
        ni = r.get("net_income")
        print(f"  {period:<10} {pe:<12} {ttm:<5} {src:<18} {lu:<12} "
              f"{rev if rev is not None else '—':>16} "
              f"{ni if ni is not None else '—':>14}")


if __name__ == "__main__":
    main()
