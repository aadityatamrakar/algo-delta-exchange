/**
 * Phone alerts end to end (gaps G7), through the whole app with a recording sender (no real push): the push routes,
 * the bell's feed, and the runner raising each kind of alert — from its hooks (an orders file, a band event) and
 * its minute pass — to the right phones, once, and never again after a restart.
 */
import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { skipUnlessMongo } from '../../api/test/require-mongo.ts'
import type { PushSender, PushTarget } from '../src/alerts/push.ts'
import { AlertRunner } from '../src/alerts/runner.ts'
import { AlertStore } from '../src/alerts/store.ts'
import { isIndex } from '../src/analytics/market-watch.ts'
import { sha256hex } from '../src/hash.ts'
import { spotTokenOf } from '../src/market/master.ts'
import { OCT, fakeQuotes, priceChain, r3Master } from './fixtures/r3-market.ts'
import { startTraders, type TradersHarness } from './harness.ts'

const M = r3Master()
const T0 = Date.UTC(2026, 9, 19, 4, 0, 0)   // the harness clock: Monday 19 Oct, 09:30 IST
const ist = (day: string, hhmm: string): number => Date.parse(`${day}T${hhmm}:00+05:30`)
const quotes = fakeQuotes()
quotes.set(spotTokenOf(M, 'TCS') as number, { price: 3395, asOf: T0 })
quotes.set(M.options.future('TCS', OCT)?.instrumentToken as number, { price: 3400, bid: 3399.5, ask: 3400.5, asOf: T0 })
priceChain(quotes, M, 'TCS', OCT, 3400, 0.25, T0)

const CLIENT = 'ZZCLIENT9'
interface Push { endpoint: string; title: string; body: string; url: string; tag: string }
const pushes: Push[] = []
const send: PushSender = async (t, payload) => {
  pushes.push({ endpoint: t.endpoint, ...(JSON.parse(payload) as Omit<Push, 'endpoint'>) })
  return 201
}

const h: TradersHarness | null = await startTraders({ suite: 'alerts_routes', master: M, quotes, pushSender: send })
after(async () => { await h?.close() })

const P = '/v1/traders'
type Call = (path: string, init?: RequestInit) => Promise<Response>
let ravi: Call, sita: Call, boss: Call
const json = async (r: Response): Promise<{ status: number; body: any }> => ({ status: r.status, body: await r.json() })
const post = (who: Call, path: string, body: unknown) =>
  who(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const phone = (id: string): PushTarget => ({
  endpoint: `https://fcm.googleapis.com/fcm/send/${id}`,
  keys: { p256dh: Buffer.concat([Buffer.from([4]), randomBytes(64)]).toString('base64url'), auth: randomBytes(16).toString('base64url') },
})
const to = (id: string): Push[] => pushes.filter((p) => p.endpoint.endsWith(`/${id}`))

before(async () => {
  if (h === null) return
  await h.addUser('ravi'); await h.addUser('sita'); await h.addUser('boss', 'admin')
  ravi = h.as('ravi'); sita = h.as('sita'); boss = h.as('boss')
})

beforeEach(async () => {
  if (h === null) return
  h.clock.now = T0
  pushes.length = 0
  for (const c of ['traders-alerts', 'traders-push', 'traders-orders', 'traders-events', 'traders-legs'] as const) await h.db.collection(c).deleteMany({})
  await h.db.collection('traders-settings').deleteMany({ kind: { $in: ['watcher', 'band'] } })
  for (const [who, id] of [[ravi, 'ravi-phone'], [sita, 'sita-phone'], [boss, 'boss-phone']] as const) {
    assert.equal((await post(who, `${P}/push/subscribe`, phone(id))).status, 200)
  }
})

// ---- the routes ----------------------------------------------------------------------------

test('GET /push/key: the one VAPID public key, the same for everyone; the private key stays in the database', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const a = await json(await ravi(`${P}/push/key`))
  assert.equal(a.status, 200)
  assert.equal(Buffer.from(a.body.publicKey, 'base64url').length, 65)
  assert.deepEqual((await json(await boss(`${P}/push/key`))).body, a.body)
  const stored = await h.db.collection('traders-settings').find({ kind: 'vapid' }).toArray()
  assert.equal(stored.length, 1)
  assert.equal(stored[0]?.['publicKey'], a.body.publicKey)
  assert.equal(JSON.stringify(a.body).includes(String(stored[0]?.['privateKey'])), false, 'the private key never leaves')
})

