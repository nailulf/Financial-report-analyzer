# Wyckoff Phase Detector v2 — Candidate/Confirmation Spec

A specification for an AI agent to implement. Designed to fix the failures of the v1 algorithm observed on DEWA, where every climactic bar in a strong markup was misclassified as a Buying Climax.

## Design philosophy

**Detection without invalidation is the original sin.** v1 committed to a phase on the first matching bar; it had no way to say "I was wrong" except via timeout. v2 separates *candidate* (this bar might be a BC) from *confirmation* (the next 10 bars proved it).

Three operating principles:

1. **No state transitions on raw bars.** Bars produce candidates; only confirmed candidates produce state transitions.
2. **Every candidate carries explicit invalidation rules.** A BC candidate is killed the moment price closes above the BC bar's high. No ambiguity.
3. **Asymmetric lockout: confirmed vs invalidated.** A *confirmed* climax locks out new climax candidates of the same type for a long window (the trend is over). An *invalidated* candidate locks out only briefly — just long enough to avoid retriggering on the same climax cluster, since invalidation is the algorithm correctly saying "that wasn't it." This kills both the "three BCs in a single markup" failure and the "missed real BC because of an earlier false candidate" failure.

4. **Honest no-call is allowed.** If a markup ends via slow rollover with no climactic up bar (which is what DEWA actually did at its top), the algorithm should NOT manufacture a BC. Phase transitions out of markup can also occur via sustained slope reversal — see "Trend-driven transitions" below.

5. **Distributed events count.** Climaxes don't always come as single textbook bars. The algorithm recognizes three forms of climactic action: (a) single wide-spread, high-volume bar, (b) 3-bar climactic cluster, (c) sustained absorption regime over 15 bars where price stops trending despite cumulative heavy volume. Likewise, phase transitions can happen via discrete climax OR via basis-building/topping when neither shows. See `ABSORPTION_REGIME` and `BASIS_BUILDING` predicates and their associated transitions.

## Data structures

```
Bar:
  idx        : int
  open, high, low, close : float
  volume     : float
  
  derived:
    spread          = high - low
    close_position  = (close - low) / spread       # 0=at low, 1=at high
    is_up           = close > open

Candidate:
  type             : SC | BC | Spring | UTAD | SOS | SOW | LPS | LPSY
  trigger_bar_idx  : int
  trigger_price    : float
  raw_confidence   : float [0..1]
  confirm_window   : int            # bars to wait
  status           : PENDING | CONFIRMED | INVALIDATED | EXPIRED
  
  metadata:
    bar_high, bar_low, bar_close at trigger
    range_high, range_low at trigger (if applicable)

Event:
  type, trigger_bar_idx, confirmed_at_idx, final_confidence

State:
  phase                       : Phase enum
  phase_confidence            : float
  range_high, range_low       : float | null
  range_start_idx             : int | null
  pending_candidates          : List<Candidate>
  confirmed_events            : List<Event>
  
  # Lockout tracking (see Lockout policy section)
  last_confirmed_climax       : { type, idx } | null
  last_invalidated_climax     : { type, idx } | null
  
  # Trend-driven transition tracking
  trend_age                   : int             # bars in current trend direction
  bearish_slope_streak        : int             # for markup_exhaustion path
  bullish_slope_streak        : int             # for markdown_exhaustion path
```

## Rolling indicators (recomputed each bar)

```
atr20            = ATR over last 20 bars
vol_mean50       = mean of volume over last 50 bars
vol_std50        = stdev of volume over last 50 bars
vol_z(idx)       = (volume[idx] - vol_mean50) / vol_std50
spread_atr(idx)  = spread[idx] / atr20

trend_slope(idx, window) = 
  linear_regression_slope(closes over window) / atr20
  # ATR-normalized so it works across instruments
```

## Helper predicates

