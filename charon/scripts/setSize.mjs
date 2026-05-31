import Database from 'better-sqlite3';
const SOL_USD = 81.82;
const sizeSol = +(50 / SOL_USD).toFixed(4);
const db = new Database('./charon.sqlite');
db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run('dry_run_buy_sol', String(sizeSol));
const strategies = db.prepare('SELECT id, config_json FROM strategies').all();
for (const row of strategies) {
  const cfg = JSON.parse(row.config_json);
  cfg.position_size_sol = sizeSol;
  db.prepare('UPDATE strategies SET config_json = ? WHERE id = ?').run(JSON.stringify(cfg), row.id);
}
console.log('Size:', sizeSol, 'SOL');
