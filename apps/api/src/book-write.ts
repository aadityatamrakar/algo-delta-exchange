/**
 * The ONE way `desk-books` is written back after a decision — compare-and-set,
 * and a re-fold when the compare fails.
 *
 * WHY THIS FILE EXISTS AT ALL (audit F-27). The book is a whole-document
 * read-modify-write. `applyDecision` reads it (`service.ts:353`), runs three
 * gates, routes N orders over the network, and writes the recomputed legs back
 * (`:554`); `flattenTag` and `/v1/desk/submit` do the same over their own
 * windows. Nothing serialised those windows — no version, no transaction, not
 * even an in-process lock — so an operator's "Close leg" landing inside one was
 * silently overwritten by the supervisor's 5-minute POST and the closed leg came
 * back. That is the 2026-08-03 ITC desync shape, reproduced by nothing more
 * exotic than two people using the desk at once.
 *
 * `store.saveBook` now pins `updatedAt` as the row version and answers
 * `'conflict'` instead of clobbering. A conflict is NOT an error and must never
 * become one: BOTH writers describe orders that really went out. So the loser
 * re-reads the book, folds ITS OWN routed fills onto the winner's legs, and
 * writes once more.
 *
 * ONE RETRY, THEN LOUD. A second conflict means we are in a write storm, and
 * looping would put us there for as long as it lasts while a routed order sits
 * unbooked. The decision record — written before anything routed, and the thing
 * `pnlstore`/`LiveBook` actually load — is already correct and is the source of
 * truth; the book is a derived view. So the second failure is logged at ERROR
 * for the reconciler to pick up and NOT thrown: the orders are already placed by
 * this line, and turning a book write into a 500 makes the caller retry and
 * place them twice.
 *
 * It lives in its own module rather than in `book.ts` or `decision-plan.ts`
 * because both of those declare themselves pure and synchronous in their
 * headers, and this awaits a store.
 */

import type { BridgeLeg, DeskMode, Fill } from './contract.ts'
import { applyRoutedFill } from './book.ts'

/** The parts of the stored book document this module reads. */
export interface BookDocLike {
  readonly symbol: string
  readonly expiry: string
  readonly legs: readonly BridgeLeg[]
  /** The row VERSION. Absent on a document written before F-27 landed. */
  readonly updatedAt?: number
  /**
   * The FOLD RECEIPTS this book already carries — see `RefoldInput.nonce`.
   * Absent on a document written before the field existed, which reads as "no
   * fold has landed" and never as "already folded".
   */
  readonly appliedCorrections?: readonly string[]
}

export interface BookKeyLike {
  readonly tag: string
  readonly mode: DeskMode
  readonly symbol: string
  readonly expiry: string
}

/**
 * The persistence this needs, as a narrow port — `DeskStore` and `SubmitStore`
 * both satisfy it structurally, which is what lets the retry be tested against
 * a fake rather than a running Mongo.
 */
export interface BookWriteStore {
  bookDoc(tag: string, mode: DeskMode): Promise<BookDocLike | null>
  saveBook(
    key: BookKeyLike,
    legs: readonly BridgeLeg[],
    nowMs: number,
    /** A version to pin, `null` for CREATE-ONLY, absent for unconditional. */
    expectedUpdatedAt?: number | null,
    /** A fold receipt to append IN THIS WRITE — see `RefoldInput.nonce`. */
    correctionNonce?: string,
  ): Promise<'ok' | 'conflict'>
}

/**
 * A routed fill, optionally capped to what the legs can OFFSET.
 *
 * `reduceOnly` exists for the reconciler's compensations. A compensation's size
 * is derived against the book it read — "reduce by at most what we hold" — and
 * by the time a lost race re-folds it, that book has moved. Re-applying the
 * original quantity to the fresh legs walks `applyRoutedFill` through zero and
 * APPENDS an opposite leg: a correction inventing exposure, which is the one
 * thing it may never do. So the cap travels WITH the fill and is re-derived at
 * apply time, which is where it belongs and the only place the fresh legs are
 * in hand.
 */
export type RefoldFill = Fill & { readonly reduceOnly?: boolean }

/** What became of ONE routed fill. There is exactly one of these per fill. */
export interface RefoldOutcome {
  readonly fill: RefoldFill
  /** Contract quantity actually folded into the legs. */
  readonly applied: number
  /** The part that did not land — `fill.qty - applied`. */
  readonly shortfall: number
  /** True when NOTHING of this fill reached the legs. */
  readonly skipped: boolean
  /**
   * Why it did not all land.
   *
   *  - `no-leg` — nothing anywhere describes this contract, or it does and the
   *    caller may not create one. THIS IS THE DANGEROUS ONE: the order is out
   *    at the broker and the book now disagrees with the account.
   *  - `capped` — a `reduceOnly` fill met legs smaller than itself. Expected,
   *    and the whole point of the flag.
   */
  readonly reason?: 'no-leg' | 'capped'
}

export interface RefoldResult {
  readonly legs: readonly BridgeLeg[]
  readonly outcomes: readonly RefoldOutcome[]
}

