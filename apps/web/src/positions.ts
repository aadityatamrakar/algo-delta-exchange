/**
 * ONE ROW PER CONTRACT, out of a book that legitimately stores several legs on
 * the same one.
 *
 * The desk closes legs BY DESK TAG, so a contract entered in two tranches is
 * two rows in `desk-books` on purpose — each separately closeable. That is the
 * right shape for the store and the wrong shape for a risk display: the
 * positions table rendered
 *
 *   ITC26AUG277.5PE  -1,725  entry 4.70
 *   ITC26AUG277.5PE  -1,725  entry 4.45
 *
 * which reads as a duplication bug, and it disagreed with the desk-vs-bridge
 * panel directly beneath it — that one groups by (strike, type) and so reported
 * "4 legs" against five rows. This is the display-side grouping that makes the
 * page agree with itself. NOTHING SERVER-SIDE MERGES; merging the store would
 * cost the desk the ability to close one tranche and not the other.
 *
 * Pure, and in its own module, because "do the rows still sum to the net delta
 * on the cards above them" is arithmetic, and arithmetic belongs somewhere it
 * can be asserted without rendering a page.
 */

import type { BookGreeks, BridgeLeg, LegQuote } from './api.ts'

export interface PositionRow extends Record<string, unknown> {
  tradingsymbol: string
  /** The contract's strike, off the leg — never parsed back out of the symbol. */
  strike: number
  /** CE or PE, off the leg. Typed as the leg's own union, and READ DEFENSIVELY
      in `compareLadder`: a running bridge may carry a leg this union does not
      describe (a future), and an ordering must not depend on it not doing so. */
  type: BridgeLeg['type']
  qty: number
  /** Size-weighted average of the merged legs' entries. */
  entry: number
  mark: number | null
  iv: number | null
  /** Per share, so a property of the contract — identical on every merged leg. */
  delta: number | null
  /**
   * Contracts per lot, off the leg's own instrument. A property of the
   * contract like `delta`, so the first merged leg's is the row's.
   *
   * Here because the PROTECT control speaks LOTS (every quantity the engine
   * reasons in is lots) while this table speaks contracts, and the conversion
   * must not be done against a lot size guessed from somewhere else. 0 when a
   * bridge sent none.
   */
  lotSize: number
  /** The SUM over the merged legs. Null only when none of them priced. */
  posDelta: number | null
  /**
   * OPEN P&L on this row: `qty x (mark − entry)`, in rupees. Null without a
   * mark — an unpriced leg has no P&L, and 0 would read as a flat trade.
   *
   * Mark-vs-entry ONLY. There is no realised component here because every row
   * is an OPEN position; a tranche the desk has already closed has left the
   * book and taken its P&L to the journal. So this is the same quantity the
   * Open legs card calls "Unrealised", measured from the desk's own entry —
   * which is the cost basis the Entry column beside it prints, so the three
   * numbers on the row are checkable by eye.
   */
  pnl: number | null
  /**
   * The bid/ask pair the mark was valued off — a long at its bid, a short at
   * its ask. Null when the server sent none (a book that could not answer, or
   * a bridge a deploy behind).
   */
  quote: LegQuote | null
  unpriced: boolean
  /** Mark/greeks are MODEL estimates (no IV solved from the quote) — the row
      is in the totals but must say it is priced by model, not by market. */
  modelPriced: boolean
  /** How many stored legs this row merged. 1 means nothing was merged. */
  fills: number
  /** Each merged leg's own entry, in book order — what the average hides. */
  entries: readonly number[]
  /**
   * A SENTINEL SUMMARY ROW appended after the sort, not a contract.
   *
   * `consolidatePositions` never sets it; `summaryRows` does, for the block
   * that sums the two summable columns and dashes out the rest (see
   * `pages.tsx`). It is declared HERE because the alternative was smuggling
   * the flag through `as unknown as PositionRow` and reading it back out with
   * a `Record<string, unknown>` cast in five cells — a double cast that would
   * have silently survived any of those fields being renamed (audit F-53).
   */
  isTotal?: boolean
  /**
   * WHAT THE SUMMARY ROW IS A SUM OF, said under its name — only on `isTotal`
   * rows. The block can be one row or three (see `summaryRows`), and each has
   * to state its own question; a bare bold figure at the foot of a P&L column
   * is exactly the ambiguity audit F-52 was about. `strong` marks the one row
   * that is the ANSWER — the net Total — so the components read as its
   * working rather than as three competing totals.
   */
  summary?: { label: string; note: string; strong?: boolean }
}

