import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SEED_RATES, brokerageFor, chargesFor, parseRates, type ChargeBreakdown } from '../src/analytics/charges.ts'
import type { ChargeRates } from '../src/analytics/wire.ts'

function close(a: number, b: number, eps: number): void {
  assert.ok(Math.abs(a - b) <= eps, `${a} vs ${b} (eps ${eps})`)
}
const err = (x: unknown): string => {
  assert.ok(typeof x === 'object' && x !== null && 'error' in x, `expected an error, got ${JSON.stringify(x)}`)
  return (x as { error: string }).error
}

test('the seed table: operator-to-confirm values, never confirmed', () => {
  assert.deepEqual(SEED_RATES, {
    option: { sttBuyPct: 0, sttSellPct: 0.1, exchangePct: 0.03503, stampBuyPct: 0.003 },
    future: { sttBuyPct: 0, sttSellPct: 0.02, exchangePct: 0.00173, stampBuyPct: 0.002 },
    share: { sttBuyPct: 0.1, sttSellPct: 0.1, exchangePct: 0.00297, stampBuyPct: 0.015 },
    sebiPerCrore: 10, gstPct: 18,
    brokerage: { default: { mode: 'order', amount: 20 }, byTrader: {} },
    confirmedBy: null, confirmedAt: null,
  })
})

test('charges on one sold option (seed rates)', () => {
  const c = chargesFor([{ instrument: 'option', side: 'Sell', qty: 175, price: 45, orderNo: 'A1', lotSize: 175 }], SEED_RATES, 'asha')
  close(c.brokerage, 20, 1e-9); close(c.stt, 7.875, 1e-9); close(c.exchange, 2.7586125, 1e-9); close(c.sebi, 0.007875, 1e-12)
  close(c.stamp, 0, 1e-12); close(c.gst, 4.09796775, 1e-9); close(c.total, 34.73945525, 1e-9)
})

test('square-off of a short call and a long future', () => {
  const c = chargesFor([{ instrument: 'option', side: 'Buy', qty: 175, price: 40, orderNo: 'x1', lotSize: 175 }, { instrument: 'future', side: 'Sell', qty: 175, price: 3010, orderNo: 'x2', lotSize: 175 }], SEED_RATES, 'asha')
  const want = { brokerage: 40, stt: 105.35, exchange: 11.564875, sebi: 0.53375, stamp: 0.21, gst: 9.3777525, total: 167.0363775 }
  for (const k of Object.keys(want) as (keyof ChargeBreakdown)[]) close(c[k], want[k], 1e-9)
})

test('per-lot brokerage and a per-trader override', () => {
  const r = { ...SEED_RATES, brokerage: { default: SEED_RATES.brokerage.default, byTrader: { asha: { mode: 'lot', amount: 10 } } } } as ChargeRates
  assert.equal(chargesFor([{ instrument: 'option', side: 'Sell', qty: 525, price: 45, orderNo: 'A1', lotSize: 175 }], r, 'asha').brokerage, 30)
  assert.equal(brokerageFor(r, 'bala').amount, 20)
})

test('per-order brokerage counts each order once, however many fills', () => {
  const fills = [
    { instrument: 'option', side: 'Sell', qty: 175, price: 45, orderNo: 'A1', lotSize: 175 },
    { instrument: 'option', side: 'Sell', qty: 175, price: 45.5, orderNo: 'A1', lotSize: 175 },
    { instrument: 'future', side: 'Buy', qty: 175, price: 3000, orderNo: 'A2', lotSize: 175 },
  ] as const
  assert.equal(chargesFor(fills, SEED_RATES, 'asha').brokerage, 40)
  assert.deepEqual(chargesFor([], SEED_RATES, 'asha'), { brokerage: 0, stt: 0, exchange: 0, sebi: 0, stamp: 0, gst: 0, total: 0 })
})

test('per-lot: a share fill, or an unknown lot size, pays once per order', () => {
  const r = { ...SEED_RATES, brokerage: { default: { mode: 'lot', amount: 10 }, byTrader: {} } } as ChargeRates
  const fills = [
    { instrument: 'share', side: 'Buy', qty: 1000, price: 2950, orderNo: 'S1', lotSize: 1 },
    { instrument: 'share', side: 'Buy', qty: 500, price: 2951, orderNo: 'S1', lotSize: 1 },
    { instrument: 'option', side: 'Sell', qty: 350, price: 45, orderNo: 'O1', lotSize: null },
    { instrument: 'future', side: 'Sell', qty: 350, price: 3010, orderNo: 'F1', lotSize: 175 },
  ] as const
  assert.equal(chargesFor(fills, r, 'asha').brokerage, 10 + 10 + 20)
})

test('a share fill: delivery STT on both sides and stamp on the buy', () => {
  const c = chargesFor([{ instrument: 'share', side: 'Buy', qty: 100, price: 3000, orderNo: 'S1', lotSize: 1 }], SEED_RATES, 'asha')
  close(c.stt, 300, 1e-9); close(c.exchange, 8.91, 1e-9); close(c.sebi, 0.3, 1e-12); close(c.stamp, 45, 1e-9)
  close(c.gst, (20 + 8.91 + 0.3) * 0.18, 1e-9)
})

