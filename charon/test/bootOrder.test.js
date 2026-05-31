// ANTI-REGRESSION (FIX_MONITOR_STALL): the position monitor is a CRITICAL independent subsystem and
// must NEVER be gated behind the signal pipeline. The freeze bug was: `await fetchServerSignals()`
// (which runs the flaky LLM pipeline inline) hung forever during boot, so the line that registered
// the position-monitor setInterval — placed AFTER that await — never ran. Trade management silently
// stopped and the dashboard read stale data forever.
//
// This test locks the invariant at the SOURCE level (no network/DB/mocks needed): the
// monitorPositions interval registration must appear BEFORE the signal-pipeline await, so a hung
// signal fetch can never again block trade monitoring from starting.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const appSrcRaw = readFileSync(join(__dirname, '../src/app.js'), 'utf8');

// Strip comments so assertions check ACTUAL CODE, not explanatory comment text (which intentionally
// quotes the anti-patterns we're guarding against).
const appSrc = appSrcRaw
  .replace(/\/\*[\s\S]*?\*\//g, '')        // block comments
  .split('\n')
  .map(line => line.replace(/\/\/.*$/, '')) // line comments
  .join('\n');

test('BOOT_ORDER: position monitor registers BEFORE the signal-pipeline await', () => {
  const monitorIdx = appSrc.indexOf('monitorPositions()');
  assert.ok(monitorIdx > 0, 'could not find the monitorPositions setInterval registration in code');

  // The first place boot awaits the signal pipeline (server or standalone warm-up).
  const awaitFetchIdx = appSrc.search(/await\s+fetchServerSignals|await\s+fetchGraduatedCoins/);

  // If boot awaits a signal fetch at all, the monitor must be registered first.
  if (awaitFetchIdx >= 0) {
    assert.ok(
      monitorIdx < awaitFetchIdx,
      'REGRESSION: position monitor is registered AFTER an `await fetch*Signals/Coins` — a hung ' +
      'signal fetch will block the monitor from ever starting (the "dashboard tidak bergerak" freeze). ' +
      'Register the monitor interval BEFORE any awaited signal-pipeline call.',
    );
  }
});

test('BOOT_ORDER: the initial server-signal warm-up is NOT awaited (fire-and-forget)', () => {
  // The warm-up fetch must not block boot. Guard against re-introducing `await fetchServerSignals(`.
  assert.equal(
    /await\s+fetchServerSignals\s*\(/.test(appSrc),
    false,
    'REGRESSION: `await fetchServerSignals()` re-introduced — the initial fetch runs the LLM pipeline ' +
    'inline and can hang with no timeout, blocking boot. Call it fire-and-forget via trackServer(); ' +
    'the scheduled setInterval re-runs it anyway.',
  );
});
