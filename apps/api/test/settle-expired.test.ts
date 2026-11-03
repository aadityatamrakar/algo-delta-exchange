/**
 * SETTLING A LEG WHOSE CONTRACT HAS EXPIRED — the paper book that missed its
 * flatten (spec §WS1 1a).
 *
 * The failure this ends: a paper book that misses its 14:50 flatten keeps an
 * expired leg forever. No simulator will ever fill an order on a contract that
 * no longer trades, the engine keeps emitting "past the flat-by — closing all
 * 1 leg(s)" against it, the roll refuses to retire the book ("holds legs"), and
 * the only exit was `?purge=1`, which destroys the history the Reports page is
 * built on.
 *
 * What is pinned here, in the order a mistake would cost:
 *
 *   1. ONLY AN EXPIRED LEG SETTLES. A leg in a live contract is left exactly
 *      where it is, and it still blocks the erase.
 *   2. NEVER GUESS A PRICE. No close for the underlying on the expiry date is a
 *      409 naming the leg, and NOTHING is written.
 *   3. THE CLOSE IS BOOKED WHERE P&L READS IT — `desk-decisions`, the same
 *      writer the flatten uses — so realised P&L and the day's report include
 *      it, and the DELETE guard (which rebuilds the position from those fills)
 *      reads the book flat.
 *   4. IDEMPOTENT. A second call settles nothing and writes nothing.
 *   5. PAPER ONLY. A live row is a 400.
 */

import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { OptionMaster, type InstrumentRow } from '@algomaker/instruments'
import { realised } from '@algomaker/pnl'
import { skipUnlessMongo } from './require-mongo.ts'
import { startNudgeSink, type NudgeSink } from './nudge-sink.ts'
import { connectMongo, type MongoHandle } from '../src/mongo.ts'
import { createBridgeServer } from '../src/server.ts'
import { bearerGate } from '../src/authgate.ts'
import { DeskStore, COLLECTIONS } from '../src/store.ts'
import { booksRoutes } from '../src/routes/books.ts'
import { DEFAULT_BOOK } from '../src/books-registry.ts'
import { PnlStore, pnlKey } from '../src/pnlstore.ts'
import { heldFromFills } from '../src/held-position.ts'
import type { ApiDeps } from '../src/routes/kit.ts'
import type { BridgeLeg, DeskMode } from '../src/contract.ts'
import { intrinsicValue, planSettlement, type UnderlyingClose } from '../src/settle-expired.ts'

// ------------------------------------------------------------------ fixtures

/** Sunday 2026-10-04, 17:00 IST — the day the operator asked for this. */
const NOW = Date.UTC(2026, 9, 4, 11, 30)
const TODAY = '2026-10-04'

function leg(over: Partial<BridgeLeg> & Pick<BridgeLeg, 'expiry' | 'strike' | 'type' | 'qty'>): BridgeLeg {
  const tradingsymbol = over.instrument?.tradingsymbol ?? `X${over.expiry}${over.strike}${over.type}`
  return {
    deskTag: `${over.type}${over.strike}`,
    instrument: { tradingsymbol, instrumentToken: 1, lotSize: 20, tickSize: 0.05, exchange: 'BFO' },
    underlying: 'SENSEX',
    side: over.qty > 0 ? 'Buy' : 'Sell',
    entryPrice: 30,
    openedTs: NOW - 5 * 86_400_000,
    ...over,
  } as BridgeLeg
}

const close = (price: number): UnderlyingClose => ({ price, at: NOW, source: 'desk-marks' })

// ------------------------------------------------------------- pure: price

test('intrinsic value: CE is close − strike, PE is strike − close, never negative', () => {
  assert.equal(intrinsicValue({ type: 'CE', strike: 2000, close: 2044.85, tickSize: 0.05 }), 44.85)
  assert.equal(intrinsicValue({ type: 'PE', strike: 2080, close: 2044.85, tickSize: 0.05 }), 35.15)
  assert.equal(intrinsicValue({ type: 'PE', strike: 71800, close: 72487.75, tickSize: 0.05 }), 0)
  assert.equal(intrinsicValue({ type: 'CE', strike: 72500, close: 72487.75, tickSize: 0.05 }), 0)
})

test('intrinsic value is tick-rounded to the instrument, with no float residue', () => {
  // 2080 − 2044.83 = 35.17 → nearest 0.05 is 35.15.
  assert.equal(intrinsicValue({ type: 'PE', strike: 2080, close: 2044.83, tickSize: 0.05 }), 35.15)
  // A tick of 0.1 rounds to the tenth.
  assert.equal(intrinsicValue({ type: 'CE', strike: 100, close: 112.36, tickSize: 0.1 }), 12.4)
})

