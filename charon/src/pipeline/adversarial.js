// PHASE_A3_PATCH: Adversarial pre-trade critique.
//
// After the LLM picks BUY for a candidate, run a second pass that asks the SAME
// LLM to argue AGAINST the buy. The critique returns up to 3 failure scenarios
// with probability + signals that should have been detected. If any scenario
// has probability >= ABORT_THRESHOLD, we abort the trade.
//
// Why this works with thinking models: the model uses genuine reasoning to
// challenge its own decision, surfacing blind spots that a single-pass call
// misses. Cost is one extra LLM call per BUY (rare event).

import axios from 'axios';
import { llmChatCompletion } from './llmStream.js';
import { ENABLE_LLM, LLM_API_KEY, LLM_BASE_URL, LLM_MODEL, LLM_TIMEOUT_MS } from '../config.js';
import { strictJsonFromText } from '../utils.js';
import { compactCandidateForLlm } from './llm.js';
import { db } from '../db/connection.js';
import { now, json } from '../utils.js';
import { numSetting } from '../db/settings.js';
import { shouldAbort } from './adversarialGate.js';

// FIX_ADVERSARIAL_CHOKE: the abort threshold is now LIVE-TUNABLE (settings key
// 'adversarial_abort_threshold', default 55) instead of a hardcoded 30 that would reject
// virtually every pump.fun memecoin (an "argue against the buy" pass almost always finds a
// >=30% downside scenario). The genuine "tidak riskan" protection is the HARD_LOSS rug floor
// inside shouldAbort(), which is INDEPENDENT of this threshold. Tune the threshold, never
// remove the rug guard. See src/pipeline/adversarialGate.js + test/adversarialGate.test.js.
const ABORT_THRESHOLD_DEFAULT = 55;

export async function critiqueBuyDecision(selectedRow, decision) {
  if (!ENABLE_LLM || !LLM_API_KEY) {
    return { skipped: true, abort: false, reason: 'LLM disabled', scenarios: [] };
  }
  if (!selectedRow || decision?.verdict !== 'BUY') {
    return { skipped: true, abort: false, reason: 'not a BUY decision', scenarios: [] };
  }
  const system = [
    'You are Charon adversarial critic. Your job: argue AGAINST a proposed buy.',
    'Assume the buy thesis is wrong. Find concrete failure modes.',
    'Return strict JSON only.',
    'Probability is your honest assessment 0-100.',
    'Surface hidden risks: bundlers/snipers, stale liquidity, ATH proximity, narrative fade,',
    'wallet concentration, fee-claim drying, or any signal that the original analysis missed.',
    'Specifically evaluate: (1) Virality duration - skip short-lived "justice" or single-event metas that fade in 24h,',
    '(2) Memeable quality - prefer high-conviction templates usable for weeks,',
    '(3) Person dependency - avoid tokens tied strictly to a single account or developer pfp.',
  ].join(' ');
  const user = {
    task: 'You proposed a BUY on this candidate. Now argue against it. Find 1-3 specific failure scenarios.',
    proposed_decision: {
      verdict: decision.verdict,
      confidence: decision.confidence,
      reason: decision.reason,
      tp: decision.suggested_tp_percent,
      sl: decision.suggested_sl_percent,
      risks_already_noted: decision.risks || [],
    },
    candidate: compactCandidateForLlm(selectedRow),
    output_schema: {
      scenarios: [{
        scenario: 'short scenario description (e.g. "rug within 1h")',
        probability: 'number 0-100',
        signal_missed: 'specific signal in candidate data that should have flagged this',
        severity: 'LOSS|HARD_LOSS (LOSS = SL hit, HARD_LOSS = -50% before exit)',
      }],
      verdict: 'PROCEED|ABORT',
      verdict_reason: 'short string',
    },
  };
  try {
    const res = await llmChatCompletion({
      model: LLM_MODEL,
      temperature: 0.3,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: JSON.stringify(user) },
      ],
    }, {
      timeout: LLM_TIMEOUT_MS,
      headers: { authorization: `Bearer ${LLM_API_KEY}`, 'content-type': 'application/json' },
      baseUrl: LLM_BASE_URL,
    });
    const content = res.data?.choices?.[0]?.message?.content || '';
    const parsed = strictJsonFromText(content);
    const scenarios = Array.isArray(parsed?.scenarios) ? parsed.scenarios.map(s => ({
      scenario: String(s.scenario || '').slice(0, 200),
      probability: Math.max(0, Math.min(100, Number(s.probability) || 0)),
      signal_missed: String(s.signal_missed || '').slice(0, 200),
      severity: ['LOSS', 'HARD_LOSS'].includes(String(s.severity).toUpperCase())
        ? String(s.severity).toUpperCase() : 'LOSS',
    })) : [];
    const llmVerdict = String(parsed?.verdict || '').toUpperCase();
    const verdictReason = String(parsed?.verdict_reason || '').slice(0, 300);
    const threshold = numSetting('adversarial_abort_threshold', ABORT_THRESHOLD_DEFAULT);
    const gate = shouldAbort({ scenarios, llmVerdict, threshold });
    const maxProb = gate.maxProbability;
    const hardLossExists = gate.hardLossExists;
    const abort = gate.abort;
    // Log to DB for analysis
    try {
      db.prepare(`
        INSERT INTO adversarial_critiques (created_at_ms, candidate_id, decision_id, max_probability, abort_flag, scenarios_json, raw_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(now(), selectedRow.id, decision.id || null, maxProb, abort ? 1 : 0, json(scenarios), json({ verdict: llmVerdict, verdictReason, raw: parsed }));
    } catch { /* table may not exist on first run, handled by ensure */ }
    return {
      skipped: false,
      abort,
      maxProbability: maxProb,
      llmVerdict,
      verdictReason,
      scenarios,
      reason: abort
        ? `ADVERSARIAL_ABORT — max scenario prob ${maxProb}% (threshold ${threshold}%) — ${verdictReason}`
        : `ADVERSARIAL_PROCEED — max scenario prob ${maxProb}% < ${threshold}%`,
    };
  } catch (err) {
    console.log(`[adversarial] critique LLM failed: ${err.message}`);
    // Fail-open on LLM error: don't block valid trades on infra issues.
    return { skipped: false, abort: false, reason: `critique error: ${err.message}`, scenarios: [], llmError: true };
  }
}
