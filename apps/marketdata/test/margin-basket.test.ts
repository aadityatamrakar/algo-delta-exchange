/**
 * The HYPOTHETICAL basket-margin endpoint — what the broker would hold against
 * a book that does not exist yet.
 *
 * The sweep in `refresh.ts` prices books the desk ALREADY HOLDS, off `BridgeLeg`s
 * that carry their own contract. This one is asked about a plan: a leg list the
 * cockpit assembled from a repair the operator is thinking about, named
 * semantically (`underlying/expiry/strike/type`) because the caller has no
 * business spelling `BHEL26AUG415CE` itself — that string is the exchange's to
 * define and a client guessing at it is the C4 phantom-PE bug.
 *
 * SO RESOLUTION IS THE FIRST THING TESTED. A strike the master does not list is
 * an ERROR, never a dropped leg: a basket short one short strangle wing prices
 * at a fraction of the real thing, and the operator would read that number as
 * permission to place the trade.
 *
 * The Kite call itself is injected. Nothing here opens a socket, and nothing
 * here may invent a figure when the broker declines to give one.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import type { InstrumentRef } from '@algomaker/order-bus'
import type { BasketOrder } from '../src/book-margin/basket.ts'
import type { MarginQuote } from '../src/book-margin/kite.ts'
import { handleMdRequest } from '../src/history.ts'
import {
  MARGIN_BASKET_PATH,
  handleMarginBasket,
  parseHypotheticalLegs,
  type MarginBasketDeps,
} from '../src/book-margin/hypothetical.ts'

// ------------------------------------------------------------------ fixtures

const EXPIRY = '2026-08-25'

function ref(strike: number, type: 'CE' | 'PE'): InstrumentRef {
  return {
    tradingsymbol: `BHEL26AUG${strike}${type}`,
    instrumentToken: 700000 + strike * 10 + (type === 'CE' ? 1 : 2),
    lotSize: 2625,
    tickSize: 0.05,
    exchange: 'NFO',
  }
}

/** Every BHEL strike in the fixture chain resolves; nothing else does. */
const LISTED = new Set([395, 405, 415, 420])

function quote(over: Partial<MarginQuote> = {}): MarginQuote {
  return {
    span: 200_000,
    exposure: 50_000,
    premium: 1200,
    premiumPaid: 0,
    total: 250_000,
    legs: [],
    ...over,
  }
}

interface Spy {
  readonly deps: MarginBasketDeps
  /** Every basket the fake Kite client was handed, in order. */
  readonly baskets: (readonly BasketOrder[])[]
}

function spy(opts: { readonly quote?: MarginQuote; readonly fail?: Error; readonly client?: null } = {}): Spy {
  const baskets: (readonly BasketOrder[])[] = []
  const deps: MarginBasketDeps = {
    resolve: (underlying, expiry, strike, type) =>
      underlying === 'BHEL' && expiry === EXPIRY && LISTED.has(strike) ? ref(strike, type) : null,
    client: () =>
      opts.client === null
        ? null
        : {
            basketMargin: async (orders) => {
              baskets.push(orders)
              if (opts.fail !== undefined) throw opts.fail
              return opts.quote ?? quote()
            },
          },
  }
  return { deps, baskets }
}

const body = (legs: unknown): unknown => ({ legs })

/** The same body as it actually arrives on the wire: raw, unparsed bytes. */
const raw = (legs: unknown): string => JSON.stringify(body(legs))

const shortStrangle = [
  { underlying: 'BHEL', expiry: EXPIRY, strike: 420, type: 'CE', qty: -5250 },
  { underlying: 'BHEL', expiry: EXPIRY, strike: 395, type: 'PE', qty: -2625 },
]

// -------------------------------------------------------------------- parsing

test('the wire shape is validated field by field, never coerced', () => {
  const ok = parseHypotheticalLegs(shortStrangle)
  assert.ok(!('error' in ok), 'the fixture book is readable')
  assert.equal(ok.length, 2)
  assert.equal(ok[0]?.type, 'CE')

  // `Number('')` is 0 and a zero strike would resolve to nothing at all, which
  // is a 'not listed' error for what is really a malformed request.
  for (const bad of [
    { underlying: '', expiry: EXPIRY, strike: 420, type: 'CE', qty: -5250 },
    { underlying: 'BHEL', expiry: '', strike: 420, type: 'CE', qty: -5250 },
    { underlying: 'BHEL', expiry: EXPIRY, strike: '420', type: 'CE', qty: -5250 },
    { underlying: 'BHEL', expiry: EXPIRY, strike: 420, type: 'XX', qty: -5250 },
    { underlying: 'BHEL', expiry: EXPIRY, strike: 420, type: 'CE', qty: Number.NaN },
    null,
  ]) {
    const out = parseHypotheticalLegs([bad])
    assert.ok('error' in out, `${JSON.stringify(bad)} must be refused, not read`)
  }
})

