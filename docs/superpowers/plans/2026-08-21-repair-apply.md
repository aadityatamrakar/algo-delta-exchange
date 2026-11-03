# Repair Apply Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An Apply button on each repair candidate card that executes the plan (closes → opens) through the existing SubmitService rail, behind a preview modal showing every order, broker margin Δ, and the hypothetical post-apply delta picture.

**Architecture:** A new bridge-side `RepairApplyService` orchestrates the existing per-order `SubmitService` (idempotency, live gates, kill switch, chaser, journal, book fold all inherited). Preflight is a pure apply-then-measure pass beside `verifyMargin`. The Python driver pauses its action pass while a `repairHold` rides the positions payload, and adopts repair-origin legs unprotected (bot-managed).

**Tech Stack:** Node 24 + TypeScript (`node:test` runner), React + `@astryxdesign/core`, MongoDB (standalone — no change streams), Python 3 (pytest) in sensibull-desk.

**Spec:** `docs/superpowers/specs/2026-08-21-repair-apply-design.md`

## Global Constraints

- `RepairMove.qty` is **signed shares**; `SubmitRequestBody.lots` is **lots**; gateway `quantity` is contract units. Every conversion is explicit; nothing infers side from the op word.
- The Kite basket-margin endpoint stays **the one allowed broker call** on the preflight path. Order placement rides the existing rails only.
- Never set `resting: true` on a repair order (gap F12: a resting fill never folds into the book).
- Fail-soft on reads: preflight answers 200-with-warnings, never 500 (cockpit convention).
- The delta panel uses the **Positions engine** (`bookGreeks` BS-on-spot + `Δ0 = spot − netΔ/netΓ` + shorts-only = qty<0 filter) — never the cockpit's Black-76.
- `desk-repair-applies` is the run collection; one RUNNING run per tag.
- Repo test commands: `npm test -w apps/api`, `npm test -w apps/web`, `npm test -w apps/marketdata`, `npm test -w packages/payoff`; Python: `python -m pytest tests/ -k <pat>` from the sensibull-desk root.
- Standalone Mongo: poll, never change streams.
- Commit after every green task with the repo's `feat(desk):` / `fix(desk):` narrative style.

## File Structure

**algomaker**
- Create: `apps/api/src/repair-plan.ts` — pure: `resolveOrders`, `estimateFill`, `deltaFigures`/`deltaPictures`, wire types.
- Create: `apps/api/src/repair-apply.ts` — `RepairApplyService`: run doc, wave state machine over `SubmitService`, hold accessor.
- Create: `apps/api/src/routes/repair.ts` — `/v1/desk/repair/preflight`, `/v1/desk/repair/apply`, `/v1/desk/repair/apply/:id`.
- Modify: `apps/api/src/routes/payoff.ts` — export `assemble`, `chainLookups`, `verifyMargin`, `bookPrint`; amend header + Repairs copy constraint note.
- Modify: `apps/api/src/store.ts:96` (COLLECTIONS), `apps/api/src/submit.ts` (`origin`), `apps/api/src/contract.ts:120` (BridgeLeg.origin), `apps/api/src/routes/desk.ts:294` (repairHold), `apps/api/src/marks.ts` + `apps/api/src/chain.ts` + `apps/api/src/main.ts:290` (depth plumbing).
- Modify: `apps/marketdata/src/kite-feed.ts:34` + `apps/marketdata/src/main.ts` `tickPayload` (~:495) — depth with quantities.
- Create: `apps/web/src/repair-apply.tsx` — the modal. Modify: `apps/web/src/api.ts`, `apps/web/src/payoff.tsx`.

**sensibull-desk**
- Modify: `sensibull_tools/live/desk/translate.py` (~:1723), `sensibull_tools/live/desk/driver.py` (~:493).
- Tests: `tests/test_desk_manual_adopt.py`, new `tests/test_repair_hold.py`.

---

### Task 1: Marketdata retains 5-level depth with quantities

**Files:**
- Modify: `apps/marketdata/src/kite-feed.ts:34`
- Modify: `apps/marketdata/src/main.ts` (`tickPayload`, declared near `:495`, used at `:821`)
- Test: `apps/marketdata/test/` — add `depth.test.ts` (mirror the naming of the existing tests in that dir)

**Interfaces:**
- Produces: `md.tick` payload gains `depth?: { buy: { price: number; qty: number }[]; sell: { price: number; qty: number }[] }` — max 5 levels per side, only levels with `price > 0`.

- [ ] **Step 1: Widen the tick type**

In `kite-feed.ts:34` change the depth line to:

```ts
  readonly depth?: {
    buy?: { price: number; quantity?: number }[]
    sell?: { price: number; quantity?: number }[]
  }
```

(`quantity` is what KiteTicker's full-mode parser names the field; optional because older fixtures omit it.) `bestBidAsk`/`acceptTick` read `[0]?.price` and are untouched.

- [ ] **Step 2: Write the failing test for the payload builder**

Find `tickPayload` in `apps/marketdata/src/main.ts` (declared near line 495; if it is not exported, export it). Test:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tickPayload } from '../src/main.ts'

test('tickPayload carries top-5 depth with quantities, skipping empty levels', () => {
  const t = {
    instrument_token: 111, last_price: 12.4,
    depth: {
      buy: [{ price: 12.3, quantity: 500 }, { price: 12.25, quantity: 900 }, { price: 0, quantity: 0 }],
      sell: [{ price: 12.5, quantity: 250 }],
    },
  }
  const p = tickPayload(t as never, 1755750000000)
  assert.deepEqual(p.depth, {
    buy: [{ price: 12.3, qty: 500 }, { price: 12.25, qty: 900 }],
    sell: [{ price: 12.5, qty: 250 }],
  })
})

