/**
 * pm2 ecosystem — the DESK system (the new one).
 *
 * Separate from `ecosystem.config.cjs`, which describes the legacy system being
 * retired. Keeping them apart means `pm2 stop dx` cannot touch legacy
 * processes and vice versa, and when legacy is finally off, that file is
 * deleted without touching this one.
 *
 * USAGE
 *   pm2 start ecosystem.desk.config.cjs             # everything, SIMULATED broker
 *   pm2 start ecosystem.desk.config.cjs --env live  # real broker (see below)
 *   pm2 stop dx                                   # the whole namespace
 *   pm2 restart dx-api                            # one process
 *   pm2 logs dx                                   # all desk logs
 *   pm2 logs dx-gateway --lines 200               # one process's logs
 *   pm2 delete dx                                 # hard reset
 *
 * ORDER MATTERS on a cold start: marketdata owns the bus that api and gateway
 * subscribe to. They tolerate it being absent (both reconnect), so the order is
 * a nicety rather than a requirement — but it avoids a minute of confusing logs.
 *
 * THE SAFETY PROPERTY
 * -------------------
 * The default start runs the gateway with `DESK_BROKER=simulate`, so a plain
 * `pm2 start ecosystem.desk.config.cjs` CANNOT place a real order. Going live is
 * `--env live`, which is a deliberate act that also reads as one in shell
 * history. Defaulting the other way would mean a single forgotten flag is the
 * difference between a dry run and real money.
 *
 * Secrets come from `.env.local` (gitignored). This file loads it explicitly
 * because pm2 does not read dotenv files itself.
 */

const fs = require('node:fs')
const path = require('node:path')

const ROOT = __dirname

/**
 * Parse `.env.local` into an object.
 *
 * Deliberately minimal and dependency-free: `KEY=value`, `#` comments, blank
 * lines. Values are NOT unquoted beyond a surrounding pair, because a broker
 * secret containing `#` or `=` must survive verbatim.
 */
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

/** Defaults every desk process shares. `.env.local` wins over these. */
const base = {
  DESK_MONGO_URL: 'mongodb://127.0.0.1:27017/algomaker_dx',
  DESK_BUS_URL: 'ws://127.0.0.1:8891',
  DESK_BUS_PORT: '8891',
  DESK_PORT: '8890',
  NODE_ENV: 'production',
  // The Delta desk. Every dx process reads the venue from here; .env.local may only restate it.
  DESK_VENUE: 'dx',
  ...secrets,
}

/**
 * Node 24 runs TypeScript directly by stripping types, so the sources are the
 * entry points and there is no build step. `interpreter` is pinned to the node
 * running pm2 rather than left to detection, which would otherwise look for a
 * ts-node that is deliberately not installed.
 */
function app(name, script, env, extra = {}) {
  return {
    name,
    namespace: 'dx',
    script,
    cwd: ROOT,
    interpreter: process.execPath,
    autorestart: true,
    // A crash loop should be loud and bounded, not a silent hot spin.
    max_restarts: 10,
    restart_delay: 2000,
    min_uptime: 10_000,
    max_memory_restart: '600M',
    time: true,
    merge_logs: true,
    out_file: `logs/${name}-out.log`,
    error_file: `logs/${name}-err.log`,
    env: { ...base, ...env },
    ...extra,
  }
}

