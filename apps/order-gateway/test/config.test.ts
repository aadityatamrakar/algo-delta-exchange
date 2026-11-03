import { test } from 'node:test'
import assert from 'node:assert/strict'
import { positiveEnvMs } from '../src/main.ts'
import { DX_DEFAULT_BASE_URL, DX_DEFAULT_WS_URL, loadDxConfig } from '../src/dx-config.ts'

/**
 * The Delta credentials: the BROKER STORE (`desk-brokers` kind `delta`, typed
 * into the Brokers page) with env as the fallback. The store is the operator's
 * most recent deliberate act; env is what the machine was started with.
 */

const store = (
  secret: Record<string, unknown> = {},
  meta: Record<string, unknown> = {},
) => async () => ({ secret, meta })

const quiet = (): void => {}

test('the broker store supplies the key and secret, and the India hosts are the default', async () => {
  const cfg = await loadDxConfig(store({ apiKey: 'K', apiSecret: 'S' }), {}, quiet)
  assert.deepEqual(
    { baseUrl: cfg.baseUrl, wsUrl: cfg.wsUrl, apiKey: cfg.apiKey, apiSecret: cfg.apiSecret, source: cfg.source },
    { baseUrl: DX_DEFAULT_BASE_URL, wsUrl: DX_DEFAULT_WS_URL, apiKey: 'K', apiSecret: 'S', source: 'broker-store' },
  )
  assert.equal(DX_DEFAULT_BASE_URL, 'https://api.india.delta.exchange')
  assert.equal(DX_DEFAULT_WS_URL, 'wss://socket.india.delta.exchange')
})

test('meta.baseUrl is used, and the store WINS over the environment', async () => {
  const cfg = await loadDxConfig(
    store({ apiKey: 'K', apiSecret: 'S' }, { baseUrl: 'https://cdn-ind.testnet.deltaex.org' }),
    { DX_API_KEY: 'EK', DX_API_SECRET: 'ES', DX_BASE_URL: 'https://env.example.com' },
    quiet,
  )
  assert.equal(cfg.baseUrl, 'https://cdn-ind.testnet.deltaex.org')
  assert.equal(cfg.apiKey, 'K')
})

test('env fills in anything the store does not have', async () => {
  const cfg = await loadDxConfig(store({ apiKey: 'K' }), { DX_API_SECRET: 'ES' }, quiet)
  assert.equal(cfg.apiSecret, 'ES')
  assert.equal(cfg.source, 'mixed')
})

test('missing credentials name what is missing, in BOTH vocabularies', async () => {
  await assert.rejects(() => loadDxConfig(store(), {}, quiet), /apiKey\/DX_API_KEY.*apiSecret\/DX_API_SECRET/s)
})

test('a blank env var counts as absent, not as an empty credential', async () => {
  await assert.rejects(() => loadDxConfig(store({ apiKey: 'K' }), { DX_API_SECRET: '   ' }, quiet), /apiSecret\/DX_API_SECRET/)
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