test('an empty leg list is refused rather than priced at zero', () => {
  // Zero is a real answer for a flat book and a lie for a book that failed to
  // serialise. The caller asked what a PLAN costs; it has to name the plan.
  const out = parseHypotheticalLegs([])
  assert.ok('error' in out)
})

// ---------------------------------------------------------------- the basket

test('the basket is built from the POSTED legs, resolved through the master', async () => {
  const s = spy()
  const out = await handleMarginBasket(s.deps, body(shortStrangle))

  assert.equal(out.status, 200)
  assert.deepEqual(out.body, { total: 250_000, span: 200_000, exposure: 50_000, premiumPaid: 0 })

  const sent = s.baskets[0]
  assert.ok(sent !== undefined, 'the Kite client was called exactly once')
  assert.equal(s.baskets.length, 1)
  assert.deepEqual(
    sent.map((o) => `${o.transaction_type} ${String(o.quantity)} ${o.tradingsymbol} ${o.exchange}`),
    ['SELL 5250 BHEL26AUG420CE NFO', 'SELL 2625 BHEL26AUG395PE NFO'],
    'the symbols come from the MASTER, never from string concatenation here',
  )
})

test('a long leg is a BUY and the sign never reaches the quantity', async () => {
  const s = spy()
  await handleMarginBasket(
    s.deps,
    body([{ underlying: 'BHEL', expiry: EXPIRY, strike: 415, type: 'CE', qty: 2625 }]),
  )
  assert.equal(s.baskets[0]?.[0]?.transaction_type, 'BUY')
  assert.equal(s.baskets[0]?.[0]?.quantity, 2625)
})

test('the total is span + exposure + premiumPaid, NOT the calculator headline', async () => {
  /**
   * A BOOK WITH A LONG LEG, which is the only book where the two differ.
   *
   * Zerodha's calculator prints `span + exposure` (`MarginQuote.total` — 250,000
   * here) and the broker BLOCKS the long legs' premium as well: the XTS
   * account's `MarginUsed` is the three-term sum, exact to the paisa
   * (2026-08-04). `apps/api/src/book-margin.ts` computes the per-book margin
   * tile the same way, so serving 250,000 here would put a figure 34,675 lower
   * than the tile's on the same book — and an operator reads a smaller margin
   * as headroom before placing.
   */
  const s = spy({ quote: quote({ premiumPaid: 34_675 }) })
  const out = await handleMarginBasket(
    s.deps,
    body([
      ...shortStrangle,
      { underlying: 'BHEL', expiry: EXPIRY, strike: 415, type: 'CE', qty: 2625 },
    ]),
  )
  assert.equal(out.status, 200)
  assert.deepEqual(out.body, {
    total: 284_675,
    span: 200_000,
    exposure: 50_000,
    premiumPaid: 34_675,
  })
  // The components ride along, so nothing is hidden behind the sum and Kite's
  // own figure is still recoverable from the reply.
  assert.equal(Number(out.body['span']) + Number(out.body['exposure']), 250_000)
})

test('a strike the master does not list is an ERROR, never a smaller basket', async () => {
  // The failure this guards: dropping the unresolvable wing prices a naked
  // short at a hedged book's margin, and the operator reads that as headroom.
  const s = spy()
  const out = await handleMarginBasket(
    s.deps,
    body([...shortStrangle, { underlying: 'BHEL', expiry: EXPIRY, strike: 999, type: 'CE', qty: 2625 }]),
  )
  assert.equal(out.status, 400)
  assert.match(String(out.body['error']), /999CE/)
  assert.equal(s.baskets.length, 0, 'nothing was priced at all')
})

// ------------------------------------------------------------------ refusals

test('Kite failing is an error, never a fabricated number', async () => {
  const s = spy({ fail: new Error('basket margin HTTP 403: token rejected') })
  const out = await handleMarginBasket(s.deps, body(shortStrangle))
  assert.equal(out.status, 502)
  assert.match(String(out.body['error']), /403/)
  assert.equal(out.body['total'], undefined, 'no total on a failed call')
})

test('before the Kite login lands the answer is 503, not zero', async () => {
  const s = spy({ client: null })
  const out = await handleMarginBasket(s.deps, body(shortStrangle))
  assert.equal(out.status, 503)
  assert.equal(out.body['total'], undefined)
})

test('a body that is not {legs: [...]} is a 400', async () => {
  const s = spy()
  for (const bad of [null, {}, { legs: 'nope' }, []]) {
    const out = await handleMarginBasket(s.deps, bad)
    assert.equal(out.status, 400, `${JSON.stringify(bad)} must be a 400`)
  }
  assert.equal(s.baskets.length, 0)
})

test('the path is the one the bridge posts to', () => {
  assert.equal(MARGIN_BASKET_PATH, '/v1/md/margin-basket')
})

// ------------------------------------------------ the :8892 server's dispatch

const TOKEN = 'machine-bearer'

