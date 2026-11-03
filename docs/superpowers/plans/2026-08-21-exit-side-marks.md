# Exit-Side Marks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** P&L and unrealized value price off the order book's exit side (long→bid, short→ask), never LTP; the bid/ask pair is wired end-to-end with basis and age visible.

**Architecture:** The `QuoteCache` keeps the last two-sided book frame per token (LTP-only ticks age it instead of erasing it) and gains direction-aware reads. The P&L mark resolver in `pnl-jobs.ts` fills the existing `Marks` map with exit-side prices — the shared `@algomaker/pnl` package does not change. Rows gain a parallel `quotes` block so the stream and the positions endpoint carry the pair + basis to the web, which shows it and badges anything not priced off a live book.

**Tech Stack:** TypeScript (Node 24, `node --test`), React (apps/web), MongoDB.

**Spec:** `docs/superpowers/specs/2026-08-21-exit-side-marks-design.md`

## Global Constraints

- LTP is never a valuation basis for P&L/unrealized/display marks. Candles, index spot, and journalled fill prices are data, not valuation — out of scope, do not touch.
- A leg with no book frame ever seen is `null` (unpriced) — never 0, never an LTP stand-in. Existing null-propagation (`complete`, `unpriced`) contracts must keep passing.
- Order-path files are OFF LIMITS (another agent's worktree): `safety.ts`, `flatten.ts`, `submit*.ts`, `marketable.ts`, `chain.ts`, `decision-plan.ts`, and `QuoteCache.price()`/`quote()`/`displayQuote()` semantics.
- Work in an isolated worktree (`superpowers:using-git-worktrees`) — another agent has its own worktree on this repo.
- Run tests from `apps/api` with `npm test` (`node --test test/*.test.ts`); whole repo: `npm test` at root.

---

### Task 1: QuoteCache — persistent book frame + `exitQuote` / `displayExitQuote`

**Files:**
- Modify: `apps/api/src/marks.ts`
- Test: `apps/api/test/marks.test.ts` (append; existing tests must keep passing)

**Interfaces:**
- Consumes: existing `QuoteCache.update(token, price, ts, extra)` call shape (api `main.ts:289` already passes `bid`/`ask`).
- Produces (later tasks rely on these exact names):

```ts
export type ExitSide = 'Buy' | 'Sell'   // the ORDER side that would close the leg
export type MarkBasis = 'bid' | 'ask' | 'mid' | 'snapshot'
export interface ExitQuote {
  readonly price: number
  readonly basis: MarkBasis
  readonly bid: number
  readonly ask: number
  /** Epoch ms of the book frame this came from. */
  readonly asOf: number
  readonly ageMs: number
  readonly stale: boolean
}
// live only (feed-gated) — the P&L path:
exitQuote(token: number, exit: ExitSide | null): ExitQuote | null
// falls back to the persisted pair snapshot — the display path:
displayExitQuote(token: number, exit: ExitSide | null): ExitQuote | null
```

- [ ] **Step 1: Write the failing tests** (append to `apps/api/test/marks.test.ts`, following its existing style — it constructs `new QuoteCache({ now: () => fakeNow })`):

```ts
describe('exitQuote', () => {
  it('values the exit side of the last two-sided frame', () => {
    let now = 1_000_000
    const c = new QuoteCache({ now: () => now })
    c.update(1, 10, now, { bid: 9.8, ask: 10.2 })
    assert.deepEqual(c.exitQuote(1, 'Sell')?.price, 9.8)   // closing a long sells at bid
    assert.equal(c.exitQuote(1, 'Sell')?.basis, 'bid')
    assert.equal(c.exitQuote(1, 'Buy')?.price, 10.2)       // closing a short buys at ask
    assert.equal(c.exitQuote(1, 'Buy')?.basis, 'ask')
    assert.equal(c.exitQuote(1, null)?.price, 10)          // no direction → mid
    assert.equal(c.exitQuote(1, null)?.basis, 'mid')
  })

  it('an LTP-only tick ages the book frame instead of erasing it', () => {
    let now = 1_000_000
    const c = new QuoteCache({ now: () => now })
    c.update(1, 10, now, { bid: 9.8, ask: 10.2 })
    now += 30_000
    c.update(1, 11, now) // trade print, no depth
    const q = c.exitQuote(1, 'Buy')
    assert.equal(q?.price, 10.2)          // still the book, not the print
    assert.equal(q?.asOf, 1_000_000)      // frame's own timestamp
    assert.equal(q?.ageMs, 30_000)        // aged, and says so
  })

  it('no book frame ever seen → null, never an LTP stand-in', () => {
    let now = 1_000_000
    const c = new QuoteCache({ now: () => now })
    c.update(1, 10, now) // LTP only, forever
    assert.equal(c.exitQuote(1, 'Buy'), null)
    assert.equal(c.exitQuote(1, null), null)
  })

  it('refuses on a dead feed exactly as mark() does', () => {
    let now = 1_000_000
    const c = new QuoteCache({ now: () => now, feedDeadAfterMs: 120_000 })
    c.update(1, 10, now, { bid: 9.8, ask: 10.2 })
    now += 300_000
    assert.equal(c.exitQuote(1, 'Buy'), null)
  })

  it('displayExitQuote falls back to a persisted pair, basis snapshot', () => {
    let now = 1_000_000
    const c = new QuoteCache({ now: () => now })
    c.loadSnapshot([{ token: 1, price: 10, ts: 900_000, bid: 9.8, ask: 10.2 }])
    const q = c.displayExitQuote(1, 'Buy')
    assert.equal(q?.price, 10.2)
    assert.equal(q?.basis, 'snapshot')
    assert.equal(q?.stale, true)
    // a legacy snapshot row without a pair prices NOTHING here:
    c.loadSnapshot([{ token: 2, price: 5, ts: 900_000 }])
    assert.equal(c.displayExitQuote(2, 'Buy'), null)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && npm test 2>&1 | grep -A2 exitQuote | head -30`
Expected: FAIL — `exitQuote is not a function`.

- [ ] **Step 3: Implement in `marks.ts`**

1. Extend the `#byToken` entry type with `book: { bid: number; ask: number; ts: number } | null`.
2. In `update()`, replace the entry write so the frame persists (the existing `bothSides` guard is already there):

```ts
    const prev = this.#byToken.get(token)
    this.#byToken.set(token, {
      price,
      ts: at,
      oi: Number.isFinite(extra?.oi) ? (extra?.oi as number) : null,
      volume: Number.isFinite(extra?.volume) ? (extra?.volume as number) : null,
      bid: bothSides ? bid : null,
      ask: bothSides ? ask : null,
      // The last TWO-SIDED frame survives LTP-only ticks: valuation prices off
      // the book, and a book that stopped is old, not gone. Its own ts says how old.
      book: bothSides ? { bid: bid as number, ask: ask as number, ts: at } : (prev?.book ?? null),
    })
```

3. Add the types and the two methods (place beside `mark()`/`displayMark()`):

```ts
export type ExitSide = 'Buy' | 'Sell'
export type MarkBasis = 'bid' | 'ask' | 'mid' | 'snapshot'
export interface ExitQuote {
  readonly price: number
  readonly basis: MarkBasis
  readonly bid: number
  readonly ask: number
  readonly asOf: number
  readonly ageMs: number
  readonly stale: boolean
}

function exitPick(bid: number, ask: number, exit: ExitSide | null): { price: number; basis: 'bid' | 'ask' | 'mid' } {
  if (exit === 'Sell') return { price: bid, basis: 'bid' }
  if (exit === 'Buy') return { price: ask, basis: 'ask' }
  return { price: (bid + ask) / 2, basis: 'mid' }
}
```

```ts
  /**
   * The valuation read: the exit side of the last two-sided book frame.
   * LTP NEVER SUBSTITUTES (operator directive 2026-08-21) — a contract whose
   * book has never been seen is unpriced, and the total goes incomplete the
   * same way an unmarked leg always has. Feed-gated exactly like `mark()`.
   */
  exitQuote(token: number, exit: ExitSide | null): ExitQuote | null {
    if (!this.feedAlive()) return null
    const book = this.#byToken.get(token)?.book
    if (book === undefined || book === null) return null
    const ageMs = this.#now() - book.ts
    const picked = exitPick(book.bid, book.ask, exit)
    return { ...picked, bid: book.bid, ask: book.ask, asOf: book.ts, ageMs, stale: ageMs > this.#staleAfterMs }
  }

  /**
   * `exitQuote`'s rule with `displayMark`'s forgiveness: past the feed gate and
   * down to the persisted pair. A snapshot row that never carried a pair prices
   * nothing here — display may be old, it may not be a last print.
   */
  displayExitQuote(token: number, exit: ExitSide | null): ExitQuote | null {
    const live = this.exitQuote(token, exit)
    if (live !== null) return live
    const held = this.#byToken.get(token)?.book
    const fromSnap = this.#snapshot.get(token)
    const book = held ?? (fromSnap !== undefined && fromSnap.bid !== null && fromSnap.ask !== null
      ? { bid: fromSnap.bid, ask: fromSnap.ask, ts: fromSnap.ts }
      : null)
    if (book === null) return null
    const picked = exitPick(book.bid, book.ask, exit)
    return {
      price: picked.price,
      basis: 'snapshot',
      bid: book.bid,
      ask: book.ask,
      asOf: book.ts,
      ageMs: this.#now() - book.ts,
      stale: true,
    }
  }
```

(Task 2 changes `#snapshot`'s value type to carry `bid`/`ask`; implement both tasks' `marks.ts` edits together if that ordering is simpler, but keep the commits separate.)

- [ ] **Step 4: Run tests to verify pass**

Run: `cd apps/api && npm test 2>&1 | tail -5`
Expected: all pass, including every pre-existing `marks.test.ts` case.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/marks.ts apps/api/test/marks.test.ts
git commit -m "feat(desk): QuoteCache keeps the last two-sided book frame and answers exit-side quotes"
```

---

### Task 2: Snapshot parity — the pair survives restarts and market close

**Files:**
- Modify: `apps/api/src/marks.ts` (`MarkSnapshot`, `#snapshot`, `loadSnapshot`)
- Modify: `apps/marketdata/src/main.ts` (`lastPrice` map ~line 822, snapshot writer ~line 1104)
- Modify: `apps/api/src/main.ts` (`loadMarkSnapshot` ~line 351)
- Test: `apps/api/test/marks.test.ts` (the snapshot case from Task 1 Step 1 covers the api side)

**Interfaces:**
- Produces: `MarkSnapshot` gains `readonly bid?: number | null; readonly ask?: number | null` — optional so every existing constructor site stays valid. `desk-marks` documents gain `bid`/`ask` (nullable) beside `price`/`ts`.

- [ ] **Step 1: api side — extend `MarkSnapshot` and the `#snapshot` store**

```ts
export interface MarkSnapshot {
  readonly token: number
  readonly price: number
  readonly ts: number
  /** Last two-sided book frame, when the writer had one. Both or neither. */
  readonly bid?: number | null
  readonly ask?: number | null
}
```

`#snapshot` value type becomes `{ price: number; ts: number; bid: number | null; ask: number | null }`; in `loadSnapshot`:

```ts
  loadSnapshot(rows: Iterable<MarkSnapshot>): void {
    for (const r of rows) {
      if (!Number.isFinite(r.price) || r.price <= 0) continue
      const paired =
        typeof r.bid === 'number' && Number.isFinite(r.bid) && r.bid > 0 &&
        typeof r.ask === 'number' && Number.isFinite(r.ask) && r.ask >= r.bid
      this.#snapshot.set(r.token, {
        price: r.price,
        ts: r.ts,
        bid: paired ? (r.bid as number) : null,
        ask: paired ? (r.ask as number) : null,
      })
    }
  }
```

- [ ] **Step 2: Run api tests**

Run: `cd apps/api && npm test 2>&1 | tail -5`
Expected: PASS (Task 1's snapshot test now exercises the pair path).

- [ ] **Step 3: marketdata side — persist the pair**

At `apps/marketdata/src/main.ts:822` the tick handler keeps `lastPrice.set(t.instrument_token, { price: t.last_price, ts })`. Change the map and the write so the last two-sided frame rides along (reuse the existing `bestBidAsk(t)` helper — `tickPayload` already calls it):

```ts
      const book = bestBidAsk(t)
      const prev = lastPrice.get(t.instrument_token)
      lastPrice.set(t.instrument_token, {
        price: t.last_price,
        ts,
        book: book !== null ? { bid: book.bid, ask: book.ask, ts } : (prev?.book ?? null),
      })
```

and widen the map's type where it is declared: `Map<number, { price: number; ts: number; book: { bid: number; ask: number; ts: number } | null }>`.

In the writer (~line 1109):

```ts
          await col.updateOne(
            { token },
            { $set: { token, price: e.price, ts: e.ts, bid: e.book?.bid ?? null, ask: e.book?.ask ?? null, bookTs: e.book?.ts ?? null } },
            { upsert: true },
          )
```

- [ ] **Step 4: api boot — carry the pair out of Mongo**

In `apps/api/src/main.ts` `loadMarkSnapshot` (~line 354), extend the row mapping:

```ts
        rows.map((r) => ({
          token: Number(r['token']),
          price: Number(r['price']),
          ts: Number(r['ts']),
          bid: typeof r['bid'] === 'number' ? r['bid'] : null,
          ask: typeof r['ask'] === 'number' ? r['ask'] : null,
        })),
```

- [ ] **Step 5: Typecheck both apps and run the api suite**

Run: `npm run typecheck 2>&1 | tail -5` (root; use the repo's actual script — check root `package.json` scripts; fall back to `npx tsc -p apps/marketdata --noEmit && npx tsc -p apps/api --noEmit`)
Expected: clean. Then `cd apps/api && npm test` — PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/marks.ts apps/api/src/main.ts apps/marketdata/src/main.ts
git commit -m "feat(desk): the desk-marks snapshot carries the book pair, not just the last print"
```

---

### Task 3: Direction-aware P&L mark resolution

**Files:**
- Modify: `apps/api/src/pnl-jobs.ts` (`defaultMarkResolver` ~line 159, `markResolverFor` ~line 183, `pnlRowFor` ~line 314)
- Modify: `apps/api/src/livebook.ts:499` (resolver type annotation)
- Test: `apps/api/test/pnl-jobs.test.ts` if it exists, else the test file that already covers `pnlRowFor` (search: `grep -rln pnlRowFor apps/api/test/`); append there.

**Interfaces:**
- Consumes: `QuoteCache.exitQuote(token, exit)` from Task 1; `buildPositions` from `@algomaker/pnl` (already imported by `rollup.ts`).
- Produces: the resolver port becomes

```ts
export type MarkResolver = (symbols: readonly string[], exits: ReadonlyMap<string, ExitSide>) => Marks
```

  `pnlRowFor` computes `exits` from its own window and passes it; every `opts.marks` injection site (tests) gains the second parameter.

- [ ] **Step 1: Write the failing test** (in the file that covers `pnlRowFor`; construct fills the way its existing cases do):

```ts
it('marks open legs at the exit side: short at ask, long at bid', () => {
  const fills = [
    stamped({ tradingsymbol: 'XCE', side: 'Sell', qty: 100, price: 10, ts: t0 }),  // short → exit Buy → ask
    stamped({ tradingsymbol: 'XPE', side: 'Buy', qty: 100, price: 4, ts: t0 }),    // long  → exit Sell → bid
  ]
  const seen: Array<ReadonlyMap<string, ExitSide>> = []
  const row = pnlRowFor({
    tag: 'T', label: 'T', mode: 'paper', fills, boundary: t0 - 1,
    marksOf: (symbols, exits) => {
      seen.push(exits)
      return { XCE: exits.get('XCE') === 'Buy' ? 10.2 : -1, XPE: exits.get('XPE') === 'Sell' ? 3.8 : -1 }
    },
    malformed: [],
  })
  assert.equal(seen[0]?.get('XCE'), 'Buy')
  assert.equal(seen[0]?.get('XPE'), 'Sell')
  const xce = row.legs.find((l) => l.tradingsymbol === 'XCE')
  assert.equal(xce?.mark, 10.2)
})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && npm test 2>&1 | tail -10`
Expected: FAIL — TypeScript rejects the two-arg `marksOf`, or `exits` is `undefined`.

- [ ] **Step 3: Implement**

In `pnl-jobs.ts`:

```ts
import { buildPositions, type Marks, type PnlSide } from '@algomaker/pnl'
import type { ExitSide } from './marks.ts'

export type MarkResolver = (symbols: readonly string[], exits: ReadonlyMap<string, ExitSide>) => Marks
```

`defaultMarkResolver` — exit-side, book-only, LTP never:

```ts
export function defaultMarkResolver(deps: ApiDeps): MarkResolver {
  return (symbols, exits) => {
    const out: Record<string, number> = {}
    const cache = deps.marks
    if (cache === undefined) return out
    const master = deps.master.current()
    for (const symbol of symbols) {
      const ref = master.resolveSymbol(symbol)
      const token = ref?.instrumentToken
      if (token === undefined) continue
      // Exit side of the net open position; a symbol with no open qty needs no
      // mark (markOpenLegs only values qty != 0), so it is simply not resolved.
      const exit = exits.get(symbol)
      if (exit === undefined) continue
      const q = cache.exitQuote(token, exit)
      if (q !== null && Number.isFinite(q.price) && q.price >= 0) out[symbol] = q.price
    }
    return out
  }
}
```

`pnlRowFor` — build the exits map from its own window (direction = sign of the net position over the whole window, the exact thing `markOpenLegs` is about to value):

```ts
  const window = splitFills(input.fills, input.boundary)
  const exits = new Map<string, ExitSide>()
  for (const p of buildPositions([...window.carried, ...window.during])) {
    if (p.qty !== 0) exits.set(p.tradingsymbol, p.qty > 0 ? 'Sell' : 'Buy')
  }
  const marks = input.marksOf(symbolsIn(window), exits)
```

Update `pnlRowFor`'s input type, `markResolverFor`'s return type, `PnlOptions.marks` type, and `livebook.ts:499`'s annotation to `MarkResolver`. Fix every test-injected `marks:` fake by adding the ignored second parameter.

- [ ] **Step 4: Run the whole api suite**

Run: `cd apps/api && npm test 2>&1 | tail -8`
Expected: PASS — including livebook/pnl tests whose fakes were widened.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/pnl-jobs.ts apps/api/src/livebook.ts apps/api/test/
git commit -m "feat(desk): P&L marks resolve at the exit side of the book — long at bid, short at ask"
```

---

### Task 4: Rows carry the pair — `quotes` on PnlRow, through stream and positions

**Files:**
- Modify: `apps/api/src/pnl-jobs.ts` (`PnlRow` type + `pnlRowFor`)
- Modify: `apps/api/src/stream.ts` (leg/row delta forwarding — extend the row diff so `quotes` changes push)
- Verify (read, change only if it strips fields): `apps/api/src/service.ts` positions payload (`realised: true` branch, ~line 294 of `routes/desk.ts` calls it)
- Modify: `apps/web/src/api.ts` (row/leg types)
- Test: same api test file as Task 3

**Interfaces:**
- Produces on every `PnlRow`:

```ts
readonly quotes?: Readonly<Record<string, {
  readonly bid: number
  readonly ask: number
  readonly basis: MarkBasis      // 'bid' | 'ask' | 'mid' | 'snapshot'
  readonly asOf: number          // book frame epoch ms
}>>
```

- [ ] **Step 1: Write the failing test**

```ts
it('rows carry the quote pair beside each marked leg', () => {
  // marksOf fake as in Task 3; quotesOf mirrors what defaultMarkResolver sees
  const row = pnlRowFor({
    tag: 'T', label: 'T', mode: 'paper', fills, boundary: t0 - 1,
    marksOf: (s, e) => ({ XCE: 10.2 }),
    quotesOf: (s, e) => ({ XCE: { bid: 9.8, ask: 10.2, basis: 'ask', asOf: t0 } }),
    malformed: [],
  })
  assert.deepEqual(row.quotes?.['XCE'], { bid: 9.8, ask: 10.2, basis: 'ask', asOf: t0 })
})
```

- [ ] **Step 2: Run to verify failure** — `cd apps/api && npm test 2>&1 | tail -6`; FAIL on unknown `quotesOf`.

- [ ] **Step 3: Implement**

In `pnl-jobs.ts`: add `QuoteResolver` beside `MarkResolver`:

```ts
export type LegQuote = { readonly bid: number; readonly ask: number; readonly basis: MarkBasis; readonly asOf: number }
export type QuoteResolver = (symbols: readonly string[], exits: ReadonlyMap<string, ExitSide>) => Readonly<Record<string, LegQuote>>
```

`defaultQuoteResolver(deps)` mirrors `defaultMarkResolver` but returns the full `LegQuote` from the same `exitQuote` call (one implementation: refactor `defaultMarkResolver` to call `defaultQuoteResolver` and project `.price`... simplest correct form — build the quotes record once, derive marks from it:

```ts
export function defaultQuoteResolver(deps: ApiDeps): QuoteResolver {
  return (symbols, exits) => {
    const out: Record<string, LegQuote & { price: number }> = {}
    const cache = deps.marks
    if (cache === undefined) return out
    const master = deps.master.current()
    for (const symbol of symbols) {
      const token = master.resolveSymbol(symbol)?.instrumentToken
      const exit = exits.get(symbol)
      if (token === undefined || exit === undefined) continue
      const q = cache.exitQuote(token, exit)
      if (q !== null) out[symbol] = { price: q.price, bid: q.bid, ask: q.ask, basis: q.basis, asOf: q.asOf }
    }
    return out
  }
}
export function defaultMarkResolver(deps: ApiDeps): MarkResolver {
  const quotes = defaultQuoteResolver(deps)
  return (symbols, exits) => Object.fromEntries(
    Object.entries(quotes(symbols, exits)).map(([s, q]) => [s, (q as { price: number }).price]),
  )
}
```

— note this calls `exitQuote` twice per row build when both resolvers run; if that double read matters, have `pnlRowFor` call `quotesOf` once and derive `marks` internally when `marksOf` is not injected. Keep whichever shape leaves the existing injected-`marksOf` tests untouched.)

`pnlRowFor` accepts optional `quotesOf`, computes `quotes` with the SAME `exits` map, and attaches it to the returned row. `markResolverFor`-style plumbing: `pnlFromFills` and `LiveBook` pass `defaultQuoteResolver(deps)` (or the injected one from `PnlOptions.quotes`).

In `stream.ts`: the row-delta comparison (~line 328) compares legs; add `quotes` to the pushed row payload wherever the full row is serialized, and treat a `quotes` change as a row change (simplest: include `quotes` in the leg-diff trigger by comparing `next.quotes?.[sym]?.asOf` per moved leg — or push `quotes` whenever `legs` are pushed, which is sufficient since a quote only changes with a tick that also moves the mark).

In `apps/web/src/api.ts`: find the row interface the pnl page consumes (it has `legs` with `mark: number | null`) and add:

```ts
  quotes?: Readonly<Record<string, { bid: number; ask: number; basis: 'bid' | 'ask' | 'mid' | 'snapshot'; asOf: number }>>
```

Verify `service.positions(tag, mode, { realised: true })` serves rows built by this same path (it does per `routes/desk.ts:294`; only confirm nothing strips unknown fields — if it projects fields explicitly, add `quotes` to the projection).

- [ ] **Step 4: Run api suite + web typecheck**

Run: `cd apps/api && npm test 2>&1 | tail -5 && cd ../web && npx tsc --noEmit 2>&1 | tail -5`
Expected: PASS / clean.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/pnl-jobs.ts apps/api/src/stream.ts apps/api/src/service.ts apps/web/src/api.ts apps/api/test/
git commit -m "feat(desk): every P&L row carries its legs' bid/ask, basis and book age"
```

---

### Task 5: Web — show the pair, badge anything that is not the live book

**Files:**
- Modify: `apps/web/src/pnl.tsx` (legs table, ~lines 403 and 420 render `l.mark`)
- Modify: `apps/web/src/payoff.tsx` only if its leg rows render a mark without the pair (verify; the cockpit chain already shows bid/ask from ff4c64b4)
- Test: `apps/web` has no unit-test harness for these tables — verification is the typecheck plus the manual check in Task 6.

- [ ] **Step 1: Legs table** — beside the mark cell (`{l.mark === null ? '—' : inr(l.mark, 2)}`), render the pair and basis from `row.quotes?.[l.tradingsymbol]`:

```tsx
{(() => {
  const q = row.quotes?.[l.tradingsymbol]
  if (q === undefined) return null
  const age = Math.max(0, Math.round((asOfMs - q.asOf) / 1000))
  return (
    <div className="quote-sub">
      {q.bid.toFixed(2)} / {q.ask.toFixed(2)}
      {q.basis === 'snapshot' ? ' · last session' : age > 60 ? ` · book ${Math.round(age / 60)}m old` : ''}
    </div>
  )
})()}
```

(`asOfMs` = the row/snapshot `asOf` already available where the table renders; match the file's existing formatting helpers — it uses `inr()`; a `quote-sub` style consistent with the leg dialog's "mid of 0.20 / 0.24" note from ff4c64b4.)

The existing `no mark` badge at line 403 stays — under the new resolver it now also appears for a leg whose book was never seen, which is exactly the spec's honest-unpriced rule.

- [ ] **Step 2: Snapshot badge** — where the page shows the marks-snapshot notice (`marksSnapshot` / `marksAsOf` fields in `apps/web/src/api.ts:76-78,147-156` — the banner component that consumes them), no change is needed: `basis: 'snapshot'` per-leg sub-lines now say "last session" themselves. Only add a roll-up if the page has none: if any rendered leg's `basis === 'snapshot'` while the page claims live, show the existing stale banner. (Read the banner's condition first; extend, don't duplicate.)

- [ ] **Step 3: Typecheck + build**

Run: `cd apps/web && npx tsc --noEmit 2>&1 | tail -3 && npm run build 2>&1 | tail -3`
Expected: clean build.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/pnl.tsx apps/web/src/payoff.tsx
git commit -m "feat(desk): leg rows show the bid/ask they are valued off, and say when the book is old"
```

---

### Task 6: Whole-suite verification + spec cross-check

- [ ] **Step 1: Full repo test run** — `npm test` at the root (runs node + web suites). Expected: PASS.
- [ ] **Step 2: Grep the diff for banned surfaces** — `git diff master --stat` must NOT touch `safety.ts`, `flatten.ts`, `submit*.ts`, `marketable.ts`, `chain.ts`, `decision-plan.ts`.
- [ ] **Step 3: Behavioural spot-check against the spec** — in `apps/api`, `node --test` the marks tests once more and confirm the three spec rules each have a passing test: exit-side pick, LTP-only tick ages the frame, never-seen book → null.
- [ ] **Step 4: Merge/rebase** — bring the worktree branch up to date with `master` (the repair-Apply agent may have landed `marks.ts`/chain changes; resolve in favour of BOTH: their order pricing, this valuation). Run the full suite again after rebase.
- [ ] **Step 5: Final commit / hand back** — leave the branch ready; deployment (desk-marketdata + desk-api + web build together, marketdata bounce after hours) is the operator's call per the spec's rollout section.
