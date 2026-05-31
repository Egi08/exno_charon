// PnL Dashboard — realtime calendar view for Charon (sniper) + Meridian (DLMM LP).
// Dependency-free: Node built-in http + child_process(sqlite3 CLI) + fs. Read-only.
//
// Data model:
//   Charon  : charon.sqlite dry_run_positions, PnL stored in SOL (pnl_sol). USD = pnl_sol * solPrice.
//             Paper baseline + reset timestamp live in `settings` (dashboard_start_balance_usd / _reset_at_ms).
//   Meridian: sim-positions.json (object keyed by address). Closed entries carry realized_pnl_usd + closed_at(ms).
//             Baseline = $50 (SIMULATED_SOL_BALANCE * solPrice at start).
//
// Exposes:  GET /            → HTML calendar UI
//           GET /api/data    → { solPrice, startUsd, bots:{charon,meridian,combined} } for all months
'use strict';

const http = require('http');
const fs = require('fs');
const { execFileSync } = require('child_process');
const https = require('https');

const PORT = Number(process.env.PNL_DASH_PORT || 8910);
const HOST = '127.0.0.1';
const CHARON_DB = process.env.CHARON_DB || '/root/charon/charon.sqlite';
const MERIDIAN_SIM = process.env.MERIDIAN_SIM || '/root/meridian/sim-positions.json';
const START_USD_PER_BOT = 50;
const SOL_PRICE_FALLBACK = 82.0;

// ---- optional access token (set PNL_DASH_TOKEN to require ?token=… ) ----
const ACCESS_TOKEN = process.env.PNL_DASH_TOKEN || '';

let solPriceCache = { value: SOL_PRICE_FALLBACK, at: 0 };

