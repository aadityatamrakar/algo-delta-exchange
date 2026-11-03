# Book Margin — a per-book margin figure the operator can size a trade from

**Date:** 2026-08-04
**Status:** approved, awaiting implementation plan
**Supersedes:** nothing. Replaces the `Margin used (account)` tile described at
`apps/web/src/pages.tsx:604-648`.

## What we are building, in one paragraph

The book page gets a **per-book margin figure** — what *this* book would cost to hold,
standalone, with hedge benefit applied — sourced from Zerodha's own basket-margin
endpoint, the same computation behind the Kite margin calculator. A refresher inside
desk-marketdata (the only process holding a Kite session) prices each open book on a
SPAN-publication schedule plus on any leg-set change, and writes the result to Mongo.
desk-api serves the stored document; the dashboard renders it with its age. When Kite is
unreachable nothing is estimated — the last good figure stands and visibly ages, which is
the honest failure mode for a number an operator sizes trades from. The account-wide
figure does not disappear; it moves to the rail, where a desk-wide number belongs.

## Locked decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | **Per-book margin is priced standalone**, `consider_positions=false`. | The operator asked "what does the TCS recenter-relief-r book cost". Marginal-vs-account is a different question; see §12.1. |
| D2 | **Source of truth is `kite.zerodha.com/oms/margins/basket`.** | Measured against the operator's own calculator screenshot: exact mapping (§2.1). `api.kite.trade` does NOT accept an enctoken — 400. The OMS host is pinned. |
| D3 | **The refresher lives in desk-marketdata**, not desk-api. | The enctoken exists ONLY in `apps/marketdata/src/feed-pool.ts:52` process memory. It is persisted nowhere (§1.2). desk-api cannot reach it without a second login, which is the 2026-08-04 feed kill. |
| D4 | **Mongo is the seam.** marketdata writes `desk-book-margin`, desk-api only reads. | Identical to the existing XTS pattern — the gateway owns the session and publishes, `handleBrokerFunds` (`apps/api/src/routes/desk.ts:1234`) only reads. One session per credential, by construction. |
| D5 | **The reported number is `final.span + final.exposure`.** | That is what the Kite calculator prints as "Total margin". `initial` is the pre-benefit figure and is 2.6× larger — using it would restate the bug this work exists to fix. Premium is carried separately, never added. |
| D6 | **No computed fallback in v1.** When Kite is unreachable the last good figure stands, visibly aged. SPAN-lite is deferred to §12.3. | There is no TS→Python boundary to reach `portfolio_margin` across (§1.3), and reimplementing it in TypeScript would mean a second margin model in a repo that deliberately keeps one pricing implementation. An aged number labelled with its age is honest; an 18%-conservative estimate dressed as a live figure is the class of bug this document exists to fix. |
| D7 | **A failed refresh never overwrites a good value.** | A margin tile that silently freezes is the failure mode this whole document exists to correct. It must age visibly instead. |
| D8 | **Refresh on a SPAN-publication schedule, not a fixed poll.** Leg-set change forces an immediate debounced refresh. | Operator direction. Recorded with its known limitation in §6.2. |
| D9 | **The account figure survives, on the rail.** | It is a true number that answers a different question. Deleting it would lose the only view of total utilisation. |

## 1. What exists today — audited, not assumed

### 1.1 There is no margin calculation in this repo

The tile is a passthrough, end to end:

| Layer | File | What it does |
|---|---|---|
| Tile | `apps/web/src/pages.tsx:625` | prints `funds.utilised` verbatim |
| Endpoint | `apps/api/src/routes/desk.ts:1274` | `findNumber(funds, /margin.?utili[sz]ed/)` — greps the key out of whatever XTS sent |
| Source | `packages/brokers/src/xts-rest.ts:429` | `getBalance()` → XTS `/user/balance`, stored raw by the gateway |

So the figure is the **XTS account's** utilised margin. It was never a per-book number and
the label says so. Confirmed live on 2026-08-04: account `PRO111` holds both books under
`NRML` — TCS (2660 CE long, 2460 CE / 2440 PE short, 1125 = 5×225) and DLF (600 PE long,
plus its three siblings, 4750 = 5×950). The 9.6L tile was DLF + TCS together, against a
DLF-only basket figure of 4.39L. Nothing foreign under the PRO code.

### 1.2 Where the Kite credential lives

`apps/marketdata/src/feed-pool.ts:52` holds the current enctoken in memory and rotates it
on reconnect. It is written to **no** collection and **no** file — marketdata touches only
`instrument`, the subscription collection, and `desk-marks`. `zerodha-login.ts` can mint a
fresh one, but a new IJ0574 login invalidates the running session, which is exactly the
2026-08-04 feed outage. Therefore: whatever calls Kite must run *inside* desk-marketdata
and reuse the token already in hand. This is D3.

### 1.3 Two conventions this design must obey

Both checked against the code, both of which corrected an earlier draft of this spec:

