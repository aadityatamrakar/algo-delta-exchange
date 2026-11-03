import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadXtsConfig, positiveEnvMs } from '../src/main.ts'

/**
 * Phase A §6: the BROKER STORE with env as the fallback.
 *
 * This process read env only, so credentials entered on the portal's Brokers
 * page changed nothing about how the gateway logged in — the form was a form
 * over nothing. And `XTS_CLIENT_ID` did not exist at all in any source, which is
 * the configuration half of G5.
 */

const store = (
  secret: Record<string, unknown> = {},
  meta: Record<string, unknown> = {},
) => async () => ({ secret, meta })

const quiet = (): void => {}

test('the broker store supplies the credentials when it has them', async () => {
  const cfg = await loadXtsConfig(
    store({ baseUrl: 'https://portal.example.com', appKey: 'PK', secretKey: 'PS' }),
    {},
    quiet,
  )
  assert.equal(cfg.baseUrl, 'https://portal.example.com')
  assert.equal(cfg.appKey, 'PK')
  assert.equal(cfg.source, 'broker-store')
})

test('the store WINS over the environment', async () => {
  // The store is the operator's most recent deliberate act; env is what the
  // machine happened to be started with, possibly months ago.
  const cfg = await loadXtsConfig(
    store({ baseUrl: 'https://portal.example.com', appKey: 'PK', secretKey: 'PS' }),
    { XTS_BASE_URL: 'https://env.example.com', XTS_APP_KEY: 'EK', XTS_SECRET_KEY: 'ES' },
    quiet,
  )
  assert.equal(cfg.baseUrl, 'https://portal.example.com')
  assert.equal(cfg.appKey, 'PK')
})

test('env fills in anything the store does not have', async () => {
  const cfg = await loadXtsConfig(
    store({ appKey: 'PK' }),
    { XTS_BASE_URL: 'https://env.example.com', XTS_SECRET_KEY: 'ES' },
    quiet,
  )
  assert.equal(cfg.appKey, 'PK')
  assert.equal(cfg.baseUrl, 'https://env.example.com')
  assert.equal(cfg.source, 'mixed')
})

test('with no store at all it runs entirely on env', async () => {
  const cfg = await loadXtsConfig(
    store(),
    { XTS_BASE_URL: 'https://env.example.com', XTS_APP_KEY: 'EK', XTS_SECRET_KEY: 'ES' },
    quiet,
  )
  assert.equal(cfg.source, 'env')
  assert.equal(cfg.clientId, undefined, 'unset means "use whatever the login returns"')
})

test('XTS_CLIENT_ID is read from the environment', async () => {
  const cfg = await loadXtsConfig(
    store(),
    {
      XTS_BASE_URL: 'https://env.example.com',
      XTS_APP_KEY: 'EK',
      XTS_SECRET_KEY: 'ES',
      XTS_CLIENT_ID: '*****',
    },
    quiet,
  )
  assert.equal(cfg.clientId, '*****')
})

test('the client code can come from the store META, which is not a secret', async () => {
  const cfg = await loadXtsConfig(
    store({ baseUrl: 'https://p', appKey: 'PK', secretKey: 'PS' }, { clientId: 'DEALER01' }),
    { XTS_CLIENT_ID: 'ENVCODE' },
    quiet,
  )
  assert.equal(cfg.clientId, 'DEALER01', 'the portal value wins over the env one')
})

test('an explicit investor flag is parsed; anything unparseable is ignored', async () => {
  const base = { XTS_BASE_URL: 'https://e', XTS_APP_KEY: 'K', XTS_SECRET_KEY: 'S' }
  assert.equal((await loadXtsConfig(store(), base, quiet)).investorClient, undefined)
  assert.equal(
    (await loadXtsConfig(store(), { ...base, XTS_INVESTOR_CLIENT: 'false' }, quiet)).investorClient,
    false,
  )
  assert.equal(
    (await loadXtsConfig(store(), { ...base, XTS_INVESTOR_CLIENT: 'true' }, quiet)).investorClient,
    true,
  )
})

test('missing credentials name what is missing, in BOTH vocabularies', async () => {
  // The operator has two places to look and the error has to point at both.
  await assert.rejects(
    () => loadXtsConfig(store(), {}, quiet),
    /baseUrl\/XTS_BASE_URL.*appKey\/XTS_APP_KEY.*secretKey\/XTS_SECRET_KEY/s,
  )
})

test('a blank env var counts as absent, not as an empty credential', async () => {
  await assert.rejects(
    () =>
      loadXtsConfig(
        store({ appKey: 'K', secretKey: 'S' }),
        { XTS_BASE_URL: '   ' },
        quiet,
      ),
    /baseUrl\/XTS_BASE_URL/,
  )
})

/**
 * The SWEEP KNOBS, which are read straight off the environment on the only
 * process that places orders.
 *
 * `Number('10m')` is `NaN`, and NaN is not loud — it is silent and wrong in two
 * different directions here:
 *
 *   - `now - placedAt <= NaN` is FALSE, so a traceless ambiguous tranche is
 *     declared "never placed" on the FIRST sweep instead of after the TTL. That
 *     un-books a position that fills seconds later — the exact F-3 failure the
 *     ambiguous hold exists to prevent.
 *   - `setInterval(fn, NaN)` clamps to ~1ms, so the broker sweep hammers
 *     `orderBook` in a tight loop on the order-placing process.
 *
 * Falling back to the default is the only safe reading of a typo.
 */

test('a well-formed value is used', () => {
  assert.equal(positiveEnvMs('DESK_BROKER_SWEEP_MS', 45_000, { DESK_BROKER_SWEEP_MS: '15000' }), 15000)
})

test('an unset or blank knob takes the default', () => {
  assert.equal(positiveEnvMs('DESK_AMBIGUOUS_TTL_MS', 600_000, {}), 600_000)
  assert.equal(positiveEnvMs('DESK_AMBIGUOUS_TTL_MS', 600_000, { DESK_AMBIGUOUS_TTL_MS: '   ' }), 600_000)
})

test('a UNIT-SUFFIXED value falls back rather than becoming NaN', () => {
  // '10m' is the plausible typo: every comparison against the resulting NaN is
  // false, so the TTL it configures would be silently disabled.
  assert.equal(positiveEnvMs('DESK_AMBIGUOUS_TTL_MS', 600_000, { DESK_AMBIGUOUS_TTL_MS: '10m' }), 600_000)
  assert.equal(positiveEnvMs('DESK_BROKER_SWEEP_MS', 45_000, { DESK_BROKER_SWEEP_MS: '45s' }), 45_000)
})

test('zero and negative are refused — a 0ms interval is a busy loop', () => {
  assert.equal(positiveEnvMs('DESK_BROKER_SWEEP_MS', 45_000, { DESK_BROKER_SWEEP_MS: '0' }), 45_000)
  assert.equal(positiveEnvMs('DESK_BROKER_SWEEP_MS', 45_000, { DESK_BROKER_SWEEP_MS: '-1' }), 45_000)
})

test('a non-finite value falls back', () => {
  assert.equal(positiveEnvMs('DESK_SWEEP_MS', 5000, { DESK_SWEEP_MS: 'Infinity' }), 5000)
  assert.equal(positiveEnvMs('DESK_SWEEP_MS', 5000, { DESK_SWEEP_MS: 'NaN' }), 5000)
})
