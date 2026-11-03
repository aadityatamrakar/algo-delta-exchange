/**
 * THE MONTHLY STOCK BOOKS, THE SEPTEMBER WAY, AND NOT ONE OF THEM LIVE.
 *
 * `scripts/stock-books.mjs` writes down what was done by hand on 2026-09-07
 * for TCS, TATASTEEL and KALYANKJIL: register a `recenter-relief-r` book per
 * symbol, start it, switch its paper rail on; then, in market hours, open a
 * short ATM straddle with long wings at about ±9 % of spot through
 * `/v1/desk/submit`, wait for the fills and record them with `/v1/desk/seed`.
 * Recenter never opens its own position (2026-07-30 recenter spec), so the
 * script is the only thing that does.
 *
 * What this file pins, in the order a mistake would cost money:
 *
 *   1. A LIVE ROW OR A LIVE ORDER. `mode` is the sibling's `PAPER` constant on
 *      every body — registry, start, submit, seed — and a body that is not
 *      paper is refused at the wire.
 *   2. AN OPEN THAT DOUBLES A BOOK. `--open` refuses before a single order is
 *      built when the clock is outside 09:20–15:00 IST, when the day is not a
 *      trading day, when a book already holds legs, or when its tag has
 *      traded at all (a half-finished earlier open leaves fills and no
 *      `desk-books` document — the legs only exist once seeded).
 *   3. THE WRONG STRIKES OR SIZE. The strike choice is pinned against the
 *      REAL October strike lists from the `instrument` collection and the
 *      three Friday futures marks (TCS 2076.8, TATASTEEL 178.65, KALYANKJIL
 *      528); the size is 5 / 5 / 2 lots, the lot coming off the contract.
 *   4. THE WRONG ORDER OF CALLS. Wings are bought before the straddle is sold,
 *      every order is filled before anything is seeded, and the seed records
 *      the FILLED rates with the shorts negative. Pinned by recording calls.
 *
 * Pure tests need no Mongo. The last block drives `--register` against a real
 * `booksRoutes` + `deskRoutes` server on its own database
 * (`algomaker_dx_stock_books_test`, or `DESK_TEST_MONGO`) through the nudge sink.
 */

import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { skipUnlessMongo } from './require-mongo.ts'
import { startNudgeSink, type NudgeSink } from './nudge-sink.ts'
import { connectMongo, type MongoHandle } from '../src/mongo.ts'
import { createBridgeServer } from '../src/server.ts'
import { bearerGate } from '../src/authgate.ts'
import { DeskStore, COLLECTIONS } from '../src/store.ts'
import { booksRoutes } from '../src/routes/books.ts'
import { deskRoutes } from '../src/routes/desk.ts'
import type { ApiDeps } from '../src/routes/kit.ts'
import { validateBookCreate } from '../src/books-registry.ts'
import { validateSeedRequest } from '../src/validate.ts'
import { validateSubmitRequest } from '../src/submit.ts'
import { isOn } from '../src/strategies.ts'
import { OptionMaster, type InstrumentRow } from '@algomaker/instruments'
import { BridgeService } from '../src/service.ts'
import { PaperRail, LiveRail } from '../src/rail.ts'
import { StaticMarks } from '../src/marks.ts'
import { SUBMISSIONS } from '../src/submit.ts'
import { submitRoutes } from '../src/routes/submit.ts'

// ------------------------------------------------------------ the contract

/**
 * The script is a `.mjs` outside every tsconfig, imported through a URL so the
 * resolver does not try to typecheck it. Its exported contract is therefore
 * stated here, which is also the only place it is written down.
 */
interface BookPlan {
  readonly tag: string
  readonly symbol: string
  readonly expiry: string
  readonly mode: string
  readonly variant: string
  readonly dials: Readonly<Record<string, number | boolean>>
  readonly series?: string
}
interface Contract {
  readonly tradingsymbol: string
  readonly instrumentToken: number
  readonly lotSize: number
  readonly tickSize: number
  readonly exchange: string
}
interface Quote {
  readonly price: number
  readonly asOf?: number
}
interface ChainRow {
  readonly strike: number
  readonly CE: Quote | null
  readonly PE: Quote | null
  readonly ceContract?: Contract
  readonly peContract?: Contract
}
interface Chain {
  readonly underlying: string
  readonly expiry: string
  readonly future: number | null
  readonly futureAsOf?: number | null
  readonly lotSize: number | null
  readonly rows: readonly ChainRow[]
}
interface OpenLeg {
  readonly strike: number
  readonly type: 'CE' | 'PE'
  readonly side: 'Buy' | 'Sell'
  readonly qty: number
  readonly tradingsymbol: string | null
  readonly price: number | null
}
interface SubmitBody {
  readonly tag: string
  readonly mode: string
  readonly clientOrderId: string
  readonly instrument: Contract
  readonly side: 'Buy' | 'Sell'
  readonly lots: number
  readonly [k: string]: unknown
}
interface OpenPlan {
  readonly tag: string
  readonly symbol: string
  readonly expiry: string
  readonly mode: string
  readonly spot: number | null
  readonly lots: number
  readonly atm: number | null
  readonly wingLo: number | null
  readonly wingHi: number | null
  readonly legs: readonly OpenLeg[]
  readonly orders: readonly SubmitBody[]
  readonly problems: readonly string[]
}
interface WireResult {
  readonly status: number
  readonly body: unknown
  readonly text: string
}
type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE'
type Request = (method: Method, path: string, body?: unknown) => Promise<WireResult>
interface OpenIo {
  readonly request: Request
  readonly now: () => number
  readonly sleep?: (ms: number) => Promise<void>
  readonly log?: (line: string) => void
}

const script = (await import(new URL('../../../scripts/stock-books.mjs', import.meta.url).href)) as {
  planStockBooks(expiry: string, opts?: { series?: boolean }): readonly BookPlan[]
  sizeLots(symbol: string): number
  chooseStrikes(input: { spot: number; strikes: readonly number[] }): { atm: number; wingLo: number; wingHi: number }
  openWindowRefusal(nowMs: number, isTrading?: (dateIst: string) => boolean): string | null
  registrySupportsSeries(rows: readonly Record<string, unknown>[]): boolean
  heldLegCount(positions: unknown): number | null
  planOpen(book: BookPlan, chain: Chain, opts: { nowMs: number }): OpenPlan
  selectBooks(books: readonly BookPlan[], only: readonly string[]): readonly BookPlan[]
  deskRequest(base: string, token: string, timeoutMs?: number): Request
  seedBody(plan: OpenPlan, legs: readonly { strike: number; type: 'CE' | 'PE'; qty: number; rate: number }[]): Record<string, unknown>
  filledLegs(
    plan: OpenPlan,
    submitted: readonly { orders: readonly { clientOrderId: string }[] }[],
    trades: readonly Record<string, unknown>[],
  ): { legs: { strike: number; type: 'CE' | 'PE'; qty: number; rate: number }[] | null; pending: string[]; failed: string[] }
  registerBooks(
    expiry: string,
    io: { request: Request; log?: (line: string) => void },
    opts?: { only?: readonly string[] },
  ): Promise<{ created: number; started: number; switchedOn: number; series: boolean }>
  openBooks(books: readonly BookPlan[], io: OpenIo): Promise<{ opened: number; seeded: readonly string[] }>
  parseArgs(argv: readonly string[]): { register: boolean; open: boolean; apply: boolean; json: boolean; help: boolean; only: string[] }
  readonly PAPER: string
  readonly VARIANT: string
  readonly DIALS: Readonly<Record<string, number | boolean>>
  readonly WING_PCT: number
  readonly REQUEST_TIMEOUT_MS: number
}
const siblings = (await import(new URL('../../../scripts/delta-lean-books.mjs', import.meta.url).href)) as {
  readonly PAPER: string
  requestJson(
    base: string,
    method: Method,
    path: string,
    body: unknown,
    token: string,
    opts?: { timeoutMs?: number },
  ): Promise<WireResult>
}

