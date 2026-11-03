/**
 * THE MONTHLY STOCK BOOKS — TCS, TATASTEEL, KALYANKJIL — THE SEPTEMBER WAY,
 * WRITTEN DOWN, AND NOT ONE OF THEM LIVE.
 *
 * On 2026-09-07 13:20–13:27 IST three `recenter-relief-r` paper books were put
 * on the desk by hand, through the API, in two phases. This script is those
 * two phases, so that October (and every month after) is a command rather
 * than a recollection:
 *
 *     node scripts/stock-books.mjs --register            # dry run: the three bodies
 *     node scripts/stock-books.mjs --register --apply    # create, start, switch on
 *     node scripts/stock-books.mjs --open                # dry run: strikes off the snapshot
 *     node scripts/stock-books.mjs --open --apply        # 09:20–15:00 IST: buy, sell, seed
 *     node scripts/stock-books.mjs --help
 *
 * `docs/runbooks/stock-books.md` is the procedure around it.
 *
 * ── PHASE 1, --register: THE SAME THREE CALLS AS THE DELTA-LEAN BOOKS ───────
 *
 * Per book: `POST /v1/desk/books/registry` (lands `desired: stopped`), `POST
 * .../:tag/start {mode:'paper'}`, `PATCH /v1/desk/strategies/:tag
 * {modes:{paper:{enabled:true}}}` — unconditionally, for the reason the
 * sibling gives (a running book that is switched off has every order refused).
 * Safe on a Sunday: a recenter book with no legs decides nothing. Registering
 * is also what makes desk-marketdata subscribe the October chain
 * (`registrySubscriptionBooks`), which `--open` needs priced on Monday.
 *
 * The tag is `<SYMBOL>-<expiry>-recenter-relief-r`, as in September. The
 * dials are September's, exactly. `series` (`<SYMBOL>-recenter-relief-r`) is
 * sent ONLY when `GET /v1/desk/books/registry?mode=paper` already returns rows
 * carrying a `series` field — i.e. the desk runs the build that knows it. That
 * read is an --apply-only step; a dry run says what it would decide.
 *
 * ── PHASE 2, --open: RECENTER NEVER OPENS ITS OWN POSITION ──────────────────
 *
 * The playbook manages delta from a position it is handed (2026-07-30 recenter
 * spec). So the initial structure — a short ATM straddle with long wings at
 * about ±9 % of spot — is opened here, the September way:
 *
 *   1. REFUSE before anything is built: outside 09:20–15:00 IST, on a day the
 *      engine's calendar says is not a session, when a book is not registered
 *      and running, when a book already holds legs, or when its tag has
 *      traded at all. The last one matters: submits under a tag with no
 *      `desk-books` document do not create one, so a half-finished earlier
 *      open leaves fills and an EMPTY book, and only the trades show it.
 *   2. READ each October chain (`GET /v1/desk/chain/:symbol?expiry=`): the
 *      future's live mark is spot, ATM is the listed strike nearest it, the
 *      wings the listed strikes nearest spot × 0.91 (PE) and × 1.09 (CE). All
 *      three books are planned, and every one of the twelve contracts must
 *      have a live quote, before the first order of the first book goes out.
 *   3. SUBMIT four orders per book through `POST /v1/desk/submit`, wings
 *      first — Buy wing CE, Buy wing PE, Sell ATM CE, Sell ATM PE — sized
 *      5 / 5 / 2 lots (TCS / TATASTEEL / KALYANKJIL) with `exactLots`. No
 *      `orderType`: the desk prices a marketable limit with the same dials
 *      the decision path uses, so this script never invents a price.
 *   4. WAIT for the fills (`GET /v1/desk/trades?tag=&mode=paper`), then
 *   5. SEED (`POST /v1/desk/seed`, `replace: false`) the four legs at the
 *      FILLED rates, shorts negative — which is what makes the book hold them.
 *
 * The `clientOrderId` is deterministic per tag, contract and side, so a
 * resent submit is a replay at the API, never a second order.
 *
 * ── PAPER, AND THERE IS NO FLAG THAT SAYS OTHERWISE ─────────────────────────
 *
 * The sibling's five layers, with its `PAPER` imported rather than restated:
 *   1. `mode` is a module constant, never an argument or variable.
 *   2. Every registry read asks for `?mode=paper`, and a row that comes back
 *      any other mode is a throw.
 *   3. `assertAllPaper` on the planned books; every submit and seed body is
 *      built with `PAPER`.
 *   4. Each body is re-checked in the line before its POST.
 *   5. Start sends the literal `{"mode":"paper"}`, every read `?mode=paper`,
 *      and a create whose echo carries another mode aborts.
 *
 * Nothing here parses a tag: membership comes from the registry row's own
 * `symbol`, `expiry`, `variant` and `mode`.
 *
 * Tested by `apps/api/test/stock-books.test.ts`. Everything above `main()` is
 * pure or takes its I/O as an argument; Mongo is imported lazily inside it.
 */

import { fileURLToPath } from 'node:url'
import { resolve as resolvePath } from 'node:path'
import { isTradingDay } from '@algomaker/desk-engine'
import { PAPER, PAPER_ON, STRATEGIES, assertAllPaper, istDate, requestJson } from './delta-lean-books.mjs'

// ─────────────────────────────────────────────────────────────── the constants

const REGISTRY = '/v1/desk/books/registry'
const SUBMIT = '/v1/desk/submit'
const SEED = '/v1/desk/seed'
const POSITIONS = '/v1/desk/positions'
const TRADES = '/v1/desk/trades'
const CHAIN = '/v1/desk/chain'
const KILLSWITCH = '/v1/desk/killswitch'
const DEFAULT_API = 'http://127.0.0.1:8890'
const DEFAULT_MONGO = 'mongodb://127.0.0.1:27017/algomaker_dx'

/** The playbook every one of these books runs. */
const VARIANT = 'recenter-relief-r'

/**
 * September's dials, exactly as the 2026-09-07 audit log recorded them. The
 * shorts-only pair makes the rules steer by the short legs and treat the
 * wings as hedge only.
 */
const DIALS = Object.freeze({
  margin_cap: 5_000_000,
  target_pnl: 50_000,
  delta_shorts_only: true,
  gamma_shorts_only: true,
})

/** The three books, in the order they are registered and opened, and their size. */
const STOCKS = Object.freeze([
  Object.freeze({ symbol: 'TCS', lots: 5 }),
  Object.freeze({ symbol: 'TATASTEEL', lots: 5 }),
  Object.freeze({ symbol: 'KALYANKJIL', lots: 2 }),
])

/** Wing distance as a fraction of spot. */
const WING_PCT = 0.09

/** The --open window, in IST minutes of the day: [09:20, 15:00). */
const OPEN_FROM_MIN = 9 * 60 + 20
const OPEN_UNTIL_MIN = 15 * 60
const IST_OFFSET_MS = (5 * 60 + 30) * 60_000
const DAY_MS = 86_400_000

