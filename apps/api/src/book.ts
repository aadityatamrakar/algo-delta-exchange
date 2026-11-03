/**
 * The bridge's book: apply the desk's actions to what WE hold.
 *
 * Pure and synchronous. No Mongo, no HTTP, no clock — `nowMs` and every mark are
 * injected. That is what makes the semantics testable without a broker, a feed,
 * or a database, and it is the same reasoning as `packages/strategy-kit`'s ports.
 *
 * This is bookkeeping, NOT trading logic (D1). Nothing here decides anything: it
 * resolves contracts, records what filled, and reports what it could not do. Any
 * "should we" question belongs on the Python side.
 *
 * Fail-soft throughout, mirroring `decide.py:401`: a single bad action is skipped
 * with a reason and the rest of the decision still applies. Seven good legs must
 * not be discarded because the eighth strike was delisted.
 */

import type { OptionMaster } from '@algomaker/instruments'
import { roundToStep } from '@algomaker/venue'
import {
  closingSide,
  signedQty,
  type ApplyResult,
  type BridgeLeg,
  type DeskAction,
  type Fill,
  type MarkSource,
  type Skip,
} from './contract.ts'

/**
 * Every quantity this fold produces is snapped to a grid far finer than any
 * venue's step (NSE 1 share, Delta 0.001 BTC), so float tails cannot survive a
 * sum: 0.05 + 0.05 + 0.05 is 0.15000000000000002, and closing 0.15 against it
 * would leave a 2.7e-17 leg that counts as a position. Integers pass unchanged.
 */
const QTY_GRID = 1e-6
const cleanQty = (x: number): number => roundToStep(x, QTY_GRID)

/** One order that actually reached a rail, in the terms the book needs. */
export interface RoutedFill {
  readonly instrument: BridgeLeg['instrument']
  readonly underlying: string
  readonly expiry: string
  readonly strike: number
  readonly type: 'CE' | 'PE'
  readonly side: 'Buy' | 'Sell'
  /** UNSIGNED contracts. The side decides the sign. */
  readonly qty: number
  readonly price: number
  readonly ts: number
  /** Identifies the leg when one is created. Ignored when merging. */
  readonly deskTag: string
  /**
   * The delta-lean bet this order belongs to, stamped on a leg this fill
   * CREATES and — like `deskTag` — ignored when it merges into one that already
   * exists. See the merge branch in `applyRoutedFill` for why.
   *
   * Absent for every fill that names no lean, and never `undefined`.
   */
  readonly leanId?: string
}

/**
 * Fold ONE routed fill into the book.
 *
 * WHY THIS EXISTS. `desk-books` was written in exactly two places — the seed
 * path and `applyActions` — so it was a DECLARED snapshot rather than a record
 * of what we hold. Neither `/v1/desk/submit` (the Build screen's Place) nor
 * `close-all` (the UI's Flatten) touched it. Flattening BHEL on 2026-07-31
 * therefore left the order log correctly reading "0 open, 2 closed" while the
 * book still recorded the opening BUYs, the Positions page still drew two legs,
 * the net delta and P&L were computed off a position that no longer existed,
 * and the book could not be deleted because the delete guard reads the same
 * stale record. Three views, three different answers, one unmaintained record.
 *
 * MATCHED BY CONTRACT, not by `deskTag`. A close routed by `close-all` carries
 * its own generated tag (`ui-flatten-...`), which never equals the tag the leg
 * was opened under — matching on it would append a second, opposite leg instead
 * of closing the first. The instrument is the identity that both paths share.
 *
 * A leg whose signed quantity reaches ZERO is REMOVED, not kept at qty 0: every
 * consumer counts `legs.length` to mean "does this book hold anything", the
 * delete guard included.
 *
 * `entryPrice` is size-weighted when a leg is ADDED to, and left alone when one
 * is reduced — a partial close must not restate the cost basis of what remains.
 *
 * ACROSS EVERY MATCHING LEG, AND NEVER FLIPPING ONE (audit F-26). A book
 * legally holds the same contract on SEVERAL legs — `recenter-relief`
 * (`service.ts:870-874`) buys one contract back on one leg while another leg
 * still carries it — while `planFlatten` nets those legs into ONE order per
 * contract. This fold used to take the FIRST matching leg and put the whole
 * netted quantity through it, flipping its side when the quantity crossed zero:
 * two `Sell 500` legs closed by one `Buy 1000` became `[Buy 500, Sell 500]`.
 * That is two phantom positions where the desk holds none, and `closeLeg` over
 * them routes two more REAL orders in opposite directions.
 *
 * So a REDUCING fill (opposite sign to a matched leg) is consumed leg by leg in
 * array order, `min(remaining, |leg.qty|)` at a time, removing each leg it
 * empties and never taking one past zero. Opposite-sign legs are consumed
 * FIRST even when a same-sign leg also matches: a fill may not grow gross
 * exposure while an offsetting leg is still open. Only a remainder that
 * outlives EVERY matching leg crosses through zero, and it becomes ONE NEW leg
 * carrying the fill's own side, price and desk tag — the aggregate
 * cross-through-zero answer survives, the per-leg flip does not.
 */
