/**
 * pm2 ecosystem — the TRADERS app, on its own.
 *
 * Deliberately NOT part of ecosystem.desk.config.cjs: `make up`, `make restart`,
 * `make live`, `make deploy` and scripts/deploy.sh all `pm2 startOrRestart` that
 * file with no `--only`, so an entry there would start dx-traders on the live
 * box with the next routine desk deploy, before the runbook's steps are done.
 *
 *   npx pm2 start ecosystem.traders.config.cjs    # the operator, per the runbook
 *   npx pm2 restart dx-traders
 *
 * Read-only analytics of the files each trader's ODIN watcher uploads; it
 * places no order and imports no order code (apps/traders/test/import-rule.test.ts).
 * It is internet-facing (Caddy proxies to 127.0.0.1:TRADERS_PORT), so its `env`
 * is its own and holds only the keys below: never the desk's API token, master
 * key or any broker secret. TRADERS_ORIGINS lists the exact origins the page is
 * served from (plain `http://<ip>` is fine); never `*`.
 *
 * The assistant (docs/superpowers/specs/2026-10-23-traders-ai-desk-design.md
 * §6.1) reads the TRADERS_AI_* keys below, each passed only when .env.local
 * sets it: with none set it is off and the app is exactly as without it. Its
 * one secret is TRADERS_AI_API_KEY, the LLM provider's key — the app never
 * logs it.
 *
 * `.env.local` is read the same way the desk file reads it.
 */

const fs = require('node:fs')
const path = require('node:path')

const ROOT = __dirname

/** `KEY=value`, `#` comments, blank lines; a surrounding quote pair is stripped. Mirrors ecosystem.desk.config.cjs. */
function loadEnvFile(file) {
  const out = {}
  if (!fs.existsSync(file)) return out
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq < 0) continue
    const key = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    out[key] = value
  }
  return out
}

const secrets = loadEnvFile(path.join(ROOT, '.env.local'))

/** The assistant's settings (spec §6.1): passed through only when set, so unset they take the app's defaults (off). */
const AI_KEYS = [
  'TRADERS_AI_ENABLED', 'TRADERS_AI_PROVIDER', 'TRADERS_AI_API_KEY', 'TRADERS_AI_BASE_URL', 'TRADERS_AI_MODEL', 'TRADERS_AI_EFFORT',
  'TRADERS_AI_MAX_STEPS', 'TRADERS_AI_DAILY_USD', 'TRADERS_AI_TRADER_DAILY_USD', 'TRADERS_AI_PRICE_IN_PER_MTOK', 'TRADERS_AI_PRICE_OUT_PER_MTOK',
]
const aiEnv = Object.fromEntries(AI_KEYS.filter((k) => secrets[k] !== undefined).map((k) => [k, secrets[k]]))
const deskMongoUrl = secrets.DESK_MONGO_URL ?? 'mongodb://127.0.0.1:27017/algomaker_dx'
const deskBusUrl = secrets.DESK_BUS_URL ?? 'ws://127.0.0.1:8891'

module.exports = {
  apps: [
    {
      name: 'dx-traders',
      // Not 'dx': `make down` (pm2 stop dx) and `make clean` (pm2 delete dx) act on that namespace. Not 'traders'
      // either: that is the live NSE desk's traders namespace on this box. Not 'dx-traders': pm2 resolves a name
      // before a namespace, so `pm2 stop dx-traders` would only ever reach the app, never the group.
      namespace: 'dxtraders',
      script: 'bin/desk-traders.mjs',
      cwd: ROOT,
      interpreter: process.execPath,
      autorestart: true,
      // A crash loop should be loud and bounded, not a silent hot spin.
      max_restarts: 10,
      restart_delay: 2000,
      min_uptime: 10_000,
      // It loads the full instrument master, like the supervisor. A new watcher's history back-fill took it to
      // ~960 MB on 21 Oct 2026 (343 files in 5 min) and the old 900M limit restarted it mid-upload.
      max_memory_restart: '1500M',
      time: true,
      merge_logs: true,
      out_file: 'logs/dx-traders-out.log',
      error_file: 'logs/dx-traders-err.log',
      env: {
        NODE_ENV: 'production',
        TRADERS_PORT: secrets.TRADERS_PORT ?? '8894',
        TRADERS_MONGO_URL: secrets.TRADERS_MONGO_URL ?? deskMongoUrl,
        DESK_BUS_URL: deskBusUrl,
        TRADERS_ORIGINS: secrets.TRADERS_ORIGINS ?? '',
        // The most feed tokens desk-traders declares; they join the desk's Kite feed pool (runbook section 5).
        TRADERS_MAX_TOKENS: secrets.TRADERS_MAX_TOKENS ?? '2000',
        // The folder scripts/span_job.py fills with NSE's SPAN, exposure and end-of-day files.
        TRADERS_NSE_DIR: secrets.TRADERS_NSE_DIR ?? path.join(ROOT, 'data/nse'),
        ...(secrets.TRADERS_SESSION_TTL_MS === undefined ? {} : { TRADERS_SESSION_TTL_MS: secrets.TRADERS_SESSION_TTL_MS }),
        // The most tokens Market Watch's on-screen chains declare, across all viewers, inside TRADERS_MAX_TOKENS (runbook §17.2).
        // Passed only when .env.local sets it: unset, the app takes 1000, or TRADERS_MAX_TOKENS when that is lower; a value
        // set over TRADERS_MAX_TOKENS refuses to start.
        ...(secrets.TRADERS_MARKET_WATCH_MAX_TOKENS === undefined ? {} : { TRADERS_MARKET_WATCH_MAX_TOKENS: secrets.TRADERS_MARKET_WATCH_MAX_TOKENS }),
        ...aiEnv,
      },
    },
    {
      // Download-and-save only (scripts/span_job.py); the python interpreter is pm2's, not node's.
      name: 'dx-traders-span',
      namespace: 'dxtraders',
      script: 'scripts/span_job.py',
      cwd: ROOT,
      interpreter: secrets.TRADERS_NSE_PYTHON ?? path.join(ROOT, '.venv-nse/bin/python'),
      autorestart: false,
      cron_restart: '*/15 3-14 * * 1-5', // box is UTC: every 15 min, 08:30–20:15 IST, Mon–Fri
      time: true,
      merge_logs: true,
      out_file: 'logs/dx-traders-span-out.log',
      error_file: 'logs/dx-traders-span-err.log',
      env: { TRADERS_NSE_DIR: secrets.TRADERS_NSE_DIR ?? path.join(ROOT, 'data/nse') },
    },
    {
      // The held stocks' option chains and NSE's CMVOLT file, once each weekday evening (scripts/nse_vol_job.py).
      // Not started by any deploy: the operator starts it (runbook / vol addendum). Same venv as the span job.
      name: 'dx-traders-vol',
      namespace: 'dxtraders',
      script: 'scripts/nse_vol_job.py',
      cwd: ROOT,
      interpreter: secrets.TRADERS_NSE_PYTHON ?? path.join(ROOT, '.venv-nse/bin/python'),
      autorestart: false,
      cron_restart: '50 14 * * 1-5', // box is UTC: 20:20 IST Mon–Fri, after the span job's last (20:15) download
      time: true,
      merge_logs: true,
      out_file: 'logs/dx-traders-vol-out.log',
      error_file: 'logs/dx-traders-vol-err.log',
      env: { TRADERS_NSE_DIR: secrets.TRADERS_NSE_DIR ?? path.join(ROOT, 'data/nse') },
    },
  ],
}