/** How long to wait for the paper fills before giving up (paper fills synchronously). */
const POLL_ATTEMPTS = 10
const POLL_MS = 1000

/**
 * The deadline on every request --apply makes. A desk that accepts the
 * connection and never answers (a restart mid-request) must stop the run with
 * a message, not hang it with orders possibly routed.
 */
const REQUEST_TIMEOUT_MS = 15_000

/** The future's mark must have ticked within this long of the plan. */
const FUTURE_MAX_AGE_MS = 120_000
/** A leg quote must be from today's session: at or after 09:15 IST. */
const SESSION_FROM_MIN = 9 * 60 + 15

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
/** Float noise on spot × 0.91 must not decide a tie. */
const EPS = 1e-9

/**
 * @typedef {{ tag: string, symbol: string, expiry: string, mode: string, variant: string, dials: Record<string, number | boolean>, series?: string }} BookPlan
 * @typedef {{ tradingsymbol: string, instrumentToken: number, lotSize: number, tickSize: number, exchange: string }} Contract
 * @typedef {{ price: number, asOf?: number } | null} Quote
 * @typedef {{ strike: number, CE: Quote, PE: Quote, ceContract?: Contract, peContract?: Contract }} ChainRow
 * @typedef {{ underlying: string, expiry: string, future: number | null, futureAsOf?: number | null, lotSize: number | null, rows: readonly ChainRow[] }} Chain
 * @typedef {{ strike: number, type: 'CE' | 'PE', side: 'Buy' | 'Sell', qty: number, tradingsymbol: string | null, price: number | null }} OpenLeg
 * @typedef {{ tag: string, symbol: string, expiry: string, mode: string, spot: number | null, lots: number, atm: number | null, wingLo: number | null, wingHi: number | null, legs: OpenLeg[], orders: Record<string, unknown>[], problems: string[] }} OpenPlan
 * @typedef {{ status: number, body: unknown, text: string }} WireResult
 * @typedef {(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown) => Promise<WireResult>} Request
 */

// ───────────────────────────────────────────────────────────────── pure logic

/**
 * The three `BookCreate` bodies for one monthly expiry.
 *
 * Pure: the expiry is an argument (main resolves it from the instrument
 * master), so the plan can be printed and tested without a clock or a desk.
 *
 * @param {string} expiry `YYYY-MM-DD`
 * @param {{ series?: boolean }} [opts] `series: true` only when the registry
 *   already carries the field — see `registrySupportsSeries`.
 * @returns {readonly BookPlan[]}
 */
export function planStockBooks(expiry, opts = {}) {
  if (typeof expiry !== 'string' || !ISO_DATE.test(expiry)) {
    throw new Error(`the expiry must be a 'YYYY-MM-DD' date, got ${JSON.stringify(expiry)}`)
  }
  const withSeries = opts.series === true
  return assertAllPaper(
    STOCKS.map(({ symbol }) => ({
      // The September shape. Built here; never parsed anywhere.
      tag: `${symbol}-${expiry}-${VARIANT}`,
      symbol,
      expiry,
      mode: PAPER,
      variant: VARIANT,
      dials: { ...DIALS },
      ...(withSeries ? { series: `${symbol}-${VARIANT}` } : {}),
    })),
  )
}

/**
 * Whether the desk's registry knows `series`: true only when a row it
 * returned carries one. An empty registry proves nothing, and then the field
 * is not sent — a build that knows it derives the same `<symbol>-<variant>`.
 *
 * @param {readonly Record<string, unknown>[]} rows
 */
export function registrySupportsSeries(rows) {
  return rows.some((r) => typeof r?.['series'] === 'string')
}

/**
 * Lots per order for a symbol — September's sizes.
 *
 * @param {string} symbol
 * @returns {number}
 */
export function sizeLots(symbol) {
  const found = STOCKS.find((s) => s.symbol === symbol)
  if (found === undefined) {
    throw new Error(`${symbol} is not one of this script's books (${STOCKS.map((s) => s.symbol).join(', ')})`)
  }
  return found.lots
}

/**
 * The books `--only` names (repeatable), in their usual order — or all of
 * them when none is named. An unknown symbol is refused, never ignored: a
 * typo must not quietly open nothing, or everything.
 *
 * @param {readonly BookPlan[]} books
 * @param {readonly string[]} only
 * @returns {readonly BookPlan[]}
 */
export function selectBooks(books, only) {
  for (const symbol of only) sizeLots(symbol)
  return only.length === 0 ? books : books.filter((b) => only.includes(b.symbol))
}

/**
 * The listed strike nearest `target`; on an exact tie, the lower one, or the
 * higher one when `tie` is 'up'.
 *
 * @param {readonly number[]} sorted ascending
 * @param {number} target
 * @param {'down' | 'up'} tie
 */
function nearest(sorted, target, tie) {
  let best = /** @type {number | null} */ (null)
  let bestD = Infinity
  for (const k of sorted) {
    const d = Math.abs(k - target)
    if (d < bestD - EPS || (tie === 'up' && Math.abs(d - bestD) <= EPS)) {
      best = k
      bestD = d
    }
  }
  return /** @type {number} */ (best)
}

/**
 * ATM and the two wings, off the strikes the exchange actually LISTS.
 *
 * ATM is the listed strike nearest spot (a tie goes down). The wings are the
 * listed strikes nearest spot × (1 − 0.09) and spot × (1 + 0.09), and a tie
 * goes OUTWARD, so a wing is never pulled inside its 9 %. No step rule: stock
 * chains change spacing toward the edges and list half-steps (TATASTEEL
 * 177.5), so a computed step would name contracts that do not exist.
 *
 * @param {{ spot: number, strikes: readonly number[] }} input
 * @returns {{ atm: number, wingLo: number, wingHi: number }}
 */
export function chooseStrikes({ spot, strikes }) {
  if (typeof spot !== 'number' || !Number.isFinite(spot) || spot <= 0) {
    throw new Error(`spot must be a positive price, got ${JSON.stringify(spot)}`)
  }
  const sorted = [...new Set(strikes.filter((k) => typeof k === 'number' && Number.isFinite(k)))].sort(
    (a, b) => a - b,
  )
  if (sorted.length === 0) throw new Error('no listed strikes to choose from')
  const atm = nearest(sorted, spot, 'down')
  const wingLo = nearest(sorted, spot * (1 - WING_PCT), 'down')
  const wingHi = nearest(sorted, spot * (1 + WING_PCT), 'up')
  if (!(wingLo < atm && atm < wingHi)) {
    throw new Error(
      `the listed strikes cannot put a wing on each side of the ATM ${atm} at spot ${spot} ` +
        `(wings ${wingLo} / ${wingHi}) — refusing to open a structure without both hedges`,
    )
  }
  return { atm, wingLo, wingHi }
}

