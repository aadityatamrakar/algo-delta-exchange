import { test } from 'node:test'
import assert from 'node:assert/strict'
import { crossPrice, pegPrice } from '../src/order-chaser.ts'
import { DWELL, NOW, SYMBOL, harness, orderDoc } from './chaser-harness.ts'

/**
 * PEG MODE — a passive order joins the touch and follows it by atomic MODIFY.
 *
 * The blind ladder these extend (`order-chaser.test.ts`) crosses the spread by
 * construction: it escalates through the original limit until the order fills,
 * paying the spread on every desk action. Passive working is the opposite bet
 * — rest AT the touch, follow it while it moves, and cross ONCE, at the
 * deadline, when the fill has become worth more than the tick.
 *
 * So what these assert is again restraint, but of a different kind: never a
 * modify off a stale book, never one inside the dwell, never one worse than
 * the bound, never a second crossing, and never — under any failure of the
 * feed — a silent fall back to the blind ladder that would cross immediately.
 */

const TOKEN = 12345
/** Placed 5s ago: past the 1s peg dwell, well inside the 30s cross deadline. */
const PLACED = NOW - 5_000

/** A passive SELL resting at its own ask, 10.00, on a doc the peg can work. */
const passiveDoc = (over: Record<string, unknown> = {}): Record<string, unknown> =>
  orderDoc({
    placedAt: PLACED,
    transaction_type: 'SELL',
    limitPrice: 10,
    workMode: 'passive',
    instrument_token: TOKEN,
    tickSize: 0.05,
    ...over,
  })

/** A two-sided frame, timestamped now unless told otherwise. */
function book(h: ReturnType<typeof harness>, bid: number, ask: number, ts = h.clock.now): void {
  h.quotes.onTick({ token: TOKEN, price: (bid + ask) / 2, ts, bid, ask })
}

// ------------------------------------------------------------ the arithmetic

test('pegPrice JOINS the touch and never crosses it by rounding', () => {
  const cfg = { limitPrice: 10, crossBufferPct: 0.005, tickSize: 0.05 }
  // A sell rests at the ASK, a buy at the BID — the passive side of the book.
  assert.equal(pegPrice('SELL', { bid: 9.9, ask: 10.1 }, cfg), 10.1)
  assert.equal(pegPrice('BUY', { bid: 9.9, ask: 10.1 }, cfg), 9.9)
  // Rounding is directional AWAY from the spread — a sell rounds UP onto the
  // grid, a buy DOWN — so a quote off the grid can never round the order INTO
  // a cross it did not ask for. (Exchange quotes are already on the grid; this
  // is what protects a malformed frame from becoming an aggressive order.)
  const tenPaisa = { limitPrice: 10, crossBufferPct: 0.005, tickSize: 0.1 }
  assert.equal(pegPrice('SELL', { bid: 9.93, ask: 10.13 }, tenPaisa), 10.2)
  assert.equal(pegPrice('BUY', { bid: 9.93, ask: 10.13 }, tenPaisa), 9.9)
})

test('pegPrice is BOUNDED by the original limit ± the cross buffer', () => {
  const cfg = { limitPrice: 10, crossBufferPct: 0.005, tickSize: 0.05 }
  // The ask collapses to 9.00. Following it would sell 10% under the price the
  // desk chose; the bound stops at 10 x (1 - 0.005) = 9.95.
  assert.equal(pegPrice('SELL', { bid: 8.9, ask: 9 }, cfg), 9.95)
  // ...and symmetrically, a buy does not follow a bid running away upward.
  assert.equal(pegPrice('BUY', { bid: 11, ask: 11.1 }, cfg), 10.05)
})

test('crossPrice reaches THROUGH the touch by the buffer, directionally rounded', () => {
  const cfg = { crossBufferPct: 0.005, tickSize: 0.05 }
  // A sell crosses to the BID — the side it can actually fill against —
  // 9.90 x 0.995 = 9.8505, floored onto the grid.
  assert.equal(crossPrice('SELL', { bid: 9.9, ask: 10 }, cfg), 9.85)
  // A buy crosses to the ASK: 10 x 1.005 = 10.05, ceiled.
  assert.equal(crossPrice('BUY', { bid: 9.9, ask: 10 }, cfg), 10.05)
  // A cross that would price at or below zero clamps to one tick, as the blind
  // ladder does — the aggressive-but-legal price is the useful one.
  assert.equal(crossPrice('SELL', { bid: 0.05, ask: 0.1 }, cfg), 0.05)
})

