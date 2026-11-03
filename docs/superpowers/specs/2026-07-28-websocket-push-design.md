# Websocket push: fills first, then a live book

**Date:** 2026-07-28
**Status:** **Phase 1 SHIPPED** (`90923d3b`, merged `2f96c79c`, 2026-07-28).
**Phase 2 — the in-memory LiveBook — BUILT** (`apps/api/src/livebook.ts`), including §Safety 3's
60 s reconcile and the three tick/LiveBook test bullets. `/v1/desk/pnl` no longer scans
`desk-decisions`: the only read left on that path is the strategy registry, and the 30-day scan now
happens once a minute in total rather than once per poll per tab.

**Two deviations from what is written below, both deliberate:**

1. **The `pnl` frame carries the whole row, not a nudge**, and nothing on the web renders it yet.
   At an unthrottled ~100 frames/sec a nudge would become ~100 REST re-fetches and cost more than
   the book saved. See `context/12-dashboard-data-and-push.md` §2.1.
2. **§Safety 1 still says the fallback poll is 10 s and the live poll 60 s.** `LIVE_POLL_MS` is
   **15 s** as of `e8b46815`, deliberately: `connected` proves the socket, not the producer. Phase 2
   does not change that — a tick frame proves the mark producer, not the gateway's notify — so it
   stays 15 s.

See `context/12-dashboard-data-and-push.md` for what was actually built, including the parts that
are not in this document.
**Scope:** `apps/api`, `apps/order-gateway`, `apps/web`. Two phases.

## The problem, stated correctly

The complaint is "REST polling is slow for an algo trading app". The
transport is not the expensive part, and swapping it without fixing what is
would make things worse.

Every `/v1/desk/pnl` call runs `PnlStore.loadFills()` over a **30-day
window** of `desk-decisions`, plus `listStrategies()`, then rebuilds every
strategy's position from raw fills (`pnl-jobs.ts:182-207`). The browser
polls that every 10s. With N tabs open that is N 30-day scans every 10
seconds.

Putting the same computation behind a socket and pushing at 1s multiplies
that load by ten and barely improves the numbers. **The fix is to stop
recomputing from Mongo, not to poll it faster.** The socket is what makes
the result visible; the in-memory book is what makes it cheap.

## What already exists

- `desk-marketdata` runs a websocket bus on `:8791`. `desk-api` and
  `desk-runner` are already clients (`apps/api/src/main.ts:134`). Ticks
  arrive in `desk-api` in real time today — they simply never reach a
  browser.
- Paper fills are journalled **inside `desk-api`** (`submit.ts`,
  `PaperRail.route`). The API knows about a paper fill at the moment of the
  write. No database watching is needed for them.
- The session is an **httpOnly `SameSite=Strict` cookie**.

## Constraint: no change streams

Production Mongo is a **standalone, not a replica set** (verified
2026-07-28). Change streams require an oplog and are therefore unavailable.

Converting to a single-node replica set was considered and rejected: it is
a live-database migration on a box whose kernel is already pinned at 6.8
because Mongo will not start on 6.19+. The risk is out of proportion to
this feature. **No part of this design may depend on change streams.**

## Transport

One endpoint: `GET /v1/desk/stream` on `desk-api`'s existing `:8790`,
upgraded to a websocket. nginx proxies the upgrade.

It lives in `desk-api` because that process already owns the book, the
marks and the auth gate. A separate process would need its own copy of all
three, and the copy that drifts is the one that shows a position nobody
holds.

**Auth is the existing cookie.** A websocket handshake IS an HTTP request,
so the browser attaches the session cookie automatically and the upgrade is
validated by the same gate as every other route. No token in a query
string — query strings land in nginx access logs.

Client subscribes per mode. The server never pushes a mode the client did
not ask for; a paper tab must not receive live figures.

## Phase 1 — fills and order events

Push order events and fills as they happen.

- **Paper:** in-process. Emit at the point `submit.ts` / `PaperRail`
  journals. No new dependency.
- **Live:** `desk-gateway` notifies `desk-api` when it journals a fill or
  an order event. One new inter-process call.