module.exports = {
  apps: [
    /**
     * One Kite login, one socket pool, the bus. Start first — the others
     * subscribe to it (and reconnect on their own if it is not up yet).
     */
    app('dx-marketdata', 'bin/desk-marketdata.mjs', {
      DESK_UNIVERSE: secrets.DESK_UNIVERSE ?? 'NIFTY,BANKNIFTY,SENSEX,BHEL',
      DESK_FULL_CHAIN: '1',
    }),

    /**
     * The bridge the Python desk POSTs to.
     *
     * `DESK_MD_URL` is where the payoff cockpit asks what a PROPOSED book would
     * cost to hold (`/v1/desk/repair/verify-margin` -> desk-marketdata's
     * `/v1/md/margin-basket`). It points at the same `DESK_MD_PORT` the history
     * endpoint serves on, for the same reason: that process holds the only Kite
     * login, and a second one invalidates the first. Best effort — the cockpit
     * still serves its own SPAN-lite estimate when this is wrong or down.
     */
    app('dx-api', 'bin/desk-bridge.mjs', {
      DESK_MD_URL: 'http://127.0.0.1:8892',
    }),

    /**
     * The only process that can place orders.
     *
     * `DESK_BROKER=simulate` here is the safety default described above; the
     * `live` env below is the deliberate opt-in.
     */
    app(
      'dx-gateway',
      'bin/desk-gateway.mjs',
      {
        /**
         * SIMULATE IS THE CODE DEFAULT, but `.env.local` may override it.
         *
         * The default has to stay simulate so a fresh checkout, a new box or a
         * misdirected deploy cannot place a real order — that is the safety
         * property described at the top of this file, and it is worth keeping.
         *
         * What it was missing is PERSISTENCE for a box that genuinely is a live
         * trading machine. `--env live` arms the gateway until the next restart,
         * and `make up`, `make restart`, `make deploy`, a crash-restart or a
         * reboot all silently drop back to simulate — with the desk looking
         * completely healthy while its orders reach nothing. A live session
         * cannot depend on nobody bouncing a process.
         *
         * So a live box sets `DESK_BROKER=xts` in `.env.local` ONCE, and stays
         * armed across every restart. `--env live` still works and still
         * overrides, for a one-off.
         */
        DESK_BROKER: secrets.DESK_BROKER ?? 'simulate',
        /**
         * Where to tell desk-api that a live order event happened, so the
         * dashboard sees it without waiting for its next poll.
         *
         * BEST EFFORT AND UNABLE TO AFFECT AN ORDER (`apps/order-gateway/src/
         * notify.ts`): if this is wrong or the bridge is down, the push is
         * dropped, the dashboard stays on 10-second polling and says so, and
         * every order is placed exactly as before.
         */
        DESK_API_URL: 'http://127.0.0.1:8890',
      },
      { env_live: { ...base, DESK_BROKER: 'xts', DESK_API_URL: 'http://127.0.0.1:8890' } },
    ),

    /**
     * The hosted intraday strategies. ONE process, N strategies — the legacy
     * system ran ~150, each with its own Kite socket and its own LoopBack boot.
     *
     * It has no broker credentials and no `env_live`: every order is an HTTP
     * POST to `/v1/desk/submit`, so whether it can reach a real broker is
     * decided by the gateway's mode and `DESK_LIVE_TAGS`, never by anything
     * here. There is deliberately no way to make this process dangerous on its
     * own.
     *
     * Started LAST: it POSTs to desk-api and subscribes to desk-marketdata's
     * bus, and it retries both, so this is a nicety rather than a requirement.
     *
     * SIGTERM stops the strategies and, with `DESK_SQUAREOFF_ON_STOP=1`,
     * squares them off first (`apps/runner/src/main.ts`) — so `kill_timeout` is
     * well above pm2's 1.6s default: killing the process mid-square-off would
     * leave a real position unmanaged, which is the exact failure this app
     * exists to fix.
     *
     * `max_memory_restart` is raised well above the 600M default because at
     * 600M it was an UNATTENDED path into a mid-session stop: nothing is
     * watching when pm2 decides to bounce, and the runner's quote cache
     * legitimately grows all session (`market-data.ts` never prunes `#quotes`),
     * so the limit is reached by normal operation rather than by a leak.
     */
    app('dx-runner', 'bin/desk-runner.mjs', { DESK_API_URL: 'http://127.0.0.1:8890' }, {
      kill_timeout: 20_000,
      max_memory_restart: '1500M',
      // Not part of the default start: BULL-S runs in the supervisor. scripts/dx-start.sh names its apps
      // one by one and never starts this one.
      autostart: false,
    }),

    /**
     * THE RECENTER SUPERVISOR — the process that steers the positional books.
     *
     * It replaces the Python `desk-supervisor` / `desk-supervisor-live` pair that
     * ran out of `sensibull-desk`. Like the runner it holds NO broker
     * credentials: every order is a `POST /v1/desk/engine/decisions` at desk-api,
     * so whether it can reach a real broker is decided by the gateway's mode and
     * the per-book live switch, never by anything here. There is deliberately no
     * `env_live` — this process cannot be made dangerous on its own.
     *
     * `DESK_SUPERVISOR_PORT` is the loopback nudge/health port desk-api reaches
     * it on (`apps/api/src/engine-notify.ts`). Both processes read the same
     * variable, so moving it is one edit; leaving it unset puts both on the
     * contract's default of 8893.
     *
     * NO `kill_timeout` ABOVE THE DEFAULT, and that is the point: **stopping this
     * process touches no book**. It squares nothing off, cancels nothing, and has
     * no `DESK_SQUAREOFF_ON_STOP` equivalent — not even one that is off by
     * default. Its whole state (rule state, decision seq, working package,
     * protected lots) is durable in `desk-supervisor-state`, so a restart resumes
     * every book. A stop that placed orders would be reached by
     * `max_memory_restart` at 11:40 with nobody watching, which is exactly how
     * the runner flattened a live book on 2026-08-17.
     *
     * `max_memory_restart` is raised to 900M anyway, because the memory bounce
     * itself is still disruptive: the confirm windows restart, the chain view is
     * rebuilt cold, and every book waits a poll cycle. The supervisor's memory is
     * bounded by the chains it steers (`chain-view.ts` §3) rather than by the
     * tick stream, so 900M is headroom rather than a leak allowance.
     */
    app(
      'dx-supervisor',
      'bin/desk-supervisor.mjs',
      {
        DESK_API_URL: 'http://127.0.0.1:8890',
        DESK_SUPERVISOR_PORT: secrets.DESK_SUPERVISOR_PORT ?? '8893',
      },
      { max_memory_restart: '900M' },
    ),

    /**
     * THE WATCHDOG — the desk seen from OUTSIDE it (apps/watchdog).
     *
     * Every 10s it reads the desk's health (gateway heartbeat row, supervisor
     * lease, desk-api's system report) and each Delta account straight from
     * Delta with its own client. A desk process down > 30s while Delta holds
     * positions is a critical alert; the gateway down > 30s cancels the desk's
     * non-stop working orders (the retired dead-man switch's job, keeping the
     * exchange backstops); the LIVE account is flattened after
     * DX_WATCHDOG_FLATTEN_S (300; 0 = off). It forwards desk-alerts to
     * Telegram when DX_ALERT_TELEGRAM_TOKEN / DX_ALERT_TELEGRAM_CHAT are set.
     */
    app('dx-watchdog', 'bin/dx-watchdog.mjs', { DESK_API_URL: 'http://127.0.0.1:8890' }),

    /**
     * ONE-PORT WEB FRONT: serves apps/web/dist and proxies /v1 (HTTP + websocket)
     * to desk-api. No bus dependency; holds no credentials.
     */
    app('dx-web', 'bin/dx-web.mjs', { DESK_WEB_PORT: '5000' }),
  ],
}
