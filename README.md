# exno_charon

Setup lengkap bot trading Solana: **Charon** (pump.fun sniper), **Meridian** (Meteora DLMM LP bot), dan **PnL Dashboard** (realtime calendar view).

---

## 📋 Prasyarat

- **Node.js** >= 18 (disarankan v22+)
- **PM2** (process manager): `npm install -g pm2`
- **Git LFS** (untuk clone database sqlite): `apt install git-lfs && git lfs install`
- **sqlite3 CLI** (untuk dashboard): `apt install sqlite3`
- **cloudflared** (opsional, untuk akses publik via tunnel): [install guide](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)

### API Keys yang Dibutuhkan

| Key | Untuk | Cara Dapat |
|-----|-------|------------|
| Helius API Key | RPC Solana | https://helius.dev |
| Telegram Bot Token | Notifikasi | @BotFather di Telegram |
| LLM API Key | AI screening/decision | OpenRouter / 9router / provider lain |
| Solana Wallet Private Key | Eksekusi live trading | `solana-keygen` atau export dari Phantom |
| Jupiter API Key (Charon) | Swap execution | https://station.jup.ag |
| GMGN API Key (Charon, opsional) | Data enrichment | https://gmgn.ai |

---

## 🚀 Instalasi

### 1. Clone Repository

```bash
git lfs install
git clone https://github.com/Egi08/exno_charon.git
cd exno_charon
```

### 2. Setup Charon (Pump.fun Sniper Bot)

```bash
cd charon
cp .env.example .env
nano .env   # Isi semua API keys dan konfigurasi

npm install

# Test dry-run dulu
TRADING_MODE=dry_run node index.js

# Jalankan via PM2
pm2 start index.js --name charon
cd ..
```

**Konfigurasi penting di `.env` Charon:**
```env
TRADING_MODE=dry_run          # Ganti ke "live" untuk trading sungguhan
TELEGRAM_BOT_TOKEN=xxx        # Token bot Telegram
HELIUS_API_KEY=xxx            # Helius RPC key
SOLANA_PRIVATE_KEY=xxx        # Private key wallet (hanya untuk mode live)
LLM_BASE_URL=http://127.0.0.1:20128/v1   # Endpoint LLM (9router/OmniRoute/dll)
LLM_API_KEY=xxx               # API key LLM
ENABLE_LLM=true               # Aktifkan AI screening
MAX_OPEN_POSITIONS=3           # Maks posisi terbuka bersamaan
```

### 3. Setup Meridian (Meteora DLMM LP Bot)

```bash
cd meridian
cp .env.example .env
nano .env   # Isi semua API keys dan konfigurasi

npm install

# Test dry-run dulu
DRY_RUN=true node index.js

# Jalankan via PM2
pm2 start index.js --name meridian
cd ..
```

**Konfigurasi penting di `.env` Meridian:**
```env
WALLET_PRIVATE_KEY=xxx        # Private key wallet Solana (base58)
RPC_URL=https://mainnet.helius-rpc.com/?api-key=xxx
LLM_API_KEY=xxx               # API key LLM
LLM_MODEL=ag/gemini-3-flash-agent   # Model AI untuk screening
HELIUS_API_KEY=xxx
TELEGRAM_BOT_TOKEN=xxx
DRY_RUN=true                  # true = simulasi, false = live
```

**Konfigurasi strategi di `user-config.json` Meridian:**
```json
{
  "screening": {
    "minTvl": 10000,
    "maxTvl": 150000,
    "minVolume": 500,
    "maxMcap": 200000
  },
  "management": {
    "deployAmountSol": 0.5,
    "outOfRangeWaitMinutes": 30
  },
  "risk": {
    "maxPositions": 3,
    "maxDeployAmount": 50
  }
}
```

### 4. Setup PnL Dashboard

```bash
cd pnl-dashboard

# Jalankan via PM2 (tidak perlu npm install, zero-dependency)
pm2 start server.js --name pnl-dashboard

cd ..
```

