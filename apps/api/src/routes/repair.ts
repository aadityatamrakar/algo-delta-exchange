/**
 * THE REPAIR APPLY BUTTON'S THREE ENDPOINTS — preview, place, watch.
 *
 *   POST /v1/desk/repair/preflight    what these moves WOULD place
 *   POST /v1/desk/repair/apply        place them, once, under a claimed id
 *   GET  /v1/desk/repair/apply/:id    the run's ledger while and after it runs
 *
 * ── WHAT `apply` ADDS OVER `preflight`, AND WHAT IT DELIBERATELY DOES NOT ───
 *
 * It adds five gates and ONE new capability, and the capability is not "placing
 * orders" — `SubmitService` places orders, and it is the same instance-shaped
 * object every manual order and every hosted strategy goes through, built here
 * from the same dependency bag `routes/submit.ts` builds it from. What this
 * endpoint adds is the SEQUENCING (`repair-apply.ts`: closes, real fills, then
 * opens) and the five refusals in front of it:
 *
 *   FINGERPRINT  `legsPrint` is recomputed and compared — the LEGS the operator
 *                confirmed, not the prices they were quoted. A plan whose legs
 *                moved under it is the class of error the preview exists to
 *                prevent, so a mismatch is a 409 and not a warning; a quote
 *                that ticked is not, because nothing here executes at a
 *                previewed price. Compared against BOTH of this endpoint's
 *                reads of the book, because the password gate sits between
 *                them. See `placeRepair` for why the wide `bookPrint` is the
 *                wrong instrument for this job.
 *   PASSWORD     a LIVE apply re-authenticates, exactly as arming a live
 *                strategy does (`routes/desk.ts`) — same gate object, same 403
 *                shape, same reason: password-only auth means one leaked
 *                session is otherwise a live trading account.
 *   RE-RESOLVED  the client's expansion is never trusted. `resolveOrders` runs
 *                again, server-side, against the book AS IT STANDS, and ANY
 *                drop refuses the whole plan rather than executing the part the
 *                bridge understood.
 *   ONE PER TAG  the apply service's own claim. Two wave machines on one book
 *                is a doubled position with two screens both reading correct.
 *   KILL SWITCH  read about the PLAN, not about each order. The rail's own
 *                GATE 3 lets every close through and refuses every open, which
 *                on a shift is the naked book this whole feature is sequenced
 *                to avoid — so a plan holding an open is refused here, whole,
 *                while a pure-close plan still goes out. See "the desk-wide
 *                halt" below.
 *
 * ── WHY THE STATUS ROUTE IS A GET OF A DOCUMENT ─────────────────────────────
 *
 * The run is DETACHED — Confirm answers in one round trip and the waves take up
 * to ten minutes — so the modal polls. The document is written before `start`
 * returns, so there is no window in which the caller holds an applyId that
 * resolves to nothing, and the ledger it reads is the same one that survives
 * the run: after a halt it is the record of what actually executed, which is
 * what the operator finishes by hand from.
 *
 * ── `POST /v1/desk/repair/preflight` — THE ONLY SCREEN BETWEEN A REPAIR CARD
 * AND REAL ORDERS ───────────────────────────────────────────────────────────
 *
 * The cockpit next door (`routes/payoff.ts`) is a menu: it ranks repair plans in
 * the vocabulary the search reasons in — `close` this leg, `shift` that one,
 * `hedge` a wing — and a human then re-typed those sentences into the order box.
 * The Apply button removes the re-typing, and this endpoint is what earns the
 * right to remove it: it answers the four questions the operator was answering
 * by hand, against the book AS IT STANDS NOW rather than against the snapshot
 * the card was searched on.
 *
 *   ORDERS   what a broker would actually be sent — a side, a contract, a whole
 *            number of lots — with each one priced by WALKING THE BOOK for its
 *            own size rather than quoting the last print. `repair-plan.ts` owns
 *            both the crossing and the walk; this file owns the JOIN, which is
 *            the part that needs the chain.
 *   DROPPED  every move that could not be crossed, named. `/repair/apply`
 *            refuses outright when this is non-empty, so a drop here is a
 *            refusal there — the operator finishes by hand rather than
 *            executing a plan the bridge only half understood.
 *   MARGIN   the same `verifyMargin` the standalone route runs: SPAN-lite beside
 *            the broker's own basket figure. Asked automatically, because a
 *            verify the operator has to remember to press is a verify that gets
 *            skipped on the day it matters.
 *   DELTA    the book now and the book the plan would leave, in the POSITIONS
 *            engine — not the cockpit's Black-76 one. The panel is read against
 *            the Positions tiles, and two models in one comparison is how a
 *            hedge gets sized against a delta no other screen agrees with.
 *
 * ── WHY IT IS NOT IN `payoff.ts` ────────────────────────────────────────────
 *
 * That file's own header makes a structural safety claim: nothing in it decides
 * anything and nothing in it places an order, and there is no rail in the file
 * to reach. Preflight is the first half of an ORDER path. Keeping it here keeps
 * that claim true of that file, and puts this one beside `repair-apply.ts`,
 * which is what will hold the rail.
 *
 * ── FAIL-SOFT, WITH ONE EXCEPTION ───────────────────────────────────────────
 *
 * A missing `tag` is a 400 — there is no all-books repair, and picking a book
 * would preflight a different strategy's position under this one's name.
 * EVERYTHING else is a 200 that says what went wrong, for the reason the cockpit
 * gives: this answer renders inside a modal beside a live position, and a failed
 * fetch there is a blank panel at exactly the moment the operator needs to read
 * one. An unreadable `moves` is the one case that must not degrade quietly into
 * an empty plan — an empty plan reads as "this repair changes nothing", so it
 * goes to `dropped` instead, where the Confirm button is already disabled by it.
 *
 * ── THE ONE SEAM WORTH KNOWING ──────────────────────────────────────────────
 *
 * `margin` is computed by APPLYING the moves (`applyMoves`, the payoff
 * vocabulary) while `orders` is computed by RESOLVING them (`resolveOrders`, the
 * broker vocabulary). The two refuse on slightly different grounds — a size that
 * is not a whole number of lots is a plan `applyMoves` will happily price and a
 * plan no broker can be sent — so on a plan with anything in `dropped` the
 * margin figure describes a book fractionally different from the orders beside
 * it. That is survivable precisely because `dropped` is a refusal downstream:
 * no plan carrying one is ever executed, so the two never disagree about
 * anything that trades.
 */

import { FreezeLimits } from '@algomaker/instruments'
import { bookGreeks, carryYield, type LegGreeks, type PositionLeg } from '@algomaker/greeks'
import { DEFAULT_RATE, DEFAULT_REPAIR_DIALS, type Move } from '@algomaker/payoff'
import { loadFreezeLimits } from '../../../marketdata/src/sync-runner.ts'
// TYPE-ONLY, and erased at runtime — see `VERDICT_OF`. `@algomaker/api` takes
// no build dependency on the gateway app; it borrows its vocabulary so that a
// state added there cannot be missed here.
import type { OrderState } from '../../../order-gateway/src/queue.ts'
import type { AuthGate } from '../authgate.ts'
import type { ChainQuote, ChainResponse } from '../chain.ts'
import type { DeskMode } from '../contract.ts'
import { errorMessage } from '../errors.ts'
import type { JournalEntry } from '../livebook.ts'
import { marketableFromEnv } from '../marketable.ts'
import type { KillSwitchState } from '../safety.ts'
import { LiveRail, LIVE_COLLECTION, PaperRail, type PaperFillEmit } from '../rail.ts'
import type { PositionsResponse } from '../service.ts'
import {
  bookLegsPrint,
  deltaPictures,
  estimateFill,
  legsPrint,
  resolveOrders,
  type DeltaGreekOpts,
  type DeltaPicture,
  type FillEstimate,
  type PlannedOrder,
} from '../repair-plan.ts'
import { RepairApplyService, repairHoldLookup, type RepairQuote } from '../repair-apply.ts'
import { liveAllowlistFromStrategies } from '../strategies.ts'
import { COLLECTIONS } from '../store.ts'
import { liveTagsFromEnv, SubmitService, type SubmitRequestBody } from '../submit.ts'
import {
  assemble,
  bookPrint,
  marginProxyFromEnv,
  verifyMargin,
  type Assembled,
  type MarginProxyConfig,
  type VerifyMarginResponse,
} from './payoff.ts'
import type { ApiDeps, Route, RouteCtx } from './kit.ts'
import { isObject, suffixOf } from './kit.ts'

// ------------------------------------------------------------ the wire shape

