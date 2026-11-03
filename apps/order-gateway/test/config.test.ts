import { test } from 'node:test'
import assert from 'node:assert/strict'
import { positiveEnvMs } from '../src/main.ts'
import { DX_DEMO_REST_URL, DX_DEMO_WS_URL } from '@algomaker/dx'
import { DX_DEFAULT_BASE_URL, DX_DEFAULT_WS_URL, loadDxConfig, loadDxDemoConfig } from '../src/dx-config.ts'

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
    store({ apiKey: 'K', apiSecret: 'S' }, { baseUrl: 'https://api.india.delta.exchange/' }),
    { DX_API_KEY: 'EK', DX_API_SECRET: 'ES', DX_BASE_URL: 'https://env.example.com' },
    quiet,
  )
  assert.equal(cfg.baseUrl, 'https://api.india.delta.exchange')
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

// ------------------------------------------------------------- the demo rail

test('demo: the delta-demo row resolves onto the TESTNET by default', async () => {
  const cfg = await loadDxDemoConfig(store({ apiKey: 'DK', apiSecret: 'DS' }), {}, quiet)
  assert.equal(cfg.baseUrl, DX_DEMO_REST_URL)
  assert.equal(cfg.wsUrl, DX_DEMO_WS_URL)
  assert.equal(cfg.apiKey, 'DK')
  assert.equal(cfg.source, 'broker-store')
})

test('demo: production env credentials are NEVER a fallback — only DX_DEMO_* are', async () => {
  await assert.rejects(
    () => loadDxDemoConfig(store(), { DX_API_KEY: 'PROD', DX_API_SECRET: 'PRODS' }, quiet),
    /Delta demo is not configured/,
  )
  const cfg = await loadDxDemoConfig(store(), { DX_DEMO_API_KEY: 'EK', DX_DEMO_API_SECRET: 'ES' }, quiet)
  assert.equal(cfg.apiKey, 'EK')
  assert.equal(cfg.source, 'env')
})

test('demo credentials never reach the production host', async () => {
  for (const meta of [
    { baseUrl: 'https://api.india.delta.exchange' },
    { wsUrl: 'wss://socket.india.delta.exchange' },
    { baseUrl: 'http://127.0.0.1:9' },
  ]) {
    await assert.rejects(
      () => loadDxDemoConfig(store({ apiKey: 'DK', apiSecret: 'DS' }, meta), {}, quiet),
      /demo credentials may only be sent to the testnet/,
      JSON.stringify(meta),
    )
  }
  await assert.rejects(
    () => loadDxDemoConfig(store({ apiKey: 'DK', apiSecret: 'DS' }), { DX_DEMO_BASE_URL: 'https://api.india.delta.exchange' }, quiet),
    /testnet/,
  )
})

test('production credentials never reach the testnet', async () => {
  for (const meta of [{ baseUrl: DX_DEMO_REST_URL }, { wsUrl: DX_DEMO_WS_URL }]) {
    await assert.rejects(
      () => loadDxConfig(store({ apiKey: 'K', apiSecret: 'S' }, meta), {}, quiet),
      /production credentials must never be sent to the testnet/,
      JSON.stringify(meta),
    )
  }
  await assert.rejects(
    () => loadDxConfig(store({ apiKey: 'K', apiSecret: 'S' }), { DX_BASE_URL: DX_DEMO_REST_URL }, quiet),
    /testnet/,
  )
})

test('demo: the same key as production is refused — it would be the real account', async () => {
  await assert.rejects(
    () => loadDxDemoConfig(store({ apiKey: 'SAME', apiSecret: 'DS' }), {}, quiet, { liveApiKey: 'SAME' }),
    /same API key as production/,
  )
})

test('production credentials go to Delta Exchange India only — not any other host', async () => {
  await assert.rejects(
    () => loadDxConfig(store({ apiKey: 'K', apiSecret: 'S' }, { baseUrl: 'https://example.com' }), {}, quiet),
    /only be sent to Delta Exchange India/,
  )
})
