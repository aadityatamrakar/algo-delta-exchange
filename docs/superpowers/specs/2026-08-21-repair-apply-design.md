# Repair Apply — executing a repair candidate from the payoff cockpit

**Date:** 2026-08-21
**Status:** Draft for review
**Repos touched:** algomaker (apps/web, apps/api, apps/marketdata, packages/payoff), sensibull-desk (Python — two small contract changes)

## 1. Summary

The payoff cockpit's Repair Builder shows scored repair candidates (`RepairPlan`
with typed `moves`) but deliberately places no orders — the operator re-keys the
legs through the Manual Order dialog. This spec adds an **Apply** button per
candidate card that executes the plan through the existing hardened order rail,
behind a preview/confirm modal that shows every order it will place, the
broker-verified margin change, and the hypothetical post-apply delta picture in
the same convention the Positions page displays.

This consciously amends the cockpit's founding constraint ("nothing here places
an order", stated in `apps/api/src/routes/payoff.ts:16`, `apps/web/src/payoff.tsx:28`
and the panel copy at `payoff.tsx:1827`). All three notices are rewritten to
describe the new gated path.

## 2. Scope

**In:**
- Apply button on each repair candidate card; **Verify margin button removed**
  (its check runs automatically inside the preflight).
- Preview/confirm **modal** (same dialog pattern as the leg editor) with order
  list, margin Δ, delta panel, warnings, Fast/Limit style toggle, and a live
  execution tracker after Confirm.
- Two new endpoints: `POST /v1/desk/repair/preflight`, `POST /v1/desk/repair/apply`
  (+ `GET /v1/desk/repair/apply/:applyId` for reconnect).
- A bridge-side `RepairApplyService` that sequences orders through the existing
  `SubmitService` (`apps/api/src/submit.ts`) — closes first, then opens.
- Top-5 depth retained by the marketdata feed and used both to **display** an
  estimated execution price and to **price** the orders (touch/mid), instead of
  LTP marks.
- Per-tag **supervisor hold** while a run executes.
- **Bot-managed handoff**: legs a repair opens are adopted by the Python driver
  *without* the `protected` stamp, so the bot's dials resume managing them.
- Symbol display formatting on cards and modal: `TCS 2340 PE` (Positions style)
  instead of raw `TCS26AUG2340PE`.

**Out (explicitly):**
- No automatic rollback of partially executed runs.
- No per-order style overrides (the Fast/Limit toggle applies to the whole run).
- No resume of an interrupted run across a desk-api restart (it halts safely).
- No new broker calls beyond the already-allowed Kite basket-margin endpoint;
  order placement rides the existing paper/live rails.
- No change to how repair candidates are generated (`packages/payoff` search).

## 3. UX

### 3.1 Candidate card (`PlanCard`, `apps/web/src/payoff.tsx:1531`)

- Buttons become **Load into overlay** · **Apply**. `Verify margin` and its
  plumbing (`verifyPlan`, `verifyRef` single-flight, `verify*` props) are removed.
- Move lines (`moveText`, `payoff.tsx:278`) render contracts via the shared
  formatter (§3.4): `Shift TCS 2440 PE → 2260`, `Close TCS 2280 PE`. The `#n`
  uniqueness suffix stays as the muted note it already is.
- Apply is disabled (with a title explaining why) when: another apply is running
  for this tag; the plan is the baseline / has `no-feasible-plan`; `lotSize` is
  unknown (0); or the mode's book is missing.

### 3.2 The modal — preview state

Opening the modal immediately fires `preflight`. It shows:

1. **Orders, fully expanded**, grouped into two waves labelled *"closes first"*
   and *"then opens"*. Each row: side chip (BUY/SELL), formatted contract, lots,
   estimated execution price (§5.2) with quote age, and the per-move source
   (`from: Shift 2440 PE → 2260`). A shift renders as its two orders.
2. **Margin Δ** — the broker basket figure (`VerifyMarginResponse.broker.total`,
   calibrated) minus current; the SPAN-lite `estimated` shown as fallback with a
   visible warning when Kite refused.