/**
 * A planned order with what the market says about it RIGHT NOW.
 *
 * `mark` is the chain's own price for the contract — already the MID when the
 * tick carried two sides (`marks.ts:#effective`), so nothing here re-derives a
 * mid and the modal's reference price is the same one the greeks, the paper
 * fills and the marketable-limit pricer all read.
 *
 * `est` is what this SIZE would pay, which is a different number and the one
 * that matters on an order screen. Null only when the chain has no quote at all
 * for the contract; a quote with an empty book still answers, with a null
 * `price` and `exceedsDepth` set — "no depth on this tick" and "no market" are
 * not the same fact to a reader.
 */
export interface PricedOrder extends PlannedOrder {
  readonly mark: number | null
  readonly est: FillEstimate | null
}

export interface RepairPreflightResponse {
  readonly tag: string
  readonly mode: DeskMode
  readonly asOf: number
  /**
   * The INPUTS this plan was priced against, fingerprinted — the same scheme
   * the snapshot archive dedupes on, and the same one `/repair/apply` STAMPS
   * onto the run for the record.
   *
   * IT IS NOT THE APPLY'S STALENESS GUARD, and was: it hashes every live chain
   * price, the spot and the future, so it moves on essentially every tick. A
   * 409 keyed on it would have refused every mid-session Confirm — the operator
   * reads the modal, one quote prints, the plan is dead — which is a preview
   * that cannot be acted on rather than a safety property. `legsPrint` below is
   * the guard. See `placeRepair`.
   */
  readonly bookPrint: string
  /**
   * THE LEGS THIS PLAN ADDRESSES, fingerprinted — `repair-plan.ts:legsPrint`,
   * the same value `/v1/desk/repair` serves beside the cards.
   *
   * Accepted (to guard the menu → preflight step) AND served, because it is
   * what `/repair/apply` compares: the modal carries THIS value into Confirm,
   * and a quote that ticked in between changes nothing the operator read.
   */
  readonly legsPrint: string
  readonly orders: readonly PricedOrder[]
  readonly dropped: readonly string[]
  readonly margin: VerifyMarginResponse
  readonly delta: { readonly current: DeltaPicture; readonly after: DeltaPicture }
  /**
   * A repair still owns this tag — the button stays held.
   *
   * It is the SUPERVISOR's hold verbatim (`repairHoldLookup`), which outlives
   * the run itself by the driver's adoption grace (`REPAIR_HOLD_GRACE_MS`), so
   * for a minute and a half after a repair finishes this reads true while
   * `RepairApplyService.start` would in fact accept the next plan. That is the
   * deliberate direction: the two answers are ONE definition of "held", a false
   * hold costs a retry, and the sentence the modal renders says both things.
   */
  readonly holdActive: boolean
  readonly warnings: readonly string[]
}

/**
 * What this module is built with: the shared bag plus the password gate, as
 * `routes/desk.ts` and `routes/books.ts` take it. A LIVE apply re-authenticates
 * through the same object those do — one definition of "prove a person is at
 * the keyboard", not a second one that could disagree with it.
 */
export type RepairDeps = ApiDeps & { readonly gate: AuthGate }

export interface RepairRouteOptions {
  /**
   * Where `verifyMargin` asks the broker. Absent, it is read from the
   * environment, exactly as `payoffRoutes` does; the suite injects a `fetch`
   * here so no test opens a socket.
   */
  readonly margin?: MarginProxyConfig
}

/**
 * THE 409 BODY, in one place because it is sent from two.
 *
 * Both checks are the same refusal — the legs this plan addresses are not the
 * legs it was written against — and they are made against two different reads
 * of the book (see `placeRepair`). Two wordings would read to the operator as
 * two different problems, and the client narrows on `error` alone.
 */
function bookChanged(tag: string): Record<string, string> {
  return {
    error: 'book-changed',
    detail:
      `the legs behind '${tag}' are not the ones this plan was written against — a leg has been ` +
      'opened, closed or resized since it was previewed, and its moves address legs by POSITION. ' +
      'Preflight again and read the new answer before placing it.',
  }
}

/** The sentence a card that has outlived its book is refused with. */
const BOOK_MOVED =
  'the book has changed since this menu was drawn — search again rather than aiming this ' +
  'sentence at whatever now sits under its leg id'

/* ---------------------------------------------------- the desk-wide halt ---
 *
 * THE KILL SWITCH, ASKED ABOUT THE WHOLE PLAN RATHER THAN ABOUT ONE ORDER.
 *
 * Every order this feature places is already screened by `SubmitService`'s own
 * GATE 3, and that gate is PER ORDER — which is exactly the failure. A close
 * carries `reducesExposure` by construction (`repair-plan.ts:closeOrder`) and
 * passes it; an open does not and is refused. So on a halted desk a shift fills
 * its CLOSE wave and is then refused its OPEN wave, leaving the book naked on
 * the leg it has just taken off: the half-applied shape the atomicity of
 * `resolveOrders` and the wave machine exist to prevent, arrived at through a
 * safety control. The switch therefore has to be read ONCE, about the plan,
 * before anything is placed — see `placeRepair`.
 *
 * A PURE-CLOSE PLAN IS NEVER REFUSED HERE, and the register is not even asked
 * about one. The governing rule of this desk (`safety.ts`,
 * `packages/order-bus/src/risk.ts:82`): a control stops NEW exposure and never
 * blocks an exit, because trapping an open position behind a safety control is
 * worse than whatever the control was protecting against. A halted desk must
 * still be able to get flat.
 */

/** ` (why the desk is down)`, or nothing — both sentences below open with it. */
function because(halt: KillSwitchState): string {
  return halt.reason === '' ? '' : ` (${halt.reason})`
}

/** What the PREVIEW says, so the refusal is not a surprise at Confirm. */
function killSwitchWarning(halt: KillSwitchState): string {
  return (
    `the kill switch is engaged${because(halt)} — Apply will refuse this plan while it holds an ` +
    'open, because the closes in front of it would fill and the opens behind them would not'
  )
}

/** What the APPLY refuses with. Same fact, said where it costs something. */
function killSwitchRefusal(halt: KillSwitchState, opens: number): string {
  return (
    `kill switch: engaged${because(halt)} — this plan opens ${opens} new ` +
    `${opens === 1 ? 'leg' : 'legs'}, and a halted desk places exposure-reducing orders only. ` +
    'Nothing was placed: the closes in front of those opens would have filled and left this book ' +
    'naked on the legs it had just taken off. A plan that only CLOSES is still accepted.'
  )
}

/** The same fact when the register itself cannot be read. Refused, not guessed. */
const SWITCH_UNREADABLE =
  'the desk-wide kill switch could not be read, so this plan cannot be shown to be allowed to open ' +
  'new exposure — refused rather than placing the closes in front of it on a guess. A plan that ' +
  'only CLOSES is unaffected.'

/**
 * The switch, or null when the register would not answer.
 *
 * FAIL-SOFT ONLY IN THE READ. Both callers turn a null into the CONSERVATIVE
 * answer — the preview says it cannot vouch, the apply refuses — for the reason
 * `activeHold` gives one screen over: a false clearance on this path is new
 * exposure opened while the desk is halted, and a false hold costs a retry.
 */
async function killSwitch(deps: ApiDeps): Promise<KillSwitchState | null> {
  try {
    return await deps.store.loadKillSwitch()
  } catch (err: unknown) {
    deps.log('the kill switch register could not be read on the repair path', {
      error: errorMessage(err),
    })
    return null
  }
}

/**
 * PAST THIS, A QUOTE IS NOT AN EXECUTION PRICE.
 *
 * The cockpit's own staleness dial — the window `solveChainIvs` accepts a quote
 * inside and `bookPrint` records freshness against — so an order estimated here
 * and a vol solved next door agree about what still counts as evidence.
 *
 * IT IS NOT RELAXED AFTER THE CLOSE, and that is the one place this file
 * deliberately parts company with `assemble`. The cockpit widens its window out
 * of hours because it is READING last session's book and says so in the header.
 * This endpoint is the preview for placing orders, and "the depth you are about
 * to be priced against is nineteen hours old" is a fact about the order, not
 * noise about the clock.
 */
const STALE_QUOTE_MS = DEFAULT_REPAIR_DIALS.maxQuoteAgeMs

// ------------------------------------------------------------------- the route

const APPLY_PATH = '/v1/desk/repair/apply'

