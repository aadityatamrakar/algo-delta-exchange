/**
 * SETTLE A PAPER LEG WHOSE CONTRACT HAS EXPIRED (spec §WS1 1a).
 *
 * THE FAILURE. A paper book that misses its flatten keeps an expired leg
 * forever. No simulator will ever fill an order on a contract that no longer
 * trades, so the engine keeps emitting "past the flat-by — closing all 1
 * leg(s)" against it, the daily roll refuses to retire the book ("holds
 * legs"), and the only exit used to be `DELETE ?purge=1` — which destroys the
 * history the Reports page is built on. Seen on the box 2026-10-04: both
 * SENSEX 10-01 books holding `SENSEX26O0171800PE` three days after it expired,
 * and `TCS-2026-09-29-recenter-relief-r` holding `TCS26SEP2080PE` ×1125.
 *
 * WHAT IT DOES, per contract whose `expiry` is before today's IST date — and
 * every refusal below writes NOTHING (bar the cancel request in 3):
 *
 *   1. PRICE at intrinsic value against the underlying's close ON THE EXPIRY
 *      DATE — CE `max(0, close − strike)`, PE `max(0, strike − close)`, rounded
 *      to the instrument's tick. No close → 409 naming the leg. A settlement
 *      price is never guessed. (Where the close comes from: below.)
 *   2. CHECK THE LEDGER. The flatten and the DELETE guard size from the fills
 *      (`heldFromFills`); this sizes from `desk-books`. If the two disagree
 *      about THIS contract — or the fill read is unreadable or capped — 409.
 *      Per contract, not per book: a mismatch on another contract does not
 *      block this one (the erase will still refuse on it, as it should).
 *   3. NOTHING MAY STILL BE OUT on the contract. Every non-terminal gateway
 *      order on it gets a cancel filed through the queue `POST
 *      /v1/desk/broker/orders/:id/cancel` writes, and the call answers 409
 *      until those orders are terminal — a late real fill would otherwise
 *      close the leg on the ledger a second time.
 *   4. BOOK a synthetic close into `desk-decisions` — the journal P&L, the
 *      daily rollup and the DELETE guard all read — in the shape the flatten
 *      (`flatten.ts`) books its exits: one DONE decision carrying the fill,
 *      marked `source: 'settle'`, `desk_op: 'settle'`. The fill's own `op` is
 *      `'close'` (`FillOp` has no fifth member and the P&L engine nets on it).
 *      BOOKED ON THE EXPIRY DATE: the fill's `ts` AND the decision's
 *      `createdAt` are 15:30:00 IST that day (`loadFills` windows on
 *      `createdAt`, so a `createdAt` of today would keep the close out of the
 *      expiry-date rollup); `writtenAt` says when it was recorded. Then THIS
 *      book's report for the expiry date is re-written, so the day the contract
 *      died shows the close and `closingPositions: 0`, and the settlement day
 *      does not count it again.
 *   5. FOLD the close into `desk-books` with the same compare-and-set and the
 *      same conflict re-fold every other book writer uses, the decision id as
 *      the fold receipt — so a crash between 4 and 5 re-runs cleanly.
 *   6. AUDIT it, with the price and where the close came from.
 *
 * A LEG IN A LIVE CONTRACT IS LEFT EXACTLY WHERE IT IS. Settling is not
 * closing: it is recording what the exchange already did.
 *
 * PAPER ONLY. On the live rail settlement is the broker's.
 *
 * WHERE THE CLOSE COMES FROM. Every candidate carries its own timestamp, and
 * it must fall at or after 15:29 IST on the expiry date (`closeWindow`) — a
 * 13:00 tick before marketdata died is a price, not a close. In order:
 *
 *   a. `operator` — the request body's `{"close": <number>}`, when given. It is
 *      the operator stating the close, so it is used as given and recorded as
 *      theirs, in the decision and the audit entry. One close per request, so
 *      a book with legs on two expiry dates is a 400.
 *   b. `payoff-spot` — the CASH spot a `desk-payoff-snapshots` row carried
 *      (`payload.spot`, beside `payload.future`), any book on that underlying.
 *   c. `desk-marks` — the spot token's last price, only while that row's `ts`
 *      is still in the window. It is ONE row per token, re-stamped on every
 *      marketdata restart (every row read 2026-10-04 22:16 IST after Sunday's
 *      reboot), so for a past expiry it usually cannot answer.
 *   d. `future-mid` — a STOCK only: this book's own last `desk-book-marks` row
 *      of the day. Its `spot` is `ChainSnap.spot`, the FUTURE's mid, which on
 *      expiry day has all but converged — an approximation, and the response
 *      and audit say so. NEVER for an index: on 2026-10-01 the SENSEX book-mark
 *      read 72,487.75 against an index close of ~71,909.7, a basis that would
 *      settle a 72,400 put worth ~490 at 0. Index membership is the book's
 *      `symbol` against `INDEX_UNDERLYINGS`, never its tag.
 *
 * Nothing else → 409, naming the leg and the body that would settle it.
 *
 * Idempotent: a second call finds no expired leg and answers 200 with
 * `settled: []`.
 */