```
CLIMACTIC_DOWN_BAR(idx):
  spread_atr(idx)     > 1.5
  AND vol_z(idx)      > 1.3
  AND close_position(idx) < 0.4         # closed in lower half
  AND (bar.is_up == false OR prior 2 bars were down)

CLIMACTIC_UP_BAR(idx):
  spread_atr(idx)     > 1.5
  AND vol_z(idx)      > 1.3
  AND bar.is_up == true
  AND close_position(idx) > 0.4         # don't require weak close;
                                        # weakness proven by NEXT bars

CLIMACTIC_CLUSTER(idx, direction, lookback=3):
  # Catches gradual climaxes that single-bar tests miss
  sum(vol_z over last lookback bars) > 4.0
  AND net_price_move(direction) > 2 * atr20

ABSORPTION_REGIME(idx, direction, lookback=15):
  # "Distributed climax" — sustained heavy volume across many bars where
  # price stops trending and a new local extreme is reclaimed. Catches
  # cases where no single bar is wide-spread but aggregate volume is
  # clearly climactic.
  
  window = bars[idx - lookback + 1 .. idx]
  prior  = bars[idx - 2*lookback + 1 .. idx - lookback]
  
  # Volume must be cumulatively heavy AND broadly distributed
  pos_vol_z_sum   = sum(max(0, vol_z(b)) for b in window)
  high_vol_bars   = count(b in window where vol_z(b) > 1.0)
  if pos_vol_z_sum < 10.0:  return false
  if high_vol_bars < 4:     return false
  
  if direction == DOWN:
    extreme       = min(b.low for b in window)
    prior_extreme = min(b.low for b in prior)
    window_high   = max(b.high for b in window)
    
    # Must be a new low vs prior period (this is where stopping occurs)
    if extreme >= prior_extreme: return false
    # Must show recovery: close has reclaimed >=30% of window range from low
    if (close[idx] - extreme) / (window_high - extreme) < 0.30: return false
    return true
  
  if direction == UP:
    extreme       = max(b.high for b in window)
    prior_extreme = max(b.high for b in prior)
    window_low    = min(b.low for b in window)
    
    if extreme <= prior_extreme: return false
    # Reverse retracement: high made then sold off
    if (extreme - close[idx]) / (extreme - window_low) < 0.30: return false
    return true

BASIS_BUILDING(idx, direction, lookback=20):
  # Recognizes that a trend has ENDED on stopping action without producing
  # a discrete climax. Triggers DOWNTREND -> ACCUM_A or UPTREND -> DISTR_A
  # with lower confidence than climactic entry. Without this, soft
  # accumulation bottoms produce no events and downstream SOS/Spring
  # detection never has a phase to fire from.
  
  window      = bars[idx - lookback + 1 .. idx]
  early_third = bars[idx - lookback + 1 .. idx - 2*lookback/3]
  late_third  = bars[idx - lookback/3 + 1 .. idx]
  
  # Range must be contained
  window_range = max(b.high) - min(b.low) over window
  if window_range > 5 * atr20: return false
  
  # Volume not dead (some interest, not vacuum)
  avg_vol_z = mean(vol_z(b) for b in window)
  if avg_vol_z < -1.0: return false
  
  if direction == DOWN:  # bottom basis after downtrend
    # Prior trend was meaningfully bearish
    if trend_slope(idx - lookback, 30) > -0.05: return false
    # Closes in last third haven't broken below early-third lows
    early_low = min(b.low for b in early_third)
    if any(b.close < early_low for b in late_third): return false
    return true
  
  if direction == UP:  # top basis after uptrend
    if trend_slope(idx - lookback, 30) < +0.05: return false
    early_high = max(b.high for b in early_third)
    if any(b.close > early_high for b in late_third): return false
    return true

WIDE_UP_BAR(idx):
  spread_atr(idx) > 1.5 AND bar.is_up AND close_position > 0.6

WIDE_DOWN_BAR(idx):
  spread_atr(idx) > 1.5 AND not bar.is_up AND close_position < 0.4

NO_SUPPLY_BAR(idx):
  spread_atr(idx) < 0.7 AND vol_z(idx) < -0.5

NO_DEMAND_BAR(idx):
  spread_atr(idx) < 0.7 AND vol_z(idx) < -0.5 AND not bar.is_up

RETRACEMENT(from_idx, to_idx, reference_range):
  # How much of the reference range was retraced between two bars
  abs(close[to_idx] - close[from_idx]) / reference_range
```

## Lockout policy

The lockout determines whether a new climax candidate (SC or BC) can be created given recent history. The key insight: **invalidation is the algorithm correctly rejecting a candidate, so it should not penalize future detection as harshly as a confirmation does.**

```
State additions:
  last_confirmed_climax  : { type, idx } | null   # SC or BC that was confirmed
  last_invalidated_climax: { type, idx } | null   # SC or BC candidate that was killed

Constants:
  HARD_LOCKOUT_BARS = 80     # after a CONFIRMED climax of same type
  SOFT_LOCKOUT_BARS = 20     # after an INVALIDATED candidate of same type

climax_lockout_clear(climax_type, current_idx):
  # Hard lockout: a confirmed climax means the trend is presumed over;
  # don't look for another climax of the same type for a long time.
  if last_confirmed_climax exists AND last_confirmed_climax.type == climax_type:
    if current_idx - last_confirmed_climax.idx < HARD_LOCKOUT_BARS:
      return false
  
  # Soft lockout: an invalidated candidate often comes from a multi-bar
  # climactic cluster. Block re-triggering on the same cluster, but
  # allow re-triggering on the next genuinely separate climax.
  if last_invalidated_climax exists AND last_invalidated_climax.type == climax_type:
    if current_idx - last_invalidated_climax.idx < SOFT_LOCKOUT_BARS:
      return false
  
  return true

# Maintenance: update these fields in update_candidate()
on candidate CONFIRMED:
  last_confirmed_climax = { type: c.type, idx: c.trigger_bar_idx }

on candidate INVALIDATED:
  last_invalidated_climax = { type: c.type, idx: c.trigger_bar_idx }
```

