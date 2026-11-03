# Desk Live Books — running sensibull-desk variants as managed paper books

**Date:** 2026-07-28
**Status:** approved, awaiting implementation plan
**Supersedes:** nothing. Extends `docs/superpowers/plans/2026-07-27-desk-bridge.md`.

## What we are building, in one paragraph

algomaker becomes the **live running desk**: it owns instruments, marks, greeks, order
routing, the book registry, the operator UI and all reporting. sensibull-desk stays the
**research desk** and keeps owning every trading decision — its rules engine is the engine,
in research and in production, unchanged. Between them goes a live driver on the Python side
that runs the *same* `sim` primitives the backtest runs, sourcing prices from the bridge
instead of the GFDL lake and booking fills from the bridge instead of pricing its own. The
first book is BHEL August 2026 on `hold-recycle-r`, seeded from the position already held.
More variants follow on the same symbol, side by side, which is what most of the schema work
below exists to make possible. Nothing here is paper-only: every component is built so that
switching a book to the live rail is configuration, not code (§7).

## Locked decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | **Python owns all trading logic, permanently.** No rules port to TypeScript. | Research and live must be literally the same code, or the backtest numbers stop describing the live desk. |
| D2 | **Python owns the book.** algomaker mirrors it and reports the diff. | Unchanged from the desk-bridge plan. |
| D3 | **Books are keyed by tag**, not by symbol. | Multiple variants on one symbol is the point. See §2. |
| D4 | The Python desk runs on the prod EC2 beside the bridge, from `/home/ubuntu/sensibull-desk`, supervised by systemd via the existing `pm2-ubuntu` unit. | A month-long positional book cannot depend on a laptop. |
| D5 | The live driver is a **new `live/desk/` package**, a sibling of `live/` — not a modification of it. | `live/session.py` drives a different engine. See §1.3. |
| D6 | The variant list shown in the UI is **published by the supervisor**, never hardcoded in algomaker. | Adding a variant must not mean editing two repos. |
| D7 | BHEL August starts from the **already-seeded 8-leg book**. | Operator direction. The long wings are simply held; `no_buy` means the engine never adds more. |
| D8 | **Every component is built live-ready.** Switching a book from paper to live must be a configuration act, never a code change. | Operator direction. See §7. |
| D9 | **Pricing matches research: Black-76 off the near future.** `BridgeStore` computes IV and greeks locally through the same path `GfdlStore` uses. The chain endpoint's own TS-computed greeks are **display-only** and never enter `ctx`. | One marking implementation. Per-strike delta sizes the rebalance, spot anchors the corridor, margin scans shocks around spot — a hybrid model matches neither engine. Requires subscribing the near-future token. |
| D10 | **Expiry settles at the last mark of expiry day**, mirroring `run_cycle` exactly: a synthesised `_close_all_decision`, throttle bypassed. | Every hold-recycle-r research figure includes that settle. A pre-expiry flatten is specified as a dial in §7.5 but stays **off** for paper. |

## 1. What exists today — audited, not assumed

### 1.1 algomaker gives

`apps/api`, port 8790, bearer auth (`DESK_API_TOKEN`, required at `main.ts:68`):

| Endpoint | Gives |
|---|---|
| `POST /v1/desk/actions` | `{op: open\|close\|roll\|resize}`, idempotent on `decisionId`, returns `{book, fills, skips}` |
| `GET /v1/desk/positions?symbol&mode` | legs + per-leg greeks, net book delta, spot, `complete` |
| `GET /v1/desk/instruments/:underlying` | expiries, listed strikes, inferred step, lot size |
| `GET /v1/desk/trades \| /books \| /diff \| /feed \| /orders \| /pnl` | reconciliation, feed readiness, reporting |
| `POST /v1/desk/declare \| /seed \| /killswitch \| /close-all` | book of record, safety |

BHEL is already seeded: August series **2026-08-25**, lot **2625**, strike step **2.5**,
3 short strikes per side (5 lots each) against one long wing per side (15 lots).

### 1.2 Corrections to the desk-bridge plan doc

Three statements in `docs/superpowers/plans/2026-07-27-desk-bridge.md` do not match the code
as built. Recorded here so the next reader does not re-derive them:

