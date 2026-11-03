/**
 * The manual-order dialog's arithmetic — dirty-tracking on the limit box,
 * placeability, the stale-chain guard, the execution copy and the idempotency
 * key. Runs under `node --test` (repo-root `npm run test:node`), like
 * `entry-plan.test.ts`: no DOM in here.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  chainForPair,
  classifyExposure,
  contractKey,
  deskBookNote,
  executionNote,
  manualClientOrderId,
  orderIdForPress,
  orderProblem,
  pairKey,
  prefillPrice,
  priceIsOperators,
  serverAnswered,
  unconfirmedText,
  type HeldLeg,
  type ManualOrderDraft,
  type OrderIdentity,
} from '../src/manual-order-plan.ts'

// ------------------------------------------------------------- prefillPrice

test('a fresh quote fills the box with a crossing limit', () => {
  // Same formula as entry-plan's suggestedLimit: a Buy at mark 28 crosses UP.
  const fill = prefillPrice({ dirty: false, side: 'Buy', quote: { price: 28, ageMs: 100 } })
  assert.deepEqual(fill, { price: '28.60', note: '' })
})

test('THE OPERATOR\'S NUMBER IS NEVER OVERWRITTEN once they have typed', () => {
  // The whole point of the dirty flag: a fresh quote arrives, a side flips —
  // and the box they priced off the depth is left exactly alone.
  const fill = prefillPrice({ dirty: true, side: 'Sell', quote: { price: 28, ageMs: 100 } })
  assert.equal(fill, null)
})

test('no quote clears the box and says why, rather than keeping a stale suggestion', () => {
  // A price suggested for the PREVIOUS strike must not sit under the new one:
  // it looks chosen and was never chosen for this contract.
  const fill = prefillPrice({ dirty: false, side: 'Buy', quote: null })
  assert.notEqual(fill, null)
  assert.equal(fill?.price, '')
  assert.match(fill?.note ?? '', /no quote yet/)
})

test('a stale quote is refused as a suggestion, with the age in the reason', () => {
  const fill = prefillPrice({ dirty: false, side: 'Buy', quote: { price: 28, ageMs: 120_000 } })
  assert.equal(fill?.price, '')
  assert.match(fill?.note ?? '', /too stale/)
})

test('the tick size is honoured when given', () => {
  // Tick 0.10: a Sell at 28 buffers 2% (0.56) and floors onto the 0.10 grid.
  const fill = prefillPrice({
    dirty: false, side: 'Sell', quote: { price: 28, ageMs: 100 }, tickSize: 0.1,
  })
  assert.deepEqual(fill, { price: '27.40', note: '' })
})

// -------------------------------------------------------------- orderProblem

const CONTRACT = { tradingsymbol: 'BHEL25AUG445CE', instrumentToken: 123 }
const META = { lotSize: 5250, tickSize: 0.05, exchange: 'NFO' }
const GOOD: ManualOrderDraft = { contract: CONTRACT, meta: META, lots: '2', price: '3.55' }

test('a complete draft has no problem', () => {
  assert.equal(orderProblem(GOOD), null)
})

test('no contract from the chain blocks Place — never a string-built symbol', () => {
  assert.match(orderProblem({ ...GOOD, contract: undefined }) ?? '', /strike/)
})

test('no instrument master blocks Place — lot and tick size cannot be guessed', () => {
  assert.match(orderProblem({ ...GOOD, meta: null }) ?? '', /instrument master/)
})

test('lots must be a whole number of at least 1', () => {
  assert.match(orderProblem({ ...GOOD, lots: '0' }) ?? '', /lots/)
  assert.match(orderProblem({ ...GOOD, lots: '1.5' }) ?? '', /lots/)
  assert.match(orderProblem({ ...GOOD, lots: '-2' }) ?? '', /lots/)
  assert.match(orderProblem({ ...GOOD, lots: '' }) ?? '', /lots/)
  assert.equal(orderProblem({ ...GOOD, lots: ' 3 ' }), null)
})

test('the limit price must be a positive number', () => {
  assert.match(orderProblem({ ...GOOD, price: '' }) ?? '', /limit price/)
  assert.match(orderProblem({ ...GOOD, price: '0' }) ?? '', /limit price/)
  assert.match(orderProblem({ ...GOOD, price: '-1' }) ?? '', /limit price/)
  assert.match(orderProblem({ ...GOOD, price: 'abc' }) ?? '', /limit price/)
})

// ------------------------------------------- the typed price and its contract

test('a typed price is the operator\'s only for the contract they typed it under', () => {
  const typed = contractKey('1070', 'CE')
  assert.equal(priceIsOperators(typed, '1070', 'CE'), true)
  // THE BUG THIS CLOSES: 3.55 chosen off 1070CE's depth, then the strike moves.
  // Nothing about that number describes 1080CE, so it is not theirs any more.
  assert.equal(priceIsOperators(typed, '1080', 'CE'), false)
  // Same strike, other option — two different contracts at one strike.
  assert.equal(priceIsOperators(typed, '1070', 'PE'), false)
  // Never typed at all: the suggestion owns the box.
  assert.equal(priceIsOperators(null, '1070', 'CE'), false)
})

test('moving the strike re-arms the suggestion IN THE SAME PASS, not a render later', () => {
  // The flag is derived from the selection rather than reset by an effect, so
  // the price for the new contract is computed off the fresh `dirty` at once —
  // no window in which the old strike's flag suppresses the new strike's quote
  // and leaves an empty box beside a perfectly good print.
  const typed = contractKey('1070', 'CE')
  const stillTheirs = prefillPrice({
    dirty: priceIsOperators(typed, '1070', 'CE'),
    side: 'Buy',
    quote: { price: 28, ageMs: 100 },
  })
  assert.equal(stillTheirs, null)

  const afterStrikeMove = prefillPrice({
    dirty: priceIsOperators(typed, '1080', 'CE'),
    side: 'Buy',
    quote: { price: 12, ageMs: 100 },
  })
  assert.deepEqual(afterStrikeMove, { price: '12.25', note: '' })
})

test('a SIDE flip leaves the operator\'s number alone — it is still their price', () => {
  // Deliberate asymmetry: realising you meant to sell what you priced does not
  // make the price someone else's, so only the CONTRACT is in the key.
  const typed = contractKey('1070', 'CE')
  assert.equal(priceIsOperators(typed, '1070', 'CE'), true)
  assert.equal(prefillPrice({ dirty: true, side: 'Sell', quote: { price: 28, ageMs: 100 } }), null)
})

// -------------------------------------------------------------- stale chains

test('a chain read is used ONLY for the pair it was fetched for', () => {
  const read = { pair: pairKey('BHEL', '2026-08-26'), chain: { rows: [{ strike: 445 }] } }
  assert.deepEqual(chainForPair(read, pairKey('BHEL', '2026-08-26')), read.chain)
})

test('THE WRONG-EXPIRY ORDER: the previous pair\'s strikes are not placeable', () => {
  // `usePoll` keeps its last good payload across a deps change. Before the tag
  // match, the August strikes stayed on screen and selectable after the
  // operator switched to September — and a press in that window routed the
  // AUGUST contract stamped with SEPTEMBER's lot size and exchange.
  const august = { pair: pairKey('BHEL', '2026-08-26'), chain: { rows: [{ strike: 445 }] } }
  assert.equal(chainForPair(august, pairKey('BHEL', '2026-09-30')), null)
  // A different SYMBOL at the same expiry is just as wrong.
  assert.equal(chainForPair(august, pairKey('SBIN', '2026-08-26')), null)
})

test('no read yet reads as loading, never as an empty chain', () => {
  // null means "still loading" to the dialog, which shows the Selector's
  // spinner. An empty rows array would say "this pair has no strikes".
  assert.equal(chainForPair(null, pairKey('BHEL', '2026-08-26')), null)
  assert.equal(chainForPair(undefined, pairKey('BHEL', '2026-08-26')), null)
})

test('the pair key separates symbol from expiry', () => {
  assert.equal(pairKey('BHEL', '2026-08-26'), 'BHEL|2026-08-26')
})

// ------------------------------------------------------------ execution copy

test('Immediate says the chaser will move the price', () => {
  assert.match(executionNote('live', 'Immediate'), /chases/)
  assert.match(executionNote('paper', 'Immediate'), /chases/)
})

test('a LIVE resting order sits at the operator\'s price and is never repriced', () => {
  assert.match(executionNote('live', 'Resting'), /sits at your price/)
  assert.match(executionNote('live', 'Resting'), /never repriced/)
})

test('PAPER SAYS RESTING IS A LIVE BEHAVIOUR — the paper rail fills it instantly', () => {
  // `PaperRail` books every order the moment it routes, at the operator's
  // limit. Telling them it "sits until it trades" here would teach a behaviour
  // they would then expect from the rail that can actually cost money.
  const note = executionNote('paper', 'Resting')
  assert.match(note, /LIVE-rail behaviour/)
  assert.match(note, /IMMEDIATELY/)
  assert.doesNotMatch(note, /sits at your price/)
})

// ------------------------------------------------ the desk-book explainer

test('an IMMEDIATE fill is promised adoption by the supervisor', () => {
  for (const mode of ['live', 'paper']) {
    const note = deskBookNote(mode, 'Immediate')
    assert.match(note, /the leg joins the book/)
    assert.match(note, /adopts it on its next tick/)
  }
})

test('A LIVE RESTING ORDER IS PROMISED NOTHING — the fill joins no book', () => {
  // The plumbing does not exist: a resting order's eventual fill reaches
  // desk-fills and the Broker page and stops there — no desk-decisions record,
  // no book leg, no adoption. Promising adoption here is how an operator ends
  // up with a broker position their book does not hold, believing it managed.
  const note = deskBookNote('live', 'Resting')
  assert.match(note, /does NOT join this book/)
  assert.match(note, /Use Immediate for a leg the supervisor should manage/)
  assert.doesNotMatch(note, /adopts it on its next tick/)
})

test('A PAPER RESTING ORDER JOINS THE BOOK — it filled at the limit as it routed', () => {
  // `submit.ts:restsUnbooked` books a paper resting order like any other fill.
  // The old live-rail warning here was the half of the TCS incident
  // (2026-10-19) an operator could read: it spoke of legs, not of closes.
  const note = deskBookNote('paper', 'Resting')
  assert.match(note, /fills at your limit/)
  assert.match(note, /the leg joins the book/)
  assert.doesNotMatch(note, /does NOT join this book/)
})

// --------------------------------------------------- exit, or a new leg

const HELD_SYMBOL = 'BHEL25AUG445CE'
const leg = (tradingsymbol: string, qty: number): HeldLeg => ({
  instrument: { tradingsymbol },
  qty,
})

test('a BUY against a SHORT leg reduces it, and says which leg', () => {
  const intent = classifyExposure({
    legs: [leg(HELD_SYMBOL, -5250)],
    tradingsymbol: HELD_SYMBOL,
    side: 'Buy',
  })
  assert.equal(intent?.kind, 'reduces')
  assert.match(intent?.text ?? '', /Reduces the book’s BHEL25AUG445CE leg \(qty -5250\)/)
})

test('a SELL against a LONG leg reduces it too — the sign is what decides', () => {
  const intent = classifyExposure({
    legs: [leg(HELD_SYMBOL, 5250)],
    tradingsymbol: HELD_SYMBOL,
    side: 'Sell',
  })
  assert.equal(intent?.kind, 'reduces')
  assert.match(intent?.text ?? '', /qty 5250/)
})

test('THE PHANTOM SHORT: a SELL on a contract the book does not hold ADDS a leg', () => {
  /**
   * The defect this exists for. The dialog sent no `reducesExposure`, so the
   * bridge read every manual order as an `open` — and since `fefe922b` an open
   * on an unheld contract CREATES a leg. An operator selling what they believed
   * was an exit, on a strike the book turned out not to hold, booked a phantom
   * SHORT that the supervisor then adopted and eventually flattened for real.
   */
  const intent = classifyExposure({
    legs: [leg('BHEL25AUG450CE', -5250)],
    tradingsymbol: HELD_SYMBOL,
    side: 'Sell',
  })
  assert.equal(intent?.kind, 'adds')
  assert.match(intent?.text ?? '', /ADDS a new Sell leg to the book/)
  assert.match(intent?.text ?? '', /managed by the supervisor/)
})

