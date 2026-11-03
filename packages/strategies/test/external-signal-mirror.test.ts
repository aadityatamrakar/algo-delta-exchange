import test from 'node:test'
import assert from 'node:assert/strict'
import { RecordingGateway, makeLogger } from '@algomaker/strategy-kit'
import { ExternalSignalMirrorAdapter, FakeSignalSource, type InstrumentResolver } from '../src/external-signal-mirror/adapter.ts'
import type { ExternalSignalMirrorConfig } from '../src/external-signal-mirror/config.ts'

const SYM = { tradingsymbol: 'BANKNIFTY50000CE', instrumentToken: 1, lotSize: 35, tickSize: 0.05, exchange: 'NFO' }
const resolver: InstrumentResolver = { bySymbol: (s) => (s === SYM.tradingsymbol ? SYM : null) }

const cfg: ExternalSignalMirrorConfig = {
  tag: 'Mirror_1PBUY_TEST', destinationTag: '1PBUY', credentialsRef: 'secrets/optionbhai/live001',
  instrumentRefreshMinutes: 15, onUnknownSymbol: 'drop-and-alert',
}

test('an EXECUTED order execution message is mirrored onto the order bus', async () => {
  const gateway = new RecordingGateway()
  const source = new FakeSignalSource()
  const adapter = new ExternalSignalMirrorAdapter(cfg, source, gateway, resolver, makeLogger())
  adapter.start()

  source.emit({ type: 'ORDER_EXECUTION', payload: { symbol: SYM.tradingsymbol, side: 'BUY', status: 'EXECUTED' } })
  await new Promise((r) => setImmediate(r))

  assert.equal(gateway.orders.length, 1)
  assert.equal(gateway.orders[0]?.side, 'BUY')
  assert.equal(gateway.orders[0]?.symbol, SYM.tradingsymbol)
})

test('a PENDING message is NOT mirrored — only EXECUTED fires', async () => {
  const gateway = new RecordingGateway()
  const source = new FakeSignalSource()
  const adapter = new ExternalSignalMirrorAdapter(cfg, source, gateway, resolver, makeLogger())
  adapter.start()
  source.emit({ type: 'ORDER_EXECUTION', payload: { symbol: SYM.tradingsymbol, side: 'BUY', status: 'PENDING' } })
  await new Promise((r) => setImmediate(r))
  assert.equal(gateway.orders.length, 0)
})

test('an unknown symbol is dropped-and-alerted, not thrown, under the default policy', async () => {
  const gateway = new RecordingGateway()
  const source = new FakeSignalSource()
  const logs: { level: string; msg: string }[] = []
  const adapter = new ExternalSignalMirrorAdapter(cfg, source, gateway, resolver, makeLogger(logs))
  adapter.start()
  source.emit({ type: 'ORDER_EXECUTION', payload: { symbol: 'NOT_A_REAL_SYMBOL', side: 'SELL', status: 'EXECUTED' } })
  await new Promise((r) => setImmediate(r))
  assert.equal(gateway.orders.length, 0)
  assert.ok(logs.some((l) => l.level === 'warn' && l.msg.includes('unknown symbol')))
})

test('stop() unsubscribes — no further orders are mirrored', async () => {
  const gateway = new RecordingGateway()
  const source = new FakeSignalSource()
  const adapter = new ExternalSignalMirrorAdapter(cfg, source, gateway, resolver, makeLogger())
  adapter.start()
  adapter.stop()
  source.emit({ type: 'ORDER_EXECUTION', payload: { symbol: SYM.tradingsymbol, side: 'BUY', status: 'EXECUTED' } })
  await new Promise((r) => setImmediate(r))
  assert.equal(gateway.orders.length, 0)
})

// ------------------------------------------------- exits are exits (F-6b/6c)

/** A stand-in for the runner's `PositionLedger`, which is what wires this live. */
function positions(net: Record<string, number>): { netLots(symbol: string): number } {
  return { netLots: (symbol) => net[symbol] ?? 0 }
}

