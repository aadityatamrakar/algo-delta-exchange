# Ticket 11 — ChainView: bus ticks to chain snapshots (plan Task 13)

**Status:** DONE (three judgement calls flagged in §4; nothing blocked)
**Branch:** `worktree-agent-ae1d9fc084548935d` (worktree at
`/Users/aaditya/Documents/dev/algomaker/.claude/worktrees/agent-ae1d9fc084548935d`,
based off `ca7b0610` on `recenter-migration`)

| Commit | Subject |
|---|---|
| `1b881d30` | feat(supervisor): ChainView turns md.tick into two-sided chain snapshots, book pairs survive LTP-only ticks |
| `f77172e1` | docs(supervisor): ChainView says where its citations point and what it still holds after a book rolls away |

Files: `apps/supervisor/src/chain-view.ts` (new),
`apps/supervisor/test/chain-view.test.ts` (new). Nothing else touched — no
`package.json` change was needed (`@algomaker/desk-engine` was already a
dependency, and the instrument master is injected rather than imported).

---

## 1. What was implemented

`ChainView` folds the bus's `md.tick` stream into `ChainSnap`s for the engine.
The brief's interface, unchanged:

```ts
constructor(deps: { tokensFor(symbol, expiry): ReadonlyArray<ChainToken>; futureToken(symbol): number })
onTick(t: MdTick): void
warmStart(rows: ReadonlyArray<WarmMark>): void
snap(symbol, expiry, lotSize, step): ChainSnap | null
touchedSince(ms: number): boolean
```

Exported alongside it: `ChainToken`, `ChainViewDeps`, `MdTick`, `WarmMark` —
the four shapes Task 15 has to satisfy when it wires `packages/instruments`
and the bus in. `Quote`, `StrikeQuote`, `ChainSnap`, `OptType` and `midOf` are
imported from `@algomaker/desk-engine`, never restated. Nothing is imported
from `apps/api` (the `Side`/`ExitSide` structural trap).

### Both-or-neither, and the book survives an LTP-only tick

The deployed `QuoteCache` rule, ported (`apps/api/src/marks.ts:190-219`, and
the retention itself at `:228`): a tick with a real, positive, un-crossed
**bid AND ask** replaces the pair; a tick with only a price updates the print
and leaves the pair alone. It never half-updates and never clears. `pairOf`
applies the same four tests as `marks.ts:217-219` (present, finite, positive,
not crossed).

The failure being prevented is not a crash: clearing the pair on an LTP-only
tick unmarks every illiquid short *between prints*, because in live pricing a
leg with no pair is not marked at all. TCS 2440 PE last printed at 14:20 on
2026-08-17 under a book that moved every second.

### `asOf` times the BASIS, not the last packet

`Quote` carries one timestamp and two possible bases, so it has to say which
one it is timing — and it times the one that will actually be read:

- pair held → `asOf` is that **book frame's** own time, and an LTP-only tick
  does **not** advance it;
- no pair → `asOf` is the print's.

This is a contract decision I made, and it is the one I would most want
reviewed. The argument: an LTP-only tick that advanced `asOf` would make a
frozen book read fresh, so "the book is old" (shipped 2026-08-21) could never
fire — the caller ages `LegView.exit`, and `marking.ts` copies this quote into
it verbatim. `QuoteCache.exitQuote` reports `asOf: book.ts` for the same reason
(`marks.ts:410`). Because live marks read the exit side and parity marks read
the mid, `ltp` is consulted only when there is no pair — exactly the case where
`asOf` *is* the print's time. So "asOf ages the number that would be used"
holds in every branch.

### `snap()` — and the spot contract

`spot = midOf(future)`, per the marking ticket, and `null` when the future has
no usable quote (`ChainSnap.spot` is a plain `number`; a chain with no forward
cannot be priced at all). `midOf` falls back to the print only for a genuinely
one-sided future.