/**
 * Why `--open` may not run at `nowMs`, or null when it may: a trading day by
 * the engine's own calendar, between 09:20 and 15:00 IST. Opening before
 * 09:20 prices off the opening auction's noise; after 15:00 the desk is
 * flattening and the session is ending.
 *
 * @param {number} nowMs epoch ms
 * @param {(dateIst: string) => boolean} [isTrading] stubbed only by the tests
 * @returns {string | null}
 */
export function openWindowRefusal(nowMs, isTrading = isTradingDay) {
  const day = istDate(nowMs)
  if (!isTrading(day)) {
    return `${day} is not a trading day (weekend or NSE holiday) — --open runs only in a session`
  }
  const minute = Math.floor((((nowMs + IST_OFFSET_MS) % DAY_MS) + DAY_MS) % DAY_MS / 60_000)
  if (minute < OPEN_FROM_MIN || minute >= OPEN_UNTIL_MIN) {
    const hh = String(Math.floor(minute / 60)).padStart(2, '0')
    const mm = String(minute % 60).padStart(2, '0')
    return `it is ${hh}:${mm} IST — --open runs only between 09:20 and 15:00 IST`
  }
  return null
}

/**
 * Open legs in a `GET /v1/desk/positions?tag=` answer, or null when the
 * answer cannot be read (which is not the same as flat).
 *
 * @param {unknown} positions
 * @returns {number | null}
 */
export function heldLegCount(positions) {
  const legs = /** @type {{ legs?: unknown } | null} */ (positions)?.legs
  if (!Array.isArray(legs)) return null
  let open = 0
  for (const leg of legs) {
    const qty = /** @type {{ qty?: unknown }} */ (leg ?? {}).qty
    if (typeof qty !== 'number' || !Number.isFinite(qty)) return null
    if (qty !== 0) open += 1
  }
  return open
}

/**
 * The four entry orders for one registered book, off one chain read.
 *
 * Pure. Never throws for a missing quote or contract: it records the reason in
 * `problems`, so a dry run can show the whole plan and say what --apply would
 * refuse. `openBooks` refuses any plan with a problem before the first order.
 *
 * FRESHNESS is part of "has a live quote": the future's mark must be at most
 * two minutes old at `nowMs`, and each leg's quote must be from today's
 * session (09:15 IST on). A cache can still hold a price from a previous
 * session for a contract that has not traded today, and that is not a price.
 *
 * @param {BookPlan} book
 * @param {Chain} chain
 * @param {{ nowMs: number }} opts
 * @returns {OpenPlan}
 */
export function planOpen(book, chain, opts) {
  const nowMs = opts?.nowMs
  if (typeof nowMs !== 'number' || !Number.isFinite(nowMs)) {
    throw new Error('planOpen needs opts.nowMs — freshness is judged against the moment of the plan')
  }
  const sessionFrom = Math.floor((nowMs + IST_OFFSET_MS) / DAY_MS) * DAY_MS - IST_OFFSET_MS + SESSION_FROM_MIN * 60_000
  if (book.mode !== PAPER) {
    throw new Error(`REFUSED: ${book.tag} is mode ${JSON.stringify(book.mode)} — this script opens paper books only`)
  }
  if (chain.underlying !== book.symbol || chain.expiry !== book.expiry) {
    throw new Error(
      `the chain read for ${book.tag} is ${chain.underlying} ${chain.expiry}, not ${book.symbol} ${book.expiry}`,
    )
  }
  const lots = sizeLots(book.symbol)
  /** @type {string[]} */
  const problems = []
  const base = { tag: book.tag, symbol: book.symbol, expiry: book.expiry, mode: PAPER, lots }
  const spot = chain.future
  if (typeof spot !== 'number' || !Number.isFinite(spot) || spot <= 0) {
    problems.push(`no live mark for the ${book.symbol} future — cannot place the ATM`)
    return { ...base, spot: null, atm: null, wingLo: null, wingHi: null, legs: [], orders: [], problems }
  }
  const futureAsOf = chain.futureAsOf
  if (typeof futureAsOf !== 'number' || !Number.isFinite(futureAsOf)) {
    problems.push(`the ${book.symbol} future's mark has no timestamp — cannot tell it is live`)
  } else if (nowMs - futureAsOf > FUTURE_MAX_AGE_MS) {
    problems.push(
      `the ${book.symbol} future's mark is ${Math.round((nowMs - futureAsOf) / 1000)} s old ` +
        `(more than ${FUTURE_MAX_AGE_MS / 1000} s) — not a live price`,
    )
  }
  const { atm, wingLo, wingHi } = chooseStrikes({ spot, strikes: chain.rows.map((r) => r.strike) })

  // Wings FIRST, then the straddle — the September order, and the one that
  // never leaves a naked short while the hedge is still being bought.
  /** @type {ReadonlyArray<{ strike: number, type: 'CE' | 'PE', side: 'Buy' | 'Sell' }>} */
  const specs = [
    { strike: wingHi, type: 'CE', side: 'Buy' },
    { strike: wingLo, type: 'PE', side: 'Buy' },
    { strike: atm, type: 'CE', side: 'Sell' },
    { strike: atm, type: 'PE', side: 'Sell' },
  ]
  /** @type {OpenLeg[]} */
  const legs = []
  /** @type {Record<string, unknown>[]} */
  const orders = []
  for (const s of specs) {
    const row = chain.rows.find((r) => r.strike === s.strike)
    const contract = s.type === 'CE' ? row?.ceContract : row?.peContract
    const quote = row === undefined ? null : row[s.type]
    const price = quote !== null && typeof quote?.price === 'number' && quote.price > 0 ? quote.price : null
    if (contract === undefined) {
      problems.push(`the master lists no ${book.symbol} ${book.expiry} ${s.strike} ${s.type}`)
      legs.push({ ...s, qty: 0, tradingsymbol: null, price })
      continue
    }
    if (!Number.isInteger(contract.lotSize) || contract.lotSize <= 0) {
      problems.push(`${contract.tradingsymbol} has no usable lot size (${JSON.stringify(contract.lotSize)})`)
      legs.push({ ...s, qty: 0, tradingsymbol: contract.tradingsymbol, price })
      continue
    }
    if (price === null) problems.push(`no live quote for ${contract.tradingsymbol}`)
    else if (typeof quote?.asOf !== 'number' || !Number.isFinite(quote.asOf)) {
      problems.push(`the quote for ${contract.tradingsymbol} has no timestamp`)
    } else if (quote.asOf < sessionFrom) {
      problems.push(`the quote for ${contract.tradingsymbol} is from before 09:15 IST today`)
    }
    legs.push({ ...s, qty: lots * contract.lotSize, tradingsymbol: contract.tradingsymbol, price })
    orders.push({
      tag: book.tag,
      mode: PAPER,
      // Deterministic: the same tag, contract and side is the same order, so
      // a resend replays at the API instead of placing twice.
      clientOrderId: `entry-${book.tag}-${contract.tradingsymbol}-${s.side}`,
      instrument: {
        tradingsymbol: contract.tradingsymbol,
        instrumentToken: contract.instrumentToken,
        lotSize: contract.lotSize,
        tickSize: contract.tickSize,
        exchange: contract.exchange,
      },
      side: s.side,
      lots,
      // A positional book's leg: sized exactly as asked (spec §7.4).
      exactLots: true,
      underlying: book.symbol,
      ...(price === null ? {} : { referencePrice: price }),
    })
  }
  return { ...base, spot, atm, wingLo, wingHi, legs, orders, problems }
}