export interface RefoldInput {
  readonly store: BookWriteStore
  readonly key: BookKeyLike
  /** What actually ROUTED. An attempt is not a position. */
  readonly routedFills: readonly RefoldFill[]
  /**
   * The book as WE computed it, and the book we read before computing it.
   *
   * A `Fill` carries a tradingsymbol and nothing else about the contract, so
   * strike/type/underlying/expiry can only come from a leg. These two views are
   * where a fill on a contract the FRESH book does not hold — an open we just
   * made, or a close that removed the leg — gets its identity from.
   */
  readonly nextBook: readonly BridgeLeg[]
  readonly priorBook: readonly BridgeLeg[]
  /**
   * May a fill on a contract the fresh book does not hold OPEN a leg?
   *
   * True for `applyDecision`, whose opens are exactly that. False for the
   * flatten fold and for `/v1/desk/submit`, which reduce and add only and never
   * create — creating there would invent a position in a record that is read as
   * one, and it is the Record step's job (`seed.ts`).
   */
  readonly mayCreate: boolean
  readonly nowMs: number
  /**
   * THE FOLD RECEIPT, for a reconciler compensation (absent for everything
   * else).
   *
   * It is the gateway `clientOrderId` of the order being corrected, and it is
   * appended to the book's own `appliedCorrections` in the SAME `saveBook`
   * write as the legs. The reconciler's other proof — `foldDone` — lives on
   * `desk-decisions`, so a crash between the two documents left a book that had
   * been folded and a record that said it had not, and the next pass folded the
   * same compensation twice. One document and one write has no such window; the
   * caller reads the array back and skips a fold whose nonce is already there.
   *
   * Threaded through the retry for the obvious reason: a fold that lands on the
   * SECOND attempt needs its receipt just as much as one that lands on the
   * first, and a fold that lands with no receipt is one the next pass repeats.
   */
  readonly nonce?: string
  readonly log: (message: string) => void
}

/**
 * Re-apply our routed fills to the CURRENT legs.
 *
 * Pure, and the reason the retry is safe: it starts from whatever the winner
 * left and applies our fills as DELTAS, so nothing of theirs is overwritten and
 * nothing of ours is applied twice — this runs only when our write did not
 * land.
 *
 * IT REPORTS PER FILL, and that is not bookkeeping. A fill that cannot be
 * placed is a routed order — money already moved at the broker — which the book
 * will now never show. Nothing here can un-route it, so the only correct scope
 * is loud visibility, and the caller cannot be loud about what it is not told.
 */
export function refoldRoutedFills(input: {
  readonly legs: readonly BridgeLeg[]
  readonly routedFills: readonly RefoldFill[]
  readonly views: readonly (readonly BridgeLeg[])[]
  readonly mayCreate: boolean
  readonly nowMs: number
}): RefoldResult {
  let legs = input.legs
  const outcomes: RefoldOutcome[] = []
  const dropped = (fill: RefoldFill, reason: 'no-leg' | 'capped'): void => {
    outcomes.push({ fill, applied: 0, shortfall: fill.qty, skipped: true, reason })
  }

  for (const f of input.routedFills) {
    const held = legs.find((l) => l.instrument.tradingsymbol === f.tradingsymbol)
    if (held === undefined && !input.mayCreate) {
      dropped(f, f.reduceOnly === true ? 'capped' : 'no-leg')
      continue
    }
    // MATCHED BY CONTRACT, never by desk tag: a flatten routes under its own
    // generated tag, and a roll re-tags. The tradingsymbol is the identity the
    // book and the fill share.
    const meta =
      held ??
      input.views
        .map((v) => v.find((l) => l.instrument.tradingsymbol === f.tradingsymbol))
        .find((l) => l !== undefined)
    // No leg anywhere describes this contract, so we cannot say what strike or
    // type it is. Guessing one is how phantom contracts get booked; skip it and
    // let the reconciler answer from the broker.
    if (meta === undefined) {
      dropped(f, 'no-leg')
      continue
    }

    /**
     * THE CAP IS RE-DERIVED HERE, against the legs this fill is about to touch.
     *
     * `applyRoutedFill` consumes offsetting legs and then opens a NEW leg with
     * whatever remains. For a compensation that remainder is a position nobody
     * ordered, so a `reduceOnly` fill is trimmed to exactly what it can consume
     * and the remainder is reported instead of booked.
     */
    let qty = f.qty
    if (f.reduceOnly === true) {
      const sign = f.side === 'Buy' ? 1 : -1
      const offsetting = legs
        .filter((l) => l.instrument.tradingsymbol === f.tradingsymbol && Math.sign(l.qty) === -sign)
        .reduce((sum, l) => sum + Math.abs(l.qty), 0)
      qty = Math.min(f.qty, offsetting)
      if (qty <= 0) {
        dropped(f, 'capped')
        continue
      }
    }

    legs = applyRoutedFill(legs, {
      instrument: meta.instrument,
      underlying: meta.underlying,
      expiry: meta.expiry,
      strike: meta.strike,
      type: meta.type,
      side: f.side,
      qty,
      price: f.price,
      ts: input.nowMs,
      deskTag: f.deskTag,
      /**
       * THE FILL'S OWN LEAN, not the view's (plan 10A). The identity fields
       * above come from `meta` — a contract rebuilt out of the instrument
       * master, which knows the strike and nothing about whose bet it is —
       * while the stamp is a property of the ORDER, and travels with it.
       *
       * Conditional, so a fill with no lean adds no key at all.
       */
      ...(f.leanId === undefined ? {} : { leanId: f.leanId }),
    })
    outcomes.push({
      fill: f,
      applied: qty,
      shortfall: f.qty - qty,
      skipped: false,
      ...(qty < f.qty ? { reason: 'capped' as const } : {}),
    })
  }
  return { legs, outcomes }
}

