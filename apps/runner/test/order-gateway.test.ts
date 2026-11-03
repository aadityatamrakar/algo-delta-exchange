/**
 * The `orders` port: what a hosted strategy's submit actually becomes.
 *
 * Two properties matter most here and neither is obvious from the code:
 *
 *  - A submit that did not reach a rail must come back `accepted: false`, or
 *    the strategy flips its "opportunity used" flag on an order that never
 *    existed and skips the trade for the rest of the day.
 *  - The ledger must book the lots the BRIDGE reports, not the lots the
 *    strategy asked for. A live entry is re-sized to `liveLots`, and a ledger
 *    that recorded the request would strand the difference at flatten time.
 */

import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { fixedClock } from '@algomaker/core'
import {
  MemoryStateStore,
  makeLogger,
  type CapturedLog,
  type InstrumentRef,
} from '@algomaker/strategy-kit'
import { HttpOrderGateway, PositionLedger } from '../src/order-gateway.ts'

const INSTRUMENT: InstrumentRef = {
  tradingsymbol: 'BANKNIFTY26AUG56000CE',
  instrumentToken: 4242,
  lotSize: 35,
  tickSize: 0.05,
  exchange: 'NFO',
}

interface Captured {
  readonly url: string
  readonly body: Record<string, unknown>
}

function fakeFetch(
  captured: Captured[],
  reply: () => { status?: number; body: unknown },
): typeof globalThis.fetch {
  return (async (url: string, init: { body: string }) => {
    captured.push({ url, body: JSON.parse(init.body) as Record<string, unknown> })
    const r = reply()
    const text = JSON.stringify(r.body)
    return {
      ok: (r.status ?? 200) < 400,
      status: r.status ?? 200,
      text: async () => text,
    }
  }) as unknown as typeof globalThis.fetch
}

let state: MemoryStateStore
let ledger: PositionLedger
let captured: Captured[]

function gateway(
  reply: () => { status?: number; body: unknown },
  mode: 'paper' | 'live' = 'paper',
): HttpOrderGateway {
  return withFetch(fakeFetch(captured, reply), mode)
}

function withFetch(
  fetch: typeof globalThis.fetch,
  mode: 'paper' | 'live' = 'paper',
  log = makeLogger(),
): HttpOrderGateway {
  return new HttpOrderGateway({
    baseUrl: 'http://bridge:8890',
    token: 'tok',
    tag: 'BN_BREAKOUT',
    mode,
    underlying: 'BANKNIFTY',
    clock: fixedClock(1_800_000_000_000),
    log,
    ledger,
    // The SAME store the ledger uses, exactly as `main.ts` wires it: the held
    // `clientOrderId`s and the positions share one `tag:mode` scope.
    state,
    fetch,
    // These tests assert the retry HAPPENED, not that it waited.
    retryDelayMs: 0,
  })
}

/** An `accepted: true` body in the shape `/v1/desk/submit` returns today. */
function routed(lots: number, intended = lots): Record<string, unknown> {
  return {
    accepted: true,
    status: lots === intended ? 'DONE' : 'FAILED',
    clientOrderId: 'c',
    orders: [{ clientOrderId: 'c#0', lots, qty: lots * INSTRUMENT.lotSize }],
    replayed: false,
    routedLots: lots,
    lots,
    intendedLots: intended,
    requestedLots: intended,
    freezeMaxLots: intended === lots ? null : lots,
    errors: lots === intended ? [] : [`c#1: freeze tranche rejected`],
  }
}

beforeEach(async () => {
  state = new MemoryStateStore()
  ledger = new PositionLedger(state)
  await ledger.load()
  captured = []
})

test('a submit POSTs to /v1/desk/submit with the REGISTRY tag and its own idempotency key', async () => {
  const g = gateway(() => ({ body: { accepted: true, clientOrderId: 'c1', lots: 2 } }))
  await g.submit({ instrument: INSTRUMENT, side: 'BUY', lots: 2, referencePrice: 120 })

  assert.equal(captured.length, 1)
  assert.equal(captured[0]?.url, 'http://bridge:8890/v1/desk/submit')
  const body = captured[0]?.body ?? {}
  assert.equal(body['tag'], 'BN_BREAKOUT')
  assert.equal(body['mode'], 'paper')
  assert.equal(body['underlying'], 'BANKNIFTY')
  assert.equal(body['lots'], 2)
  // Translated at the boundary: strategies speak BUY/SELL, the desk Buy/Sell.
  assert.equal(body['side'], 'Buy')
  assert.equal(body['referencePrice'], 120)
  assert.ok(String(body['clientOrderId']).startsWith('BN_BREAKOUT-'))
})