/**
 * The seed body that records what filled. `replace: false`, stated: this
 * adds legs to an empty book, it never overwrites one.
 *
 * @param {OpenPlan} plan
 * @param {readonly { strike: number, type: 'CE' | 'PE', qty: number, rate: number }[]} legs
 */
export function seedBody(plan, legs) {
  return {
    tag: plan.tag,
    symbol: plan.symbol,
    expiry: plan.expiry,
    mode: PAPER,
    replace: false,
    legs: legs.map((l) => ({ strike: l.strike, type: l.type, qty: l.qty, rate: l.rate })),
  }
}

/**
 * The filled legs, or what is still missing, from the trades of one tag.
 *
 * A submitted order is filled when every tranche the submit reported has a
 * `COMPLETE` paper trade; its rate is the quantity-weighted price of those
 * trades. Signed for the seed: bought legs positive, sold legs negative.
 *
 * @param {OpenPlan} plan
 * @param {readonly { orders: readonly { clientOrderId: string }[] }[]} submitted aligned with `plan.orders`
 * @param {readonly Record<string, unknown>[]} trades
 * @returns {{ legs: { strike: number, type: 'CE' | 'PE', qty: number, rate: number }[] | null, pending: string[], failed: string[] }}
 */
export function filledLegs(plan, submitted, trades) {
  /** @type {string[]} */
  const pending = []
  /** @type {string[]} */
  const failed = []
  /** @type {{ strike: number, type: 'CE' | 'PE', qty: number, rate: number }[]} */
  const legs = []
  plan.orders.forEach((order, i) => {
    const instrument = /** @type {{ tradingsymbol: string }} */ (order['instrument'])
    const leg = plan.legs.find((l) => l.tradingsymbol === instrument.tradingsymbol && l.side === order['side'])
    const tranches = submitted[i]?.orders ?? []
    if (leg === undefined || tranches.length === 0) {
      failed.push(`${String(order['clientOrderId'])}: no routed tranche to wait for`)
      return
    }
    // Per ORDER, so one order still waiting never hides another's state.
    let waiting = false
    let broken = false
    let qty = 0
    let value = 0
    for (const t of tranches) {
      const row = trades.find((r) => r['clientOrderId'] === t.clientOrderId)
      const status = row === undefined ? 'MISSING' : String(row['status'])
      if (status === 'REJECTED' || status === 'CANCELLED') {
        failed.push(`${t.clientOrderId}: ${status}`)
        broken = true
        continue
      }
      if (row === undefined || status !== 'COMPLETE') {
        pending.push(t.clientOrderId)
        waiting = true
        continue
      }
      const filled = Number(row['filled_quantity'] ?? row['quantity'])
      const price = Number(row['price'])
      if (!Number.isFinite(filled) || filled <= 0 || !Number.isFinite(price) || price <= 0) {
        failed.push(`${t.clientOrderId}: unreadable fill (${JSON.stringify({ filled, price })})`)
        broken = true
        continue
      }
      qty += filled
      value += filled * price
    }
    if (waiting || broken) return
    if (qty !== leg.qty) {
      failed.push(`${leg.tradingsymbol}: filled ${qty}, expected ${leg.qty}`)
      return
    }
    legs.push({
      strike: leg.strike,
      type: leg.type,
      qty: leg.side === 'Buy' ? qty : -qty,
      // Four decimals strip float noise (3.3499999999999996) without moving a tick.
      rate: Math.round((value / qty) * 10_000) / 10_000,
    })
  })
  const done = pending.length === 0 && failed.length === 0 && legs.length === plan.orders.length
  return { legs: done ? legs : null, pending, failed }
}

// ─────────────────────────────────────────────────────────────────── the wire

/**
 * The paper registry, re-checked row by row (layer 2).
 *
 * @param {Request} request
 * @returns {Promise<Record<string, unknown>[]>}
 */
async function readRegistry(request) {
  const res = await request('GET', `${REGISTRY}?mode=${PAPER}`)
  if (res.status !== 200) throw new Error(`reading the registry failed: HTTP ${res.status} ${res.text}`)
  const rows = /** @type {{ books?: unknown } | null} */ (res.body)?.books
  if (!Array.isArray(rows)) throw new Error(`the registry answered no book list: ${res.text}`)
  for (const row of rows) {
    if (row?.mode !== PAPER) {
      throw new Error(`REFUSED: a paper registry read returned ${row?.tag} in mode ${JSON.stringify(row?.mode)}`)
    }
  }
  return rows
}

/**
 * --register --apply: decide `series` from the registry, then create, start
 * and switch on each book. Stops at the first failure; re-runnable (an
 * identical re-register converges on 200, a start on a running book is a
 * no-op, the PATCH is idempotent).
 *
 * @param {string} expiry
 * @param {{ request: Request, log?: (line: string) => void }} io
 * @param {{ only?: readonly string[] }} [opts] `--only`: just these symbols
 */
export async function registerBooks(expiry, io, opts = {}) {
  const { request } = io
  const log = io.log ?? (() => {})
  const series = registrySupportsSeries(await readRegistry(request))
  const books = assertAllPaper(selectBooks(planStockBooks(expiry, { series }), opts.only ?? []))
  log(`  series ${series ? 'sent (the registry carries it)' : 'not sent (the registry rows carry none)'}`)
  let created = 0
  let started = 0
  let switchedOn = 0
  for (const book of books) {
    // Layer 4: the last check before the wire, on the object that is sent.
    if (book.mode !== PAPER) throw new Error(`REFUSED at the wire: ${book.tag} is mode ${JSON.stringify(book.mode)}`)
    const create = await request('POST', REGISTRY, book)
    if (create.status !== 201 && create.status !== 200) {
      throw new Error(
        `create ${book.tag} failed: HTTP ${create.status} ${create.text}` +
          (create.status === 409 ? '\n  A DIFFERENT book already holds this tag; sort it out on the Books page.' : ''),
      )
    }
    const row = /** @type {Record<string, unknown> | null} */ (create.body)
    if (row !== null && typeof row === 'object' && row['mode'] !== PAPER) {
      throw new Error(`REFUSED: the registry echoed mode ${JSON.stringify(row['mode'])} for ${book.tag}`)
    }
    created += 1
    log(`  created  ${book.tag}  (HTTP ${create.status}${create.status === 200 ? ', already registered' : ''})`)

    const start = await request('POST', `${REGISTRY}/${book.tag}/start`, { mode: PAPER })
    if (start.status !== 200) throw new Error(`start ${book.tag} failed: HTTP ${start.status} ${start.text}`)
    started += 1
    log(`  started  ${book.tag}`)

    const on = await request('PATCH', `${STRATEGIES}/${book.tag}`, PAPER_ON)
    if (on.status !== 200) {
      throw new Error(
        `switch on ${book.tag} failed: HTTP ${on.status} ${on.text}` +
          '\n  The book is registered and started but its paper switch is OFF. Flip it on the ' +
          'Strategies page, or fix the cause and re-run.',
      )
    }
    switchedOn += 1
    log(`  switched on  ${book.tag}  (modes.paper.enabled: true)`)
  }
  return { created, started, switchedOn, series }
}

