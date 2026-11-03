# Verified Risk Register

*Compiled 2026-07-25. **Every item below was reproduced or read directly at the cited
line.** Claims that survey agents made but that did not survive verification are listed in
§5 so they don't get re-reported as fact. Severity reflects real-world impact given that
the repo is private and much of the order flow may be simulated.*

---

## 1. Critical

### C1 — Unauthenticated superadmin backdoor
**`server/boot/tradelab_auth.js:74`**

```js
router.get('/add_the_boss', (req, res) => {
  Client.create({ realm: "admin", id: "<fixed>", superadmin: true, live: true, ... })
```

An HTTP `GET` route with **no authentication guard** that creates a client with
`superadmin: true` and `live: true` at a fixed ID. It lives in `server/boot/`, so
`loopback-boot` registers it on every app start. Anyone who can reach the dashboard's port
can mint an admin account by visiting one URL.

*Blast radius:* only `server.js` calls `listen()`, so it's exposed on that one port — which
is the port the dashboard serves from.

**Fix:** delete the route. If a bootstrap-admin mechanism is genuinely needed, make it a
one-off CLI script, not an HTTP endpoint.

### C2 — Live database credentials committed to git
Four Atlas connection strings **with embedded passwords**, all present at current HEAD and
throughout history:

| File | Note |
|---|---|
| `server/datasources am.json:9` | full `mongodb+srv://user:pass@cluster0...` |
| `server/datasources ob.json:9` | full URI with password |
| `server/datasources smp.json:9` | full URI with password |
| `todo:53` | full URI with password, **plus 3 plaintext broker passwords and a 2FA seed** |

These grant read/write to the live trading database.

**Fix:** rotate all four credentials, move to environment variables, then purge from
history. Rotation must come **first** — history rewriting does not un-leak an
already-exposed password.

*Mitigating context:* the GitHub repo is **private** (verified: `isPrivate: true`). This is
exposure to anyone with repo access, not the public. Serious, not an emergency.

---

## 2. High

### H1 — Browser executes server-pushed strings via `eval`
**`client_wc/js/services/socket.js:25` and `:104`**

```js
eval(resp);
```

The socket.io client `eval`s a payload delivered on a server-pushed event. Any compromise of
the server — or of the socket channel — becomes arbitrary code execution in every open
dashboard. Combined with **C1** (anyone can become admin), this is a realistic chain.

**Fix:** replace with an explicit message-type switch. There is no legitimate need for `eval`
here.

### H2 — Additional hardcoded secrets in the live boot path
`server/boot/tradelab_auth.js:26` contains a broker `clientId` — notable because this file
executes on **every** app boot, in all ~150 processes. Further hardcoded credentials found in
`server/lib/notify.js` (Telegram bot token), `server/lib/s3upload.js` (AWS keys),
`server/tools/daily_report.js` (SendGrid key), `server/tools/tradelab_login.js` (broker
credentials), and `common/models/client.js:217` (a hardcoded weak password used in a reset
path).

`server/userdata/*.json` holds 4 Zerodha session cookies (incl. `enctoken`), force-added over
a later `.gitignore` rule. These expire daily, so they are almost certainly already dead.

### H3 — `placeAllAccount` is DUAL-RAIL, and the active `lion-s25-2` has no broker-resting stop

> **CORRECTED 2026-07-25.** An earlier version of this entry described a "broker-rail mismatch"
> in `lion-s25-1.js`. **That file is not in the active set** — the registry runs `lion-s25-2`,
> and the two differ by 64 diff lines *including this exact mechanism*. The corrected finding
> below is different, and more actionable.

**H3a — `Account.placeAllAccount` emits to BOTH rails simultaneously.** Verified at
`common/models/account.js:148-152`:

```js
function placeAllAccount(strategyTag, account_quantities, running_accounts, optionInstrument, orderType, multiplier = 1) {
  if (optionInstrument && optionInstrument.tradingsymbol) {
    return new Promise((resolve, reject) => {
      trackOrder(optionInstrument, orderType, strategyTag, multiplier);   // → PaperTrade insert = ORDER BUS
      async.map(running_accounts, ...                                      // → Zerodha, direct
```