export function applyRoutedFill(
  book: readonly BridgeLeg[],
  fill: RoutedFill,
): readonly BridgeLeg[] {
  const delta = signedQty(fill.side, fill.qty)
  if (delta === 0) return book

  const newLeg = (qty: number): BridgeLeg => ({
    deskTag: fill.deskTag,
    instrument: fill.instrument,
    underlying: fill.underlying,
    expiry: fill.expiry,
    strike: fill.strike,
    type: fill.type,
    side: fill.side,
    qty,
    entryPrice: fill.price,
    openedTs: fill.ts,
    /**
     * THE DELTA-LEAN STAMP ON A LEG THIS FOLD CREATES (plan 10A).
     *
     * This is the writer the PAPER rail actually uses: an engine paper open
     * books nothing at decision time, so the leg comes into existence here,
     * when `paper-fold.ts` folds the gateway's fill. Without this line the
     * stamp reached the order document and stopped, every paper lean read as
     * holding nothing, and the add/cut/flip rule was inert on exactly the rail
     * the four books ship on — silently, with every test green.
     *
     * OMITTED, never `leanId: undefined`: Mongo stores an undefined as null and
     * reads it back as a VALUE.
     */
    ...(fill.leanId === undefined ? {} : { leanId: fill.leanId }),
  })

  const next = [...book]
  const isMatch = (l: BridgeLeg): boolean =>
    l.instrument.tradingsymbol === fill.instrument.tradingsymbol
  const sign = Math.sign(delta)

  // Reducing: eat the offsetting legs, oldest first, one at a time.
  let remaining = Math.abs(delta)
  for (let i = 0; i < next.length && remaining > 0; i++) {
    const leg = next[i] as BridgeLeg
    if (!isMatch(leg) || Math.sign(leg.qty) === sign) continue
    const take = Math.min(remaining, Math.abs(leg.qty))
    remaining = cleanQty(remaining - take)
    const qty = cleanQty(leg.qty + sign * take)
    if (qty === 0) {
      next.splice(i, 1)
      i--
    } else {
      // The cost basis of what REMAINS is what it always was.
      next[i] = { ...leg, qty }
    }
  }
  if (remaining === 0) return next
  const consumed = remaining !== Math.abs(delta)

  // Adding: the first same-sign leg absorbs it, size-weighted. A remainder that
  // survived a consumption pass is a CROSS THROUGH ZERO and opens its own leg
  // rather than re-averaging some other leg's basis into it.
  const j = consumed ? -1 : next.findIndex((l) => isMatch(l) && Math.sign(l.qty) === sign)
  if (j < 0) return [...next, newLeg(sign * remaining)]

  const leg = next[j] as BridgeLeg
  const qty = cleanQty(leg.qty + sign * remaining)
  /**
   * A LEG THAT ALREADY EXISTS KEEPS ITS OWN `deskTag`, `openedTs` AND `leanId`.
   *
   * Only the size and the cost basis move. The stamp is the identity of the bet
   * that OPENED this leg, and a later fill adding to it does not make it a
   * different leg — re-stamping here would silently move a position from one
   * lean's P&L to another's, which is the same class of error as restating a
   * cost basis on a partial close.
   */
  next[j] = {
    ...leg,
    qty,
    entryPrice:
      (leg.entryPrice * Math.abs(leg.qty) + fill.price * remaining) / Math.abs(qty),
  }
  return next
}