1. **No route in `apps/api/src/routes/desk.ts` uses a path parameter.** Every one is an
   exact `path === '/v1/desk/...'` match, with scoping done by query string
   (`/v1/desk/positions?symbol&mode`). A `/v1/desk/book/:tag/margin` route would be the
   only one of its kind. §8 uses a query param instead.
2. **Nothing in TypeScript calls the Python desk.** There is no `child_process` use in
   desk-marketdata or desk-api, and the bridge runs the other way — Python calls algomaker.
   Any design that "just calls `portfolio_margin`" is inventing a boundary. This is D6.

## 2. The spike — what was measured, not assumed

### 2.1 Kite basket margin vs the operator's calculator

`POST https://kite.zerodha.com/oms/margins/basket?consider_positions=false`,
`Authorization: enctoken <tok>`, the four DLF legs at 4750 each:

| | Kite API | Operator screenshot | drift |
|---|---:|---:|---:|
| `final.span + final.exposure` | 4,45,629 | 4,38,845 | 1.5% |
| `-final.option_premium` | 1,28,012 | 1,26,588 | 1.1% |

Residual drift is marks moving between the two observations. The mapping is exact.

The distinction that must be locked by a test (D5):

| block | span | exposure | premium | total |
|---|---:|---:|---:|---:|
| `initial` | 5,92,895 | 2,19,625 | 34,675 | 8,47,195 |
| `final` | 2,26,004 | 2,19,625 | −1,28,012 | 3,17,617 |

`data.orders[]` carries a per-leg breakdown (shorts hold span+exposure, longs zero) in the
same shape as the calculator's per-leg table.

### 2.2 SPAN-lite (`sensibull_tools/sim/margin.py`) vs the same truth

| configuration | span | exposure | total | vs truth |
|---|---:|---:|---:|---:|
| Zerodha (truth) | 2,16,553 | 2,22,293 | **4,38,846** | — |
| defaults (scan 21%, exp 5%) | 3,05,615 | 3,05,615 | 6,11,230 | +39% |
| exposure at NSE's 3.5% | 3,05,615 | 2,13,930 | 5,19,546 | **+18%** |

Span was **identical at every scan width from 3% to 30%**, which is the diagnostic finding:
the scenario grid is not binding. Raw scan loss saturates at 1,06,836 — converging correctly
on the condor's structural max loss of 1,13,525 — and is then floored at
`5% × short notional` = 3,05,615, which is 2.9× larger. For a defined-risk book, SPAN-lite's
span is entirely the floor.

Setting the floor to 3.54% and exposure to 3.64% reproduces the screenshot to the rupee.
**We do not do this** — it is two constants fitted to one book on one day. This measurement
is why SPAN-lite is deferred rather than shipped as a fallback (D6, §12.3): it is defensible
as a backtest margin-cap guard, and not accurate enough to stand in for the broker's figure
on an operator's sizing tile.

## 3. Architecture

```
desk-marketdata (owns the Kite enctoken)
  book-margin/schedule.ts   pure: (now, config, lastRun) -> which tags refresh now?
  book-margin/basket.ts     pure: (legs) -> Kite basket request payload
  book-margin/kite.ts       HTTP behind an interface; the ONLY networked file
  book-margin/refresh.ts    orchestration: legs -> call -> write (or leave intact)
        |
        v  Mongo: desk-book-margin  (one doc per book tag)
        |
desk-api    GET /v1/desk/margin?tag=<tag>   — reads the doc, never calls a broker
        |
        v
apps/web    Margin (book) tile + age note
```

Each unit is independently testable: two of the four files are pure functions, one is a
faked HTTP boundary, one is orchestration over both.

## 4. The Kite call

**Request.** `POST https://kite.zerodha.com/oms/margins/basket?consider_positions=false`

```
Authorization: enctoken <token from feed-pool>
Content-Type: application/json
X-Kite-Version: 3
```

Body is an array, one entry per leg:

```json
{"exchange":"NFO","tradingsymbol":"DLF26AUG650PE","transaction_type":"SELL",
 "variety":"regular","product":"NRML","order_type":"MARKET","quantity":4750}
```

`tradingsymbol` comes off the leg's own `instrument.tradingsymbol` — already Kite's
vocabulary (`packages/instruments/src/master.ts:313`). `quantity` is **units, not lots**.
`transaction_type` is `SELL` for negative qty, `BUY` for positive.

**Response.** Read `data.final.span`, `data.final.exposure`, `data.final.option_premium`,
and `data.orders[]`. Report `span + exposure` (D5).

**Host is pinned to `kite.zerodha.com/oms`** — `api.kite.trade` returns 400 for enctoken
auth and must not be used as a fallback host.

## 5. What happens when Kite is unreachable

Nothing is computed. The stored figure stands, its `asOf` unchanged, and the UI shows its
age (§9, §10). `diagnostic` records the Kite error so the operator can tell "the session
died" from "this book has no legs".

