// Regression tests for the exit-ladder invariants.
//
// Locks bug classes that violated "tidak ada batasan untuk cuan" / "jangan sampai minus lagi":
//   1. Profit cap — a ladder selling 100% leaves no runner (old 33/33/34 sold out at +50%).
//   2. Runner chop — trailing armed at a hardcoded +15% while first de-risk moved up
//      shook the runner out before any profit was locked.
//   3. Green→red round-trip — a token that touched +15% closing NEGATIVE because the wide
//      trailing band dragged a low peak below entry (DOGEUS, bowie, UCL). breakevenFloorHit guards it.
//
// Run: npm test
//
// NOTE: the LIVE constant below is a SNAPSHOT for the pure-math tests. The TRUE anti-drift guard
// is configInvariants.test.js, which reads the ACTUAL strategies.config_json from the DB and
// asserts the same invariants — so the live config can never silently diverge from intent.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  trailingArmThreshold,
  totalLadderSell,
  runnerRemaining,
  validateLadder,
  breakevenFloorHit,
  effectiveExitParams,
} from '../src/execution/exitLadder.js';

// Mirror of the live ladder for pure-math assertions (keep in sync with strategies.config_json;
// configInvariants.test.js enforces the real one).
const LIVE = [
  { at: 15, sell: 20 },
  { at: 40, sell: 20 },
  { at: 90, sell: 20 },
  { at: 180, sell: 15 },
];

test('CORE: live ladder leaves an uncapped runner (>0% rides)', () => {
  assert.equal(totalLadderSell(LIVE), 75);
  assert.equal(runnerRemaining(LIVE), 25, 'runner must be 25% — the uncapped upside');
  assert.ok(runnerRemaining(LIVE) > 0, 'REGRESSION: no runner = profit capped');
});

test('CORE: a 100%-sell ladder is rejected (the old +50% cap bug)', () => {
  const capped = [{ at: 8, sell: 33 }, { at: 20, sell: 33 }, { at: 50, sell: 34 }];
  const v = validateLadder(capped);
  assert.equal(v.ok, false);
  assert.ok(v.issues.some(i => i.includes('no runner')), 'must flag the capped-profit ladder');
  assert.equal(runnerRemaining(capped), 0);
});

test('FIX_RUNNER_CHOP: trailing arms at the first de-risk, not a hardcoded 15', () => {
  assert.equal(trailingArmThreshold(LIVE), 15, 'must arm at the first stage (+15%)');
});

test('trailingArmThreshold falls back to 15 when no stages (legacy single-trail)', () => {
  assert.equal(trailingArmThreshold([]), 15);
  assert.equal(trailingArmThreshold(null), 15);
  assert.equal(trailingArmThreshold(undefined, 15), 15);
});

test('validateLadder: ascending thresholds + sell bounds', () => {
  assert.equal(validateLadder(LIVE).ok, true);
  assert.equal(validateLadder([{ at: 80, sell: 25 }, { at: 30, sell: 25 }]).ok, false); // not ascending
  assert.equal(validateLadder([{ at: 30, sell: 0 }]).ok, false);   // sell out of range
  assert.equal(validateLadder([{ at: 30, sell: 120 }]).ok, false); // sell > 100
});

test('empty ladder is valid (single TP/trailing governs instead)', () => {
  const v = validateLadder([]);
  assert.equal(v.ok, true);
  assert.equal(v.runner, 100);
});

// ---- BREAKEVEN FLOOR ("kalo sudah nyentuh +15%, jangan sampai minus lagi") ----

test('BREAKEVEN: a token that never reached +15% has NO floor (SL still governs)', () => {
  // peaked only +10%, now at -8% → breakeven must NOT fire (it never armed). SL handles it.
  assert.equal(breakevenFloorHit({ highWaterPnlPercent: 10, pnlPercent: -8 }), false);
});

test('BREAKEVEN: DOGEUS round-trip is now CUT at the floor, not left to go red', () => {
  // peaked +24.9%, retraced toward entry — once pnl hits +2% floor we exit GREEN.
  assert.equal(breakevenFloorHit({ highWaterPnlPercent: 24.9, pnlPercent: 2 }), true);
  assert.equal(breakevenFloorHit({ highWaterPnlPercent: 24.9, pnlPercent: -0.9 }), true,
    'a token that touched +15% must never be allowed to close negative');
});

