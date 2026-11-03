/**
 * P&L computed from OUR OWN fills, marked against the live feed.
 *
 * WHY this exists at all (B1): one engine for paper and live. The legacy
 * `strategyPNL` asked the broker for a number in live and made one up in paper,
 * so the two modes could never be compared and neither survived a restart. Here
 * the only inputs are the fills we ourselves booked and the marks we ourselves
 * hold, which makes the number reproducible: re-run the same fills tomorrow and
 * you get the same rupees.
 *
 * AVERAGE COST, NOT FIFO (B2). Options desks quote average. FIFO across a rolled
 * ladder — where a strike is sold, part-covered, re-sold and rolled out over a
 * week — books lots against each other in an order no human tracked, and the
 * realised figure it produces is one nobody recognises when they sit down with a
 * broker statement. Average cost gives the number the trader already has in
 * their head.
 *
 * GROSS, NOT NET (B3). `costs` is an explicit optional input defaulting to zero.
 * The Python desk owns its own charges via its `CostModel`; if we silently
 * applied a second, different one, our number and theirs would disagree for
 * reasons neither side could explain. Costs are a parameter so net can be added
 * later without a redesign, and so nobody can mistake our gross for their net.
 *
 * SHORT-OPEN IS A CREDIT and buying back realises. That is the normal case for
 * these books — they are short-premium — not an edge case, and it is the first
 * thing an implementation gets wrong.
 *
 * Pure: no IO, no Mongo, no clock. Persistence, the 15s snapshot loop and the
 * daily rollup all live in `apps/api`, where the book and the marks already are.
 */

/** Matches `DeskSide` in apps/api. Deliberately re-declared, not imported. */
export type PnlSide = 'Buy' | 'Sell'

/**
 * The minimum a fill must carry for P&L.
 *
 * A structural SUBSET of `apps/api/src/contract.ts:Fill`, so an api `Fill[]`
 * passes straight in — but declared here so this package depends on nothing.
 * `op`, `deskTag` and `ts` are carried as optional passthrough because callers
 * hand us whole fills; none of them affect the arithmetic.
 */
export interface PnlFill {
  readonly tradingsymbol: string
  readonly side: PnlSide
  /** Contract quantity traded by THIS fill. Always positive; the side signs it. */
  readonly qty: number
  readonly price: number
  /**
   * Epoch ms. Informational only — we never read a clock and never re-sort on
   * it. Fills are consumed in ARRAY ORDER, because average cost is
   * path-dependent and the caller's book order is the authoritative sequence;
   * two fills in the same millisecond would sort unstably and silently change
   * the average.
   */
  readonly ts?: number
}

/**
 * Charges to subtract, supplied by whoever owns the cost model. Absent means
 * zero, which is the default and the reported basis (B3).
 *
 * Two buckets only, and no formula: `bySymbol` for charges already attributed
 * to a contract, `book` for anything that is not (a flat daily fee). Deriving
 * brokerage/STT/stamp duty here would be inventing the very model B3 says we do
 * not own.
 */
export interface Costs {
  readonly bySymbol?: Readonly<Record<string, number>>
  readonly book?: number
}

/** Live marks by tradingsymbol. A missing entry is UNPRICED, never zero. */
export type Marks = Readonly<Record<string, number>>

export interface Position {
  readonly tradingsymbol: string
  /** SIGNED contract qty: negative is short. Same convention as apps/api. */
  readonly qty: number
  /**
   * Average price of the OPEN quantity — a price, so always >= 0 regardless of
   * side. Zero when flat, where it is meaningless rather than free.
   */
  readonly avgCost: number
  /** Booked P&L on this contract, GROSS of costs. */
  readonly realised: number
}

export interface UnrealisedLeg {
  readonly tradingsymbol: string
  readonly qty: number
  readonly avgCost: number
  readonly mark: number
  readonly unrealised: number
}

export interface UnrealisedResult {
  readonly total: number
  readonly legs: readonly UnrealisedLeg[]
  /**
   * Open contracts with no usable mark. Named, never dropped and never treated
   * as zero: a P&L of ₹0 and a P&L of "three legs could not be marked" must not
   * look identical. Same convention as `bookGreeks().unpriced`.
   */
  readonly unpriced: readonly string[]
}

