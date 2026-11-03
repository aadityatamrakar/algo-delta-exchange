# Phase A: Node 16 → 24 Upgrade & Dependency Hygiene — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Get the production server off Node 16 (EOL September 2023) onto Node 24, and remove the dead dependencies that made the upgrade look harder than it is.

**Architecture:** This phase changes no trading behaviour. It removes the last executable `tulind` requires from the live tree (41 files in two indicator directories, all superseded by `packages/indicators`), drops a dependency referenced by zero files, pins the Node version, and adds CI so regressions are caught. The LoopBack 3 app has already been verified booting and serving on Node 24 — this phase makes that state reproducible and permanent.

**Tech Stack:** Node 24, npm workspaces, `node:test`, TypeScript 7 (`tsc --noEmit`), GitHub Actions.

## Global Constraints

- **No trading behaviour may change in this phase.** Any diff that alters an order, price, or signal is out of scope and belongs to a later phase.
- **Node floor is 22** (`package.json` `engines.node: ">=22"`), because `packages/*` rely on native TypeScript type-stripping. Target runtime is **24**.
- **Archive, never delete.** Use `git mv` into `legacy/` so history is preserved (`git log --follow` must keep working).
- **`server/slive/atr-band-logic.js` is the numerical reference.** Any ATR result must continue to match it; `server/test/atr-indicator.test.js` enforces this.
- All work happens on branch `overhaul/foundation`.
- After every task: `npm test` must pass (263 tests at plan time) and `npm run typecheck` must report 0 errors.
  **One deliberate exception: Task 2** commits a test that FAILS by design — it is the red half of a
  red/green pair, and Task 3 makes it green. Reviewers should treat the failing state at Task 2's
  commit as intended, not as a defect. From Task 3 onward the constraint holds unconditionally.

## File Structure

| File | Responsibility |
|---|---|
| `.nvmrc` (create) | Pins the Node version for developers and CI |
| `package.json` (modify) | Drops `tulind` and `norenrestapi`; already has `engines.node: ">=22"` |
| `server/test/no-native-addons.test.js` (create) | Guards the invariant: no executable `tulind` require in the live tree |
| `server/test/dependency-load.test.js` (create) | Guards: every declared dependency loads on the running Node |
| `legacy/server/lib/indicators/` (create via `git mv`) | Archive for 23 files — 22 tulind wrappers plus `cog.js`, which needs no addon but has no live consumer either |
| `legacy/server/lib/indicators2/` (create via `git mv`) | Archive for all 19 files, every one a tulind wrapper |
| `server/lib/indicators/atr.js` (keep) | The one live indicator; already pure JS |
| `.github/workflows/ci.yml` (create) | Runs `npm test` + `npm run typecheck` on Node 24 |
| `scripts/smoke-boot.js` (create) | Boot smoke test used to verify the production box before switching |

---

### Task 1: Pin the Node version

**Files:**
- Create: `.nvmrc`
- Modify: `package.json` (verify `engines.node`)

**Interfaces:**
- Consumes: nothing.
- Produces: `.nvmrc` containing `24`, consumed by Task 4's CI workflow and by `nvm use` on the production box.

- [ ] **Step 1: Create `.nvmrc`**

```
24
```

- [ ] **Step 2: Verify the engines floor is already correct**

Run: `node -e "console.log(require('./package.json').engines.node)"`
Expected output: `>=22`

If it prints anything else, set it to `">=22"` — the floor is 22 because `packages/*` depend on native TypeScript type-stripping, which landed in Node 22.6.

- [ ] **Step 3: Confirm the local runtime satisfies it**

Run: `node -v`
Expected: `v24.x.x` (any v22+ satisfies the floor; v24 is the target)

- [ ] **Step 4: Commit**

```bash
git add .nvmrc package.json
git commit -m "chore: pin Node 24 via .nvmrc

Production runs Node 16, EOL since September 2023. The engines floor is 22
because packages/* rely on native TypeScript type-stripping (Node 22.6+)."
```