test('POST /push/subscribe: a known push service only; the caller\'s own row, an admin\'s too whoever they act as', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  for (const endpoint of ['https://127.0.0.1/x', 'http://fcm.googleapis.com/fcm/send/x', 'https://fcm.googleapis.com:8443/x', 'https://evil.example/x']) {
    const r = await json(await post(ravi, `${P}/push/subscribe`, { ...phone('x'), endpoint }))
    assert.equal(r.status, 400, endpoint)
    assert.match(r.body.error, /https|port|push service/)
  }
  assert.equal((await post(ravi, `${P}/push/subscribe`, { endpoint: phone('x').endpoint })).status, 400)
  const r = await json(await post(boss, `${P}/push/subscribe?as=ravi`, phone('boss-tablet')))
  assert.deepEqual(r, { status: 200, body: { subscribed: true, phones: 2 } })
  const rows = await h.db.collection('traders-push').find({}, { projection: { _id: 0, username: 1, endpoint: 1 } }).sort({ endpoint: 1 }).toArray()
  assert.deepEqual(rows.map((x) => [x['username'], String(x['endpoint']).split('/').at(-1)]),
    [['boss', 'boss-phone'], ['boss', 'boss-tablet'], ['ravi', 'ravi-phone'], ['sita', 'sita-phone']])
})

test('POST /push/unsubscribe: only the caller\'s own phone', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  assert.deepEqual(await json(await post(ravi, `${P}/push/unsubscribe`, { endpoint: phone('sita-phone').endpoint })), { status: 200, body: { removed: false } })
  assert.equal(await h.db.collection('traders-push').countDocuments({ username: 'sita' }), 1)
  assert.deepEqual(await json(await post(ravi, `${P}/push/unsubscribe`, { endpoint: phone('ravi-phone').endpoint })), { status: 200, body: { removed: true } })
  assert.equal(await h.db.collection('traders-push').countDocuments({ username: 'ravi' }), 0)
  assert.equal((await post(ravi, `${P}/push/unsubscribe`, {})).status, 400)
})

test('POST /push/test: one test alert to the caller\'s own phones, at most every 10 s', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  assert.deepEqual(await json(await post(ravi, `${P}/push/test`, {})), { status: 200, body: { sent: 1, phones: 1 } })
  assert.deepEqual(pushes, [{ endpoint: phone('ravi-phone').endpoint, title: 'Delta Desk: test alert', body: 'Phone alerts are on for this phone.', url: '/traders/', tag: 'test' }])
  assert.equal((await post(ravi, `${P}/push/test`, {})).status, 429)
  h.clock.now += 10_000
  assert.equal((await json(await post(ravi, `${P}/push/test`, {}))).body.sent, 1)
  assert.deepEqual(to('sita-phone'), [])
  assert.deepEqual(to('boss-phone'), [])
})

// ---- the runner, each kind -----------------------------------------------------------------

const ORDERS_HEADER = 'order_no,exch_order_no,client_code,stock,instrument,expiry,strike,type,side,qty,price,status,reason,time'
async function uploadOrders(trader: string, rows: readonly string[]): Promise<void> {
  const text = [ORDERS_HEADER, ...rows].join('\n')
  const r = await fetch(`${h!.url}${P}/files?path=orders.csv&mtime=${h!.clock.now}&sha256=${sha256hex(text)}`, {
    method: 'PUT', headers: { authorization: `Bearer ${await h!.token(trader)}`, 'content-type': 'application/octet-stream' }, body: text,
  })
  assert.equal(r.status, 200, await r.text())
}

