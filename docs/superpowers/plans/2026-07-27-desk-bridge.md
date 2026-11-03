# Desk Bridge — algomaker as execution bridge + dashboard for the Python desk

**Owner decisions, 2026-07-27.** Supersedes the intraday-migration framing in
`context/08-overhaul-proposal.md` phases 4-7 for sequencing purposes. Those phases are not
cancelled, they are **deferred**: the ported strategy classes stay in `packages/strategies` as
libraries and get a host **if and when** they are wanted again.

## What we are building, in one paragraph

The Python desk (`/Users/aaditya/Documents/dev/algo-engine/sensibull-desk`) owns **all trading
logic** — the rules engine, the book, delta management, roll decisions. algomaker is a **bridge and
a dashboard**: it accepts actions over an API, routes them (paper or live), computes greeks/delta
independently from the live feed, and exposes positions + trades so Python can see what actually
happened. Multiple Python processes run under pm2, one or more per symbol.

## Locked decisions

| # | Decision | Consequence |
|---|---|---|
| D1 | **Python has the logic; algomaker is an API bridge.** | No risk engine, no strategy, no position management policy on our side. We route, record, mark, and report. |
| D2 | **Both sides keep a book; the API surfaces the diff.** | algomaker's book is what it actually executed/holds. Python's is what it believes. Neither arbitrates — the dashboard shows the difference and a human decides. |
| D3 | **Paper first, live later.** | Paper positional delta management is the first thing that runs end to end. Live is a per-tag switch, not a rewrite. |
| D4 | **Paper orders NEVER touch the `positional` collection.** | `xtsOrder.js:314` watches that collection's change stream and routes to a real broker. A paper order reaching it is a real trade. Paper writes to a separate collection, so the failure is impossible by construction rather than by discipline — the same reasoning as `ZerodhaDataAdapter` making order placement throw. |
| D5 | **algomaker computes greeks itself.** | Python's delta is a view of what it believes it holds; ours is computed from the executed book and the live feed. When they disagree, that difference is the signal — which only works if the two are independent. |
| D6 | **Stock options are first-class.** | 3-4 names now, 10+ later. Strike steps and lot sizes come from the exchange dump, never from config or a book file. |
| D7 | **Legacy intraday runner is out of scope.** | No `apps/runner`, no marketdata for strategies. Rebuild into the new system if/when wanted. |
| D8 | **FULL CUTOVER (2026-07-27).** The old system is discarded, not strangled. | `apps/order-gateway` is THE live executor and `LiveRail` defaults to it. `xtsOrder.js` / `smp_order_listener.js` are retired and must NOT run alongside — both consuming orders would place every one twice. No further fixes go into legacy files. |
| D9 | **Every order submission is journalled.** | `desk-order-events` records ACCEPTED → PLANNED → SUBMITTED → ACK → STATUS, plus FAILED with the broker message and its class. Today the only record of a failure is a Telegram line (`xtsOrder.js:115`). |

## The rail (post-cutover)

```
Python (pm2, N processes)
   │  POST /v1/desk/actions   {mode: paper|live, actions:[{op, ...}]}
   ▼
apps/api  ─────────── paper ──────────▶  desk-paper-trade
   │                                     (marked off the live feed; no broker, ever)
   └──────────────── live ────────────▶  desk-gateway-orders   (durable record)
                                          │  + bus nudge  `order.submitted`
                                          ▼
                                  apps/order-gateway
                                   split under freeze limit
                                   place via XTS adapter
                                   XTS order socket -> real fills
                                          │
                                          ├──▶ desk-order-events   (every attempt)
                                          └──▶ XTS broker
```

**Why the collection AND the bus.** A tick dropped to a disconnected subscriber
is harmless — another arrives in 30s. An *order* dropped to a disconnected
gateway is gone, and the desk believes it placed something that never reached a
broker. So the collection is the durable record and the bus carries only a
nudge; losing a nudge costs latency, never an order, because the idle sweep
finds it anyway. No change stream, and therefore no replica-set dependency on
the order path.