test('both refuse an unusable touch rather than inventing a price', () => {
  const cfg = { limitPrice: 10, crossBufferPct: 0.005, tickSize: 0.05 }
  // The side each mode ACTUALLY uses is the one that has to be real — a sell
  // joining the ask does not care what the bid is, and the QuoteMap has
  // already refused any frame where either side was missing.
  assert.equal(pegPrice('SELL', { bid: 9.9, ask: NaN }, cfg), null)
  assert.equal(pegPrice('BUY', { bid: 0, ask: 10 }, cfg), null)
  assert.equal(pegPrice('SELL', { bid: 9.9, ask: 10 }, { ...cfg, limitPrice: 0 }), null)
  assert.equal(crossPrice('SELL', { bid: -1, ask: 10 }, { crossBufferPct: 0.005, tickSize: 0.05 }), null)
})

// -------------------------------------------------------------- the pegging

test('a passive SELL already AT the touch is left alone, then follows it up one tick later', async () => {
  const h = harness({ docs: [passiveDoc()] })
  book(h, 9.95, 10)
  await h.run()
  assert.deepEqual(h.modifies, [], 'the order already rests at the ask — nothing to say to the broker')

  // The ask lifts to 10.10. One modify, at the touch, off the ATOMIC path.
  h.clock.now = NOW + 2_000
  book(h, 10.05, 10.1)
  await h.run()
  assert.deepEqual(h.modifies, [{ brokerOrderId: '987', price: 10.1 }])
  assert.equal(h.orders.docs[0]?.['lastChasePrice'], 10.1)
  assert.equal(h.orders.docs[0]?.['chasedAt'], NOW + 2_000)
  assert.equal(h.orders.docs[0]?.['chaseAttempts'], 1)
  // Quiet: a peg working as designed is progress, not an incident.
  assert.equal(h.events.length, 1)
  assert.equal(h.events[0]?.ok, true)
  assert.match(String(h.events[0]?.detail?.['note']), /peg: repriced to 10\.1/)
})

test('a touch that flickers inside the dwell moves NOTHING', async () => {
  // 10.00 -> 10.05 -> 10.00 in under a second is noise, and a modify per
  // flicker is a broker rate-limit incident, not a chase.
  const h = harness({ docs: [passiveDoc({ placedAt: NOW })] })
  book(h, 9.95, 10)
  await h.run()

  h.clock.now = NOW + 400
  book(h, 10, 10.05)
  await h.run()
  h.clock.now = NOW + 800
  book(h, 9.95, 10)
  await h.run()
  assert.deepEqual(h.modifies, [])
  assert.equal(h.orders.docs[0]?.['chaseAttempts'], undefined)

  // Past the dwell the touch is back where it started: still nothing to do.
  h.clock.now = NOW + 1_001
  await h.run()
  assert.deepEqual(h.modifies, [])
})

test('a move smaller than one tick is not a move', async () => {
  // An order resting at 10.02 with the ask at 10.04: the join rounds to 10.05,
  // three paisa away on a five-paisa grid. That is a broker round-trip for
  // less than a tick of edge, so it does not happen.
  const h = harness({ docs: [passiveDoc({ limitPrice: 10.02 })] })
  book(h, 9.9, 10.04)
  await h.run()
  assert.deepEqual(h.modifies, [])

  // A whole tick away, and it moves.
  h.clock.now = NOW + 2_000
  book(h, 10, 10.07)
  await h.run()
  assert.deepEqual(h.modifies, [{ brokerOrderId: '987', price: 10.1 }])
})

test('each peg waits its OWN dwell — the touch may run, the order does not', async () => {
  const h = harness({ docs: [passiveDoc()], pegDwellMs: 1_000 })
  book(h, 10.05, 10.1)
  await h.run()
  assert.equal(h.modifies.length, 1)

  h.clock.now = NOW + 999
  book(h, 10.15, 10.2)
  await h.run()
  assert.equal(h.modifies.length, 1, 'inside the dwell, however far the touch has run')

  h.clock.now = NOW + 1_001
  await h.run()
  assert.deepEqual(h.modifies[1], { brokerOrderId: '987', price: 10.2 })
})

