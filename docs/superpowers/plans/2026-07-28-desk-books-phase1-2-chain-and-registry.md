# Desk Books Phases 1–2 — Chain Feed and Book Registry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve the Python driver everything it needs to price a chain — per-strike price, OI, ΔOI, volume, spot and the near-future, each with an age — and replace the hardcoded `BHEL_SEED` with a real book registry the UI can drive.

**Architecture:** Ticks for the whole chain already flow (`fullChain` is on by default at `apps/marketdata/src/main.ts:289`), but `md.tick` discards everything except price, and nothing exposes a chain over HTTP. Phase 1 widens the tick, adds the near-future token, and adds one endpoint. Phase 2 adds a `desk-books` collection with CRUD, and a variant catalogue the Python supervisor publishes so the UI never carries a hardcoded list.

**Tech Stack:** TypeScript, Node 24 (`node --test`, `.ts` run directly), MongoDB, npm workspaces.

## Global Constraints

- **Node >= 22**, ESM only. Import local modules **with the `.ts` extension**.
- **Tests are `node:test`**; Mongo-dependent tests skip themselves when no Mongo is reachable (`service.integration.test.ts:26`).
- **`exactOptionalPropertyTypes` is on.** Declare `readonly x?: T | undefined` when a caller may pass `undefined`.
- **Greeks returned by the chain endpoint are DISPLAY-ONLY** (spec D9). `BridgeStore` computes its own from the raw price. Never let an endpoint greek become the number the engine trades on.
- **Prod MongoDB is STANDALONE** — no change streams.
- **Never restart `desk-runner`** — it squares off positions on SIGTERM.
- **Depends on phase 0** (`2026-07-28-desk-books-phase0-tag-keying.md`) being merged: books are keyed `{tag, mode}` and `StoredBook` carries `tag`/`expiry`.
- Commit after every task.

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `apps/api/src/marks.ts` | Quote cache and mark policy | **Modify.** Cache `oi`/`volume`; expose `quote(token)` with `asOf` |
| `apps/marketdata/src/main.ts` | Feed host | **Modify.** Publish `oi`/`volume` on `md.tick`; subscribe the near-future |
| `apps/marketdata/src/subscription-source.ts` | Token planning | **Modify.** Add each book's near-future token |
| `apps/api/src/chain.ts` | Build the chain response from master + cache | **Create** |
| `apps/api/src/routes/desk.ts` | HTTP routing | **Modify.** Add `GET /v1/desk/chain/:underlying` |
| `apps/api/src/books-registry.ts` | `desk-books` registry rows and their rules | **Create** |
| `apps/api/src/routes/books.ts` | Registry CRUD + variant catalogue | **Create** |
| `apps/api/src/store.ts` | Persistence | **Modify.** Registry + catalogue collections |
| `apps/api/test/chain.test.ts` | Chain assembly | **Create** |
| `apps/api/test/books-registry.test.ts` | Registry rules and CRUD | **Create** |

---

### Task 1: Cache OI and volume, and expose a quote with its age

**Files:**
- Modify: `apps/api/src/marks.ts:79-200`
- Test: `apps/api/test/marks.test.ts` (extend)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `update(token: number, price: number, ts?: number, extra?: { oi?: number; volume?: number }): void`
  - `export interface Quote { readonly price: number; readonly oi: number | null; readonly volume: number | null; readonly asOf: number; readonly ageMs: number; readonly stale: boolean }`
  - `quote(token: number): Quote | null` — **live only**, same refusal as `mark()`: `null` when the feed is dead

**Why `asOf` per token:** feed-wide liveness cannot answer "is *this* strike live". `QuoteCache.#byToken` is never evicted and nothing restarts daily, so after an overnight run every strike from yesterday 15:30 still prices. The driver refuses a quote not stamped today — but only if the age reaches it.

- [ ] **Step 1: Write the failing test**

Append to `apps/api/test/marks.test.ts`:

```ts
test('quote carries oi, volume and the timestamp of the tick', () => {
  let now = 1_000_000
  const cache = new QuoteCache({ now: () => now })
  cache.update(700420, 15.4, 999_000, { oi: 123_400, volume: 8_800 })

  const q = cache.quote(700420)
  assert.ok(q)
  assert.equal(q.price, 15.4)
  assert.equal(q.oi, 123_400)
  assert.equal(q.volume, 8_800)
  assert.equal(q.asOf, 999_000)
  assert.equal(q.ageMs, 1_000)
})

test('quote is null when the feed is dead, even though the cache is full', () => {
  let now = 1_000_000
  const cache = new QuoteCache({ now: () => now, feedDeadAfterMs: 120_000 })
  cache.update(700420, 15.4, undefined, { oi: 1, volume: 2 })
  now += 200_000
  assert.equal(cache.quote(700420), null)
})

test('a tick without oi or volume leaves them null rather than zero', () => {
  const cache = new QuoteCache({ now: () => 1_000 })
  cache.update(700420, 15.4)
  assert.equal(cache.quote(700420)?.oi, null)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -w @algomaker/api -- --test-name-pattern="quote"`