export function repairRoutes(deps: RepairDeps, opts: RepairRouteOptions = {}): Route {
  /** Read ONCE per process, like every other env-derived config in this app. */
  const margin = opts.margin ?? marginProxyFromEnv()

  /**
   * THE ONE APPLY SERVICE THIS PROCESS HAS, and the boot halt that goes with it.
   *
   * A singleton because the run it starts is IN MEMORY: the wave machine lives
   * in the promise `start` detaches, so a second service would be a second set
   * of machines with no way to see each other's. The Mongo claim would catch
   * two racing runs, but only after both had inserted — and a process arguing
   * with itself about which of its own runs owns a book is not a state worth
   * being able to reach.
   *
   * `haltStaleRunsOnBoot` runs ONCE, here, for the same reason: a RUNNING row
   * left by the process that died is a run nothing is watching and a hold on a
   * live book. It is not awaited — a bridge that could not open its port until
   * Mongo answered would be down during exactly the outage it is needed in —
   * and its failure is logged rather than thrown, because the hold's TTL is the
   * backstop that releases the book regardless.
   */
  const rail = orderRailFor(deps)
  const applies = new RepairApplyService({
    db: deps.db,
    rail,
    now: deps.now,
    log: deps.log,
    quote: (tradingsymbol) => liveQuoteOf(deps, tradingsymbol),
    // The collection the RAIL chose, so the reader and the writer cannot be
    // pointed at two different ones.
    fillState: repairFillState(deps, rail.liveOrders),
  })
  void applies.haltStaleRunsOnBoot().catch((err: unknown) => {
    deps.log('stale repair runs could not be halted on boot — the hold TTL is the backstop', {
      error: errorMessage(err),
    })
  })

  return async (ctx: RouteCtx): Promise<boolean> => {
    const { path, method, send } = ctx
    if (path === APPLY_PATH && method === 'POST') {
      return await placeRepair(deps, applies, ctx)
    }
    /**
     * The status GET, matched on the SUFFIX so a malformed percent-escape in an
     * applyId is a 400 from the dispatcher rather than a 500 from here.
     */
    const applyId = suffixOf(path, `${APPLY_PATH}/`)
    if (applyId !== null && method === 'GET') {
      const run = await applies.status(applyId)
      if (run === null) {
        send(404, { error: `no repair run under '${applyId}'` })
        return true
      }
      send(200, run)
      return true
    }
    if (path !== '/v1/desk/repair/preflight' || method !== 'POST') return false

    const raw = await ctx.readJson()
    const body = isObject(raw) ? raw : {}
    const tag = typeof body['tag'] === 'string' ? body['tag'] : ''
    if (tag === '') {
      send(400, { error: 'tag is required' })
      return true
    }
    const mode: DeskMode = body['mode'] === 'live' ? 'live' : 'paper'

    const rawMoves = body['moves']
    const readable = Array.isArray(rawMoves)
    const moves: readonly Move[] = readable ? (rawMoves as readonly Move[]) : []
    /** The card's own view of the legs, when the client threads one. See below. */
    const drawnPrint = typeof body['legsPrint'] === 'string' ? body['legsPrint'] : null

    const dropped: string[] = []
    if (rawMoves !== undefined && !readable) {
      /**
       * NOT A WARNING. A malformed plan that answered with an empty `orders`
       * and an empty `dropped` would render as "this repair places nothing",
       * which is the one reading a repair preview must never produce — and it
       * would leave Confirm enabled. `dropped` is what the apply route refuses
       * on, so an unreadable request refuses there too.
       */
      dropped.push('moves was not a list of {op, …} — nothing in this request could be read as a plan')
    }

    const hold = await activeHold(deps, tag)
    const book = await assemble(deps, tag, mode)
    const warnings: string[] = [...book.warnings, ...hold.warnings]
    /**
     * AN ABSENT `moves` KEY IS AN EMPTY PLAN, and says so in the same words.
     *
     * It used to answer with an empty `orders`, an empty `dropped` and no
     * sentence at all — which renders as "this repair changes nothing" beside
     * an ENABLED Confirm, the one reading this preview must never produce. The
     * malformed case above is louder still (it refuses), and the difference is
     * deliberate: "you sent nothing" is a plan that places nothing, while "you
     * sent something I could not read" is a plan I do not understand.
     */
    if (moves.length === 0 && (readable || rawMoves === undefined)) {
      warnings.push('this request carries no moves, so there is nothing here to place')
    }

    /**
     * THE BOOK AS THE PREFLIGHT SEES IT, fingerprinted the same way the menu
     * fingerprinted it. Computed after `assemble` because it is a function of
     * the legs, and served whatever the comparison says.
     */
    const nowPrint = bookLegsPrint(book.legs)
    /**
     * THE CARD OUTLIVED ITS BOOK — the one staleness `bookPrint` cannot cover.
     *
     * A legId is POSITIONAL (`repair-plan.ts:legsById`), so a book that loses
     * one pocket of a doubled contract re-points the bare id onto the pocket
     * behind it. Every screen still reads correct and the close goes out at the
     * survivor's full size. `bookPrint` would catch it and everything else too
     * — it moves on every quote — so it is the wrong instrument in front of a
     * menu a human reads for minutes. This is the narrow one.
     *
     * ADDS AND HEDGES ARE UNTOUCHED. They name a strike and a side; nothing
     * about them can have re-pointed. Only the moves that address a LEG are
     * refused, and `resolveOrders` is told WHY so each drop names its own move.
     */
    const legIdsStale = drawnPrint !== null && drawnPrint !== nowPrint
    if (legIdsStale) warnings.push(BOOK_MOVED)

    const answer = (
      orders: readonly PricedOrder[],
      margins: VerifyMarginResponse,
      delta: { readonly current: DeltaPicture; readonly after: DeltaPicture },
      extra: readonly string[],
    ): RepairPreflightResponse => ({
      tag,
      mode,
      asOf: book.asOf,
      /**
       * `''` FOR THE EXTRA ARG, and `placeRepair` below spells it the same way
       * — not because anything compares the two any more (it does not; see
       * `bookPrint`'s field doc above) but because the value it stamps on the
       * run has to be READ against this one afterwards. `bookPrint` mixes that
       * argument into the hash, so two spellings would file the preview and the
       * run it authorised under two unrelated fingerprints and nobody could
       * join them. The other call site is `placeRepair`; neither should move
       * without the other.
       */
      bookPrint: bookPrint(book, 'repair', ''),
      legsPrint: nowPrint,
      orders,
      dropped,
      margin: margins,
      delta,
      holdActive: hold.active,
      warnings: [...warnings, ...extra],
    })

    if (book.error !== null) {
      /**
       * NO BOOK, so nothing joins: resolving against an empty leg list would
       * fill `dropped` with "no such leg" for every move, which reads as a book
       * that has moved on rather than as a tag that names nothing. The one
       * sentence is the honest answer, and `verifyMargin` short-circuits on the
       * same condition without asking the broker anything.
       */
      warnings.unshift(book.error)
      send(200, answer([], await verifyMargin(deps, book, moves, margin), emptyDelta(book.asOf), []))
      return true
    }

    const pos = await deps.service.positions(tag, mode, { realised: true })
    const resolved = resolveOrders({
      // THE BOOK AS IT STANDS, never the card's snapshot: a leg the bot has
      // shifted since the menu was drawn no longer joins, and that move is
      // dropped rather than aimed at whatever now sits under its old id.
      legs: pos.legs,
      moves,
      chain: book.chain,
      // 0, never a guess — `resolveOrders` then opens nothing, which is the
      // right refusal for a book whose lot size the master does not know.
      lotSize: book.chain?.lotSize ?? 0,
      bookExpiry: book.expiry,
      // Absent, never `undefined`: `exactOptionalPropertyTypes`, and a present
      // key holding nothing is not the same as a key that was not sent.
      ...(legIdsStale ? { legIdsStale: BOOK_MOVED } : {}),
    })
    dropped.push(...resolved.dropped)

    const extra: string[] = []
    const orders = resolved.orders.map((order) => {
      const q = quoteFor(book.chain, order)
      const units = order.lots * order.instrument.lotSize
      const name = order.instrument.tradingsymbol
      const walked = estimateFill(order.side, units, q)
      const stale = q !== null && !(q.ageMs <= STALE_QUOTE_MS)

      if (q === null) {
        extra.push(
          `"${name}": the ${book.expiry} chain carries no quote for it, so this order shows neither a ` +
            'mark nor an execution estimate — it would be placed blind',
        )
      } else if (stale) {
        extra.push(
          `"${name}": its book is ${Math.round(q.ageMs / 1000)}s old, past the ${Math.round(
            STALE_QUOTE_MS / 1000,
          )}s this desk treats as evidence — no execution estimate is offered, and the mark beside it is ` +
            'the last one seen, not a price anyone is showing now',
        )
      } else if (walked?.exceedsDepth === true) {
        extra.push(
          `"${name}": the book only shows ${walked.coveredQty} of the ${units} this order would ` +
            `${order.side === 'Buy' ? 'buy' : 'sell'} — the estimate is the VWAP of what is visible, and ` +
            'the rest fills at whatever is behind it',
        )
      }

      return {
        ...order,
        mark: q?.price ?? null,
        // A STALE QUOTE WITHDRAWS THE PRICE AND KEEPS THE REST: the age and the
        // visible size are still facts, and they are what tell the operator WHY
        // there is no estimate. Nulling the whole object would say "no market".
        est: walked === null ? null : stale ? { ...walked, price: null } : walked,
      }
    })

    /**
     * WOULD CONFIRM BE REFUSED? Asked here because the modal renders
     * `warnings`, and this is the only screen between the card and the button:
     * a plan the apply route is going to refuse must say so while the operator
     * is still reading, not after they have pressed. Asked ONLY of a plan that
     * opens something — see "the desk-wide halt" above for why a pure-close
     * plan is neither refused nor warned about.
     */
    if (resolved.orders.some((o) => o.wave === 'open')) {
      const halt = await killSwitch(deps)
      if (halt === null) extra.push(SWITCH_UNREADABLE)
      else if (halt.enabled) extra.push(killSwitchWarning(halt))
    }

    // ---- the book now, and the book this plan would leave -------------------
    const current = currentLegs(pos)
    const folded = foldPlan(current, resolved.orders, book.symbol, pos.spot ?? 0, (o) =>
      quoteFor(book.chain, o)?.price ?? null,
    )
    if (folded.unmarkable.length > 0) {
      extra.push(
        `${quoted(folded.unmarkable)}: the chain prices nothing for them, so the "after" column below is ` +
          'computed WITHOUT the legs this plan would open — read it as the floor of what the book would carry',
      )
    }
    const model = modelPass(greekOptsFor(book, pos), current, book.asOf)
    if (model.modelled.length > 0) {
      extra.push(
        `${quoted(model.modelled)}: no vol solves from their own quote, so both columns below price them ` +
          "at the book's MEDIAN solved vol — an estimate, and exactly how the Positions tiles carry them",
      )
    }
    if (model.dropped.length > 0) {
      extra.push(
        `${quoted(model.dropped)}: nothing on this book solved a vol to model them from, so they are ` +
          'OUT of both columns below — the delta figures understate this book by whatever they hold',
      )
    }
    /**
     * A LEG THIS PLAN WOULD OPEN THAT THE HYPOTHETICAL CANNOT PRICE. The model
     * pass above is decided on the book AS IT STANDS — that is what makes the
     * "now" column the tile — so a shift landing on a deep-ITM strike, whose own
     * mid admits no vol, can fall out of the "after" column alone. Silently, and
     * in the direction that flatters the plan.
     */
    const afterOnly = bookGreeks(folded.legs, book.asOf, model.opts).unpriced.filter(
      (s) => !model.modelled.includes(s) && !model.dropped.includes(s),
    )
    if (afterOnly.length > 0) {
      extra.push(
        `${quoted(afterOnly)}: the chain's own mid for them admits no vol, so the "after" column below ` +
          'leaves them out — the delta this plan would ADD is understated by whatever they carry',
      )
    }

    send(
      200,
      answer(
        orders,
        await verifyMargin(deps, book, moves, margin),
        deltaPictures({
          current,
          after: folded.legs,
          // The POSITIONS engine's own spot, so the "now" column is the tile.
          spot: pos.spot,
          nowMs: book.asOf,
          greekOpts: model.opts,
        }),
        extra,
      ),
    )
    return true
  }
}

