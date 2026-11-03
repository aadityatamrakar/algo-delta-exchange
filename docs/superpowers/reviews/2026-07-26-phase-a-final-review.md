# Phase A final whole-branch review — findings to fix

Verdict: **code is sound to merge; the cutover procedure is not.** No trading behaviour changed
(verified numerically: 2,513,200 ATR samples, 0 shape mismatches, max rel diff 1.6e-15; and
687,600 Supertrend bars × 3 (period,mul) combos in raw and tick-rounded regimes → **0
`supertrendTrg` differences**). The Supertrend band/flip loop is byte-identical apart from
`for (i = …)` → `for (let i = …)`, which only scopes what were implicit globals.

All four Critical findings are in `scripts/smoke-boot.js` and `docs/runbooks/node-24-upgrade.md`.

---

## CRITICAL

### C1 — the pre-flight gate is guaranteed to fail on a live box, and the runbook says to abort
`docs/runbooks/node-24-upgrade.md:19-28`

Pre-flight step 4 runs `nvm exec 24 node scripts/smoke-boot.js` **before** `pm2 stop all` (Switch
step 1, line 32). `server/config.json:4` hardcodes `"port": 80`, already held by the live `server`
process. LoopBack's `app.listen` (`server/server.js:55`) attaches no `'error'` handler, so
`EADDRINUSE` is an uncaught exception → child exits → `smoke-boot.js:42-44` → `finish(1, 'FAIL…')`.
Lines 27-28 then instruct: "**Abort if:** … the smoke test does not reach the listening state."
Net effect: **a healthy Node 24 upgrade is aborted every time.**

**Fix:** move the smoke test to AFTER `pm2 stop all`, AND give it a scratch port so a clash cannot
cause a false abort. Add `server/config.smoke.json`:
`{"restApiRoot":"/api","host":"127.0.0.1","port":31780}` and have smoke-boot spawn with
`env: {...process.env, NODE_ENV: 'smoke'}` — `loopback-boot` loads `config.<NODE_ENV>.json`.

### C2 — smoke-boot boots a full PRODUCTION instance: Zerodha login + live change streams
`scripts/smoke-boot.js:19`

`spawn(process.execPath, [SERVER], { env: process.env })` runs `server/server.js` with no datasource
or mode override. `server/model-config.json` binds 17 models (incl. `paper-trade`, `positional`,
`orderbook2`, `xtsAccount`) to the `cloud` datasource, whose **production** Mongo host/user/password
are committed in `server/datasources.json`. The guard at `server/boot/paperstream.js:404`
(`require.main.filename … === 'server.js'`) is exactly TRUE for a spawned `node server/server.js`,
so the gate opens and:
- `startSocket()` (`paperstream.js:285-299`) performs `zapi_base.login()`. Zerodha allows ONE active
  session per API key → **this invalidates the running instance's access token.**
- `paperstream.js:418-420` opens `collection.watch()` on `paper-trade`, `positional`, `algopaper`.

Worse, `server/server.js:56` emits `'started'` BEFORE the listening log on line 58, so all of that is
already in flight by the time smoke-boot matches PASS.

This is exactly the failure the runbook tells the operator to watch for (line 45), and the runbook
instructs them to cause it. Today it is masked only by C1's port clash.

**Also:** the header comment at `smoke-boot.js:5-6` ("because no MongoDB is configured") is
**factually wrong** — `server/datasources.json` configures one. The observed local crash at
`paperstream.js:408` is `XtsAccount.find` erroring so `accounts` is `undefined`.

**Fix:** the same `NODE_ENV=smoke` mechanism, plus `server/datasources.smoke.json` pointing every
model at the `memory` connector. Alternatively add `&& !process.env.SMOKE_BOOT` to the
`paperstream.js:404` guard and set `SMOKE_BOOT=1` in smoke-boot's spawn env. Correct the header
comment either way.

### C3 — "non-mutating dry-run" wipes node_modules under the running production processes
`docs/runbooks/node-24-upgrade.md:19-28`

`nvm exec 24 npm ci` (line 21) deletes `node_modules` wholesale before reinstalling, while ~150 pm2
processes are still live. Any lazy `require()` in that window fails `MODULE_NOT_FOUND`, and pm2
`autorestart` will restart a crashed strategy against a half-populated tree. Line 28's "Nothing has
changed yet, so aborting is free" is false the moment `npm ci` starts.

