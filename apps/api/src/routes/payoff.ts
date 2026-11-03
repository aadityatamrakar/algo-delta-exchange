/**
 * THE PAYOFF COCKPIT — what a book is worth, what the bot is about to do about
 * it, and what a human could do instead.
 *
 * Four endpoints, one assembly:
 *
 *   GET  /v1/desk/payoff          the curves, the table, the machine card
 *   POST /v1/desk/payoff/whatif   the same, with a proposed leg — or a whole
 *                                 repair plan's `moves` — folded in
 *   GET  /v1/desk/repair          four goals, ranked plans, and the do-nothing
 *                                 baseline every one of them is scored against
 *   POST /v1/desk/repair/verify-margin
 *                                 what the BROKER would hold against a plan,
 *                                 beside this desk's own SPAN-lite estimate.
 *                                 The dashboard no longer has a button for it —
 *                                 `/repair/preflight` runs the same check as
 *                                 part of its answer, against the book as it
 *                                 stands, beside the orders it would place —
 *                                 but the route stays: it is the one way to ask
 *                                 the question without opening an apply modal.
 *
 * NOTHING HERE DECIDES ANYTHING AND NOTHING IN THIS FILE PLACES AN ORDER —
 * every route above is a GET or a pure calculation over a POSTed hypothetical,
 * and there is no rail, no gate and no `service.applyActions` in it to reach.
 *
 * THAT IS NOW A FACT ABOUT THIS FILE, NOT ABOUT THE MENU. A plan served here
 * CAN be placed, and the path it takes is `routes/repair.ts` — deliberately a
 * separate module, so that the thing which reads a book and the thing which
 * trades one are never the same handler. The gates live along that path, in
 * this order: PREFLIGHT (`POST /repair/preflight` — resolves the moves against
 * the book as it stands and answers what WOULD be placed, writing nothing),
 * then the dashboard's confirm modal, which renders every order and refuses on
 * any dropped move, then the OPERATOR'S PASSWORD on a live book (the same
 * re-auth arming a live strategy pays), and finally `SubmitService` — the same
 * instance every manual order and every hosted strategy submits through, with
 * its own journal behind it. What reaches this module from all of that is
 * nothing: the run re-resolves its own orders and never trusts a client's.
 *
 * THE ONE OUTBOUND CALL FROM HERE, and why it does not weaken that.
 * `verify-margin` POSTs a leg list to desk-marketdata's
 * `/v1/md/margin-basket`, which prices it against Kite's basket CALCULATOR.
 * That endpoint quotes orders; it cannot place them, and this process still
 * holds no broker session of its own — which is the reason the call is a proxy
 * rather than a Kite call from here: the enctoken lives only in
 * desk-marketdata's memory, and a second IJ0574 login invalidates the first
 * (the 2026-08-04 feed outage).
 *
 * ── WHERE EACH NUMBER COMES FROM, AND WHY THAT SOURCE ───────────────────────
 *
 *   LEGS      `service.positions(tag, mode, {realised: true})` — the same call
 *             the book page draws its table from, so the cockpit cannot show a
 *             different position from the page it is opened out of. `qty` is
 *             already SIGNED SHARES, which is exactly `PayoffLeg.qty`.
 *   FUTURE    `ChainResponse.future`. Options are marked BLACK-76 off the
 *             traded future, never Black-Scholes on cash spot — the market's own
 *             arithmetic settled that on TCS 2440PE (2026-08-17), where the put
 *             admitted no vol at all against spot and solved at 26.4% against
 *             the future. `@algomaker/payoff` prices the same way throughout.
 *   VOL       solved off the WHOLE CHAIN (`solveChainIvs`) and stamped per leg
 *             (`ivFor`), sticky-strike. A book's legs are two strikes out of
 *             forty and the ones that hurt are the wings, whose own last trade
 *             is the least trustworthy quote on the board; the neighbours are
 *             evidence. Where a leg's vol was REBUILT rather than measured, the
 *             response says so — `ivFor` returns a bare number and cannot,
 *             which is why `SolvedIv.source` is consulted here.
 *   REALISED  `positions().realised`. `null` is NOT zero: a book whose banked
 *             P&L cannot be vouched for is drawn as if nothing were banked AND
 *             says `realised unknown`, because the alternative is a breakeven
 *             line drawn tens of thousands of rupees from where it belongs.
 *   DIALS     the registry row's dials over the variant catalogue's defaults —
 *             the same merge the Books page does. An absent key then means the
 *             playbook really does not declare it.
 *   MARGIN    `desk-book-margin` through `book-margin.ts`, which is the SAME
 *             figure the per-book margin tile renders. Two definitions of
 *             "margin used" on one screen is the defect this desk keeps
 *             re-finding; there is one, and both readers import it.
 *
 * ── FAIL-SOFT, AND WHAT EACH REFUSAL LOOKS LIKE ─────────────────────────────
 *
 * A missing `tag` is a 400: there is no "all books" payoff, and picking one
 * would label another strategy's curve with the wrong name. Everything else
 * that can go wrong is a 200 that SAYS what went wrong — no book, no future, no
 * chain, no vol on a leg — because these panels sit beside a live position and
 * a 500 on the chain would blank the machine card, which needs no chain at all.
 * `view: null` with a warning is a state to render. A blank chart is not.
 *
 * ── AND EVERY SUCCESSFUL GET IS ARCHIVED ────────────────────────────────────
 *
 * Into `desk-payoff-snapshots`, fire-and-forget: what the cockpit showed at
 * 14:32 is the only way to answer "what did it look like when I decided" the
 * next morning, and a reader must never wait on — or fail because of — the
 * archive. `onSnapshot` hands the in-flight write to a caller that wants to
 * await it, which is how the suite asserts on a landed document rather than on
 * a race.
 *
 * AN UNCHANGED ANSWER IS NOT ARCHIVED TWICE. A payoff document is ~30KB (121
 * curve points, the table, a whole chain's solved vols) and a dashboard polls;
 * an IDLE book — out of hours, or a name that has not printed in ten minutes —
 * would otherwise file the same picture every five seconds, 43-86MB a day per
 * book, on a box whose Mongo is pinned to a kernel and whose disk filling stops
 * the desk. So the last archived answer's fingerprint is held per
 * (tag, mode, kind) and an identical one is skipped.
 *
 * WHAT "IDENTICAL" MEANS, precisely, because a byte compare of the payload
 * would never fire: the fingerprint is taken over the answer's INPUTS — the
 * legs as held, the chain's quoted prices, the future, the dials, the margin,
 * the valuation date — every one of which is a feed value or a stored one, and
 * none of which moves on its own. The response is a deterministic function of
 * those plus the clock, so this compares the book and the market and ignores
 * the passage of time exactly. See `bookPrint` for what hashing the payload
 * costs instead, measured.
 *
 * THIS IS A DAMPER, NOT RETENTION. Nothing prunes the collection yet; a book
 * that is genuinely moving still files every poll it changes on. A TTL index is
 * the real fix and it needs `expireAfterSeconds` on the `Collection` port,
 * which is a port change deliberately not made here. Until it lands, this is
 * still the collection to watch.
 */

import { createHash } from 'node:crypto'
import { fixedClock, isMarketOpen } from '@algomaker/core'
import {
  b76Greeks,
  yearsToExpiry,
  type OptionType,
} from '@algomaker/greeks'
import {
  DEFAULT_RATE,
  DEFAULT_REPAIR_DIALS,
  atomicMoves,
  applyMoves,
  buildPayoffView,
  ivFor,
  reliefTriggers,
  searchRepairs,
  solveChainIvs,
  spanLiteMargin,
  type ChainQuoteLite,
  type Goal,
  type Move,
  type PayoffLeg,
  type PayoffView,
  type ReliefTriggers,
  type RepairDials,
  type RepairPlan,
  type SolvedIv,
  type StrikeInfo,
} from '@algomaker/payoff'
import { buildChain, type ChainResponse } from '../chain.ts'
import { bookLegsPrint } from '../repair-plan.ts'
import { BOOK_MARGIN_STALE_MS, brokerCalibration, brokerFigures } from '../book-margin.ts'
import { COLLECTIONS } from '../store.ts'
import type { DeskMode } from '../contract.ts'
import type { DialValue } from '../books-registry.ts'
import type { ApiDeps, Route, RouteCtx } from './kit.ts'
import { isObject, istDate, modeOf } from './kit.ts'

// ------------------------------------------------------------ the wire shapes

/**
 * The payoff answer. The web and the CLI are built against these names, so they
 * are not free to change; `view` and `machine` are independently nullable
 * because they fail independently (no chain kills the first and not the second).
 */
