import fs from 'fs';
import path from 'path';

const STORE = path.join(process.cwd(), 'sim-positions.json');
let cache = null;

function load() {
  if (cache) return cache;
  if (fs.existsSync(STORE)) {
    try { cache = JSON.parse(fs.readFileSync(STORE, 'utf8')); }
    catch { cache = { positions: {} }; }
  } else cache = { positions: {} };
  return cache;
}
function save() {
  // Atomic write: temp file + rename to avoid truncation if process crashes mid-write.
  const tmp = STORE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
  fs.renameSync(tmp, STORE);
}

function fakeAddr(prefix) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz123456789';
  let r = prefix;
  while (r.length < 44) r += chars[Math.floor(Math.random() * chars.length)];
  return r;
}

export function simAddPosition(p) {
  const store = load();
  const addr = fakeAddr('SIM');
  store.positions[addr] = {
    position: addr,
    pool: p.pool_address,
    pool_name: p.pool_name || p.pool_address.slice(0, 8),
    base_mint: p.base_mint,
    base_symbol: p.base_symbol || 'TOKEN',
    quote_mint: p.quote_mint,
    quote_symbol: p.quote_symbol || 'SOL',
    amount_sol_y: Number(p.amount_sol),
    lower_bin: p.lower_bin,
    upper_bin: p.upper_bin,
    active_bin_at_deploy: p.active_bin_at_deploy,
    active_price_at_deploy: Number(p.active_price_at_deploy),
    strategy: p.strategy,
    bin_step: p.bin_step,
    base_fee_pct: Number(p.base_fee_pct || 0.5),
    pool_volume_24h_usd: Number(p.pool_volume_24h || 0),
    pool_tvl_usd: Number(p.pool_tvl_usd || 0),
    sol_price_at_deploy: Number(p.sol_price_usd || 82),
    deployed_at: Date.now(),
    last_fee_accrual_at: Date.now(),
    accumulated_fees_sol: 0,
    accumulated_fees_usd: 0,
    total_claimed_sol: 0,
    total_claimed_usd: 0,
    closed: false,
  };
  save();
  return addr;
}

export function simGet(addr) { return load().positions[addr] || null; }
export function simList({ openOnly = true } = {}) {
  const store = load();
  return Object.values(store.positions).filter(p => openOnly ? !p.closed : true);
}
export function simUpdate(addr, patch) {
  const store = load();
  if (!store.positions[addr]) return false;
  store.positions[addr] = { ...store.positions[addr], ...patch };
  save();
  return true;
}

// Approximate fee accrual based on pool real-time data
export function simAccrueFees(addr, pool) {
  // pool: { volume_24h_usd, tvl_usd, active_bin_id, active_price, sol_price_usd }
  const pos = simGet(addr);
  if (!pos || pos.closed) return null;
  const now = Date.now();
  const minutesElapsed = (now - pos.last_fee_accrual_at) / 60000;
  if (minutesElapsed < 0.5) return pos;

  const inRange = pool.active_bin_id != null
    && pool.active_bin_id >= pos.lower_bin
    && pool.active_bin_id <= pos.upper_bin;

  if (!inRange) {
    simUpdate(addr, { last_fee_accrual_at: now });
    return simGet(addr);
  }

  const ourAmountUsd = pos.amount_sol_y * (pool.sol_price_usd || pos.sol_price_at_deploy);
  const rangeBins = Math.max(pos.upper_bin - pos.lower_bin + 1, 35);
  const approxActiveBinTvlUsd = (pool.tvl_usd || pos.pool_tvl_usd) / rangeBins;
  const ourShare = Math.min(1, ourAmountUsd / Math.max(approxActiveBinTvlUsd, ourAmountUsd));

  const dailyVolumeUsd = pool.volume_24h_usd || pos.pool_volume_24h_usd;
  const dailyFeesUsd = dailyVolumeUsd * (pos.base_fee_pct / 100);
  const feesPerMinUsd = dailyFeesUsd / (24 * 60);
  const gainedUsd = feesPerMinUsd * ourShare * minutesElapsed;
  const gainedSol = gainedUsd / (pool.sol_price_usd || pos.sol_price_at_deploy);

  simUpdate(addr, {
    last_fee_accrual_at: now,
    accumulated_fees_sol: pos.accumulated_fees_sol + gainedSol,
    accumulated_fees_usd: pos.accumulated_fees_usd + gainedUsd,
  });
  return simGet(addr);
}

export function simClaim(addr) {
  const pos = simGet(addr);
  if (!pos) return null;
  const claimedSol = pos.accumulated_fees_sol;
  const claimedUsd = pos.accumulated_fees_usd;
  simUpdate(addr, {
    accumulated_fees_sol: 0,
    accumulated_fees_usd: 0,
    total_claimed_sol: pos.total_claimed_sol + claimedSol,
    total_claimed_usd: pos.total_claimed_usd + claimedUsd,
  });
  return { claimed_sol: claimedSol, claimed_usd: claimedUsd };
}

export function simClose(addr, reason) {
  const pos = simGet(addr);
  if (!pos) return null;
  simUpdate(addr, { closed: true, closed_at: Date.now(), close_reason: reason || 'closed' });
  return simGet(addr);
}

export function computePriceBasedPnlPct(pos, currentPrice) {
  if (!pos.active_price_at_deploy || !currentPrice) return 0;
  return ((currentPrice / pos.active_price_at_deploy) - 1) * 100;
}

// SIM_WALLET_FIX: derive honest dry-run wallet state from sim positions instead of a
// frozen constant. Free-cash semantics (matches live Helius "available SOL"):
//   free = baseSol − Σ(open principals, locked) + Σ(realized_pnl_sol of closed)
// Also returns locked + unrealized fee accrual so callers can show a fuller picture.
export function computeSimWalletState(baseSol = 1.0) {
  const store = load();
  let locked = 0;       // principal tied up in open positions
  let realized = 0;     // realized PnL (price + fees) from closed positions
  let unrealizedFeesSol = 0; // accrued-but-unclaimed fees on open positions
  let openCount = 0;
  let closedCount = 0;
  for (const p of Object.values(store.positions)) {
    if (p.closed) {
      closedCount++;
      realized += Number(p.realized_pnl_sol || 0);
    } else {
      openCount++;
      locked += Number(p.amount_sol_y || 0);
      unrealizedFeesSol += Number(p.accumulated_fees_sol || 0);
    }
  }
  const free = baseSol - locked + realized;
  return {
    base_sol: baseSol,
    locked_sol: Number(locked.toFixed(6)),
    realized_pnl_sol: Number(realized.toFixed(6)),
    unrealized_fees_sol: Number(unrealizedFeesSol.toFixed(6)),
    free_sol: Number(free.toFixed(6)),
    open_count: openCount,
    closed_count: closedCount,
  };
}