/**
 * The book's legs, joined to their greeks and grouped onto their contract.
 *
 * Rows come back in first-seen book order. Per contract:
 *
 *   qty       summed
 *   entry     averaged, WEIGHTED BY |qty| — a 10-lot fill at 4.70 and a 1-lot
 *             fill at 4.45 is not a 4.575 cost basis
 *   mark/iv   carried through: a property of the contract, identical on every
 *   delta     leg holding it, so there is nothing to combine
 *   posDelta  derived as delta x the row's qty, so it always agrees with the
 *             two columns beside it and stays right when a contract splits
 *
 * THE GREEKS JOIN IS ONE-TO-MANY IN BOTH DIRECTIONS, which is the part that was
 * already subtly wrong before any merging: `greeks.legs` carries one entry PER
 * STORED LEG (see `bookGreeks`), so a contract held twice appears twice there
 * too, and the old `new Map(legs.map(l => [l.tradingsymbol, l]))` silently kept
 * only the LAST of them. Every row of that contract then displayed the last
 * tranche's position delta — right only while the tranches happened to be the
 * same size, and never summing to the net delta on the cards above when they
 * were not. Summing here is what makes the table reconcile with its own totals.
 */
export function consolidatePositions(
  legs: readonly BridgeLeg[],
  greeks: BookGreeks | undefined,
  quotes?: Readonly<Record<string, LegQuote>>,
): PositionRow[] {
  const unpriced = new Set(greeks?.unpriced ?? [])
  const modelPriced = new Set(greeks?.fallbackPriced ?? [])

  /** Per contract: the per-share figures (from any one leg) and the summed position delta. */
  const priced = new Map<string, { mark: number; iv: number | null; delta: number }>()
  for (const p of greeks?.legs ?? []) {
    // Per-SHARE figures only. They are properties of the contract, identical on
    // every leg of it, so the first one wins and later ones add nothing.
    // Position delta is derived per row at the end — see there for why.
    if (!priced.has(p.tradingsymbol)) {
      priced.set(p.tradingsymbol, { mark: p.price, iv: p.iv, delta: p.delta })
    }
  }

  const rows: PositionRow[] = []
  const at = new Map<string, PositionRow>()
  /** Σ|qty| per contract, kept out of the row: it is the averaging weight, not a field. */
  const weight = new Map<string, number>()

  /*
    KEYED BY CONTRACT **AND DIRECTION**, not by contract alone.

    `applyActions` pushes one leg per desk tag, so the same tradingsymbol can be
    open Sell under one tag and Buy under another — a roll or a hedge, each
    separately closeable. Merging across the sign netted them into one row: an
    exactly offsetting pair rendered as `Qty 0`, uncoloured because `sign(0)` is
    undefined, reading as "nothing held" while two legs were genuinely open and
    carrying margin and pin risk. It also blended the two into a cost basis no
    fill ever happened at.

    Same-direction tranches are what this function exists to merge, and they
    still are. Opposite directions are a different position on the same
    contract, and the table says so.
  */
  for (const leg of legs) {
    const symbol = leg.instrument.tradingsymbol
    const key = `${symbol}|${leg.qty < 0 ? 'S' : 'B'}`
    const w = Math.abs(leg.qty)
    const row = at.get(key)
    if (row === undefined) {
      const p = priced.get(symbol)
      const fresh: PositionRow = {
        tradingsymbol: symbol, strike: leg.strike, type: leg.type,
        qty: leg.qty, entry: leg.entryPrice,
        mark: p?.mark ?? null, iv: p?.iv ?? null, delta: p?.delta ?? null,
        lotSize: leg.instrument.lotSize,
        posDelta: null, pnl: null, quote: quotes?.[symbol] ?? null,
        unpriced: unpriced.has(symbol),
        modelPriced: modelPriced.has(symbol),
        fills: 1, entries: [leg.entryPrice],
      }
      rows.push(fresh)
      at.set(key, fresh)
      weight.set(key, w)
      continue
    }
    const held = weight.get(key) ?? 0
    /*
      A ZERO-SIZE GROUP CANNOT CARRY WEIGHT. `0/0` is NaN, and NaN renders as an
      em dash on a row that plainly has an entry price. A leg closed to nothing
      should not be in the book at all — `applyRoutedFill` removes one that
      reaches zero — but this is the arithmetic every displayed cost basis goes
      through, and a guard on it is cheaper than trusting every writer forever.
    */
    const total = held + w
    row.entry = total === 0
      ? (row.entry * row.fills + leg.entryPrice) / (row.fills + 1)
      : (row.entry * held + leg.entryPrice * w) / total
    row.qty += leg.qty
    row.fills += 1
    row.entries = [...row.entries, leg.entryPrice]
    weight.set(key, total)
  }

  /*
    POSITION DELTA IS DERIVED, not carried over from `priced`.

    `LegGreeks.positionDelta` is `delta x qty` per leg, so summing a group is
    exactly `delta x rowQty` — the same number, and it stays right once a
    contract can occupy two rows, which a contract-level sum could not. It also
    closes a gap the summed version had: when only SOME tranches of a contract
    priced, the row showed the full merged `qty` beside a delta covering only
    the priced ones, so `Delta x Qty` contradicted `Pos delta` on one row. Now
    the three always agree, and an unpriced contract reports nothing rather than
    a partial figure.
  */
  for (const row of rows) row.posDelta = row.delta === null ? null : row.delta * row.qty

  /*
    OPEN P&L IS DERIVED THE SAME WAY, AND OFF THE SAME THREE NUMBERS THE ROW
    PRINTS — `qty x (mark − entry)` — so the column can be checked against its
    neighbours by eye rather than taken on trust.

    IT STILL SUMS TO `bookTotals.mtm`, which is the property that keeps this
    column from becoming a fourth opinion about the same book. That holds
    because a row only ever merges legs of ONE DIRECTION (see the key above):
    with a single sign, Σ|q| = |Σq|, so the |qty|-weighted entry satisfies
    `rowQty x avgEntry = Σ qᵢ·eᵢ` exactly and the row's figure is the sum of
    its legs'. Merge across the sign and that identity breaks silently — one
    more reason the key carries the direction.

    NULL, NEVER 0, when the contract has no mark — the rule the whole file
    keeps. An unpriced leg is the case where a flat-looking P&L is most
    dangerous, because it is the case where the loss is unknown.

    A NOTE ON THE MTM TILE ABOVE: these rows need NOT add up to it. That tile
    prefers the P&L stream's chip total, which is the DAY's realised + open,
    off the order journal; this is the OPEN book's mark-vs-entry since each
    position was put on. They coincide on a book opened today and left alone,
    and diverge the moment a tranche is closed or a position is carried
    overnight. `bookTotals.mtm` — the tile's fallback — is the one these sum to.
  */
  for (const row of rows) row.pnl = row.mark === null ? null : row.qty * (row.mark - row.entry)

  return rows
}

