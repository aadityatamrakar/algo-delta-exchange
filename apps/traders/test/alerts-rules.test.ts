/** The alert rules (gaps G7), pure: each kind, its dedupe key, the restart rule, and who an alert is for. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { BandEvent } from '../src/analytics/band.ts'
import {
  BAND_QUIET_MS, bandBreaches, expiringItm, istDayStart, itmWindow, rejectedOrders, watcherOffline, watcherWindow, type AlertDraft,
} from '../src/alerts/rules.ts'
import type { TraderLeg, TraderOrder } from '../src/types.ts'

const OCT = '2026-10-27'   // a Tuesday: TCS's and NIFTY's October expiry in the fixtures
const ist = (day: string, hhmm: string): number => Date.parse(`${day}T${hhmm}:00+05:30`)
const CLIENT = 'ZZCLIENT9'   // a client code: it must never reach an alert's text

type Leg = Pick<TraderLeg, 'trader' | 'stock' | 'instrument' | 'expiry' | 'strike' | 'optType' | 'qty'>
const opt = (stock: string, strike: number, optType: 'CE' | 'PE', qty: number, over: Partial<Leg> = {}): Leg =>
  ({ trader: 'ravi', stock, instrument: 'option', expiry: OCT, strike, optType, qty, ...over })
const fut = (stock: string, qty: number, over: Partial<Leg> = {}): Leg =>
  ({ trader: 'ravi', stock, instrument: 'future', expiry: OCT, strike: null, optType: null, qty, ...over })

const spots: Record<string, number> = { TCS: 3450, NIFTY: 25510 }
const itm = (nowMs: number, legs: readonly Leg[]): AlertDraft[] =>
  expiringItm({ nowMs, legs, spotOf: (s) => spots[s] ?? null, isIndex: (s) => s === 'NIFTY' })

const noClientCode = (ds: readonly AlertDraft[]): void => {
  for (const d of ds) assert.equal(JSON.stringify(d).includes(CLIENT), false, `${d.dedupeKey} carries a client code`)
}

// ---- expiring ITM ------------------------------------------------------------------------

test('expiring ITM: from 14:30 IST on the expiry day until the 15:40 close, nothing before or after', () => {
  const legs = [opt('TCS', 3400, 'CE', 350)]
  assert.equal(itmWindow(ist(OCT, '14:29')), false)
  assert.deepEqual(itm(ist(OCT, '14:29'), legs), [])
  assert.equal(itmWindow(ist(OCT, '14:30')), true)
  assert.equal(itm(ist(OCT, '14:30'), legs).length, 1)
  assert.equal(itm(ist(OCT, '15:39'), legs).length, 1)
  assert.deepEqual(itm(ist(OCT, '15:40'), legs), [])
  assert.deepEqual(itm(ist('2026-10-26', '14:35'), legs), [], 'the day before its expiry')
  assert.deepEqual(itm(ist('2026-10-20', '14:35'), [opt('TCS', 3400, 'CE', 350, { expiry: '2026-10-20' })]), [], 'a holiday (Dussehra)')
})

test('expiring ITM, a stock: the ITM legs netted across client codes, and the delivery they would make at spot', () => {
  const now = ist(OCT, '14:35')
  const [d, ...rest] = itm(now, [
    opt('TCS', 3400, 'CE', 350), opt('TCS', 3400, 'CE', 175),          // two client codes, one contract
    opt('TCS', 3500, 'PE', -175),                                      // short PE, 50 in the money: takes shares
    opt('TCS', 3500, 'CE', -350),                                      // out of the money: not named
    opt('TCS', 3300, 'PE', 700),                                       // out of the money: not named
    opt('TCS', 3400, 'CE', 175, { expiry: '2026-11-24' }),             // another expiry
  ])
  assert.deepEqual(rest, [])
  assert.deepEqual(d, {
    trader: 'ravi', kind: 'expiring-itm', stock: 'TCS',
    dedupeKey: `itm|ravi|TCS|${OCT}|3400 CE,3500 PE`,
    title: 'TCS expiring in the money',
    body: '3400 CE +525, 3500 PE -175 expire today, in the money at spot 3,450. Held to the close: take delivery of 700 shares, about ₹24,15,000 at spot.',
    url: '/traders/#/books/TCS', at: now,
  })
  // a long PE and a short CE give shares; a stock future always delivers
  const [g] = itm(now, [opt('TCS', 3500, 'PE', 350), opt('TCS', 3400, 'CE', -175), fut('TCS', 175)])
  assert.match(g?.body ?? '', /^FUT \+175, 3400 CE -175, 3500 PE \+350 expire today.*give delivery of 350 shares, about ₹12,07,500 at spot\.$/)
})

test('expiring ITM, an index: cash settlement, and an index future is not named (it settles like any day)', () => {
  const now = ist(OCT, '15:00')
  const [d, ...rest] = itm(now, [opt('NIFTY', 25400, 'CE', 130), opt('NIFTY', 25600, 'PE', -65), fut('NIFTY', 65)])
  assert.deepEqual(rest, [])
  assert.equal(d?.dedupeKey, `itm|ravi|NIFTY|${OCT}|25400 CE,25600 PE`)
  // 130 × 110 − 65 × 90 = 8,450
  assert.equal(d?.body, '25400 CE +130, 25600 PE -65 expire today, in the money at spot 25,510. Held to the close: cash settlement about +₹8,450.')
  assert.deepEqual(itm(now, [fut('NIFTY', 65), opt('NIFTY', 26000, 'CE', 65)]), [], 'only an index future and an OTM call')
})

test('expiring ITM: one alert per trader and book; a book with no spot, or flat, is not judged; the key moves with the ITM set', () => {
  const now = ist(OCT, '14:45')
  const ds = itm(now, [opt('TCS', 3400, 'CE', 350), opt('TCS', 3400, 'CE', 350, { trader: 'sita' }), opt('INFY', 1400, 'CE', 400),
    opt('TCS', 3300, 'CE', 175), opt('TCS', 3300, 'CE', -175)])
  assert.deepEqual(ds.map((d) => [d.trader, d.stock]), [['ravi', 'TCS'], ['sita', 'TCS']])
  assert.doesNotMatch(ds[0]?.body ?? '', /3300/, 'a contract netted flat is not named')
  const one = itm(now, [opt('TCS', 3400, 'CE', 350)])[0]?.dedupeKey
  const two = itm(now, [opt('TCS', 3400, 'CE', 350), opt('TCS', 3425, 'CE', 175)])[0]?.dedupeKey
  assert.notEqual(one, two, 'a second leg going in the money is a new alert')
  assert.equal(itm(now, [opt('TCS', 3400, 'CE', 700)])[0]?.dedupeKey, one, 'a bigger position of the same set is not')
})

// ---- order rejected ------------------------------------------------------------------------

const order = (o: Partial<TraderOrder>): TraderOrder => ({
  trader: 'ravi', orderNo: '1100000001', exchOrderNo: '0', clientCode: CLIENT, stock: 'TCS', instrument: 'option',
  expiry: OCT, strike: 3400, optType: 'CE', side: 'Sell', qty: 350, price: 41.5, status: 'Rejected (6)', reason: `client ${CLIENT}`,
  time: ist('2026-10-19', '10:00'), day: '2026-10-19', filledQty: 0, updateTime: ist('2026-10-19', '10:00'), ...o,
})

test('order rejected: the trader\'s own alert and an admin-wide one; never a client code or the rejection text', () => {
  const now = ist('2026-10-19', '10:01')
  const ds = rejectedOrders({ nowMs: now, since: ist('2026-10-19', '09:00'), orders: [order({})] })
  assert.deepEqual(ds, [
    {
      trader: 'ravi', kind: 'order-rejected', stock: 'TCS', dedupeKey: 'rejected|ravi|2026-10-19|1100000001',
      title: 'Order rejected: TCS', body: `Sell 350 TCS 3400 CE ${OCT} at ₹41.5`, url: '/traders/#/books/TCS', at: now,
    },
    {
      trader: null, kind: 'order-rejected', stock: 'TCS', dedupeKey: 'admin|rejected|ravi|2026-10-19|1100000001',
      title: 'Order rejected: ravi, TCS', body: `Sell 350 TCS 3400 CE ${OCT} at ₹41.5`, url: '/traders/#/orders', at: now,
    },
  ])
  noClientCode(ds)
  assert.equal(ds[0]?.title.includes('ravi') || ds[0]?.body.includes('ravi'), false, 'a trader\'s own alert names no one')
})

test('order rejected: other statuses are not alerts, and nothing updated before the IST day began (history)', () => {
  const started = istDayStart(ist('2026-10-19', '11:07'))
  assert.equal(started, ist('2026-10-19', '00:00'))
  const orders = [
    order({ orderNo: 'a', updateTime: ist('2026-10-18', '23:59') }),                 // yesterday's: history
    order({ orderNo: 'b', updateTime: ist('2026-10-19', '09:20') }),                 // this morning's, before any restart: still today's
    order({ orderNo: 'c', status: 'Traded (4)', updateTime: ist('2026-10-19', '11:05') }),
    order({ orderNo: 'd', status: 'Cancelled (5)', updateTime: ist('2026-10-19', '11:05') }),
    order({ orderNo: 'e', status: 'REJECTED', instrument: 'share', expiry: '', strike: null, optType: null, price: 0, side: 'Buy', updateTime: ist('2026-10-19', '11:06') }),
  ]
  const ds = rejectedOrders({ nowMs: ist('2026-10-19', '11:07'), since: started, orders })
  assert.deepEqual(ds.filter((d) => d.trader !== null).map((d) => [d.dedupeKey, d.body]), [
    ['rejected|ravi|2026-10-19|b', `Sell 350 TCS 3400 CE ${OCT} at ₹41.5`],
    ['rejected|ravi|2026-10-19|e', 'Buy 350 TCS shares'],
  ])
})

// ---- watcher offline -----------------------------------------------------------------------

const MON = '2026-10-19'

test('watcher offline: more than 10 min without a heartbeat, counted from 09:00, 09:00–15:45 on a trading day', () => {
  const w = (lastHeartbeatAt: number) => [{ trader: 'ravi', status: { lastHeartbeatAt } }]
  const lastNight = ist('2026-10-16', '18:00')   // the Friday before
  assert.deepEqual(watcherOffline({ nowMs: ist(MON, '08:59'), watchers: w(lastNight) }), [], 'before 09:00')
  assert.deepEqual(watcherOffline({ nowMs: ist(MON, '09:10'), watchers: w(lastNight) }), [], 'ten minutes from 09:00 is not more than ten')
  const ds = watcherOffline({ nowMs: ist(MON, '09:11'), watchers: w(lastNight) })
  assert.deepEqual(ds.map((d) => [d.trader, d.dedupeKey, d.title, d.body, d.url]), [
    ['ravi', `watcher|ravi|${lastNight}`, 'Watcher offline', 'No heartbeat from your watcher since 2026-10-16 18:00 IST: new ODIN files are not reaching the desk.', '/traders/#/books'],
    [null, `admin|watcher|ravi|${lastNight}`, 'Watcher offline: ravi', 'No heartbeat since 2026-10-16 18:00 IST.', '/traders/#/admin'],
  ])
  // within the day: 10:00 last, alerted from past 10:10
  assert.deepEqual(watcherOffline({ nowMs: ist(MON, '10:10'), watchers: w(ist(MON, '10:00')) }), [])
  assert.equal(watcherOffline({ nowMs: ist(MON, '10:10') + 1, watchers: w(ist(MON, '10:00')) })[0]?.body,
    'No heartbeat from your watcher since 10:00 IST: new ODIN files are not reaching the desk.')
  assert.equal(watcherWindow(ist(MON, '15:44')), true)
  assert.deepEqual(watcherOffline({ nowMs: ist(MON, '15:45'), watchers: w(lastNight) }), [], 'from 15:45')
  assert.deepEqual(watcherOffline({ nowMs: ist('2026-10-20', '11:00'), watchers: w(lastNight) }), [], 'a holiday')
  assert.deepEqual(watcherOffline({ nowMs: ist('2026-10-24', '11:00'), watchers: w(lastNight) }), [], 'a Saturday')
})

test('watcher offline: one alert per outage (the same key all day, and the next day), a new one after a heartbeat; no watcher, no alert', () => {
  const last = ist(MON, '09:30')
  const key = (nowMs: number, l: number) => watcherOffline({ nowMs, watchers: [{ trader: 'ravi', status: { lastHeartbeatAt: l } }] })[0]?.dedupeKey
  assert.equal(key(ist(MON, '09:45'), last), key(ist(MON, '15:30'), last))
  assert.equal(key(ist('2026-10-21', '10:00'), last), key(ist(MON, '09:45'), last), 'a watcher left off for days is one outage')
  assert.notEqual(key(ist(MON, '12:00'), ist(MON, '11:00')), key(ist(MON, '09:45'), last))
  assert.deepEqual(watcherOffline({ nowMs: ist(MON, '12:00'), watchers: [{ trader: 'sita', status: null }] }), [])
})

// ---- band breach ---------------------------------------------------------------------------

const band = (at: number, to: 'in' | 'out', over: Partial<BandEvent> = {}): BandEvent => ({
  trader: 'ravi', stock: 'BHEL', kind: 'band', from: to === 'out' ? 'in' : 'out', to, at,
  netDelta: -4321.7, bandShares: 1890.2, lotSize: 2625, outByLots: 1, source: 'engine', ...over,
})

test('band breach: an event to out is an alert; a book flapping alerts once in the quiet window', () => {
  const t = ist(MON, '10:00')
  const ds = bandBreaches({
    events: [band(t, 'out'), band(t + 60_000, 'in'), band(t + 120_000, 'out'), band(t + BAND_QUIET_MS, 'out'), band(t + 60_000, 'out', { stock: 'TCS', outByLots: 3 })],
    lastAlertAt: () => null,
  })
  assert.deepEqual(ds.map((d) => [d.stock, d.at, d.title]), [
    ['BHEL', t, 'BHEL out of band'], ['TCS', t + 60_000, 'TCS out of band'], ['BHEL', t + BAND_QUIET_MS, 'BHEL out of band'],
  ])
  assert.deepEqual(ds[0], {
    trader: 'ravi', kind: 'band-breach', stock: 'BHEL', dedupeKey: `band|ravi|BHEL|${t}`, title: 'BHEL out of band',
    body: 'Out of band by 1 lot: net delta -4,322 shares against a band of ±1,890.', url: '/traders/#/books/BHEL', at: t,
  })
  // the last stored alert counts too (a later pass, or a restart)
  assert.deepEqual(bandBreaches({ events: [band(t + 120_000, 'out')], lastAlertAt: () => t }), [])
  assert.equal(bandBreaches({ events: [band(t + BAND_QUIET_MS, 'out')], lastAlertAt: () => t }).length, 1)
})

test('no rule puts a client code in an alert', () => {
  noClientCode([
    ...itm(ist(OCT, '14:35'), [opt('TCS', 3400, 'CE', 350)]),
    ...rejectedOrders({ nowMs: ist(MON, '10:01'), since: 0, orders: [order({})] }),
  ])
})
