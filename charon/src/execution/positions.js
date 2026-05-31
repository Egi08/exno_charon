import { now, json } from '../utils.js';
import { numSetting, boolSetting, strategyById } from '../db/settings.js';
import { db } from '../db/connection.js';
import { firstPositiveNumber, marketCapFromGmgn, tokenPriceFromGmgn } from '../utils.js';
import { fetchGmgnTokenInfo } from '../enrichment/gmgn.js';
import { fetchJupiterAsset, fetchJupiterHolders, fetchJupiterChartContext, fetchJupiterWalletPnl } from '../enrichment/jupiter.js';
import { liveWalletPubkey } from '../liveExecutor.js';
import { fetchSavedWalletExposure } from '../enrichment/wallets.js';
import { filterCandidate } from '../pipeline/candidateBuilder.js';
import { openPositions } from '../db/positions.js';
import { updateCandidateSnapshot } from '../db/candidates.js';
import { trending } from '../signals/trending.js';
import { executeLiveSell } from './router.js';
import { sendPositionExit } from '../telegram/send.js';
import { runPostmortem } from '../learning/postmortem.js';
import { trailingArmThreshold, maxHoldExit, breakevenFloorHit, effectiveExitParams } from './exitLadder.js';

export async function freshEntryMarket(mint, candidate) {
  const gmgn = await fetchGmgnTokenInfo(mint, false);
  const asset = await fetchJupiterAsset(mint, { useCache: false });
  const priceUsd = firstPositiveNumber(tokenPriceFromGmgn(gmgn), asset?.usdPrice, candidate.metrics?.priceUsd);
  const marketCapUsd = firstPositiveNumber(
    marketCapFromGmgn(gmgn),
    asset?.mcap,
    asset?.fdv,
    candidate.metrics?.marketCapUsd,
    candidate.metrics?.graduatedMarketCapUsd,
  );
  return { gmgn, asset, priceUsd, marketCapUsd, refreshedAtMs: now() };
}