test('BREAKEVEN: a still-green runner above the floor is NEVER touched (uncapped)', () => {
  // peaked +174% (PACKS-style), currently +113% — way above floor → ride, do not cut.
  assert.equal(breakevenFloorHit({ highWaterPnlPercent: 174.8, pnlPercent: 113.1 }), false);
  // armed but holding at +20% → still above floor → ride.
  assert.equal(breakevenFloorHit({ highWaterPnlPercent: 30, pnlPercent: 20 }), false);
});

test('BREAKEVEN: exactly at the +2% floor fires (<= floor)', () => {
  assert.equal(breakevenFloorHit({ highWaterPnlPercent: 16, pnlPercent: 2 }), true);
  assert.equal(breakevenFloorHit({ highWaterPnlPercent: 16, pnlPercent: 2.1 }), false);
});

test('BREAKEVEN: arm/floor are tunable; arm<=0 disables the floor entirely', () => {
  assert.equal(breakevenFloorHit({ highWaterPnlPercent: 50, pnlPercent: 1, armPercent: 0 }), false);
  // custom arm +30, floor +5
  assert.equal(breakevenFloorHit({ highWaterPnlPercent: 29, pnlPercent: 5, armPercent: 30, floorPercent: 5 }), false,
    'peak below custom arm → not armed');
  assert.equal(breakevenFloorHit({ highWaterPnlPercent: 31, pnlPercent: 5, armPercent: 30, floorPercent: 5 }), true);
});

// ---- FIX_CONFIG_PROPAGATION: effectiveExitParams (split-brain: live config vs frozen snapshot) ----

const LIVE_STRAT = { tp_percent: 200, sl_percent: -20, trailing_percent: 15, trailing_enabled: true };

test('CONFIG_PROP: a non-overridden open position FOLLOWS live config, not its frozen snapshot', () => {
  // position was opened under the OLD clobbered config (50/-25/20) — the exact DOGEUS #22 case.
  const pos = { tp_percent: 50, sl_percent: -25, trailing_percent: 20, trailing_enabled: 1, exit_overridden: 0 };
  const ep = effectiveExitParams(pos, LIVE_STRAT);
  assert.equal(ep.overridden, false);
  assert.equal(ep.tpPercent, 200, 'must use LIVE tp, not the frozen 50');
  assert.equal(ep.slPercent, -20, 'must use LIVE sl, not the frozen -25');
  assert.equal(ep.trailingPercent, 15, 'must use LIVE trailing, not the frozen 20');
  assert.equal(ep.trailingEnabled, 1);
});

test('CONFIG_PROP: a manually-overridden position PINS its snapshot (user choice wins)', () => {
  const pos = { tp_percent: 75, sl_percent: -10, trailing_percent: 25, trailing_enabled: 1, exit_overridden: 1 };
  const ep = effectiveExitParams(pos, LIVE_STRAT);
  assert.equal(ep.overridden, true);
  assert.equal(ep.tpPercent, 75, 'manual override must win over live config');
  assert.equal(ep.slPercent, -10);
  assert.equal(ep.trailingPercent, 25);
});

test('CONFIG_PROP: live trailing_enabled=false propagates (turns trailing off on open positions)', () => {
  const pos = { tp_percent: 50, sl_percent: -25, trailing_percent: 20, trailing_enabled: 1, exit_overridden: 0 };
  const ep = effectiveExitParams(pos, { ...LIVE_STRAT, trailing_enabled: false });
  assert.equal(ep.trailingEnabled, 0, 'live config can disable trailing on an already-open position');
});

test('CONFIG_PROP: degrades safely when strat is null/missing keys (falls back to snapshot)', () => {
  const pos = { tp_percent: 50, sl_percent: -25, trailing_percent: 20, trailing_enabled: 1, exit_overridden: 0 };
  const ep = effectiveExitParams(pos, null);
  assert.equal(ep.tpPercent, 50, 'no live config → use the snapshot, never NaN');
  assert.equal(ep.slPercent, -25);
  assert.equal(ep.trailingPercent, 20);
});