// ------------------------------------------------------------- pure: plan

test('only the EXPIRED leg settles; a leg in a live contract is left and named', () => {
  const expired = leg({ expiry: '2026-10-01', strike: 71800, type: 'PE', qty: 80 })
  const live = leg({ expiry: '2026-10-08', strike: 72000, type: 'CE', qty: -40 })
  const plan = planSettlement({ legs: [expired, live] }, new Map([['2026-10-01', close(71000)]]), TODAY)
  assert.equal(plan.settle.length, 1)
  const s = plan.settle[0]!
  assert.equal(s.tradingsymbol, expired.instrument.tradingsymbol)
  assert.equal(s.qty, 80)
  assert.equal(s.side, 'Sell', 'a long is closed by a sell')
  assert.equal(s.price, 800)
  assert.equal(s.expiry, '2026-10-01')
  assert.deepEqual(plan.blocked, [live.instrument.tradingsymbol])
  assert.deepEqual(plan.unpriced, [])
})

test('a contract expiring TODAY is still live — it is not settled', () => {
  const today = leg({ expiry: TODAY, strike: 71800, type: 'PE', qty: 80 })
  const plan = planSettlement({ legs: [today] }, new Map([[TODAY, close(71000)]]), TODAY)
  assert.deepEqual(plan.settle, [])
  assert.deepEqual(plan.blocked, [today.instrument.tradingsymbol])
})

test('a short expired leg is closed by a BUY at intrinsic', () => {
  const short = leg({ expiry: '2026-09-29', strike: 2000, type: 'CE', qty: -1125, underlying: 'TCS' })
  const plan = planSettlement({ legs: [short] }, new Map([['2026-09-29', close(2044.85)]]), TODAY)
  assert.equal(plan.settle[0]?.side, 'Buy')
  assert.equal(plan.settle[0]?.qty, 1125)
  assert.equal(plan.settle[0]?.price, 44.85)
})

test('no close for the expiry date: the leg is UNPRICED, never guessed', () => {
  const expired = leg({ expiry: '2026-10-01', strike: 71800, type: 'PE', qty: 80 })
  // A close for ANOTHER day is not a close for this one.
  const plan = planSettlement({ legs: [expired] }, new Map([['2026-10-03', close(71909.7)]]), TODAY)
  assert.deepEqual(plan.settle, [])
  assert.deepEqual(plan.unpriced, [{ tradingsymbol: expired.instrument.tradingsymbol, expiry: '2026-10-01' }])
})

test('a leg whose identity cannot be read is blocked, not settled', () => {
  const bad = { ...leg({ expiry: '2026-10-01', strike: 71800, type: 'PE', qty: 80 }), strike: Number.NaN }
  const plan = planSettlement({ legs: [bad] }, new Map([['2026-10-01', close(71000)]]), TODAY)
  assert.deepEqual(plan.settle, [])
  assert.deepEqual(plan.blocked, [bad.instrument.tradingsymbol])
})

// ------------------------------------------------ against a real registry

const URL_MONGO = process.env['DESK_TEST_MONGO'] ?? 'mongodb://127.0.0.1:27017/algomaker_dx_settle_expired_test'
const TOKEN = 'machine-token-do-not-use-in-prod'
const REG = '/v1/desk/books/registry'

const TAG = 'SENSEX-delta-lean-aggressive-2026-10-01'
const EXPIRED_SYM = 'SENSEX26O0171800PE'
const LIVE_SYM = 'SENSEX26O0872000CE'
/** The SENSEX index spot token — `desk-marks` is keyed by it. */
const SPOT_TOKEN = 265
/** 2026-10-01 15:29:58 IST — the last tick of expiry day. */
const EXPIRY_CLOSE_AT = Date.UTC(2026, 9, 1, 9, 59, 58)

function testMaster(): OptionMaster {
  const rows: InstrumentRow[] = [
    {
      instrument_token: SPOT_TOKEN,
      tradingsymbol: 'SENSEX',
      name: 'SENSEX',
      expiry: '',
      strike: 0,
      tick_size: 0,
      lot_size: 0,
      instrument_type: 'EQ',
      segment: 'INDICES',
      exchange: 'BSE',
    },
    {
      instrument_token: 227_100_000,
      tradingsymbol: LIVE_SYM,
      name: 'SENSEX',
      expiry: '2026-10-08',
      strike: 72000,
      tick_size: 0.05,
      lot_size: 20,
      instrument_type: 'CE',
      segment: 'BFO-OPT',
      exchange: 'BFO',
    },
  ]
  return new OptionMaster(rows)
}

