import { test } from 'node:test';
import assert from 'node:assert';
import { maxHoldExit } from '../src/execution/exitLadder.js';

const H = 3600000;
const base = { openedAtMs: 0, maxHoldMs: 6 * H, minPnlPercent: 15, stage: 0 };

test('does NOT fire before the hold window elapses', () => {
  assert.equal(maxHoldExit({ ...base, nowMs: 5 * H, pnlPercent: -5 }), false);
});

test('fires on flat/dead capital after the window (no partial, below floor)', () => {
  // position sat 7h, flat at +2%, never de-risked → free the capital
  assert.equal(maxHoldExit({ ...base, nowMs: 7 * H, pnlPercent: 2 }), true);
});

test('fires on a stale loser (recycle dead money)', () => {
  assert.equal(maxHoldExit({ ...base, nowMs: 7 * H, pnlPercent: -8 }), true);
});

test('NEVER clips a green runner above the floor (the BUG 9 guarantee)', () => {
  // +40% after 7h, no partial yet — must ride, not get clocked out
  assert.equal(maxHoldExit({ ...base, nowMs: 7 * H, pnlPercent: 40 }), false);
});

test('NEVER clips a position that already banked a partial (stage >= 1)', () => {
  // de-risked runner riding the remainder — clock must not touch it even if pnl dips below floor
  assert.equal(maxHoldExit({ ...base, nowMs: 9 * H, pnlPercent: 8, stage: 1 }), false);
});

test('exactly at the floor does not fire (>= floor is a runner)', () => {
  assert.equal(maxHoldExit({ ...base, nowMs: 7 * H, pnlPercent: 15 }), false);
});

test('just below the floor on dead time fires', () => {
  assert.equal(maxHoldExit({ ...base, nowMs: 7 * H, pnlPercent: 14.9 }), true);
});

test('disabled when maxHoldMs is 0/unset (never fires)', () => {
  assert.equal(maxHoldExit({ ...base, maxHoldMs: 0, nowMs: 100 * H, pnlPercent: -50 }), false);
  assert.equal(maxHoldExit({ ...base, maxHoldMs: null, nowMs: 100 * H, pnlPercent: -50 }), false);
});
