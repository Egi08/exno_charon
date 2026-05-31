// Pure, db-free drawdown-scaling decision for position sizing. Extracted from sizing.js so the
// threshold + sample-gate logic can be regression-tested WITHOUT opening the database.
//
// BUG CLASS this guards (sizing over-reaction to noise): a SINGLE unlucky stop-loss must not
// shrink every subsequent entry. In high-variance memecoin sniping, 1-2 closed trades is noise,
// not a trend. Risk control is layered elsewhere (rug floors + adversarial critic + confidence
// tiers + the independent risk-watchdog HALT flag). The drawdown damper should only react to a
// SUSTAINED losing streak — i.e. once enough trades have closed to be statistically meaningful.

// Minimum closed-trade sample (last 24h) before drawdown size-reduction activates.
export const DRAWDOWN_MIN_SAMPLE_DEFAULT = 3;

// Raw drawdown tiers — size reduction as the bot bleeds.
//   PnL > -10%  → 1.0x   (NORMAL)
//   -10..-20%   → 0.75x  (CAUTIOUS)
//   -20..-30%   → 0.5x   (DEFENSIVE)
//   < -30%      → 0      (HALT — also enforced independently by the risk-watchdog flag file)
export function drawdownScale(pnlPct) {
  const p = Number.isFinite(Number(pnlPct)) ? Number(pnlPct) : 0;
  if (p > -10) return { ddScale: 1.0, ddTier: 'NORMAL' };
  if (p > -20) return { ddScale: 0.75, ddTier: 'CAUTIOUS' };
  if (p > -30) return { ddScale: 0.50, ddTier: 'DEFENSIVE' };
  return { ddScale: 0, ddTier: 'HALT' };
}

// Sample-gated drawdown scale. Below `minSample` closed trades, the size-reduction tiers
// (CAUTIOUS / DEFENSIVE) are suppressed → NORMAL, so a lone stop-loss can't kneecap sizing.
// HALT is a hard catastrophic floor and is NEVER suppressed regardless of sample.
export function effectiveDrawdownScale(pnlPct, closedCount, minSample = DRAWDOWN_MIN_SAMPLE_DEFAULT) {
  const base = drawdownScale(pnlPct);
  if (base.ddTier === 'HALT') return { ...base, sampleGated: false };
  const n = Number(closedCount) || 0;
  const min = Number.isFinite(Number(minSample)) ? Number(minSample) : DRAWDOWN_MIN_SAMPLE_DEFAULT;
  if (n < min) return { ddScale: 1.0, ddTier: 'NORMAL', sampleGated: true };
  return { ...base, sampleGated: false };
}