1. **`declare` does not drive feed subscription.** `service.declare` (`service.ts:1222`) only
   calls `store.saveDeclaration`. Subscription is driven off `store.allBooks(mode)` in
   `apps/marketdata/src/main.ts:272`. Being **in the book** is what gets tokens marked;
   declaring only feeds the D2 diff.
2. **The feed already subscribes the whole chain.** `planSubscriptions` supports `fullChain`,
   enabled by default at `apps/marketdata/src/main.ts:289` (`DESK_FULL_CHAIN !== '0'`). The
   comment at `subscription-source.ts:56-65` records that a window was tried and rejected —
   an action opening a strike outside it was skipped as "no mark". Ticks for ATM±2 already flow.
3. **`GET /v1/desk/instruments/:underlying` exists** (`desk.ts:831`) but returns the master
   dump — strikes, step, lot size. **No prices.**
4. **"Live routing is BLOCKED for stock options" is stale.** It describes `xtsOrder.js:104`,
   whose `maxOrderLots` table held only 5 index names — and `xtsOrder.js` is retired.
   `apps/order-gateway/src/gateway.ts:125` calls `freeze.maxLotsPerOrder(underlying, lotSize)`
   per underlying, off `desk-freeze-limits`, and splits with `splitIntoTranches`. BHEL resolves
   to 20 lots per order. The gateway path is not blocked for stock options.

### 1.3 The integration gap, stated precisely

sensibull-desk contains **two engines**, and they are not interchangeable:

| | `backtest/` | `sim/` |
|---|---|---|
| Entry | `basket_engine.py`, `decide.py` | `engine.run_cycle`, `rules/engine.RuleEngine` |
| Variants | `variant_config` — `active`, `delta2`, `tv5l` | `sim/variants.py` — ~30 keys incl. **`hold-recycle-r`** |
| Decision shape | `{op: open\|close\|roll\|resize}` | `{action, picked_id, open_legs, close_ids, close_parts, reason}` |
| Live loop | **exists** — `live/session.py`, pm2 `sensibull-live` | **none** |

`grep -c "hold-recycle" backtest/basket_engine.py backtest/decide.py` returns `0, 0`.

`contract.ts:3-5` states that the bridge contract was shaped from `backtest/decide.py`.
**So the bridge speaks the vocabulary of the engine that cannot run `hold-recycle-r`, and not
the one that can.** That is the actual gap — not marks, not the feed, not greeks.

What *is* reusable from the existing live package: `live/store.py` (135 lines) already does
atomic, restart-safe per-book state at `<SYMBOL>/<variant>.state.json` plus ledger and marks.
It is used verbatim.

### 1.4 What `hold-recycle-r` consumes

`sim/engine.py:266-272` builds one `rules_ctx` per mark:

```
marked_book, chain, signals, spot, dte, symbol, date, time,
realized_so_far, pending_lots, margin, margin_cap, table
```

For a `rule-engine` decider `table` is empty and `signals` is unused by `hold_recycle`, so
`sim/optimizer/`, `sim/signals.py` and `sim/decide.py` are all out of scope. Everything else
derives from the store, through six methods: `spot_ref`, `mark`, `marks`, `raw_chain`,
`raw_future`, `future`.

`hold_recycle` (`playbooks.py:2063`) additionally needs **per-strike delta and price**
(`_chain_delta`, `_chain_price`) for candidate strikes it does not yet own.

## 2. Book identity — the change that unblocks multi-variant

Today the bridge carries two identity schemes in one function. `applyDecision` loads the book
by `(req.symbol, req.mode)` (`service.ts:264`) and then gates the decision on `req.tag`
(`service.ts:302`).

```
store.ts:161  books        unique { symbol: 1, mode: 1 }
store.ts:162  declarations unique { symbol: 1 }
store.ts:167  strategies   unique { tag: 1 }
```

**Consequence:** two variants on BHEL paper carry different tags, pass the gate independently,
then `saveBook` — an upsert on `{symbol, mode}` — **overwrites each other with no error**.
It also prevents BHEL August and BHEL September paper coexisting.

### The change

- `desk-books` unique index `{symbol, mode}` → **`{tag, mode}`**; `desk-declarations` follows.
- `symbol` and `expiry` remain attributes on the row. `planSubscriptions` reads `b.symbol` and
  needs no change — N books on one symbol dedupe to the same token set.
