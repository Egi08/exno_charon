import Database from 'better-sqlite3';
const db = new Database('./charon.sqlite', { readonly: true });

const decisions = db.prepare(`
  SELECT id, candidate_id, mint, verdict, confidence, reason, created_at_ms
  FROM llm_decisions ORDER BY id DESC LIMIT 10
`).all();
console.log('Recent llm_decisions:', decisions.length);
for (const d of decisions) {
  const ago = Math.floor((Date.now() - d.created_at_ms) / 1000);
  console.log(`  #${d.id} cand=${d.candidate_id} ${d.verdict} conf=${d.confidence} ${ago}s ago`);
  console.log(`    mint: ${d.mint}`);
  console.log(`    reason: ${(d.reason || '').slice(0, 200)}`);
}

const batches = db.prepare(`
  SELECT id, trigger_candidate_id, verdict, confidence, selected_candidate_id, reason, created_at_ms
  FROM llm_batches ORDER BY id DESC LIMIT 10
`).all();
console.log('\nRecent llm_batches:', batches.length);
for (const b of batches) {
  const ago = Math.floor((Date.now() - b.created_at_ms) / 1000);
  console.log(`  #${b.id} trigger=${b.trigger_candidate_id} ${b.verdict} conf=${b.confidence} selected=${b.selected_candidate_id} ${ago}s ago`);
  console.log(`    reason: ${(b.reason || '').slice(0, 200)}`);
}

const events = db.prepare(`
  SELECT id, action, mode, batch_id, trigger_candidate_id, verdict, confidence, at_ms
  FROM decision_logs ORDER BY id DESC LIMIT 15
`).all();
console.log('\nRecent decision_logs:', events.length);
for (const e of events) {
  const ago = Math.floor((Date.now() - e.at_ms) / 1000);
  console.log(`  #${e.id} ${e.action} mode=${e.mode} ${e.verdict || '-'} conf=${e.confidence ?? '-'} batch=${e.batch_id} trig=${e.trigger_candidate_id} ${ago}s ago`);
}

const cols = db.prepare("PRAGMA table_info(dry_run_positions)").all().map(c => c.name);
const tsCol = ['opened_at_ms','open_at_ms','at_ms','created_at_ms'].find(c => cols.includes(c)) || 'id';
const positions = db.prepare(`
  SELECT id, mint, status, size_sol, entry_price, strategy_id, ${tsCol} AS ts
  FROM dry_run_positions ORDER BY id DESC LIMIT 10
`).all();
console.log('\nRecent dry_run_positions:', positions.length, '(ts col:', tsCol + ')');
for (const p of positions) {
  const ago = tsCol !== 'id' ? Math.floor((Date.now() - p.ts) / 1000) + 's ago' : '';
  console.log(`  #${p.id} ${p.mint?.slice(0,10)}... ${p.status} size=${p.size_sol} entry=${p.entry_price} strat=${p.strategy_id} ${ago}`);
}