test('tickPayload omits depth when the packet has none', () => {
  const p = tickPayload({ instrument_token: 1, last_price: 5 } as never, 1)
  assert.equal(p.depth, undefined)
})
```

- [ ] **Step 3: Run to verify failure** — `npm test -w apps/marketdata`. Expected: FAIL (no `depth` on payload / not exported).

- [ ] **Step 4: Implement**

In `tickPayload`, after the existing bid/ask fields, add:

```ts
  const level = (l: { price: number; quantity?: number } | undefined) =>
    l !== undefined && typeof l.price === 'number' && Number.isFinite(l.price) && l.price > 0
      ? { price: l.price, qty: typeof l.quantity === 'number' && l.quantity >= 0 ? l.quantity : 0 }
      : null
  const side = (ls: { price: number; quantity?: number }[] | undefined) =>
    (ls ?? []).slice(0, 5).map(level).filter((x): x is { price: number; qty: number } => x !== null)
  const buy = side(t.depth?.buy)
  const sell = side(t.depth?.sell)
  // in the returned object:
  ...(buy.length > 0 || sell.length > 0 ? { depth: { buy, sell } } : {}),
```

Adapt names to the function's existing style (it already derives `bid`/`ask` — keep those untouched).

- [ ] **Step 5: Run to green** — `npm test -w apps/marketdata`. Expected: PASS, no other test broken.

- [ ] **Step 6: Commit** — `git add -A apps/marketdata && git commit` — "feat(desk): the feed keeps the book's top five levels, not just the touch".

---

### Task 2: Depth flows through the bridge's QuoteCache into the chain

**Files:**
- Modify: `apps/api/src/marks.ts` (the `Quote` type and `QuoteCache.update`)
- Modify: `apps/api/src/main.ts:288-295` (the `md.tick` subscriber)
- Modify: `apps/api/src/chain.ts:25-30` (quote type) and `:85` (the projection)
- Test: `apps/api/test/chain.test.ts` (extend)

**Interfaces:**
- Consumes: Task 1's `md.tick.depth`.
- Produces: `ChainResponse` rows' `CE`/`PE` quotes gain `depth?: { buy: { price: number; qty: number }[]; sell: { price: number; qty: number }[] }`. Type name: export `interface DepthBook { buy: DepthLevel[]; sell: DepthLevel[] }`, `interface DepthLevel { price: number; qty: number }` from `chain.ts`.

- [ ] **Step 1: Write the failing test**

Extend `apps/api/test/chain.test.ts` — copy its existing fixture pattern for feeding the cache, then:

```ts
test('a chain quote carries the depth the cache holds', () => {
  // feed marks.update(token, price, ts, { bid, ask, depth: { buy: [{price: 12.3, qty: 500}], sell: [{price: 12.5, qty: 250}] } })
  // build the chain exactly as the existing tests do, then:
  const q = chain.rows.find((r) => r.strike === 2440)?.PE
  assert.deepEqual(q?.depth, { buy: [{ price: 12.3, qty: 500 }], sell: [{ price: 12.5, qty: 250 }] })
})
```

- [ ] **Step 2: Run to verify failure** — `npm test -w apps/api -- --test-name-pattern depth` (or run the chain test file). Expected: FAIL.

- [ ] **Step 3: Implement the plumbing**

1. `marks.ts`: add `depth?: DepthBook` to the stored quote and to `update`'s options bag, stored verbatim.
2. `main.ts` subscriber (`:288`): widen the generic with `depth?: ...` and pass `depth: m.payload.depth` in the options.
3. `chain.ts`: add `readonly depth?: DepthBook` beside `bid`/`ask` (:29) and project it at `:85`: `...(q.depth === undefined ? {} : { depth: q.depth })`.

Match `exactOptionalPropertyTypes` style — spread-omit, never `depth: undefined`.

- [ ] **Step 4: Run api tests to green** — `npm test -w apps/api`. Expected: PASS.

- [ ] **Step 5: Commit** — "feat(desk): the chain serves the book behind each quote".

---

### Task 3: Order origin rides submit into the stored book leg

**Files:**
- Modify: `apps/api/src/contract.ts:120` (BridgeLeg), `apps/api/src/submit.ts` (SubmitRequestBody `:146`, validate, `#maintainBook` fold `:1267+`)
- Test: `apps/api/test/book-write.test.ts` or the submit test file (find the test that already asserts `#maintainBook` folds a leg — extend beside it)

**Interfaces:**
- Produces: `SubmitRequestBody.origin?: 'manual' | 'repair'` (absent = manual); the folded leg document in `desk-books` carries `origin` verbatim; `BridgeLeg.origin?: 'manual' | 'repair'` so `service.positions()` serves it to Python untouched.

- [ ] **Step 1: Failing test** — in the existing submit/book-fold suite, clone the "manual leg added to book" case, submit with `origin: 'repair'`, and assert the stored book leg has `origin: 'repair'`; a submit without the field stores no `origin` key (absent, not `'manual'` — absent IS manual, and old documents stay valid).

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement** — add the field to `SubmitRequestBody` (doc comment: "Who authored this order. `repair` legs are adopted BOT-MANAGED by the Python driver — no `protected` stamp; absent means manual."); let `validateSubmitRequest` accept `'manual' | 'repair'` and reject other strings; thread it through the fold in `#maintainBook` onto the new/resized leg document; add `readonly origin?: 'manual' | 'repair'` to `BridgeLeg` in `contract.ts` and to the web mirror `apps/web/src/api.ts:49`.

- [ ] **Step 4: Run to green.** `npm test -w apps/api`.

- [ ] **Step 5: Commit** — "feat(desk): a submitted order says who authored it, and the book leg remembers".

---

### Task 4: `resolveOrders` — a plan becomes concrete orders (pure)

**Files:**
- Create: `apps/api/src/repair-plan.ts`
- Test: `apps/api/test/repair-plan.test.ts`

**Interfaces:**
- Consumes: `BridgeLeg` (contract.ts:120 — `deskTag, instrument: {tradingsymbol, instrumentToken, lotSize?, tickSize?, exchange?}, underlying, expiry, strike, type, side, qty (signed units), entryPrice`), `Move` (`@algomaker/payoff` moves.ts:72), `ChainResponse` (chain.ts — rows carry `strike`, `ceContract`/`peContract` instrument refs; read chain.ts first for their exact field names and mirror them).
- Produces (verbatim, exported):