test('a rejected order: raised as the orders file lands, to the trader\'s phone and every admin\'s, once', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  await uploadOrders('ravi', [
    `O1,X1,${CLIENT},TCS,option,${OCT},3400,CE,SELL,350,41.5,Rejected,"RMS: margin ${CLIENT}",2026-10-19T09:45:00+05:30`,
    `O2,X2,${CLIENT},TCS,option,${OCT},3400,CE,SELL,350,41.5,Traded,,2026-10-19T09:46:00+05:30`,
    `O0,X0,${CLIENT},TCS,future,${OCT},,,BUY,175,3400,Rejected,,2026-10-16T15:10:00+05:30`,   // last Friday's: history
  ])
  assert.equal(await h.app.alerts.tick(), 0, 'the hook raised it already; the minute pass finds nothing new')
  const body = `Sell 350 TCS 3400 CE ${OCT} at ₹41.5`
  assert.deepEqual(to('ravi-phone'), [{ endpoint: phone('ravi-phone').endpoint, title: 'Order rejected: TCS', body, url: '/traders/#/books/TCS', tag: 'order-rejected:TCS' }])
  assert.deepEqual(to('boss-phone').map((p) => [p.title, p.body, p.url]), [['Order rejected: ravi, TCS', body, '/traders/#/orders']])
  assert.deepEqual(to('sita-phone'), [])
  for (const p of pushes) assert.equal(JSON.stringify(p).includes(CLIENT), false, 'a push carries a client code')
  for (const p of to('ravi-phone')) assert.equal(`${p.title}${p.body}${p.url}${p.tag}`.includes('ravi'), false, 'a trader\'s own push names no one')

  // the bell: ravi's own; the admin's admin-wide, plus ravi's when ravi is picked; sita sees nothing of ravi's
  const mine = (await json(await ravi(`${P}/alerts?since=0&as=sita`))).body
  assert.deepEqual(mine.map((a: any) => [a.kind, a.title, a.admin, a.sentAt !== null]), [['order-rejected', 'Order rejected: TCS', false, true]])
  assert.deepEqual((await json(await boss(`${P}/alerts`))).body.map((a: any) => [a.title, a.admin]), [['Order rejected: ravi, TCS', true]])
  assert.deepEqual((await json(await boss(`${P}/alerts?as=ravi`))).body.map((a: any) => a.admin).sort(), [false, true])
  assert.deepEqual((await json(await sita(`${P}/alerts`))).body, [])
  for (const a of [...mine, ...(await json(await boss(`${P}/alerts?as=ravi`))).body]) {
    assert.deepEqual(Object.keys(a).sort(), ['admin', 'at', 'body', 'kind', 'sentAt', 'stock', 'title', 'url'], 'no dedupe key, no trader field')
    assert.equal(JSON.stringify(a).includes(CLIENT), false)
  }

  // the same file again, and a later pass: nothing new
  pushes.length = 0
  h.clock.now += 120_000
  assert.equal(await h.app.alerts.tick(), 0)
  assert.deepEqual(pushes, [])
})

test('a restart repeats nothing already alerted, and still alerts a rejection whose file lands after it', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  await uploadOrders('ravi', [`O1,X1,${CLIENT},TCS,option,${OCT},3400,CE,SELL,350,41.5,Rejected,,2026-10-19T09:45:00+05:30`])
  await h.app.alerts.tick()
  assert.equal(to('ravi-phone').length, 1)
  // the restart: a fresh process at 10:30
  h.clock.now = ist('2026-10-19', '10:30')
  const d = h.deps
  const sent: string[] = []
  const restarted = new AlertRunner({
    store: new AlertStore(h.db), pusher: { send: async (to, m) => { sent.push(`${to.join(',')}: ${m.title}`); return 1 } }, users: d.users,
    status: d.status, legs: d.legs, db: h.db, spotOf: () => null, isIndex, now: () => h.clock.now, log: () => {},
  })
  assert.equal(await restarted.tick(), 0, 'the 09:45 rejection was alerted before the restart')
  // a rejection from 10:15, while the server was down, whose file lands now; and last Friday's, never
  const order = (orderNo: string, time: string) => ({
    trader: 'ravi', orderNo, exchOrderNo: '0', clientCode: CLIENT, stock: 'TCS', instrument: 'option', expiry: OCT, strike: 3400, optType: 'PE',
    side: 'Buy', qty: 175, price: 12, status: 'Rejected (6)', reason: '', time: Date.parse(time), day: time.slice(0, 10), filledQty: 0, updateTime: Date.parse(time),
  })
  await h.db.collection('traders-orders').insertOne(order('O7', '2026-10-19T10:15:00+05:30'))
  await h.db.collection('traders-orders').insertOne(order('O8', '2026-10-16T10:15:00+05:30'))
  restarted.ordersLanded('ravi')
  assert.equal(await restarted.tick(), 0, 'the hook raised it; the pass finds nothing new')
  assert.deepEqual(sent, ['ravi: Order rejected: TCS', 'boss: Order rejected: ravi, TCS'])
  assert.equal(await h.db.collection('traders-alerts').countDocuments({ dedupeKey: /O8$/ }), 0)
})

