import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  BROKER_MARGIN_COLLECTION,
  createDeltaMarginSnapshot,
  DELTA_MARGIN_MS,
  marginFromBalances,
} from '../src/dx-margin.ts'

const USD = {
  asset_symbol: 'USD',
  balance: '1000.50',
  available_balance: '850.25',
  position_margin: '140.25',
  order_margin: '10',
  portfolio_margin: '0',
}

test('the USD row becomes balance, available, the margins, used and % utilized', () => {
  const m = marginFromBalances([{ asset_symbol: 'BTC', balance: '0.1' }, USD])
  assert.deepEqual(m, {
    ok: true,
    balance: 1000.5,
    available: 850.25,
    positionMargin: 140.25,
    orderMargin: 10,
    portfolioMargin: 0,
    used: 150.25,
    utilizedPct: Number(((150.25 / 1000.5) * 100).toFixed(4)),
  })
})

test('no USD row, or a USD row without a balance, is a failure — never zeros', () => {
  assert.deepEqual(marginFromBalances([{ asset_symbol: 'BTC', balance: '1' }]), {
    ok: false,
    error: 'Delta reported no USD wallet row (assets: BTC)',
  })
  const bad = marginFromBalances([{ asset_symbol: 'USD', balance: 'abc' }])
  assert.equal(bad.ok, false)
  // A zero balance has no utilization to speak of: null, not 0 % and not NaN.
  const empty = marginFromBalances([{ asset_symbol: 'USD', balance: '0', available_balance: '0' }])
  assert.equal(empty.ok && empty.utilizedPct, null)
})

test('each rail writes its own row every read; a failed read is recorded as failed with no figures', async () => {
  const writes: { filter: Record<string, unknown>; set: Record<string, unknown> }[] = []
  const collection = {
    updateOne: async (filter: Record<string, unknown>, update: Record<string, unknown>) => {
      writes.push({ filter, set: update['$set'] as Record<string, unknown> })
    },
  }
  let fail = false
  const demo = createDeltaMarginSnapshot({
    id: 'delta-demo',
    walletBalances: async () => {
      if (fail) throw new Error('GET /v2/wallet/balances: 401 invalid_api_key')
      return [USD]
    },
    collection,
    now: () => 1_000,
    host: 'cdn-ind.testnet.deltaex.org',
    log: () => {},
  })
  await demo.take()
  fail = true
  await demo.take()
  assert.deepEqual(writes[0]?.filter, { _id: 'delta-demo' })
  assert.deepEqual(
    { ok: writes[0]?.set['ok'], balance: writes[0]?.set['balance'], rail: writes[0]?.set['rail'], host: writes[0]?.set['host'] },
    { ok: true, balance: 1000.5, rail: 'demo', host: 'cdn-ind.testnet.deltaex.org' },
  )
  const failed = writes[1]?.set ?? {}
  assert.equal(failed['ok'], false)
  assert.match(String(failed['error']), /testnet.*invalid_api_key/)
  for (const k of ['balance', 'available', 'positionMargin', 'orderMargin', 'portfolioMargin', 'used', 'utilizedPct']) {
    assert.equal(failed[k], null, `${k} is null on a failed read, never 0`)
  }
  assert.equal(BROKER_MARGIN_COLLECTION, 'desk-broker-margin')
  assert.equal(DELTA_MARGIN_MS, 30_000)
})

test('the live rail is written as _id delta', async () => {
  const ids: unknown[] = []
  const live = createDeltaMarginSnapshot({
    id: 'delta',
    walletBalances: async () => [USD],
    collection: { updateOne: async (f: Record<string, unknown>) => void ids.push(f['_id']) },
    now: () => 1,
    host: 'api.india.delta.exchange',
    log: () => {},
  })
  await live.take()
  assert.deepEqual(ids, ['delta'])
})
