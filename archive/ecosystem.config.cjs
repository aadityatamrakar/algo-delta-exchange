/**
 * pm2 ecosystem — the single source of truth for what runs in production.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * There was no ecosystem file. The only process inventory was `dump.pm2`, a
 * snapshot whose newest internal timestamp is 2023-03-05 and which contains none
 * of the current strategies. This file replaces it with something reviewable and
 * version-controlled.
 *
 * USAGE
 *   pm2 start ecosystem.config.cjs                  # everything
 *   pm2 start ecosystem.config.cjs --only server    # one process
 *   pm2 restart infra                               # the whole infra namespace
 *   pm2 restart strategies                          # every strategy
 *   pm2 logs lion-s25-2                             # one strategy's logs
 *   pm2 delete strategies && pm2 start ecosystem.config.cjs   # hard reset
 *
 * Per-process logs land in logs/<name>-{out,err}.log, so a stuck or misbehaving
 * module can be inspected and restarted in isolation.
 *
 * TWO DELIBERATE SEMANTICS
 * ------------------------
 * 1. `stop_exit_codes: [0]` on strategies. Every strategy calls `process.exit()`
 *    at ~15:30 IST as a clean end-of-day shutdown. With plain `autorestart: true`
 *    pm2 would immediately restart it and leave it running overnight; with
 *    `autorestart: false` a mid-session CRASH would leave it dead with an open
 *    position. `stop_exit_codes: [0]` gives the correct behaviour of both: a clean
 *    exit(0) stays down, any non-zero crash is restarted.
 *
 * 2. NO `cron_restart` for market timing. pm2 cron runs in the server's local
 *    timezone, whereas every strategy schedules its own phases in `Asia/Kolkata`
 *    via the `cron` package. Putting market-hours logic here would create two
 *    competing schedulers in two timezones. Morning launch stays owned by
 *    `server/tools/ob_start.js` + each strategy's internal IST crons.
 *
 * SCOPE
 * -----
 * Strategies listed here are exactly the ACTIVE set: entries in
 * `common/models/strategies.json` with `autostart: true` or a `delay_start`
 * value (see context/09-active-strategy-scope.md). Everything else is legacy.
 *
 * NOTE ON `ob_start`: it only ever `pm2.restart`s EXISTING processes — there is
 * no `pm2.start` anywhere in the repo. So a strategy must exist in pm2 for its
 * registry entry to do anything. Starting from this file satisfies that, which is
 * the bug it quietly fixes.
 */

const path = require('path')
const LOGS = path.join(__dirname, 'logs')

/** Shared defaults. Node 22+ is required by the new TypeScript packages. */
const base = {
  cwd: __dirname,
  instances: 1,
  exec_mode: 'fork',
  time: true, // timestamp every log line
  merge_logs: true,
  max_memory_restart: '600M',
  min_uptime: '30s',
  restart_delay: 5000,
  env: {
    NODE_ENV: 'production',
    TZ: 'Asia/Kolkata', // align process-local time with market time
  },
}

/** Long-running infrastructure: always up, always restarted on exit. */
function infra(name, script, extra = {}) {
  return {
    ...base,
    name,
    script,
    namespace: 'infra',
    autorestart: true,
    out_file: `${LOGS}/${name}-out.log`,
    error_file: `${LOGS}/${name}-err.log`,
    ...extra,
  }
}

/**
 * A strategy: crash-restarted, but a clean EOD exit(0) leaves it stopped.
 * `live: true` marks strategies that place real broker orders directly via
 * `Account.placeAllAccount` — kept as metadata so it is impossible to forget
 * which processes move real money.
 */
function strategy(name, { live = false, tag = '', note = '' } = {}) {
  return {
    ...base,
    name,
    script: `server/slive/${name}.js`,
    namespace: 'strategies',
    autorestart: true,
    stop_exit_codes: [0], // clean EOD shutdown must NOT be restarted
    max_restarts: 10,
    out_file: `${LOGS}/${name}-out.log`,
    error_file: `${LOGS}/${name}-err.log`,
    // metadata only — pm2 ignores unknown keys, humans do not
    _live: live,
    _tag: tag,
    _note: note,
  }
}

