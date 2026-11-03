/**
 * Real frames from Delta's public socket (read-only probe, 3 Nov 2026,
 * wss://public-socket.india.delta.exchange, C-BTC-77000-041126). The `ticker`
 * frame is COMPACT and nests the quote in `d[]`; spot and timestamp sit on the
 * envelope. The last line of the probe (its own message counts) is dropped.
 *
 * Greek order in `g` (delta, gamma, rho, theta, vega) is cross-checked
 * against the REST snapshot of the same product (161396) two hours earlier:
 * REST delta 0.4266 gamma 0.000197 rho 1.052 theta -326.4 vega 17.21.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parseFrame, parseFrames } from '../src/index.ts'

const frames = readFileSync(new URL('./fixtures/ws-frames-2026-11-03.jsonl', import.meta.url), 'utf8')
  .split('\n')
  .filter((l) => l.trim() !== '')
  .map((l) => JSON.parse(l) as Record<string, unknown>)
const ofType = (t: string) => frames.filter((f) => f['type'] === t)

test('fixture holds the real ticker, ob_l1 and mark_price frames', () => {
  assert.equal(ofType('ticker').length, 3)
  assert.equal(ofType('ob_l1').length, 3)
  assert.equal(ofType('mark_price').length, 3)
})

test('the real compact ticker parses to a full quote — nothing null that Delta sent', () => {
  const raw = ofType('ticker')[0]
  const f = parseFrame(raw)
  assert.equal(f.kind, 'ticker')
  if (f.kind !== 'ticker') return
  assert.deepEqual(f.quote, {
    symbol: 'C-BTC-77000-041126',
    productId: 161396,
    mark: 600.25957414,
    spot: 76787.8,
    ask: 606,
    askSize: 8588,
    bid: 601,
    bidSize: 13682,
    askIv: 0.41523297,
    bidIv: 0.41226959,
    iv: 0.41269936,
    oi: 16143,
    delta: 0.45721045,
    gamma: 0.00022595,
    rho: 1.05882959,
    theta: -310.86207846,
    vega: 16.87198841,
    tsMs: 1793696838633,
  })
})

test('every real ticker frame yields bid < ask and a mark between them', () => {
  for (const raw of ofType('ticker')) {
    const [f, ...rest] = parseFrames(raw)
    assert.equal(rest.length, 0)
    assert.ok(f && f.kind === 'ticker')
    const q = f.quote
    assert.ok(q.bid !== null && q.ask !== null && q.mark !== null)
    assert.ok(q.bid < q.ask)
    assert.ok(q.mark >= q.bid - 5 && q.mark <= q.ask + 5)
    assert.ok(q.delta !== null && q.delta > 0 && q.delta < 1, 'call delta')
    assert.ok(q.theta !== null && q.theta < 0, 'theta in slot 3')
  }
})

test('the compact quote agrees with the ob_l1 frame of the same moment', () => {
  // ticker 1793696843154422 quotes 605/8592 × 600/13665 — the ob_l1 frames read the same
  const f = parseFrame(ofType('ticker')[1])
  const l1 = parseFrame(ofType('ob_l1')[0])
  assert.ok(f.kind === 'ticker' && l1.kind === 'ob_l1')
  assert.equal(f.quote.ask, l1.ask)
  assert.equal(f.quote.askSize, l1.askSize)
  assert.equal(f.quote.bid, l1.bid)
  assert.equal(f.quote.bidSize, l1.bidSize)
})

test('the real ob_l1 frame parses', () => {
  assert.deepEqual(parseFrame(ofType('ob_l1')[0]), {
    kind: 'ob_l1', symbol: 'C-BTC-77000-041126', ask: 605, askSize: 8592, bid: 600, bidSize: 13665, tsMs: 1793696837646,
  })
})

test('the real mark_price frame parses, with the MARK: prefix stripped from the symbol', () => {
  assert.deepEqual(parseFrame(ofType('mark_price')[0]), {
    kind: 'mark', symbol: 'C-BTC-77000-041126', price: 601.35221224, tsMs: 1793696838626,
  })
})

test('a compact ticker with several symbols in d yields one quote per symbol', () => {
  const raw = ofType('ticker')[0] as { d: Record<string, unknown>[] } & Record<string, unknown>
  const first = raw.d[0]
  assert.ok(first)
  const multi = {
    ...raw,
    d: [first, { ...first, s: 'P-BTC-77000-041126', i: 161397, q: ['700', '10', '690', '20', null], sp: '76790.1' }],
  }
  const fs = parseFrames(multi)
  assert.equal(fs.length, 2)
  const [a, b] = fs
  assert.ok(a?.kind === 'ticker' && b?.kind === 'ticker')
  assert.equal(a.quote.symbol, 'C-BTC-77000-041126')
  assert.equal(b.quote.symbol, 'P-BTC-77000-041126')
  assert.equal(b.quote.productId, 161397)
  assert.equal(b.quote.bid, 690)
  assert.equal(b.quote.spot, 76790.1, 'an element\'s own sp wins over the envelope')
  assert.equal(a.quote.spot, 76787.8, 'else the envelope sp')
  assert.equal(b.quote.tsMs, 1793696838633, 'the envelope ts applies to every element')
})

test('a compact ticker with an empty d yields nothing, not a blank quote', () => {
  assert.deepEqual(parseFrames({ type: 'ticker', d: [], sy: 'X', ts: 1 }), [])
})