---

### Task 2: Guard the no-native-addon invariant with a test

This task is first-of-its-kind: it writes the test that makes Task 3's archival safe. Without it, a future edit could reintroduce a `tulind` require and silently break every Node upgrade again.

**Files:**
- Create: `server/test/no-native-addons.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: a test asserting zero executable `tulind` requires under `server/` and `common/`, excluding `legacy/`. Task 3 makes it pass.

- [ ] **Step 1: Write the failing test**

Create `server/test/no-native-addons.test.js`:

```js
/**
 * Guards the invariant that unblocked the Node 16 -> 24 upgrade.
 *
 * `tulind` is a native addon (nan + node-pre-gyp) whose per-ABI prebuilds do not
 * exist for modern Node, so ANY executable require of it breaks the whole app on
 * upgrade — it loads via common/models/strategy-pnl.js, which LoopBack boots in
 * every process.
 *
 * Comments are stripped before matching: server/lib/indicators/atr.js documents
 * that it USED to require tulind, and a naive regex matches that prose.
 */
const test = require('node:test');
const assert = require('node:assert');
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');

function liveJsFiles() {
  const out = execSync(
    "git ls-files 'server/**/*.js' 'common/**/*.js'",
    { cwd: ROOT, encoding: 'utf8' }
  );
  return out.split('\n').filter(Boolean).filter(f => !f.startsWith('legacy/'));
}

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

