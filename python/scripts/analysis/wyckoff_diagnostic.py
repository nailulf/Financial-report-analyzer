"""
Wyckoff Diagnostic — Per-bar trace of why each detector did or did not fire.

For a given ticker and date range, prints a table with:
  - Bar OHLCV
  - Rolling stats (vol_z, range_z)
  - Climax (SC/BC) check: thresholds passed? AR confirmed?
  - Spring/UTAD check: in pierce zone? reclaim found?
  - SOS/SOW check: closes above/below prior 30d range? upper/lower third?
  - Effort/Result flags (absorption / no_demand / no_supply)

Usage:
    python -m scripts.analysis.wyckoff_diagnostic DEWA --since 2025-12-01
    python -m scripts.analysis.wyckoff_diagnostic DEWA --since 2025-12-01 --only-fires
"""
from __future__ import annotations

import argparse
from datetime import date, datetime, timedelta
from typing import List, Optional

from rich.console import Console
from rich.table import Table

from scripts.analysis.wyckoff_detector import (
    WyckoffDetector, WyckoffParams, Bar,
    SC, BC, AR_UP, AR_DOWN, SPRING, UTAD, SOS, SOW, LPS, LPSY,
    ST_LOW, ST_HIGH, ABSORPTION, NO_DEMAND, NO_SUPPLY,
)

console = Console()


def _fetch(ticker: str, lookback_days: int) -> List[Bar]:
    from utils.supabase_client import get_client
    client = get_client()
    cutoff = (date.today() - timedelta(days=lookback_days)).isoformat()
    resp = (
        client.table("daily_prices")
        .select("date, open, high, low, close, volume")
        .eq("ticker", ticker)
        .gte("date", cutoff)
        .order("date")
        .execute()
    )
    rows = resp.data or []
    return [
        Bar(
            date=r["date"],
            open=float(r["open"] or 0),
            high=float(r["high"] or 0),
            low=float(r["low"] or 0),
            close=float(r["close"] or 0),
            volume=int(r["volume"] or 0),
        )
        for r in rows
        if r.get("close") and r.get("volume")
    ]