export interface PayoffResponse {
  readonly tag: string
  readonly mode: DeskMode
  readonly symbol: string
  readonly expiry: string
  readonly future: number | null
  readonly spot: number | null
  readonly asOf: number
  readonly view: PayoffView | null
  readonly machine: ReliefTriggers | null
  readonly ivs: readonly SolvedIv[]
  readonly warnings: readonly string[]
  /**
   * Market closed — everything above is display marks, the last session's.
   * The clock-noise warnings (feed silent, greeks/margin aged since the bell)
   * are deliberately NOT in `warnings` when this is set; the panel header
   * carries the one sentence instead.
   */
  readonly marketClosed: boolean
  /** Set ONLY when there is no such book. Absent on every other answer. */
  readonly error?: string
}

export interface RepairResponse {
  readonly tag: string
  readonly mode: DeskMode
  readonly asOf: number
  readonly dials: RepairDials
  readonly goals: readonly { readonly goal: Goal; readonly plans: readonly RepairPlan[] }[]
  /**
   * How big the search's alphabet was, so a menu that came back thin can be
   * told from one that came back thin BECAUSE the chain was.
   *
   * `atomic` is the number of single moves the dials allowed on this chain;
   * `evaluated` is the number of (strike, side) rows that were quotable at all.
   */
  readonly universe: { readonly atomic: number; readonly evaluated: number }
  /**
   * THE LEGS THESE PLANS ADDRESS, FINGERPRINTED — `repair-plan.ts:legsPrint`.
   *
   * Every plan below names its legs by an id that is POSITIONAL, and this menu
   * is read for minutes: a book that loses one pocket of a doubled contract in
   * that window re-points `…CE#2` at a leg the card was never about. Carried
   * back on `/v1/desk/repair/preflight`, which refuses every legId-addressed
   * move when it no longer matches the book it recomputes.
   *
   * NOT `bookPrint`. That one moves with every quote — correct between a
   * preview and the orders it authorises, useless in front of a menu nobody
   * would ever click in time. This moves when the LEGS move and not otherwise.
   */
  readonly legsPrint: string
  readonly warnings: readonly string[]
  readonly error?: string
}

export interface WhatIfResponse {
  /** The book as it stands. `null` when it could not be priced at all. */
  readonly current: PayoffView['summary'] | null
  /**
   * THE SENTENCES ABOUT THIS REQUEST AND NOTHING ELSE — one per proposal that
   * could not be read plus one per move `applyMoves` refused, verbatim and
   * UNDEDUPED so a caller can count them against what it sent. They also ride
   * inside `combined.warnings` for display, but there they are folded into the
   * book-level envelope, and a client that separates the two by set-difference
   * against a stale envelope misattributes any book-level warning that appeared
   * between two polls to the plan being loaded.
   */
  readonly dropped: readonly string[]
  readonly combined: PayoffResponse
}

/** One proposed contract: SIGNED shares, negative to sell. */
interface Proposed {
  readonly strike: number
  readonly type: OptionType
  readonly qty: number
  /** Fill assumption. Absent means the chain's own mark. */
  readonly price?: number
}

export interface PayoffRouteOptions {
  /**
   * Handed every snapshot write the moment it starts, for a caller that wants
   * to await it. Production leaves it unset and the write is fire-and-forget —
   * see the header.
   */
  readonly onSnapshot?: (write: Promise<void>) => void
  /**
   * Where `verify-margin` asks the broker. Absent, it is read from the
   * environment (`marginProxyFromEnv`); the suite injects a `fetch` here so no
   * test opens a socket.
   */
  readonly margin?: MarginProxyConfig
}

/**
 * What the broker holds — THE SAME FOUR FIELDS THE PER-BOOK MARGIN TILE READS,
 * computed by the same function (`brokerFigures`).
 *
 * `total` is `span + exposure + premiumPaid`, at the account's calibrated
 * rates. It is NOT Zerodha's calculator headline, which is `span + exposure`:
 * the broker blocks the long legs' premium as margin as well, and the XTS
 * account's `MarginUsed` matches the three-term sum to the paisa (2026-08-04).
 * Serving the calculator's figure would put a SMALLER number on the verify
 * panel than the tile shows for the same book, on exactly the books that hold
 * a long leg — and an operator reads a smaller margin as headroom.
 *
 * The components ride along so nothing is hidden behind the sum.
 */
export interface BrokerMargin {
  readonly total: number
  readonly span: number
  readonly exposure: number
  /** Premium DEBITED for the long legs. Zero on an all-short book. */
  readonly premiumPaid: number
  /**
   * WHETHER THE ACCOUNT'S OWN RATES WERE APPLIED, and the panel says which.
   *
   * `brokerCalibration` returns null whenever it cannot derive the multipliers
   * honestly — no broker snapshot, no funds on it, a book not yet priced, a
   * ratio outside its sanity bounds — and `brokerFigures` is then the IDENTITY,
   * i.e. Zerodha's own rates in the account's shape. The figures are the same
   * four fields either way, so nothing downstream can tell the two apart from
   * the numbers; a screen that claims "calibrated" over an uncalibrated figure
   * is claiming a x1.05 that was never applied.
   */
  readonly calibrated: boolean
}

export interface VerifyMarginResponse {
  /**
   * SPAN-lite over the COMBINED book, in rupees. Always present, even when the
   * broker could not be asked — a verify panel that blanks on a Kite hiccup is
   * a panel nobody trusts twice.
   */
  readonly estimated: number
  /** The broker's own figure, or null with a warning saying why not. */
  readonly broker: BrokerMargin | null
  readonly warnings: readonly string[]
}

export interface MarginProxyConfig {
  /** desk-marketdata's base URL. Empty disables the call and says so. */
  readonly url: string
  /** `DESK_API_TOKEN` — the same machine principal `/v1/md/history` wants. */
  readonly token: string
  /** Injected by the suite. Defaults to the global `fetch`. */
  readonly fetch?: typeof globalThis.fetch
  readonly timeoutMs?: number
}

/**
 * Where desk-marketdata is, from the environment.
 *
 * `DESK_MD_URL`, defaulting to the port `ecosystem.desk.config.cjs` starts it
 * on. Same shape as `machineTokenFromEnv` and `liveTagsFromEnv`: a function
 * taking `env`, so a test never has to write to `process.env`.
 */
export function marginProxyFromEnv(env: NodeJS.ProcessEnv = process.env): MarginProxyConfig {
  return {
    url: (env['DESK_MD_URL'] ?? 'http://127.0.0.1:8892').trim(),
    token: env['DESK_API_TOKEN'] ?? '',
  }
}

/**
 * The goal order the menu is rendered in. It mirrors `goals.ts`'s own `GOALS`,
 * but the order actually SERVED is taken from the engine's output below — this
 * list only guarantees that a goal the engine returned nothing for still
 * appears, empty, instead of vanishing from the menu.
 */
const ALL_GOALS: readonly Goal[] = [
  'REDUCE-LOSS',
  'PROFITABLE-BY-EXPIRY',
  'CHEAP-TAIL-CAP',
  'MAX-CREDIT-SAFE',
]

// ------------------------------------------------------------------- the routes