test('a SETTLED order releases its id; an UNSETTLED one holds it', async () => {
  /**
   * The invariant, stated in one place and in the right direction.
   *
   * This test used to be titled "every attempt gets a FRESH id — resubmitting
   * one would replay, not retry", which asserts the OPPOSITE of what
   * `#idFor`'s docstring promises: a retry of a request whose ANSWER WAS LOST
   * must go out under the id already on the wire, or both ids are new to the
   * bridge's unique index, both route, and the strategy holds twice what it
   * asked for. It also passed with `#idFor` and `#unresolved` deleted outright,
   * because a gateway that always mints a fresh id satisfies it trivially.
   *
   * Both halves are here because only the pair is falsifiable: "always fresh"
   * fails the second, "always reuse" fails the first.
   */
  let live = true
  const g = withFetch((async (url: string, init: { body: string }) => {
    captured.push({ url, body: JSON.parse(init.body) as Record<string, unknown> })
    if (!live) throw new Error('socket hang up')
    const text = JSON.stringify({ accepted: true, clientOrderId: 'c', lots: 1 })
    return { ok: true, status: 200, text: async () => text }
  }) as unknown as typeof globalThis.fetch)

  // Settled: the answer was definite, so the next attempt at the same intent is
  // a GENUINE second order and must not replay the first one's outcome.
  await g.submit({ instrument: INSTRUMENT, side: 'BUY', lots: 1 })
  await g.submit({ instrument: INSTRUMENT, side: 'BUY', lots: 1 })
  assert.notEqual(captured[0]?.body['clientOrderId'], captured[1]?.body['clientOrderId'])

  // Unsettled: every attempt failed, so the claim may be live at the bridge and
  // the id is HELD. The strategy's next attempt must replay it, not route.
  live = false
  captured.length = 0
  await g.submit({ instrument: INSTRUMENT, side: 'SELL', lots: 3 })
  const heldId = captured[0]?.body['clientOrderId']
  captured.length = 0
  await g.submit({ instrument: INSTRUMENT, side: 'SELL', lots: 3 })
  assert.equal(captured[0]?.body['clientOrderId'], heldId, 'an unresolved intent must replay its id')
})

test('a refusal comes back as accepted:false with the gate name the bridge gave', async () => {
  const g = gateway(() => ({
    body: { accepted: false, clientOrderId: 'c', reason: 'kill switch: engaged' },
  }))
  const res = await g.submit({ instrument: INSTRUMENT, side: 'BUY', lots: 1 })
  assert.equal(res.accepted, false)
  assert.match(res.reason ?? '', /kill switch/)
  assert.equal(ledger.openCount, 0, 'a refused order must never enter the ledger')
})

test('a transport failure is a refusal, not an exception — the opportunity stays available', async () => {
  const g = withFetch((async () => {
    throw new Error('ECONNREFUSED')
  }) as unknown as typeof globalThis.fetch)
  const res = await g.submit({ instrument: INSTRUMENT, side: 'BUY', lots: 1 })
  assert.equal(res.accepted, false)
  assert.match(res.reason ?? '', /ECONNREFUSED/)
  assert.equal(ledger.openCount, 0)
})

// ------------------------------------------------- the idempotency key

