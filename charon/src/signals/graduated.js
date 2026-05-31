import axios from 'axios';
import { JSON_HEADERS, GRADUATED_LOOKBACK_MS } from '../config.js';
import { now } from '../utils.js';

export const graduated = new Map();

export async function fetchGraduatedCoins() {
  const res = await axios.get('https://advanced-api-v2.pump.fun/coins/graduated', {
    timeout: 10_000,
    headers: JSON_HEADERS,
  });
  const coins = Array.isArray(res.data?.coins) ? res.data.coins : [];
  const cutoff = now() - GRADUATED_LOOKBACK_MS;
  for (const coin of coins) {
    const mint = coin?.coinMint;
    if (!mint) continue;
    const graduationDate = Number(coin.graduationDate || 0);
    if (graduationDate > 0 && graduationDate < cutoff) continue;
    graduated.set(mint, { ...coin, seenAt: now() });
  }
  for (const [mint, coin] of graduated) {
    const ts = Number(coin.graduationDate || coin.seenAt || 0);
    if (ts > 0 && ts < cutoff) graduated.delete(mint);
  }
  console.log(`[graduated] loaded ${coins.length}, tracking ${graduated.size}`);
}
