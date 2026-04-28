"""
Wyckoff Structural Event Detector — Detect classical Wyckoff events from
price/volume bars.

This is a STRUCTURAL detector that produces discrete events (single-day
signals), in contrast to market_phase_detector.py which produces contiguous
SMA-based phase bands. The two are complementary:

  - SMA detector → "what trend regime are we in right now?"
  - Wyckoff detector → "did an institutional accumulation/distribution event
    just occur?"

Three detection layers:

  Layer 1 (Climax detection):
    SC  = Selling Climax  → wide-range down bar at lowest close in N days,
                            volume z-score > threshold
    BC  = Buying Climax   → mirror at highs

  Layer 2 (Spring / UTAD):
    Spring = pierces a recent support level → reclaims it within 1-3 bars on
             expanding volume → bullish (failed breakdown)
    UTAD   = pierces a recent resistance level → fails and reverses → bearish
             (failed breakout)

  Layer 3 (Effort vs Result):
    absorption = high volume z but small price range = institutions absorbing
                 supply (bullish if at lows, bearish if at highs)
    no_demand  = low-volume up bar = rally on weak participation
    no_supply  = low-volume down bar = decline on weak selling

References:
  - Hank Pruden, "The Three Skills of Top Trading"
  - David Weis, "Trades About to Happen"
  - Anna Coulling, "A Complete Guide to Volume Price Analysis"

Usage:
    detector = WyckoffDetector()
    events = detector.detect_ticker("BBRI")
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Tuple

from utils.supabase_client import get_client, bulk_upsert, delete_where

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Event type constants — keep in sync with schema CHECK constraint
# ---------------------------------------------------------------------------

# Accumulation events (bottoming pattern)
PS       = "PS"          # Preliminary Support
SC       = "SC"          # Selling Climax
AR_UP    = "AR_up"       # Automatic Rally (after SC)
ST_LOW   = "ST_low"      # Secondary Test (of SC low)
SPRING   = "Spring"      # Failed breakdown
SOS      = "SOS"         # Sign of Strength
LPS      = "LPS"         # Last Point of Support

# Distribution events (topping pattern)
PSY      = "PSY"         # Preliminary Supply
BC       = "BC"          # Buying Climax
AR_DOWN  = "AR_down"     # Automatic Reaction (after BC)
ST_HIGH  = "ST_high"     # Secondary Test (of BC high)
UTAD     = "UTAD"        # Upthrust After Distribution
SOW      = "SOW"         # Sign of Weakness
LPSY     = "LPSY"        # Last Point of Supply

# Effort/Result anomalies
ABSORPTION = "absorption"
NO_DEMAND  = "no_demand"
NO_SUPPLY  = "no_supply"

# Passive drift — sustained directional move on below-average volume.
# Not classical Wyckoff terminology, but captures the "slow markup/markdown"
# phases that produce no climactic events.
PASSIVE_MARKUP   = "passive_markup"
PASSIVE_MARKDOWN = "passive_markdown"

BULLISH_EVENTS = {SC, AR_UP, SPRING, SOS, LPS, NO_SUPPLY, PASSIVE_MARKUP}
BEARISH_EVENTS = {BC, AR_DOWN, UTAD, SOW, LPSY, NO_DEMAND, PASSIVE_MARKDOWN}


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

@dataclass
class WyckoffParams:
    """Tunable parameters for Wyckoff event detection."""
    lookback_days: int = 504              # ~2 years of data
    rolling_window: int = 50              # for volume/range z-scores

    # Climax thresholds (range_z 1.2 catches borderline-narrow capitulation
    # bars that have climactic volume but didn't quite expand the range —
    # these are real climaxes that the prior 1.5 threshold missed)
    climax_volume_z: float = 2.0          # vol_z > this = climactic volume
    climax_range_z: float = 1.2           # range_z > this = wide bar
    climax_extreme_window: int = 60       # close must be lowest/highest in this window

    # Spring / UTAD thresholds (5% pierce catches deeper false-breakdowns
    # common in IDX small/mid-caps — 3% was too tight)
    range_lookback: int = 30              # define "recent range" via this window
    pierce_pct: float = 0.05              # max % beyond range boundary to qualify
    reclaim_window: int = 3               # bars to reclaim level after pierce
    spring_volume_z: float = 0.8          # min volume z-score on the reclaim bar

    # SOS / SOW suppression — 10 bars is sufficient to dedupe within a single
    # breakout cluster while still allowing a fresh SOS/SOW after a 2-week gap.
    # Prior 20 bars caused January continuations to be eaten by December SOSes.
    sos_sow_suppress_bars: int = 10

    # Absorption / no-demand / no-supply
    absorption_volume_z: float = 1.5      # high volume threshold
    absorption_range_z: float = -0.5      # narrow range threshold (z < this)
    quiet_volume_z: float = -0.7          # low-volume threshold for no-demand/supply
    quiet_range_z: float = 0.3            # bar still needs some range

    # Passive drift detection — for slow markups/markdowns that grind without
    # producing climactic events. Looks for sustained directional moves on
    # below-average volume.
    passive_window_bars: int = 30         # rolling window length
    passive_min_move_pct: float = 0.10    # net move ≥ 10% in window
    passive_max_avg_vol_z: float = -0.1   # average vol_z must be NEGATIVE
                                          # (drift, not breakout)
    passive_suppress_bars: int = 30       # one passive event per 30-bar block


# ---------------------------------------------------------------------------
# Data containers
# ---------------------------------------------------------------------------

@dataclass
class Bar:
    """One trading day with computed rolling statistics."""
    date: str
    open: float
    high: float
    low: float
    close: float
    volume: int
    # Computed:
    vol_z: Optional[float] = None        # (volume - mean) / std over rolling window
    range_z: Optional[float] = None      # (high - low) z-score
    range_size: float = 0.0


@dataclass
class WyckoffEvent:
    """One detected event."""
    ticker: str
    event_type: str
    event_date: str
    price: int
    volume: Optional[int]
    volume_z: float
    range_z: float
    confidence: int
    inferred_phase: Optional[str] = None
    notes: Optional[str] = None


# ---------------------------------------------------------------------------
# Main Detector
# ---------------------------------------------------------------------------

class WyckoffDetector:
    """
    Detect Wyckoff structural events for IDX stocks.

    Usage:
        detector = WyckoffDetector()
        events = detector.detect_ticker("BBCA")
        detector.detect_batch(["BBCA", "BBRI", "BMRI"])
    """

    def __init__(self, params: WyckoffParams | None = None):
        self.params = params or WyckoffParams()

    # =================================================================
    # Public API
    # =================================================================

    def detect_ticker(self, ticker: str, dry_run: bool = False) -> List[WyckoffEvent]:
        """Full detection pipeline for one ticker."""
        bars = self._fetch_bars(ticker)
        if len(bars) < self.params.rolling_window + 10:
            logger.info("%s: insufficient bars (%d), skipping", ticker, len(bars))
            return []

        self._compute_rolling_stats(bars)

        # Layer 1: climaxes (SC/BC + AR). Dedupe nearby climaxes — in a
        # sustained trend, every new 60-day high with high volume would
        # otherwise emit a BC, drowning the chart. Real Wyckoff has ONE
        # climax per swing.
        climaxes = self._detect_climaxes(ticker, bars)
        climaxes = self._suppress_nearby_climaxes(climaxes, window_bars=30)

        # Layer 2: springs / UTADs (cleanest structural signals)
        springs = self._detect_springs_and_utads(ticker, bars)

        # Layer 3: secondary tests of climax extremes (low-volume retests)
        secondary_tests = self._detect_secondary_tests(ticker, bars, climaxes)

        # Layer 4: SOS / SOW — wide-range breakout/breakdown bars
        sos_sow = self._detect_sos_sow(ticker, bars)

        # Layer 5: LPS / LPSY — pullback after SOS/SOW (entry trigger)
        lps_lpsy = self._detect_lps_lpsy(ticker, bars, sos_sow)

        # Layer 6: effort-vs-result anomalies (absorption, no_demand, no_supply)
        effort = self._detect_effort_result(ticker, bars)

        # Layer 7: passive drift — slow markup/markdown without climactic events
        passive = self._detect_passive_drifts(ticker, bars)

        # If a single bar fires both a climax (SC/BC) AND an SOS/SOW, prefer
        # the climax — it's the more specific event with stronger criteria.
        climax_dates = {e.event_date for e in climaxes if e.event_type in (SC, BC)}
        sos_sow = [
            e for e in sos_sow
            if not (e.event_date in climax_dates and (
                (e.event_type == SOW and any(
                    c.event_type == SC and c.event_date == e.event_date for c in climaxes
                )) or
                (e.event_type == SOS and any(
                    c.event_type == BC and c.event_date == e.event_date for c in climaxes
                ))
            ))
        ]
        # LPSY/LPS anchored on suppressed SOS/SOW must also drop
        live_anchor_dates = {e.event_date for e in sos_sow}
        # (re-run the LPS detector with the filtered anchors)
        lps_lpsy = self._detect_lps_lpsy(ticker, bars, sos_sow)

        events: List[WyckoffEvent] = []
        events.extend(climaxes)
        events.extend(springs)
        events.extend(secondary_tests)
        events.extend(sos_sow)
        events.extend(lps_lpsy)
        events.extend(effort)
        events.extend(passive)

        # Dedupe (date, type) — overlapping detectors can collide.
        events = self._dedupe_events(events)

        # Sort by date so downstream consumers see them chronologically
        events.sort(key=lambda e: e.event_date)

        if not dry_run:
            self._upsert_events(ticker, events)
            logger.info("%s: saved %d Wyckoff events", ticker, len(events))
        else:
            logger.info("%s: detected %d Wyckoff events (dry run)", ticker, len(events))

        return events

    def detect_batch(
        self,
        tickers: List[str] | None = None,
        dry_run: bool = False,
    ) -> Dict[str, int]:
        """Batch detection. If tickers=None, processes all active stocks."""
        if tickers is None:
            tickers = self._fetch_active_tickers()

        results: Dict[str, int] = {}
        total = len(tickers)

        for i, ticker in enumerate(tickers, 1):
            try:
                evts = self.detect_ticker(ticker, dry_run=dry_run)
                results[ticker] = len(evts)
                if i % 50 == 0 or i == total:
                    logger.info("Progress: %d / %d tickers", i, total)
            except Exception:
                logger.exception("%s: wyckoff detection failed", ticker)
                results[ticker] = -1

        ok = sum(1 for v in results.values() if v >= 0)
        failed = sum(1 for v in results.values() if v < 0)
        logger.info("Wyckoff batch complete: %d ok, %d failed", ok, failed)
        return results

    def annotate_phases(
        self,
        ticker: str,
        events: List[WyckoffEvent],
        phases: List[Any],  # MarketPhase objects from market_phase_detector
    ) -> List[Dict[str, Any]]:
        """
        Group events into the SMA-based phase bands they fall within and
        compute per-phase Wyckoff metadata for storage on market_phases.

        Returns list of dicts with keys:
            phase_id_index, wyckoff_phase, wyckoff_events (json), absorption_score
        """
        annotations: List[Dict[str, Any]] = []
        for idx, phase in enumerate(phases):
            phase_events = [
                e for e in events
                if phase.start_date <= e.event_date <= phase.end_date
            ]

            wyckoff_phase = self._infer_phase_from_events(phase_events, phase)

            absorption_score = self._compute_absorption_score(phase_events, phase)

            event_summary = [
                {"type": e.event_type, "date": e.event_date, "confidence": e.confidence}
                for e in phase_events
            ]

            annotations.append({
                "phase_id_index": idx,
                "wyckoff_phase": wyckoff_phase,
                "wyckoff_events": event_summary,
                "absorption_score": absorption_score,
            })
        return annotations

    # =================================================================
    # Layer 1: Climax detection (SC / BC)
    # =================================================================

    def _detect_climaxes(
        self, ticker: str, bars: List[Bar],
    ) -> List[WyckoffEvent]:
        """
        Selling Climax (SC):
          - Down bar (close < open)
          - Wide range (range_z > climax_range_z)
          - Climactic volume (vol_z > climax_volume_z)
          - Closing at/near lowest low in climax_extreme_window

        Buying Climax (BC) is the mirror condition at highs.
        """
        p = self.params
        events: List[WyckoffEvent] = []
        N = len(bars)

        for i, bar in enumerate(bars):
            if bar.vol_z is None or bar.range_z is None:
                continue
            if bar.vol_z < p.climax_volume_z or bar.range_z < p.climax_range_z:
                continue

            # Lookback window for "lowest/highest in N"
            lo = max(0, i - p.climax_extreme_window)
            window = bars[lo:i + 1]
            window_min = min(b.low for b in window)
            window_max = max(b.high for b in window)

            is_down = bar.close < bar.open
            is_up = bar.close > bar.open

            # SC: down bar at extreme low — only emit if AR confirms.
            # Without AR follow-through it's just a wide-range down bar,
            # not a climax in the structural sense.
            if is_down and bar.low <= window_min * 1.005:
                ar = self._find_automatic_reaction(bars, i, direction="up")
                if ar is None:
                    continue
                conf = self._climax_confidence(bar, p)
                events.append(WyckoffEvent(
                    ticker=ticker,
                    event_type=SC,
                    event_date=bar.date,
                    price=int(bar.close),
                    volume=int(bar.volume),
                    volume_z=round(bar.vol_z, 2),
                    range_z=round(bar.range_z, 2),
                    confidence=conf,
                    inferred_phase="accumulation",
                    notes=f"Selling Climax: panic low on volume z={bar.vol_z:.1f}",
                ))
                _, ar_bar = ar
                events.append(WyckoffEvent(
                    ticker=ticker,
                    event_type=AR_UP,
                    event_date=ar_bar.date,
                    price=int(ar_bar.close),
                    volume=int(ar_bar.volume),
                    volume_z=round(ar_bar.vol_z or 0, 2),
                    range_z=round(ar_bar.range_z or 0, 2),
                    confidence=max(40, conf - 15),
                    inferred_phase="accumulation",
                    notes="Automatic Rally after Selling Climax",
                ))

            # BC: up bar at extreme high — only emit if AR confirms.
            elif is_up and bar.high >= window_max * 0.995:
                ar = self._find_automatic_reaction(bars, i, direction="down")
                if ar is None:
                    continue
                conf = self._climax_confidence(bar, p)
                events.append(WyckoffEvent(
                    ticker=ticker,
                    event_type=BC,
                    event_date=bar.date,
                    price=int(bar.close),
                    volume=int(bar.volume),
                    volume_z=round(bar.vol_z, 2),
                    range_z=round(bar.range_z, 2),
                    confidence=conf,
                    inferred_phase="distribution",
                    notes=f"Buying Climax: euphoric high on volume z={bar.vol_z:.1f}",
                ))
                _, ar_bar = ar
                events.append(WyckoffEvent(
                    ticker=ticker,
                    event_type=AR_DOWN,
                    event_date=ar_bar.date,
                    price=int(ar_bar.close),
                    volume=int(ar_bar.volume),
                    volume_z=round(ar_bar.vol_z or 0, 2),
                    range_z=round(ar_bar.range_z or 0, 2),
                    confidence=max(40, conf - 15),
                    inferred_phase="distribution",
                    notes="Automatic Reaction after Buying Climax",
                ))

        return events

    @staticmethod
    def _suppress_nearby_climaxes(
        events: List[WyckoffEvent], window_bars: int = 30,
    ) -> List[WyckoffEvent]:
        """
        Real Wyckoff has ONE climax per swing — but a sustained trend
        produces a sequence of bars that all qualify (every new high with
        strong volume looks like a BC). Group climaxes within `window_bars`
        of each other and keep only the highest-confidence one. AR pairs
        belonging to dropped climaxes are also dropped.

        Operates in calendar-day approximation: events within ~window_bars
        trading days (≈ window_bars * 7/5 calendar days).
        """
        if not events:
            return events
        from datetime import datetime
        calendar_window = int(window_bars * 7 / 5)

        # Separate by type so SC and BC don't suppress each other
        def parse(d: str) -> datetime:
            return datetime.strptime(d, "%Y-%m-%d")

        def suppress(group: List[WyckoffEvent]) -> List[WyckoffEvent]:
            group.sort(key=lambda e: parse(e.event_date))
            kept: List[WyckoffEvent] = []
            for ev in group:
                ev_dt = parse(ev.event_date)
                # If within window of any kept event, only keep if higher confidence
                conflict_idx = None
                for i, k in enumerate(kept):
                    if abs((ev_dt - parse(k.event_date)).days) <= calendar_window:
                        conflict_idx = i
                        break
                if conflict_idx is None:
                    kept.append(ev)
                elif ev.confidence > kept[conflict_idx].confidence:
                    kept[conflict_idx] = ev
            return kept

        sc_events = suppress([e for e in events if e.event_type == SC])
        bc_events = suppress([e for e in events if e.event_type == BC])

        # Keep only AR events whose anchoring climax survived suppression
        kept_climax_dates = {(e.event_type, e.event_date) for e in sc_events + bc_events}

        def ar_anchor_alive(ar: WyckoffEvent) -> bool:
            # AR must follow a kept climax within ~6 trading days (the climax
            # detector's lookahead window). Approximate as 9 calendar days.
            target_type = SC if ar.event_type == AR_UP else BC
            ar_dt = parse(ar.event_date)
            for t, d in kept_climax_dates:
                if t != target_type:
                    continue
                gap = (ar_dt - parse(d)).days
                if 0 < gap <= 9:
                    return True
            return False

        ar_events = [
            e for e in events
            if e.event_type in (AR_UP, AR_DOWN) and ar_anchor_alive(e)
        ]

        return sc_events + bc_events + ar_events

    @staticmethod
    def _climax_confidence(bar: Bar, p: WyckoffParams) -> int:
        """Score climax event confidence based on how extreme volume + range are."""
        vol_excess = (bar.vol_z or 0) - p.climax_volume_z
        rng_excess = (bar.range_z or 0) - p.climax_range_z
        score = 60 + int(vol_excess * 8) + int(rng_excess * 6)
        return max(40, min(score, 95))

    @staticmethod
    def _find_automatic_reaction(
        bars: List[Bar], climax_idx: int, direction: str,
    ) -> Optional[Tuple[int, Bar]]:
        """
        Find the first bar after a climax that confirms the AR (Automatic
        Rally / Reaction). Returns (index, bar) or None.
        """
        max_look = min(climax_idx + 6, len(bars))
        climax = bars[climax_idx]

        if direction == "up":
            best_idx = None
            best_high = climax.high
            for j in range(climax_idx + 1, max_look):
                if bars[j].high > best_high:
                    best_high = bars[j].high
                    best_idx = j
            if best_idx is not None and bars[best_idx].close > climax.close * 1.02:
                return (best_idx, bars[best_idx])

        elif direction == "down":
            best_idx = None
            best_low = climax.low
            for j in range(climax_idx + 1, max_look):
                if bars[j].low < best_low:
                    best_low = bars[j].low
                    best_idx = j
            if best_idx is not None and bars[best_idx].close < climax.close * 0.98:
                return (best_idx, bars[best_idx])

        return None

    # =================================================================
    # Layer 2: Spring / UTAD detection
    # =================================================================

    def _detect_springs_and_utads(
        self, ticker: str, bars: List[Bar],
    ) -> List[WyckoffEvent]:
        """
        Spring: bar pierces below the recent N-day low by < pierce_pct,
                then closes back above the level within reclaim_window bars
                with volume confirmation.

        UTAD:   mirror condition at the upper boundary.

        These are the highest-conviction Wyckoff events for code detection
        because they have a clear pattern signature.
        """
        p = self.params
        events: List[WyckoffEvent] = []

        for i in range(p.range_lookback, len(bars)):
            bar = bars[i]
            if bar.vol_z is None:
                continue

            # Recent range from prior N bars (excluding current)
            window = bars[i - p.range_lookback: i]
            range_low = min(b.low for b in window)
            range_high = max(b.high for b in window)

            # ── Spring detection ───────────────────────────────────────
            # Bar pierces below range_low but not by too much
            pierce_low = range_low * (1 - p.pierce_pct)
            if pierce_low < bar.low <= range_low and bar.close < range_low:
                # Look forward up to reclaim_window bars for a close back inside
                reclaim_idx = self._find_reclaim(bars, i, range_low, direction="up")
                if reclaim_idx is not None:
                    reclaim_bar = bars[reclaim_idx]
                    if (reclaim_bar.vol_z or 0) >= p.spring_volume_z:
                        conf = self._spring_confidence(bar, reclaim_bar, range_low, p)
                        events.append(WyckoffEvent(
                            ticker=ticker,
                            event_type=SPRING,
                            event_date=reclaim_bar.date,
                            price=int(reclaim_bar.close),
                            volume=int(reclaim_bar.volume),
                            volume_z=round(reclaim_bar.vol_z or 0, 2),
                            range_z=round(reclaim_bar.range_z or 0, 2),
                            confidence=conf,
                            inferred_phase="accumulation",
                            notes=f"Spring: pierced {int(range_low)} on {bar.date}, reclaimed",
                        ))

            # ── UTAD detection ─────────────────────────────────────────
            pierce_high = range_high * (1 + p.pierce_pct)
            if range_high <= bar.high < pierce_high and bar.close > range_high:
                reclaim_idx = self._find_reclaim(bars, i, range_high, direction="down")
                if reclaim_idx is not None:
                    reclaim_bar = bars[reclaim_idx]
                    if (reclaim_bar.vol_z or 0) >= p.spring_volume_z:
                        conf = self._spring_confidence(bar, reclaim_bar, range_high, p)
                        events.append(WyckoffEvent(
                            ticker=ticker,
                            event_type=UTAD,
                            event_date=reclaim_bar.date,
                            price=int(reclaim_bar.close),
                            volume=int(reclaim_bar.volume),
                            volume_z=round(reclaim_bar.vol_z or 0, 2),
                            range_z=round(reclaim_bar.range_z or 0, 2),
                            confidence=conf,
                            inferred_phase="distribution",
                            notes=f"UTAD: pierced {int(range_high)} on {bar.date}, rejected",
                        ))

        return events

    def _find_reclaim(
        self, bars: List[Bar], pierce_idx: int, level: float, direction: str,
    ) -> Optional[int]:
        """
        Find first bar within reclaim_window that closes back across `level`
        in the given direction.
        """
        max_look = min(pierce_idx + self.params.reclaim_window + 1, len(bars))
        if direction == "up":
            for j in range(pierce_idx + 1, max_look):
                if bars[j].close > level:
                    return j
        else:  # down
            for j in range(pierce_idx + 1, max_look):
                if bars[j].close < level:
                    return j
        return None

    @staticmethod
    def _spring_confidence(
        pierce_bar: Bar, reclaim_bar: Bar, level: float, p: WyckoffParams,
    ) -> int:
        """Score spring/UTAD based on how far pierced vs. how strong reclaim."""
        pierce_depth = abs(pierce_bar.low - level) / level if level else 0
        # Shallower pierce = better spring (less follow-through to the bear case)
        depth_score = max(0, 25 - int(pierce_depth * 1000))
        # Stronger volume on reclaim = higher conviction
        vol_score = max(0, int(((reclaim_bar.vol_z or 0) - p.spring_volume_z) * 12))
        return min(95, 55 + depth_score + vol_score)

    # =================================================================
    # Secondary Tests (ST_low / ST_high)
    # =================================================================

    def _detect_secondary_tests(
        self,
        ticker: str,
        bars: List[Bar],
        climaxes: List[WyckoffEvent],
    ) -> List[WyckoffEvent]:
        """
        Secondary Test = low-volume retest of a prior climax extreme.

        ST_low: after an SC, a later bar that re-probes the SC.low to within
                ~3% on volume substantially LOWER than SC.volume_z. Confirms
                supply has been absorbed.

        ST_high: mirror after BC.

        Operates per-climax: looks forward up to 30 trading days after each
        SC/BC for the qualifying retest bar.
        """
        events: List[WyckoffEvent] = []
        if not climaxes:
            return events

        bar_index = {b.date: i for i, b in enumerate(bars)}

        for cx in climaxes:
            if cx.event_type not in (SC, BC):
                continue
            if cx.event_date not in bar_index:
                continue
            cx_idx = bar_index[cx.event_date]
            cx_bar = bars[cx_idx]
            cx_vol_z = cx.volume_z

            end_idx = min(cx_idx + 30, len(bars))
            for j in range(cx_idx + 3, end_idx):  # at least a few bars after
                b = bars[j]
                if b.vol_z is None:
                    continue
                # Must be a noticeably quieter bar
                if b.vol_z >= cx_vol_z * 0.6:
                    continue

                if cx.event_type == SC:
                    # Re-probe SC.low within 3%
                    if b.low <= cx_bar.low * 1.03 and b.low >= cx_bar.low * 0.97:
                        conf = self._st_confidence(b, cx_vol_z)
                        events.append(WyckoffEvent(
                            ticker=ticker,
                            event_type=ST_LOW,
                            event_date=b.date,
                            price=int(b.close),
                            volume=int(b.volume),
                            volume_z=round(b.vol_z, 2),
                            range_z=round(b.range_z or 0, 2),
                            confidence=conf,
                            inferred_phase="accumulation",
                            notes=(
                                f"Secondary Test of {int(cx_bar.low)} on lower volume "
                                f"(z={b.vol_z:.1f} vs SC z={cx_vol_z:.1f}) — supply absorbed"
                            ),
                        ))
                        break  # only the FIRST qualifying ST per climax

                elif cx.event_type == BC:
                    # Re-probe BC.high within 3%
                    if b.high >= cx_bar.high * 0.97 and b.high <= cx_bar.high * 1.03:
                        conf = self._st_confidence(b, cx_vol_z)
                        events.append(WyckoffEvent(
                            ticker=ticker,
                            event_type=ST_HIGH,
                            event_date=b.date,
                            price=int(b.close),
                            volume=int(b.volume),
                            volume_z=round(b.vol_z, 2),
                            range_z=round(b.range_z or 0, 2),
                            confidence=conf,
                            inferred_phase="distribution",
                            notes=(
                                f"Secondary Test of {int(cx_bar.high)} on lower volume "
                                f"(z={b.vol_z:.1f} vs BC z={cx_vol_z:.1f}) — demand exhausted"
                            ),
                        ))
                        break

        return events

    @staticmethod
    def _st_confidence(bar: Bar, climax_vol_z: float) -> int:
        """Higher confidence the QUIETER the test bar relative to the climax."""
        ratio = (bar.vol_z or 0) / climax_vol_z if climax_vol_z else 1
        # ratio close to 0.2 = very quiet test = high conviction
        score = 80 - int(ratio * 50)
        return max(45, min(score, 90))

    # =================================================================
    # SOS / SOW — Sign of Strength / Sign of Weakness
    # =================================================================

    def _detect_sos_sow(
        self, ticker: str, bars: List[Bar],
    ) -> List[WyckoffEvent]:
        """
        SOS = wide-range up bar that breaks above the prior 30-day range
              high on expanding volume. Closes in upper third of its range.

        SOW = mirror — wide-range down bar that breaks below 30-day low
              on expanding volume. Closes in lower third.

        Confirms emergence from accumulation (SOS) or distribution (SOW).
        Suppressed: only the strongest within a 20-bar window survives.
        """
        events: List[WyckoffEvent] = []
        lookback = 30  # range definition
        sup_window = self.params.sos_sow_suppress_bars  # suppression window

        for i in range(lookback, len(bars)):
            bar = bars[i]
            if bar.vol_z is None or bar.range_z is None:
                continue

            # Must be wide-range AND expanding volume
            if bar.range_z < 1.0 or bar.vol_z < 0.5:
                continue

            bar_range = bar.high - bar.low
            if bar_range <= 0:
                continue
            close_pos = (bar.close - bar.low) / bar_range  # 0=at low, 1=at high

            window = bars[i - lookback: i]
            prior_high = max(b.high for b in window)
            prior_low = min(b.low for b in window)

            is_up_bar = bar.close > bar.open

            # SOS — breakout up
            if is_up_bar and close_pos >= 0.65 and bar.close > prior_high * 0.99:
                conf = self._sos_sow_confidence(bar)
                events.append(WyckoffEvent(
                    ticker=ticker,
                    event_type=SOS,
                    event_date=bar.date,
                    price=int(bar.close),
                    volume=int(bar.volume),
                    volume_z=round(bar.vol_z, 2),
                    range_z=round(bar.range_z, 2),
                    confidence=conf,
                    inferred_phase="markup",
                    notes=(
                        f"Sign of Strength: wide-range up bar breaking {int(prior_high)} "
                        f"on volume z={bar.vol_z:.1f}"
                    ),
                ))

            # SOW — breakdown down
            elif (not is_up_bar) and close_pos <= 0.35 and bar.close < prior_low * 1.01:
                conf = self._sos_sow_confidence(bar)
                events.append(WyckoffEvent(
                    ticker=ticker,
                    event_type=SOW,
                    event_date=bar.date,
                    price=int(bar.close),
                    volume=int(bar.volume),
                    volume_z=round(bar.vol_z, 2),
                    range_z=round(bar.range_z, 2),
                    confidence=conf,
                    inferred_phase="markdown",
                    notes=(
                        f"Sign of Weakness: wide-range down bar breaking {int(prior_low)} "
                        f"on volume z={bar.vol_z:.1f}"
                    ),
                ))

        # Cluster suppression — keep best within sup_window calendar days
        return self._suppress_window(events, calendar_window=int(sup_window * 7 / 5))

    @staticmethod
    def _sos_sow_confidence(bar: Bar) -> int:
        rng = (bar.range_z or 0)
        vol = (bar.vol_z or 0)
        score = 55 + int((rng - 1.0) * 12) + int((vol - 0.5) * 10)
        return max(45, min(score, 90))

    @staticmethod
    def _suppress_window(
        events: List[WyckoffEvent], calendar_window: int,
    ) -> List[WyckoffEvent]:
        """Generic: within an event_type, keep highest-confidence per window."""
        from datetime import datetime
        if not events:
            return events
        by_type: Dict[str, List[WyckoffEvent]] = {}
        for e in events:
            by_type.setdefault(e.event_type, []).append(e)

        kept: List[WyckoffEvent] = []
        for type_events in by_type.values():
            type_events.sort(key=lambda e: e.event_date)
            kept_local: List[WyckoffEvent] = []
            for ev in type_events:
                ev_dt = datetime.strptime(ev.event_date, "%Y-%m-%d")
                conflict = None
                for i, k in enumerate(kept_local):
                    k_dt = datetime.strptime(k.event_date, "%Y-%m-%d")
                    if abs((ev_dt - k_dt).days) <= calendar_window:
                        conflict = i
                        break
                if conflict is None:
                    kept_local.append(ev)
                elif ev.confidence > kept_local[conflict].confidence:
                    kept_local[conflict] = ev
            kept.extend(kept_local)
        return kept

    # =================================================================
    # LPS / LPSY — Last Point of Support / Supply
    # =================================================================

    def _detect_lps_lpsy(
        self,
        ticker: str,
        bars: List[Bar],
        sos_sow: List[WyckoffEvent],
    ) -> List[WyckoffEvent]:
        """
        LPS = first higher-low pullback within 15 bars of an SOS, on
              declining volume. Marks the entry trigger for the markup phase.

        LPSY = mirror — first lower-high pullback within 15 bars of an SOW.

        Each SOS/SOW yields at most one LPS/LPSY.
        """
        events: List[WyckoffEvent] = []
        bar_index = {b.date: i for i, b in enumerate(bars)}
        lookforward = 15

        for anchor in sos_sow:
            if anchor.event_date not in bar_index:
                continue
            anchor_idx = bar_index[anchor.event_date]
            anchor_bar = bars[anchor_idx]
            end_idx = min(anchor_idx + 1 + lookforward, len(bars))

            if anchor.event_type == SOS:
                # Look for higher-low: a bar where low > anchor.low,
                # close < anchor.close, volume softer than anchor
                for j in range(anchor_idx + 2, end_idx):
                    b = bars[j]
                    if b.vol_z is None:
                        continue
                    is_pullback = b.close < anchor_bar.close
                    higher_low = b.low > anchor_bar.low
                    softer_vol = (b.vol_z or 0) < (anchor.volume_z * 0.85)
                    if is_pullback and higher_low and softer_vol:
                        conf = self._lps_confidence(b, anchor)
                        events.append(WyckoffEvent(
                            ticker=ticker,
                            event_type=LPS,
                            event_date=b.date,
                            price=int(b.close),
                            volume=int(b.volume),
                            volume_z=round(b.vol_z, 2),
                            range_z=round(b.range_z or 0, 2),
                            confidence=conf,
                            inferred_phase="markup",
                            notes=(
                                f"Last Point of Support: higher low after SOS on "
                                f"volume z={b.vol_z:.1f} — markup entry"
                            ),
                        ))
                        break

            elif anchor.event_type == SOW:
                # Look for lower-high pullback after SOW
                for j in range(anchor_idx + 2, end_idx):
                    b = bars[j]
                    if b.vol_z is None:
                        continue
                    is_pullback = b.close > anchor_bar.close
                    lower_high = b.high < anchor_bar.high
                    softer_vol = (b.vol_z or 0) < (anchor.volume_z * 0.85)
                    if is_pullback and lower_high and softer_vol:
                        conf = self._lps_confidence(b, anchor)
                        events.append(WyckoffEvent(
                            ticker=ticker,
                            event_type=LPSY,
                            event_date=b.date,
                            price=int(b.close),
                            volume=int(b.volume),
                            volume_z=round(b.vol_z, 2),
                            range_z=round(b.range_z or 0, 2),
                            confidence=conf,
                            inferred_phase="markdown",
                            notes=(
                                f"Last Point of Supply: lower high after SOW on "
                                f"volume z={b.vol_z:.1f} — markdown entry"
                            ),
                        ))
                        break

        return events

    @staticmethod
    def _lps_confidence(bar: Bar, anchor: WyckoffEvent) -> int:
        """Quieter pullback = better LPS/LPSY."""
        if anchor.volume_z <= 0:
            return 55
        ratio = (bar.vol_z or 0) / anchor.volume_z
        score = 75 - int(ratio * 30)
        return max(45, min(score, 85))

    # =================================================================
    # Passive markup / markdown — slow drifts on below-average volume
    # =================================================================

    def _detect_passive_drifts(
        self, ticker: str, bars: List[Bar],
    ) -> List[WyckoffEvent]:
        """
        Detect sustained directional moves on quiet volume — the "slow
        markdown / markup" pattern that produces no climactic events.

        Window-based: at every bar, check the prior `passive_window_bars`.
        If price moved ≥ `passive_min_move_pct` in one direction AND average
        vol_z over the window is below `passive_max_avg_vol_z`, emit a
        marker at the END of that window. Cluster-suppressed.

        This is NOT classical Wyckoff terminology — it's a pragmatic addition
        for charts where supply/demand imbalance is steady rather than
        climactic, like soft IDX bear markets.
        """
        p = self.params
        events: List[WyckoffEvent] = []
        W = p.passive_window_bars

        for i in range(W, len(bars)):
            window = bars[i - W: i + 1]
            start_close = window[0].close
            end_close = window[-1].close
            if start_close <= 0:
                continue
            move_pct = (end_close - start_close) / start_close

            # Average vol_z across the window (bars that have it computed)
            vol_zs = [b.vol_z for b in window if b.vol_z is not None]
            if len(vol_zs) < W // 2:
                continue
            avg_vol_z = sum(vol_zs) / len(vol_zs)

            if avg_vol_z > p.passive_max_avg_vol_z:
                continue  # too much volume = it's an active move, not drift

            bar = bars[i]
            if move_pct >= p.passive_min_move_pct:
                events.append(WyckoffEvent(
                    ticker=ticker,
                    event_type=PASSIVE_MARKUP,
                    event_date=bar.date,
                    price=int(bar.close),
                    volume=int(bar.volume),
                    volume_z=round(bar.vol_z or 0, 2),
                    range_z=round(bar.range_z or 0, 2),
                    confidence=self._passive_confidence(move_pct, avg_vol_z),
                    inferred_phase="markup",
                    notes=(
                        f"Passive markup: +{move_pct*100:.0f}% over {W} bars "
                        f"on avg vol z={avg_vol_z:+.2f}"
                    ),
                ))
            elif move_pct <= -p.passive_min_move_pct:
                events.append(WyckoffEvent(
                    ticker=ticker,
                    event_type=PASSIVE_MARKDOWN,
                    event_date=bar.date,
                    price=int(bar.close),
                    volume=int(bar.volume),
                    volume_z=round(bar.vol_z or 0, 2),
                    range_z=round(bar.range_z or 0, 2),
                    confidence=self._passive_confidence(move_pct, avg_vol_z),
                    inferred_phase="markdown",
                    notes=(
                        f"Passive markdown: {move_pct*100:.0f}% over {W} bars "
                        f"on avg vol z={avg_vol_z:+.2f}"
                    ),
                ))

        return self._suppress_window(
            events,
            calendar_window=int(p.passive_suppress_bars * 7 / 5),
        )

    @staticmethod
    def _passive_confidence(move_pct: float, avg_vol_z: float) -> int:
        """Bigger move + quieter volume = higher conviction it's a drift."""
        # 10% move at vol_z=-0.5 ≈ baseline 60
        score = 50 + int(abs(move_pct) * 100) + int(abs(avg_vol_z) * 15)
        return max(45, min(score, 80))

    # =================================================================
    # Layer 3: Effort vs Result anomalies
    # =================================================================

    def _detect_effort_result(
        self, ticker: str, bars: List[Bar],
    ) -> List[WyckoffEvent]:
        """
        High-volume narrow-range bars (absorption) and low-volume directional
        bars (no-demand / no-supply). These are subtler than climaxes — set
        confidence floor lower.
        """
        p = self.params
        events: List[WyckoffEvent] = []

        for bar in bars:
            if bar.vol_z is None or bar.range_z is None:
                continue

            # Absorption: high volume, narrow range
            if bar.vol_z >= p.absorption_volume_z and bar.range_z <= p.absorption_range_z:
                conf = 50 + int((bar.vol_z - p.absorption_volume_z) * 10)
                events.append(WyckoffEvent(
                    ticker=ticker,
                    event_type=ABSORPTION,
                    event_date=bar.date,
                    price=int(bar.close),
                    volume=int(bar.volume),
                    volume_z=round(bar.vol_z, 2),
                    range_z=round(bar.range_z, 2),
                    confidence=min(80, max(40, conf)),
                    notes="High volume, narrow range — institutional absorption",
                ))
                continue

            # No-demand: up bar on low volume
            if (bar.close > bar.open
                and bar.vol_z <= p.quiet_volume_z
                and bar.range_z >= p.quiet_range_z):
                events.append(WyckoffEvent(
                    ticker=ticker,
                    event_type=NO_DEMAND,
                    event_date=bar.date,
                    price=int(bar.close),
                    volume=int(bar.volume),
                    volume_z=round(bar.vol_z, 2),
                    range_z=round(bar.range_z, 2),
                    confidence=45,
                    notes="Up bar on weak volume — lack of buying conviction",
                ))
                continue

            # No-supply: down bar on low volume
            if (bar.close < bar.open
                and bar.vol_z <= p.quiet_volume_z
                and bar.range_z >= p.quiet_range_z):
                events.append(WyckoffEvent(
                    ticker=ticker,
                    event_type=NO_SUPPLY,
                    event_date=bar.date,
                    price=int(bar.close),
                    volume=int(bar.volume),
                    volume_z=round(bar.vol_z, 2),
                    range_z=round(bar.range_z, 2),
                    confidence=45,
                    notes="Down bar on weak volume — sellers exhausted",
                ))

        return events

    # =================================================================
    # Phase inference (event sequence → wyckoff phase label)
    # =================================================================

    def _infer_phase_from_events(
        self, events: List[WyckoffEvent], phase: Any,
    ) -> Optional[str]:
        """
        Infer wyckoff structural phase from the event mix and the SMA-based
        phase context. This is intentionally simple — confidence-weighted
        majority of bullish vs bearish event content.

        Returns 'accumulation' | 'markup' | 'distribution' | 'markdown' | None
        """
        if not events:
            # Fall back to SMA phase mapping when no Wyckoff events fired
            sma_to_wyckoff = {
                "uptrend":          "markup",
                "downtrend":        "markdown",
                "sideways_bullish": "accumulation",
                "sideways_bearish": "distribution",
            }
            return sma_to_wyckoff.get(getattr(phase, "phase_type", None))

        bullish_score = sum(
            e.confidence for e in events if e.event_type in BULLISH_EVENTS
        )
        bearish_score = sum(
            e.confidence for e in events if e.event_type in BEARISH_EVENTS
        )

        # If there's a Spring or SC, accumulation is highly likely regardless
        if any(e.event_type in (SPRING, SC) for e in events):
            return "accumulation"
        if any(e.event_type in (UTAD, BC) for e in events):
            return "distribution"

        if bullish_score > bearish_score * 1.3:
            return "accumulation" if getattr(phase, "phase_type", "") in (
                "downtrend", "sideways_bearish", "sideways_bullish",
            ) else "markup"
        if bearish_score > bullish_score * 1.3:
            return "distribution" if getattr(phase, "phase_type", "") in (
                "uptrend", "sideways_bullish", "sideways_bearish",
            ) else "markdown"
        return None

    @staticmethod
    def _compute_absorption_score(
        events: List[WyckoffEvent], phase: Any,
    ) -> Optional[int]:
        """
        Effort-vs-result intensity for the phase: ratio of absorption +
        no-supply/no-demand events to phase length, scaled 0-100.
        """
        if not events:
            return None
        intensity = sum(
            1 for e in events
            if e.event_type in (ABSORPTION, NO_DEMAND, NO_SUPPLY)
        )
        days = max(getattr(phase, "days", 1), 1)
        # ~5-10% of bars showing absorption is meaningful → 100 score
        ratio = intensity / days
        score = int(min(100, ratio * 1000))
        return score if score > 0 else None

    # =================================================================
    # Indicator computation
    # =================================================================

    def _compute_rolling_stats(self, bars: List[Bar]) -> None:
        """Compute volume z-score and range z-score with rolling window."""
        w = self.params.rolling_window
        n = len(bars)

        for i, bar in enumerate(bars):
            bar.range_size = bar.high - bar.low

        for i in range(n):
            lo = max(0, i - w + 1)
            window = bars[lo:i + 1]
            if len(window) < max(10, w // 2):
                continue

            vols = [b.volume for b in window if b.volume > 0]
            ranges = [b.range_size for b in window if b.range_size > 0]
            if len(vols) < 5 or len(ranges) < 5:
                continue

            vmean = sum(vols) / len(vols)
            vstd = (sum((v - vmean) ** 2 for v in vols) / len(vols)) ** 0.5
            rmean = sum(ranges) / len(ranges)
            rstd = (sum((r - rmean) ** 2 for r in ranges) / len(ranges)) ** 0.5

            if vstd > 0:
                bars[i].vol_z = (bars[i].volume - vmean) / vstd
            if rstd > 0:
                bars[i].range_z = (bars[i].range_size - rmean) / rstd

    # =================================================================
    # Data Fetching / Persistence
    # =================================================================

    def _fetch_bars(self, ticker: str) -> List[Bar]:
        client = get_client()
        cutoff = (date.today() - timedelta(days=self.params.lookback_days)).isoformat()
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

    def _fetch_active_tickers(self) -> List[str]:
        client = get_client()
        resp = (
            client.table("stocks")
            .select("ticker")
            .eq("status", "Active")
            .order("ticker")
            .execute()
        )
        return [r["ticker"] for r in (resp.data or [])]

    @staticmethod
    def _dedupe_events(events: List[WyckoffEvent]) -> List[WyckoffEvent]:
        """
        Collapse events sharing the same (event_date, event_type) into a single
        record by keeping the one with highest confidence. The unique constraint
        in the database is (ticker, event_date, event_type), so duplicates
        within a single ticker's batch are illegal.
        """
        best: Dict[Tuple[str, str], WyckoffEvent] = {}
        for e in events:
            key = (e.event_date, e.event_type)
            existing = best.get(key)
            if existing is None or e.confidence > existing.confidence:
                best[key] = e
        return list(best.values())

    def _upsert_events(self, ticker: str, events: List[WyckoffEvent]) -> None:
        """DELETE + INSERT all events for a ticker, then denorm latest onto stocks."""
        delete_where("wyckoff_events", "ticker", ticker)

        if events:
            rows = [{
                "ticker": e.ticker,
                "event_type": e.event_type,
                "event_date": e.event_date,
                "price": e.price,
                "volume": e.volume,
                "volume_z": e.volume_z,
                "range_z": e.range_z,
                "confidence": e.confidence,
                "inferred_phase": e.inferred_phase,
                "notes": e.notes,
                "detection_version": "1.0",
                "detected_at": datetime.now(timezone.utc).isoformat(),
            } for e in events]
            bulk_upsert("wyckoff_events", rows, on_conflict="ticker,event_date,event_type")

        # Denormalize the latest event onto the stocks table for fast screener
        # filtering. Schema-v24 introduced these columns; the update is a no-op
        # on tickers without rows in stocks.
        latest = events[-1] if events else None
        update_payload = {
            "current_wyckoff_event":      latest.event_type if latest else None,
            "current_wyckoff_event_date": latest.event_date if latest else None,
            "current_wyckoff_phase":      latest.inferred_phase if latest else None,
            "current_wyckoff_confidence": latest.confidence if latest else None,
        }
        try:
            get_client().table("stocks").update(update_payload).eq("ticker", ticker).execute()
        except Exception:
            logger.debug("%s: stocks denorm update failed (columns may not exist yet)", ticker)
