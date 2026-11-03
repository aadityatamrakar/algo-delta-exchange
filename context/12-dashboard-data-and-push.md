# The Dashboard: where its numbers come from, and how they arrive

*Written **2026-07-28**, describing the desk bridge (`apps/`, `packages/`) as it stands on branch
`overhaul/foundation` at `cc7f6933`. Every claim below was re-verified against the code on the day
it was written; `file:line` citations are given so it can be re-checked rather than trusted.*

> **This document is about the NEW system.** Documents 01–11 in this directory describe the legacy
> LoopBack platform under `server/` and `client_wc/`, which was retired by the 2026-07-27 cutover
> (`memory/desk-bridge-new-system.md`). Nothing here contradicts them; they simply describe a
> different program.

---

## 1. Three panels, three collections, and the bug that came of it

Until 2026-07-28 the dashboard's three data panels each read a different Mongo collection, and a
**hosted** strategy — one supervised by `desk-runner` rather than driven by the Python desk — only
ever wrote to one of them.

| Panel | Read from | Written by | Result for a hosted tag |
|---|---|---|---|
| P&L cards | `desk-decisions` | `/v1/desk/submit` | worked |
| Net positions | `desk-books` | the Python-desk endpoints only | **always empty** |
| Order log | `desk-order-events` | the LIVE gateway, plus refusals | **empty in paper** |

So a strategy holding six legs rendered *"P&L reports 6 open legs for this tag but none are recorded
in a book — the desk and the bridge disagree"*, and the Positions page said "Nothing is open" under a
screenful of P&L pills. The UI was correctly alarming on a state that is **normal for every hosted
tag, all session** — which is how an operator learns to ignore banners. Fixed in `0f97cb6a`.

### Who actually writes `desk-books`

The single writer is `DeskStore.saveBook` (`apps/api/src/store.ts:177-183`), and it has exactly two
callers:

- `BridgeService.applyDecision` (`apps/api/src/service.ts:512`), reached by **`POST /v1/desk/actions`**
  (`apps/api/src/routes/desk.ts:105`) — the Python desk's decision endpoint;
- `seedBook` (`apps/api/src/seed.ts:109`), reached by `POST /v1/desk/seed` (`routes/desk.ts:157`).

**CORRECTION, and it is worth knowing because the code says otherwise in five places.** The commit
message of `0f97cb6a` and the comments at `apps/api/src/rollup.ts:96`, `apps/web/src/api.ts:707`,
`apps/web/src/pages.tsx:322` and `apps/web/src/strategies.tsx:1144` all say `desk-books` is written
by the Python desk's **`declare`**. It is not. `POST /v1/desk/declare` (`routes/desk.ts:140-146` →
`service.ts:1222`) writes **`desk-declarations`** via `store.saveDeclaration` (`store.ts:219`) — that
is the desk stating what it *believes* it holds, which is the input to `/v1/desk/diff`, not a book.
The substantive point those comments make is right (a hosted strategy never produces a
`desk-books` row); only the endpoint they name is wrong.

Hosted strategies instead **journal their fills** to `desk-decisions` via `SubmitService.#writeJournal`
(`apps/api/src/submit.ts:1001`, `PNL_JOURNAL = COLLECTIONS.decisions` at `submit.ts:108`), reached by
`POST /v1/desk/submit` (`apps/api/src/routes/submit.ts:118`), which the runner calls at
`apps/runner/src/order-gateway.ts:794`. They hold their position internally, in the runner's own
ledger. Nothing about that is a defect — it is the design.

### Positions now ride on the P&L row

`computeWindowPnl` (`apps/api/src/rollup.ts:174`) was already netting every leg out of the same fills
it derives the P&L number from, on every 15 s tick; `rowFor` kept the **count** and threw the list
away. The list is now carried:

```
StrategyPnl.legs      apps/api/src/rollup.ts:100     built at rollup.ts:210-246
PnlRow.legs           apps/api/src/pnl-jobs.ts:105   populated at pnl-jobs.ts:280
```

`MarkedLeg` (`rollup.ts:113-146`) is the per-contract shape:

| Field | Meaning |
|---|---|
| `tradingsymbol` | the contract |
| `qty` | **signed** — negative is short, `0` is a closed round trip |
| `avgCost` | average cost of the open position |
| `mark` | LTP. **`null`, never `0`**, when the feed could not price it, and for a closed contract |
| `unrealised`, `mtm` | `null` on the same terms |
| `realised` | booked on this contract inside the window, gross of costs |
| `buyQty` / `buyValue` / `sellQty` / `sellValue` | the two sides, as **cash traded** (Σ price × qty), never averages |