/**
 * What a lost-race recovery did.
 *
 * `'already-applied'` means the FRESH document already carries this fold's
 * nonce: the writer who won the race was another pass of the same correction
 * (two API processes each run a reconciler), and it has already folded it.
 * Re-applying it here would be the double-fold the nonce exists to prevent, so
 * nothing is written and the caller finishes the job.
 *
 * `'ok-with-skips'` is deliberately NOT `'ok'`: the write landed, but at least
 * one ROUTED fill did not reach the legs, so the book that was just persisted
 * is known to be missing an order the broker has already executed. Callers
 * journal the difference, because the pass counters cannot tell them apart.
 */
export interface RefoldConflictResult {
  readonly status: 'ok' | 'ok-with-skips' | 'already-applied' | 'lost' | 'gone'
  /** One per routed fill, in order. Empty when nothing was folded at all. */
  readonly outcomes: readonly RefoldOutcome[]
}

/**
 * Recover from a lost compare-and-set: re-read, re-fold, write once more.
 *
 * Called ONLY when `saveBook` answered `'conflict'`. Never throws — see the
 * header.
 */
export async function refoldOnConflict(input: RefoldInput): Promise<RefoldConflictResult> {
  const { store, key, nowMs, log } = input
  const doc = await store.bookDoc(key.tag, key.mode)
  if (doc === null) {
    // The row is GONE, not stale — the book was deleted while we routed.
    // Recreating it would resurrect a book an operator just removed, so the
    // divergence is reported instead.
    log(
      `[bridge] book write lost a race and ${key.tag} (${key.mode}) no longer exists — ` +
        `decision recorded, book NOT updated`,
    )
    return { status: 'gone', outcomes: [] }
  }
  /**
   * THE WINNER WAS THIS SAME CORRECTION, folded by another pass.
   *
   * The pre-fold check in `reconcile-live.ts` runs against the document we read
   * BEFORE routing our write; the race we just lost may have been another
   * process's copy of this very fold. Re-applying it onto the winner's legs is
   * exactly the double-fold the receipt exists to prevent, so it is checked
   * again here, on the fresh document, where the answer is current.
   */
  if (input.nonce !== undefined && (doc.appliedCorrections ?? []).includes(input.nonce)) {
    log(
      `[bridge] book write lost a race for ${key.tag} (${key.mode}) to another pass of the SAME ` +
        `correction (${input.nonce}) — it is already on the book and is NOT folded twice`,
    )
    return { status: 'already-applied', outcomes: [] }
  }
  const folded = refoldRoutedFills({
    legs: doc.legs,
    routedFills: input.routedFills,
    views: [input.nextBook, input.priorBook],
    mayCreate: input.mayCreate,
    nowMs,
  })

  /**
   * EVERY DROPPED FILL IS NAMED, one line each, before the write.
   *
   * A `no-leg` skip is a routed order — usually an EXIT — that the book will
   * now never show, and no code anywhere can put it back: the order is out at
   * the broker. Silence here was the defect. A `capped` outcome is the
   * `reduceOnly` cap doing its job and is NOT an alarm; its caller reports the
   * real quantity from the outcome instead.
   */
  let skipped = false
  for (const o of folded.outcomes) {
    if (o.reason !== 'no-leg') continue
    skipped = true
    log(
      `[bridge] ROUTED fill could NOT be re-folded after losing the race; book and broker ` +
        `may now disagree — check positions: tag=${key.tag} (${key.mode}) ` +
        `${o.fill.tradingsymbol} ${o.fill.side} ${o.fill.qty}`,
    )
  }

  // An `updatedAt`-less document predates F-27 and cannot be compared against;
  // `saveBook` then takes its historical unconditional path, which is the same
  // behaviour that row has always had rather than a new hazard.
  const outcome = await store.saveBook(
    { ...key, symbol: doc.symbol, expiry: key.expiry === '' ? doc.expiry : key.expiry },
    folded.legs,
    nowMs,
    doc.updatedAt,
    input.nonce,
  )
  if (outcome === 'ok') {
    return { status: skipped ? 'ok-with-skips' : 'ok', outcomes: folded.outcomes }
  }
  log(
    `[bridge] book write lost two races for ${key.tag} (${key.mode}) — decision recorded, ` +
      `book NOT updated; the reconciler will surface the divergence`,
  )
  return { status: 'lost', outcomes: [] }
}
