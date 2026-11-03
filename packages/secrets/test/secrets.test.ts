import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import {
  seal,
  open,
  keyFromEnvValue,
  isSealed,
  optionalMasterKey,
  MASTER_KEY_MISMATCH,
  SecretKeyError,
  SecretOpenError,
} from '../src/index.ts'

const KEY = Buffer.alloc(32, 7)
const OTHER_KEY = Buffer.alloc(32, 9)

/** Rebuild a sealed string after mutating its decoded bytes. */
const remap = (sealed: string, f: (raw: Buffer) => Buffer): string => {
  const [prefix, b64] = sealed.split('.')
  return `${prefix}.${f(Buffer.from(b64 ?? '', 'base64')).toString('base64')}`
}

test('seal/open round-trips a credential blob', () => {
  const secret = JSON.stringify({ apiKey: 'abc123', apiSecret: 'p@ss:word/with+base64ish=chars' })
  assert.equal(open(seal(secret, KEY), KEY), secret)
})

test('round-trips unicode and an empty string', () => {
  assert.equal(open(seal('', KEY), KEY), '')
  const s = 'पासवर्ड — ₹1,50,000 🔐'
  assert.equal(open(seal(s, KEY), KEY), s)
})

test('sealing the same value twice gives different ciphertext', () => {
  const a = seal('same-password', KEY)
  const b = seal('same-password', KEY)
  assert.notEqual(a, b, 'random IV must make repeat seals differ')
  // ...and both still open. A random IV is only useful if it travels along.
  assert.equal(open(a, KEY), 'same-password')
  assert.equal(open(b, KEY), 'same-password')
})

test('a tampered ciphertext fails to open instead of decrypting to garbage', () => {
  const sealed = seal('XTS-live-password', KEY)
  // Flip one bit in the ciphertext body (past the 12-byte IV and 16-byte tag).
  const tampered = remap(sealed, (raw) => {
    const copy = Buffer.from(raw)
    copy[28] = (copy[28] ?? 0) ^ 0x01
    return copy
  })
  assert.notEqual(tampered, sealed)
  assert.throws(
    () => open(tampered, KEY),
    (e: unknown) => e instanceof SecretOpenError && e.reason === 'auth',
  )
})

test('a tampered IV or auth tag fails to open', () => {
  const sealed = seal('XTS-live-password', KEY)
  for (const at of [0, 12]) {
    const t = remap(sealed, (raw) => {
      const copy = Buffer.from(raw)
      copy[at] = (copy[at] ?? 0) ^ 0xff
      return copy
    })
    assert.throws(() => open(t, KEY), SecretOpenError, `mutation at byte ${at} must be rejected`)
  }
})

test('the wrong key is rejected, not silently wrong', () => {
  const sealed = seal('XTS-live-password', KEY)
  assert.throws(
    () => open(sealed, OTHER_KEY),
    (e: unknown) => e instanceof SecretOpenError && e.reason === 'auth',
  )
})

test('a truncated or non-sealed string is malformed, which is distinguishable from a bad key', () => {
  const sealed = seal('XTS-live-password', KEY)
  const cases = ['', 'not-sealed-at-all', sealed.slice(4), `v1.${'!'.repeat(40)}`, 'v1.YWJj']
  for (const c of cases) {
    assert.throws(
      () => open(c, KEY),
      (e: unknown) => e instanceof SecretOpenError && e.reason === 'malformed',
      `expected malformed for ${JSON.stringify(c)}`,
    )
  }
  // The version prefix is authenticated, so relabelling a v1 blob is not an
  // "unreadable field" — it is a rejected one, either way.
  assert.throws(() => open(`v2.${sealed.slice(3)}`, KEY), SecretOpenError)
})

test('a key that is not exactly 32 bytes is refused, never padded or truncated', () => {
  for (const n of [0, 16, 31, 33, 64]) {
    assert.throws(() => seal('x', Buffer.alloc(n, 1)), SecretKeyError, `${n}-byte key must refuse`)
    assert.throws(() => open(seal('x', KEY), Buffer.alloc(n, 1)), SecretKeyError)
  }
})