export async function refreshCandidateForExecution(row) {
  const candidate = row.candidate;
  const mint = candidate.token.mint;
  const gmgn = await fetchGmgnTokenInfo(mint, false);
  const asset = await fetchJupiterAsset(mint, { useCache: false });
  const holders = await fetchJupiterHolders(mint);
  const chart = await fetchJupiterChartContext(mint);
  const selectedTrending = trending.get(mint) || candidate.trending || null;
  const selectedHolders = holders?.holders?.length ? holders : candidate.holders;
  const selectedSavedWalletExposure = selectedHolders
    ? await fetchSavedWalletExposure(mint, selectedHolders)
    : candidate.savedWalletExposure;
  const priceUsd = firstPositiveNumber(tokenPriceFromGmgn(gmgn), asset?.usdPrice, selectedTrending?.price, candidate.metrics?.priceUsd);
  const marketCapUsd = firstPositiveNumber(
    marketCapFromGmgn(gmgn),
    asset?.mcap,
    asset?.fdv,
    selectedTrending?.market_cap,
    candidate.metrics?.marketCapUsd,
    candidate.metrics?.graduatedMarketCapUsd,
  );
  const refreshed = {
    ...candidate,
    token: {
      ...candidate.token,
      name: gmgn?.name || asset?.name || selectedTrending?.name || candidate.token.name,
      symbol: gmgn?.symbol || asset?.symbol || selectedTrending?.symbol || candidate.token.symbol,
      twitter: candidate.token.twitter || asset?.twitter || gmgn?.link?.twitter_username || selectedTrending?.twitter || '',
      website: candidate.token.website || asset?.website || gmgn?.link?.website || '',
      telegram: candidate.token.telegram || gmgn?.link?.telegram || '',
    },
    metrics: {
      ...candidate.metrics,
      priceUsd,
      marketCapUsd,
      liquidityUsd: Number(gmgn?.liquidity ?? asset?.liquidity ?? selectedTrending?.liquidity ?? candidate.metrics?.liquidityUsd ?? 0),
      holderCount: Number(gmgn?.holder_count ?? asset?.holderCount ?? selectedTrending?.holder_count ?? candidate.metrics?.holderCount ?? 0),
      gmgnTotalFeesSol: Number(gmgn?.total_fee ?? asset?.fees ?? candidate.metrics?.gmgnTotalFeesSol ?? 0),
      gmgnTradeFeesSol: Number(gmgn?.trade_fee ?? candidate.metrics?.gmgnTradeFeesSol ?? 0),
      trendingVolumeUsd: Number(selectedTrending?.volume ?? candidate.metrics?.trendingVolumeUsd ?? 0),
      trendingSwaps: Number(selectedTrending?.swaps ?? candidate.metrics?.trendingSwaps ?? 0),
      trendingHotLevel: Number(selectedTrending?.hot_level ?? candidate.metrics?.trendingHotLevel ?? 0),
      trendingSmartDegenCount: Number(selectedTrending?.smart_degen_count ?? candidate.metrics?.trendingSmartDegenCount ?? 0),
    },
    gmgn,
    jupiterAsset: asset,
    trending: selectedTrending,
    holders: selectedHolders,
    chart,
    savedWalletExposure: selectedSavedWalletExposure,
    executionRefresh: {
      refreshedAtMs: now(),
      source: 'pre_execution',
      marketCapUsd,
      priceUsd,
      liquidityUsd: Number(gmgn?.liquidity ?? asset?.liquidity ?? selectedTrending?.liquidity ?? 0),
      holdersRefreshed: Boolean(holders?.holders?.length),
    },
  };
  refreshed.filters = filterCandidate(refreshed);
  const executionFailures = [];
  if (!Number.isFinite(Number(refreshed.metrics.marketCapUsd)) || Number(refreshed.metrics.marketCapUsd) <= 0) {
    executionFailures.push('execution mcap: missing');
  }
  if (!Number.isFinite(Number(refreshed.metrics.priceUsd)) || Number(refreshed.metrics.priceUsd) <= 0) {
    executionFailures.push('execution price: missing');
  }
  if (executionFailures.length) {
    refreshed.filters = {
      ...refreshed.filters,
      passed: false,
      failures: [...(refreshed.filters?.failures || []), ...executionFailures],
    };
  }
  updateCandidateSnapshot(row.id, refreshed, refreshed.filters.passed ? 'candidate' : 'filtered');
  return { ...row, candidate: refreshed };
}

const sellInProgress = new Set();

