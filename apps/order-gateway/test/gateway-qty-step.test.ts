/**
 * THE GATEWAY'S WHOLE-LOT CHECK ON A 0.001 LOT — Delta BTC options.
 *
 * `quantity % lotSize` is 0.0009999999999999913 for 0.15 % 0.001, so the
 * float remainder refused every fractional order. The check is now "a whole
 * number of lots, to float precision" and NSE integers behave exactly as they
 * did.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FreezeLimits } from '@algomaker/instruments'
import { planOrder, planTranches, type GatewayOrderDoc, type ResolvedContract } from '../src/gateway.ts'

const BTC_CE: ResolvedContract = {
  tradingsymbol: 'C-BTC-70000-061126',
  instrumentToken: 101,
  lotSize: 0.001,
  tickSize: 0.1,
  exchange: 'DX',
}
const BHEL: ResolvedContract = {
  tradingsymbol: 'BHEL26AUG420CE',
  instrumentToken: 19664898,
  lotSize: 2625,
  tickSize: 0.05,
  exchange: 'NFO',
}
const freeze = new FreezeLimits([{ symbol: 'BHEL', freezeQty: 52500 }])

const doc = (over: Partial<GatewayOrderDoc> = {}): GatewayOrderDoc => ({
  tradingsymbol: 'C-BTC-70000-061126',
  transaction_type: 'SELL',
  quantity: 0.15,
  tag: 'BTC-D',
  underlying: 'BTC',
  ...over,
})

test('quantity 0.15 at lotSize 0.001 is 150 lots, sent as 0.15', () => {
  const p = planOrder({ doc: doc(), contract: BTC_CE, freeze, clientOrderId: 'ord-1' })
  assert.equal(p.rejected, null)
  assert.equal(p.intents.length, 1)
  assert.equal(p.intents[0]?.lots, 150)
  assert.equal(p.intents[0]?.quantity, 0.15)
  assert.equal(p.expectedQty, 0.15)
})

test('a float-noisy 0.15000000000000002 is still 150 lots, and goes out clean', () => {
  const p = planOrder({ doc: doc({ quantity: 0.05 + 0.05 + 0.05 }), contract: BTC_CE, freeze, clientOrderId: 'ord-1' })
  assert.equal(p.rejected, null)
  assert.equal(p.intents[0]?.lots, 150)
  assert.equal(p.intents[0]?.quantity, 0.15)
  assert.equal(p.expectedQty, 0.15, 'the fill watcher waits for 0.15, not 0.15000000000000002')
})

test('0.0505 at lotSize 0.001 is refused — half a contract cannot trade', () => {
  const p = planOrder({ doc: doc({ quantity: 0.0505 }), contract: BTC_CE, freeze, clientOrderId: 'ord-1' })
  assert.match(p.rejected ?? '', /not a multiple of lot size/)
})

test('NSE is unchanged: 5 lots pass, a share off a lot is refused', () => {
  const ok = planOrder({
    doc: doc({ tradingsymbol: 'BHEL26AUG420CE', quantity: 13125, underlying: 'BHEL' }),
    contract: BHEL,
    freeze,
    clientOrderId: 'ord-1',
  })
  assert.equal(ok.rejected, null)
  assert.equal(ok.intents[0]?.quantity, 13125)
  assert.equal(ok.intents[0]?.lots, 5)
  const off = planOrder({
    doc: doc({ tradingsymbol: 'BHEL26AUG420CE', quantity: 13126, underlying: 'BHEL' }),
    contract: BHEL,
    freeze,
    clientOrderId: 'ord-1',
  })
  assert.match(off.rejected ?? '', /not a multiple of lot size 2625/)
})

test('tranche slices of a 0.15 BTC order are clean 0.001 multiples', () => {
  const slices = planTranches({ quantity: 0.15, lotSize: 0.001, trancheLots: 40, freezeMaxLots: null })
  assert.deepEqual(
    slices?.map((s) => s.qty),
    [0.04, 0.04, 0.04, 0.03],
  )
})