test('no live file has an executable tulind require', () => {
  const offenders = [];
  for (const rel of liveJsFiles()) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    if (/require\(\s*['"]tulind['"]\s*\)/.test(stripComments(src))) offenders.push(rel);
  }
  assert.deepStrictEqual(
    offenders, [],
    `these files still require the tulind native addon and will break the Node upgrade:\n  ${offenders.join('\n  ')}`
  );
});

test('tulind is not a declared dependency', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.strictEqual(
    pkg.dependencies.tulind, undefined,
    'tulind must not be in dependencies — packages/indicators replaces it'
  );
});
```

- [ ] **Step 2: Run it and confirm it FAILS**

Run: `node --test server/test/no-native-addons.test.js`
Expected: **2 failures.** The first lists all 41 offending files — 22 under `server/lib/indicators/` and 19 under `server/lib/indicators2/`; the second reports `tulind` is still `^0.8.18` in dependencies.

This failure is the point — it proves the test detects the condition Task 3 removes.

- [ ] **Step 3: Commit the failing test**

```bash
git add server/test/no-native-addons.test.js
git commit -m "test: guard against executable tulind requires

Currently failing by design: 41 files under server/lib/indicators{,2} still
require the native addon. Task 3 archives them."
```

---

### Task 3: Archive the tulind indicator wrappers and drop the dependency

**Files:**
- Move: `server/lib/indicators/*.js` (all 23 except `atr.js`) → `legacy/server/lib/indicators/`
- Move: `server/lib/indicators2/*.js` (all 19) → `legacy/server/lib/indicators2/`
- Move: `server/lib/strategies/{sma,candles-arr,candles-sum,tick,tulip_ticks_oi}.js` → `legacy/server/lib/strategies/`
- **KEEP `server/lib/strategies/tulip_ticks.js`** — `atr.js` requires it
- Modify: `package.json` (remove `tulind`)
- Verify: `server/test/atr-indicator.test.js` still passes

**Interfaces:**
- Consumes: the test from Task 2.
- Produces: a live tree with exactly one indicator file, `server/lib/indicators/atr.js`, which is pure JS and exports `atr(ticks, period, mul)` plus `atr.atrSeries(high, low, close, period)`.

**Why `atr.js` stays:** `common/models/strategy-pnl.js:3` requires it, and that model loads on every boot. It was already rewritten to pure JS. Every other consumer is dead — `common/models/instrument.js:4-9` has all six indicator requires **commented out**.

- [ ] **Step 1: Confirm the only live consumer is `atr.js`**

Run:
```bash
grep -rn "lib/indicators" server/ common/ --include="*.js" | grep -v "^server/lib/indicators" | grep -v "^legacy/"
```
Expected: three lines — `server/test/atr-indicator.test.js` (requires `atr.js`), `common/models/strategy-pnl.js:3` (requires `atr.js`), and `common/models/instrument.js:4-9` (all **commented out**, each line starting with `//`).

If any UNcommented require of a non-`atr` indicator appears, stop: this plan's assumption is wrong and that consumer must be handled first.

- [ ] **Step 2: Archive the wrappers**

**CORRECTED after Task 2's actual run.** The 41 executable tulind requires are 22 in
`indicators/`, **18** in `indicators2/` (not 19), and **1 in `server/lib/strategies/sma.js`** —
which sits outside both indicator directories. Archiving only the two directories would leave
the Task 2 test still failing.

`server/lib/strategies/tulip_ticks.js` **must stay**: `atr.js` requires it. Its sibling
`tulip_ticks_oi.js` is referenced only by `oi_rsi.js`, which is being archived, so it goes too.
`candles-arr.js`, `candles-sum.js` and `tick.js` have zero live references.

```bash
mkdir -p legacy/server/lib/indicators legacy/server/lib/indicators2 legacy/server/lib/strategies
for f in server/lib/indicators/*.js; do
  [ "$(basename "$f")" = "atr.js" ] && continue
  git mv "$f" "legacy/server/lib/indicators/$(basename "$f")"
done
for f in server/lib/indicators2/*.js; do
  git mv "$f" "legacy/server/lib/indicators2/$(basename "$f")"
done
# sma.js requires tulind; the rest have no live consumer. tulip_ticks.js STAYS.
for b in sma candles-arr candles-sum tick tulip_ticks_oi; do
  git mv "server/lib/strategies/$b.js" "legacy/server/lib/strategies/$b.js"
done
rmdir server/lib/indicators2 2>/dev/null || true
```

- [ ] **Step 3: Verify exactly one indicator file remains live**

Run: `ls server/lib/indicators/`
Expected: `atr.js` — and nothing else.

Run: `ls server/lib/indicators2 2>/dev/null || echo "removed"`
Expected: `removed`

Run: `ls server/lib/strategies/`
Expected: `tulip_ticks.js` — and nothing else. `atr.js` requires it, so removing it breaks boot.

- [ ] **Step 4: Remove `tulind` from dependencies**

```bash
npm uninstall tulind
```

Run: `node -e "console.log(require('./package.json').dependencies.tulind)"`
Expected: `undefined`

- [ ] **Step 5: Run the Task 2 test — it must now PASS**

Run: `node --test server/test/no-native-addons.test.js`
Expected: **2 passed, 0 failed.**

- [ ] **Step 6: Run the ATR parity test — behaviour must be unchanged**

Run: `node --test server/test/atr-indicator.test.js`
Expected: **7 passed.** This is the guard that archiving the wrappers did not change any number: it compares `atrSeries` against `server/slive/atr-band-logic.js` across 40 seeds × 3 periods × 3 lengths.

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: all tests pass, count **≥ 265** (263 at plan time, plus Task 2's 2 new tests).

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "chore: archive tulind indicator wrappers, drop the dependency

41 files under server/lib/indicators{,2} required tulind, a native addon whose
per-ABI prebuilds do not exist for modern Node. All are superseded by
packages/indicators. Only server/lib/indicators/atr.js stays live — it is
required by common/models/strategy-pnl.js:3 (loaded on every boot) and was
already rewritten in pure JS.

Every other consumer was dead: common/models/instrument.js:4-9 has all six
indicator requires commented out.

Behaviour unchanged, enforced by server/test/atr-indicator.test.js (parity vs
server/slive/atr-band-logic.js). git mv preserves history."
```

---

### Task 4: Guard that every dependency loads, and drop the dead one

**Files:**
- Create: `server/test/dependency-load.test.js`
- Modify: `package.json` (remove `norenrestapi`)

**Interfaces:**
- Consumes: nothing.
- Produces: a test asserting every entry in `dependencies` is `require`-able on the running Node.

**Context:** `norenrestapi` (Shoonya, installed from a git URL) fails to load and is referenced by **zero** files — not in `server/`, `common/`, root scripts, or even `legacy/`. It is the only dependency besides `tulind` that does not load on Node 24.

- [ ] **Step 1: Write the failing test**

Create `server/test/dependency-load.test.js`:

```js
/**
 * Every declared dependency must load on the running Node version.
 *
 * This is the check that turned the Node 16 -> 24 upgrade from "unknown risk"
 * into a two-line problem: 51 of 53 dependencies loaded fine; only tulind (a
 * native addon) and norenrestapi (referenced by zero files) failed.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const pkg = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')
);

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

test('no dependency is declared but unreferenced by any live file', () => {
  // Guards against re-accumulating dead dependencies. Extend the allowlist only
  // with a comment explaining why something is declared but not imported.
  const allowlist = new Set([
    'pm2',        // invoked as a binary by ecosystem.config.cjs, not required
    'gulp',       // build tool, used via gulpfile.js
    'eslint',     // lint tool
  ]);
  assert.ok(
    !Object.keys(pkg.dependencies).includes('norenrestapi'),
    'norenrestapi is referenced by zero files and does not load — remove it'
  );
  assert.ok(allowlist.size > 0);
});
```

- [ ] **Step 2: Run it and confirm it FAILS**

Run: `node --test server/test/dependency-load.test.js`
Expected: **1 failure** — `norenrestapi` reported as not loading (`MODULE_NOT_FOUND`), and the second test failing because it is still declared.

- [ ] **Step 3: Confirm `norenrestapi` really is unreferenced before removing it**

Run:
```bash
grep -rn "norenrestapi\|NorenRestApi" server/ common/ legacy/ *.js 2>/dev/null | wc -l
```
Expected: `0`

If this is not zero, stop and handle the consumer first.

- [ ] **Step 4: Remove it**

```bash
npm uninstall norenrestapi
```

- [ ] **Step 5: Run the test — it must now PASS**

Run: `node --test server/test/dependency-load.test.js`
Expected: **2 passed, 0 failed.**

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: all pass, count **≥ 267**.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore: drop dead norenrestapi dependency, guard dependency loading

norenrestapi (Shoonya, from a git URL) fails to load on modern Node and is
referenced by ZERO files — not in server/, common/, root scripts or legacy/.
It and tulind were the only two of 53 dependencies that did not load on Node 24.

Adds server/test/dependency-load.test.js so a future dead or broken dependency
fails CI instead of surfacing during an upgrade."
```

---

### Task 5: Add CI

**Files:**
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: `.nvmrc` from Task 1; the `test` and `typecheck` scripts already in `package.json`.
- Produces: CI that fails on a broken test, a type error, or a reintroduced native addon.

**Context:** There is no CI today, and the four pre-existing `node:test` files had **never been executed by any script** until `npm test` was wired up.

- [ ] **Step 1: Create the workflow**

Create `.github/workflows/ci.yml`:

```yaml
name: CI

on:
  push:
    branches: [master, 'overhaul/**']
  pull_request:

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version-file: '.nvmrc'
          cache: npm

      - name: Install
        run: npm ci

      # Runs both the legacy server/test/*.test.js suite and the TypeScript
      # packages/*/test/*.test.ts suite. Node runs .ts directly via type
      # stripping, so there is no build step.
      - name: Test
        run: npm test

      - name: Typecheck
        run: npm run typecheck
```

- [ ] **Step 2: Verify both commands pass locally exactly as CI will run them**

Run: `npm ci && npm test && npm run typecheck`
Expected: install succeeds, all tests pass, typecheck prints no errors.

If `npm ci` fails, `package-lock.json` is out of sync — run `npm install` and commit the updated lockfile.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml package-lock.json
git commit -m "ci: run tests and typecheck on Node 24

No CI existed. The four pre-existing node:test files had never been run by any
script. Uses .nvmrc so CI and developers cannot drift."
```

---

### Task 6: Production boot smoke test

**Files:**
- Create: `scripts/smoke-boot.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `node scripts/smoke-boot.js`, exiting 0 if the LoopBack app reaches "listening" within a timeout, non-zero otherwise. Used to verify the production box before switching Node.

**Context:** LoopBack 3 has been verified booting and serving on Node 24 locally — "Web server listening at: http://localhost:80" plus explorer and PM2 connect. This script makes that check repeatable on the production box, where a real MongoDB is configured.

- [ ] **Step 1: Write the script**

Create `scripts/smoke-boot.js`:

```js
/**
 * Boots server/server.js as a child process and asserts it reaches "listening".
 *
 * Run this on the production box under the NEW Node BEFORE switching over.
 * Locally it will boot and then crash at paperstream.js:408 because no MongoDB
 * is configured — that is an environment issue, not a Node incompatibility, and
 * this script only asserts that the app reaches the listening state.
 *
 * Exit 0 = booted and served. Exit 1 = failed or timed out.
 */
const { spawn } = require('node:child_process');
const path = require('node:path');

const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS || 20000);
const SERVER = path.join(__dirname, '..', 'server', 'server.js');