const EXPIRED_LEG: BridgeLeg = {
  deskTag: 'PE71800#lean',
  instrument: { tradingsymbol: EXPIRED_SYM, instrumentToken: 227040261, lotSize: 20, tickSize: 0.05, exchange: 'BFO' },
  underlying: 'SENSEX',
  expiry: '2026-10-01',
  strike: 71800,
  type: 'PE',
  side: 'Buy',
  qty: 80,
  entryPrice: 31.35,
  openedTs: Date.UTC(2026, 9, 1, 5, 36),
}
const LIVE_LEG: BridgeLeg = {
  deskTag: 'CE72000#lean',
  instrument: { tradingsymbol: LIVE_SYM, instrumentToken: 227_100_000, lotSize: 20, tickSize: 0.05, exchange: 'BFO' },
  underlying: 'SENSEX',
  expiry: '2026-10-08',
  strike: 72000,
  type: 'CE',
  side: 'Sell',
  qty: -40,
  entryPrice: 210,
  openedTs: Date.UTC(2026, 9, 1, 5, 40),
}

let handle: MongoHandle | null = null
let store: DeskStore
let server: Server | null = null
let base = ''
let available = false
/**
 * The stop route this suite drives nudges the supervisor. Pointed here so no
 * nudge from this file can reach the live desk-supervisor (`./nudge-sink.ts`).
 */
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

async function call(
  method: 'POST' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await res.text()
  return { status: res.status, body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>) }
}

const settle = (tag: string, mode = 'paper', body?: unknown): ReturnType<typeof call> =>
  call('POST', `${REG}/${tag}/settle-expired?mode=${mode}`, body)

/** Register a book, give it legs, and journal the opens the way the desk would have. */
async function standUp(
  opts: {
    mode?: DeskMode
    legs?: readonly BridgeLeg[]
    desired?: 'running' | 'stopped'
    tag?: string
    symbol?: string
    expiry?: string
    /** Journal these instead of one open per leg — to make the ledger disagree. */
    ledger?: readonly BridgeLeg[]
  } = {},
): Promise<void> {
  const mode = opts.mode ?? 'paper'
  const legs = opts.legs ?? [EXPIRED_LEG, LIVE_LEG]
  const tag = opts.tag ?? TAG
  const symbol = opts.symbol ?? 'SENSEX'
  const expiry = opts.expiry ?? '2026-10-01'
  await store.upsertBook({
    tag,
    symbol,
    expiry,
    mode,
    variant: symbol === 'SENSEX' ? 'delta-lean-aggressive' : 'recenter-relief-r',
    ...DEFAULT_BOOK,
    desired: opts.desired ?? 'running',
    actual: opts.desired ?? 'running',
    createdAt: Date.UTC(2026, 9, 1, 3, 20),
    updatedAt: Date.UTC(2026, 9, 1, 3, 20),
  })
  await store.saveBook({ tag, mode, symbol, expiry }, legs, Date.UTC(2026, 9, 1, 6))
  for (const [i, l] of (opts.ledger ?? legs).entries()) {
    await handle!.db.collection(COLLECTIONS.decisions).insertOne({
      decisionId: `${tag}:${mode}:open-${i}`,
      tag,
      mode,
      symbol,
      expiry: l.expiry,
      status: 'DONE',
      createdAt: l.openedTs,
      fills: [
        {
          op: 'open',
          deskTag: l.deskTag,
          tradingsymbol: l.instrument.tradingsymbol,
          side: l.side,
          qty: Math.abs(l.qty),
          price: l.entryPrice,
          ts: l.openedTs,
        },
      ],
    })
  }
}

/** The September TCS book: a stock, so the master here lists no cash row for it. */
const TCS_TAG = 'TCS-2026-09-29-recenter-relief-r'
const TCS_LEG: BridgeLeg = {
  deskTag: 'PE2080#seed',
  instrument: { tradingsymbol: 'TCS26SEP2080PE', instrumentToken: 39412482, lotSize: 225, tickSize: 0.05, exchange: 'NFO' },
  underlying: 'TCS',
  expiry: '2026-09-29',
  strike: 2080,
  type: 'PE',
  side: 'Buy',
  qty: 1125,
  entryPrice: 6.05,
  openedTs: Date.UTC(2026, 8, 7, 7, 50),
}

/** 15:30:00 IST on an IST date — where a settlement is booked. */
const settleAt = (dateIst: string): number => Date.parse(`${dateIst}T15:30:00+05:30`)

async function bookMark(tag: string, dateIst: string, istTime: string, spot: number): Promise<void> {
  await handle!.db.collection('desk-book-marks').insertOne({
    tag,
    mode: 'paper',
    dateIst,
    mark: Number(istTime.replace(':', '')),
    ts: Date.parse(`${dateIst}T${istTime}:00+05:30`),
    spot,
  })
}

