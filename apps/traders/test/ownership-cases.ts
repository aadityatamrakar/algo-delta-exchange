/**
 * One ownership case per endpoint id. A case is a short script that, as trader
 * A, tries to reach trader B's data (or an admin door) and asserts it cannot.
 * `ownership.test.ts` fails listing every endpoint in the table with no entry
 * here, so a new endpoint cannot ship without its case. Releases 2 and 3 add
 * their endpoints' cases to this file; a market-data endpoint's case asserts the
 * response carries no `trader`, `legs` or `key` field.
 */

import assert from 'node:assert/strict'
import type { BookSummary } from '../src/types.ts'

export interface Res { status: number; body: any; headers: Headers }

export interface Walk {
  /** Trader A's session. A Buffer or string body is sent raw, anything else as JSON. */
  asA(method: string, path: string, body?: unknown): Promise<Res>
  asAdmin(method: string, path: string, body?: unknown): Promise<Res>
  /** Trader A's watcher token. */
  watcherA(method: string, path: string, body?: unknown): Promise<Res>
  /** Trader B's watcher token. */
  watcherB(method: string, path: string, body?: unknown): Promise<Res>
  /** No credentials at all. */
  anon(method: string, path: string, body?: unknown): Promise<Res>
  /** A fresh login (its own session) for a user whose password is `${name}-password`. */
  login(name: string): Promise<string>
  withCookie(cookie: string, method: string, path: string, body?: unknown): Promise<Res>
  readonly tokenA: string
  readonly tokenB: string
  /** Rows of a traders-* collection for one trader, `_id` dropped, in a stable order. */
  rows(collection: string, trader: string): Promise<Record<string, unknown>[]>
  readonly b: {
    stocks: string[]; manualKey: string; day: string
    /** B's assistant conversation (one turn), stored by the walk's setup. */
    conversation: string
    legKeys(): Promise<string[]>
    files(): Promise<string[]>
  }
}

export type Case = (w: Walk) => Promise<void>

const own = (r: Res): void => assert.equal(r.status, 403, `expected 403, got ${r.status} ${JSON.stringify(r.body)}`)
const noOther = (body: unknown): void => {
  assert.equal(JSON.stringify(body).includes('sita'), false, 'the response names trader sita')
}
const QUERY = (day: string) => `day=${day}&as=sita`

/** A browser's push subscription on FCM; the walk's setup subscribes B's (gaps G7). */
const phoneOf = (id: string) => ({
  endpoint: `https://fcm.googleapis.com/fcm/send/${id}`,
  keys: { p256dh: Buffer.concat([Buffer.from([4]), Buffer.alloc(64, id.length)]).toString('base64url'), auth: Buffer.alloc(16, 7).toString('base64url') },
})
export const PHONE_B = phoneOf('phone-of-b')
const PHONE_A = phoneOf('phone-of-a')

/** An admin endpoint, as trader A (session) and as a watcher token: refused, and B untouched. */
async function adminDoor(w: Walk, method: string, path: string, body: unknown, untouched: () => Promise<unknown>): Promise<void> {
  const before = JSON.stringify(await untouched())
  own(await w.asA(method, path, body))
  own(await w.watcherA(method, path, body))
  own(await w.watcherB(method, path, body))
  assert.equal(JSON.stringify(await untouched()), before, 'a refused admin call changed data')
}