test('a lost response is RETRIED under the same id — a fresh one would route twice', async () => {
  /**
   * THE RETRY THAT MATTERS IS THE STRATEGY'S, NOT THE LOOP'S.
   *
   * This test used to exhaust one attempt, let the second succeed, and assert
   * that `captured[0].clientOrderId === captured[1].clientOrderId`. That
   * proved nothing: `submit()` builds its request body ONCE, before the retry
   * loop, so both POSTs are serialisations of the same object and the two ids
   * are equal however `#idFor` behaves — delete `#unresolved` entirely and it
   * still passes.
   *
   * So the sequence here spans TWO `submit()` calls, which is where a new body
   * (and therefore a new `#idFor`) is genuinely built: all three attempts of
   * the first call fail, the strategy tries again, and the id on that fourth
   * POST is the one that has to match.
   */
  let call = 0
  const g = withFetch((async (url: string, init: { body: string }) => {
    captured.push({ url, body: JSON.parse(init.body) as Record<string, unknown> })
    call++
    if (call <= 3) throw new Error('socket hang up')
    const text = JSON.stringify(routed(2))
    return { ok: true, status: 200, text: async () => text }
  }) as unknown as typeof globalThis.fetch)

  const first = await g.submit({ instrument: INSTRUMENT, side: 'BUY', lots: 2 })
  assert.equal(first.accepted, false, 'every attempt failed, so the outcome is unknown')
  assert.equal(captured.length, 3)
  assert.equal(ledger.openCount, 0, 'nothing is booked on a maybe')

  const second = await g.submit({ instrument: INSTRUMENT, side: 'BUY', lots: 2 })
  assert.equal(second.accepted, true)
  assert.equal(captured.length, 4)
  assert.equal(
    new Set(captured.map((c) => c.body['clientOrderId'])).size,
    1,
    'the strategy retry must reuse the id already on the wire, across submit() calls',
  )
  assert.equal(ledger.openCount, 1, 'and it is booked exactly once')
})

test('an outcome that stayed unknown keeps its id, so the strategy retry replays instead of routing', async () => {
  const dead = (async () => {
    throw new Error('ETIMEDOUT')
  }) as unknown as typeof globalThis.fetch
  const seen: string[] = []
  const g = withFetch((async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as Record<string, string>
    seen.push(body['clientOrderId'] ?? '')
    return await dead('' as never)
  }) as unknown as typeof globalThis.fetch)

  const first = await g.submit({ instrument: INSTRUMENT, side: 'BUY', lots: 2 })
  await g.submit({ instrument: INSTRUMENT, side: 'BUY', lots: 2 })

  assert.equal(first.accepted, false)
  assert.equal(first.clientOrderId, seen[0], 'the id is reported so it can be reconciled')
  assert.equal(new Set(seen).size, 1, 'every attempt at this order used one id')
  assert.equal(ledger.openCount, 0, 'and nothing was booked on a maybe')
})

test('a DEFINITE refusal releases the id — that is a genuine second attempt, not a replay', async () => {
  const g = gateway(() => ({
    body: { accepted: false, status: 'DONE', clientOrderId: 'c', reason: 'kill switch', routedLots: 0 },
  }))
  await g.submit({ instrument: INSTRUMENT, side: 'BUY', lots: 2 })
  await g.submit({ instrument: INSTRUMENT, side: 'BUY', lots: 2 })
  assert.notEqual(captured[0]?.body['clientOrderId'], captured[1]?.body['clientOrderId'])
})

// ----------------------------------------------------------- indeterminate

test('an INDETERMINATE submission books nothing — a phantom leg is worse than a missing one', async () => {
  // The bridge has a claim under this id and does not know its outcome; it
  // deliberately sends no `routedLots`. Booking the planned size would put a leg
  // in the ledger that may not exist, and the EOD flatten would SELL it —
  // opening a real short out of a position that was never opened.
  const g = gateway(() => ({
    body: {
      accepted: false,
      status: 'ROUTING',
      indeterminate: true,
      clientOrderId: 'c',
      reason: 'submission is still routing',
      replayed: true,
      intendedLots: 4,
      plannedOrders: [{ clientOrderId: 'c#0', lots: 4, qty: 140 }],
    },
  }))
  const res = await g.submit({ instrument: INSTRUMENT, side: 'BUY', lots: 4 })

  assert.equal(res.accepted, false, 'an unknown outcome is not an accepted order')
  assert.equal(ledger.openCount, 0)
  assert.match(res.reason ?? '', /routing/)
  // Reported, not nulled like a clean refusal: this id is the thing that has to
  // be reconciled, and the next attempt has to replay it.
  assert.equal(res.clientOrderId, captured[0]?.body['clientOrderId'])
})