/**
 * --open --apply: refuse, read, plan all, then submit → fill → seed per book.
 *
 * The refusals all happen before the first order of the first book: the
 * clock, the registry, the paper switches and the kill switch, the holdings,
 * book document and trades of every tag, and every chain (fresh quotes
 * only). Any failure after that point — including a request that throws or
 * times out — stops the run naming the book, how many of its orders were
 * submitted and which books are already seeded (runbook §3).
 *
 * @param {readonly BookPlan[]} books
 * @param {{ request: Request, now: () => number, sleep?: (ms: number) => Promise<void>, log?: (line: string) => void }} io
 */
export async function openBooks(books, io) {
  const { request } = io
  const log = io.log ?? (() => {})
  const sleep = io.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))

  // 1. The clock. Before any request at all.
  const refusal = openWindowRefusal(io.now())
  if (refusal !== null) throw new Error(`REFUSED: ${refusal}. Nothing was sent.`)
  assertAllPaper(books)

  // 2–4. Every check and every plan, before the first order. Anything that
  // fails here — a refusal or a request that throws — has sent nothing.
  /** @type {OpenPlan[]} */
  let plans
  try {
    plans = await checkAndPlan(books, request, io.now, log)
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err)
    throw new Error(why.startsWith('REFUSED') ? why : `REFUSED before any order: ${why}. Nothing was sent.`)
  }

  // 5. Per book: four submits, wait for the fills, seed them. Past the first
  // submit anything can have routed, so EVERY failure — a refusal, a timeout,
  // a dropped connection — leaves with the same account of where it stopped.
  /** @type {string[]} */
  const seeded = []
  for (const plan of plans) {
    let submittedCount = 0
    try {
      /** @type {{ orders: { clientOrderId: string }[] }[]} */
      const submitted = []
      for (const order of plan.orders) {
        // Layer 4, on the body that is sent.
        if (order['mode'] !== PAPER) throw new Error(`REFUSED at the wire: ${String(order['clientOrderId'])} is not paper`)
        const res = await request('POST', SUBMIT, order)
        const body = /** @type {Record<string, unknown> | null} */ (res.body)
        if (res.status !== 200 || body?.['accepted'] !== true || body['routedLots'] !== plan.lots) {
          throw new Error(`submit ${String(order['clientOrderId'])} was not routed whole: HTTP ${res.status} ${res.text}`)
        }
        submittedCount += 1
        submitted.push({ orders: /** @type {{ clientOrderId: string }[]} */ (body['orders'] ?? []) })
        const instrument = /** @type {Record<string, unknown>} */ (order['instrument'])
        log(`  submitted  ${String(order['side'])} ${plan.lots} lot(s) ${String(instrument['tradingsymbol'])}`)
      }

      /** @type {ReturnType<typeof filledLegs>} */
      let fills = { legs: null, pending: [], failed: [] }
      for (let attempt = 1; attempt <= POLL_ATTEMPTS; attempt += 1) {
        const tr = await request('GET', `${TRADES}?tag=${plan.tag}&mode=${PAPER}`)
        const trades = /** @type {{ trades?: unknown } | null} */ (tr.body)?.trades
        fills = filledLegs(plan, submitted, Array.isArray(trades) ? trades : [])
        if (fills.legs !== null || fills.failed.length > 0) break
        if (attempt < POLL_ATTEMPTS) await sleep(POLL_MS)
      }
      if (fills.legs === null) {
        throw new Error(
          'the entry orders did not all fill — ' +
            (fills.failed.length > 0 ? `failed: ${fills.failed.join('; ')}` : `still waiting on ${fills.pending.join(', ')}`) +
            '; nothing was seeded for this book',
        )
      }

      const seed = seedBody(plan, fills.legs)
      if (seed.mode !== PAPER) throw new Error(`REFUSED at the wire: the seed for ${plan.tag} is not paper`)
      const res = await request('POST', SEED, seed)
      const booked = /** @type {{ booked?: unknown, unresolved?: unknown } | null} */ (res.body)
      if (
        res.status !== 200 ||
        !Array.isArray(booked?.booked) ||
        booked.booked.length !== fills.legs.length ||
        (Array.isArray(booked.unresolved) && booked.unresolved.length > 0)
      ) {
        // A 409 can mean the book ALREADY holds these legs. Look before
        // seeding again: a second seed would refuse, a replace would erase.
        throw new Error(
          `seed refused: HTTP ${res.status} ${res.text} — the four orders FILLED. ` +
            `check GET ${POSITIONS}?tag=${plan.tag}&mode=${PAPER} FIRST: if it shows these four legs, do NOT ` +
            `seed again; if it shows none, send exactly this one seed: ${JSON.stringify(seed)}`,
        )
      }
      seeded.push(plan.tag)
      log(
        `  seeded  ${plan.tag}  ` +
          fills.legs.map((l) => `${l.qty > 0 ? '+' : ''}${l.qty} ${l.strike}${l.type} @ ${l.rate}`).join(', '),
      )
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err)
      throw new Error(
        `${plan.tag}: STOPPED after ${submittedCount} of ${plan.orders.length} entry orders were submitted — ${why}\n` +
          `  books already seeded: ${seeded.join(', ') || 'none'}.\n` +
          `  orders may have ROUTED — check GET ${TRADES}?tag=${plan.tag}&mode=${PAPER}; runbook §3.`,
      )
    }
  }
  return { opened: seeded.length, seeded }
}

/**
 * Steps 2–4 of `openBooks`: the registry, the gates, the holdings, the
 * chains. Sends nothing; answers the plans, or throws a refusal.
 *
 * @param {readonly BookPlan[]} books
 * @param {Request} request
 * @param {() => number} now
 * @param {(line: string) => void} log
 * @returns {Promise<OpenPlan[]>}
 */