test('watcher offline: past 10 min without a heartbeat, the trader and the admins, one alert per outage', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const hb = await fetch(`${h.url}${P}/heartbeat`, {
    method: 'POST', headers: { authorization: `Bearer ${await h.token('ravi')}`, 'content-type': 'application/json' },
    body: JSON.stringify({ version: '1', folder: `C:\\odin\\${CLIENT}`, lastUploadAt: null, fileCount: 0 }),
  })
  assert.equal(hb.status, 200)
  h.clock.now = T0 + 10 * 60_000
  assert.equal(await h.app.alerts.tick(), 0, 'ten minutes is not more than ten')
  h.clock.now = T0 + 11 * 60_000
  assert.equal(await h.app.alerts.tick(), 2)
  assert.deepEqual(to('ravi-phone').map((p) => [p.title, p.body]), [['Watcher offline', 'No heartbeat from your watcher since 09:30 IST: new ODIN files are not reaching the desk.']])
  assert.deepEqual(to('boss-phone').map((p) => [p.title, p.body]), [['Watcher offline: ravi', 'No heartbeat since 09:30 IST.']])
  assert.deepEqual(to('sita-phone'), [], 'sita has no watcher: nothing to miss')
  for (const p of pushes) assert.equal(p.body.includes(CLIENT), false)
  h.clock.now = T0 + 60 * 60_000
  assert.equal(await h.app.alerts.tick(), 0, 'the same outage')
})

test('band breach: the board\'s out event is alerted as it is written, to the trader only', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  // short 10 lots of the 3300 CE, a hundred points in the money: far past the band
  await h.deps.legs.addManual('ravi', { stock: 'TCS', instrument: 'option', expiry: OCT, strike: 3300, optType: 'CE', qty: -1750, avgPrice: 120, note: '' },
    M.options.resolve('TCS', OCT, 3300, 'CE')?.instrumentToken ?? null)
  assert.equal(await h.app.board.tick(h.clock.now), 1)
  assert.equal(await h.app.alerts.tick(), 0, 'the hook raised it')
  assert.deepEqual(to('ravi-phone').map((p) => [p.title, p.url, p.tag]), [['TCS out of band', '/traders/#/books/TCS', 'band-breach:TCS']])
  assert.match(to('ravi-phone')[0]?.body ?? '', /^Out of band by \d+ lots: net delta -[\d,]+ shares against a band of ±[\d,]+\.$/)
  assert.deepEqual([...to('boss-phone'), ...to('sita-phone')], [])
})

test('expiring ITM: on the expiry day from 14:30, the book\'s ITM legs and the delivery, to the trader', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const token = M.options.resolve('TCS', OCT, 3300, 'CE')?.instrumentToken ?? null
  await h.deps.legs.addManual('ravi', { stock: 'TCS', instrument: 'option', expiry: OCT, strike: 3300, optType: 'CE', qty: 175, avgPrice: 60, note: '' }, token)
  h.clock.now = ist(OCT, '14:29')
  assert.equal(await h.app.alerts.tick(), 0)
  h.clock.now = ist(OCT, '14:31')
  assert.equal(await h.app.alerts.tick(), 1)
  assert.deepEqual(to('ravi-phone').map((p) => [p.title, p.body]), [[
    'TCS expiring in the money',
    '3300 CE +175 expire today, in the money at spot 3,395. Held to the close: take delivery of 175 shares, about ₹5,94,125 at spot.',
  ]])
  h.clock.now = ist(OCT, '15:00')
  assert.equal(await h.app.alerts.tick(), 0, 'once per book and ITM set')
  assert.deepEqual([...to('boss-phone'), ...to('sita-phone')], [])
})