`qty === buyQty - sellQty` always holds — a position book whose net does not reconcile against its
own two sides cannot be checked by eye, and this is the table an operator uses to confirm a strategy
did what they think it did. There is no `side` field: side is the sign of `qty`, and the per-side
average price is recovered in the web as `buyValue / buyQty` (`apps/web/src/strategies.tsx:1177`) —
the total is not recoverable from an average, so the API sends the total.

**The path, end to end:**

```
GET /v1/desk/pnl?mode=          routes/pnl.ts:28
  -> livePnl                    pnl-jobs.ts:182
  -> PnlStore.loadFills         pnlstore.ts:187   (desk-decisions ONLY)
  -> rowFor -> computeWindowPnl rollup.ts:174
  -> PnlRow { openLegs, legs }
```

Two consumers, both off that one response:

- the per-strategy page — `usePoll(() => api.pnl(mode), 10_000)` at `apps/web/src/strategies.tsx:1237`,
  legs at `:1245`, rendered by `legColumns` (`:1264`) / `legRows` (`:1407`);
- the consolidated `OpenLegs` card on the books page — `apps/web/src/pnl.tsx:261`, mounted at
  `apps/web/src/pages.tsx:326`, **live-mode only**, filtering `qty !== 0`.

The count and the table therefore cannot disagree, and the page makes **no second request** — this
replaced a fan-out of one request per book every 6 s. `api.books(mode)` (`apps/web/src/api.ts:890` →
`GET /v1/desk/books`, `routes/desk.ts:825`) still exists and still renders the books the bridge
built from `/v1/desk/actions` and `/v1/desk/seed`; it is simply no longer the source for per-tag
positions.

### Orders: two collections, merged per mode

- **`desk-paper-trade`** is written by `PaperRail.route` (`apps/api/src/rail.ts:186`, insert at
  `:188`, stamped `mode: 'paper'`). Both the Python path (`service.ts:445`, `:459`) and the hosted
  `/v1/desk/submit` path go through that one method, so it is the complete record of paper fills —
  price and timestamp included. Nothing read it until `0f97cb6a`.
- **`desk-order-events`** is the LIVE gateway's journal (`apps/order-gateway/src/journal.ts:70`,
  which holds its own copy of the collection name) **plus refusals from both rails**, appended via
  `DeskStore.journalBlocked` (`apps/api/src/store.ts:508`, which never throws) from `blockedEvents`
  (`apps/api/src/strategies.ts:250`) and `SubmitService.#journal` (`submit.ts:1033`).

Both order endpoints are now **mode-scoped on `detail.mode`** — `GET /v1/desk/orders`
(`service.ts:1262-1263`) and `GET /v1/desk/reports/orders` (`pnlstore.ts:441-442`) — and in PAPER
each merges that rail's refusals with the `desk-paper-trade` fills, normalised by `paperFillEvent`
(`rail.ts:124`; merge at `pnlstore.ts:452-467` and `service.ts:1273-1282`). Gateway rows carry no
`detail.mode` and are live by construction.

> **The trap that scoping exposed.** `blockedEvents` never stamped *which rail* it refused. Once the
> log was filtered on `detail.mode`, an unstamped paper refusal would have surfaced under LIVE — the
> same class of defect in a new place. Stamped at the writer (`strategies.ts:283`,
> `submit.ts:1043`), not at the reader.

---

## 2. Websocket push

Phase 1 shipped `90923d3b`, merged `2f96c79c`. Phase 2 — the in-memory `LiveBook` — is described in
§2.1 below. Design doc: `docs/superpowers/specs/2026-07-28-websocket-push-design.md`.

### The endpoint

`GET /v1/desk/stream` on **desk-api's existing :8790** — `STREAM_PATH` at `apps/api/src/stream.ts:42`,
`ws` with `noServer: true` at `stream.ts:173`, hooked to the HTTP server's `upgrade` event at
`apps/api/src/server.ts:72-80` with the handler at `server.ts:101-132`.