`trackOrder` (`account.js:112-127`) does `PaperTrade.create(...)`, and `xtsOrder.js:311` forwards
**every** `paper-trade` insert carrying a `tag` to XTS accounts holding that tag. So one
`placeAllAccount` call can produce **Zerodha fills *and* XTS/Spark/Fyers fills** from a single
strategy decision.

Whether that *doubles* live size depends on which accounts are configured under the tag — not
determinable from the repo. **This is the question to answer.** It also means the `live` vs
`bus-routed` split used throughout these documents is a simplification: `placeAllAccount`
strategies are on *both* rails.

**H3b — the active `lion-s25-2` has no resting broker stop.** Verified:

- Entry: `Account.placeAllAccount(... 'SELL' ...)` at `lion-s25-2.js:142,152`
- Stop: a **local, in-process, tick-based** check at `:178`
  (`ticksCache[...].last_price > check_option.sl_trigger`) firing a market BUY through
  `placeAllAccount` at `:182`.
- `trackOrder_slm` refs: **0**. `OrderUpdate` refs: **0**.

So entry and stop use the *same* rail — the mismatch concern does not apply. The real exposure is
different: **the stop lives only in process memory.** If the pm2 process dies, or the tick feed
stalls while the socket stays open, a short strangle sits unprotected until `squareoff_smp` runs.
There is no protective order resting at the broker as a backstop.

Verified: the same holds for all 6 non-modern active strategies — `bull-s-1`, `bull-snx-1`,
`eagle-s-1`, `lion-s25-2`, `cheetah-b1-1`, `cheetah-b1-snx` all have `trackOrder_slm = 0` and
`OrderUpdate = 0`. **Every stop in the active set is a local tick-based stop.**

This is a strong argument for the new design's feed-staleness watchdog and WAL-based restart
recovery (`11-execution-and-resilience.md` Part 2), and for optionally arming a wide resting
broker stop as a catastrophe backstop.

### H3c — the simulator never fills a resting order (legacy-only)
`paperstream.js:353` returns early unless `status === 'COMPLETE'`, but `trackOrder_slm` and
`trackOrder_limit` insert with `status: 'Pending'` (`paper-trade.js:8,27`). So stop and limit
orders **never fill in simulation** — they rest forever. The only writer of `OrderUpdate` fill
events is `smp_order_listener.js`, fed by the XTS interactive websocket, so the fill stream exists
only when an XTS account is attached.

Impact on the active set: **none** (all six use local tick stops, not resting orders). But it means
any legacy strategy built on `trackOrder_slm` cannot be meaningfully simulated as written, and
the golden-master replay harness must synthesise resting-order fills itself.

### H4 — Silent data loss on restart
`strategy`, `strategyPNL`, `payment`, `log`, `manager`, `algopaper`, `algouser` are mapped to
the `db` datasource, which is `{"connector": "memory"}` (`server/datasources.json`,
`server/model-config.json`). A restart wipes them with no error. `strategyPNL` takes
10-second M2M snapshots, so a mid-session crash truncates the day's P&L to `[]`.

---

## 3. Medium

### M1 — Five dashboard routes throw in production
`client_wc/js/app.js:60,65,72` register ui-router states for `BuilderController` and
`ComboController`, but `gulpfile.js:30` **excludes** the file implementing them
(`client_wc/js/controllers/builderCtrl.js:326`). Verified: the router state names appear in
`build_wc/assets/app.min.js`; the implementations do not.

So `builder`, `combo`, `combo_list`, `spreads`, `ibkr_parity` load and throw
`$controller:ctrlreg` rather than failing closed. Worse, `builderCtrl.js` is **still being
edited** (last commit 2026-01-09) — active development on features that cannot run.

Dev/prod also diverge: `client_wc/index.html` loads `builderCtrl.js`; the production shell
`build.html` → `build_wc/index.html` does not.

### ~~M2~~ — `otmSelector` returns 0 everywhere — **RESOLVED: INTENTIONAL, NOT A RISK**