module.exports = {
  apps: [
    // ---------------------------------------------------------------- infra
    infra('server', 'server/server.js', {
      // The only process that calls listen(): REST API + socket.io dashboard feed.
      max_memory_restart: '1G',
    }),

    // Order-bus consumer: forwards `paper-trade` documents to REAL XTS/Jainam
    // accounts. While this is running, "bus-routed" strategies place real orders.
    infra('xtsOrder', 'server/tools/xtsOrder.js'),

    // Stoploss service. Operates on XtsAccount positions
    // (XtsAccount.place_order / squareOff).
    infra('smp_target', 'server/tools/smp_target.js'),

    // Reporting / P&L aggregation.
    infra('smp_report', 'server/tools/smp_report.js'),

    // Order-tracking service (registry delay_start 09:14).
    infra('smp_order_listener', 'server/tools/smp_order_listener.js'),

    // Central square-off: flattens EVERY strategy's non-zero positions. Several
    // strategies (notably eagle-s-1) have NO in-file exit logic and depend
    // entirely on this process. Treat it as safety-critical.
    infra('squareoff_smp', 'server/scripts/squareoff_smp.js'),

    // Daily Zerodha token exchange.
    infra('exchangeToken', 'server/tools/exchangeToken.js'),

    // ----------------------------------------------------------- strategies
    // -- modern lineage: logic-split, unit-tested, bus-routed --
    strategy('bn-breakout', { tag: 'BN_Breakout', note: 'delay_start 0916; 0.09% band off first 5-min candle' }),
    strategy('atr-band-nifty', { tag: 'ATR_Band_NIFTY', note: 'delay_start 0918; Wilder ATR-14/3 band, 2-candle confirm' }),
    strategy('orb-scalp', { tag: 'ORB_Scalp', note: 'delay_start 0918; BANKNIFTY+NIFTY+SENSEX ORB in one process' }),
    strategy('orb-fut-bn', { tag: 'ORB_Fut_BankNifty', note: 'delay_start 0918; 7-line config wrapper over orb-fut-core' }),
    strategy('orb-fut-nifty', { tag: 'ORB_Fut_NIFTY', note: 'delay_start 0918; wrapper over orb-fut-core' }),
    strategy('orb-fut-snx', { tag: 'ORB_Fut_Sensex', note: 'delay_start 0918; wrapper over orb-fut-core' }),

    // -- legacy lineage, autostart:true --
    strategy('bull-s-1', { tag: 'Bull_S-1', note: 'ATM straddle sell, pyramid UP, 25% premium stop. otmSelector() -> 0 so ATM not OTM' }),
    strategy('bull-snx-1', { tag: 'Bull_SNX-1', note: 'SENSEX variant of bull-s-1' }),

    // WARNING: no intraday per-leg stop. Only ever ADDS short legs (BUY=0 in the
    // whole file). Exits depend entirely on squareoff_smp above.
    strategy('eagle-s-1', { tag: 'Eagle_S-1', note: 'pyramiding short gamma, NO intraday stop - relies on squareoff_smp' }),

    // WARNING: placeAllAccount is DUAL-RAIL (account.js:151) — it inserts onto the
    // order bus AND places Zerodha orders, so a single decision can fill on Zerodha
    // and XTS/Spark/Fyers. Its stop is LOCAL and tick-based (:178 -> :182), with no
    // resting broker order: if this process dies, the short is unprotected until
    // squareoff_smp runs. See context/07-verified-risks.md H3.
    strategy('lion-s25-2', { live: true, tag: 'Lion_S25_2', note: 'DUAL-RAIL orders; local tick stop only, no resting broker stop' }),

    // -- legacy lineage, delay_start, LIVE Zerodha orders --
    strategy('cheetah-b1-1', { live: true, tag: 'CheetahB1-1', note: 'delay_start 0917; momentum BUY + martingale, capped 12 lots' }),
    strategy('cheetah-b1-snx', { live: true, tag: 'Cheetah_B1_SNX', note: 'delay_start 0917; SENSEX variant' }),

    // -- external signal mirrors (not strategies: they mirror optionbhai.com) --
    strategy('candlestrategy', { tag: '1PBUY', note: 'delay_start 0914; websocket order mirror' }),
    strategy('candlestrategy-a006', { tag: 'A006', note: 'delay_start 0914; websocket order mirror' }),
    strategy('candlestrategy-test3', { tag: 'EMA2050', note: 'delay_start 0914; websocket order mirror' }),
  ],
}
