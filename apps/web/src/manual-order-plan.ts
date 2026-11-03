/**
 * THE MANUAL ORDER'S ARITHMETIC — what the dialog around it can be wrong about.
 *
 * `manual-order.tsx` is buttons and fetches; whether a draft is PLACEABLE,
 * whether the limit box may be overwritten by a fresh suggestion, and what the
 * one idempotency key looks like are all decidable without a DOM — so they
 * live here, where `node --test` can assert on them (the same split
 * `entry-plan.ts` uses, for the same reason).
 */

import { suggestFromQuote, type QuoteLike, type Side } from './entry-plan.ts'

/** What the limit box should be set to, and the sentence shown when it can't. */
export interface PricePrefill {
  readonly price: string
  /** Why the box is empty. Empty string when there is a price. */
  readonly note: string
}

/**
 * A suggested limit for the box — or `null`, meaning LEAVE IT ALONE.
 *
 * `dirty` is the operator having typed in the box FOR THE CONTRACT NOW
 * SELECTED (see `priceIsOperators`). Once they have, no tick and no side flip
 * may overwrite their number: a price someone chose by reading the depth being
 * replaced under their cursor is the worst kind of helpful (the same rule
 * `book-build.tsx`'s `applyQuotes` keeps).
 *
 * When the quote is missing or stale the box is CLEARED, not kept: the previous
 * strike's suggestion sitting under a new strike is a number that looks chosen
 * and was never chosen for this contract.
 */
export function prefillPrice(opts: {
  dirty: boolean
  side: Side
  quote: QuoteLike | null
  tickSize?: number
}): PricePrefill | null {
  if (opts.dirty) return null
  const s = suggestFromQuote(
    opts.side,
    opts.quote,
    opts.tickSize === undefined ? {} : { tickSize: opts.tickSize },
  )
  // toFixed(2), not String(): the suggestion is tick-rounded but still a
  // float, and "78.57499999999999" in an editable box is not a price.
  return s.price === null ? { price: '', note: s.reason } : { price: s.price.toFixed(2), note: '' }
}

/**
 * WHICH CONTRACT A TYPED PRICE BELONGS TO. `1070|CE` and `1070|PE` are two
 * different options at one strike, so the type is part of the identity.
 *
 * The dialog remembers this key when the operator types, rather than a bare
 * `dirty` boolean, because the boolean could not tell "they chose 3.55 for THIS
 * contract" from "they chose 3.55 for the one they were looking at a moment
 * ago" — and 3.55 armed under a different strike is a number that looks chosen
 * and never was.
 */
export function contractKey(strike: string, optType: string): string {
  return `${strike}|${optType}`
}

/**
 * Is the number in the limit box still the OPERATOR's, for the contract now
 * selected? `typedFor` is the key they last typed under, or null if they have
 * not typed at all.
 *
 * False re-arms the suggestion, which then REPLACES the box (`prefillPrice`) —
 * so changing strike or CE/PE both clears their price and re-prices for what is
 * actually selected. A SIDE flip deliberately does not: a limit chosen off the
 * depth is still theirs when they realise they meant to sell it.
 */
export function priceIsOperators(typedFor: string | null, strike: string, optType: string): boolean {
  return typedFor !== null && typedFor === contractKey(strike, optType)
}

// ------------------------------------------------------------- stale chains

/** `SYMBOL|EXPIRY` — the pair a chain read belongs to. */
export function pairKey(symbol: string, expiry: string): string {
  return `${symbol}|${expiry}`
}

/** A chain read, carrying the pair it was fetched for. */
export interface TaggedChain<T> {
  readonly pair: string
  readonly chain: T
}

/**
 * The chain IF IT IS THIS PAIR'S — otherwise null, meaning "still loading".
 *
 * `usePoll` keeps the last good payload across a deps change (deliberately: a
 * failed refresh must not blank the screen). That is wrong for a strike list.
 * When the operator switches expiry, the previous expiry's strikes stayed
 * selectable for a poll interval, and a press in that window would have routed
 * the OLD expiry's contract stamped with the NEW pair's lot size and exchange —
 * a wrong-instrument order that reads as a normal one everywhere afterwards.
 *
 * So the read is TAGGED at the source and matched here. Nothing renders as
 * placeable until the answer that arrives is an answer about what is on screen.
 */