**No new port, and no new auth mechanism.** A websocket handshake *is* an HTTP request, so the
httpOnly `SameSite=Strict` session cookie rides along and the same `AuthGate` instance that guards
every REST route is called at `server.ts:121`. There is additionally an explicit Origin allowlist
check on the upgrade (`server.ts:115-119`) because browsers do not CORS-check websockets. Refusals
are written as real HTTP status lines rather than a reset socket (`stream.ts:326-338`): 404 for a
non-stream path, 401 unauthenticated, 403 bad origin, 503 over the 50-client cap (`stream.ts:176`,
`:212-216`).

> **Undocumented door, verified 2026-07-28:** the gate falls back to bearer matching
> (`apps/api/src/authsvc.ts:213`) and `upgrade()` does **not** check `principal.kind`, so a holder of
> `DESK_API_TOKEN` can open the stream. A browser cannot reach it that way — `WebSocket` cannot set
> an `Authorization` header — and the socket is read-only and unscoped by principal
> (`stream.ts:206-210`), so the exposure is a machine client reading order events. It is not tested
> and appears to be a consequence rather than a decision.

### Per-mode subscription

One socket, one mode, replace-not-accumulate: `#clients: Map<WebSocket, DeskMode | null>`
(`stream.ts:162`). A new socket starts at `null` — **subscribed to nothing** (`stream.ts:219`) — and
only `{type:'subscribe', mode}` is honoured (`stream.ts:278-284`); every other inbound frame,
malformed JSON included, is dropped. Fan-out filters per socket at `stream.ts:288-295`. The client
does not re-subscribe when the operator flips PAPER/LIVE: `mode` is a dependency of the
`useDeskStream` effect (`apps/web/src/stream.tsx:236`), so the socket is torn down and rebuilt.

Three frame types, and that is all (`StreamFrame`, `stream.ts:78-82`):
`{type:'subscribed', mode}`, `{type:'heartbeat', ts}`, `{type:'order', mode, event}`.

### It is a nudge — on the client

**Stated precisely, because the shorthand is misleading.** The wire frame *does* carry a populated
order event — `StreamOrderEvent` (`stream.ts:58-75`) has `clientOrderId`, `phase`, `ok`, `tag`,
`tradingsymbol`, `ts`, `side`, `filledQty`, `avgPrice`, `status`, `error`, `detail`. What makes it a
nudge is that **nothing renders it**. Each frame increments `DeskStreamState.nudge`
(`apps/web/src/stream.tsx:94-97`, `:178`), `useStreamedPoll` carries that counter in its poll
dependencies so a frame forces an immediate REST re-fetch (`stream.tsx:261-269`), and the rows on
screen come only from `api.orders(...)` (`apps/web/src/pages.tsx:420-421`). `state.last` is exported
and has **zero readers** anywhere in `apps/web/src`.

The principle is at `apps/web/src/stream.tsx:12-17` — *"the socket says WHEN; REST says WHAT"* — and
asserted by `apps/web/test/stream.test.tsx:212`. Two producers of the rows on screen would be two
shapes to drift; this way a dropped frame costs latency, never correctness.

### Where the events come from

- **Paper fills: in-process.** `PaperRail` takes an emit callback and fires it after the durable
  insert (`rail.ts:201-208`), wired at `apps/api/src/main.ts:266` and, for the submit route's own
  rails, at `apps/api/src/routes/submit.ts:31-34`. Wrapped in try/catch, and `DeskStream.publish`
  itself never throws (`stream.ts:245-258`), so a failed push cannot fail a fill.
- **Live fills: one POST.** `desk-gateway` → `POST /v1/desk/stream/notify` (`apps/api/src/routes/stream.ts:31`,
  handler `:38-73`), **machine principal only** (403 for a session cookie, `routes/stream.ts:43-46`)
  and **live only** (400 for `mode: 'paper'`, `:53-60`). The caller is
  `apps/order-gateway/src/notify.ts:90-98`, invoked per journalled event at
  `apps/order-gateway/src/journal.ts:146-148`.

  **The notify cannot fail an order**, which is the property that file exists for: it returns void
  so the order path has nothing to await, carries its own 2 s abort (`notify.ts:67`, `:85-89`),
  swallows every failure including a synchronous throw from `fetch`, throttles its logging to once a
  minute (`notify.ts:50`, `:74-81`), and no-ops on an empty token (`:61-64`). `OrderJournal.record`
  wraps the call again outside the write's own try/catch, so a notify that threw can never be
  reported as "journal write failed" for a row that was written perfectly.