import { INDEX_UNDERLYINGS } from '@algomaker/instruments'
import { auditLog } from './audit.ts'
import { refoldOnConflict } from './book-write.ts'
import { closingSide, signedQty, type BridgeLeg, type DeskMode, type DeskSide, type Fill } from './contract.ts'
import { foldRoutedFillsIntoBook } from './decision-plan.ts'
import { notifySupervisor } from './engine-notify.ts'
import { isDuplicateKey } from './errors.ts'
import { heldFromFills } from './held-position.ts'
import { rollupDate } from './pnl-jobs.ts'
import { PnlStore } from './pnlstore.ts'
import { NON_TERMINAL_STATES } from './reconcile-live.ts'
import { isObject, istDate, type ApiDeps, type RouteCtx } from './routes/kit.ts'
import { isNse } from './venue.ts'
import { COLLECTIONS } from './store.ts'

/**
 * Where a close came from — see the header for the order and the rules.
 *
 *   payoff-spot  the cash spot a payoff snapshot carried
 *   desk-marks   the spot token's last price, when stamped in the close window
 *   future-mid   a STOCK book's own last mark (`ChainSnap.spot` = the future's
 *                mid) — an approximation, said so in the audit
 *   operator     the request body's `close`
 */
export type CloseSource = 'payoff-spot' | 'desk-marks' | 'future-mid' | 'operator'

/** A recorded price of the underlying on one IST date, and where it came from. */
export interface UnderlyingClose {
  readonly price: number
  /** Epoch ms the price was recorded at. */
  readonly at: number
  readonly source: CloseSource
}

/** One contract this call will settle. */
export interface PlannedSettle {
  readonly tradingsymbol: string
  /** Contract quantity to close — always positive. */
  readonly qty: number
  /** The CLOSING side: a long is closed by a Sell. */
  readonly side: DeskSide
  /** Intrinsic value, tick-rounded. */
  readonly price: number
  readonly expiry: string
  readonly strike: number
  readonly type: 'CE' | 'PE'
  readonly close: UnderlyingClose
  /** The leg id the close is booked against (the first leg on that contract). */
  readonly deskTag: string
  /**
   * The contract held legs on BOTH sides. The net is settled; the offsetting
   * legs that net to zero stay in `desk-books`, and the response says so.
   */
  readonly offsetting: boolean
}