test('the peg is BOUNDED — it does not follow a book falling away from the desk’s price', async () => {
  const h = harness({ docs: [passiveDoc()] })
  book(h, 8.9, 9)
  await h.run()
  // 10 x (1 - 0.005), not the 9.00 ask.
  assert.deepEqual(h.modifies, [{ brokerOrderId: '987', price: 9.95 }])

  // The book keeps falling; the order does not.
  h.clock.now = NOW + 2_000
  book(h, 7.9, 8)
  await h.run()
  assert.equal(h.modifies.length, 1)
})

test('a passive BUY joins the bid, bounded above', async () => {
  const h = harness({
    docs: [passiveDoc({ clientOrderId: 'ord-buy', transaction_type: 'BUY' })],
  })
  book(h, 9.9, 10)
  await h.run()
  assert.deepEqual(h.modifies, [{ brokerOrderId: '987', price: 9.9 }])

  // A bid running up past the bound stops at 10 x 1.005.
  h.clock.now = NOW + 2_000
  book(h, 10.4, 10.5)
  await h.run()
  assert.deepEqual(h.modifies[1], { brokerOrderId: '987', price: 10.05 })
})

test('the doc’s own tickSize governs the grid, not the NFO default', async () => {
  const h = harness({ docs: [passiveDoc({ tickSize: 0.1 })] })
  // A 10.13 ask on a 10-paisa grid rests at 10.20 — up, away from the spread.
  book(h, 9.93, 10.13)
  await h.run()
  assert.deepEqual(h.modifies, [{ brokerOrderId: '987', price: 10.2 }])
})

test('every live tranche of the doc pegs to the same price', async () => {
  const h = harness({
    docs: [passiveDoc({ brokerOrderIds: ['987', '988'] })],
    fillRows: [{ brokerOrderId: '988', status: 'WORKING' }],
  })
  book(h, 10.05, 10.1)
  await h.run()
  assert.deepEqual(h.modifies, [
    { brokerOrderId: '987', price: 10.1 },
    { brokerOrderId: '988', price: 10.1 },
  ])
})

// ------------------------------------------------------------- never a guess

test('a STALE book pauses the peg — no modify, and no attempt consumed', async () => {
  const h = harness({ docs: [passiveDoc()] })
  // A book from 20s ago, past the 15s max age. The feed is behind; the last
  // spread it showed is not where the market is.
  book(h, 10.05, 10.1, NOW - 20_000)
  await h.run()
  assert.deepEqual(h.modifies, [])
  assert.deepEqual(h.events, [])
  assert.equal(h.orders.docs[0]?.['chaseAttempts'], undefined)

  // A fresh frame and the peg resumes exactly where it left off.
  book(h, 10.05, 10.1)
  await h.run()
  assert.deepEqual(h.modifies, [{ brokerOrderId: '987', price: 10.1 }])
})

test('an LTP-only feed never pegs — a trade print is not a book', async () => {
  const h = harness({ docs: [passiveDoc()] })
  h.quotes.onTick({ token: TOKEN, price: 10.4, ts: h.clock.now })
  await h.run()
  assert.deepEqual(h.modifies, [])
})

test('a passive order NEVER falls back to the blind ladder when the feed is missing', async () => {
  // THE POINT OF THE WHOLE TICKET: with no quote map wired, or no tick for
  // this token, the blind ladder would cross the spread within one dwell. A
  // passive order that cannot see the touch rests and waits instead — the
  // broker sweep's WORKING alert (F-17) is what tells a human.
  for (const h of [harness({ docs: [passiveDoc()], noQuotes: true }), harness({ docs: [passiveDoc()] })]) {
    h.clock.now = NOW + DWELL + 1
    await h.run()
    h.clock.now = NOW + 3 * DWELL
    await h.run()
    assert.deepEqual(h.modifies, [])
    assert.deepEqual(h.events, [])
    assert.equal(h.orders.docs[0]?.['chaseAttempts'], undefined)
  }
})

