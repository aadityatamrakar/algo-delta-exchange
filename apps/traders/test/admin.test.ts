import { after, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { skipUnlessMongo } from '../../api/test/require-mongo.ts'
import { DEFAULT_SESSION_TTL_MS } from '@algomaker/auth'
import { adminRoutes } from '../src/routes/admin.ts'
import { authRoutes } from '../src/routes/auth.ts'
import { BadRequest } from '../src/routes/kit.ts'
import type { AdminTraderRow } from '../src/types.ts'
import { parseHeartbeat, WatcherStatusStore } from '../src/watcher-status.ts'
import { startHarness, type Harness } from './harness.ts'

let status: WatcherStatusStore
const h: Harness | null = await startHarness('admin', (d) => {
  status = new WatcherStatusStore(d.db)
  return [
    authRoutes({ users: d.users, sessions: d.sessions, sessionTtlMs: DEFAULT_SESSION_TTL_MS, now: d.now, log: d.log }),
    adminRoutes({ users: d.users, sessions: d.sessions, tokens: d.tokens, status, now: d.now, log: d.log }),
  ]
})
after(async () => { await h?.close() })
let adminCookie = ''
beforeEach(async () => {
  if (h === null) return
  await h.reset()
  await h.addUser('boss', 'admin'); await h.addUser('ravi'); await h.addUser('sita')
  adminCookie = await h.login('boss')
})
const A = '/v1/traders/admin/traders'
const adminCall = (method: string, path: string, json?: unknown) =>
  h!.call(method, path, json === undefined ? { cookie: adminCookie } : { cookie: adminCookie, json })

test('add a trader; duplicates and bad input refused', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  assert.deepEqual((await adminCall('POST', A, { username: 'Newbie', password: 'pass-1234' })).body, { username: 'newbie' })
  assert.equal((await adminCall('POST', A, { username: 'newbie', password: 'pass-1234' })).status, 409)
  assert.equal((await adminCall('POST', A, { username: 'x', password: 'pass-1234' })).status, 400)
  assert.equal((await adminCall('POST', A, { username: 'zed', password: 'short' })).status, 400)
  assert.equal((await h.call('POST', A, { json: { username: 'zed', password: 'pass-1234' } })).status, 401)
  assert.equal((await h.call('POST', A, { cookie: await h.login('ravi'), json: { username: 'zed', password: 'pass-1234' } })).status, 403)
})

test('the list holds traders only, with token and watcher state', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  await h.tokens.issue('ravi', h.clock.now)
  await status.record('ravi', { version: '1.0.0', folder: 'C:\\ODIN\\OnLineBackup', lastUploadAt: null, fileCount: 3 }, h.clock.now)
  const rows = (await adminCall('GET', A)).body
  assert.deepEqual(rows.map((r: AdminTraderRow) => r.username), ['ravi', 'sita'])
  assert.equal(rows[0].token.lastUsedAt, null); assert.equal(rows[0].watcher.fileCount, 3); assert.equal(rows[1].token, null)
  assert.equal(rows[1].watcher, null)
  assert.equal(JSON.stringify(rows).includes('passwordHash'), false)
})

test('disable revokes sessions; a new password revokes sessions and clears the lockout', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const ME = '/v1/traders/auth/me'
  let cookie = await h.login('ravi')
  assert.equal((await h.call('GET', ME, { cookie })).status, 200)
  assert.equal((await adminCall('PATCH', `${A}/ravi`, { disabled: true })).status, 200)
  assert.equal((await h.call('GET', ME, { cookie })).status, 401)
  assert.equal((await h.call('POST', '/v1/traders/auth/login', { json: { username: 'ravi', password: 'ravi-password' } })).status, 403)
  assert.equal((await adminCall('PATCH', `${A}/ravi`, { disabled: false })).status, 200)
  // the pre-disable cookie must stay dead after re-enabling: the sessions were revoked, not just masked
  assert.equal((await h.call('GET', ME, { cookie })).status, 401)
  cookie = await h.login('ravi')
  for (let i = 0; i < 5; i++) await h.call('POST', '/v1/traders/auth/login', { json: { username: 'ravi', password: 'wrong-wrong' } })
  assert.equal((await h.call('POST', '/v1/traders/auth/login', { json: { username: 'ravi', password: 'ravi-password' } })).status, 429)
  assert.equal((await adminCall('PATCH', `${A}/ravi`, { password: 'new-pass-99' })).status, 200)
  assert.equal((await h.call('GET', ME, { cookie })).status, 401)
  assert.equal((await h.call('POST', '/v1/traders/auth/login', { json: { username: 'ravi', password: 'new-pass-99' } })).status, 200)
  assert.equal((await adminCall('PATCH', `${A}/ravi`, { password: 'short' })).status, 400)
})

test('patch refuses admins, unknown names and empty bodies', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  assert.equal((await adminCall('PATCH', `${A}/boss`, { disabled: true })).status, 404)
  assert.equal((await adminCall('PATCH', `${A}/nobody`, { disabled: true })).status, 404)
  assert.equal((await adminCall('PATCH', `${A}/ravi`, {})).status, 400)
  assert.equal((await adminCall('PATCH', `${A}/ravi`, { disabled: 'yes' })).status, 400)
  assert.equal((await adminCall('POST', `${A}/boss/token`)).status, 404)
})

test('issue shows the token once; issuing again kills the old one; revoke', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const { token } = (await adminCall('POST', `${A}/Ravi/token`)).body
  assert.equal(JSON.stringify((await adminCall('GET', A)).body).includes(token), false)
  await adminCall('POST', `${A}/ravi/token`)
  assert.equal(await h.tokens.authenticate(token, h.clock.now), null)
  assert.equal((await adminCall('DELETE', `${A}/ravi/token`)).status, 200)
  assert.equal((await adminCall('DELETE', `${A}/ravi/token`)).status, 404)
})

test('parseHeartbeat', () => {
  const ok = { version: '1.0.0', folder: 'C:\\x', lastUploadAt: 5, fileCount: 2 }
  assert.deepEqual(parseHeartbeat(ok), ok)
  assert.equal(parseHeartbeat({ ...ok, lastUploadAt: null }).lastUploadAt, null)
  for (const bad of [{ ...ok, version: 5 }, { ...ok, fileCount: -1 }, { ...ok, fileCount: 1.5 }, { ...ok, folder: 'x'.repeat(300) },
    { ...ok, version: 'v'.repeat(33) }, { ...ok, lastUploadAt: 'x' }, null, []]) {
    assert.throws(() => parseHeartbeat(bad), BadRequest)
  }
})

test('status store: record replaces, all lists every trader', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  await status.record('ravi', { version: '1', folder: 'a', lastUploadAt: null, fileCount: 1 }, 100)
  await status.record('Ravi', { version: '2', folder: 'a', lastUploadAt: 90, fileCount: 4 }, 200)
  await status.record('sita', { version: '1', folder: 'b', lastUploadAt: null, fileCount: 0 }, 150)
  assert.deepEqual(await status.get('ravi'), { lastHeartbeatAt: 200, lastUploadAt: 90, version: '2', folder: 'a', fileCount: 4 })
  assert.equal(await status.get('nobody'), null)
  assert.deepEqual([...(await status.all()).keys()].sort(), ['ravi', 'sita'])
})