export interface SettlementPlan {
  readonly settle: readonly PlannedSettle[]
  /**
   * Contracts that stay: a live contract, or a leg this pass cannot read well
   * enough to price (no strike, no type, no expiry, net zero). Named, never
   * dropped.
   */
  readonly blocked: readonly string[]
  /** Expired contracts with no close on their expiry date. Any one is a 409. */
  readonly unpriced: readonly { readonly tradingsymbol: string; readonly expiry: string }[]
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/**
 * Intrinsic value at expiry, rounded to the instrument's tick.
 *
 * Rounded to the NEAREST tick and then cleaned of float residue, so a price
 * written to the journal reads `35.15` and not `35.150000000000006`.
 */
export function intrinsicValue(input: {
  readonly type: 'CE' | 'PE'
  readonly strike: number
  readonly close: number
  readonly tickSize: number
}): number {
  const raw =
    input.type === 'CE' ? Math.max(0, input.close - input.strike) : Math.max(0, input.strike - input.close)
  const tick = Number.isFinite(input.tickSize) && input.tickSize > 0 ? input.tickSize : 0.05
  const ticks = Math.round(raw / tick)
  const decimals = Math.max(0, Math.ceil(-Math.log10(tick) - 1e-9))
  return Number((ticks * tick).toFixed(decimals))
}

/**
 * WHAT WOULD SETTLE, as data. No clock, no Mongo.
 *
 * Legs are grouped by contract and netted, because that is the unit a close
 * fill acts on (`applyRoutedFill` eats every offsetting leg on the contract).
 *
 * @param closes the underlying's close per IST date — only the dates of the
 *   expired legs need be present.
 * @param todayIst a contract whose expiry is BEFORE this date has expired; one
 *   expiring today is still live.
 */
export function planSettlement(
  book: { readonly legs: readonly BridgeLeg[] },
  closes: ReadonlyMap<string, UnderlyingClose>,
  todayIst: string,
): SettlementPlan {
  const byContract = new Map<string, BridgeLeg[]>()
  for (const l of book.legs) {
    const sym = l.instrument?.tradingsymbol ?? ''
    const list = byContract.get(sym)
    if (list === undefined) byContract.set(sym, [l])
    else list.push(l)
  }

  const settle: PlannedSettle[] = []
  const blocked: string[] = []
  const unpriced: { tradingsymbol: string; expiry: string }[] = []

  for (const [tradingsymbol, legs] of byContract) {
    const first = legs[0] as BridgeLeg
    const net = legs.reduce((sum, l) => sum + (Number.isFinite(l.qty) ? l.qty : Number.NaN), 0)
    const readable =
      tradingsymbol !== '' &&
      legs.every(
        (l) =>
          typeof l.expiry === 'string' &&
          l.expiry === first.expiry &&
          ISO_DATE.test(l.expiry) &&
          l.strike === first.strike &&
          Number.isFinite(l.strike) &&
          l.strike > 0 &&
          (l.type === 'CE' || l.type === 'PE') &&
          l.type === first.type,
      ) &&
      Number.isFinite(net)
    if (!readable) {
      blocked.push(tradingsymbol)
      continue
    }
    if (first.expiry >= todayIst) {
      // Still trading (a contract expiring TODAY trades until 15:40). Not ours.
      blocked.push(tradingsymbol)
      continue
    }
    if (net === 0) {
      // Opposite legs on one contract that net to nothing: there is no
      // position to settle, and no fill can remove two legs that cancel.
      blocked.push(tradingsymbol)
      continue
    }
    const close = closes.get(first.expiry)
    if (close === undefined || !Number.isFinite(close.price) || close.price <= 0) {
      unpriced.push({ tradingsymbol, expiry: first.expiry })
      continue
    }
    settle.push({
      tradingsymbol,
      qty: Math.abs(net),
      side: closingSide(net > 0 ? 'Buy' : 'Sell'),
      price: intrinsicValue({
        type: first.type,
        strike: first.strike,
        close: close.price,
        tickSize: first.instrument.tickSize,
      }),
      expiry: first.expiry,
      strike: first.strike,
      type: first.type,
      close,
      deskTag: first.deskTag,
      offsetting: legs.some((l) => l.qty > 0) && legs.some((l) => l.qty < 0),
    })
  }
  return { settle, blocked, unpriced }
}

/** 15:30:00 IST on an IST date — where a settlement is BOOKED. */
export function settlementInstant(dateIst: string): number {
  return Date.parse(`${dateIst}T15:30:00+05:30`)
}

/**
 * The window a price must have been recorded in to count as that date's close:
 * from 15:29:00 IST on the date to the end of the IST day. A 13:00 tick before
 * marketdata died is a price, not a close.
 */
export function closeWindow(dateIst: string): { readonly from: number; readonly to: number } {
  const start = Date.parse(`${dateIst}T00:00:00+05:30`)
  return { from: Date.parse(`${dateIst}T15:29:00+05:30`), to: start + 24 * 60 * 60 * 1000 }
}

/** The decision id a settlement is booked under — one per book, rail and contract. */
export function settleDecisionId(tag: string, mode: DeskMode, tradingsymbol: string): string {
  return `settle-${tag}-${mode}-${tradingsymbol}`
}

/**
 * The synthetic close fill, as `desk-decisions` stores it — stamped at 15:30
 * IST on the EXPIRY date, the moment the exchange settled it, so the day the
 * contract died carries its close and the day it was recorded does not.
 */
export function settleFill(s: PlannedSettle): Fill {
  return {
    op: 'close',
    deskTag: s.deskTag,
    tradingsymbol: s.tradingsymbol,
    side: s.side,
    qty: s.qty,
    price: s.price,
    ts: settlementInstant(s.expiry),
  }
}

// ──────────────────────────────────────────────────────────────── the route

/** The whole bag: the expiry-date rollup re-run needs what the P&L jobs need. */
export type SettleDeps = ApiDeps

/** The underlying's spot token's last price — one row per token, see the header. */
const DESK_MARKS = 'desk-marks'
/** What the payoff cockpit showed, `payload.spot` being the CASH spot. */
const PAYOFF_SNAPSHOTS = COLLECTIONS.payoffSnapshots
/** The supervisor's 5-minute journal of each book; its `spot` is the FUTURE's mid. */
const BOOK_MARKS = 'desk-book-marks'
/** The cancel queue `POST /v1/desk/broker/orders/:id/cancel` writes and the gateway drains. */
const BROKER_CANCELS = 'desk-broker-cancels'

/** An index underlying, by the book's `symbol` field — never by its tag. */
function isIndex(symbol: string): boolean {
  return INDEX_UNDERLYINGS.some((u) => u.symbol === symbol)
}

function positive(v: unknown): number | null {
  const n = Number(v)
  return typeof v === 'number' && Number.isFinite(n) && n > 0 ? n : null
}

/**
 * A RECORDED close of `symbol` on `dateIst`, or null — see the header.
 *
 * Every candidate must carry its own timestamp inside `closeWindow(dateIst)`.
 * The cash sources come first, for both kinds; the future-mid fallback is for
 * a STOCK only, because for an index the basis is hundreds of points.
 */
async function recordedClose(
  deps: SettleDeps,
  input: { symbol: string; tag: string; mode: DeskMode; dateIst: string },
): Promise<UnderlyingClose | null> {
  const { from, to } = closeWindow(input.dateIst)

  // 1. The cash spot a payoff snapshot carried — any book on this underlying.
  const snaps = await deps.db
    .collection<Record<string, unknown>>(PAYOFF_SNAPSHOTS)
    .find({ 'payload.symbol': input.symbol, ts: { $gte: from, $lt: to } })
    .sort({ ts: -1 })
    .limit(20)
    .toArray()
  for (const s of snaps) {
    const payload = (s['payload'] ?? {}) as Record<string, unknown>
    const price = positive(payload['spot'])
    const at = Number(payload['asOf'] ?? s['ts'])
    if (price !== null && Number.isFinite(at) && at >= from && at < to) {
      return { price, at, source: 'payoff-spot' }
    }
  }

  // 2. The spot token's last price — only while that row is still stamped in
  //    the window. It is re-stamped on every marketdata restart.
  const token = deps.master.current().spotToken(input.symbol)
  if (token !== null) {
    const row = await deps.db.collection<Record<string, unknown>>(DESK_MARKS).findOne({ token })
    const price = positive(row?.['price'])
    const at = Number(row?.['ts'])
    if (price !== null && Number.isFinite(at) && at >= from && at < to) {
      return { price, at, source: 'desk-marks' }
    }
  }

  // 3. A STOCK only: this book's own last mark of the day — the future's mid,
  //    which on expiry day has all but converged on the cash price.
  if (!isIndex(input.symbol)) {
    const marks = await deps.db
      .collection<Record<string, unknown>>(BOOK_MARKS)
      .find({ tag: input.tag, mode: input.mode, dateIst: input.dateIst })
      .sort({ ts: -1 })
      .limit(20)
      .toArray()
    for (const m of marks) {
      const price = positive(m['spot'])
      const at = Number(m['ts'])
      if (price !== null && Number.isFinite(at) && at >= from && at < to) {
        return { price, at, source: 'future-mid' }
      }
    }
  }
  return null
}

/** The newest broker order id on a gateway order — the only tranche that can still be working. */
function newestBrokerOrderId(doc: Record<string, unknown>): string {
  const ids = doc['brokerOrderIds']
  if (!Array.isArray(ids)) return ''
  for (let i = ids.length - 1; i >= 0; i--) {
    const id = ids[i]
    if (typeof id === 'string' && id !== '') return id
  }
  return ''
}

/**
 * Every order still OUT on this contract under this book — and a cancel filed
 * for each, through the same queue the Broker page's cancel button writes
 * (`routes/desk.ts`), which the gateway performs for paper and live alike. One
 * id per order (the newest tranche), for the reason `working-orders.ts` gives.
 */
async function cancelResting(
  deps: SettleDeps,
  ctx: RouteCtx,
  input: { tag: string; mode: DeskMode; tradingsymbol: string },
): Promise<{ working: number; requested: string[]; noBrokerId: string[] }> {
  const docs = await deps.db
    .collection<Record<string, unknown>>(COLLECTIONS.gatewayOrders)
    .find({
      tag: input.tag,
      mode: input.mode,
      tradingsymbol: input.tradingsymbol,
      state: { $in: NON_TERMINAL_STATES },
    })
    .toArray()
  const requested: string[] = []
  const noBrokerId: string[] = []
  for (const doc of docs) {
    const id = newestBrokerOrderId(doc)
    if (id === '') {
      noBrokerId.push(String(doc['clientOrderId'] ?? ''))
      continue
    }
    await deps.db.collection(BROKER_CANCELS).updateOne(
      { _id: id as never },
      {
        $set: { status: 'pending', requestedAt: deps.now(), error: '' },
        $setOnInsert: { requestedBy: ctx.principal.name },
      },
      { upsert: true },
    )
    requested.push(id)
  }
  return { working: docs.length, requested, noBrokerId }
}

/**
 * The close, in the journal P&L reads — claimed under a deterministic id so a
 * retry can never book it twice. Answers the fill that IS on the journal (the
 * earlier one, on a retry) and whether this call wrote it.
 *
 * BOTH STAMPS ARE THE EXPIRY DATE'S 15:30 IST: the fill's `ts` (which day's
 * report counts it) and the decision's `createdAt` (which day's fill READ
 * admits it — `loadFills` windows on it, so a `createdAt` of today would keep
 * the close out of the expiry-date rollup). `writtenAt` is when it was booked.
 */
async function journalSettle(
  deps: SettleDeps,
  input: { tag: string; mode: DeskMode; symbol: string; s: PlannedSettle; nowMs: number },
): Promise<{ decisionId: string; fill: Fill; createdAt: number; fresh: boolean }> {
  const { tag, mode, s, nowMs } = input
  const decisionId = settleDecisionId(tag, mode, s.tradingsymbol)
  const fill = settleFill(s)
  const createdAt = settlementInstant(s.expiry)
  const decisions = deps.db.collection<Record<string, unknown>>(COLLECTIONS.decisions)
  try {
    await decisions.insertOne({
      decisionId,
      symbol: input.symbol,
      expiry: s.expiry,
      mode,
      tag,
      fills: [fill],
      skips: [],
      createdAt,
      writtenAt: nowMs,
      completedAt: nowMs,
      status: 'DONE',
      source: 'settle',
      desk_op: 'settle',
      settlement: {
        rule: 'intrinsic',
        strike: s.strike,
        type: s.type,
        close: s.close.price,
        closeSource: s.close.source,
        closeAt: s.close.at,
      },
    })
    return { decisionId, fill, createdAt, fresh: true }
  } catch (err) {
    if (!isDuplicateKey(err)) throw err
  }
  // Already journalled: a retry after a crash before the book write, or a
  // concurrent call. The earlier record is the truth, never a second fill.
  const existing = await decisions.findOne({ decisionId })
  const prior = Array.isArray(existing?.['fills']) ? (existing['fills'] as Fill[])[0] : undefined
  if (existing === null || existing['source'] !== 'settle' || prior === undefined) {
    throw new Error(`decision id ${decisionId} is already taken by something that is not a settlement`)
  }
  return { decisionId, fill: prior, createdAt: Number(existing['createdAt']) || createdAt, fresh: false }
}

/**
 * Fold the close into `desk-books` — compare-and-set, the decision id as the
 * fold receipt, re-folded on a lost race. Reduces only, never creates.
 */
async function foldSettle(
  deps: SettleDeps,
  input: { tag: string; mode: DeskMode; decisionId: string; fill: Fill; nowMs: number },
): Promise<void> {
  const { tag, mode, decisionId, fill, nowMs } = input
  const doc = await deps.store.bookDoc(tag, mode)
  if (doc === null) return
  if ((doc.appliedCorrections ?? []).includes(decisionId)) return
  const folded = foldRoutedFillsIntoBook(doc.legs, [fill], nowMs)
  if (!folded.touched) return
  const key = { tag, mode, symbol: doc.symbol, expiry: doc.expiry }
  const saved = await deps.store.saveBook(key, folded.legs, nowMs, doc.updatedAt, decisionId)
  if (saved === 'conflict') {
    await refoldOnConflict({
      store: deps.store,
      key,
      routedFills: [fill],
      nextBook: folded.legs,
      priorBook: doc.legs,
      mayCreate: false,
      nowMs,
      nonce: decisionId,
      log: (m) => deps.log(m),
    })
  }
}

/**
 * Re-write THIS book's daily report for the expiry date, now that its close
 * is on that date — and no other book's: a past day is rolled up with no live
 * marks, so rewriting the whole day would degrade every other book's figure.
 * The production P&L jobs run with default options, and so does this.
 */
async function rerollExpiryDay(deps: SettleDeps, input: { tag: string; mode: DeskMode; dateIst: string; nowMs: number }): Promise<void> {
  const pnl = new PnlStore(deps.store)
  const reports = await rollupDate(deps, pnl, {}, input.dateIst, input.nowMs)
  for (const r of reports) {
    if (r.tag === input.tag && r.mode === input.mode) await pnl.writeReport(r)
  }
}

const REFUSED = 'NOTHING WAS SETTLED.'

/**
 * `POST /v1/desk/books/registry/:tag/settle-expired?mode=paper`, optional body
 * `{ "close": <number> }`.
 *
 * 200 `{ tag, mode, settled: [...], remaining, cancelRequested }`; 400 for a
 * live row, an unstated mode or a bad `close`; 404 for an unknown book; 409
 * `{ error, leg }` when a settlement price cannot be established, when the
 * fills ledger disagrees with `desk-books` about the contract, or while an
 * order is still out on it — and then nothing is written but the cancel.
 */
export async function handleSettleExpired(deps: SettleDeps, ctx: RouteCtx, tag: string): Promise<boolean> {
  const { send } = ctx
  /**
   * ON DX THIS IS THE GATEWAY'S JOB, NOT THIS ROUTE'S. Delta settles every
   * expiry itself at 12:00 UTC on the 30-minute TWAP of its index, and the
   * gateway's settlement job books each expired leg — paper and live alike —
   * at the price Delta publishes, alerting when it is late and never inventing
   * one. Intrinsic against an underlying close is NSE's method, and a second
   * booking of the same expiry here would close the leg twice.
   */
  if (!isNse(deps.venue)) {
    send(409, {
      error:
        'Delta settles every expiry itself: the gateway books each expired leg at the settlement ' +
        "price Delta publishes. Nothing is settled here on this venue.",
    })
    return true
  }
  // Stated, never defaulted — the DELETE's rule (`requiredModeParam`).
  const raw = ctx.url.searchParams.get('mode')
  if (raw !== 'paper' && raw !== 'live') {
    send(400, { error: "mode must be stated explicitly as '?mode=paper'" })
    return true
  }
  if (raw !== 'paper') {
    send(400, {
      error:
        "settle-expired is paper only — on the live rail settlement is the broker's, and the desk " +
        'records what the broker reports rather than getting ahead of it',
    })
    return true
  }
  const mode: DeskMode = raw
  const body = await ctx.readJson()
  const given = isObject(body) ? body['close'] : undefined
  const operatorClose = given === undefined ? null : positive(given)
  if (given !== undefined && operatorClose === null) {
    send(400, { error: '`close` must be a positive number — the underlying\'s close on the expiry date' })
    return true
  }
  const row = await deps.store.getBook(tag, mode)
  if (row === null) {
    send(404, { error: `'${tag}' has no book registered in ${mode}` })
    return true
  }

  const nowMs = deps.now()
  const todayIst = istDate(nowMs)
  const doc = await deps.store.bookDoc(tag, mode)
  const legs = doc?.legs ?? []
  const symbol = doc?.symbol ?? row.symbol

  // ─── the price ───
  const dates = [...new Set(legs.map((l) => l.expiry).filter((e) => typeof e === 'string' && e < todayIst))].sort()
  if (operatorClose !== null && dates.length > 1) {
    send(400, {
      error:
        `this book holds legs that expired on ${dates.join(' and ')} — one \`close\` cannot be the ` +
        `underlying's close on more than one date. ${REFUSED}`,
    })
    return true
  }
  const closes = new Map<string, UnderlyingClose>()
  for (const dateIst of dates) {
    const close =
      operatorClose !== null
        ? { price: operatorClose, at: nowMs, source: 'operator' as const }
        : await recordedClose(deps, { symbol, tag, mode, dateIst })
    if (close !== null) closes.set(dateIst, close)
  }

  const plan = planSettlement({ legs }, closes, todayIst)
  if (plan.unpriced.length > 0) {
    const first = plan.unpriced[0] as { tradingsymbol: string; expiry: string }
    send(409, {
      error:
        `no close for ${symbol} on ${first.expiry} stamped at or after 15:29 IST — ` +
        (isIndex(symbol)
          ? 'no payoff-snapshot cash spot and no desk-marks price in that window (an index is never settled off the future) — '
          : 'no cash spot, and no mark of this book, in that window — ') +
        `so ${first.tradingsymbol} cannot be settled at intrinsic. Supply the close with ` +
        `{"close": <${symbol} close on ${first.expiry}>}. ${REFUSED} A settlement price is never guessed.`,
      leg: first.tradingsymbol,
      legs: plan.unpriced,
    })
    return true
  }

  // ─── the ledger must agree, contract by contract ───
  if (plan.settle.length > 0) {
    const ledger = await heldFromFills(deps.store, tag, mode)
    if (ledger.unreadable.length > 0 || ledger.capped) {
      send(409, {
        error:
          `the fills ledger for '${tag}' cannot be read in full (${ledger.capped ? 'the read hit its cap' : ledger.unreadable.join('; ')}) ` +
          `— a settlement sized from desk-books could not be checked against it. ${REFUSED}`,
        leg: plan.settle[0]?.tradingsymbol,
      })
      return true
    }
    for (const s of plan.settle) {
      const booksNet = legs
        .filter((l) => l.instrument.tradingsymbol === s.tradingsymbol)
        .reduce((sum, l) => sum + l.qty, 0)
      let ledgerNet = ledger.held.find((h) => h.tradingsymbol === s.tradingsymbol)?.qty ?? 0
      // A settlement already journalled but not yet folded (a crash between
      // the two): the ledger already carries its close, desk-books does not.
      // Compare against the ledger as it stood before that close.
      const prior = await deps.db
        .collection<Record<string, unknown>>(COLLECTIONS.decisions)
        .findOne({ decisionId: settleDecisionId(tag, mode, s.tradingsymbol), source: 'settle' })
      const priorFill = Array.isArray(prior?.['fills']) ? (prior['fills'] as Fill[])[0] : undefined
      if (priorFill !== undefined) ledgerNet -= signedQty(priorFill.side, priorFill.qty)
      if (booksNet !== ledgerNet) {
        send(409, {
          error:
            `desk-books holds ${booksNet} ${s.tradingsymbol} but the fills ledger nets to ${ledgerNet} — ` +
            `the two disagree about this contract, so a close sized from either could be wrong. Reconcile ` +
            `it first. ${REFUSED}`,
          leg: s.tradingsymbol,
          booksNet,
          ledgerNet,
        })
        return true
      }
    }
  }

  // ─── nothing may still be out on a contract being settled ───
  const cancelRequested: string[] = []
  const uncancellable: string[] = []
  let waitingOn: string | null = null
  for (const s of plan.settle) {
    const cancels = await cancelResting(deps, ctx, { tag, mode, tradingsymbol: s.tradingsymbol })
    cancelRequested.push(...cancels.requested)
    uncancellable.push(...cancels.noBrokerId)
    if (cancels.working > 0 && waitingOn === null) waitingOn = s.tradingsymbol
  }
  if (waitingOn !== null) {
    send(409, {
      error:
        `an order is still out on ${waitingOn} — a late fill would close the leg on the ledger a second ` +
        `time. A cancel was requested (${cancelRequested.join(', ') || 'none possible: no broker id yet'}); ` +
        `retry once it is terminal. ${REFUSED}`,
      leg: waitingOn,
      cancelRequested,
      ...(uncancellable.length === 0 ? {} : { uncancellable }),
    })
    return true
  }

  // ─── book it ───
  const settled: Record<string, unknown>[] = []
  for (const s of plan.settle) {
    // THE RECORD FIRST, THE BOOK SECOND — `paper-fold.ts`'s ordering, for its
    // reason: a crash after the journal leaves the money right and only the
    // derived book behind, and a re-run folds it once.
    const booked = await journalSettle(deps, { tag, mode, symbol, s, nowMs })
    await foldSettle(deps, { tag, mode, decisionId: booked.decisionId, fill: booked.fill, nowMs })
    if (booked.fresh && deps.book !== undefined) {
      try {
        deps.book.onJournal({ tag, mode, createdAt: booked.createdAt, fills: [booked.fill] })
      } catch {
        /* a stale dashboard is an inconvenience; the record is already right */
      }
    }
    settled.push({
      tradingsymbol: s.tradingsymbol,
      qty: booked.fill.qty,
      side: booked.fill.side,
      price: booked.fill.price,
      source: 'intrinsic',
      expiry: s.expiry,
      strike: s.strike,
      type: s.type,
      close: s.close.price,
      closeSource: s.close.source,
      closeAt: s.close.at,
      decisionId: booked.decisionId,
      ...(s.close.source === 'future-mid'
        ? { closeNote: "approximated by the future's mid at the last mark of expiry day, not the cash close" }
        : {}),
      ...(s.offsetting
        ? { note: 'the contract held offsetting legs: the NET was settled, and legs netting to zero remain in desk-books' }
        : {}),
    })
  }

  // The expiry date's report now has a close to show — this book's only.
  for (const dateIst of new Set(plan.settle.map((s) => s.expiry))) {
    try {
      await rerollExpiryDay(deps, { tag, mode, dateIst, nowMs })
    } catch (err) {
      deps.log('settle: the expiry-date rollup could not be rewritten', { tag, dateIst, error: String(err) })
    }
  }

  const after = await deps.store.bookDoc(tag, mode)
  const remaining = (after?.legs ?? []).filter((l) => l.qty !== 0).length

  if (settled.length > 0) {
    deps.log('book expired legs SETTLED', { tag, mode, legs: settled.length, remaining })
    await auditLog(deps).record({
      principal: ctx.principal,
      source: '/v1/desk/books/registry/:tag/settle-expired',
      action: 'settled expired legs of a book',
      tag,
      mode,
      detail: { settled, remaining, ...(operatorClose === null ? {} : { operatorClose }) },
    })
    // The book moved under a supervisor that may still be steering it.
    await notifySupervisor('fill', { tag, mode, source: 'settle' }, { log: deps.log })
  }
  send(200, { tag, mode, settled, remaining, cancelRequested })
  return true
}
