import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  hashPassword,
  verifyPassword,
  storedAlgorithm,
  DEFAULT_ALGORITHM,
} from '../src/index.ts'

const PW = 'correct horse battery staple'

test('the default algorithm is argon2id and the stored string says so', async () => {
  assert.equal(DEFAULT_ALGORITHM, 'argon2id')
  const stored = await hashPassword(PW)
  assert.ok(
    stored.startsWith('$argon2id$v=19$m=19456,t=2,p=1$'),
    `unexpected stored format: ${stored}`,
  )
  assert.equal(storedAlgorithm(stored), 'argon2id')
  // algorithm + version + params + salt + digest, all self-describing.
  assert.equal(stored.split('$').length, 6)
})

test('hash/verify round-trips', async () => {
  const stored = await hashPassword(PW)
  assert.equal(await verifyPassword(PW, stored), true)
})

test('the wrong password fails', async () => {
  const stored = await hashPassword(PW)
  assert.equal(await verifyPassword('correct horse battery stapl', stored), false)
  assert.equal(await verifyPassword('', stored), false)
  assert.equal(await verifyPassword(PW + ' ', stored), false)
})

test('the same password hashes differently twice — the salt is random', async () => {
  const a = await hashPassword(PW)
  const b = await hashPassword(PW)
  assert.notEqual(a, b)
  // Specifically the salt AND digest differ, not just some serialisation nonce.
  assert.notEqual(a.split('$')[4], b.split('$')[4], 'salts must differ')
  assert.notEqual(a.split('$')[5], b.split('$')[5], 'digests must differ')
  // Both still verify: the salt travels with the hash.
  assert.equal(await verifyPassword(PW, a), true)
  assert.equal(await verifyPassword(PW, b), true)
})

test('a corrupted stored hash resolves false instead of throwing', async () => {
  const stored = await hashPassword(PW)
  const parts = stored.split('$')
  const corrupted = [
    '',
    'not a phc string at all',
    '$argon2id$',
    // truncated digest
    stored.slice(0, stored.length - 8),
    // unknown algorithm
    stored.replace('$argon2id$', '$bcrypt$'),
    // unknown argon2 version
    stored.replace('v=19', 'v=16'),
    // non-integer cost parameter
    stored.replace('t=2', 't=x'),
    // missing a field
    `$argon2id$v=19$m=19456,t=2,p=1$${parts[4]}`,
    // salt is not valid base64url
    `$argon2id$v=19$m=19456,t=2,p=1$!!!!$${parts[5]}`,
    // empty digest
    `$argon2id$v=19$m=19456,t=2,p=1$${parts[4]}$`,
    // digest tampered with, same length and still valid base64url
    `$argon2id$v=19$m=19456,t=2,p=1$${parts[4]}$${(parts[5] ?? '').replace(/^./, (c) => (c === 'A' ? 'B' : 'A'))}`,
    // salt swapped for another valid one: the digest no longer belongs to it
    `$argon2id$v=19$m=19456,t=2,p=1$${(await hashPassword(PW)).split('$')[4]}$${parts[5]}`,
    // scrypt row asking for absurd memory — must be refused, not attempted
    '$scrypt$ln=40,r=8,p=1$c2FsdHNhbHRzYWx0c2E$ZGlnZXN0',
  ]
  for (const bad of corrupted) {
    const ok = await verifyPassword(PW, bad)
    assert.equal(ok, false, `expected false for ${JSON.stringify(bad)}`)
  }
})

test('scrypt hashes verify too, so the format is genuinely migratable', async () => {
  // Cheap parameters: this test is exercising the format branch, not the cost.
  const stored = await hashPassword(PW, {
    algorithm: 'scrypt',
    scrypt: { logN: 12, r: 8, p: 1, tagLength: 32 },
  })
  assert.ok(stored.startsWith('$scrypt$ln=12,r=8,p=1$'), `unexpected stored format: ${stored}`)
  assert.equal(storedAlgorithm(stored), 'scrypt')
  assert.equal(await verifyPassword(PW, stored), true)
  assert.equal(await verifyPassword('wrong', stored), false)

  // An argon2id hash and a scrypt hash coexist: verify dispatches on the string.
  const argonStored = await hashPassword(PW)
  assert.equal(await verifyPassword(PW, argonStored), true)
  assert.notEqual(storedAlgorithm(argonStored), storedAlgorithm(stored))
})

test('raised cost does not invalidate hashes made at the old cost', async () => {
  const old = await hashPassword(PW, {
    algorithm: 'argon2id',
    argon2: { memory: 8192, passes: 1, parallelism: 1, tagLength: 32 },
  })
  assert.ok(old.includes('m=8192,t=1,p=1'))
  // Verified under the parameters stored WITH it, not today's defaults.
  assert.equal(await verifyPassword(PW, old), true)
  assert.equal(await verifyPassword('wrong', old), false)
})

test('storedAlgorithm reports null for an unreadable record', () => {
  assert.equal(storedAlgorithm('garbage'), null)
  assert.equal(storedAlgorithm(''), null)
})