- Routes take `?tag=`; `?symbol=` is retained as a **list** filter, no longer a unique key.
- Tag convention: `BHEL-2026-08-25-hold-recycle-r`.

### Scope

22 call sites, 14 of them in `service.ts` (`loadBook`, `saveBook`, `allBooks`,
`saveDeclaration`), plus `apps/web/src/{api,pages,App}.tsx`. `shell.tsx:59-64` already carries
both `symbol` and `tag` on `Location`, so the route change is small.

### Payoff beyond unblocking

P&L, orders and reports are already tag-scoped, so they segregate per variant for free. And
`UnknownStrategy` (a 403 for any tag without a registry row, `service.ts:302`) resolves
naturally: creating a book creates its registry row.

## 3. Components

### 3.1 algomaker

| Item | Detail |
|---|---|
| Tag-keyed books | §2. Migration is one paper document, re-seeded under its tag. |
| `GET /v1/desk/chain/:underlying?expiry=` | Per strike, per side: **price, OI, ΔOI, volume**, plus spot and the near-future price, each with **`asOf`**. Greeks/IV may be returned but are **display-only** (D9) — `BridgeStore` never reads them. Returns **every listed strike**, `null` price where a strike has not ticked. |
| `oi` **and `volume`** on `md.tick` | The feed subscribes `'full'` by default (`kite-feed.ts:138`) so both arrive in the packet and are discarded at `main.ts:262`. `QuoteCache` must carry them alongside price. |
| **Near-future subscription** (D9) | The research forward. `planSubscriptions` adds each book's near-future token; `BridgeStore.future`/`raw_future` serve it. |
| **Per-strike `asOf` on every quote** | Blocker 2. Without an age per quote, `BridgeStore` cannot tell a live price from yesterday's. |
| `desk-books` registry | `{tag, symbol, expiry, mode, variant, dials, seedLegs, desired, actual, lastMarkAt, lastDecision}`. CRUD + start/stop. Replaces the hardcoded `BHEL_SEED` constant at `seed.ts:131`. |
| `POST /v1/desk/variants` | The supervisor publishes its catalogue, **filtered to the runnable subset** — `decider: 'rule-engine'` only. The registry is mixed (`llm`, `hybrid`, `rule-engine`); the others shell out to `claude` and are not offered as books. |
| **Tag on `desk-fills`; tag filter on `/v1/desk/trades` in BOTH modes** | `desk-fills` rows carry no tag today (`gateway.ts:234-251`), though `fills.ts:132` already journals `order.tag` — so the write site has it in hand. Paper filters by symbol only (`store.ts:233`). Both rails need `?tag=`, or phase 6's two-variant reconcile mixes the sibling book's fills in. |
| `expiry` on the `allBooks` mapping | `apps/marketdata/src/main.ts:276` must pass `expiry: b.expiry ?? b.legs[0]?.expiry`. `planSubscriptions` already consumes a book-level expiry (`subscription-source.ts:20, 90`); without it a **flat** book subscribes nothing and can never open its first leg. |
| Real `DESK_API_TOKEN` | Currently a readable placeholder in `.env.prod`. |
| `#/books` page | §5. |

### 3.2 sensibull-desk — new `live/desk/`

| Module | Responsibility |
|---|---|
| `bridge.py` | HTTP client: positions, chain, actions, declare, feed, killswitch, variants |
| `store.py` | `BridgeStore` — the six-method duck-type. Serves raw prices from the chain/positions responses and **computes IV and greeks locally through the same path `GfdlStore` uses** (D9) |
| `driver.py` | Wall-clock loop replacing `run_cycle`'s date×checkpoint walk, **including the session calendar (§4.4) and the expiry settle (§4.5) that loop also owned** |
| `translate.py` | sim decision → bridge actions; bridge fills → book; realized accounting (§4.6) |
| `supervisor.py` | Converges `desk-books.desired` → running workers; publishes the runnable variant catalogue on start |

Reuses `live/store.py` for state, ledger and marks — **but rooted at `data/desk/` and keyed by
tag**, not at the default `data/live/` keyed by `(symbol, variant)`. Two reasons: the default
root is the old `sensibull-live` loop's, and §6's anti-double-execution guard looks there; and
`(symbol, variant)` carries no expiry, so two expiries of one variant on one symbol would
clobber each other's `hr_anchor` — precisely the collision §2 fixes on the bridge side. The
`dir` parameter already exists on every `live/store.py` function, so this is configuration.