export function chainForPair<T>(read: TaggedChain<T> | null | undefined, pair: string): T | null {
  if (read === null || read === undefined) return null
  return read.pair === pair ? read.chain : null
}

// ------------------------------------------------------------ execution copy

/**
 * The sentence under the Execution toggle.
 *
 * RESTING IS A LIVE-RAIL BEHAVIOUR and the paper rail says otherwise by doing:
 * `PaperRail` books every order the moment it routes (status COMPLETE,
 * `filled_quantity` = the whole size), at the operator's limit — see
 * `apps/api/src/rail.ts:orderDocument` and `submit.ts`'s resting fill price. So
 * a paper "resting" order does not sit anywhere; it fills instantly. Saying
 * "sits at your price until it trades" there would teach an operator a
 * behaviour they would then expect from the rail that CAN cost money.
 */
export function executionNote(mode: string, execution: 'Immediate' | 'Resting'): string {
  if (execution === 'Immediate') {
    return 'Immediate: if it rests unfilled, the gateway chases it toward the market.'
  }
  if (mode === 'paper') {
    return (
      'Resting is a LIVE-rail behaviour: on paper this fills IMMEDIATELY at your limit — ' +
      'nothing will sit waiting.'
    )
  }
  return 'Resting: sits at your price until it trades or you cancel it — never repriced.'
}

/**
 * The desk-book caveat, which is a DIFFERENT PROMISE PER EXECUTION MODE.
 *
 * IMMEDIATE: the fill reaches `/v1/desk/submit`'s book fold, which creates the
 * leg (`submit.ts:#maintainBook`), and the Python driver adopts it on its next
 * tick. That is the promise the dialog has been making since phase 2.
 *
 * RESTING ON PAPER: the same promise as Immediate. The paper rail fills it at
 * the limit as it routes, and `submit.ts:restsUnbooked` books it like any other
 * fill — an exit reduces the leg, an open creates one.
 *
 * RESTING ON LIVE: it is NOT true, and saying it anyway is the worst kind of
 * wrong. A live resting order is deliberately not booked at route time — it may
 * sit for hours or never trade — and when it DOES trade, the fill reaches `desk-fills` and
 * the Broker page and stops there: nothing writes `desk-decisions`, nothing
 * creates the book leg, and the supervisor therefore never sees it. So a
 * resting manual order under a book's tag is a broker position the book does
 * not hold, for as long as it lives. Closing that gap needs the gateway's fill
 * notification to reach the fold and is a feature of its own (audit F12); until
 * it exists, the operator choosing between two buttons is the only person who
 * can act on it, and they can only act on what they are told.
 */
export function deskBookNote(mode: string, execution: 'Immediate' | 'Resting'): string {
  if (restingUnbooked(mode, execution)) {
    return (
      'A RESTING order does NOT join this book: when it trades, nothing creates the leg and ' +
      'the supervisor never adopts it — it will be a broker position the book does not hold. ' +
      'Use Immediate for a leg the supervisor should manage.'
    )
  }
  if (execution === 'Resting') {
    return (
      'On paper this fills at your limit as it routes, so the leg joins the book exactly as an ' +
      'Immediate fill does — an exit reduces it, an open creates it — and the supervisor adopts ' +
      'it on its next tick.'
    )
  }
  return (
    'Trades under this book’s tag at the broker. On fill the leg joins the book and the ' +
    'supervisor adopts it on its next tick — watch the order feed for the “manual leg added” ' +
    'line, then manage it like any other leg.'
  )
}

/**
 * True when the desk-book note is a WARNING rather than a promise — the dialog
 * renders it emphasised. The same rule as `submit.ts:restsUnbooked`.
 */
export function restingUnbooked(mode: string, execution: 'Immediate' | 'Resting'): boolean {
  return execution === 'Resting' && mode !== 'paper'
}

// -------------------------------------------- an exit, or a whole new leg

/** A leg of the book, as `PositionsResponse.legs` carries it. */
export interface HeldLeg {
  readonly instrument: { readonly tradingsymbol: string }
  /** SIGNED contract quantity — negative is short. */
  readonly qty: number
}

