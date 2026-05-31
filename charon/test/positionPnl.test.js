import { test } from 'node:test';
import assert from 'node:assert';
import { positionPnlPercent, positionPeakPnlPercent } from '../src/telegram/format.js';

// Regression guard for FIX_PNL_STUCK: display PnL for OPEN positions must reflect CURRENT mcap
// (last_mcap), never the frozen high-water peak. The original bug made losers show 0% and winners
// freeze at their high.

test('open winner shows CURRENT pnl, not the frozen peak', () => {
  // entry 100k, currently 110k (+10%), but peaked at 150k (+50%)
  const p = { status: 'open', entry_mcap: 100000, last_mcap: 110000, high_water_mcap: 150000, pnl_percent: null };
  assert.ok(Math.abs(positionPnlPercent(p) - 10) < 1e-9, 'current pnl must be +10%, not +50%');
  assert.ok(Math.abs(positionPeakPnlPercent(p) - 50) < 1e-9, 'peak still reported as +50%');
});

test('open LOSER shows the real loss, not 0% (the Keycard/NIKITA bug)', () => {
  // entry 27.8k, now 22.6k (-18.7%); high_water never rose above entry → was displayed as 0%
  const p = { status: 'open', entry_mcap: 27842, last_mcap: 22628, high_water_mcap: 27842, pnl_percent: null };
  const pnl = positionPnlPercent(p);
  assert.ok(pnl < -18 && pnl > -19, `expected ~-18.7%, got ${pnl}`);
});

test('flat position with no movement reads ~0%', () => {
  const p = { status: 'open', entry_mcap: 50000, last_mcap: 50000, high_water_mcap: 50000, pnl_percent: null };
  assert.ok(Math.abs(positionPnlPercent(p)) < 1e-9);
});

test('legacy row without last_mcap falls back to high_water (no crash)', () => {
  const p = { status: 'open', entry_mcap: 100000, last_mcap: null, high_water_mcap: 120000, pnl_percent: null };
  assert.ok(Math.abs(positionPnlPercent(p) - 20) < 1e-9);
});

test('closed position uses realized pnl_percent (authoritative)', () => {
  const p = { status: 'closed', entry_mcap: 100000, last_mcap: 80000, high_water_mcap: 130000, pnl_percent: -21.2 };
  assert.equal(positionPnlPercent(p), -21.2);
});

test('zero/invalid entry_mcap never divides by zero', () => {
  assert.equal(positionPnlPercent({ status: 'open', entry_mcap: 0, last_mcap: 5, pnl_percent: null }), 0);
  assert.equal(positionPnlPercent({ status: 'open', entry_mcap: null, last_mcap: 5, pnl_percent: null }), 0);
});

test('peak marker suppressed when current >= peak (no stale peak shown)', () => {
  const p = { status: 'open', entry_mcap: 100000, last_mcap: 130000, high_water_mcap: 130000, pnl_percent: null };
  // current == peak → peak line should not add noise (handled in formatPosition; here peak==pnl)
  assert.ok(Math.abs(positionPnlPercent(p) - positionPeakPnlPercent(p)) < 1e-9);
});