// --------------------------------------------------------------- the placing

/**
 * `POST /v1/desk/repair/apply` — the plan becomes orders.
 *
 * FOUR REFUSALS BEFORE ANY OF THEM MOVES, in this order and for these reasons:
 *
 *  400  the request cannot be executed as written. `tag`, `decisionId` and
 *       `legsPrint` are all unguessable: picking a book would repair a
 *       different strategy's position, inventing a decisionId would defeat the
 *       idempotency it exists to provide, and an absent fingerprint is a plan
 *       pinned to nothing.
 *  409  the LEGS no longer match the ones the operator confirmed. NOT a
 *       warning: the plan addresses them by a POSITIONAL id, so a book that
 *       lost a pocket re-points a sentence onto a leg that was never on screen.
 *       Asked TWICE — once of the book this endpoint reads to price and gate
 *       on, and again of the book the orders are actually resolved against,
 *       since the password gate spends real time between the two.
 *  403  live, and the operator has not re-proved they are there.
 *  200  `{accepted:false}` — the plan is understood and refused: something in
 *       it dropped, it places nothing, the desk is halted and the plan opens
 *       something, a run already owns this tag, or the decisionId already owns
 *       a run on ANOTHER book. A 200 rather than a 4xx because the REQUEST was
 *       fine and the answer is a sentence to read.
 *
 * ── WHY THE GUARD IS `legsPrint` AND NOT `bookPrint` ────────────────────────
 *
 * It was `bookPrint`, and that was a defect rather than a strictness. That hash
 * covers every live chain price, the spot and the future, so it moves on the
 * next tick of any strike on the board: an operator who opened the modal, read
 * four numbers and pressed Confirm would have been 409'd on essentially every
 * mid-session click. A guard that fires on a plan nobody changed does not make
 * anything safer, it just teaches its user that Confirm is broken.
 *
 * What the operator actually confirmed is a set of LEGS — which contracts, at
 * what size, entered where — and `legsPrint` is exactly that and nothing else.
 * The PRICES need no fingerprint at all, because nothing here executes at a
 * previewed price: `RepairApplyService` re-reads the quote at submit time and
 * prices each order off the live touch, and the preflight's estimate was only
 * ever a preview. So the narrow print is not the weaker check, it is the one
 * that describes the thing being authorised.
 *
 * `bookPrint` is still recomputed — and STAMPED on the run, never compared —
 * so an after-the-fact reader can tell which book state the operator was
 * looking at. That is the job it can actually do.
 */