const { planStockBooks, sizeLots, chooseStrikes, openWindowRefusal, planOpen } = script

// ------------------------------------------------------------- the fixtures

/** October's monthly, for all three — verified in the `instrument` collection. */
const EXPIRY = '2026-10-27'
const TCS = `TCS-${EXPIRY}-recenter-relief-r`
const TATA = `TATASTEEL-${EXPIRY}-recenter-relief-r`
const KALYAN = `KALYANKJIL-${EXPIRY}-recenter-relief-r`

/**
 * The REAL 2026-10-27 strike lists (CE and PE identical), read from
 * `algomaker.instrument` on 2026-10-04. Not a step rule: TCS is 20 apart in
 * the middle and 40 at the edges, TATASTEEL lists the 2.5 half-steps.
 */
const STRIKES: Readonly<Record<string, readonly number[]>> = {
  TCS: [
    1720, 1760, 1800, 1820, 1840, 1860, 1880, 1900, 1920, 1940, 1960, 1980, 2000, 2020, 2040, 2060,
    2080, 2100, 2120, 2140, 2160, 2180, 2200, 2220, 2240, 2260, 2280, 2300, 2320, 2340, 2360, 2380,
    2400, 2420, 2440, 2460, 2480, 2500, 2520, 2540, 2560, 2580, 2600, 2620, 2640, 2680, 2720, 2800,
  ],
  TATASTEEL: [
    150, 155, 160, 162.5, 165, 167.5, 170, 172.5, 175, 177.5, 180, 182.5, 185, 187.5, 190, 192.5,
    195, 197.5, 200, 202.5, 205, 207.5, 210, 215, 220,
  ],
  KALYANKJIL: [
    420, 440, 450, 460, 470, 480, 490, 500, 510, 520, 530, 540, 550, 560, 570, 580, 590, 600, 610,
    620, 630, 640, 650, 660, 670, 680, 690, 700, 710, 720,
  ],
}
/** The Friday 2026-10-02 close of each October future, from `desk-marks`. */
const FRIDAY: Readonly<Record<string, number>> = { TCS: 2076.8, TATASTEEL: 178.65, KALYANKJIL: 528 }
/** Lot and tick per contract, from the dump. */
const LOT: Readonly<Record<string, number>> = { TCS: 225, TATASTEEL: 2750, KALYANKJIL: 1350 }
const TICK: Readonly<Record<string, number>> = { TCS: 0.05, TATASTEEL: 0.01, KALYANKJIL: 0.05 }
/** The real tokens of the twelve contracts the Friday marks select. */
const TOKENS: Readonly<Record<string, number>> = {
  TCS26OCT2080CE: 28984578,
  TCS26OCT2080PE: 28984834,
  TCS26OCT1880PE: 28982274,
  TCS26OCT2260CE: 33196802,
  'TATASTEEL26OCT177.5CE': 33148418,
  'TATASTEEL26OCT177.5PE': 33148674,
  'TATASTEEL26OCT162.5PE': 33146626,
  TATASTEEL26OCT195CE: 28901634,
  KALYANKJIL26OCT530CE: 22454786,
  KALYANKJIL26OCT530PE: 22455042,
  KALYANKJIL26OCT480PE: 22406402,
  KALYANKJIL26OCT580CE: 22460930,
}

function contractOf(symbol: string, strike: number, type: 'CE' | 'PE'): Contract {
  const tradingsymbol = `${symbol}26OCT${strike}${type}`
  return {
    tradingsymbol,
    instrumentToken: TOKENS[tradingsymbol] ?? 1,
    lotSize: LOT[symbol] as number,
    tickSize: TICK[symbol] as number,
    exchange: 'NFO',
  }
}

/** A chain as `GET /v1/desk/chain/:symbol?expiry=` answers it, every strike quoted. */
function chainFor(
  symbol: string,
  opts: {
    future?: number | null
    futureAsOf?: number | null
    price?: (strike: number, type: 'CE' | 'PE') => number | null
    asOf?: (strike: number, type: 'CE' | 'PE') => number | undefined
  } = {},
): Chain {
  const price = opts.price ?? ((k: number, t: 'CE' | 'PE') => (t === 'CE' ? 1000 / k : k / 1000))
  // Fresh by default: a tick five seconds before the runbook's 09:35.
  const asOf = opts.asOf ?? (() => MONDAY_0935 - 5_000)
  const quote = (k: number, t: 'CE' | 'PE'): Quote | null => {
    const p = price(k, t)
    if (p === null) return null
    const at = asOf(k, t)
    return at === undefined ? { price: p } : { price: p, asOf: at }
  }
  return {
    underlying: symbol,
    expiry: EXPIRY,
    future: opts.future === undefined ? (FRIDAY[symbol] as number) : opts.future,
    futureAsOf: opts.futureAsOf === undefined ? MONDAY_0935 - 10_000 : opts.futureAsOf,
    lotSize: LOT[symbol] as number,
    rows: (STRIKES[symbol] as readonly number[]).map((strike) => ({
      strike,
      CE: quote(strike, 'CE'),
      PE: quote(strike, 'PE'),
      ceContract: contractOf(symbol, strike, 'CE'),
      peContract: contractOf(symbol, strike, 'PE'),
    })),
  }
}

/** 09:35 IST on Monday 2026-10-05, the runbook's slot — never `Date.now()`. */
const MONDAY_0935 = Date.UTC(2026, 9, 5, 4, 5)
function ist(dateIst: string, hh: number, mm: number, ss = 0): number {
  const [y, m, d] = dateIst.split('-').map(Number) as [number, number, number]
  return Date.UTC(y, m - 1, d, hh, mm, ss) - (5 * 60 + 30) * 60_000
}
/** `planOpen` is judged at the runbook's moment. */
const AT = { nowMs: MONDAY_0935 }

// --------------------------------------------------------------- the books

test('three books, October expiry, September dials, every one paper', () => {
  const books = planStockBooks(EXPIRY)
  assert.deepEqual(
    books.map((b) => b.tag),
    [TCS, TATA, KALYAN],
  )
  for (const b of books) {
    assert.equal(b.mode, 'paper')
    assert.equal(b.mode, siblings.PAPER, 'PAPER is the sibling constant, not a restatement')
    assert.equal(b.expiry, EXPIRY)
    assert.equal(b.variant, 'recenter-relief-r')
    // Exactly the dials the 2026-09-07 audit log recorded — nothing added.
    assert.deepEqual(b.dials, { margin_cap: 5_000_000, target_pnl: 50_000, delta_shorts_only: true, gamma_shorts_only: true })
    assert.equal('series' in b, false, 'no series unless the registry already carries one')
    // The exact wire body: no desired/actual (the registry refuses them).
    assert.deepEqual(Object.keys(b).sort(), ['dials', 'expiry', 'mode', 'symbol', 'tag', 'variant'])
    const v = validateBookCreate(b)
    assert.ok(v.ok, `${b.tag}: ${v.ok ? '' : v.error}`)
  }
  assert.deepEqual(
    books.map((b) => b.symbol),
    ['TCS', 'TATASTEEL', 'KALYANKJIL'],
  )
})

test('series is carried only when asked, and is symbol-variant', () => {
  const books = planStockBooks(EXPIRY, { series: true })
  assert.deepEqual(
    books.map((b) => b.series),
    ['TCS-recenter-relief-r', 'TATASTEEL-recenter-relief-r', 'KALYANKJIL-recenter-relief-r'],
  )
})