export function payoffRoutes(deps: ApiDeps, opts: PayoffRouteOptions = {}): Route {
  /**
   * The last answer archived for each (tag, mode, kind) — see the header.
   *
   * IN MEMORY IS ENOUGH because this process is the only writer, and the cost of
   * being wrong is one duplicate document after a restart, not a lost one. It
   * cannot grow without bound either: a key is only created on the archive path,
   * which needs a book that really exists, so a caller cannot inflate it by
   * asking for made-up tags.
   */
  const lastArchived = new Map<string, string>()

  /** Read ONCE per process, like every other env-derived config in this app. */
  const margin = opts.margin ?? marginProxyFromEnv()

  /**
   * Archive what was served, unless it is what was already archived. NEVER
   * awaited by a handler and never able to fail one: losing a snapshot is a lost
   * audit line, and failing the request that produced it would trade the
   * operator's answer for the archive of it.
   */
  const snapshot = (
    tag: string,
    mode: DeskMode,
    kind: 'payoff' | 'repair',
    /** The payload's OWN `asOf`, never a second clock read: a row filed under a
     *  different instant from the answer inside it cannot be lined up against
     *  anything else that happened at that instant. */
    ts: number,
    /** `bookPrint` of what this answer was built from — see there. */
    print: string,
    payload: unknown,
  ): void => {
    const key = `${tag}|${mode}|${kind}`
    if (lastArchived.get(key) === print) return
    // Recorded BEFORE the insert so a burst of polls inside one write's latency
    // files one document, and dropped again if that write fails — otherwise a
    // failed insert would suppress every identical answer after it and the
    // archive would silently lose the state altogether.
    lastArchived.set(key, print)
    const write = deps.db
      .collection(COLLECTIONS.payoffSnapshots)
      .insertOne({ tag, mode, ts, kind, payload })
      .then(() => undefined)
      .catch((err: unknown) => {
        // COMPARE AND DELETE. A slow insert can fail AFTER a later, faster one
        // has already succeeded and recorded its own answer; deleting blindly
        // would throw away the newer record and re-file a duplicate of it. Only
        // the print this write was for is withdrawn.
        if (lastArchived.get(key) === print) lastArchived.delete(key)
        deps.log('payoff snapshot could not be archived', {
          tag,
          kind,
          error: err instanceof Error ? err.message : String(err),
        })
      })
    opts.onSnapshot?.(write)
  }

  return async (ctx: RouteCtx): Promise<boolean> => {
    const { path, method, url, send } = ctx

    if (path === '/v1/desk/payoff' && method === 'GET') {
      const tag = url.searchParams.get('tag') ?? ''
      if (tag === '') {
        send(400, { error: 'tag is required' })
        return true
      }
      const mode = modeOf(url)
      const book = await assemble(deps, tag, mode)
      const body = payoffOf(book)
      if (book.error === null) snapshot(tag, mode, 'payoff', body.asOf, bookPrint(book, 'payoff', ''), body)
      send(200, body)
      return true
    }

    if (path === '/v1/desk/payoff/whatif' && method === 'POST') {
      const raw = await ctx.readJson()
      const body = isObject(raw) ? raw : {}
      const tag = typeof body['tag'] === 'string' ? body['tag'] : ''
      if (tag === '') {
        send(400, { error: 'tag is required' })
        return true
      }
      /**
       * TWO VOCABULARIES, AND A CALLER MAY USE EITHER.
       *
       * `proposed` is CONTRACTS — `{strike, type, qty}` — which is everything a
       * leg editor can say and strictly less than a repair plan can. It has no
       * way to take a leg OFF, so a plan of pure closes used to translate to an
       * EMPTY proposal: the panel drew the unchanged book under the label "if
       * placed" and the operator read "this repair changes nothing" about a
       * flatten. That is the one reading a repair menu must never produce.
       *
       * `moves` is the repairer's own language — `close` and `shift` included —
       * and it is applied by the same `applyMoves`, against the same
       * one-snapshot chain lookups, that SCORED the plan. So the curve that
       * comes back is the plan, rather than a strictly riskier subset of it.
       *
       * PRESENT-AND-UNREADABLE IS A 400 — FOR EITHER FIELD, INDEPENDENTLY. A
       * request may carry both, and a `proposed` that cannot be read must not
       * ride to a 200 on the back of a well-formed `moves`: coercing it to []
       * would silently drop legs the caller believes are in the curve. Absent
       * is not present; a caller that sends only `proposed` is the old request
       * and stays legal, and at least one of the two must be there.
       */
      const rawMoves = body['moves']
      if (rawMoves !== undefined && !Array.isArray(rawMoves)) {
        send(400, { error: 'moves must be an array of {op, ...} — see the repair menu' })
        return true
      }
      const rawProposed = body['proposed']
      if (rawProposed !== undefined && !Array.isArray(rawProposed)) {
        send(400, { error: 'proposed must be an array of {strike, type, qty, price?}' })
        return true
      }
      if (rawMoves === undefined && rawProposed === undefined) {
        send(400, { error: 'proposed must be an array of {strike, type, qty, price?}' })
        return true
      }
      const mode = body['mode'] === 'live' ? 'live' : 'paper'
      send(200, whatIf(
        await assemble(deps, tag, mode),
        Array.isArray(rawProposed) ? rawProposed : [],
        Array.isArray(rawMoves) ? rawMoves : [],
      ))
      return true
    }

    if (path === '/v1/desk/repair/verify-margin' && method === 'POST') {
      const raw = await ctx.readJson()
      const body = isObject(raw) ? raw : {}
      const tag = typeof body['tag'] === 'string' ? body['tag'] : ''
      if (tag === '') {
        // The only 400 on this route, and the same one the other three carry:
        // there is no all-books margin, and picking a book would price a
        // different strategy's risk under this one's name.
        send(400, { error: 'tag is required' })
        return true
      }
      if (!Array.isArray(body['moves'])) {
        send(400, { error: 'moves must be an array of {op, ...} — see the repair menu' })
        return true
      }
      const mode = body['mode'] === 'live' ? 'live' : 'paper'
      const book = await assemble(deps, tag, mode)
      send(200, await verifyMargin(deps, book, body['moves'], margin))
      return true
    }

    if (path === '/v1/desk/repair' && method === 'GET') {
      const tag = url.searchParams.get('tag') ?? ''
      if (tag === '') {
        send(400, { error: 'tag is required' })
        return true
      }
      const mode = modeOf(url)
      const tailCap = numberParam(url, 'tailCap')
      const book = await assemble(deps, tag, mode)
      const body = repairOf(book, tailCap)
      // The tail cap is part of the QUESTION, so two menus asked with different
      // caps are two answers even on an identical book.
      if (body.error === undefined) {
        snapshot(tag, mode, 'repair', body.asOf, bookPrint(book, 'repair', String(tailCap)), body)
      }
      send(200, body)
      return true
    }

    return false
  }
}

// ------------------------------------------------------------- the assembly

/**
 * Everything the three endpoints share: one book, one chain snapshot, one set
 * of solved vols.
 *
 * ONE SNAPSHOT IS A CORRECTNESS PROPERTY, not an optimisation. The repair
 * search reads a strike's price through `StrikeInfo` when it bands a candidate
 * and through `priceOf` when it fills one; if those came from two reads of a
 * live cache, a plan could be generated against one price and scored against
 * another. Both close over the object built here.
 */
export interface Assembled {
  readonly tag: string
  readonly mode: DeskMode
  readonly symbol: string
  readonly expiry: string
  readonly today: string
  readonly asOf: number
  readonly future: number | null
  readonly spot: number | null
  readonly chain: ChainResponse | null
  readonly legs: readonly PayoffLeg[]
  readonly ivs: readonly SolvedIv[]
  readonly tYears: number
  readonly realised: number
  readonly targetPnl: number | null
  readonly machine: ReliefTriggers | null
  readonly warnings: readonly string[]
  /** Market closed — the chain above is display marks, last session's. */
  readonly closed: boolean
  /** Set ONLY when the tag names no book at all. */
  readonly error: string | null
}

/**
 * How far back "the last session" may reach when the market is closed: a
 * Friday close must still price a chain on Tuesday pre-open with a Monday
 * holiday in between. Finite deliberately — `Infinity` serialises to `null`
 * in the dials that ride the wire — and generous deliberately: a mark older
 * than this is not last session's, it is archaeology.
 */
const LAST_SESSION_MAX_AGE_MS = 4 * 24 * 60 * 60 * 1000

