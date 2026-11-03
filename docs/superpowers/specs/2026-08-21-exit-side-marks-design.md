# Exit-side marks: P&L and unrealized value off bid/ask, not last print

**Date:** 2026-08-21
**Status:** Approved (operator directive: "use bid/ask values for calculation and showing pnl and unrealized amount because last mark price or ltp can be old and not trusted value")

## Problem

Two incidents establish the failure mode:

- **TCS 2440PE (2026-08-17):** last print 14:20 under a book moving every
  second. Fixed for the *leg dialog* by ff4c64b4 — the chain wire now carries
  best bid/ask and the dialog pre-fills the mid.
- **BHEL (2026-08-21):** the positions page held "+25k" through the afternoon
  while the book was worth ≈ −4.6k at the live marks; the number snapped to
  −7,061 (the true realised figure) only when the last leg filled. Slippage
  was ~2.5k of that; the rest was displayed valuation not tracking the market.

Far-OTM and illiquid legs make this permanent: their LTP can be hours old
while the book's bid/ask is live intent. Any P&L built on last prints is a
number nobody should trust, and today nothing on screen says *which* basis a
mark came from.

## Principle

An open leg's display value is **what closing it would actually fetch, from
the order book — and only the order book. LTP is not a valuation basis
anywhere** (operator directive 2026-08-21: "we don't want to use LTP
anywhere").

- a **long** leg is valued at the **bid** of the last two-sided book frame
  (you would sell to close);
- a **short** leg is valued at the **ask** (you would buy to close);
- market closed: the **last session's final book** (persisted pair
  snapshot), basis `snapshot`;
- no book frame has ever been seen for the contract: the leg is honestly
  **unpriced** (`null` → em-dash, total incomplete) — never an LTP stand-in,
  never a guess.

Every valued leg reports its basis and the **book frame's age**, and the UI
badges anything not from the live book. Where a single *neutral* price is
needed and no direction applies (a chain strike's shown price, a what-if
preview before a side is chosen), the **mid of the same book frame** is the
price — same source, direction-free. The pair itself is wired end-to-end
(operator: "wire bid/ask everywhere"), so any consumer can show or derive
either. Realised P&L is untouched — fill arithmetic, already exact.

**Boundary — where trade prints remain correct:** candles/history (the data
*is* trades), index spot (an index has no book), and journalled fill prices.
These are data, not valuation, and are out of scope.

## What already exists (do not rebuild)

- The feed subscribes in Kite **full** mode; `tickPayload` publishes
  `bid`/`ask` on `md.tick` (marketdata `main.ts:504`).
- desk-api's `QuoteCache` (`marks.ts`) stores the pair per tick, enforces
  two-sidedness (`ask >= bid > 0`, both from the *same* tick), and its
  `#effective()` already marks at the **mid** when a book exists. `price()`
  reads through it.
- The chain endpoint serves per-strike bid/ask (ff4c64b4).

The gaps: valuation is direction-blind (mid, not exit side); the
`desk-marks` persistence snapshot stores **raw LTP** (`lastPrice` map,
marketdata `main.ts:822,1109`) so restarts and out-of-hours seeding lose the
book; the stream/positions payloads carry a bare `mark` number so the web
cannot show basis or the pair.

## Changes

### 1. `QuoteCache.exitQuote(instrument, side)` — apps/api/src/marks.ts

New read beside `price()`: returns `{ price, basis, ts, bid, ask } | null`
where `basis ∈ 'bid' | 'ask' | 'mid' | 'snapshot'`. Side `sell` (closing a
long) → bid; side `buy` (closing a short) → ask; no direction → mid. The
cache keeps the **last two-sided book frame** (`bid`, `ask`, its own `ts`)
separately from the last trade tick, so an LTP-only tick no longer erases
the pair — it just ages it, and the age is reported. A contract with no
book frame ever seen returns `null` (unpriced). LTP never substitutes.
`price()` remains for the out-of-scope consumers (charts, index spot,
margin) only.

