/**
 * F-46 — the XTS session token at rest.
 *
 * `desk-broker-session` holds the bearer that PLACES ORDERS, and it held it in
 * plaintext while the credentials that mint it were sealed (audit F-46). The
 * properties this file pins are the ones a migration on a live box turns on:
 *
 *   - a write seals, and the identifiers beside it stay readable;
 *   - a legacy PLAINTEXT doc still boots the session, once, and is sealed by the
 *     very next write — there is no manual migration step and no window where
 *     the gateway refuses to log in;
 *   - a value that will not open (rotated key, wrong key, no key) reads as NO
 *     SESSION, loudly — never as a throw out of the only process that can place
 *     orders, and never as a token handed to XTS that XTS will reject;
 *   - the TTL field is a `Date`. Mongo's TTL monitor ignores a numeric one
 *     entirely (`pnlstore.ts:249` — Mongo brackets by BSON TYPE first), so a
 *     `{updatedAt: 1}` TTL index over the existing epoch-millis field would be
 *     an expiry that silently never happens.
 *
 * The real `@algomaker/secrets` is used throughout — a fake seal would prove the
 * wiring and nothing about whether the bytes on disk are readable.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MASTER_KEY_MISMATCH, open, seal } from '@algomaker/secrets'
import {
  SESSION_TTL_INDEX,
  SESSION_TTL_SECONDS,
  ensureSessionTtlIndex,
  openSessionDoc,
  readSessionTokenField,
  resetLegacyPlaintextNotice,
  sessionMasterKey,
  sessionTokenUpdate,
} from '../src/session-store.ts'

const KEY = Buffer.alloc(32, 7)
const OTHER_KEY = Buffer.alloc(32, 9)
/** Shaped like the real thing — long, opaque, and never printed. */
const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.xts-live-bearer-do-not-log.9f2c'

const collect = (): { log: (m: string, c?: Record<string, unknown>) => void; lines: string[] } => {
  const lines: string[] = []
  return {
    lines,
    log: (m, c) => void lines.push(`${m} ${c === undefined ? '' : JSON.stringify(c)}`),
  }
}

// ------------------------------------------------------------------ writing

test('the write seals the token and leaves the identifiers readable', () => {
  const set = sessionTokenUpdate(
    { token: TOKEN, userID: 'U1', clientCodes: ['C1', 'C2'] },
    KEY,
    1_700_000_000_000,
  )
  assert.notEqual(set['token'], TOKEN, 'the bearer must not be written as-is')
  assert.match(String(set['token']), /^v1\./)
  assert.equal(open(String(set['token']), KEY), TOKEN)
  // Identifiers, not secrets: the dashboard and every operator query read them.
  assert.equal(set['userID'], 'U1')
  assert.deepEqual(set['clientCodes'], ['C1', 'C2'])
})

test('the TTL stamp is a Date, beside — not instead of — the numeric one', () => {
  const at = 1_700_000_000_000
  const set = sessionTokenUpdate({ token: TOKEN, userID: 'U1', clientCodes: ['C1'] }, KEY, at)
  // `updatedAt` stays a number: `routes/system.ts` and `broker-snapshot.ts` read
  // it as epoch millis, and a type change there is a silently broken read.
  assert.equal(set['updatedAt'], at)
  assert.ok(set['updatedAtDate'] instanceof Date, 'a numeric TTL field is never expired by Mongo')
  assert.equal((set['updatedAtDate'] as Date).getTime(), at)
})

test('with no master key the write stays plaintext rather than failing', () => {
  // The gateway is the only process that can place orders; refusing to persist a
  // session because a key is missing would be a self-inflicted outage.
  const set = sessionTokenUpdate({ token: TOKEN, userID: 'U1', clientCodes: ['C1'] }, null, 1)
  assert.equal(set['token'], TOKEN)
})

// ------------------------------------------------------------------ reading

test('a sealed token opens', () => {
  const read = readSessionTokenField(seal(TOKEN, KEY), KEY)
  assert.deepEqual(read, { kind: 'ok', token: TOKEN, sealed: true })
})

test('a LEGACY plaintext token is used, and says it was not sealed', () => {
  // This is the migration: the doc on the box right now is plaintext, and the
  // gateway must boot on it exactly as it does today.
  const read = readSessionTokenField(TOKEN, KEY)
  assert.deepEqual(read, { kind: 'ok', token: TOKEN, sealed: false })
})