export async function assemble(deps: ApiDeps, tag: string, mode: DeskMode): Promise<Assembled> {
  const asOf = deps.now()
  /**
   * OUTSIDE THE SESSION, THIS COCKPIT PRICES OFF THE LAST SESSION — display
   * marks, snapshot included — and says so once in the panel header instead of
   * eight times in the warnings. The gate is THE CLOCK, deliberately not
   * `feedAlive`: a feed that dies at 11am keeps every warning it earned,
   * because soothing last-seen prices mid-session are exactly the frozen-price
   * failure the cache guards against. Nothing downstream of this executes —
   * repairs are a menu, and the place-order path prices live and still refuses
   * on a dead feed.
   */
  const closed = !isMarketOpen(fixedClock(asOf))
  const warnings: string[] = []
  const doc = await deps.store.bookDoc(tag, mode)
  const row = await deps.store.getBook(tag, mode)

  if (doc === null && row === null) {
    return {
      tag,
      mode,
      symbol: '',
      expiry: '',
      today: istDate(asOf),
      asOf,
      future: null,
      spot: null,
      chain: null,
      legs: [],
      ivs: [],
      tYears: 0,
      realised: 0,
      targetPnl: null,
      machine: null,
      warnings: [],
      closed,
      // 200 with this set, not a 404: the dashboard polls this endpoint for a
      // book the operator has open, and a deleted or renamed tag has to render
      // as a sentence rather than as a failed fetch.
      error: `'${tag}' has no book in ${mode} — neither open legs nor a registry row`,
    }
  }

  const symbol = nonEmpty(doc?.symbol) ?? nonEmpty(row?.symbol) ?? ''
  const expiry = nonEmpty(doc?.expiry) ?? nonEmpty(row?.expiry) ?? ''
  const pos = await deps.service.positions(tag, mode, { realised: true })

  // ---- the chain, once ---------------------------------------------------
  let chain: ChainResponse | null = null
  if (deps.marks === undefined) {
    warnings.push('the quote cache is not attached to this process — nothing can be priced')
  } else if (symbol === '' || expiry === '') {
    warnings.push(`this book declares no ${symbol === '' ? 'symbol' : 'expiry'} — there is no chain to price it against`)
  } else {
    const marks = deps.marks
    chain = buildChain({ master: deps.master.current(), marks, now: () => asOf }, symbol, expiry, {
      display: closed,
    })
    if (chain.rows.length === 0) {
      warnings.push(`the instrument master lists no ${symbol} strikes for ${expiry}`)
    }
    // Known outside the session — no ticks flow when the market is closed, and
    // the header already says whose prices these are.
    if (!chain.feedAlive && !closed) {
      warnings.push('the feed is not ticking: every price below is the last one seen, not a live one')
    }
  }

  const future = chain?.future ?? null
  const spot = chain?.spot ?? pos.spot
  if (future === null) {
    warnings.push(
      `no future mark for ${symbol === '' ? 'this book' : symbol} — options are marked Black-76 off the ` +
        'future, so nothing on this book can be priced until it prints',
    )
  }

  // ---- one vol per (strike, side), solved off that chain -------------------
  const tYears = expiry === '' ? 0 : yearsToExpiry(expiry, asOf)
  const quotes: ChainQuoteLite[] = []
  if (chain !== null) {
    for (const r of chain.rows) {
      if (r.CE !== null) quotes.push({ strike: r.strike, type: 'CE', price: r.CE.price, ageMs: r.CE.ageMs })
      if (r.PE !== null) quotes.push({ strike: r.strike, type: 'PE', price: r.PE.price, ageMs: r.PE.ageMs })
    }
  }
  /**
   * THE WINDOW IS PASSED, NOT ASSUMED. `solveChainIvs` has a default of its own
   * (`ivs.ts`'s private `DEFAULT_MAX_AGE_MS`) that happens to be the same 120s
   * as `DEFAULT_REPAIR_DIALS.maxQuoteAgeMs` — two literals in two packages,
   * equal by coincidence. Everything else in this file that asks "is this quote
   * still evidence?" reads the dial (`fresh`, the repair candidates), so leaving
   * the solver on its own literal is how the archive's fingerprint and the
   * repairer's alphabet come to disagree with the vols they were built on the
   * day one of the two moves. Passing it makes the dial load-bearing.
   *
   * `DEFAULT_RATE` is spelled out only because `maxAgeMs` sits behind it in the
   * signature; it is the value the parameter already defaults to.
   */
  const ivs =
    future === null
      ? []
      : solveChainIvs(quotes, future, tYears, DEFAULT_RATE, {
          // Closed, every quote is legitimately hours old; the last session's
          // close vols are what an evening reader is asking about.
          maxAgeMs: closed ? LAST_SESSION_MAX_AGE_MS : DEFAULT_REPAIR_DIALS.maxQuoteAgeMs,
        })

  // ---- the legs, with their vol's PROVENANCE ------------------------------
  const legs: PayoffLeg[] = []
  const usedIds = new Set<string>()
  for (const l of pos.legs) {
    if (l.qty === 0) continue
    const name = l.instrument.tradingsymbol
    // Two legs on one contract is possible (a long and a short pocket of the
    // same strike), and the repair engine addresses a leg BY ID — so an id has
    // to be unique or a `close` would take the wrong one off.
    let id = name
    for (let n = 2; usedIds.has(id); n += 1) id = `${name}#${n}`
    usedIds.add(id)

    const stamped = stampIv(ivs, l.strike, l.type)
    /**
     * ONLY WHEN THERE WAS A CHAIN TO SOLVE AGAINST. With no future there are no
     * solved vols at all (`ivs` is empty above), so every leg would come back
     * `none` and the response would say each one "marks FLAT to expiry" —
     * which is false: nothing is marked, `view` is null, and the honest
     * sentence is the one about the missing future, said once. A per-leg
     * warning that fires from a missing input rather than from the leg is
     * noise on exactly the screen that must stay readable.
     */
    if (future === null) {
      // said once, above
    } else if (stamped.source === 'interp') {
      warnings.push(
        `${name}: its own quote did not solve, so it is marked at a vol INTERPOLATED from the ` +
          'neighbouring strikes — an estimate, and the vega beside it is one too',
      )
    } else if (stamped.source === 'off-chain') {
      warnings.push(
        `${name}: strike ${l.strike} is not on the ${expiry} chain, so its vol is interpolated from ` +
          'the strikes that are — routine on a rolled-in leg, an estimate all the same',
      )
    } else if (stamped.source === 'none') {
      warnings.push(
        `${name}: the chain solved no ${l.type} vol at all, so this leg marks FLAT to expiry — ` +
          "the book's real risk is understated by whatever it is worth",
      )
    }
    legs.push({
      id,
      instrument: 'option',
      // ALREADY SIGNED SHARES on both sides of this assignment. Nothing here
      // multiplies lots by a lot size, which is the arithmetic that drops a
      // sign and reads a short strangle as long.
      qty: l.qty,
      strike: l.strike,
      type: l.type,
      expiry: l.expiry,
      entry: l.entryPrice,
      iv: stamped.iv,
    })
  }
  if (legs.length === 0) warnings.push('this book holds no open legs')

  // ---- money already banked ----------------------------------------------
  const bookedRaw = pos.realised ?? null
  let realised = 0
  if (bookedRaw === null) {
    warnings.push(
      'realised unknown — this book\'s banked P&L could not be vouched for, so the curves are drawn ' +
        'as if nothing had been closed; every breakeven below is the OPEN legs\' own',
    )
  } else {
    realised = bookedRaw
  }

  // ---- the dials the bot is actually running ------------------------------
  let dials: Record<string, DialValue> = {}
  if (row === null) {
    warnings.push(
      `'${tag}' has no registry row in ${mode} — its dials are unknown, so the machine card cannot ` +
        'say what the bot would do with this book',
    )
  } else {
    const variants = await deps.store.listVariants()
    const defaults = variants.find((v) => v.key === row.variant)?.defaults ?? {}
    // The Books page's own merge: catalogue defaults UNDER the row's own dials.
    dials = { ...defaults, ...row.dials }
  }
  const targetPnl = typeof dials['target_pnl'] === 'number' ? dials['target_pnl'] : null

  // ---- what the RULE steers by -------------------------------------------
  let steering = pos.steering
  if (steering === null) {
    // `positions()` serves steering only from a FRESH declaration (6 minutes).
    // A stopped or wedged book still has a last published pair, and reading the
    // bot's mind off it — clearly dated — beats a blank card.
    const decl = await deps.store.loadDeclaration(tag)
    const g = decl?.greeks
    if (g?.steeringDelta !== undefined && g?.steeringGamma !== undefined) {
      steering = { delta: g.steeringDelta, gamma: g.steeringGamma }
      const at = decl?.greeksAt
      // Known outside the session: the strategy stopped publishing at the
      // close, and "not marked for 129 minutes" at 7pm is a fact about the
      // clock, not the book.
      if (!closed) {
        warnings.push(
          `the steering greeks below are STALE — last published ${
            at === undefined ? 'at an unknown time' : `${Math.round((asOf - at) / 60_000)} minutes ago`
          }; the strategy has not marked recently`,
        )
      }
    }
  }

  // ---- what the broker is holding against it ------------------------------
  let marginUsed: number | null = null
  const marginDoc = (await deps.db
    .collection(COLLECTIONS.bookMargin)
    .findOne({ _id: tag })) as Record<string, unknown> | null
  const marginAt = Number(marginDoc?.['asOf'] ?? 0)
  if (marginDoc !== null && marginAt > 0) {
    marginUsed = brokerFigures(marginDoc, await brokerCalibration(deps)).brokerTotal
    // Same rule as the greeks above: nothing refreshes margin after the close.
    if (!closed && asOf - marginAt > BOOK_MARGIN_STALE_MS) {
      warnings.push(
        `the margin figure is ${Math.round((asOf - marginAt) / 60_000)} minutes old — the gate below is ` +
          'read against a number the broker may have moved since',
      )
    }
  }

  /**
   * THE PRICE THE BAND IS A FRACTION OF. The greeks this card divides are
   * Black-76 ones — per point of FUTURE — so the future is the consistent
   * denominator, and it is what the desk hedges against. Cash spot is the
   * fallback only because a card with no band at all says less than one
   * measured a few rupees off — and it SAYS SO when it falls back, because the
   * two differ by the carry and the reader is comparing the answer against a
   * tolerance measured in percent.
   */
  const machine = reliefTriggers({ steering, dials, marginUsed, spot: future ?? spot })
  /**
   * ONLY WHEN A BAND WAS ACTUALLY MEASURED OFF IT. With no steering pair — or a
   * netΓ of exactly 0, which is the "no convexity to centre" hold — the card
   * reports no imbalance at all, and a caveat about the price a band was
   * computed from is then a caveat about nothing. `notes` already say why there
   * is no verdict.
   */
  if (future === null && spot !== null && machine.deltaImbalance !== null) {
    warnings.push(
      // Rounded: this is spot, quoted to the paisa like every price on the desk.
      // The raw float prints as 408.34999999999997 and reads as a bug.
      `the machine band below is computed off CASH SPOT ${Number(spot.toFixed(2))} — the future is not ` +
        'printing, and the bot measures its delta tolerance against the future, so read the imbalance ' +
        'as approximate',
    )
  }

  return {
    tag,
    mode,
    symbol,
    expiry,
    today: istDate(asOf),
    asOf,
    future,
    spot,
    chain,
    legs,
    ivs,
    tYears,
    realised,
    targetPnl,
    machine,
    warnings,
    closed,
    error: null,
  }
}