Expected: FAIL — `quote` is not a function.

- [ ] **Step 3: Widen the cache entry**

In `apps/api/src/marks.ts`, change the `#byToken` entry type and `update`:

```ts
  readonly #byToken = new Map<
    number,
    { price: number; ts: number; oi: number | null; volume: number | null }
  >()
```

```ts
  /**
   * Called by the feed for every tick on a subscribed token.
   *
   * `oi`/`volume` are OPTIONAL and default to null rather than 0. Zero is a real
   * value on an illiquid strike, so defaulting to it would make "no data" and
   * "no interest" indistinguishable — and ΔOI would then read as a real change.
   */
  update(
    token: number,
    price: number,
    ts?: number,
    extra?: { oi?: number | undefined; volume?: number | undefined },
  ): void {
    if (!Number.isFinite(price) || price <= 0) return
    const at = ts ?? this.#now()
    this.#byToken.set(token, {
      price,
      ts: at,
      oi: Number.isFinite(extra?.oi) ? (extra?.oi as number) : null,
      volume: Number.isFinite(extra?.volume) ? (extra?.volume as number) : null,
    })
    this.#lastAnyTickMs = this.#now()
  }
```

- [ ] **Step 4: Add `quote`**

Beside `mark()`:

```ts
export interface Quote {
  readonly price: number
  readonly oi: number | null
  readonly volume: number | null
  /** Epoch ms of the tick this came from. */
  readonly asOf: number
  readonly ageMs: number
  readonly stale: boolean
}
```

```ts
  /**
   * A quote for the DECISION path: price plus the extras, with its own age.
   *
   * Refuses on a dead feed exactly as `mark()` does. `displayMark` is the
   * separate, deliberately more forgiving path for rendering.
   */
  quote(token: number): Quote | null {
    if (!this.feedAlive()) return null
    const e = this.#byToken.get(token)
    if (e === undefined) return null
    const ageMs = this.#now() - e.ts
    return {
      price: e.price,
      oi: e.oi,
      volume: e.volume,
      asOf: e.ts,
      ageMs,
      stale: ageMs > this.#staleAfterMs,
    }
  }
```

`snapshot()` and `displayMark()` read `.price`/`.ts` off the entry and keep working unchanged.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -w @algomaker/api -- --test-name-pattern="quote"`
Expected: 3 passing, and the rest of `marks.test.ts` still green.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/marks.ts apps/api/test/marks.test.ts
git commit -m "feat(api): cache oi and volume, expose a quote with its age

Feed-wide liveness cannot say whether one strike is live. oi/volume
default to null, not 0 — zero is a real value on an illiquid strike."
```

---

### Task 2: Publish OI and volume on `md.tick`

**Files:**
- Modify: `apps/marketdata/src/main.ts:255-265`
- Modify: `apps/api/src/main.ts:139` (the bus subscriber that feeds `QuoteCache`)
- Test: `apps/marketdata/test/market-data.test.ts` or `apps/api/test/feed-boot.test.ts` (extend)

**Interfaces:**
- Consumes: `QuoteCache.update(token, price, ts, extra)` from Task 1.
- Produces: `md.tick` payload becomes `{ token, price, ts, oi?, volume? }`.

**Why:** the feed already subscribes in `'full'` mode by default (`kite-feed.ts:138`), so OI and volume arrive in every packet and are discarded at the publish site.

- [ ] **Step 1: Write the failing test**

Append to `apps/marketdata/test/market-data.test.ts`:

```ts
test('md.tick carries oi and volume when the packet has them', () => {
  const published: Record<string, unknown>[] = []
  const bus = { publish: (_t: string, payload: Record<string, unknown>) => { published.push(payload) } }

  // The onTick handler under test — extract it from main.ts into a named
  // function `tickPayload(t, ts)` so it is testable without booting the host.
  bus.publish('md.tick', tickPayload(
    { instrument_token: 700420, last_price: 15.4, oi: 123400, volume_traded: 8800 } as never,
    1_700_000_000_000,
  ))

  assert.equal(published[0]?.['oi'], 123400)
  assert.equal(published[0]?.['volume'], 8800)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -w @algomaker/marketdata -- --test-name-pattern="md.tick carries"`
Expected: FAIL — `tickPayload` does not exist.

- [ ] **Step 3: Extract and widen the payload**

In `apps/marketdata/src/main.ts`, add above the pool construction:

```ts
/**
 * The `md.tick` payload.
 *
 * Extracted from the onTick closure so it is testable without booting the host.
 * `oi` and `volume` ride along because the feed already subscribes in 'full'
 * mode (`kite-feed.ts:138`) — they arrived in every packet and were dropped
 * here, which is why the chain endpoint had no open interest to serve.
 */
export function tickPayload(t: Tick, ts: number): Record<string, unknown> {
  return {
    token: t.instrument_token,
    price: t.last_price,
    ts,
    ...(Number.isFinite(t.oi) ? { oi: t.oi } : {}),
    ...(Number.isFinite(t.volume_traded) ? { volume: t.volume_traded } : {}),
  }
}
```

Read `packages/marketdata-core/src/index.ts:35-45` for the real `Tick` field names before writing this — if the volume field is not `volume_traded`, use whatever it actually is, and do not add a field to `Tick` that the feed never sets.

Replace the publish at `:262`:

```ts
      bus.publish('md.tick', tickPayload(t, ts), ts)
```

- [ ] **Step 4: Consume them on the API side**

In `apps/api/src/main.ts:139`, the subscriber currently calls `marks.update(token, price)`. Widen it:

```ts
      marks.update(Number(msg['token']), Number(msg['price']), Number(msg['ts']), {
        oi: typeof msg['oi'] === 'number' ? msg['oi'] : undefined,
        volume: typeof msg['volume'] === 'number' ? msg['volume'] : undefined,
      })
```

Read the actual subscriber before editing — the variable names here are indicative, the shape is not.

- [ ] **Step 5: Run both suites**

Run: `npm test -w @algomaker/marketdata && npm test -w @algomaker/api`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add apps/marketdata/src/main.ts apps/api/src/main.ts apps/marketdata/test apps/api/test
git commit -m "feat(marketdata): carry oi and volume on md.tick

Full-mode packets already had both; the publish site dropped them."
```

---

### Task 3: Subscribe the near-future

**Files:**
- Modify: `apps/marketdata/src/subscription-source.ts:28-115`
- Test: `apps/marketdata/test/subscription-source.test.ts` (extend)

**Interfaces:**
- Consumes: `StoredBook.symbol` (phase 0).
- Produces: `SubscriptionResolver` gains `futureToken(underlying: string): number | null`; `SubscriptionPlan.tokens` includes each book's near-future.

**Why:** spec D9. Research prices Black-76 off the near future — `GfdlStore.spot_ref` returns `future(...)["close"]` and `mark()` inverts IV with `F = future = S`. Without the future token subscribed, `BridgeStore` cannot reproduce the research forward and the ctx matches neither engine. `OptionMaster.future(underlying, expiry?)` (`master.ts:321`) already resolves it — the master needs no change.

- [ ] **Step 1: Write the failing test**

Append to `apps/marketdata/test/subscription-source.test.ts`:

```ts
test('each book contributes its near-future token', () => {
  const plan = planSubscriptions({
    books: [{ symbol: 'BHEL', expiry: '2026-08-25', legs: [] }],
    resolver: testResolver(),   // extend the existing helper with futureToken
    fullChain: true,
  })
  assert.ok(plan.tokens.includes(FUTURE_TOKEN), 'near-future token not subscribed')
})
```

Define `FUTURE_TOKEN` in the test file and return it from the helper's `futureToken`.

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -w @algomaker/marketdata -- --test-name-pattern="near-future token"`
Expected: FAIL — the token is absent.

- [ ] **Step 3: Add it to the resolver port and the plan**

`subscription-source.ts`, in `SubscriptionResolver`:

```ts
  /**
   * The near-expiry future. It is the research FORWARD (spec D9): options are
   * priced Black-76 off it, so an unsubscribed future means the live ctx cannot
   * reproduce the backtest's own numbers.
   */
  futureToken(underlying: string): number | null
```

In `planSubscriptions`, inside the per-underlying block beside the spot lookup:

```ts
    const fut = input.resolver.futureToken(underlying)
    if (fut !== null) tokens.add(fut)
```

- [ ] **Step 4: Implement it at the host**

In `apps/marketdata/src/main.ts`, the object passed as `resolver` wraps `OptionMaster`. Add:

```ts
        futureToken: (underlying: string): number | null =>
          master.current().future(underlying)?.instrumentToken ?? null,
```

- [ ] **Step 5: Run the suite**

Run: `npm test -w @algomaker/marketdata`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add apps/marketdata/src apps/marketdata/test
git commit -m "feat(marketdata): subscribe each book's near-future token