test('an order EXTENDING the same direction adds, however much is already held', () => {
  const intent = classifyExposure({
    legs: [leg(HELD_SYMBOL, -5250)],
    tradingsymbol: HELD_SYMBOL,
    side: 'Sell',
  })
  assert.equal(intent?.kind, 'adds')
  assert.match(intent?.text ?? '', /ADDS a new Sell leg/)
})

test('an EMPTY book adds — it is read, and it holds nothing', () => {
  assert.equal(classifyExposure({ legs: [], tradingsymbol: HELD_SYMBOL, side: 'Buy' })?.kind, 'adds')
})

test('legs on ONE contract are NETTED, never judged one at a time', () => {
  // A book legally holds the same contract on several legs. The flag answers a
  // question about EXPOSURE, so 300 short against 100 long is a 200 short and a
  // further Sell adds to it — whatever order the bridge's fold walks them in.
  const legs = [leg(HELD_SYMBOL, -300), leg(HELD_SYMBOL, 100), leg('BHEL25AUG450CE', 900)]
  assert.equal(classifyExposure({ legs, tradingsymbol: HELD_SYMBOL, side: 'Sell' })?.kind, 'adds')
  const buy = classifyExposure({ legs, tradingsymbol: HELD_SYMBOL, side: 'Buy' })
  assert.equal(buy?.kind, 'reduces')
  assert.match(buy?.text ?? '', /qty -200/)
})