**Why asymmetric.** A confirmed BC means the algorithm believes a real top has formed; calling another BC 30 bars later in the same trend would contradict itself. An invalidated BC means the algorithm tried a hypothesis and discarded it; this is *evidence the algorithm is working correctly*, and should not block future detection. The 20-bar soft lockout exists only to prevent retriggering on the same multi-bar climax cluster (e.g., a 3-bar blow-off where each bar individually qualifies).

## Trend-driven transitions

Not every cycle ends with a textbook climax. DEWA's parabolic top in early 2026 rolled over without a clean BC — distribution began via slope reversal and persistent lower highs, not via a high-volume blow-off bar. The algorithm must handle this honestly rather than manufacturing a phantom BC.

```
While state.phase in {MARKUP, UPTREND}:
  # Track sustained slope reversal as alternative path out of markup
  if trend_slope(idx, 20) < -0.02:
    state.bearish_slope_streak += 1
  else:
    state.bearish_slope_streak = 0
  
  # If slope persists negative for 15+ bars AND price has retraced
  # at least 30% of the prior markup range, exit markup directly
  if state.bearish_slope_streak >= 15:
    markup_high = max(highs in last 60 bars)
    markup_low = min(lows in last 60 bars before peak)
    current_drop = (markup_high - close[idx]) / (markup_high - markup_low)
    if current_drop > 0.30:
      state.phase = MARKDOWN
      emit_event(type="markup_exhaustion", confidence=0.6)
      # Do NOT retroactively label a BC; the top simply rolled over.

# Mirror logic for {MARKDOWN, DOWNTREND} -> direct accumulation
```

This gives the algorithm two valid exits from each trending phase: the canonical climax-driven path (BC → DISTR_A → ...) and the slow-rollover path (markup_exhaustion → MARKDOWN). The latter emits a lower-confidence event so the consumer knows the transition was inferred from trend behavior, not a discrete signal.

## Basis-building transitions (soft phase A)

The mirror problem of "markup with no BC" is "downtrend with no SC." Some accumulation bottoms form gradually, with sellers exhausting in a sideways grind rather than a panic flush. AVIA's October 2025 bottom is a clean example: closes stopped making new lows around 9-19, but no single bar showed a textbook SC. Without recognizing this, downstream Spring/SOS detection has no phase to fire from.

```
While state.phase in {DOWNTREND, MARKDOWN}:
  if BASIS_BUILDING(idx, DOWN):
    state.phase = ACCUM_A
    emit_event(type="basis_building", confidence=0.5)
    state.range_high = max(b.high for b in last 20 bars)
    state.range_low  = min(b.low  for b in last 20 bars)
    state.range_start_idx = idx - 20
    # No SC stored — there wasn't one. Spring detection still works
    # because it needs range_low, not sc_low.

While state.phase in {UPTREND, MARKUP}:
  if BASIS_BUILDING(idx, UP):
    state.phase = DISTR_A
    emit_event(type="topping_action", confidence=0.5)
    state.range_high = max(b.high for b in last 20 bars)
    state.range_low  = min(b.low  for b in last 20 bars)
    state.range_start_idx = idx - 20
```

**Confidence is intentionally lower (0.5) than climactic events (0.7-0.85).** Soft entries should propagate uncertainty downstream — a Spring confirmed in a basis-building accumulation deserves more skepticism than a Spring after a textbook SC.

**Priority ordering when scanning:** climactic candidates fire first; basis-building only fires if no climax candidate has fired or is pending. This prevents double-counting when both predicates would trigger near the same bar.

## Main loop

```
process_bar(bar):
  state.bars.append(bar)
  idx = bar.idx
  
  if idx < WARMUP_BARS (50):
    return
  
  # 1. Update rolling indicators (cached on bar object)
  update_indicators(idx)
  
  # 2. Update existing candidates (confirm / invalidate / age out)
  for c in copy(state.pending_candidates):
    update_candidate(c, idx)
  
  # 3. Scan for new candidates appropriate to current phase
  scan_for_candidates(idx)
  
  # 4. Update trend tracking
  update_trend_tracking(idx)
  
  # 5. Output current state
  return {
    phase: state.phase,
    phase_confidence: state.phase_confidence,
    pending: state.pending_candidates,
    new_events: events confirmed on this bar
  }
```

## Candidate lifecycle

