import { after, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import type { IncomingMessage } from 'node:http'
import { DEFAULT_SESSION_TTL_MS } from '@algomaker/auth'
import { skipUnlessMongo } from '../../api/test/require-mongo.ts'
import { createTradersGate } from '../src/auth/gate.ts'
import { whose } from '../src/auth/whose.ts'
import { sha256hex } from '../src/hash.ts'
import { authRoutes } from '../src/routes/auth.ts'
import type { Route } from '../src/routes/kit.ts'
import { startHarness, type Harness } from './harness.ts'

const h: Harness | null = await startHarness('auth', (d) => {
  const whoseRoute: Route = async (ctx) => {
    if (ctx.endpoint.id !== 'books.list') return false
    ctx.send(200, { whose: await whose(ctx, d.users) })
    return true
  }
  return [authRoutes({ users: d.users, sessions: d.sessions, sessionTtlMs: DEFAULT_SESSION_TTL_MS, now: d.now, log: d.log }), whoseRoute]
})
after(async () => { await h?.close() })
beforeEach(async () => {
  if (h === null) return
  await h.reset()
  await h.addUser('ravi'); await h.addUser('sita'); await h.addUser('boss', 'admin'); await h.addUser('boss2', 'admin')
})

const LOGIN = '/v1/traders/auth/login'
const ME = '/v1/traders/auth/me'
const login = (hh: Harness, username: string, password: string) =>
  hh.call('POST', LOGIN, { json: { username, password } })
const bearerReq = (t: string) => ({ headers: { authorization: `Bearer ${t}` } }) as unknown as IncomingMessage
const gateOf = (hh: Harness) => createTradersGate({
  users: hh.users, sessions: hh.sessions, tokens: hh.tokens, now: () => hh.clock.now,
})
const pick = (o: Record<string, unknown>, keys: string[]) => Object.fromEntries(keys.map((k) => [k, o[k]]))

test('login sets the session cookie; Secure only behind https', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const r = await h.call('POST', LOGIN, { json: { username: 'Ravi', password: 'ravi-password' } })
  assert.equal(r.status, 200); assert.deepEqual(pick(r.body, ['username', 'role']), { username: 'ravi', role: 'trader' })
  assert.match(r.headers.get('set-cookie') ?? '', /^dx_traders_session=[^;]+; HttpOnly; SameSite=Strict; Path=\/; Max-Age=28800$/)
  const s = await h.call('POST', LOGIN, { json: { username: 'ravi', password: 'ravi-password' }, headers: { 'x-forwarded-proto': 'https' } })
  assert.match(s.headers.get('set-cookie') ?? '', /; Secure$/)
})

test('a login without both strings is a 400', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  for (const json of [{}, { username: 'ravi' }, { username: 'ravi', password: '' }, { username: 5, password: 'x' }]) {
    const r = await h.call('POST', LOGIN, { json })
    assert.equal(r.status, 400); assert.equal(r.body.error, 'username and password are required')
  }
})

test('wrong password and unknown user answer identically', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const a = await login(h, 'ravi', 'not-the-password'); const b = await login(h, 'nobody', 'not-the-password')
  assert.equal(a.status, 401); assert.equal(b.status, 401)
  assert.deepEqual(a.body, { error: 'invalid credentials' }); assert.deepEqual(b.body, a.body)
})

test('five failures lock the account for 15 minutes, even against the right password', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  for (let i = 0; i < 4; i++) assert.equal((await login(h, 'ravi', 'wrong-password')).status, 401)
  const fifth = await login(h, 'ravi', 'wrong-password')
  assert.equal(fifth.status, 429); assert.equal(typeof fifth.body.lockedUntil, 'number')
  assert.equal((await login(h, 'ravi', 'ravi-password')).status, 429)
  h.clock.now += 15 * 60_000 + 1
  assert.equal((await login(h, 'ravi', 'ravi-password')).status, 200)
})

test('a burst of wrong guesses counts every one of them', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const rs = await Promise.all(Array.from({ length: 4 }, () => login(h, 'sita', 'wrong-password')))
  assert.deepEqual(rs.map((r) => r.status), [401, 401, 401, 401])
  assert.equal((await h.users.find('sita'))?.failedAttempts, 4)
})

test('a disabled trader cannot log in, and their open session dies', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const cookie = await h.login('ravi'); await h.users.setDisabled('ravi', true)
  const r = await login(h, 'ravi', 'ravi-password')
  assert.equal(r.status, 403); assert.equal(r.body.error, 'this account is disabled')
  assert.equal((await h.call('GET', ME, { cookie })).status, 401)
  assert.equal((await h.call('GET', '/v1/traders/books', { cookie })).status, 401)
})

test('me, logout, expiry', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const cookie = await h.login('ravi')
  const me = await h.call('GET', ME, { cookie })
  assert.equal(me.status, 200); assert.deepEqual(me.body, { username: 'ravi', role: 'trader' })
  assert.equal((await h.call('GET', ME)).status, 401)
  const out = await h.call('POST', '/v1/traders/auth/logout', { cookie })
  assert.equal(out.status, 200); assert.match(out.headers.get('set-cookie') ?? '', /^dx_traders_session=; .*Max-Age=0$/)
  assert.equal((await h.call('GET', ME, { cookie })).status, 401)
  assert.equal((await h.call('POST', '/v1/traders/auth/logout')).status, 200)

  const again = await h.login('ravi')
  h.clock.now += DEFAULT_SESSION_TTL_MS + 1
  assert.equal((await h.call('GET', ME, { cookie: again })).status, 401)
  assert.equal(await h.db.collection('traders-sessions').countDocuments({}), 0)
})

