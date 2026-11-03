# Execution Layer & Resilience Design

> **Inherited from the NSE desk** (`/opt/algomaker`, copied 3 Nov 2026). It describes the machinery this repo
> shares with the NSE desk as it stood there, and is not maintained here. The process names (`desk-*`), ports
> (87xx), database (`algomaker`) and paths in it are the **live NSE desk's**: in this repo they are `dx-*`,
> 8890–8897 and `algomaker_dx`. Never run a command from this page. Links to other NSE documents point into
> the NSE repo and were not carried over.

*Covers three requirements added 2026-07-25: (a) robust/failsafe operation, (b) errors and
notifications surfaced in the web frontend, (c) pending-order **chase** execution and **sequenced
multi-leg baskets** for illiquid stock options, driven from strategy code.*

---

## Part 1 — Execution: chase and baskets

### The problem

Index options are liquid enough that a market order is fine, and the legacy system only ever sends
`MARKET` (or a `StopMarket` for stops). Stock options are not: wide spreads and thin books mean a
market order for a meaningful number of lots walks the book and pays badly. Running more lots on
stock options therefore needs **passive orders that get repriced until they fill** — a chase — and
multi-leg structures need **controlled sequencing** so a partial fill never leaves an unintended
naked position.

### 1.1 Chase — the critical safety property

A naive chase is *cancel the resting order, place a new one at a better price*. **That has a
double-fill race:** between your cancel request and its acknowledgement, the original order can
fill. If you have already sent the replacement, you end up with twice the intended position — the
worst possible outcome on a short options leg.

**Two rules, in priority order:**

1. **Prefer `modify`/`amend` over cancel+replace.** Both Zerodha and XTS support modifying a
   pending order's price. An amend is atomic at the exchange: the order either exists at the old
   price or the new one, never twice. Every `BrokerAdapter` must expose
   `modifyOrder(brokerOrderId, { price })` and the chase engine must use it whenever available.
2. **Where amend is unavailable, a cancel must be ACKNOWLEDGED before the replacement is sent** —
   and the replacement quantity must be recomputed from `remainingQty` at that moment, because the
   cancel-ack tells you how much actually filled. Never assume it filled zero.

### 1.2 Chase price ladder

Each attempt prices more aggressively, bounded by a hard cap:

| Step | Price for a BUY | Rationale |
|---|---|---|
| 0 | `bid` (join the book) | pay nothing away, may not fill |
| 1 | `mid` | meet in the middle |
| 2 | `ask` (take the touch) | cross the spread |
| 3… | `ask + n·tick` | walk up for size |
| final | `MARKET` — **only if `allowMarketFallback: true`** | guaranteed fill, unbounded price |

Governed by:

- `maxAttempts` — hard stop on repricing
- `attemptTimeoutMs` — how long to rest at each price before repricing
- `maxSlippage` — **absolute cap** expressed in points or % from the strategy's reference price.
  Breaching it aborts the chase rather than paying more. This is the single most important guard:
  without it, a chase in a fast market becomes an unbounded market order.
- `allowMarketFallback` — default **false**. Opt in per strategy.
- Partial fills: the chase continues on the **residual only**, and every reprice recomputes size
  from the broker's reported `filledQty`, never from local assumption.

### 1.3 Baskets — sequencing and partial-completion policy

A basket is an ordered set of legs with an explicit failure policy.

**Sequencing rule that matters:** for any structure with a protective leg, **the long/protective leg
must fill before the short leg is sent.** Selling first and then failing to buy the hedge leaves a
naked short — the exact accident this design exists to prevent. (It also matches broker margin
behaviour, which frequently requires the long leg to exist first.)

`legOrder` modes:

- `sequential` — leg *n+1* is sent only after leg *n* reaches a terminal fill. Safest; slowest.
- `parallel` — all legs at once. Fastest; acceptable only when legs are independent.
- `protective-first` — automatically partitions legs so every BUY precedes every SELL, then runs
  sequentially. **The default for spreads.**