// ------------------------------------------------------------- summary block

/**
 * THE SUMMARY BLOCK under the table's rows — appended AFTER the sort so it
 * stays last, and built here because whether these figures add up is
 * arithmetic, not rendering.
 *
 * WHY THREE ROWS (2026-08-18). The rows above are the OPEN book, so their sum
 * is what the surviving legs have made since entry — and on the day the live
 * BHEL book closed a leg realising −95,524, that sum read +95,419 while the
 * book's true lifetime P&L was ≈ −105. The sub-label ("open, since entry",
 * audit F-52) made the figure honest; it did not stop it being read as
 * profit, because the honest figure was still not the one the operator's
 * question needs. So the foot of the column now answers it:
 *
 *   Open       what the open legs show, mark vs entry — the old Total
 *   Realised   what the desk has BOOKED, from the corrected fills
 *   Total      the sum of the two: the book's net, the number that was ≈ −105
 *
 * Total = Open + Realised holds by construction, which is what keeps the
 * block checkable by eye against the column above it.
 *
 * WITH NO REALISED FIGURE the block is the single Total row this table has
 * always had, labelled exactly as before — an older bridge, or one that could
 * not vouch for the number (`PositionsResponse.realised`), must not change
 * what renders. And NULL propagates, never 0: an unpriced row makes Open
 * unknown, and an unknown Open makes the net unknown — Realised alone stays a
 * number, because it is booked and no mark can change it.
 *
 * `deltaRows` is which rows the Pos delta total sums — the whole table
 * normally, the short legs under the shorts-only view (see `pages.tsx`). It
 * rides the STRONG row only: realised legs have no delta, so the book's
 * delta and the net P&L are both statements about the same final line.
 */