```
update_candidate(c, current_idx):
  
  # First check invalidation — fast-path kills are critical
  for cond in c.invalidation_conditions:
    if cond.evaluate(state, current_idx):
      c.status = INVALIDATED
      log_invalidation(c, cond.reason)
      remove c from pending_candidates
      # IMPORTANT: do NOT emit event, do NOT transition state
      return
  
  # Then check confirmation
  if all c.confirmation_conditions are satisfied:
    c.status = CONFIRMED
    emit_event(c)
    apply_phase_transition(c)
    remove c from pending_candidates
    return
  
  # Then check expiry
  if (current_idx - c.trigger_bar_idx) > c.confirm_window:
    c.status = EXPIRED
    log_expiry(c)
    remove c from pending_candidates
    return
  
  # Else: candidate stays pending, age increments naturally
```

## Candidate definitions

Each candidate is defined by: (a) a *trigger condition* that creates it, (b) *invalidation conditions* (ANY-match kills it), (c) *confirmation conditions* (ALL-match confirms it), (d) a *confirmation window*.

### SC — Selling Climax

```
TRIGGER:
  state.phase in {UNKNOWN, DOWNTREND}
  AND trend_slope(idx, 50) < -0.05
  AND state.trend_age > 30
  AND ( CLIMACTIC_DOWN_BAR(idx)
        OR CLIMACTIC_CLUSTER(idx, DOWN, 3)
        OR ABSORPTION_REGIME(idx, DOWN) )    # third path: distributed capitulation
  AND no SC candidate currently pending
  AND climax_lockout_clear(SC, idx)             # see Lockout policy

RAW CONFIDENCE:
  base 0.5
  + 0.2 * min(1, vol_z / 3)
  + 0.15 * min(1, spread_atr / 3)
  + 0.15 * min(1, (1 - close_position) / 0.5)   # closing off lows is good

CONFIRM_WINDOW: 15 bars

INVALIDATION (any kills):
  - close[k] < trigger_low * 0.95 for any k in window AND vol_z(k) > 1.5
    # New low on rising volume = real breakdown, not climax
  - 3 consecutive closes below trigger_low

CONFIRMATION (all required):
  - Within window, exists bar k with WIDE_UP_BAR(k)
    AND high[k] - trigger_low > 0.30 * (trigger_high - trigger_low)
    AND vol_z(k) > 0.5                          # AR has meaningful volume
  - That AR bar becomes the range_high pivot

ON CONFIRM:
  state.phase = ACCUM_A
  state.range_high = high of confirming AR bar
  store sc_low = trigger_low, sc_volume = trigger_volume
  state.last_confirmed_climax = { type: SC, idx: trigger_bar_idx }
```

### BC — Buying Climax (the critical fix)

```
TRIGGER:
  state.phase in {MARKUP, UPTREND}
  AND trend_slope(idx, 50) > +0.05
  AND state.trend_age > 40                      # stricter than SC; markups run longer
  AND no BC candidate currently pending
  AND climax_lockout_clear(BC, idx)             # see Lockout policy
  AND idx - state.range_start_idx > 60 (if previous range exists)
  AND ANY ONE of:
        - CLIMACTIC_UP_BAR(idx) AND vol_z(idx) > 1.5     # single-bar: stricter than SC
        - CLIMACTIC_CLUSTER(idx, UP, 3)                  # 3-bar cluster
        - ABSORPTION_REGIME(idx, UP)                     # slow distribution top

RAW CONFIDENCE:
  base 0.5
  + 0.15 * min(1, vol_z / 3)
  + 0.15 * min(1, spread_atr / 3)
  + 0.20 * min(1, state.trend_age / 100)        # confidence grows with trend length

CONFIRM_WINDOW: 10 bars

INVALIDATION (any kills) — these are the critical fixes:
  - close[k] > trigger_high for any k in window
    # ANY new high after the candidate = continuation, not BC
  - within first 5 bars: WIDE_UP_BAR(k) AND vol_z(k) > 1.5
    # Continuation thrust = invalidates
  - within window: trend_slope(k, 20) > +0.10
    # Local trend reasserts strongly

CONFIRMATION (all required):
  - Within window, exists bar k with WIDE_DOWN_BAR(k)
    AND trigger_high - low[k] > 0.30 * (trigger_high - trigger_low)
    AND vol_z(k) > 0.5
  - At least 50% of bars in window had high[k] < trigger_high
  - Average vol on down days > average vol on up days within window

ON CONFIRM:
  state.phase = DISTR_A
  state.range_low = low of confirming AR_down bar
  store bc_high = trigger_high, bc_volume = trigger_volume
  state.last_confirmed_climax = { type: BC, idx: trigger_bar_idx }
  CLEAR: range_high, range_low from prior accumulation
```

### Spring