interface ServerSpy {
  readonly deps: Parameters<typeof handleMdRequest>[0]
  /** Every body the dispatcher handed on, i.e. every one it PARSED. */
  readonly parsed: unknown[]
}

function serverDeps(s: Spy): ServerSpy {
  const parsed: unknown[] = []
  return {
    deps: {
      port: 0,
      token: TOKEN,
      // The history half is not exercised here; it has its own suite.
      source: () => null,
      marginBasket: (b) => {
        parsed.push(b)
        return handleMarginBasket(s.deps, b)
      },
    },
    parsed,
  }
}

test('the margin route is a sibling of history on the SAME bearer', async () => {
  const s = spy()
  const out = await handleMdRequest(serverDeps(s).deps, {
    method: 'POST',
    url: MARGIN_BASKET_PATH,
    authorization: `Bearer ${TOKEN}`,
    body: raw(shortStrangle),
  })
  assert.equal(out.status, 200)
  assert.equal(out.body['total'], 250_000)
})

test('without the bearer nothing is priced at all', async () => {
  // An unauthenticated endpoint on the process holding the Kite session is a
  // free rate-limit exhaustion, and Kite throttles the whole login — an
  // outsider hammering this would stop the DESK pricing its own books.
  const s = spy()
  const server = serverDeps(s)
  for (const authorization of [undefined, 'Bearer wrong', TOKEN]) {
    const out = await handleMdRequest(server.deps, {
      method: 'POST',
      url: MARGIN_BASKET_PATH,
      ...(authorization === undefined ? {} : { authorization }),
      body: raw(shortStrangle),
    })
    assert.equal(out.status, 401, `'${String(authorization)}' must be refused`)
  }
  assert.equal(s.baskets.length, 0, 'the Kite session was never touched')
  assert.deepEqual(server.parsed, [], 'the body was never even parsed')
})

/**
 * THE BEARER IS CHECKED BEFORE THE BODY IS PARSED, and this is the test that
 * says so rather than a comment claiming it.
 *
 * `JSON.parse` is real work on attacker-chosen input and this port binds every
 * interface (`createHistoryServer`'s `server.listen`). Until the review, the
 * server parsed the body on the way in — so an unauthenticated sender could
 * spend that work, in the process holding the desk's entire market data feed,
 * on a request that was about to be refused. Malformed JSON is the probe: if
 * anything parsed it, the answer would be the parse failure and not the 401.
 */
test('a bad bearer is refused BEFORE the body is parsed', async () => {
  const s = spy()
  const server = serverDeps(s)
  const out = await handleMdRequest(server.deps, {
    method: 'POST',
    url: MARGIN_BASKET_PATH,
    authorization: 'Bearer wrong',
    body: '{"legs": [{"underlying": "BHEL"',
  })
  assert.equal(out.status, 401)
  assert.deepEqual(out.body, { error: 'unauthorized' }, 'a parse failure must not be what answers')
  assert.deepEqual(server.parsed, [])
})

test('an AUTHENTICATED caller with malformed JSON gets a 400, never a 500', async () => {
  const s = spy()
  const out = await handleMdRequest(serverDeps(s).deps, {
    method: 'POST',
    url: MARGIN_BASKET_PATH,
    authorization: `Bearer ${TOKEN}`,
    body: '{"legs": [{"underlying": "BHEL"',
  })
  assert.equal(out.status, 400)
  assert.match(String(out.body['error']), /JSON/)
})

test('a POST with no body at all is a 400, not a crash', async () => {
  const s = spy()
  const out = await handleMdRequest(serverDeps(s).deps, {
    method: 'POST',
    url: MARGIN_BASKET_PATH,
    authorization: `Bearer ${TOKEN}`,
  })
  assert.equal(out.status, 400)
  assert.equal(s.baskets.length, 0)
})

test('a GET on the margin path is 405, and history still routes', async () => {
  const s = spy()
  const get = await handleMdRequest(serverDeps(s).deps, {
    method: 'GET',
    url: MARGIN_BASKET_PATH,
    authorization: `Bearer ${TOKEN}`,
  })
  assert.equal(get.status, 405)

  // The history route is untouched by the new sibling: no source yet -> 503.
  const history = await handleMdRequest(serverDeps(s).deps, {
    method: 'GET',
    url: '/v1/md/history?token=1&interval=day&count=5',
    authorization: `Bearer ${TOKEN}`,
  })
  assert.equal(history.status, 503)
})

test('a process that wired no margin client answers 501, not a zero', async () => {
  const s = spy()
  const { marginBasket: _absent, ...noMargin } = serverDeps(s).deps
  const out = await handleMdRequest(noMargin, {
    method: 'POST',
    url: MARGIN_BASKET_PATH,
    authorization: `Bearer ${TOKEN}`,
    body: raw(shortStrangle),
  })
  assert.equal(out.status, 501)
  assert.equal(out.body['total'], undefined)
})