```ts
export interface PlannedOrder {
  readonly wave: 'close' | 'open'
  readonly moveIndex: number
  readonly side: 'Buy' | 'Sell'
  readonly instrument: {
    readonly tradingsymbol: string
    readonly instrumentToken: number
    readonly lotSize: number
    readonly tickSize: number
    readonly exchange: string
  }
  readonly strike: number
  readonly type: 'CE' | 'PE'
  readonly expiry: string
  readonly lots: number
  readonly reducesExposure: boolean
}
export function resolveOrders(input: {
  readonly legs: readonly BridgeLeg[]      // pos.legs, in served order
  readonly moves: readonly Move[]
  readonly chain: ChainResponse | null     // instrument identity for opens
  readonly lotSize: number
  readonly bookExpiry: string
}): { readonly orders: readonly PlannedOrder[]; readonly dropped: readonly string[] }
```

- [ ] **Step 1: Write the failing tests.** The legId join MUST reproduce `assemble`'s id assignment exactly (`routes/payoff.ts:640-648`): walk `legs` in order, skip `qty === 0`, id = `tradingsymbol`, then `#2`, `#3`… on collision.

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveOrders } from '../src/repair-plan.ts'

const leg = (ts: string, strike: number, type: 'CE' | 'PE', qty: number): BridgeLeg => ({
  deskTag: `py:${ts}:${qty}`, underlying: 'TCS', expiry: '2026-08-26', strike, type,
  side: qty < 0 ? 'Sell' : 'Buy', qty, entryPrice: 10, openedTs: 1,
  instrument: { tradingsymbol: ts, instrumentToken: 1, lotSize: 175, tickSize: 0.05, exchange: 'NFO' },
})

test('close of a short leg is a Buy for its full size, wave close', () => {
  const r = resolveOrders({
    legs: [leg('TCS26AUG2280PE', 2280, 'PE', -175)],
    moves: [{ op: 'close', legId: 'TCS26AUG2280PE' }],
    chain: null, lotSize: 175, bookExpiry: '2026-08-26',
  })
  assert.equal(r.dropped.length, 0)
  assert.deepEqual(r.orders.map((o) => [o.wave, o.side, o.lots, o.reducesExposure]),
    [['close', 'Buy', 1, true]])
})

test('a shift is two orders: close the leg, open at the new strike from the chain', () => {
  const chain = chainFixtureWithContract(2260, 'PE', 'TCS26AUG2260PE', 222) // helper: minimal ChainResponse
  const r = resolveOrders({
    legs: [leg('TCS26AUG2440PE', 2440, 'PE', -350)],
    moves: [{ op: 'shift', legId: 'TCS26AUG2440PE', toStrike: 2260 }],
    chain, lotSize: 175, bookExpiry: '2026-08-26',
  })
  assert.deepEqual(r.orders.map((o) => [o.wave, o.side, o.instrument.tradingsymbol, o.lots]), [
    ['close', 'Buy', 'TCS26AUG2440PE', 2],
    ['open', 'Sell', 'TCS26AUG2260PE', 2],
  ])
  assert.equal(r.orders[1]!.moveIndex, 0)
})

test('the #n id addresses the SECOND pocket of a doubled contract', () => {
  const legs = [leg('TCS26AUG2340CE', 2340, 'CE', -175), leg('TCS26AUG2340CE', 2340, 'CE', -350)]
  const r = resolveOrders({ legs, moves: [{ op: 'close', legId: 'TCS26AUG2340CE#2' }], chain: null, lotSize: 175, bookExpiry: '2026-08-26' })
  assert.deepEqual(r.orders.map((o) => o.lots), [2])
})

test('add with signed shares: negative qty sells, lots = |qty|/lotSize', () => {
  const chain = chainFixtureWithContract(2600, 'CE', 'TCS26AUG2600CE', 223)
  const r = resolveOrders({ legs: [], moves: [{ op: 'add', strike: 2600, type: 'CE', qty: -350 }], chain, lotSize: 175, bookExpiry: '2026-08-26' })
  assert.deepEqual(r.orders.map((o) => [o.wave, o.side, o.lots, o.reducesExposure]), [['open', 'Sell', 2, false]])
})

test('drops, never guesses: unknown legId; non-integer lots; strike missing from the chain; lotSize 0', () => {
  const r1 = resolveOrders({ legs: [], moves: [{ op: 'close', legId: 'NOPE' }], chain: null, lotSize: 175, bookExpiry: '2026-08-26' })
  assert.equal(r1.orders.length, 0); assert.equal(r1.dropped.length, 1)
  const r2 = resolveOrders({ legs: [leg('X', 100, 'CE', -100)], moves: [{ op: 'close', legId: 'X' }], chain: null, lotSize: 175, bookExpiry: '2026-08-26' })
  assert.equal(r2.dropped.length, 1) // 100 shares over lot 175 is not a whole number of lots
})

test('an open that reduces an opposite holding is reducesExposure', () => {
  const chain = chainFixtureWithContract(2340, 'CE', 'TCS26AUG2340CE', 224)
  const r = resolveOrders({ legs: [leg('TCS26AUG2340CE', 2340, 'CE', -350)],
    moves: [{ op: 'add', strike: 2340, type: 'CE', qty: 175 }], chain, lotSize: 175, bookExpiry: '2026-08-26' })
  assert.equal(r.orders[0]!.reducesExposure, true)  // buying against a short
})
```

Write `chainFixtureWithContract` against the real `ChainResponse` shape (read `chain.ts` first).

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement.** Rules:
- Rebuild the id map exactly as `assemble` does; `close`: side = opposite of the leg's sign, lots = |leg.qty| / instrument.lotSize (drop if not a positive integer), instrument copied from the leg, `reducesExposure: true`.
- `shift`: the close order above + an open (same |qty| sign as the closed leg → side by sign) whose instrument comes from the chain row at `toStrike` for the leg's type; drop the WHOLE shift (both halves) if the contract or integer-lots test fails — atomic, same rule as `applyMoves`.
- `add`/`hedge`: side by qty sign, lots = |qty| / lotSize; instrument from the chain row; drop if `lotSize <= 0`, the chain has no contract, or lots is not a positive integer.
- `reducesExposure` for opens: sum the book's signed qty on that exact contract; the order reduces exposure iff it moves that sum strictly toward zero without crossing it (the `classifyExposure` rule from `apps/web/src/manual-order-plan.ts:207` — read it and mirror the semantics server-side).
- Every drop pushes one sentence naming the move, in `moveText`'s vocabulary (e.g. `close "TCS26AUG2280PE": no such leg in the book`).
- Order the output: all `close` waves first (book order), then opens (move order). Fill instrument `lotSize`/`tickSize`/`exchange` defaults (`0.05`, `'NFO'`) only when the source ref omits them.

- [ ] **Step 4: Run to green.** `npm test -w apps/api -- --test-name-pattern repair-plan` then the full suite.

- [ ] **Step 5: Commit** — "feat(desk): a repair plan resolves to the orders it would place".

---

### Task 5: `estimateFill` — walk the book for the price the size actually pays

**Files:**
- Modify: `apps/api/src/repair-plan.ts`
- Test: `apps/api/test/repair-plan.test.ts` (extend)

**Interfaces:**
- Produces:

```ts
export interface FillEstimate {
  readonly price: number | null   // qty-weighted average across the levels walked
  readonly coveredQty: number     // depth qty available on the walked side
  readonly exceedsDepth: boolean
  readonly quoteAgeMs: number | null
}
export function estimateFill(
  side: 'Buy' | 'Sell',
  qtyUnits: number,               // lots × lotSize, always positive
  quote: { readonly depth?: DepthBook; readonly ageMs: number } | null | undefined,
): FillEstimate | null            // null when there is no quote at all
```

- [ ] **Step 1: Failing tests**

```ts
const q = (buy: [number, number][], sell: [number, number][], ageMs = 500) => ({
  ageMs, depth: { buy: buy.map(([price, qty]) => ({ price, qty })), sell: sell.map(([price, qty]) => ({ price, qty })) },
})