export async function refreshPosition(position, { autoExit = true, jupiterPnl = null } = {}) {
  const asset = await fetchJupiterAsset(position.mint);
  const price = firstPositiveNumber(asset?.usdPrice, position.high_water_price, position.entry_price);
  const mcap = firstPositiveNumber(asset?.mcap, asset?.fdv, position.high_water_mcap, position.entry_mcap);
  if (!Number.isFinite(Number(mcap)) || !Number.isFinite(Number(position.entry_mcap)) || Number(position.entry_mcap) <= 0) {
    return null;
  }
  const highWaterMcap = Math.max(Number(position.high_water_mcap || 0), Number(mcap));
  const highWaterPrice = Math.max(Number(position.high_water_price || 0), Number(price || 0));
  let pnlPercent = (Number(mcap) / Number(position.entry_mcap) - 1) * 100;
  let pnlSol = Number(position.size_sol) * pnlPercent / 100;
  if (jupiterPnl && Number.isFinite(Number(jupiterPnl.totalPnlPercentageNative))) {
    pnlPercent = Number(jupiterPnl.totalPnlPercentageNative);
    pnlSol = Number.isFinite(Number(jupiterPnl.totalPnlNative)) ? Number(jupiterPnl.totalPnlNative) : pnlSol;
  }
  // FIX_TDZ: strat MUST be declared before any use below (stages/trailing_tight_percent read it).
  // It was previously declared ~20 lines lower (at the max-hold check), so every poll threw
  // `ReferenceError: Cannot access 'strat' before initialization` (const TDZ — optional chaining
  // does NOT save you, the binding resolution itself throws). That error was swallowed by the
  // monitorPositions().catch(), so NO exit (SL/TP/trailing) ever ran for an open position.
  const strat = strategyById(position.strategy_id);
  // FIX_CONFIG_PROPAGATION: resolve SL/TP/trailing from the LIVE strategy config by default, so a
  // config change/restore reaches already-OPEN positions on the next poll (not just new entries).
  // A manual per-position override (exit_overridden=1, set when the user edits via Telegram) still
  // pins the snapshot and wins. Previously these read the frozen per-position snapshot, which
  // split-brained against the ladder/breakeven (those already read live `strat`) — the user saw
  // /positions showing tp50/sl-25/trail20 while the bot actually de-risked on the live ladder.
  const exitParams = effectiveExitParams(position, strat);
  const tpHit = pnlPercent >= Number(exitParams.tpPercent);
  const slHit = pnlPercent <= Number(exitParams.slPercent);
  // PYRAMID_PATCH: multi-stage partial TP + uncapped runner.
  // Stage 0 = nothing fired. Stage N = first N stages fired. After stage ≥ 1
  // trailing arms tighter; after final stage we ride sisanya with no TP cap,
  // exit ONLY via trailing or SL.
  const stage = Number(position.partial_tp_stage || 0);
  const stages = Array.isArray(strat?.partial_tp_stages) ? strat.partial_tp_stages : [];
  const finalStageReached = stages.length > 0 && stage >= stages.length;
  // After all stages fired, trailing tightens (default 10%) for runner protection.
  const tightTrailingPct = Number(strat?.trailing_tight_percent || 10);
  const effectiveTrailingPct = finalStageReached
    ? tightTrailingPct
    : Number(exitParams.trailingPercent || 15);
  // tp_percent acts as hard cap only if no stages configured. With stages,
  // trailing is the exit mechanism (uncapped upside).
  // FIX_RUNNER_CHOP: the early-arm threshold must scale with the ladder, not a hardcoded +15%.
  // With the first de-risk stage now at +30%, arming trailing at +15% (15% band) chopped the
  // runner on a normal climb-pullback BEFORE any profit was locked — the opposite of an uncapped
  // runner. Derive the pre-stage arm from the first stage's `at` (falls back to 15 when no stages
  // are configured, preserving legacy behavior). Below the first de-risk, the -20% SL is the floor;
  // we give the runner room to reach the first profit-lock instead of getting shaken out early.
  const firstStageAt = trailingArmThreshold(stages, 15);
  const trailingArmed = position.trailing_armed
    || (exitParams.trailingEnabled && tpHit)
    || (exitParams.trailingEnabled && stage >= 1)
    || (exitParams.trailingEnabled && pnlPercent >= firstStageAt);
  const trailDrop = highWaterMcap > 0 ? (Number(mcap) / highWaterMcap - 1) * 100 : 0;
  const trailingHit = trailingArmed && exitParams.trailingEnabled && trailDrop <= -Math.abs(effectiveTrailingPct);
  // BREAKEVEN FLOOR ("kalo sudah nyentuh +15% TRAILING_TP, jangan sampai minus lagi"):
  // once peak pnl ever reached the arm threshold (default = first ladder rung, +15%), a hard
  // floor at +breakeven_floor_percent (default +2%, buffers slippage/fees so realized stays
  // non-negative) is armed. If pnl falls back to that floor we exit NOW instead of waiting for
  // the wide trailing band to drag a low-peak token into the red (the DOGEUS/bowie/UCL round-
  // trips). Peak measured by mcap (monotonic, persisted) for consistency with high_water_mcap.
  const breakevenArmPct = Number(strat?.breakeven_arm_percent ?? firstStageAt);
  const breakevenFloorPct = Number(strat?.breakeven_floor_percent ?? 2);
  const highWaterPnlPercent = (Number(highWaterMcap) / Number(position.entry_mcap) - 1) * 100;
  const breakevenHit = breakevenFloorHit({
    highWaterPnlPercent,
    pnlPercent,
    armPercent: breakevenArmPct,
    floorPercent: breakevenFloorPct,
  });
  let exitReason = null;
  let closed = false;

  // BUG 9 fix: MAX_HOLD moved to LAST priority (see below). It must NOT pre-empt SL/trailing
  // (which mis-attributed real SL exits to MAX_HOLD) and must NEVER clip a green runner.

  // PYRAMID_PATCH: multi-stage partial TP. Each stage has {at: pct_threshold, sell: pct_size}.
  // Fires the next un-fired stage when pnlPercent crosses its threshold.
  // Stages should be ordered ascending by 'at'. Stage index stored in partial_tp_stage.
  if (!exitReason && stages.length > 0 && stage < stages.length) {
    const next = stages[stage];
    if (pnlPercent >= Number(next.at)) {
      const newStage = stage + 1;
      db.prepare('UPDATE dry_run_positions SET partial_tp_stage = ?, partial_tp_done = 1 WHERE id = ?')
        .run(newStage, position.id);
      console.log(`[position] ${position.id} partial TP stage ${newStage}/${stages.length} @ ${pnlPercent.toFixed(1)}% (sell ${next.sell}%)`);
      if (position.execution_mode === 'live' && position.token_amount_raw) {
        try {
          const sellAmount = Math.floor(Number(position.token_amount_raw) * (Number(next.sell) / 100));
          if (sellAmount > 0) {
            const sell = await executeLiveSell({ ...position, token_amount_raw: String(sellAmount) }, `PARTIAL_TP_${newStage}`);
            const remaining = Number(position.token_amount_raw) - sellAmount;
            db.prepare('UPDATE dry_run_positions SET token_amount_raw = ? WHERE id = ?').run(String(remaining), position.id);
            db.prepare(`
              INSERT INTO dry_run_trades (position_id, mint, side, at_ms, price, mcap, size_sol, token_amount_est, reason, payload_json)
              VALUES (?, ?, 'sell', ?, ?, ?, ?, ?, ?, ?)
            `).run(position.id, position.mint, now(), price, mcap,
              position.size_sol * (Number(next.sell) / 100), sellAmount, `PARTIAL_TP_${newStage}`,
              json({ pnlPercent, sell, partialSellPercent: Number(next.sell), remaining, stage: newStage, totalStages: stages.length }));
            console.log(`[position] ${position.id} stage ${newStage} sold ${sellAmount} tokens, ${remaining} remaining`);
          }
        } catch (err) {
          console.log(`[position] ${position.id} stage ${newStage} sell failed: ${err.message}`);
        }
      } else {
        // dry-run: still log a sell trade for analytics
        db.prepare(`
          INSERT INTO dry_run_trades (position_id, mint, side, at_ms, price, mcap, size_sol, token_amount_est, reason, payload_json)
          VALUES (?, ?, 'sell', ?, ?, ?, ?, ?, ?, ?)
        `).run(position.id, position.mint, now(), price, mcap,
          position.size_sol * (Number(next.sell) / 100), null, `PARTIAL_TP_${newStage}`,
          json({ pnlPercent, partialSellPercent: Number(next.sell), stage: newStage, totalStages: stages.length, dryRun: true }));
      }
    }
  }

  // LEGACY single-stage partial TP fallback (only if stages not configured)
  if (!exitReason && stages.length === 0 && strat?.partial_tp && !position.partial_tp_done && pnlPercent >= strat.partial_tp_at_percent) {
    db.prepare('UPDATE dry_run_positions SET partial_tp_done = 1 WHERE id = ?').run(position.id);
    console.log(`[position] ${position.id} partial TP at ${pnlPercent.toFixed(1)}% (${strat.partial_tp_sell_percent}% sell)`);
    if (position.execution_mode === 'live' && position.token_amount_raw) {
      try {
        const sellAmount = Math.floor(Number(position.token_amount_raw) * (strat.partial_tp_sell_percent / 100));
        if (sellAmount > 0) {
          const sell = await executeLiveSell({ ...position, token_amount_raw: String(sellAmount) }, 'PARTIAL_TP');
          const remaining = Number(position.token_amount_raw) - sellAmount;
          db.prepare('UPDATE dry_run_positions SET token_amount_raw = ? WHERE id = ?').run(String(remaining), position.id);
          db.prepare(`
            INSERT INTO dry_run_trades (position_id, mint, side, at_ms, price, mcap, size_sol, token_amount_est, reason, payload_json)
            VALUES (?, ?, 'sell', ?, ?, ?, ?, ?, 'PARTIAL_TP', ?)
          `).run(position.id, position.mint, now(), price, mcap,
            position.size_sol * (strat.partial_tp_sell_percent / 100), sellAmount,
            json({ pnlPercent, sell, partialSellPercent: strat.partial_tp_sell_percent, remaining }));
          console.log(`[position] ${position.id} partial TP sold ${sellAmount} tokens, ${remaining} remaining`);
        }
      } catch (err) {
        console.log(`[position] ${position.id} partial sell failed: ${err.message}`);
      }
    }
  }

  // Standard exit checks. With stages configured, tp_percent acts as TRAILING TRIGGER
  // not hard exit — exits happen via trailing only (uncapped runner) or SL.
  if (!exitReason) {
    if (slHit) exitReason = 'SL';
    else if (tpHit && !position.trailing_enabled && stages.length === 0) exitReason = 'TP';
    else if (breakevenHit) exitReason = 'BREAKEVEN';
    else if (trailingHit) exitReason = 'TRAILING_TP';
  }

  // BUG 9 fix: MAX_HOLD is evaluated LAST and only as a STALE-CAPITAL timeout — it frees money
  // stuck in a flat/dead position (no partial banked AND below the runner floor), and NEVER
  // force-closes a green/climbing position. A winner exits only via trailing or SL, never the clock.
  if (!exitReason && maxHoldExit({
    openedAtMs: position.opened_at_ms,
    nowMs: now(),
    maxHoldMs: strat?.max_hold_ms,
    pnlPercent,
    minPnlPercent: Number(strat?.max_hold_min_pnl_percent ?? 15),
    stage,
  })) {
    exitReason = 'MAX_HOLD';
  }

  // Live exits will override these with realized SOL values
  let finalPnlPercent = pnlPercent;
  let finalPnlSol = pnlSol;

  // FIX_PNL_STUCK: persist the CURRENT (last observed) mcap/price alongside high_water so the UI
  // can show live PnL, not the frozen peak. The exit logic above already used current `mcap`.
  db.prepare(`
    UPDATE dry_run_positions
    SET high_water_mcap = ?, high_water_price = ?, trailing_armed = ?,
        last_mcap = ?, last_price = ?, last_refreshed_at_ms = ?
    WHERE id = ?
  `).run(highWaterMcap, highWaterPrice, trailingArmed ? 1 : 0,
        Number(mcap), Number(price || 0), now(), position.id);

  if (exitReason && autoExit && position.execution_mode === 'live') {
    if (sellInProgress.has(position.id)) return { ...position, exitReason: null };
    sellInProgress.add(position.id);
    let sell;
    try {
      sell = await executeLiveSell(position, exitReason);
    } finally {
      sellInProgress.delete(position.id);
    }
    const receivedLamports = Number(sell.outputAmount || 0);
    const receivedSol = receivedLamports > 0 ? receivedLamports / 1_000_000_000 : null;
    if (receivedSol != null) {
      finalPnlSol = receivedSol - Number(position.size_sol);
      finalPnlPercent = (receivedSol / Number(position.size_sol) - 1) * 100;
    }
    db.prepare(`
      UPDATE dry_run_positions
      SET status = 'closed', closed_at_ms = ?, exit_price = ?, exit_mcap = ?, exit_reason = ?,
          pnl_percent = ?, pnl_sol = ?, exit_signature = ?
      WHERE id = ?
    `).run(now(), price, mcap, exitReason, finalPnlPercent, finalPnlSol, sell.signature, position.id);
    db.prepare(`
      INSERT INTO dry_run_trades (position_id, mint, side, at_ms, price, mcap, size_sol, token_amount_est, reason, payload_json)
      VALUES (?, ?, 'sell', ?, ?, ?, ?, ?, ?, ?)
    `).run(position.id, position.mint, now(), price, mcap, position.size_sol, position.token_amount_est, exitReason, json({ pnlPercent: finalPnlPercent, pnlSol: finalPnlSol, receivedSol: receivedSol ?? null, sell }));
    closed = true;
  } else if (exitReason && autoExit) {
    db.prepare(`
      UPDATE dry_run_positions
      SET status = 'closed', closed_at_ms = ?, exit_price = ?, exit_mcap = ?, exit_reason = ?, pnl_percent = ?, pnl_sol = ?
      WHERE id = ?
    `).run(now(), price, mcap, exitReason, pnlPercent, pnlSol, position.id);
    db.prepare(`
      INSERT INTO dry_run_trades (position_id, mint, side, at_ms, price, mcap, size_sol, token_amount_est, reason, payload_json)
      VALUES (?, ?, 'sell', ?, ?, ?, ?, ?, ?, ?)
    `).run(position.id, position.mint, now(), price, mcap, position.size_sol, position.token_amount_est, exitReason, json({ pnlPercent, pnlSol }));
    closed = true;
  }
  return {
    ...position,
    status: closed ? 'closed' : position.status,
    closed_at_ms: closed ? now() : position.closed_at_ms,
    asset,
    price,
    mcap,
    highWaterMcap,
    high_water_mcap: highWaterMcap,
    high_water_price: highWaterPrice,
    pnlPercent: finalPnlPercent,
    pnl_percent: finalPnlPercent,
    pnlSol: finalPnlSol,
    pnl_sol: finalPnlSol,
    exitReason: closed ? exitReason : null,
    exit_reason: closed ? exitReason : position.exit_reason,
    exit_mcap: closed ? mcap : position.exit_mcap,
    exit_price: closed ? price : position.exit_price,
  };
}