test('an indeterminate submission is replayed under the SAME id until it resolves', async () => {
  let call = 0
  const g = withFetch((async (url: string, init: { body: string }) => {
    captured.push({ url, body: JSON.parse(init.body) as Record<string, unknown> })
    call++
    const body =
      call === 1
        ? {
            accepted: false,
            status: 'ROUTING',
            indeterminate: true,
            clientOrderId: 'c',
            reason: 'still routing',
            replayed: true,
            intendedLots: 4,
            plannedOrders: [{ clientOrderId: 'c#0', lots: 4, qty: 140 }],
          }
        : routed(4)
    const text = JSON.stringify(body)
    return { ok: true, status: 200, text: async () => text }
  }) as unknown as typeof globalThis.fetch)

  await g.submit({ instrument: INSTRUMENT, side: 'BUY', lots: 4 })
  assert.equal(ledger.openCount, 0)

  // The record resolved between the two calls: the replay now tells the truth,
  // and THAT is what gets booked. Under-booking is recoverable; this is the
  // recovery.
  const second = await g.submit({ instrument: INSTRUMENT, side: 'BUY', lots: 4 })
  assert.equal(second.accepted, true)
  assert.equal(captured[0]?.body['clientOrderId'], captured[1]?.body['clientOrderId'])
  assert.deepEqual(
    ledger.open().map((e) => e.lots),
    [4],
    'booked once, at the size the replay confirmed',
  )
})

test('a 4xx is a DEFINITE refusal — not retried, and it does not wedge the id', async () => {
  // A refusal is a 200 with `accepted: false`, so a 4xx means the request
  // itself was wrong (an unregistered tag). Nothing was claimed, so retrying it
  // is the same rejection three times — and holding the id as "unresolved"
  // would stop this order ever being placed again once the tag IS registered.
  const g = gateway(() => ({ status: 403, body: { error: 'strategy not registered' } }))
  const res = await g.submit({ instrument: INSTRUMENT, side: 'BUY', lots: 1 })
  assert.equal(res.accepted, false)
  assert.match(res.reason ?? '', /403/)
  assert.equal(captured.length, 1, 'a rejected request is not retried')

  await g.submit({ instrument: INSTRUMENT, side: 'BUY', lots: 1 })
  assert.notEqual(captured[0]?.body['clientOrderId'], captured[1]?.body['clientOrderId'])
})

test('a 5xx IS retried under the same id — that answer may simply have been lost', async () => {
  const g = gateway(() => ({ status: 502, body: { error: 'bad gateway' } }))
  const res = await g.submit({ instrument: INSTRUMENT, side: 'BUY', lots: 1 })
  assert.equal(res.accepted, false)
  assert.equal(captured.length, 3)
  assert.equal(new Set(captured.map((c) => c.body['clientOrderId'])).size, 1)
  assert.equal(ledger.openCount, 0)
})

// -------------------------------------------------------------------- ledger

test('the ledger books the lots the BRIDGE sent, not the lots that were asked for', async () => {
  // A live entry re-sized by the row's liveLots: asked for 2, the bridge sent 5.
  const g = gateway(() => ({ body: routed(5) }), 'live')
  await g.submit({ instrument: INSTRUMENT, side: 'BUY', lots: 2 })
  assert.deepEqual(
    ledger.open().map((e) => e.lots),
    [5],
  )
})

test('a PARTIAL route books what ROUTED, not what was intended', async () => {
  // 30 lots split by the freeze cap into [24, 6]; the 6 was rejected. The real
  // position is 24. Booking 30 makes the flatten below sell 30 against 24 and
  // leave a 6-lot SHORT that nobody asked for and nothing would ever close.
  const g = gateway(() => ({ body: routed(24, 30) }), 'live')
  const res = await g.submit({ instrument: INSTRUMENT, side: 'BUY', lots: 30 })

  // Still accepted: real exposure exists and the strategy must know it does.
  assert.equal(res.accepted, true)
  assert.deepEqual(
    ledger.open().map((e) => e.lots),
    [24],
  )

  captured.length = 0
  await g.flattenAll('EOD')
  assert.equal(captured[0]?.body['lots'], 24, 'the flatten sells the real position, exactly')
  assert.equal(ledger.openCount, 0)
})