The research forward: options are priced Black-76 off the future, so an
unsubscribed future makes the live ctx unable to match the backtest."
```

---

### Task 4: `GET /v1/desk/chain/:underlying`

**Files:**
- Create: `apps/api/src/chain.ts`
- Modify: `apps/api/src/routes/desk.ts` (add the route beside `/v1/desk/instruments/`)
- Test: `apps/api/test/chain.test.ts` (create)

**Interfaces:**
- Consumes: `QuoteCache.quote` (Task 1), `OptionMaster.strikes/resolve/expiries/future/spotToken`.
- Produces:

```ts
export interface ChainRow {
  readonly strike: number
  readonly CE: ChainQuote | null
  readonly PE: ChainQuote | null
}
export interface ChainQuote {
  readonly price: number
  readonly oi: number | null
  readonly volume: number | null
  readonly asOf: number
  readonly ageMs: number
}
export interface ChainResponse {
  readonly underlying: string
  readonly expiry: string
  readonly spot: number | null
  readonly spotAsOf: number | null
  readonly future: number | null
  readonly futureAsOf: number | null
  readonly step: number | null
  readonly lotSize: number | null
  readonly rows: readonly ChainRow[]
  readonly feedAlive: boolean
}
export function buildChain(deps: ChainDeps, underlying: string, expiry: string): ChainResponse
```

**Every listed strike is returned**, with `null` where it has not ticked. An absent strike and a strike with no trades are different facts, and the driver needs to tell them apart.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/chain.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { OptionMaster, type InstrumentRow } from '@algomaker/instruments'
import { QuoteCache } from '../src/marks.ts'
import { buildChain } from '../src/chain.ts'

const EXPIRY = '2026-08-25'

function master(): OptionMaster {
  const rows: InstrumentRow[] = []
  for (const strike of [415, 417.5, 420]) {
    for (const type of ['CE', 'PE'] as const) {
      rows.push({
        instrument_token: 700000 + strike * 10 + (type === 'CE' ? 1 : 2),
        tradingsymbol: `BHEL26AUG${strike}${type}`,
        name: 'BHEL', expiry: EXPIRY, strike, tick_size: 0.05, lot_size: 2625,
        instrument_type: type, segment: 'NFO-OPT', exchange: 'NFO',
      })
    }
  }
  rows.push({
    instrument_token: 600001, tradingsymbol: 'BHEL26AUGFUT', name: 'BHEL', expiry: EXPIRY,
    strike: 0, tick_size: 0.05, lot_size: 2625, instrument_type: 'FUT',
    segment: 'NFO-FUT', exchange: 'NFO',
  })
  return new OptionMaster(rows)
}

test('every listed strike is returned, unticked ones as null', () => {
  const m = master()
  const marks = new QuoteCache({ now: () => 1_000_000 })
  marks.update(m.resolve('BHEL', EXPIRY, 420, 'CE')!.instrumentToken!, 15.4, 999_000, { oi: 1200, volume: 90 })

  const chain = buildChain({ master: m, marks, now: () => 1_000_000 }, 'BHEL', EXPIRY)

  assert.equal(chain.rows.length, 3)
  const at420 = chain.rows.find((r) => r.strike === 420)
  assert.equal(at420?.CE?.price, 15.4)
  assert.equal(at420?.CE?.oi, 1200)
  assert.equal(at420?.CE?.asOf, 999_000)
  // Listed but never ticked — present, and honestly empty.
  assert.equal(chain.rows.find((r) => r.strike === 415)?.CE, null)
})

test('the inferred strike step is served, not a configured one', () => {
  const chain = buildChain({ master: master(), marks: new QuoteCache(), now: () => 1 }, 'BHEL', EXPIRY)
  assert.equal(chain.step, 2.5)
})

test('a dead feed yields no prices but still lists the strikes', () => {
  const m = master()
  const marks = new QuoteCache({ now: () => 10_000_000, feedDeadAfterMs: 120_000 })
  marks.update(m.resolve('BHEL', EXPIRY, 420, 'CE')!.instrumentToken!, 15.4, 1_000)

  const chain = buildChain({ master: m, marks, now: () => 10_000_000 }, 'BHEL', EXPIRY)
  assert.equal(chain.feedAlive, false)
  assert.equal(chain.rows.length, 3)
  assert.equal(chain.rows.find((r) => r.strike === 420)?.CE, null)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -w @algomaker/api -- --test-name-pattern="listed strike|strike step|dead feed"`
Expected: FAIL — `Cannot find module '../src/chain.ts'`.

- [ ] **Step 3: Write the builder**

Create `apps/api/src/chain.ts`:

```ts
/**
 * The option chain as the Python desk consumes it.
 *
 * RAW PRICES ONLY, and deliberately. Greeks are not served here as inputs: the
 * desk computes IV and greeks itself, Black-76 off the near future, exactly as
 * `GfdlStore.mark` does in the backtest (spec D9). Serving a Black-Scholes-on-
 * cash-spot delta from here and letting it reach `ctx` would produce a book
 * marked by a model that matches neither engine.
 *
 * EVERY LISTED STRIKE IS RETURNED. A strike absent from the exchange and a
 * strike that simply has not traded are different facts, and the desk must be
 * able to tell them apart: the first cannot be opened at all, the second can be
 * opened once it prints.
 */

import type { OptionMaster } from '@algomaker/instruments'
import type { QuoteCache } from './marks.ts'

export interface ChainQuote {
  readonly price: number
  readonly oi: number | null
  readonly volume: number | null
  readonly asOf: number
  readonly ageMs: number
}

export interface ChainRow {
  readonly strike: number
  readonly CE: ChainQuote | null
  readonly PE: ChainQuote | null
}

export interface ChainResponse {
  readonly underlying: string
  readonly expiry: string
  readonly spot: number | null
  readonly spotAsOf: number | null
  readonly future: number | null
  readonly futureAsOf: number | null
  readonly step: number | null
  readonly lotSize: number | null
  readonly rows: readonly ChainRow[]
  readonly feedAlive: boolean
}

export interface ChainDeps {
  readonly master: OptionMaster
  readonly marks: QuoteCache
  readonly now: () => number
}

function quoteFor(deps: ChainDeps, token: number | undefined): ChainQuote | null {
  if (token === undefined) return null
  const q = deps.marks.quote(token)
  if (q === null) return null
  return { price: q.price, oi: q.oi, volume: q.volume, asOf: q.asOf, ageMs: q.ageMs }
}

export function buildChain(deps: ChainDeps, underlying: string, expiry: string): ChainResponse {
  const master = deps.master
  const meta = master.chain(underlying, expiry)

  const rows: ChainRow[] = []
  for (const strike of master.strikes(underlying, expiry)) {
    rows.push({
      strike,
      CE: quoteFor(deps, master.resolve(underlying, expiry, strike, 'CE')?.instrumentToken),
      PE: quoteFor(deps, master.resolve(underlying, expiry, strike, 'PE')?.instrumentToken),
    })
  }

  const spotToken = master.spotToken(underlying)
  const spotQuote = spotToken === null ? null : deps.marks.quote(spotToken)
  const futureToken = master.future(underlying)?.instrumentToken
  const futureQuote = quoteFor(deps, futureToken)

  return {
    underlying,
    expiry,
    spot: deps.marks.spot(underlying) ?? spotQuote?.price ?? null,
    spotAsOf: spotQuote?.asOf ?? null,
    future: futureQuote?.price ?? null,
    futureAsOf: futureQuote?.asOf ?? null,
    step: meta?.step ?? null,
    lotSize: meta?.lotSize ?? null,
    rows,
    feedAlive: deps.marks.feedAlive(),
  }
}
```

Read `ChainMeta` in `packages/instruments/src/master.ts:255-270` and use its real field names for `step`/`lotSize`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -w @algomaker/api -- --test-name-pattern="listed strike|strike step|dead feed"`
Expected: 3 passing.

- [ ] **Step 5: Add the route**

In `apps/api/src/routes/desk.ts`, beside the `/v1/desk/instruments/` prefix match near the end of the handler:

```ts
    if (method === 'GET') {
      const chainFor = suffixOf(path, '/v1/desk/chain/')
      if (chainFor !== null) {
        const m = master.current()
        const expiry = url.searchParams.get('expiry') ?? m.expiries(chainFor)[0]
        if (expiry === undefined) {
          send(404, { error: `no listed expiries for '${chainFor}'` })
          return true
        }
        send(200, buildChain({ master: m, marks: deps.marks, now: () => Date.now() }, chainFor, expiry))
        return true
      }
    }
```

Confirm `deps` exposes the `QuoteCache` and under what name — read `ApiDeps` in `apps/api/src/routes/kit.ts` first.

- [ ] **Step 6: Verify against the running system**

```bash
curl -s -H "Authorization: Bearer $DESK_API_TOKEN" \
  'http://127.0.0.1:8790/v1/desk/chain/BHEL?expiry=2026-08-25' \
  | jq '{rows: (.rows|length), step, lotSize, spot, future, priced: [.rows[] | select(.CE != null)] | length}'
```

Expected during market hours: `step` 2.5, `lotSize` 2625, a non-null `future`, and `priced` well above zero. `rows` should be the full listed count, not only the priced ones.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/chain.ts apps/api/src/routes/desk.ts apps/api/test/chain.test.ts
git commit -m "feat(api): serve the option chain with oi, volume and per-quote age

Raw prices only — the desk computes its own Black-76 greeks off the
future (D9). Every listed strike is returned; unticked ones are null."
```

---

### Task 5: The `desk-books` registry