### 2. Direction-aware mark resolution — apps/api/src/pnl-jobs.ts port

`pnlRowFor`'s `marksOf(symbols) => Marks` port becomes direction-aware: the
resolver receives each symbol's net open direction (derivable from the
window's positions) and answers with the exit-side price. `@algomaker/pnl`
itself does not change — `Marks` stays a symbol→number map; only how the map
is filled changes. The same resolver change covers `computeWindowPnl`
callers, `LiveBook` (which prices one tag per tick through `pnlRowFor`), and
`service.positions` (the positions page with `realised: true`).

### 3. Payload enrichment — stream legs and positions rows

Leg/row payloads gain `bid`, `ask` (nullable), `markBasis`, `markTs`.
`mark` itself becomes the exit-side value, so every existing consumer of
`mark` — header tiles, totals, the cockpit — inherits the honest number with
no client arithmetic change. The `null`-means-unpriceable contract is kept
exactly as documented in `stream.ts`.

### 4. Snapshot parity — desk-marks persists the pair

marketdata's `lastPrice` map and the `desk-marks` writer persist
`bid`/`ask`/`ts` beside `price`; desk-api's `loadSnapshot` carries them into
the display-only snapshot store. Out-of-hours and post-restart seeding then
show the same basis the live path would, labelled `snapshot`. (Display only,
exactly as today — `price()` still refuses snapshot values for fills.)

### 5. Web display — the pair and the badge

Positions table and payoff cockpit leg rows show the quote pair and age in
the leg-dialog's established language (e.g. "b 6.75 / a 6.85 · book 3s
old"), and a visible badge when a leg is valued off anything but the live
book ("last print 2h — no book"). Header tiles need no arithmetic change
(they consume `mark`), only the badge roll-up: a total containing any
non-book-valued leg is marked as such.

## Non-goals

- **Order pricing** — `planFlatten`/`priceExit`, submit, and the repair
  Apply flow. The repair-Apply agent is building depth-priced orders in its
  own worktree; this spec deliberately stays off those files. Exit-side
  *valuation* and depth-priced *execution* meet later.
- Python desk internal valuation (its decisions price off its own feed).
- Margin baskets, candle charts, spot.

## Edge rules

- Two-sidedness is enforced at frame-capture time (existing guard): a
  crossed or one-sided frame stores no pair; the previous frame stays,
  older. Book age is always displayed, so a frozen book is visible rather
  than silent.
- A worthless far-OTM wing with a live book values at its bid (often 0.05);
  a contract whose book has never been seen is **unpriced** — `null`, never
  an LTP stand-in, and the total goes incomplete exactly as the existing
  `null`-propagation contract demands.
- After close the book stops: closed-market display prices off the last
  session's final book frame (bc376b89 behaviour, now pair-based), basis
  `snapshot`.
- One symbol, one net direction per book — the resolver keys the side off
  the net position, which is the only thing being valued.

## Testing

- `marks.ts` unit tests: exit side per direction; mid when no direction;
  LTP-only tick ages the book frame instead of erasing it; no frame ever →
  `null`; snapshot basis after reload; same-frame pairing preserved.
- `pnl-jobs` tests: short leg valued at ask / long at bid, mixed book total,
  unmarked leg still nulls the total (existing contract).
- Stream payload shape test beside the existing stream tests.
- Snapshot round-trip: persist pair → load → display basis `snapshot`.

## Rollout

Display-only change: no order path touched. Deploy desk-marketdata +
desk-api + web build together (the tick payload already carries the pair, so
old marketdata + new api degrades gracefully to today's behaviour).
Restart desk-api alone is mid-session safe; bounce marketdata after hours.
Coordinate the merge with the repair-Apply worktree — shared surface is
`marks.ts` (QuoteCache) and the chain types, nothing else.
