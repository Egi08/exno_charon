import { setDefaultResultOrder } from 'node:dns';
import { APP_NAME, SIGNAL_SERVER_URL, SIGNAL_POLL_MS, GRADUATED_POLL_MS, TRENDING_POLL_MS, POSITION_CHECK_MS, validateConfig } from './config.js';
import { initDb } from './db/connection.js';
import { initLiveExecution } from './liveExecutor.js';
import { setupTelegram } from './telegram/commands.js';
import { monitorPositions } from './execution/positions.js';
import { processCandidateFromSignals, maybeProcessDegenCandidate } from './pipeline/orchestrator.js';
import { sendTelegram } from './telegram/send.js';
import { makeFailureTracker } from './utils.js';

setDefaultResultOrder('ipv4first');
validateConfig();

export async function startCharon() {
  initDb();
  initLiveExecution();
  setupTelegram();

  // FIX_MONITOR_STALL (root cause of "dashboard tidak bergerak"): the position monitor is an
  // INDEPENDENT subsystem and must NEVER be gated behind the signal pipeline. It used to be
  // registered LAST (after `await fetchServerSignals()`). That initial fetch processes every
  // triggered signal INLINE through the LLM pipeline; with the LLM endpoint flaky (9router returning
  // truncated JSON → "[llm] batch failed: Unexpected end of JSON input"), one signal's processing
  // hung with no timeout, so `await fetchServerSignals()` never resolved (and never rejected, so its
  // .catch never fired). Boot never reached the monitor registration → the 10s position-check
  // interval was NEVER created → every open position froze and the dashboard read stale last_mcap
  // forever. Register the monitor FIRST so trade management always runs, independent of signals.
  const trackPositions = makeFailureTracker('position monitor', (msg) => sendTelegram(msg));
  setInterval(() => trackPositions(() => monitorPositions()), POSITION_CHECK_MS);

  if (SIGNAL_SERVER_URL) {
    // ── Server mode: fetch signals from signal server ──────────────────────
    const { fetchServerSignals, setCandidateHandler, setDegenHandler } = await import('./signals/serverClient.js');

    setCandidateHandler(processCandidateFromSignals);
    setDegenHandler(maybeProcessDegenCandidate);

    const alert = (msg) => sendTelegram(msg);
    const trackServer = makeFailureTracker('server signals', alert);
    const trackDip = makeFailureTracker('dip monitor', alert);

    // FIX_MONITOR_STALL: the initial warm-up fetch is FIRE-AND-FORGET (no `await`). It runs the LLM
    // signal pipeline which can hang on a flaky endpoint; awaiting it blocked boot. The interval
    // below re-runs it on schedule anyway, and trackServer() swallows its errors internally.
    trackServer(() => fetchServerSignals());
    setInterval(() => trackServer(() => fetchServerSignals()), SIGNAL_POLL_MS);

    // Price monitor for dip buy strategy
    const { monitorPriceAlerts, cleanupAlerts } = await import('./signals/priceMonitor.js');
    const { setCandidateHandler: setAlertHandler } = await import('./signals/priceMonitor.js');
    setAlertHandler(processCandidateFromSignals);
    setInterval(() => trackDip(() => monitorPriceAlerts()), 10_000);
    setInterval(() => cleanupAlerts(), 60 * 60 * 1000);

    console.log(`[bot] ${APP_NAME} started (server mode: ${SIGNAL_SERVER_URL})`);
  } else {
    // ── Standalone mode: direct polling (legacy) ───────────────────────────
    const { fetchGraduatedCoins } = await import('./signals/graduated.js');
    const { fetchGmgnTrending, setDegenHandler } = await import('./signals/trending.js');
    const { startWebsocket, setCandidateHandler } = await import('./signals/feeClaim.js');

    setDegenHandler(maybeProcessDegenCandidate);
    setCandidateHandler(processCandidateFromSignals);

    // FIX_MONITOR_STALL: fire-and-forget the initial warm-up fetches (intervals re-run them anyway).
    fetchGraduatedCoins().catch(error => console.log(`[graduated] initial fetch failed: ${error.message}`));
    fetchGmgnTrending().catch(error => console.log(`[trending] initial fetch failed: ${error.message}`));

    setInterval(() => fetchGraduatedCoins().catch(error => console.log(`[graduated] ${error.message}`)), GRADUATED_POLL_MS);
    setInterval(() => fetchGmgnTrending().catch(error => console.log(`[trending] ${error.message}`)), TRENDING_POLL_MS);
    startWebsocket();

    console.log(`[bot] ${APP_NAME} started (standalone mode)`);
  }
}