**Why `BridgeStore` rather than building `ctx` from `/v1/desk/positions` directly** — the
latter is less code, but it creates a second marking implementation.

### 3.2.1 What `BridgeStore` serves, method by method

| Method | Source |
|---|---|
| `spot_ref` | Cash spot from the chain response |
| `future` / `raw_future` | The subscribed near-future token (D9) — the research forward |
| `mark` / `marks` | Chain price + locally computed Black-76 IV/greeks |
| `raw_chain` | Full listed chain, `null` price where unticked. **ΔOI needs the previous checkpoint**, which the bridge does not store: `BridgeStore` memoizes each mark's chain to serve the `prev_cp_time` call, and `d_oi_cp` is `None` on the first mark after a restart |

Since parity with the research desk is the entire reason D1 was chosen, the live driver runs
the same `mark_book`, `build_chain` and `RuleEngine.decide` as the backtest. Only the data
source changes.

### 3.3 Supervision

**One long-lived supervisor**, not one systemd unit per book. It polls `desk-books` and
converges `desired` → `actual`, running one in-process worker per book. algomaker never shells
out; it writes `desired: 'running'` and the supervisor picks it up — the same claim-based
pattern the order path already uses. The supervisor runs under the existing `pm2-ubuntu`
systemd unit from `/home/ubuntu/sensibull-desk`.

## 4. One mark, end to end

Cadence: **5-minute marks aligned to :00/:05**, matching the sim checkpoint grid so live runs
and the research corpus stay directly comparable.

0. **Session gate (§4.4).** Outside 09:15–15:30 IST, or not `is_trading_day` → no mark at all
1. `GET /v1/desk/feed` — not alive (warm-up is 60–90s after restart) → **skip, no decision**
2. **Reconcile the previous mark's fills** against `GET /v1/desk/trades?tag=` (§4.2)
3. `GET /v1/desk/positions?tag=` — `complete === false` **or `stale === true`** → **skip** (§4.4)
4. `BridgeStore` serves the six store methods
5. `mark_book(...)`, `build_chain(...)` — verbatim `sim` code
6. `RuleEngine.decide(ctx)`, `ctx` shaped as `sim/engine.py:266-272`, `state` from `live/store.py`
7. `throttle` paces the package (20 lots/mark)
8. `translate.py` → actions, one `decisionId` per mark
9. `POST /v1/desk/actions` → `{status, book, fills, skips, routeErrors}`
10. Book updated **from the returned fills** (provisionally — §4.2); `skips` **and**
    `routeErrors` folded into state (§4.3); state, ledger and marks saved
11. `POST /v1/desk/declare` — feeds the D2 diff

### 4.1 Translation

| sim decision | bridge |
|---|---|
| `open_legs[]` | `open`, `ts` = Python's leg id |
| `close_ids[]` | `close` |
| `close_parts[] {id, lots}` | `resize` — **absolute** remaining qty, not a delta (`contract.ts:79`) |
| — | `roll` unused: `hold-recycle` never rolls |

`deskTag` is Python's own leg id. Python owns the book, so it assigns identity; the bridge
treats the tag as opaque and compares only for equality (`contract.ts:44-47`).

**The one deviation from the research path:** `sim/execute.apply_decision` prices its own fills
off the store. The live driver must not — it books from the bridge's `fills[]`. Booking from
its own pricing makes the two books diverge on the first fill.

### 4.2 Fills are provisional until reconciled

`applyDecision` computes `result.fills` from `applyActions(...)` against `this.#d.marks` — the
live feed mark — **in both modes**, and only then routes each fill through
`railFor(req.mode)`. So the `fills[]` in the response are **intent-priced**, not broker-priced.

- **Paper:** intent *is* the fill. `PaperRail` books at "the live mark supplied by the caller —
  this is a paper BOOK, not a paper price model" (`rail.ts:164-166`).
- **Live:** the broker fills somewhere else. The true price lands asynchronously in
  `desk-fills`, correctly averaged across tranches by `apps/order-gateway/src/fills.ts` — a
  30-lot order split into two tranches at 100 and 130 must book 106, not 130.

