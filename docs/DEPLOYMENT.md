# Deploying SMPv2 to a server

Covers a fresh install and migrating from the existing host MongoDB.

> **Written from the repo, not from your server.** Anything about what is currently installed is a
> discovery step, not an assertion. Run the checks before the actions.

## 1. What has to be installed

| | Version | Why this and not less |
|---|---|---|
| **Node** | **≥ 24.9** | Two hard requirements. Native TypeScript type-stripping — there is no build step and `.ts` runs directly. And `crypto.argon2`, which landed in 24.9 and is what hashes operator passwords. On 24.8 the login system does not start. `package.json` says `>=22`; that is stale and understates it. |
| **MongoDB** | 4.0+ | Nothing exotic is used — unique indexes, `$inc`, `countDocuments`. The driver is pinned at 3.7.3 and is verified against 8.2, so a modern server is fine. |
| **pm2** | 7.x | 4.x is in the legacy tree and behaves differently around `--update-env`. |
| **git** | any | Deploy is a pull. |

Docker is **not** required. It is used locally only because it was the quickest way to get a replica
set; see §3 for why the server does not need one.

## 2. Find out what is there

```sh
node -v                                  # need >= 24.9
mongod --version                         # or: mongosh --eval 'db.version()'
mongosh --quiet --eval 'db.adminCommand({getCmdLineOpts:1}).parsed.replication || "standalone"'
pm2 -v
mongosh algomaker --quiet --eval 'db.getCollectionNames().sort()'
mongosh algomaker --quiet --eval 'db.stats().dataSize'
```

The collection list and size decide §4. Everything else decides §1.

## 3. Production Mongo is a STANDALONE — change streams do not work

Not "a replica set is optional". On `3.108.231.230` MongoDB 8.0 is installed as a plain standalone
with no replication (`SERVER-REBUILD.md` Phase 4, verified 2026-07-28), and a standalone has no
oplog, so `collection.watch()` **fails there**. Nothing in this system may be designed to depend on
a change stream, and nothing currently does: `grep -rn "watch(" apps packages --include='*.ts'`
returns zero matches (re-verified 2026-07-28), as does a grep for `changeStream`, `fullDocument` and
`resumeToken`. Every consumer polls, or is nudged over the websocket bus and then re-reads.

This is a break with the legacy system, which was built on them — `xtsOrder.js` opened a change
stream on `positional`, which is why the old box ran a single-member replica set. That daemon is
gone.

The laptop's `make mongo-up` starts a Docker replica set (`Makefile:136-137`), and that is a
leftover convenience, not a requirement. Do not convert a working standalone to a replica set for
this — and do not let a feature that only works locally get built because of it.

## 4. MongoDB: upgrade and keep the data

### Does it need upgrading at all?

Only if it is below 4.0. If it is 4.0+, skip this whole section — nothing here needs a newer server,
and an upgrade you do not need is risk you do not need.

### If it does need upgrading

MongoDB only supports **one major version at a time**. 3.6 → 8.x is 3.6→4.0→4.2→4.4→5.0→6.0→7.0→8.0,
each with a `featureCompatibilityVersion` bump. That is a long afternoon.

**The shortcut, and what I would do here:** this database is small and almost entirely
reconstructible. Dump, install the new version clean, restore.

```sh
# 1. BACK UP FIRST, and verify the archive is non-empty before touching anything
mongodump --db=algomaker --archive=/backups/algomaker-$(date +%F).gz --gzip
ls -lh /backups/algomaker-*.gz

# 2. Stop everything that writes
pm2 stop all

# 3. Install the new MongoDB (distro-specific), then
mongorestore --archive=/backups/algomaker-YYYY-MM-DD.gz --gzip

# 4. Verify the counts match what you recorded in §2
mongosh algomaker --quiet --eval 'db.getCollectionNames().sort().forEach(c => print(c, db[c].countDocuments()))'
```

### What is actually worth preserving

| Collection | Keep? |
|---|---|
| `desk-daily-reports` | **Yes — irreplaceable.** Rollups are kept forever and are the trading history. |
| `desk-decisions` | **Yes.** Every fill. P&L, positions and flatten all reconstruct from these. |
| `desk-users`, `desk-brokers` | **Yes** — but see the warning below. |
| `desk-books`, `desk-strategies`, `desk-safety` | Yes. Current positions and your switches. |
| `desk-pnl-snapshots` | Optional. Intraday charts, pruned at 30 days anyway. |
| `instrument`, `desk-freeze-limits` | No — regenerate with `make sync`. |
| `positional` | Legacy live orders. Historical only; nothing new reads it. |