/**
 * THE book-since-entry figure: open legs against their entries plus realised
 * booked on closed legs. Exported so the P&L tile and the table's Total row
 * are ONE computation, not two estimates that agree until they don't
 * (operator's call 2026-08-18: "not two different values").
 *
 * Null the moment any open row is unpriced — a sum over the rows that DID
 * price is a confident number understated by an unknown amount, the same rule
 * `summaryRows` states. A null `realised` means the bridge could not vouch
 * for one, and the open figure alone is then the honest total.
 */
export function sinceEntryTotal(
  rows: readonly PositionRow[],
  realised: number | null,
): number | null {
  if (rows.length === 0) return realised
  const openPnl = rows.some((r) => r.pnl === null)
    ? null
    : rows.reduce((n, r) => n + (r.pnl ?? 0), 0)
  if (openPnl === null) return null
  return realised === null ? openPnl : openPnl + realised
}

export function summaryRows(
  rows: readonly PositionRow[],
  realised: number | null,
  deltaRows: readonly PositionRow[] = rows,
): PositionRow[] {
  if (rows.length === 0) return []
  const sumOrNull = (
    over: readonly PositionRow[],
    field: (r: PositionRow) => number | null,
  ): number | null =>
    over.some((r) => field(r) === null)
      ? null
      : over.reduce((n, r) => n + (field(r) ?? 0), 0)
  const openPnl = sumOrNull(rows, (r) => r.pnl)
  const posDelta = sumOrNull(deltaRows, (r) => r.posDelta)
  /** Everything a sentinel dashes out, shared so the rows cannot drift. */
  const blank: PositionRow = {
    tradingsymbol: '', strike: 0, type: 'CE', qty: 0, entry: 0, entries: [],
    fills: 0, mark: null, pnl: null, quote: null, iv: null, delta: null, posDelta: null,
    // A summary row is not a contract, so it has no lot size — the cells that
    // would use one (Protect) render nothing on an `isTotal` row anyway.
    lotSize: 0,
    unpriced: false, modelPriced: false, isTotal: true,
  }
  if (realised === null) {
    return [{
      ...blank, tradingsymbol: 'Total', pnl: openPnl, posDelta,
      summary: { label: 'Total', note: 'open, since entry', strong: true },
    }]
  }
  return [
    {
      ...blank, tradingsymbol: 'Open', pnl: openPnl,
      summary: { label: 'Open', note: 'open legs, since entry' },
    },
    {
      ...blank, tradingsymbol: 'Realised', pnl: realised,
      summary: { label: 'Realised', note: 'booked on closed legs' },
    },
    {
      ...blank, tradingsymbol: 'Total',
      pnl: openPnl === null ? null : openPnl + realised, posDelta,
      summary: { label: 'Total', note: 'net, open + realised', strong: true },
    },
  ]
}