/** The vol to stamp on a leg, AND where it came from. See the header. */
function stampIv(
  ivs: readonly SolvedIv[],
  strike: number,
  type: OptionType,
): { readonly iv: number | null; readonly source: 'quote' | 'interp' | 'off-chain' | 'none' } {
  const iv = ivFor(ivs, strike, type)
  if (iv === null) return { iv: null, source: 'none' }
  const exact = ivs.find((s) => s.strike === strike && s.type === type)
  if (exact === undefined) return { iv, source: 'off-chain' }
  return { iv, source: exact.source === 'quote' && exact.iv !== null ? 'quote' : 'interp' }
}

// -------------------------------------------------------------- the payoff

function viewOf(book: Assembled, legs: readonly PayoffLeg[], realised: number): PayoffView | null {
  if (book.future === null) return null
  return buildPayoffView({
    legs,
    future: book.future,
    expiry: book.expiry,
    today: book.today,
    realised,
    targetPnl: book.targetPnl,
    rate: DEFAULT_RATE,
  })
}

function envelope(
  book: Assembled,
  view: PayoffView | null,
  extra: readonly string[] = [],
): PayoffResponse {
  return {
    tag: book.tag,
    mode: book.mode,
    symbol: book.symbol,
    expiry: book.expiry,
    future: book.future,
    spot: book.spot,
    asOf: book.asOf,
    view,
    machine: book.machine,
    ivs: book.ivs,
    warnings: [...book.warnings, ...extra],
    marketClosed: book.closed,
    ...(book.error === null ? {} : { error: book.error }),
  }
}

function payoffOf(book: Assembled): PayoffResponse {
  if (book.error !== null) return envelope(book, null)
  return envelope(book, viewOf(book, book.legs, book.realised))
}

// -------------------------------------------------------------- the what-if

function whatIf(
  book: Assembled,
  raw: readonly unknown[],
  rawMoves: readonly unknown[] = [],
): WhatIfResponse {
  const current = book.error !== null ? null : viewOf(book, book.legs, book.realised)
  if (book.error !== null || book.future === null || book.chain === null) {
    return { current: current?.summary ?? null, dropped: [], combined: payoffOf(book) }
  }

  const chain = chainLookups(book)
  const proposals = raw.map(toProposal)
  const overrides = new Map<string, number>()
  /**
   * THE PLAN'S OWN MOVES FIRST, VERBATIM AND UNVALIDATED — exactly as
   * `verify-margin` hands them over.
   *
   * `applyMoves` is the validator: every branch of it checks its own move and
   * pushes a named sentence for one it will not apply (`moves.ts` rule 1). A
   * second, weaker check here would either duplicate those sentences or, worse,
   * refuse a move the engine would have accepted — and the whole point of this
   * field is that the preview and the SCORE come out of the same function.
   *
   * FIRST, because a `close` addresses a leg BY ID and the ids a proposal
   * creates (`add:600PE`) are not ids a plan can have been scored against. Run
   * the plan against the stored book, then let a hand-added leg join the result.
   * The panel never sends both; the order is defined so that if it ever does,
   * the plan is still the plan.
   */
  const moves: Move[] = [...(rawMoves as readonly Move[])]
  const warnings: string[] = []
  for (const [i, p] of proposals.entries()) {
    if (p === null) {
      // NAMED, AND BY POSITION. A proposal this endpoint could not read is a
      // leg the caller believes it is looking at the payoff of; dropping it
      // silently answers a different question in the same shape.
      warnings.push(
        `proposed[${i}] is not a readable {strike, type, qty} — it was ignored, and the combined ` +
          'curves below do NOT include it',
      )
      continue
    }
    if (p.price !== undefined) overrides.set(`${p.strike}|${p.type}`, p.price)
    // `add` and `hedge` are the same operation to `applyMoves`; the labels are
    // the operator's own words for the two directions, and they are what the
    // warnings name when a leg cannot be filled.
    moves.push({ op: p.qty < 0 ? 'add' : 'hedge', strike: p.strike, type: p.type, qty: p.qty })
  }

  // A fill assumption WINS over the chain's mark — "what if I get filled at 12"
  // is the question — but only for the contract it was given for.
  const priceOf = (strike: number, type: OptionType): number | null =>
    overrides.get(`${strike}|${type}`) ?? chain.priceOf(strike, type)

  const applied = applyMoves(book.legs, moves, priceOf, chain.ivOf, book.future)
  /**
   * THE CLOSES' P&L IS BANKED, NOT LOST — `book.realised + realisedDelta`, the
   * same fold `goals.ts` applies when it scores a plan (`runBreakevens` and the
   * run-level figures are computed on the shifted curve). It matters most on the
   * vocabulary this endpoint only just learned: a plan of pure closes has
   * NOTHING but `realisedDelta`, so dropping it would answer a flatten with a
   * flat line at the book's OLD booked figure — the P&L of getting out simply
   * missing from the one curve drawn to show what getting out is worth.
   */
  const booked = book.realised + applied.realisedDelta
  /**
   * EVERY LEG CLOSED is a real, ordinary plan — "flatten and bank" — and its
   * answer is FLAT at what it banked, at every price. `buildPayoffView` cannot
   * say this: a zero-leg book reaches `emptyView` ("no legs: nothing to
   * price"), whose every figure is a literal 0 and whose curve is empty — which
   * the panel rightly refuses to draw. So the one plan whose outcome is known
   * EXACTLY previewed as nothing at all. `goals.ts` answers this same case with
   * its own flat branch when it SCORES the plan; `flattenedView` is that branch
   * for the preview, drawn on the base view's own scan so the fourth line lands
   * on the chart's grid. Guarded on `book.legs.length > 0` because a book that
   * was ALREADY empty earned the honest emptyView, not a flat line.
   */
  const combined =
    applied.legs.length === 0 && book.legs.length > 0
      ? (flattenedView(current, booked, book.future, book.targetPnl) ??
        viewOf(book, applied.legs, booked))
      : viewOf(book, applied.legs, booked)
  return {
    current: current?.summary ?? null,
    dropped: [...warnings, ...applied.warnings],
    // Both channels: what this route could not READ, and what `applyMoves`
    // could not FILL. They are different failures and a caller acts on them
    // differently — one is a bad request, the other is a chain that cannot
    // price the leg being asked about.
    combined: envelope(book, combined, [...warnings, ...applied.warnings]),
  }
}

/**
 * The flat view a fully-closed book previews as — see the call site. Built on
 * the CURRENT view's own scan (same prices, same named rows) so the "if placed"
 * line shares the chart's grid; every P&L is `booked`, because that is the
 * whole statement a flatten makes. The figures mirror `goals.ts`'s flat branch:
 * `maxLossAt` is `future` ("nowhere in particular: the line is flat — where the
 * reader is standing"), `pop` is 0 ("will the open legs finish green" has no
 * answer with no open legs; `buildSurface` returns 0 for an empty book too),
 * `netCredit` is 0 (premium the OPEN legs collected), and no breakeven exists
 * because a flat line never crosses zero. `null` when the base itself never
 * priced — the caller falls back to the emptyView path for that.
 */