3. **Delta panel** — two columns (*now* → *after apply*), each showing **both
   variants** exactly as Positions does:
   - **All legs**: net Δ, and Δ0 as `price (±pct%)`
   - **Shorts only**: net Δ, and Δ0 as `price (±pct%)`
   Computed with the Positions engine (§5.3), so the *now* column matches the
   Positions tiles digit-for-digit.
4. **Warnings** — plan flags restated in words (`degrades-floor`,
   `bot-may-reshift` — the latter noted as applying only after the hold lifts),
   preflight warnings, and `dropped` moves.
5. **Style toggle**: **Fast** (default) / **Limit** (§6.3).

Confirm is disabled while preflight is in flight, when `dropped` is non-empty,
or when any open-wave order has no live quote. In **live** mode Confirm runs
through `withReauth` (`apps/web/src/auth.tsx:396`) with a full statement
("Apply PROFITABLE-BY-EXPIRY to TCS live book: buy to close 3 legs, shift 1 —
5 orders, margin Δ −1,83,427"); paper confirms directly.

### 3.3 The modal — execution state

After Confirm the same modal becomes a tracker: one status chip per order
(QUEUED → PLACED → FILLED / FAILED / AGED-OUT), fed by the existing dashboard
stream (`POST /v1/desk/stream/notify` events keyed by `clientOrderId`), with
`GET /v1/desk/repair/apply/:applyId` as the reconnect/poll fallback. Terminal
banner: **Done** (all filled) or **Halted** (§6.4) with an exact statement of
what executed and what did not. The modal cannot be dismissed accidentally
mid-run (explicit "Close — run continues server-side" affordance).

### 3.4 Shared contract formatter

Extract the Positions display convention into one helper (the web already has
`formatContract` — `apps/web/src/api.ts:2637` neighbourhood): underlying,
strike, type → `TCS 2340 PE`; expiry appended **only when it differs from the
book's expiry** (mixed-expiry safety). Cards, modal, and execution tracker all
use it.

## 4. API

Both endpoints live beside the existing repair routes in
`apps/api/src/routes/payoff.ts` and reuse its `assemble()` book loading.

### 4.1 `POST /v1/desk/repair/preflight`

Request: `{ tag: string, mode: DeskMode, moves: RepairMove[] }`

Response (fail-soft 200-with-warnings like the rest of the cockpit):

```ts
interface RepairPreflightResponse {
  tag: string; mode: DeskMode; asOf: number
  bookPrint: string              // fingerprint of the book the moves resolved against
  orders: PlannedOrder[]         // empty when nothing resolves
  dropped: string[]              // human-readable, one per unresolvable move
  margin: VerifyMarginResponse   // estimated + broker|null + warnings (runs automatically)
  delta: { current: DeltaPicture; after: DeltaPicture }
  holdActive: boolean            // an apply is already running for this tag
  warnings: string[]
}

interface PlannedOrder {
  wave: 'close' | 'open'
  moveIndex: number              // which move produced it; a shift produces two orders
  side: 'Buy' | 'Sell'
  instrument: { tradingsymbol: string; instrumentToken: number; lotSize: number; tickSize: number; exchange: string }
  strike: number; type: 'CE' | 'PE'; expiry: string
  lots: number
  reducesExposure: boolean       // true for the whole close wave
  mark: number | null            // per-share mid, for reference
  est: {
    price: number | null         // depth-walk VWAP for lots × lotSize (§5.2)
    coveredQty: number           // qty visible in top-5 on the relevant side
    exceedsDepth: boolean
    quoteAgeMs: number | null
  } | null
}

interface DeltaPicture { all: DeltaFigures; shortsOnly: DeltaFigures }
interface DeltaFigures {
  netDelta: number | null
  netGamma: number | null
  neutral: { price: number; pct: number } | null   // Δ0 = spot − netΔ/netΓ
}
```

`bookPrint` reuses the input-fingerprint scheme the snapshot dedupe already
computes (`routes/payoff.ts` `bookPrint`). Resolution is against the **current**
stored book, never the card's `asOf` snapshot; a move whose `legId` no longer
joins (the bot shifted it meanwhile) lands in `dropped`.

### 4.2 `POST /v1/desk/repair/apply`

Request: `{ tag, mode, moves, bookPrint, decisionId, style: 'fast' | 'limit', password?: string }`

- **409** `{ error: 'book-changed', reauthRequired?: false }` when the current
  book's print differs from `bookPrint` → the modal silently re-runs preflight
  and re-renders the preview.
- **403** `{ reauthRequired: true }` on live without a valid operator password
  (same shape as the existing reauth sites).
- Refused (200, `accepted: false`) when: a hold/run is already active for the
  tag, the kill switch blocks the open wave and the plan has one, the mode's
  live gate fails, or any move no longer resolves.
- Accepted: `{ accepted: true, applyId, orders: { clientOrderId, wave, tradingsymbol, lots, side }[] }`.

`applyId = decisionId`. Per-order `clientOrderId = repair:<decisionId>:<n>`
(n = order index) — deterministic, so a retried apply call dedupes order-by-order
in `desk-submissions` exactly like manual orders do.

### 4.3 `GET /v1/desk/repair/apply/:applyId`

Returns the run document (§6.1): state, per-order statuses, halt reason. Poll
fallback for the stream.

## 5. Preflight computation

### 5.1 Move → order resolution

One pure function (unit-testable, no I/O): `resolveOrders(book, moves, lotSize)`.

- `close {legId}` → join `legId` to the book leg; BUY (short leg) or SELL (long
  leg) its **full** qty; lots = |qty| / lotSize; wave `close`; `reducesExposure: true`.
- `shift {legId, toStrike}` → the leg's close order (wave `close`) **plus** an
  open order at `toStrike`, same type, same lots, same sign (wave `open`).
- `add` / `hedge` `{strike, type, qty}` → qty is signed **shares** (sign = side,
  per `packages/payoff/src/moves.ts:35`); lots = |qty| / lotSize; wave `open`;
  `reducesExposure` derived the manual-order way (`classifyExposure`,
  `apps/web/src/manual-order-plan.ts:207` logic, evaluated server-side).
- Contract identity (tradingsymbol, token, tickSize, exchange) comes from the
  same instrument lookup the chain endpoint uses.
- Non-integer lots, unknown contract, or `lotSize 0` → the move goes to `dropped`.

### 5.2 Depth-priced estimate

For each order, walk the relevant side of the book — **asks for a BUY, bids for
a SELL** — accumulating level qty until the order's contract qty is covered:
level-1 price if it covers, VWAP across levels otherwise. Past level 5:
`exceedsDepth: true` and the VWAP of what is visible. Quote older than the
cockpit's staleness dial → `est.price: null`, fall back to `mark`, add a warning.

### 5.3 Delta panel — the Positions engine, not Black-76

The user reads this panel against the Positions tiles, so it uses the **same
engine**: the bridge's `bookGreeks` (BS on cash spot, `apps/api/src/service.ts:1399`
path), the Δ0 formula from `bookTotals` (`apps/web/src/positions.ts:428`:
`spot − netΔ/netΓ`, null when netΓ is 0 or nothing priced), and the shorts-only
filter (`shortsOnlyGreeks`, `positions.ts:459`: legs with qty < 0 — longs are
the hedges).

