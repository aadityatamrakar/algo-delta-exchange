/**
 * THE PURE ARITHMETIC BEHIND THE REPAIR APPLY BUTTON.
 *
 * A repair candidate is a list of MOVES — the vocabulary `packages/payoff`
 * reasons in (`add`, `hedge`, `shift`, `close`, signed shares, leg ids). A
 * broker takes ORDERS — a side, a contract, a whole number of lots. This module
 * is the one place that crossing happens, and it is a total function of its
 * arguments so that the crossing can be read, tested and reviewed on its own:
 * no store, no chain service, no clock.
 *
 * THREE PROPERTIES IT EXISTS TO HOLD.
 *
 * 1. IDENTITY. A `close` names a leg by the id `assemble` handed out
 *    (`routes/payoff.ts:640-648`) — the contract's tradingsymbol, suffixed
 *    `#2`, `#3` … when the book holds that contract more than once. That
 *    counter is rebuilt here EXACTLY, including the skip of `qty === 0` legs.
 *    Off by one and the Apply button closes the other pocket of a doubled
 *    strike, for real money, with every screen still reading correct.
 *
 * 2. IT NEVER GUESSES. A move whose leg no longer joins, whose size is not a
 *    whole number of lots, or whose contract the chain does not list is
 *    DROPPED and named — never rounded, never routed at a reconstructed
 *    symbol. `/v1/desk/repair/apply` refuses outright when anything is
 *    dropped, so a drop here is a refusal there, which is the intended
 *    severity: the operator finishes by hand rather than executing a plan the
 *    bridge only half understood.
 *
 * 3. A SHIFT IS ATOMIC, the same rule `applyMoves` holds (`moves.ts:235`). If
 *    either half cannot be resolved, NEITHER is emitted. A half-applied shift
 *    is the naked-book state the desk's own playbook guards against.
 *
 * WAVES, not a flat list. Closes execute before opens (spec §6.2), so the
 * output is grouped that way and the grouping is part of the plan rather than
 * something the executor re-derives: closes in BOOK order, opens in MOVE
 * order. `moveIndex` keeps every order traceable to the sentence the operator
 * read on the card — a shift's two orders share one index.
 */

import { createHash } from 'node:crypto'
import { bookGreeks, type OptionType, type PositionLeg } from '@algomaker/greeks'
import type { Move } from '@algomaker/payoff'
import type { InstrumentRef } from '@algomaker/order-bus'
import type { BridgeLeg } from './contract.ts'
import type { ChainResponse, DepthBook, DepthLevel } from './chain.ts'

/** Only when the source ref omits them — never overriding what the master said. */
const DEFAULT_TICK_SIZE = 0.05
const DEFAULT_EXCHANGE = 'NFO'

/** One broker-bound order a move expands into. `lots`, not units — see `submit`. */
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
  /**
   * THE DESK LEG THIS ORDER CLOSES — the Python driver's own leg id, copied
   * off the `BridgeLeg` this close was resolved against. Closes only; an open
   * closes nothing and carries none.
   *
   * IT IS THE ONE THING THAT MAKES A REPAIR'S P&L REAL. The driver books a
   * leg's realized P&L in `absorb_bridge_closes` (`translate.py`) by matching
   * a confirmed `close` trade whose `desk_tag` EQUALS the leg's id — the same
   * equality the dashboard's close-leg path preserves by posting the leg's `ts`
   * as the action's deskTag. A repair's fills are tagged with the ORDER's id by
   * default, so the match never fires: the driver sees the leg gone from the
   * bridge, drops it with "P&L is NOT booked", and the profit that repair banked
   * never reaches `cum_realized` or the target lock that reads it.
   *
   * So the id travels with the order — `SubmitRequestBody.fillDeskTag`,
   * `submit-plan.ts:trancheFill` — and the fill lands under the leg's own name.
   */
  readonly deskTag?: string
}

