"""
Wyckoff v2 Diagnostic — Trace FSM state at each bar.

Shows what state the FSM was in for every bar of a ticker's history and
what events fired (or didn't, with reasons). Useful when v2 emits 0 events
on a ticker — you can see whether the FSM ever got out of UNKNOWN, whether
a candidate climax was rejected, etc.

Usage:
    python -m scripts.analysis.wyckoff_v2_diagnostic DEWA --since 2025-09-01
    python -m scripts.analysis.wyckoff_v2_diagnostic BBRI --transitions-only
"""
from __future__ import annotations

import argparse
from datetime import date, timedelta
from typing import Optional

from rich.console import Console
from rich.table import Table

from scripts.analysis.wyckoff_detector_v2 import (
    WyckoffDetectorV2, Bar, FSMPhase,
)

console = Console()


def _fetch(ticker: str, lookback_days: int = 504) -> list[Bar]:
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
    bars: list[Bar] = []
    for i, r in enumerate(rows):
        if not r.get("close") or not r.get("volume"):
            continue
        bars.append(Bar(
            idx=i,
            date=r["date"],
            open=float(r["open"]),
            high=float(r["high"]),
            low=float(r["low"]),
            close=float(r["close"]),
            volume=int(r["volume"]),
        ))
    for i, b in enumerate(bars):
        b.idx = i
    return bars


def _trace(
    ticker: str,
    since: Optional[str],
    transitions_only: bool,
    lookback_days: int,
) -> None:
    bars = _fetch(ticker, lookback_days)
    if len(bars) < 60:
        console.print(f"[red]Insufficient bars for {ticker}: {len(bars)}[/red]")
        return

    det = WyckoffDetectorV2()
    det._ticker = ticker

    rows: list[tuple] = []
    prev_phase: FSMPhase = FSMPhase.UNKNOWN
    last_event_count = 0

    for bar in bars:
        det.process(bar)
        cur_phase = det.state.phase

        # Did this bar fire a new event?
        new_event = None
        if len(det.state.events) > last_event_count:
            new_event = det.state.events[-1]
            last_event_count = len(det.state.events)

        phase_changed = cur_phase != prev_phase
        if since and bar.date < since:
            prev_phase = cur_phase
            continue

        # Compute current vol_z and trend_slope for context
        idx = bar.idx
        vz = det._vol_z(idx) if idx >= det.params.LOOKBACK_VOL else 0.0
        atr = det._atr(idx) if idx >= det.params.LOOKBACK_ATR else 0.0
        spread_atr = bar.spread / atr if atr > 0 else 0.0
        slope = det._trend_slope(idx) if idx >= det.params.LOOKBACK_TREND else 0.0

        if transitions_only and not phase_changed and not new_event:
            prev_phase = cur_phase
            continue

        rows.append((
            bar.date,
            int(bar.close),
            f"{vz:+.2f}",
            f"{spread_atr:.2f}",
            f"{slope:+.3f}",
            cur_phase.value,
            "→" if phase_changed else "",
            new_event.event_type if new_event else "",
        ))
        prev_phase = cur_phase

    # Print summary first
    console.print(f"\n[bold cyan]{ticker} v2 FSM Trace[/bold cyan]")
    console.print(f"  Total bars: {len(bars)}")
    console.print(f"  Total events fired: {len(det.state.events)}")
    console.print(f"  Final FSM phase: [yellow]{det.state.phase.value}[/yellow]")
    if det.state.range_low and det.state.range_high:
        console.print(f"  Established range: {int(det.state.range_low)} - {int(det.state.range_high)}")
    console.print(f"\nThresholds in use:")
    p = det.params
    console.print(f"  CLIMAX_VOL_Z ≥ {p.CLIMAX_VOL_Z}, CLIMAX_SPREAD_ATR ≥ {p.CLIMAX_SPREAD_ATR}, "
                  f"TREND_SLOPE_THRESHOLD ±{p.TREND_SLOPE_THRESHOLD}")

    if not det.state.events:
        # Diagnose why no events fired
        console.print(f"\n[yellow]No events fired. Diagnosis:[/yellow]")
        n = len(bars)
        last_idx = n - 1
        if last_idx >= det.params.LOOKBACK_TREND:
            slope = det._trend_slope(last_idx)
            console.print(f"  Final-bar trend slope: {slope:+.3f} "
                          f"(threshold ±{p.TREND_SLOPE_THRESHOLD})")
        # Find best climax candidates that didn't fire
        best_down = None
        best_up = None
        for i, b in enumerate(bars):
            if i < det.params.LOOKBACK_VOL:
                continue
            vz = det._vol_z(i)
            atr = det._atr(i)
            if atr <= 0:
                continue
            sa = b.spread / atr
            if vz > 1.0 and sa > 1.0:
                if b.close < b.open:
                    score = vz + sa
                    if best_down is None or score > best_down[1]:
                        best_down = (b, score, vz, sa)
                elif b.close > b.open:
                    score = vz + sa
                    if best_up is None or score > best_up[1]:
                        best_up = (b, score, vz, sa)
        if best_down:
            b, _, vz, sa = best_down
            console.print(
                f"  Best down-bar candidate: {b.date} close={int(b.close)} "
                f"vol_z={vz:.2f} spread/atr={sa:.2f} "
                f"close_pos={b.close_position:.2f}"
            )
        if best_up:
            b, _, vz, sa = best_up
            console.print(
                f"  Best up-bar candidate: {b.date} close={int(b.close)} "
                f"vol_z={vz:.2f} spread/atr={sa:.2f} "
                f"close_pos={b.close_position:.2f}"
            )

    # Print bar-by-bar trace
    if rows:
        bt = Table(
            title=f"{ticker} per-bar trace"
                  + (" (transitions/events only)" if transitions_only else "")
                  + (f" since {since}" if since else ""),
            show_header=True, header_style="bold cyan",
        )
        bt.add_column("Date", style="dim")
        bt.add_column("Close", justify="right")
        bt.add_column("vol_z", justify="right")
        bt.add_column("sprd/atr", justify="right")
        bt.add_column("slope", justify="right")
        bt.add_column("FSM phase", style="yellow")
        bt.add_column("Δ", justify="center", style="bold")
        bt.add_column("Event", style="bold green")
        for r in rows[-200:]:  # cap output
            bt.add_row(*[str(c) for c in r])
        console.print(bt)
        if len(rows) > 200:
            console.print(f"[dim](showing last 200 of {len(rows)} rows)[/dim]")


def main():
    parser = argparse.ArgumentParser(
        description="Diagnose v2 FSM state and event firing for a ticker"
    )
    parser.add_argument("ticker")
    parser.add_argument("--since", help="ISO date — only show rows from this date onward")
    parser.add_argument("--transitions-only", action="store_true",
                        help="show only bars where the FSM changed phase or fired an event")
    parser.add_argument("--lookback-days", type=int, default=504)
    args = parser.parse_args()

    _trace(
        ticker=args.ticker.upper(),
        since=args.since,
        transitions_only=args.transitions_only,
        lookback_days=args.lookback_days,
    )


if __name__ == "__main__":
    main()