export interface ApplyContext {
  readonly master: OptionMaster
  readonly marks: MarkSource
  readonly nowMs: number
  readonly underlying: string
  readonly expiry: string
  /**
   * A hard ceiling on the age of a mark that may price NEW exposure (F-16).
   * Absent means no ceiling, which is what every caller that does not configure
   * `DESK_MAX_OPEN_MARK_AGE_MS` gets. See `tooStaleToOpen`.
   */
  readonly maxOpenMarkAgeMs?: number
}

/**
 * Is this mark too old to price NEW exposure? Returns the offending age, or
 * null when the action may proceed.
 *
 * WHY ONLY NEW EXPOSURE, stated here because the asymmetry looks arbitrary
 * until it is named. The governing rule of this repo, from `safety.ts` and
 * `packages/order-bus/src/risk.ts:82`: a control stops new exposure and NEVER
 * blocks an exit — trapping an open position behind a safety control is worse
 * than whatever the control was protecting against, because the position keeps
 * moving whether or not you can act on it. An uncontrolled exit price is bad;
 * no exit is worse.
 *
 * So `open` and a GROWING `resize` are gated (the same pair `addsExposure`
 * already treats as new risk under a halt) and `close`, `roll` and a shrinking
 * `resize` are untouched. The failure being prevented is concrete: a 470CE that
 * last printed at 09:20 gets a "marketable" limit at 14:00, the order rests
 * forever, and the hedge the desk believes it placed does not exist.
 *
 * A mark source with no `markAge` — `StaticMarks`, every dry run — yields null:
 * an unknown age is not a stale age.
 */
function tooStaleToOpen(
  ctx: ApplyContext,
  instrument: BridgeLeg['instrument'],
): number | null {
  const max = ctx.maxOpenMarkAgeMs
  if (max === undefined) return null
  const age = ctx.marks.markAge?.(instrument)
  return typeof age === 'number' && age > max ? age : null
}

/** The skip reason for a refused new-exposure action. One wording, two callers. */
function staleOpenReason(op: string, symbol: string, ageMs: number): string {
  const secs = Math.round(ageMs / 1000)
  return (
    `${op}: mark for ${symbol} is ${secs}s old — refusing to price NEW exposure off a ` +
    'stale quote (DESK_MAX_OPEN_MARK_AGE_MS)'
  )
}

/**
 * Apply `actions` to `book`, returning a NEW book plus the fills and skips.
 *
 * `book` is never mutated — the caller persists the result only if the whole
 * call succeeded, so a crash mid-decision cannot leave a half-applied book.
 */