**This is a change-stream replacement, and deliberately so.** Production Mongo is a standalone; a
change stream would not work there (see `docs/DEPLOYMENT.md` §3). Nothing on this path may be
redesigned to depend on one.

### Degradation is visible, not silent

| | |
|---|---|
| Poll while the socket is up | 60 s — `LIVE_POLL_MS`, `apps/web/src/stream.tsx:48` |
| Poll while it is down | **10 s** — `FALLBACK_POLL_MS`, `stream.tsx:38`; selected at `:265` |
| On screen when down | "Live feed down — updating every 10s" — `LiveFeedNotice`, `stream.tsx:281-290`, rendered at `pages.tsx:522` |
| Reconnect | exponential backoff 1 s → 15 s, `stream.tsx:54-55`, `:122-130` |
| Staleness watchdog | 45 s without any frame closes the socket, `STALE_MS` at `stream.tsx:51`, checked every 5 s at `:206-216` |
| Heartbeat | `DESK_STREAM_HEARTBEAT_MS`, default **15000** (`stream.ts:185-190`); `0` disables it; sent to every open socket including unsubscribed ones (`stream.ts:297-306`) |

`streamUrl()` (`stream.tsx:85-89`) is `API_BASE` with `http`→`ws`, and `API_BASE`
(`apps/web/src/api.ts:252-254, 263`) is `VITE_DESK_API` or
`${window.location.protocol}//${window.location.hostname}:8790`. It derives from **the API base the
REST calls already use**, not from the page origin — which is why the socket cannot end up knocking
on the static file server's door.

### What is NOT built

- **Nothing on the web renders a pushed P&L row.** Phase 2 below produces `{type:'pnl'}` frames;
  `apps/web/src/stream.tsx` types them, lets them feed the staleness watchdog, and **drops them**.
  Rendering them needs a coalescing story first — see §2.1.
- **Only the Orders page is streamed — **stale, 2026-08-16: the Orders page was removed**; the order-frame stream now serves the per-strategy log (strategies.tsx) and the Status page's failures section.** P&L (`apps/web/src/pnl.tsx:164`), books and positions
  (`pages.tsx:107`, `:109`, `:305`) are still flat 10 s polls with no socket and no indicator.

---

## 2.1 Phase 2 — the in-memory `LiveBook`

`apps/api/src/livebook.ts`. This is what removed the performance complaint the design doc opens
with: `/v1/desk/pnl` no longer scans `desk-decisions` at all.

### What it replaced

| | Before | After (book loaded) |
|---|---|---|
| `GET /v1/desk/pnl`, per call | 1 × 30-day scan of `desk-decisions` + 1 × `desk-strategies` | **0** scans + 1 × `desk-strategies` |
| 15 s snapshot tick (`snapshotOnce`) | 2 × 30-day scan (one per mode) | **0** |
| Steady-state scans of `desk-decisions` | ∝ tabs × poll rate | **1 per 60 s, total** — the reconcile |

The registry read is deliberately NOT cached: a strategy registered a moment ago must not be
invisible on the page someone opened to check it. The 30-day scan is what this class exists to
remove, not that.

### The three inputs

- **Boot** — one `loadFills` for BOTH modes, netted by the same `buildPositions` the REST path uses
  (`LiveBook.start` → `reconcile`). `ready` is false until it lands, and `pnlFor`
  (`pnl-jobs.ts`) falls back to `livePnl` while it is. An empty in-memory book served as "no
  positions" would be the same defect as a confident ₹0 for an unmarked leg.
- **A fill** — `onJournal`, called by the three writers of `desk-decisions`: `applyDecision`
  (`service.ts`, after the `updateOne` that promotes `routedFills`), `flattenTag` (same), and
  `SubmitService.#writeJournal`. Synchronous, void, swallows everything — the same contract
  `PaperRail`'s emit holds, so a cache update can never fail an order.
- **A tick** — `onTick(token)`, wired to `md.tick` in `main.ts` beside `QuoteCache.update`.

### The held-set check is load-bearing

`onTick`'s first statement is `#heldByToken.get(token)`, and it **returns** when the token is not
held. The cadence is unthrottled by design; it is affordable only because ~26 held legs out of ~112
subscribed tokens bound the recompute rate at ~100/sec of in-memory arithmetic. Removing that check
would put thousands of recomputes a second into the process that also routes orders.
`stats.ticks` vs `stats.recomputes` is the bound, asserted in `apps/api/test/livebook.test.ts`
rather than assumed — and verified by mutation (weakening the check fails the test).