**Fix:** run pre-flight on a copy — `git clone . /tmp/preflight && cd /tmp/preflight &&
nvm exec 24 npm ci && nvm exec 24 npm test` — or move `npm ci` after `pm2 stop all`. Delete the
"nothing has changed yet" claim.

### C4 — the switch never runs `pm2 update`, so everything silently stays on Node 16
`docs/runbooks/node-24-upgrade.md:30-39`

`ecosystem.config.cjs` sets no `interpreter`, so pm2 forks children using the interpreter from the
**daemon's** captured environment. `pm2 stop all` does not restart the daemon; `nvm use 24` only
changes the operator's shell. A daemon started under Node 16 keeps forking Node 16 children. The
runbook's only check, `node -v` (line 34), reports the SHELL's version. **The operator completes all
8 steps, sees green, and is still entirely on Node 16 — the upgrade silently does not happen.**

**Fix:** insert `pm2 update` between lines 34 and 35 (kills and respawns the daemon under the current
Node, preserving the process list); change step 6's verification to assert the actual child runtime
via `pm2 describe server`; add the mirror step to Rollback.

---

## IMPORTANT

### I1 — `dependency-load.test.js` test 2 is vacuous; its name promises a guard it does not implement
`server/test/dependency-load.test.js:32-45`

Named `'no dependency is declared but unreferenced by any live file'`, it builds an `allowlist`
(35-39), **never uses it**, hardcodes a `norenrestapi` check (40-43), and closes with
`assert.ok(allowlist.size > 0)` (44) — a tautology. Any new unreferenced dependency passes.
Also: `eslint` is in **devDependencies** but the test only iterates `dependencies`, so that allowlist
entry could never matter. And `kiteconnect` + `xts-marketdata-api` ARE in `dependencies` and are
documented as unreferenced (`context/02-backend-architecture.md:162`), so an honest implementation
would fail today. This came verbatim from the plan — a plan defect faithfully implemented.

**Fix (pick one):** implement it — `git grep` each dependency name across the live tree, assert
`offenders ⊆ allowlist`, seeding with `pm2`/`gulp`/`kiteconnect`/`xts-marketdata-api` and dated
comments — OR rename it to `'norenrestapi stays removed'` and delete the dead allowlist so it stops
advertising coverage it lacks.

### I2 — `no-native-addons.test.js` only inspects git-TRACKED files
`server/test/no-native-addons.test.js:20-26`

Proven experimentally by the reviewer: with an untracked `server/lib/__guard_probe.js` containing
`require('tulind')`, the suite reported 2 pass / 0 fail; after `git add -N` it correctly failed.
So the invariant binds only in CI, not for a developer pre-commit. Also the pathspecs miss the 12
tracked root scripts, all of `packages/`, and `.cjs`/`.mjs`/`.ts`.

**Fix:** walk the filesystem (`fs.readdirSync(ROOT, {recursive:true})`, skipping `node_modules`,
`legacy/`, `.git`) and widen the extension set to `.js|.cjs|.mjs|.ts`. Note the
`!f.startsWith('legacy/')` filter at line 25 is dead code under the current pathspecs — a filesystem
walk makes it load-bearing again.

### I3 — smoke-boot latches PASS on the first listening line, so it exits 0 for an app that then crashes
`scripts/smoke-boot.js:36-38`

PASS means only "the HTTP listener bound", never "healthy". Any boot failure after listen — the
`paperstream.js:407-408` `accounts.length` throw, a Zerodha login failure, a change-stream
permission error — is reported as PASS. The runbook elevates this to THE gate (line 25).

**Fix:** after matching, hold for a settle window (`SMOKE_SETTLE_MS`, default 5000) and only then
exit 0, treating a child exit inside that window as FAIL. Add the missing `child.on('error', …)`.
Have `finish` await child exit rather than letting `process.exit(code)` (line 28) race the SIGTERM
(line 27).