export function applyActions(
  book: readonly BridgeLeg[],
  actions: readonly DeskAction[],
  ctx: ApplyContext,
): ApplyResult {
  let next: BridgeLeg[] = [...book]
  const fills: Fill[] = []
  const skips: Skip[] = []

  const skip = (action: DeskAction, reason: string): void => {
    skips.push({ action, reason })
  }

  const findLeg = (tag: string): number => next.findIndex((l) => l.deskTag === tag)

  for (const action of actions) {
    switch (action.op) {
      case 'open': {
        if (action.qty <= 0) {
          skip(action, `open: qty must be positive, got ${action.qty}`)
          break
        }
        if (action.side !== 'Buy' && action.side !== 'Sell') {
          skip(action, `open: bad side ${String(action.side)}`)
          break
        }
        /**
         * AN OPEN ONTO A TAG THE BOOK ALREADY HOLDS.
         *
         * A duplicate tag would make every later close/roll ambiguous, so this
         * refused every repeat — and that is still the rule for an UNMARKED
         * open. It is what stops a decision that merely repeats itself from
         * silently doubling a position.
         *
         * BUT THE RECENTER SHED ACCUMULATES. It re-picks the best strike and
         * sells more of it, held or not, exactly as the legacy implementation
         * did (`parity.test.ts` replays Python emitting `open 3x 310CE` onto a
         * book already at `ce310: 4`, every mark) — and downstream a broker
         * simply nets the two. "Open X" therefore means two different things,
         * ADD DELIBERATELY and REPEAT ACCIDENTALLY, and refusing both cost six
         * days: TCS skipped 267 of 278 decisions, KALYANKJIL 125 of 132 and
         * TATASTEEL 16 of 25, each unable to act on its own shed (2026-09-16).
         *
         * `action.add` is that difference, set by the one caller that knows.
         * MERGING KEEPS THE GUARD'S REAL GUARANTEE: its fear is two legs under
         * one tag, and adding to the existing leg leaves exactly one.
         *
         * STILL REFUSED even when marked, because neither is an add:
         *   - the tag naming a DIFFERENT contract — the desk means two things
         *     by one name and no later close could say which;
         *   - the OPPOSITE side — buying into a short reduces it and, past its
         *     size, flips it through zero. `close` and `resize` say that.
         */
        const heldIdx = findLeg(action.ts)
        if (heldIdx >= 0) {
          const held = next[heldIdx]!
          const sameContract = held.strike === action.strike && held.type === action.type
          if (action.add !== true || !sameContract || held.side !== action.side) {
            skip(action, `open: tag '${action.ts}' is already open`)
            break
          }
        }
        const instrument = ctx.master.resolve(ctx.underlying, ctx.expiry, action.strike, action.type)
        if (instrument === null) {
          skip(
            action,
            `open: ${ctx.underlying} ${ctx.expiry} ${action.strike}${action.type} is not a listed contract`,
          )
          break
        }
        const price = ctx.marks.price(instrument)
        if (price === null) {
          skip(action, `open: no mark for ${instrument.tradingsymbol}`)
          break
        }
        const staleBy = tooStaleToOpen(ctx, instrument)
        if (staleBy !== null) {
          skip(action, staleOpenReason('open', instrument.tradingsymbol, staleBy))
          break
        }
        if (heldIdx >= 0) {
          /**
           * ADDED, at the WEIGHTED AVERAGE — what the position actually cost,
           * which is what every P&L reader downstream divides by. Carrying the
           * first entry forward would price the whole enlarged leg at the old
           * mark and report a profit the desk never made.
           *
           * `deskTag`, `openedTs` and `leanId` stay the FIRST open's: this is
           * the same leg, grown. Re-stamping the lean would move an older leg
           * into whatever lean happens to be adding now.
           */
          const held = next[heldIdx]!
          const heldQty = Math.abs(held.qty)
          next[heldIdx] = {
            ...held,
            qty: cleanQty(held.qty + signedQty(action.side, action.qty)),
            entryPrice: (heldQty * held.entryPrice + action.qty * price) / (heldQty + action.qty),
          }
        } else {
        next.push({
          deskTag: action.ts,
          instrument,
          underlying: ctx.underlying,
          expiry: ctx.expiry,
          strike: action.strike,
          type: action.type,
          side: action.side,
          qty: signedQty(action.side, action.qty),
          entryPrice: price,
          openedTs: ctx.nowMs,
          /**
           * THE DELTA-LEAN STAMP, and the ONLY leg field that decides anything.
           *
           * The controller reads the P&L of the legs carrying its current lean
           * id; a leg that lost the stamp belongs to no lean, so the lean holds
           * nothing, never adds and never cuts — silently.
           *
           * The key is OMITTED, never written as `leanId: undefined`: Mongo
           * stores an undefined as null and reads it back as a VALUE, and the
           * supervisor's mapper would then have a null where it expects either a
           * string or no key at all.
           */
          ...(action.leanId === undefined ? {} : { leanId: action.leanId }),
        })
        }
        // The ORDER is a fresh sale either way — the merge above is a fact
        // about the leg, not a claim about what went to the broker.
        fills.push({
          op: 'open',
          deskTag: action.ts,
          tradingsymbol: instrument.tradingsymbol,
          side: action.side,
          qty: action.qty,
          price,
          ts: ctx.nowMs,
          /**
           * THE SAME STAMP, ON THE ORDER AS WELL AS ON THE LEG (plan 10A).
           *
           * The leg above is the LIVE rail's answer and it is complete. The
           * PAPER rail does not write a leg here at all — the engine route
           * answers `WORKING` and `paper-fold.ts` creates the leg when the
           * gateway's fill lands — so the fill is the only thing that carries
           * the lean across that gap, onto the order document and into the
           * decision's `plannedFills`.
           *
           * Spread from the SAME expression as the leg's, deliberately: a leg
           * and an order that disagreed about whose bet they are would be worse
           * than neither carrying it.
           */
          ...(action.leanId === undefined ? {} : { leanId: action.leanId }),
        })
        break
      }

      case 'close': {
        const i = findLeg(action.ts)
        if (i < 0) {
          skip(action, `close: unknown leg '${action.ts}'`)
          break
        }
        const leg = next[i] as BridgeLeg
        const price = ctx.marks.price(leg.instrument)
        if (price === null) {
          skip(action, `close: no mark for ${leg.instrument.tradingsymbol}`)
          break
        }
        const side = closingSide(leg.side)
        fills.push({
          op: 'close',
          deskTag: leg.deskTag,
          tradingsymbol: leg.instrument.tradingsymbol,
          side,
          qty: Math.abs(leg.qty),
          price,
          ts: ctx.nowMs,
        })
        next.splice(i, 1)
        break
      }

      case 'roll': {
        const i = findLeg(action.ts)
        if (i < 0) {
          skip(action, `roll: unknown leg '${action.ts}'`)
          break
        }
        const leg = next[i] as BridgeLeg
        const to = ctx.master.resolve(ctx.underlying, ctx.expiry, action.to_strike, leg.type)
        if (to === null) {
          skip(action, `roll: target ${action.to_strike}${leg.type} is not a listed contract`)
          break
        }
        const closePrice = ctx.marks.price(leg.instrument)
        const openPrice = ctx.marks.price(to)
        // BOTH marks or neither. Booking half a roll leaves the book naked on one
        // side with no record of why — strictly worse than not rolling.
        if (closePrice === null || openPrice === null) {
          skip(
            action,
            `roll: missing mark (${leg.instrument.tradingsymbol}=${String(closePrice)}, ${to.tradingsymbol}=${String(openPrice)})`,
          )
          break
        }
        if (findLeg(action.to_ts) >= 0) {
          skip(action, `roll: target tag '${action.to_ts}' is already open`)
          break
        }
        const qty = Math.abs(leg.qty)
        fills.push({
          op: 'roll',
          deskTag: leg.deskTag,
          tradingsymbol: leg.instrument.tradingsymbol,
          side: closingSide(leg.side),
          qty,
          price: closePrice,
          ts: ctx.nowMs,
        })
        fills.push({
          op: 'roll',
          deskTag: action.to_ts,
          tradingsymbol: to.tradingsymbol,
          side: leg.side,
          qty,
          price: openPrice,
          ts: ctx.nowMs,
        })
        next[i] = {
          ...leg,
          deskTag: action.to_ts,
          instrument: to,
          strike: action.to_strike,
          entryPrice: openPrice,
          openedTs: ctx.nowMs,
        }
        break
      }

      case 'resize': {
        const i = findLeg(action.ts)
        if (i < 0) {
          skip(action, `resize: unknown leg '${action.ts}'`)
          break
        }
        if (action.qty < 0) {
          skip(action, `resize: qty must not be negative, got ${action.qty}`)
          break
        }
        const leg = next[i] as BridgeLeg
        const oldQty = Math.abs(leg.qty)
        const newQty = action.qty
        if (newQty === oldQty) break // genuinely nothing to do
        const price = ctx.marks.price(leg.instrument)
        if (price === null) {
          skip(action, `resize: no mark for ${leg.instrument.tradingsymbol}`)
          break
        }
        const delta = newQty - oldQty
        // GROWING ONLY. Shrinking is an exit and is never gated — see
        // `tooStaleToOpen`, and `addsExposure` in safety.ts, which draws the
        // same line for the kill switch.
        if (delta > 0) {
          const staleBy = tooStaleToOpen(ctx, leg.instrument)
          if (staleBy !== null) {
            skip(action, staleOpenReason('resize', leg.instrument.tradingsymbol, staleBy))
            break
          }
        }
        // Growing trades the leg's own side; shrinking trades the opposite.
        const side = delta > 0 ? leg.side : closingSide(leg.side)
        fills.push({
          op: 'resize',
          deskTag: leg.deskTag,
          tradingsymbol: leg.instrument.tradingsymbol,
          side,
          qty: cleanQty(Math.abs(delta)),
          price,
          ts: ctx.nowMs,
        })
        if (newQty === 0) next.splice(i, 1)
        else next[i] = { ...leg, qty: signedQty(leg.side, newQty) }
        break
      }

      default: {
        // An op we do not implement. Named explicitly so a new Python-side op
        // shows up as a reported skip rather than a silent no-op.
        const unknown = action as { op?: unknown }
        skips.push({ action, reason: `unsupported op '${String(unknown.op)}'` })
      }
    }
  }

  // Defensive: a leg that reached zero qty by any path is not a position.
  next = next.filter((l) => l.qty !== 0)
  return { book: next, fills, skips }
}