Two further short-circuits, both before the arithmetic: a **closed** leg (qty 0) is never indexed,
and a rail with **no subscribers** does no work at all, so a bridge with no dashboard attached does
exactly what it did before this class existed.

### The reconcile

Every 60 s (`DESK_BOOK_RECONCILE_MS`), the journal is re-read and compared leg by leg — both sides
netted by `buildPositions`, so the question asked is "would these produce the same positions table?".
Any difference is logged as **`LiveBook DIVERGED from the journal`** naming every leg, and the
journal's answer is **always** adopted (which is also what slides the 30-day lookback at IST
midnight). A fill landing mid-read is detected by a generation counter and the round is **skipped**,
not reported as drift — an alarm that fires on a normal Tuesday is one an operator learns to ignore.
A read that fails keeps the book it already has: "no positions" is a worse answer than a minute of
staleness.

### The arithmetic is not duplicated

`livePnl` was split at the point the fills are in hand; both it and `LiveBook.summary` call
**`pnlFromFills`**, and the tick path calls **`pnlRowFor`** — the same functions, not copies. The
carried-realised subtraction per leg (`439fa6f5`), the qty-0-only-if-it-traded-in-window rule,
`openLegs` counting qty != 0 only, and null-never-zero therefore cannot diverge between a pushed
figure and a polled one. `livebook.test.ts` asserts `deepEqual(book.summary(...), livePnl(...))`
over a carried book, which is the only claim worth making about the figures.

### The frame

`{type:'pnl', mode, row}` — `row` is exactly a `PnlRow`, field for field, so there is one vocabulary
for "what is this tag worth". It carries the whole row rather than being a nudge **because** the
cadence is unthrottled: turning ~100 frames/sec into ~100 REST re-fetches would cost far more than
the book saved. Order events stay nudges precisely because they are rare.

### Tests

`apps/api/test/stream.test.ts` (402 lines — upgrade refused without a cookie, paper never receives
live, unsubscribed receives nothing, non-subscribe frames ignored, null-not-zero on the wire, notify
refused for a session and for `mode:'paper'`, a throwing emit does not fail `PaperRail.route`,
`publish()` never throws); `apps/web/test/stream.test.tsx` (287 lines — the notice appears, clears
and returns; push triggers a re-fetch; an other-rail frame is ignored); `apps/order-gateway/test/notify.test.ts`
(225 lines — a throwing or hanging notify still journals and does not delay).

Not covered: the machine-token upgrade path, the 50-client 503 cap, and the heartbeat frame itself
(heartbeats are disabled in the API tests, `stream.test.ts:57`).

---

## 3. Layout

Design doc: `docs/superpowers/specs/2026-07-28-strategy-page-layout-design.md`. Shipped `2613930c`
and `fd42f96a`; responsive work in `4eb85002` and `660434ba`.

### The strategy page

A hand-written CSS grid in `apps/web/src/comfort.css:180-238`. Below 1200px it is one column;
at **`min-width: 1200px`** it becomes `minmax(0, 1fr) minmax(0, 1fr)` — **50/50** — with:

```
[ Net positions ] [ Order log        ]
[ Intraday P&L  ] [  spans both rows ]
```

The design doc proposed 58/42 on the theory that the position book carries more columns; in practice
the order log's Status column was the one being squeezed — a refusal reason is variable-length and
even "COMPLETE" was clipping — and the operator called it even. **`comfort.css` is authoritative
where it and the doc disagree**; the doc now says so.

Two non-decorative details:

- `minmax(0, …)` on both tracks, and `min-width: 0` on the grid and on every child. A grid item's
  default minimum is its content, and each `Table` declares a min-width summed from its columns — so
  without this the widest table pushes its column, then the grid, then the body, and the whole page
  including the navbar scrolls sideways. Pinned to zero, the overflow stays inside each table's own
  scroll container.
- `align-items: start`, so a long order log does not stretch the chart card to its height and leave
  a plot floating in an empty panel.

**DOM order is positions → order log → chart**, which is the narrow-viewport order; the desktop
arrangement comes from explicit `grid-column`/`grid-row` placement, not from reordering the markup.
So a screen reader, which follows the DOM, gets the order that was actually chosen rather than the
one that falls out of reading down the columns.

### One breakpoint scale, app-wide