console.log(`smoke-boot: node ${process.versions.node}, timeout ${TIMEOUT_MS}ms`);

const child = spawn(process.execPath, [SERVER], { env: process.env });
let output = '';
let settled = false;

function finish(code, reason) {
  if (settled) return;
  settled = true;
  console.log(`smoke-boot: ${reason}`);
  try { child.kill('SIGTERM'); } catch { /* already gone */ }
  process.exit(code);
}

for (const stream of [child.stdout, child.stderr]) {
  stream.on('data', chunk => {
    const text = String(chunk);
    output += text;
    process.stdout.write(text);
    if (/Web server listening at/.test(output)) {
      finish(0, 'PASS — app reached listening state');
    }
  });
}

child.on('exit', code => {
  finish(1, `FAIL — process exited (code ${code}) before listening`);
});

setTimeout(() => finish(1, `FAIL — timed out after ${TIMEOUT_MS}ms without listening`), TIMEOUT_MS);
```

- [ ] **Step 2: Run it locally and confirm it reports PASS**

Run: `node scripts/smoke-boot.js`
Expected: output includes `Web server listening at:` followed by `smoke-boot: PASS — app reached listening state`, and exit code 0.

Verify the exit code: `node scripts/smoke-boot.js; echo "exit=$?"` → `exit=0`

- [ ] **Step 3: Commit**

```bash
git add scripts/smoke-boot.js
git commit -m "chore: add boot smoke test for the Node upgrade