**So the driver books provisionally from the response and reconciles from
`GET /v1/desk/trades` at the next mark**, correcting entry prices where the broker's fill
differs. In paper the reconciliation is a no-op costing one HTTP call; in live it is the only
thing keeping the book honest. Building it now is the difference between a config switch and a
rewrite.

**Correcting prices is not enough.** A routed-then-**rejected** or **partially filled** order
leaves the bridge book carrying a leg the broker never filled — forever. The operator's P&L
drifts from the broker statement by cumulative slippage plus every rejection; the D2 diff flags
a mismatch and blames Python, which corrected itself; and operator close-all flattens a leg
never held, **placing a real order that opens reverse exposure** — the exact trap `applyDecision`
documents for route errors but not for broker-side failures.

So the reconcile contract is three-sided:

1. **Price differs** → correct the entry, and for a close, restate realized (§4.6)
2. **`REJECTED` / `PARTIAL`** → un-book or resize the Python leg
3. **No row yet** → wait. Never assume the fill

And it must correct **both** books: a bridge-side consumer of the gateway's terminal states
corrects `desk-books` and the `desk-decisions` fill prices, so that the book close-all plans
from is broker-true. Correcting only Python's copy leaves the dangerous half uncorrected.

API changes this needs, all in phase 0: **the gateway stamps `tag` (and `mode`) into
`desk-fills`** — the write site already has it (`fills.ts:124` loads the order, `fills.ts:132`
journals `order.tag`), the rows simply don't carry it (`gateway.ts:234-251`) — and `?tag=` on
`/v1/desk/trades` for **both** rails, since paper filters by symbol only (`store.ts:233`).

### 4.3 Route errors are skips

`routeErrors` is a **separate field** from `skips`. A live rail refusal — a tag absent from
`DESK_LIVE_TAGS` raises `LiveRailBlocked` (`rail.ts:278-282`) — produces a route error, and the
bridge deliberately excludes that leg from the book — "an attempt is not a position", the
comment above `routedFills` in `applyDecision`. The driver must fold `routeErrors` into state
exactly as it folds
`skips`. Reading only `skips` means Python believes in a leg that reached no rail.

### 4.4 Session calendar and quote freshness

**The gates in steps 1 and 3 are not sufficient alone, and the failure is silent.** `feedAlive`
is feed-**wide** — any tick within 120s (`marks.ts:117-120`). `QuoteCache.#byToken` is never
evicted and `ecosystem.desk.config.cjs` has no `cron_restart`, so a process surviving overnight
still holds yesterday's option marks. At 09:15 the first tick anywhere makes the feed alive;
every strike cached from yesterday 15:30 "prices"; `positions` returns `complete: true,
stale: true`; both gates pass; and `applyActions` fills at those cached prices
(`book.ts:82-107`). The book is silently corrupted on **every gap open**.

Three requirements, none optional:

1. **Session calendar.** Mark only 09:15–15:30 IST on `is_trading_day` — identical to the sim
   grid (`sim/config.py:35`). The utilities exist in `sensibull_tools.universe`, and the old
   live tick already gates this way (`ecosystem.config.js:56-58`). Weekends and NSE holidays
   are handled here, not left to the 120s dead-feed window.
2. **`stale === false`** is required to decide, not merely reported.
3. **Per-strike `asOf`.** `BridgeStore` refuses any quote not timestamped **today**, and the
   day's first mark requires marks from today. Feed-wide liveness cannot answer "is *this*
   strike live". The refusal belongs in the driver — per-token age must never hide a price on
   the display path.

### 4.5 Expiry settlement

**The settle is loop logic, not playbook logic**, and the driver replaces the loop.
`sim/engine.py:246-248` emits `_close_all_decision(book)` at the last checkpoint of the last
date, and `engine.py:116-128` records that it **bypasses the throttle outright**. `hold_recycle`
never emits a close (`playbooks.py:2063-2100`); `no_close` suppresses the crash and margin
guards; the `dte<=1` trigger sits inside the trailing ratchet, which this variant never
enables. Without an explicit settle, **nothing closes this book, ever**.