export interface ExposureIntent {
  /** `'reduces'` is what the submit body sends as `reducesExposure: true`. */
  readonly kind: 'reduces' | 'adds'
  /** The one sentence the operator must read BEFORE pressing Place. */
  readonly text: string
}

/**
 * WHICH OF THE TWO THINGS IS THIS ORDER — an exit, or a new leg?
 *
 * THE FAILURE THIS EXISTS FOR. The dialog never sent `reducesExposure`, so
 * `submit.ts` derived `op: 'open'` for every manual order it has ever placed.
 * A Sell the operator meant as an EXIT, on a contract the book turns out not to
 * hold — the strike they misread, the leg the supervisor closed a minute
 * earlier — was therefore booked as an OPEN, and since `fefe922b` an open on an
 * unheld contract CREATES a leg: a phantom short, on the book, adopted by the
 * supervisor and eventually flattened for real money. The desk cannot tell the
 * two apart from the request, so the SCREEN has to, before the press.
 *
 * NETTED ACROSS EVERY MATCHING LEG, never per leg. A book may legally hold one
 * contract on several legs (`book.ts`'s F-26 note), and the question the flag
 * answers is about EXPOSURE, not about which row gets consumed first: 300 short
 * against 100 long is a 200 short, and a further Sell adds to it however the
 * fold happens to walk the array. Netting is also the conservative direction —
 * it can only ever refuse to claim "reduces", and `reducesExposure` is the flag
 * that lets an order past the kill switch.
 *
 * NULL means "cannot say yet" — the book has not been read, or no contract is
 * picked. The dialog shows nothing rather than a guess, and sends no flag.
 */
export function classifyExposure(input: {
  readonly legs: readonly HeldLeg[] | null
  readonly tradingsymbol: string | undefined
  readonly side: Side
}): ExposureIntent | null {
  const symbol = input.tradingsymbol
  if (input.legs === null || symbol === undefined) return null
  const net = input.legs
    .filter((l) => l.instrument.tradingsymbol === symbol)
    .reduce((sum, l) => sum + l.qty, 0)
  const direction = input.side === 'Buy' ? 1 : -1
  if (net !== 0 && Math.sign(net) !== direction) {
    return { kind: 'reduces', text: `Reduces the book’s ${symbol} leg (qty ${net}).` }
  }
  return {
    kind: 'adds',
    text: `This ADDS a new ${input.side} leg to the book — it will be managed by the supervisor.`,
  }
}

/** The draft as the dialog holds it — text boxes still text, lookups nullable. */
export interface ManualOrderDraft {
  /** From the chain's own `ceContract`/`peContract` — NEVER string-built. */
  readonly contract: { readonly tradingsymbol: string; readonly instrumentToken: number } | undefined
  /** From `api.instruments` — lot size, tick size and exchange are the master's. */
  readonly meta: { readonly lotSize: number; readonly tickSize: number; readonly exchange: string } | null
  readonly lots: string
  readonly price: string
}

/**
 * Why the draft cannot be placed yet — or `null` when it can.
 *
 * One sentence, in the operator's terms, shown beside the disabled button; a
 * Place that is merely grey teaches people to click it harder.
 */
export function orderProblem(d: ManualOrderDraft): string | null {
  if (d.contract === undefined) {
    return 'pick a listed strike — the contract comes from the chain, never guessed'
  }
  if (d.meta === null) {
    return 'waiting for the instrument master (lot size, tick size, exchange)'
  }
  if (!/^\d+$/.test(d.lots.trim()) || Number(d.lots.trim()) < 1) {
    return 'lots must be a whole number, 1 or more'
  }
  const p = Number(d.price)
  if (d.price.trim() === '' || !Number.isFinite(p) || p <= 0) {
    return 'enter a limit price greater than 0'
  }
  return null
}

/**
 * The idempotency key, minted ONCE when Place is pressed — never per render.
 *
 * Same shape as the close-leg convention (`opclose:<tag>:<mode>:<symbol>:<ms>`):
 * the timestamp makes each deliberate press a new order, while a retry of the
 * SAME press replays rather than doubles.
 */
export function manualClientOrderId(
  tag: string,
  mode: string,
  tradingsymbol: string,
  nowMs: number,
): string {
  return `manual:${tag}:${mode}:${tradingsymbol}:${nowMs}`
}

// ------------------------------------------------------- the same order twice