test('a sealed token under the WRONG key is unreadable, not absent and not garbage', () => {
  const read = readSessionTokenField(seal(TOKEN, OTHER_KEY), KEY)
  assert.equal(read.kind, 'unreadable')
  assert.match(read.kind === 'unreadable' ? read.reason : '', /DESK_MASTER_KEY/)
})

test('a sealed token with no key at all is unreadable', () => {
  const read = readSessionTokenField(seal(TOKEN, KEY), null)
  assert.equal(read.kind, 'unreadable')
  assert.match(read.kind === 'unreadable' ? read.reason : '', /DESK_MASTER_KEY/)
})

test('a missing or empty token is absent', () => {
  assert.deepEqual(readSessionTokenField(undefined, KEY), { kind: 'absent' })
  assert.deepEqual(readSessionTokenField('', KEY), { kind: 'absent' })
  assert.deepEqual(readSessionTokenField(null, KEY), { kind: 'absent' })
  assert.deepEqual(readSessionTokenField(42, KEY), { kind: 'absent' })
})

// -------------------------------------------------------------- the whole doc

test('a sealed doc opens into the record the session is rebuilt from', () => {
  const doc = {
    _id: 'xts',
    token: seal(TOKEN, KEY),
    userID: 'U1',
    clientCodes: ['C1'],
    updatedAt: 1,
  }
  const { log, lines } = collect()
  assert.deepEqual(openSessionDoc(doc, KEY, log), {
    token: TOKEN,
    userID: 'U1',
    clientCodes: ['C1'],
  })
  assert.deepEqual(lines, [], 'a healthy read is not news')
})

test('a legacy plaintext doc still boots the socket, and says so once', () => {
  resetLegacyPlaintextNotice()
  const doc = { _id: 'xts', token: TOKEN, userID: 'U1', clientCodes: ['C1'], updatedAt: 1 }
  const { log, lines } = collect()
  const rec = openSessionDoc(doc, KEY, log)
  assert.equal(rec?.token, TOKEN)
  assert.match(lines.join('\n'), /plaintext/i)
  assert.ok(
    !lines.join('\n').includes(TOKEN),
    'the migration notice must not print the bearer it is migrating',
  )
})

test('the LEGACY PLAINTEXT notice is said ONCE PER BOOT, not once per read', () => {
  /**
   * The gateway opens this document twice on the way up — `buildSession`'s
   * `read` and the order-socket wiring below it (`main.ts:756` and `:1016`) —
   * and the snapshot loop's re-login opens it again later. The comment beside
   * the line has always claimed "said once per boot"; the code said it every
   * time, so a migration notice that means "nothing is wrong" arrived twice at
   * boot and again on every relogin, which is how a benign line trains an
   * operator to ignore the log.
   */
  resetLegacyPlaintextNotice()
  const doc = { _id: 'xts', token: TOKEN, userID: 'U1', clientCodes: ['C1'], updatedAt: 1 }
  const { log, lines } = collect()
  for (let i = 0; i < 5; i++) assert.equal(openSessionDoc(doc, KEY, log)?.token, TOKEN)
  assert.equal(
    lines.filter((l) => /LEGACY PLAINTEXT/.test(l)).length,
    1,
    `said ${lines.length} times: ${lines.join(' | ')}`,
  )
})

test('memoising the notice never silences the UNREADABLE line', () => {
  // The two are different news. "Plaintext" means the migration is happening;
  // "will not open" means a fresh login every time and a key somebody must look
  // at, and it has to be visible on the read that hit it.
  resetLegacyPlaintextNotice()
  const plain = { _id: 'xts', token: TOKEN, userID: 'U1', clientCodes: ['C1'] }
  const bad = { _id: 'xts', token: seal(TOKEN, OTHER_KEY), userID: 'U1', clientCodes: ['C1'] }
  const { log, lines } = collect()
  openSessionDoc(plain, KEY, log)
  openSessionDoc(bad, KEY, log)
  openSessionDoc(bad, KEY, log)
  assert.equal(lines.filter((l) => /LEGACY PLAINTEXT/.test(l)).length, 1)
  assert.equal(lines.filter((l) => /UNREADABLE/.test(l)).length, 2)
})