async function placeRepair(
  deps: RepairDeps,
  applies: RepairApplyService,
  ctx: RouteCtx,
): Promise<boolean> {
  const { send, log } = ctx
  const raw = await ctx.readJson()
  const body = isObject(raw) ? raw : {}
  const tag = typeof body['tag'] === 'string' ? body['tag'] : ''
  if (tag === '') {
    send(400, { error: 'tag is required' })
    return true
  }
  /**
   * THE CLAIM. It is the caller's `decisionId` verbatim and it is what makes a
   * lost 202 safe to retry: the same id executes once, however many times it
   * is asked for. Minting one here would make every retry a second repair.
   */
  const decisionId = typeof body['decisionId'] === 'string' ? body['decisionId'] : ''
  if (decisionId === '') {
    send(400, {
      error:
        'decisionId is required — it is the claim this run executes under, and a request without ' +
        'one cannot be retried safely',
    })
    return true
  }
  /**
   * BOUNDED AND PLAIN, because this string becomes an INDEXED `_id` and the
   * stem of every `clientOrderId` the run mints (`repair:<id>:<n>`), which is
   * itself uniquely indexed twice more. Mongo refuses an indexed key over ~1KB
   * — as a driver error out of `insertOne`, i.e. a 500 from an endpoint that
   * places orders — and a caller cannot tell that from the bridge falling over
   * mid-apply. Refused here instead, in words, having placed nothing.
   *
   * Printable ASCII with no spaces: the ids this desk actually mints are
   * `manual:TAG:mode:SYMBOL:ts`-shaped or a UUID, and a control character in
   * the middle of a correlation id is unreadable in every log that carries it.
   */
  if (!/^[\x21-\x7e]{1,128}$/.test(decisionId)) {
    send(400, {
      error:
        'decisionId must be 1-128 printable characters with no spaces — it becomes this run\'s id ' +
        'and the stem of every order id under it',
    })
    return true
  }
  /**
   * THE FINGERPRINT OF WHAT WAS CONFIRMED. Required: an apply with no print is
   * a plan pinned to nothing, and the whole point of the preview is that what
   * executes is what was read.
   */
  const drawnLegs = typeof body['legsPrint'] === 'string' ? body['legsPrint'] : ''
  if (drawnLegs === '') {
    send(400, {
      error:
        'legsPrint is required — it is the preflight answer this plan was read from, and it is ' +
        'what pins these moves to the legs they were written against',
    })
    return true
  }
  const mode: DeskMode = body['mode'] === 'live' ? 'live' : 'paper'
  /** Anything but the exact word is the marketable style — see `limitFor`. */
  const style: 'fast' | 'limit' = body['style'] === 'limit' ? 'limit' : 'fast'

  const book = await assemble(deps, tag, mode)
  if (book.error !== null) {
    send(200, { accepted: false, reason: book.error })
    return true
  }
  /**
   * THE CHEAP FIRST GATE, on the book this endpoint has just read. It refuses
   * the ordinary stale modal before the password is even asked for — and it is
   * NOT the last word, because the orders are resolved against a SECOND read
   * further down. See `resolvedPrint`.
   */
  if (bookLegsPrint(book.legs) !== drawnLegs) {
    send(409, bookChanged(tag))
    return true
  }
  /**
   * `''` FOR THE EXTRA ARG — the SAME call the preflight makes. Nothing
   * compares the two (the guard above is the comparison); they match so that
   * the run's stamp and the preview that authorised it can be JOINED
   * afterwards, and so both sit in the archive's own namespace. The other call
   * site is `answer` in the preflight above; neither should move alone.
   */
  const stampedBookPrint = bookPrint(book, 'repair', '')

  /**
   * THE PASSWORD, exactly as arming a live strategy pays it (`routes/desk.ts`).
   * Same gate object, same 403 body, same reason — and a `machine` principal
   * can never satisfy it, so no automation can place a live repair by itself.
   */
  if (mode === 'live') {
    const denied = await deps.gate.reauth(ctx.principal, body['password'])
    if (denied !== null) {
      send(403, { error: denied, reauthRequired: true })
      return true
    }
  }

  /**
   * RESOLVED AGAIN, SERVER-SIDE. The client's expansion is a display artefact:
   * trusting it would let a caller send any orders it liked under the cover of
   * a fingerprint that only vouches for the BOOK. This is also the second read
   * of the book — between the preview and here the operator read a modal — so
   * the sizes are the sizes of the legs as they stand at this instant.
   */
  const rawMoves = body['moves']
  if (!Array.isArray(rawMoves)) {
    send(200, {
      accepted: false,
      reason: 'moves was not a list of {op, …} — nothing in this request could be read as a plan',
    })
    return true
  }
  const moves = rawMoves as readonly Move[]
  const pos = await deps.service.positions(tag, mode, { realised: true })
  /**
   * THE PRINT AGAIN, OFF THE LEGS THAT ARE ABOUT TO BE RESOLVED.
   *
   * The check above compared the print against `assemble`'s read. This is a
   * DIFFERENT read of the same book, and between the two sits the password
   * gate: argon2id spends a few hundred milliseconds by design. A pocket of a
   * doubled contract removed in that window re-points a bare legId onto the
   * pocket behind it (`repair-plan.ts:legsById` is positional), and the SELL
   * the operator confirmed goes out against the survivor at its full size —
   * every screen still reading correct. The first check cannot see that,
   * because it vouched for a book nobody is trading against any more.
   *
   * Computed from `pos.legs` rather than re-running `assemble`: those ARE the
   * legs `resolveOrders` consumes one line below, and `assemble` builds its own
   * from exactly this list (`routes/payoff.ts` — same order, `qty === 0`
   * skipped, `#n` suffixes that `legsPrint` strips back off), so the two
   * spellings hash alike by construction. A second `assemble` would be a THIRD
   * read, and a third read is a third window.
   */
  const resolvedPrint = legsPrint(
    pos.legs.map((l) => ({
      tradingsymbol: l.instrument.tradingsymbol,
      qty: l.qty,
      entryPrice: l.entryPrice,
    })),
  )
  if (resolvedPrint !== drawnLegs) {
    send(409, bookChanged(tag))
    return true
  }
  const resolved = resolveOrders({
    legs: pos.legs,
    moves,
    chain: book.chain,
    lotSize: book.chain?.lotSize ?? 0,
    bookExpiry: book.expiry,
  })
  if (resolved.dropped.length > 0) {
    /**
     * ANY drop refuses the WHOLE plan. A repair is a shape — a shift is two
     * halves of one intent — so executing the part the bridge understood is
     * how a book ends up half-repaired and naked on the other half. The
     * operator finishes by hand from the sentences below.
     */
    send(200, { accepted: false, reason: resolved.dropped.join('; ') })
    return true
  }
  if (resolved.orders.length === 0) {
    send(200, {
      accepted: false,
      reason: 'this plan places nothing — there is no run to start and nothing to hold the book for',
    })
    return true
  }

  /**
   * THE DESK-WIDE HALT, BEFORE `applies.start` AND NOT INSIDE THE WAVES.
   *
   * The rail would refuse the opens one at a time — after the closes in front
   * of them had already filled. Read here, about the plan, the refusal costs
   * nothing and leaves the book exactly as it was. See the `killSwitch` block
   * above for the whole argument, including why a pure-close plan never even
   * asks the register.
   */
  const opens = resolved.orders.filter((o) => o.wave === 'open').length
  if (opens > 0) {
    const halt = await killSwitch(deps)
    const refusal =
      halt === null ? SWITCH_UNREADABLE : halt.enabled ? killSwitchRefusal(halt, opens) : null
    if (refusal !== null) {
      log('repair apply refused on the kill switch', { tag, mode, opens })
      send(200, { accepted: false, reason: refusal })
      return true
    }
  }

  const started = await applies.start({
    tag,
    mode,
    style,
    // The book AS THIS PROCESS READ IT a few lines ago, not a value the caller
    // sent. A stamp copied from the request would record what the client
    // claimed to have previewed, which is the one thing an audit field must not.
    bookPrint: stampedBookPrint,
    applyId: decisionId,
    orders: resolved.orders,
  })
  if (!started.ok) {
    send(200, { accepted: false, reason: started.reason })
    return true
  }
  /**
   * THE REPLAY MUST BE A REPLAY OF *THIS* REQUEST.
   *
   * `start` is keyed on the applyId alone — correctly, since that is the
   * idempotency key — so a decisionId that already owns a run answers `ok` with
   * THAT run, whatever this request asked for. Re-send an id from book A's
   * repair with `tag: B` and the reply is a 202 carrying A's applyId; the modal
   * then polls it, watches A's finished run go DONE, and reports B's repair as
   * a success that never happened. Nothing was placed, which is why this is a
   * refusal and not a halt — but it must be SAID, because the failure is
   * entirely in what the operator is told.
   */
  const owner = started.run
  if (owner.tag !== tag || owner.mode !== mode) {
    send(200, {
      accepted: false,
      reason:
        `decisionId '${decisionId}' already belongs to a repair of ${owner.tag} in ${owner.mode}, ` +
        `not ${tag} in ${mode} — nothing was placed. Mint a new decisionId for this plan; re-using ` +
        `one is what makes a retry safe, and re-using it across books is what makes a retry a lie.`,
    })
    return true
  }
  log('repair apply accepted', {
    tag,
    mode,
    style,
    applyId: started.run._id,
    orders: started.run.orders.length,
    state: started.run.state,
  })
  /**
   * 202, not 200: the run is DETACHED and this answer is "it has been claimed
   * and it exists", not "it is done". The modal polls the status route from
   * here, which it can do immediately — the document was written before
   * `start` returned.
   */
  send(202, { accepted: true, applyId: started.run._id })
  return true
}

// ------------------------------------------------------------------ the rail

/** How often the freeze table is re-read from Mongo. `make sync` writes it. */
const FREEZE_REFRESH_MS = 15 * 60_000

/**
 * HOW OLD A MARK MAY BE BEFORE IT MAY NOT PRICE NEW EXPOSURE.
 *
 * `DESK_MAX_OPEN_MARK_AGE_MS` — the SAME dial `main.ts` hands the Python action
 * path (`book.ts:tooStaleToOpen`, audit F-16), read here because that reader is
 * private to `main.ts`. The env name is the shared thing; a second default
 * would be a second policy, so it is the same 10 minutes.
 */
function maxOpenMarkAgeFromEnv(): number {
  const raw = process.env['DESK_MAX_OPEN_MARK_AGE_MS']
  const n = raw === undefined || raw.trim() === '' ? NaN : Number(raw)
  return Number.isFinite(n) && n > 0 ? n : 600_000
}

/**
 * IS THIS MARK TOO OLD TO OPEN AGAINST? The refusal sentence, or null.
 *
 * `book.ts:tooStaleToOpen`'s rule, transplanted onto this rail, with its
 * asymmetry intact and for its reasons: a control stops NEW exposure and never
 * blocks an exit, because trapping a position behind a safety control is worse
 * than whatever the control was protecting against. `reducesExposure` is the
 * desk's own name for that distinction and the field every other gate on this
 * path already reads — every close carries it `true` by construction
 * (`repair-plan.ts:closeOrder`), so no close can ever be stopped here.
 *
 * WHY THE REPAIR PATH NEEDS IT AT ALL, when the wave already prices off a live
 * quote. `QuoteCache.quote` refuses only on a DEAD FEED; a single contract that
 * has not printed since 09:20 answers happily at 14:00 on a feed that is ticking
 * everywhere else, and the "marketable" limit derived from it rests forever. On
 * a repair that is not one unfilled order: the close wave has ALREADY FILLED by
 * the time the opens go out, so the book sits naked on the leg that was just
 * taken off while the replacement never arrives.
 *
 * The residual, stated: an OPEN that nets DOWN an existing holding is exempt,
 * exactly as a shrinking resize is exempt there. That is the same judgement,
 * made in the same words, and it is why this reads `reducesExposure` rather
 * than the wave.
 *
 * An UNKNOWN age is not a stale age (no cache, no token, a dead feed) — and a
 * contract with no usable quote at all has already halted the wave one step
 * earlier, in `limitFor`. Asked by TOKEN, which is what `QuoteCache.markAge`
 * reduces to anyway: a `SubmitRequestBody`'s instrument is allowed to omit the
 * lot size, so it is not an `InstrumentRef` and inventing one to ask with would
 * be a fabricated contract on the order path.
 */