async function checkAndPlan(books, request, now, log) {
  // 2. Each book registered, paper, running, and the row says what we think.
  const rows = await readRegistry(request)
  for (const book of books) {
    const row = rows.find((r) => r['tag'] === book.tag)
    if (row === undefined) {
      throw new Error(`REFUSED: ${book.tag} is not registered — run --register --apply first. Nothing was sent.`)
    }
    if (row['symbol'] !== book.symbol || row['expiry'] !== book.expiry || row['variant'] !== book.variant) {
      throw new Error(
        `REFUSED: the registry row ${book.tag} is ${String(row['symbol'])} ${String(row['expiry'])} ` +
          `${String(row['variant'])}, not ${book.symbol} ${book.expiry} ${book.variant}. Nothing was sent.`,
      )
    }
    if (row['desired'] !== 'running') {
      throw new Error(
        `REFUSED: ${book.tag} is ${String(row['desired'])} — a stopped book would hold legs nothing manages. ` +
          'Start it (--register --apply) first. Nothing was sent.',
      )
    }
  }

  // 2b. The two gates every submit passes: the tag's paper switch, and the
  // desk's kill switch. Refused here, a closed gate costs nothing; found at
  // the third submit, it strands two legs.
  const strat = await request('GET', `${STRATEGIES}?mode=${PAPER}`)
  const switches = /** @type {{ strategies?: unknown } | null} */ (strat.body)?.strategies
  if (strat.status !== 200 || !Array.isArray(switches)) {
    throw new Error(`REFUSED: cannot read the strategy switches (HTTP ${strat.status} ${strat.text}). Nothing was sent.`)
  }
  for (const book of books) {
    const row = switches.find((r) => r?.tag === book.tag)
    if (row?.modes?.paper?.enabled !== true) {
      throw new Error(
        `REFUSED: ${book.tag} is switched OFF for paper — every order would be refused. ` +
          'Re-run --register --apply (it switches it on) or flip it on the Strategies page. Nothing was sent.',
      )
    }
  }
  const kill = await request('GET', KILLSWITCH)
  const halt = /** @type {{ enabled?: unknown, reason?: unknown } | null} */ (kill.body)
  if (kill.status !== 200 || typeof halt?.enabled !== 'boolean') {
    throw new Error(`REFUSED: cannot read the kill switch (HTTP ${kill.status} ${kill.text}). Nothing was sent.`)
  }
  if (halt.enabled) {
    throw new Error(
      `REFUSED: the kill switch is ENGAGED (${String(halt.reason ?? '')}) — no entry order would pass. Nothing was sent.`,
    )
  }

  // 3. Nothing held, no book document, nothing traded — for every tag.
  for (const book of books) {
    const pos = await request('GET', `${POSITIONS}?tag=${book.tag}&mode=${PAPER}`)
    const held = pos.status === 200 ? heldLegCount(pos.body) : null
    if (held === null) {
      throw new Error(`REFUSED: cannot tell whether ${book.tag} holds legs (HTTP ${pos.status} ${pos.text}). Nothing was sent.`)
    }
    if (held > 0) {
      throw new Error(`REFUSED: ${book.tag} already holds ${held} leg(s) — it is open. Nothing was sent.`)
    }
    // The open rests on there being NO book document: then the submits fold
    // nothing and the seed writes the book. With one (even empty) the submits
    // would fold into it and the seed would then be refused as an overwrite.
    const symbol = /** @type {{ symbol?: unknown } | null} */ (pos.body)?.symbol
    if (typeof symbol === 'string' && symbol !== '') {
      throw new Error(
        `REFUSED: ${book.tag} already has a book document (symbol ${symbol}, no legs) — the entry fills would ` +
          'fold into it and the seed would then be refused. Erase it or open by hand. Nothing was sent.',
      )
    }
    const tr = await request('GET', `${TRADES}?tag=${book.tag}&mode=${PAPER}`)
    const trades = /** @type {{ trades?: unknown } | null} */ (tr.body)?.trades
    if (tr.status !== 200 || !Array.isArray(trades)) {
      throw new Error(`REFUSED: cannot read the trades of ${book.tag} (HTTP ${tr.status} ${tr.text}). Nothing was sent.`)
    }
    if (trades.length > 0) {
      throw new Error(
        `REFUSED: ${book.tag} holds no legs but has ${trades.length} trade(s) — an earlier open stopped ` +
          'halfway. Finish it by hand (runbook §3) and open the others with --only. Nothing was sent.',
      )
    }
  }

  // 4. Every chain read and every book planned before the first order.
  /** @type {OpenPlan[]} */
  const plans = []
  for (const book of books) {
    const res = await request('GET', `${CHAIN}/${book.symbol}?expiry=${book.expiry}`)
    if (res.status !== 200) {
      throw new Error(
        `REFUSED: the ${book.symbol} ${book.expiry} chain did not answer: HTTP ${res.status} ${res.text}. Nothing was sent.`,
      )
    }
    const plan = planOpen(book, /** @type {Chain} */ (res.body), { nowMs: now() })
    if (plan.problems.length > 0) {
      throw new Error(`REFUSED: ${book.tag} cannot be opened — ${plan.problems.join('; ')}. Nothing was sent.`)
    }
    plans.push(plan)
    log(`  planned  ${describePlan(plan)}`)
  }
  return plans
}

/**
 * The `request` --apply uses: the sibling's `requestJson`, with a deadline.
 *
 * @param {string} base
 * @param {string} token
 * @param {number} [timeoutMs]
 * @returns {Request}
 */
export function deskRequest(base, token, timeoutMs = REQUEST_TIMEOUT_MS) {
  return (method, path, body) => requestJson(base, method, path, body, token, { timeoutMs })
}

// ───────────────────────────────────────────────────────────────── the output

const RULE = '─'.repeat(78)

/** @param {OpenPlan} p */
function describePlan(p) {
  return p.atm === null
    ? `${p.tag}: no spot`
    : `${p.tag}: spot ${p.spot} -> short ${p.atm} CE+PE, long ${p.wingHi} CE / ${p.wingLo} PE, ${p.lots} lot(s)`
}

/**
 * @param {readonly BookPlan[]} books
 */
function printRegisterPlan(books) {
  console.log(`\n${RULE}`)
  console.log(`  ${books.length} recenter-relief-r PAPER stock books, expiry ${books[0]?.expiry}`)
  console.log(RULE)
  books.forEach((b, i) => {
    console.log(`\n  [${i + 1}/${books.length}] ${b.tag}`)
    console.log(`      symbol   ${b.symbol}`)
    console.log(`      expiry   ${b.expiry}   (nearest monthly on or after today, from the instrument master)`)
    console.log(`      mode     ${b.mode}`)
    console.log(`      variant  ${b.variant}`)
    console.log(`      dials    ${JSON.stringify(b.dials)}`)
    console.log(`      series   ${b.symbol}-${VARIANT}, sent only if the registry rows already carry series (read at --apply)`)
    console.log(`      call 1   POST ${REGISTRY}                  -> desired: stopped`)
    console.log(`      call 2   POST ${REGISTRY}/${b.tag}/start   {"mode":"paper"}`)
    console.log(`      call 3   PATCH ${STRATEGIES}/${b.tag}   ${JSON.stringify(PAPER_ON)}`)
  })
  const live = books.filter((b) => b.mode !== PAPER).length
  console.log(`\n${RULE}`)
  console.log(`  ${books.length} books planned. paper: ${books.length - live}. live: ${live}.`)
  console.log(`  --apply first reads GET ${REGISTRY}?mode=paper (to decide series), then the calls above.`)
}