test('a bridge that predates routedLots is read from the tranches that routed', async () => {
  // `orders[]` has always been the routed set; `lots` on an old bridge was the
  // INTENDED size, so summing the tranches is the safer of the two fallbacks.
  const g = gateway(() => ({
    body: {
      accepted: true,
      clientOrderId: 'c',
      lots: 30,
      orders: [{ clientOrderId: 'c#0', lots: 24, qty: 840 }],
      errors: ['c#1: freeze tranche rejected'],
    },
  }))
  await g.submit({ instrument: INSTRUMENT, side: 'BUY', lots: 30 })
  assert.deepEqual(
    ledger.open().map((e) => e.lots),
    [24],
  )
})

test('load() after a position has been booked THROWS rather than discarding it', async () => {
  // `load()` replaces the map wholesale, so a load still in flight when the
  // first order is booked erases it — and this ledger is the only durable
  // record of a hosted position. main.ts loads every ledger at boot, awaited;
  // this is what stops that discipline being quietly dropped again.
  const g = gateway(() => ({ body: routed(1) }))
  await g.submit({ instrument: INSTRUMENT, side: 'BUY', lots: 1 })
  await assert.rejects(() => ledger.load(), /would discard them/)
  assert.equal(ledger.openCount, 1)
})

test('a round trip nets to zero and the leg leaves the ledger', async () => {
  const g = gateway(() => ({ body: { accepted: true, clientOrderId: 'c', lots: 3 } }))
  await g.submit({ instrument: INSTRUMENT, side: 'BUY', lots: 3 })
  assert.equal(ledger.openCount, 1)
  await g.submit({ instrument: INSTRUMENT, side: 'SELL', lots: 3, reducesExposure: true })
  assert.equal(ledger.openCount, 0)
})

test('the ledger survives a restart — the legacy system lost positions here', async () => {
  const g = gateway(() => ({ body: { accepted: true, clientOrderId: 'c', lots: 4 } }))
  await g.submit({ instrument: INSTRUMENT, side: 'SELL', lots: 4 })

  // New process, same StateStore.
  const reloaded = new PositionLedger(state)
  await reloaded.load()
  assert.equal(reloaded.openCount, 1)
  assert.equal(reloaded.open()[0]?.lots, -4, 'a short must come back short')
  assert.deepEqual(reloaded.open()[0]?.instrument, INSTRUMENT)
})

// ------------------------------------------------------------------- flatten

test('flattenAll reverses every open leg and marks each order as an EXIT', async () => {
  const g = gateway(() => ({ body: { accepted: true, clientOrderId: 'c', lots: 2 } }))
  await g.submit({ instrument: INSTRUMENT, side: 'BUY', lots: 2 })
  captured.length = 0

  await g.flattenAll('kill switch')

  assert.equal(captured.length, 1)
  const body = captured[0]?.body ?? {}
  assert.equal(body['side'], 'Sell')
  assert.equal(body['lots'], 2)
  // reducesExposure is what carries an exit past the kill switch and past the
  // stale-feed block. Without it a flatten is refused by the thing that asked
  // for it.
  assert.equal(body['reducesExposure'], true)
  assert.equal(ledger.openCount, 0)
})

test('a flatten with nothing open sends nothing', async () => {
  const g = gateway(() => ({ body: { accepted: true, clientOrderId: 'c', lots: 1 } }))
  await g.flattenAll('EOD')
  assert.equal(captured.length, 0)
})

test('one unflattenable leg does not abandon the rest', async () => {
  const other: InstrumentRef = { ...INSTRUMENT, tradingsymbol: 'BANKNIFTY26AUG56000PE' }
  const g = gateway(() => ({ body: { accepted: true, clientOrderId: 'c', lots: 1 } }))
  await g.submit({ instrument: INSTRUMENT, side: 'BUY', lots: 1 })
  await g.submit({ instrument: other, side: 'BUY', lots: 1 })
  captured.length = 0

  let call = 0
  const flaky = new HttpOrderGateway({
    baseUrl: 'http://bridge:8890',
    token: 'tok',
    tag: 'BN_BREAKOUT',
    mode: 'paper',
    underlying: 'BANKNIFTY',
    clock: fixedClock(0),
    log: makeLogger(),
    ledger,
    state,
    fetch: fakeFetch(captured, () => {
      call++
      return call === 1
        ? { body: { accepted: false, reason: 'no mark' } }
        : { body: { accepted: true, clientOrderId: 'c', lots: 1 } }
    }),
  })
  await flaky.flattenAll('EOD')

  assert.equal(captured.length, 2, 'the second leg must still be attempted')
  // The refused leg stays in the ledger — it is still open, and saying
  // otherwise would be the "flatten did nothing" lie.
  assert.equal(ledger.openCount, 1)
})

