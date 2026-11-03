import { test } from 'node:test'
import assert from 'node:assert/strict'
import { planSubscriptions, type SubscriptionResolver, type BookLike } from '../src/subscription-source.ts'

const STRIKES = [380, 405, 410, 415, 420, 425, 430, 470]

const FUTURE_TOKEN = 999888

const resolver = (opts: { spot?: number | null; future?: number | null } = {}): SubscriptionResolver => ({
  spotToken: () => (opts.spot === undefined ? 112129 : opts.spot),
  strikes: () => STRIKES,
  resolve: (_u, _e, strike, type) =>
    STRIKES.includes(strike) ? { instrumentToken: strike * 10 + (type === 'CE' ? 1 : 2) } : null,
  // Defaults to null (no future) so the many existing tests above, which count
  // exact token totals, are unaffected — only the tests about the future
  // itself opt in.
  futureToken: () => (opts.future === undefined ? null : opts.future),
})

const book = (symbol: string, tokens: number[]): BookLike => ({
  symbol,
  expiry: '2026-08-25',
  legs: tokens.map((t) => ({ instrument: { instrumentToken: t }, expiry: '2026-08-25' })),
})

test('every open leg plus the spot token is subscribed', () => {
  const plan = planSubscriptions({
    books: [book('BHEL', [111, 222, 333])],
    resolver: resolver(),
  })
  assert.equal(plan.tokens.length, 4)
  assert.ok(plan.tokens.includes(112129), 'spot must always be present')
  assert.equal(plan.spotTokens.get(112129), 'BHEL')
  assert.equal(plan.missingSpot.length, 0)
})

test('an underlying with NO spot instrument is NAMED, not silently smaller', () => {
  // Without spot, every greek for that book is uncomputable and it reports no
  // delta at all — a condition an operator has to see.
  const plan = planSubscriptions({
    books: [book('BHEL', [111])],
    resolver: resolver({ spot: null }),
  })
  assert.deepEqual(plan.missingSpot, ['BHEL'])
  assert.deepEqual(plan.tokens, [111])
})

test('several books on the same underlying share one spot subscription', () => {
  const plan = planSubscriptions({
    books: [book('BHEL', [111]), book('BHEL', [222])],
    resolver: resolver(),
  })
  assert.equal(plan.tokens.filter((t) => t === 112129).length, 1)
  assert.equal(plan.tokens.length, 3)
})

test('duplicate legs across books are deduplicated', () => {
  const plan = planSubscriptions({
    books: [book('BHEL', [111, 222]), book('BHEL', [222, 333])],
    resolver: resolver(),
  })
  assert.equal(plan.tokens.length, 4) // spot + 111 + 222 + 333
})

test('the roll window walks the LISTED grid around spot', () => {
  const plan = planSubscriptions({
    books: [book('BHEL', [111])],
    resolver: resolver(),
    rollWindow: 1,
    spotPrices: new Map([['BHEL', 417]]),
  })
  // Nearest listed to 417 is 415; one each side gives 410, 415, 420.
  for (const strike of [410, 415, 420]) {
    assert.ok(plan.tokens.includes(strike * 10 + 1), `missing ${strike}CE`)
    assert.ok(plan.tokens.includes(strike * 10 + 2), `missing ${strike}PE`)
  }
  assert.ok(!plan.tokens.includes(4301), '430 is two strikes away and outside the window')
})

test('fullChain subscribes EVERY listed strike of the traded expiry', () => {
  // Verified live: with only a window, an action opening a strike outside it is
  // skipped as "no mark" and the desk cannot open that leg at all.
  const plan = planSubscriptions({
    books: [book('BHEL', [111])],
    resolver: resolver(),
    fullChain: true,
  })
  for (const strike of STRIKES) {
    assert.ok(plan.tokens.includes(strike * 10 + 1), `missing ${strike}CE`)
    assert.ok(plan.tokens.includes(strike * 10 + 2), `missing ${strike}PE`)
  }
  assert.equal(plan.tokens.length, STRIKES.length * 2 + 2, 'chain + spot + the held leg')
})

test('fullChain does not need a spot price to work', () => {
  // The window needs spot to centre on; the chain does not. So a book still
  // marks correctly before the first spot tick arrives.
  const plan = planSubscriptions({
    books: [book('BHEL', [111])],
    resolver: resolver(),
    fullChain: true,
  })
  assert.ok(plan.tokens.length > 2)
})

test('no roll window without a spot price — it cannot be centred', () => {
  const plan = planSubscriptions({
    books: [book('BHEL', [111])],
    resolver: resolver(),
    rollWindow: 3,
  })
  assert.equal(plan.tokens.length, 2, 'just the leg and spot')
})

test('the plan is deterministic — re-running produces the same set', () => {
  // The host re-runs this on a timer; any instability would churn the socket.
  const input = {
    books: [book('BHEL', [111, 222])],
    resolver: resolver(),
    rollWindow: 2,
    spotPrices: new Map([['BHEL', 417]]),
  }
  const a = [...planSubscriptions(input).tokens].sort((x, y) => x - y)
  const b = [...planSubscriptions(input).tokens].sort((x, y) => x - y)
  assert.deepEqual(a, b)
})

test('no books means nothing subscribed', () => {
  const plan = planSubscriptions({ books: [], resolver: resolver() })
  assert.equal(plan.tokens.length, 0)
  assert.equal(plan.missingSpot.length, 0)
})

test('each book contributes its near-future token', () => {
  // The research FORWARD (spec D9): options are priced Black-76 off the
  // near future, so an unsubscribed future makes the live ctx unable to
  // reproduce the backtest.
  const plan = planSubscriptions({
    books: [book('BHEL', [111])],
    resolver: resolver({ future: FUTURE_TOKEN }),
  })
  assert.ok(plan.tokens.includes(FUTURE_TOKEN), 'near-future token not subscribed')
})

test('an underlying with no resolvable future subscribes none, but nothing else breaks', () => {
  const plan = planSubscriptions({
    books: [book('BHEL', [111])],
    resolver: resolver({ future: null }),
  })
  assert.ok(!plan.tokens.includes(FUTURE_TOKEN))
  assert.ok(plan.tokens.includes(112129), 'spot is unaffected')
})

test('multiple underlyings each contribute their own spot', () => {
  const multi: SubscriptionResolver = {
    spotToken: (u) => (u === 'BHEL' ? 112129 : 999),
    strikes: () => STRIKES,
    resolve: () => null,
    futureToken: () => null,
  }
  const plan = planSubscriptions({
    books: [book('BHEL', [111]), book('KALYANKJIL', [222])],
    resolver: multi,
  })
  assert.equal(plan.spotTokens.size, 2)
  assert.equal(plan.spotTokens.get(999), 'KALYANKJIL')
  assert.equal(plan.perUnderlying.get('BHEL'), 2)
})