test('two session cookies is no session', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const cookie = await h.login('ravi')
  const r = await h.call('GET', ME, { cookie: `${cookie}; dx_traders_session=other` })
  assert.equal(r.status, 401)
})

test('the session token is stored hashed', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const cookie = await h.login('ravi'); const token = decodeURIComponent(cookie.split('=')[1]!)
  const doc = await h.db.collection('traders-sessions').findOne({})
  assert.equal(JSON.stringify(doc).includes(token), false); assert.equal(doc?.['tokenHash'], sha256hex(token))
})

test('watcher tokens: hashed, one active, revocable, dead with a disabled trader', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const t1 = await h.tokens.issue('ravi', h.clock.now); assert.match(t1, /^[A-Za-z0-9_-]{43}$/)
  assert.equal(JSON.stringify(await h.db.collection('traders-tokens').find({}).toArray()).includes(t1), false)
  assert.deepEqual(await gateOf(h).authenticate(bearerReq(t1)), { kind: 'watcher', name: 'ravi' })
  const t2 = await h.tokens.issue('ravi', h.clock.now)
  assert.equal(await gateOf(h).authenticate(bearerReq(t1)), null)
  assert.equal(await h.db.collection('traders-tokens').countDocuments({ trader: 'ravi', revokedAt: null }), 1)
  assert.equal(await h.tokens.revoke('ravi', h.clock.now), true)
  assert.equal(await h.tokens.revoke('ravi', h.clock.now), false)
  assert.equal(await gateOf(h).authenticate(bearerReq(t2)), null)
  const t3 = await h.tokens.issue('ravi', h.clock.now); await h.users.setDisabled('ravi', true)
  assert.equal(await gateOf(h).authenticate(bearerReq(t3)), null)
})

test('a token of an admin account is no watcher', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const tok = await h.tokens.issue('boss', h.clock.now)
  assert.equal(await gateOf(h).authenticate(bearerReq(tok)), null)
})

test('whose(): a trader is always themselves; an admin must pick a trader', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  assert.equal((await h.call('GET', '/v1/traders/books?as=sita', { cookie: await h.login('ravi') })).body.whose, 'ravi')
  const admin = await h.login('boss')
  assert.equal((await h.call('GET', '/v1/traders/books', { cookie: admin })).status, 400)
  assert.equal((await h.call('GET', '/v1/traders/books?as=sita', { cookie: admin })).body.whose, 'sita')
  assert.equal((await h.call('GET', '/v1/traders/books?as=boss2', { cookie: admin })).status, 404)
  assert.equal((await h.call('GET', '/v1/traders/books?as=nobody', { cookie: admin })).status, 404)
})

test('a watcher bearer cannot reach a trader endpoint, so whose() is never asked', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const tok = await h.watcherToken('ravi')
  assert.equal((await h.call('GET', '/v1/traders/books', { bearer: tok })).status, 403)
})

test('a token issued under a mixed-case name is revocable and unique under the canonical one', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const t1 = await h.tokens.issue('Ravi', h.clock.now)
  assert.equal((await h.tokens.active('ravi'))?.trader, 'ravi')
  const t2 = await h.tokens.issue(' RAVI ', h.clock.now)
  assert.equal(await h.db.collection('traders-tokens').countDocuments({ trader: 'ravi', revokedAt: null }), 1)
  assert.equal(await gateOf(h).authenticate(bearerReq(t1)), null)
  assert.equal(await h.tokens.revoke('ravi', h.clock.now), true)
  assert.equal(await gateOf(h).authenticate(bearerReq(t2)), null)
})

test('the gate refuses a token row whose trader is not canonical', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const plain = 'x'.repeat(43)
  await h.db.collection('traders-tokens').insertOne({ trader: 'Ravi', tokenHash: sha256hex(plain), createdAt: 1, lastUsedAt: null, revokedAt: null })
  assert.equal(await gateOf(h).authenticate(bearerReq(plain)), null)
})

test('a wrong guess after a lockout has lifted counts one, not six', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  for (let i = 0; i < 5; i++) await login(h, 'ravi', 'wrong-password')
  assert.ok((await h.users.find('ravi'))?.lockedUntil)
  h.clock.now += 15 * 60_000 + 1
  assert.equal((await login(h, 'ravi', 'wrong-password')).status, 401)
  const u = await h.users.find('ravi')
  assert.equal(u?.failedAttempts, 1); assert.equal(u?.lockedUntil, null)
})

test('create rethrows a non-duplicate insert failure with its cause', async (t) => {
  const { TraderStore } = await import('../src/auth/users.ts')
  const boom = Object.assign(new Error('not primary'), { code: 10107 })
  const fake = { collection: () => ({ findOne: async () => null, insertOne: async () => { throw boom } }) }
  const store = new TraderStore(fake as never)
  await assert.rejects(store.create('ravi', 'h', 'trader', 1), (e) => e === boom)
  const dup = Object.assign(new Error('E11000'), { code: 11000 })
  const fake2 = { collection: () => ({ findOne: async () => null, insertOne: async () => { throw dup } }) }
  await assert.rejects(new TraderStore(fake2 as never).create('ravi', 'h', 'trader', 1), /already exists/)
})