**Claiming.** Orders are taken by a conditional update, so two gateway instances
cannot both place the same order. A claim held past `CLAIM_TIMEOUT_MS` is
reclaimed — a gateway that dies mid-placement would otherwise leave the order
stuck forever and silently never sent.

Live routing gates, none of them a default:
1. `mode: 'live'` stated on the request (never inferred).
2. The tag in the API's live allowlist (`DESK_LIVE_TAGS`), checked inside `LiveRail` itself rather
   than at the HTTP edge — an edge check is one refactor away from a second call site bypassing it.
3. The **kill switch** (`desk-safety`, persisted). Blocks new exposure; never blocks an exit.

A tag that is not configured produces a recorded, unrouted order — visible in `desk-order-events`,
not silently dropped.

## API surface (`apps/api`)

| Endpoint | Purpose |
|---|---|
| `POST /v1/desk/actions` | The desk's actions for one decision. `{op: open\|close\|roll\|resize}` — the shape `basket_engine.py:400` already emits. Idempotency key per action; a replayed key returns the original result and does not re-route. |
| `GET  /v1/desk/positions` | Open legs **with per-leg greeks and net book delta**, computed here. `?mode=paper\|live`. |
| `GET  /v1/desk/trades` | Fill history, so Python can reconcile what it asked for against what happened. |
| `GET  /v1/desk/diff` | D2: algomaker's book vs the book Python last declared, per symbol. |
| `GET  /v1/desk/instruments/:underlying` | Chain resolution: expiries, listed strikes, inferred strike step, **lot size from the dump**. |
| `POST /v1/desk/declare` | Python declares its intended book. Drives (a) the diff and (b) which tokens the feed subscribes. |
| `POST /v1/desk/seed` | Record an already-held position without routing anything. |
| `GET  /v1/desk/feed` | Feed readiness. Warm-up takes 60-90s after a restart, so the desk can ask whether marks are usable before acting. |
| `GET  /v1/desk/books` | Every book with its net delta and completeness. |
| `POST /v1/desk/killswitch` | Halt new exposure. Persisted; survives restart. |
| `POST /v1/desk/close-all` | Flatten a book. `style: 'fast'` (MARKET) or `'limit'` (priced through the mark). Works while halted. |

Auth: bearer token from env. Not the LoopBack superadmin session, and not the
`/add_the_boss` lineage.

## Instrument + token sync (replaces `server/tools/exchangeToken.js`)

The existing file has three defects that block this work outright:

1. **Hardcoded to 5 index names** (`exchangeToken.js:46-50`). Stock options are simply absent from
   the `instrument` collection, so `xtsOrder.js:288`'s `loadInstruments` cannot resolve a
   `KALYANKJIL...` symbol — a live desk order would fail to route with no useful error.
2. **Upsert-only, never deletes.** Expired contracts accumulate forever. Since `loadInstruments`
   keys the map by `tradingsymbol`, a stale row from a prior year can shadow the current contract.
3. No retry, no signal on failure, and it boots all of LoopBack to write to one collection.

