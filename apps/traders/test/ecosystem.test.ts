import { test } from 'node:test'
import assert from 'node:assert/strict'
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const eco = createRequire(import.meta.url)('../../../ecosystem.traders.config.cjs')
const desk = createRequire(import.meta.url)('../../../ecosystem.desk.config.cjs')
const app = eco.apps.find((a: { name: string }) => a.name === 'dx-traders')
const AI_KEYS = [
  'TRADERS_AI_ENABLED', 'TRADERS_AI_PROVIDER', 'TRADERS_AI_API_KEY', 'TRADERS_AI_BASE_URL', 'TRADERS_AI_MODEL', 'TRADERS_AI_EFFORT',
  'TRADERS_AI_MAX_STEPS', 'TRADERS_AI_DAILY_USD', 'TRADERS_AI_TRADER_DAILY_USD', 'TRADERS_AI_PRICE_IN_PER_MTOK', 'TRADERS_AI_PRICE_OUT_PER_MTOK',
]

test('desk-traders runs bin/desk-traders.mjs with its own env and none of the desk secrets', () => {
  assert.equal(app.script, 'bin/desk-traders.mjs')
  assert.deepEqual(
    Object.keys(app.env).filter((k) => !['NODE_ENV', 'TRADERS_PORT', 'TRADERS_MONGO_URL', 'DESK_BUS_URL', 'TRADERS_ORIGINS', 'TRADERS_SESSION_TTL_MS', 'TRADERS_MAX_TOKENS', 'TRADERS_NSE_DIR', 'TRADERS_MARKET_WATCH_MAX_TOKENS', ...AI_KEYS].includes(k)),
    [],
  )
  for (const secret of ['DESK_API_TOKEN', 'DESK_MASTER_KEY', 'DESK_BROKER']) assert.ok(!(secret in app.env), secret)
})

test('its env is its own: the desk base (mongo url, ports, secrets) is not merged in', () => {
  assert.equal(app.env.DESK_MONGO_URL, undefined)
  assert.equal(app.env.DESK_PORT, undefined)
  assert.equal(app.env.DESK_BUS_PORT, undefined)
  assert.ok(app.env.TRADERS_MONGO_URL)
  assert.equal(app.env.NODE_ENV, 'production')
})

test('desk-traders is not in the desk pm2 file: a routine desk deploy must not start it', () => {
  assert.equal(desk.apps.some((a: { name: string }) => a.name === 'dx-traders'), false)
})

test('its pm2 namespace is not the desk\'s: make down / make clean act on namespace dx and must not touch it', () => {
  assert.equal(app.namespace, 'dxtraders')
  assert.ok(desk.apps.every((a: { namespace: string }) => a.namespace !== app.namespace))
})

test('the feed cap is in its env, 2000 tokens unless .env.local says otherwise', () => {
  assert.equal(app.env.TRADERS_MAX_TOKENS, '2000')
})

test('bounded restarts and a memory ceiling for the full master', () => {
  assert.deepEqual([app.autorestart, app.max_restarts, app.restart_delay, app.min_uptime, app.max_memory_restart], [true, 10, 2000, 10_000, '1500M'])
})

test('desk-traders-span is a cron job in the traders file and namespace, with only the NSE folder in its env', () => {
  const span = eco.apps.find((a: { name: string }) => a.name === 'dx-traders-span')
  assert.equal(span.namespace, 'dxtraders')
  assert.equal(span.script, 'scripts/span_job.py')
  assert.equal(span.autorestart, false)
  assert.equal(span.cron_restart, '*/15 3-14 * * 1-5')
  assert.deepEqual(Object.keys(span.env), ['TRADERS_NSE_DIR'])
  assert.equal(span.env.TRADERS_NSE_DIR, app.env.TRADERS_NSE_DIR)
  for (const secret of ['DESK_API_TOKEN', 'DESK_MASTER_KEY', 'DESK_BROKER']) assert.ok(!(secret in span.env), secret)
  assert.equal(desk.apps.some((a: { name: string }) => a.name === 'dx-traders-span'), false)
})

