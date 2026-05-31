#!/usr/bin/env python3
"""Charon: 'low risk, more entries' = many SMALL bets.
Levers (calibrated from 7d BUY distribution):
  - entry gate 65 -> 62   : captures the dense 62-64 BUY cluster (~0.4/day -> ~4/day, 10x more)
  - max_open_positions 3 -> 6 : let the extra entries run concurrently instead of being blocked
  - base position_size 0.2037 -> 0.10 : halve per-bet size so TOTAL exposure stays ~flat
KEEP (the low-risk guardrails — do NOT loosen):
  - sl_percent -20 (now actually enforced post-TDZ-fix), trailing 15%/tight 10%
  - rug floors: min_mcap 12000, min_holders 40, max_top20_holder 50
  - adversarial critic veto stays on
Exposure math:
  before: 3 slots x 0.2037              = 0.611 SOL max base exposure
  after : 6 slots x 0.10               = 0.600 SOL max base exposure (flat),
          but most entries land in LOW tier (0.5x) = ~0.05 SOL each -> typically far less.
Settings (llm_min_confidence) = live, no restart. config_json = 5s cache, no restart.
Backs up config_json into strategy_config_backups before writing. Idempotent."""
import sqlite3, json, time, sys

DB = "charon.sqlite"
con = sqlite3.connect(DB)
con.row_factory = sqlite3.Row
cur = con.cursor()

# --- backup table ---
cur.execute("""CREATE TABLE IF NOT EXISTS strategy_config_backups(
  id INTEGER PRIMARY KEY AUTOINCREMENT, strategy_id TEXT, config_json TEXT, backed_up_at_ms INTEGER, note TEXT)""")

row = cur.execute("SELECT id, config_json FROM strategies WHERE enabled=1").fetchone()
if not row:
    print("ERROR: no enabled strategy"); sys.exit(1)
sid, raw = row["id"], row["config_json"]
cfg = json.loads(raw)

# backup
cur.execute("INSERT INTO strategy_config_backups(strategy_id, config_json, backed_up_at_ms, note) VALUES (?,?,?,?)",
            (sid, raw, int(time.time()*1000), "before low-risk-many-entries"))

before = {
  "gate": cur.execute("SELECT value FROM settings WHERE key='llm_min_confidence'").fetchone()["value"],
  "max_open_positions": cfg.get("max_open_positions"),
  "position_size_sol": cfg.get("position_size_sol"),
}

# --- apply config_json changes ---
cfg["max_open_positions"] = 6
cfg["position_size_sol"]  = 0.10
cur.execute("UPDATE strategies SET config_json=? WHERE id=?", (json.dumps(cfg), sid))

# --- apply settings changes (keep settings mirror in sync with config) ---
def set_setting(k, v):
    cur.execute("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (k, str(v)))
set_setting("llm_min_confidence", 62)
set_setting("max_open_positions", 6)
set_setting("dry_run_buy_sol", 0.10)

con.commit()

after = {
  "gate": cur.execute("SELECT value FROM settings WHERE key='llm_min_confidence'").fetchone()["value"],
  "max_open_positions": cfg["max_open_positions"],
  "position_size_sol": cfg["position_size_sol"],
}
print("BEFORE:", json.dumps(before))
print("AFTER :", json.dumps(after))
print("KEPT  :", json.dumps({k: cfg.get(k) for k in ("sl_percent","trailing_percent","trailing_tight_percent","min_mcap_usd","min_holders","max_top20_holder_percent","tp_percent")}))
print("OK — config_json backed up + updated; settings updated (live).")
con.close()