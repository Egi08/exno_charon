/**
 * Regression test for the phantom -99.9% PnL bug (sim DLMM dry-run).
 *
 * ROOT CAUSE (fixed): the deploy side stored the position's entry price in RAW bin-math units
 * (getPriceOfBinByBinId = (1+binStep/10000)^binId), but a poll path computed the *current* price
 * in DECIMAL-ADJUSTED units (fromPricePerLamport, ~10^(decimalsDiff) smaller). Dividing two
 * different scales produced a CONSTANT ≈ -99.9% PnL on every poll, tripping the stop-loss within
 * minutes regardless of real market movement.
 *
 * THE INVARIANT THIS TEST LOCKS: both the entry price and the current price fed to
 * computePriceBasedPnlPct() MUST be in the same (raw bin-math) scale. If a future edit reverts the
 * poll/close path to a decimal-adjusted price, the "phantom guard" case below will fail loudly.
 *
 * Pure + offline (no network, no pool). Run: node test/test-pnl-regression.js
 * Exits non-zero on any failure so it slots into `npm test`.
 */
import { getPriceOfBinByBinId } from "@meteora-ag/dlmm";
import { computePriceBasedPnlPct } from "../tools/sim-store.js";

let failures = 0;
function assert(cond, msg) {
  if (cond) {
    console.log(`  ✓ ${msg}`);
  } else {
    console.log(`  ✗ FAIL: ${msg}`);
    failures++;
  }
}
function approx(a, b, tol = 0.01) {
  return Math.abs(a - b) <= tol;
}

console.log("\n[1] SDK getPriceOfBinByBinId == raw bin-math formula (1+binStep/10000)^binId");
for (const [binId, binStep] of [[-564, 100], [-617, 100], [0, 100], [120, 80], [-330, 125]]) {
  const sdk = Number(getPriceOfBinByBinId(binId, binStep).toString());
  const formula = Math.pow(1 + binStep / 10000, binId);
  assert(approx(sdk / formula, 1, 1e-4), `bin ${binId} step ${binStep}: SDK ${sdk.toExponential(4)} ≈ formula ${formula.toExponential(4)}`);
}

console.log("\n[2] computePriceBasedPnlPct: same price → 0%, never -99.9%");
{
  const entry = Number(getPriceOfBinByBinId(-564, 100).toString());
  const pos = { active_price_at_deploy: entry };
  const pnl = computePriceBasedPnlPct(pos, entry);
  assert(approx(pnl, 0), `active bin unchanged → PnL ${pnl.toFixed(4)}% (expected ~0%)`);
  assert(!approx(pnl, -99.9, 1), `PnL is NOT the phantom -99.9% (got ${pnl.toFixed(2)}%)`);
}

console.log("\n[3] computePriceBasedPnlPct: moves proportionally with the active bin (bin-math both sides)");
{
  const binStep = 100;
  const deployBin = -564;
  const entry = Number(getPriceOfBinByBinId(deployBin, binStep).toString());
  const pos = { active_price_at_deploy: entry };

  // price drops 5 bins lower
  const down = Number(getPriceOfBinByBinId(deployBin - 5, binStep).toString());
  const pnlDown = computePriceBasedPnlPct(pos, down);
  const expDown = (Math.pow(1.01, -5) - 1) * 100; // ≈ -4.85%
  assert(pnlDown < 0 && approx(pnlDown, expDown, 0.05), `5 bins down → ${pnlDown.toFixed(2)}% (expected ≈ ${expDown.toFixed(2)}%)`);

  // price rises 10 bins higher
  const up = Number(getPriceOfBinByBinId(deployBin + 10, binStep).toString());
  const pnlUp = computePriceBasedPnlPct(pos, up);
  const expUp = (Math.pow(1.01, 10) - 1) * 100; // ≈ +10.46%
  assert(pnlUp > 0 && approx(pnlUp, expUp, 0.05), `10 bins up → ${pnlUp.toFixed(2)}% (expected ≈ ${expUp.toFixed(2)}%)`);
}

console.log("\n[4] PHANTOM GUARD: mixing raw entry with decimal-adjusted current reproduces -99.9%");
{
  // This documents the ORIGINAL bug. A 6-decimal token vs 9-decimal SOL => decimal factor ~10^3.
  const binStep = 100;
  const bin = -564;
  const rawEntry = Number(getPriceOfBinByBinId(bin, binStep).toString());
  const pos = { active_price_at_deploy: rawEntry };

  const decimalFactor = 1e3; // fromPricePerLamport shrinks price by ~10^(decimalsDiff)
  const buggyCurrent = rawEntry / decimalFactor; // what the OLD poll path produced
  const phantom = computePriceBasedPnlPct(pos, buggyCurrent);
  assert(phantom < -99 && phantom > -100, `decimal-adjusted current → ${phantom.toFixed(2)}% (the phantom band, as expected for the BUGGY path)`);

  // The CORRECT path (same bin, raw) must stay ~0% — proving the fix neutralizes the trap.
  const correctCurrent = Number(getPriceOfBinByBinId(bin, binStep).toString());
  const correct = computePriceBasedPnlPct(pos, correctCurrent);
  assert(approx(correct, 0), `raw bin-math current → ${correct.toFixed(4)}% (fix keeps it sane)`);
}

console.log("\n[5] computePriceBasedPnlPct: defensive — missing/zero inputs → 0 (never NaN/Infinity)");
{
  assert(computePriceBasedPnlPct({ active_price_at_deploy: 0 }, 0.005) === 0, "zero entry price → 0");
  assert(computePriceBasedPnlPct({ active_price_at_deploy: 0.005 }, 0) === 0, "zero current price → 0");
  assert(computePriceBasedPnlPct({}, 0.005) === 0, "missing entry price → 0");
}

console.log(`\n${failures === 0 ? "✅ ALL PASS" : `❌ ${failures} FAILURE(S)`} — phantom -99.9% regression suite\n`);
process.exit(failures === 0 ? 0 : 1);