function finite(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/**
 * THE LOT SIZE THE CONTRACT ITSELF CARRIES, falling back to the book's.
 *
 * A leg stored before an exchange lot-size revision carries the old one, and
 * the book's chain carries the new: dividing a stored qty by the NEW size is
 * how a 175-share leg becomes 1.4 lots and is dropped. The contract's own
 * number is the one its qty was multiplied out by.
 */
function lotSizeOf(ref: InstrumentRef | undefined, fallback: number): number {
  const own = finite(ref?.lotSize)
  return own !== null && own > 0 ? own : fallback
}

/** Whole lots, or null — a fractional or non-positive size is never rounded. */
function wholeLots(units: number, lotSize: number): number | null {
  if (!(lotSize > 0)) return null
  const lots = Math.abs(units) / lotSize
  return Number.isInteger(lots) && lots > 0 ? lots : null
}

/**
 * The contract as `PlannedOrder` needs it, or null when the source ref cannot
 * identify one. The TOKEN is required and never defaulted: it is how every
 * quote, mark and depth walk downstream finds this contract, and a zero there
 * would read as a real token that simply never prints.
 */
function contractOf(
  ref: InstrumentRef | undefined,
  fallbackLotSize: number,
): PlannedOrder['instrument'] | null {
  if (ref === undefined || ref === null) return null
  const tradingsymbol = typeof ref.tradingsymbol === 'string' ? ref.tradingsymbol : ''
  const token = finite(ref.instrumentToken)
  if (tradingsymbol === '' || token === null) return null
  const tick = finite(ref.tickSize)
  const exchange = typeof ref.exchange === 'string' && ref.exchange !== '' ? ref.exchange : DEFAULT_EXCHANGE
  return {
    tradingsymbol,
    instrumentToken: token,
    lotSize: lotSizeOf(ref, fallbackLotSize),
    tickSize: tick !== null && tick > 0 ? tick : DEFAULT_TICK_SIZE,
    exchange,
  }
}

function contractAt(chain: ChainResponse | null, strike: number, type: OptionType): InstrumentRef | undefined {
  const row = chain?.rows.find((r) => r.strike === strike)
  if (row === undefined) return undefined
  return type === 'CE' ? row.ceContract : row.peContract
}

/**
 * WHICH OF THE TWO THINGS IS THIS OPEN — an exit, or new exposure?
 *
 * The server-side twin of the Manual Order dialog's `classifyExposure`
 * (`apps/web/src/manual-order-plan.ts:207`), deliberately to the letter: the
 * same order must not be called an exit on one screen and a new leg on the
 * other. NETTED across every leg on the contract (a book may legally hold one
 * contract on several legs), and SIGNS are compared, not sizes — netting is
 * the only conservatism the rule claims.
 *
 * The net is taken over the book AS SERVED, not over the book the earlier
 * moves in this plan would leave behind. Closes execute first, so a plan that
 * closed a short and then bought the same contract would be flagged `reduces`
 * against exposure that is already gone — no repair candidate re-opens the
 * contract it just closed, and the flag is re-derived server-side at apply
 * time from the book of that moment.
 */
function reducesExposure(legs: readonly BridgeLeg[], tradingsymbol: string, side: 'Buy' | 'Sell'): boolean {
  const net = legs
    .filter((l) => l.instrument.tradingsymbol === tradingsymbol)
    .reduce((sum, l) => sum + (finite(l.qty) ?? 0), 0)
  const direction = side === 'Buy' ? 1 : -1
  return net !== 0 && Math.sign(net) !== direction
}

/** The move as the drop sentence names it — `applyMoves`' warning vocabulary. */
function describe(move: Move): string {
  if (move === null || typeof move !== 'object') return 'a move that was not an object'
  if (move.op === 'close') return `close "${String(move.legId)}"`
  if (move.op === 'shift') return `shift "${String(move.legId)}" to ${String(move.toStrike)}`
  if (move.op === 'add' || move.op === 'hedge') {
    return `${move.op} ${String(move.strike)}${String(move.type)} x ${String(move.qty)}`
  }
  return `unknown move "${String((move as { op?: unknown }).op)}"`
}

/**
 * The book's legs by the id the repair engine addresses them by.
 *
 * `assemble`'s assignment, reproduced move for move: walk in served order,
 * skip `qty === 0` (a closed pocket holds no id), first occurrence takes the
 * bare tradingsymbol, later ones `#2`, `#3` … The index is kept so the close
 * wave can be emitted in book order.
 */
function legsById(legs: readonly BridgeLeg[]): Map<string, { readonly leg: BridgeLeg; readonly index: number }> {
  const byId = new Map<string, { readonly leg: BridgeLeg; readonly index: number }>()
  const used = new Set<string>()
  legs.forEach((leg, index) => {
    if (leg === null || typeof leg !== 'object' || leg.qty === 0) return
    const name = leg.instrument?.tradingsymbol ?? ''
    let id = name
    for (let n = 2; used.has(id); n += 1) id = `${name}#${n}`
    used.add(id)
    byId.set(id, { leg, index })
  })
  return byId
}

// ------------------------------------------- the menu's legs, fingerprinted

/**
 * ONE LEG AS A FINGERPRINT SEES IT — its contract, its size, its entry.
 *
 * Deliberately NOT `BridgeLeg` or `PayoffLeg`. This desk holds one book in
 * three shapes (Python's leg, the bridge's, the cockpit's) and a fingerprint
 * declared over any one of them would move whenever that shape gained a field
 * it does not care about. `bookLegsPrint` below is the adapter for the one
 * shape both call sites actually hold; this is what the hash is OF.
 */
export interface PrintableLeg {
  readonly tradingsymbol: string
  readonly qty: number
  readonly entryPrice: number
}

/** `TCS26AUG2340CE#2` -> `TCS26AUG2340CE`. See `legsPrint`. */
function bareSymbol(name: unknown): string {
  // An exchange tradingsymbol never carries a `#`; the suffix is `assemble`'s
  // own doubled-pocket counter and is reproduced positionally by `legsById`,
  // so stripping it is lossless — the POSITION in the list carries that fact.
  return typeof name === 'string' ? name.replace(/#\d+$/, '') : ''
}

/**
 * THE LEGS THIS MENU WAS DRAWN AGAINST, FINGERPRINTED.
 *
 * `bookPrint` already pins a preflight to the whole valuation — book, chain,
 * future, margin — and that is the right guard between a PREVIEW and the
 * ORDERS it authorises, because everything in it is an input the preview's
 * numbers came out of. It is the wrong guard one step earlier: the repair MENU
 * is read for minutes, its prices tick the whole time, and a fingerprint that
 * moved with them would refuse every card the operator ever clicked.
 *
 * What must not move under a card is the thing its sentences ADDRESS: a legId
 * is POSITIONAL (`legsById`), so a book that loses one pocket of a doubled
 * contract re-points `TCS26AUG2340CE#2` at a leg that was never on the card —
 * silently, at full size, in the right direction to look plausible. This is the
 * hash that catches exactly that and nothing else: the contracts, their sizes
 * and their entries, IN THE SERVED ORDER. Quotes are not in it; the book is.
 *
 * A flattened pocket is skipped, because it holds no id either (`legsById`,
 * `assemble`) — carrying it would make the print disagree with the ids it
 * exists to vouch for.
 */
export function legsPrint(legs: readonly PrintableLeg[]): string {
  const parts: string[] = []
  for (const l of Array.isArray(legs) ? legs : []) {
    if (l === null || typeof l !== 'object') continue
    const qty = finite(l.qty)
    if (qty === null || qty === 0) continue
    parts.push(`${bareSymbol(l.tradingsymbol)}|${qty}|${finite(l.entryPrice) ?? ''}`)
  }
  return createHash('sha1').update(parts.join(';')).digest('hex')
}

/**
 * `legsPrint` over the cockpit's own leg shape (`Assembled.legs`).
 *
 * The ONE place that says which fields of a served leg are its identity, so the
 * menu (`routes/payoff.ts:repairOf`) and the preflight (`routes/repair.ts`) can
 * never come to disagree by mapping it two ways. `id` rather than a
 * tradingsymbol because that is what the served leg carries — `legsPrint`
 * strips the `#n` back off, so the two spellings print alike.
 */
export function bookLegsPrint(
  legs: readonly { readonly id: string; readonly qty: number; readonly entry: number }[],
): string {
  return legsPrint(legs.map((l) => ({ tradingsymbol: l.id, qty: l.qty, entryPrice: l.entry })))
}

/**
 * Expand `moves` into the orders they would place, against the book AS IT
 * STANDS NOW — never against the snapshot the candidate was searched on. A leg
 * the bot has since shifted no longer joins, and that move is dropped rather
 * than aimed at whatever now sits under its old id.
 */
export function resolveOrders(input: {
  readonly legs: readonly BridgeLeg[]
  readonly moves: readonly Move[]
  readonly chain: ChainResponse | null
  readonly lotSize: number
  readonly bookExpiry: string
  /**
   * WHY THE CALLER CANNOT VOUCH FOR THESE LEG IDS, when it cannot.
   *
   * Present ⇒ every `close` and `shift` is DROPPED carrying this sentence,
   * rather than resolved against whatever now sits under its id. `add` and
   * `hedge` are untouched: they name a strike and a side, not a leg, so
   * nothing about them can have re-pointed.
   *
   * It is an input rather than something the caller filters out first because
   * `moveIndex` is the array position — the sentence the operator read on the
   * card — and a caller that pruned the list would renumber every move behind
   * the pruned one.
   */
  readonly legIdsStale?: string
}): { readonly orders: readonly PlannedOrder[]; readonly dropped: readonly string[] } {
  const legs = Array.isArray(input.legs) ? input.legs.filter((l) => l !== null && typeof l === 'object') : []
  const byId = legsById(legs)
  const bookLotSize = finite(input.lotSize) ?? 0
  const bookExpiry = typeof input.bookExpiry === 'string' ? input.bookExpiry : ''

  const closes: { readonly index: number; readonly order: PlannedOrder }[] = []
  const opens: PlannedOrder[] = []
  const dropped: string[] = []
  const drop = (move: Move, why: string): void => {
    dropped.push(`${describe(move)}: ${why}`)
  }

  /** The order that takes a held leg off: opposite the SIGN, its full size. */
  const closeOrder = (leg: BridgeLeg, moveIndex: number): PlannedOrder | string => {
    const qty = finite(leg.qty)
    if (qty === null || qty === 0) return 'the book holds no size on it — dropped'
    const instrument = contractOf(leg.instrument, bookLotSize)
    if (instrument === null) return 'the book carries no identifiable contract for it — dropped'
    const lots = wholeLots(qty, instrument.lotSize)
    if (lots === null) {
      return (
        `${Math.abs(qty)} shares is not a whole number of ${instrument.lotSize}-share lots — ` +
        'dropped rather than rounded to a size nobody chose'
      )
    }
    return {
      wave: 'close',
      moveIndex,
      // The SIGN is the side. `leg.side` is the word the leg was opened with
      // and a resize can leave it standing against the qty it now holds.
      side: qty < 0 ? 'Buy' : 'Sell',
      instrument,
      strike: finite(leg.strike) ?? 0,
      type: leg.type,
      expiry: typeof leg.expiry === 'string' && leg.expiry !== '' ? leg.expiry : bookExpiry,
      lots,
      // A close is an exit by construction, whatever the book nets to.
      reducesExposure: true,
      /**
       * The leg's OWN id, carried so the fill can be booked against it — see
       * `PlannedOrder.deskTag`. Absent when the book carries no id for the leg
       * (a bridge-only leg written before the field, a seeded row): an empty
       * string would be an id that matches nothing, which is the failure this
       * exists to prevent wearing the shape of the fix. `exactOptionalProperty
       * Types`, so it is an ABSENT key rather than an explicit undefined.
       */
      ...(typeof leg.deskTag === 'string' && leg.deskTag !== '' ? { deskTag: leg.deskTag } : {}),
    }
  }

  /** The order that puts a new contract on: the chain's identity, the sign's side. */
  const openOrder = (
    strike: number,
    type: OptionType,
    qty: number,
    expiry: string,
    moveIndex: number,
  ): PlannedOrder | string => {
    if (!(bookLotSize > 0)) return 'this book has no lot size, so a size in lots cannot be stated — dropped'
    const instrument = contractOf(contractAt(input.chain, strike, type), bookLotSize)
    if (instrument === null) {
      return `the chain lists no ${strike}${type} contract — dropped rather than opened at a guessed symbol`
    }
    const lots = wholeLots(qty, instrument.lotSize)
    if (lots === null) {
      return (
        `${Math.abs(qty)} shares is not a whole number of ${instrument.lotSize}-share lots — ` +
        'dropped rather than rounded to a size nobody chose'
      )
    }
    if (expiry === '') return 'there is no expiry to open it in — dropped'
    return {
      wave: 'open',
      moveIndex,
      side: qty < 0 ? 'Sell' : 'Buy',
      instrument,
      strike,
      type,
      expiry,
      lots,
      reducesExposure: reducesExposure(legs, instrument.tradingsymbol, qty < 0 ? 'Sell' : 'Buy'),
    }
  }

  const moves = Array.isArray(input.moves) ? input.moves : []
  const stale = typeof input.legIdsStale === 'string' && input.legIdsStale !== '' ? input.legIdsStale : null
  /**
   * THE LEGS THIS PLAN HAS ALREADY SPENT.
   *
   * A leg id names a POCKET holding a size, and every order this module emits
   * against one is that pocket's FULL size — there is no partial close. So two
   * moves on one id are not two orders, they are one order and one order that
   * opens the same leg back the other way: close a two-lot short twice and the
   * book ends the repair two lots LONG, which is exposure nobody chose, in the
   * direction the repair was reducing.
   *
   * Claimed on EMISSION rather than on mention: a first move that was itself
   * dropped spent nothing, so a later move on the same leg is the only one
   * that ever addressed it and must still resolve.
   */
  const spent = new Set<string>()
  /** The repeat's own sentence — it names the leg, so it is actionable alone. */
  const REPEAT =
    'that leg is already taken by an earlier move in this plan — dropped rather than placed a ' +
    'second time at its full size'

  moves.forEach((move, moveIndex) => {
    if (move === null || typeof move !== 'object') {
      drop(move, 'it is not a move this bridge can read — dropped')
      return
    }

    if (move.op === 'close') {
      const legId = String(move.legId)
      if (stale !== null) {
        drop(move, stale)
        return
      }
      if (spent.has(legId)) {
        drop(move, REPEAT)
        return
      }
      const held = byId.get(legId)
      if (held === undefined) {
        drop(move, 'no such leg in the book — dropped')
        return
      }
      const order = closeOrder(held.leg, moveIndex)
      if (typeof order === 'string') {
        drop(move, order)
        return
      }
      spent.add(legId)
      closes.push({ index: held.index, order })
      return
    }

    if (move.op === 'shift') {
      const legId = String(move.legId)
      if (stale !== null) {
        drop(move, stale)
        return
      }
      if (spent.has(legId)) {
        drop(move, REPEAT)
        return
      }
      const held = byId.get(legId)
      if (held === undefined) {
        drop(move, 'no such leg in the book — dropped')
        return
      }
      const leg = held.leg
      const toStrike = finite(move.toStrike)
      if (toStrike === null) {
        drop(move, 'that is not a strike — dropped')
        return
      }
      if (toStrike === finite(leg.strike)) {
        // `applyMoves` skips this outright (moves.ts:229) and so does the
        // playbook: two fills, and the book unchanged at the end of them.
        drop(move, 'it is already there — dropped')
        return
      }
      const out = closeOrder(leg, moveIndex)
      const back =
        typeof out === 'string'
          ? out
          : openOrder(toStrike, leg.type, leg.qty, out.expiry, moveIndex)
      if (typeof out === 'string' || typeof back === 'string') {
        // ATOMIC. Both halves or neither — a shift that half-lands leaves the
        // book one leg naked, which is the state nothing downstream expects.
        drop(move, `${typeof out === 'string' ? out : back} — the whole shift is dropped, never half-applied`)
        return
      }
      spent.add(legId)
      closes.push({ index: held.index, order: out })
      opens.push(back)
      return
    }

    if (move.op === 'add' || move.op === 'hedge') {
      const strike = finite(move.strike)
      const qty = finite(move.qty)
      const type = move.type === 'CE' || move.type === 'PE' ? move.type : null
      if (strike === null || type === null || qty === null || qty === 0) {
        drop(move, 'not a tradeable leg — dropped')
        return
      }
      const order = openOrder(strike, type, qty, bookExpiry, moveIndex)
      if (typeof order === 'string') {
        drop(move, order)
        return
      }
      opens.push(order)
      return
    }

    // Not silently ignored: `dropped` is what the apply route refuses on, and a
    // move nothing here understands must stop the plan rather than shrink it.
    drop(move, 'this bridge has no such move — dropped')
  })

  const ordered = [...closes].sort((a, b) => a.index - b.index).map((c) => c.order)
  return { orders: [...ordered, ...opens], dropped }
}

// ------------------------------------------- what the size actually pays

/**
 * What the book says this size costs — not what the last print said.
 *
 * `price` is a qty-weighted average over the levels the order would eat, so a
 * two-lot order into a one-lot touch is priced at what the second lot costs
 * too. `coveredQty` is the whole visible side, which is the number that says
 * how much room there was; `exceedsDepth` is the plain reading of it against
 * the size asked for.
 */
export interface FillEstimate {
  /** Qty-weighted average across the levels walked. Null when none were. */
  readonly price: number | null
  /** Depth qty visible on the walked side, whether or not it was consumed. */
  readonly coveredQty: number
  readonly exceedsDepth: boolean
  readonly quoteAgeMs: number | null
}

/** Best-first, and only levels that are actually tradeable. */
function levels(depth: DepthBook | undefined, side: 'buy' | 'sell'): readonly DepthLevel[] {
  const raw = side === 'buy' ? depth?.buy : depth?.sell
  if (!Array.isArray(raw)) return []
  return raw.filter(
    (l) => l !== null && typeof l === 'object' && (finite(l.price) ?? 0) > 0 && (finite(l.qty) ?? 0) > 0,
  )
}

/**
 * WALK THE BOOK FOR THE SIZE, at the side that side would have to take: a BUY
 * lifts asks, a SELL hits bids. Anything else prices a repair at the mid of a
 * spread nobody is going to trade at.
 *
 * A partial walk is answered honestly rather than refused: the VWAP of what IS
 * visible, with `exceedsDepth` set. The modal says "the book only shows N" and
 * the operator decides — a null there would be read as "no market", which is a
 * different and worse fact than "a thinner one than you asked for".
 *
 * Null ONLY when there is no quote at all. An empty side is a quote that
 * prices nothing, and the two are not the same thing to a screen.
 */
export function estimateFill(
  side: 'Buy' | 'Sell',
  qtyUnits: number,
  quote: { readonly depth?: DepthBook; readonly ageMs: number } | null | undefined,
): FillEstimate | null {
  if (quote === null || quote === undefined || typeof quote !== 'object') return null
  const quoteAgeMs = finite(quote.ageMs)
  const book = levels(quote.depth, side === 'Buy' ? 'sell' : 'buy')
  const want = Math.max(finite(qtyUnits) ?? 0, 0)

  let coveredQty = 0
  let taken = 0
  let cost = 0
  for (const level of book) {
    const qty = finite(level.qty) ?? 0
    const price = finite(level.price) ?? 0
    coveredQty += qty
    const eaten = Math.min(Math.max(want - taken, 0), qty)
    taken += eaten
    cost += eaten * price
  }

  return {
    price: taken > 0 ? cost / taken : null,
    coveredQty,
    exceedsDepth: coveredQty < want,
    quoteAgeMs,
  }
}

// -------------------------------------- the book as it would stand, in delta

/**
 * THE PANEL IS READ AGAINST THE POSITIONS TILES, so it is computed by the same
 * engine those tiles are: the bridge's `bookGreeks` on cash spot with the
 * book's carry, `bookTotals`' Δ0 (`apps/web/src/positions.ts:428`), and the
 * shorts-only filter (`positions.ts:459`). The cockpit's Black-76 greeks are
 * deliberately NOT used here — two models in one panel is how a hedge gets
 * sized against a delta that no other screen agrees with.
 */
export interface DeltaFigures {
  readonly netDelta: number | null
  readonly netGamma: number | null
  /** The underlying price at which this book is flat, and how far that is. */
  readonly neutral: { readonly price: number; readonly pct: number } | null
}

/** The whole book, and the set the recenter rules actually steer by. */
export interface DeltaPicture {
  readonly all: DeltaFigures
  readonly shortsOnly: DeltaFigures
}

const NOTHING_PRICED: DeltaFigures = { netDelta: null, netGamma: null, neutral: null }

/**
 * What this module hands `bookGreeks`, DECLARED rather than smuggled.
 *
 * `fallbackVol` is the Positions engine's model pass (`service.ts:1399-1412`):
 * a leg whose own quote admits no IV is out of `bookGreeks`' totals entirely
 * unless it is passed, and on the deep-ITM stock wings this desk carries that
 * is a whole delta of underlying. It used to reach `bookGreeks` structurally —
 * the object was passed straight down and only the far end read the key — so
 * the one option that decides whether a leg is IN the answer was invisible in
 * every signature between the caller and it, and a caller that passed it as an
 * object literal was told it was excess. Widening the type is what makes the
 * pass a stated part of this module's contract.
 */
export interface DeltaGreekOpts {
  readonly rate: number
  readonly dividendYield?: number
  /** Vol for legs whose own mark solves none. Omit to EXCLUDE them instead. */
  readonly fallbackVol?: number
}

function figures(
  legs: readonly PositionLeg[],
  nowMs: number,
  spot: number | null,
  greekOpts: DeltaGreekOpts,
): DeltaFigures {
  const g = bookGreeks(legs, nowMs, greekOpts)
  // A book where nothing solved reports NULL, never a net of 0 — on a delta
  // panel a zero reads as "flat, no action needed" at exactly the moment the
  // book's risk is least known.
  if (g.legs.length === 0) return NOTHING_PRICED
  const haveSpot = typeof spot === 'number' && spot > 0
  if (!haveSpot || g.netGamma === 0) {
    return { netDelta: g.netDelta, netGamma: g.netGamma, neutral: null }
  }
  const price = spot - g.netDelta / g.netGamma
  return { netDelta: g.netDelta, netGamma: g.netGamma, neutral: { price, pct: ((price - spot) / spot) * 100 } }
}

function picture(
  legs: readonly PositionLeg[],
  nowMs: number,
  spot: number | null,
  greekOpts: DeltaGreekOpts,
): DeltaPicture {
  return {
    all: figures(legs, nowMs, spot, greekOpts),
    // Longs are the hedges; the rules under `delta_shorts_only` steer by what
    // is left when they are set aside.
    shortsOnly: figures(legs.filter((l) => l.qty < 0), nowMs, spot, greekOpts),
  }
}

/**
 * The book as it stands and the book the plan would leave, in the same four
 * figures — so the modal's before/after is a comparison and not two numbers
 * that happen to sit beside each other.
 *
 * The caller owns the JOIN and the hypothetical: `current` is the bridge's own
 * legs at their marks, `after` is that set with the plan's closes removed and
 * its opens added at the chain's price. Doing that fold here would need the
 * chain, and this module stays a total function of its arguments.
 */
export function deltaPictures(input: {
  readonly current: readonly PositionLeg[]
  readonly after: readonly PositionLeg[]
  readonly spot: number | null
  readonly nowMs: number
  readonly greekOpts: DeltaGreekOpts
}): { readonly current: DeltaPicture; readonly after: DeltaPicture } {
  return {
    current: picture(input.current, input.nowMs, input.spot, input.greekOpts),
    after: picture(input.after, input.nowMs, input.spot, input.greekOpts),
  }
}