test('a book that NETS FLAT on this contract adds — there is nothing to reduce', () => {
  const legs = [leg(HELD_SYMBOL, -300), leg(HELD_SYMBOL, 300)]
  assert.equal(classifyExposure({ legs, tradingsymbol: HELD_SYMBOL, side: 'Buy' })?.kind, 'adds')
})

test('NOTHING IS CLAIMED before the book is read, or before a strike is picked', () => {
  // Null is "cannot say": the dialog shows no line and sends no flag, so the
  // order is treated as an open exactly as it always was. A default of
  // "reduces" would be a kill-switch bypass derived from a failed fetch.
  assert.equal(classifyExposure({ legs: null, tradingsymbol: HELD_SYMBOL, side: 'Sell' }), null)
  assert.equal(classifyExposure({ legs: [], tradingsymbol: undefined, side: 'Sell' }), null)
})

// ------------------------------------------------------- manualClientOrderId

test('the client order id carries tag, mode, contract and the press time', () => {
  assert.equal(
    manualClientOrderId('BHEL-2026-08-26-recenter-r', 'live', 'BHEL25AUG445CE', 1755500000000),
    'manual:BHEL-2026-08-26-recenter-r:live:BHEL25AUG445CE:1755500000000',
  )
})

// -------------------------------------------------- one press, one order id