/**
 * @param {readonly OpenPlan[]} plans
 * @param {string | null} refusal
 * @param {ReadonlyMap<string, { held: number | null, doc: boolean, trades: number }>} state
 */
function printOpenPlan(plans, refusal, state) {
  console.log(`\n${RULE}`)
  console.log('  --open PREVIEW, priced off the PERSISTED SNAPSHOT (desk-marks) — --apply reads the live chain')
  console.log(RULE)
  console.log(
    refusal === null
      ? '\n  window   open now (09:20–15:00 IST, trading day)'
      : `\n  window   --apply would REFUSE now: ${refusal}`,
  )
  for (const p of plans) {
    const s = state.get(p.tag)
    console.log(`\n  ${p.tag}`)
    console.log(
      `      book     held legs: ${s?.held ?? 'unknown'}, book document: ${s === undefined ? 'unknown' : s.doc ? 'YES' : 'none'}, ` +
        `trades under the tag: ${s?.trades ?? 'unknown'}` +
        `${(s?.held ?? 0) > 0 || s?.doc === true || (s?.trades ?? 0) > 0 ? '   <- --apply would REFUSE' : ''}`,
    )
    console.log(`      spot     ${p.spot ?? 'no mark'} (the ${p.symbol} future's last persisted mark)   size ${p.lots} lot(s)`)
    p.legs.forEach((l, i) => {
      console.log(
        `      order ${i + 1}  ${l.side.padEnd(4)} ${String(l.qty).padStart(6)}  ${(l.tradingsymbol ?? `${l.strike}${l.type}`).padEnd(24)}` +
          `  last ${l.price ?? '—'}`,
      )
    })
    if (p.legs.length > 0) console.log(`      then     poll GET ${TRADES}?tag=${p.tag}&mode=paper, POST ${SEED} with the filled rates`)
    // Off the SNAPSHOT these are expected for an unregistered book: the feed
    // subscribes a chain once its book is registered. --apply re-reads live.
    for (const problem of p.problems) console.log(`      snapshot ${problem.replace('no live quote', 'no persisted price')}`)
  }
  console.log(`\n${RULE}`)
}

// ────────────────────────────────────────────────────────────────────── main

const HELP = `
  The monthly recenter-relief-r PAPER stock books — TCS, TATASTEEL, KALYANKJIL —
  put on the desk the way the September ones were (2026-09-07), in two phases.

    node scripts/stock-books.mjs (--register | --open) [--only SYMBOL]... [--dry-run | --apply] [--json]

    --register  Create, start and switch on the three books for the nearest
                monthly expiry (tag <SYMBOL>-<expiry>-recenter-relief-r, dials
                margin_cap 5000000, target_pnl 50000, delta/gamma_shorts_only).
                Safe on any day: an empty recenter book does nothing.
    --open      In a session, 09:20–15:00 IST only: short ATM straddle + long
                wings at the strikes nearest ±9 % of the October future, 5 / 5 / 2
                lots, through /v1/desk/submit; wait for the fills; seed them.
                Refuses, before any order, outside the window, when a book holds
                legs, has a book document or has traded, when a paper switch is
                off or the kill switch on, or when any quote is not fresh.
    --only SYM  Just this book (repeatable): TCS, TATASTEEL, KALYANKJIL. For
                opening the others after one stopped halfway (runbook §3).
    --dry-run   THE DEFAULT. Prints the plan; sends nothing and needs no desk-api.
                --open's dry run prices off the persisted snapshot in Mongo.
    --apply     Perform it against desk-api.
    --json      Print the plan as JSON instead of the table.
    --help      This.

  Environment: DESK_MONGO_URL (default ${DEFAULT_MONGO}), DESK_API_URL (default
  ${DEFAULT_API}), DESK_API_TOKEN (required for --apply). .env.local is loaded
  first; an already-set variable wins. Every book, order and seed is mode: paper,
  and no flag changes that. Procedure: docs/runbooks/stock-books.md
`

/** @param {readonly string[]} argv */
export function parseArgs(argv) {
  const opts = { register: false, open: false, apply: false, json: false, help: false, only: /** @type {string[]} */ ([]) }
  for (let i = 0; i < argv.length; i += 1) {
    const a = /** @type {string} */ (argv[i])
    if (a === '--only') {
      const symbol = argv[i + 1]
      if (symbol === undefined || symbol.startsWith('-')) throw new Error('--only needs a symbol: --only TCS')
      opts.only.push(symbol)
      i += 1
    } else if (a === '--help' || a === '-h') opts.help = true
    else if (a === '--register') opts.register = true
    else if (a === '--open') opts.open = true
    else if (a === '--apply') opts.apply = true
    else if (a === '--dry-run') opts.apply = false
    else if (a === '--json') opts.json = true
    else {
      // A hard error, never ignored: `--mode live` must fail, not run.
      throw new Error(
        `unrecognised argument ${JSON.stringify(a)} — this script takes --register, --open, --dry-run, ` +
          '--apply, --json, --only and --help, and nothing else (there is no flag that changes the mode)',
      )
    }
  }
  // Judged on what was PASSED, not on which came last: `--apply --dry-run`
  // must not quietly become a dry run, nor `--dry-run --apply` an apply.
  if (argv.includes('--apply') && argv.includes('--dry-run')) {
    throw new Error('--apply and --dry-run are opposites; pass one')
  }
  if (!opts.help && opts.register === opts.open) {
    throw new Error('pass exactly one of --register or --open (see --help)')
  }
  return opts
}

/**
 * The one expiry all three books share: each symbol's nearest listed expiry
 * on or after today, and they must agree (a monthly stock expiry is one day).
 *
 * @param {{ nearestExpiry(u: string, onOrAfter: string): string | null }} master
 * @param {string} todayIst
 */
function sharedExpiry(master, todayIst) {
  const found = STOCKS.map(({ symbol }) => ({ symbol, expiry: master.nearestExpiry(symbol, todayIst) }))
  const missing = found.filter((f) => f.expiry === null || f.expiry === undefined)
  if (missing.length > 0) {
    throw new Error(`the instrument dump lists no expiry for ${missing.map((m) => m.symbol).join(', ')} — run \`make sync\``)
  }
  const distinct = [...new Set(found.map((f) => f.expiry))]
  if (distinct.length !== 1) {
    throw new Error(`the three symbols do not share an expiry: ${found.map((f) => `${f.symbol} ${f.expiry}`).join(', ')}`)
  }
  return /** @type {string} */ (distinct[0])
}