Server-side: build the hypothetical leg set (current bridge legs, closes
removed, shifts moved, opens added, new legs marked at their chain mid), run the
same greeks pass over both the current and hypothetical sets, emit both
`DeltaPicture`s. The Black-76 cockpit greeks are **not** used here — the two
models must not be mixed in one panel (`apps/web/src/api.ts:80` note).

### 5.4 Margin

Exactly the existing `verifyMargin` flow (`routes/payoff.ts:1210`): SPAN-lite
estimate + the one allowed broker call (`POST /v1/md/margin-basket` via
`DESK_MD_URL`), calibrated by `brokerFigures`. Invoked automatically by
preflight; the standalone verify-margin route stays (other callers may exist)
but the button is gone.

## 6. Execution — `RepairApplyService` (apps/api)

### 6.1 Run document

New collection `desk-repair-applies`:
`{ _id: applyId, tag, mode, style, bookPrint, state: 'RUNNING' | 'DONE' | 'HALTED',
haltReason?, orders: [{ clientOrderId, wave, status, ... }], createdAt, updatedAt }`.
Unique `_id` doubles as the idempotency claim for the whole run. **One run per
tag**: starting refuses while another run for the tag is RUNNING.

On desk-api boot, any RUNNING run is marked `HALTED (restart)` and its hold
released — no cross-restart resume; the operator finishes by hand.