```
TRIGGER:
  state.phase == ACCUM_B
  AND idx - state.range_start_idx > 15
  AND bar.low < state.range_low
  AND bar.close > state.range_low
  AND vol_z(idx) < 2.0                          # not climactic = not real breakdown

RAW CONFIDENCE:
  base 0.5
  + 0.20 * min(1, recovery_distance / atr20)
  - 0.15 * min(1, penetration_depth / atr20)    # deep poke = scary
  + 0.15 if vol_z > 0 else 0                    # some volume = absorption

CONFIRM_WINDOW: 8 bars

INVALIDATION (any kills):
  - 2 consecutive closes below trigger_low
  - any close below trigger_low with vol_z > 2.0     # real breakdown
  - any close below state.range_low * 0.95           # too far below

CONFIRMATION (any one suffices):
  - Test of spring: NO_SUPPLY_BAR(k) AND
    abs(low[k] - trigger_low) / atr20 < 0.3
  - WIDE_UP_BAR(k) AND close[k] > state.range_low + 0.5 * (range_high - range_low)

ON CONFIRM:
  state.phase = ACCUM_C
  store spring_idx = trigger_bar_idx, spring_low = trigger_low
```

### UTAD — Upthrust After Distribution (tightened)

```
TRIGGER:
  state.phase == DISTR_B
  AND idx - state.range_start_idx > 20          # distribution needs longer to mature
  AND bar.high > state.range_high
  AND bar.close < state.range_high              # closes back inside
  AND spread_atr(idx) > 1.0                     # FIXES "noise UTAD"
  AND vol_z(idx) > 0.5                          # FIXES "noise UTAD"
  AND (bar.high - state.range_high) / atr20 > 0.3   # meaningful penetration

CONFIRM_WINDOW: 8 bars

INVALIDATION:
  - any close > trigger_high * 1.01
  - WIDE_UP_BAR(k) with vol_z(k) > 1.5 within window

CONFIRMATION (any):
  - WIDE_DOWN_BAR(k) within 5 bars
  - 3 consecutive closes back inside the range

ON CONFIRM:
  state.phase = DISTR_C
  store utad_idx, utad_high
```

### SOS — Sign of Strength

```
TRIGGER:
  state.phase == ACCUM_C                        # only after Spring
  AND WIDE_UP_BAR(idx)
  AND bar.close > state.range_high
  AND vol_z(idx) > 0.8

CONFIRM_WINDOW: 5 bars

INVALIDATION:
  - close back below state.range_high within window

CONFIRMATION:
  - close stays above state.range_high for 3 consecutive bars
  - higher highs continue (at least one new high in window)

ON CONFIRM:
  state.phase = ACCUM_D
  store sos_idx
```

### LPS — Last Point of Support

```
TRIGGER:
  state.phase == ACCUM_D
  AND idx - sos_idx > 2 AND idx - sos_idx < 15
  AND state.range_high * 0.97 <= bar.low <= state.range_high * 1.03
  AND vol_z(idx) < 0                            # drying volume

CONFIRM_WINDOW: 3 bars

INVALIDATION:
  - close < state.range_high * 0.97

CONFIRMATION:
  - WIDE_UP_BAR within 3 bars
  - higher high than recent

ON CONFIRM:
  emit LPS event
  if subsequent 5 bars show sustained move: state.phase = MARKUP
```

### SOW (mirror of SOS), LPSY (mirror of LPS)

Apply the same logic with directions inverted. SOW is the wide-spread down bar that closes below `range_low` from `DISTR_C`; LPSY is the weak retest of broken support from `DISTR_D`.

## Phase transition map

```
Forward path (accumulation cycle):
  UNKNOWN/DOWNTREND ──[SC confirmed]──> ACCUM_A
  ACCUM_A           ──[ST holds after AR]──> ACCUM_B
  ACCUM_B           ──[Spring confirmed]──> ACCUM_C
  ACCUM_C           ──[SOS confirmed]──> ACCUM_D
  ACCUM_D           ──[LPS + sustained markup]──> MARKUP
  MARKUP            ──[5 consecutive higher highs OR 30 bars trending]──> UPTREND

Forward path (distribution cycle):
  MARKUP/UPTREND    ──[BC confirmed]──> DISTR_A
  DISTR_A           ──[ST_high after AR_down]──> DISTR_B
  DISTR_B           ──[UTAD confirmed]──> DISTR_C
  DISTR_C           ──[SOW confirmed]──> DISTR_D
  DISTR_D           ──[LPSY + sustained markdown]──> MARKDOWN
  MARKDOWN          ──[5 consecutive lower lows OR 30 bars trending]──> DOWNTREND

Failure / regression paths (the v1 algorithm lacked these):
  ACCUM_A   ──[SC invalidated by new low on volume]──> DOWNTREND, clear SC state
  ACCUM_C   ──[Spring invalidated]──> ACCUM_B (preserve range)
  DISTR_A   ──[BC invalidated by new high]──> UPTREND, clear BC state    ← KEY FIX
  DISTR_C   ──[UTAD invalidated]──> DISTR_B (preserve range)
  
Force-exit (range fails decisively):
  ACCUM_B   ──[strong breakout above range_high on volume]──> direct to MARKUP
                                                              (skip C/D — failed accum still works)
  DISTR_B   ──[strong breakdown below range_low on volume]──> direct to MARKDOWN
```