// FIX_MONITOR_STALL (root cause of "dashboard tidak bergerak"): the monitor loop is sequential
// (`for...of` + await). Previously a single hung network await — `await sendPositionExit()` blocking
// on a Telegram 409 flood, or a slow `refreshPosition` — froze the ENTIRE loop: every position after
// the stuck one never refreshed, so the dashboard read stale last_mcap forever. And because it runs
// on setInterval(10s) with no overlap guard, a stalled pass let the next fire stack on top.
// Three guards so ONE bad await can never freeze the loop again, regardless of WHY it hangs:
//   1. monitorInFlight — skip a tick if the previous pass hasn't finished (no stacking).
//   2. withTimeout — bound each refreshPosition; a hung position is abandoned, loop continues.
//   3. sendPositionExit is fire-and-forget (.catch) — a notification must never block trade monitoring.
let monitorInFlight = false;
const POSITION_REFRESH_TIMEOUT_MS = 15_000;

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export async function monitorPositions() {
  if (monitorInFlight) {
    console.log('[monitor] previous pass still running — skipping this tick');
    return;
  }
  monitorInFlight = true;
  try {
    const positions = openPositions();
    let walletPnlData = {};
    const pubkey = liveWalletPubkey();
    if (pubkey && positions.some(p => p.execution_mode === 'live')) {
      walletPnlData = await withTimeout(fetchJupiterWalletPnl(pubkey), POSITION_REFRESH_TIMEOUT_MS, 'walletPnl')
        .catch(err => { console.log(`[monitor] walletPnl ${err.message}`); return {}; });
    }
    for (const position of positions) {
      const jupiterPnl = position.execution_mode === 'live'
        ? (walletPnlData[position.mint]?.pnl || null)
        : null;
      const result = await withTimeout(
        refreshPosition(position, { autoExit: true, jupiterPnl }),
        POSITION_REFRESH_TIMEOUT_MS,
        `refresh #${position.id}`,
      ).catch((err) => {
        // A single position failing/hanging must NOT stall the rest of the loop.
        console.log(`[position] ${position.id} ${err.message}`);
        return null;
      });
      if (result?.exitReason) {
        // Fire-and-forget: a Telegram hang/409 must never block trade monitoring.
        sendPositionExit(result).catch(err => console.log(`[position] ${position.id} exit-notify failed: ${err.message}`));
        // PHASE_B1_PATCH: trigger postmortem on losing exit (non-blocking).
        if (Number(result.pnl_percent) < -10) {
          runPostmortem(result).catch(err => console.log(`[postmortem] async error: ${err.message}`));
        }
      }
    }
  } finally {
    monitorInFlight = false;
  }
}