**Files:**
- Create: `apps/api/src/books-registry.ts`
- Create: `apps/api/src/routes/books.ts`
- Modify: `apps/api/src/store.ts` (collection + indexes), `apps/api/src/server.ts` (mount the route)
- Test: `apps/api/test/books-registry.test.ts` (create)

**Interfaces:**
- Consumes: phase 0's tag keying.
- Produces:

```ts
export type BookState = 'stopped' | 'running'
export interface BookRow {
  readonly tag: string
  readonly symbol: string
  readonly expiry: string
  readonly mode: DeskMode
  readonly variant: string
  readonly dials: Readonly<Record<string, number>>
  readonly desired: BookState
  readonly actual: BookState
  readonly lastMarkAt: number
  readonly lastDecision: string
  readonly createdAt: number
  readonly updatedAt: number
}
export function validateBookCreate(raw: unknown): Validated<BookCreate>
export const DEFAULT_BOOK: Omit<BookRow, 'tag' | 'symbol' | 'expiry' | 'mode' | 'variant'>
```

**Rule carried from `DEFAULT_STRATEGY` (`strategies.ts:139-151`): a created book is `desired: 'stopped'`.** Creating a book is never itself a trading permission.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/books-registry.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateBookCreate, DEFAULT_BOOK } from '../src/books-registry.ts'

test('a created book starts stopped', () => {
  assert.equal(DEFAULT_BOOK.desired, 'stopped')
  assert.equal(DEFAULT_BOOK.actual, 'stopped')
})

test('create requires tag, symbol, expiry, mode and variant', () => {
  const bad = validateBookCreate({ symbol: 'BHEL', expiry: '2026-08-25', mode: 'paper' })
  assert.equal(bad.ok, false)
  assert.match(bad.ok === false ? bad.error : '', /tag/)
})

test('create rejects a mode that was not stated explicitly', () => {
  const bad = validateBookCreate({
    tag: 'BHEL-2026-08-25-hold-recycle-r', symbol: 'BHEL', expiry: '2026-08-25',
    variant: 'hold-recycle-r',
  })
  assert.equal(bad.ok, false)
  assert.match(bad.ok === false ? bad.error : '', /mode/)
})