function flattenedView(
  base: PayoffView | null,
  booked: number,
  future: number,
  target: number | null,
): PayoffView | null {
  if (base === null || base.curve.length === 0) return null
  return {
    curve: base.curve.map((p) => ({ price: p.price, expiry: booked, t0: booked, mid: booked })),
    table: base.table.map((r) => ({
      price: r.price, expiry: booked, t0: booked, mid: booked, label: r.label,
    })),
    midDate: base.midDate,
    summary: {
      maxProfit: booked,
      maxLoss: booked,
      maxLossAt: future,
      breakevens: { down: null, up: null },
      pop: 0,
      netCredit: 0,
      worstShock: booked,
      worstShockAt: future,
      floor: booked,
      booked,
      targetPnl: target,
    },
    greeks: { delta: 0, gamma: 0, theta: 0, vega: 0 },
    warnings: [],
  }
}

function toProposal(raw: unknown): Proposed | null {
  if (!isObject(raw)) return null
  const strike = raw['strike']
  const type = raw['type']
  const qty = raw['qty']
  const price = raw['price']
  if (typeof strike !== 'number' || !Number.isFinite(strike) || strike <= 0) return null
  if (type !== 'CE' && type !== 'PE') return null
  if (typeof qty !== 'number' || !Number.isFinite(qty) || qty === 0) return null
  return {
    strike,
    type,
    qty,
    ...(typeof price === 'number' && Number.isFinite(price) && price > 0 ? { price } : {}),
  }
}

// --------------------------------------------------------------- the repair

interface ChainLookups {
  readonly strikes: readonly StrikeInfo[]
  readonly priceOf: (strike: number, type: OptionType) => number | null
  readonly ivOf: (strike: number, type: OptionType) => number | null
}

/**
 * The tradeable chain and the two lookups over it, all three built from ONE
 * snapshot and one solved skew — see `Assembled`.
 *
 * `delta` is Black-76 at the strike's OWN solved vol, which is what the
 * repairer's delta bands mean. It is deliberately not served by `chain.ts` (see
 * that file's header: a Black-Scholes-on-spot delta would match neither engine).
 */
export function chainLookups(book: Assembled): ChainLookups {
  const prices = new Map<string, number>()
  const strikes: StrikeInfo[] = []
  const future = book.future
  /**
   * MEMOISED, and only because `ivFor` filters and sorts the whole solved chain
   * on every call. It is asked once per row here and then again for every move
   * the beam search prices — hundreds of candidate books deep — so on a 400-row
   * index chain the same scan would run thousands of times for an answer that
   * cannot change: `book.ivs` is one immutable snapshot. Same values, same
   * order, one pass each.
   */
  const solved = new Map<string, number | null>()
  const ivAt = (strike: number, type: OptionType): number | null => {
    const key = `${strike}|${type}`
    const hit = solved.get(key)
    if (hit !== undefined) return hit
    const v = ivFor(book.ivs, strike, type)
    solved.set(key, v)
    return v
  }
  for (const r of book.chain?.rows ?? []) {
    for (const type of ['CE', 'PE'] as const) {
      const q = type === 'CE' ? r.CE : r.PE
      if (q === null) continue
      prices.set(`${r.strike}|${type}`, q.price)
      const iv = ivAt(r.strike, type)
      const delta =
        iv === null || future === null
          ? null
          : b76Greeks({ future, strike: r.strike, t: book.tYears, vol: iv, rate: DEFAULT_RATE, type }).delta
      strikes.push({ strike: r.strike, type, price: q.price, ageMs: q.ageMs, iv, delta })
    }
  }
  return {
    strikes,
    priceOf: (strike, type) => prices.get(`${strike}|${type}`) ?? null,
    // Interpolating rather than reading the row: a shift lands on a strike the
    // book does not hold and may sit between two that quoted.
    ivOf: ivAt,
  }
}

function repairOf(book: Assembled, tailCap: number | null): RepairResponse {
  const dials: RepairDials = {
    ...DEFAULT_REPAIR_DIALS,
    // A lot size the master does not know is 0, never a guess: `candidates.ts`
    // then proposes no opens at all, which is the right refusal — a plan
    // quietly sized in single shares is worse than no plan.
    lotSize: book.chain?.lotSize ?? 0,
    // Closed, "fresh" means "the last session's" — the same window the vols
    // above were solved through, or the menu prices moves on a chain whose
    // every row it then refuses as too old.
    ...(book.closed ? { maxQuoteAgeMs: LAST_SESSION_MAX_AGE_MS } : {}),
  }
  const base = {
    tag: book.tag,
    mode: book.mode,
    asOf: book.asOf,
    dials,
    /**
     * COMPUTED THROUGH THE SHARED HELPER, and from `book.legs` — the very list
     * whose positions handed out the ids the plans below address. The preflight
     * calls the SAME function over its own `assemble`, which is what makes the
     * comparison meaningful: two spellings of it would drift, and a fingerprint
     * that drifts either refuses every card or vouches for nothing.
     *
     * Served on EVERY answer including the error ones: a constant field is one
     * fewer branch for the client, and an empty book prints the empty hash.
     *
     * The snapshot archive is unaffected — see `bookPrint`'s header on fields
     * that are not functions of its inputs. This one is: every leg it hashes is
     * already inside that fingerprint.
     */
    legsPrint: bookLegsPrint(book.legs),
  }
  if (book.error !== null) {
    return { ...base, goals: [], universe: { atomic: 0, evaluated: 0 }, warnings: [], error: book.error }
  }
  if (book.future === null || book.chain === null) {
    return { ...base, goals: [], universe: { atomic: 0, evaluated: 0 }, warnings: book.warnings }
  }

  const warnings = [...book.warnings]
  if (dials.lotSize <= 0) {
    warnings.push(
      `the instrument master has no lot size for ${book.symbol} ${book.expiry} — no plan below opens ` +
        'anything, because there is no honest number of shares to open',
    )
  }

  const chain = chainLookups(book)
  /**
   * THE DEGRADED-BOOK WARNINGS (task 8's carry-over ruling).
   *
   * `RepairPlan` has no warnings channel: every plan is scored through the same
   * surface `buildPayoffView` builds, so a book carrying a leg that will not
   * price is scored — silently — as if that leg marked flat. The floor a menu
   * quotes then belongs to a different book from the one on the screen. This is
   * the only level at which that can be said, so it is said here, once, from
   * the baseline view of the book the plans were scored on.
   */
  for (const w of viewOf(book, book.legs, book.realised)?.warnings ?? []) warnings.push(w)

  const plans = searchRepairs({
    legs: book.legs,
    future: book.future,
    today: book.today,
    expiry: book.expiry,
    realised: book.realised,
    dials,
    priceOf: chain.priceOf,
    ivOf: chain.ivOf,
    strikes: chain.strikes,
    triggers: book.machine,
    ...(tailCap === null ? {} : { tailCapRupees: tailCap }),
  })

  // Grouped in the ENGINE's own order, with any goal it said nothing about
  // appended empty rather than silently missing from the menu.
  const byGoal = new Map<Goal, RepairPlan[]>()
  for (const p of plans) {
    const bucket = byGoal.get(p.goal)
    if (bucket === undefined) byGoal.set(p.goal, [p])
    else bucket.push(p)
  }
  for (const g of ALL_GOALS) if (!byGoal.has(g)) byGoal.set(g, [])

  return {
    ...base,
    goals: [...byGoal.entries()].map(([goal, list]) => ({ goal, plans: list })),
    universe: {
      // Recomputed rather than reported by the search, which does not expose
      // it. Cheap — `atomicMoves` prices nothing — and it is the difference
      // between "nothing helps" and "there was nothing to try".
      atomic: atomicMoves(book.legs, chain.strikes, dials).length,
      evaluated: chain.strikes.length,
    },
    warnings,
  }
}

// ------------------------------------------------------ the margin verify

/**
 * ONE LEG OF A HYPOTHETICAL BOOK, on the wire desk-marketdata speaks.
 *
 * NAMED SEMANTICALLY, not by tradingsymbol, and that is deliberate: the process
 * that talks to Kite is the one that syncs the instrument master daily, so it
 * is the one that should say what `BHEL26AUG415CE` is. A bridge spelling the
 * exchange's own symbol format and posting it as fact is the string fabrication
 * that produced the C4 phantom PE.
 */
export interface WireLeg {
  readonly underlying: string
  readonly expiry: string
  readonly strike: number
  readonly type: OptionType
  /** SIGNED units, exactly as `PayoffLeg.qty` already is. */
  readonly qty: number
}

