import { test } from 'node:test'
import assert from 'node:assert/strict'
import { skipUnlessMongo } from '../../api/test/require-mongo.ts'
import { SessionStore } from '../src/auth/sessions.ts'
import { TraderStore } from '../src/auth/users.ts'
import { main } from '../src/user-cli.ts'
import { connectSuite, suiteUrl, wipe } from './mongo.ts'

test('create-admin makes an admin; a short password is refused; list shows roles', async (t) => {
  const s = await connectSuite('cli'); if (s === null) return skipUnlessMongo(t)
  await wipe(s.handle)
  process.env['TRADERS_MONGO_URL'] = suiteUrl('cli')
  t.mock.method(console, 'error', () => {})
  const out: string[] = []
  t.mock.method(console, 'log', (...a: unknown[]) => { out.push(a.join(' ')) })
  const store = new TraderStore(s.db)
  try {
    await main(['create-admin', 'boss', '--password', 'long-enough'])
    assert.equal((await store.find('boss'))?.role, 'admin')
    await assert.rejects(main(['create-admin', 'x2', '--password', 'short']), /at least 8/)
    assert.equal(await store.find('x2'), null)
    await assert.rejects(main(['create-admin', 'boss', '--password', 'long-enough']), /already exists/)
    await assert.rejects(main(['create-admin', 'Bad Name', '--password', 'long-enough']), /username must be/)

    out.length = 0
    await main(['list'])
    const line = out.find((l) => l.startsWith('boss'))
    assert.ok(line?.includes('admin')); assert.equal(out.join('\n').includes('$argon2'), false)
  } finally { await s.handle.close() }
})

test('reset revokes sessions and clears the lockout; unlock clears it; unknown user is an error', async (t) => {
  const s = await connectSuite('cli'); if (s === null) return skipUnlessMongo(t)
  await wipe(s.handle)
  process.env['TRADERS_MONGO_URL'] = suiteUrl('cli')
  t.mock.method(console, 'error', () => {}); t.mock.method(console, 'log', () => {})
  const store = new TraderStore(s.db); const sessions = new SessionStore(s.db)
  try {
    await main(['create-admin', 'boss', '--password', 'long-enough'])
    await sessions.create('boss', Date.now(), 60_000)
    for (let i = 0; i < 5; i++) await store.recordLoginFailure('boss', Date.now())
    assert.ok((await store.find('boss'))?.lockedUntil)
    await main(['unlock', 'boss'])
    assert.equal((await store.find('boss'))?.lockedUntil, null)
    await main(['reset', 'boss', '--password', 'brand-new-pw'])
    assert.equal(await s.db.collection('traders-sessions').countDocuments({}), 0)
    await assert.rejects(main(['reset', 'ghost', '--password', 'brand-new-pw']), /no such user/)
  } finally { await s.handle.close() }
})

test('TRADERS_MONGO_URL is required', async (t) => {
  const saved = process.env['TRADERS_MONGO_URL']; delete process.env['TRADERS_MONGO_URL']
  t.mock.method(console, 'log', () => {})
  try { await assert.rejects(main(['list']), /TRADERS_MONGO_URL/) }
  finally { if (saved !== undefined) process.env['TRADERS_MONGO_URL'] = saved }
})