// -------------------------------------------------------------- row ordering

/**
 * THE OPTION LADDER, as an ASCENDING comparator: futures and anything this
 * bridge does not label CE/PE first, then every put by strike, then every call.
 *
 * READ IT THROUGH THE DEFAULT, WHICH IS DESCENDING — the exact reverse of the
 * line above, and the order an operator reads a chain in:
 *
 *   DLF 710 CE      calls on top, furthest out of the money first
 *   DLF 660 CE
 *   DLF 650 PE      puts underneath, same high-to-low run
 *   DLF 640 PE
 *   DLF 600 PE
 *
 * so the table runs downhill in strike from top to bottom, with the upside
 * wing at the top of the screen and the downside wing at the bottom — the
 * same geometry as the payoff the operator is picturing.
 *
 * IT IS WRITTEN ASCENDING BECAUSE THE SORT PLUGIN OWNS THE DIRECTION: comparators
 * hand back an ascending order and the table negates them for descending (see
 * `useTableSortableState`). Writing the ladder itself as the descending case
 * would have made the header announce `aria-sort="ascending"` over a column
 * running 710 → 600, which is a lie told to exactly the readers who cannot see
 * the arrow.
 *
 * TIES KEEP BOOK ORDER. `Array.prototype.sort` is stable, so the two rows a
 * hedged contract occupies (same strike, same type, opposite directions) stay
 * in the order the desk stored them rather than swapping about between polls.
 */
export function compareLadder(a: PositionRow, b: PositionRow): number {
  const rank = (r: PositionRow): number => (r.type === 'CE' ? 2 : r.type === 'PE' ? 1 : 0)
  const byType = rank(a) - rank(b)
  if (byType !== 0) return byType

  /*
    COMPARED, NOT SUBTRACTED. A leg with no usable strike — a future, or a
    payload a deploy behind — must not produce a NaN: `Array.prototype.sort`
    reads NaN as "equal", which makes the comparator inconsistent and scrambles
    the order of the rows AROUND it, not just its own. Unusable strikes sort to
    the ascending end, which is the BOTTOM of the ladder as displayed — the same
    place an unrecognised type goes.
  */
  const strike = (r: PositionRow): number =>
    typeof r.strike === 'number' && Number.isFinite(r.strike) ? r.strike : Number.NEGATIVE_INFINITY
  const sa = strike(a)
  const sb = strike(b)
  return sa < sb ? -1 : sa > sb ? 1 : 0
}

// ------------------------------------------------------------- book totals

export interface BookTotals {
  /** Σ qty x (mark − entry) over the priced legs. Null when nothing priced. */
  mtm: number | null
  /**
   * Net time value: each leg's (mark − intrinsic), shorts counted as collected
   * (positive) and longs as paid. Null without a spot — intrinsic needs one.
   */
  netTv: number | null
  /** The Δ0 spot where the book's delta crosses zero, and its distance from here. */
  neutral: { price: number; pct: number } | null
}