test('level 1 covers: the touch is the estimate', () => {
  const e = estimateFill('Buy', 175, q([[12.3, 500]], [[12.5, 500]]))
  assert.deepEqual(e, { price: 12.5, coveredQty: 500, exceedsDepth: false, quoteAgeMs: 500 })
})
test('VWAP across levels when level 1 is thin', () => {
  const e = estimateFill('Sell', 400, q([[12.3, 100], [12.2, 300]], []))
  // 100@12.3 + 300@12.2 → (100*12.3 + 300*12.2)/400 = 12.225
  assert.equal(e?.price, 12.225); assert.equal(e?.exceedsDepth, false)
})
test('size past the visible book flags exceedsDepth and prices what it can see', () => {
  const e = estimateFill('Buy', 1000, q([], [[12.5, 200], [12.6, 300]]))
  assert.equal(e?.exceedsDepth, true); assert.equal(e?.coveredQty, 500)
  assert.equal(e?.price, (200 * 12.5 + 300 * 12.6) / 500)
})
test('no depth on the walked side → price null, coveredQty 0', () => {
  const e = estimateFill('Buy', 175, q([[12.3, 500]], []))
  assert.deepEqual(e, { price: null, coveredQty: 0, exceedsDepth: true, quoteAgeMs: 500 })
})
test('no quote at all → null', () => { assert.equal(estimateFill('Buy', 175, null), null) })
```

- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.** A BUY walks `sell` levels (asks), a SELL walks `buy`. Accumulate `min(remaining, level.qty)` at each price; `price` = weighted average over what was consumed (or over the whole visible side when it can't cover — the honest partial answer); `exceedsDepth = coveredQty < qtyUnits`.
- [ ] **Step 4: Run to green.**
- [ ] **Step 5: Commit** — "feat(desk): the estimate walks the book for the size, not the last print".

---

### Task 6: `deltaPictures` — the Positions engine over a hypothetical book

**Files:**
- Modify: `apps/api/src/repair-plan.ts`
- Test: `apps/api/test/repair-plan.test.ts` (extend)

**Interfaces:**
- Consumes: `bookGreeks(legs: PositionLeg[], nowMs, opts)` from `@algomaker/greeks` (index.ts:291 — `PositionLeg` needs `tradingsymbol, qty, strike, type, expiry, spot, markPrice`); the carry-yield greek opts recipe from `apps/api/src/service.ts` (`RATE`, `carryYield(spot, futMark, tBook, RATE)` → `{ rate, dividendYield }`) — import the same helpers, do not restate the numbers.
- Produces:

```ts
export interface DeltaFigures {
  readonly netDelta: number | null
  readonly netGamma: number | null
  readonly neutral: { readonly price: number; readonly pct: number } | null
}
export interface DeltaPicture { readonly all: DeltaFigures; readonly shortsOnly: DeltaFigures }
export function deltaPictures(input: {
  readonly current: readonly PositionLeg[]   // built by the route from pos.greeks marks
  readonly after: readonly PositionLeg[]     // current ± the plan's closes/shifts/opens
  readonly spot: number | null
  readonly nowMs: number
  readonly greekOpts: { readonly rate: number; readonly dividendYield?: number }
}): { readonly current: DeltaPicture; readonly after: DeltaPicture }
```

- [ ] **Step 1: Failing tests.** Key invariants, with a two-leg fixture (one short PE, one long CE hedge) at a fixed `nowMs`:
  1. `current.all.netDelta` equals `bookGreeks(currentLegs, nowMs, opts).netDelta` exactly (same engine, no drift).
  2. `shortsOnly` figures equal `bookGreeks` over `legs.filter(l => l.qty < 0)` (the `shortsOnlyGreeks` rule, `apps/web/src/positions.ts:459`).
  3. `neutral` equals `spot − netΔ/netΓ` with `pct = (price − spot)/spot·100`, and is `null` when `netGamma === 0`, when nothing priced, or when `spot` is null (`positions.ts:428-431` semantics).
  4. Removing the short leg from `after` moves `after.all.netDelta` by exactly that leg's position delta.

- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** — one `figures(legs)` helper calling `bookGreeks` and the Δ0 formula, called four times (all/shortsOnly × current/after). `netDelta: null` when `bookGreeks` returns an empty priced set (all legs in `unpriced`).
- [ ] **Step 4: Run to green.**
- [ ] **Step 5: Commit** — "feat(desk): the hypothetical book answers in the Positions page's own delta".

---

### Task 7: `POST /v1/desk/repair/preflight`

**Files:**
- Create: `apps/api/src/routes/repair.ts`
- Modify: `apps/api/src/routes/payoff.ts` — add `export` to `assemble`, `chainLookups`, `verifyMargin`, `bookPrint` (and export the `Assembled` type)
- Modify: wherever routes are registered (see how `payoffRoutes` is mounted in `apps/api/src/main.ts` / the router list — mount `repairRoutes(deps, opts)` beside it)
- Test: `apps/api/test/repair-routes.test.ts`

**Interfaces:**
- Consumes: Tasks 4-6 exports; `verifyMargin(deps, book, moves, marginCfg)`; `deps.service.positions(tag, mode, { realised: true })`; `bookPrint(book, kind, extra)`.
- Produces the wire shape (mirror into `apps/web/src/api.ts` in Task 11):

```ts
export interface RepairPreflightResponse {
  readonly tag: string
  readonly mode: DeskMode
  readonly asOf: number
  readonly bookPrint: string
  readonly orders: readonly (PlannedOrder & { readonly mark: number | null; readonly est: FillEstimate | null })[]
  readonly dropped: readonly string[]
  readonly margin: VerifyMarginResponse
  readonly delta: { readonly current: DeltaPicture; readonly after: DeltaPicture }
  readonly holdActive: boolean
  readonly warnings: readonly string[]
}
```

- [ ] **Step 1: Failing route test.** Follow the existing route-test pattern in `apps/api/test` (they build `ApiDeps` fakes — copy the harness `payoff`/`chain` tests use). Cases:
  1. Happy path: a one-short book + a `[close]` plan → 200 with one Buy close order, `margin.estimated` present, `delta.current.all.netDelta` a number, `bookPrint` non-empty.
  2. A `legId` that doesn't resolve → `dropped` non-empty, `orders` empty for that move, still 200.
  3. `tag` missing → 400. Unknown book → 200 with `warnings` naming it (assemble's `error` folded in) and empty orders.
  4. `holdActive: true` when a `desk-repair-applies` doc for the tag has `state: 'RUNNING'`.

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement.** Handler flow (fail-soft):

```ts
const book = await assemble(deps, tag, mode)                    // chain, ivs, future, spot, PayoffLegs
const pos = await deps.service.positions(tag, mode, { realised: true })  // BridgeLegs + greeks marks
const resolved = resolveOrders({ legs: pos.legs, moves, chain: book.chain, lotSize: book.chain?.lotSize ?? 0, bookExpiry: book.expiry })
// mark + est per order: join order.instrument.tradingsymbol back to the chain row quote
// (row = chain.rows.find(strike && type)); mark = quote.price; est = estimateFill(side, lots*lotSize, quote)
const margin = await verifyMargin(deps, book, moves, marginCfg)  // runs the broker check automatically
// delta: current PositionLegs from pos.greeks.legs (they carry tradingsymbol, qty, price) joined to
// pos.legs for strike/type/expiry, spot = pos.spot; after = fold resolved orders into that set
// (closes remove/reduce by matching tradingsymbol+qty; opens add with markPrice = chain mid)
// greekOpts: same recipe as service.ts (rate + carry when future & spot print)
const print = bookPrint(book, 'repair', '')                      // same inputs-fingerprint the archive uses
send(200, { tag, mode, asOf: book.asOf, bookPrint: print, orders, dropped, margin, delta, holdActive, warnings })
```

`holdActive` = `await deps.db.collection(COLLECTIONS.repairApplies).findOne({ tag, state: 'RUNNING' }) !== null`.

- [ ] **Step 4: Run to green** — `npm test -w apps/api`.
- [ ] **Step 5: Commit** — "feat(desk): preflight prices a repair as the orders it would place".

---

### Task 8: `RepairApplyService` — the wave state machine

**Files:**
- Create: `apps/api/src/repair-apply.ts`
- Modify: `apps/api/src/store.ts:96` — add `repairApplies: 'desk-repair-applies',` to `COLLECTIONS` with a one-line doc comment
- Test: `apps/api/test/repair-apply.test.ts`

**Interfaces:**
- Consumes: `SubmitService`-shaped port (inject a narrow interface, not the class):

```ts
export interface OrderRail {
  submit(req: SubmitRequestBody): Promise<SubmitResponse>
}
```

- Produces:

```ts
export type RunState = 'RUNNING' | 'DONE' | 'HALTED'
export interface RunOrder {
  readonly clientOrderId: string
  readonly wave: 'close' | 'open'
  readonly planned: PlannedOrder
  readonly status: 'QUEUED' | 'SUBMITTED' | 'FILLED' | 'FAILED'
  readonly detail?: string
}
export interface RunDoc {
  readonly _id: string            // applyId (= the caller's decisionId)
  readonly tag: string
  readonly mode: DeskMode
  readonly style: 'fast' | 'limit'
  readonly bookPrint: string
  readonly state: RunState
  readonly haltReason?: string
  readonly orders: readonly RunOrder[]
  readonly createdAt: number
  readonly updatedAt: number
}
export class RepairApplyService {
  constructor(deps: {
    db: Db; rail: OrderRail; now: () => number; log: (msg: string, ctx?: object) => void
    quote: (tradingsymbol: string) => { bid: number | null; ask: number | null; mid: number | null; tickSize: number } | null
    fillState: (mode: DeskMode, clientOrderId: string) => Promise<'PENDING' | 'FILLED' | 'FAILED'>
    pollMs?: number               // default 2000; tests pass 1
    maxWaveMs?: number            // default 300_000 (the gateway's own order max age)
  })
  start(req: { tag: string; mode: DeskMode; style: 'fast' | 'limit'; bookPrint: string
    applyId: string; orders: readonly PlannedOrder[] }): Promise<{ ok: true; run: RunDoc } | { ok: false; reason: string }>
  status(applyId: string): Promise<RunDoc | null>
  activeHold(tag: string): Promise<{ applyId: string; heldAt: number; untilMs: number } | null>
  haltStaleRunsOnBoot(): Promise<void>
}
```

- [ ] **Step 1: Failing tests**, against a fake `OrderRail` + scripted `fillState`. Break into multiple named tests:
  1. **Happy path**: 1 close + 1 open; rail receives the close first; the open is NOT submitted until `fillState` reports the close `FILLED`; run ends `DONE`; every `RunOrder.status === 'FILLED'`.
  2. **Second run refused**: `start` for a tag with a RUNNING run returns `{ ok: false }` and submits nothing.
  3. **Close fails → halt**: `fillState` returns `FAILED` for the close → state `HALTED`, `haltReason` names the order, the open stays `QUEUED`, the rail never saw it.
  4. **Rail refusal halts**: rail resolves `{ accepted: false, reason: 'live not allowed', ... }` → that order `FAILED` with the reason as `detail`, run `HALTED`.
  5. **Wave timeout**: `fillState` stays `PENDING` past `maxWaveMs` (drive with a controllable `now`) → `HALTED (aged out waiting on fills)`.
  6. **Idempotent clientOrderIds**: submitted ids are `repair:<applyId>:0`, `repair:<applyId>:1`, … in wave order.
  7. **Pricing per style**: with quote `{bid: 12.3, ask: 12.5, tickSize: 0.05}`, `fast` Buy carries `limitPrice` = ask stepped UP by the marketable buffer (reuse `marketableLimit` from `apps/api/src/marketable.ts:103` with the touch as the mark — assert against its output, not a hand-computed number); `limit` style carries mid (12.4) rounded to tick. A `null` quote on a queued order → run halts BEFORE that order is submitted.
  8. **`activeHold`** returns `{applyId, heldAt, untilMs: heldAt + 600_000}` while RUNNING and fresh, null after DONE/HALTED and null when `now > untilMs`.
  9. **`haltStaleRunsOnBoot`** flips every RUNNING doc to `HALTED (restart)`.
  10. **Origin + flags on the wire**: every submitted req has `origin: 'repair'`, `orderType: 'LIMIT'`, no `resting`, `exactLots: true`, and closes carry `reducesExposure: true`.

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement.** Notes for the implementer:
- `start` inserts the run doc first (`_id` unique index gives whole-run idempotency: a duplicate insert error → return the existing doc's status instead of re-running).
- The execution loop runs detached (`void this.#execute(run)` after `start` resolves) — `start` returns as soon as the doc exists so the HTTP response is immediate; the modal polls `status`.
- Submit sequentially within a wave is fine (the rail is fast); gate the open wave on ALL closes `FILLED` via `fillState` polling every `pollMs`.
- `fillState` is INJECTED; the real implementation (built in Task 9) reads the rails' own collections.
- Persist every transition with `updatedAt: now()` so `status` polling shows live progress.
- `quote` reads the live chain-quote path (`deps.marks` mid/bid/ask by tradingsymbol) — for a repair, price at submit time, never at preflight time.