/**
 * A `Chain` built from the instrument master and the persisted `desk-marks`
 * snapshot — the dry run's stand-in for `GET /v1/desk/chain`, so a preview
 * needs no desk-api.
 *
 * @param {any} master an `OptionMaster`
 * @param {ReadonlyMap<number, { price: number, ts: number }>} marks token -> last price and when
 * @param {string} symbol
 * @param {string} expiry
 * @returns {Chain}
 */
function chainFromSnapshot(master, marks, symbol, expiry) {
  const quote = (/** @type {number | undefined} */ token) => {
    const m = token === undefined ? undefined : marks.get(token)
    return m === undefined ? null : { price: m.price, asOf: m.ts }
  }
  const future = master.future(symbol, expiry)
  const fut = future === null ? undefined : marks.get(future.instrumentToken)
  return {
    underlying: symbol,
    expiry,
    future: fut?.price ?? null,
    futureAsOf: fut?.ts ?? null,
    lotSize: master.chain(symbol, expiry)?.lotSize ?? null,
    rows: master.strikes(symbol, expiry).map((/** @type {number} */ strike) => {
      const ce = master.resolve(symbol, expiry, strike, 'CE')
      const pe = master.resolve(symbol, expiry, strike, 'PE')
      return {
        strike,
        CE: quote(ce?.instrumentToken),
        PE: quote(pe?.instrumentToken),
        ...(ce ? { ceContract: ce } : {}),
        ...(pe ? { peContract: pe } : {}),
      }
    }),
  }
}

async function main() {
  try {
    process.loadEnvFile(fileURLToPath(new URL('../.env.local', import.meta.url)))
  } catch {
    // Nothing to load. The environment stands as it is.
  }
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help) {
    console.log(HELP)
    return 0
  }
  const nowMs = Date.now()
  const todayIst = istDate(nowMs)

  // --open --apply refuses on the clock before it so much as opens Mongo.
  if (opts.open && opts.apply) {
    const refusal = openWindowRefusal(nowMs)
    if (refusal !== null) throw new Error(`REFUSED: ${refusal}. Nothing was sent.`)
  }

  // Imported HERE: the suite imports this module for its pure functions.
  const { connectMongo } = await import('../apps/api/src/mongo.ts')
  const { loadStoredInstruments } = await import('../apps/marketdata/src/sync-runner.ts')
  const { OptionMaster } = await import('@algomaker/instruments')
  const { DeskStore } = await import('../apps/api/src/store.ts')

  const mongo = await connectMongo(process.env['DESK_MONGO_URL'] ?? DEFAULT_MONGO, { serverSelectionTimeoutMS: 5000 })
  /** @type {string} */
  let expiry
  /** @type {OpenPlan[]} */
  const previews = []
  /** @type {Map<string, { held: number | null, doc: boolean, trades: number }>} */
  const state = new Map()
  /** @type {readonly BookPlan[]} */
  let books
  try {
    const master = new OptionMaster(await loadStoredInstruments(mongo.db.collection('instrument')))
    expiry = sharedExpiry(master, todayIst)
    books = selectBooks(planStockBooks(expiry), opts.only)
    if (opts.open && !opts.apply) {
      // The preview: read-only, off the snapshot, no desk-api.
      const store = new DeskStore(mongo.db)
      for (const book of books) {
        const tokens = []
        const fut = master.future(book.symbol, expiry)
        if (fut !== null) tokens.push(fut.instrumentToken)
        for (const k of master.strikes(book.symbol, expiry)) {
          for (const t of ['CE', 'PE']) {
            const ref = master.resolve(book.symbol, expiry, k, t)
            if (ref) tokens.push(ref.instrumentToken)
          }
        }
        const docs = await mongo.db.collection('desk-marks').find({ token: { $in: tokens } }).toArray()
        const marks = new Map(docs.map((d) => [Number(d['token']), { price: Number(d['price']), ts: Number(d['ts']) }]))
        previews.push(planOpen(book, chainFromSnapshot(master, marks, book.symbol, expiry), { nowMs }))
        const doc = await store.bookDoc(book.tag, PAPER)
        // The SAME two sources `GET /v1/desk/trades?mode=paper` unions
        // (`service.paperTrades`): the paper rail's own rows, and paper fills
        // the gateway journalled. The preview and --apply must agree.
        const rail = await store.listPaperTrades({ tag: book.tag })
        const engine = await mongo.db.collection('desk-fills').countDocuments({ mode: PAPER, tag: book.tag })
        state.set(book.tag, { held: doc === null ? 0 : heldLegCount(doc), doc: doc !== null, trades: rail.length + engine })
      }
    }
  } finally {
    await mongo.close()
  }

  if (!opts.apply) {
    if (opts.register) {
      if (opts.json) console.log(JSON.stringify(books, null, 2))
      else printRegisterPlan(books)
      console.log('\n  DRY RUN. Nothing was created; desk-api was not contacted.')
      console.log('  --apply  read the registry, then create, start and switch on these three books.\n')
    } else {
      if (opts.json) console.log(JSON.stringify({ window: openWindowRefusal(nowMs), plans: previews }, null, 2))
      else printOpenPlan(previews, openWindowRefusal(nowMs), state)
      console.log('\n  DRY RUN. Nothing was sent; desk-api was not contacted.')
      console.log(
        '  --apply  in a session: re-check every book, read the LIVE chains (every contract must be quoted),\n' +
          '           submit, wait for the fills, seed. Strikes can differ from this preview if spot has moved.\n',
      )
    }
    return 0
  }

  const base = process.env['DESK_API_URL'] ?? DEFAULT_API
  const token = process.env['DESK_API_TOKEN'] ?? ''
  if (token.trim() === '') {
    throw new Error('DESK_API_TOKEN is not set — --apply authenticates to desk-api as the machine principal')
  }
  // Every request carries a deadline (REQUEST_TIMEOUT_MS): a hung desk stops
  // the run with an account of where it was, never hangs it.
  const request = deskRequest(base, token)
  const log = (/** @type {string} */ line) => console.log(line)
  console.log(`\n  applying against ${base}\n`)

  if (opts.register) {
    const done = await registerBooks(expiry, { request, log }, { only: opts.only })
    console.log(`\n  ${done.created} registered, ${done.started} started, ${done.switchedOn} switched on, all paper.`)
    console.log('  Monday 09:35 IST: node scripts/stock-books.mjs --open --apply (docs/runbooks/stock-books.md)\n')
    return 0
  }
  const done = await openBooks(books, { request, now: () => Date.now(), log })
  console.log(`\n  ${done.opened} book(s) opened and seeded, all paper: ${done.seeded.join(', ')}\n`)
  return 0
}

// Run only when executed directly — the test suite imports this file.
if (process.argv[1] !== undefined && resolvePath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
    .then((code) => {
      process.exitCode = code
    })
    .catch((err) => {
      console.error(`\n${err instanceof Error ? err.message : String(err)}\n`)
      process.exitCode = 1
    })
}

export { PAPER, VARIANT, DIALS, STOCKS, WING_PCT, REGISTRY, REQUEST_TIMEOUT_MS }
