"""
Wyckoff Detector v2 — Finite State Machine
============================================

Context-aware Wyckoff accumulation/distribution phase detector built on a
finite state machine. Designed to fix the failure modes of the v1 (flat-pass)
detector:

  1. BC misclassified as SOS (identical bar shape, opposite meaning)
  2. Springs flagged before Phase A/B has formed
  3. Climactic SC bars confused with continuation down-bars
  4. UTAD vs Spring confusion at range edges

Core principles
---------------
- STRUCTURE FIRST. Trading ranges (Phase B) must form before classifying
  events inside them. No range = no Spring, no SOS.
- SEQUENCE ENFORCEMENT. Events emit only when the state allows them.
  Accum: PS → SC → AR → ST → Range → Spring → Test → SOS → LPS
  Distr: PSY → BC → AR → ST → Range → UTAD → SOW → LPSY
- RELATIVE THRESHOLDS. Volume and spread are normalized vs rolling ATR
  and a 50-bar volume distribution.
- EFFORT VS RESULT. Heavy effort with weak result = absorption.
- CONFIRMATION. Springs without successful tests are downgraded; failed
  tests revert state.

Differences from v1:
  - Single-pass FSM, not multiple independent detectors
  - One Wyckoff phase at a time (FSM ensures mutual exclusivity)
  - Fine-grained phase (Accum_A/B/C/D) tracked explicitly
  - Spring requires Phase B to have built for ≥ MIN_PHASE_B_BARS
  - Spring requires NON-climactic volume on the pierce bar
  - Spring failure (close < spring_low for 2+ bars) reverts to Phase B

Persistence:
  Events are written to the existing wyckoff_events table with
  detection_version='2.0' so v1 and v2 can be visualized side-by-side.

Reference:
  Pruden — "The Three Skills of Top Trading"
  Weis — "Trades About to Happen"
  The state-machine architecture itself is a clean port of a Wyckoff FSM
  designed by Anthropic Claude (referenced in this repo's design notes).
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from enum import Enum
from typing import Any, Dict, List, Optional, Tuple

from utils.supabase_client import get_client, bulk_upsert, delete_where

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# FSM phases
# ---------------------------------------------------------------------------

class FSMPhase(Enum):
    UNKNOWN     = "unknown"
    DOWNTREND   = "downtrend"
    ACCUM_A     = "accumulation_a"      # SC, AR, ST forming
    ACCUM_B     = "accumulation_b"      # range building, "the cause"
    ACCUM_C     = "accumulation_c"      # spring + test (PRIMARY BUY ZONE)
    ACCUM_D     = "accumulation_d"      # SOS + LPS (SECONDARY BUY ZONE)
    MARKUP      = "markup"
    UPTREND     = "uptrend"
    DISTR_A     = "distribution_a"      # PSY, BC, AR, ST forming
    DISTR_B     = "distribution_b"      # range building (top)
    DISTR_C     = "distribution_c"      # UTAD (PRIMARY SHORT ZONE)
    DISTR_D     = "distribution_d"      # SOW + LPSY
    MARKDOWN    = "markdown"


# ---------------------------------------------------------------------------
# Event-type strings (kept identical to v1 schema CHECK constraint so the
# frontend doesn't need new types). Test-of-Spring reuses ST_low; Test-of-
# UTAD reuses ST_high.
# ---------------------------------------------------------------------------

PS = "PS"
SC = "SC"
AR_UP = "AR_up"
ST_LOW = "ST_low"
SPRING = "Spring"
SOS = "SOS"
LPS = "LPS"

PSY = "PSY"
BC = "BC"
AR_DOWN = "AR_down"
ST_HIGH = "ST_high"
UTAD = "UTAD"
SOW = "SOW"
LPSY = "LPSY"

# Fix 3: structural failure events (range broke decisively in opposite direction)
DISTR_FAILED = "distr_failed"   # supposed distribution range broke up = re-accumulation
ACCUM_FAILED = "accum_failed"   # supposed accumulation range broke down = re-distribution

# v2.1 spec: soft entry / trend-driven transition events
MARKUP_EXHAUSTION   = "markup_exhaustion"    # MARKUP→MARKDOWN via slope reversal, no clean BC
MARKDOWN_EXHAUSTION = "markdown_exhaustion"  # MARKDOWN→MARKUP via slope reversal, no clean SC
BASIS_BUILDING_EVT  = "basis_building"       # DOWNTREND→ACCUM_A without textbook SC
TOPPING_ACTION_EVT  = "topping_action"       # MARKUP→DISTR_A without textbook BC
RANGE_BREAKOUT_UP   = "range_breakout_up"    # ACCUM_B exits up without Spring/SOS
RANGE_BREAKOUT_DOWN = "range_breakout_down"  # DISTR_B exits down without UTAD/SOW

# Broad inferred_phase for the wyckoff_events row (4 categories) — distinct
# from the FSM's 12 fine-grained phases.
PHASE_CATEGORY: Dict[FSMPhase, Optional[str]] = {
    FSMPhase.UNKNOWN:    None,
    FSMPhase.DOWNTREND:  "markdown",
    FSMPhase.ACCUM_A:    "accumulation",
    FSMPhase.ACCUM_B:    "accumulation",
    FSMPhase.ACCUM_C:    "accumulation",
    FSMPhase.ACCUM_D:    "accumulation",
    FSMPhase.MARKUP:     "markup",
    FSMPhase.UPTREND:    "markup",
    FSMPhase.DISTR_A:    "distribution",
    FSMPhase.DISTR_B:    "distribution",
    FSMPhase.DISTR_C:    "distribution",
    FSMPhase.DISTR_D:    "distribution",
    FSMPhase.MARKDOWN:   "markdown",
}


# ---------------------------------------------------------------------------
# Bar / event / state
# ---------------------------------------------------------------------------

@dataclass
class Bar:
    """One trading day with index for FSM positional logic."""
    idx: int
    date: str
    open: float
    high: float
    low: float
    close: float
    volume: int

    @property
    def spread(self) -> float:
        return self.high - self.low

    @property
    def close_position(self) -> float:
        if self.spread == 0:
            return 0.5
        return (self.close - self.low) / self.spread

    @property
    def is_up(self) -> bool:
        return self.close > self.open


@dataclass
class WyckoffEvent:
    ticker: str
    event_type: str
    event_date: str
    bar_idx: int
    price: int
    volume: int
    confidence: int                # 0-100
    inferred_phase: Optional[str]  # broad: accumulation|markup|distribution|markdown
    fsm_phase: str                 # fine: accumulation_a/b/c/d, markup, etc.
    notes: Optional[str] = None


@dataclass
class WyckoffState:
    phase: FSMPhase = FSMPhase.UNKNOWN
    range_high: Optional[float] = None
    range_low: Optional[float] = None
    range_start_idx: Optional[int] = None
    sc_idx: Optional[int] = None
    sc_low: Optional[float] = None
    sc_volume: Optional[float] = None
    bc_idx: Optional[int] = None
    bc_high: Optional[float] = None
    bc_volume: Optional[float] = None
    spring_idx: Optional[int] = None
    spring_low: Optional[float] = None
    utad_idx: Optional[int] = None
    utad_high: Optional[float] = None
    sos_idx: Optional[int] = None
    sow_idx: Optional[int] = None
    # One-shot flags so the same anchor doesn't emit a test event repeatedly
    spring_test_fired: bool = False
    utad_test_fired: bool = False
    # Fix 2: candidate climaxes — flagged silently, only confirmed after
    # distribution/accumulation character is observed. NOT emitted as events
    # at this stage; if invalidated they leave no trace.
    bc_candidate_idx: Optional[int] = None
    bc_candidate_high: Optional[float] = None
    bc_candidate_volume: Optional[float] = None
    sc_candidate_idx: Optional[int] = None
    sc_candidate_low: Optional[float] = None
    sc_candidate_volume: Optional[float] = None
    # Fix 5: trend persistence — track when the current trend started.
    trend_start_idx: int = 0
    # v2.1 spec: asymmetric lockout — distinguish confirmed vs invalidated
    # so an invalidation (the algorithm correctly rejecting a candidate)
    # doesn't penalize future detection as much as a confirmation does.
    last_bc_confirmed_idx: int = -10_000
    last_bc_invalidated_idx: int = -10_000
    last_sc_confirmed_idx: int = -10_000
    last_sc_invalidated_idx: int = -10_000
    # Slope-streak counters for markup_exhaustion / markdown_exhaustion
    bearish_slope_streak: int = 0
    bullish_slope_streak: int = 0
    # Tracks soft-entry events so we don't double-emit on consecutive bars
    last_soft_entry_idx: int = -10_000
    events: List[WyckoffEvent] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Detector
# ---------------------------------------------------------------------------

@dataclass
class WyckoffParamsV2:
    """Tunables for the v2 FSM detector."""
    lookback_days: int = 504             # ~2 years of daily bars
    LOOKBACK_VOL: int = 50               # rolling volume mean/std
    LOOKBACK_ATR: int = 20
    LOOKBACK_TREND: int = 50
    MIN_TREND_BARS: int = 30             # required prior trend before SC/BC
    MIN_PHASE_B_BARS: int = 15           # range must build before Spring/UTAD
    MAX_AR_LAG: int = 15                 # bars after climax to find AR
    MAX_ST_LAG: int = 30                 # bars after AR to find ST
    SPRING_RECOVER_BARS: int = 3
    # Climax thresholds — calibrated for IDX equities. Strict-classical
    # Wyckoff would use 2.0/2.0 but real-world bars rarely simultaneously
    # satisfy 2σ volume AND 2× ATR spread AND close-position AND trend
    # condition. Loosened so v2 catches comparable signals to v1.
    CLIMAX_VOL_Z: float = 1.2
    CLIMAX_SPREAD_ATR: float = 1.2
    # Super-climactic override: a single bar with overwhelming volume gets
    # admitted as a climax regardless of other criteria. This catches the
    # "obviously a panic top" bars that strict-classical rules miss when
    # the broader trend slope hasn't fully confirmed yet.
    SUPER_CLIMAX_VOL_Z: float = 3.0
    WIDE_SPREAD_ATR: float = 1.2
    NARROW_SPREAD_ATR: float = 0.7
    LOW_VOLUME_RATIO: float = 0.7
    TREND_SLOPE_THRESHOLD: float = 0.02  # ATR-normalized slope to confirm trend

    # Fix 1+2: BC/SC candidate-confirmation
    CANDIDATE_CONFIRM_BARS: int = 5      # min bars of dist/accum character
    CANDIDATE_TIMEOUT_BARS: int = 10     # max bars to wait before invalidation
    CANDIDATE_PULLBACK_PCT: float = 0.03 # pullback magnitude that confirms

    # Fix 4: tighter UTAD/Spring penetration thresholds
    PENETRATION_MIN_ATR: float = 0.3     # min |bar - range_boundary| in ATR units
    UTAD_SPRING_VOL_Z_MIN: float = 0.5   # require some volume even on the false break
    UTAD_SPRING_SPREAD_ATR_MIN: float = 1.0

    # Fix 5: trend persistence required for a climax to even be a candidate
    SC_MIN_TREND_PERSIST_BARS: int = 30  # spec: SC is less strict than BC
    BC_MIN_TREND_PERSIST_BARS: int = 40  # spec: markups run longer

    # v2.1 spec: asymmetric lockout (replaces uniform MIN_GAP_BETWEEN_CLIMAXES)
    HARD_LOCKOUT_BARS: int = 80    # after a CONFIRMED climax of same type
    SOFT_LOCKOUT_BARS: int = 20    # after an INVALIDATED candidate of same type

    # v2.1 spec: per-direction climax volume (BC stricter than SC)
    SC_CLIMAX_VOL_Z: float = 1.3
    BC_CLIMAX_VOL_Z: float = 1.5

    # CLIMACTIC_CLUSTER (3-bar gradual climax)
    CLUSTER_LOOKBACK: int = 3
    CLUSTER_VOL_Z_SUM_MIN: float = 4.0
    CLUSTER_NET_MOVE_ATR_MIN: float = 2.0

    # ABSORPTION_REGIME (15-bar distributed climax)
    ABSORPTION_LOOKBACK: int = 15
    ABSORPTION_VOL_Z_SUM_MIN: float = 10.0
    ABSORPTION_HIGH_VOL_BARS_MIN: int = 4
    ABSORPTION_RECOVERY_PCT: float = 0.30  # close must reclaim 30% of window range

    # BASIS_BUILDING (soft phase A entry)
    BASIS_LOOKBACK: int = 20
    BASIS_RANGE_ATR_LIMIT: float = 5.0    # max range / ATR for "contained"
    BASIS_AVG_VOL_Z_FLOOR: float = -1.0   # volume not dead
    BASIS_PRIOR_TREND_SLOPE: float = 0.05 # prior trend must have been clear

    # markup_exhaustion / markdown_exhaustion
    EXHAUSTION_SLOPE_STREAK_BARS: int = 15
    EXHAUSTION_SLOPE_THRESHOLD: float = 0.02
    EXHAUSTION_RETRACE_PCT: float = 0.30  # 30% retrace from extreme


class WyckoffDetectorV2:
    """
    FSM-based Wyckoff detector. Process bars one at a time via process(),
    or run end-to-end via detect_ticker(ticker).

    Usage
    -----
        det = WyckoffDetectorV2()
        det.detect_ticker("DEWA")              # fetches + persists
        det.detect_batch(["BBRI", "DEWA"])     # batch
    """

    def __init__(self, params: WyckoffParamsV2 | None = None):
        self.params = params or WyckoffParamsV2()
        self._reset()

    def _reset(self):
        self.state = WyckoffState()
        self.bars: List[Bar] = []
        self._ticker: Optional[str] = None

    # =================================================================
    # Public API
    # =================================================================

    def detect_ticker(self, ticker: str, dry_run: bool = False) -> List[WyckoffEvent]:
        self._reset()
        self._ticker = ticker
        bars = self._fetch_bars(ticker)
        if len(bars) < self.params.LOOKBACK_VOL + 10:
            logger.info("%s: insufficient bars (%d), skipping", ticker, len(bars))
            return []

        for bar in bars:
            self.process(bar)

        events = self.state.events
        if not dry_run:
            self._upsert_events(ticker, events)
            logger.info(
                "%s [v2]: saved %d events; final phase=%s",
                ticker, len(events), self.state.phase.value,
            )
        else:
            logger.info(
                "%s [v2]: detected %d events (dry-run); final phase=%s",
                ticker, len(events), self.state.phase.value,
            )
        return events

    def detect_batch(
        self,
        tickers: List[str] | None = None,
        dry_run: bool = False,
    ) -> Dict[str, int]:
        if tickers is None:
            tickers = self._fetch_active_tickers()

        results: Dict[str, int] = {}
        total = len(tickers)
        for i, ticker in enumerate(tickers, 1):
            try:
                evts = self.detect_ticker(ticker, dry_run=dry_run)
                results[ticker] = len(evts)
                if i % 50 == 0 or i == total:
                    logger.info("v2 progress: %d / %d", i, total)
            except Exception:
                logger.exception("%s [v2]: detection failed", ticker)
                results[ticker] = -1
        ok = sum(1 for v in results.values() if v >= 0)
        failed = sum(1 for v in results.values() if v < 0)
        logger.info("Wyckoff v2 batch complete: %d ok, %d failed", ok, failed)
        return results

    # =================================================================
    # FSM dispatch — one bar at a time
    # =================================================================

    def process(self, bar: Bar) -> None:
        """Feed a bar; advances state in-place."""
        self.bars.append(bar)
        idx = len(self.bars) - 1
        if idx < self.params.LOOKBACK_VOL:
            return  # warm-up

        # Bootstrap: at the first post-warm-up bar, decide whether we're
        # entering a downtrend (eligible for SC) or uptrend (eligible for
        # BC) so the FSM doesn't get stuck in UNKNOWN forever for stocks
        # that weren't in a downtrend at the start of the lookback.
        if self.state.phase == FSMPhase.UNKNOWN:
            self._bootstrap_initial_state(idx)

        phase = self.state.phase

        if phase in (FSMPhase.UNKNOWN, FSMPhase.DOWNTREND, FSMPhase.MARKDOWN):
            # SC candidate lifecycle (mirror of BC).
            if self.state.sc_candidate_idx is not None:
                self._check_sc_candidate(idx)
            else:
                self._check_phase_a_accumulation(idx)
            # v2.1: if no SC candidate fired here, try basis-building soft entry.
            # Spec §priority ordering: climactic candidates fire first.
            if (self.state.phase in (FSMPhase.UNKNOWN, FSMPhase.DOWNTREND, FSMPhase.MARKDOWN)
                    and self.state.sc_candidate_idx is None):
                self._check_basis_building(idx, "down")
            if self.state.phase in (FSMPhase.DOWNTREND, FSMPhase.MARKDOWN):
                self._reclassify_trend(idx)
                self._check_markdown_exhaustion(idx)
        elif phase == FSMPhase.ACCUM_A:
            self._check_ar_then_st(idx)
            self._check_climax_invalidation(idx, direction="down")
        elif phase == FSMPhase.ACCUM_B:
            self._check_spring(idx)
            self._check_accum_range_invalidation(idx)
        elif phase == FSMPhase.ACCUM_C:
            self._check_test_or_sos(idx)
            self._check_spring_failure(idx)
            self._check_accum_range_invalidation(idx)
        elif phase == FSMPhase.ACCUM_D:
            self._check_lps_or_markup(idx)
        elif phase in (FSMPhase.MARKUP, FSMPhase.UPTREND):
            if self.state.bc_candidate_idx is not None:
                self._check_bc_candidate(idx)
            else:
                self._check_phase_a_distribution(idx)
            # v2.1: if no BC candidate fired, try basis-building soft entry
            # for topping action.
            if (self.state.phase in (FSMPhase.MARKUP, FSMPhase.UPTREND)
                    and self.state.bc_candidate_idx is None):
                self._check_basis_building(idx, "up")
            if self.state.phase in (FSMPhase.MARKUP, FSMPhase.UPTREND):
                self._reclassify_trend(idx)
                self._check_markup_exhaustion(idx)
        elif phase == FSMPhase.DISTR_A:
            self._check_distr_ar_then_st(idx)
            self._check_climax_invalidation(idx, direction="up")
        elif phase == FSMPhase.DISTR_B:
            self._check_utad(idx)
            self._check_distr_range_invalidation(idx)
        elif phase == FSMPhase.DISTR_C:
            self._check_test_utad_or_sow(idx)
            self._check_utad_failure(idx)
            self._check_distr_range_invalidation(idx)
        elif phase == FSMPhase.DISTR_D:
            self._check_lpsy_or_markdown(idx)

    # =================================================================
    # Initial-state bootstrap
    # =================================================================

    def _bootstrap_initial_state(self, idx: int) -> None:
        """
        Set the initial FSM phase based on the trend slope at warm-up.
        Without this, a stock that was already uptrending at the start of
        the lookback window stays in UNKNOWN forever (no SC ever fires,
        and BC requires being in MARKUP/UPTREND first).
        """
        slope = self._trend_slope(idx)
        threshold = self.params.TREND_SLOPE_THRESHOLD
        if slope > threshold:
            self.state.phase = FSMPhase.UPTREND
            self.state.trend_start_idx = idx
        elif slope < -threshold:
            self.state.phase = FSMPhase.DOWNTREND
            self.state.trend_start_idx = idx
        # Otherwise stay in UNKNOWN — sideways start, neither side eligible yet

    def _check_climax_invalidation(self, idx: int, direction: str) -> None:
        """
        While in ACCUM_A / DISTR_A, if the climax is contradicted by sustained
        opposite-direction movement, abandon it and return to the trend.

        - direction='down' (we just had an SC and are waiting for ST):
            if 3 consecutive closes go BELOW sc_low * 0.95, the SC was a
            continuation, not a climax → revert to DOWNTREND.
        - direction='up' (we just had a BC and are waiting for ST_high):
            if 3 consecutive closes go ABOVE bc_high * 1.05, the BC was a
            strong continuation → revert to UPTREND.

        Without this rule the FSM stalls indefinitely waiting for an ST that
        will never come (e.g. DEWA Oct 2025 BC at 354 followed by rally to 850).
        """
        if idx < 2:
            return
        last3 = self.bars[idx - 2: idx + 1]
        if direction == "down":
            if (self.state.sc_low is not None
                    and all(b.close < self.state.sc_low * 0.95 for b in last3)):
                self.state = WyckoffState(
                    phase=FSMPhase.DOWNTREND, events=self.state.events,
                )
                self.state.trend_start_idx = idx
        elif direction == "up":
            if (self.state.bc_high is not None
                    and all(b.close > self.state.bc_high * 1.05 for b in last3)):
                self.state = WyckoffState(
                    phase=FSMPhase.UPTREND, events=self.state.events,
                )
                self.state.trend_start_idx = idx

    def _check_accum_range_invalidation(self, idx: int) -> None:
        """
        Range failure handling for accumulation. Two failure modes:
          - Range breaks DOWN decisively → accum_failed event (re-distribution)
          - Range breaks UP decisively without Spring/SOS → range_breakout_up
            event (v2.1 spec: don't transition silently; emit a marker so the
            chart shows the range completed even without textbook signals)
        """
        if (self.state.range_low is None or self.state.range_high is None
                or idx < 2):
            return
        last3 = self.bars[idx - 2: idx + 1]
        bar = self.bars[idx]
        # Down-break failure
        if all(b.close < self.state.range_low * 0.95 for b in last3):
            ev = WyckoffEvent(
                ticker=self._ticker or "",
                event_type=ACCUM_FAILED,
                event_date=bar.date, bar_idx=idx,
                price=int(bar.close), volume=int(bar.volume),
                confidence=75, inferred_phase="markdown",
                fsm_phase=self.state.phase.value,
                notes=(f"Accumulation Failed — range {int(self.state.range_low)}"
                       f"-{int(self.state.range_high)} broke down on close. "
                       f"Likely re-distribution, not a base."),
            )
            self.state.events.append(ev)
            self.state = WyckoffState(phase=FSMPhase.MARKDOWN, events=self.state.events)
            self.state.trend_start_idx = idx
            return
        # Up-break completion without Spring/SOS — emit range_breakout_up
        if all(b.close > self.state.range_high * 1.05 for b in last3):
            ev = WyckoffEvent(
                ticker=self._ticker or "",
                event_type=RANGE_BREAKOUT_UP,
                event_date=bar.date, bar_idx=idx,
                price=int(bar.close), volume=int(bar.volume),
                confidence=65, inferred_phase="markup",
                fsm_phase=self.state.phase.value,
                notes=(f"Range Breakout Up — accumulation {int(self.state.range_low)}"
                       f"-{int(self.state.range_high)} resolved upward on closes "
                       f"without classical Spring/SOS sequence."),
            )
            self.state.events.append(ev)
            self.state = WyckoffState(phase=FSMPhase.MARKUP, events=self.state.events)
            self.state.trend_start_idx = idx

    def _check_distr_range_invalidation(self, idx: int) -> None:
        """
        Range failure handling for distribution (mirror).
          - Range breaks UP decisively → distr_failed (re-accumulation)
          - Range breaks DOWN decisively without UTAD/SOW → range_breakout_down
        """
        if (self.state.range_low is None or self.state.range_high is None
                or idx < 2):
            return
        last3 = self.bars[idx - 2: idx + 1]
        bar = self.bars[idx]
        if all(b.close > self.state.range_high * 1.05 for b in last3):
            ev = WyckoffEvent(
                ticker=self._ticker or "",
                event_type=DISTR_FAILED,
                event_date=bar.date, bar_idx=idx,
                price=int(bar.close), volume=int(bar.volume),
                confidence=75, inferred_phase="markup",
                fsm_phase=self.state.phase.value,
                notes=(f"Distribution Failed — range {int(self.state.range_low)}"
                       f"-{int(self.state.range_high)} broke up on close. "
                       f"Was re-accumulation, not a top."),
            )
            self.state.events.append(ev)
            self.state = WyckoffState(phase=FSMPhase.MARKUP, events=self.state.events)
            self.state.trend_start_idx = idx
            return
        if all(b.close < self.state.range_low * 0.95 for b in last3):
            ev = WyckoffEvent(
                ticker=self._ticker or "",
                event_type=RANGE_BREAKOUT_DOWN,
                event_date=bar.date, bar_idx=idx,
                price=int(bar.close), volume=int(bar.volume),
                confidence=65, inferred_phase="markdown",
                fsm_phase=self.state.phase.value,
                notes=(f"Range Breakout Down — distribution {int(self.state.range_low)}"
                       f"-{int(self.state.range_high)} resolved downward on closes "
                       f"without classical UTAD/SOW sequence."),
            )
            self.state.events.append(ev)
            self.state = WyckoffState(phase=FSMPhase.MARKDOWN, events=self.state.events)
            self.state.trend_start_idx = idx

    def _reclassify_trend(self, idx: int) -> None:
        """
        Periodically re-evaluate whether a stuck DOWNTREND/UPTREND state
        should flip to the opposite. Without this, a stock that quietly
        reverses without a climactic event stays in the wrong phase
        forever and never fires distribution/accumulation events.

        Only re-classifies every 20 bars to avoid thrashing.
        """
        if idx % 20 != 0:
            return
        slope = self._trend_slope(idx)
        threshold = self.params.TREND_SLOPE_THRESHOLD

        cur = self.state.phase
        if cur in (FSMPhase.DOWNTREND, FSMPhase.MARKDOWN) and slope > threshold:
            self.state.phase = FSMPhase.UPTREND
            self.state.trend_start_idx = idx
            # Fresh trend → climax-candidate gap counter resets relative to
            # this bar; old candidates from the prior trend don't gate.
            self.state.last_bc_candidate_idx = -10_000
        elif cur in (FSMPhase.UPTREND, FSMPhase.MARKUP) and slope < -threshold:
            self.state.phase = FSMPhase.DOWNTREND
            self.state.trend_start_idx = idx
            self.state.last_sc_candidate_idx = -10_000

    # =================================================================
    # Rolling indicators
    # =================================================================

    def _atr(self, idx: int) -> float:
        if idx < self.params.LOOKBACK_ATR:
            return 0.0
        window = self.bars[idx - self.params.LOOKBACK_ATR: idx]
        trs: List[float] = []
        for i, b in enumerate(window):
            if i == 0:
                trs.append(b.spread)
                continue
            pc = window[i - 1].close
            tr = max(b.high - b.low, abs(b.high - pc), abs(b.low - pc))
            trs.append(tr)
        return sum(trs) / len(trs)

    def _vol_stats(self, idx: int) -> Tuple[float, float]:
        if idx < self.params.LOOKBACK_VOL:
            return 0.0, 0.0
        window = [b.volume for b in self.bars[idx - self.params.LOOKBACK_VOL: idx]]
        if not window:
            return 0.0, 0.0
        mean = sum(window) / len(window)
        var = sum((v - mean) ** 2 for v in window) / len(window)
        return mean, var ** 0.5

    def _vol_z(self, idx: int) -> float:
        if idx < self.params.LOOKBACK_VOL:
            return 0.0
        mean, std = self._vol_stats(idx)
        if std == 0:
            return 0.0
        return (self.bars[idx].volume - mean) / std

    def _trend_slope(self, idx: int, window: int | None = None) -> float:
        """Linear-regression slope of closes, ATR-normalized."""
        w = window or self.params.LOOKBACK_TREND
        if idx < w:
            return 0.0
        closes = [b.close for b in self.bars[idx - w: idx]]
        n = len(closes)
        x_mean = (n - 1) / 2
        y_mean = sum(closes) / n
        num = sum((i - x_mean) * (c - y_mean) for i, c in enumerate(closes))
        den = sum((i - x_mean) ** 2 for i in range(n))
        slope = num / den if den else 0.0
        atr = self._atr(idx)
        return slope / atr if atr else 0.0

    # =================================================================
    # Bar predicates
    # =================================================================

    def _is_climactic_down(self, idx: int) -> bool:
        """
        SC candidate. Two paths:
          1. Strict-classical: wide spread + climactic volume + close off lows
             + red bar + downtrend confirmed.
          2. Super-climactic override: overwhelming volume (vol_z > 3.0) +
             red bar — this alone is enough to flag SC even if the slope
             hasn't fully confirmed, because such bars are unmistakable.
        """
        bar = self.bars[idx]
        atr = self._atr(idx)
        p = self.params
        if atr == 0:
            return False

        vz = self._vol_z(idx)

        # Path 2: super-climactic override
        if (vz > p.SUPER_CLIMAX_VOL_Z
                and bar.close < bar.open
                and bar.spread > atr):
            return True

        # Path 1: strict-classical
        return (bar.spread > p.CLIMAX_SPREAD_ATR * atr
                and vz > p.CLIMAX_VOL_Z
                and bar.close_position > 0.20
                and bar.close < bar.open
                and self._trend_slope(idx) < -p.TREND_SLOPE_THRESHOLD)

    def _is_climactic_up(self, idx: int) -> bool:
        """
        BC candidate. Same two-path structure as SC.
        """
        bar = self.bars[idx]
        atr = self._atr(idx)
        p = self.params
        if atr == 0:
            return False

        vz = self._vol_z(idx)

        # Path 2: super-climactic override
        if vz > p.SUPER_CLIMAX_VOL_Z and bar.spread > atr:
            # Even a green super-volume bar can be BC if it's wide and the
            # close is weak relative to the high (failed late-bar push)
            if bar.close_position < 0.85:
                return True

        # Path 1: strict-classical
        return (bar.spread > p.CLIMAX_SPREAD_ATR * atr
                and vz > p.CLIMAX_VOL_Z
                and bar.close_position < 0.75
                and self._trend_slope(idx) > p.TREND_SLOPE_THRESHOLD)

    def _is_wide_up_bar(self, idx: int) -> bool:
        bar = self.bars[idx]
        atr = self._atr(idx)
        return (bar.spread > self.params.WIDE_SPREAD_ATR * atr
                and bar.is_up
                and bar.close_position > 0.6)

    def _is_wide_down_bar(self, idx: int) -> bool:
        bar = self.bars[idx]
        atr = self._atr(idx)
        return (bar.spread > self.params.WIDE_SPREAD_ATR * atr
                and not bar.is_up
                and bar.close_position < 0.4)

    def _is_no_supply(self, idx: int) -> bool:
        bar = self.bars[idx]
        atr = self._atr(idx)
        mean_vol, _ = self._vol_stats(idx)
        return (bar.spread < self.params.NARROW_SPREAD_ATR * atr
                and bar.volume < self.params.LOW_VOLUME_RATIO * mean_vol)

    # =================================================================
    # v2.1 spec predicates: distributed climaxes (cluster + absorption)
    # =================================================================

    def _climactic_cluster(self, idx: int, direction: str) -> bool:
        """
        3-bar gradual climax. Catches climaxes that no single bar would
        flag — e.g., 3 consecutive heavy-volume bars that together move
        > 2× ATR in one direction. Spec §Helper predicates / CLIMACTIC_CLUSTER.
        """
        p = self.params
        if idx < p.CLUSTER_LOOKBACK:
            return False
        atr = self._atr(idx)
        if atr <= 0:
            return False
        window = self.bars[idx - p.CLUSTER_LOOKBACK + 1: idx + 1]
        # Cumulative volume z-score (heavy effort across the window)
        vol_z_sum = sum(max(0.0, self._vol_z(b.idx)) for b in window)
        if vol_z_sum < p.CLUSTER_VOL_Z_SUM_MIN:
            return False
        # Net price move in the claimed direction
        first_close = window[0].open
        last_close = window[-1].close
        net = last_close - first_close
        if direction == "down":
            return -net > p.CLUSTER_NET_MOVE_ATR_MIN * atr
        else:
            return net > p.CLUSTER_NET_MOVE_ATR_MIN * atr

    def _absorption_regime(self, idx: int, direction: str) -> bool:
        """
        15-bar distributed climax. The 'sustained absorption' pattern: heavy
        cumulative volume across many bars where price stops trending, makes
        a new local extreme, then partially reclaims. Catches soft tops/bottoms
        where no single bar is wide-spread. Spec §ABSORPTION_REGIME.
        """
        p = self.params
        if idx < 2 * p.ABSORPTION_LOOKBACK:
            return False
        window = self.bars[idx - p.ABSORPTION_LOOKBACK + 1: idx + 1]
        prior  = self.bars[idx - 2 * p.ABSORPTION_LOOKBACK + 1:
                           idx - p.ABSORPTION_LOOKBACK + 1]

        pos_vol_z_sum = sum(max(0.0, self._vol_z(b.idx)) for b in window)
        high_vol_bars = sum(1 for b in window if self._vol_z(b.idx) > 1.0)
        if pos_vol_z_sum < p.ABSORPTION_VOL_Z_SUM_MIN:
            return False
        if high_vol_bars < p.ABSORPTION_HIGH_VOL_BARS_MIN:
            return False

        if direction == "down":
            extreme = min(b.low for b in window)
            prior_extreme = min(b.low for b in prior)
            window_high = max(b.high for b in window)
            # Must be a new low vs prior period (stopping-action zone)
            if extreme >= prior_extreme:
                return False
            denom = (window_high - extreme)
            if denom <= 0:
                return False
            recovery = (window[-1].close - extreme) / denom
            return recovery >= p.ABSORPTION_RECOVERY_PCT

        if direction == "up":
            extreme = max(b.high for b in window)
            prior_extreme = max(b.high for b in prior)
            window_low = min(b.low for b in window)
            if extreme <= prior_extreme:
                return False
            denom = (extreme - window_low)
            if denom <= 0:
                return False
            retracement = (extreme - window[-1].close) / denom
            return retracement >= p.ABSORPTION_RECOVERY_PCT

        return False

    def _basis_building(self, idx: int, direction: str) -> bool:
        """
        20-bar containment pattern that signals 'trend ended on stopping
        action without a discrete climax.' Triggers soft phase A entry.
        Spec §BASIS_BUILDING.
        """
        p = self.params
        if idx < p.BASIS_LOOKBACK + 30:
            return False
        window = self.bars[idx - p.BASIS_LOOKBACK + 1: idx + 1]
        atr = self._atr(idx)
        if atr <= 0:
            return False

        # Range must be contained
        window_range = max(b.high for b in window) - min(b.low for b in window)
        if window_range > p.BASIS_RANGE_ATR_LIMIT * atr:
            return False
        # Volume not dead (some interest, not vacuum)
        avg_vz = sum(self._vol_z(b.idx) for b in window if self._vol_z(b.idx) is not None) / len(window)
        if avg_vz < p.BASIS_AVG_VOL_Z_FLOOR:
            return False

        third = max(1, p.BASIS_LOOKBACK // 3)
        early_third = window[:third]
        late_third  = window[-third:]

        if direction == "down":
            # Prior trend was meaningfully bearish
            if self._trend_slope(idx - p.BASIS_LOOKBACK, window=30) > -p.BASIS_PRIOR_TREND_SLOPE:
                return False
            early_low = min(b.low for b in early_third)
            # Closes in last third haven't broken below early-third lows
            return all(b.close >= early_low for b in late_third)

        if direction == "up":
            if self._trend_slope(idx - p.BASIS_LOOKBACK, window=30) < p.BASIS_PRIOR_TREND_SLOPE:
                return False
            early_high = max(b.high for b in early_third)
            return all(b.close <= early_high for b in late_third)

        return False

    # =================================================================
    # v2.1 spec: soft phase A entry (BASIS_BUILDING / TOPPING_ACTION)
    # =================================================================

    def _check_basis_building(self, idx: int, direction: str) -> None:
        """
        Soft phase A entry per v2.1 spec §basis-building. When a trend ends
        on stopping action without a textbook climax (DEWA Oct 2025 / AVIA
        Oct 2025 cases), this gives the FSM a phase to transition into so
        downstream Spring/SOS/UTAD detection can fire.

        Confidence is 0.5 (vs 0.7-0.85 for climactic events) — soft entries
        propagate uncertainty downstream.

        Gates added beyond spec text (to prevent flapping observed on real
        IDX data where ranges are common):
          - state.trend_age must meet the same persistence bar as climax
            candidates (30 for DOWN entry, 40 for UP entry)
          - 60-bar suppression after any prior soft entry
          - 30-bar suppression after any range_breakout, distr_failed, or
            accum_failed event (which ALREADY emitted a marker)
        """
        p = self.params
        # Suppression window after any prior soft entry
        if idx - self.state.last_soft_entry_idx < 60:
            return
        # Trend persistence gate — same as climax candidates
        trend_age = idx - self.state.trend_start_idx
        if direction == "down" and trend_age < p.SC_MIN_TREND_PERSIST_BARS:
            return
        if direction == "up" and trend_age < p.BC_MIN_TREND_PERSIST_BARS:
            return
        # Recent breakout/failure event already says "transition happened"
        for ev in reversed(self.state.events):
            if idx - ev.bar_idx > 30:
                break
            if ev.event_type in (RANGE_BREAKOUT_UP, RANGE_BREAKOUT_DOWN,
                                 DISTR_FAILED, ACCUM_FAILED,
                                 MARKUP_EXHAUSTION, MARKDOWN_EXHAUSTION):
                return
        if not self._basis_building(idx, direction):
            return

        bar = self.bars[idx]
        p = self.params
        window = self.bars[idx - p.BASIS_LOOKBACK + 1: idx + 1]
        rh = max(b.high for b in window)
        rl = min(b.low for b in window)

        if direction == "down":
            self.state.phase = FSMPhase.ACCUM_B  # skip A — basis IS the range
            self.state.range_high = rh
            self.state.range_low = rl
            self.state.range_start_idx = idx - p.BASIS_LOOKBACK + 1
            self.state.last_soft_entry_idx = idx
            self._emit(
                idx, BASIS_BUILDING_EVT, bar.close, confidence=50,
                notes=(
                    f"Basis Building — downtrend stopped on stopping action, "
                    f"no textbook SC. Range {int(rl)}-{int(rh)} from "
                    f"bar {idx - p.BASIS_LOOKBACK + 1}. Soft entry to ACCUM_B."
                ),
            )
        else:  # up — topping action
            self.state.phase = FSMPhase.DISTR_B
            self.state.range_high = rh
            self.state.range_low = rl
            self.state.range_start_idx = idx - p.BASIS_LOOKBACK + 1
            self.state.last_soft_entry_idx = idx
            self._emit(
                idx, TOPPING_ACTION_EVT, bar.close, confidence=50,
                notes=(
                    f"Topping Action — uptrend stopped on stopping action, "
                    f"no textbook BC. Range {int(rl)}-{int(rh)} from "
                    f"bar {idx - p.BASIS_LOOKBACK + 1}. Soft entry to DISTR_B."
                ),
            )

    # =================================================================
    # v2.1 spec: trend-driven phase exit (markup_exhaustion / markdown_exhaustion)
    # =================================================================

    def _check_markup_exhaustion(self, idx: int) -> None:
        """
        Per v2.1 spec §trend-driven transitions. When a markup ends via
        slow rollover with no climactic BC (DEWA Jan 2026 case), recognize
        it explicitly: bearish slope persists for ≥15 bars AND price has
        retraced ≥30% of the markup range.
        """
        p = self.params
        slope = self._trend_slope(idx, window=20)
        if slope < -p.EXHAUSTION_SLOPE_THRESHOLD:
            self.state.bearish_slope_streak += 1
        else:
            self.state.bearish_slope_streak = 0

        if self.state.bearish_slope_streak < p.EXHAUSTION_SLOPE_STREAK_BARS:
            return

        # Check retracement vs the recent markup extreme
        lookback = 60
        if idx < lookback:
            return
        window = self.bars[idx - lookback: idx + 1]
        markup_high = max(b.high for b in window)
        markup_low = min(b.low for b in window)
        denom = markup_high - markup_low
        if denom <= 0:
            return
        bar = self.bars[idx]
        retrace = (markup_high - bar.close) / denom
        if retrace < p.EXHAUSTION_RETRACE_PCT:
            return

        # Emit and transition
        self._emit(
            idx, MARKUP_EXHAUSTION, bar.close, confidence=60,
            notes=(
                f"Markup Exhaustion — bearish slope {self.state.bearish_slope_streak} bars, "
                f"retraced {retrace*100:.0f}% from {int(markup_high)} high. "
                f"No clean BC; trend rolled over."
            ),
        )
        self.state = WyckoffState(phase=FSMPhase.MARKDOWN, events=self.state.events)
        self.state.trend_start_idx = idx

    def _check_markdown_exhaustion(self, idx: int) -> None:
        """Mirror — markdown ending via slow recovery without a textbook SC."""
        p = self.params
        slope = self._trend_slope(idx, window=20)
        if slope > p.EXHAUSTION_SLOPE_THRESHOLD:
            self.state.bullish_slope_streak += 1
        else:
            self.state.bullish_slope_streak = 0

        if self.state.bullish_slope_streak < p.EXHAUSTION_SLOPE_STREAK_BARS:
            return

        lookback = 60
        if idx < lookback:
            return
        window = self.bars[idx - lookback: idx + 1]
        markdown_low = min(b.low for b in window)
        markdown_high = max(b.high for b in window)
        denom = markdown_high - markdown_low
        if denom <= 0:
            return
        bar = self.bars[idx]
        recovery = (bar.close - markdown_low) / denom
        if recovery < p.EXHAUSTION_RETRACE_PCT:
            return

        self._emit(
            idx, MARKDOWN_EXHAUSTION, bar.close, confidence=60,
            notes=(
                f"Markdown Exhaustion — bullish slope {self.state.bullish_slope_streak} bars, "
                f"recovered {recovery*100:.0f}% from {int(markdown_low)} low. "
                f"No clean SC; trend reversed."
            ),
        )
        self.state = WyckoffState(phase=FSMPhase.MARKUP, events=self.state.events)
        self.state.trend_start_idx = idx

    # =================================================================
    # Event emission helper
    # =================================================================

    def _emit(
        self, idx: int, event_type: str, price: float,
        confidence: int, notes: Optional[str] = None,
    ) -> None:
        bar = self.bars[idx]
        ev = WyckoffEvent(
            ticker=self._ticker or "",
            event_type=event_type,
            event_date=bar.date,
            bar_idx=idx,
            price=int(price),
            volume=int(bar.volume),
            confidence=max(0, min(100, confidence)),
            inferred_phase=PHASE_CATEGORY[self.state.phase],
            fsm_phase=self.state.phase.value,
            notes=notes,
        )
        self.state.events.append(ev)

    # =================================================================
    # State transitions: ACCUMULATION
    # =================================================================

    def _check_super_climactic_distribution(self, idx: int) -> None:
        """
        Allow BC firing from non-uptrend states when a single bar is so
        overwhelmingly climactic (vol_z > 3.0, weak close) that ignoring it
        would be obviously wrong. Caller checks the phase precondition.
        """
        bar = self.bars[idx]
        vz = self._vol_z(idx)
        atr = self._atr(idx)
        if atr == 0 or vz <= self.params.SUPER_CLIMAX_VOL_Z:
            return
        if bar.spread <= atr or bar.close_position >= 0.85:
            return
        # Looks like a BC even though we weren't in MARKUP/UPTREND
        self.state.phase = FSMPhase.DISTR_A
        self.state.bc_idx = idx
        self.state.bc_high = bar.high
        self.state.bc_volume = bar.volume
        self.state.range_high = None
        self.state.range_low = None
        self.state.spring_idx = None
        self.state.spring_low = None
        self._emit(
            idx, BC, bar.high, confidence=70,
            notes=f"BC (super-climactic override) — vol_z={vz:.1f}, weak close",
        )

    def _check_super_climactic_accumulation(self, idx: int) -> None:
        """
        Mirror: SC firing from uptrend states when a single bar is
        overwhelmingly climactic on the down side.
        """
        bar = self.bars[idx]
        vz = self._vol_z(idx)
        atr = self._atr(idx)
        if atr == 0 or vz <= self.params.SUPER_CLIMAX_VOL_Z:
            return
        if bar.spread <= atr or bar.close >= bar.open or bar.close_position <= 0.15:
            return
        self.state.phase = FSMPhase.ACCUM_A
        self.state.sc_idx = idx
        self.state.sc_low = bar.low
        self.state.sc_volume = bar.volume
        self._emit(
            idx, SC, bar.low, confidence=70,
            notes=f"SC (super-climactic override) — vol_z={vz:.1f}, off-lows close",
        )

    def _check_phase_a_accumulation(self, idx: int) -> None:
        """
        Mark an SC candidate per v2.1 spec. Three valid trigger paths
        mirroring BC: single-bar, 3-bar cluster, or 15-bar absorption regime.
        """
        p = self.params
        if idx - self.state.trend_start_idx < p.SC_MIN_TREND_PERSIST_BARS:
            return
        if not self._climax_lockout_clear("SC", idx):
            return

        path = None
        if self._is_climactic_down(idx) and self._vol_z(idx) > p.SC_CLIMAX_VOL_Z:
            path = "single-bar"
        elif self._climactic_cluster(idx, "down"):
            path = "cluster-3bar"
        elif self._absorption_regime(idx, "down"):
            path = "absorption-15bar"
        if path is None:
            return

        bar = self.bars[idx]
        self.state.sc_candidate_idx = idx
        if path == "single-bar":
            self.state.sc_candidate_low = bar.low
        else:
            window = self.bars[max(0, idx - p.ABSORPTION_LOOKBACK + 1): idx + 1]
            self.state.sc_candidate_low = min(b.low for b in window)
        self.state.sc_candidate_volume = bar.volume

    def _check_sc_candidate(self, idx: int) -> None:
        """Mirror of _check_bc_candidate — same invalidate / confirm / timeout logic."""
        cand_idx = self.state.sc_candidate_idx
        if cand_idx is None:
            return
        cand_low = self.state.sc_candidate_low
        cand_vol = self.state.sc_candidate_volume
        bars_since = idx - cand_idx
        bar = self.bars[idx]

        # Fix 1 mirror: any close below candidate's low → invalidate
        if bar.close < cand_low:
            self.state.last_sc_invalidated_idx = cand_idx
            self._clear_sc_candidate()
            return

        if bars_since >= self.params.CANDIDATE_CONFIRM_BARS:
            post = self.bars[cand_idx + 1: idx + 1]
            if not post:
                return
            min_low = min(b.low for b in post)
            max_close = max(b.close for b in post)
            cand_bar = self.bars[cand_idx]
            if (min_low >= cand_low
                    and max_close > cand_bar.close * (1 + self.params.CANDIDATE_PULLBACK_PCT)):
                self.state.phase = FSMPhase.ACCUM_A
                self.state.sc_idx = cand_idx
                self.state.sc_low = cand_low
                self.state.sc_volume = cand_vol
                ev = WyckoffEvent(
                    ticker=self._ticker or "",
                    event_type=SC,
                    event_date=cand_bar.date,
                    bar_idx=cand_idx,
                    price=int(cand_low),
                    volume=int(cand_vol or 0),
                    confidence=80,
                    inferred_phase="accumulation",
                    fsm_phase=self.state.phase.value,
                    notes=f"Selling Climax — confirmed by accumulation character "
                          f"over {bars_since} bars (no new low, "
                          f"rebound {(max_close / cand_bar.close - 1)*100:.1f}%)",
                )
                self.state.events.append(ev)
                self.state.last_sc_confirmed_idx = cand_idx
                self._clear_sc_candidate()
                return

        if bars_since >= self.params.CANDIDATE_TIMEOUT_BARS:
            self.state.last_sc_invalidated_idx = cand_idx
            self._clear_sc_candidate()

    def _clear_sc_candidate(self) -> None:
        self.state.sc_candidate_idx = None
        self.state.sc_candidate_low = None
        self.state.sc_candidate_volume = None

    def _check_ar_then_st(self, idx: int) -> None:
        bars_since_sc = idx - (self.state.sc_idx or idx)

        # Stage 1: looking for AR (rally)
        if self.state.range_high is None:
            if bars_since_sc > self.params.MAX_AR_LAG:
                # SC didn't lead anywhere → abort
                self.state = WyckoffState(phase=FSMPhase.DOWNTREND, events=self.state.events)
                return

            if self._is_wide_up_bar(idx):
                bar = self.bars[idx]
                rally_size = bar.high - (self.state.sc_low or bar.high)
                sc_bar = self.bars[self.state.sc_idx]
                sc_range = sc_bar.high - sc_bar.low
                if rally_size > 0.30 * sc_range and rally_size > 1.5 * self._atr(idx):
                    self.state.range_high = bar.high
                    self._emit(
                        idx, AR_UP, bar.high, confidence=70,
                        notes="Automatic Rally after SC — defines range high",
                    )
            return

        # Stage 2: AR established, looking for ST
        if bars_since_sc > self.params.MAX_AR_LAG + self.params.MAX_ST_LAG:
            return  # don't time out hard

        bar = self.bars[idx]
        if (self.state.sc_low * 0.97 <= bar.low <= self.state.sc_low * 1.03
                and bar.volume < self.params.LOW_VOLUME_RATIO * (self.state.sc_volume or 1)):
            self.state.range_low = min(self.state.sc_low, bar.low)
            self.state.range_start_idx = idx
            self.state.phase = FSMPhase.ACCUM_B
            self._emit(
                idx, ST_LOW, bar.low, confidence=75,
                notes=f"Secondary Test of SC low on quieter volume — Phase B begins",
            )

    def _check_spring(self, idx: int) -> None:
        """
        Fix 4 (Spring side): require meaningful penetration AND meaningful
        spread AND some volume on the false-break bar. A 0.05 IDR pierce on
        a doji isn't a Spring even if the math says it dipped below.
        """
        bars_in_b = idx - (self.state.range_start_idx or idx)
        if bars_in_b < self.params.MIN_PHASE_B_BARS:
            return

        bar = self.bars[idx]
        if (self.state.range_low is None
                or bar.low >= self.state.range_low
                or bar.close <= self.state.range_low):
            return
        if self._vol_z(idx) >= self.params.CLIMAX_VOL_Z:
            return  # climactic volume = real breakdown, not a spring

        atr = self._atr(idx)
        if atr <= 0:
            return
        penetration_atr = (self.state.range_low - bar.low) / atr
        spread_atr = bar.spread / atr
        vz = self._vol_z(idx)

        # Fix 4: penetration > 0.3× ATR, spread > 1.0× ATR, vol_z > 0.5
        if (penetration_atr < self.params.PENETRATION_MIN_ATR
                or spread_atr < self.params.UTAD_SPRING_SPREAD_ATR_MIN
                or vz < self.params.UTAD_SPRING_VOL_Z_MIN):
            return

        self.state.phase = FSMPhase.ACCUM_C
        self.state.spring_idx = idx
        self.state.spring_low = bar.low
        self.state.spring_test_fired = False
        recovery_atr = (bar.close - self.state.range_low) / atr
        confidence = int(max(50, min(90, 60 + 15 * recovery_atr - 5 * penetration_atr)))
        self._emit(
            idx, SPRING, bar.low, confidence=confidence,
            notes=f"Spring — pierced range_low {self.state.range_low:.0f} "
                  f"by {penetration_atr:.2f}× ATR, recovered {recovery_atr:.2f}× ATR, "
                  f"spread {spread_atr:.2f}× ATR, vol_z={vz:+.2f}",
        )

    def _check_test_or_sos(self, idx: int) -> None:
        bar = self.bars[idx]

        # Test of Spring — only one per Spring anchor (mapped to ST_low)
        if (not self.state.spring_test_fired
                and self.state.spring_low is not None
                and self.state.spring_low * 0.97 <= bar.low <= self.state.spring_low * 1.03
                and self._is_no_supply(idx)):
            self.state.spring_test_fired = True
            self._emit(
                idx, ST_LOW, bar.low, confidence=85,
                notes="Successful Test of Spring — narrow range, low volume",
            )
            return

        # SOS — wide-spread up bar closing ABOVE range high on above-avg volume
        if (self._is_wide_up_bar(idx)
                and self.state.range_high is not None
                and bar.close > self.state.range_high
                and self._vol_z(idx) > 1.0):
            self.state.phase = FSMPhase.ACCUM_D
            self.state.sos_idx = idx
            self._emit(
                idx, SOS, bar.close, confidence=85,
                notes=f"Sign of Strength — closes above range_high "
                      f"{self.state.range_high:.0f} on vol_z={self._vol_z(idx):.1f}",
            )

    def _check_spring_failure(self, idx: int) -> None:
        bar = self.bars[idx]
        if (self.state.spring_low is not None
                and bar.close < self.state.spring_low
                and idx > 0
                and self.bars[idx - 1].close < self.state.spring_low):
            # Revert to Phase B; the spring failed
            self.state.phase = FSMPhase.ACCUM_B
            self.state.spring_idx = None
            self.state.spring_low = None

    def _check_lps_or_markup(self, idx: int) -> None:
        bar = self.bars[idx]
        if (self.state.range_high is not None
                and self.state.range_high * 0.97 <= bar.low <= self.state.range_high * 1.03
                and self._vol_z(idx) < 0):
            self._emit(
                idx, LPS, bar.low, confidence=80,
                notes="Last Point of Support — pullback to broken range_high "
                      "on declining volume",
            )

        if (self.state.sos_idx is not None
                and idx - self.state.sos_idx > 10
                and self.state.range_high is not None
                and bar.close > self.state.range_high * 1.05):
            self.state.phase = FSMPhase.MARKUP

    # =================================================================
    # State transitions: DISTRIBUTION
    # =================================================================

    def _check_phase_a_distribution(self, idx: int) -> None:
        """
        Mark a BC candidate per v2.1 spec. Three valid trigger paths:
          1. Single-bar climactic up (CLIMACTIC_UP_BAR + vol_z > 1.5)
          2. 3-bar gradual climax (CLIMACTIC_CLUSTER)
          3. 15-bar distributed climax (ABSORPTION_REGIME UP)

        Gated by:
          - state.phase in MARKUP/UPTREND
          - state.trend_age (idx - trend_start_idx) > BC_MIN_TREND_PERSIST_BARS
          - asymmetric lockout: HARD if last BC confirmed, SOFT if invalidated
          - no BC candidate currently pending
        """
        p = self.params
        # Trend persistence — markups need 40+ bars of trend before BC valid
        if idx - self.state.trend_start_idx < p.BC_MIN_TREND_PERSIST_BARS:
            return
        # Asymmetric lockout (Priority 3)
        if not self._climax_lockout_clear("BC", idx):
            return

        # Three valid trigger paths
        path = None
        if self._is_climactic_up(idx) and self._vol_z(idx) > p.BC_CLIMAX_VOL_Z:
            path = "single-bar"
        elif self._climactic_cluster(idx, "up"):
            path = "cluster-3bar"
        elif self._absorption_regime(idx, "up"):
            path = "absorption-15bar"
        if path is None:
            return

        bar = self.bars[idx]
        self.state.bc_candidate_idx = idx
        # For cluster/absorption paths use the highest high in the recent
        # window as the candidate "high" — that's the level a continuation
        # close would need to clear to invalidate.
        if path == "single-bar":
            self.state.bc_candidate_high = bar.high
        else:
            window = self.bars[max(0, idx - p.ABSORPTION_LOOKBACK + 1): idx + 1]
            self.state.bc_candidate_high = max(b.high for b in window)
        self.state.bc_candidate_volume = bar.volume
        # Note: trigger path stored implicitly via vol_z/spread in confirm logic

    def _check_bc_candidate(self, idx: int) -> None:
        """
        Manage a pending BC candidate (Fix 1+2):
          - Invalidate immediately if any close in the window > candidate.high
            (continuation, not a top — no event recorded)
          - After CONFIRM_BARS bars of distribution character (no new high,
            meaningful pullback) → emit BC and transition to DISTR_A
          - After TIMEOUT_BARS without confirmation → silently invalidate
        """
        cand_idx = self.state.bc_candidate_idx
        if cand_idx is None:
            return
        cand_high = self.state.bc_candidate_high
        cand_vol = self.state.bc_candidate_volume
        bars_since = idx - cand_idx
        bar = self.bars[idx]

        # Fix 1: any close above the candidate's high → invalidate, no event.
        # v2.1: record SOFT lockout so the same cluster doesn't retrigger.
        if bar.close > cand_high:
            self.state.last_bc_invalidated_idx = cand_idx
            self._clear_bc_candidate()
            return

        if bars_since >= self.params.CANDIDATE_CONFIRM_BARS:
            # Distribution character: post-candidate bars must NOT make a
            # new high AND must show a meaningful pullback below candidate close.
            post = self.bars[cand_idx + 1: idx + 1]
            if not post:
                return
            max_high = max(b.high for b in post)
            min_close = min(b.close for b in post)
            cand_bar = self.bars[cand_idx]
            if (max_high <= cand_high
                    and min_close < cand_bar.close * (1 - self.params.CANDIDATE_PULLBACK_PCT)):
                # Confirmed — transition to DISTR_A and emit BC at the
                # ORIGINAL candidate bar's date/price.
                self.state.phase = FSMPhase.DISTR_A
                self.state.bc_idx = cand_idx
                self.state.bc_high = cand_high
                self.state.bc_volume = cand_vol
                # reset accumulation-specific state
                self.state.range_high = None
                self.state.range_low = None
                self.state.spring_idx = None
                self.state.spring_low = None
                ev = WyckoffEvent(
                    ticker=self._ticker or "",
                    event_type=BC,
                    event_date=cand_bar.date,
                    bar_idx=cand_idx,
                    price=int(cand_high),
                    volume=int(cand_vol or 0),
                    confidence=80,
                    inferred_phase="distribution",
                    fsm_phase=self.state.phase.value,
                    notes=f"Buying Climax — confirmed by distribution character "
                          f"over {bars_since} bars (no new high, "
                          f"close pulled back {(1 - min_close / cand_bar.close)*100:.1f}%)",
                )
                self.state.events.append(ev)
                # v2.1: HARD lockout — confirmed climax means trend over
                self.state.last_bc_confirmed_idx = cand_idx
                self._clear_bc_candidate()
                return

        if bars_since >= self.params.CANDIDATE_TIMEOUT_BARS:
            # Stalled — neither confirmed nor invalidated; treat as soft
            # invalidation for lockout purposes (don't retrigger on this cluster).
            self.state.last_bc_invalidated_idx = cand_idx
            self._clear_bc_candidate()

    def _clear_bc_candidate(self) -> None:
        self.state.bc_candidate_idx = None
        self.state.bc_candidate_high = None
        self.state.bc_candidate_volume = None

    def _climax_lockout_clear(self, climax_type: str, idx: int) -> bool:
        """
        v2.1 spec: asymmetric lockout. A CONFIRMED climax means the trend
        is presumed over; lock out the same type for HARD_LOCKOUT_BARS.
        An INVALIDATED candidate is the algorithm working correctly; only
        block briefly (SOFT_LOCKOUT_BARS) to avoid retriggering on the same
        multi-bar climactic cluster.
        """
        p = self.params
        if climax_type == "BC":
            confirmed = self.state.last_bc_confirmed_idx
            invalidated = self.state.last_bc_invalidated_idx
        else:  # SC
            confirmed = self.state.last_sc_confirmed_idx
            invalidated = self.state.last_sc_invalidated_idx

        if idx - confirmed < p.HARD_LOCKOUT_BARS:
            return False
        if idx - invalidated < p.SOFT_LOCKOUT_BARS:
            return False
        return True

    def _check_distr_ar_then_st(self, idx: int) -> None:
        bars_since_bc = idx - (self.state.bc_idx or idx)

        # Stage 1: looking for AR (drop)
        if self.state.range_low is None:
            if bars_since_bc > self.params.MAX_AR_LAG:
                self.state = WyckoffState(phase=FSMPhase.UPTREND, events=self.state.events)
                return

            if self._is_wide_down_bar(idx):
                bar = self.bars[idx]
                drop_size = (self.state.bc_high or bar.low) - bar.low
                if drop_size > 1.5 * self._atr(idx):
                    self.state.range_low = bar.low
                    self._emit(
                        idx, AR_DOWN, bar.low, confidence=70,
                        notes="Automatic Reaction after BC — defines range low",
                    )
            return

        # Stage 2: AR established, looking for ST high
        if bars_since_bc > self.params.MAX_AR_LAG + self.params.MAX_ST_LAG:
            return

        bar = self.bars[idx]
        if (self.state.bc_high is not None
                and self.state.bc_high * 0.97 <= bar.high <= self.state.bc_high * 1.03
                and bar.volume < self.params.LOW_VOLUME_RATIO * (self.state.bc_volume or 1)):
            self.state.range_high = max(self.state.bc_high, bar.high)
            self.state.range_start_idx = idx
            self.state.phase = FSMPhase.DISTR_B
            self._emit(
                idx, ST_HIGH, bar.high, confidence=75,
                notes="Secondary Test of BC high on quieter volume — Phase B begins",
            )

    def _check_utad(self, idx: int) -> None:
        """
        Fix 4 (UTAD side): require meaningful penetration above range AND
        meaningful spread AND some volume. A 1-tick poke above range_high
        with a wick isn't a UTAD.
        """
        bars_in_b = idx - (self.state.range_start_idx or idx)
        if bars_in_b < self.params.MIN_PHASE_B_BARS:
            return

        bar = self.bars[idx]
        if (self.state.range_high is None
                or bar.high <= self.state.range_high
                or bar.close >= self.state.range_high):
            return
        if self._vol_z(idx) >= self.params.CLIMAX_VOL_Z:
            return

        atr = self._atr(idx)
        if atr <= 0:
            return
        penetration_atr = (bar.high - self.state.range_high) / atr
        spread_atr = bar.spread / atr
        vz = self._vol_z(idx)

        if (penetration_atr < self.params.PENETRATION_MIN_ATR
                or spread_atr < self.params.UTAD_SPRING_SPREAD_ATR_MIN
                or vz < self.params.UTAD_SPRING_VOL_Z_MIN):
            return

        self.state.phase = FSMPhase.DISTR_C
        self.state.utad_idx = idx
        self.state.utad_high = bar.high
        self.state.utad_test_fired = False
        rejection_atr = (self.state.range_high - bar.close) / atr
        confidence = int(max(50, min(90, 60 + 15 * rejection_atr - 5 * penetration_atr)))
        self._emit(
            idx, UTAD, bar.high, confidence=confidence,
            notes=f"UTAD — false breakout above range_high {self.state.range_high:.0f}, "
                  f"penetration {penetration_atr:.2f}× ATR, "
                  f"rejected {rejection_atr:.2f}× ATR, vol_z={vz:+.2f}",
        )

    def _check_test_utad_or_sow(self, idx: int) -> None:
        bar = self.bars[idx]

        # Test of UTAD — only one per UTAD anchor
        if (not self.state.utad_test_fired
                and self.state.utad_high is not None
                and self.state.utad_high * 0.97 <= bar.high <= self.state.utad_high * 1.03
                and self._is_no_supply(idx)):
            self.state.utad_test_fired = True
            self._emit(
                idx, ST_HIGH, bar.high, confidence=80,
                notes="Test of UTAD — failed retest on quiet volume",
            )
            return

        # SOW — wide down bar closing below range_low
        if (self._is_wide_down_bar(idx)
                and self.state.range_low is not None
                and bar.close < self.state.range_low
                and self._vol_z(idx) > 1.0):
            self.state.phase = FSMPhase.DISTR_D
            self.state.sow_idx = idx
            self._emit(
                idx, SOW, bar.close, confidence=85,
                notes=f"Sign of Weakness — closes below range_low "
                      f"{self.state.range_low:.0f} on vol_z={self._vol_z(idx):.1f}",
            )

    def _check_utad_failure(self, idx: int) -> None:
        """If price closes above UTAD high for 2+ bars, the UTAD failed."""
        bar = self.bars[idx]
        if (self.state.utad_high is not None
                and bar.close > self.state.utad_high
                and idx > 0
                and self.bars[idx - 1].close > self.state.utad_high):
            self.state.phase = FSMPhase.DISTR_B
            self.state.utad_idx = None
            self.state.utad_high = None

    def _check_lpsy_or_markdown(self, idx: int) -> None:
        bar = self.bars[idx]
        # LPSY — pullback toward broken range_low (now resistance) on declining volume
        if (self.state.range_low is not None
                and self.state.range_low * 0.97 <= bar.high <= self.state.range_low * 1.03
                and self._vol_z(idx) < 0):
            self._emit(
                idx, LPSY, bar.high, confidence=80,
                notes="Last Point of Supply — rally to broken range_low "
                      "on declining volume",
            )

        # Transition to MARKDOWN after sustained move clear of the range
        if (self.state.sow_idx is not None
                and idx - self.state.sow_idx > 10
                and self.state.range_low is not None
                and bar.close < self.state.range_low * 0.95):
            self.state.phase = FSMPhase.MARKDOWN

    # =================================================================
    # Persistence
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
        bars: List[Bar] = []
        for i, r in enumerate(rows):
            if not r.get("close") or not r.get("volume"):
                continue
            bars.append(Bar(
                idx=i,
                date=r["date"],
                open=float(r["open"] or 0),
                high=float(r["high"] or 0),
                low=float(r["low"] or 0),
                close=float(r["close"] or 0),
                volume=int(r["volume"] or 0),
            ))
        # Re-index to be contiguous after potential filtering
        for i, b in enumerate(bars):
            b.idx = i
        return bars

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

    def _upsert_events(self, ticker: str, events: List[WyckoffEvent]) -> None:
        """DELETE v2-tagged events for ticker, INSERT new ones, denorm latest."""
        # Delete only v2 rows; leave v1 rows untouched.
        try:
            client = get_client()
            (client.table("wyckoff_events")
                   .delete()
                   .eq("ticker", ticker)
                   .eq("detection_version", "2.0")
                   .execute())
        except Exception:
            logger.debug("%s [v2]: delete-by-version failed (likely empty)", ticker)

        if events:
            rows = [{
                "ticker": e.ticker,
                "event_type": e.event_type,
                "event_date": e.event_date,
                "price": e.price,
                "volume": e.volume,
                "volume_z": None,    # v2 stores context in notes; vol_z not needed in row
                "range_z": None,
                "confidence": e.confidence,
                "inferred_phase": e.inferred_phase,
                "notes": (
                    (e.notes or "") + f" [fsm_phase={e.fsm_phase}]"
                ).strip(),
                "detection_version": "2.0",
                "detected_at": datetime.now(timezone.utc).isoformat(),
            } for e in events]
            try:
                bulk_upsert(
                    "wyckoff_events", rows,
                    on_conflict="ticker,event_date,event_type,detection_version",
                )
            except Exception as exc:
                msg = str(exc)
                if "wyckoff_events_event_type_check" in msg:
                    logger.error(
                        "%s [v2]: upsert blocked by stale CHECK constraint. "
                        "Apply docs/schema-wyckoff-event-types-current.sql in "
                        "Supabase SQL editor to enable distr_failed/accum_failed.",
                        ticker,
                    )
                raise

        # Denormalize latest event + final FSM phase to stocks (v2 columns)
        latest = events[-1] if events else None
        update_payload = {
            "current_wyckoff_event_v2":      latest.event_type if latest else None,
            "current_wyckoff_event_date_v2": latest.event_date if latest else None,
            "current_wyckoff_phase_v2":      latest.inferred_phase if latest else None,
            "current_wyckoff_confidence_v2": latest.confidence if latest else None,
            "current_wyckoff_fsm_phase_v2":  self.state.phase.value,
        }
        try:
            get_client().table("stocks").update(update_payload).eq("ticker", ticker).execute()
        except Exception:
            logger.debug("%s [v2]: stocks denorm update failed", ticker)