function fetchSolPrice() {
  return new Promise((resolve) => {
    const url = 'https://datapi.jup.ag/v1/assets/search?query=So11111111111111111111111111111111111111112';
    const req = https.get(url, { timeout: 8000 }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try {
          const arr = JSON.parse(body);
          const s = Array.isArray(arr) ? arr[0] : arr;
          const p = Number(s.usdPrice ?? s.price ?? s.priceUsd);
          if (Number.isFinite(p) && p > 0) return resolve(p);
        } catch (_) {}
        resolve(null);
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

async function getSolPrice() {
  // refresh at most once per 15s (was 60s) — fresher SOL badge, datapi.jup call is cheap
  if (Date.now() - solPriceCache.at < 15_000) return solPriceCache.value;
  const live = await fetchSolPrice();
  solPriceCache = { value: live || SOL_PRICE_FALLBACK, at: Date.now() };
  return solPriceCache.value;
}

// ---------- Charon (SQLite via sqlite3 -json CLI) ----------
function sqliteJson(sql) {
  try {
    const out = execFileSync('sqlite3', ['-json', CHARON_DB, sql], { encoding: 'utf8', timeout: 10_000 });
    return out.trim() ? JSON.parse(out) : [];
  } catch (e) {
    return [];
  }
}

function charonData(solPrice) {
  const ACTIVE = "COALESCE(execution_mode,'dry_run') IN ('dry_run','live')";
  const resetRow = sqliteJson(`SELECT value FROM settings WHERE key='dashboard_reset_at_ms'`);
  const resetMs = resetRow[0] ? Number(resetRow[0].value) : 0;
  // daily realized PnL (SOL → USD), keyed local-UTC day
  const rows = sqliteJson(
    `SELECT strftime('%Y-%m-%d', closed_at_ms/1000, 'unixepoch', '+7 hours') d, ` +
    `SUM(pnl_sol) sol, COUNT(*) n FROM dry_run_positions ` +
    `WHERE status='closed' AND ${ACTIVE} AND closed_at_ms >= ${resetMs} GROUP BY d`
  );
  const days = {};
  let realizedSol = 0;
  for (const r of rows) {
    const usd = Number(r.sol) * solPrice;
    days[r.d] = { usd, sol: Number(r.sol), trades: Number(r.n) };
    realizedSol += Number(r.sol);
  }
  // open positions + unrealized (mark-to-market via last_mcap vs entry_mcap)
  const openRows = sqliteJson(
    `SELECT COUNT(*) n, COALESCE(SUM(size_sol),0) deployed, ` +
    `COALESCE(SUM(size_sol*(COALESCE(last_mcap,entry_mcap)/NULLIF(entry_mcap,0)-1)),0) unreal_sol ` +
    `FROM dry_run_positions WHERE status='open' AND ${ACTIVE}`
  );
  const o = openRows[0] || { n: 0, deployed: 0, unreal_sol: 0 };
  const realizedUsd = realizedSol * solPrice;
  const deployedUsd = Number(o.deployed) * solPrice;
  // REALTIME W/L: realized win/lose count BY TRADE since reset (not by calendar day)
  const wlRows = sqliteJson(
    `SELECT (pnl_sol > 0) w, COUNT(*) n, SUM(pnl_sol) sol FROM dry_run_positions ` +
    `WHERE status='closed' AND ${ACTIVE} AND closed_at_ms >= ${resetMs} GROUP BY w`
  );
  let wins = 0, winUsd = 0, losses = 0, lossUsd = 0;
  for (const r of wlRows) {
    if (Number(r.w) === 1) { wins = Number(r.n); winUsd = Number(r.sol) * solPrice; }
    else { losses = Number(r.n); lossUsd = Number(r.sol) * solPrice; }
  }
  // REALTIME open-position detail for the live panel (mark-to-market via last_mcap)
  const positions = sqliteJson(
    `SELECT symbol, size_sol, entry_mcap, COALESCE(last_mcap,entry_mcap) cur_mcap ` +
    `FROM dry_run_positions WHERE status='open' AND ${ACTIVE} ORDER BY id DESC`
  ).map((p) => {
    const pct = Number(p.entry_mcap) ? (Number(p.cur_mcap) / Number(p.entry_mcap) - 1) * 100 : 0;
    const sol = Number(p.size_sol) * pct / 100;
    return { sym: p.symbol || '?', pct, usd: sol * solPrice, sizeSol: Number(p.size_sol), bot: '🎯' };
  });
  // REALTIME closed-trade detail (realized, since reset) — distinct from open positions
  const closedPositions = sqliteJson(
    `SELECT symbol, pnl_sol, pnl_percent, exit_reason FROM dry_run_positions ` +
    `WHERE status='closed' AND ${ACTIVE} AND closed_at_ms >= ${resetMs} ORDER BY closed_at_ms DESC`
  ).map((p) => ({
    sym: p.symbol || '?', pct: Number(p.pnl_percent), usd: Number(p.pnl_sol) * solPrice,
    reason: p.exit_reason || '', bot: '🎯',
  }));
  return {
    name: 'Charon',
    emoji: '🎯',
    unit: 'sniper',
    startUsd: START_USD_PER_BOT,
    realizedUsd,
    balanceUsd: START_USD_PER_BOT + realizedUsd - deployedUsd,
    openCount: Number(o.n),
    unrealizedUsd: Number(o.unreal_sol) * solPrice,
    wins, winUsd, losses, lossUsd,
    positions,
    closedPositions,
    days,
    resetMs,
  };
}

// ---------- Meridian (sim-positions.json) ----------
function meridianData(solPrice) {
  let posObj = {};
  try {
    const raw = JSON.parse(fs.readFileSync(MERIDIAN_SIM, 'utf8'));
    posObj = raw.positions || {};
  } catch (_) {}
  const arr = Object.values(posObj);
  const days = {};
  let realizedUsd = 0;
  let openCount = 0;
  let unrealizedUsd = 0;
  let wins = 0, winUsd = 0, losses = 0, lossUsd = 0;
  const positions = [];
  const closedPositions = [];
  for (const p of arr) {
    const isClosed = p.closed || p.closed_at || p.close_reason;
    if (isClosed) {
      const ts = Number(p.closed_at || 0);
      if (!ts) continue;
      const d = new Date(ts + 7 * 3600 * 1000).toISOString().slice(0, 10); // WIB (UTC+7) day bucket
      // prefer stored USD; else derive from realized SOL * price
      let usd = Number(p.realized_pnl_usd);
      if (!Number.isFinite(usd)) usd = Number(p.realized_pnl_sol || 0) * solPrice;
      if (!Number.isFinite(usd)) usd = 0;
      if (!days[d]) days[d] = { usd: 0, sol: 0, trades: 0 };
      days[d].usd += usd;
      days[d].sol += Number(p.realized_pnl_sol || 0);
      days[d].trades += 1;
      realizedUsd += usd;
      if (usd > 0) { wins += 1; winUsd += usd; } else { losses += 1; lossUsd += usd; }
      const rawSym = p.live_pair
          || (p.base_symbol && p.base_symbol !== 'TOKEN' ? `${p.base_symbol}-${p.quote_symbol || 'SOL'}` : null)
          || (p.pool_name || (p.pool ? p.pool.slice(0, 8) : 'LP'));
      const sym = rawSym.replace(/^SIM-/, '');
      closedPositions.push({
        sym,
        pct: null, usd, reason: p.close_reason || '', ts, bot: '💧',
      });
    } else {
      openCount += 1;
      // Prefer the bot's persisted live mark-to-market snapshot (live_*) so this matches
      // /positions exactly. Fall back to fees-only if a management cycle hasn't run yet.
      const hasLive = Number.isFinite(Number(p.live_pnl_usd));
      const feeUsd = Number(p.accumulated_fees_usd || 0);
      const pnlUsd = hasLive ? Number(p.live_pnl_usd) : feeUsd;
      const valueUsd = Number.isFinite(Number(p.live_value_usd)) ? Number(p.live_value_usd) : null;
      const pct = Number.isFinite(Number(p.live_pnl_pct)) ? Number(p.live_pnl_pct) : null;
      const inRange = (p.live_in_range === undefined) ? null : !!p.live_in_range;
      const rawSym = p.live_pair
        || (p.base_symbol && p.base_symbol !== 'TOKEN' ? `${p.base_symbol}-${p.quote_symbol || 'SOL'}` : null)
        || (p.pool_name || (p.pool ? p.pool.slice(0, 8) : 'LP'));
      const sym = rawSym.replace(/^SIM-/, '');
      unrealizedUsd += pnlUsd;
      positions.push({
        sym, pct, usd: pnlUsd, valueUsd, feeUsd, inRange,
        ageMin: Number.isFinite(Number(p.live_age_min)) ? Number(p.live_age_min) : null,
        sizeSol: Number(p.amount_sol_y) || null, bot: '💧',
      });
    }
  }
  closedPositions.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  return {
    name: 'Meridian',
    emoji: '💧',
    unit: 'DLMM LP',
    startUsd: START_USD_PER_BOT,
    realizedUsd,
    balanceUsd: START_USD_PER_BOT + realizedUsd,
    openCount,
    unrealizedUsd,
    wins, winUsd, losses, lossUsd,
    positions,
    closedPositions,
    days,
  };
}

function combine(a, b) {
  const days = {};
  for (const src of [a.days, b.days]) {
    for (const [d, v] of Object.entries(src)) {
      if (!days[d]) days[d] = { usd: 0, sol: 0, trades: 0 };
      days[d].usd += v.usd;
      days[d].sol += v.sol || 0;
      days[d].trades += v.trades || 0;
    }
  }
  return {
    name: 'Combined',
    emoji: '📊',
    unit: 'both bots',
    startUsd: a.startUsd + b.startUsd,
    realizedUsd: a.realizedUsd + b.realizedUsd,
    balanceUsd: a.balanceUsd + b.balanceUsd,
    openCount: a.openCount + b.openCount,
    unrealizedUsd: a.unrealizedUsd + b.unrealizedUsd,
    wins: (a.wins || 0) + (b.wins || 0),
    winUsd: (a.winUsd || 0) + (b.winUsd || 0),
    losses: (a.losses || 0) + (b.losses || 0),
    lossUsd: (a.lossUsd || 0) + (b.lossUsd || 0),
    positions: [...(a.positions || []), ...(b.positions || [])],
    closedPositions: [...(a.closedPositions || []), ...(b.closedPositions || [])],
    days,
  };
}

async function buildPayload() {
  const solPrice = await getSolPrice();
  const charon = charonData(solPrice);
  const meridian = meridianData(solPrice);
  const combined = combine(charon, meridian);
  return {
    solPrice,
    generatedAt: Date.now(),
    bots: { combined, charon, meridian },
  };
}

// Tiny server-side payload cache so a 5s UI poll (×N open tabs) doesn't spawn the sqlite3 CLI
// more than ~once per 2.5s. Source data (Charon last_mcap @10s, Meridian live_* @30s) is fresher
// than this, so 2.5s adds no perceptible staleness while halving DB/exec load at the new poll rate.
let _payloadCache = { at: 0, value: null };
async function cachedPayload() {
  if (_payloadCache.value && Date.now() - _payloadCache.at < 2500) return _payloadCache.value;
  const value = await buildPayload();
  _payloadCache = { at: Date.now(), value };
  return value;
}

// ---------- HTTP ----------
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`);
  if (ACCESS_TOKEN) {
    const t = u.searchParams.get('token') || req.headers['x-access-token'];
    if (t !== ACCESS_TOKEN) {
      res.writeHead(401, { 'Content-Type': 'text/plain' });
      return res.end('Unauthorized — append ?token=YOUR_TOKEN');
    }
  }
  if (u.pathname === '/api/data') {
    try {
      const payload = await cachedPayload();
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify(payload));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }
  if (u.pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('ok');
  }
  if (u.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(HTML);
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
});

server.listen(PORT, HOST, () => {
  console.log(`[pnl-dashboard] listening on http://${HOST}:${PORT} (token=${ACCESS_TOKEN ? 'on' : 'off'})`);
});

// ---------- Frontend (single page, dark, calendar) ----------
const HTML = String.raw`<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1"/>
<title>PnL Calendar — Charon × Meridian</title>
<style>
  :root{
    --bg:#0a0e0d; --panel:#111714; --panel2:#0d1310; --line:#1d2622;
    --txt:#e7f0ec; --muted:#7d8f88; --green:#2fe28a; --greenDim:#1a7a4f;
    --green1:#0f2a1f; --green2:#11402c; --green3:#155f3f; --red:#ff5d6c; --red1:#2a1216;
    --amber:#ffb648; --amberCell:#3a2a12; --gray:#161d1a;
  }
  *{box-sizing:border-box}
  body{margin:0;background:
      radial-gradient(1200px 600px at 80% -10%, #10201a 0%, transparent 60%),
      var(--bg);
    color:var(--txt);font:14px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
    -webkit-font-smoothing:antialiased;padding:18px;max-width:1040px;margin:0 auto;}
  .layout{display:grid;grid-template-columns:1fr 340px;gap:16px;align-items:start}
  .col-right{position:sticky;top:18px}
  @media(max-width:820px){
    .layout{grid-template-columns:1fr}
    .col-right{position:static}
  }
  .head{display:flex;align-items:center;gap:10px;margin-bottom:14px;flex-wrap:wrap}
  .title{font-size:20px;font-weight:700;letter-spacing:.3px}
  .badge{font-size:11px;color:var(--muted);border:1px solid var(--line);padding:2px 8px;border-radius:20px}
  .tabs{display:flex;gap:6px;margin-left:auto}
  .tab{cursor:pointer;font-size:12px;padding:6px 12px;border-radius:20px;border:1px solid var(--line);
    background:var(--panel2);color:var(--muted);user-select:none}
  .tab.on{background:linear-gradient(180deg,#13402b,#0e2c1e);color:var(--green);border-color:#1e5238}
  .card{background:linear-gradient(180deg,var(--panel),var(--panel2));border:1px solid var(--line);
    border-radius:16px;padding:16px 18px;margin-bottom:14px}
  .total{font-size:34px;font-weight:800;letter-spacing:.5px}
  .total.pos{color:var(--green)} .total.neg{color:var(--red)}
  .sub{display:flex;justify-content:space-between;margin-top:10px;font-size:12.5px}
  .sub .l{color:var(--green)} .sub .r{color:var(--red)}
  .livehdr{display:flex;align-items:center;justify-content:space-between;margin-bottom:4px}
  .lh-title{font-size:13px;font-weight:700;letter-spacing:.3px}
  .lh-title .dot{width:7px;height:7px;border-radius:50%;display:inline-block;margin-right:6px;
    background:var(--green);box-shadow:0 0 8px #2fe28a;vertical-align:middle;animation:pulse 1.6s infinite}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}
  .lh-unreal{font-size:18px;font-weight:800}
  .lh-unreal.pos{color:var(--green)} .lh-unreal.neg{color:var(--red)}
  .pos-list{display:flex;flex-direction:column;gap:6px;margin-top:8px}
  .sec-label{display:flex;align-items:center;justify-content:space-between;font-size:11px;
    text-transform:uppercase;letter-spacing:.6px;color:var(--muted);margin:14px 0 2px;font-weight:700}
  .sec-label.first{margin-top:10px}
  .sec-label .cnt{color:var(--muted);font-weight:600}
  .sec-label.running{color:#7fe3b4} .sec-label.closed{color:#9aa8a2}
  .pos-row{display:flex;align-items:center;justify-content:space-between;padding:8px 11px;border-radius:10px;
    background:var(--panel2);border:1px solid var(--line)}
  .pos-row .sym{font-weight:600}
  .pos-row .pct{font-size:11.5px;color:var(--muted);margin-left:7px}
  .pos-row .reason{font-size:10px;color:var(--muted);margin-left:7px;text-transform:uppercase;letter-spacing:.4px}
  .pos-row .oor{font-size:9.5px;font-weight:700;color:#f0b24a;background:#3a2a10;border:1px solid #5a4015;
    border-radius:5px;padding:1px 5px;margin-left:7px;text-transform:uppercase;letter-spacing:.4px}
  .pos-row .valwrap{display:flex;flex-direction:column;align-items:flex-end;line-height:1.25}
  .pos-row .val2{font-size:10.5px;color:var(--muted);font-weight:600}
  .pos-row .val{font-weight:700;font-size:13px}
  .pos-row.pos{border-color:#1c4a33} .pos-row.pos .val{color:var(--green)}
  .pos-row.neg{background:var(--red1);border-color:#5a2230} .pos-row.neg .val{color:var(--red)}
  .pos-row.closed{opacity:.82}
  .pos-empty{color:var(--muted);font-size:12px;text-align:center;padding:8px}
  .bar{height:5px;border-radius:6px;background:#0c1612;margin-top:10px;overflow:hidden}
  .bar > i{display:block;height:100%;background:linear-gradient(90deg,#1f9d5c,var(--green));border-radius:6px}
  .stats{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-top:14px}
  .stat{background:var(--panel2);border:1px solid var(--line);border-radius:12px;padding:10px}
  .stat .k{font-size:10.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px}
  .stat .v{font-size:16px;font-weight:700;margin-top:3px}
  .nav{display:flex;align-items:center;justify-content:center;gap:14px;margin:6px 0 12px}
  .nav button{background:var(--panel2);border:1px solid var(--line);color:var(--txt);
    width:34px;height:34px;border-radius:10px;font-size:16px;cursor:pointer}
  .nav .mlabel{font-weight:600;min-width:150px;text-align:center}
  .grid{display:grid;grid-template-columns:repeat(7,1fr);gap:7px}
  .dow{font-size:11px;color:var(--muted);text-align:center;padding-bottom:2px}
  .cell{aspect-ratio:1/1;border-radius:11px;background:var(--gray);border:1px solid var(--line);
    position:relative;padding:6px;display:flex;flex-direction:column;justify-content:center;align-items:center;
    overflow:hidden}
  .cell .dnum{position:absolute;top:5px;left:7px;font-size:10.5px;color:var(--muted)}
  .cell .amt{font-size:12.5px;font-weight:700;margin-top:6px}
  .cell.empty{background:transparent;border-color:transparent}
  .cell.zero{background:var(--gray)} .cell.zero .amt{color:#3f4b46}
  .cell.pos{border-color:#1c4a33} .cell.pos .amt{color:var(--green)}
  .cell.neg{background:var(--red1);border-color:#5a2230} .cell.neg .amt{color:var(--red)}
  .cell.best{background:linear-gradient(180deg,#3a2a12,#2a1f0d);border-color:#6b4d1d}
  .cell.best .amt{color:var(--amber)}
  .cell.today{outline:2px solid #2fe28a55;outline-offset:1px}
  .g1{background:#0f2a1f}.g2{background:#11402c}.g3{background:#155f3f}.g4{background:#1a7a4f}
  .foot{display:flex;justify-content:space-between;color:var(--muted);font-size:11px;margin-top:10px}
  .dot{width:7px;height:7px;border-radius:50%;display:inline-block;margin-right:5px;vertical-align:middle}
  .live{color:var(--green)} .live .dot{background:var(--green);box-shadow:0 0 8px #2fe28a}
  .live .dot.pulse{animation:flash .55s ease-out}
  @keyframes flash{0%{transform:scale(2.4);box-shadow:0 0 14px #2fe28a}100%{transform:scale(1);box-shadow:0 0 8px #2fe28a}}
  a{color:var(--green)}
</style>
</head>
<body>
  <div class="head">
    <div class="title">PnL Calendar</div>
    <span class="badge" id="solbadge">SOL —</span>
    <div class="tabs" id="tabs">
      <div class="tab on" data-bot="combined">Combined</div>
      <div class="tab" data-bot="charon">🎯 Charon</div>
      <div class="tab" data-bot="meridian">💧 Meridian</div>
    </div>
  </div>

  <div class="layout">
    <div class="col-left">
      <div class="card">
        <div class="total pos" id="total">$0.00</div>
        <div class="bar"><i id="bar" style="width:0%"></i></div>
        <div class="sub">
          <span class="l" id="winsum">0 / $0</span>
          <span class="r" id="losssum">0 / $0</span>
        </div>
        <div class="stats">
          <div class="stat"><div class="k">Balance</div><div class="v" id="balance">$0</div></div>
          <div class="stat"><div class="k">ROI</div><div class="v" id="roi">0%</div></div>
          <div class="stat"><div class="k">Win days</div><div class="v" id="winrate">0%</div></div>
          <div class="stat"><div class="k">Open / Unreal</div><div class="v" id="open">0</div></div>
        </div>
      </div>

      <div class="nav">
        <button id="prev">‹</button>
        <div class="mlabel" id="mlabel">—</div>
        <button id="next">›</button>
      </div>

      <div class="grid" id="dow"></div>
      <div class="grid" id="cal" style="margin-top:7px"></div>

      <div class="foot">
        <span class="live"><span class="dot"></span><span id="livetxt">live · auto-refresh 5s</span></span>
        <span id="gen">—</span>
      </div>
    </div>

    <div class="col-right">
      <div class="card">
        <div class="livehdr">
          <div class="lh-title"><span class="dot"></span>Realtime</div>
          <div class="lh-unreal pos" id="rt-equity">$0.00</div>
        </div>

        <div class="sec-label running first">
          <span>🟢 Running (open)</span>
          <span class="cnt"><span id="rt-opencnt">0</span> · <span id="rt-unreal">$0</span></span>
        </div>
        <div class="pos-list" id="poslist-open"></div>

        <div class="sec-label closed">
          <span>✅ Closed (realized)</span>
          <span class="cnt"><span id="rt-wl">0W / 0L</span> · <span id="rt-realized">$0</span></span>
        </div>
        <div class="pos-list" id="poslist-closed"></div>
      </div>
    </div>
  </div>

<script>
const MONTHS=['Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'];
const DOW=['S','S','R','K','J','S','M']; // Senin-first (Sen Sel Rab Kam Jum Sab Min)
let DATA=null, BOT='combined';
const TZ_OFFSET_MS=7*3600*1000; // WIB (UTC+7) — kalender berganti hari di tengah malam WIB, bukan UTC
const now=new Date(Date.now()+TZ_OFFSET_MS); // baca getUTC* di atas Date yang sudah digeser = jam dinding WIB
let curY=now.getUTCFullYear(), curM=now.getUTCMonth();

function fmt(n){const s=n<0?'-':(n>0?'+':'');return s+'$'+Math.abs(n).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});}
function fmtShort(n){if(n===0)return '$0';const s=n<0?'-$':'+$';return s+Math.abs(n).toLocaleString('en-US',{maximumFractionDigits:2});}

async function load(){
  try{
    const r=await fetch('/api/data'+location.search,{cache:'no-store'});
    DATA=await r.json();
    document.getElementById('solbadge').textContent='SOL $'+Number(DATA.solPrice).toFixed(2);
    lastLoadAt=Date.now();
    tickFreshness();
    document.getElementById('livetxt').textContent='live · auto-refresh 5s';
    render();
    // brief pulse so a refresh is visibly noticeable
    const dot=document.querySelector('.live .dot');
    if(dot){dot.classList.remove('pulse');void dot.offsetWidth;dot.classList.add('pulse');}
  }catch(e){ document.getElementById('livetxt').textContent='offline — retrying'; }
}

// per-second freshness ticker — shows how long ago the last successful fetch landed,
// so the panel reads as LIVE between the 5s polls (no extra network/compute).
let lastLoadAt=0;
function tickFreshness(){
  if(!lastLoadAt){document.getElementById('gen').textContent='connecting…';return;}
  const s=Math.round((Date.now()-lastLoadAt)/1000);
  document.getElementById('gen').textContent = s<=1 ? 'updated just now' : 'updated '+s+'s ago';
}

function render(){
  if(!DATA)return;
  const bot=DATA.bots[BOT];
  const days=bot.days||{};
  // month grid
  const first=new Date(Date.UTC(curY,curM,1));
  const startDow=(first.getUTCDay()+6)%7; // Monday=0
  const daysInMonth=new Date(Date.UTC(curY,curM+1,0)).getUTCDate();
  document.getElementById('mlabel').textContent=MONTHS[curM]+' '+curY+' · WIB';

  // summary for THIS month
  let total=0,wins=0,winUsd=0,losses=0,lossUsd=0,best=null,bestv=-1e9;
  const tracked=[];
  for(let dd=1;dd<=daysInMonth;dd++){
    const key=curY+'-'+String(curM+1).padStart(2,'0')+'-'+String(dd).padStart(2,'0');
    const v=days[key]?days[key].usd:0;
    tracked.push({dd,key,v,has:!!days[key]});
    total+=v;
    if(v>0.0001){wins++;winUsd+=v; if(v>bestv){bestv=v;best=dd;}}
    else if(v<-0.0001){losses++;lossUsd+=v;}
  }
  const t=document.getElementById('total');
  t.textContent=fmt(total); t.className='total '+(total>=0?'pos':'neg');
  document.getElementById('bar').style.width=Math.min(100,Math.abs(total)/Math.max(1,(winUsd-lossUsd))*100)+'%';
  document.getElementById('winsum').textContent=wins+' / '+fmtShort(winUsd);
  document.getElementById('losssum').textContent=losses+' / '+fmtShort(lossUsd);

  // global stats (not month-bound)
  document.getElementById('balance').textContent=fmtShort(bot.balanceUsd).replace('+','');
  const roi=((bot.balanceUsd-bot.startUsd)/bot.startUsd*100);
  const roiEl=document.getElementById('roi');
  roiEl.textContent=(roi>=0?'+':'')+roi.toFixed(1)+'%';
  roiEl.style.color=roi>=0?'var(--green)':'var(--red)';
  const tradedDays=wins+losses;
  document.getElementById('winrate').textContent=tradedDays?Math.round(wins/tradedDays*100)+'%':'—';
  document.getElementById('open').textContent=bot.openCount+' · '+fmtShort(bot.unrealizedUsd);

  // ---- Realtime panel: split into RUNNING (open, unrealized) vs CLOSED (realized W/L) ----
  const rw=bot.wins||0, rl=bot.losses||0;
  const unreal=bot.unrealizedUsd||0, realized=bot.realizedUsd||0;
  // header shows live equity = realized + unrealized (the true "where am I right now")
  const eq=realized+unreal;
  const eqEl=document.getElementById('rt-equity');
  eqEl.textContent=fmt(eq);
  eqEl.className='lh-unreal '+(eq>=0?'pos':'neg');

  // section label counters
  document.getElementById('rt-opencnt').textContent=(bot.openCount||0)+' pos';
  const ruEl=document.getElementById('rt-unreal');
  ruEl.textContent=fmt(unreal); ruEl.style.color=unreal>=0?'var(--green)':'var(--red)';
  document.getElementById('rt-wl').textContent=rw+'W / '+rl+'L';
  const rrEl=document.getElementById('rt-realized');
  rrEl.textContent=fmt(realized); rrEl.style.color=realized>=0?'var(--green)':'var(--red)';

  const rowHtml=(p,closed)=>{
    const cls=(p.usd>=0?'pos':'neg')+(closed?' closed':'');
    const pct=(p.pct==null)?'':'<span class="pct">'+(p.pct>=0?'+':'')+p.pct.toFixed(1)+'%</span>';
    const reason=(closed&&p.reason)?'<span class="reason">'+p.reason+'</span>':'';
    const oor=(!closed&&p.inRange===false)?'<span class="oor">OOR</span>':'';
    // open LP rows carry a live position value — show it small under the PnL
    const val2=(!closed&&p.valueUsd!=null)?'<span class="val2">$'+Number(p.valueUsd).toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2})+'</span>':'';
    return '<div class="pos-row '+cls+'"><div><span class="sym">'+p.bot+' '+p.sym+'</span>'+pct+oor+reason+'</div>'+
           '<div class="valwrap"><span class="val">'+fmt(p.usd)+'</span>'+val2+'</div></div>';
  };

  const openList=document.getElementById('poslist-open');
  const ps=bot.positions||[];
  openList.innerHTML=ps.length?ps.map(p=>rowHtml(p,false)).join(''):'<div class="pos-empty">Tidak ada posisi running</div>';

  const closedList=document.getElementById('poslist-closed');
  const cs=bot.closedPositions||[];
  closedList.innerHTML=cs.length?cs.map(p=>rowHtml(p,true)).join(''):'<div class="pos-empty">Belum ada yang closed</div>';

  // dow header
  document.getElementById('dow').innerHTML=DOW.map(d=>'<div class="dow">'+d+'</div>').join('');

  // cells
  let html='';
  for(let i=0;i<startDow;i++) html+='<div class="cell empty"></div>';
  const todayKey=now.getUTCFullYear()+'-'+String(now.getUTCMonth()+1).padStart(2,'0')+'-'+String(now.getUTCDate()).padStart(2,'0');
  for(const c of tracked){
    let cls='cell';
    if(!c.has || Math.abs(c.v)<0.0001) cls+=' zero';
    else if(c.v>0) cls+=' pos';
    else cls+=' neg';
    if(c.dd===best && bestv>0) cls='cell best';
    if(c.key===todayKey) cls+=' today';
    const amt=(!c.has||Math.abs(c.v)<0.0001)?'$0':fmtShort(c.v);
    html+='<div class="'+cls+'"><span class="dnum">'+c.dd+'</span><span class="amt">'+amt+'</span></div>';
  }
  document.getElementById('cal').innerHTML=html;
}

document.getElementById('tabs').addEventListener('click',e=>{
  const t=e.target.closest('.tab'); if(!t)return;
  BOT=t.dataset.bot;
  [...document.querySelectorAll('.tab')].forEach(x=>x.classList.toggle('on',x===t));
  render();
});
document.getElementById('prev').onclick=()=>{curM--;if(curM<0){curM=11;curY--;}render();};
document.getElementById('next').onclick=()=>{curM++;if(curM>11){curM=0;curY++;}render();};

load();
setInterval(load,5000);           // poll /api/data every 5s (was 20s)
setInterval(tickFreshness,1000);   // per-second "updated Ns ago" ticker
</script>
</body>
</html>`;