`onPartial` policy when the basket cannot complete:

- `unwind` — reverse whatever filled, restoring flat. **Default for spreads**, because a
  half-executed spread has a different risk profile than intended.
- `keep` — retain fills and report. Reasonable for a strangle where each leg stands alone.
- `abort` — stop sending further legs, keep fills, do not unwind.

Plus `basketTimeoutMs` bounding the whole operation, and the guarantee that **unwind uses the same
chase machinery** — an emergency unwind must not itself become an unbounded market order, unless
`allowMarketFallback` is explicitly set for unwinds (which is usually the right choice, since being
flat matters more than price).

### 1.4 Strategy-facing API

Strategies express *intent*; the execution layer owns the mechanics. Chase policy is configuration,
so the same strategy runs market-style on indices and chase-style on stock options with no code
change:

```ts
await this.execute({
  legs: [
    { action: 'BUY',  instrument: farCE,  lots: 5 },   // protective leg
    { action: 'SELL', instrument: nearCE, lots: 5 },
  ],
  legOrder: 'protective-first',
  onPartial: 'unwind',
  chase: {
    maxAttempts: 6,
    attemptTimeoutMs: 1500,
    maxSlippage: { type: 'percent', value: 2 },
    allowMarketFallback: false,
  },
  basketTimeoutMs: 20_000,
  mode: 'live',
})
```

### 1.5 Order state machine

`PENDING_NEW → WORKING → (PARTIALLY_FILLED) → FILLED | CANCELLED | REJECTED | EXPIRED`,
with `AMENDING` as a transient state during a reprice.

Non-negotiable invariants:

- Every intent carries a **`clientOrderId`** generated before the WAL write, so a retry after a
  crash is recognised as the same order and cannot double-submit (idempotency).
- Terminal states are terminal. A late fill event on a `CANCELLED` order raises a reconciliation
  alert rather than silently mutating state.
- `filledQty` is only ever taken **from the broker**, never inferred locally.

---

## Part 2 — Robust and failsafe

Failure modes, each with a specific mitigation. This is the checklist the implementation is held to.

### Market data

| Failure | Mitigation |
|---|---|
| Socket open but **ticks stop flowing** (the dangerous one — looks healthy) | Per-token staleness watchdog. If the last tick for a subscribed token exceeds `maxTickAgeMs` during market hours → publish `FEED_STALE`, **block new entries**, keep managing existing positions. |
| Websocket disconnect | Exponential backoff reconnect, resubscribe from the registry, emit a gap event so strategies know they may have missed ticks. |
| Kite subscription cap exceeded | Registry enforces the cap, reports headroom, shards to a second connection. Refuses silent truncation. |
| Bad tick (zero/negative/absurd price) | Sanity filter at ingest; reject and count rather than propagate. A `0.05` fill artefact in the legacy system came from exactly this class of problem. |

### Broker and orders

| Failure | Mitigation |
|---|---|
| Session/token expiry mid-session | Gateway detects auth failure, re-authenticates, holds intents in a bounded queue, emits `BROKER_REAUTH`. Never drops an intent silently. |
| Duplicate submission on retry | `clientOrderId` idempotency, deduped at the gateway. |
| Order acknowledged but no fill callback | Reconciliation loop polls the broker order book every N seconds and repairs local state. |
| Position drift (local vs broker) | Periodic position reconciliation; mismatch raises `CRITICAL` and can trip the kill switch. |
| Rejected order | Typed reason surfaced to the strategy; margin rejections trip a circuit breaker rather than retrying in a loop. |

### Process and runtime