This is a deliberate narrowing from the first draft, which had SPAN-lite
(`sensibull_tools/sim/margin.py`) filling in. Two facts killed it (D6): there is no
mechanism for TypeScript to call the Python desk (§1.3), and building one — or porting the
model — buys a number measured at ~18% conservative, whose span for a defined-risk book is
entirely the short-notional floor (§2.2). A visibly stale exact figure beats a fresh
approximate one on a tile an operator sizes trades from. The `source` field exists in the
schema (§7) so adding it later is additive; see §12.3.

## 6. Trigger

### 6.1 Two paths into one function

`refreshBookMargin(tag)`:

- **Schedule** — a config list of IST clock times aligned to SPAN file publication.
  Configurable, not hardcoded, so times change without a deploy. Ships with
  `09:10, 11:05, 12:35, 14:05, 15:35, 15:45` — **these are a starting point and need
  operator confirmation against NSE's actual publication times before merge.** A missed
  slot is skipped, not queued: a late-starting process must not fire six stale refreshes.
- **Leg-set change** — immediate, debounced 5s. Four fast fills collapse into one call
  after the last lands.

A refresh already in flight **coalesces** rather than queueing, so a fill landing mid-call
cannot produce two overlapping requests whose writes race.

### 6.2 Known limitation, recorded deliberately

Publication-time-only refresh under-samples. The SPAN risk array is indexed by scenarios
*relative to current spot*, so the same file yields a different scan loss as the underlying
moves — a short strangle drifting ITM sees margin climb with no new file. The operator chose
this cadence knowingly. The schedule is config precisely so extra ticks can be added without
a code change.

## 7. Storage

Collection `desk-book-margin`, `_id` = book tag:

| field | meaning |
|---|---|
| `asOf` | epoch ms of the figure |
| `ok` | did the last attempt succeed |
| `source` | `'kite'` today; the field exists so §12.3 stays additive |
| `span`, `exposure`, `total` | `total` = span + exposure (D5) |
| `premium` | `-final.option_premium`; carried, never added to total |
| `legs[]` | per-leg breakdown for the hover |
| `diagnostic` | why the last attempt failed, when it did |

Per D7 a failed refresh writes `ok:false` and `diagnostic` and **leaves `asOf` and the
figures untouched**, so the UI ages the number instead of blanking it.

## 8. API

`GET /v1/desk/margin?tag=<tag>` → the stored doc plus `ageMs` and a `stale` flag, mirroring
the `age`/`stale` shape `handleBrokerFunds` already returns. Never calls a broker. Returns
200 with `available:false` and a reason when no document exists yet — an absent figure is a
state to render, not an error.

## 9. UI

**Book page.** `Margin (book)` takes the slot the account tile has now. Value is `total`.
Note under the figure: nothing when fresh, `· 12m ago` once past the stale threshold. No
tone — margin is headroom, not P&L, and tinting it would put it in the same visual language
as the MTM tile two positions away.

**Rail.** Account utilised moves here, keeping the `(account)` label and the reasoning in
the current comment block, which should be carried across rather than rewritten.

**The tile must never imply additivity.** Per-book standalone figures do not sum to the
account total — SPAN scans the whole portfolio at once. The hover states this.

## 10. Degradation

| condition | behaviour |
|---|---|
| Kite 200 | figure and `asOf` updated, no note |
| enctoken expired / session dead | last good value + age; `diagnostic` records the Kite error; figure and `asOf` unchanged (D7) |
| Kite 200 but malformed body | treated as failure — no partial write |
| market closed | schedule does not fire; last value stands with its age |
| book has no legs | no call, no tile |
| no document yet | `available:false` + reason; tile shows `—` with `reading…` |

## 11. Testing

| unit | how |
|---|---|
| `basket.ts` | table-driven: sign→`transaction_type`, lots→units, symbol passthrough, empty legs |
| `schedule.ts` | pure over an injected clock: fires once per slot, debounce collapses a burst, in-flight coalesces |
| `kite.ts` | faked HTTP; **one recorded real response as a fixture** so the `final`-vs-`initial` choice (D5) is locked by a test, not by memory |
| `refresh.ts` | D7 — assert a failed call leaves the prior figure and `asOf` intact and sets only `ok`/`diagnostic` |
| endpoint | existing `server.test.ts` pattern: present doc, absent doc, stale doc |

## 12. Out of scope, recorded so it is not lost

**12.1 Marginal margin.** "What does *adding* these legs cost against what I already hold"
is a different call (`consider_positions=true`) and a different tile. Deliberately not built.

**12.2 Account-level attribution.** Splitting the account total across books is not possible
honestly — SPAN is not additive. Not attempted; §9 says so on the hover.

**12.3 SPAN-lite as an offline fallback.** Deferred, not rejected (D6). It would need either
a TS port of `sensibull_tools/sim/margin.py` or a real TypeScript→Python boundary, and it
buys a number ~18% conservative. Worth revisiting only if Kite session loss turns out to be
frequent enough that stale figures actually bite. The `source` field is in the schema so it
lands additively.

**12.4 Local dev environment is down.** Local Mongo is refusing connections on
`127.0.0.1:27017`; desk-api logs `pnl job failed` every minute and desk-marketdata has
restarted 254×. Unrelated to this work but it blocks local verification of it.