Every LISTED strike is in `strikes`, ascending, with an unquoted wing as `null`
rather than a zero — `apps/api/src/chain.ts`'s rule, because "not listed" and
"listed, never traded" are different facts and only the second can be opened
once it prints. `asOf` on the snapshot is the newest quote in it; per-contract
age stays on each `Quote`, and the forward's own age is `future.asOf`.

### Memory: the declared set and nothing else

`apps/runner/src/market-data.ts:373-403` (audit F-53) is cited in the header as
the cautionary tale — `#quotes` kept the last tick for every token that ever
arrived, and a stale quote is not inert, it is selectable. Here:

- a tick for a token no declared chain wants is dropped — not stored, and not
  counted as a touch;
- `#reindex` rebuilds the admitted union across **every** declared chain
  (snapping book A must not forget book B, the same reason the runner prunes
  against `fullSubscriptionSet()`), prunes quotes outside it, and promotes any
  matching warm-start seed;
- a token that leaves the declared set takes its price with it, so a strike
  that leaves the window and returns does **not** return with a frozen price.

Residual bound, stated in the header rather than left implicit: a chain is
never *un*-declared, so a book that rolls away leaves its last resolved token
list held until restart. That is a per-expiry-roll leak, not a per-tick one.

### `touchedSince`

`#lastTickMs > ms`, where `#lastTickMs` is the newest **admitted** tick
timestamp (out-of-order arrivals cannot wind it backwards). Epoch instant, not
a duration — forced, and correctly so: the constructor takes no clock, so the
only times this class has are the ones the ticks carry. Documented as a change
detector and explicitly **not** a liveness proof: feed-death detection measures
ARRIVAL and stays with `QuoteCache.feedAlive` (`marks.ts:261`). An LTP-only
tick counts (the market moved); a dropped tick does not.

---

## 2. Tests

`apps/supervisor/test/chain-view.test.ts` — 19 tests, `node:test`, **no Mongo,
no clock, no bus**: every input is a literal. That matters in this directory,
where the two sibling suites are database suites that skip themselves without a
server.

The brief's four:

| Brief | Test |
|---|---|
| ltp-only tick after a two-sided tick keeps the pair | `an LTP-only tick keeps the book pair — it never half-updates or clears it` |
| `snap()` mid of future feeds `spot` | `spot is the MID of the future, never its last print` (2400/2402 book, 2405 print → `spot 2401`) |
| unknown token ignored | `a tick on a token no declared chain wants is ignored entirely` |
| warmStart then tick overrides | `warmStart seeds a chain that is declared later, and a real tick overrides it` |

Plus, in the same order as the source: the frame-time rule (five LTP-only ticks
over five minutes leave `asOf` at the frame); one-sided, crossed and zero-bid
ticks set no pair; a zero/NaN price or NaN timestamp changes nothing and is not
a touch; the one-sided-future LTP fallback; `snap` null until the future quotes
and null forever when the master lists no future; every listed strike present
with null wings; the snapshot echoing symbol/expiry/lot/step and its newest
`asOf`; the F-53 reproduction (a strike that leaves the chain and returns has no
frozen price); two chains in one view not pruning each other; warm start not
overwriting a live quote; a seeded pair ageing from `bookTs`; an unpaired or
zero-priced snapshot row seeding no book; warm start not counting as a touch;
and `touchedSince` at, before and after the instant.

Verification actually run (not asserted from memory):

```
$ npx tsc -p tsconfig.json          → clean (exit 0)
$ node --test apps/supervisor/test/chain-view.test.ts
  ℹ tests 19  ℹ pass 19  ℹ fail 0  ℹ skipped 0
$ npm test --workspace @algomaker/supervisor
  ℹ tests 49  ℹ pass 49  ℹ fail 0  ℹ skipped 0
```

`skipped 0` on the workspace run is load bearing: Mongo was reachable locally,
so the state-store and lease suites ran for real rather than self-skipping.

