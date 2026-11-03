import { after, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_SESSION_TTL_MS } from '@algomaker/auth'
import { skipUnlessMongo } from '../../api/test/require-mongo.ts'
import { ChargeSettingsStore, SEED_RATES } from '../src/analytics/charges.ts'
import type { ChargeRates } from '../src/analytics/wire.ts'
import { authRoutes } from '../src/routes/auth.ts'
import { settingsRoutes } from '../src/routes/settings.ts'
import { startHarness, type Harness } from './harness.ts'

const logs: { msg: string; ctx: Record<string, unknown> | undefined }[] = []
let store: ChargeSettingsStore
const h: Harness | null = await startHarness('settings', (d) => {
  store = new ChargeSettingsStore(d.db, d.now, (msg, ctx) => { logs.push({ msg, ctx }) })
  return [
    authRoutes({ users: d.users, sessions: d.sessions, sessionTtlMs: DEFAULT_SESSION_TTL_MS, now: d.now, log: d.log }),
    settingsRoutes({ charges: store }),
  ]
})
after(async () => { await h?.close() })

const S = '/v1/traders/admin/settings'
let admin = ''
let ravi = ''
beforeEach(async () => {
  if (h === null) return
  await h.reset()
  logs.length = 0
  await h.addUser('admin', 'admin'); await h.addUser('ravi')
  admin = await h.login('admin'); ravi = await h.login('ravi')
})
const stored = async () => await h!.db.collection('traders-settings').find({ kind: 'charges' }, { projection: { _id: 0 } }).toArray()

const EDITED: ChargeRates = {
  ...SEED_RATES, option: { ...SEED_RATES.option, sttSellPct: 0.0625 }, gstPct: 18,
  brokerage: { default: { mode: 'order', amount: 15 }, byTrader: { ravi: { mode: 'lot', amount: 5 } } },
}

test('admin GET with nothing stored: the seed rates, unconfirmed', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const r = await h.call('GET', S, { cookie: admin })
  assert.equal(r.status, 200)
  assert.deepEqual(r.body, { charges: SEED_RATES })
  assert.deepEqual(await stored(), [])
})

test('admin PUT: stamped by the admin, stored once, and read back', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const put = await h.call('PUT', S, { cookie: admin, json: { charges: { ...EDITED, confirmedBy: 'mallory', confirmedAt: 1 } } })
  assert.equal(put.status, 200)
  const want = { ...EDITED, confirmedBy: 'admin', confirmedAt: h.clock.now }
  assert.deepEqual(put.body, { charges: want })
  assert.deepEqual((await h.call('GET', S, { cookie: admin })).body, { charges: want })
  h.clock.now += 60_000
  const again = await h.call('PUT', S, { cookie: admin, json: { charges: { ...EDITED, gstPct: 12 } } })
  assert.equal(again.status, 200)
  assert.deepEqual((await h.call('GET', S, { cookie: admin })).body.charges, { ...EDITED, gstPct: 12, confirmedBy: 'admin', confirmedAt: h.clock.now })
  const docs = await stored()
  assert.equal(docs.length, 1)
  assert.deepEqual([docs[0]!['trader'], docs[0]!['updatedBy'], docs[0]!['updatedAt']], [null, 'admin', h.clock.now])
  assert.ok(logs.some((l) => l.msg === 'charge rates saved' && l.ctx?.['by'] === 'admin'))
})

test('a trader PUT is 403 and the stored document is unchanged; a trader cannot GET either', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  assert.equal((await h.call('PUT', S, { cookie: admin, json: { charges: EDITED } })).status, 200)
  const before = await stored()
  const r = await h.call('PUT', S, { cookie: ravi, json: { charges: { ...EDITED, gstPct: 0 } } })
  assert.equal(r.status, 403)
  assert.deepEqual(await stored(), before)
  assert.equal((await h.call('GET', S, { cookie: ravi })).status, 403)
  assert.equal((await h.call('GET', S)).status, 401)
})

test('a bad table is 400 naming the field; nothing is stored', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const r = await h.call('PUT', S, { cookie: admin, json: { charges: { ...SEED_RATES, gstPct: 90 } } })
  assert.equal(r.status, 400)
  assert.match(r.body.error, /gstPct/)
  const deep = await h.call('PUT', S, { cookie: admin, json: { charges: { ...SEED_RATES, brokerage: { default: { mode: 'order', amount: 20 }, byTrader: { ravi: { mode: 'lot', amount: -1 } } } } } })
  assert.deepEqual([deep.status, deep.body.error], [400, 'brokerage.byTrader.ravi.amount must be 0–10000'])
  for (const body of [{}, { rates: SEED_RATES }, { charges: null }]) {
    assert.equal((await h.call('PUT', S, { cookie: admin, json: body })).status, 400, JSON.stringify(body))
  }
  assert.deepEqual(await stored(), [])
})

test('a stored table that no longer parses reads as the seed rates, and says so in the log', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  await h.db.collection('traders-settings').insertOne({ kind: 'charges', trader: null, value: { ...SEED_RATES, gstPct: 900 }, updatedAt: 1, updatedBy: 'admin' })
  assert.deepEqual(await store.get(), SEED_RATES)
  assert.deepEqual((await h.call('GET', S, { cookie: admin })).body, { charges: SEED_RATES })
  assert.ok(logs.some((l) => /do not parse/.test(l.msg) && /gstPct/.test(String(l.ctx?.['error']))))
})

test('the charges document lives beside the watcher and ledger documents of traders-settings', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  await h.db.collection('traders-settings').insertOne({ kind: 'watcher', trader: 'ravi', lastHeartbeatAt: 1 })
  await store.put(EDITED, 'admin')
  assert.deepEqual((await store.get()).gstPct, EDITED.gstPct)
  assert.equal(await h.db.collection('traders-settings').countDocuments({}), 2)
})
