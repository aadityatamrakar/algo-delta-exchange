/**
 * Every declared dependency must load on the running Node version.
 *
 * This is the check that turned the Node 16 -> 24 upgrade from "unknown risk"
 * into a two-line problem: 51 of 53 dependencies loaded fine; only tulind (a
 * native addon) and norenrestapi (referenced by zero files) failed.
 */
const test = require('node:test');
const assert = require('node:assert');
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

test('every declared dependency loads on this Node version', () => {
  const failures = [];
  for (const dep of Object.keys(pkg.dependencies)) {
    try {
      require(dep);
    } catch (err) {
      failures.push(`${dep}: ${err.code || ''} ${String(err.message).split('\n')[0]}`);
    }
  }
  assert.deepStrictEqual(
    failures, [],
    `dependencies that do not load on Node ${process.versions.node}:\n  ${failures.join('\n  ')}`
  );
});

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function liveFiles() {
  // Tracked-only is fine here (unlike no-native-addons.test.js's filesystem
  // walk): an untracked file exercising a dependency is still "not yet
  // committed usage", and a dependency add + its usage land in the same
  // commit in practice.
  //
  // Docs (*.md) are excluded deliberately: context/02-backend-architecture.md
  // *documents* kiteconnect/xts-marketdata-api as dead, which would otherwise
  // make them look "referenced" and defeat the point of this check.
  const out = execSync('git ls-files', { cwd: ROOT, encoding: 'utf8' });
  return out.split('\n').filter(Boolean)
    .filter(f => !f.startsWith('legacy/'))
    .filter(f => !f.endsWith('.md'))
    .filter(f => f !== 'package.json' && f !== 'package-lock.json');
}

/**
 * A dependency counts as referenced if either:
 *  - a .js/.cjs/.mjs/.ts file has an executable `require('<dep>')` (comments
 *    stripped first — server/lib/KiteTicker.js documents, in a comment, that
 *    it used to use `kiteconnect`; that must NOT count as live usage), or
 *  - any other tracked file (config JSON, mainly) contains the bare dependency
 *    name — LoopBack's server/middleware.json wires in modules like
 *    `compression`/`cors`/`helmet` by string name, not by a JS `require()`
 *    call, so a require()-only check would wrongly flag them as dead.
 */
function isReferencedSomewhere(dep) {
  const requirePattern = new RegExp(`require\\(\\s*['"]${escapeRegExp(dep)}['"]`);
  const namePattern = new RegExp(escapeRegExp(dep));
  for (const rel of liveFiles()) {
    const full = path.join(ROOT, rel);
    if (!fs.statSync(full).isFile()) continue;
    const src = fs.readFileSync(full, 'utf8');
    const isJsLike = /\.(js|cjs|mjs|ts)$/.test(rel);
    if (isJsLike ? requirePattern.test(stripComments(src)) : namePattern.test(src)) {
      return true;
    }
  }
  return false;
}

test('no dependency is declared but unreferenced by any live file', () => {
  // Guards against re-accumulating dead dependencies. Extend this only with a
  // dated comment explaining why something is declared but not required.
  const allowlist = new Set([
    'pm2',                       // invoked as a binary by ecosystem.config.cjs / pm2 CLI, not required directly (this file's own `require(dep)` loop above is dynamic, so text-search can't see it either)
    'gulp',                      // build tool, used via gulpfile.js's own require('gulp') — kept for documentation even though the check below already finds it
    'loopback-connector-mongodb', // never required BY NAME: loopback-datasource-juggler resolves `"connector": "mongodb"` in datasources.json to this package internally via naming convention. A real, load-bearing dependency this text-search cannot see.
    // Below: verified 2026-07-26 to have zero references (as a `require()`
    // call, or by name in any config file) under server/, common/, scripts/,
    // or root — dead weight, kept only because removing a dependency is out
    // of scope for this Node-upgrade phase.
    'kiteconnect',             // context/02-backend-architecture.md:162 — real Zerodha ticker is hand-rolled (server/lib/KiteTicker.js), not this SDK
    'xts-marketdata-api',      // context/02-backend-architecture.md:162 — XTS-routed strategies use Kite ticks, never this package
    'axios-cookiejar-support', // no call sites found
    'cronjob',                 // no call sites found (distinct from the `cron` package, which IS used)
    'fixparser',               // no call sites found
    'ioredis',                 // no call sites found
    'memphis-dev',             // no call sites found
    'protobufjs',              // no call sites found
    'puppeteer-core',          // no call sites found — server/tools/tradelab_login.js instead requires the plain `puppeteer` package, which is NOT a declared dependency at all (likely a pre-existing bug; out of scope here, see fix-wave-report.md)
    'serve-favicon',           // no call sites found
    'speakeasy',               // no call sites found — TOTP is done via the `authenticator` package (server/lib/zerodha.js, totp.js), not speakeasy
    'tough-cookie',             // only `tough-cookie-filestore` (a separate, used dependency) is required directly; the bare `tough-cookie` package is never require()'d
  ]);

  const offenders = Object.keys(pkg.dependencies)
    .filter(dep => !allowlist.has(dep))
    .filter(dep => !isReferencedSomewhere(dep));

  assert.deepStrictEqual(
    offenders, [],
    'dependencies declared in package.json but not referenced by any live ' +
    'tracked file (excluding legacy/ and docs) — either use them or add them ' +
    `to the allowlist with a dated reason: ${offenders.join(', ')}`
  );
});