### 6.2 Sequencing

1. Write the run doc; set the supervisor hold (§7).
2. **Close wave**: submit every close-wave order in parallel through
   `SubmitService.submit` (each gets its own `desk-submissions` claim, rail
   routing, journal, book fold — identical to a manual order). All carry
   `reducesExposure: true`, so they pass the kill switch.
3. Watch fills via the existing order-events/fills journals until every close is
   FILLED (bounded by the gateway's order max age, 300s).
4. **Open wave**: submit the open-wave orders in parallel. `exactLots: true`
   (size exactly as planned, no liveLots override).
5. All filled → state DONE, release the hold.

### 6.3 Pricing and the Fast/Limit toggle

Every order goes to `SubmitService` as `orderType: 'LIMIT'` with an explicit
`limitPrice` computed by the service from the live quote at submit time — the
gateway and `marketable.ts` are untouched:

- **Fast**: the touch ± the existing marketable buffer (BUY: ask + buffer,
  SELL: bid − buffer) — crosses the spread immediately.
- **Limit**: the **mid** — for wide spreads; if unfilled after 15s the existing
  chaser (`order-chaser.ts`) steps it toward the market, so the run still
  completes instead of stalling.

Neither style sets `resting: true` — a resting fill never folds into the book
(known gap F12, `submit.ts:813`), which would break adoption. No quote at
submit time → the run halts before placing that order.

### 6.4 Failure = halt, never rollback

Any order that is REJECTED, FAILED, or ages out halts the run: in-flight orders
in the same wave are left to terminate (they are already at the broker), **no
later wave fires**, state becomes HALTED with the exact per-order ledger, and
the hold is released. The modal states plainly what executed and what did not;
the operator finishes via the Manual Order dialog. The bridge never re-opens or
un-closes a leg on its own.

## 7. Supervisor hold (cross-repo)

**Bridge side:** the hold lives in the run document (§6.1 — a tag's RUNNING run
*is* the hold), surfaced to Python as a new optional field on the positions
payload the supervisor already polls every tick
(`GET /v1/desk/positions?tag=&mode=`, `sensibull-desk .../live/desk/bridge.py:89`):

```jsonc
"repairHold": { "applyId": "...", "heldAt": 1755760000000, "untilMs": 1755760600000 }
```

`untilMs` = heldAt + 10 minutes, the TTL backstop: the bridge stops emitting the
field once the run leaves RUNNING **or** the TTL passes, whichever is first, so
a crashed apply can never freeze a book beyond 10 minutes.

**Python side (sensibull-desk):** at the top of its action pass the driver
checks `repairHold` on the positions payload it already fetched; while present
and fresh it **skips all candidate actions for that tag** (marking, greeks,
adoption of *filled* legs still run — only shift/close/resize/recenter decisions
pause). One guard clause + log line in `driver.py`.

## 8. Bot handoff (cross-repo)

Decision: **bot-managed** — legs a repair creates rejoin the bot's rules.

- **Bridge:** `SubmitRequestBody` gains optional `origin: 'manual' | 'repair'`
  (absent ⇒ manual). `#maintainBook` stamps it onto the bridge leg it folds, so
  the leg document in `desk-books` carries its origin.
- **Python:** `adopt_manual_legs` (`translate.py:1723` — the single place the
  `protected` stamp is applied) stamps `protected = True` **only when
  origin ≠ 'repair'**. Repair-origin legs adopt unprotected and the dials resume
  managing them on the next tick after the hold lifts.
- Consequence, stated in the modal when the plan carries `bot-may-reshift`: the
  bot may legitimately re-shift a just-applied leg once the hold releases — that
  badge exists precisely to warn about dials-vs-plan disagreement.
- Closes of existing bot legs need nothing new: the exit fold and Python's
  delta-fold reconciliation already handle qty reductions.

## 9. Marketdata: retain top-5 depth

The feed already subscribes in **full** mode; packets carry 5 levels × {price,
quantity} both sides, but the parser keeps only the best price
(`apps/marketdata/src/kite-feed.ts:34,322`). Change: widen the tick type to
`depth: { buy: {price, quantity}[]; sell: {price, quantity}[] }`, keep it in the
ticks cache, and expose it on the quote payloads the bridge already reads (the
leg-dialog quote shape `apps/web/src/api.ts:2168` gains an optional `depth`).
Consumers that ignore it are unaffected.

## 10. Gates

Unchanged and all inherited by riding `SubmitService` per order: the per-order
live allowlist (`liveAllowlistFromStrategies`, fails closed), the gateway's
independent re-check, the kill switch (close wave passes; a kill switch raised
mid-run halts the run at the open wave with a clear reason), and operator-password
reauth for live applies. Machine principals cannot call apply on a live book
(same rule as arming live).

## 11. Copy and guard amendments

- `routes/payoff.ts:16` header: from "nothing here places an order" to a précis
  of the preflight/apply gate chain.
- `payoff.tsx:28` header: same.
- Panel copy `payoff.tsx:1827`: from "A menu, not a decision…" to "Apply places
  these orders through the same rail as the Manual Order dialog, behind a
  preview and (live) the operator password."
- `docs/superpowers/plans/2026-08-19-desk-payoff-cockpit.md` Task 13's
  constraint is superseded by this spec (noted here, the old plan is history and
  stays untouched).

## 12. Testing

- **resolveOrders** (pure): sign→side, shares→lots, shift expands to two orders
  in the right waves, full-qty closes, legId join misses → dropped, lotSize 0,
  non-integer lots, mixed-expiry contract identity.
- **Delta panel**: hypothetical engine over a fixture book equals the Positions
  engine run on the post-state book (both variants, Δ0 nulls when netΓ 0 /
  nothing priced).
- **Depth walk**: level-1 cover, VWAP across levels, exceeds-depth flag, stale
  quote fallback.
- **Sequencing state machine** (fake SubmitService + journals): happy path;
  close REJECTED → opens never fire, state HALTED, hold released; age-out;
  kill-switch raised between waves; desk-api restart marks RUNNING → HALTED.
- **Idempotency**: re-posted apply with same decisionId dedupes per
  `clientOrderId`; 409 on changed bookPrint.
- **Web**: modal preview render from a canned preflight, Confirm disabled on
  dropped/stale, formatter output (`TCS 2340 PE`, expiry only when foreign),
  reauth statement content for live.
- **Python** (sensibull-desk): adoption respects origin ('repair' ⇒ not
  protected — extend `test_desk_manual_adopt.py` / `test_protected_legs.py`);
  driver skips its action pass while `repairHold` fresh, resumes after.

## 13. Deployment notes

- algomaker: desk-api restart **alone** mid-session is the safe unit (deploy
  hazards doc); marketdata restart for the depth change in a quiet window; web
  dist is untracked ⇒ build on the box.
- sensibull-desk: the supervisor does **not** pick up code edits while running —
  restart it and verify the new behaviour in Mongo/logs (variants lesson).
- Order of ship: marketdata depth → bridge endpoints + service + web (Apply can
  ship dark behind the modal) → Python adoption/hold change → enable.