/**
 * The three figures the desk's report puts on every marked row — MTM, net TV
 * and Δ0 — computed the same way here so the dashboard and the report never
 * disagree about the same book (`report_html.py` / `book.py` on the desk side).
 *
 * Δ0 is `spot − netΔ/netΓ`: a LINEAR, gamma-constant estimate, accurate near
 * spot only. A netΓ of exactly 0 renders as nothing rather than a division
 * blow-up — on this bridge that is "no leg priced", not "a gamma-flat book".
 *
 * Same partiality convention as the greeks above these cards: unpriced legs are
 * EXCLUDED from the sums (the banner names them), and a book where nothing
 * priced reports null — never a figure of 0, which would read as flat exactly
 * when the book is at its least known.
 */
export function bookTotals(
  legs: readonly BridgeLeg[],
  greeks: BookGreeks | undefined,
  spot: number | null,
): BookTotals {
  /** Per-share mark by contract — first entry wins, as in the join above. */
  const marks = new Map<string, number>()
  for (const p of greeks?.legs ?? []) {
    if (!marks.has(p.tradingsymbol)) marks.set(p.tradingsymbol, p.price)
  }

  let mtm: number | null = null
  let netTv: number | null = null
  const haveSpot = typeof spot === 'number' && spot > 0
  for (const l of legs) {
    const mark = marks.get(l.instrument.tradingsymbol)
    if (mark === undefined) continue
    mtm = (mtm ?? 0) + l.qty * (mark - l.entryPrice)
    if (!haveSpot) continue
    const intrinsic = l.type === 'CE' ? Math.max(spot - l.strike, 0) : Math.max(l.strike - spot, 0)
    netTv = (netTv ?? 0) - l.qty * (mark - intrinsic)
  }

  let neutral: BookTotals['neutral'] = null
  if (greeks !== undefined && (greeks.legs?.length ?? 0) > 0 && greeks.netGamma !== 0 && haveSpot) {
    const price = spot - greeks.netDelta / greeks.netGamma
    neutral = { price, pct: ((price - spot) / spot) * 100 }
  }

  return { mtm, netTv, neutral }
}

// ------------------------------------------------------- shorts-only greeks

/**
 * THE BOOK'S GREEKS RESTRICTED TO ITS SHORT LEGS — the set the rules read
 * under `delta_shorts_only` / `gamma_shorts_only` (every live recenter-relief
 * book; "buy legs are making issue so we ignore them from the position ...
 * its just for hedge", 2026-08-12).
 *
 * SAME ENGINE, SMALLER SET — this filters the per-leg figures the bridge
 * already computed and re-sums them, so the shorts-only tiles and the
 * shorts-only Pos delta total still reconcile by eye, the invariant the
 * whole-book view is read on. The strategy's own declared steering pair is a
 * DIFFERENT model (it prices off the future) and is served separately as
 * `steering`; where the page prefers it, it says so on the label rather than
 * mixing it into these sums.
 *
 * `unpriced` and `fallbackPriced` keep only contracts with a short leg: a
 * long hedge the feed cannot price does not qualify a total it is not in.
 * Note the limit of the symbol-keyed lists: a contract held BOTH ways (a
 * hedged pair) stays named even though only its short side is summed here —
 * over-warning, which is the safe direction.
 */
export function shortsOnlyGreeks(
  greeks: BookGreeks | undefined,
  legs: readonly BridgeLeg[],
): BookGreeks | undefined {
  if (greeks === undefined) return undefined
  const shortContracts = new Set(
    legs.filter((l) => l.qty < 0).map((l) => l.instrument.tradingsymbol),
  )
  const kept = (greeks.legs ?? []).filter((l) => l.qty < 0)
  const sum = (f: (l: BookGreeks['legs'][number]) => number): number =>
    kept.reduce((n, l) => n + f(l), 0)
  return {
    legs: kept,
    netDelta: sum((l) => l.positionDelta),
    netGamma: sum((l) => l.positionGamma),
    netVega: sum((l) => l.positionVega),
    netTheta: sum((l) => l.positionTheta),
    unpriced: (greeks.unpriced ?? []).filter((s) => shortContracts.has(s)),
    ...(greeks.fallbackPriced === undefined
      ? {}
      : { fallbackPriced: greeks.fallbackPriced.filter((s) => shortContracts.has(s)) }),
  }
}