Dashboard akan berjalan di **port 8910** secara default.

**Catatan:** Dashboard membaca data dari:
- Charon: `../charon/charon.sqlite` (posisi & PnL)
- Meridian: `../meridian/sim-positions.json` (posisi simulasi LP)

Pastikan struktur folder tetap seperti ini:
```
exno_charon/
├── charon/
├── meridian/
└── pnl-dashboard/
```

### 5. (Opsional) Expose Dashboard ke Internet via Cloudflare Tunnel

```bash
# Dashboard
pm2 start cloudflared --name pnl-tunnel -- tunnel --url http://127.0.0.1:8910 --no-autoupdate

# Cek URL publik yang digenerate
tail -n 20 ~/.pm2/logs/pnl-tunnel-error.log
# Cari baris: "Your quick Tunnel has been created! Visit it at: https://xxx.trycloudflare.com"
```

---

## 🔧 Perintah PM2 Umum

```bash
# Status semua proses
pm2 status

# Lihat logs realtime
pm2 logs charon
pm2 logs meridian
pm2 logs pnl-dashboard

# Restart bot
pm2 restart charon
pm2 restart meridian

# Stop bot
pm2 stop charon

# Auto-start saat reboot
pm2 save
pm2 startup
```

---

## 📁 Struktur Folder

```
exno_charon/
├── charon/                    # Pump.fun Sniper Bot
│   ├── index.js               # Entry point
│   ├── src/
│   │   ├── config.js          # Konfigurasi runtime
│   │   ├── pipeline/          # LLM screening pipeline
│   │   ├── execution/         # Exit ladder, sizing, drawdown gate
│   │   ├── signals/           # Signal sources (trending, graduated)
│   │   ├── enrichment/        # Data enrichment (GMGN, Jupiter, Twitter)
│   │   ├── telegram/          # Telegram bot commands & notifications
│   │   ├── learning/          # Auto-learning & postmortem
│   │   └── db/                # SQLite database layer
│   ├── charon.sqlite          # Database posisi & signals (Git LFS)
│   └── .env.example           # Template environment variables
│
├── meridian/                  # Meteora DLMM LP Bot
│   ├── index.js               # Entry point + cron orchestration
│   ├── agent.js               # ReAct loop (LLM → tool call → repeat)
│   ├── config.js              # Runtime config dari user-config.json + .env
│   ├── prompt.js              # System prompt per agent role
│   ├── state.js               # Position registry (state.json)
│   ├── tools/
│   │   ├── dlmm.js            # Meteora DLMM SDK wrapper
│   │   ├── screening.js       # Pool discovery dari Meteora API
│   │   ├── sim-store.js       # Simulasi posisi (dry-run)
│   │   ├── wallet.js          # SOL/token balances + Jupiter swap
│   │   └── token.js           # Token info/holders/narrative
│   ├── user-config.json       # Konfigurasi strategi (editable)
│   ├── sim-positions.json     # Data posisi simulasi
│   └── .env.example           # Template environment variables
│
├── pnl-dashboard/             # Realtime PnL Calendar Dashboard
│   └── server.js              # HTTP server (zero-dependency, port 8910)
│
└── README.md
```

---

## ⚠️ Peringatan Penting

1. **SELALU test di mode `dry_run` / `DRY_RUN=true` terlebih dahulu** sebelum beralih ke live trading.
2. **Jangan share private key wallet** Solana kamu ke siapapun.
3. **Backup `.env` file** secara terpisah — file ini mengandung semua kredensial sensitif.
4. **Monitor posisi secara berkala** via Telegram bot atau PnL Dashboard.
5. **Atur `MAX_OPEN_POSITIONS` dan `maxDeployAmount`** sesuai toleransi risiko kamu.

---

## 📜 Lisensi

Private repository. Hanya untuk penggunaan pribadi.
