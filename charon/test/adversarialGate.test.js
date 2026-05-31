import { test } from 'node:test';
import assert from 'node:assert';
import { shouldAbort } from '../src/pipeline/adversarialGate.js';

// Regression guard for the adversarial-critic choke bug class: a hardcoded threshold that
// rejected every memecoin BUY. Locks the "sering entry tapi tidak riskan" contract.

test('ordinary LOSS below threshold PROCEEDS (normal memecoin volatility must not block)', () => {
  const r = shouldAbort({ scenarios: [{ severity: 'LOSS', probability: 40 }], threshold: 55 });
  assert.equal(r.abort, false);
  assert.equal(r.reasonCode, 'PROCEED');
});

test('ordinary LOSS at/over threshold ABORTS', () => {
  const r = shouldAbort({ scenarios: [{ severity: 'LOSS', probability: 60 }], threshold: 55 });
  assert.equal(r.abort, true);
  assert.equal(r.reasonCode, 'MAX_PROB_OVER_THRESHOLD');
});

test('CORE: HARD_LOSS rug guard ABORTS even far below the general threshold', () => {
  // a 20% rug probability must block regardless of how high the general threshold is set
  const r = shouldAbort({ scenarios: [{ severity: 'HARD_LOSS', probability: 20 }], threshold: 90 });
  assert.equal(r.abort, true);
  assert.equal(r.reasonCode, 'HARD_LOSS_RUG_GUARD');
});

test('HARD_LOSS below the rug floor does NOT abort on its own', () => {
  const r = shouldAbort({ scenarios: [{ severity: 'HARD_LOSS', probability: 10 }], threshold: 55, hardLossProbFloor: 20 });
  assert.equal(r.abort, false);
});

test('explicit ABORT verdict always blocks', () => {
  const r = shouldAbort({ scenarios: [{ severity: 'LOSS', probability: 5 }], llmVerdict: 'ABORT', threshold: 55 });
  assert.equal(r.abort, true);
  assert.equal(r.reasonCode, 'LLM_VERDICT_ABORT');
});

test('empty scenarios proceed', () => {
  const r = shouldAbort({ scenarios: [], threshold: 55 });
  assert.equal(r.abort, false);
  assert.equal(r.maxProbability, 0);
});

test('INVARIANT: raising the threshold can only ever loosen general LOSS gating, never the rug guard', () => {
  const rug = [{ severity: 'HARD_LOSS', probability: 25 }];
  // at any threshold from 30..95 a real rug stays blocked
  for (let t = 30; t <= 95; t += 5) {
    assert.equal(shouldAbort({ scenarios: rug, threshold: t }).abort, true, `rug must block at threshold ${t}`);
  }
  // a borderline 50% LOSS flips from abort->proceed as the threshold rises past it
  assert.equal(shouldAbort({ scenarios: [{ severity: 'LOSS', probability: 50 }], threshold: 45 }).abort, true);
  assert.equal(shouldAbort({ scenarios: [{ severity: 'LOSS', probability: 50 }], threshold: 55 }).abort, false);
});