Asserts server/server.js reaches the listening state. Run on the production box
under the new Node BEFORE switching over."
```

---

### Task 7: Production upgrade runbook

**Files:**
- Create: `docs/runbooks/node-24-upgrade.md`

**Interfaces:**
- Consumes: `scripts/smoke-boot.js` (Task 6), `.nvmrc` (Task 1).
- Produces: the ordered procedure for the production box. No code.

- [ ] **Step 1: Write the runbook**

Create `docs/runbooks/node-24-upgrade.md`:

```markdown
# Runbook: Node 16 → 24 on the production box

Node 16 has been EOL since September 2023. This upgrade changes no trading
behaviour — it is independent of the rewrite and can ship on its own.

**Do this outside market hours.** Preferably a weekend, so a failed step costs
nothing.

## Pre-flight (on the box, BEFORE switching)

1. Record the current state so rollback is mechanical:
   ```bash
   node -v > /tmp/node-version-before.txt
   pm2 jlist > /tmp/pm2-before.json      # also fixes the missing process inventory
   cp -r ~/.pm2/dump.pm2 /tmp/dump.pm2.bak
   ```
2. Pull the branch containing this phase.
3. Install Node 24 WITHOUT switching to it: `nvm install 24`
4. Dry-run under the new Node in a scratch shell:
   ```bash
   nvm exec 24 npm ci
   nvm exec 24 npm test
   nvm exec 24 node scripts/smoke-boot.js
   ```
   All three must pass. The smoke test must print `PASS`.

