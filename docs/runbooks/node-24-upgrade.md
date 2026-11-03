# Runbook: Node 16 → 24 on the production box

Node 16 has been EOL since September 2023. This upgrade is independent of the
rewrite and can ship on its own — but pulling the branch that contains it also
pulls everything else on `overhaul/foundation` up to this point, including the
`atr.js` indicator rewrite, ~850 deleted client/build files, and the archived
server directories (see step 2 and Rollback below: this phase does NOT leave
application code paths untouched, only trading *behaviour* unchanged).

**Do this outside market hours.** Preferably a weekend, so a failed step costs
nothing.

## Pre-flight (on the box, BEFORE switching)

1. Record the current state so rollback is mechanical:
   ```bash
   node -v > /tmp/node-version-before.txt
   git rev-parse HEAD > /tmp/git-sha-before.txt   # so Rollback can restore the exact tree, not just the Node version
   pm2 jlist > /tmp/pm2-before.json               # also fixes the missing process inventory
   cp ~/.pm2/dump.pm2 /tmp/dump.pm2.bak           # dump.pm2 is a FILE — no -r
   ```
2. Pull the branch containing this phase.
3. Install Node 24 WITHOUT switching to it: `nvm install 24`
4. Dry-run `npm ci` + the test suite under the new Node **on a disposable clone**,
   never in place. `npm ci` deletes `node_modules` wholesale before reinstalling;
   doing that in the live checkout while ~150 pm2 processes still `require()`
   out of it will `MODULE_NOT_FOUND`-crash them mid-install, and pm2's
   `autorestart` will then restart a crashed strategy against a half-populated
   tree.
   ```bash
   rm -rf /tmp/preflight-node24
   git clone . /tmp/preflight-node24
   cd /tmp/preflight-node24
   nvm exec 24 npm ci
   nvm exec 24 npm test
   nvm exec 24 npm run typecheck
   cd -
   ```
5. Exercise the pm2 daemon itself under Node 24, in total isolation from the
   live daemon, via a scratch `PM2_HOME`. `pm2` is pinned to `4.5.6` (a 2021
   release) and nothing else in CI or this runbook ever touches the daemon, CLI,
   or its `pidusage`/`vizion`/`chokidar` paths — only the API client
   (`require('pm2')`) is exercised elsewhere. **Do not point this at
   `~/.pm2` or omit `PM2_HOME` — that would touch the live daemon.**

   Use a SHORT `PM2_HOME` path — pm2 puts unix-domain sockets under it, and a
   long path (e.g. a deeply nested tmp dir) overflows the OS socket-path limit
   with a confusing `EINVAL` on connect that looks like a Node 24 bug but
   isn't. `/tmp/pm2-smoke-preflight` is short enough.

   Launch `scripts/smoke-boot.js` itself as the pm2-managed process, NOT
   `ecosystem.config.cjs --only server`. This still proves the daemon/CLI can
   spawn, track, and report the interpreter version of a real child under
   Node 24 — but unlike `server`, it stays safe even though
   `ecosystem.config.cjs`'s `base.env` hardcodes `NODE_ENV: 'production'`
   (which pm2 would inject ahead of anything in the parent shell, silently
   defeating an attempt to pass `NODE_ENV=smoke` on the command line here).
   `smoke-boot.js` sets its OWN child's env internally regardless of what pm2
   hands to the `smoke-boot.js` process itself, so the Zerodha-login/
   change-stream guard from Switch step 2 still applies:
   ```bash
   export PM2_HOME=/tmp/pm2-smoke-preflight
   nvm exec 24 npx pm2 start scripts/smoke-boot.js --name smoke-boot --no-autorestart
   sleep 9 && npx pm2 logs smoke-boot --lines 100 --nostream   # must show PASS
   npx pm2 describe smoke-boot   # confirm node.js version: 24.x
   npx pm2 delete all
   npx pm2 kill
   unset PM2_HOME
   ```