test('series is decided by the registry rows, never guessed', () => {
  assert.equal(script.registrySupportsSeries([]), false, 'an empty registry proves nothing')
  assert.equal(script.registrySupportsSeries([{ tag: 'A', mode: 'paper' }]), false)
  assert.equal(script.registrySupportsSeries([{ tag: 'A', mode: 'paper', series: 'X-recenter-relief-r' }]), true)
})

test('an expiry that is not a date is refused', () => {
  assert.throws(() => planStockBooks('2026-10-7'), /YYYY-MM-DD/)
})

test('sizes are 5, 5 and 2 lots, and an unknown symbol is refused', () => {
  assert.equal(sizeLots('TCS'), 5)
  assert.equal(sizeLots('TATASTEEL'), 5)
  assert.equal(sizeLots('KALYANKJIL'), 2)
  assert.throws(() => sizeLots('INFY'), /INFY/)
})

// ------------------------------------------------------------- the strikes

test('the Friday marks pick these strikes from the real October lists', () => {
  // Computed, not stepped: ATM is the listed strike nearest the future; the
  // wings are the listed strikes nearest future x 0.91 (PE) and x 1.09 (CE).
  //   TCS 2076.8      ATM 2080 (3.2 away; 2060 is 16.8)
  //                   x0.91 = 1889.888 -> 1880 (9.888; 1900 is 10.112)
  //                   x1.09 = 2263.712 -> 2260 (3.712; 2280 is 16.288)
  //   TATASTEEL 178.65 ATM 177.5 (1.15; 180 is 1.35)
  //                   x0.91 = 162.5715 -> 162.5;  x1.09 = 194.7285 -> 195
  //   KALYANKJIL 528  ATM 530 (2; 520 is 8)
  //                   x0.91 = 480.48 -> 480;  x1.09 = 575.52 -> 580 (4.48; 570 is 5.52)
  const pick = (s: string) => chooseStrikes({ spot: FRIDAY[s] as number, strikes: STRIKES[s] as number[] })
  assert.deepEqual(pick('TCS'), { atm: 2080, wingLo: 1880, wingHi: 2260 })
  assert.deepEqual(pick('TATASTEEL'), { atm: 177.5, wingLo: 162.5, wingHi: 195 })
  assert.deepEqual(pick('KALYANKJIL'), { atm: 530, wingLo: 480, wingHi: 580 })
  assert.equal(script.WING_PCT, 0.09)
})

test('September is reproduced by the same rule', () => {
  // TCS 2026-09-07: shorts 2280, wings 2480 CE / 2080 PE. Any spot between
  // 2275 and 2285 on a 20-step list gives that; 2280 itself is the check.
  const sept = [2000, 2020, 2040, 2060, 2080, 2100, 2280, 2460, 2480, 2500]
  assert.deepEqual(chooseStrikes({ spot: 2280, strikes: sept }), { atm: 2280, wingLo: 2080, wingHi: 2480 })
})

test('a tie goes down for the ATM and outward for each wing', () => {
  const every20 = Array.from({ length: 21 }, (_, i) => 800 + i * 20) // 800 .. 1200
  // 1010 sits exactly between 1000 and 1020: the ATM takes the lower.
  assert.equal(chooseStrikes({ spot: 1010, strikes: every20 }).atm, 1000)
  // 1000 x 0.91 = 910 (900 | 920) and 1000 x 1.09 = 1090 (1080 | 1100): each
  // wing takes the strike FURTHER from spot, so a wing is never inside 9 %.
  assert.deepEqual(chooseStrikes({ spot: 1000, strikes: every20 }), { atm: 1000, wingLo: 900, wingHi: 1100 })
})

test('a list that cannot put a wing on each side of the ATM is refused', () => {
  assert.throws(() => chooseStrikes({ spot: 100, strikes: [100] }), /wing/)
  assert.throws(() => chooseStrikes({ spot: 0, strikes: [100] }), /spot/)
  assert.throws(() => chooseStrikes({ spot: 100, strikes: [] }), /strike/)
})

// --------------------------------------------------------------- the clock

test('--open is allowed from 09:20 to before 15:00 IST on a trading day, and only then', () => {
  const MON = '2026-10-05'
  assert.equal(openWindowRefusal(MONDAY_0935), null)
  assert.equal(openWindowRefusal(ist(MON, 9, 20)), null)
  assert.equal(openWindowRefusal(ist(MON, 14, 59, 59)), null)
  assert.match(openWindowRefusal(ist(MON, 9, 19, 59)) ?? '', /09:19 IST/)
  assert.match(openWindowRefusal(ist(MON, 15, 0)) ?? '', /15:00 IST/)
  assert.match(openWindowRefusal(ist(MON, 3, 0)) ?? '', /09:20/)
  // Sunday the 4th, mid-morning: not a session at all.
  assert.match(openWindowRefusal(ist('2026-10-04', 10, 0)) ?? '', /2026-10-04 is not a trading day/)
  // Friday 2 October was Gandhi Jayanti — a weekday holiday, from the engine's calendar.
  assert.match(openWindowRefusal(ist('2026-10-02', 10, 0)) ?? '', /not a trading day/)
  // The calendar is a parameter only so it can be stubbed here.
  assert.match(openWindowRefusal(MONDAY_0935, () => false) ?? '', /not a trading day/)
})

// ------------------------------------------------------------ the open plan

const BOOKS = planStockBooks(EXPIRY)
const bookOf = (tag: string): BookPlan => BOOKS.find((b) => b.tag === tag) as BookPlan

test('TCS at 2076.8: wings bought first, then the straddle sold, 5 lots of 225', () => {
  const plan = planOpen(bookOf(TCS), chainFor('TCS'), AT)
  assert.deepEqual(plan.problems, [])
  assert.equal(plan.spot, 2076.8)
  assert.deepEqual([plan.atm, plan.wingLo, plan.wingHi], [2080, 1880, 2260])
  assert.deepEqual(
    plan.legs.map((l) => [l.side, l.tradingsymbol, l.qty]),
    [
      ['Buy', 'TCS26OCT2260CE', 1125],
      ['Buy', 'TCS26OCT1880PE', 1125],
      ['Sell', 'TCS26OCT2080CE', 1125],
      ['Sell', 'TCS26OCT2080PE', 1125],
    ],
  )
  // The exact first body on the wire.
  assert.deepEqual(plan.orders[0], {
    tag: TCS,
    mode: 'paper',
    clientOrderId: `entry-${TCS}-TCS26OCT2260CE-Buy`,
    instrument: { tradingsymbol: 'TCS26OCT2260CE', instrumentToken: 33196802, lotSize: 225, tickSize: 0.05, exchange: 'NFO' },
    side: 'Buy',
    lots: 5,
    exactLots: true,
    underlying: 'TCS',
    referencePrice: 1000 / 2260,
  })
  for (const o of plan.orders) {
    // No orderType: the desk prices a marketable limit with its own dials.
    assert.equal('orderType' in o, false)
    assert.equal('limitPrice' in o, false)
    assert.equal('resting' in o, false, 'resting orders are not booked — the September orders filled')
    const v = validateSubmitRequest(o)
    assert.ok(v.ok, v.ok ? '' : v.error)
  }
})