/**
 * EVERYTHING THAT MAKES ONE PRESS THE SAME ORDER AS THE LAST ONE.
 *
 * Every field the submit body carries that an operator can change between two
 * presses. `lots` and `price` stay TEXT, exactly as the boxes hold them, so the
 * comparison is of what was on screen rather than of a number two different
 * strings could parse to.
 */
export interface OrderIdentity {
  readonly tag: string
  readonly mode: string
  readonly tradingsymbol: string
  readonly side: string
  readonly lots: string
  readonly price: string
  readonly resting: boolean
}

/** The id a press should carry, and what it was minted for. */
export interface PressId {
  readonly clientOrderId: string
  readonly identity: OrderIdentity
  /** True when this press REPLAYS the previous one instead of being a new order. */
  readonly retry: boolean
}

function sameOrder(a: OrderIdentity, b: OrderIdentity): boolean {
  return (
    a.tag === b.tag &&
    a.mode === b.mode &&
    a.tradingsymbol === b.tradingsymbol &&
    a.side === b.side &&
    a.lots === b.lots &&
    a.price === b.price &&
    a.resting === b.resting
  )
}

/**
 * The `clientOrderId` for this press — REUSING the last one when the press is
 * the same order, minting a fresh one when it is not.
 *
 * THE FAILURE THIS EXISTS FOR. A network drop or a timeout AFTER the request
 * left the browser is indistinguishable, from here, from one that never
 * arrived: the order may be on the wire, at the broker, filled. Discarding the
 * id and letting the natural re-press mint a new one is the double-order bug in
 * its purest form — both ids are new to the server's unique index, so both
 * route, and the operator who pressed twice because the screen said "not
 * placed" ends up with twice the position.
 *
 * Under the SAME id the server replays: `desk-submissions` claims the id before
 * anything routes, so a retry gets the original outcome back instead of a
 * second order (see `apps/api/src/submit.ts`'s "RETRY UNDER THE SAME ID").
 *
 * IT IS KEYED ON THE DRAFT, not merely held. An id replayed under a draft the
 * operator has since edited would answer with the OLD order's outcome while the
 * screen shows the new one's numbers — so any edit to what would be sent is a
 * new order and gets a new id. That is also why `held` is not cleared when the
 * dialog's fields change: it does not have to be.
 */
export function orderIdForPress(
  held: PressId | null,
  identity: OrderIdentity,
  nowMs: number,
): PressId {
  if (held !== null && sameOrder(held.identity, identity)) {
    return { clientOrderId: held.clientOrderId, identity, retry: true }
  }
  return {
    clientOrderId: manualClientOrderId(identity.tag, identity.mode, identity.tradingsymbol, nowMs),
    identity,
    retry: false,
  }
}

/**
 * Did the SERVER answer, i.e. is this failure DEFINITIVE?
 *
 * Only a 4xx qualifies. It means the request was read and rejected before
 * anything routed — a malformed body, an unregistered tag, an expired session
 * — so the id it carried is spent and the next press is genuinely a new order.
 *
 * EVERYTHING ELSE IS "WE DO NOT KNOW", and is treated as such: the client's own
 * timeout (`ApiError` status 0, whose message already says the request "may
 * STILL BE EXECUTING"), a dropped connection (a bare `TypeError` from `fetch`,
 * no status at all), and a 5xx — the desk's own routing loop deliberately
 * refuses to turn a bookkeeping failure into a 500 precisely because a caller
 * cannot tell "never routed" from "routed, response lost", and this is the
 * client side of that same rule.
 *
 * Duck-typed on `status` rather than `instanceof ApiError` so this module stays
 * importable under `node --test`: `api.ts` reads `window.location` at module
 * scope and there is no window in there.
 */
export function serverAnswered(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false
  const status = (err as { status?: unknown }).status
  return typeof status === 'number' && status >= 400 && status < 500
}

/**
 * What the banner says when the transport failed and the outcome is UNKNOWN.
 *
 * The old copy was "Not placed", which is a claim the client cannot make — and
 * the one that talks an operator into pressing again on a fresh id. This says
 * what is actually known and makes the safe move the obvious one.
 */
export function unconfirmedText(message: string): string {
  return `${message} — pressing Place again retries the SAME order safely.`
}
