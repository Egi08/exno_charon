// Pure, testable abort-decision for the adversarial critic. Extracted so the threshold
// logic can be regression-tested WITHOUT an LLM call.
//
// BUG CLASS this guards (same family as the sizing-gate and dual-source bugs): a hardcoded
// ABORT_THRESHOLD = 30 silently rejected EVERY pump.fun memecoin BUY, because an adversarial
// "argue against this buy" pass almost always surfaces a >=30% downside scenario. The choke
// was invisible because no BUY had ever reached the critic (the confidence gate blocked them
// upstream) — so it would have bitten the moment entries started flowing.
//
// Philosophy ("sering entry tapi tidak riskan"): ordinary LOSS scenarios up to the threshold
// are normal memecoin volatility and must NOT block entries — the asymmetric uncapped-runner
// exit absorbs them. The genuine "tidak riskan" protection is the HARD_LOSS (rug/catastrophic)
// floor, which aborts even at low probability and is INDEPENDENT of the general threshold, plus
// an explicit ABORT verdict from the critic. Tune the general threshold, never remove the rug guard.

export function shouldAbort({ scenarios = [], llmVerdict = '', threshold = 55, hardLossProbFloor = 20 } = {}) {
  const verdict = String(llmVerdict).toUpperCase();
  const maxProbability = scenarios.reduce((m, s) => Math.max(m, Number(s.probability) || 0), 0);
  const hardLossExists = scenarios.some(
    (s) => String(s.severity).toUpperCase() === 'HARD_LOSS' && (Number(s.probability) || 0) >= hardLossProbFloor,
  );
  const abort = verdict === 'ABORT' || maxProbability >= threshold || hardLossExists;

  let reasonCode;
  if (verdict === 'ABORT') reasonCode = 'LLM_VERDICT_ABORT';
  else if (hardLossExists) reasonCode = 'HARD_LOSS_RUG_GUARD';
  else if (maxProbability >= threshold) reasonCode = 'MAX_PROB_OVER_THRESHOLD';
  else reasonCode = 'PROCEED';

  return { abort, maxProbability, hardLossExists, threshold, reasonCode };
}