The consequence is worse than a missing number. Once the series expires the master drops the
contracts; `book.ts:119-120` skips any close with no live mark and the order path refuses stale
prices (`service.ts:1165-1167`) — so **not even a manual close-all can flatten it**. The book
wedges with terminal P&L unrealised, and §9.1 parity is violated by construction, since every
hold-recycle-r research figure includes that settle.

Per D10: the driver synthesises the same `_close_all_decision` at the final checkpoint of
expiry day, routes it as an ordinary decision with the throttle bypassed, then archives the
`desk-books` row. If the process was down at settle time, the next start after expiry runs
settlement against the last marks it holds. A book still carrying legs past its expiry raises a
**named alarm** on the Books page — never silence.

### 4.6 Persistent state, in full

`ctx['state']` is not the whole story: the throttle queue, `cum_realized` and `prev_cp` live in
`run_cycle`'s **loop**, not in the state dict. An unpersisted throttle queue silently drops the
un-worked remainder of a paced package across a restart — a 60-lot package at 20/mark loses 40
lots — and `pending_lots` stops gating the strategy tier.

The state file holds, per book: the Python book with leg ids · `rule_state` (incl. `hr_anchor`,
`hr_funded`, scrap bans, cooldowns) · `throttle_state` · `cum_realized` · `prev_cp` · the last
`decisionId` and mark.

**Realized accounting** is defined here rather than inherited: the driver computes realized
deltas from bridge fills against its own entries using sim's convention,
`sign × (exit − entry) × shares`. §4.2's reconciliation therefore **restates realized** when a
*close* fill's broker price differs from intent — not only entry prices. `cum_realized` feeds
`realized_so_far`, which times the hard target lock and funds `hr_funded`: the two mechanisms
that define this variant.

## 5. Frontend

The dashboard already splits manage from monitor: `#/strategies` is the registry with
switches; `#/positions/<symbol>` is the live view. A book is the positional sibling of a
strategy row and takes the same split.

- **`#/books`** — new. Create, configure, start/stop.
- **`#/positions/<tag>`** — existing page, re-keyed.

**Create flow:** symbol → expiry (from `/v1/desk/instruments/:underlying`) → variant (from the
published catalogue, so it is exactly what is deployed) → dials pre-filled from the variant's
`default_target_pnl` / `default_margin_cap` → seed legs → review.

Two safety properties carried from `DEFAULT_STRATEGY` (`strategies.ts:139-151`): **a created
book is added to nothing and starts stopped** — creating is never itself a trading permission.
The seed screen enforces client-side what `validate.ts:170-184` enforces server-side: signed
qty, whole lots, `rate > 0`.

**Monitor view:** legs with per-leg greeks and net delta; P&L; the decision log with reasons
and skips; the D2 diff; feed health; killswitch and close-all. A halt blocks new exposure and
never an exit — close-all works while halted.

`apps/web/src/strategies.tsx` is currently modified in the working tree; the Books page borrows
from it and should land after that settles.

## 6. Failure handling

- **Skips and route errors fold into state** (§4.3). A skipped open is not in the book, so the
  corridor anchor and the high-water mark must reflect what happened, not what was requested.
  Assuming the fill is how a paper book stops describing a real one.
- **`decisionId = <tag>:<mode>:<ISO mark>`** — deterministic, so a retry after a timeout
  replays rather than double-fills. **`mode` is in the key**: because a paper and a live book
  coexist under one tag (§7.3), two workers marking at the same instant would otherwise compute
  the identical id, and the loser would receive the *other mode's* fills as a `DONE` replay and
  book them — a live book populated by paper fills, with no order on any rail.
- **Crash between POST and save — the recovery is a mechanism, not an assumption.** "The same
  decisionId on restart replays" only holds if something re-sends it. On start the driver
  derives every mark boundary between its last saved mark and now, **re-POSTs each missed
  `decisionId`**, folds the returned fills, and only then resumes the live grid. A replayed
  mark's fresh engine decision is **discarded** in favour of the stored fills.
- **The indeterminate third state.** A response of `ROUTING` means the bridge claimed the id and
  may or may not have routed. Never save state or advance the mark on it: retry the **same** id
  with backoff until `DONE` or `FAILED`. Accepting an empty replay as final leaves fills that
  *did* route unfolded forever.