async function markSpot(price: number, ts: number): Promise<void> {
  await handle!.db
    .collection('desk-marks')
    .updateOne({ token: SPOT_TOKEN }, { $set: { token: SPOT_TOKEN, price, ts } }, { upsert: true })
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
  const master = testMaster()
  const apiDeps = {
    db: handle.db,
    store,
    master: { current: () => master },
    service: {} as unknown as ApiDeps['service'],
    log: () => {},
    now: () => NOW,
    gate: bearerGate(TOKEN),
  } as unknown as Parameters<typeof booksRoutes>[0]
  server = createBridgeServer({ gate: bearerGate(TOKEN), routes: [booksRoutes(apiDeps)] })
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`
  sink = await startNudgeSink()
  available = true
})

after(async () => {
  if (server !== null) await new Promise<void>((r) => server!.close(() => r()))
  if (sink !== null) await sink.close()
  if (handle !== null) await handle.close()
})

beforeEach(async () => {
  if (!available) return
  for (const c of [
    ...Object.values(COLLECTIONS),
    'desk-marks',
    'desk-book-marks',
    'desk-broker-cancels',
    'desk-audit-log',
    'desk-payoff-snapshots',
    'desk-daily-reports',
    'desk-pnl-snapshots',
  ]) {
    await handle!.db.collection(c).deleteMany({})
  }
  await store.ensureIndexes()
  if (sink !== null) sink.nudges.length = 0
})

itMongo('one expired leg and one live leg: only the expired one settles, at intrinsic, and the erase is still refused', async () => {
  await standUp()
  // SENSEX closed 1 Oct at 71,000 — the 71,800 put expired 800 in the money.
  await markSpot(71000, EXPIRY_CLOSE_AT)

  const res = await settle(TAG)
  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.equal(res.body['tag'], TAG)
  assert.equal(res.body['mode'], 'paper')
  assert.equal(res.body['remaining'], 1)
  const settled = res.body['settled'] as Record<string, unknown>[]
  assert.equal(settled.length, 1)
  assert.equal(settled[0]?.['tradingsymbol'], EXPIRED_SYM)
  assert.equal(settled[0]?.['qty'], 80)
  assert.equal(settled[0]?.['price'], 800)
  assert.equal(settled[0]?.['source'], 'intrinsic')
  assert.equal(settled[0]?.['expiry'], '2026-10-01')
  assert.equal(settled[0]?.['closeSource'], 'desk-marks')

  // desk-books: the expired leg is gone, the live one untouched.
  const doc = await store.bookDoc(TAG, 'paper')
  assert.deepEqual(doc?.legs.map((l) => l.instrument.tradingsymbol), [LIVE_SYM])
  assert.equal(doc?.legs[0]?.qty, -40)

  // desk-decisions: one DONE settle decision, booked like a flatten's exit.
  const decision = await handle!.db.collection(COLLECTIONS.decisions).findOne({ tag: TAG, source: 'settle' })
  assert.ok(decision !== null, 'no settle decision was journalled')
  assert.equal(decision['desk_op'], 'settle')
  assert.equal(decision['status'], 'DONE')
  assert.equal(decision['mode'], 'paper')
  // Booked ON THE EXPIRY DATE at 15:30 IST — the decision and the fill both —
  // so the day the contract died carries its close; written today.
  assert.equal(decision['createdAt'], settleAt('2026-10-01'))
  assert.equal(decision['writtenAt'], NOW)
  const fills = decision['fills'] as Record<string, unknown>[]
  assert.equal(fills.length, 1)
  assert.equal(fills[0]?.['ts'], settleAt('2026-10-01'))
  assert.equal(fills[0]?.['side'], 'Sell')
  assert.equal(fills[0]?.['qty'], 80)
  assert.equal(fills[0]?.['price'], 800)
  assert.equal(fills[0]?.['op'], 'close')

  // P&L reads it: the round trip realises (800 − 31.35) × 80.
  const load = await new PnlStore(store).loadFills({ from: 0, to: NOW + 1, tag: TAG, mode: 'paper' })
  const tagFills = (load.byKey.get(pnlKey(TAG, 'paper')) ?? []).filter((f) => f.tradingsymbol === EXPIRED_SYM)
  assert.equal(Math.round(realised(tagFills) * 100), Math.round((800 - 31.35) * 80 * 100))

  // The DELETE guard rebuilds from the fills: only the live leg is held.
  const held = await heldFromFills(store, TAG, 'paper')
  assert.deepEqual(held.held.map((h) => h.tradingsymbol), [LIVE_SYM])
  assert.equal((await call('POST', `${REG}/${TAG}/stop`, { mode: 'paper' })).status, 200)
  const del = await call('DELETE', `${REG}/${TAG}?mode=paper`)
  assert.equal(del.status, 409, 'the live leg still blocks the erase')
  assert.match(String(del.body['error']), new RegExp(LIVE_SYM))

  // Audited, with the price and its source.
  const audit = await handle!.db
    .collection('desk-audit-log')
    .findOne({ tag: TAG, action: 'settled expired legs of a book' })
  assert.ok(audit !== null, 'the settlement is not in the audit log')
})

itMongo('no close for the underlying on the expiry date: 409 naming the leg, nothing written', async () => {
  await standUp()
  // The only mark on file is from Friday the 3rd — not the 1st.
  await markSpot(71909.7, Date.UTC(2026, 9, 3, 10))
  const decisionsBefore = await handle!.db.collection(COLLECTIONS.decisions).countDocuments({})
  const bookBefore = await store.bookDoc(TAG, 'paper')

  const res = await settle(TAG)
  assert.equal(res.status, 409)
  assert.equal(res.body['leg'], EXPIRED_SYM)
  assert.match(String(res.body['error']), new RegExp(EXPIRED_SYM))
  assert.match(String(res.body['error']), /2026-10-01/)

  assert.equal(await handle!.db.collection(COLLECTIONS.decisions).countDocuments({}), decisionsBefore)
  assert.deepEqual((await store.bookDoc(TAG, 'paper'))?.legs, bookBefore?.legs)
  assert.equal(await handle!.db.collection('desk-broker-cancels').countDocuments({}), 0)
  assert.equal(await handle!.db.collection('desk-audit-log').countDocuments({}), 0)
})

itMongo("an INDEX leg never settles off the book's own marks: that `spot` is the FUTURE's mid, not the index", async () => {
  // 1 Oct on the box: the last book-mark read 72,487.75 while the index
  // closed ~71,909.7 — a ~600-point basis. A 72,400 put worth ~490 would have
  // settled at 0 off the book-mark.
  await standUp({ legs: [EXPIRED_LEG] })
  await markSpot(71909.7, Date.UTC(2026, 9, 4, 16, 46)) // re-stamped by Sunday's restart
  await bookMark(TAG, '2026-10-01', '15:30', 72487.75)

  const res = await settle(TAG)
  assert.equal(res.status, 409, JSON.stringify(res.body))
  assert.equal(res.body['leg'], EXPIRED_SYM)
  assert.match(String(res.body['error']), /"close"/, 'the refusal says how to supply one')
  assert.equal(await handle!.db.collection(COLLECTIONS.decisions).countDocuments({ source: 'settle' }), 0)
})

itMongo('a close stamped BEFORE 15:29 IST on the expiry date is not a close', async () => {
  // A 13:00 tick, and then marketdata died: that is a price, not the close.
  await standUp({ legs: [EXPIRED_LEG] })
  await markSpot(71000, Date.parse('2026-10-01T13:00:00+05:30'))
  await handle!.db.collection('desk-payoff-snapshots').insertOne({
    tag: TAG,
    mode: 'paper',
    ts: Date.parse('2026-10-01T15:10:00+05:30'),
    kind: 'payoff',
    payload: { symbol: 'SENSEX', spot: 71000, future: 71600, asOf: Date.parse('2026-10-01T15:10:00+05:30') },
  })
  assert.equal((await settle(TAG)).status, 409)
})

itMongo('the index cash spot from a payoff snapshot at/after 15:29 IST on the expiry date is a close', async () => {
  await standUp({ legs: [EXPIRED_LEG] })
  const at = Date.parse('2026-10-01T15:29:40+05:30')
  await handle!.db.collection('desk-payoff-snapshots').insertOne({
    tag: 'ANY-OTHER-BOOK',
    mode: 'paper',
    ts: at,
    kind: 'payoff',
    payload: { symbol: 'SENSEX', spot: 71500, future: 72100, asOf: at },
  })
  const res = await settle(TAG)
  assert.equal(res.status, 200, JSON.stringify(res.body))
  const s = (res.body['settled'] as Record<string, unknown>[])[0]
  assert.equal(s?.['price'], 300)
  assert.equal(s?.['closeSource'], 'payoff-spot')
  assert.equal(s?.['closeAt'], at)
})

itMongo('an operator-supplied close settles it, and is recorded as the operator\'s', async () => {
  await standUp({ legs: [EXPIRED_LEG] })
  const res = await settle(TAG, 'paper', { close: 71909.7 })
  assert.equal(res.status, 200, JSON.stringify(res.body))
  const s = (res.body['settled'] as Record<string, unknown>[])[0]
  assert.equal(s?.['closeSource'], 'operator')
  assert.equal(s?.['price'], 0, 'the 71,800 put expired out of the money')
  const decision = await handle!.db.collection(COLLECTIONS.decisions).findOne({ source: 'settle' })
  assert.equal((decision?.['settlement'] as Record<string, unknown>)['closeSource'], 'operator')
  assert.equal((decision?.['settlement'] as Record<string, unknown>)['close'], 71909.7)
  const audit = await handle!.db.collection('desk-audit-log').findOne({ action: 'settled expired legs of a book' })
  assert.match(JSON.stringify(audit?.['detail']), /operator/)

  // Not a number, or not positive: a 400, nothing written.
  await standUp({ legs: [EXPIRED_LEG], tag: 'SENSEX-OTHER' })
  assert.equal((await settle('SENSEX-OTHER', 'paper', { close: 'about 71900' })).status, 400)
  assert.equal((await settle('SENSEX-OTHER', 'paper', { close: -1 })).status, 400)
})

itMongo('one operator close cannot price legs that expired on two different dates', async () => {
  const older = { ...EXPIRED_LEG, deskTag: 'PE71000#old', instrument: { ...EXPIRED_LEG.instrument, tradingsymbol: 'SENSEX26S2471000PE' }, expiry: '2026-09-24', strike: 71000 }
  await standUp({ legs: [EXPIRED_LEG, older] })
  const res = await settle(TAG, 'paper', { close: 71909.7 })
  assert.equal(res.status, 400)
  assert.match(String(res.body['error']), /2026-09-24/)
})

itMongo('a STOCK leg may settle off the future-mid book-mark at/after 15:29, labelled as the approximation it is', async () => {
  await standUp({ tag: TCS_TAG, symbol: 'TCS', expiry: '2026-09-29', legs: [TCS_LEG] })
  await bookMark(TCS_TAG, '2026-09-29', '15:25', 2051.95)
  await bookMark(TCS_TAG, '2026-09-29', '15:30', 2044.85)
  const res = await settle(TCS_TAG)
  assert.equal(res.status, 200, JSON.stringify(res.body))
  const s = (res.body['settled'] as Record<string, unknown>[])[0]
  assert.equal(s?.['price'], 35.15)
  assert.equal(s?.['closeSource'], 'future-mid')
  const audit = await handle!.db.collection('desk-audit-log').findOne({ action: 'settled expired legs of a book' })
  assert.match(JSON.stringify(audit?.['detail']), /future-mid/)
  assert.match(JSON.stringify(audit?.['detail']), /approximat/)
})

itMongo('a STOCK leg whose last book-mark is before 15:29 IST is a 409', async () => {
  await standUp({ tag: TCS_TAG, symbol: 'TCS', expiry: '2026-09-29', legs: [TCS_LEG] })
  await bookMark(TCS_TAG, '2026-09-29', '13:00', 2051.95)
  assert.equal((await settle(TCS_TAG)).status, 409)
})

// --------------------------------------------------- the ledger must agree

itMongo('the fills ledger disagrees with desk-books on the contract: 409, nothing written', async () => {
  // desk-books says long 80; the fills journal only ever opened 40.
  await standUp({ legs: [EXPIRED_LEG], ledger: [{ ...EXPIRED_LEG, qty: 40 }] })
  await markSpot(71000, EXPIRY_CLOSE_AT)
  const res = await settle(TAG)
  assert.equal(res.status, 409)
  assert.equal(res.body['leg'], EXPIRED_SYM)
  assert.match(String(res.body['error']), /ledger|fills/)
  assert.equal(await handle!.db.collection(COLLECTIONS.decisions).countDocuments({ source: 'settle' }), 0)
  assert.equal((await store.bookDoc(TAG, 'paper'))?.legs.length, 1)
})

itMongo('a ledger mismatch on ANOTHER contract does not block this one — the erase then refuses on it', async () => {
  // The live leg's ledger is wrong (−20 journalled against −40 held); the
  // expired leg's agrees. The expired leg settles; the DELETE guard still
  // refuses on the live one, as it would have.
  await standUp({ ledger: [EXPIRED_LEG, { ...LIVE_LEG, qty: -20 }] })
  await markSpot(71000, EXPIRY_CLOSE_AT)
  const res = await settle(TAG)
  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.equal((res.body['settled'] as unknown[]).length, 1)
})

itMongo('an unreadable fill for the tag is a 409: the ledger cannot be checked', async () => {
  await standUp({ legs: [EXPIRED_LEG] })
  await handle!.db.collection(COLLECTIONS.decisions).insertOne({
    decisionId: 'corrupt',
    tag: TAG,
    mode: 'paper',
    createdAt: Date.UTC(2026, 9, 1, 6),
    fills: [{ tradingsymbol: EXPIRED_SYM, side: 'Buy', qty: 'eighty', price: 30 }],
  })
  await markSpot(71000, EXPIRY_CLOSE_AT)
  const res = await settle(TAG)
  assert.equal(res.status, 409)
  assert.equal(await handle!.db.collection(COLLECTIONS.decisions).countDocuments({ source: 'settle' }), 0)
})

// ------------------------------------------------- booked on the right day

itMongo("the expiry date's daily report carries the close; the settlement day's does not", async () => {
  await standUp({ legs: [EXPIRED_LEG] })
  await markSpot(71000, EXPIRY_CLOSE_AT)
  // The report the 15:40 job wrote on 1 Oct: still holding the put.
  const reports = handle!.db.collection('desk-daily-reports')
  await reports.insertOne({ date: '2026-10-01', tag: TAG, mode: 'paper', realised: 0, total: -1000, closingPositions: 1, orderCount: 1, writtenAt: 1 })
  // Another book's 1 Oct report must not be rewritten by this book's settle.
  await reports.insertOne({ date: '2026-10-01', tag: 'NIFTY-other', mode: 'paper', realised: 5, total: 7, closingPositions: 2, orderCount: 3, writtenAt: 1 })

  assert.equal((await settle(TAG)).status, 200)
  const day = await reports.findOne({ date: '2026-10-01', tag: TAG, mode: 'paper' })
  assert.equal(day?.['closingPositions'], 0)
  assert.equal(Math.round(Number(day?.['realised']) * 100), Math.round((800 - 31.35) * 80 * 100))
  assert.equal(day?.['writtenAt'], NOW)
  const other = await reports.findOne({ date: '2026-10-01', tag: 'NIFTY-other' })
  assert.equal(other?.['writtenAt'], 1, "another book's report was rewritten")
  // Nothing on the settlement day: the close is not counted twice.
  assert.equal(await reports.countDocuments({ date: TODAY, tag: TAG }), 0)
})

itMongo('offsetting legs on one contract: the NET is settled, and the response says what is left', async () => {
  const short = { ...EXPIRED_LEG, deskTag: 'PE71800#short', side: 'Sell' as const, qty: -30 }
  await standUp({ legs: [EXPIRED_LEG, short] })
  await markSpot(71000, EXPIRY_CLOSE_AT)
  const res = await settle(TAG)
  assert.equal(res.status, 200, JSON.stringify(res.body))
  const s = (res.body['settled'] as Record<string, unknown>[])[0]
  assert.equal(s?.['qty'], 50)
  assert.match(String(s?.['note']), /offsetting/)
})

itMongo('idempotent: a second call settles nothing and writes nothing', async () => {
  await standUp()
  await markSpot(71000, EXPIRY_CLOSE_AT)
  assert.equal((await settle(TAG)).status, 200)
  const decisions = await handle!.db.collection(COLLECTIONS.decisions).countDocuments({})

  const again = await settle(TAG)
  assert.equal(again.status, 200)
  assert.deepEqual(again.body['settled'], [])
  assert.equal(again.body['remaining'], 1)
  assert.equal(await handle!.db.collection(COLLECTIONS.decisions).countDocuments({}), decisions)
})

itMongo('a crash between the journal and the book write re-runs cleanly: folded once, journalled once', async () => {
  await standUp({ legs: [EXPIRED_LEG] })
  await markSpot(71000, EXPIRY_CLOSE_AT)
  assert.equal((await settle(TAG)).status, 200)
  // Put the leg back as if the book write had never landed.
  await handle!.db
    .collection(COLLECTIONS.books)
    .updateOne({ tag: TAG, mode: 'paper' }, { $set: { legs: [EXPIRED_LEG], appliedCorrections: [] } })

  const again = await settle(TAG)
  assert.equal(again.status, 200, JSON.stringify(again.body))
  assert.deepEqual((await store.bookDoc(TAG, 'paper'))?.legs, [])
  assert.equal(await handle!.db.collection(COLLECTIONS.decisions).countDocuments({ source: 'settle' }), 1)
  const decision = await handle!.db.collection(COLLECTIONS.decisions).findOne({ source: 'settle' })
  assert.equal((decision?.['fills'] as unknown[]).length, 1, 'the close is journalled once')
})

itMongo('a fully settled book can then be stopped and erased without purge', async () => {
  await standUp({ legs: [EXPIRED_LEG] })
  await markSpot(71000, EXPIRY_CLOSE_AT)
  const res = await settle(TAG)
  assert.equal(res.body['remaining'], 0)
  assert.equal((await call('POST', `${REG}/${TAG}/stop`, { mode: 'paper' })).status, 200)
  const del = await call('DELETE', `${REG}/${TAG}?mode=paper`)
  assert.equal(del.status, 200, JSON.stringify(del.body))
  // History stays for the Reports page.
  assert.equal(await handle!.db.collection(COLLECTIONS.decisions).countDocuments({ tag: TAG, source: 'settle' }), 1)
})

itMongo('an order still resting on the expired contract is cancelled through the gateway cancel queue', async () => {
  await standUp({ legs: [EXPIRED_LEG] })
  await markSpot(71000, EXPIRY_CLOSE_AT)
  const orders = handle!.db.collection(COLLECTIONS.gatewayOrders)
  await orders.insertOne({
    clientOrderId: `${TAG}:paper:5#4`,
    tag: TAG,
    mode: 'paper',
    tradingsymbol: EXPIRED_SYM,
    // PLACED: at the simulator, unanswered — the 14:50 exit that never filled.
    state: 'PLACED',
    brokerOrderIds: ['sim-1', 'sim-2'],
    createdAt: Date.UTC(2026, 9, 1, 9, 20),
  })
  // A terminal one on the same contract, and a working one on another tag:
  // neither is ours to cancel.
  await orders.insertOne({ clientOrderId: `${TAG}:paper:4#0`, tag: TAG, mode: 'paper', tradingsymbol: EXPIRED_SYM, state: 'FILLED', brokerOrderIds: ['sim-0'], createdAt: 1 })
  await orders.insertOne({ clientOrderId: 'OTHER:paper:1#0', tag: 'OTHER', mode: 'paper', tradingsymbol: EXPIRED_SYM, state: 'PLACED', brokerOrderIds: ['sim-9'], createdAt: 1 })

  // While an order is still out, a late real fill could close the leg on the
  // ledger a second time — so the cancel is filed and the settle WAITS (409).
  const res = await settle(TAG)
  assert.equal(res.status, 409, JSON.stringify(res.body))
  assert.equal(res.body['leg'], EXPIRED_SYM)
  assert.deepEqual(res.body['cancelRequested'], ['sim-2'])
  const cancels = await handle!.db.collection('desk-broker-cancels').find({}).toArray()
  assert.deepEqual(cancels.map((c) => c['_id']), ['sim-2'])
  assert.equal(cancels[0]?.['status'], 'pending')
  assert.equal(await handle!.db.collection(COLLECTIONS.decisions).countDocuments({ source: 'settle' }), 0)

  // The gateway performs the cancel; the order goes terminal; the retry settles.
  await orders.updateOne({ clientOrderId: `${TAG}:paper:5#4` }, { $set: { state: 'REJECTED' } })
  const again = await settle(TAG)
  assert.equal(again.status, 200, JSON.stringify(again.body))
  assert.equal((again.body['settled'] as unknown[]).length, 1)
})