- [ ] **Step 4: Run to green.**
- [ ] **Step 5: Commit** — "feat(desk): a repair run walks its waves — closes, fills confirmed, then opens — and halts rather than guesses".

---

### Task 9: The real `fillState` + apply/status routes

**Files:**
- Modify: `apps/api/src/routes/repair.ts`
- Test: `apps/api/test/repair-routes.test.ts` (extend)

**Interfaces:**
- Consumes: `RepairApplyService`, `SubmitService` (construct with the exact dependency bag `routes/submit.ts:113-149` uses — copy it, same rails/freeze/marketable/risk wiring), reauth gate (mirror the operator-password check exactly as `routes/desk.ts:1471-1479` performs it, same deps field and same 403 `{ error, reauthRequired: true }` shape).
- Produces routes:
  - `POST /v1/desk/repair/apply` `{tag, mode, moves, bookPrint, decisionId, style, password?}` → `202 { accepted: true, applyId }` | `409 { error: 'book-changed' }` | `403 reauth` | `200 { accepted: false, reason }`.
  - `GET /v1/desk/repair/apply/:applyId` → the `RunDoc` (404 when unknown).

- [ ] **Step 1: Failing route tests**:
  1. Paper apply happy path → 202; the fake rail saw closes-then-opens; GET status shows the run.
  2. `bookPrint` mismatch (recompute differs) → 409, nothing submitted.
  3. `mode: 'live'` without password → 403 `{ reauthRequired: true }`, nothing submitted.
  4. Second apply while RUNNING → `{ accepted: false, reason }`.
  5. `fillState` implementation: paper mode → an order whose `SubmitResponse` came back `accepted: true, status: 'DONE'` is `FILLED` immediately (the paper rail books synchronously; the paperstream price-stamp is display-only); live mode → read the gateway order docs by `clientOrderId` prefix in `COLLECTIONS.gatewayOrders` (tranches are `<id>.1`, `<id>.2` — `gateway.ts:104`); read `apps/api/src/queue.ts:26`'s `OrderState` FIRST and map: every tranche in the fully-filled terminal state → `FILLED`; any tranche in a failed/rejected/expired terminal state → `FAILED`; else `PENDING`. Test with seeded gateway docs.
  6. Unknown `applyId` on GET → 404.

- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.** The apply handler: validate body → recompute `assemble` + `bookPrint` and compare → reauth when live → `resolveOrders` again server-side (never trust the client's expansion; refuse if `dropped` non-empty: `{ accepted: false, reason: dropped.join('; ') }`) → `service.start(...)` with `applyId = decisionId` → 202. Wire `haltStaleRunsOnBoot()` into the route factory's construction (runs once per process start).
- [ ] **Step 4: Run to green** — full `npm test -w apps/api`.
- [ ] **Step 5: Commit** — "feat(desk): apply places a repair through the desk's own rail, gated like every live order".

---

### Task 10: `repairHold` rides the positions payload

**Files:**
- Modify: `apps/api/src/routes/desk.ts:281-295`
- Test: extend the positions route test in `apps/api/test` (find the test that exercises `/v1/desk/positions`)

**Interfaces:**
- Consumes: `RepairApplyService.activeHold(tag)` (Task 8) — the routes module exposes the service instance to `deskRoutes` (thread it through the shared deps/registration in `main.ts`; if the two route factories don't share state today, export a `repairHoldLookup(db, now)` standalone function from `repair-apply.ts` and call that — same query, no coupling).
- Produces: positions response gains `repairHold: { applyId, heldAt, untilMs } | null` — always present (null when no hold), so the Python side reads one stable key.

- [ ] **Step 1: Failing test** — positions for a tag with a RUNNING run carries the hold; DONE/stale runs → `repairHold: null`.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** — at `routes/desk.ts:294`: `send(200, { ...(await service.positions(tag, mode, { realised: true })), repairHold: await holdOf(tag) })`.
- [ ] **Step 4: Run to green.**
- [ ] **Step 5: Commit** — "feat(desk): the positions payload says when a repair is mid-flight".

---

### Task 11: Web client — types and calls

**Files:**
- Modify: `apps/web/src/api.ts`
- Test: `apps/web/test/` — the api surface is exercised through component tests; add the type mirrors compile-checked only.

**Interfaces:**
- Produces (mirroring Tasks 7-9's wire shapes verbatim into `api.ts` beside `RepairResponse` at `:1826`): `PlannedOrderWire`, `FillEstimate`, `DeltaFigures`, `DeltaPicture`, `RepairPreflightResponse`, `RepairRunOrder`, `RepairRunDoc`; and on the `api` object beside `repairVerifyMargin` (`:2373`):

```ts
repairPreflight: (tag: string, mode: DeskMode, moves: readonly RepairMove[]) =>
  post<RepairPreflightResponse>('/v1/desk/repair/preflight', { tag, mode, moves }),
repairApply: (body: { tag: string; mode: DeskMode; moves: readonly RepairMove[]
  bookPrint: string; decisionId: string; style: 'fast' | 'limit'; password?: string }) =>
  post<{ accepted: true; applyId: string } | { accepted: false; reason: string }>('/v1/desk/repair/apply', body),
repairApplyStatus: (applyId: string) =>
  get<RepairRunDoc>(`/v1/desk/repair/apply/${encodeURIComponent(applyId)}`),
```

- [ ] **Step 1: Add the types + fns; `npm run typecheck -w apps/web` (or the repo's check script — read package.json scripts) passes.**
- [ ] **Step 2: Commit** — "feat(desk): the web client can preflight and apply a repair".

---

### Task 12: The Apply modal

**Files:**
- Create: `apps/web/src/repair-apply.tsx`
- Test: `apps/web/test/repair-apply.test.tsx`

**Interfaces:**
- Consumes: Task 11's api fns; `Dialog, DialogHeader` from `@astryxdesign/core/Dialog`; `withReauth, type Reauth` from `./auth.tsx`; `formatContract` from `./contract.ts`; `moveLine` stays in payoff.tsx.
- Produces:

```ts
export function RepairApplyDialog(props: {
  open: boolean
  tag: string
  mode: DeskMode
  bookExpiry: string
  planLabel: string                 // goal name, for the header + reauth statement
  planFlags: readonly string[]      // restated as warnings (degrades-floor, bot-may-reshift)
  moves: readonly RepairMove[]
  reauth: Reauth
  onClose: () => void
}): React.ReactElement
```

- [ ] **Step 1: Failing component tests** (follow `apps/web/test/close-leg.test.tsx` / `manual-order` test harness conventions — fake `api` module the way those suites do):
  1. Opening fires `repairPreflight` once and renders one row per order: side chip, `formatContract(tradingsymbol)` text (`TCS 2440 PE`), lots, est price, grouped under "closes first" / "then opens" headings.
  2. Expiry shown on a row only when `order.expiry !== props.bookExpiry`.
  3. `dropped` non-empty → a Banner naming the moves and a disabled Confirm. Also disabled while preflight is in flight, and when any `wave: 'open'` order has `est === null` (no live quote — the run would only halt there anyway).
  4. Margin block renders `broker.total − <current>` when broker present, falls back to `estimated` with the warning text when `broker: null`.
  5. Delta panel: 2×2 (all / shorts-only × now / after), Δ0 as `price (pct%)`, `—` for nulls.
  6. `bot-may-reshift` in `planFlags` → warning line "the bot may re-shift these legs once the hold lifts".
  7. Fast/Limit `Selector` present, default `fast`.
  8. Confirm in paper mode calls `repairApply` with `{style, bookPrint, decisionId}` (decisionId pattern `repair:TAG:mode:<ts>`); in live mode goes through `withReauth` with a statement naming the tag, order count and margin Δ (assert `promptFirst: true` path prompts).
  9. A `409`-shaped rejection re-runs preflight (api fake: first apply rejects with `explain`-able 'book-changed', second preflight call observed).
  10. After an accepted apply the dialog polls `repairApplyStatus` (drive timers the way the suite's usePoll fakes do) and renders per-order status chips; `state: 'HALTED'` renders `haltReason` and what executed; `DONE` renders "all filled".

- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.** Model the dialog skeleton on `WhatIfLegDialog` (`payoff.tsx:1109`, `Dialog … purpose="form" width={560}`) and the submit-with-reauth on `manual-order.tsx:405`. Preview state → confirm → tracker state in one component; keep polling only while open and `state === 'RUNNING'`; "Close — run continues server-side" secondary button while running.
- [ ] **Step 4: Run to green** — `npm test -w apps/web`.
- [ ] **Step 5: Commit** — "feat(desk): the apply modal shows every order, the margin, and where the delta lands".

---

### Task 13: Wire the card, retire Verify margin, reword the guards

**Files:**
- Modify: `apps/web/src/payoff.tsx` (PlanCard `:1531`, Repairs `:1780`, parent handlers `:2233-2300`, header comment `:28-37`, panel copy `:1827`, `moveText` `:278`)
- Modify: `apps/api/src/routes/payoff.ts:16-20` (header)
- Test: `apps/web/test/payoff.test.tsx` (update)

**Interfaces:**
- Consumes: `RepairApplyDialog` (Task 12), `formatContract` (`./contract.ts`).

- [ ] **Step 1: Failing/updated tests** in `payoff.test.tsx`:
  1. PlanCard renders an **Apply** button and no Verify margin button.
  2. Apply disabled (with title) for: baseline plan (`moves.length === 0`), `lotSize <= 0`, `no-feasible-plan` flag, or `applyOpen !== null` (a dialog already open).
  3. Move lines render formatted: a fixture `{op:'close', legId:'TCS26AUG2340CE#2'}` renders text `Close TCS 2340 CE` with muted note `#2`; `{op:'shift', legId:'TCS26AUG2440PE', toStrike:2260}` renders `Shift TCS 2440 PE → 2260`.
  4. The panel copy no longer contains "Nothing here places an order".
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.**
  - `moveText`: run `formatContract` over `legId`'s bare id (strip the `#n` first — `moveLine` already splits it) and over `strikeText` output unchanged; keep `moveKey`/`planKey` on the RAW ids (identity must not change with display).
  - PlanCard: drop `verify/verifyError/verifying/anyVerifying/onVerify` props; add `canApply: boolean`, `onApply: () => void`; keep Load into overlay.
  - Parent: delete `verifyPlan`, `verifyRef`, `verified`, `verifyErrors`, `setVerified({})`/`setVerifyErrors({})` resets (`:2216-2217`) and the props threading; add `const [applying, setApplying] = useState<{ key: string; plan: RepairPlan; goal: string } | null>(null)` and render `<RepairApplyDialog …>` from it (bookExpiry from the payoff response, reauth from the page's existing `Reauth` source — see how manual-order gets its `reauth` prop on this page).
  - Keep `api.repairVerifyMargin` in api.ts (the endpoint stays; only the button dies).
  - Copy: replace the `:1827` sentence with: `Apply places a plan's orders through the same rail as the Manual Order dialog — a preview first, the operator password on a live book, closes before opens. Each search prices hundreds of candidate books, so it runs when you ask for it and never on a timer.` Update the two file headers (`payoff.tsx:28`, `routes/payoff.ts:16`) to describe the gated path instead of denying it exists.
- [ ] **Step 4: Run to green** — `npm test -w apps/web && npm test -w apps/api`.
- [ ] **Step 5: Commit** — "feat(desk): the repair menu gets its Apply button, and the cockpit stops denying it places orders".

---

### Task 14: Python — repair-origin legs adopt bot-managed

**Files (repo: `/Users/aaditya/Documents/dev/algo-engine/sensibull-desk`):**
- Modify: `sensibull_tools/live/desk/translate.py` (~`:1700-1723`, inside `adopt_manual_legs`)
- Test: `tests/test_desk_manual_adopt.py` (extend)

**Interfaces:**
- Consumes: the bridge-only leg dict now carries `origin: 'repair' | 'manual' | absent` (Task 3 — the raw bridge leg, i.e. the element of `bridge_legs` the fold reads before `adopt_bridge_legs` translates it).
- Produces: an adopted leg is stamped `protected = True` **unless** the raw bridge leg's `origin == 'repair'`; a repair-origin leg is adopted WITHOUT the key (absent, like the driver's own legs).

- [ ] **Step 1: Failing test** — clone the existing adopt test case in `tests/test_desk_manual_adopt.py`, set `origin: 'repair'` on the raw bridge leg fixture, assert the adopted leg has no `protected` key and the log line says "bot-managed". A second case with `origin: 'manual'` and a third with no origin both still stamp `protected = True`.
- [ ] **Step 2: Run** `python -m pytest tests/test_desk_manual_adopt.py -x` — expected FAIL.
- [ ] **Step 3: Implement** at the stamp site (`translate.py:1723`):

```python
                # PROTECTED: counted in greeks, exempt from routine shift/close —
                # UNLESS the bridge says the desk's own repair flow authored it
                # (origin == 'repair'), in which case the operator explicitly chose
                # bot-managed: the dials resume shifting/closing it like any leg
                # the driver opened itself.
                if str(raw.get("origin") or "") != "repair":
                    leg["protected"] = True
```

and extend the ADOPTED log line to name which way it went.
- [ ] **Step 4: Run to green**, plus `python -m pytest tests/test_protected_legs.py`.
- [ ] **Step 5: Commit (sensibull-desk repo)** — "feat(desk): a repair-authored leg adopts bot-managed, not protected".

---

### Task 15: Python — the driver honours `repairHold`

**Files:**
- Modify: `sensibull_tools/live/desk/driver.py` (the decision pass that consumes `pos = self._bridge.positions(...)` at `:493`)
- Test: create `tests/test_repair_hold.py` (copy the driver-test harness from the nearest existing driver test — grep `tests/` for `BookDriver` fixtures)

**Interfaces:**
- Consumes: `pos["repairHold"]` = `{"applyId": str, "heldAt": ms, "untilMs": ms} | None` (Task 10).
- Produces: while a hold is present AND `now_ms < untilMs`, the driver's decision/action pass emits NO actions for the tag (no shift/close/resize/recenter/open); marking, greeks publishing, `_save`, and the adoption pass still run. One warning log per hold (not per tick).

- [ ] **Step 1: Failing test** — drive one tick with a positions payload carrying a fresh `repairHold` and a book state that WOULD otherwise act (reuse an existing test scenario that asserts an action is emitted); assert no action reaches the bridge fake. Second case: `untilMs` in the past → actions flow again. Third: hold present, adoption still adopts a new bridge leg.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** — immediately before the action-decision block that consumes `pos`:

```python
        hold = pos.get("repairHold") or None
        if hold and float(hold.get("untilMs") or 0) > time.time() * 1000.0:
            if self.state.get("_hold_seen") != hold.get("applyId"):
                self.state["_hold_seen"] = hold.get("applyId")
                _log.warning(
                    "BookDriver(%s/%s): repair %s is executing on the bridge — "
                    "holding every action this tick until it completes",
                    self.tag, self.mode, hold.get("applyId"))
            return  # or skip to the non-acting tail, matching the pass structure
```

Match the actual structure: if the decision pass is a block rather than the whole method tail, guard the block, not the return — the marking/adoption code above it must still run (see Step 1's third case).
- [ ] **Step 4: Run to green** — new test + the full desk driver test files.
- [ ] **Step 5: Commit (sensibull-desk)** — "feat(desk): the driver stands down while a repair executes".

---

### Task 16: Whole-tree verification

- [ ] **Step 1:** algomaker: `npm test -w apps/api && npm test -w apps/web && npm test -w apps/marketdata && npm test -w packages/payoff`, plus the repo's typecheck/build scripts (read root `package.json`; web dist builds with its build script).
- [ ] **Step 2:** sensibull-desk: `python -m pytest tests/ -x -q` (at minimum the desk/live test files).
- [ ] **Step 3:** Fix anything red; re-run to green.
- [ ] **Step 4:** Final commit of any stragglers; both repos clean `git status`.

---

## Deployment (operator-run, after review — NOT part of task execution)

Per spec §13 and the desk deploy-hazards doc: ship marketdata (quiet window) → desk-api alone → build web dist on the box → sensibull-desk pull + supervisor restart + verify the new behaviour in logs/Mongo (variants lesson: a running supervisor never picks up edits). `pm2` on prod is `npx pm2`. Do not restart desk-runner.