---

## 3. TDD note

Tests were written first and run first: the initial run failed with
`ERR_MODULE_NOT_FOUND` on `../src/chain-view.ts`, which is red for the right
reason but is one failure, not nineteen. The suite then needed one structural
edit before implementation could turn it green — see §4.1: the first draft
assumed ticks could land before any chain had been declared, and that is not
how the class can work.

---

## 4. Judgement calls (please review these three)

### 4.1 `snap()` IS the declaration — and the cold start that follows

**The constraint:** a `token` does not say which underlying it belongs to, and
`tokensFor` is keyed by `(symbol, expiry)`. With the brief's five members and
nothing else, the only moment this class can learn which chains matter is when
it is asked for one. So `snap()` registers the chain, and a tick that arrives
before a book has ever been snapped is dropped.

**The alternatives I rejected:** a public `declare(symbol, expiry)` method
(cleaner at the boot path, but an addition to a brief that spelled the
interface out exactly); and storing unknown ticks speculatively (unbounded —
the shared bus carries every consumer's subscriptions, which is the ~50,000
subscription world, and it directly violates the brief's retention criterion).

**Cost:** a supervisor's very first ticks, for one poll cycle, on a stream that
repeats every few hundred ms. `warmStart` covers the boot itself, and the
chain is re-resolved on every subsequent snap so it self-heals. **Task 15
should be aware:** snap each leased book once at boot, before the tick
subscription's output matters.

### 4.2 `WarmMark.bookTs` — one optional field beyond the brief's row shape

The brief's warm-start row is `{token, price, ts, bid, ask}`. `desk-marks`
persists a `bookTs` — the pair's OWN time, which can be older than the last
print's `ts` — and `QuoteCache.loadSnapshot` already reads it with a `?? ts`
fallback (`marks.ts:313`). Dropping it would make every seeded pair age from
the print and read fresher than it is, which is the §2 defect reintroduced at
boot.

So `WarmMark` carries `bookTs?: number | null | undefined`. It is **optional**,
so a caller passing exactly the brief's shape still typechecks and behaves
identically (`bookTs` absent → `ts` is used).

### 4.3 Warm start never overwrites a live quote

The brief specifies "warmStart then tick overrides" and says nothing about the
reverse order. I made the reverse safe too: a persisted row is by definition
older than any live quote for the same token, so `warmStart` writes only where
nothing is held. Otherwise a warm start called late (a re-seed, a reconnect)
would replace a real book with yesterday's.

---

## 5. Self-review — what I checked and what I would still watch

- **Cited line numbers were verified against the files**, not remembered:
  `marks.ts:190-219`/`:228`/`:261`/`:313`/`:410`,
  `market-data.ts:373-403`/`:393-396`, `marketdata/src/main.ts:504`. Three were
  wrong in the first draft and are fixed in `f77172e1`.
- **`snap()` allocates a fresh snapshot per call** and `#reindex` is O(declared
  tokens + held quotes) per snap. With a handful of books at a few snaps a
  minute this is nothing; it would matter if a caller snapped in a tight loop.
- **A chain with zero listed rows still snaps** (empty `strikes`, valid
  future). That is honest — the rules find no candidates — rather than a `null`
  that would be indistinguishable from "no forward".
- **Duplicate `(strike, optType)` rows**: the first *quoted* one wins
  (`row.ce ?? q`). A malformed dump, not a real chain; noted inline.
- **`ChainToken.instrument` is unused** by the snapshot. Kept because it is the
  same row the caller's leg-building path resolves and splitting the shape
  would invite the two halves to disagree about which token is which contract.
- **Not covered here, by design:** spread/age *gates* (they belong in the
  rules, per `marking.ts`'s valuation-vs-candidacy split), feed-liveness
  (`QuoteCache.feedAlive`), and any subscription management — this class reads
  the stream, it does not shape it.
