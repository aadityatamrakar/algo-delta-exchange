/**
 * The operator's emergency flatten (`scripts/dx-flatten.mts`): a dry run by
 * default that only reads; `--yes` cancels EVERY order (stops included) and
 * then close_all, and reports what is left.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { DxOrder, DxPosition } from '@algomaker/dx'
import { parseFlattenArgs, runFlatten, type FlattenRest } from '../src/flatten.ts'

const pos: DxPosition = { product_id: 1, product_symbol: 'C-BTC-77000-131126', size: -20, entry_price: '2060' }
const ord: DxOrder = { id: 9, product_id: 1, product_symbol: 'C-BTC-77000-131126', size: 20, unfilled_size: 20, side: 'buy', state: 'pending', stop_order_type: 'stop_loss_order', stop_price: '4737.5', limit_price: '7106.3', reduce_only: true, client_order_id: 'bkstpX' }

function fake(after: { positions: DxPosition[]; open: DxOrder[] }) {
  const calls: string[] = []
  let done = false
  const rest: FlattenRest = {
    positions: async () => (done ? after.positions : [pos]),
    openOrders: async () => (done ? after.open : [ord]),
    cancelAllOrders: async (b) => { calls.push(`cancelAll:${JSON.stringify(b)}`) },
    closeAllPositions: async () => { calls.push('closeAll'); done = true; return {} },
  }
  return { rest, calls }
}

test('args: --rail is required; dry run unless --yes', () => {
  assert.deepEqual(parseFlattenArgs(['--rail', 'live']), { rail: 'live', yes: false })
  assert.deepEqual(parseFlattenArgs(['--rail', 'demo', '--yes']), { rail: 'demo', yes: true })
  assert.deepEqual(parseFlattenArgs(['--rail=live', '--dry-run']), { rail: 'live', yes: false })
  assert.throws(() => parseFlattenArgs([]), /--rail/)
  assert.throws(() => parseFlattenArgs(['--rail', 'prod']), /--rail/)
  assert.throws(() => parseFlattenArgs(['--rail', 'live', '--yes', '--dry-run']), /both/)
})

test('dry run: prints positions and orders, writes nothing', async () => {
  const f = fake({ positions: [], open: [] })
  const out: string[] = []
  const r = await runFlatten({ rest: f.rest, yes: false, print: (l) => out.push(l), sleep: async () => {} })
  assert.deepEqual(f.calls, [])
  assert.equal(r.flattened, false)
  const text = out.join('\n')
  assert.match(text, /C-BTC-77000-131126 +-20/)
  assert.match(text, /stop_loss_order/)
  assert.match(text, /DRY RUN/)
})

test('--yes: cancel ALL orders (stops too), then close_all, then show what remains', async () => {
  const f = fake({ positions: [], open: [] })
  const out: string[] = []
  const r = await runFlatten({ rest: f.rest, yes: true, print: (l) => out.push(l), sleep: async () => {} })
  assert.deepEqual(f.calls, ['cancelAll:{}', 'closeAll'])
  assert.equal(r.flattened, true)
  assert.equal(r.after?.positions.length, 0)
  assert.match(out.join('\n'), /FLAT/)
})

test('--yes with positions left over says so loudly', async () => {
  const f = fake({ positions: [pos], open: [] })
  const out: string[] = []
  const r = await runFlatten({ rest: f.rest, yes: true, print: (l) => out.push(l), sleep: async () => {} })
  assert.equal(r.after?.positions.length, 1)
  assert.match(out.join('\n'), /STILL OPEN/)
})