const IDENTITY: OrderIdentity = {
  tag: 'BHEL-2026-08-26-recenter-r',
  mode: 'live',
  tradingsymbol: 'BHEL25AUG445CE',
  side: 'Buy',
  lots: '2',
  price: '3.55',
  resting: false,
}

test('a first press mints an id stamped with the press time', () => {
  const press = orderIdForPress(null, IDENTITY, 1755500000000)
  assert.equal(press.retry, false)
  assert.equal(press.clientOrderId, 'manual:BHEL-2026-08-26-recenter-r:live:BHEL25AUG445CE:1755500000000')
})

test('THE DOUBLE-ORDER BUG: re-pressing an unconfirmed order REUSES its id', () => {
  // The transport dropped; the order may be at the broker. The natural response
  // is to press Place again — under the SAME id `desk-submissions` replays the
  // original outcome instead of routing a second lot.
  const first = orderIdForPress(null, IDENTITY, 1755500000000)
  const again = orderIdForPress(first, IDENTITY, 1755500009999)
  assert.equal(again.clientOrderId, first.clientOrderId)
  assert.equal(again.retry, true)
})

test('EVERY field of the draft is part of the identity — an edit is a new order', () => {
  const first = orderIdForPress(null, IDENTITY, 1755500000000)
  const edits: readonly OrderIdentity[] = [
    { ...IDENTITY, tag: 'OTHER-TAG' },
    { ...IDENTITY, mode: 'paper' },
    { ...IDENTITY, tradingsymbol: 'BHEL25AUG450CE' },
    { ...IDENTITY, side: 'Sell' },
    { ...IDENTITY, lots: '3' },
    { ...IDENTITY, price: '3.60' },
    { ...IDENTITY, resting: true },
  ]
  for (const edit of edits) {
    const next = orderIdForPress(first, edit, 1755500009999)
    // A replay under an edited draft would answer with the OLD order's outcome
    // while the screen shows the new one's numbers.
    assert.equal(next.retry, false, `${JSON.stringify(edit)} must not replay`)
    assert.notEqual(next.clientOrderId, first.clientOrderId)
  }
})