The replacement is an active sync:
- Full Kite dump (`api.kite.trade/instruments`, unauthenticated) → filter to the configured
  universe (indices + the desk's stock names) → upsert.
- **Delete rows whose expiry is in the past**, guarded: never delete a token referenced by an open
  position in either book.
- Runs at boot, on a pre-open cron, and on demand — adding a stock must not need a restart.
- Reports added / updated / expired-removed counts.

## Feed and subscription lifecycle (`apps/marketdata`)

One Kite login, one websocket (the legacy system opened 147). `SubscriptionRegistry`
(`packages/marketdata-core`) already refcounts tokens per subscriber and returns a subscribe/
unsubscribe diff; the desk drives it by declaring each book's legs plus a strike window around
spot for roll candidates. When a book rolls or closes a leg, re-declaring drops the dead token
automatically — that is the "remove old ones" on the feed side, and it is idempotent, so it is safe
to call on every Python tick.

## Build order

| # | Item | Status |
|---|---|---|
| 1 | `packages/instruments` — `OptionMaster`: stock-option contract resolution, strike step **inferred** from listed strikes, lot size from the dump, `null` for unlisted strikes | **DONE** — 9 tests |
| 2 | `packages/greeks` — BS greeks, implied vol by bisection, book-level net delta | **DONE** — 12 tests |
| 3 | `apps/api` — the bridge: book engine, store, rails, service, HTTP, validation | **DONE** — 19 unit + 11 Mongo integration + 18 HTTP |
| 4 | Paper fill engine — marks off the feed, staleness = absent | **DONE** |
| 5 | `apps/marketdata` — token sync, feed, socket pool | **DONE** — 11 sync + 14 shard + 10 pool + 6 login |
| 6 | Dashboard: desk books, per-leg greeks, net delta, the D2 diff | **NEXT** |
| 7 | Live switch: allowlist + XTS tag registration runbook | blocked, see below |

## Environment (BHEL paper, 2026-07-27)

MongoDB **8.2.12** in docker as container `algomaker-mongo`, single-node replica set `rs0`,
bound to 127.0.0.1 only. A replica set is required, not optional: `xtsOrder.js:314` uses change
streams, which standalone mongod does not support. Verified end to end — driver 3.7.3 talks to
server 8.2 and a change-stream insert event was observed.

The old `mongo` container was stopped, not removed; its volume is intact.

## Live routing is BLOCKED for stock options

`xtsOrder.js:104` gates order size on `maxOrderLots[index_name]`, where `index_name` comes from
`tradingsymbol.match(/^\D*/)`. That table (`xtsOrder.js:15-21`) holds only the 5 index names, so
for `BHEL` the lookup is `undefined`: `orderQuantity <= undefined` is false, and control falls to
`tranches(orderQuantity, undefined)`. Stock options cannot route live until that table has
per-symbol freeze quantities. **Paper is unaffected**, so D3's sequence is not blocked.

## BHEL — first paper symbol

Seeded from the operator sheet. Verified against the live exchange dump:
- **Lot size 2625.** Shorts of 13125 are 5 lots; the 39375 wings are 15 lots.
- **Strike step 2.5, not 5.** ATM at spot 417 is **417.5**. Every strike on the sheet is a
  multiple of 5, so a configured step would have been wrong and the roll ladder would have
  skipped half the listed strikes. This is why the step is inferred.
- **Expiry is the AUGUST series** (2026-08-25), derived rather than assumed — see `seed.ts`.
- Structure: 3 short strikes each side against one long wing sized to the whole short quantity,
  so net contract quantity per side is zero. Delta/gamma-managed, not directional.
- Book greeks at spot 417: net delta **-3316**, gamma **-347**, vega **-14633**,
  theta **+7660/day**.

## Feed sizing

Kite caps ~**900 tokens per socket**, so `KiteFeedPool` opens sockets as demand grows and shards
tokens with `TokenSharder`. Assignment is **sticky**: a token never moves socket while it is still
wanted. The naive alternative — sort and deal out in chunks — reshuffles every token after an
insertion point, and since a Python client re-declares on every tick that would mean permanent
churn on a live feed. A 10-stock desk (~4500 tokens) sizes to 5 sockets.

## Deliberately NOT in scope

- `apps/runner` and the intraday strategy migration (D7).
- Any trading logic, sizing policy, or delta target on the algomaker side (D1).
- Backtesting. Declined by the owner 2026-07-25 and unchanged.

## Notes carried in

- `ATR_BAND_NIFTY`'s port defect (two-phase band + option-token exit bug) is **parked** with the
  rest of the intraday work. Its golden test stays `{ todo }` and failing-by-design.
- Plaintext optionbhai credentials remain in 3 `server/slive/candlestrategy*.js` files. Operator
  rotation, unrelated to this build, still open.