test('a doc with no instrument_token is not pegged off some other token’s book', async () => {
  const h = harness({ docs: [passiveDoc({ instrument_token: undefined })] })
  book(h, 10.05, 10.1)
  await h.run()
  assert.deepEqual(h.modifies, [])
})

// ------------------------------------------------------- crossing, once, last

test('at the deadline it crosses ONCE at the touch through the buffer, then hands over', async () => {
  const h = harness({ docs: [passiveDoc({ placedAt: NOW - 31_000 })] })
  book(h, 9.9, 10)
  await h.run()
  // 9.90 x (1 - 0.005) = 9.8505 -> 9.85 on the grid. A LIMIT past the touch
  // fills AT the touch, so the buffer is a reach, not a price given away.
  assert.deepEqual(h.modifies, [{ brokerOrderId: '987', price: 9.85 }])
  assert.equal(h.orders.docs[0]?.['pegCrossedAt'], NOW)
  assert.equal(h.orders.docs[0]?.['lastChasePrice'], 9.85)
  assert.match(String(h.events[0]?.detail?.['note']), /peg deadline: crossed to 9\.85/)
  assert.equal(h.events.filter((e) => e.ok === false).length, 0, 'not an alert yet — it may still fill')

  // The crossing price gets the same dwell every other rung gets before the
  // order is declared stuck: alerting a second after a marketable modify would
  // send a human after an order that filled while they read the message.
  h.clock.now = NOW + 5_000
  book(h, 9.8, 9.9)
  await h.run()
  assert.equal(h.modifies.length, 1, 'ONE cross, whatever the touch does next')
  assert.equal(h.orders.docs[0]?.['chaseExhaustedAt'], undefined)

  h.clock.now = NOW + DWELL + 1
  await h.run()
  assert.equal(h.modifies.length, 1)
  const loud = h.events.filter((e) => e.ok === false)
  assert.equal(loud.length, 1)
  assert.ok(String(loud[0]?.error).includes(SYMBOL))
  assert.match(String(loud[0]?.error), /last accepted reprice 9\.85/)
  assert.equal(h.notified.length, 1)
  assert.equal(h.orders.docs[0]?.['chaseExhaustedAt'], NOW + DWELL + 1)

  // Stamped once, silent after — the doc is a human's now.
  h.clock.now = NOW + 60_000
  await h.run()
  assert.equal(h.events.filter((e) => e.ok === false).length, 1)
})

test('a cross the broker REFUSED is retried, not counted as the one cross', async () => {
  let accept = false
  const h = harness({
    docs: [passiveDoc({ placedAt: NOW - 31_000 })],
    modifyResult: () => accept,
  })
  book(h, 9.9, 10)
  await h.run()
  assert.equal(h.modifies.length, 1)
  assert.equal(h.orders.docs[0]?.['pegCrossedAt'], undefined, 'a refusal never reached the exchange')
  assert.deepEqual(h.events, [])

  accept = true
  h.clock.now = NOW + 2_000
  await h.run()
  assert.equal(h.modifies.length, 2)
  assert.equal(h.orders.docs[0]?.['pegCrossedAt'], NOW + 2_000)
})

test('a cross that FILLED exhausts silently — nobody is sent after an order that is gone', async () => {
  const h = harness({
    docs: [passiveDoc({ placedAt: NOW - 31_000, pegCrossedAt: NOW - 20_000, lastChasePrice: 9.85 })],
    fillRows: [{ brokerOrderId: '987', status: 'FILLED' }],
  })
  book(h, 9.9, 10)
  await h.run()
  assert.deepEqual(h.modifies, [])
  assert.deepEqual(h.events, [])
  assert.equal(h.orders.docs[0]?.['chaseExhaustedAt'], undefined)
})

