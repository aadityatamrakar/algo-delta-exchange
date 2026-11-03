/**
 * THE ENTRY PLAN — what order to place a structure's legs in, and when it is
 * safe to call the resulting position a book.
 *
 * The Create wizard SEEDS legs: it declares "the book holds this" and places
 * nothing. This is the other half — actually opening the position — and the
 * only two decisions that matter are sequencing and when to stop.
 *
 * Pure and separately testable on purpose: the page around it is buttons and
 * fetches, but "did we just leave a naked short" is arithmetic, and arithmetic
 * belongs somewhere it can be asserted.
 */

import { VENUE } from './venue.ts'

export type Side = 'Buy' | 'Sell'

export interface EntryLeg {
  readonly strike: number
  readonly type: 'CE' | 'PE'
  /** Signed, in contracts: negative is short. Matches the seed-file shape. */
  readonly qty: number
  readonly tradingsymbol: string
  readonly instrumentToken: number
}

export interface PlacedFill {
  readonly tradingsymbol: string
  /** What it ACTUALLY filled at. The book's cost basis comes from here. */
  readonly price: number
  readonly qty: number
}

export const sideOf = (leg: EntryLeg): Side => (leg.qty < 0 ? 'Sell' : 'Buy')

/**
 * WINGS FIRST, THEN SHORTS.
 *
 * If the shorts fill and a wing does not, the position is a naked short
 * strangle — unlimited risk, on a book that was never meant to carry it. The
 * reverse merely spends the wing premium and leaves a long option nobody
 * wanted, which costs money and cannot blow up.
 *
 * Within each group the original order is kept, so what the operator typed is
 * what they see.
 */
export function entrySequence(legs: readonly EntryLeg[]): readonly EntryLeg[] {
  return [...legs.filter((l) => sideOf(l) === 'Buy'), ...legs.filter((l) => sideOf(l) === 'Sell')]
}

/** The venue's options tick (Delta 0.1); matches the server's `marketable.ts` default. */
const DEFAULT_TICK = VENUE.defaultTick

/**
 * A price that CROSSES the touch, so the order fills at once with the limit as
 * a worst-case bound rather than resting.
 *
 * The same formula the server applies to unpriced supervisor actions
 * (`apps/api/src/marketable.ts`) — `max(pct x mark, minTicks x tick)`, sell
 * below and buy above, rounded in the direction that keeps it marketable. Kept
 * in step deliberately: an entry priced by a different rule than the management
 * that follows it would make the two incomparable in the journal.
 *
 * `null` when there is no usable mark. The caller must then ask the operator
 * rather than invent a price.
 */
export function suggestedLimit(
  side: Side,
  mark: number,
  opts: { bufferPct?: number; minTicks?: number; tickSize?: number } = {},
): number | null {
  if (!Number.isFinite(mark) || mark <= 0) return null
  const tick = opts.tickSize !== undefined && opts.tickSize > 0 ? opts.tickSize : DEFAULT_TICK
  const buffer = Math.max((opts.bufferPct ?? 0.02) * mark, (opts.minTicks ?? 2) * tick)
  const raw = side === 'Sell' ? mark - buffer : mark + buffer
  const ticks =
    side === 'Sell' ? Math.floor(raw / tick + 1e-9) : Math.ceil(raw / tick - 1e-9)
  return Math.round(Math.max(ticks, 1) * tick * 100) / 100
}

/**
 * How old a mark may be before it must not drive a suggested price.
 *
 * A limit pre-filled from a stale print is worse than an empty box: the box
 * makes an operator look at the depth, the number invites them to press Place.
 * 60s is generous for a liquid strike and still catches a pre-open or an
 * illiquid wing whose last trade was an hour ago.
 */
export const MARK_STALE_MS = 60_000

export interface QuoteLike {
  readonly price: number
  readonly ageMs: number
}

export interface Suggestion {
  readonly price: number | null
  /** Why there is no price, for the operator. Empty when there is one. */
  readonly reason: string
}

/**
 * A suggested limit from a live quote, or nothing plus the reason.
 *
 * NOTE WHAT THE MARK IS. The chain carries LAST TRADED PRICE and no bid/ask
 * (`ChainQuote`), so this crosses relative to the last print, not to the touch.
 * On a wide spread it may not cross at all — which is why this is a suggestion
 * in an editable box and not a price the screen sends by itself.
 */
export function suggestFromQuote(
  side: Side,
  quote: QuoteLike | null | undefined,
  opts: { tickSize?: number; staleMs?: number } = {},
): Suggestion {
  if (quote === null || quote === undefined) {
    return { price: null, reason: 'no quote yet — check the depth and type a price' }
  }
  const limit = opts.staleMs ?? MARK_STALE_MS
  if (quote.ageMs > limit) {
    return {
      price: null,
      reason: `last trade was ${Math.round(quote.ageMs / 1000)}s ago — too stale to price from`,
    }
  }
  const p = suggestedLimit(
    side,
    quote.price,
    opts.tickSize === undefined ? {} : { tickSize: opts.tickSize },
  )
  return p === null
    ? { price: null, reason: 'the quote has no usable price' }
    : { price: p, reason: '' }
}

export interface EntryState {
  readonly filled: readonly EntryLeg[]
  readonly outstanding: readonly EntryLeg[]
  readonly complete: boolean
  /**
   * A SHORT WITH NO WING BEHIND IT on the same side. Unlimited risk, and the
   * single state this screen exists to make impossible to miss.
   */
  readonly nakedShorts: readonly EntryLeg[]
  /** Safe to create the book? Only a complete structure qualifies. */
  readonly canBuild: boolean
}

/**
 * Where the entry currently stands.
 *
 * `canBuild` requires EVERY leg, not merely "no naked shorts". A book seeded
 * from a partial structure hands the supervisor a position nobody chose, and
 * recenter would then manage the delta of it — so a half-built entry is
 * something to finish or unwind by hand, never something to start managing.
 */
export function entryState(
  legs: readonly EntryLeg[],
  fills: readonly PlacedFill[],
): EntryState {
  const done = new Set(fills.map((f) => f.tradingsymbol))
  const filled = legs.filter((l) => done.has(l.tradingsymbol))
  const outstanding = legs.filter((l) => !done.has(l.tradingsymbol))

  // A short is covered when a LONG of the same option type has filled — the
  // wing is what bounds it. Same side (CE/PE), not merely "some long exists".
  const longTypes = new Set(filled.filter((l) => sideOf(l) === 'Buy').map((l) => l.type))
  const nakedShorts = filled.filter((l) => sideOf(l) === 'Sell' && !longTypes.has(l.type))

  return {
    filled,
    outstanding,
    complete: outstanding.length === 0 && legs.length > 0,
    nakedShorts,
    canBuild: outstanding.length === 0 && legs.length > 0,
  }
}

/**
 * The seed-file legs, priced at what ACTUALLY filled.
 *
 * Seeding at the requested price would give the book a cost basis that never
 * happened, and every P&L, target and scrap decision after it inherits the
 * error. Throws rather than guessing when a fill is missing — a book is not
 * worth creating from half-known prices.
 */
export function seedLegsFromFills(
  legs: readonly EntryLeg[],
  fills: readonly PlacedFill[],
): { strike: number; type: 'CE' | 'PE'; qty: number; rate: number }[] {
  return legs.map((l) => {
    const f = fills.find((x) => x.tradingsymbol === l.tradingsymbol)
    if (f === undefined) throw new Error(`no fill recorded for ${l.tradingsymbol}`)
    return { strike: l.strike, type: l.type, qty: l.qty, rate: f.price }
  })
}