| Failure | Mitigation |
|---|---|
| Runner crash with an **open position** | WAL replay + broker position reconciliation on boot. The legacy system cannot do this: positions live in process memory, so a restart loses them (its own conventions note this explicitly). |
| One strategy throws | Per-strategy try/catch boundary; the strategy is quarantined and its neighbours keep running. Repeated throws → circuit breaker disables just that strategy. |
| One strategy blocks the event loop | Per-tick time budget with measurement; offenders logged and flagged. Heavy work must be off the tick path. |
| Cascading restart loop | pm2 `min_uptime` + `max_restarts`; `stop_exit_codes: [0]` so a clean 15:30 exit is not treated as a crash (already in `ecosystem.config.cjs`). |
| Timezone/clock drift | One IST time source in `packages/core`. `TZ=Asia/Kolkata` set per process. No `new Date()` arithmetic scattered through strategies. |

### Risk (the outermost safety net)

Enforced in `OrderRouter`, **before** the WAL write, so no strategy bug can bypass them:

- Global **kill switch** — halts all new intents immediately; management/exit orders still allowed.
- Max daily loss → flatten and stop.
- Max open lots per underlying and in aggregate.
- Max orders per minute (runaway-loop protection).
- Max notional per order.
- `mode: 'live'` requires an explicit allowlist of enabled strategies — so a misconfigured strategy
  cannot accidentally trade real money. This directly addresses the current situation where
  sim-vs-live depends on which daemon is running.

---

## Part 3 — Errors and notifications in the frontend

### Event model

Every module publishes typed events onto the bus:

```ts
type SystemEvent = {
  id: string
  ts: number                    // epoch ms, IST-rendered in the UI
  severity: 'debug' | 'info' | 'warn' | 'error' | 'critical'
  source: string                // 'marketdata' | 'order-gateway' | 'runner:indices' | strategy tag
  code: string                  // stable, greppable: 'FEED_STALE', 'ORDER_REJECTED', 'RISK_BREACH'
  message: string
  context?: Record<string, unknown>
  acknowledged?: boolean
}
```

Stable `code` values matter: they make events filterable, alertable and countable, which free-text
messages never are.

### Transport and storage

- Published on the bus → `apps/api` fans out to browsers over socket.io (already in use).
- Persisted to a **capped** MongoDB collection (audit, bounded growth) — off the hot path.
- `critical` also goes to Telegram via the existing `server/lib/notify.js` path, so a failure
  outside market hours or with no browser open still reaches a human.

### Dashboard surfaces

1. **System Health page** — per-module cards (marketdata, order-gateway, each runner, scheduler):
   status, last heartbeat, tick age, subscription count, error rate. Plus the **kill switch** and
   per-strategy enable/disable.
2. **Persistent notification bell** — unacknowledged `warn`+ with a count. Deliberately *not* a
   toast that vanishes; an unnoticed `FEED_STALE` is exactly the kind of thing that must stay
   visible until acknowledged.
3. **Event log** — filterable by severity, source, code, time; the debugging view.
4. **Per-strategy detail** — that strategy's events, open position, order history, today's P&L.
5. **Order blotter** — live order states including `WORKING`/`AMENDING`, so a chase is observable
   in real time. Watching a chase reprice is the fastest way to tell whether its policy is sane.

### Rules

- The browser is a **viewer**, never a participant in the order path. A closed dashboard must not
  change trading behaviour.
- No `eval`. The current `client_wc/js/services/socket.js:25,104` executes server-pushed strings —
  that pattern does not survive into the new frontend.
- Events are append-only; acknowledgement is a separate mutation.

---

## Implementation order

1. `packages/order-bus` — `OrderIntent` types, `clientOrderId`, WAL, `OrderRouter` risk checks.
2. `packages/execution` — chase + basket **state machines as pure logic**, unit-tested. No I/O, so
   every race and policy branch is testable without a broker.
3. `packages/brokers` — adapters with `modifyOrder` as a first-class method.
4. `apps/order-gateway` — wire it together; reconciliation loop.
5. Event model + System Health page.

Chase and basket logic is written **pure and tested first**, following the pattern already proven
in `atr-band-logic.js` / `orb-fut-logic.js`. Money is lost in the edge cases — partial fill during
a reprice, cancel-ack racing a fill, unwind failing mid-way — and those are only cheap to explore
in unit tests.