test('lots and price compare AS TYPED — the boxes, not what they parse to', () => {
  // '2' and '2 ' both place two lots, but they are not the same thing on
  // screen, and an id must never be reused across a press the operator edited.
  const first = orderIdForPress(null, IDENTITY, 1755500000000)
  assert.equal(orderIdForPress(first, { ...IDENTITY, lots: '2 ' }, 1755500009999).retry, false)
  assert.equal(orderIdForPress(first, { ...IDENTITY, price: '3.550' }, 1755500009999).retry, false)
})

// ---------------------------------------------- did the server actually answer

test('a 4xx is DEFINITIVE — the desk read the request and refused it', () => {
  // Nothing routed, so the id is spent and the next press is a new order.
  assert.equal(serverAnswered({ status: 400 }), true)
  assert.equal(serverAnswered({ status: 401 }), true)
  assert.equal(serverAnswered({ status: 499 }), true)
})

test('EVERYTHING ELSE IS UNKNOWN — timeout, dropped socket, 5xx', () => {
  // The client's own timeout, whose message already says the request may still
  // be executing.
  assert.equal(serverAnswered({ status: 0 }), false)
  // A bare fetch failure carries no status at all.
  assert.equal(serverAnswered(new TypeError('Failed to fetch')), false)
  // A 5xx may have routed and lost the response — the desk's routing loop
  // refuses to turn a bookkeeping failure into a 500 for exactly this reason.
  assert.equal(serverAnswered({ status: 500 }), false)
  assert.equal(serverAnswered({ status: 502 }), false)
  // Nothing that could carry a status.
  assert.equal(serverAnswered(null), false)
  assert.equal(serverAnswered('boom'), false)
  assert.equal(serverAnswered({ status: '400' }), false)
})

test('the unconfirmed banner never claims the order was not placed', () => {
  const text = unconfirmedText('the desk did not respond in time')
  assert.match(text, /the desk did not respond in time/)
  assert.match(text, /pressing Place again retries the SAME order safely/)
  assert.doesNotMatch(text, /Not placed/)
})