- Feed dead, incomplete book, or killswitch → hold with a logged reason.
- The supervisor restarts a failed worker with backoff; the state file is the recovery point.
- **`sensibull-live` must never manage a book the supervisor manages.** Same double-execution
  failure as running `xtsOrder.js` beside `apps/order-gateway`. Enforced: the supervisor refuses
  a book whose `(symbol, variant)` exists under **the old loop's `data/live/` root** — its own
  `data/desk/` root (§3.2) is exempt. Stated this way deliberately: a guard reading its own
  state directory would refuse every book it manages on the first restart, failing phase 4 on
  its own exit condition. Residual race worth knowing: the old tick writes its state file only
  on first fire, and the two `(symbol, variant)` vocabularies are disjoint today — so what this
  guard really prevents is a future name collision, not a live one.

## 7. Live readiness — what switching actually costs

D8: no retrofit. This section is the audit that backs that claim.

### 7.1 What is already shared

The paper/live difference in the bridge is **only the rail**. Action validation, the strategy
gate, halt handling, mark-priced fill computation, the recompute of the book from routed fills,
the decision journal, idempotent replay, killswitch and close-all are one code path for both
modes. `railFor(req.mode, this.#d.rails)` is the entire fork.

Everything in §3 and §4 is therefore mode-agnostic by construction, with one exception —
§4.2's reconciliation, which is specified now precisely so that it does not become a retrofit.

### 7.2 The three gates, none of which default to on

Switching a book to live requires three deliberate, independent acts:

1. **`DESK_LIVE_TAGS`** — the tag must be in the allowlist. Checked inside `LiveRail.route`
   (`rail.ts:278`), *not* at the API edge, because "an edge check is one refactor away from
   being bypassed by a second call site" (`rail.ts:221-223`).