/**
 * What the broker would hold against the book AFTER `moves`.
 *
 * ── THE WHOLE BOOK GOES OVER, NEVER JUST THE MOVES ──────────────────────────
 *
 * A broker prices a PORTFOLIO. The short call that a proposed long wing caps is
 * what makes the wing cheap, and posting the wing alone would price a naked
 * long option — margin nil — for a plan that still carries two shorts. So the
 * moves are applied to the stored book first and the RESULT is what crosses the
 * wire, which is also why this cannot be a pure function of the plan.
 *
 * ── TWO NUMBERS, AND THE ESTIMATE NEVER GOES MISSING ────────────────────────
 *
 * `estimated` is `spanLiteMargin` — the same estimator the Python engine's
 * margin-cap guard runs, so it is the number the BOT would gate on. `broker` is
 * what the counter actually blocks, put through `brokerFigures` — the SAME
 * function the per-book margin tile reads, so the two panels cannot disagree
 * about one book. They are reported side by side rather than reconciled: the
 * gap between them is information, and a single "margin" figure would hide
 * which of the two would refuse a plan.
 *
 * Every broker failure — an unreachable marketdata, a dead enctoken, a strike
 * the master does not list — is `broker: null` plus a sentence. Never a zero,
 * and never a 500: this panel sits beside a live position, and a plan whose
 * broker check failed must read as "not verified", not as "free to hold".
 */
export async function verifyMargin(
  deps: ApiDeps,
  book: Assembled,
  rawMoves: readonly unknown[],
  cfg: MarginProxyConfig,
): Promise<VerifyMarginResponse> {
  if (book.error !== null) return { estimated: 0, broker: null, warnings: [book.error] }

  const warnings: string[] = []
  const chain = chainLookups(book)
  const applied = applyMoves(
    book.legs,
    rawMoves as readonly Move[],
    chain.priceOf,
    chain.ivOf,
    // `undefined` is exactly "omitted" here, and it is what makes a FUTURES
    // close refusable rather than markable at a guess — see `moves.ts`.
    book.future ?? undefined,
  )
  // The moves that did NOT happen, named. A plan verified one leg lighter than
  // the operator believes they are placing is worse than no verification.
  for (const w of applied.warnings) warnings.push(w)

  /**
   * THE PRICE THE SCAN IS RUN OFF. The future, because every option on this
   * desk is marked Black-76 against it and `spanLiteMargin` shocks the same
   * quantity the legs are priced from. Cash spot is the fallback, and it is
   * SAID, because the two differ by the carry.
   */
  const scanFrom = book.future ?? book.spot
  if (book.future === null && scanFrom !== null) {
    warnings.push(
      `the estimate below is scanned off CASH SPOT ${Number(scanFrom.toFixed(2))} — the future is not ` +
        'printing, and every option here is marked off the future, so read it as approximate',
    )
  }
  const estimated =
    scanFrom === null ? 0 : spanLiteMargin(applied.legs, scanFrom, book.today).total
  if (scanFrom === null) {
    warnings.push(
      'neither the future nor spot is printing, so there is no price to scan this book against — ' +
        'the estimate is 0 because it could not be computed, NOT because the book is free to hold',
    )
  } else {
    /**
     * A LEG WITH NO SOLVED VOL IS STILL SCANNED, at `spanLiteMargin`'s 35%
     * default — silently, because that estimator returns no warnings by design
     * (it is called on every mark of every book). Said here because the vol
     * shock is a third of the grid: an estimate carrying a guessed vol is not
     * the same claim as one carrying the chain's.
     */
    const guessed = applied.legs.filter((l) => l.qty !== 0 && (l.iv === null || !(l.iv > 0)))
    if (guessed.length > 0) {
      warnings.push(
        `${guessed.map((l) => `"${l.id}"`).join(', ')}: the chain solved no vol, so the estimate ` +
          'below scans them at a DEFAULT volatility — the broker figure beside it does not guess',
      )
    }
  }

  const wire = toWireLegs(book, applied.legs)
  for (const w of wire.warnings) warnings.push(w)
  if (wire.legs.length === 0) {
    warnings.push('this plan holds nothing the broker can be asked to price')
    return { estimated, broker: null, warnings }
  }
  if (!wire.postable) {
    // A basket that would go over SHORT A LEG is not asked for at all: the
    // figure that came back would describe a book nobody is proposing.
    return { estimated, broker: null, warnings }
  }

  const asked = await askBroker(cfg, wire.legs)
  if (!asked.ok) {
    deps.log('broker margin verify could not be answered', { tag: book.tag, reason: asked.why })
    warnings.push(`the broker could not be asked what this plan costs: ${asked.why}`)
    return { estimated, broker: null, warnings }
  }
  /**
   * THROUGH THE SAME FUNCTION THE TILE USES, and for the reason this file's
   * header already gives about `MARGIN`: two definitions of "margin used" on one
   * screen is the defect this desk keeps re-finding. `brokerFigures` applies the
   * XTS account's measured span/exposure calibration and sums in the long-leg
   * premium; uncalibrated it is the identity, so a desk with no broker snapshot
   * simply gets Zerodha's rates in the right SHAPE.
   *
   * The calibration is re-read rather than carried on `Assembled` — two indexed
   * finds that this same request has already paid for once in `assemble`, on a
   * route a human presses a button for rather than one a dashboard polls.
   */
  const cal = await brokerCalibration(deps)
  const fig = brokerFigures(
    { span: asked.figures.span, exposure: asked.figures.exposure, premiumPaid: asked.figures.premiumPaid },
    cal,
  )
  return {
    estimated,
    broker: {
      total: fig.brokerTotal,
      span: fig.brokerSpan,
      exposure: fig.brokerExposure,
      premiumPaid: fig.premiumPaid,
      // Carried rather than re-derived on the far side: the calibration is a
      // fact about THIS answer, and a panel that re-asked would be describing a
      // different moment's snapshot. See `BrokerMargin.calibrated`.
      calibrated: cal !== null,
    },
    warnings,
  }
}

/**
 * The combined book -> the wire, with everything the chain can say about it.
 *
 * `postable` is false when a leg exists that this shape cannot carry — today
 * only a FUTURES leg, which has no strike or type. Refusing the whole call then
 * is the same rule `moves.ts` applies to a half-priced shift: a basket missing
 * a futures leg is not a smaller answer, it is an answer to a different
 * question, and futures margin is the largest line on a book that holds one.
 *
 * A strike that is not on the chain is only a WARNING. The chain covers the
 * book's own expiry, and a rolled-in leg legitimately sits on another one;
 * desk-marketdata's master is the authority on what is listed, and it refuses
 * the basket itself if the contract really does not exist. Pre-empting that
 * here would let a stale master in THIS process veto a real contract.
 */
export function toWireLegs(
  /**
   * NARROWER THAN `Assembled` on purpose: these are the only three fields this
   * needs, and asking for no more is what lets the suite exercise both refusals
   * with a three-line literal instead of a whole assembled book. `Assembled`
   * satisfies it structurally.
   */
  book: { readonly symbol: string; readonly expiry: string; readonly chain: ChainResponse | null },
  legs: readonly PayoffLeg[],
): { readonly legs: readonly WireLeg[]; readonly warnings: readonly string[]; readonly postable: boolean } {
  const warnings: string[] = []
  const out: WireLeg[] = []
  let postable = true

  /**
   * `${strike}|${type}` for every side the chain carries a CONTRACT for.
   *
   * `null` rather than an empty set when there is no chain at all: with no
   * chain, "this strike is not listed" is not something this process knows, and
   * saying it of every leg in the book would be a page of confident nonsense
   * about a contract the desk is already holding.
   */
  const rows = book.chain?.rows ?? []
  const listed = rows.length === 0 ? null : new Set<string>()
  for (const r of rows) {
    if (r.ceContract !== undefined) listed?.add(`${r.strike}|CE`)
    if (r.peContract !== undefined) listed?.add(`${r.strike}|PE`)
  }

  for (const leg of legs) {
    // Kite rejects a zero quantity for the WHOLE basket, so a closed leg still
    // sitting in the book would cost every other leg its figure.
    if (leg.qty === 0) continue
    const strike = finiteNum(leg.strike)
    const type = leg.type
    if (leg.instrument !== 'option' || type === null || strike === null) {
      postable = false
      warnings.push(
        `"${leg.id}" is not an option leg, and the broker check speaks options only — the whole ` +
          'basket is left unasked rather than priced without it',
      )
      continue
    }
    const expiry = typeof leg.expiry === 'string' && leg.expiry !== '' ? leg.expiry : book.expiry
    if (expiry === '') {
      postable = false
      warnings.push(`"${leg.id}" carries no expiry, so no contract can be named for it`)
      continue
    }
    if (listed !== null && expiry === book.expiry && !listed.has(`${strike}|${type}`)) {
      warnings.push(
        `${strike}${type} is not listed on the ${book.expiry} chain this desk can see — the ` +
          'broker check will refuse the whole basket if its own master agrees',
      )
    }
    out.push({
      underlying: book.symbol,
      expiry,
      strike,
      type,
      // ALREADY SIGNED UNITS on both sides. Nothing here multiplies lots.
      qty: leg.qty,
    })
  }
  return { legs: out, warnings, postable }
}