test('a refused flatten logs ONE line per attempt, naming every leg — not one line per leg', async () => {
  /**
   * The 2026-08-04 noise floor: a 12-leg book whose flatten the bridge refused
   * was retried on a cadence, and each attempt logged each leg separately —
   * ~48 identical lines a minute, burying the one fact that mattered. The
   * aggregate keeps every leg and every distinct reason on a single line.
   */
  const other: InstrumentRef = { ...INSTRUMENT, tradingsymbol: 'BANKNIFTY26AUG56000PE' }
  const g = gateway(() => ({ body: routed(1) }))
  await g.submit({ instrument: INSTRUMENT, side: 'SELL', lots: 1 })
  await g.submit({ instrument: other, side: 'SELL', lots: 1 })

  const logs: CapturedLog[] = []
  const refusing = withFetch(
    fakeFetch(captured, () => ({
      body: { accepted: false, reason: 'strategy switch: switched off for paper' },
    })),
    'paper',
    makeLogger(logs),
  )
  await refusing.flattenAll('switched off in the registry')

  const rejected = logs.filter((l) => l.msg.includes('flatten REJECTED'))
  assert.equal(rejected.length, 1, 'one aggregated line, not one per leg')
  assert.match(rejected[0]?.msg ?? '', /2\/2 leg\(s\)/)
  const ctx = rejected[0]?.ctx ?? {}
  assert.match(String(ctx['legs']), /BANKNIFTY26AUG56000CE:-1/)
  assert.match(String(ctx['legs']), /BANKNIFTY26AUG56000PE:-1/)
  // One reason, stated once — the bridge refusing a whole book refuses it for
  // one reason, and repeating it per leg is what made the incident unreadable.
  assert.equal(String(ctx['reasons']), 'strategy switch: switched off for paper')
  assert.equal(ledger.openCount, 2, 'and both legs are honestly still open')
})

// ------------------------------------- F4: the flatten must carry a price

test('flattenAll sends the ledger price as referencePrice — the feed is DEAD by then', async () => {
  /**
   * `apps/api/src/submit.ts` resolves a fill price as
   * `marks.price() ?? referencePrice ?? limitPrice ?? refuse`, and its
   * `QuoteCache` calls the feed dead 120 seconds after the last tick. So from
   * roughly 15:32 the first of those three is gone, and a flatten that sent
   * none of them was REFUSED — then re-armed by `Runner`'s 60-second exit
   * retry and refused again, every minute, all night, with a real position
   * sitting at the broker the whole time.
   *
   * This gateway has NO `markOf`, which is the 15:33 case exactly: everything
   * the exit can state has to come off the ledger entry.
   */
  const g = gateway(() => ({ body: routed(2) }))
  await g.submit({ instrument: INSTRUMENT, side: 'BUY', lots: 2, referencePrice: 143.5 })
  captured.length = 0

  await g.flattenAll('day end')
  assert.equal(captured.length, 1)
  assert.equal(captured[0]?.body['referencePrice'], 143.5)
  assert.equal(captured[0]?.body['reducesExposure'], true)
})

test('the ledger price SURVIVES a restart, so a 15:33 flatten still has one', async () => {
  // The whole point of persisting it. A process that came back after the feed
  // stopped has no quote for anything and no live mark to borrow.
  const g = gateway(() => ({ body: routed(2) }))
  await g.submit({ instrument: INSTRUMENT, side: 'BUY', lots: 2, referencePrice: 143.5 })

  const reloaded = new PositionLedger(state)
  await reloaded.load()
  assert.equal(reloaded.open()[0]?.lastPrice, 143.5)
})

