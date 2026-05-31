import { test } from 'node:test';
import assert from 'node:assert';
import { liquidityScale } from '../src/execution/liquidityGate.js';

test('THIN mini-mcap near rug floor → 0.5x (the TS/Bagworkers blowout class)', () => {
  assert.equal(liquidityScale(30000).scale, 0.5);
  assert.equal(liquidityScale(38000).tier, 'THIN');
});

test('MID mcap → 0.75x', () => {
  assert.equal(liquidityScale(100000).scale, 0.75);
  assert.equal(liquidityScale(100000).tier, 'MID');
});

test('DEEP mcap → full size 1.0x', () => {
  assert.equal(liquidityScale(200000).scale, 1);
  assert.equal(liquidityScale(500000).tier, 'DEEP');
});

test('boundary: exactly at thin threshold is MID, not THIN', () => {
  assert.equal(liquidityScale(40000).tier, 'MID');
});

test('boundary: exactly at mid threshold is DEEP', () => {
  assert.equal(liquidityScale(150000).tier, 'DEEP');
});

test('unknown/zero/negative mcap → no damper (wiring-safe 1.0x)', () => {
  assert.equal(liquidityScale(0).scale, 1);
  assert.equal(liquidityScale(null).scale, 1);
  assert.equal(liquidityScale(undefined).tier, 'UNKNOWN');
  assert.equal(liquidityScale(-5).scale, 1);
});

test('custom thresholds honored', () => {
  assert.equal(liquidityScale(50000, { thin: 60000 }).tier, 'THIN');
});

test('CORE INVARIANT: thinner liquidity is never sized larger than deeper liquidity', () => {
  const thin = liquidityScale(20000).scale;
  const mid = liquidityScale(80000).scale;
  const deep = liquidityScale(300000).scale;
  assert.ok(thin <= mid && mid <= deep, `expected thin<=mid<=deep, got ${thin},${mid},${deep}`);
});