export interface DayPnl {
  /** Booked, NET of `costs` if any were supplied. Gross by default. */
  readonly realised: number
  /** Open legs marked. Excludes anything in `unpriced`. */
  readonly unrealised: number
  readonly total: number
  readonly unpriced: readonly string[]
}

/** Mutable accumulator; `Position` is the frozen view of it. */
interface Acc {
  tradingsymbol: string
  qty: number
  avgCost: number
  realised: number
}

/**
 * Reject rather than absorb corrupt fills.
 *
 * A NaN price would poison an average cost and then every downstream rupee
 * figure — realised, unrealised, the snapshot, the rollup — with a NaN that
 * says nothing about where it came from. A qty of 0 or a negative price is
 * upstream corruption, and this package has no channel to report a skip through
 * (unlike `ApplyResult.skips`). Failing loudly at the boundary is the only
 * option that does not silently produce a wrong number.
 */
function assertUsable(f: PnlFill, i: number): void {
  if (typeof f.tradingsymbol !== 'string' || f.tradingsymbol === '') {
    throw new TypeError(`pnl: fill ${i} has no tradingsymbol`)
  }
  if (f.side !== 'Buy' && f.side !== 'Sell') {
    throw new TypeError(`pnl: fill ${i} (${f.tradingsymbol}) has side ${String(f.side)}`)
  }
  if (!Number.isFinite(f.qty) || f.qty <= 0) {
    throw new TypeError(`pnl: fill ${i} (${f.tradingsymbol}) has qty ${String(f.qty)}; must be > 0`)
  }
  if (!Number.isFinite(f.price) || f.price < 0) {
    throw new TypeError(`pnl: fill ${i} (${f.tradingsymbol}) has price ${String(f.price)}`)
  }
}

/**
 * Fold one fill into a contract's running position, average cost and realised.
 *
 * The whole engine is this function. The four cases:
 *
 *  - FLAT -> open at the fill price. A short opens at a negative qty and its
 *    avgCost is the premium RECEIVED; that credit is what a later buy-back
 *    realises against.
 *  - SAME DIRECTION -> weighted average. Adding to a short averages the credit
 *    up or down exactly as adding to a long averages the debit.
 *  - PARTIAL/FULL CLOSE -> realise the closed quantity against the average, and
 *    leave the remainder at the SAME average. Re-basing the remainder to the
 *    closing price would book P&L that has not happened.
 *  - REVERSAL THROUGH ZERO (short 5, buy 8) -> realise the ENTIRE short, then
 *    open the 3 that are left as a fresh long at the fill price. Blending the
 *    old short's credit into the new long's cost produces an average that is
 *    not a price of anything.
 */
function applyFill(a: Acc, f: PnlFill): void {
  const delta = f.side === 'Sell' ? -f.qty : f.qty

  if (a.qty === 0) {
    a.qty = delta
    a.avgCost = f.price
    return
  }

  const sameDirection = a.qty > 0 === delta > 0
  if (sameDirection) {
    const open = Math.abs(a.qty)
    const added = Math.abs(delta)
    a.avgCost = (a.avgCost * open + f.price * added) / (open + added)
    a.qty += delta
    return
  }

  const closedQty = Math.min(Math.abs(a.qty), Math.abs(delta))
  // Long: sold at `price`, carried at `avgCost`. Short: bought back at `price`
  // against a credit of `avgCost`. One line, both directions, no side lookup.
  const perUnit = a.qty > 0 ? f.price - a.avgCost : a.avgCost - f.price
  a.realised += closedQty * perUnit

  const remainder = Math.abs(delta) - closedQty
  a.qty += delta
  if (remainder > 0) {
    a.avgCost = f.price // reversal: a brand-new position at the price just paid
  } else if (a.qty === 0) {
    a.avgCost = 0 // flat: no open quantity for an average to describe
  }
  // else: partial close — the remainder keeps its original average, untouched.
}

/**
 * Net signed qty and average cost per contract, plus the realised booked along
 * the way (the walk computes it anyway; recomputing it in `realised()` would be
 * a second implementation of the same path-dependent arithmetic to keep in
 * sync).
 *
 * Flat contracts are RETAINED with qty 0. They still carry the day's realised,
 * and dropping them would delete booked P&L from the total — the commonest way
 * to lose a closed roll. Order is first-appearance in `fills`, so the output is
 * deterministic without depending on timestamps.
 */