def _trace(
    ticker: str,
    since: Optional[str],
    only_fires: bool,
    lookback_days: int = 504,
) -> None:
    bars = _fetch(ticker, lookback_days)
    if len(bars) < 60:
        console.print(f"[red]Insufficient bars for {ticker}: {len(bars)}[/red]")
        return

    det = WyckoffDetector()
    p = det.params
    det._compute_rolling_stats(bars)

    # Run full detection so we have ground-truth event dates
    events = []
    climaxes = det._suppress_nearby_climaxes(det._detect_climaxes(ticker, bars))
    events.extend(climaxes)
    events.extend(det._detect_springs_and_utads(ticker, bars))
    events.extend(det._detect_secondary_tests(ticker, bars, climaxes))
    sos_sow = det._detect_sos_sow(ticker, bars)
    events.extend(sos_sow)
    events.extend(det._detect_lps_lpsy(ticker, bars, sos_sow))
    events.extend(det._detect_effort_result(ticker, bars))
    fired_by_date = {}
    for e in events:
        fired_by_date.setdefault(e.event_date, []).append(e.event_type)

    start_idx = 0
    if since:
        for i, b in enumerate(bars):
            if b.date >= since:
                start_idx = i
                break

    # Print parameter table once
    pt = Table(title=f"Detection parameters (apply to all bars)", show_header=True, header_style="bold cyan")
    pt.add_column("Parameter")
    pt.add_column("Value", justify="right")
    pt.add_row("climax_volume_z (SC/BC)", f"≥ {p.climax_volume_z}")
    pt.add_row("climax_range_z (SC/BC)", f"≥ {p.climax_range_z}")
    pt.add_row("climax_extreme_window", f"{p.climax_extreme_window} bars")
    pt.add_row("range_lookback (Spring/UTAD/SOS)", f"{p.range_lookback} bars")
    pt.add_row("pierce_pct (Spring/UTAD)", f"≤ {p.pierce_pct*100:.1f}%")
    pt.add_row("reclaim_window (Spring/UTAD)", f"≤ {p.reclaim_window} bars")
    pt.add_row("spring_volume_z (Spring/UTAD reclaim)", f"≥ {p.spring_volume_z}")
    pt.add_row("absorption_volume_z", f"≥ {p.absorption_volume_z}")
    pt.add_row("absorption_range_z", f"≤ {p.absorption_range_z}")
    pt.add_row("quiet_volume_z (no_demand/no_supply)", f"≤ {p.quiet_volume_z}")
    console.print(pt)

    # Per-bar diagnostic table
    bt = Table(
        title=f"{ticker} per-bar diagnostic" + (f" (since {since})" if since else ""),
        show_header=True, header_style="bold cyan",
    )
    bt.add_column("Date", style="dim")
    bt.add_column("Close", justify="right")
    bt.add_column("vol_z", justify="right")
    bt.add_column("range_z", justify="right")
    bt.add_column("Climax", justify="center")
    bt.add_column("Spring/UTAD", justify="center")
    bt.add_column("SOS/SOW", justify="center")
    bt.add_column("Effort/Result", justify="center")
    bt.add_column("FIRED", style="bold green")

    for i in range(start_idx, len(bars)):
        bar = bars[i]
        if bar.vol_z is None or bar.range_z is None:
            continue

        # ── Climax check ──
        climax_status = ""
        passes_climax_thresholds = (
            bar.vol_z >= p.climax_volume_z and bar.range_z >= p.climax_range_z
        )
        if passes_climax_thresholds:
            window = bars[max(0, i - p.climax_extreme_window):i + 1]
            window_min = min(b.low for b in window)
            window_max = max(b.high for b in window)
            is_down = bar.close < bar.open
            is_up = bar.close > bar.open
            at_low = is_down and bar.low <= window_min * 1.005
            at_high = is_up and bar.high >= window_max * 0.995

            if at_low:
                ar = det._find_automatic_reaction(bars, i, direction="up")
                climax_status = f"SC✓ AR={'✓' if ar else '✗'}"
            elif at_high:
                ar = det._find_automatic_reaction(bars, i, direction="down")
                climax_status = f"BC✓ AR={'✓' if ar else '✗'}"
            else:
                climax_status = "thresh✓ extr✗"
        else:
            v_pass = bar.vol_z >= p.climax_volume_z
            r_pass = bar.range_z >= p.climax_range_z
            if not v_pass and not r_pass:
                climax_status = "—"
            else:
                climax_status = f"vol{'✓' if v_pass else '✗'} rng{'✓' if r_pass else '✗'}"

        # ── Spring/UTAD check ──
        sp_status = "—"
        if i >= p.range_lookback:
            window = bars[i - p.range_lookback: i]
            range_low = min(b.low for b in window)
            range_high = max(b.high for b in window)
            pierce_low = range_low * (1 - p.pierce_pct)
            pierce_high = range_high * (1 + p.pierce_pct)
            if pierce_low < bar.low <= range_low and bar.close < range_low:
                rec = det._find_reclaim(bars, i, range_low, "up")
                sp_status = f"sprPiercd reclaim={'✓' if rec is not None else '✗'}"
            elif range_high <= bar.high < pierce_high and bar.close > range_high:
                rec = det._find_reclaim(bars, i, range_high, "down")
                sp_status = f"utadPiercd reclaim={'✓' if rec is not None else '✗'}"

        # ── SOS/SOW check ──
        ss_status = "—"
        if i >= 30 and bar.vol_z >= 0.5 and bar.range_z >= 1.0:
            sos_window = bars[i - 30: i]
            prior_high = max(b.high for b in sos_window)
            prior_low = min(b.low for b in sos_window)
            br = bar.high - bar.low
            if br > 0:
                close_pos = (bar.close - bar.low) / br
                is_up = bar.close > bar.open
                breakout = bar.close > prior_high * 0.99
                breakdown = bar.close < prior_low * 1.01
                if is_up and close_pos >= 0.65 and breakout:
                    ss_status = "SOS✓"
                elif (not is_up) and close_pos <= 0.35 and breakdown:
                    ss_status = "SOW✓"
                else:
                    parts = []
                    if is_up:
                        parts.append("up")
                        if close_pos < 0.65: parts.append(f"close@{close_pos:.0%}")
                        if not breakout: parts.append("noBrk")
                    else:
                        parts.append("dn")
                        if close_pos > 0.35: parts.append(f"close@{close_pos:.0%}")
                        if not breakdown: parts.append("noBkd")
                    ss_status = " ".join(parts)

        # ── Effort/Result ──
        er_status = "—"
        if bar.vol_z >= p.absorption_volume_z and bar.range_z <= p.absorption_range_z:
            er_status = "absorption"
        elif (bar.close > bar.open and bar.vol_z <= p.quiet_volume_z and bar.range_z >= p.quiet_range_z):
            er_status = "no_demand"
        elif (bar.close < bar.open and bar.vol_z <= p.quiet_volume_z and bar.range_z >= p.quiet_range_z):
            er_status = "no_supply"

        fired = ", ".join(fired_by_date.get(bar.date, []))
        if only_fires and not fired:
            continue

        bt.add_row(
            bar.date,
            f"{int(bar.close):,}",
            f"{bar.vol_z:+.2f}",
            f"{bar.range_z:+.2f}",
            climax_status,
            sp_status,
            ss_status,
            er_status,
            fired or "",
        )

    console.print(bt)

    # Summary
    fires_in_range = [d for d in fired_by_date if (not since) or d >= since]
    console.print(f"\n[bold]Summary:[/bold] {len(fires_in_range)} firing bars in range")
    for d in sorted(fires_in_range):
        console.print(f"  {d}: {', '.join(fired_by_date[d])}")


def main():
    parser = argparse.ArgumentParser(
        description="Diagnose why Wyckoff events did/didn't fire on a ticker"
    )
    parser.add_argument("ticker", help="ticker code, e.g. DEWA")
    parser.add_argument("--since", help="ISO date — only show bars from this date onward")
    parser.add_argument("--only-fires", action="store_true", help="show only bars that fired an event")
    parser.add_argument("--lookback-days", type=int, default=504, help="how far back to fetch (default 504)")
    args = parser.parse_args()

    _trace(
        ticker=args.ticker.upper(),
        since=args.since,
        only_fires=args.only_fires,
        lookback_days=args.lookback_days,
    )


if __name__ == "__main__":
    main()
