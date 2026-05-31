// ANTI-DRIFT guard: reads the ACTUAL live strategy config from the DB and asserts the exit
// invariants against it. This is the real single-source-of-truth check — exitLadder.test.js uses
// a hardcoded snapshot for pure math, but THIS test fails loudly if the live config_json ever
// drifts away from the agreed strategy (e.g. a config clobber wipes the ladder, or someone sets a
// profit-capping ladder, or the breakeven floor gets misconfigured above its arm).
//
// Bug class locked: "two sources of truth" — a hardcoded test that passes while the live config is
// broken. Here the assertions run against the live config itself, so they cannot lie.
//
// Run: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activeStrategy } from '../src/db/settings.js';
import { validateLadder, runnerRemaining, trailingArmThreshold } from '../src/execution/exitLadder.js';

const s = activeStrategy();

test('LIVE CONFIG: loads with the full key set (not a clobbered 2-key stub)', () => {
  // The config-clobber regression left only {max_hold_ms, max_hold_min_pnl_percent}. A healthy
  // config has the full exit + rug-floor set. Guard a generous lower bound.
  assert.ok(Object.keys(s).length >= 20,
    `REGRESSION (config clobber): only ${Object.keys(s).length} keys — exits/floors were wiped`);
});

test('LIVE CONFIG: ladder is valid and leaves an uncapped runner', () => {
  const stages = s.partial_tp_stages;
  assert.ok(Array.isArray(stages) && stages.length > 0, 'partial_tp_stages must be configured');
  const v = validateLadder(stages);
  assert.equal(v.ok, true, `invalid ladder: ${v.issues.join('; ')}`);
  assert.ok(runnerRemaining(stages) > 0, 'REGRESSION: no runner = profit capped (violates uncapped-runner)');
});

test('LIVE CONFIG: breakeven floor is armed and sane (arm>0, floor<arm)', () => {
  const arm = Number(s.breakeven_arm_percent ?? trailingArmThreshold(s.partial_tp_stages));
  const floor = Number(s.breakeven_floor_percent ?? 2);
  assert.ok(arm > 0, 'breakeven_arm_percent must be > 0 so the floor arms (jangan sampai minus lagi)');
  assert.ok(floor < arm, `breakeven_floor_percent (${floor}) must be below arm (${arm})`);
  assert.ok(floor >= 0, 'floor should be >= 0 so a position that touched the arm never closes red');
});

test('LIVE CONFIG: breakeven arm aligns with the first de-risk rung (consistency)', () => {
  // We want the floor to arm at the same point the first partial banks, so a token that touches
  // +15% both de-risks AND earns its break-even floor. Not strictly required, but a mismatch is
  // almost always a mistake — flag it.
  const firstStage = trailingArmThreshold(s.partial_tp_stages);
  assert.equal(Number(s.breakeven_arm_percent), firstStage,
    `breakeven_arm_percent (${s.breakeven_arm_percent}) should match first ladder rung (${firstStage})`);
});

test('LIVE CONFIG: SL/TP signs are correct and rug floors are present', () => {
  assert.ok(Number(s.sl_percent) < 0, 'sl_percent must be negative');
  assert.ok(Number(s.tp_percent) > 0, 'tp_percent must be positive');
  // Rug floors that the clobber had wiped — ensure they came back.
  assert.ok(Number(s.min_mcap_usd) > 0, 'min_mcap_usd floor missing (rug protection)');
  assert.ok(Number(s.max_mcap_usd) > Number(s.min_mcap_usd), 'max_mcap_usd must exceed min');
  assert.ok(Number(s.min_holders) > 0, 'min_holders floor missing (rug protection)');
  assert.ok(Number(s.max_top20_holder_percent) > 0 && Number(s.max_top20_holder_percent) <= 100,
    'max_top20_holder_percent floor missing/invalid (whale protection)');
});
