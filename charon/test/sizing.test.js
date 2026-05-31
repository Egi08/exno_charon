// Regression tests for confidence-weighted position sizing.
//
// Locks two bug classes that previously made Charon "take risky" entries:
//
//   BUG (gate fallback): confidenceTier(c) called with no 2nd arg used
//     `Number.isFinite(Number(null))` === Number.isFinite(0) === true, so it
//     treated the no-arg call as an explicit override of gate=0. Every BUY then
//     landed VERY_HIGH (2x) and marginal entries got MAX size — the opposite of
//     confidence-weighted sizing. Fix: null/undefined/non-finite → fall back to
//     the live llm_min_confidence gate; only a finite number overrides.
//
//   INVARIANT: sizing tiers are RELATIVE to the entry gate, so a marginal BUY
//     (just over the gate) can never be sized larger than a high-conviction BUY.
//
// Run: npm test   (uses node:test, no devDependencies)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { confidenceTier, effectivePositionSize } from '../src/execution/sizing.js';
import { numSetting } from '../src/db/settings.js';

const LIVE_GATE = numSetting('llm_min_confidence', 65);

test('no-arg fallback uses the live entry gate, never 0', () => {
  const t = confidenceTier(70);
  assert.equal(t.gate, LIVE_GATE, 'gate must fall back to live llm_min_confidence');
  assert.notEqual(t.gate, 0, 'REGRESSION: gate fell back to 0 (the bug)');
});

test('undefined 2nd arg also falls back to the live gate', () => {
  const t = confidenceTier(70, undefined);
  assert.equal(t.gate, LIVE_GATE);
});

test('an explicit finite gate overrides the live setting', () => {
  assert.equal(confidenceTier(80, 75).gate, 75);
  assert.equal(confidenceTier(80, 0).gate, 0, 'an explicit 0 is still allowed as an override');
});

test('tiers are relative to the gate (deterministic with explicit gate=65)', () => {
  const g = 65;
  assert.deepEqual(pick(confidenceTier(60, g)), { tier: 'SKIP', multiplier: 0 });
  assert.deepEqual(pick(confidenceTier(64, g)), { tier: 'SKIP', multiplier: 0 });
  assert.deepEqual(pick(confidenceTier(65, g)), { tier: 'LOW', multiplier: 0.5 });
  assert.deepEqual(pick(confidenceTier(69, g)), { tier: 'LOW', multiplier: 0.5 });
  assert.deepEqual(pick(confidenceTier(70, g)), { tier: 'MID', multiplier: 1.0 });
  assert.deepEqual(pick(confidenceTier(74, g)), { tier: 'MID', multiplier: 1.0 });
  assert.deepEqual(pick(confidenceTier(75, g)), { tier: 'HIGH', multiplier: 1.5 });
  assert.deepEqual(pick(confidenceTier(84, g)), { tier: 'HIGH', multiplier: 1.5 });
  assert.deepEqual(pick(confidenceTier(85, g)), { tier: 'VERY_HIGH', multiplier: 2.0 });
});

test('CORE INVARIANT: a marginal BUY is never sized larger than a high-conviction BUY', () => {
  // This is the user-facing guarantee: "tanpa ngambil riskan".
  const marginal = confidenceTier(LIVE_GATE + 1).multiplier;     // just over the line
  const strong = confidenceTier(LIVE_GATE + 25).multiplier;      // way over
  assert.ok(marginal < strong, `marginal ${marginal}x must be < strong ${strong}x`);
  assert.ok(marginal <= 0.5, `marginal BUY must be <= 0.5x, got ${marginal}x`);
});

test('effectivePositionSize: marginal < strong, and sub-gate is 0', () => {
  const marginal = effectivePositionSize({ confidence: LIVE_GATE + 1 });
  const strong = effectivePositionSize({ confidence: LIVE_GATE + 25 });
  const below = effectivePositionSize({ confidence: LIVE_GATE - 5 });
  assert.equal(below.sizeSol, 0, 'below the gate must size to 0');
  assert.ok(marginal.sizeSol > 0, 'marginal must still open (just small)');
  assert.ok(
    marginal.sizeSol < strong.sizeSol,
    `marginal ${marginal.sizeSol} SOL must be < strong ${strong.sizeSol} SOL`
  );
});

function pick({ tier, multiplier }) {
  return { tier, multiplier };
}