function tooStaleToOpen(deps: ApiDeps, req: SubmitRequestBody, maxMs: number): string | null {
  if (req.reducesExposure === true) return null
  const token = req.instrument.instrumentToken
  const age = token === undefined ? null : (deps.marks?.mark(token)?.ageMs ?? null)
  if (typeof age !== 'number' || !(age > maxMs)) return null
  return (
    `mark age: ${req.instrument.tradingsymbol}'s last usable quote is ${Math.round(age / 1000)}s ` +
    `old, past the ${Math.round(maxMs / 1000)}s this desk will price NEW exposure against ` +
    `(DESK_MAX_OPEN_MARK_AGE_MS). Refused rather than resting a "marketable" limit at a price ` +
    `nobody is showing — the closes in front of this one have already filled.`
  )
}

/** What the apply service is handed, and where its live orders end up. */
interface RepairRail {
  readonly submit: SubmitService['submit']
  /**
   * The collection the LIVE rail files its orders in, read OFF the rail rather
   * than restated — see `orderCollections` below. `repairFillState` reads it,
   * and probing the wrong one reports every live repair order as PENDING
   * forever: the wave then ages out and halts a run whose closes all filled.
   */
  readonly liveOrders: string
}

/**
 * The order rail this feature places through: `SubmitService`, built from the
 * SAME dependency bag `routes/submit.ts` builds it from.
 *
 * Copied deliberately rather than shared. The two are peers — each route module
 * owns its own construction so a feature can be built without editing a file
 * another feature is also editing — and what must not diverge is the BAG, not
 * the object: same rails, same freeze table, same marketable dials, same risk
 * caps, same journal. A repair that reached the broker through a rail with one
 * gate missing would be the one order path on this desk that is not gated like
 * every other, which is precisely the claim this feature makes.
 */
function orderRailFor(deps: ApiDeps): RepairRail {
  /**
   * `DESK_LIVE_TAGS` is the optional BOX-LEVEL PIN, not the allowlist — the
   * allowlist is the password-gated `modes.live` switch on the strategy row.
   */
  const livePin = liveTagsFromEnv()

  /**
   * The freeze table, refreshed in the background and starting EMPTY rather
   * than blocking boot on a Mongo read. Empty means `maxLotsPerOrder` answers
   * null, which `submit.ts` sends as one order and logs as unknown — the
   * honest degradation, where inventing a limit gets orders rejected by the
   * exchange.
   */
  let freeze = new FreezeLimits()
  const refreshFreeze = async (): Promise<void> => {
    try {
      freeze = await loadFreezeLimits(deps.db.collection('desk-freeze-limits'))
    } catch (err) {
      deps.log('freeze limit load failed (repair rail) — keeping the previous table', {
        error: errorMessage(err),
      })
    }
  }
  void refreshFreeze()
  const timer = setInterval(() => void refreshFreeze(), FREEZE_REFRESH_MS)
  timer.unref()

  const stream = deps.stream
  const emit: PaperFillEmit | undefined =
    stream === undefined ? undefined : (m, event) => stream.publish(m, event)
  const book = deps.book

  const rails = {
    paper: new PaperRail(deps.db, emit),
    // The SAME allowlist source `routes/submit.ts` and `main.ts` use. A third
    // spelling of "which tags may trade live" is how a tag switched ON in the
    // portal comes to be refused by one rail and accepted by another.
    live: new LiveRail(
      deps.db,
      liveAllowlistFromStrategies(deps.db.collection('desk-strategies'), livePin),
    ),
  }

  const liveOrders = LIVE_COLLECTION[rails.live.executor]
  const service = new SubmitService({
    store: deps.store,
    rails,
    master: deps.master,
    // Without a mark source every paper submit is refused rather than booked at
    // 0, which is the safe direction.
    marks: deps.marks ?? { price: () => null, spot: () => null },
    freeze: () => freeze,
    liveTags: livePin,
    // Read OFF the rails rather than restated: a replay that probed the wrong
    // collection would report a live order as never routed.
    orderCollections: { paper: COLLECTIONS.paperTrade, live: liveOrders },
    marketable: marketableFromEnv(),
    now: deps.now,
    log: deps.log,
    ...(deps.risk === undefined ? {} : { risk: deps.risk }),
    // `exactOptionalPropertyTypes`: an explicit `undefined` is not an absent key.
    ...(emit === undefined ? {} : { emit }),
    ...(book === undefined ? {} : { journal: (e: JournalEntry) => book.onJournal(e) }),
  })

  const maxOpenMarkAgeMs = maxOpenMarkAgeFromEnv()

  return {
    liveOrders,
    /**
     * Handed over as the narrow port `repair-apply.ts` declares, so that module
     * still knows nothing about rails, freeze tables or instrument masters —
     * with ONE gate of this path's own in front of it.
     *
     * It sits here rather than in `quote()` because that port is asked the same
     * question for both waves and cannot tell them apart, and blocking a CLOSE
     * on a stale mark is the one thing this control must never do. The refusal
     * is shaped as `SubmitService`'s own "a gate refused, nothing attempted"
     * answer, so the wave halts before anything is sent and the halt reason
     * carries the age.
     */
    submit: async (req) => {
      const stale = tooStaleToOpen(deps, req, maxOpenMarkAgeMs)
      if (stale === null) return await service.submit(req)
      deps.log('repair order refused on mark age', {
        clientOrderId: req.clientOrderId,
        symbol: req.instrument.tradingsymbol,
        tag: req.tag,
      })
      return {
        accepted: false,
        // DONE, not FAILED: nothing was attempted and nothing has to be
        // reconciled — the third row of `submit.ts`'s state matrix.
        status: 'DONE',
        clientOrderId: req.clientOrderId,
        reason: stale,
        replayed: false,
        routedLots: 0,
      }
    },
  }
}

/**
 * The live quote for a contract, AT SUBMIT TIME.
 *
 * Joined through the instrument master because the apply service addresses a
 * contract by NAME (it is handed a plan, not a token) while the quote cache is
 * keyed by token. A symbol the master cannot resolve answers null, and the wave
 * halts before that order is placed rather than pricing it off a guess.
 *
 * `mid` is the cache's own `price`, which IS the mid whenever the tick carried
 * two sides (`marks.ts:#effective`) and the last trade when it did not. That is
 * the desk's single definition of a mark, shared with the greeks, the paper
 * fills and the preflight's own estimates — a second one here would price the
 * Limit style off a number no other screen shows.
 *
 * THE QUOTE'S AGE IS DELIBERATELY NOT JUDGED HERE, and that is not an
 * oversight. This port is asked the same question for both waves and cannot
 * tell them apart, so an age check in it would block a CLOSE — the one thing a
 * safety control on this desk must never do. The ceiling lives one step later,
 * on the rail, where `reducesExposure` says which orders are new exposure. See
 * `tooStaleToOpen`.
 */
function liveQuoteOf(deps: ApiDeps, tradingsymbol: string): RepairQuote | null {
  const marks = deps.marks
  if (marks === undefined) return null
  const ref = deps.master.current().resolveSymbol(tradingsymbol)
  const token = ref?.instrumentToken
  if (ref === null || token === undefined) return null
  const q = marks.quote(token)
  if (q === null) return null
  return { bid: q.bid, ask: q.ask, mid: q.price, tickSize: ref.tickSize }
}

// ------------------------------------------------------------- did it trade?

type Verdict = 'PENDING' | 'FILLED' | 'FAILED'

