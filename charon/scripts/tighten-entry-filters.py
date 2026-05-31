#!/usr/bin/env python3
"""Tighten Charon sniper entry-quality filters. Preserves all other config_json keys.
Backs up the current config_json before writing. Idempotent."""
import sqlite3, json, sys, time

DB = "/root/charon/charon.sqlite"
CHANGES = {
    "min_mcap_usd": 12000,            # was 7000 — kill sub-lottery (the $7.4K ultracode entry)
    "min_holders": 40,               # was 0   — kill ghost tokens (only 17% have <50 holders)
    "max_top20_holder_percent": 50,  # was 100 — kill single-whale rug setups (>50% one holder)
}

con = sqlite3.connect(DB)
con.row_factory = sqlite3.Row
row = con.execute("SELECT id, name, config_json FROM strategies WHERE enabled=1 LIMIT 1").fetchone()
if not row:
    print("ERROR: no enabled strategy"); sys.exit(1)

cfg = json.loads(row["config_json"])
before = {k: cfg.get(k) for k in CHANGES}

# Backup current config to a sibling key-row in a tiny audit table (create if needed)
con.execute("CREATE TABLE IF NOT EXISTS strategy_config_backups (at_ms INTEGER, strategy_id TEXT, config_json TEXT)")
con.execute("INSERT INTO strategy_config_backups (at_ms, strategy_id, config_json) VALUES (?,?,?)",
            (int(time.time()*1000), row["id"], row["config_json"]))

for k, v in CHANGES.items():
    cfg[k] = v

con.execute("UPDATE strategies SET config_json=? WHERE id=?", (json.dumps(cfg), row["id"]))
con.commit()

# Verify round-trip
check = json.loads(con.execute("SELECT config_json FROM strategies WHERE id=?", (row["id"],)).fetchone()[0])
after = {k: check.get(k) for k in CHANGES}
con.close()

print(f"strategy: {row['name']} ({row['id']})")
print(f"  before: {before}")
print(f"  after:  {after}")
print("  backup row inserted into strategy_config_backups")
assert after == CHANGES, "round-trip mismatch!"
print("OK")