`apps/web/src/responsive.css`, kept separate from `comfort.css` on purpose: that file is about
**colour**, this one is about **width**. The scale is documented in its header and used everywhere:

| | |
|---|---|
| ≥ 1200px | two-column panel layouts (owned by the strategy page) |
| ≥ 1024px | navbar is one row — `WIDE_NAV`, `apps/web/src/App.tsx:51` |
| < 1024px | the seven links move into a drawer behind a Menu button. Measured, not rounded: the eight controls need ~1140px |
| ≤ 719px | phone — `PHONE`, `apps/web/src/shell.tsx:210`. Tighter padding, 44px touch targets, full-width dialogs |
| ≤ 559px | dialog footers stack `column-reverse` |
| ≤ 479px | the word "Showing" beside the PAPER/LIVE switch goes |

Three properties of that file worth not breaking:

- **Every rule is unlayered.** astryx ships its stylesheet inside `@layer astryx-base`, so unlayered
  declarations beat it regardless of specificity. There is no `!important` anywhere in the file and
  none should be added. The `.astryx-*` hooks it targets are the design system's documented consumer
  hooks and carry no shipped styles of their own.
- **Nothing in it touches colour** — not one hex value, not one `--color-*` override — so both
  themes keep working by construction.
- **The small-screen rules are `max-width` overrides**, so a mistake degrades the phone and never
  the desk.

**The PAPER/LIVE switch is in the bar at every width.** Burying the control that decides which book
you are looking at behind a hamburger is a safety decision, not a layout one; only the word
"Showing" in front of it is ever dropped.

### Phones get cards, not a table

The strategies page swaps layouts rather than reflowing one: `const phone = useMedia(PHONE)`
(`apps/web/src/strategies.tsx:884`) selects `StrategyCard` (`:822`) or the table, and only one of the
two is ever in the document. The row's actions call the same handler either way (`:1059`), so a card
and a row cannot come apart.

`apps/web/test/responsive.test.tsx` covers this suite.

---

## 4. Collection map, as of today

Central constants: `COLLECTIONS` at `apps/api/src/store.ts:87`.

| Collection | Written by |
|---|---|
| `desk-decisions` | `applyDecision` (`store.ts:203`) **and** hosted `/v1/desk/submit` (`submit.ts:1001`). The fill journal; P&L, positions and flatten all reconstruct from it |
| `desk-books` | `POST /v1/desk/actions` and `POST /v1/desk/seed` only (`store.ts:177`) |
| `desk-declarations` | `POST /v1/desk/declare` (`store.ts:219`) |
| `desk-paper-trade` | `PaperRail.route` (`rail.ts:188`) |
| `desk-order-events` | the live gateway (`journal.ts:70`) + refusals from both rails (`store.ts:508`) |
| `desk-gateway-orders` | the durable order queue the gateway claims from |
| `desk-fills` | the order gateway (`service.ts:1296`; deliberately not in `COLLECTIONS`, see `service.ts:1288`) |
| `desk-submissions` | `submit.ts:92` |
| `desk-pnl-snapshots`, `desk-daily-reports` | `pnlstore.ts:38-39` |
| `desk-strategies`, `desk-safety` | the registry and the kill switch |
| `desk-users`, `desk-sessions` | `authstore.ts:27-28` |
| `desk-brokers` | `brokerstore.ts:19` — sealed with `DESK_MASTER_KEY` |
| `desk-marks` | persisted marks, read at `main.ts:165` |
| `positional` | **legacy, and reachable but not reached.** It is `LiveRail`'s collection when its executor is `legacy-positional` (`rail.ts:248-252`) — a deprecated option kept only so an in-flight cutover can be pointed back for one session. Both construction sites (`main.ts:267`, `routes/submit.ts:79`) take the `desk-gateway` default, so nothing writes it today. **Never run `xtsOrder.js` alongside the gateway: both would place every order.** |

---

## 5. Where to read next

| | |
|---|---|
| `13-development-workflow.md` | how work gets from an idea to the server, and the two hazards that bit today |
| `../docs/DEPLOYMENT.md` | the production host, the deploy script, and the runner's square-off-on-SIGTERM |
| `../docs/PYTHON-DESK.md` | the `/v1/desk/actions` ↔ `declare` ↔ `diff` contract the Python desk speaks |
| `../docs/superpowers/specs/2026-07-28-*` | the three design docs behind today's work |
| `../memory/desk-bridge-new-system.md` | the distilled facts about the cutover |