> **Owner-confirmed 2026-07-25: "otmSelector 0 is intentional, we trade ATM mostly."**
> This is correct behaviour. Retained below as documentation of *why* the code looks the way it
> does, and because the dead weekday scaffolding is still worth deleting. **Not a defect — do not
> re-raise.** The Thursday crash in M3 is a separate and still-real bug.
`server/lib/otmSelector.js` is called by **104 of 156** `slive` files. Verified call-site
distribution:

| Call | Count | Returns |
|---|---|---|
| `otmSelector()` → defaults to `'Lion'` | 71 | `0` always |
| `otmSelector('Cheetah')` | 15 | `0` always |
| `otmSelector('Lion_SNX')` | 1 | `0` always |
| `otmSelector('SD_2')` | 6 | array — **except Thursday**, see M3 |

**87 of 93 call sites resolve to `0`**, so strategies named as OTM strangle sellers are in
practice selling **at-the-money**. Every weekday branch in `otmSelector.js:4-33` returns `0`,
including `else return 0` — structure retained, values zeroed.

**This reads as deliberate**, not accidental: someone zeroed the offsets and left the
scaffolding. **Needs confirmation** — if intentional, delete the dead scaffolding; if not,
~87 strategies have been trading the wrong strikes.

### M3 — `otmSelector('SD_2')` crashes on Thursdays
`otmSelector.js:34-45` branches on days 1, 2, 3, 3 (**duplicated**), 5. **Day 4 — Thursday —
is missing**, so the function falls through and returns `undefined`. Reproduced:

```
SD_2 on Thursday  -> undefined
SD_2 on Wednesday -> [5,3,4,18,-5,-10]
```

Consumers dereference it immediately (`server/slive/ce-d2-0020.js:64-65`):

```js
day_config = otmSelector('SD_2');
current_spread = day_config[5];   // TypeError: Cannot read properties of undefined
```

Affects 6 files: `ce-d2-0020`, `ce-d2-extra`, `ce-d2p-extra`, `pe-d2-0020`, `pe-d2p-extra`,
`pe-d2-extra`. Thursday is weekly index expiry, which is unlucky timing.

*Impact is low:* all 6 verified as bus-routed (no `placeAllAccount`) and none have
`autostart: true`.

### M4 — socket.io major-version mismatch
Server `socket.io@3.1.2` vs client `socket.io-client@4.8.1` — wire-incompatible without
`allowEIO3`. The dashboard reportedly works, so something reconciles this (likely the
*bundled* vendor client differs from the npm dependency). **Worth confirming**; it is a
latent breakage on the next dependency touch.

### M5 — Stale deploy script targets a dead directory
`package.json` `"sync": "aws s3 sync build s3://cdn.algomaker.in"` pushes **`build/`** (dead
since 2022-10) rather than `build_wc/`. Naively deleting `build/` converts a silently-stale
CDN sync into a hard failure — or an accidental empty sync to production CDN.

*Good news:* the app's actual static root is correct — `server/middleware.json:43-44` points
at `build_wc`. The feared "wrong static root" scenario does **not** apply; the S3/CloudFront
path is simply disconnected from what users see.

### M6 — The linter has never checked the trading logic
`.eslintignore` excludes **`/server/`** — so the project's only linter has never examined any
strategy or broker code. `eslint@3` is also 9 major versions behind.

---

## 4. Architectural / scaling

### A1 — ~150× resource duplication
Verified: **150 of 156** `slive` files `require('../server.js')`, each booting the full
LoopBack app and all 10 boot scripts; **147 of 156** construct their own `KiteTicker`. So
~150 Kite websockets, ~150 MongoDB pools, and ~150 executions of every boot script — to carry
**15–18 distinct trading ideas**.

Each strategy process also opens ~3 MongoDB change streams. This is the primary scaling
ceiling and the main argument for a shared market-data service.

### A2 — Strategy sprawl: 380+ files, ~15–18 ideas
`cheetah-1910.js` vs `cheetah-1911.js` differ by **4 diff lines out of 236**. ATM-crossover
strangle/straddle selling alone spans ~90 files. A strategy is a *file*, so every new client
or variant costs a file, a pm2 process, a websocket and a LoopBack boot.