/**
 * WHAT EACH GATEWAY ORDER STATE MEANS TO A REPAIR WAVE.
 *
 * `Record<OrderState, …>` and not a set of strings, and the type import is the
 * whole point: TypeScript refuses this literal if `apps/order-gateway`'s
 * `OrderState` gains a member, so a new terminal state BREAKS THE BUILD here
 * instead of quietly falling through to "still working" while a live run waits
 * out its age-out. A `switch` would give the same exhaustiveness but would
 * still need a second, hand-written list to narrow the string Mongo returns —
 * two lists is the drift this is guarding against.
 *
 * TYPE-ONLY, deliberately. `rail.ts` re-implements `baseClientOrderId` rather
 * than import it, because `@algomaker/api` must not take a runtime dependency
 * on the gateway app; `import type` is erased under `verbatimModuleSyntax`, so
 * this buys the shared vocabulary without the shared build.
 *
 * `PARTIAL` is the one worth arguing about: it is a REAL position of a size
 * nobody asked for (queue.ts spells this out), neither a fill nor a rejection.
 * For a repair it is a failure of the PLAN — the rest of it is sized against a
 * leg that is only partly there — so it halts the run with the ledger intact,
 * which is what the operator finishes by hand from. Calling it FILLED would
 * open the next wave against a book that does not exist.
 *
 * `HALTED` is the same answer for the same reason, one step earlier: the
 * gateway stopped a fill-gated order part-way, so some of the size the wave
 * asked for was never shown to the market at all. That is a plan failure
 * whether or not the tranches that DID go out filled.
 */
const VERDICT_OF: Readonly<Record<OrderState, Verdict>> = {
  PENDING: 'PENDING',
  CLAIMED: 'PENDING',
  PLACED: 'PENDING',
  FILLED: 'FILLED',
  PARTIAL: 'FAILED',
  HALTED: 'FAILED',
  REJECTED: 'FAILED',
  INVALID: 'FAILED',
}

/** A state this reading has never heard of is not a verdict — see PENDING below. */
function verdictOf(raw: string): Verdict {
  return Object.hasOwn(VERDICT_OF, raw) ? VERDICT_OF[raw as OrderState] : 'PENDING'
}

/**
 * DID THIS ORDER ACTUALLY TRADE? — the injected half of `RepairApplyService`.
 *
 * PAPER IS FILLED THE MOMENT IT IS ACCEPTED. `PaperRail.route` writes the fill
 * inside `submit`, synchronously, so by the time the caller holds an
 * `accepted: true, status: 'DONE'` response the book has already moved. There
 * is no later truth to wait for: the paperstream's price-stamp is a display
 * correction, not a settlement. Waiting anyway would stall every paper repair
 * for a fill that already happened.
 *
 * LIVE IS READ BACK OFF `desk-gateway-orders`, THE ONLY WITNESS. One desk order
 * becomes SEVERAL documents there whenever the exchange freeze limit splits it
 * — `submit-plan.ts:planTranches` writes `<id>#0`, `<id>#1`, … and `LiveRail`
 * files one document per tranche. The GATEWAY then splits again on its own side
 * (`gateway.ts:planOrder` — `<id>.1`, `<id>.2`, …); those are BROKER intents
 * and live inside the desk document's `trancheIds`, not as rows of their own,
 * but the filter matches them anyway. Reading the convention rather than
 * today's writer is what keeps this correct if the two ever swap places, and
 * costs one alternation. The verdict is folded to ONE per order either way,
 * because a repair's wave gate is about the ORDER: half a close is not a close.
 *
 * THE THREE ANSWERS, and why the defaults lean the way they do:
 *   FILLED   every document says FILLED. Nothing less.
 *   FAILED   any document is terminal without a full fill — see below.
 *   PENDING  everything else: still working (PENDING/CLAIMED/PLACED), no
 *            documents at all, a state this reading does not recognise, or a
 *            store that will not answer. Never FILLED on silence — that opens
 *            the next wave against a leg that may still be live at the broker —
 *            and never FAILED on it either, since a Mongo blip is not a
 *            rejection. The wave's own age-out ends a run that stays here.
 */
export function repairFillState(
  deps: Pick<ApiDeps, 'db' | 'log'>,
  /**
   * WHERE THE LIVE RAIL FILES ITS ORDERS, passed in rather than named here.
   *
   * It is `LIVE_COLLECTION[rail.executor]` — the rail's own choice — for the
   * reason `orderCollections` is read off the rail in `submit.ts`: a
   * legacy-executor box writes `positional`, and a reader hardcoded to
   * `desk-gateway-orders` would find nothing, answer PENDING forever, and halt
   * every live repair at its wave age-out with all of its closes already filled.
   */
  liveOrders: string,
): (mode: DeskMode, clientOrderId: string) => Promise<Verdict> {
  return async (mode, clientOrderId) => {
    if (mode === 'paper') return 'FILLED'
    let docs: { readonly state?: unknown }[]
    try {
      docs = await deps.db
        .collection<{ readonly state?: unknown }>(liveOrders)
        .find(tranchesOf(clientOrderId))
        .toArray()
    } catch (err: unknown) {
      deps.log('the gateway order register could not be read — the fill stays unknown', {
        clientOrderId,
        collection: liveOrders,
        error: errorMessage(err),
      })
      return 'PENDING'
    }
    if (docs.length === 0) return 'PENDING'
    const verdicts = docs.map((d) => verdictOf(String(d.state ?? '')))
    if (verdicts.includes('FAILED')) return 'FAILED'
    return verdicts.every((v) => v === 'FILLED') ? 'FILLED' : 'PENDING'
  }
}

/**
 * The filter matching an order and EVERY tranche of it, and nothing else.
 *
 * Anchored, and anchored ON THE SEPARATOR: `repair:x:0` and `repair:x:01` are
 * two different orders that share a prefix, and a bare `^repair:x:0` would fold
 * the second one's rejection into the first one's verdict. The anchored regex
 * is served by the collection's own unique index on `clientOrderId`.
 */
function tranchesOf(clientOrderId: string): Record<string, unknown> {
  const escaped = clientOrderId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return {
    $or: [{ clientOrderId }, { clientOrderId: { $regex: `^${escaped}[.#]` } }],
  }
}

// ------------------------------------------------------------------- the hold

/**
 * Does a repair still own this tag?
 *
 * ASKED THROUGH `repairHoldLookup`, which is the apply service's OWN definition
 * of a hold exported as a function of the database — a run inside its TTL, and
 * for a run that has ENDED, the adoption grace past its last write. A
 * hand-written `findOne({tag, state: 'RUNNING'})` here would agree with it today
 * and disagree the first time either end of that rule moves, and disagreeing
 * means a button that is enabled while the server refuses.
 *
 * IT IS THE SUPERVISOR'S QUESTION, NOT THE CLAIM'S, and during the grace those
 * two genuinely differ: `start` would accept the next plan while this still
 * reads held. Held is the direction to be wrong in — a false hold costs a
 * retry — and one shared definition is worth more here than a second predicate
 * that tracks the claim exactly and drifts from the hold silently.
 *
 * AN UNREADABLE REGISTER HOLDS THE BUTTON. The alternative — reporting `false`
 * because the read failed — opens Apply on a tag whose run state is unknown,
 * which is the one direction this answer must never be wrong in: a false hold
 * costs a retry, a false clearance costs a second set of orders on a book that
 * is already mid-repair. `RepairApplyService.start` re-checks server-side
 * anyway, so the button is the outer of two gates, not the only one.
 */
async function activeHold(
  deps: ApiDeps,
  tag: string,
): Promise<{ readonly active: boolean; readonly warnings: readonly string[] }> {
  try {
    return { active: (await repairHoldLookup(deps.db, deps.now)(tag)) !== null, warnings: [] }
  } catch (err: unknown) {
    deps.log('the repair hold register could not be read', {
      tag,
      error: err instanceof Error ? err.message : String(err),
    })
    return {
      active: true,
      warnings: [
        'the register of running repairs could not be read, so this answer cannot vouch that no apply is ' +
          'already in flight on this book — Apply is held rather than opened on a guess',
      ],
    }
  }
}

// ------------------------------------------------------------------- the join

/**
 * The chain's quote for a planned order, or null.
 *
 * MATCHED ON THE CONTRACT'S NAME, not on the strike alone. A rolled-in leg
 * legitimately sits on another expiry, and that expiry's 420CE and this one's
 * share a strike and a side — pricing the first off the second is a silent
 * mis-estimate on the one screen an order is placed from. The chain covers the
 * BOOK's expiry, so a foreign-expiry leg simply has no quote here, which is the
 * true answer.
 */
function quoteFor(chain: ChainResponse | null, order: PlannedOrder): ChainQuote | null {
  const row = chain?.rows.find((r) => r.strike === order.strike)
  if (row === undefined) return null
  const q = order.type === 'CE' ? row.CE : row.PE
  const ref = order.type === 'CE' ? row.ceContract : row.peContract
  if (q === null || ref?.tradingsymbol !== order.instrument.tradingsymbol) return null
  return q
}

// ------------------------------------------------------- the delta hypothesis