test('keyFromEnvValue accepts hex and base64, and only 32 bytes of either', () => {
  const raw = randomBytes(32)
  assert.deepEqual(keyFromEnvValue(raw.toString('hex')), raw)
  assert.deepEqual(keyFromEnvValue(raw.toString('base64')), raw)
  assert.deepEqual(keyFromEnvValue(raw.toString('base64url')), raw)
  // A stray newline from a .env file or a `docker secret` mount is not a failure.
  assert.deepEqual(keyFromEnvValue(`  ${raw.toString('base64')}\n`), raw)

  for (const bad of [
    '',
    '   ',
    'hunter2',
    randomBytes(16).toString('hex'),
    randomBytes(31).toString('base64'),
    randomBytes(48).toString('base64'),
    `${raw.toString('hex')}ff`,
  ]) {
    assert.throws(() => keyFromEnvValue(bad), SecretKeyError, `expected refusal for ${bad}`)
  }
})

test('a key from env opens what the same key sealed', () => {
  const env = randomBytes(32).toString('base64')
  const sealed = seal('round-trip-through-env', keyFromEnvValue(env))
  assert.equal(open(sealed, keyFromEnvValue(env)), 'round-trip-through-env')
})

// ------------------------------------------- the shared sealing machinery
//
// Three apps had grown their own copy of this: the order gateway spelled the
// `v1.` magic itself, and the gateway, the cookie jar and the broker store each
// worded "no key, so this is plaintext" and "this will not open" differently.
// An operator greps `pm2 logs` for ONE sentence, not three near-misses.

const collect = (): { log: (m: string, c?: Record<string, unknown>) => void; lines: string[] } => {
  const lines: string[] = []
  return {
    lines,
    log: (m, c) => void lines.push(`${m} ${c === undefined ? '' : JSON.stringify(c)}`),
  }
}

test('isSealed owns the v1 magic, so no caller has to spell it', () => {
  assert.equal(isSealed(seal('anything', KEY)), true)
  // Shape only — `open` is what decides whether the bytes are any good. The
  // point of the discriminator is that a value CLAIMING to be sealed is never
  // fallen through to and used as a credential.
  assert.equal(isSealed('v1.this-will-not-open'), true)
  assert.equal(isSealed('eyJhbGciOiJIUzI1NiJ9.legacy-plaintext-bearer'), false)
  assert.equal(isSealed('v2.something-later'), false)
  for (const v of ['', undefined, null, 42, {}, ['v1.x']]) assert.equal(isSealed(v), false)
})

test('optionalMasterKey hands back the key, and says nothing, when the env has one', () => {
  const { log, lines } = collect()
  const key = optionalMasterKey({ DESK_MASTER_KEY: KEY.toString('hex') }, log, 'the XTS session')
  assert.ok(key !== null)
  assert.equal(open(seal('x', key), KEY), 'x', 'one key must serve every sealed value on the desk')
  assert.deepEqual(lines, [], 'a key that is present is not news')
})

test('a missing or malformed key degrades to plaintext with ONE canonical sentence', () => {
  // Same wording for every subject: the greppable core is single-sourced here,
  // and only the noun differs.
  const jar = collect()
  const session = collect()
  assert.equal(
    optionalMasterKey({}, jar.log, 'the Zerodha cookie jar (which holds the ENCTOKEN)'),
    null,
  )
  assert.equal(
    optionalMasterKey({ DESK_MASTER_KEY: 'hunter2' }, session.log, 'the XTS session token'),
    null,
  )
  for (const { lines } of [jar, session]) {
    assert.equal(lines.length, 1)
    assert.match(
      lines[0] as string,
      /DESK_MASTER_KEY is missing or malformed — .+ will be stored in PLAINTEXT/,
    )
    assert.match(lines[0] as string, /openssl rand -hex 32/, 'say how to fix it, not just what broke')
  }
  assert.match(jar.lines[0] as string, /ENCTOKEN/, 'the subject-specific noun still travels')
  assert.match(session.lines[0] as string, /XTS session token/)
  // The malformed case carries WHY the key was refused, in the ctx.
  assert.match(session.lines[0] as string, /master key must/)
})

test('the "will not open" reason is one constant, not three near-identical sentences', () => {
  // `brokerstore.describeOpenFailure`, `session-store.readSessionTokenField` and
  // `zerodha-native.decodeJarFile` all build their message from this.
  assert.equal(MASTER_KEY_MISMATCH, 'will not decrypt with the current DESK_MASTER_KEY')
})