export function buildPositions(fills: readonly PnlFill[]): readonly Position[] {
  const bySymbol = new Map<string, Acc>()
  for (let i = 0; i < fills.length; i++) {
    const f = fills[i]
    if (f === undefined) continue
    assertUsable(f, i)
    let acc = bySymbol.get(f.tradingsymbol)
    if (acc === undefined) {
      acc = { tradingsymbol: f.tradingsymbol, qty: 0, avgCost: 0, realised: 0 }
      bySymbol.set(f.tradingsymbol, acc)
    }
    applyFill(acc, f)
  }
  return [...bySymbol.values()].map((a) => ({
    tradingsymbol: a.tradingsymbol,
    qty: a.qty,
    avgCost: a.avgCost,
    realised: a.realised,
  }))
}

/** Sum of everything in `costs`. Absent buckets are zero, not an error. */
export function totalCosts(costs?: Costs): number {
  if (costs === undefined) return 0
  let sum = costs.book ?? 0
  for (const v of Object.values(costs.bySymbol ?? {})) sum += v
  return sum
}

/**
 * Booked P&L, average-cost basis (B2), minus `costs` if supplied.
 *
 * Costs are charged against REALISED rather than spread over unrealised:
 * charges fall on executed trades, and a mark moving does not create a
 * brokerage bill. It also keeps the deduction idempotent — marking the book a
 * hundred times a day must not deduct the same charge a hundred times.
 */
export function realised(fills: readonly PnlFill[], costs?: Costs): number {
  let gross = 0
  for (const p of buildPositions(fills)) gross += p.realised
  return gross - totalCosts(costs)
}

/**
 * A mark is usable only if it is a finite, non-negative number.
 *
 * `undefined` (feed has nothing yet), `null` cast through a loose caller, NaN
 * and negatives are all "we do not know", and all route to `unpriced`. Zero IS
 * usable — a worthless far OTM option genuinely marks at zero, and treating
 * that as missing would hide a leg that is fully realised gain on a short.
 */
function usableMark(m: number | undefined): m is number {
  return typeof m === 'number' && Number.isFinite(m) && m >= 0
}

/**
 * Mark the open legs.
 *
 * Flat positions (qty 0) need no mark and are NOT reported unpriced — they have
 * no exposure, so a missing quote for them is not a gap in the number. Only
 * genuinely open legs can be unpriced.
 */
export function unrealised(positions: readonly Position[], marks: Marks): UnrealisedResult {
  const legs: UnrealisedLeg[] = []
  const unpriced: string[] = []
  let total = 0

  for (const p of positions) {
    if (p.qty === 0) continue
    const mark = marks[p.tradingsymbol]
    if (!usableMark(mark)) {
      unpriced.push(p.tradingsymbol)
      continue
    }
    // Signed qty does the work: short 13125 at 15.00 marked 12.00 gives
    // -13125 * (12 - 15) = +39,375. The credit is a gain as the option decays.
    const value = p.qty * (mark - p.avgCost)
    legs.push({
      tradingsymbol: p.tradingsymbol,
      qty: p.qty,
      avgCost: p.avgCost,
      mark,
      unrealised: value,
    })
    total += value
  }

  return { total, legs, unpriced }
}

/**
 * The day's number: realised (net of any costs) plus the marked open legs.
 *
 * `total` deliberately excludes the unpriced legs rather than guessing at them,
 * and names them instead. A caller rendering this must show the book as PARTIAL
 * when `unpriced` is non-empty — the same convention as the positions endpoint,
 * for the same reason (§8).
 */
export function dayPnl(fills: readonly PnlFill[], marks: Marks, costs?: Costs): DayPnl {
  const positions = buildPositions(fills)
  let gross = 0
  for (const p of positions) gross += p.realised
  const booked = gross - totalCosts(costs)
  const open = unrealised(positions, marks)
  return {
    realised: booked,
    unrealised: open.total,
    total: booked + open.total,
    unpriced: open.unpriced,
  }
}
