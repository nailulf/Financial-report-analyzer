"""Show last 10 runs of financials-related scrapers."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from utils.supabase_client import get_client


def main() -> None:
    db = get_client()

    for scraper in ["financials_fallback", "financials"]:
        rows = (
            db.table("scraper_runs")
            .select("started_at, finished_at, status, stocks_processed, "
                    "stocks_failed, stocks_skipped, metadata")
            .eq("scraper_name", scraper)
            .order("started_at", desc=True)
            .limit(10)
            .execute()
            .data
            or []
        )
        print(f"\n=== {scraper} (last {len(rows)} runs) ===")
        if not rows:
            print("  (no runs recorded)")
            continue
        print(f"  {'started':<22} {'status':<10} {'proc':>5} {'fail':>5} "
              f"{'skip':>5}  metadata")
        for r in rows:
            started = (r.get("started_at") or "")[:19]
            status = r.get("status") or ""
            proc = r.get("stocks_processed") or 0
            fail = r.get("stocks_failed") or 0
            skip = r.get("stocks_skipped") or 0
            meta = str(r.get("metadata") or "")[:60]
            print(f"  {started:<22} {status:<10} {proc:>5} {fail:>5} {skip:>5}  {meta}")


if __name__ == "__main__":
    main()