// -------------------------------------------------------------- breakevens

/** One breakeven: the underlying price, and how far it is from spot. */
export interface Level {
  readonly price: number
  readonly pct: number
}

export interface BookBreakevens {
  /** The nearest price ABOVE spot at which the book expires flat. */
  readonly up: Level | null
  /** The nearest price BELOW spot at which the book expires flat. */
  readonly down: Level | null
}

/**
 * The book's at-expiry P&L at one underlying price.
 *
 * Intrinsic minus what was paid, times the signed quantity — so a short leg
 * (negative qty) earns the premium it collected and loses the intrinsic it ends
 * up owing. `entryPrice` and `strike` are all this needs, which is the property
 * that makes the whole calculation below independent of the feed: a book whose
 * every leg is UNPRICED still has breakevens, and they are exactly as reliable
 * as a fully marked one's.
 */
function payoffAt(legs: readonly BridgeLeg[], s: number): number {
  let total = 0
  for (const l of legs) {
    const intrinsic = l.type === 'CE' ? Math.max(s - l.strike, 0) : Math.max(l.strike - s, 0)
    total += l.qty * (intrinsic - l.entryPrice)
  }
  return total
}

/** Distinct strikes, ascending — the knots of the piecewise-linear payoff. */
function knotsOf(legs: readonly BridgeLeg[]): number[] {
  const seen = new Set<number>()
  for (const l of legs) if (l.strike > 0) seen.add(l.strike)
  return [...seen].sort((a, b) => a - b)
}

/**
 * The zero of a LINEAR payoff through two sampled points, or null when the
 * segment never reaches zero.
 *
 * Both tails and every interior segment are straight lines, so two evaluations
 * describe each one exactly — no iteration, and no tolerance to tune. The root
 * is only returned when it lies inside the segment it was derived from, which is
 * what stops a flat-but-profitable wing from reporting a breakeven behind it.
 */
function rootOn(pa: number, pb: number, a: number, b: number): number | null {
  if (pa === 0) return a
  if (pb === 0) return b
  // Same sign at both ends: a straight line between them does not cross zero.
  if ((pa < 0) === (pb < 0)) return null
  return a + ((b - a) * (0 - pa)) / (pb - pa)
}

/**
 * WHERE THE BOOK EXPIRES FLAT, above and below spot.
 *
 * The combined payoff of a book of options is piecewise linear in the underlying
 * with a knot at every strike, so its zeros are found exactly: sample each
 * segment at its two ends and interpolate, and extrapolate the two unbounded
 * tails from a second point inside them. No root-finding, no Black-Scholes, no
 * marks — this is arithmetic on strikes, entry prices and signed quantities, all
 * of which every stored leg carries.
 *
 * ONLY THE TWO NEAREST CROSSINGS ARE REPORTED, and they are the two the operator
 * is managing: the price above spot at which the position turns over, and the one
 * below. A butterfly or a condor has four, and a tile listing all of them would
 * bury the pair that matters — the far two are behind a wing the underlying has
 * to cross the near one to reach.
 *
 * `null` FOR A SIDE THAT HAS NO CROSSING, never a fabricated bound. A one-sided
 * book — a lone short put, a call spread — genuinely has no breakeven on one
 * side, and a flat tail (a fully hedged wing that ends profitable) has none
 * either. Both cases render as an em dash, which is the truth: there is no price
 * out there at which this book comes back to flat.
 *
 * `realised` IS THE RUN'S BOOKED P&L, and it shifts the whole curve by a
 * constant: the question the tile answers is where the RUN comes back to flat,
 * not where the open legs alone would. A repaired book whose open legs lose
 * everywhere at expiry — a spread paid over its width — but whose earlier legs
 * banked more than that loss has real levels, and without this term the tile
 * dashed both sides while the payoff panel (which folds realised in) printed a
 * band (TCS, 2026-08-21). Booked money is a constant no mark can change, so
 * the independence-from-the-feed property below survives it. `null` — the
 * bridge could not vouch for a figure — degrades to the open legs alone, the
 * same rule `sinceEntryTotal` applies.
 *
 * IT ASSUMES ONE EXPIRY, which is what this desk trades (see `contract.ts`). A
 * book holding two expiries at once would have its near legs valued as though
 * they expired with the far ones, so the figure would be a same-day payoff
 * rather than a breakeven; nothing here detects that, and it is the one input
 * that would make the answer wrong rather than merely absent.
 */