test('a username that is an Object.prototype key falls back to the default', () => {
  for (const name of ['__proto__', 'constructor', 'tostring']) assert.deepEqual(brokerageFor(SEED_RATES, name), { mode: 'order', amount: 20 })
})

test('parseRates names the bad field and ignores confirmedBy', () => {
  assert.match((parseRates({ ...SEED_RATES, option: { ...SEED_RATES.option, sttSellPct: -1 } }) as { error: string }).error, /option\.sttSellPct/)
  assert.equal((parseRates({ ...SEED_RATES, confirmedBy: 'mallory' }) as ChargeRates).confirmedBy, null)
})

test('parseRates: a valid table round-trips; confirmedAt is dropped; unknown keys are ignored', () => {
  const r = { ...SEED_RATES, gstPct: 12, brokerage: { default: { mode: 'lot', amount: 15 }, byTrader: { asha: { mode: 'order', amount: 0 } } } } as ChargeRates
  assert.deepEqual(parseRates({ ...r, confirmedBy: 'admin', confirmedAt: 123, note: 'x', option: { ...r.option, extra: 1 } }), r)
})

test('parseRates: every limit, each error naming its field path', () => {
  const bad = (patch: Record<string, unknown>) => err(parseRates({ ...SEED_RATES, ...patch }))
  assert.match(bad({ option: { ...SEED_RATES.option, sttSellPct: 5.01 } }), /^option\.sttSellPct must be 0–5$/)
  assert.match(bad({ future: { ...SEED_RATES.future, exchangePct: Number.NaN } }), /^future\.exchangePct must be 0–5$/)
  assert.match(bad({ share: { ...SEED_RATES.share, stampBuyPct: Number.POSITIVE_INFINITY } }), /^share\.stampBuyPct must be 0–5$/)
  assert.match(bad({ share: { ...SEED_RATES.share, sttBuyPct: '0.1' } }), /^share\.sttBuyPct must be 0–5$/)
  assert.match(bad({ option: 'x' }), /^option must be an object$/)
  assert.match(bad({ sebiPerCrore: 1001 }), /^sebiPerCrore must be 0–1000$/)
  assert.match(bad({ gstPct: 90 }), /^gstPct must be 0–50$/)
  assert.match(bad({ brokerage: { default: { mode: 'trade', amount: 20 }, byTrader: {} } }), /^brokerage\.default\.mode must be 'order' or 'lot'$/)
  assert.match(bad({ brokerage: { default: { mode: 'order', amount: 10_001 }, byTrader: {} } }), /^brokerage\.default\.amount must be 0–10000$/)
  assert.match(bad({ brokerage: { default: { mode: 'order', amount: 20 }, byTrader: { asha: { mode: 'lot', amount: -1 } } } }), /^brokerage\.byTrader\.asha\.amount must be 0–10000$/)
  assert.match(bad({ brokerage: { default: { mode: 'order', amount: 20 }, byTrader: { Asha: { mode: 'lot', amount: 1 } } } }), /^brokerage\.byTrader: "Asha" is not a username/)
  assert.match(bad({ brokerage: { default: { mode: 'order', amount: 20 }, byTrader: { a: { mode: 'lot', amount: 1 } } } }), /^brokerage\.byTrader: "a" is not a username/)
  const many = Object.fromEntries(Array.from({ length: 101 }, (_, k) => [`t${k}`, { mode: 'order', amount: 1 }]))
  assert.match(bad({ brokerage: { default: { mode: 'order', amount: 20 }, byTrader: many } }), /^brokerage\.byTrader has more than 100 entries$/)
  assert.match(bad({ brokerage: { default: { mode: 'order', amount: 20 } } }), /^brokerage\.byTrader must be an object$/)
  assert.match(err(parseRates(null)), /^charges must be an object$/)
  assert.match(err(parseRates([])), /^charges must be an object$/)
  // the bounds themselves are allowed
  assert.equal('error' in (parseRates({ ...SEED_RATES, gstPct: 50, sebiPerCrore: 0, option: { ...SEED_RATES.option, sttSellPct: 5 } }) as object), false)
})

test('parseRates keeps a byTrader key named like an Object.prototype key as a plain entry', () => {
  const raw = JSON.parse('{"default":{"mode":"order","amount":20},"byTrader":{"__proto__":{"mode":"lot","amount":7}}}')
  const r = parseRates({ ...SEED_RATES, brokerage: raw }) as ChargeRates
  assert.equal(Object.getPrototypeOf(r.brokerage.byTrader), Object.prototype)
  assert.deepEqual(Object.keys(r.brokerage.byTrader), ['__proto__'])
  assert.deepEqual(brokerageFor(r, '__proto__'), { mode: 'lot', amount: 7 })
})