## Range maintenance

```
While state.phase in {ACCUM_B, DISTR_B}:
  every bar:
    if bar.high > state.range_high * 1.005:
      # range expanded upward — only allow if volume confirms
      if vol_z(idx) > 0.5:
        state.range_high = bar.high
    
    if bar.low < state.range_low * 0.995:
      if vol_z(idx) > 0.5:
        state.range_low = bar.low
  
  # Once Spring or UTAD fires, freeze the range
```

## Trend tracking

```
update_trend_tracking(idx):
  slope = trend_slope(idx, 20)
  
  if state.phase in {DOWNTREND, MARKDOWN}:
    if slope > +0.02 for 10 consecutive bars:
      # trend is potentially reversing — but don't transition yet
      reset state.trend_age (the next phase will need to earn it)
  
  if state.phase in {UPTREND, MARKUP}:
    if slope < -0.02 for 10 consecutive bars:
      reset state.trend_age
  
  state.trend_age += 1 if trend direction unchanged else 1 (start counting fresh)
```

## Phase confidence

```
phase_confidence is a float [0..1] reflecting how cleanly the algorithm
believes the current phase is established. Compute as:

  if state.phase in canonical_phases:
    confidence = average of confirmed_events_in_current_cycle.final_confidence
  
  if pending candidates exist that would cause regression:
    confidence *= 0.7
  
  if recent invalidations occurred:
    confidence *= 0.8
```

## Output per bar

```
{
  current_phase: Phase,
  phase_confidence: float,
  range: { high, low } | null,
  
  pending_candidates: [
    {
      type, trigger_bar_idx, trigger_price,
      raw_confidence, bars_remaining_in_window,
      what_would_confirm: human_readable,
      what_would_invalidate: human_readable
    }
  ],
  
  new_confirmed_events_this_bar: [...],
  new_invalidations_this_bar: [...],   # for transparency
  
  diagnostic_signals: {
    vol_z, spread_atr, trend_slope,
    bars_in_phase, last_confirmed_climax, last_invalidated_climax
  }
}
```

This output shape gives the consumer (UI, trader, downstream model) the *current belief* plus the *pipeline of pending hypotheses* — useful for early warning ("BC candidate forming, will confirm or invalidate in 8 bars") rather than only firm phase claims.

## Implementation notes for the agent

1. **Rolling indicators must be incremental.** Don't recompute ATR/vol stats from scratch each bar — maintain rolling buffers. For 1000+ bars on multiple instruments this matters.

2. **Candidates should be serializable.** Store them with bar timestamps so a partial trace can be reconstructed for debugging.

3. **All thresholds in a single config object.** No magic numbers in predicates. Tunables: `MIN_PHASE_B_BARS`, `CLIMAX_VOL_Z`, `CLIMAX_SPREAD_ATR`, `BC_MIN_TREND_AGE`, `HARD_LOCKOUT_BARS`, `SOFT_LOCKOUT_BARS`, `BEARISH_SLOPE_STREAK`, `ABSORPTION_LOOKBACK`, `ABSORPTION_VOL_Z_SUM`, `ABSORPTION_HIGH_VOL_BARS`, `BASIS_LOOKBACK`, `BASIS_RANGE_ATR_LIMIT`, etc. Defaults given above are starting points only.

4. **Event log must distinguish CONFIRMED vs INVALIDATED candidates.** When debugging on real data (like the DEWA trace), you want to see "BC candidate at 7-21 — invalidated at 7-23 by new high at 222." This is your lens into whether the algorithm is reasoning correctly.

5. **Test against the DEWA trace as a regression suite.** Full expected behavior on the DEWA July 2025 – April 2026 daily history is documented below in "Regression test: DEWA worked trace." A v2 implementation that produces three-plus confirmed BCs during the markup is broken; one is broken; zero is correct.

6. **The state machine is not symmetric.** Distributions take longer to form than accumulations (sellers liquidate gradually; buyers panic in a hurry). Don't share thresholds between SC and BC — BC is intentionally stricter.

7. **Don't over-engineer the "pending" output to users.** Surface only candidates that have meaningfully high raw_confidence (> 0.6). Low-quality pending candidates are noise.

## Regression test: DEWA worked trace

The DEWA daily chart (July 2025 – April 2026) is the canonical regression case. It contains:
- A parabolic markup from ~180 to ~815 with multiple climactic up bars that are NOT BCs
- A slow-rollover top with no clean climactic distribution event
- A persistent markdown that has not yet produced a clean SC

A correct v2 implementation must produce the lifecycle shown below. Bar dates and prices are taken from the actual DEWA per-bar trace.

### Phase 1: Markup with multiple invalidated BC candidates (July–early December 2025)