test('a strategy that sends no price at all still gets one, from the live mark', async () => {
  // No catalogue strategy sends `referencePrice` today, so without this the
  // ledger would carry no price and the fix above would be inert in production.
  const g = new HttpOrderGateway({
    baseUrl: 'http://bridge:8890',
    token: 'tok',
    tag: 'BN_BREAKOUT',
    mode: 'paper',
    underlying: 'BANKNIFTY',
    clock: fixedClock(0),
    log: makeLogger(),
    ledger,
    state,
    // What `main.ts` injects: the runner's own last-seen quote, which
    // `RunnerMarketData` never expires.
    markOf: () => 88.25,
    fetch: fakeFetch(captured, () => ({ body: routed(1) })),
  })
  await g.submit({ instrument: INSTRUMENT, side: 'BUY', lots: 1 })
  assert.equal(ledger.open()[0]?.lastPrice, 88.25)
  captured.length = 0
  await g.flattenAll('kill switch')
  assert.equal(captured[0]?.body['referencePrice'], 88.25)
})

test('a leg booked with NO price anywhere is flattened loudly rather than silently', async () => {
  // Honest about the one case that cannot be fixed here: nothing knew a price.
  // The bridge will very likely refuse, and the log has to say why so the
  // refusal is not read as the bridge misbehaving.
  const logs: CapturedLog[] = []
  const g = new HttpOrderGateway({
    baseUrl: 'http://bridge:8890',
    token: 'tok',
    tag: 'BN_BREAKOUT',
    mode: 'paper',
    underlying: 'BANKNIFTY',
    clock: fixedClock(0),
    log: makeLogger(logs),
    ledger,
    state,
    fetch: fakeFetch(captured, () => ({ body: routed(1) })),
  })
  await g.submit({ instrument: INSTRUMENT, side: 'BUY', lots: 1 })
  captured.length = 0
  await g.flattenAll('day end')
  assert.equal(captured[0]?.['body']['referencePrice'], undefined)
  assert.ok(
    logs.some((l) => l.level === 'error' && l.msg.includes('NO reference price')),
    'the missing price must be named, not discovered from a refusal',
  )
})

// ------------------------------- F5: the held id must survive a restart

test('a held clientOrderId SURVIVES a restart — process memory would double-place', async () => {
  /**
   * `#unresolved` used to be a bare `Map` on the gateway, sitting beside a
   * `PositionLedger` that is persisted precisely because "positions in process
   * memory" was the legacy system's defining gap.
   *
   * The trace: a submit whose answer is lost parks its id, the process is
   * restarted (which is likeliest right after exactly that kind of failure),
   * and the strategy retries. With the map gone, `#idFor` mints a FRESH id —
   * new to the bridge's unique index, so it ROUTES — while the original claim
   * may already be live. Two orders, one ledger entry.
   */
  const dead = (async () => {
    throw new Error('ETIMEDOUT')
  }) as unknown as typeof globalThis.fetch
  const seen: string[] = []
  const record = (async (_url: string, init: { body: string }) => {
    seen.push((JSON.parse(init.body) as Record<string, string>)['clientOrderId'] ?? '')
    return await dead('' as never)
  }) as unknown as typeof globalThis.fetch

  const first = withFetch(record)
  await first.load()
  await first.submit({ instrument: INSTRUMENT, side: 'BUY', lots: 2 })
  assert.equal(first.unresolvedCount, 1)

  // A NEW process: a new gateway, a new ledger, sharing only the StateStore.
  const second = withFetch(record)
  await second.load()
  assert.equal(second.unresolvedCount, 1, 'the held id must come back from storage')
  await second.submit({ instrument: INSTRUMENT, side: 'BUY', lots: 2 })

  assert.equal(new Set(seen).size, 1, 'every attempt, across the restart, used ONE id')
})

