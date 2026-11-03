import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { runLegacyShadow } from '../src/index.ts'

const SLIVE = path.join(import.meta.dirname, '..', '..', '..', 'archive', 'server', 'slive')

test('drives bull-s-1.js UNMODIFIED and captures the initial straddle', async () => {
  const run = await runLegacyShadow({
    legacyFile: path.join(SLIVE, 'bull-s-1.js'),
    futureToken: 999001,
    currentExpiryOptions: {
      '50000CE': { instrument_token: 999002, tradingsymbol: 'BANKNIFTY50000CE', strike: 50000, lot_size: 35 },
      '50000PE': { instrument_token: 999003, tradingsymbol: 'BANKNIFTY50000PE', strike: 50000, lot_size: 35 },
    },
    nowMs: Date.UTC(2026, 6, 24, 3, 46, 0), // 09:16 IST
  })

  await run.tick([
    { instrument_token: 999001, last_price: 50000 },
    { instrument_token: 999002, last_price: 100 },
    { instrument_token: 999003, last_price: 100 },
  ])

  assert.equal(run.orders.length, 2, 'bull-s-1.js sends exactly one SELL CE + one SELL PE on the first crossover')
  assert.equal(run.orders[0]?.side, 'SELL')
  assert.equal(run.orders[0]?.tradingsymbol, 'BANKNIFTY50000CE')
  assert.equal(run.orders[1]?.side, 'SELL')
  assert.equal(run.orders[1]?.tradingsymbol, 'BANKNIFTY50000PE')

  run.stop()
})
