// Pure, zero-dependency exit-ladder helpers.
//
// Kept dependency-free ON PURPOSE so they can be unit-tested without booting the DB /
// Telegram / network import chain that positions.js pulls in. positions.js imports
// trailingArmThreshold() from here; tests import the validators.
//
// Bug classes these guard (both surfaced live):
//   1. Profit cap: partial_tp_stages summing to 100% sell → position fully closed at the
//      last stage (sold out at +50%), no runner → "tidak ada batasan untuk cuan" violated.
//   2. Runner chop: trailing armed at a hardcoded +15% while the first de-risk moved to +30%
//      → a normal climb-pullback stops the runner BEFORE any profit is locked.

// Pre-stage trailing arms once price reaches the FIRST de-risk threshold, so the runner is
// not shaken out before any profit is banked. Falls back to 15 when no stages are configured
// (preserves legacy single-trail behavior).
export function trailingArmThreshold(stages, fallback = 15) {
  if (Array.isArray(stages) && stages.length > 0 && Number.isFinite(Number(stages[0].at))) {
    return Number(stages[0].at);
  }
  return fallback;
}

// Total % of the position sold across all partial-TP stages.
export function totalLadderSell(stages) {
  if (!Array.isArray(stages)) return 0;
  return stages.reduce((sum, s) => sum + (Number(s?.sell) || 0), 0);
}

// Runner % left riding after all stages fire. > 0 means uncapped upside survives.
export function runnerRemaining(stages) {
  return 100 - totalLadderSell(stages);
}

// Validate a ladder: strictly-ascending thresholds, each sell in (0,100], and a runner remains.
// A ladder with no stages is valid (single trailing/TP exit governs instead).
export function validateLadder(stages) {
  const issues = [];
  if (!Array.isArray(stages) || stages.length === 0) {
    return { ok: true, runner: 100, issues };
  }
  let prev = -Infinity;
  stages.forEach((s, i) => {
    const at = Number(s?.at);
    const sell = Number(s?.sell);
    if (!Number.isFinite(at) || !Number.isFinite(sell)) issues.push(`stage ${i}: non-numeric at/sell`);
    if (at <= prev) issues.push(`stage ${i}: at=${at} not strictly ascending (prev ${prev})`);
    if (sell <= 0 || sell > 100) issues.push(`stage ${i}: sell=${sell} out of (0,100]`);
    prev = at;
  });
  const runner = runnerRemaining(stages);
  if (runner <= 0) {
    issues.push(`no runner remains (total sell ${totalLadderSell(stages)}% >= 100%) — profit is capped`);
  }
  return { ok: issues.length === 0, runner, issues };
}

// BUG 9 (profit cap via time): MAX_HOLD must be a STALE-CAPITAL timeout, never a profit cap.
// Force-closing a green/climbing position at a fixed hold time caps upside — directly violates
// the user's uncapped-runner philosophy ("tidak ada batasan untuk cuan"). A winner must exit
// only via tightening trailing or SL, NEVER the clock.
// Returns true (fire MAX_HOLD) ONLY when ALL hold:
//   - max_hold_ms configured (> 0) AND the hold time has elapsed
//   - the position has NOT de-risked yet (stage === 0 → no partial banked)
//   - the position is below the "green enough to be a runner" floor (pnl < minPnlPercent)
// i.e. it only frees capital tied up in a flat/dead/losing position, never clips a runner.
export function maxHoldExit({ openedAtMs, nowMs, maxHoldMs, pnlPercent, minPnlPercent = 15, stage = 0 }) {
  if (!(Number(maxHoldMs) > 0)) return false;
  if ((Number(nowMs) - Number(openedAtMs)) < Number(maxHoldMs)) return false;
  if (Number(stage) > 0) return false;            // already banked a partial → let the runner ride
  return Number(pnlPercent) < Number(minPnlPercent); // only clip flat/dead money, never a green runner
}

// BREAK-EVEN FLOOR ("kalo sudah nyentuh +15%, jangan sampai minus lagi"):
// Once a position has EVER touched the arm threshold (peak pnl >= armPercent, default +15%),
// it earns a hard floor at floorPercent (default +2% to absorb live slippage/fees so the
// realized exit stays NON-negative). If price retraces back down to that floor, exit NOW —
// don't wait for the wide trailing band to drag it into the red.
//
// Why this and not just trailing: trailing measures drop FROM PEAK. For a low peak (e.g. +20%)
// a 15-20% trailing band lands the exit BELOW entry (1.20 * 0.80 = -4%) — exactly the green→red
// round-trips we saw (DOGEUS, bowie, UCL). The break-even floor is an ABSOLUTE floor on pnl,
// so a token that touched +15% can never close negative regardless of how high the peak was.
//
// Does NOT cap upside: it only fires when pnl has already fallen back to floorPercent. A token
// that keeps climbing (or holds above the floor) is never touched — runner stays uncapped.
// Decoupled from armPercent==first ladder rung on purpose, but they share the +15% default so a
// position de-risks (stage 1) and arms its floor at the same moment.
//
// hasArmed: pass the high-water-mark pnl% (peak), NOT the current pnl. floorPercent MUST be < armPercent.
export function breakevenFloorHit({ highWaterPnlPercent, pnlPercent, armPercent = 15, floorPercent = 2 }) {
  if (!(Number(armPercent) > 0)) return false;                 // disabled when arm <= 0
  if (!(Number(highWaterPnlPercent) >= Number(armPercent))) return false; // never reached arm → no floor yet
  return Number(pnlPercent) <= Number(floorPercent);           // gave the gains back to the floor → cut here
}

// FIX_CONFIG_PROPAGATION (split-brain on one position): exit params used to be read from the
// per-position SNAPSHOT (tp_percent/sl_percent/trailing_percent), frozen at entry — so a strategy
// config change (or a clobber+restore) never reached already-open positions. Meanwhile the ladder
// and breakeven floor read the LIVE `strat`. Result: SL/TP/trailing on the SAME position disagreed
// with its ladder/breakeven — two sources of truth. This resolver makes the LIVE strategy config
// govern by default (a config change propagates to every open position next poll), while a MANUAL
// per-position override (exit_overridden=1, set when the user edits TP/SL/trailing via Telegram)
// still wins and pins the snapshot. Pure + DB-free for testability.
export function effectiveExitParams(position, strat) {
  const overridden = Number(position?.exit_overridden) === 1;
  const num = (a, b) => { const x = Number(a); return Number.isFinite(x) ? x : Number(b); };
  const tpPercent = overridden
    ? num(position?.tp_percent, strat?.tp_percent)
    : num(strat?.tp_percent, position?.tp_percent);
  const slPercent = overridden
    ? num(position?.sl_percent, strat?.sl_percent)
    : num(strat?.sl_percent, position?.sl_percent);
  const trailingPercent = overridden
    ? num(position?.trailing_percent, strat?.trailing_percent)
    : num(strat?.trailing_percent, num(position?.trailing_percent, 15));
  const teRaw = overridden
    ? position?.trailing_enabled
    : (strat?.trailing_enabled ?? position?.trailing_enabled);
  return { overridden, tpPercent, slPercent, trailingPercent, trailingEnabled: teRaw ? 1 : 0 };
}