/**
 * Difference between the desk's declared book and ours (D2).
 *
 * Neither side wins. The bridge reports; a human decides. Matching is by
 * (strike, type) rather than by tag deliberately — a tag mismatch is exactly the
 * desync we want surfaced, so keying the comparison on tags would hide the thing
 * being looked for.
 */
export interface BookDiffEntry {
  readonly strike: number
  readonly type: string
  readonly deskQty: number
  readonly bridgeQty: number
}

export interface BookDiff {
  readonly matched: readonly BookDiffEntry[]
  /** Present on both sides but with different quantities. */
  readonly mismatched: readonly BookDiffEntry[]
  /** In the desk's book, absent from ours — usually an action we skipped. */
  readonly deskOnly: readonly BookDiffEntry[]
  /** In our book, absent from the desk's — usually a fill it does not know about. */
  readonly bridgeOnly: readonly BookDiffEntry[]
  readonly inSync: boolean
}

export interface DeclaredLeg {
  readonly strike: number
  readonly type: string
  /** Signed contract quantity, same convention as ours. */
  readonly qty: number
}

export function diffBooks(
  desk: readonly DeclaredLeg[],
  bridge: readonly BridgeLeg[],
): BookDiff {
  const key = (strike: number, type: string): string => `${strike}|${type}`
  const deskBy = new Map<string, number>()
  for (const l of desk) deskBy.set(key(l.strike, l.type), (deskBy.get(key(l.strike, l.type)) ?? 0) + l.qty)
  const bridgeBy = new Map<string, number>()
  for (const l of bridge) {
    bridgeBy.set(key(l.strike, l.type), (bridgeBy.get(key(l.strike, l.type)) ?? 0) + l.qty)
  }

  const matched: BookDiffEntry[] = []
  const mismatched: BookDiffEntry[] = []
  const deskOnly: BookDiffEntry[] = []
  const bridgeOnly: BookDiffEntry[] = []

  for (const k of new Set([...deskBy.keys(), ...bridgeBy.keys()])) {
    const [strikeStr, type] = k.split('|')
    const strike = Number(strikeStr)
    const deskQty = deskBy.get(k) ?? 0
    const bridgeQty = bridgeBy.get(k) ?? 0
    const entry: BookDiffEntry = { strike, type: type ?? '', deskQty, bridgeQty }
    if (deskQty === bridgeQty) matched.push(entry)
    else if (bridgeQty === 0) deskOnly.push(entry)
    else if (deskQty === 0) bridgeOnly.push(entry)
    else mismatched.push(entry)
  }

  const bySt = (a: BookDiffEntry, b: BookDiffEntry): number => a.strike - b.strike
  return {
    matched: matched.sort(bySt),
    mismatched: mismatched.sort(bySt),
    deskOnly: deskOnly.sort(bySt),
    bridgeOnly: bridgeOnly.sort(bySt),
    inSync: mismatched.length === 0 && deskOnly.length === 0 && bridgeOnly.length === 0,
  }
}