test('desk-traders-vol is an evening cron job after the span job\'s last slot, with only the NSE folder in its env', () => {
  const vol = eco.apps.find((a: { name: string }) => a.name === 'dx-traders-vol')
  const span = eco.apps.find((a: { name: string }) => a.name === 'dx-traders-span')
  assert.equal(vol.namespace, 'dxtraders')
  assert.equal(vol.script, 'scripts/nse_vol_job.py')
  assert.equal(vol.interpreter, span.interpreter)
  assert.equal(vol.autorestart, false)
  assert.equal(vol.cron_restart, '50 14 * * 1-5')
  assert.deepEqual(Object.keys(vol.env), ['TRADERS_NSE_DIR'])
  assert.equal(vol.env.TRADERS_NSE_DIR, app.env.TRADERS_NSE_DIR)
  assert.equal(desk.apps.some((a: { name: string }) => a.name === 'dx-traders-vol'), false)
})

test('the launcher exists and calls main() explicitly', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../../../bin/desk-traders.mjs', import.meta.url), 'utf8')
  assert.match(src, /import \{ main \} from '\.\.\/apps\/traders\/src\/main\.ts'/)
  assert.match(src, /\bmain\(\)\.catch/)
})

/** desk-traders' env from a copy of the ecosystem file beside an `.env.local` holding `lines`: the repo's own `.env.local` never counts. */
function envWith(lines: readonly string[]): Record<string, string> {
  const dir = mkdtempSync(join(tmpdir(), 'traders-eco-'))
  try {
    copyFileSync(new URL('../../../ecosystem.traders.config.cjs', import.meta.url), join(dir, 'ecosystem.traders.config.cjs'))
    writeFileSync(join(dir, '.env.local'), lines.join('\n'))
    const copy = createRequire(import.meta.url)(join(dir, 'ecosystem.traders.config.cjs'))
    return copy.apps.find((a: { name: string }) => a.name === 'dx-traders').env
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test("Market Watch's cap is passed only when .env.local sets it, so unset it defaults to min(1000, TRADERS_MAX_TOKENS) (R3 final fix N1)", () => {
  // always passing '1000' made TRADERS_MAX_TOKENS=800 alone a boot refusal, and pm2 a restart loop
  const lowered = envWith(['TRADERS_MAX_TOKENS=800'])
  assert.equal(lowered['TRADERS_MAX_TOKENS'], '800')
  assert.equal('TRADERS_MARKET_WATCH_MAX_TOKENS' in lowered, false)
  assert.equal('TRADERS_MARKET_WATCH_MAX_TOKENS' in envWith([]), false)
  assert.equal(envWith(['TRADERS_MARKET_WATCH_MAX_TOKENS=600'])['TRADERS_MARKET_WATCH_MAX_TOKENS'], '600')
})

test('the assistant\'s TRADERS_AI_* keys are passed only when .env.local sets them; no other AI or desk key gets in', () => {
  const none = envWith([])
  assert.deepEqual(Object.keys(none).filter((k) => k.startsWith('TRADERS_AI_')), [], 'unset, the assistant is off and nothing is passed')
  const on = envWith(['TRADERS_AI_ENABLED=1', 'TRADERS_AI_PROVIDER=anthropic', 'TRADERS_AI_API_KEY=sk-test', 'TRADERS_AI_DAILY_USD=10', 'ANTHROPIC_API_KEY=other', 'DESK_API_TOKEN=x'])
  assert.deepEqual(
    Object.fromEntries(Object.entries(on).filter(([k]) => k.startsWith('TRADERS_AI_'))),
    { TRADERS_AI_ENABLED: '1', TRADERS_AI_PROVIDER: 'anthropic', TRADERS_AI_API_KEY: 'sk-test', TRADERS_AI_DAILY_USD: '10' },
  )
  assert.equal('ANTHROPIC_API_KEY' in on, false, 'only the app\'s own key name is read')
  assert.equal('DESK_API_TOKEN' in on, false)
})