test('the deadline with a STALE book crosses NOTHING — it will not guess a price to pay', async () => {
  const h = harness({ docs: [passiveDoc({ placedAt: NOW - 31_000 })] })
  book(h, 9.9, 10, NOW - 20_000)
  await h.run()
  assert.deepEqual(h.modifies, [])
  assert.deepEqual(h.events, [])
  assert.equal(h.orders.docs[0]?.['pegCrossedAt'], undefined)
  assert.ok(h.logs.some((l) => l.includes('touch is stale')))

  // Said ONCE. The condition is re-evaluated every pass, and a feed outage
  // lasting an hour must not put 700 identical lines on the console.
  h.clock.now = NOW + 5_000
  await h.run()
  h.clock.now = NOW + 10_000
  await h.run()
  assert.equal(h.logs.filter((l) => l.includes('touch is stale')).length, 1)
})

test('the doc’s own chase_max_ms and cross buffer are what govern it', async () => {
  const h = harness({
    docs: [passiveDoc({ placedAt: NOW - 6_000, chaseMaxMs: 5_000, chaseCrossBufferPct: 0.02 })],
  })
  book(h, 9.9, 10)
  await h.run()
  // Deadline at 5s (not 30s), buffer 2% (not 0.5%): 9.90 x 0.98 = 9.702 -> 9.70.
  assert.deepEqual(h.modifies, [{ brokerOrderId: '987', price: 9.7 }])
})

// ------------------------------------------------- what peg mode does NOT change

test('resting:true beats workMode passive — the operator’s price is untouchable', async () => {
  const h = harness({ docs: [passiveDoc({ resting: true })] })
  book(h, 10.05, 10.1)
  await h.run()
  assert.deepEqual(h.modifies, [])
  assert.deepEqual(h.events, [])
})

test('a pending cancel suppresses the peg too — cancel wins everywhere', async () => {
  const h = harness({
    docs: [passiveDoc({ brokerOrderIds: ['987', '988'] })],
    cancels: [{ _id: '988', status: 'pending' }],
  })
  book(h, 10.05, 10.1)
  await h.run()
  assert.deepEqual(h.modifies, [])
  assert.deepEqual(h.events, [])
  assert.ok(h.logs.some((l) => l.includes('cancel wins')))
})

test('a pre-boot passive doc is still never touched — the deploy gate precedes peg mode', async () => {
  const h = harness({ docs: [passiveDoc({ placedAt: NOW - 3_700_000 })] })
  book(h, 10.05, 10.1)
  await h.run()
  assert.deepEqual(h.modifies, [])
})

test('the BLIND ladder ignores the touch entirely — a non-passive doc is unchanged', async () => {
  // Same fresh book, three docs the peg must not claim: no workMode at all,
  // an explicit urgent, and an unrecognised value. All three escalate blindly
  // off the original limit of 100 — 97, exactly as before peg mode existed.
  const h = harness({
    docs: [
      orderDoc({ instrument_token: TOKEN }),
      orderDoc({ clientOrderId: 'ord-2', brokerOrderIds: ['988'], workMode: 'urgent', instrument_token: TOKEN }),
      orderDoc({ clientOrderId: 'ord-3', brokerOrderIds: ['989'], workMode: 'PASSIVE', instrument_token: TOKEN }),
    ],
  })
  book(h, 10.05, 10.1)
  await h.run()
  assert.deepEqual(h.modifies, [
    { brokerOrderId: '987', price: 97 },
    { brokerOrderId: '988', price: 97 },
    { brokerOrderId: '989', price: 97 },
  ])
})

test('a passive doc is exempt from the blind ladder’s attempt ceiling', async () => {
  // The blind ladder exhausts after `maxAttempts` accepted reprices; a peg is
  // bounded by the DEADLINE instead, because following a touch for 30s is
  // normal and being handed to a human for doing so is not.
  const h = harness({ docs: [passiveDoc({ chaseAttempts: 9 })] })
  book(h, 10.05, 10.1)
  await h.run()
  assert.deepEqual(h.modifies, [{ brokerOrderId: '987', price: 10.1 }])
  assert.equal(h.events.filter((e) => e.ok === false).length, 0)
})

test('the disabled flag and a modify-less adapter stop the peg as well', async () => {
  const off = harness({ docs: [passiveDoc()], disabled: () => true })
  book(off, 10.05, 10.1)
  await off.run()
  assert.deepEqual(off.modifies, [])

  const noModify = harness({ docs: [passiveDoc()], canModify: false })
  book(noModify, 10.05, 10.1)
  await noModify.run()
  assert.deepEqual(noModify.modifies, [])
})
