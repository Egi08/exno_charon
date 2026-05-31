import { test } from 'node:test';
import assert from 'node:assert';
import { drawdownScale, effectiveDrawdownScale, DRAWDOWN_MIN_SAMPLE_DEFAULT } from '../src/execution/drawdownGate.js';

// --- raw tiers ---
test('drawdownScale raw tiers', () => {
  assert.equal(drawdownScale(0).ddTier, 'NORMAL');
  assert.equal(drawdownScale(-5).ddScale, 1.0);
  assert.equal(drawdownScale(-15).ddTier, 'CAUTIOUS');
  assert.equal(drawdownScale(-15).ddScale, 0.75);
  assert.equal(drawdownScale(-25).ddTier, 'DEFENSIVE');
  assert.equal(drawdownScale(-25).ddScale, 0.5);
  assert.equal(drawdownScale(-40).ddTier, 'HALT');
  assert.equal(drawdownScale(-40).ddScale, 0);
});

// --- BUG GUARD: a lone loss must NOT shrink sizing (the Violence/PAYNE scenario) ---
test('single loss (n=1, -21%) is NOT scaled down — sample gated to NORMAL', () => {
  const r = effectiveDrawdownScale(-21, 1, 3);
  assert.equal(r.ddTier, 'NORMAL');
  assert.equal(r.ddScale, 1.0);
  assert.equal(r.sampleGated, true);
});

test('two losses (n=2, -25%) still sample gated to NORMAL', () => {
  const r = effectiveDrawdownScale(-25, 2, 3);
  assert.equal(r.ddScale, 1.0);
  assert.equal(r.sampleGated, true);
});

// --- sustained streak: scaling activates once sample threshold is met ---
test('n=3 at -21% activates DEFENSIVE (sustained streak = real signal)', () => {
  const r = effectiveDrawdownScale(-21, 3, 3);
  assert.equal(r.ddTier, 'DEFENSIVE');
  assert.equal(r.ddScale, 0.5);
  assert.equal(r.sampleGated, false);
});

test('n=4 at -15% activates CAUTIOUS', () => {
  const r = effectiveDrawdownScale(-15, 4, 3);
  assert.equal(r.ddTier, 'CAUTIOUS');
  assert.equal(r.ddScale, 0.75);
});

test('healthy pnl with enough sample stays NORMAL', () => {
  const r = effectiveDrawdownScale(-5, 10, 3);
  assert.equal(r.ddTier, 'NORMAL');
  assert.equal(r.sampleGated, false);
});

// --- HALT is a hard floor: never suppressed by small sample ---
test('catastrophic loss (-40%) HALTS even at n=1 (sample gate does NOT override HALT)', () => {
  const r = effectiveDrawdownScale(-40, 1, 3);
  assert.equal(r.ddTier, 'HALT');
  assert.equal(r.ddScale, 0);
  assert.equal(r.sampleGated, false);
});

// --- default sample param ---
test('default minSample is 3', () => {
  assert.equal(DRAWDOWN_MIN_SAMPLE_DEFAULT, 3);
  assert.equal(effectiveDrawdownScale(-25, 2).sampleGated, true);
  assert.equal(effectiveDrawdownScale(-25, 3).sampleGated, false);
});