/**
 * The broker's answer, or the sentence explaining its absence.
 *
 * The RAW components, at Zerodha's rates. `brokerFigures` turns them into the
 * account's own figures and the headline — see `verifyMargin`.
 */
type BrokerAnswer =
  | { readonly ok: true; readonly figures: { span: number; exposure: number; premiumPaid: number } }
  | { readonly ok: false; readonly why: string }

/** How long one basket call may take. Kite's own attempt budget is 15s. */
const VERIFY_TIMEOUT_MS = 20_000

function finiteNum(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/**
 * Ask desk-marketdata. NEVER THROWS — every outcome is an answer, because the
 * caller's job is to render one.
 */
async function askBroker(cfg: MarginProxyConfig, legs: readonly WireLeg[]): Promise<BrokerAnswer> {
  const base = cfg.url.replace(/\/$/, '')
  if (base === '') {
    return { ok: false, why: 'no DESK_MD_URL is configured, so there is nowhere to ask' }
  }
  if (cfg.token === '') {
    return { ok: false, why: 'no DESK_API_TOKEN is set, so the market-data process would refuse us' }
  }
  const doFetch = cfg.fetch ?? globalThis.fetch
  try {
    const res = await doFetch(`${base}/v1/md/margin-basket`, {
      method: 'POST',
      headers: { authorization: `Bearer ${cfg.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ legs }),
      // `fetch` has NO timeout of its own, and this is awaited inside a request
      // handler: a market-data process that accepts the connection and never
      // answers would hold a dashboard poll open indefinitely.
      signal: AbortSignal.timeout(cfg.timeoutMs ?? VERIFY_TIMEOUT_MS),
    })
    const text = await res.text()
    let parsed: unknown = null
    try {
      parsed = JSON.parse(text)
    } catch {
      // A body that is not JSON is a failure whatever the status says — the
      // same lesson `kite.ts` records about a 200 carrying a login page.
      return { ok: false, why: `HTTP ${String(res.status)}: ${text.slice(0, 200)}` }
    }
    const body = isObject(parsed) ? parsed : {}
    const stated = typeof body['error'] === 'string' ? body['error'] : ''
    if (!res.ok || stated !== '') {
      return { ok: false, why: stated === '' ? `HTTP ${String(res.status)}` : stated }
    }
    const span = finiteNum(body['span'])
    const exposure = finiteNum(body['exposure'])
    if (span === null || exposure === null) {
      // Type-checked, not coerced: `Number(null)` is 0, and a 0 here reads on
      // the panel as a plan that costs nothing to hold.
      return { ok: false, why: 'the reply carried no usable span/exposure figures' }
    }
    /**
     * TOLERATED, NOT REQUIRED — a desk-marketdata that has not been restarted
     * since this shipped serves `{total, span, exposure}` and nothing else.
     * Absent means zero, which is exactly what it meant there, so a half-updated
     * desk degrades to the figure it used to give rather than to a refusal.
     */
    const premiumPaid = finiteNum(body['premiumPaid']) ?? 0
    /**
     * THE REPLY'S OWN `total` IS DELIBERATELY NOT READ. The headline is
     * recomputed from the three components below, which makes this route's
     * arithmetic identical across both marketdata versions — the older one's
     * `span + exposure` is what `premiumPaid: 0` reproduces — instead of
     * inheriting whichever definition of "total" the far side happened to hold.
     */
    return { ok: true, figures: { span, exposure, premiumPaid } }
  } catch (err) {
    return { ok: false, why: err instanceof Error ? err.message : String(err) }
  }
}

// -------------------------------------------------------------- the archive

/**
 * WHAT THE ANSWER IS MADE OF — the archive's idea of "the same picture".
 *
 * Fingerprinted over the INPUTS, never over the served payload, and that is the
 * whole design. A payoff response is a deterministic function of these values
 * plus the clock, and every one of them is a feed price, a stored figure or a
 * calendar date — nothing here moves on its own. So two polls of an unmoved
 * book fingerprint identically no matter how much time passed between them,
 * exactly and with no tolerance to tune.
 *
 * HASHING THE PAYLOAD DOES NOT WORK, and it was tried before this: `asOf` moves
 * every millisecond, and the solved IVs drift in their sixth decimal because
 * the tenor they are solved at shrinks with the clock. That drift reaches the
 * mark-to-market curves through the legs' vega, and its size is SCALE-DEPENDENT
 * — measured at 0.19 on a −392 curve point (5e-4 relative) and 0.42 on a
 * −14,836 one (3e-5 relative) over one minute of an utterly still book. No
 * single rounding is coarse enough for the first and fine enough to still catch
 * a real move on the second. Rounding the tenor instead would distort a number
 * the operator reads and the repairer bands on, to serve the archive. Neither
 * is acceptable; the inputs are.
 *
 * FRESHNESS IS AN INPUT, NOT A CLOCK, and that distinction is the whole reason
 * a quote's AGE is not in here while its freshness FLAG is. `solveChainIvs`
 * refuses a quote older than its window and rebuilds that strike from its
 * neighbours instead; so a quote that simply sits there, unchanged, crossing
 * two minutes flips its leg from a measured vol to an interpolated one — the
 * stamped IV, the whole t0 curve, a named warning and the repair menu's bands
 * all move, at an identical price. On the illiquid wings this desk actually
 * runs, that is the normal way an answer changes, and a fingerprint blind to it
 * would archive nothing for the rest of a quiet window. The raw age is the
 * clock and would drift every millisecond; the boolean it feeds is a step, and
 * a step cannot drift.
 *
 * THE COST OF THIS CHOICE, stated: a field added to the response that is NOT a
 * function of the values below would be deduped away silently. Anything derived
 * from the book, the chain (price and freshness), the dials or the margin is
 * covered; a new input belongs in here.
 */
export function bookPrint(book: Assembled, kind: 'payoff' | 'repair', extra: string): string {
  const parts: string[] = [
    kind,
    extra,
    book.symbol,
    book.expiry,
    // The valuation DATE, not the instant: the curves are dated, so midnight IST
    // is a genuinely different answer and files its own document.
    book.today,
    String(book.future),
    String(book.spot),
    String(book.realised),
    String(book.targetPnl),
    String(book.chain?.lotSize ?? ''),
    // Clock-free by construction: `marginFrac` is a ratio of two stored figures,
    // `deltaImbalance` is the published steering pair over the future.
    JSON.stringify(book.machine),
  ]
  // The legs as HELD — their vol is left out deliberately: it is solved off the
  // chain prices below at a tenor that shrinks every millisecond, so it is the
  // one field on a leg that moves without anything happening.
  for (const l of book.legs) {
    parts.push(`${l.id}|${l.qty}|${l.strike}|${l.type}|${l.expiry}|${l.entry}`)
  }
  // The market itself: each side's price, and whether that price is still
  // EVIDENCE. See the header — the age is the clock, the verdict on it is not.
  for (const r of book.chain?.rows ?? []) {
    parts.push(
      `${r.strike}|${r.CE?.price ?? ''}${fresh(r.CE)}|${r.PE?.price ?? ''}${fresh(r.PE)}`,
    )
  }
  return createHash('sha1').update(parts.join('')).digest('hex')
}

/**
 * Is this quote inside the window the vol solve will accept?
 *
 * Read from `DEFAULT_REPAIR_DIALS.maxQuoteAgeMs` rather than written as a
 * literal, because that dial IS `ivs.ts`'s own window, deliberately (see its
 * comment there): two definitions of "fresh" in one cockpit is how a strike
 * gets an IV it is not allowed to trade on — and a third, here, is how the
 * archive stops noticing the day one of them moves. A missing quote is not
 * fresh, and neither is one whose age cannot be read.
 */
function fresh(q: { readonly ageMs: number } | null | undefined): '+' | '-' {
  const inside =
    q !== null &&
    q !== undefined &&
    Number.isFinite(q.ageMs) &&
    q.ageMs <= DEFAULT_REPAIR_DIALS.maxQuoteAgeMs
  return inside ? '+' : '-'
}

// ----------------------------------------------------------------- odds and ends

function nonEmpty(v: string | undefined): string | null {
  return typeof v === 'string' && v !== '' ? v : null
}

/** A positive finite query param, or null when absent OR unreadable. */
function numberParam(url: URL, name: string): number | null {
  const raw = url.searchParams.get(name)
  if (raw === null || raw.trim() === '') return null
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : null
}