The notify is **best-effort and must never block or fail an order**. The
gateway's job is to place orders; a dashboard that missed an update is an
inconvenience, a gateway that stalled on a notify is an outage. Wrap it the
way `OrderJournal.record` and `journalBlocked` already are — swallow the
error, log it, carry on.

## Phase 2 — the live book

*Built as `apps/api/src/livebook.ts`, with ONE structural difference from the sentence below: it is
**one** `LiveBook` holding **both** modes, keyed `tag|mode`, rather than one per mode. Two objects
would mean two boot reads, two reconciles and two copies of the token index for a desk whose ticks
arrive on one bus — and the per-mode isolation the design actually cares about is at the **push**
(a paper tab must never see a live figure), which `DeskStream.#send` already enforces per socket and
`livebook.test.ts` asserts.*

An in-memory `LiveBook` per mode, in `desk-api`:

- **At boot:** load fills once, net into positions (the existing
  `buildPositions`).
- **On a fill:** mutate the book. Rare, event-driven.
- **On a tick:** if the instrument is one we HOLD, re-mark and push.
  Otherwise ignore.

That last clause is what makes the agreed cadence affordable.

### Cadence: unthrottled, on every tick for a held instrument

Chosen deliberately over throttling. The reasoning, because the raw
sentence "unthrottled" sounds more expensive than it is:

Only instruments in an open position can change a P&L. The desk currently
holds ~26 open legs against ~112 subscribed tokens, so the recompute rate
is bounded by ticks on those 26 — on the order of 100/sec — and each
recompute is arithmetic over an in-memory position, not a database read.
Ticks on the rest of the chain are discarded before any work happens.

**This bound must be enforced in code, not assumed.** The tick handler
checks membership in the held set FIRST and returns. If that check is ever
removed, a full-chain subscription would put thousands of recomputes a
second into the process that also routes orders.

## Safety rules

These are the point of the design, not decoration.

### 1. Polling fallback, stated on screen

On disconnect the page reverts to today's REST polling and shows a "live
feed down — updating every 10s" indicator. Reconnects in the background and
clears the notice.

A polling UI fails loudly: the request errors and a banner appears. A
websocket fails **silently** — the socket dies, no error fires, and the
screen keeps showing the last numbers it received, which look live. On a
P&L display that is the same class of defect as rendering a confident zero
for an unmarked leg, which this codebase already goes to lengths to
prevent.

**Every REST endpoint stays exactly as it is.** They are the safety net,
not legacy to be removed once the socket works.

### 2. The socket is read-only

Orders continue over HTTP. The websocket never carries an order, a flatten,
or a kill-switch toggle. A failed HTTP request is a failure you can see and
retry; a message dropped into a dead socket is not.

### 3. `LiveBook` reconciles against Mongo, and says so when it drifts

Every 60s, rebuild from the journal and compare against the in-memory book.
Log loudly on any difference and adopt the journal's answer.

This is the worst failure available to this design: an in-memory book that
silently diverges shows a position that is not held, or hides one that is.
The reconcile is what makes the optimisation safe to run.

### 4. Null discipline survives the wire

An unmarked leg pushes `null`, never `0`. Every rule already documented in
`rollup.ts` and `pnl.tsx` applies identically to pushed payloads: an
unknown number is `null` on the wire and an em-dash on screen.

## Testing

- Upgrade without a valid session cookie is refused.
- A client subscribed to `paper` never receives a `live` payload.
- A tick for an instrument NOT held triggers no recompute and no push
  (the load bound, asserted rather than assumed).
- A tick for a held instrument pushes an updated mark.
- An unmarked leg is pushed as `null`, never `0`.
- A gateway notify that throws does not fail the order path.
- `LiveBook` reconcile detects an injected divergence and logs it.
- The client falls back to polling on close and shows the indicator.

## Out of scope

- Replacing REST. The endpoints remain, both as fallback and for machine
  clients.
- Pushing feed health, kill-switch state or registry changes. Those are low
  frequency and polling them is not the complaint.
- Any Mongo topology change.