> **`DESK_MASTER_KEY` must move to the server with the data.** Broker credentials in `desk-brokers`
> are sealed with it. Restore the database without it and they are unreadable — not lost silently,
> the portal reports `unreadable` rather than `absent`, but they must be re-entered. It is not
> derivable from anything. Copy it, and keep a copy somewhere else.

## 5. Install

```sh
git clone <repo> /opt/algomaker-delta && cd /opt/algomaker-delta
npm ci
cp .env.local.example .env.local     # every variable, documented, no values
```

There is no build step for the backend — Node runs the TypeScript. The dashboard does build:

```sh
npm run build --workspace @algomaker/web
```

`apps/web/dist/` is gitignored and generated here. On the production box it is served by **Caddy**
— see below and `SERVER-REBUILD.md` Phase 5 for the Caddyfile. Any static file server does the job;
the hash router means there are no deep paths to rewrite.

> **The build fails on the developer laptop, and works on the server.** `npm run build --workspace
> @algomaker/web` currently dies with `ERR_MODULE_NOT_FOUND: Cannot find package 'esbuild'` — vite's
> platform binary is missing from the local `node_modules`, not a code fault (`tsc -b` passes).
> `npm ci` at the repo root is the fix if it needs fixing locally. Do not go looking for a
> regression in the dashboard.

**THE PUSH SOCKET NEEDS NO PROXY CONFIG ON THIS HOST**, and it is worth saying why so nobody adds
some.