function mirror(
  gateway: RecordingGateway,
  net: Record<string, number>,
  logs: { level: string; msg: string }[] = [],
): FakeSignalSource {
  const source = new FakeSignalSource()
  const adapter = new ExternalSignalMirrorAdapter(cfg, source, gateway, resolver, makeLogger(logs), {
    positions: positions(net),
  })
  adapter.start()
  return source
}

const settle = (): Promise<void> => new Promise((r) => setImmediate(r))

test('an order that REDUCES the mirrored net is marked reducesExposure', async () => {
  // The F-6 mechanism this closes: an unmarked exit is refused by the kill
  // switch and by the stale-feed block, and nothing retries it — so the leg
  // stays open forever while the upstream account is flat.
  const gateway = new RecordingGateway()
  const source = mirror(gateway, { [SYM.tradingsymbol]: -2 })

  source.emit({ type: 'ORDER_EXECUTION', payload: { symbol: SYM.tradingsymbol, side: 'BUY', status: 'EXECUTED' } })
  await settle()

  assert.equal(gateway.submitted.length, 1)
  assert.equal(gateway.submitted[0]?.req.reducesExposure, true)
})

test('an order from FLAT is an entry, not an exit — it is not marked', async () => {
  const gateway = new RecordingGateway()
  const source = mirror(gateway, {})

  source.emit({ type: 'ORDER_EXECUTION', payload: { symbol: SYM.tradingsymbol, side: 'BUY', status: 'EXECUTED' } })
  await settle()

  assert.equal(gateway.submitted.length, 1)
  assert.equal(gateway.submitted[0]?.req.reducesExposure, undefined)
})

test('an order that ADDS to the mirrored net is not marked either', async () => {
  const gateway = new RecordingGateway()
  const source = mirror(gateway, { [SYM.tradingsymbol]: 1 })

  source.emit({ type: 'ORDER_EXECUTION', payload: { symbol: SYM.tradingsymbol, side: 'BUY', status: 'EXECUTED' } })
  await settle()

  assert.equal(gateway.submitted[0]?.req.reducesExposure, undefined)
})

test('an EXACT-flat exit is placed — the crossing guard must not trap a position', async () => {
  const gateway = new RecordingGateway()
  const source = mirror(gateway, { [SYM.tradingsymbol]: 1 })

  source.emit({ type: 'ORDER_EXECUTION', payload: { symbol: SYM.tradingsymbol, side: 'SELL', status: 'EXECUTED' } })
  await settle()

  assert.equal(gateway.submitted.length, 1, 'a leg that closes to exactly flat must go out')
  assert.equal(gateway.submitted[0]?.req.reducesExposure, true)
})

test('an order that would take the symbol PAST flat is refused and named', async () => {
  // The upstream sends a size we do not carry: quantity is fabricated at 1 lot
  // per EXECUTED message, so a reversing order larger than the net we hold
  // would open a position the other way that nothing here would ever close.
  const gateway = new RecordingGateway()
  const logs: { level: string; msg: string }[] = []
  const source = new FakeSignalSource()
  const adapter = new ExternalSignalMirrorAdapter(cfg, source, gateway, resolver, makeLogger(logs), {
    positions: { netLots: () => -1 },
    // Two lots against a net of one: the second lot is a fresh long.
    lots: 2,
  })
  adapter.start()

  source.emit({ type: 'ORDER_EXECUTION', payload: { symbol: SYM.tradingsymbol, side: 'BUY', status: 'EXECUTED' } })
  await settle()

  assert.equal(gateway.submitted.length, 0)
  assert.ok(
    logs.some((l) => l.level === 'error' && l.msg.includes('past flat')),
    `expected a refusal naming the crossing, got ${JSON.stringify(logs)}`,
  )
})

test('with no positions port the adapter behaves exactly as it did — no marking, no refusal', async () => {
  const gateway = new RecordingGateway()
  const source = new FakeSignalSource()
  const adapter = new ExternalSignalMirrorAdapter(cfg, source, gateway, resolver, makeLogger())
  adapter.start()

  source.emit({ type: 'ORDER_EXECUTION', payload: { symbol: SYM.tradingsymbol, side: 'SELL', status: 'EXECUTED' } })
  await settle()

  assert.equal(gateway.submitted.length, 1)
  assert.equal(gateway.submitted[0]?.req.reducesExposure, undefined)
})
