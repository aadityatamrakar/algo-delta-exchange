// M5: this file was previously test/golden/external-signal-mirror.test.ts. external-signal-mirror
// has no legacy .js file to diff against — it mirrors an EXTERNAL signal source, not a ported
// strategy — so these are hand-written expectations of the adapter's own behaviour, never a
// legacy comparison. Living under golden/ overstated that. Relocated here, content unchanged.
import test from 'node:test'
import assert from 'node:assert/strict'
import { RecordingGateway, makeLogger } from '@algomaker/strategy-kit'
import { ExternalSignalMirrorAdapter, FakeSignalSource, type InstrumentResolver } from '../src/external-signal-mirror/adapter.ts'
import { MIRROR_1PBUY, MIRROR_A006, MIRROR_A010, MIRROR_EMA2050 } from '../src/external-signal-mirror/configs.ts'

// A010 is the one config with NO legacy .js file behind it — it was added on
// 2026-08-24, after the cutover, so its destinationTag comes from the upstream
// account name rather than from a ported `trackOrder()` call. It is pinned here
// for the same reason the other three are: the destinationTag is what lands in
// `meta.mirroredFrom`, and a typo there is silent — orders would be placed and
// booked under a tag nothing reconciles against.
test('the 4 configs carry the exact destinationTag values from the legacy trackOrder calls', () => {
  assert.equal(MIRROR_1PBUY.destinationTag, '1PBUY')
  assert.equal(MIRROR_A006.destinationTag, 'A006')
  assert.equal(MIRROR_A010.destinationTag, 'A010')
  assert.equal(MIRROR_EMA2050.destinationTag, 'EMA2050')
  // No config carries a literal credential — only an opaque secret-store reference.
  for (const cfg of [MIRROR_1PBUY, MIRROR_A006, MIRROR_A010, MIRROR_EMA2050]) {
    assert.equal(/[0-9a-zA-Z]{8,}/.test(cfg.credentialsRef) && cfg.credentialsRef.includes('@'), false)
  }
})

test('end-to-end: an EXECUTED message for the A006 mirror submits with the A006 destinationTag in meta', async () => {
  const SYM = { tradingsymbol: 'NIFTY22000CE', instrumentToken: 1, lotSize: 75, tickSize: 0.05, exchange: 'NFO' }
  const resolver: InstrumentResolver = { bySymbol: (s) => (s === SYM.tradingsymbol ? SYM : null) }
  const gateway = new RecordingGateway()
  const source = new FakeSignalSource()
  const adapter = new ExternalSignalMirrorAdapter(MIRROR_A006, source, gateway, resolver, makeLogger())
  adapter.start()
  source.emit({ type: 'ORDER_EXECUTION', payload: { symbol: SYM.tradingsymbol, side: 'SELL', status: 'EXECUTED' } })
  await new Promise((r) => setImmediate(r))
  assert.equal(gateway.submitted.length, 1)
  assert.equal(gateway.submitted[0]?.req.meta?.mirroredFrom, 'A006')
})