The production box runs **Caddy on `:80` serving `apps/web/dist` as static files and nothing
else** — it does not proxy the API. The browser calls `:8790` directly (which is why
`DESK_CORS_ORIGINS` has to name the page's origin), and `GET /v1/desk/stream` goes to that same
port by the same route. `streamUrl()` derives from the API base the REST calls already use, not
from the page's origin, so the socket cannot end up knocking on Caddy's door.

If a reverse proxy is ever put in front of the API, it MUST forward the upgrade headers or the
handshake is answered as an ordinary request and the socket silently never connects:

```nginx
location /v1/desk/stream {
    proxy_pass http://127.0.0.1:8790;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 3600s;   # the socket is long-lived and mostly idle
}
```

Getting this wrong is a degradation, not an outage: the dashboard falls back to its 10-second REST
polling and says "live feed down" on screen. Every REST endpoint keeps working exactly as before.

## 6. Environment

`.env.local` at the repo root, never committed.

**Required — the process refuses to start without them:**

```sh
DESK_MONGO_URL=mongodb://127.0.0.1:27017/algomaker
DESK_API_TOKEN=<openssl rand -hex 32>    # machine clients (the Python desk)
DESK_MASTER_KEY=<openssl rand -hex 32>   # seals broker credentials — SEE THE WARNING IN §4
```

**Needed in practice:**

```sh
DESK_CORS_ORIGINS=https://desk.example.com   # exact origins; a wildcard is REFUSED with cookies
DESK_LIVE_TAGS=                              # empty = every live order refused. Fill deliberately.

# Optional. desk-gateway tells desk-api about live order events so the dashboard
# sees them immediately; both default to the values below. An unreachable bridge
# costs the push and nothing else — orders are never blocked or failed by it.
DESK_API_URL=http://127.0.0.1:8790
DESK_STREAM_HEARTBEAT_MS=15000               # proof of life, so a dead socket is DETECTABLE

# desk-marketdata THROWS AT BOOT without these — no feed at all, not a degraded one.
ZERODHA_USER_ID= ZERODHA_PASSWORD= ZERODHA_TOTP_SECRET=

# desk-gateway will not start without these when running `make live`.
# XTS_CLIENT_ID matters for a DEALER account: the login-derived code is wrong for
# one, and it also selects the dealer order-book and positions endpoints. See docs/XTS.md.
XTS_BASE_URL= XTS_APP_KEY= XTS_SECRET_KEY=
XTS_HOST_LOOKUP_URL= XTS_PREFIX= XTS_UNIQUE_KEY= XTS_CLIENT_ID=

# The four optionbhai signal mirrors (desk-runner), if you run them. The pair is
# named by each config's credentialsRef, NOT by the registry tag:
#   MIRROR_1PBUY -> OPTIONBHAI_1PBUY_*    MIRROR_A006    -> OPTIONBHAI_A006_*
#   MIRROR_A010  -> OPTIONBHAI_A010_*     MIRROR_EMA2050 -> OPTIONBHAI_TEST3_*  (optionbhai/test3)
# One variable per line, and no inline comments: ecosystem.desk.config.cjs keeps
# everything after the first '=' as the value.
OPTIONBHAI_1PBUY_USER=
OPTIONBHAI_1PBUY_PASS=
OPTIONBHAI_A006_USER=
OPTIONBHAI_A006_PASS=
OPTIONBHAI_A010_USER=
OPTIONBHAI_A010_PASS=
OPTIONBHAI_TEST3_USER=
OPTIONBHAI_TEST3_PASS=

# Optional. Where the mirrors connect; unset = https://optionbhai.com and
# wss://optionbhai.com. To reach the origin directly (past Cloudflare), point
# both at it and name the vhost — Host is then sent on every request and on the
# socket handshake. http:// and ws:// carry the login password and the session
# token UNENCRYPTED; desk-runner logs a warning at boot when either is set.
# A malformed value does not crash desk-runner: every mirror parks as failed
# with the reason. Read once at start; after changing them restart desk-runner
# THROUGH THE ECOSYSTEM FILE, which is what reads .env.local, and outside market
# hours (desk-runner squares off on SIGTERM — see §11):
#   npx pm2 startOrRestart ecosystem.desk.config.cjs --only desk-runner --update-env
# (or `make restart` for all four). A bare `pm2 restart desk-runner --update-env`
# takes the env of the shell you typed it in, not .env.local.
# Shapes: http(s)://host[:port], ws(s)://host[:port], bare host[:port].
# The origin route chosen on 2026-10-04 (cleartext):
#   OPTIONBHAI_BASE_URL=http://13.202.244.113
#   OPTIONBHAI_SOCKET_URL=ws://13.202.244.113
#   OPTIONBHAI_HOST_HEADER=optionbhai.com
OPTIONBHAI_BASE_URL=
OPTIONBHAI_SOCKET_URL=
OPTIONBHAI_HOST_HEADER=
```

A failed optionbhai attempt backs off: 5 s doubling to 5 min (±20 % jitter), and at least 10 min
after an HTTP 403 or 429 — from the login, the instruments call or the socket upgrade. A socket
that opens and drops at once still counts as a failure; the burst ends only on the first frame or
a socket that stayed up a minute. The first rejection of each burst logs one
`optionbhai login rejected` (or `optionbhai instruments rejected`) line with the status,
Cloudflare's `cf-ray` if present and the first 200 characters of the body (credentials and token
cut out) — enough to tell a Cloudflare block from a bad password. Later attempts in the burst log
`optionbhai login failed, retrying` / `optionbhai instruments failed, retrying`. The socket
handshake always gives up after 30 s; with `OPTIONBHAI_HOST_HEADER` set, so does every request
(without it, requests use Node's fetch and its own timeouts).

Broker credentials entered through the **portal** now take precedence over these, with env as the
fallback — so the Brokers page is what actually logs in, not just a record of what does.

`DESK_LIVE_TAGS` is the outermost live gate and an environment change, so going live stays a
deployment act rather than a click in the portal. Leave it empty until you mean it.

Full list: `grep -rho "process\.env\['[A-Z_]*'\]" apps packages | sort -u`.

## 7. Start

```sh
make up          # simulated broker — no real orders
make status
make logs
```

`make live` is the same with the real broker, and asks for confirmation. **`--update-env` is why
these are make targets**: pm2 keeps the previous process definition and silently ignores an edited
`.env.local` on a plain restart. A `pm2 restart` by hand is how you get a process running with an
old secret and no indication of it.

Processes: `desk-api`, `desk-marketdata`, `desk-gateway`, `desk-runner`, namespace `desk`.

```sh
pm2 startup && pm2 save     # survive a reboot
```

## 7b. Starting clean

A fresh server with a fresh database needs nothing here — there is nothing to remove. This matters
when you **restore a dump** taken from a laptop, or redeploy onto a host that already ran the desk.

```sh
node bin/desk-reset.mjs            # dry run: prints exactly what it would drop
node bin/desk-reset.mjs --yes      # desk data + the strategy registry
node bin/desk-reset.mjs --yes --all   # ALSO users, sessions and broker credentials
```

The reason this is a script and not a line of `mongosh`: which collections must go is **not
guessable from their names**. `positional` looks like ours and is the LEGACY live order log —
historical evidence of real trades that nothing new writes and nobody can reconstruct.
`instrument` looks precious and is a cache `make sync` rebuilds. Getting that backwards either
destroys history or leaves a laptop's test position on a production desk.

Dropping `desk-strategies` is how you discard an operator's switches — every row returns at the
next boot **off, paper only**. Right on a fresh server; a silent mass-disable on a live one.

Afterwards: `make sync`, then create an operator (§8), then enter broker credentials in the portal.

## 8. Create the operator account

No signup endpoint — deliberately, on an internet-facing service that can trade.

```sh
node bin/desk-user.mjs create <username>
```

## 9. Verify, in this order

```sh
curl -s localhost:8790/health                       # {"ok":true}
curl -s localhost:8790/v1/desk/feed | jq .ready     # true once the feed is alive
pm2 logs desk-api --lines 50 --nostream | grep -i "listening\|error"
```

`ready` asks "can the desk act on what it holds?", so **holding nothing answers yes** — on a first
deployment it goes true as soon as the feed is alive, without waiting for a book. It used to be
`books.length > 0 && ...`, which meant this documented check could never pass on a fresh install.

The response carries `bookCount` and `booksIncomplete` and deliberately does NOT name the symbols:
this endpoint is unauthenticated, and what the desk is positioned in is the most valuable thing it
knows. `GET /v1/desk/books` has the detail, behind auth.

Then in the browser: sign in, confirm the mode switch says **PAPER**, and confirm the strategies
table is empty or all-off. **Every strategy seeds switched off** — nothing trades because it was
deployed.

## 10. Before real money

- `DESK_LIVE_TAGS` names only what you intend, and no more.
- Broker credentials entered through the portal and **tested** there, not left in env.
- One paper day observed end to end. **The 15:40 rollup has never run against a live market** —
  check `desk-daily-reports` has rows at 15:45 on the first day.
- Serve over **HTTPS**. The session cookie sets `Secure` only on a TLS request; over plain http on a
  remote host the session works but the cookie is sent in the clear.
- A backup schedule for `desk-daily-reports` and `desk-decisions`. Everything else regenerates.

## 11. Updating a running server

The box is `ubuntu@3.108.231.230`, path `/opt/algomaker-delta` (`Makefile:30-31`). Two ways in, one
script:

```sh
# from the laptop — SSHes in and runs the same `make deploy` on the box
make deploy-remote
make deploy-remote FORCE=1
make status-remote          # pm2 list + /health, over SSH
make logs-remote            # follow the desk logs, over SSH

# on the box itself
su - ubuntu && cd /opt/algomaker-delta
make deploy                 # pull, install if needed, build, restart, verify
make deploy FORCE=1         # ...during market hours, or to rebuild the same commit
```

`make deploy` is `scripts/deploy.sh` and always runs **on the server** against `$PWD`;
`make deploy-remote` is the laptop-side wrapper that SSHes in and invokes it (`Makefile:78-80`), so
there is only ever one deploy implementation and one copy of the guards. The SSH key path defaults
to `$(HOME)/Documents/dev/aws_keys/wealthcreator.pem` and is overridable with `SSH_KEY=`; the key
itself is not in the repo and must not be.

Run it as **`ubuntu`**, never root — pm2 is per-user, and a deploy run as root talks to root's empty
daemon, reports success, and leaves the real desk on the old code. The script refuses outright if it
is root.

What it does beyond `git pull && make restart`, and why:

| Guard | Reason |
|---|---|
| Refuses 09:15–15:30 IST Mon–Fri | The runner holds strategy state in memory; a mid-session bounce drops whatever it was tracking. `FORCE=1` overrides. |
| Refuses on modified tracked files | A fast-forward would fail or silently carry a hand-edit forward. Untracked files (`optionConfig_*.json`, order journals) are ignored — they are regenerated. |
| `npm ci` only when `package-lock.json` changed | `npm ci` wipes `node_modules` (~35 s). Doing that for a docs commit is pure downtime. |
| `--ff-only` | A deploy host must never produce a merge commit. Failure means someone committed on the server. |
| Polls `/health` for 30 s after restart | pm2 reports **online** for a crash-looping process. The health check is what actually decides success; on failure it dumps `desk-api` logs and prints the rollback command. |
| Always rebuilds the dashboard | ~7 s, and `tsc -b` is the only typecheck between a pulled commit and a running process. |

**A deploy is the first place `apps/web` is typechecked, so check it before you push.** The root
`npm run typecheck` (`tsc -p tsconfig.json`) does **not** cover the dashboard: `tsconfig.json:11`
lists `apps/web` in `exclude`, and its `include` globs only `*.ts`, never `*.tsx`. `make check` runs
that same root typecheck, so it does not cover it either. The gate that does is `cd apps/web &&
npx tsc -b`, or the full `npm run build --workspace @algomaker/web`. A type error reached production
this way on 2026-07-28 (`cc7f6933`) and surfaced as a **failed deploy with the previous bundle still
being served**.

It restarts **all four** processes: `make restart` is `pm2 startOrRestart ecosystem.desk.config.cjs
--update-env`, which covers `desk-marketdata`, `desk-api`, `desk-gateway` and `desk-runner`.

> ### `desk-runner` SQUARES OFF ON SIGTERM. Restarting it mid-session CLOSES REAL POSITIONS.
>
> This is deliberate — `apps/runner/src/main.ts:593` → `shutdown()` → `Runner.stopAll` →
> `#stopOne`, which calls `endDay` then `stop` on every supervised strategy and, when the tag still
> shows open contracts (`apps/runner/src/runner.ts:671-681`), flattens them through the gateway.
> It is **not** conditional on paper vs live: a live tag holding a position is flattened at the
> broker. (Mirrors are exempt — `main.ts:566-571` — because the upstream account owns those legs.)
> `ecosystem.desk.config.cjs` gives the runner `kill_timeout: 20_000` for exactly this reason, above
> its own 15 s hard-exit fuse; anything still open is logged `STILL OPEN at shutdown — needs manual
> square-off`.
>
> **A safe mid-session deploy is therefore not `make deploy`.** Build the web bundle (static, zero
> risk) and restart only what changed:
>
> ```sh
> npm run build --workspace @algomaker/web       # the dashboard alone needs no restart at all
> npx pm2 restart desk-api --update-env          # and desk-gateway too, if it changed
> ```
>
> Never `desk-runner` while the market is open. `scripts/deploy.sh` restarts everything and refuses
> during market hours by design — `FORCE=1` opts out of the guard, not out of the consequence.

**Restarting `desk-api` during market hours can still cost a signal.** The runner retries a submit
**3 times, 200 ms apart** (`SUBMIT_ATTEMPTS` / `RETRY_DELAY_MS`,
`apps/runner/src/order-gateway.ts:120-122`) — about 600 ms of cover, less than an API restart. On
exhaustion the outcome is recorded as **OUTCOME UNKNOWN**, the `clientOrderId` is remembered rather
than released (`order-gateway.ts:611-628`), nothing is booked into the ledger, and the strategy's
next tick **replays the same id**. So nothing double-routes; the signal is deferred, and may be
missed.

Rollback is printed on both success and failure:

```sh
git checkout <previous-sha> && FORCE=1 scripts/deploy.sh
```

Requires `ubuntu` to have git access — an account SSH key or a repo deploy key. Verify with
`sudo -u ubuntu bash -lc 'cd /opt/algomaker-delta && git fetch origin'`. Without it the pull fails with
"Repository not found", because the key belongs to root.

## 12. Still outstanding

- **UNVERIFIED ON THE BOX, and it would matter: does a deploy silently return the gateway to
  `simulate`?** `deploy.sh:111` logs "restarting desk (simulated broker unless already live)", but
  it calls `make restart`, which is `pm2 startOrRestart $(ECO) --update-env` with **no `--env live`**
  (`Makefile:63-64`) — while `make live` does pass it (`Makefile:96`). `desk-gateway`'s base `env`
  sets `DESK_BROKER=simulate` and only `env_live` sets `xts`
  (`ecosystem.desk.config.cjs:127-144`), so on pm2's usual semantics a deploy re-applies the base
  env and the gateway comes back simulated. Nothing has run live yet, so this has never been
  observed. Check it the first time it matters: `make status` prints the gateway's own
  `BROKER MODE:` line from its log (`apps/order-gateway/src/main.ts:357,387`).
- **The optionbhai credentials in git history are not rotated.** Unrelated to deployment, still true.
- `apps/marketdata` and `apps/order-gateway` read broker credentials from env, with the Mongo store
  as the newer path. Env still works; the portal is the intended source.