itMongo('a live row is a 400 and nothing is touched; an unknown book is a 404; the mode must be stated', async () => {
  await standUp({ mode: 'live', legs: [EXPIRED_LEG] })
  await markSpot(71000, EXPIRY_CLOSE_AT)
  const live = await settle(TAG, 'live')
  assert.equal(live.status, 400)
  assert.match(String(live.body['error']), /paper/)
  assert.equal((await store.bookDoc(TAG, 'live'))?.legs.length, 1)
  assert.equal(await handle!.db.collection(COLLECTIONS.decisions).countDocuments({ source: 'settle' }), 0)

  assert.equal((await settle('NOPE-2026-10-01')).status, 404)
  assert.equal((await call('POST', `${REG}/${TAG}/settle-expired`)).status, 400)
})

itMongo('a flat book answers 200 with nothing settled', async () => {
  await standUp({ legs: [] })
  const res = await settle(TAG)
  assert.equal(res.status, 200)
  assert.deepEqual(res.body['settled'], [])
  assert.equal(res.body['remaining'], 0)
})

test('DX: settle-expired refuses — Delta settles every expiry and the gateway books its price', async () => {
  const { DX } = await import('@algomaker/venue')
  const { handleSettleExpired } = await import('../src/settle-expired.ts')
  const sent: { status: number; body: unknown }[] = []
  const ctx = {
    url: new URL('http://x/v1/desk/books/registry/T/settle-expired?mode=paper'),
    send: (status: number, body: unknown) => {
      sent.push({ status, body })
    },
    readJson: async () => {
      throw new Error('the body must not be read')
    },
  }
  const deps = { venue: DX } as unknown as Parameters<typeof handleSettleExpired>[0]
  assert.equal(await handleSettleExpired(deps, ctx as unknown as Parameters<typeof handleSettleExpired>[1], 'T'), true)
  assert.equal(sent.length, 1)
  assert.equal(sent[0]?.status, 409)
  assert.match(String((sent[0]?.body as { error: string }).error), /Delta settles/)
})