test('a valid create carries its dials through', () => {
  const ok = validateBookCreate({
    tag: 'BHEL-2026-08-25-hold-recycle-r', symbol: 'BHEL', expiry: '2026-08-25',
    mode: 'paper', variant: 'hold-recycle-r',
    dials: { target_pnl: 250000, margin_cap: 100000000 },
  })
  assert.equal(ok.ok, true)
  assert.equal(ok.ok === true ? ok.value.dials['target_pnl'] : 0, 250000)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -w @algomaker/api -- --test-name-pattern="created book|create requires|create rejects|dials through"`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the registry module**

Create `apps/api/src/books-registry.ts`, following the shape and reasoning of `apps/api/src/strategies.ts` (read it first — reuse its `Validated`, `ok`, `fail`, `isObject`, `isNonEmptyString`, `isIsoDate` helpers from `validate.ts` rather than writing new ones):

```ts
/**
 * The book registry: one row per managed positional book.
 *
 * Distinct from `desk-strategies`, which registers an intraday order-bus tag.
 * A positional book has an expiry, a variant and a lifecycle, and it is the
 * thing the supervisor converges on. The two share a tag namespace — a book's
 * tag is ALSO registered as a strategy row, because `applyDecision` throws
 * UnknownStrategy for a tag with no registry row (`service.ts:302`).
 *
 * `desired` is the operator's intent; `actual` is what the supervisor reports.
 * They are separate fields because the gap between them is the interesting
 * state — "asked to run, not running" is precisely what an operator needs to
 * see, and a single field cannot say it.
 */
```

with `DEFAULT_BOOK` (stopped, empty dials, zeroed timestamps) and `validateBookCreate` checking: `tag` non-empty, `symbol` non-empty, `expiry` an ISO date, `mode` explicitly `'paper' | 'live'` (never defaulted — the same rule as `validateSeedRequest` at `validate.ts:159-161`), `variant` non-empty, and `dials` an optional record of finite numbers.

- [ ] **Step 4: Persist and index**

In `apps/api/src/store.ts`, add `booksRegistry: 'desk-books-registry'` to `COLLECTIONS` — **not** `desk-books`, which phase 0 already uses for the leg-level book — and in `ensureIndexes`:

```ts
    await this.#db
      .collection(COLLECTIONS.booksRegistry)
      .createIndex({ tag: 1, mode: 1 }, { unique: true })
```

Add `listBooks(mode)`, `getBook(tag, mode)`, `upsertBook(row)`, `setDesired(tag, mode, desired)`, `setActual(tag, mode, actual, lastMarkAt, lastDecision)`.

- [ ] **Step 5: Add the routes**

Create `apps/api/src/routes/books.ts` following `apps/api/src/routes/brokers.ts`'s prefix-dispatch shape:

- `GET /v1/desk/books/registry?mode=` → rows
- `POST /v1/desk/books/registry` → create (validated, always stopped)
- `POST /v1/desk/books/registry/:tag/start` → `desired: 'running'`
- `POST /v1/desk/books/registry/:tag/stop` → `desired: 'stopped'`
- `PATCH /v1/desk/books/registry/:tag` → dials only

Creating a book must **also** upsert a `desk-strategies` row for the same tag, added to the book's mode but **switched off**, so that the first decision does not 403 and the operator still has to switch it on deliberately.

Mount it in `apps/api/src/server.ts` beside the existing route modules.

- [ ] **Step 6: Run the suite**

Run: `npm test -w @algomaker/api`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/books-registry.ts apps/api/src/routes/books.ts apps/api/src/store.ts apps/api/src/server.ts apps/api/test/books-registry.test.ts
git commit -m "feat(api): book registry with desired/actual lifecycle

A created book is stopped and switched off — creating is not itself a
trading permission. desired and actual are separate so 'asked to run,
not running' is expressible."
```

---

### Task 6: The variant catalogue

**Files:**
- Modify: `apps/api/src/routes/books.ts`, `apps/api/src/store.ts`
- Test: `apps/api/test/books-registry.test.ts` (extend)

**Interfaces:**
- Produces:
  - `POST /v1/desk/variants` — body `{ variants: [{ key, decider, playbook, defaults }] }`, replaces the cached catalogue wholesale
  - `GET /v1/desk/variants` — the cached catalogue

**Why published rather than hardcoded:** the UI dropdown must be exactly what the deployed Python can run. The supervisor posts `sim.variants.list_variants()` filtered to `decider: 'rule-engine'` on start — the registry is mixed (`llm`, `hybrid`, `rule-engine`), and the others shell out to the `claude` CLI, so they are not offerable as unattended books.

- [ ] **Step 1: Write the failing test**

```ts
test('the catalogue is replaced wholesale, not merged', async (t) => {
  if (!available) return t.skip('no mongo')
  await store.putVariants([{ key: 'hold-recycle-r', decider: 'rule-engine', playbook: 'hold-recycle', defaults: { target_pnl: 250000 } }])
  await store.putVariants([{ key: 'guard-r', decider: 'rule-engine', playbook: 'guard', defaults: {} }])

  const rows = await store.listVariants()
  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.key, 'guard-r')
})
```

**Wholesale replacement is the point:** a merge would leave a variant in the dropdown after it was deleted from `sim/variants.py`, and an operator could then create a book the supervisor cannot run.

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -w @algomaker/api -- --test-name-pattern="catalogue is replaced"`
Expected: FAIL — `putVariants` is not a function.

- [ ] **Step 3: Implement**

Add `COLLECTIONS.variants = 'desk-variants'`, then:

```ts
  /** Replace the catalogue wholesale. See the route's comment for why not merge. */
  async putVariants(rows: readonly VariantRow[]): Promise<void> {
    const col = this.#db.collection(COLLECTIONS.variants)
    await col.deleteMany({})
    if (rows.length > 0) await col.insertMany([...rows])
  }

  async listVariants(): Promise<VariantRow[]> {
    return await this.#db.collection<VariantRow>(COLLECTIONS.variants).find({}).toArray()
  }
```

Add `insertMany` and `deleteMany` to the `Collection` port if absent. Then the two routes in `routes/books.ts`.

- [ ] **Step 4: Run the suite**

Run: `npm test -w @algomaker/api`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src apps/api/test
git commit -m "feat(api): variant catalogue published by the supervisor

Replaced wholesale, not merged: a stale entry would let an operator
create a book the deployed Python cannot run."
```

---

### Task 7: Retire `BHEL_SEED`

**Files:**
- Modify: `apps/api/src/seed.ts:131-145` (delete the constant), `apps/api/src/cli.ts` (replace `seed-bhel`)
- Test: `apps/api/test/registry-seed.test.ts` (adjust)

**Interfaces:** removes `BHEL_SEED`; `seed-bhel` becomes `seed --file <json>`.

**Do this LAST in the phase.** `BHEL_SEED` is the phase-0 migration's rollback path, and it stops being one only once the registry can create the same book.

- [ ] **Step 1: Add the generic command**

Replace the `seed-bhel` case in `apps/api/src/cli.ts`:

```ts
      case 'seed': {
        const file = arg('--file')
        if (file === undefined) {
          console.error('usage: seed --file <path-to-seed.json> [--replace]')
          process.exitCode = 2
          break
        }
        const parsed = validateSeedRequest(JSON.parse(await readFile(file, 'utf8')))
        if (!parsed.ok) {
          console.error(parsed.error)
          process.exitCode = 2
          break
        }
        const master = new OptionMaster(await loadStoredInstruments(mongo.db.collection('instrument')))
        const res = await seedBook(
          { ...parsed.value, replace: has('--replace') },
          { store, master, nowMs: Date.now(), replace: has('--replace') },
        )
        console.log(JSON.stringify(res, null, 2))
        break
      }
```

Import `readFile` from `node:fs/promises` and `validateSeedRequest` from `./validate.ts`. Match `seedBook`'s real deps object — read `seed.ts:95-115`.

- [ ] **Step 2: Record the existing seed as a file**

```bash
mkdir -p seeds
cat > seeds/BHEL-2026-08-25-hold-recycle-r.json <<'JSON'
{
  "tag": "BHEL-2026-08-25-hold-recycle-r",
  "symbol": "BHEL",
  "expiry": "2026-08-25",
  "mode": "paper",
  "legs": [
    { "strike": 420, "type": "CE", "qty": -13125, "rate": 15 },
    { "strike": 425, "type": "CE", "qty": -13125, "rate": 13 },
    { "strike": 430, "type": "CE", "qty": -13125, "rate": 11 },
    { "strike": 470, "type": "CE", "qty": 39375, "rate": 2.9 },
    { "strike": 415, "type": "PE", "qty": -13125, "rate": 14 },
    { "strike": 410, "type": "PE", "qty": -13125, "rate": 12 },
    { "strike": 405, "type": "PE", "qty": -13125, "rate": 9 },
    { "strike": 380, "type": "PE", "qty": 39375, "rate": 3.55 }
  ]
}
JSON
```

This is `BHEL_SEED` verbatim from `seed.ts:131-145` plus its tag. **Verify each rate against the constant before deleting it** — these are the cost basis.

- [ ] **Step 3: Delete the constant**

Remove `BHEL_SEED` from `seed.ts` and its import from `cli.ts`. Update `apps/api/test/registry-seed.test.ts` to load the JSON file instead.

- [ ] **Step 4: Verify**

```bash
npm test -w @algomaker/api
node apps/api/src/cli.ts seed --file seeds/BHEL-2026-08-25-hold-recycle-r.json
```

Expected: suite green; the seed reports a 409-equivalent (`replace` not asked for, book non-empty) — proving it refuses to overwrite the live book.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/seed.ts apps/api/src/cli.ts apps/api/test seeds/
git commit -m "refactor(api): seed from a file, not a compiled-in constant

BHEL_SEED was the only way to create a book without editing TypeScript."
```

---

## Phase exit condition

```bash
npm test -w @algomaker/api && npm test -w @algomaker/marketdata
curl -s -H "Authorization: Bearer $DESK_API_TOKEN" 'http://127.0.0.1:8790/v1/desk/chain/BHEL?expiry=2026-08-25' \
  | jq '{rows:(.rows|length), future, step, withOi: [.rows[]|select(.CE.oi != null)]|length}'
curl -s -H "Authorization: Bearer $DESK_API_TOKEN" 'http://127.0.0.1:8790/v1/desk/books/registry?mode=paper' | jq '.[0].desired'
```

Expected: suites green; the chain returns every listed strike with a non-null `future`, `step` 2.5, and a non-zero `withOi` during market hours; the registry lists the BHEL book as `"stopped"`.

## Self-review

**Spec coverage:** implements spec §8 phases 1 and 2, and specifically §3.1's chain endpoint / `oi`+`volume` on `md.tick` / near-future subscription / per-quote `asOf` / `desk-books` registry / `POST /v1/desk/variants` with the rule-engine subset, plus §3.2.1's price-and-OI source for `BridgeStore`.

**Deliberately deferred:** ΔOI is *not* computed here. `raw_chain`'s `d_oi_cp` needs the previous checkpoint, which the bridge does not store — spec §3.2.1 puts that memoization in `BridgeStore`, phase 3. This endpoint serves absolute OI only, which is what that memoization needs.

**Type consistency check:** `Quote` (Task 1) is the cache's type; `ChainQuote` (Task 4) is the wire type and deliberately drops `stale` — the driver decides staleness from `asOf` against its own session clock, not from the bridge's 60s threshold. `COLLECTIONS.booksRegistry` is `desk-books-registry`, distinct from phase 0's `desk-books`; using one name for both would have made the registry overwrite the legs.

**Ordering:** Task 7 must come after Task 5, since it removes the phase-0 rollback path and the registry is what replaces it. Tasks 1→2 and 3 are independent of 5→6; a second agent can take 5 and 6 while the first takes 1–4.