### A3 — Strategy logic cannot be verified offline
Strategy decisions are fused to live I/O, so there is no way to exercise them without running
them against a live market. That blocks port verification, not research: a research/P&L
backtester was explicitly declined by the owner on 2026-07-25 and is NOT a gap. What matters
is that a ported strategy can be replayed to prove it emits the same orders as the legacy
file. Logic is only separable offline —
except in the 4 newest files, which correctly split pure logic into `*-logic.js` with
`node:test` coverage.

### A4 — Missing engineering baseline
| Gap | Detail |
|---|---|
| No lockfile | `package-lock.json` existed, deleted 2025-05-02, never restored |
| No CI | 4 `node:test` files exist; no `"test"` script in `package.json`; nothing runs them |
| No Node pin | declares `>=6`; prod ran 14.17.0; local is 24.11.0; no `.nvmrc` |
| No containerisation | no Dockerfile |
| Generated artifacts committed | both `client_wc` (142 files) and `build_wc` (86) are tracked |
| `.gitignore` too broad | blanket `*.csv` / `*.log` silently excludes intended deliverables |

### A5 — Deprecated dependencies
| Package | Status |
|---|---|
| `loopback` / `loopback-boot` | **EOL** (LB3 EOL Dec 2020) |
| `request` | **deprecated since 2020** — still the HTTP backbone of `lib/zerodha.js` and `lib/notify.js` |
| AngularJS 1.x | **EOL** Jan 2022 |
| `aws-sdk` v2 | maintenance mode |
| `helmet@3`, `express-rate-limit@5`, `eslint@3`, `puppeteer-core@14` | many majors behind |

---

## 5. Agent claims that did NOT survive verification

Recorded so they are not re-reported as fact.

| Claim | Verdict |
|---|---|
| "`PaperTrade` calls are paper-only" | **False.** It is the order bus; `xtsOrder.js:306-309` forwards to live brokers. Central to the architecture. |
| "`lion-s25` stop-loss never reaches a broker" | **Not established.** `StopMarket` *is* forwarded live (`xtsOrder.js:150-158`). Real concern is a broker-rail mismatch → H3. |
| "`eagle-*` has no stop-loss = unbounded risk" | **Misleading.** True that all 12 files have `BUY=0` and no exit logic, but `scripts/squareoff_smp.js:40-47` flattens *every* strategy's positions generically. Exits are centralised by design. Real gap is narrower: no *intraday* per-leg stop. |
| "`dump.pm2` shows what runs in production" | **False** — my own earlier claim too. Newest internal timestamp is 2023-03-05; contains none of the 2026 strategies. |
| "`otmSelector` returns 0 for every tag" | **Partly false.** True for `Lion`/`Lion_SNX`/`Cheetah` (87 sites), but `SD_2` returns an array — and that exception is where the real bug lives (M3). |
| "~30 secrets in `extra/diff_strategy.js`" | **False positives** — numeric `instrument_token` values. |
| "`api_key: 'kitefront'` is a secret" | **False** — Kite's *public* web API key. |
| "Static root may point at dead `build/`" | **False** — `middleware.json:43-44` correctly points at `build_wc`. |
| "Builder views are simply dead" | **Understated** — routes ship without controllers, so they *throw* rather than being unreachable (M1). |

## 6. Open questions only you can answer

1. **What actually runs in production right now?** A fresh `pm2 jlist` is the highest-value
   missing input. (§8 of `01-system-overview.md`)
2. **Which order-forwarding daemons are running, against which broker accounts?** Determines
   whether H3 is a live money risk or a non-issue.
3. **Is the `otmSelector` zeroing intentional?** (M2) — decides whether ~87 strategies are
   correct or mis-strikes.
4. **Is `eagle-*`'s reliance on central squareoff, with no intraday stop, intentional?**
5. **What should happen to the 108 `smp` files with no `slive` twin?** (§7)
6. **Which of the ~150 strategies do you still care about?** Nobody should port dead ideas.