test('TATASTEEL and KALYANKJIL: the half-step strike, and the 2-lot book', () => {
  const tata = planOpen(bookOf(TATA), chainFor('TATASTEEL'), AT)
  assert.deepEqual(
    tata.legs.map((l) => [l.side, l.tradingsymbol, l.qty]),
    [
      ['Buy', 'TATASTEEL26OCT195CE', 13750],
      ['Buy', 'TATASTEEL26OCT162.5PE', 13750],
      ['Sell', 'TATASTEEL26OCT177.5CE', 13750],
      ['Sell', 'TATASTEEL26OCT177.5PE', 13750],
    ],
  )
  assert.ok(tata.orders.every((o) => o.lots === 5))
  const kal = planOpen(bookOf(KALYAN), chainFor('KALYANKJIL'), AT)
  assert.deepEqual(
    kal.legs.map((l) => [l.side, l.tradingsymbol, l.qty]),
    [
      ['Buy', 'KALYANKJIL26OCT580CE', 2700],
      ['Buy', 'KALYANKJIL26OCT480PE', 2700],
      ['Sell', 'KALYANKJIL26OCT530CE', 2700],
      ['Sell', 'KALYANKJIL26OCT530PE', 2700],
    ],
  )
  assert.ok(kal.orders.every((o) => o.lots === 2 && o.mode === 'paper'))
})

test('a missing future mark or leg quote is a problem, not a guess', () => {
  const noFuture = planOpen(bookOf(TCS), chainFor('TCS', { future: null }), AT)
  assert.equal(noFuture.orders.length, 0)
  assert.match(noFuture.problems.join(';'), /no live mark for the TCS future/)

  const noWing = planOpen(bookOf(TCS), chainFor('TCS', { price: (k, t) => (k === 1880 && t === 'PE' ? null : 5) }), AT)
  assert.deepEqual(noWing.problems, ['no live quote for TCS26OCT1880PE'])
})

test('a chain for another symbol or expiry is refused', () => {
  assert.throws(() => planOpen(bookOf(TCS), chainFor('TATASTEEL'), AT), /not TCS 2026-10-27/)
})