### I4 — pm2 4.5.6 on Node 24 is entirely unverified, and it runs all ~150 processes
`pm2` is pinned `^4.5.6` (installed 4.5.6, a 2021 release). `dependency-load.test.js:21` does
`require('pm2')`, which loads only the API client — not the God daemon, CLI, or its
`pidusage`/`vizion`/`chokidar` paths. CI never touches pm2; smoke-boot runs `server.js` directly.
Combined with C4, the process supervisor is an unexercised dependency on the critical path.
The reviewer explicitly did NOT determine whether it works — a live daemon (pid 51758) was running
and probing it risked disturbing real strategies. This is "unverified and unguarded", not "broken".

**Fix:** add a pre-flight step exercising the daemon under the new Node in isolation, using a scratch
`PM2_HOME` so the live daemon is untouched:
`PM2_HOME=/tmp/pm2-smoke nvm exec 24 npx pm2 start ecosystem.config.cjs --only server &&
PM2_HOME=/tmp/pm2-smoke npx pm2 describe server && PM2_HOME=/tmp/pm2-smoke npx pm2 delete all &&
PM2_HOME=/tmp/pm2-smoke npx pm2 kill`
The reviewer calls this the single highest-value missing check in the phase.

### I5 — "Nothing in this phase changes application code paths" is false
`docs/runbooks/node-24-upgrade.md:51`

Step 2 has the operator pull the branch, which includes `c6d4dd6b`: the `atr.js` rewrite, ~850
deleted client/build files, `client/email.html` → `server/templates/`, and the archived server dirs.
Rollback (54-61) reverts only the Node version, so the box still runs all that new code under
Node 16. It will function, but rollback does not restore the pre-branch state.

**Fix:** record the pre-pull commit in pre-flight (`git rev-parse HEAD > /tmp/git-sha-before.txt`),
add `git checkout $(cat …)` + `npm ci` to Rollback, and replace line 51 with an accurate statement.

---

## MINOR (fix if cheap, else defer)

- **M1** `runbook:36-38` — step 7's bare `pm2 start ecosystem.config.cjs` restarts `server`, which
  step 5 just verified. Use `--only strategies` or note the bounce.
- **M2** `runbook:15` — `cp -r` on `dump.pm2`, a file. Drop `-r`. The `pm2 jlist` on line 14 is the
  real artefact; the stale-2023 dump has little value.
- **M3** `.nvmrc:1` — no trailing newline. `asdf`/`fnm` and some nvm wrappers read it naively.
- **M4** `.github/workflows/ci.yml` — no `permissions:` block, no `concurrency` group, and
  `npm run lint` is never run. `eslint` resolves to **3.19.0 (2017)** and is a devDependency, so it
  is outside `dependency-load.test.js` coverage and very likely broken on Node 24. Either wire lint
  in or delete the script so it doesn't look available.
- **M5** `server/test/atr-indicator.test.js:88-101` — Supertrend output is never pinned to a
  reference; only "is a number" and `upperband > lowerband`. Fine for THIS diff (loop byte-identical,
  0 flip differences over 687,600 bars) but the file header over-promises. Cheap fix: commit a frozen
  fixture of 200 candles + the resulting `supertrendTrg` array.

---

## SECURITY POSTURE — flagged as NOT coherent

- Deleting `finvasia.js` removes it from the tree, **not from history**.
  `git show 8b438f6c^:legacy/root/extra/finvasia.js` still prints the full set, also reachable from
  `3c9b18c7` and `c6d4dd6b` at the old `extra/finvasia.js` path. The branch is pushed. My commit
  subject reads as remediation but is really "stop shipping it going forward" — **soften it so nobody
  treats rotation as closed.**
- **`server/datasources.json` commits the production MongoDB host, username and password** for the
  `cloud` datasource that 17 models bind to — and it is NOT gitignored. Flagged nowhere before now.
- `totp.js` (8 TOTP seeds + plaintext password) also still tracked and not gitignored.
- Genuine win: after this branch the only native binaries left are two optional macOS-only
  `fsevents` artefacts. On the Linux production box the tree is now free of native addons — which is
  what makes the runtime swap low-risk.

---

## CONTROLLER ERROR TO RECORD

The review range I supplied (`8ecdf86d..HEAD`, 10 commits) **excluded `c6d4dd6b`** — the commit
containing the ATR/Supertrend rewrite and the ~850-file client/build deletion. The primary review
question was therefore not answerable in the range I gave. The reviewer noticed and reviewed
`master..HEAD` (19 commits) instead. Any future review of this branch must use the merge-base.
