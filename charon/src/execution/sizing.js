// PHASE_A_PATCH: Confidence-weighted + drawdown-adaptive position sizing.
//
// Sizing logic (in order):
//   1. Confidence tier multiplier on top of strategy base size
//   2. Drawdown-adaptive scale based on last-24h PnL (SAMPLE-GATED — see drawdownGate.js)
//   3. Floor at 0 (skip trade) when confidence below entry threshold
//
// Returns { sizeSol, tier, ddScale, ddPnlPct, closedCount, sampleGated, baseSize, reason }.

import { db } from '../db/connection.js';
import { numSetting, activeStrategy } from '../db/settings.js';
import { drawdownScale, effectiveDrawdownScale, DRAWDOWN_MIN_SAMPLE_DEFAULT } from './drawdownGate.js';
import { liquidityScale } from './liquidityGate.js';

// Confidence tier multipliers — applied on top of strategy base size.
// FIX_SIZING_GATE: tiers are RELATIVE to the live entry gate (llm_min_confidence), not a
// hardcoded 75. Previously this floored at <75 → SKIP while the entry gate was lowered to 65,
// so every BUY at confidence 65-74 passed the gate then got sized to 0 SOL → "entry_sized_to_zero"
// → no position ever opened. Anchoring to the gate makes the two impossible to contradict again.
//   below gate        → SKIP (0x)   — never enters (matches the orchestrator gate exactly)
//   gate .. gate+4    → 0.5x  (marginal conviction, just over the line)
//   gate+5 .. gate+9  → 1.0x  (normal)
//   gate+10 .. gate+19→ 1.5x  (high conviction)
//   gate+20+          → 2.0x  (very high conviction)
export function confidenceTier(confidence, minConfidence = null) {
  const c = Number(confidence) || 0;
  // FIX_GATE_FALLBACK: only use an EXPLICITLY-passed override. `Number(null)` and
  // `Number(undefined)` resolve to 0 / NaN — and `Number.isFinite(0) === true` — so the
  // previous `Number.isFinite(Number(minConfidence))` test treated the no-arg call (null)
  // as a real override of 0. That forced gate=0, so every BUY landed VERY_HIGH (2x) and
  // marginal entries got MAX size — the exact opposite of confidence-weighted sizing.
  // Now: null/undefined/non-finite → fall back to the live entry gate; a finite number wins.
  const override = Number(minConfidence);
  const gate = (minConfidence === null || minConfidence === undefined || !Number.isFinite(override))
    ? numSetting('llm_min_confidence', 65)
    : override;
  if (c < gate) return { tier: 'SKIP', multiplier: 0, gate };
  const over = c - gate;
  if (over < 5) return { tier: 'LOW', multiplier: 0.5, gate };
  if (over < 10) return { tier: 'MID', multiplier: 1.0, gate };
  if (over < 20) return { tier: 'HIGH', multiplier: 1.5, gate };
  return { tier: 'VERY_HIGH', multiplier: 2.0, gate };
}

// drawdownScale + effectiveDrawdownScale now live in ./drawdownGate.js (pure, db-free, testable).
// Re-exported here for backward compatibility with existing importers.
export { drawdownScale, effectiveDrawdownScale };

// Compute 24h closed-trade stats: PnL % (pnl_sol / size_sol invested) AND the closed-trade count.
// The count drives the sample gate so a lone loss can't trigger drawdown size-reduction.
export function recent24hStats() {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const row = db.prepare(`
    SELECT COALESCE(SUM(pnl_sol), 0) AS pnl, COALESCE(SUM(size_sol), 0) AS size, COUNT(*) AS n
    FROM dry_run_positions
    WHERE status = 'closed'
      AND closed_at_ms >= ?
      AND execution_mode IN ('dry_run', 'live')
  `).get(cutoff);
  const size = Number(row?.size) || 0;
  const pnlPct = size ? (Number(row.pnl) / size) * 100 : 0;
  return { pnlPct, closedCount: Number(row?.n) || 0 };
}

// Backward-compatible: 24h PnL % only.
export function recent24hPnlPct() {
  return recent24hStats().pnlPct;
}

// Main entry: compute effective position size for a decision.
//   decision: { confidence: 0-100, ... }
//   opts.entryMcap: token entry market cap (USD) — drives the liquidity damper (thin → smaller size)
// Returns { sizeSol, tier, multiplier, ddScale, ddTier, ddPnlPct, closedCount, sampleGated, liqScale, liqTier, baseSize, reason }
export function effectivePositionSize(decision, { entryMcap = null } = {}) {
  const strat = activeStrategy();
  const baseSize = Number(strat.position_size_sol ?? numSetting('dry_run_buy_sol', 0.1));
  const confidence = Number(decision?.confidence) || 0;
  const { tier, multiplier, gate } = confidenceTier(confidence);
  if (multiplier === 0) {
    return {
      sizeSol: 0,
      tier,
      multiplier: 0,
      ddScale: 1,
      ddTier: 'N/A',
      ddPnlPct: 0,
      closedCount: 0,
      sampleGated: false,
      liqScale: 1,
      liqTier: 'N/A',
      baseSize,
      reason: `Confidence ${confidence} below entry gate (${gate})`,
    };
  }
  const { pnlPct: ddPnlPct, closedCount } = recent24hStats();
  const minSample = numSetting('drawdown_min_sample', DRAWDOWN_MIN_SAMPLE_DEFAULT);
  const { ddScale, ddTier, sampleGated } = effectiveDrawdownScale(ddPnlPct, closedCount, minSample);
  // FIX_LIQUIDITY_SIZING: shrink SOL-at-risk on thin mini-mcap tokens (the TS/Bagworkers -40%
  // blowout class). Does NOT cap upside — only reduces worst-case loss → improves risk:reward.
  const liqThin = numSetting('liq_thin_mcap_usd', 40000);
  const liqMid = numSetting('liq_mid_mcap_usd', 150000);
  const { scale: liqScale, tier: liqTier } = liquidityScale(entryMcap, { thin: liqThin, mid: liqMid });
  const sizeSol = Number((baseSize * multiplier * ddScale * liqScale).toFixed(4));
  const ddPart = sampleGated
    ? `drawdown=NORMAL (sample n=${closedCount}<${minSample}; 24h_pnl=${ddPnlPct.toFixed(1)}% ignored as noise)`
    : (ddScale < 1
      ? `drawdown=${ddTier} 24h_pnl=${ddPnlPct.toFixed(1)}% (n=${closedCount}) → ${ddScale}x`
      : `drawdown=NORMAL`);
  const liqPart = liqScale < 1 ? `, liquidity=${liqTier} (mcap=${Math.round(Number(entryMcap)||0)}) → ${liqScale}x` : '';
  const reason = `tier=${tier} (${multiplier}x), ${ddPart}${liqPart}`;
  return { sizeSol, tier, multiplier, ddScale, ddTier, ddPnlPct, closedCount, sampleGated, liqScale, liqTier, baseSize, reason };
}
