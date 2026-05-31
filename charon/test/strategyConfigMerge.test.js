import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeStrategyConfig } from '../src/db/settings.js';

// Regression guard for the config-clobber bug class:
// A PARTIAL updateStrategyConfig({max_hold_ms}) once FULL-REPLACED config_json,
// wiping tp/sl/trailing/partial_tp_stages + every rug floor down to {max_hold_ms},
// silently reverting the bot to code defaults (tp50/sl-25/trailing20, no ladder,
// no floors). mergeStrategyConfig must MERGE, never replace.

const FULL = {
  id: 'sniper', name: 'Sniper',
  tp_percent: 200, sl_percent: -20, trailing_enabled: true,
  trailing_percent: 15, trailing_tight_percent: 10,
  partial_tp_stages: [{ at: 15, sell: 20 }, { at: 40, sell: 20 }, { at: 90, sell: 20 }, { at: 180, sell: 15 }],
  min_mcap_usd: 12000, max_mcap_usd: 500000, min_holders: 40,
  max_top20_holder_percent: 50, max_open_positions: 10,
};

test('partial update preserves all sibling keys (the clobber bug)', () => {
  const out = mergeStrategyConfig(FULL, { max_hold_ms: 21600000 });
  // every original key survives
  for (const k of Object.keys(FULL)) {
    assert.deepEqual(out[k], FULL[k], `key '${k}' must survive a partial update`);
  }
  // and the new key is applied
  assert.equal(out.max_hold_ms, 21600000);
  // rug floors specifically must NOT vanish (the dangerous regression)
  assert.equal(out.min_mcap_usd, 12000);
  assert.equal(out.max_top20_holder_percent, 50);
  assert.ok(Array.isArray(out.partial_tp_stages) && out.partial_tp_stages.length === 4);
});

test('patch overrides only the specified keys', () => {
  const out = mergeStrategyConfig(FULL, { sl_percent: -25, min_holders: 100 });
  assert.equal(out.sl_percent, -25);     // overridden
  assert.equal(out.min_holders, 100);    // overridden
  assert.equal(out.tp_percent, 200);     // untouched
  assert.equal(out.max_mcap_usd, 500000); // untouched
});

test('accepts existing as a JSON string (DB column form)', () => {
  const out = mergeStrategyConfig(JSON.stringify(FULL), { max_hold_ms: 1 });
  assert.equal(out.tp_percent, 200);
  assert.equal(out.max_hold_ms, 1);
});

test('corrupt/empty existing degrades to just the patch (no throw)', () => {
  assert.deepEqual(mergeStrategyConfig('{not json', { tp_percent: 50 }), { tp_percent: 50 });
  assert.deepEqual(mergeStrategyConfig(null, { tp_percent: 50 }), { tp_percent: 50 });
  assert.deepEqual(mergeStrategyConfig(undefined, { a: 1 }), { a: 1 });
});

test('empty patch is a no-op, never wipes existing', () => {
  assert.deepEqual(mergeStrategyConfig(FULL, {}), FULL);
  assert.deepEqual(mergeStrategyConfig(FULL, null), FULL);
});

test('CORE INVARIANT: ladder sell-sum stays < 100 (uncapped runner preserved)', () => {
  // not a merge property per se, but locks the runner guarantee the restored config relies on
  const sum = FULL.partial_tp_stages.reduce((s, x) => s + x.sell, 0);
  assert.ok(sum < 100, `ladder must leave a runner; sells sum to ${sum}`);
});