export function bookBreakevens(
  legs: readonly BridgeLeg[],
  spot: number | null,
  realised: number | null = null,
): BookBreakevens | null {
  if (typeof spot !== 'number' || !Number.isFinite(spot) || spot <= 0) return null
  // A leg closed to nothing contributes no payoff and no premium; including it
  // would tilt the curve by a trade that is already over — its money survives
  // as part of `realised` instead.
  const open = legs.filter((l) => l.qty !== 0)
  const knots = knotsOf(open)
  if (open.length === 0 || knots.length === 0) return null
  const booked = typeof realised === 'number' && Number.isFinite(realised) ? realised : 0
  // The run's payoff: the open legs' at-expiry value plus what is already in
  // the bank. A constant shift, so every slope below is untouched by it.
  const pay = (s: number): number => payoffAt(open, s) + booked

  const lowest = knots[0] as number
  const highest = knots[knots.length - 1] as number
  const crossings: number[] = []

  /*
    THE LOWER TAIL, below every strike.

    EXTRAPOLATED, not interpolated: there is no lower end to sample, so the slope
    comes from a second point under `lowest` — half of it, which is inside the
    tail for any positive strike — and the root is projected off it. Kept only if
    it lands in the tail AND above zero: an underlying cannot go negative, so a
    "breakeven" at -240 is not a level the operator can watch for, it is a book
    that never comes back.
  */
  {
    const a = lowest / 2
    const pa = pay(a)
    const pb = pay(lowest)
    const m = (pb - pa) / (lowest - a)
    // A flat tail either never reaches zero or is zero everywhere; neither is a
    // level, so neither is reported.
    if (m !== 0) {
      const x = lowest - pb / m
      if (x > 0 && x <= lowest) crossings.push(x)
    }
  }

  // Every interior segment, between one strike and the next.
  for (let i = 0; i + 1 < knots.length; i += 1) {
    const a = knots[i] as number
    const b = knots[i + 1] as number
    const root = rootOn(pay(a), pay(b), a, b)
    if (root !== null) crossings.push(root)
  }

  /*
    THE UPPER TAIL, above every strike. Same reasoning, extrapolated rather than
    interpolated because there is no far end to sample: the slope comes from a
    second point above `highest` and the root is kept only if it is up there.
  */
  {
    const b = highest * 1.5 + 1
    const pa = pay(highest)
    const pb = pay(b)
    const m = (pb - pa) / (b - highest)
    if (m !== 0) {
      const x = highest - pa / m
      if (x >= highest) crossings.push(x)
    }
  }

  const level = (price: number): Level => ({ price, pct: ((price - spot) / spot) * 100 })
  /*
    `>=` AND `<=`, so a book sitting exactly on a breakeven shows it on both
    sides at 0.0% rather than dropping it. Two crossings that land on the same
    price — a strike where the payoff touches zero and turns back — are the same
    level twice, and `Math.min`/`Math.max` collapse them for free.
  */
  const above = crossings.filter((c) => c >= spot)
  const below = crossings.filter((c) => c <= spot)
  return {
    up: above.length === 0 ? null : level(Math.min(...above)),
    down: below.length === 0 ? null : level(Math.max(...below)),
  }
}
