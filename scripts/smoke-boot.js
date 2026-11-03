/**
 * Boots server/server.js as a child process and asserts it reaches "listening"
 * AND stays up through a settle window afterward — not just that it bound the
 * port once.
 *
 * Run this on the production box under the NEW Node, per
 * docs/runbooks/node-24-upgrade.md (Switch step 2, AFTER `pm2 stop all`).
 *
 * Two env vars make this safe to run against the real repo on the real box:
 *   - NODE_ENV=smoke makes loopback-boot also load server/config.smoke.json,
 *     which binds to 127.0.0.1:31780 instead of server/config.json's 0.0.0.0:80
 *     — a scratch port that can never clash with (or steal) the live listener.
 *   - SMOKE_BOOT=1 is checked by server/boot/paperstream.js's `app.on('started')`
 *     handler, which otherwise performs a Zerodha login (invalidating the
 *     production session — Zerodha allows one active session per API key) and
 *     opens change-stream watches on the paper-trade/positional/algopaper
 *     collections. Both env vars are set below; the operator does not need to
 *     export anything.
 *
 * The datasources themselves are NOT swapped — server/datasources.json's real
 * `cloud` Mongo is still what loopback-boot attaches models to, so this still
 * exercises the real boot path. What's suppressed is only the broker login and
 * the live change-stream watches gated behind SMOKE_BOOT above.
 *
 * Exit 0 = booted, reached listening, and stayed up for SMOKE_SETTLE_MS after.
 * Exit 1 = failed to spawn, crashed (before or during the settle window), or
 *          timed out without ever reaching listening.
 */
const { spawn } = require('node:child_process');
const path = require('node:path');

const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS || 20000);
const SETTLE_MS = Number(process.env.SMOKE_SETTLE_MS || 5000);
const SERVER = path.join(__dirname, '..', 'server', 'server.js');

console.log(`smoke-boot: node ${process.versions.node}, timeout ${TIMEOUT_MS}ms, settle ${SETTLE_MS}ms`);

const child = spawn(process.execPath, [SERVER], {
  env: { ...process.env, NODE_ENV: 'smoke', SMOKE_BOOT: '1' },
});
let output = '';
let settled = false;
let settleTimer = null;

function finish(code, reason) {
  if (settled) return;
  settled = true;
  if (settleTimer) clearTimeout(settleTimer);
  console.log(`smoke-boot: ${reason}`);

  // Await the child's actual exit instead of racing SIGTERM with our own
  // process.exit() — otherwise the parent can exit before the signal is even
  // delivered, and on some platforms before the child is reaped.
  const hardStop = setTimeout(() => process.exit(code), 5000);
  hardStop.unref();
  child.once('exit', () => process.exit(code));
  try {
    child.kill('SIGTERM');
  } catch {
    process.exit(code); // already gone
  }
}

for (const stream of [child.stdout, child.stderr]) {
  stream.on('data', chunk => {
    const text = String(chunk);
    output += text;
    process.stdout.write(text);
    if (!settled && !settleTimer && /Web server listening at/.test(output)) {
      console.log(`smoke-boot: reached listening state, watching for ${SETTLE_MS}ms before declaring PASS`);
      settleTimer = setTimeout(
        () => finish(0, 'PASS — reached listening state and stayed up through the settle window'),
        SETTLE_MS
      );
    }
  });
}

child.on('error', err => {
  finish(1, `FAIL — could not spawn child: ${err.message}`);
});

child.on('exit', code => {
  finish(1, `FAIL — process exited (code ${code}) before or during the settle window`);
});

setTimeout(() => finish(1, `FAIL — timed out after ${TIMEOUT_MS}ms without listening`), TIMEOUT_MS);
