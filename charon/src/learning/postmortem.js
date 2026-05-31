// PHASE_B1_PATCH: Per-position loss postmortem.
//
// After a losing position closes (SL or significant negative PnL on TRAILING/MAX_HOLD),
// ask the LLM to identify which signal at entry should have prevented the trade.
// The output becomes a single lesson appended to learning_lessons table, which
// llm.js#activeLessonsForPrompt() injects into the next decision cycle.
//
// This creates a closed feedback loop:
//   bad trade → postmortem → lesson stored → next decision sees the lesson → fewer repeats.
//
// Cost: one LLM call per losing trade. Triggered async, non-blocking.

import axios from 'axios';
import { llmChatCompletion } from '../pipeline/llmStream.js';
import { ENABLE_LLM, LLM_API_KEY, LLM_BASE_URL, LLM_MODEL, LLM_TIMEOUT_MS } from '../config.js';
import { now, json, strictJsonFromText } from '../utils.js';
import { db } from '../db/connection.js';

// Trigger postmortem only when loss meaningful — avoid noise from minor exits.
const LOSS_THRESHOLD_PCT = -10;

export function shouldRunPostmortem(position) {
  if (!position) return false;
  if (position.status !== 'closed') return false;
  const pnl = Number(position.pnl_percent ?? 0);
  if (pnl >= LOSS_THRESHOLD_PCT) return false;
  // skip if we already have one
  try {
    const exists = db.prepare(
      `SELECT id FROM learning_lessons WHERE evidence_json LIKE ? LIMIT 1`
    ).get(`%"position_id":${position.id}%`);
    if (exists) return false;
  } catch { /* table missing; ensure() handles */ }
  return true;
}

function snapshotForLlm(position) {
  let snap = {};
  try { snap = JSON.parse(position.snapshot_json || '{}'); } catch { /* ignore */ }
  const c = snap.candidate || {};
  return {
    position_id: position.id,
    symbol: position.symbol,
    mint: position.mint,
    entry_mcap: position.entry_mcap,
    high_water_mcap: position.high_water_mcap,
    exit_mcap: position.exit_mcap,
    exit_reason: position.exit_reason,
    pnl_percent: position.pnl_percent,
    pnl_sol: position.pnl_sol,
    size_sol: position.size_sol,
    held_ms: Number(position.closed_at_ms || 0) - Number(position.opened_at_ms || 0),
    partial_tp_stage: position.partial_tp_stage || 0,
    decision_at_entry: snap.decision || null,
    candidate_metrics: c.metrics || null,
    candidate_holders: c.holders ? {
      count: c.holders.holders?.length,
      top10_pct: c.holders.top10_pct ?? c.holders.summary?.top10HolderPercent,
      top20_pct: c.holders.top20_pct ?? c.holders.summary?.top20HolderPercent,
    } : null,
    candidate_signals: c.signals || null,
    candidate_filters: c.filters || null,
    candidate_route: c.signals?.route,
    candidate_chart: c.chart ? {
      distanceFromAth: c.chart.distanceFromAthPercent,
      topBlastRisk: c.chart.topBlastRisk,
      currentNative: c.chart.currentNative,
      rangeHighNative: c.chart.rangeHighNative,
    } : null,
  };
}

export async function runPostmortem(position) {
  if (!ENABLE_LLM || !LLM_API_KEY) return null;
  if (!shouldRunPostmortem(position)) return null;

  const system = [
    'You are Charon postmortem analyst.',
    'A dry-run trade lost money. Identify which entry signal should have flagged this risk.',
    'Be concrete: cite specific numbers from the candidate data.',
    'Return strict JSON only.',
    'Output a SINGLE actionable lesson that can prevent this exact loss pattern next time.',
  ].join(' ');

  const user = {
    task: 'Postmortem of losing trade. What signal at entry should have prevented this buy?',
    output_schema: {
      root_cause: 'short string — the primary failure mode',
      missed_signal: 'specific data point that hinted at the loss',
      severity: 'CRITICAL|HIGH|MEDIUM',
      lesson: 'one sentence rule for future screening (e.g. "Reject candidates with X when Y")',
    },
    snapshot: snapshotForLlm(position),
  };

  try {
    const res = await llmChatCompletion({
      model: LLM_MODEL,
      temperature: 0.2,
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
    const lesson = String(parsed?.lesson || '').slice(0, 500);
    const rootCause = String(parsed?.root_cause || '').slice(0, 200);
    const missedSignal = String(parsed?.missed_signal || '').slice(0, 200);
    const severity = ['CRITICAL', 'HIGH', 'MEDIUM'].includes(String(parsed?.severity).toUpperCase())
      ? String(parsed.severity).toUpperCase() : 'MEDIUM';

    if (!lesson) return null;

    // Insert directly into learning_lessons (run_id null = postmortem-sourced)
    db.prepare(`
      INSERT INTO learning_lessons (run_id, created_at_ms, status, lesson, evidence_json)
      VALUES (NULL, ?, 'active', ?, ?)
    `).run(now(), lesson, json({
      source: 'postmortem',
      position_id: position.id,
      symbol: position.symbol,
      pnl_percent: position.pnl_percent,
      exit_reason: position.exit_reason,
      root_cause: rootCause,
      missed_signal: missedSignal,
      severity,
    }));

    console.log(`[postmortem] position ${position.id} (${position.symbol}, ${position.pnl_percent?.toFixed(1)}%): ${lesson}`);
    return { lesson, rootCause, missedSignal, severity };
  } catch (err) {
    console.log(`[postmortem] ${position.id} LLM failed: ${err.message}`);
    return null;
  }
}