test('a stale future mark, or a leg quote from before today 09:15 IST, is a problem', () => {
  // The future must have ticked within two minutes of the open.
  const oldFuture = planOpen(bookOf(TCS), chainFor('TCS', { futureAsOf: MONDAY_0935 - 121_000 }), AT)
  assert.match(oldFuture.problems.join(';'), /the TCS future's mark is 121 s old/)
  const okFuture = planOpen(bookOf(TCS), chainFor('TCS', { futureAsOf: MONDAY_0935 - 119_000 }), AT)
  assert.deepEqual(okFuture.problems, [])
  const noAsOf = planOpen(bookOf(TCS), chainFor('TCS', { futureAsOf: null }), AT)
  assert.match(noAsOf.problems.join(';'), /the TCS future's mark has no timestamp/)

  // A leg quote must be from TODAY's session: Friday's close is not a price.
  const friday = ist('2026-10-02', 15, 29)
  const stale = planOpen(bookOf(TCS), chainFor('TCS', { asOf: (k, t) => (k === 2080 && t === 'PE' ? friday : MONDAY_0935) }), AT)
  assert.deepEqual(stale.problems, ['the quote for TCS26OCT2080PE is from before 09:15 IST today'])
  const preOpen = planOpen(bookOf(TCS), chainFor('TCS', { asOf: () => ist('2026-10-05', 9, 14, 59) }), AT)
  assert.equal(preOpen.problems.length, 4)
  const noStamp = planOpen(bookOf(TCS), chainFor('TCS', { asOf: () => undefined }), AT)
  assert.match(noStamp.problems.join(';'), /the quote for TCS26OCT2260CE has no timestamp/)
  assert.throws(() => planOpen(bookOf(TCS), chainFor('TCS'), {} as { nowMs: number }), /nowMs/)
})

test('--only narrows to the named books, in their usual order, and refuses a stranger', () => {
  assert.deepEqual(
    script.selectBooks(BOOKS, ['KALYANKJIL', 'TATASTEEL']).map((b) => b.tag),
    [TATA, KALYAN],
  )
  assert.deepEqual(script.selectBooks(BOOKS, []).map((b) => b.tag), [TCS, TATA, KALYAN], 'none named = all three')
  assert.throws(() => script.selectBooks(BOOKS, ['INFY']), /INFY is not one of this script's books/)
})

test('the seed records the filled rates, shorts negative, and the API would accept it', () => {
  const plan = planOpen(bookOf(TCS), chainFor('TCS'), AT)
  const submitted = plan.orders.map((o) => ({ orders: [{ clientOrderId: `${o.clientOrderId}#0` }] }))
  const rates = [6.425, 6.05, 53.125, 57.599999999999994]
  const trades = plan.orders.map((o, i) => ({
    clientOrderId: `${o.clientOrderId}#0`,
    status: 'COMPLETE',
    filled_quantity: 1125,
    price: rates[i],
  }))
  const got = script.filledLegs(plan, submitted, trades)
  assert.deepEqual(got.failed, [])
  assert.deepEqual(got.legs, [
    { strike: 2260, type: 'CE', qty: 1125, rate: 6.425 },
    { strike: 1880, type: 'PE', qty: 1125, rate: 6.05 },
    { strike: 2080, type: 'CE', qty: -1125, rate: 53.125 },
    { strike: 2080, type: 'PE', qty: -1125, rate: 57.6 },
  ])
  const seed = script.seedBody(plan, got.legs ?? [])
  assert.deepEqual(seed, {
    tag: TCS,
    symbol: 'TCS',
    expiry: EXPIRY,
    mode: 'paper',
    replace: false,
    legs: got.legs,
  })
  const v = validateSeedRequest(seed)
  assert.ok(v.ok, v.ok ? '' : v.error)
})

test('fills: a missing trade is pending, a rejection or a short fill is a failure', () => {
  const plan = planOpen(bookOf(KALYAN), chainFor('KALYANKJIL'), AT)
  const submitted = plan.orders.map((o) => ({ orders: [{ clientOrderId: `${o.clientOrderId}#0` }] }))
  const complete = (i: number, extra: Record<string, unknown> = {}) => ({
    clientOrderId: `${plan.orders[i]?.clientOrderId}#0`,
    status: 'COMPLETE',
    filled_quantity: 2700,
    price: 10,
    ...extra,
  })
  const three = script.filledLegs(plan, submitted, [complete(0), complete(1), complete(2)])
  assert.equal(three.legs, null)
  assert.deepEqual(three.pending, [`${plan.orders[3]?.clientOrderId}#0`])
  // Each order is judged on its own: two missing are both named.
  const two = script.filledLegs(plan, submitted, [complete(0), complete(1)])
  assert.deepEqual(two.pending, [`${plan.orders[2]?.clientOrderId}#0`, `${plan.orders[3]?.clientOrderId}#0`])

  const rejected = script.filledLegs(plan, submitted, [complete(0), complete(1), complete(2), complete(3, { status: 'REJECTED' })])
  assert.equal(rejected.legs, null)
  assert.match(rejected.failed.join(';'), /REJECTED/)

  const short = script.filledLegs(plan, submitted, [complete(0), complete(1), complete(2), complete(3, { filled_quantity: 1350 })])
  assert.equal(short.legs, null)
  assert.match(short.failed.join(';'), /filled 1350, expected 2700/)
})

// ------------------------------------------------- the wire, against a fake desk

const REG = '/v1/desk/books/registry'
const STRAT = '/v1/desk/strategies'

interface FakeDesk {
  readonly calls: string[]
  readonly bodies: Array<{ call: string; body: unknown }>
  readonly request: Request
}

/**
 * A desk-api that answers as the paper rail does: a submit fills at once and
 * the trade is visible on the next `GET /v1/desk/trades`. Every call recorded.
 */
function fakeDesk(
  opts: {
    rows?: Record<string, unknown>[]
    held?: Readonly<Record<string, unknown[]>>
    trades?: Readonly<Record<string, Record<string, unknown>[]>>
    chain?: (symbol: string) => Chain
    submit?: (body: SubmitBody, n: number) => WireResult | null
    /** Tags whose paper switch is OFF on the strategy row. */
    switchedOff?: readonly string[]
    killSwitch?: boolean
    /** Tags that already have a `desk-books` document (positions answer a symbol). */
    docFor?: Readonly<Record<string, string>>
    seed?: (body: unknown) => WireResult | null
  } = {},
): FakeDesk {
  const calls: string[] = []
  const bodies: Array<{ call: string; body: unknown }> = []
  const rows =
    opts.rows ?? BOOKS.map((b) => ({ ...b, desired: 'running', actual: 'running', createdAt: MONDAY_0935 }))
  const trades: Record<string, Record<string, unknown>[]> = Object.fromEntries(
    Object.entries(opts.trades ?? {}).map(([k, v]) => [k, [...v]]),
  )
  let submits = 0
  const ok = (body: unknown, status = 200): WireResult => ({ status, body, text: JSON.stringify(body) })
  return {
    calls,
    bodies,
    async request(method, path, body) {
      const call = `${method} ${path}`
      calls.push(call)
      if (body !== undefined) bodies.push({ call, body })
      const url = new URL(path, 'http://desk')
      const tag = url.searchParams.get('tag') ?? ''
      if (method === 'GET' && url.pathname === REG) return ok({ books: rows })
      if (method === 'GET' && url.pathname === '/v1/desk/positions') {
        return ok({ tag, symbol: opts.docFor?.[tag] ?? '', legs: opts.held?.[tag] ?? [] })
      }
      if (method === 'GET' && url.pathname === STRAT) {
        return ok({
          strategies: rows.map((r) => ({
            tag: r['tag'],
            modes: { paper: { enabled: !(opts.switchedOff ?? []).includes(String(r['tag'])) } },
          })),
        })
      }
      if (method === 'GET' && url.pathname === '/v1/desk/killswitch') {
        return ok({ enabled: opts.killSwitch ?? false, reason: '', setBy: '', setAt: 0 })
      }
      if (method === 'GET' && url.pathname === '/v1/desk/trades') return ok({ trades: trades[tag] ?? [] })
      if (method === 'GET' && url.pathname.startsWith('/v1/desk/chain/')) {
        const symbol = url.pathname.split('/').at(-1) as string
        return ok((opts.chain ?? chainFor)(symbol))
      }
      if (method === 'POST' && path === '/v1/desk/submit') {
        const b = body as SubmitBody
        submits += 1
        const override = opts.submit?.(b, submits)
        if (override !== undefined && override !== null) return override
        const coid = `${b.clientOrderId}#0`
        const qty = b.lots * b.instrument.lotSize
        ;(trades[b.tag] ??= []).push({ clientOrderId: coid, status: 'COMPLETE', filled_quantity: qty, price: 7.5, mode: 'paper' })
        return ok({
          accepted: true,
          status: 'DONE',
          clientOrderId: b.clientOrderId,
          routedLots: b.lots,
          lots: b.lots,
          orders: [{ clientOrderId: coid, lots: b.lots, qty }],
        })
      }
      if (method === 'POST' && path === '/v1/desk/seed') {
        const override = opts.seed?.(body)
        if (override !== undefined && override !== null) return override
        const b = body as { legs: unknown[] }
        return ok({ booked: b.legs, unresolved: [] })
      }
      if (method === 'POST' && path === REG) return ok({ ...(body as object), desired: 'stopped' }, 201)
      if (method === 'POST' && path.endsWith('/start')) return ok({ desired: 'running', mode: 'paper' })
      if (method === 'PATCH' && path.startsWith(STRAT)) return ok({ modes: { paper: { enabled: true } } })
      return ok({ error: `unrouted ${call}` }, 404)
    },
  }
}

const noSleep = async (): Promise<void> => {}
const openAt = (desk: FakeDesk, at = MONDAY_0935) =>
  script.openBooks(BOOKS, { request: desk.request, now: () => at, sleep: noSleep })

test('--open: refuses outside the window before a single request', async () => {
  for (const at of [ist('2026-10-05', 9, 0), ist('2026-10-05', 15, 30), ist('2026-10-04', 10, 0)]) {
    const desk = fakeDesk()
    await assert.rejects(openAt(desk, at), /REFUSED/)
    assert.deepEqual(desk.calls, [], 'nothing was asked of the desk')
  }
})

test('--open: the exact call order — every check, every chain, then submit, fill, seed per book', async () => {
  const desk = fakeDesk()
  const done = await openAt(desk)
  assert.deepEqual(done, { opened: 3, seeded: [TCS, TATA, KALYAN] })

  const expected: string[] = [`GET ${REG}?mode=paper`, `GET ${STRAT}?mode=paper`, 'GET /v1/desk/killswitch']
  for (const tag of [TCS, TATA, KALYAN]) {
    expected.push(`GET /v1/desk/positions?tag=${tag}&mode=paper`, `GET /v1/desk/trades?tag=${tag}&mode=paper`)
  }
  for (const s of ['TCS', 'TATASTEEL', 'KALYANKJIL']) expected.push(`GET /v1/desk/chain/${s}?expiry=${EXPIRY}`)
  for (const tag of [TCS, TATA, KALYAN]) {
    expected.push(
      'POST /v1/desk/submit',
      'POST /v1/desk/submit',
      'POST /v1/desk/submit',
      'POST /v1/desk/submit',
      `GET /v1/desk/trades?tag=${tag}&mode=paper`,
      'POST /v1/desk/seed',
    )
  }
  assert.deepEqual(desk.calls, expected)

  // Wings bought before the straddle is sold, in every book.
  const submits = desk.bodies.filter((b) => b.call === 'POST /v1/desk/submit').map((b) => b.body as SubmitBody)
  assert.deepEqual(
    submits.map((s) => `${s.side} ${s.instrument.tradingsymbol} x${s.lots}`),
    [
      'Buy TCS26OCT2260CE x5',
      'Buy TCS26OCT1880PE x5',
      'Sell TCS26OCT2080CE x5',
      'Sell TCS26OCT2080PE x5',
      'Buy TATASTEEL26OCT195CE x5',
      'Buy TATASTEEL26OCT162.5PE x5',
      'Sell TATASTEEL26OCT177.5CE x5',
      'Sell TATASTEEL26OCT177.5PE x5',
      'Buy KALYANKJIL26OCT580CE x2',
      'Buy KALYANKJIL26OCT480PE x2',
      'Sell KALYANKJIL26OCT530CE x2',
      'Sell KALYANKJIL26OCT530PE x2',
    ],
  )
  assert.ok(submits.every((s) => s.mode === 'paper'))

  // The seed carries what FILLED (7.5 on the fake rail), shorts negative.
  const seeds = desk.bodies.filter((b) => b.call === 'POST /v1/desk/seed').map((b) => b.body)
  assert.deepEqual(seeds[2], {
    tag: KALYAN,
    symbol: 'KALYANKJIL',
    expiry: EXPIRY,
    mode: 'paper',
    replace: false,
    legs: [
      { strike: 580, type: 'CE', qty: 2700, rate: 7.5 },
      { strike: 480, type: 'PE', qty: 2700, rate: 7.5 },
      { strike: 530, type: 'CE', qty: -2700, rate: 7.5 },
      { strike: 530, type: 'PE', qty: -2700, rate: 7.5 },
    ],
  })
  assert.ok(!desk.calls.some((c) => c.startsWith('DELETE') || /purge|flatten|live/.test(c)))
})

test('--open: a book that holds legs is refused before any order is built', async () => {
  const desk = fakeDesk({ held: { [TATA]: [{ qty: -13750 }] } })
  await assert.rejects(openAt(desk), /TATASTEEL-2026-10-27-recenter-relief-r already holds 1 leg/)
  assert.equal(desk.calls.filter((c) => c.startsWith('POST')).length, 0)
  assert.equal(desk.calls.filter((c) => c.includes('/chain/')).length, 0, 'not even a chain read')
})

test('--open: a tag that has traded but holds nothing (a half-finished open) is refused', async () => {
  const desk = fakeDesk({ trades: { [KALYAN]: [{ clientOrderId: 'x#0', status: 'COMPLETE' }] } })
  await assert.rejects(openAt(desk), /KALYANKJIL-2026-10-27-recenter-relief-r holds no legs but has 1 trade/)
  assert.equal(desk.calls.filter((c) => c.startsWith('POST')).length, 0)
})

test('--open: an unregistered, stopped, mismatched or live row is refused before any order', async () => {
  const running = BOOKS.map((b) => ({ ...b, desired: 'running' }))
  const cases: Array<[Record<string, unknown>[], RegExp]> = [
    [running.filter((r) => r.tag !== TATA), /TATASTEEL-2026-10-27-recenter-relief-r is not registered/],
    [running.map((r) => (r.tag === TCS ? { ...r, desired: 'stopped' } : r)), /TCS-2026-10-27-recenter-relief-r is stopped/],
    [running.map((r) => (r.tag === TCS ? { ...r, expiry: '2026-09-29' } : r)), /not TCS 2026-10-27/],
    [running.map((r) => (r.tag === TCS ? { ...r, mode: 'live' } : r)), /REFUSED: a paper registry read returned/],
  ]
  for (const [rows, why] of cases) {
    const desk = fakeDesk({ rows })
    await assert.rejects(openAt(desk), why)
    assert.equal(desk.calls.filter((c) => c.startsWith('POST')).length, 0)
  }
})

test('--open: one unpriced contract in the LAST book stops the run before the FIRST order', async () => {
  const desk = fakeDesk({
    chain: (s) =>
      s === 'KALYANKJIL' ? chainFor(s, { price: (k, t) => (k === 480 && t === 'PE' ? null : 3) }) : chainFor(s),
  })
  await assert.rejects(openAt(desk), /no live quote for KALYANKJIL26OCT480PE/)
  assert.equal(desk.calls.filter((c) => c.startsWith('POST')).length, 0)
})

test('--open: a refused submit stops the run, says what routed, and seeds nothing', async () => {
  const desk = fakeDesk({
    submit: (_b, n) =>
      n === 3
        ? { status: 200, body: { accepted: false, status: 'DONE', reason: 'kill switch', routedLots: 0 }, text: 'kill switch' }
        : null,
  })
  await assert.rejects(openAt(desk), (e: unknown) => {
    assert.ok(e instanceof Error)
    assert.match(e.message, /kill switch/)
    assert.match(e.message, /TCS-2026-10-27-recenter-relief-r: STOPPED after 2 of 4 entry orders were submitted/)
    assert.match(e.message, /books already seeded: none/)
    return true
  })
  assert.equal(desk.calls.filter((c) => c === 'POST /v1/desk/submit').length, 3)
  assert.equal(desk.calls.filter((c) => c === 'POST /v1/desk/seed').length, 0)
})

test('--open: fills that never arrive are waited for, then the book is NOT seeded', async () => {
  const desk = fakeDesk({
    submit: (b) => ({
      status: 200,
      body: { accepted: true, status: 'DONE', routedLots: b.lots, orders: [{ clientOrderId: `${b.clientOrderId}#0`, lots: b.lots }] },
      text: '',
    }),
  })
  let slept = 0
  const sleep = async (): Promise<void> => {
    slept += 1
  }
  await assert.rejects(
    script.openBooks(BOOKS, { request: desk.request, now: () => MONDAY_0935, sleep }),
    /did not all fill/,
  )
  assert.equal(slept, 9, 'ten reads, nine waits between them')
  assert.equal(desk.calls.filter((c) => c === 'POST /v1/desk/seed').length, 0)
})

test('--open: a request that THROWS after the first order says what may have routed', async () => {
  const desk = fakeDesk()
  let posts = 0
  const request: Request = async (m, p, b) => {
    if (m === 'POST' && p === '/v1/desk/submit') {
      posts += 1
      if (posts === 3) throw new TypeError('fetch failed')
    }
    return await desk.request(m, p, b)
  }
  await assert.rejects(
    script.openBooks(BOOKS, { request, now: () => MONDAY_0935, sleep: noSleep }),
    (e: unknown) => {
      assert.ok(e instanceof Error)
      assert.match(e.message, /TCS-2026-10-27-recenter-relief-r: STOPPED after 2 of 4 entry orders were submitted/)
      assert.match(e.message, /fetch failed/)
      assert.match(e.message, /books already seeded: none/)
      assert.match(e.message, /orders may have ROUTED — check GET \/v1\/desk\/trades\?tag=TCS-2026-10-27-recenter-relief-r&mode=paper; runbook §3/)
      return true
    },
  )
  assert.equal(desk.calls.filter((c) => c === 'POST /v1/desk/seed').length, 0)
})

test('--open: a failure in a LATER book names the books already seeded', async () => {
  const desk = fakeDesk({
    seed: (body) =>
      (body as { tag: string }).tag === KALYAN ? { status: 409, body: { error: 'already holds 4 legs' }, text: 'already holds 4 legs' } : null,
  })
  await assert.rejects(openAt(desk), (e: unknown) => {
    assert.ok(e instanceof Error)
    assert.match(e.message, /KALYANKJIL-2026-10-27-recenter-relief-r: STOPPED after 4 of 4 entry orders were submitted/)
    assert.match(e.message, /books already seeded: TCS-2026-10-27-recenter-relief-r, TATASTEEL-2026-10-27-recenter-relief-r/)
    // A 409 means the book may ALREADY hold these legs: look before seeding again.
    assert.match(e.message, /check GET \/v1\/desk\/positions\?tag=KALYANKJIL-2026-10-27-recenter-relief-r&mode=paper FIRST/)
    return true
  })
})

test('--open: the fill timeout names the books already seeded', async () => {
  const desk = fakeDesk({
    submit: (b) =>
      b.tag === TATA
        ? { status: 200, body: { accepted: true, status: 'DONE', routedLots: b.lots, orders: [{ clientOrderId: `${b.clientOrderId}#0` }] }, text: '' }
        : null,
  })
  await assert.rejects(openAt(desk), /did not all fill[\s\S]*books already seeded: TCS-2026-10-27-recenter-relief-r\./)
})

test('--open: a paper switch that is off, or the kill switch on, refuses before any order', async () => {
  const off = fakeDesk({ switchedOff: [KALYAN] })
  await assert.rejects(openAt(off), /KALYANKJIL-2026-10-27-recenter-relief-r is switched OFF for paper/)
  assert.equal(off.calls.filter((c) => c.startsWith('POST')).length, 0)

  const halted = fakeDesk({ killSwitch: true })
  await assert.rejects(openAt(halted), /the kill switch is ENGAGED/)
  assert.equal(halted.calls.filter((c) => c.startsWith('POST')).length, 0)
})

test('--open: a book that already has a desk-books document is refused (the submits would fold into it)', async () => {
  const desk = fakeDesk({ docFor: { [TCS]: 'TCS' } })
  await assert.rejects(openAt(desk), /TCS-2026-10-27-recenter-relief-r already has a book document/)
  assert.equal(desk.calls.filter((c) => c.startsWith('POST')).length, 0)
})

test('--open --only: opens the named book alone, after an earlier one stopped halfway', async () => {
  // TCS traded and stopped; the operator finishes it by hand and opens the rest.
  const desk = fakeDesk({ trades: { [TCS]: [{ clientOrderId: 'x#0', status: 'COMPLETE' }] } })
  await assert.rejects(openAt(desk), /TCS-2026-10-27-recenter-relief-r holds no legs but has 1 trade/)
  const rest = fakeDesk({ trades: { [TCS]: [{ clientOrderId: 'x#0', status: 'COMPLETE' }] } })
  const done = await script.openBooks(script.selectBooks(BOOKS, ['TATASTEEL', 'KALYANKJIL']), {
    request: rest.request,
    now: () => MONDAY_0935,
    sleep: noSleep,
  })
  assert.deepEqual(done.seeded, [TATA, KALYAN])
  assert.ok(!rest.calls.some((c) => c.includes(TCS)), 'TCS was not touched')
})

test('--register --only: registers just the named books', async () => {
  const desk = fakeDesk({ rows: [] })
  const done = await script.registerBooks(EXPIRY, { request: desk.request }, { only: ['KALYANKJIL'] })
  assert.equal(done.created, 1)
  assert.deepEqual(desk.calls, [`GET ${REG}?mode=paper`, `POST ${REG}`, `POST ${REG}/${KALYAN}/start`, `PATCH ${STRAT}/${KALYAN}`])
})

test('--register: reads the registry, then create, start, switch on — per book, in order', async () => {
  const desk = fakeDesk({ rows: [] })
  const done = await script.registerBooks(EXPIRY, { request: desk.request })
  assert.deepEqual(done, { created: 3, started: 3, switchedOn: 3, series: false })
  const expected = [`GET ${REG}?mode=paper`]
  for (const tag of [TCS, TATA, KALYAN]) {
    expected.push(`POST ${REG}`, `POST ${REG}/${tag}/start`, `PATCH ${STRAT}/${tag}`)
  }
  assert.deepEqual(desk.calls, expected)
  const creates = desk.bodies.filter((b) => b.call === `POST ${REG}`).map((b) => b.body)
  assert.deepEqual(creates, planStockBooks(EXPIRY))
  for (const b of desk.bodies.filter((x) => x.call.endsWith('/start'))) assert.deepEqual(b.body, { mode: 'paper' })
  for (const b of desk.bodies.filter((x) => x.call.startsWith('PATCH'))) {
    assert.deepEqual(b.body, { modes: { paper: { enabled: true } } })
  }
})

test('--register: series goes on the create only when the registry rows already carry it', async () => {
  const desk = fakeDesk({
    rows: [{ tag: 'NIFTY-delta-lean-aggressive-2026-10-01', mode: 'paper', series: 'NIFTY-delta-lean-aggressive' }],
  })
  const done = await script.registerBooks(EXPIRY, { request: desk.request })
  assert.equal(done.series, true)
  const creates = desk.bodies.filter((b) => b.call === `POST ${REG}`).map((b) => (b.body as BookPlan).series)
  assert.deepEqual(creates, ['TCS-recenter-relief-r', 'TATASTEEL-recenter-relief-r', 'KALYANKJIL-recenter-relief-r'])
})

test('--register: a switch that will not flip stops the run', async () => {
  const desk = fakeDesk({ rows: [] })
  const request: Request = async (m, p, b) =>
    m === 'PATCH' ? { status: 400, body: { error: 'not added' }, text: 'not added' } : await desk.request(m, p, b)
  await assert.rejects(script.registerBooks(EXPIRY, { request }), /switch on TCS-2026-10-27-recenter-relief-r failed/)
})

test('flags: exactly one phase, and no flag that changes the mode', () => {
  assert.deepEqual(script.parseArgs(['--register']), { register: true, open: false, apply: false, json: false, help: false, only: [] })
  assert.deepEqual(script.parseArgs(['--open', '--apply']), { register: false, open: true, apply: true, json: false, help: false, only: [] })
  assert.deepEqual(script.parseArgs(['--open', '--only', 'TATASTEEL', '--only', 'KALYANKJIL']).only, ['TATASTEEL', 'KALYANKJIL'])
  assert.throws(() => script.parseArgs(['--open', '--only']), /--only needs a symbol/)
  assert.throws(() => script.parseArgs(['--open', '--only', '--apply']), /--only needs a symbol/)
  assert.throws(() => script.parseArgs([]), /exactly one of --register or --open/)
  assert.throws(() => script.parseArgs(['--register', '--open']), /exactly one/)
  assert.throws(() => script.parseArgs(['--register', '--mode', 'live']), /unrecognised argument "--mode"/)
  assert.throws(() => script.parseArgs(['--open', '--apply', '--dry-run']), /opposites/)
  assert.throws(() => script.parseArgs(['--register', '--dry-run', '--apply']), /opposites/)
  assert.equal(script.parseArgs(['--help']).help, true)
})

// ---------------------------------------- --register against the real routes

const URL_MONGO = process.env['DESK_TEST_MONGO'] ?? 'mongodb://127.0.0.1:27017/algomaker_dx_stock_books_test'
const TOKEN = 'machine-token-do-not-use-in-prod'
const NOW = Date.UTC(2026, 9, 4, 11, 0)

let handle: MongoHandle | null = null
let store: DeskStore
let server: Server | null = null
let base = ''
let available = false
/** The start route nudges the supervisor; the sink keeps that off the live one. */
let sink: NudgeSink | null = null

function itMongo(name: string, fn: () => Promise<void>): void {
  test(name, async (t) => {
    if (!available) {
      skipUnlessMongo(t)
      return
    }
    await fn()
  })
}

before(async () => {
  try {
    handle = await connectMongo(URL_MONGO, { serverSelectionTimeoutMS: 2500 })
  } catch {
    available = false
    return
  }
  store = new DeskStore(handle.db)
  await store.ensureIndexes()
  const apiDeps = {
    db: handle.db,
    store,
    service: {
      patchStrategy: (tag: string, patch: unknown, expected?: number) =>
        store.patchStrategy(tag, patch as Parameters<DeskStore['patchStrategy']>[1], NOW, expected),
    } as unknown as ApiDeps['service'],
    log: () => {},
    now: () => NOW,
    gate: bearerGate(TOKEN),
  } as unknown as Parameters<typeof booksRoutes>[0] & Parameters<typeof deskRoutes>[0]
  server = createBridgeServer({ gate: bearerGate(TOKEN), routes: [booksRoutes(apiDeps), deskRoutes(apiDeps)] })
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`
  sink = await startNudgeSink()
  await startE2e()
  available = true
})

after(async () => {
  if (server !== null) await new Promise<void>((r) => server!.close(() => r()))
  if (e2e !== null) await new Promise<void>((r) => e2e!.close(() => r()))
  if (sink !== null) await sink.close()
  if (handle !== null) await handle.close()
})

beforeEach(async () => {
  if (!available) return
  for (const c of Object.values(COLLECTIONS)) await handle!.db.collection(c).deleteMany({})
  // The submit route's replay lock is not in COLLECTIONS. Left behind, the
  // deterministic entry ids of the previous run REPLAY instead of routing, and
  // the replayed answer points at trades this cleanup has just deleted.
  await handle!.db.collection(SUBMISSIONS).deleteMany({})
  await store.ensureIndexes()
  if (sink !== null) sink.nudges.length = 0
})

/** The same `request` `main` builds, pointed at the test server. */
const realRequest: Request = (method, path, body) => siblings.requestJson(base, method, path, body, TOKEN)

itMongo('--register on a real registry: three running paper books, each switched on', async () => {
  const calls: string[] = []
  const request: Request = async (m, p, b) => {
    calls.push(`${m} ${p}`)
    return await realRequest(m, p, b)
  }
  const done = await script.registerBooks(EXPIRY, { request })
  assert.deepEqual(done, { created: 3, started: 3, switchedOn: 3, series: false })
  assert.equal(calls.length, 10)

  const rows = await store.listBooks('paper')
  assert.deepEqual(rows.map((r) => r.tag).sort(), [KALYAN, TATA, TCS])
  for (const r of rows) {
    assert.equal(r.desired, 'running')
    assert.equal(r.variant, 'recenter-relief-r')
    assert.equal(r.expiry, EXPIRY)
    assert.deepEqual(r.dials, script.DIALS)
    const strategy = await store.loadStrategy(r.tag)
    assert.ok(strategy !== null && isOn(strategy.modes, 'paper'), `${r.tag} is not switched on for paper`)
    assert.equal(strategy.modes.live?.enabled ?? false, false, `${r.tag} must not be on for live`)
  }
  assert.equal((await store.listBooks('live')).length, 0, 'nothing reached the live registry')
  assert.equal(sink?.nudges.length, 3, 'each start nudged the (sunk) supervisor once')
})

itMongo('--register run twice converges: still three rows, every call answered', async () => {
  await script.registerBooks(EXPIRY, { request: realRequest })
  const again = await script.registerBooks(EXPIRY, { request: realRequest })
  // The first run registered three rows; the registry now answers with a
  // `series` on every row (WS2), so the second run sends series too.
  assert.deepEqual(again, { created: 3, started: 3, switchedOn: 3, series: true })
  assert.equal((await store.listBooks('paper')).length, 3)
})

// ------------------------------------------------- a hung desk cannot hang a run

test('every request has a deadline: a desk that never answers is an error, not a hang', async () => {
  const hung = createServer(() => {
    // Accept the request and never answer it.
  })
  await new Promise<void>((r) => hung.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${(hung.address() as AddressInfo).port}`
  try {
    await assert.rejects(siblings.requestJson(url, 'GET', '/v1/desk/killswitch', undefined, 't', { timeoutMs: 100 }), /timeout|aborted/i)
    await assert.rejects(script.deskRequest(url, 't', 100)('GET', '/v1/desk/killswitch'), /timeout|aborted/i)
    assert.equal(script.REQUEST_TIMEOUT_MS, 15_000, 'the run uses 15 s')
  } finally {
    hung.closeAllConnections()
    await new Promise<void>((r) => hung.close(() => r()))
  }
})

// ------------------- the invariant --open rests on, against the real routes

/** The TCS October chain as an `OptionMaster` row set, and the marks the paper rail fills at. */
function tcsMaster(): OptionMaster {
  const rows: InstrumentRow[] = []
  for (const strike of STRIKES['TCS'] as readonly number[]) {
    for (const type of ['CE', 'PE'] as const) {
      const c = contractOf('TCS', strike, type)
      rows.push({
        instrument_token: c.instrumentToken === 1 ? 900_000 + strike * 2 + (type === 'CE' ? 0 : 1) : c.instrumentToken,
        tradingsymbol: c.tradingsymbol,
        name: 'TCS',
        expiry: EXPIRY,
        strike,
        tick_size: 0.05,
        lot_size: 225,
        instrument_type: type,
        segment: 'NFO-OPT',
        exchange: 'NFO',
      })
    }
  }
  return new OptionMaster(rows)
}
const FILL_AT: Readonly<Record<string, number>> = {
  TCS26OCT2260CE: 6.4,
  TCS26OCT1880PE: 6.05,
  TCS26OCT2080CE: 53.1,
  TCS26OCT2080PE: 57.6,
}

let e2e: Server | null = null
let e2eBase = ''

/**
 * Started from the ONE top-level `before` above: a second top-level hook
 * declared after the tests does not run ahead of them.
 */
async function startE2e(): Promise<void> {
  if (handle === null) return
  const m = tcsMaster()
  const marks = new StaticMarks(
    Object.fromEntries((STRIKES['TCS'] as readonly number[]).flatMap((k) => [
      [`TCS26OCT${k}CE`, FILL_AT[`TCS26OCT${k}CE`] ?? 5],
      [`TCS26OCT${k}PE`, FILL_AT[`TCS26OCT${k}PE`] ?? 5],
    ])),
    { TCS: 2076.8 },
  )
  const service = new BridgeService({
    store,
    rails: { paper: new PaperRail(handle.db), live: new LiveRail(handle.db, []) },
    master: { current: () => m },
    marks,
    clock: { now: () => MONDAY_0935 },
  })
  const deps = {
    db: handle.db,
    store,
    service,
    master: { current: () => m },
    marks,
    log: () => {},
    now: () => MONDAY_0935,
    gate: bearerGate(TOKEN),
  } as unknown as ApiDeps & Parameters<typeof deskRoutes>[0]
  e2e = createBridgeServer({
    gate: bearerGate(TOKEN),
    routes: [booksRoutes(deps), submitRoutes(deps), deskRoutes(deps)],
  })
  await new Promise<void>((r) => e2e!.listen(0, '127.0.0.1', r))
  e2eBase = `http://127.0.0.1:${(e2e!.address() as AddressInfo).port}`
}

itMongo('registered, no book document: four paper submits fold NOTHING, the seed books four, positions show them', async () => {
  const real = script.deskRequest(e2eBase, TOKEN)
  await script.registerBooks(EXPIRY, { request: real }, { only: ['TCS'] })
  assert.equal(await store.bookDoc(TCS, 'paper'), null, 'registering writes no book document')

  let docBeforeSeed: unknown = 'not checked'
  const request: Request = async (m, p, b) => {
    // The live chain needs a quote cache this harness does not run; the
    // chain is the fixture, priced where the marks will fill.
    if (m === 'GET' && p.startsWith('/v1/desk/chain/TCS')) {
      const chain = chainFor('TCS', { price: (k, t) => FILL_AT[`TCS26OCT${k}${t}`] ?? 5 })
      return { status: 200, body: chain, text: '' }
    }
    if (m === 'POST' && p === '/v1/desk/seed') docBeforeSeed = await store.bookDoc(TCS, 'paper')
    return await real(m, p, b)
  }
  // A real (short) wait between fill polls: the paper rail's trade write lands
  // a tick after the submit answers, and under the full parallel suite a
  // zero-wait poll can run all ten attempts before it does.
  const shortSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, Math.min(ms, 50)))
  const done = await script.openBooks(script.selectBooks(BOOKS, ['TCS']), { request, now: () => MONDAY_0935, sleep: shortSleep })
  assert.deepEqual(done.seeded, [TCS])
  assert.equal(docBeforeSeed, null, 'the four filled submits folded nothing into a book')

  const pos = await real('GET', `/v1/desk/positions?tag=${TCS}&mode=paper`)
  assert.equal(pos.status, 200, pos.text)
  const legs = (pos.body as { legs: Array<{ qty: number; entryPrice: number; instrument: { tradingsymbol: string } }> }).legs
  assert.deepEqual(
    legs.map((l) => [l.instrument.tradingsymbol, l.qty, l.entryPrice]).sort(),
    [
      ['TCS26OCT1880PE', 1125, 6.05],
      ['TCS26OCT2080CE', -1125, 53.1],
      ['TCS26OCT2080PE', -1125, 57.6],
      ['TCS26OCT2260CE', 1125, 6.4],
    ],
  )
  // And a second --open now refuses: the book holds legs.
  await assert.rejects(
    script.openBooks(script.selectBooks(BOOKS, ['TCS']), { request, now: () => MONDAY_0935, sleep: noSleep }),
    /already holds 4 leg/,
  )
})