| Date | Price | vol_z | sprd/atr | Expected v2 behavior |
|---|---|---|---|---|
| 2025-07-21 | 214 | +3.28 | 3.55 | **BC candidate created** (raw_conf ~0.78). State stays `MARKUP`. trigger_high ≈ 215. |
| 2025-07-23 | 222 | +0.21 | 2.26 | close 222 > trigger_high 215 → **BC INVALIDATED**. Soft lockout to ~2025-08-19. |
| 2025-10-02 | 334 | +2.63 | 3.42 | Soft lockout cleared. **BC candidate created**. trigger_high ≈ 336. |
| 2025-10-07 | 354 | +2.23 | 3.62 | close 354 > trigger_high 336 → **BC INVALIDATED**. Soft lockout to ~2025-11-04. |
| 2025-11-11 | 446 | +9.70 | 3.10 | Soft lockout cleared. **BC candidate created**. trigger_high ≈ 450. |
| 2025-11-13 | 430 | +0.72 | 1.00 | No new high yet, candidate pending. |
| 2025-12-01 | 462 | +2.30 | 1.37 | close 462 > trigger_high 450 → **BC INVALIDATED**. Soft lockout to ~2025-12-29. |
| 2025-12-09 | 505 | +2.69 | 1.52 | Within soft lockout window → **trigger blocked**. No candidate. |

Result for this phase: **0 confirmed BCs.** The state remains `MARKUP` throughout, correctly. Each climactic up bar produces a candidate that gets killed by subsequent new highs.

### Phase 2: The actual top (late December 2025 – mid January 2026)

| Date | Price | vol_z | sprd/atr | Expected v2 behavior |
|---|---|---|---|---|
| 2025-12-29 | 690 | +2.24 | 2.60 | Soft lockout cleared. **BC candidate created**. trigger_high ≈ 700. |
| 2026-01-02 | 750 | +0.64 | 1.28 | close 750 > trigger_high 700 → **BC INVALIDATED**. Soft lockout to ~2026-01-30. |
| 2026-01-12 | 790 | +0.55 | 2.15 | vol_z below 1.5 threshold → **no BC trigger**. Soft lockout active anyway. |

Result: **0 confirmed BCs.** This is the correct outcome — DEWA's top did not have a single decisive climactic distribution bar. The 1-12 high of 815 was on modest volume.

### Phase 3: Markup exhaustion → markdown (late January – February 2026)

| Date | Price | trend_slope | Expected v2 behavior |
|---|---|---|---|
| 2026-01-22 onward | 665 declining | turning negative | bearish_slope_streak begins counting |
| 2026-02-09 | 500 | +0.057 | streak ≥ 15 bars, drop > 30% from 815 high → **markup_exhaustion event emitted** (confidence ~0.6). State transitions `MARKUP → MARKDOWN`. |

Result: phase exit happens via the trend-driven path, not via a manufactured BC. The event log honestly reflects "no clean distribution structure was observed."

### Phase 4: Markdown without clean SC (March – April 2026)

| Date | Price | vol_z | sprd/atr | Expected v2 behavior |
|---|---|---|---|---|
| 2026-03-25 | 460 | -0.24 | 1.67 | Volume below climactic threshold → no SC trigger |
| 2026-04-01 | 505 | +0.61 | 1.45 | Mild rally on weak volume → not climactic |
| 2026-04-10 | 515 | -0.16 | 0.81 | No SC candidate. State remains `DOWNTREND`. |

Result through end of trace: **0 confirmed SCs.** Algorithm output: "Downtrend continues; no climactic stopping action observed yet." Any tool that has flagged a Spring on this stock during this window is wrong by construction — Phase A has not completed.

### Summary expectations

| Metric | Required v2 result |
|---|---|
| Confirmed BCs in markup (Jul–Dec 2025) | 0 |
| Invalidated BC candidates in markup | 3–4 |
| Confirmed BCs at top (Dec 2025–Jan 2026) | 0 |
| markup_exhaustion event | exactly 1, around Feb 2026 |
| Confirmed SCs in markdown (Feb–Apr 2026) | 0 |
| Phase at end of trace (April 10) | DOWNTREND |
| Spring or Test events anywhere in trace | 0 |

If your implementation produces these counts (±1 invalidation), the v2 algorithm is structurally correct on this case. If you see confirmed BCs during the markup or a Spring during the markdown, debug by logging every candidate's full lifecycle (created → pending → invalidated/confirmed) and trace which invalidation rule failed to fire.

## Regression test: AVIA worked trace

The AVIA daily chart (July 2025 – April 2026) is the complementary regression case to DEWA. Where DEWA tests *false positive* avoidance (don't manufacture phantom BCs in a markup), AVIA tests *false negative* avoidance (don't miss real structure when it forms softly). It contains:

- A topping range in summer 2025 with no clean BC
- A soft accumulation bottom in Sept-Oct 2025 with no climactic SC
- A textbook SOS-equivalent breakout on 2025-11-05
- A markup to ~520 with no climactic top
- A distributed capitulation in April 2026 (sustained heavy volume, no single-bar SC)

