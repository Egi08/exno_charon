// Pure, db-free liquidity-aware size damper.
//
// BUG CLASS (sizing ignored liquidity): position sizing used ONLY confidence × drawdown — it had
// NO liquidity factor. The two biggest dry-run blowouts were THIN mini-mcap tokens that received
// the MAX size: TS -46% (entry mcap ~38K) and Bagworkers -39% (~30K), both near the 12K rug floor.
// Thin liquidity = larger gap-down / slow-rug risk → a stop-loss overshoots far past its set level
// (set -15%/-25%, realized -46%/-39%). Confidence being high does NOT make a thin token safe.
//
// Fix: scale SOL-at-risk DOWN for thin tokens. This does NOT cap upside (a thin token can still
// run; you simply risk less getting there), so it is consistent with the uncapped-runner
// philosophy — it ONLY improves risk:reward by shrinking the worst-case loss on the riskiest names.

export const LIQ_THIN_DEFAULT = 40000;   // < this mcap = thinnest liquidity (near the rug floor)
export const LIQ_MID_DEFAULT = 150000;   // < this mcap = moderate depth

// Returns { scale, tier }. Unknown/zero mcap → scale 1 (no damper) so a missing-data wiring gap
// never silently shrinks every trade; in practice createDryRunPosition always passes a real mcap.
export function liquidityScale(entryMcap, { thin = LIQ_THIN_DEFAULT, mid = LIQ_MID_DEFAULT } = {}) {
  const m = Number(entryMcap);
  if (!Number.isFinite(m) || m <= 0) return { scale: 1, tier: 'UNKNOWN' };
  if (m < thin) return { scale: 0.5, tier: 'THIN' };   // halve risk on the thinnest names
  if (m < mid)  return { scale: 0.75, tier: 'MID' };    // moderate depth
  return { scale: 1, tier: 'DEEP' };                     // deep liquidity → full size
}