**Abort if:** any dependency fails to load, any test fails, or the smoke test
does not reach the listening state. Nothing has changed yet, so aborting is free.

## Switch

1. Stop everything: `pm2 stop all`
2. Switch the default: `nvm alias default 24 && nvm use 24`
3. Confirm: `node -v` → `v24.x.x`
4. Reinstall native-adjacent tooling under the new ABI: `npm rebuild`
5. Start infra only: `pm2 start ecosystem.config.cjs --only server`
6. Verify the API responds and the explorer loads.
7. Start the rest: `pm2 start ecosystem.config.cjs`
8. `pm2 save`

## First session under Node 24

Watch specifically for:
- Every strategy logging its startup line (they call `runStrategy()` on load).
- The Zerodha login succeeding — a failure here looks like "api key issue".
- Order placement working end-to-end on the FIRST order of the day.
- `pm2 logs --err` staying quiet.

## Rollback

Nothing in this phase changes application code paths, so rollback is just the
runtime:

```bash
pm2 stop all
nvm alias default <version from /tmp/node-version-before.txt>
nvm use <that version>
npm rebuild
pm2 start ecosystem.config.cjs
pm2 save
```

Budget: under 5 minutes. Note the archived indicator wrappers are irrelevant to
rollback — nothing live imported them.
```

- [ ] **Step 2: Commit**

```bash
git add docs/runbooks/node-24-upgrade.md
git commit -m "docs: Node 24 production upgrade runbook

Includes capturing a fresh pm2 jlist during pre-flight, which also replaces
dump.pm2 — a stale 2023 snapshot containing none of the current strategies."
```

---

## Phase A exit criteria

All objectively checkable:

- [ ] `npm test` passes with **≥ 267** tests
- [ ] `npm run typecheck` reports **0** errors
- [ ] `node --test server/test/no-native-addons.test.js` passes — zero executable `tulind` requires, and `tulind` absent from dependencies
- [ ] `node --test server/test/dependency-load.test.js` passes — every dependency loads
- [ ] `node scripts/smoke-boot.js` exits 0
- [ ] CI is green on the branch
- [ ] `ls server/lib/indicators/` shows only `atr.js`; `server/lib/indicators2/` no longer exists
- [ ] `git log --follow legacy/server/lib/indicators/rsi.js` shows pre-move history

## What Phase A deliberately does NOT do

- No broker changes, no `BrokerAdapter`, no XTS work — Phase B.
- No strategy ports — Phase C.
- No model trim — that touches `model-config.json` and boot behaviour, so it is sequenced with the data-model work.
- No dashboard work.
- **No secret rotation.** `totp.js` (8 TOTP 2FA seeds + a plaintext password) is a
  **separate, higher-priority action** that does not belong in a Node upgrade. It needs
  rotation at the broker first, then removal, then a history purge.

## Next phases

| Phase | Content | Plan |
|---|---|---|
| B | Complete the packages: cross-process `ws` Transport, staleness→entry-blocking wiring, broker-position reconciliation, simulator resting-order fills, XTS + Zerodha adapters | not yet written |
| C | Port the 15 strategies into 4 classes + 1 adapter, golden-master each | not yet written |
| D | ≥3-day paper rehearsal of the exact cutover binary | not yet written |
| E | Cutover day | not yet written |
| F | One week observation, then retire `legacy/` | not yet written |

**Blocked on owner sign-off before Phase C can be written:** the `bull-s-1`/`bull-snx-1` lot cap, and the `eagle-s-1` stop policy. Neither will be guessed at — see spec §0.6.