**Abort if:** step 4 fails (any dependency fails to load, any test fails, or
typecheck errors) or step 5's `smoke-boot` logs don't show `PASS` / `pm2
describe smoke-boot` doesn't report Node 24. Nothing on the live box has
changed yet, so aborting here is free — step 4 ran entirely in
`/tmp/preflight-node24`, and step 5 ran under a throwaway `PM2_HOME`.

## Switch

1. Stop everything: `pm2 stop all`
2. **Now** — with the live `server` process no longer holding port 80 — smoke
   test the real app under Node 24, still without switching the default
   interpreter. This does not actually depend on port 80 being free (it binds
   `127.0.0.1:31780` via `server/config.smoke.json`, loaded through
   `NODE_ENV=smoke`), but running it here, after everything is stopped, means a
   failure can't be confused with interference from the live process, and there
   is no live process for a stray signal or open handle to disturb.
   `SMOKE_BOOT=1` (set internally by the script) also disables the Zerodha
   login and the paper-trade/positional/algopaper change-stream watches in
   `server/boot/paperstream.js` for this run only — see the header comment in
   `scripts/smoke-boot.js` for exactly what that does and doesn't skip.
   ```bash
   nvm exec 24 node scripts/smoke-boot.js
   ```
   Must print `PASS`. **Abort if it does not**: restart on the old Node
   (`pm2 start ecosystem.config.cjs`) and investigate before touching anything
   else — nothing else has changed yet.
3. Switch the default: `nvm alias default 24 && nvm use 24`
4. Confirm the shell is on the new Node: `node -v` → `v24.x.x`. (This only
   proves the operator's shell switched — step 8 below proves pm2's children
   did too.)
5. Reinstall native-adjacent tooling under the new ABI: `npm rebuild`
6. Respawn the pm2 **daemon** under the now-current Node. `ecosystem.config.cjs`
   sets no `interpreter`, so pm2 forks every child using whatever interpreter
   was captured when the daemon itself last started — `pm2 stop all` does not
   restart the daemon, and `nvm use 24` only changes the operator's shell.
   Without this step every child silently keeps forking under Node 16 even
   though every check above passed:
   ```bash
   pm2 update
   ```
7. Start infra only: `pm2 start ecosystem.config.cjs --only server`
8. Verify the API responds, the explorer loads, AND the child process is
   actually running under Node 24 — `node -v` above only proves the shell:
   ```bash
   pm2 describe server
   ```
   Confirm the reported interpreter/version is Node 24, not 16.
9. Start the rest: `pm2 start ecosystem.config.cjs`. This intentionally bounces
   `server` again (it restarts anything already running) — that's expected and
   harmless; it's the simplest single command that also brings up the other six
   `infra` processes (`xtsOrder`, `smp_target`, `smp_report`,
   `smp_order_listener`, `squareoff_smp`, `exchangeToken`) and every `strategy`
   entry, none of which step 7 started. `squareoff_smp` in particular is the
   central flattening process several strategies have no in-file exit logic and
   depend on entirely — treat a delay in getting it back up as high priority.
10. `pm2 save`

## First session under Node 24

Watch specifically for:
- Every strategy logging its startup line (they call `runStrategy()` on load).
- The Zerodha login succeeding — a failure here looks like "api key issue".
- Order placement working end-to-end on the FIRST order of the day.
- `pm2 logs --err` staying quiet.

## Rollback

This phase changes application code (see the note at the top), so rollback is
the runtime AND the tree, not just the runtime:

```bash
pm2 stop all
git checkout $(cat /tmp/git-sha-before.txt)
npm ci
nvm alias default <version from /tmp/node-version-before.txt>
nvm use <that version>
npm rebuild
pm2 update
pm2 start ecosystem.config.cjs
pm2 save
```

Budget: under 5 minutes. Note the archived indicator wrappers are irrelevant to
rollback — nothing live imported them.