test('an unopenable doc reads as NO SESSION, loudly, and does not throw', () => {
  const doc = { _id: 'xts', token: seal(TOKEN, OTHER_KEY), userID: 'U1', clientCodes: ['C1'] }
  const { log, lines } = collect()
  const rec = openSessionDoc(doc, KEY, log)
  assert.equal(rec, null, 'a fresh login is the only correct answer here')
  assert.match(lines.join('\n'), /DESK_MASTER_KEY/)
  assert.match(lines.join('\n'), /fresh login|logging in fresh/i)
})

test('a null doc is simply no session', () => {
  const { log, lines } = collect()
  assert.equal(openSessionDoc(null, KEY, log), null)
  assert.deepEqual(lines, [])
})

test('nothing on the read path ever prints the token', () => {
  const { log, lines } = collect()
  for (const value of [TOKEN, seal(TOKEN, KEY), seal(TOKEN, OTHER_KEY)]) {
    openSessionDoc({ token: value, userID: 'U1', clientCodes: ['C1'] }, KEY, log)
  }
  const all = lines.join('\n')
  assert.ok(!all.includes(TOKEN), 'plaintext bearer in a log line')
  assert.ok(!all.includes('v1.'), 'ciphertext in a log line is still the credential')
})

// -------------------------------------------------------------- the TTL index

test('the TTL index is built on the Date field, at seven days', async () => {
  const calls: { spec: Record<string, 1 | -1>; options?: Record<string, unknown> }[] = []
  const { log } = collect()
  const ok = await ensureSessionTtlIndex(
    { createIndex: async (spec, options) => void calls.push({ spec, ...(options === undefined ? {} : { options }) }) },
    log,
  )
  assert.equal(ok, true)
  assert.deepEqual(calls[0]?.spec, { updatedAtDate: 1 })
  assert.equal(calls[0]?.options?.['expireAfterSeconds'], SESSION_TTL_SECONDS)
  assert.equal(SESSION_TTL_SECONDS, 7 * 24 * 60 * 60)
  assert.equal(calls[0]?.options?.['name'], SESSION_TTL_INDEX)
})

test('an index Mongo refuses is LOGGED, and the gateway boots anyway', async () => {
  // F-42's boot-safety rule: an index is a guard against the next problem, never
  // a reason to stop the only process that can place orders from starting.
  const { log, lines } = collect()
  const ok = await ensureSessionTtlIndex(
    {
      createIndex: async () => {
        throw Object.assign(new Error('Index already exists with a different name'), { code: 85 })
      },
    },
    log,
  )
  assert.equal(ok, false)
  assert.match(lines.join('\n'), /TTL/i)
  assert.match(lines.join('\n'), /different name/)
})

// ------------------------------------------------------------------- the key

test('the key comes from the SAME derivation the broker store uses', () => {
  const { log, lines } = collect()
  const key = sessionMasterKey({ DESK_MASTER_KEY: KEY.toString('hex') }, log)
  assert.ok(key !== null)
  assert.equal(open(seal('x', key), KEY), 'x', 'one key must serve every sealed value on the desk')
  assert.deepEqual(lines, [])
})

test('a missing key degrades to plaintext with a LOUD line, not a crash', () => {
  const { log, lines } = collect()
  assert.equal(sessionMasterKey({}, log), null)
  assert.match(lines.join('\n'), /DESK_MASTER_KEY/)
  assert.match(lines.join('\n'), /plaintext/i)
  // The wording is `@algomaker/secrets`'s, not this module's: the cookie jar
  // and the broker store say the same sentence about the same key.
  assert.match(
    lines.join('\n'),
    /DESK_MASTER_KEY is missing or malformed — the XTS session token will be stored in PLAINTEXT/,
  )
})

test('"will not open" is the desk-wide sentence, not a gateway-local paraphrase', () => {
  const read = readSessionTokenField(seal(TOKEN, OTHER_KEY), KEY)
  assert.equal(read.kind, 'unreadable')
  assert.ok(
    (read.kind === 'unreadable' ? read.reason : '').includes(MASTER_KEY_MISMATCH),
    'one grep must find the broker store, the cookie jar and this',
  )
})