test('a held id is SWEPT once it is too old to be worth replaying', async () => {
  /**
   * `intentKey` includes `lots` — it has to, because replaying an id held for
   * "BUY 2" against a later "BUY 5" would answer the 5-lot order with the
   * 2-lot outcome. The cost is that a strategy which re-sizes strands the old
   * entry with no retry that can ever resolve it, so nothing but age can
   * remove it. Without a sweep the document grows for the life of the process
   * and a stale id blocks that exact order forever.
   */
  const clock = fixedClock(1_800_000_000_000)
  const dead = (async () => {
    throw new Error('ETIMEDOUT')
  }) as unknown as typeof globalThis.fetch
  const seen: string[] = []
  const record = (async (_url: string, init: { body: string }) => {
    seen.push((JSON.parse(init.body) as Record<string, string>)['clientOrderId'] ?? '')
    return await dead('' as never)
  }) as unknown as typeof globalThis.fetch

  const g = new HttpOrderGateway({
    baseUrl: 'http://bridge:8890',
    token: 'tok',
    tag: 'BN_BREAKOUT',
    mode: 'paper',
    underlying: 'BANKNIFTY',
    clock,
    log: makeLogger(),
    ledger,
    state,
    fetch: record,
    retryDelayMs: 0,
    unresolvedTtlMs: 60_000,
  })
  await g.load()
  await g.submit({ instrument: INSTRUMENT, side: 'BUY', lots: 2 })
  assert.equal(g.unresolvedCount, 1)
  const strandedId = seen[0]

  /**
   * The strategy re-sizes. `intentKey` includes `lots`, so this is a DIFFERENT
   * intent: the 2-lot entry's id will never be retried by anything, and only
   * age can remove it.
   */
  clock.set(1_800_000_000_000 + 120_000)
  seen.length = 0
  await g.submit({ instrument: INSTRUMENT, side: 'BUY', lots: 5 })
  assert.equal(g.unresolvedCount, 1, 'the stranded 2-lot entry is swept; only the 5-lot one is held')

  const stored = await state.get<{ intent: string }[]>('runner:unresolved')
  assert.equal(stored?.length, 1, 'the expired record is gone from STORAGE, not merely ignored')
  assert.match(stored?.[0]?.intent ?? '', /\|5\|/)

  // And the swept intent can be placed again, under a fresh id rather than
  // replaying a claim from hours ago.
  seen.length = 0
  await g.submit({ instrument: INSTRUMENT, side: 'BUY', lots: 2 })
  assert.notEqual(seen[0], strandedId, 'an expired id must not be replayed')
})

test('an expired id is not replayed even with no other traffic to trigger a sweep', async () => {
  /**
   * The read side of the TTL, on its own. A strategy that tries the same order
   * again tomorrow morning must not replay a claim parked yesterday afternoon:
   * the bridge would answer today's decision with yesterday's stored outcome,
   * and the strategy would book — or fail to book — against something that has
   * nothing to do with the order it just placed.
   */
  const clock = fixedClock(1_800_000_000_000)
  const seen: string[] = []
  const g = new HttpOrderGateway({
    baseUrl: 'http://bridge:8890',
    token: 'tok',
    tag: 'BN_BREAKOUT',
    mode: 'paper',
    underlying: 'BANKNIFTY',
    clock,
    log: makeLogger(),
    ledger,
    state,
    fetch: (async (_url: string, init: { body: string }) => {
      seen.push((JSON.parse(init.body) as Record<string, string>)['clientOrderId'] ?? '')
      throw new Error('ETIMEDOUT')
    }) as unknown as typeof globalThis.fetch,
    retryDelayMs: 0,
    unresolvedTtlMs: 60_000,
  })
  await g.load()
  await g.submit({ instrument: INSTRUMENT, side: 'BUY', lots: 2 })
  const heldId = seen[0]

  // Inside the TTL: replayed, because the claim may still be resolving.
  clock.set(1_800_000_000_000 + 30_000)
  seen.length = 0
  await g.submit({ instrument: INSTRUMENT, side: 'BUY', lots: 2 })
  assert.equal(seen[0], heldId)

  // Past it: a fresh id, because holding one forever means that exact order can
  // never be placed again.
  clock.set(1_800_000_000_000 + 61_000)
  seen.length = 0
  await g.submit({ instrument: INSTRUMENT, side: 'BUY', lots: 2 })
  assert.notEqual(seen[0], heldId)
})

test('cancel is unsupported and says so rather than pretending', async () => {
  const g = gateway(() => ({ body: { accepted: true } }))
  assert.equal(await g.cancel('c1'), false)
})