test('GET /alerts: since is epoch ms (default the last day, never before the 30 days kept)', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  for (const [dedupeKey, title, at] of [['a', 'old', T0 - 2 * 86_400_000], ['b', 'new', T0 - 60_000]] as const) {
    await h.db.collection('traders-alerts').insertOne({ trader: 'ravi', kind: 'band-breach', stock: 'TCS', dedupeKey, title, body: '', url: '/traders/', at, sentAt: null, expiresAt: new Date(T0 + 86_400_000) })
  }
  assert.deepEqual((await json(await ravi(`${P}/alerts`))).body.map((a: any) => a.title), ['new'])
  assert.deepEqual((await json(await ravi(`${P}/alerts?since=0`))).body.map((a: any) => a.title), ['new', 'old'])
  assert.deepEqual((await json(await ravi(`${P}/alerts?since=${T0 - 30_000}`))).body, [])
  for (const bad of ['x', '-1', '1.5']) assert.equal((await ravi(`${P}/alerts?since=${bad}`)).status, 400, bad)
})

test('traders-alerts: one row per dedupe key, and rows expire 30 days after the alert (a TTL index on a Date)', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  type Index = { key: Record<string, number>; unique?: boolean; expireAfterSeconds?: number }
  const indexesOf = (name: string): Promise<Index[]> => (h.handle.db.collection(name) as unknown as { indexes(): Promise<Index[]> }).indexes()
  const indexes = await indexesOf('traders-alerts')
  assert.ok(indexes.some((i) => JSON.stringify(i.key) === '{"dedupeKey":1}' && i.unique === true))
  assert.ok(indexes.some((i) => JSON.stringify(i.key) === '{"expiresAt":1}' && i.expireAfterSeconds === 0))
  const store = new AlertStore(h.db)
  const draft = { trader: 'ravi', kind: 'band-breach' as const, stock: 'TCS', dedupeKey: 'k', title: 't', body: 'b', url: '/traders/', at: T0 }
  assert.equal(await store.add(draft), true)
  assert.equal(await store.add({ ...draft, title: 'again' }), false)
  const [row] = await h.db.collection('traders-alerts').find({ dedupeKey: 'k' }).toArray()
  assert.equal(row?.['title'], 't')
  assert.ok(row?.['expiresAt'] instanceof Date)
  assert.equal((row?.['expiresAt'] as Date).getTime(), T0 + 30 * 86_400_000)
  const pushIdx = await indexesOf('traders-push')
  assert.ok(pushIdx.some((i) => JSON.stringify(i.key) === '{"endpoint":1}' && i.unique === true))
})

test('revoked access: disabling a trader or resetting a password forgets the phones; a disabled user is never pushed to', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const patch = (name: string, body: unknown) =>
    boss(`${P}/admin/traders/${name}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const phones = async (user: string) => h.db.collection('traders-push').countDocuments({ username: user })
  assert.equal((await patch('ravi', { disabled: true })).status, 200)
  assert.deepEqual([await phones('ravi'), await phones('sita'), await phones('boss')], [0, 1, 1])
  assert.equal((await patch('sita', { password: 'a-new-password' })).status, 200)
  assert.equal(await phones('sita'), 0)
  assert.equal((await patch('ravi', { disabled: false })).status, 200)
  assert.equal((await patch('sita', { password: 'sita-password' })).status, 200)
  ravi = h.as('ravi'); sita = h.as('sita')   // their sessions were revoked

  // a phone still on file for a user disabled outside the admin route (the CLI): the Pusher skips it
  assert.equal((await post(ravi, `${P}/push/subscribe`, phone('ravi-phone'))).status, 200)
  await h.deps.users.setDisabled('ravi', true)
  try {
    // an expiring ITM leg of ravi's (the rule reads every open leg, a disabled trader's too)
    await h.deps.legs.addManual('ravi', { stock: 'TCS', instrument: 'option', expiry: OCT, strike: 3300, optType: 'CE', qty: 175, avgPrice: 60, note: '' },
      M.options.resolve('TCS', OCT, 3300, 'CE')?.instrumentToken ?? null)
    h.clock.now = ist(OCT, '14:31')
    assert.equal(await h.app.alerts.tick(), 1)
    assert.equal(await h.db.collection('traders-alerts').countDocuments({ trader: 'ravi', kind: 'expiring-itm' }), 1, 'raised and kept for the record')
    assert.deepEqual(to('ravi-phone'), [], 'never sent to a disabled user')
  } finally {
    await h.deps.users.setDisabled('ravi', false)
  }
})