This case stress-tests `BASIS_BUILDING` and `ABSORPTION_REGIME`. Without these predicates, v2 produces zero events on AVIA — which is what motivated their addition.

### Phase 1: Soft top + downtrend (July–September 2025)

| Date | Price | Expected v2 behavior |
|---|---|---|
| 2025-07-17 | 445 | vol_z=+2.38, sprd/atr=2.91. BC candidate may fire. |
| 2025-07-22 | 447 | close 447 > trigger_high → BC INVALIDATED. |
| Aug–Sep | sideways/declining | bearish_slope_streak grows from late August |
| 2025-09-25 | 392 | streak ≥ 15 bars, drop > 30% from 456 → markup_exhaustion event. State `MARKUP → MARKDOWN`. |

### Phase 2: Soft accumulation bottom (October 2025)

| Date | Price | Expected v2 behavior |
|---|---|---|
| 2025-10-06 onward | 392-417 range | Range contained, closes not breaking sub-392, slope still negative but flattening |
| ~2025-10-13 to 10-17 | ~410 | BASIS_BUILDING(DOWN) fires: 20-bar window shows contained range, no new lows in last third, prior trend bearish. **basis_building event emitted** (conf 0.5). State `DOWNTREND → ACCUM_A`. range_low ≈ 390, range_high ≈ 419. |
| Subsequent bars | sideways | State advances `ACCUM_A → ACCUM_B` once the range matures |

### Phase 3: Breakout SOS-equivalent (November 2025)

| Date | Price | Expected v2 behavior |
|---|---|---|
| 2025-11-05 | 447 | vol_z=+4.15, sprd/atr=3.22. Wide-spread up bar closing well above range_high (~419). State is ACCUM_B. **Range force-exit fires** (per spec: "ACCUM_B + strong breakout above range_high on volume → direct to MARKUP"). State `ACCUM_B → MARKUP`. Event: `range_breakout_up`. |
| 2025-11-06 | 456 | Followthrough. |

This is the event v1 missed entirely. With BASIS_BUILDING in place, the algorithm has a phase to break out from.

### Phase 4: Markup to peak (Nov 2025–Jan 2026)

| Date | Price | Expected v2 behavior |
|---|---|---|
| Nov–Jan | 447 → 520 | State `MARKUP → UPTREND` after sustained higher highs |
| 2026-01-02 | 520 | Peak. No climactic up bar (max vol_z ~+1.12). No BC candidate fires. |

### Phase 5: Markdown via slope reversal (Feb–March 2026)

| Date | Price | Expected v2 behavior |
|---|---|---|
| Feb onward | declining | bearish_slope_streak begins ~2-19 |
| ~2026-03-12 | 394 | streak ≥ 15 bars, drop ≈ 24% from 520. May not exceed 30% threshold immediately — `markup_exhaustion` may fire later, around 3-16 to 3-25. State `MARKUP → MARKDOWN`. |

### Phase 6: Distributed capitulation (April 2026)

| Date | Price | Expected v2 behavior |
|---|---|---|
| 04-01 to 04-22 | 366 → 392 | 13+ bars with vol_z > 1.0; cumulative pos_vol_z_sum ≈ 35; new low at 354 on 04-16; recovery to 392 by 04-22 |
| ~2026-04-22 | 392 | ABSORPTION_REGIME(DOWN) fires. **SC candidate created** (conf ~0.65, lower than single-bar SC). State stays MARKDOWN until AR confirms. |
| Following bars | TBD | If AR forms within 15 bars, SC confirmed, state → ACCUM_A |

### Summary expectations for AVIA

| Metric | Required v2 result |
|---|---|
| BC candidates in summer 2025 | 0–1 (invalidated if present) |
| markup_exhaustion events | exactly 2 (Sep 2025, Mar 2026) |
| basis_building events | exactly 1 (October 2025) |
| range_breakout events | exactly 1 (November 2025) |
| Confirmed SCs from absorption | 0–1 (April 2026, depending on confirmation window) |
| Phase at end of trace (April 28) | MARKDOWN or ACCUM_A |
| Spring or UTAD events anywhere | 0 |

The AVIA test case validates that the algorithm produces *some* events on every well-defined structural shift — even when the shifts are soft. A v2 implementation that produces zero events on AVIA (matching the v1 result that prompted this whole exercise) means BASIS_BUILDING or ABSORPTION_REGIME isn't firing correctly.

### Combined regression coverage

Together, DEWA and AVIA cover the four hard cases:

| | Climactic top | Soft top |
|---|---|---|
| **Climactic bottom** | (textbook — try TLKM 2020) | AVIA April 2026 (capitulation) |
| **Soft bottom** | AVIA Oct 2025 → Nov SOS | DEWA-style parabolic |

Adding a textbook climactic case as a third regression test would close the matrix.