2. **The order-gateway's own `DESK_LIVE_TAGS`** — a *second process* refusing independently
   (`apps/order-gateway/src/main.ts:495`). Both read the same variable from the shared
   ecosystem env, but **each needs its own restart** to pick up a change. (`rail.ts:225-228`
   still describes gate 2 as `xtsOrder.js:99`'s `account.strategy[tag]` — that is the *retired*
   executor's mechanism and the comment is stale; worth fixing in phase 0.)
3. **The registry row must be added and enabled for `live`** — `StrategyModes` is per-rail, and
   `DEFAULT_STRATEGY` is added to nothing (`strategies.ts:139-151`).

**The Books page shows all three as a readiness checklist**, so "why did nothing route?" is
answered on the page instead of in a log. That is the main UI concession to live.

### 7.3 The switch itself

Because books are keyed `{tag, mode}` (§2), a paper book and a live book **coexist under one
tag**. Going live is:

1. Seed the live book from the real position (`POST /v1/desk/seed`, `mode: 'live'`)
2. Add the tag to `DESK_LIVE_TAGS`
3. **Restart both the API and the order-gateway** — two processes, two allowlists (§7.2)
4. Enable `live` on the registry row
5. Stop the paper worker; start the live one

No migration, no code change, and the paper book's history stays intact beside it.

**What state carries across:** the book is **re-seeded from the real position**, not copied.
Engine state starts **fresh** — `realized_so_far`, `hr_funded` and `hr_anchor` are reset. This
is not a detail: `default_target_pnl` is ₹2.5L (`variants.py:315-317`), so carrying a month of
paper profit across would make the live target lock fire almost immediately, flattening a book
that had earned nothing. The mode-keyed state path (§3.2) makes reset the default rather than a
step someone has to remember.

### 7.4 Sizing does not silently change

`StrategyRow.liveLots` is read by the Phase C intraday runner. A positional book sizes from its
seed and its variant dials, and **must not** pick up `liveLots` — a book that quietly resized
on going live would be a different strategy from the one that was paper-tested.

### 7.5 Physical settlement

BHEL options are **physically settled**. Short ITM strikes carried into expiry mean delivery
obligations and NSE's expiry-week delivery-margin ramp — neither modelled by the sim, which
cash-settles at intrinsic. D10 keeps paper mirroring `run_cycle` so the month's numbers stay
comparable to the research corpus. A **pre-expiry flatten dial** (force-close at a configurable
DTE) is specified now and ships **off**; switching a book to the live rail requires either
turning it on or an operator runbook for delivery week. This is the one place where live is
deliberately *not* identical to paper, and it is named rather than discovered.

## 8. Build order

The tag refactor goes first because the Python client is written against that API. Ship BHEL on
`?symbol=` and the client gets written, then rewritten.

| # | Phase | Exit condition |
|---|---|---|
| 0 | Tag-keyed books + declarations; real `DESK_API_TOKEN`; `tag`+`mode` on `desk-fills`; `?tag=` on `/v1/desk/trades` **both rails**; `expiry` on the `allBooks` mapping; stale `rail.ts` gate-2 comment | BHEL book reads back under its tag; a flat book still subscribes its chain |
| 1 | Chain endpoint (price/OI/ΔOI/volume/spot/future, **per-quote `asOf`**); `oi`+`volume` on `md.tick`; near-future subscription | Every listed strike returns, unticked ones as `null`, each with an age |
| 2 | `desk-books` registry + variant catalogue (rule-engine subset) | BHEL exists as a registry row |
| 3 | Python `live/desk/` — driver, `BridgeStore` (local Black-76 greeks), translate, **§4.2 reconciliation, §4.4 session+freshness gates, §4.5 settle, §4.6 state** | **BHEL `hold-recycle-r` runs live-paper, by hand, one book** |
| 4 | Supervisor + pm2/systemd | Survives a reboot unattended |
| 5 | Books UI, incl. the §7.2 live-readiness checklist | A book is created and started without a shell |
| 6 | Second variant, A/B on one symbol | Two variants on BHEL paper, independent books |

Reconciliation lands in phase 3 and the readiness checklist in phase 5 — both no-ops in paper.
They are built there rather than deferred precisely so that going live is D8's config act.

BHEL is live-paper at the end of phase 3 — before the supervisor and before the UI. Deliberate:
run the mechanism watched by hand first, automate second.

## 9. Testing

New coverage, ordered by what would hurt most if wrong:

1. **Parity harness.** Record a day of bridge responses; replay through the driver; assert the
   decisions match `run_cycle` over the same marks. This is the test that says the live desk is
   the desk that was researched.
2. **`BridgeStore` conformance** — the same book through `GfdlStore` and `BridgeStore` over the
   same data produces an identical `ctx`.
3. **Fills are not self-priced** — the book moves to the bridge's fill price, never Python's mark.
4. **Skips fold into state** — a skipped open does not advance the anchor or the high-water mark.
5. **`decisionId` replay** — a retry after a timeout routes nothing.
6. **`translate.py` round-trip**, including `close_parts` → absolute `resize` qty.
7. **Book-key migration** — two variants on one symbol produce two independent books.
8. **Reconciliation corrects a divergent fill** — a broker fill at a price other than the
   intent price moves the book to the broker's price, including the tranche-averaged case.
9. **`routeErrors` fold into state** like skips — a leg blocked by the live allowlist is not
   in the book and does not advance the anchor.
10. **Mode-parity** — the same decision through the paper and live rails produces the same
    actions, differing only in which collection the order lands in.
11. **The driver settles at expiry** and the throttle does not pace the settle (§4.5).
12. **The 09:15 mark after an overnight run does not decide or fill on the prior day's cached
    marks** (§4.4) — with weekend and NSE-holiday cases.
13. **Crash recovery re-POSTs missed marks** and folds their fills; a `ROUTING` response never
    advances the mark (§6).
14. **A paper and a live worker on one tag cannot collide** — `decisionId` carries `mode`.
15. **Rejected and partial broker fills** un-book or resize the leg, in both books (§4.2).
16. **Throttle queue survives a restart** — a 60-lot package at 20/mark resumes with 40 left.
17. **Two expiries of one variant on one symbol** keep separate Python state (§3.2).

## 10. Deliberately not in scope

- Porting any rules to TypeScript. D1.
- **Turning live money on.** The design is live-ready (§7) and the gateway path is not blocked
  for stock options, but no book in this build is switched to the live rail. That is a separate,
  deliberate act requiring all three gates in §7.2.
- `apps/runner` and the intraday strategy migration.
- The `backtest/` engine's own live loop (`live/session.py`, pm2 `sensibull-live`). It keeps
  running as it does today, on books the supervisor does not own.
- Retiring `sim/optimizer/`, `sim/signals.py` or `sim/decide.py`. Unused by this path, still
  used by other variants.
