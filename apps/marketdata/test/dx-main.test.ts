/**
 * The Delta boot: it never reaches Kite, and what it publishes on `md.health`
 * keeps the NSE field set.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { toInstrumentRows, type DxProduct } from '@algomaker/dx'
import { dxHealthPayload, feedInstruments } from '../src/dx-main.ts'

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../src')

/** Every file reachable from `entry` through RELATIVE imports, static or dynamic. */
function importClosure(entry: string): Set<string> {
  const seen = new Set<string>()
  const walk = (file: string): void => {
    if (seen.has(file)) return
    seen.add(file)
    const text = readFileSync(file, 'utf8')
    for (const m of text.matchAll(/(?:from\s+|import\s*\(\s*|require\(\s*)['"](\.[^'"]+)['"]/g)) {
      const target = resolve(dirname(file), m[1]!)
      if (existsSync(target) && /\.(ts|js)$/.test(target)) walk(target)
    }
  }
  walk(entry)
  return seen
}

const KITE = /(kite-feed|kite-auth|zerodha-login|zerodha-native|feed-pool|feed-recovery|history|book-margin\/|vendor\/)/

test('DESK_VENUE=dx: the Delta boot imports no Kite or Zerodha module', () => {
  const closure = [...importClosure(resolve(SRC, 'dx-main.ts'))]
  const kite = closure.filter((f) => KITE.test(f.slice(SRC.length)))
  assert.deepEqual(kite, [])
  assert.ok(closure.some((f) => f.endsWith('dx-feed.ts')))
})

test('main() hands over to mainDx before any Kite step runs', () => {
  const text = readFileSync(resolve(SRC, 'main.ts'), 'utf8')
  const body = text.slice(text.indexOf('export async function main()'))
  const handOver = body.indexOf("if (venueFromEnv().id === 'dx')")
  assert.ok(handOver > 0, 'the venue hand-over is in main()')
  for (const kiteStep of ['installCrashGuards(', 'resolveZerodhaCredentials(', 'zerodhaLogin(', 'new KiteFeedPool(']) {
    const at = body.indexOf(kiteStep)
    assert.ok(at > handOver, `${kiteStep} runs after the hand-over`)
  }
})

/** The keys `main.ts` publishes on md.health for NSE. */
const NSE_HEALTH_KEYS = [
  'sockets',
  'tokens',
  'ts',
  'date',
  'staleTokens',
  'oldestAgeMs',
  'freezeStaleMs',
  'session',
  'instrumentSyncDay',
  'instrumentsStale',
  'freezeSyncDay',
  'bseFreezeSyncDay',
  'enctokenLastVerifiedAt',
]

test('md.health on Delta carries the NSE field set', () => {
  const nowMs = Date.UTC(2026, 10, 4, 12, 30)
  const p = dxHealthPayload({
    feed: { connected: true, downForMs: null, tokens: 550, staleTokens: 3, oldestAgeMs: 200_000 },
    nowMs,
    lastSyncMs: nowMs - 60_000,
    staleAfterMs: 180_000,
  })
  assert.deepEqual(Object.keys(p).sort(), [...NSE_HEALTH_KEYS].sort())
  assert.deepEqual(p['sockets'], [{ socket: 0, connected: true, tokens: 550, downForMs: null }])
  assert.equal(p['session'], true)
  assert.equal(p['date'], '2026-11-05', 'past 12:00 UTC the Delta day is the next settlement')
  assert.equal(p['instrumentsStale'], false)
  const stale = dxHealthPayload({
    feed: { connected: false, downForMs: 5_000, tokens: 0, staleTokens: 0, oldestAgeMs: 0 },
    nowMs,
    lastSyncMs: 0,
    staleAfterMs: 180_000,
  })
  assert.equal(stale['instrumentsStale'], true)
  assert.equal(stale['instrumentSyncDay'], null)
})

test('feedInstruments: the BTC options by symbol, and the spot token', () => {
  const p = (id: number, cp: 'call_options' | 'put_options'): DxProduct => ({
    id,
    symbol: `${cp === 'call_options' ? 'C' : 'P'}-BTC-76600-051126`,
    contract_type: cp,
    strike_price: '76600',
    settlement_time: '2026-11-05T12:00:00Z',
    contract_value: '0.001',
    tick_size: '0.1',
    underlying_asset: { id: 1, symbol: 'BTC' },
    spot_index: { id: 14, symbol: '.DEXBTUSD', tick_size: '0.5' },
  })
  const got = feedInstruments(toInstrumentRows([p(1, 'call_options'), p(2, 'put_options')]))
  assert.deepEqual(got, {
    options: [
      { token: 1, symbol: 'C-BTC-76600-051126' },
      { token: 2, symbol: 'P-BTC-76600-051126' },
    ],
    spotToken: 14,
  })
})