export const CASES: Record<string, Case> = {
  'health': async (w) => {
    const r = await w.anon('GET', '/v1/traders/health')
    assert.equal(r.status, 200)
    for (const name of ['ravi', 'sita', 'boss']) assert.equal(JSON.stringify(r.body).includes(name), false)
  },
  'auth.login': async (w) => {
    // ravi's password never opens sita's account
    const bad = await w.anon('POST', '/v1/traders/auth/login', { username: 'sita', password: 'ravi-password' })
    assert.equal(bad.status, 401)
    assert.equal(bad.headers.get('set-cookie'), null)
    const cookie = await w.login('ravi')
    const me = await w.withCookie(cookie, 'GET', '/v1/traders/auth/me')
    assert.deepEqual(me.body, { username: 'ravi', role: 'trader' })
  },
  'auth.logout': async (w) => {
    const a = await w.login('ravi')
    const b = await w.login('sita')
    assert.equal((await w.withCookie(a, 'POST', '/v1/traders/auth/logout')).status, 200)
    assert.equal((await w.withCookie(a, 'GET', '/v1/traders/auth/me')).status, 401)
    assert.equal((await w.withCookie(b, 'GET', '/v1/traders/auth/me')).status, 200, 'logging A out ended B\'s session')
  },
  'auth.me': async (w) => {
    const r = await w.asA('GET', '/v1/traders/auth/me?as=sita')
    assert.deepEqual(r.body, { username: 'ravi', role: 'trader' })
    assert.equal((await w.anon('GET', '/v1/traders/auth/me')).status, 401)
  },

  'watcher.files': async (w) => {
    const { sha256hex } = await import('../src/hash.ts')
    const filesB = await w.b.files(); const legsB = await w.b.legKeys()
    const before = JSON.stringify(await w.rows('traders-files', 'sita'))
    const note = 'ravi was here\r\n'
    const q = (p: string, extra = '') => `/v1/traders/files?path=${encodeURIComponent(p)}&mtime=1&sha256=${sha256hex(note)}${extra}`
    // the trader is the token: a trader named in the query or a header is ignored
    const r = await w.watcherA('PUT', q('Nse Derivatives/Trades/ravi-note.log', '&trader=sita&as=sita'), Buffer.from(note))
    assert.equal(r.status, 200)
    assert.equal((await w.rows('traders-files', 'ravi')).some((f) => f['path'] === 'Nse Derivatives/Trades/ravi-note.log'), true)
    assert.deepEqual(await w.b.files(), filesB)
    // A sending a path B already holds writes A's row, never B's
    const clash = filesB[0] as string
    const junk = 'not an odin file\r\n'
    const r2 = await w.watcherA('PUT', `/v1/traders/files?path=${encodeURIComponent(clash)}&mtime=1&sha256=${sha256hex(junk)}`, Buffer.from(junk))
    assert.equal(r2.status, 200)
    assert.equal(JSON.stringify(await w.rows('traders-files', 'sita')), before)
    assert.deepEqual(await w.b.legKeys(), legsB)
    // a session cookie on a watcher endpoint is refused
    own(await w.asA('PUT', q('x.log'), Buffer.from(note)))
    own(await w.asAdmin('PUT', q('x.log'), Buffer.from(note)))
  },
  'watcher.heartbeat': async (w) => {
    const beforeB = JSON.stringify(await w.rows('traders-settings', 'sita'))
    const r = await w.watcherA('POST', '/v1/traders/heartbeat?as=sita', { version: '9.9', folder: 'C:\\odin-ravi', lastUploadAt: null, fileCount: 1, trader: 'sita' })
    assert.equal(r.status, 200)
    const mine = await w.rows('traders-settings', 'ravi')
    assert.deepEqual(mine.map((s) => s['folder']), ['C:\\odin-ravi'])
    assert.equal(JSON.stringify(await w.rows('traders-settings', 'sita')), beforeB)
    own(await w.asA('POST', '/v1/traders/heartbeat', { version: '1', folder: 'x', lastUploadAt: null, fileCount: 0 }))
    own(await w.asAdmin('POST', '/v1/traders/heartbeat', { version: '1', folder: 'x', lastUploadAt: null, fileCount: 0 }))
  },

  'admin.traders.list': async (w) => {
    assert.equal((await w.asAdmin('GET', '/v1/traders/admin/traders')).status, 200)
    await adminDoor(w, 'GET', '/v1/traders/admin/traders', undefined, async () => 0)
    const r = await w.asA('GET', '/v1/traders/admin/traders')
    noOther(r.body)
  },
  'admin.traders.add': async (w) => {
    await adminDoor(w, 'POST', '/v1/traders/admin/traders', { username: 'mallory', password: 'password-1' }, async () => w.rows('traders-users', 'mallory'))
    assert.deepEqual(await w.rows('traders-users', 'mallory'), [])
  },
  'admin.traders.patch': async (w) => {
    const state = async () => w.rows('traders-users', 'sita')
    await adminDoor(w, 'PATCH', '/v1/traders/admin/traders/sita', { disabled: true }, state)
    await adminDoor(w, 'PATCH', '/v1/traders/admin/traders/sita', { password: 'hijacked-password' }, state)
    await adminDoor(w, 'PATCH', '/v1/traders/admin/traders/ravi', { disabled: true }, async () => w.rows('traders-users', 'ravi'))
    assert.equal((await w.login('sita')).startsWith('dx_traders_session='), true, 'sita can still sign in with her own password')
  },
  'admin.token.issue': async (w) => {
    await adminDoor(w, 'POST', '/v1/traders/admin/traders/sita/token', undefined, async () => w.rows('traders-tokens', 'sita'))
    assert.equal((await w.watcherB('GET', '/v1/traders/auth/me')).status, 401)
    // B's token still works as a watcher
    assert.equal((await w.watcherB('POST', '/v1/traders/heartbeat', { version: '1', folder: 'C:\\odin-sita', lastUploadAt: null, fileCount: 0 })).status, 200)
  },
  'admin.token.revoke': async (w) => {
    await adminDoor(w, 'DELETE', '/v1/traders/admin/traders/sita/token', undefined, async () => w.rows('traders-tokens', 'sita'))
    assert.equal((await w.watcherB('POST', '/v1/traders/heartbeat', { version: '1', folder: 'C:\\odin-sita', lastUploadAt: null, fileCount: 0 })).status, 200)
  },
  'admin.files.upload': async (w) => {
    await adminDoor(w, 'PUT', '/v1/traders/admin/traders/sita/files?path=planted.csv', Buffer.from('x'), async () => [await w.b.files(), await w.b.legKeys()])
    assert.equal((await w.b.files()).includes('planted.csv'), false)
  },
  'admin.settings.get': async (w) => {
    const r = await w.asAdmin('GET', '/v1/traders/admin/settings')
    assert.equal(r.status, 200)
    assert.deepEqual(Object.keys(r.body), ['charges'])
    await adminDoor(w, 'GET', '/v1/traders/admin/settings', undefined, async () => 0)
    noOther((await w.asA('GET', '/v1/traders/admin/settings')).body)
  },
  'admin.settings.put': async (w) => {
    const { SEED_RATES } = await import('../src/analytics/charges.ts')
    const settings = async () => (await w.asAdmin('GET', '/v1/traders/admin/settings')).body
    await adminDoor(w, 'PUT', '/v1/traders/admin/settings', { charges: { ...SEED_RATES, gstPct: 0 } }, settings)
    assert.equal((await settings()).charges.confirmedBy, null, 'a refused PUT confirmed the rates')
  },

  'books.list': async (w) => {
    const r = await w.asA('GET', '/v1/traders/books?as=sita')
    assert.deepEqual(r.body.map((b: BookSummary) => b.stock), ['TCS'])
    noOther(r.body)
  },
  'books.view': async (w) => {
    for (const stock of w.b.stocks) {
      assert.equal((await w.asA('GET', `/v1/traders/books/${encodeURIComponent(stock)}?as=sita`)).status, 404, stock)
    }
    const mine = await w.asA('GET', '/v1/traders/books/TCS?as=sita')
    assert.equal(mine.status, 200)
    noOther(mine.body)
  },
  'books.live': async (w) => {
    for (const stock of w.b.stocks) {
      assert.equal((await w.asA('GET', `/v1/traders/books/${encodeURIComponent(stock)}/live?as=sita`)).status, 404, stock)
    }
    const mine = await w.asA('GET', '/v1/traders/books/TCS/live?as=sita')
    assert.equal(mine.status, 200)
    assert.equal(mine.headers.get('content-type'), 'text/event-stream; charset=utf-8')
    assert.equal((mine.body as { stock?: unknown } | null)?.stock, 'TCS')
    noOther(mine.body)
  },
  'books.margin': async (w) => {
    for (const stock of w.b.stocks) {
      assert.equal((await w.asA('GET', `/v1/traders/books/${encodeURIComponent(stock)}/margin?as=sita`)).status, 404, stock)
    }
    const mine = await w.asA('GET', '/v1/traders/books/TCS/margin?as=sita')
    assert.equal(mine.status, 200)
    noOther(mine.body)
  },
  'books.analysis': async (w) => {
    for (const stock of w.b.stocks) {
      assert.equal((await w.asA('GET', `/v1/traders/books/${encodeURIComponent(stock)}/analysis?as=sita`)).status, 404, stock)
    }
    const mine = await w.asA('GET', '/v1/traders/books/TCS/analysis?as=sita')
    assert.equal(mine.status, 200)
    noOther(mine.body)
  },
  'books.scenario': async (w) => {
    for (const stock of w.b.stocks) {
      assert.equal((await w.asA('POST', `/v1/traders/books/${encodeURIComponent(stock)}/scenario?as=sita`, {})).status, 404, stock)
    }
    // A's own TCS book (one share leg); this walk has no price for it, so the bare request asks for a CMP
    const bare = await w.asA('POST', '/v1/traders/books/TCS/scenario?as=sita', {})
    assert.equal(bare.status, 400, JSON.stringify(bare.body))
    noOther(bare.body)
    const mine = await w.asA('POST', '/v1/traders/books/TCS/scenario?as=sita', { spot: 3400 })
    assert.equal(mine.status, 200, JSON.stringify(mine.body))
    assert.deepEqual(mine.body.legs.map((l: { qty: number }) => l.qty), [5])
    noOther(mine.body)
  },
  'legs.add': async (w) => {
    const before = await w.b.legKeys()
    await w.asA('POST', '/v1/traders/books/M%26M/legs?as=sita', { instrument: 'share', qty: 1, avgPrice: 1, trader: 'sita' })
    assert.deepEqual(await w.b.legKeys(), before)
  },
  'legs.patch': async (w) => {
    const before = JSON.stringify(await w.rows('traders-legs', 'sita'))
    assert.equal((await w.asA('PATCH', `/v1/traders/legs/${encodeURIComponent(w.b.manualKey)}?as=sita`, { qty: 5 })).status, 404)
    assert.equal(JSON.stringify(await w.rows('traders-legs', 'sita')), before)
  },
  'legs.delete': async (w) => {
    const before = await w.b.legKeys()
    assert.equal((await w.asA('DELETE', `/v1/traders/legs/${encodeURIComponent(w.b.manualKey)}?as=sita`)).status, 404)
    assert.deepEqual(await w.b.legKeys(), before)
  },
  'orders.list': async (w) => {
    assert.deepEqual((await w.asA('GET', `/v1/traders/orders?${QUERY(w.b.day)}`)).body, [])
    assert.deepEqual((await w.asA('GET', `/v1/traders/orders?${QUERY(w.b.day)}&stock=JINDALSTEL`)).body, [])
  },
  'trades.list': async (w) => {
    assert.deepEqual((await w.asA('GET', `/v1/traders/trades?${QUERY(w.b.day)}`)).body, [])
  },
  'log.list': async (w) => {
    assert.deepEqual((await w.asA('GET', `/v1/traders/log?${QUERY(w.b.day)}`)).body, [])
  },
  'watcher.status': async (w) => {
    assert.equal((await w.watcherA('POST', '/v1/traders/heartbeat', { version: '1', folder: 'C:\\odin-ravi', lastUploadAt: null, fileCount: 0 })).status, 200)
    const r = await w.asA('GET', '/v1/traders/watcher?as=sita')
    const mine = await w.rows('traders-settings', 'ravi')
    assert.equal(r.status, 200)
    assert.ok(mine.length > 0, 'A has a heartbeat of its own (sent just above)')
    assert.equal(r.body?.folder, mine[0]?.['folder'])
    assert.notEqual(r.body?.folder, 'C:\\odin-sita')
  },
  'files.list': async (w) => {
    const r = await w.asA('GET', '/v1/traders/files?as=sita')
    const mine = (await w.rows('traders-files', 'ravi')).map((f) => f['path']).sort()
    assert.deepEqual(r.body.map((f: { path: string }) => f.path).sort(), mine)
    const theirs = await w.b.files()
    for (const f of r.body as { path: string; sha256: string }[]) {
      const own = (await w.rows('traders-files', 'ravi')).find((x) => x['path'] === f.path)
      assert.equal(f.sha256, own?.['sha256'], `${f.path} is not A's file`)
    }
    assert.ok(theirs.length > 0)
  },
  'books.groups': async (w) => {
    assert.equal((await w.asA('GET', '/v1/traders/books/JINDALSTEL/groups?as=sita')).status, 404)
  },
  'books.groups.put': async (w) => {
    const r = await w.asA('PUT', '/v1/traders/books/TCS/groups?as=sita', { groups: [{ name: 'x', keys: await w.b.legKeys() }] })
    assert.equal(r.status, 400, JSON.stringify(r.body))
    assert.match(r.body.error, /unknown leg keys/)
    assert.deepEqual(await w.rows('traders-groups', 'sita'), [])
    assert.deepEqual(await w.rows('traders-groups', 'ravi'), [])
  },
  'books.repair': async (w) => {
    // JINDALSTEL only: by now the legs.add case has given A an M&M share leg of its own
    assert.equal((await w.asA('POST', '/v1/traders/books/JINDALSTEL/repair?as=sita', {})).status, 404)
    // A's own TCS book (one share leg): nothing to repair, and nothing of B's in the answer
    const mine = await w.asA('POST', '/v1/traders/books/TCS/repair?as=sita', {})
    assert.equal(mine.status, 200, JSON.stringify(mine.body))
    assert.equal(mine.body.error, 'no option legs to repair: TCS holds only shares')
    noOther(mine.body)
  },
  'books.band': async (w) => {
    // ravi holds no JINDALSTEL: `?as=sita` is ignored for a trader, so it is ravi's (absent) book, and nothing is written
    const r = await w.asA('PUT', '/v1/traders/books/JINDALSTEL/band?as=sita', { lots: 2 })
    assert.equal(r.status, 404, JSON.stringify(r.body))
    assert.deepEqual(r.body, { error: 'no open book JINDALSTEL' })
    for (const trader of ['sita', 'ravi']) assert.deepEqual((await w.rows('traders-settings', trader)).filter((s) => s['kind'] === 'band'), [], trader)
  },
  'market.contracts': async (w) => {
    // market data: 200 for anyone signed in, `as` ignored, and nothing in it is a trader's
    const r = await w.asA('GET', '/v1/traders/contracts/JINDALSTEL?as=sita')
    assert.equal(r.status, 200, JSON.stringify(r.body))
    const fields = (v: unknown): string[] => (Array.isArray(v) ? v.flatMap(fields)
      : typeof v === 'object' && v !== null ? Object.entries(v).flatMap(([k, x]) => [k, ...fields(x)]) : [])
    for (const f of ['trader', 'legs', 'key']) assert.equal(fields(r.body).includes(f), false, `the response carries a ${f} field`)
    noOther(r.body)
  },
  'market.watch': async (w) => {
    // market data: 200 for anyone signed in, `as` ignored, and nothing in it is a trader's
    const r = await w.asA('GET', '/v1/traders/market/JINDALSTEL?as=sita')
    assert.equal(r.status, 200, JSON.stringify(r.body))
    const fields = (v: unknown): string[] => (Array.isArray(v) ? v.flatMap(fields)
      : typeof v === 'object' && v !== null ? Object.entries(v).flatMap(([k, x]) => [k, ...fields(x)]) : [])
    for (const f of ['trader', 'legs', 'key']) assert.equal(fields(r.body).includes(f), false, `the response carries a ${f} field`)
    noOther(r.body)
  },
  'market.context': async (w) => {
    // market data: 200 for anyone signed in, `as` ignored (B holds JINDALSTEL, A does not: the same view), nothing a trader's
    const r = await w.asA('GET', '/v1/traders/market/JINDALSTEL/context?as=sita')
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.stock, 'JINDALSTEL')
    const fields = (v: unknown): string[] => (Array.isArray(v) ? v.flatMap(fields)
      : typeof v === 'object' && v !== null ? Object.entries(v).flatMap(([k, x]) => [k, ...fields(x)]) : [])
    for (const f of ['trader', 'legs', 'key']) assert.equal(fields(r.body).includes(f), false, `the response carries a ${f} field`)
    noOther(r.body)
    const admin = await w.asAdmin('GET', '/v1/traders/market/JINDALSTEL/context?as=sita')
    assert.equal(admin.status, 200, JSON.stringify(admin.body))
    assert.deepEqual({ ...admin.body, asOf: 0 }, { ...r.body, asOf: 0 }, 'an admin acting as B sees the same market')
    assert.equal((await w.watcherA('GET', '/v1/traders/market/JINDALSTEL/context')).status, 403)
  },
  'market.bars': async (w) => {
    const fields = (v: unknown): string[] => (Array.isArray(v) ? v.flatMap(fields)
      : typeof v === 'object' && v !== null ? Object.entries(v).flatMap(([k, x]) => [k, ...fields(x)]) : [])
    for (const interval of ['day', '15m', '5m']) {
      const r = await w.asA('GET', `/v1/traders/market/JINDALSTEL/bars?interval=${interval}&as=sita`)
      assert.equal(r.status, 200, JSON.stringify(r.body))
      assert.deepEqual([r.body.stock, r.body.interval], ['JINDALSTEL', interval])
      for (const f of ['trader', 'legs', 'key']) assert.equal(fields(r.body).includes(f), false, `the response carries a ${f} field`)
      noOther(r.body)
    }
    assert.equal((await w.watcherA('GET', '/v1/traders/market/JINDALSTEL/bars')).status, 403)
  },
  'portfolio.view': async (w) => {
    // `?as=` is ignored for a trader: A's own portfolio, A's own books only — TCS, and the M&M share
    // legs.add's case left A (B's M&M book is ten shares, A's one)
    const r = await w.asA('GET', '/v1/traders/portfolio?as=sita')
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.trader, 'ravi')
    const own: string[] = (await w.asA('GET', '/v1/traders/books')).body.map((b: BookSummary) => b.stock)
    assert.deepEqual(r.body.rows.map((x: { stock: string }) => x.stock), own)
    assert.ok(own.includes('TCS') && !own.includes('JINDALSTEL'), JSON.stringify(own))
    for (const row of r.body.rows as { stock: string; delta: number }[]) {
      const view = await w.asA('GET', `/v1/traders/books/${encodeURIComponent(row.stock)}`)
      assert.equal(row.delta, view.body.totals.delta, row.stock)
    }
    noOther(r.body)
  },
  'admin.portfolio': async (w) => {
    const all = await w.asAdmin('GET', '/v1/traders/admin/portfolio')
    assert.equal(all.status, 200, JSON.stringify(all.body))
    assert.deepEqual(all.body.traders.map((t: { trader: string }) => t.trader), ['ravi', 'sita'])
    await adminDoor(w, 'GET', '/v1/traders/admin/portfolio', undefined, async () => 0)
    noOther((await w.asA('GET', '/v1/traders/admin/portfolio')).body)
  },
  'books.advice': async (w) => {
    // ravi holds no JINDALSTEL: `?as=sita` is ignored for a trader, so it is ravi's (absent) book
    const r = await w.asA('GET', '/v1/traders/books/JINDALSTEL/advice?as=sita')
    assert.equal(r.status, 404, JSON.stringify(r.body))
    assert.deepEqual(r.body, { error: 'no open book JINDALSTEL' })
    // A's own TCS book (one share leg): the walk quotes no TCS price, so no forward and no band to advise from, and nothing of B's in the card
    const mine = await w.asA('GET', '/v1/traders/books/TCS/advice?as=sita')
    assert.equal(mine.status, 200, JSON.stringify(mine.body))
    assert.deepEqual([mine.body.stock, mine.body.status, mine.body.lines, mine.body.whatIf], ['TCS', 'unavailable', [], []])
    noOther(mine.body)
  },
  'assistant.status': async (w) => {
    // A's own status (`?as=` ignored): off in the walk, and nothing of B's in it
    const r = await w.asA('GET', '/v1/traders/assistant/status?as=sita')
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.enabled, false)
    assert.equal(r.body.budget.traderUsdToday, 0)
    noOther(r.body)
  },
  'assistant.chat': async (w) => {
    // off in the walk: 503 before anything is read or written, B's conversation untouched
    const before = JSON.stringify(await w.rows('traders-assistant', 'sita'))
    const r = await w.asA('POST', '/v1/traders/assistant/chat?as=sita', { message: 'read sita', conversationId: w.b.conversation })
    assert.equal(r.status, 503, JSON.stringify(r.body))
    assert.equal(JSON.stringify(await w.rows('traders-assistant', 'sita')), before)
    assert.deepEqual(await w.rows('traders-assistant', 'ravi'), [])
  },
  'assistant.conversations': async (w) => {
    const r = await w.asA('GET', '/v1/traders/assistant/conversations?as=sita')
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.deepEqual(r.body, [])
    const b = await w.asAdmin('GET', '/v1/traders/assistant/conversations?as=sita')
    assert.deepEqual(b.body.map((c: { id: string }) => c.id), [w.b.conversation], 'an admin names B with ?as=')
  },
  'assistant.conversation': async (w) => {
    const path = `/v1/traders/assistant/conversations/${w.b.conversation}?as=sita`
    const r = await w.asA('GET', path)
    assert.equal(r.status, 404, JSON.stringify(r.body))
    noOther(r.body)
    const admin = await w.asAdmin('GET', path)
    assert.equal(admin.status, 200)
    assert.equal(admin.body.id, w.b.conversation)
  },
  'assistant.conversation.hide': async (w) => {
    const r = await w.asA('DELETE', `/v1/traders/assistant/conversations/${w.b.conversation}?as=sita`)
    assert.equal(r.status, 404, JSON.stringify(r.body))
    assert.deepEqual((await w.rows('traders-assistant', 'sita')).map((d) => d['hidden']), [false])
  },
  'assistant.feedback': async (w) => {
    const r = await w.asA('POST', `/v1/traders/assistant/conversations/${w.b.conversation}/feedback?as=sita`, { turn: 1, rating: 'down', note: 'ravi was here' })
    assert.equal(r.status, 404, JSON.stringify(r.body))
    const [doc] = await w.rows('traders-assistant', 'sita')
    assert.equal((doc?.['turns'] as { feedback: unknown }[])[0]?.feedback, null)
  },
  'admin.assistant.usage': async (w) => {
    assert.equal((await w.asAdmin('GET', '/v1/traders/admin/assistant/usage')).status, 200)
    await adminDoor(w, 'GET', '/v1/traders/admin/assistant/usage', undefined, async () => 0)
    noOther((await w.asA('GET', '/v1/traders/admin/assistant/usage')).body)
  },
  'admin.assistant.export': async (w) => {
    const all = await w.asAdmin('GET', `/v1/traders/admin/assistant/export?from=${w.b.day}&to=${w.b.day}`)
    assert.equal(all.status, 200)
    // one turn is one line: the walk's reader parses a single line as JSON
    assert.match(typeof all.body === 'string' ? all.body : JSON.stringify(all.body), /"trader":"sita"/, 'the admin export carries every trader')
    await adminDoor(w, 'GET', '/v1/traders/admin/assistant/export', undefined, async () => w.rows('traders-assistant', 'sita'))
    noOther((await w.asA('GET', '/v1/traders/admin/assistant/export')).body)
  },
  'books.plan-search': async (w) => {
    // ravi holds no JINDALSTEL: `?as=sita` is ignored for a trader, so it is ravi's (absent) book, and nothing is recorded for anyone
    const before = JSON.stringify(await w.rows('traders-assistant', 'sita'))
    const r = await w.asA('POST', '/v1/traders/books/JINDALSTEL/plan-search?as=sita', { presets: ['neutralize-delta'] })
    assert.equal(r.status, 404, JSON.stringify(r.body))
    assert.deepEqual(r.body, { error: 'no open book JINDALSTEL' })
    // A's own TCS book (one share leg): nothing to search, and nothing of B's in the answer
    const mine = await w.asA('POST', '/v1/traders/books/TCS/plan-search?as=sita', { presets: ['neutralize-delta'] })
    assert.equal(mine.status, 422, JSON.stringify(mine.body))
    noOther(mine.body)
    assert.equal(JSON.stringify(await w.rows('traders-assistant', 'sita')), before)
  },
  'vol.view': async (w) => {
    // `?as=` is ignored for a trader: a row per A's own open book only, and no trader named but A
    const r = await w.asA('GET', '/v1/traders/vol?as=sita')
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.trader, 'ravi')
    const mine: string[] = (await w.asA('GET', '/v1/traders/books')).body.map((b: BookSummary) => b.stock)
    assert.deepEqual(r.body.rows.map((x: { stock: string }) => x.stock), mine)
    assert.ok(mine.includes('TCS') && !mine.includes('JINDALSTEL'), JSON.stringify(mine))
    noOther(r.body)
    // an admin: every held stock without `?as=`, B's with it; a watcher token never
    const all = await w.asAdmin('GET', '/v1/traders/vol')
    assert.equal(all.body.trader, null)
    for (const s of ['JINDALSTEL', 'TCS']) assert.ok(all.body.rows.some((x: { stock: string }) => x.stock === s), s)
    assert.equal(JSON.stringify(all.body).includes('sita') || JSON.stringify(all.body).includes('ravi'), false)
    const theirs: string[] = (await w.asAdmin('GET', '/v1/traders/books?as=sita')).body.map((b: BookSummary) => b.stock)
    const b = await w.asAdmin('GET', '/v1/traders/vol?as=sita')
    assert.deepEqual([b.body.trader, b.body.rows.map((x: { stock: string }) => x.stock)], ['sita', theirs])
    assert.ok(theirs.includes('JINDALSTEL'), JSON.stringify(theirs))
    own(await w.watcherA('GET', '/v1/traders/vol'))
  },
  'risk.view': async (w) => {
    // `?as=` is ignored for a trader: a book per A's own open book only, and no trader named but A
    const r = await w.asA('GET', '/v1/traders/risk?as=sita')
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.trader, 'ravi')
    const mine: string[] = (await w.asA('GET', '/v1/traders/books')).body.map((b: BookSummary) => b.stock)
    assert.deepEqual(r.body.books.map((x: { stock: string }) => x.stock), mine)
    assert.deepEqual(r.body.correlation.stocks, mine)
    assert.ok(mine.includes('TCS') && !mine.includes('JINDALSTEL'), JSON.stringify(mine))
    noOther(r.body)
    // an admin: every held stock repriced together without `?as=` (no trader named), B's with it; a watcher token never
    const all = await w.asAdmin('GET', '/v1/traders/risk')
    assert.equal(all.status, 200, JSON.stringify(all.body))
    assert.equal(all.body.trader, null)
    for (const s of ['JINDALSTEL', 'TCS']) assert.ok(all.body.books.some((x: { stock: string }) => x.stock === s), s)
    assert.equal(JSON.stringify(all.body).includes('sita') || JSON.stringify(all.body).includes('ravi'), false)
    const theirs: string[] = (await w.asAdmin('GET', '/v1/traders/books?as=sita')).body.map((b: BookSummary) => b.stock)
    const b = await w.asAdmin('GET', '/v1/traders/risk?as=sita')
    assert.deepEqual([b.body.trader, b.body.books.map((x: { stock: string }) => x.stock)], ['sita', theirs])
    assert.ok(theirs.includes('JINDALSTEL'), JSON.stringify(theirs))
    own(await w.watcherA('GET', '/v1/traders/risk'))
  },
  'events.view': async (w) => {
    // `?as=` is ignored for a trader: a row per A's own open book only (no calendar in the walk: by stock), and no trader named but A
    const r = await w.asA('GET', '/v1/traders/events?as=sita')
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.trader, 'ravi')
    const mine: string[] = (await w.asA('GET', '/v1/traders/books')).body.map((b: BookSummary) => b.stock)
    assert.deepEqual(r.body.rows.map((x: { stock: string }) => x.stock), [...mine].sort())
    assert.ok(mine.includes('TCS') && !mine.includes('JINDALSTEL'), JSON.stringify(mine))
    noOther(r.body)
    // an admin: every held stock without `?as=` (each stock's books together, naming no one), B's with it; a watcher token never
    const all = await w.asAdmin('GET', '/v1/traders/events')
    assert.equal(all.body.trader, null)
    for (const s of ['JINDALSTEL', 'TCS']) assert.ok(all.body.rows.some((x: { stock: string }) => x.stock === s), s)
    assert.equal(JSON.stringify(all.body).includes('sita') || JSON.stringify(all.body).includes('ravi'), false)
    const theirs: string[] = (await w.asAdmin('GET', '/v1/traders/books?as=sita')).body.map((b: BookSummary) => b.stock)
    const b = await w.asAdmin('GET', '/v1/traders/events?as=sita')
    assert.deepEqual([b.body.trader, b.body.rows.map((x: { stock: string }) => x.stock)], ['sita', [...theirs].sort()])
    assert.ok(theirs.includes('JINDALSTEL'), JSON.stringify(theirs))
    own(await w.watcherA('GET', '/v1/traders/events'))
  },
  'daily.list': async (w) => {
    // `?as=` and `?trader=` are ignored for a trader: A's own record (empty), though B has a row on b.day
    assert.equal((await w.rows('traders-daily', 'sita')).length, 1)
    const r = await w.asA('GET', '/v1/traders/daily?as=sita&trader=sita')
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.deepEqual([r.body.trader, r.body.days, r.body.recordedFrom], ['ravi', [], null])
    noOther(r.body)
    // an admin names B and sees B's row; a watcher token never
    const b = await w.asAdmin('GET', '/v1/traders/daily?trader=sita')
    assert.deepEqual(b.body.days.map((d: { day: string }) => d.day), [w.b.day])
    assert.equal((await w.asAdmin('GET', '/v1/traders/daily?trader=sita&as=ravi')).body.trader, 'sita')
    own(await w.watcherA('GET', '/v1/traders/daily'))
  },
  'admin.data-status': async (w) => {
    const all = await w.asAdmin('GET', '/v1/traders/admin/data-status')
    assert.equal(all.status, 200, JSON.stringify(all.body))
    assert.deepEqual(all.body.traders.map((t: { trader: string }) => t.trader), ['ravi', 'sita'])
    await adminDoor(w, 'GET', '/v1/traders/admin/data-status', undefined, async () => 0)
    noOther((await w.asA('GET', '/v1/traders/admin/data-status')).body)
  },
  'booked.view': async (w) => {
    // `?as=` and `?trader=` are ignored for a trader: A's own rows only (its manual share legs), none of B's JINDALSTEL
    const mine: string[] = (await w.asA('GET', '/v1/traders/books')).body.map((b: BookSummary) => b.stock).sort()
    assert.ok(mine.includes('TCS') && !mine.includes('JINDALSTEL'), JSON.stringify(mine))
    for (const q of ['as=sita', 'trader=sita']) {
      const r = await w.asA('GET', `/v1/traders/booked?${q}`)
      assert.equal(r.status, 200, JSON.stringify(r.body))
      assert.equal(r.body.trader, 'ravi')
      assert.deepEqual([...new Set(r.body.rows.map((x: { stock: string }) => x.stock))].sort(), mine)
      noOther(r.body)
    }
    // an admin names B either way and gets B's: the JINDALSTEL trades B's watcher sent; naming nobody is refused
    for (const q of ['as=sita', 'trader=sita']) {
      const b = await w.asAdmin('GET', `/v1/traders/booked?${q}`)
      assert.equal(b.status, 200, JSON.stringify(b.body))
      assert.equal(b.body.trader, 'sita')
      assert.ok(b.body.rows.some((x: { stock: string }) => x.stock === 'JINDALSTEL'), JSON.stringify(b.body.rows))
    }
    assert.equal((await w.asAdmin('GET', '/v1/traders/booked')).status, 400)
    assert.equal((await w.asAdmin('GET', '/v1/traders/booked?trader=boss')).status, 404)
    own(await w.watcherA('GET', '/v1/traders/booked'))
  },
  'admin.booked': async (w) => {
    const all = await w.asAdmin('GET', '/v1/traders/admin/booked')
    assert.equal(all.status, 200, JSON.stringify(all.body))
    assert.deepEqual(all.body.traders.map((t: { trader: string }) => t.trader), ['ravi', 'sita'])
    await adminDoor(w, 'GET', '/v1/traders/admin/booked', undefined, async () => 0)
    noOther((await w.asA('GET', '/v1/traders/admin/booked')).body)
  },
  // phone alerts (gaps G7): a user's own phones only, whoever `?as=` names; the bell's alerts by owner
  'push.key': async (w) => {
    const r = await w.asA('GET', '/v1/traders/push/key?as=sita')
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.deepEqual(Object.keys(r.body), ['publicKey'])
    assert.deepEqual((await w.asAdmin('GET', '/v1/traders/push/key')).body, r.body, 'one key for everyone: nothing in it is a trader\'s')
    own(await w.watcherA('GET', '/v1/traders/push/key'))
  },
  'push.subscribe': async (w) => {
    const theirs = await w.rows('traders-push', 'sita')
    assert.equal(theirs.length, 1, 'B has its phone (the walk\'s setup)')
    const r = await w.asA('POST', '/v1/traders/push/subscribe?as=sita', PHONE_A)
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.deepEqual((await w.rows('traders-push', 'ravi')).map((x) => x['endpoint']), [PHONE_A.endpoint])
    assert.deepEqual(await w.rows('traders-push', 'sita'), theirs, 'B untouched')
    own(await w.watcherA('POST', '/v1/traders/push/subscribe', PHONE_A))
  },
  'push.unsubscribe': async (w) => {
    const r = await w.asA('POST', '/v1/traders/push/unsubscribe?as=sita', { endpoint: PHONE_B.endpoint })
    assert.deepEqual([r.status, r.body], [200, { removed: false }])
    assert.deepEqual((await w.rows('traders-push', 'sita')).map((x) => x['endpoint']), [PHONE_B.endpoint])
    own(await w.watcherB('POST', '/v1/traders/push/unsubscribe', { endpoint: PHONE_B.endpoint }))
  },
  'push.test': async (w) => {
    const theirs = await w.rows('traders-push', 'sita')
    const r = await w.asA('POST', '/v1/traders/push/test?as=sita', {})
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.deepEqual(r.body, { sent: 1, phones: 1 }, 'A\'s one phone (push.subscribe), not B\'s')
    assert.deepEqual(await w.rows('traders-push', 'sita'), theirs, 'B\'s phone was not sent to (its lastOkAt is unchanged)')
  },
  'alerts.list': async (w) => {
    const r = await w.asA('GET', '/v1/traders/alerts?since=0&as=sita')
    assert.equal(r.status, 200, JSON.stringify(r.body))
    noOther(r.body)
    assert.equal(r.body.some((a: { admin: boolean }) => a.admin), false, 'a trader never sees the admin-wide alerts')
    // an admin picking B: B's own and the admin-wide (B's ODIN orders file holds a rejection, alerted as it landed)
    const b = await w.asAdmin('GET', '/v1/traders/alerts?since=0&as=sita')
    const seen = b.body.map((a: { title: string; admin: boolean }) => JSON.stringify([a.title, a.admin]))
    for (const x of [['Watcher offline: sita', true], ['sita alert', false]]) assert.ok(seen.includes(JSON.stringify(x)), `${JSON.stringify(x)} in ${seen}`)
    own(await w.watcherA('GET', '/v1/traders/alerts'))
  },
}