/**
 * `bookGreeks` options exactly as `service.ts:1394` builds them — BLACK-76 VIA
 * THE CARRY, so this panel and the Positions tiles price off the same forward.
 *
 * The rate is `DEFAULT_RATE` rather than a literal 0.065: it is the same number
 * that file spells out, and one of the two moving without the other is how the
 * "now" column comes to disagree with the tile it is read against.
 */
function greekOptsFor(book: Assembled, pos: PositionsResponse): DeltaGreekOpts {
  const carry =
    pos.spot !== null && book.future !== null && book.tYears > 0
      ? carryYield(pos.spot, book.future, book.tYears, DEFAULT_RATE)
      : null
  return { rate: DEFAULT_RATE, ...(carry === null ? {} : { dividendYield: carry }) }
}

/**
 * The book's own reference vol for the model pass: the median of the IVs that
 * DID solve.
 *
 * REPRODUCED FROM `service.ts:163` (`medianSolvedIv`), which is private to that
 * module. Median, not mean — one crazy wing quote must not drag the vol every
 * modelled leg is priced at. Null when nothing solved, in which case there is no
 * defensible reference and nothing gets modelled. If that rule ever changes
 * there, it must change here: the whole point of this panel is that its "now"
 * column IS the Positions tile.
 */
function medianSolvedIv(legs: readonly LegGreeks[]): number | null {
  const ivs = legs
    .map((l) => l.iv)
    .filter((v): v is number => v !== null)
    .sort((a, b) => a - b)
  const mid = ivs[Math.floor((ivs.length - 1) / 2)]
  const midHi = ivs[Math.ceil((ivs.length - 1) / 2)]
  if (mid === undefined || midHi === undefined) return null
  return (mid + midHi) / 2
}

/**
 * THE MODEL PASS, and why this panel cannot skip it.
 *
 * `deltaPictures` calls `bookGreeks` once per figure with whatever options it is
 * handed, and a leg whose own quote admits no IV simply falls out of that call's
 * totals. The Positions engine does NOT leave it there: it re-runs the whole
 * book at the median solved IV (`service.ts:1399-1412`) and carries the leg as a
 * named estimate. A deep-ITM stock option lives in exactly that state routinely
 * — it prices off the future, so its LTP sits below the cash-spot no-arbitrage
 * floor and no vol solves it — so a panel without this pass would report a
 * different netΔ from the tile beside it, on the books whose wings hurt most.
 *
 * DECIDED ON THE CURRENT BOOK AND APPLIED TO BOTH COLUMNS. A before/after that
 * priced its two halves under different models would compare two things, and
 * the difference between them would be partly the model.
 *
 * One honest divergence from `service.ts`: its median is taken over the legs
 * that solved from their MARKET marks, while a leg it had already modelled
 * reaches here at the model price and so solves on the first pass. On a book
 * with quote-less legs the two medians can differ in the last digits. Both are
 * the same rule over the same evidence; neither is a second opinion.
 */
function modelPass(
  base: DeltaGreekOpts,
  current: readonly PositionLeg[],
  nowMs: number,
): {
  readonly opts: DeltaGreekOpts
  /** Legs the fallback vol rescued — estimates, and the panel says so. */
  readonly modelled: readonly string[]
  /** Legs nothing could price at all. Out of both columns. */
  readonly dropped: readonly string[]
} {
  const first = bookGreeks(current, nowMs, base)
  if (first.unpriced.length === 0) return { opts: base, modelled: [], dropped: [] }
  const ref = medianSolvedIv(first.legs)
  if (ref === null) return { opts: base, modelled: [], dropped: first.unpriced }
  return { opts: { ...base, fallbackVol: ref }, modelled: first.unpriced, dropped: [] }
}

/**
 * The book as the Positions page holds it, in the shape `bookGreeks` takes.
 *
 * The MARK is `greeks.legs[].price` — the model price at the vol that was solved
 * out of the market mark, which round-trips back to the same vol and therefore
 * to the same greeks. Taking it from there rather than re-reading the quote
 * cache is what makes this a re-computation of the tile rather than a second
 * opinion about it: one read of `positions()` supplies both columns.
 *
 * Strike, type and expiry come from `pos.legs`, joined by tradingsymbol — a
 * contract's strike cannot differ between two pockets of it, so the join is
 * safe even on a book holding one contract twice, and the QTY is taken from the
 * greeks leg, which is per-pocket.
 */
function currentLegs(pos: PositionsResponse): readonly PositionLeg[] {
  const spot = pos.spot
  if (spot === null) return []
  const meta = new Map(pos.legs.map((l) => [l.instrument.tradingsymbol, l]))
  const out: PositionLeg[] = []
  for (const g of pos.greeks.legs) {
    const m = meta.get(g.tradingsymbol)
    if (m === undefined || g.qty === 0) continue
    out.push({
      tradingsymbol: g.tradingsymbol,
      underlying: m.underlying,
      strike: m.strike,
      type: m.type,
      expiry: m.expiry,
      qty: g.qty,
      spot,
      markPrice: g.price,
    })
  }
  return out
}

/**
 * The hypothetical book: closes taken off, opens put on at the chain's mid.
 *
 * A CLOSE IS MATCHED TO A POCKET, not to a contract. A book may legally hold one
 * contract on two legs — a long pocket and a short one — and `resolveOrders`
 * emits one close per leg it was asked to take off. Consuming a pocket per order
 * (and preferring the one the order EXACTLY flattens) is what keeps a plan that
 * closes one of two pockets from flattening both here and understating the
 * delta the operator would be left carrying.
 *
 * A close never flips a leg through zero. `resolveOrders` only ever emits a
 * leg's full size, so the clamp is unreachable on today's inputs; it is here so
 * that a future partial close is wrong in the safe direction rather than
 * inventing exposure on the other side.
 */
function foldPlan(
  current: readonly PositionLeg[],
  orders: readonly PlannedOrder[],
  underlying: string,
  spot: number,
  markOf: (order: PlannedOrder) => number | null,
): { readonly legs: readonly PositionLeg[]; readonly unmarkable: readonly string[] } {
  const legs: PositionLeg[] = current.map((l) => ({ ...l }))
  const taken = new Set<number>()
  const unmarkable: string[] = []

  for (const o of orders) {
    if (o.wave !== 'close') continue
    const name = o.instrument.tradingsymbol
    const signed = (o.side === 'Buy' ? 1 : -1) * o.lots * o.instrument.lotSize
    const free = (l: PositionLeg, i: number): boolean => !taken.has(i) && l.tradingsymbol === name
    let i = legs.findIndex((l, idx) => free(l, idx) && l.qty + signed === 0)
    if (i < 0) i = legs.findIndex((l, idx) => free(l, idx) && Math.sign(l.qty) === -Math.sign(signed))
    const held = i < 0 ? undefined : legs[i]
    if (held === undefined) continue
    taken.add(i)
    const next = held.qty + signed
    legs[i] = { ...held, qty: Math.sign(next) === Math.sign(held.qty) ? next : 0 }
  }

  for (const o of orders) {
    if (o.wave !== 'open') continue
    const mark = markOf(o)
    if (mark === null || !(mark > 0)) {
      unmarkable.push(o.instrument.tradingsymbol)
      continue
    }
    legs.push({
      tradingsymbol: o.instrument.tradingsymbol,
      underlying,
      strike: o.strike,
      type: o.type,
      expiry: o.expiry,
      qty: (o.side === 'Buy' ? 1 : -1) * o.lots * o.instrument.lotSize,
      spot,
      markPrice: mark,
    })
  }

  /**
   * A FLATTENED POCKET IS NOT A LEG. Carried as a zero it would leave the two
   * rows of one panel disagreeing about whether the book still exists —
   * `bookGreeks` prices a zero-qty leg quite happily (contributing nothing)
   * while the shorts-only filter drops it, so "all legs" would read 0 and
   * "shorts only" would read nothing-priced for the same hypothetical.
   *
   * The cost, stated: a plan that closes EVERYTHING leaves an empty set, and
   * `deltaPictures` reports an empty set as nothing-priced rather than as a
   * flat book. That errs towards "unknown" instead of towards "flat, no action
   * needed", which is the safe direction on a delta panel, and the orders list
   * beside it already says in words that the plan is a flatten.
   */
  return { legs: legs.filter((l) => l.qty !== 0), unmarkable }
}

/** Both columns, priced from nothing — the shape a bookless answer still owes. */
function emptyDelta(nowMs: number): { readonly current: DeltaPicture; readonly after: DeltaPicture } {
  return deltaPictures({ current: [], after: [], spot: null, nowMs, greekOpts: { rate: DEFAULT_RATE } })
}

// ----------------------------------------------------------------- odds and ends

function quoted(names: readonly string[]): string {
  return [...new Set(names)].map((n) => `"${n}"`).join(', ')
}
