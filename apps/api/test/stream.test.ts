/**
 * The push socket: who gets in, what they are sent, and what it cannot break.
 *
 * NO MONGO. Every property here is about the socket — the auth gate on the
 * upgrade, the per-mode filter, the null discipline on the wire, and the rule
 * that a broken notification can never fail an order. A test that needs a
 * database to prove any of those is a test that stops being run.
 *
 * The one that matters most is `a paper client never receives a live payload`.
 * Real money rendered under a badge that says PAPER is the most expensive thing
 * this dashboard could do, and "the server only sends what was asked for" is
 * exactly the kind of claim that stays true until someone adds a broadcast.
 */

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import type { IncomingMessage, Server } from 'node:http'
import { WebSocket } from 'ws'
import { createBridgeServer } from '../src/server.ts'
import { DeskStream, pnlUpdateFor, streamOrderEvent, type StreamFrame } from '../src/stream.ts'
import type { PnlRow } from '../src/pnl-jobs.ts'
import type { MarkedLeg } from '../src/rollup.ts'
import { streamRoutes } from '../src/routes/stream.ts'
import { cookieOf, SESSION_COOKIE } from '../src/authsvc.ts'
import type { AuthGate } from '../src/authgate.ts'
import { PaperRail } from '../src/rail.ts'
import type { Database } from '../src/store.ts'
import type { Fill } from '../src/contract.ts'
import type { RouteContext } from '../src/rail.ts'

const GOOD = 'a-valid-session'
const TOKEN = 'machine-token-for-tests'

/**
 * The real cookie parser, behind a fake session lookup.
 *
 * `cookieOf` is doing the security-relevant part — including refusing two
 * `dx_desk_session` cookies as ambiguous — so the upgrade is tested against the
 * same code the HTTP routes authenticate with, not against a stub that says
 * yes.
 */
const gate: AuthGate = {
  authenticate: async (req: IncomingMessage) => {
    if (cookieOf(req, SESSION_COOKIE) === GOOD) return { kind: 'user', name: 'operator' }
    if (req.headers.authorization === `Bearer ${TOKEN}`) return { kind: 'machine', name: 'bearer' }
    return null
  },
  reauth: async () => 'not used here',
}

let server: Server
let stream: DeskStream
let port = 0

before(async () => {
  // Heartbeat off: these tests assert on the frames they provoke, and a timer
  // firing mid-assertion would make them flaky for no property gained.
  stream = new DeskStream({ heartbeatMs: 0, now: () => 1_700_000_000_000 })
  server = createBridgeServer({
    gate,
    stream,
    routes: [streamRoutes({ stream })],
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
})

after(async () => {
  await stream.close()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

// ------------------------------------------------------------------ helpers

function url(): string {
  return `ws://127.0.0.1:${port}/v1/desk/stream`
}

/** Open a client, resolving on `open` and rejecting with the refusal's status. */
function connect(cookie: string | null): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url(), {
      headers: cookie === null ? {} : { cookie: `${SESSION_COOKIE}=${cookie}` },
    })
    ws.on('open', () => resolve(ws))
    ws.on('error', (err) => reject(err))
  })
}

/** Collect every frame a client receives, in order. */
function frames(ws: WebSocket): StreamFrame[] {
  const seen: StreamFrame[] = []
  ws.on('message', (raw) => seen.push(JSON.parse(String(raw)) as StreamFrame))
  return seen
}

/** Subscribe and wait for the server's acknowledgement, so a later publish
 *  cannot race the subscription it depends on. */
async function subscribe(ws: WebSocket, mode: 'paper' | 'live'): Promise<void> {
  const acked = new Promise<void>((resolve) => {
    const onMessage = (raw: unknown): void => {
      const frame = JSON.parse(String(raw)) as StreamFrame
      if (frame.type === 'subscribed' && frame.mode === mode) {
        ws.off('message', onMessage)
        resolve()
      }
    }
    ws.on('message', onMessage)
  })
  ws.send(JSON.stringify({ type: 'subscribe', mode }))
  await acked
}

function waitFor<T>(predicate: () => T | null, what: string, timeoutMs = 2000): Promise<T> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const poll = (): void => {
      const v = predicate()
      if (v !== null) {
        resolve(v)
        return
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error(`timed out waiting for ${what}`))
        return
      }
      setTimeout(poll, 5)
    }
    poll()
  })
}

const FILL = {
  clientOrderId: 'X-1',
  phase: 'FILL',
  ok: true,
  tag: 'ORB_SCALP_BN',
  tradingsymbol: 'BANKNIFTY26AUG52000CE',
  ts: 1_700_000_000_001,
  side: 'BUY',
  filledQty: 15,
  avgPrice: 131.5,
}

// -------------------------------------------------------------------- tests

describe('the upgrade', () => {
  test('a handshake with no session cookie is REFUSED', async () => {
    await assert.rejects(
      connect(null),
      // The status is the point: the page has to be able to tell "you are not
      // signed in" from "the bridge is down", or it reconnects forever against
      // a gate that will never let it in.
      (err: Error) => err.message.includes('401'),
    )
    assert.equal(stream.clientCount, 0)
  })

  test('a handshake with a session cookie is let in', async () => {
    const ws = await connect(GOOD)
    assert.equal(ws.readyState, WebSocket.OPEN)
    ws.close()
  })

  test('a path that is not the stream cannot be upgraded', async () => {
    await assert.rejects(
      new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/desk/pnl`, {
          headers: { cookie: `${SESSION_COOKIE}=${GOOD}` },
        })
        ws.on('open', () => resolve(ws))
        ws.on('error', reject)
      }),
      (err: Error) => err.message.includes('404'),
    )
  })
})

describe('the per-mode filter', () => {
  test('a client subscribed to PAPER never receives a LIVE payload', async () => {
    const paperTab = await connect(GOOD)
    const liveTab = await connect(GOOD)
    const paperSaw = frames(paperTab)
    const liveSaw = frames(liveTab)
    await subscribe(paperTab, 'paper')
    await subscribe(liveTab, 'live')

    stream.publish('live', { ...FILL, tag: 'REAL_MONEY' })
    // Published SECOND and to the other rail. Frames arrive on a socket in the
    // order they were sent, so if the live one had leaked it would be sitting
    // in front of this one — which is what makes the assertion below a real
    // check rather than a race the paper client happened to win.
    stream.publish('paper', { ...FILL, tag: 'PAPER_ONLY' })

    await waitFor(
      () => (liveSaw.some((f) => f.type === 'order') ? true : null),
      'the live client to receive its event',
    )
    const paperOrders = await waitFor(() => {
      const orders = paperSaw.filter((f) => f.type === 'order')
      return orders.length > 0 ? orders : null
    }, 'the paper client to receive its event')

    assert.equal(paperOrders.length, 1)
    assert.equal(paperOrders[0]?.type === 'order' ? paperOrders[0].mode : '', 'paper')
    assert.equal(
      paperOrders[0]?.type === 'order' ? paperOrders[0].event.tag : '',
      'PAPER_ONLY',
    )

    paperTab.close()
    liveTab.close()
  })

  test('a client that has subscribed to NOTHING is sent nothing', async () => {
    const ws = await connect(GOOD)
    const seen = frames(ws)
    stream.publish('paper', FILL)
    stream.publish('live', FILL)
    // Give the loop several turns; the assertion is that nothing ever arrives.
    await new Promise((r) => setTimeout(r, 50))
    assert.deepEqual(seen, [])
    ws.close()
  })

  test('an inbound frame that is not a subscribe does nothing at all', async () => {
    const ws = await connect(GOOD)
    const seen = frames(ws)
    // The socket is READ-ONLY. Orders, flattens and the kill switch stay on
    // HTTP, where a failure is visible — so an order-shaped frame arriving here
    // must be ignored rather than interpreted.
    ws.send(JSON.stringify({ type: 'submit', tag: 'ORB', lots: 5, mode: 'live' }))
    ws.send('not json at all')
    ws.send(JSON.stringify({ type: 'subscribe', mode: 'both' }))
    await new Promise((r) => setTimeout(r, 50))
    assert.deepEqual(seen, [])
    assert.equal(stream.subscriberCount('live'), 0)
    assert.equal(ws.readyState, WebSocket.OPEN, 'a bad frame must not drop the socket')
    ws.close()
  })
})

describe('null discipline on the wire', () => {
  test('an unpriced event is pushed as null, NEVER 0', () => {
    // A PLANNED event has no fill: no quantity, no price. A 0 in either field
    // is a claim about a fill that did not happen, and `avgPrice: 0` reads as a
    // free option — the same defect `rollup.ts` and `pnl.tsx` exist to prevent.
    const event = streamOrderEvent(
      { clientOrderId: 'X-1', phase: 'PLANNED', ok: true, tag: 'ORB', tradingsymbol: 'N26' },
      42,
    )
    assert.equal(event.avgPrice, null)
    assert.equal(event.filledQty, null)
    assert.equal(event.side, null)
    assert.equal(event.status, null)
    assert.notEqual(event.avgPrice, 0)
  })

  test('a real 0 survives — the rule is about UNKNOWN, not about zero', () => {
    const event = streamOrderEvent({ filledQty: 0, avgPrice: 0.05 }, 42)
    assert.equal(event.filledQty, 0)
    assert.equal(event.avgPrice, 0.05)
  })

  test('a missing timestamp becomes now, not 1970', () => {
    // A table sorted by time buries a 1970 row at the bottom, which is where
    // nobody looks for the event that just happened.
    assert.equal(streamOrderEvent({ phase: 'FILL' }, 42).ts, 42)
  })

  test('the null survives the socket, not just the normaliser', async () => {
    const ws = await connect(GOOD)
    const seen = frames(ws)
    await subscribe(ws, 'paper')
    stream.publish('paper', { clientOrderId: 'X-9', phase: 'PLANNED', ok: true })

    const frame = await waitFor(
      () => seen.find((f) => f.type === 'order') ?? null,
      'the pushed event',
    )
    assert.equal(frame.type === 'order' ? frame.event.avgPrice : 'missing', null)
    assert.equal(frame.type === 'order' ? frame.event.filledQty : 'missing', null)
    ws.close()
  })
})

describe('POST /v1/desk/stream/notify', () => {
  const post = async (body: unknown, headers: Record<string, string>): Promise<Response> =>
    await fetch(`http://127.0.0.1:${port}/v1/desk/stream/notify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    })

  test('it reaches the live subscribers', async () => {
    const ws = await connect(GOOD)
    const seen = frames(ws)
    await subscribe(ws, 'live')

    const res = await post(
      { mode: 'live', event: { ...FILL, phase: 'STATUS', status: 'FILLED' } },
      { authorization: `Bearer ${TOKEN}` },
    )
    assert.equal(res.status, 200)

    const frame = await waitFor(
      () => seen.find((f) => f.type === 'order') ?? null,
      'the notified event',
    )
    assert.equal(frame.type === 'order' ? frame.event.status : '', 'FILLED')
    ws.close()
  })

  test('a SESSION cannot inject an order event — only a machine token can', async () => {
    // Otherwise every operator with the dashboard open would see a fill that
    // never happened, attributed to a strategy, with nothing in the journal to
    // explain it.
    const res = await post({ mode: 'live', event: FILL }, { cookie: `${SESSION_COOKIE}=${GOOD}` })
    assert.equal(res.status, 403)
  })

  test('an unauthenticated notify is refused', async () => {
    assert.equal((await post({ mode: 'live', event: FILL }, {})).status, 401)
  })

  test("a 'paper' notify is ACCEPTED and lands on the paper tab (D14)", async () => {
    /**
     * This used to be a 400, on the premise that the gateway reads only the
     * live queue — so a paper event arriving from it was a bug. The engine's
     * paper orders are worked through that very queue now, and while this
     * refused them the gateway sent them all as `'live'` instead: a
     * rehearsal's every step in front of an operator watching real money,
     * which is the failure the refusal existed to prevent, arriving through
     * the other door.
     */
    const res = await post({ mode: 'paper', event: FILL }, { authorization: `Bearer ${TOKEN}` })
    assert.equal(res.status, 200)
  })

  test('a notify with no mode, or a mode that is neither, is still a 400', async () => {
    // The frame is scoped by rail and a default would put an event on a tab
    // nobody chose. Widening the accepted set is not the same as guessing.
    for (const mode of [undefined, '', 'LIVE', 'both', 1, null]) {
      const res = await post({ mode, event: FILL }, { authorization: `Bearer ${TOKEN}` })
      assert.equal(res.status, 400, `mode=${JSON.stringify(mode)} must be refused`)
    }
  })
})

describe('a notification can never fail an order', () => {
  /** Just enough Database to record what the rail wrote. */
  function fakeDb(written: Record<string, unknown>[]): Database {
    return {
      collection: () => ({
        insertOne: async (doc: Record<string, unknown>) => {
          written.push(doc)
          return {}
        },
      }),
    } as unknown as Database
  }

  const fill: Fill = {
    op: 'open',
    deskTag: 'X-1#0',
    tradingsymbol: 'BANKNIFTY26AUG52000CE',
    side: 'Buy',
    qty: 15,
    price: 131.5,
    ts: 1,
  }
  const ctx: RouteContext = {
    tag: 'ORB_SCALP_BN',
    underlying: 'BANKNIFTY',
    instrument: {
      tradingsymbol: 'BANKNIFTY26AUG52000CE',
      lotSize: 15,
      tickSize: 0.05,
      exchange: 'NFO',
      instrumentToken: 12345,
    },
    nowMs: 1,
    clientOrderId: 'X-1#0',
  }

  test('a THROWING emit does not fail PaperRail.route, and the fill is still written', async () => {
    const written: Record<string, unknown>[] = []
    const rail = new PaperRail(fakeDb(written), () => {
      throw new Error('the dashboard socket exploded')
    })

    await rail.route(fill, ctx)

    // The fill is durable. That is the only thing the caller was promised, and
    // the notification failing must not turn it into a routing error — the
    // caller would then be told an order did not go out when it did.
    assert.equal(written.length, 1)
    assert.equal(written[0]?.['clientOrderId'], 'X-1#0')
  })

  test('the emit sees the fill in the shape the Orders page renders', async () => {
    const seen: { mode: string; event: Record<string, unknown> }[] = []
    const rail = new PaperRail(fakeDb([]), (mode, event) => seen.push({ mode, event }))
    await rail.route(fill, ctx)
    assert.equal(seen.length, 1)
    assert.equal(seen[0]?.mode, 'paper')
    assert.equal(seen[0]?.event['phase'], 'FILL')
    assert.equal(seen[0]?.event['avgPrice'], 131.5)
  })

  test('publish() itself never throws, whatever it is handed', () => {
    const circular: Record<string, unknown> = { phase: 'FILL' }
    circular['self'] = circular
    // `JSON.stringify` throws on a cycle. It must not be able to throw INSIDE
    // the order path — the single worst place for a new exception.
    assert.doesNotThrow(() => stream.publish('paper', circular))
  })
})

// ============================================================ P&L on the wire

/**
 * SNAPSHOT, THEN COALESCED DELTAS.
 *
 * The push used to be one COMPLETE `PnlRow` per tick per held instrument,
 * unthrottled — ~16 held tokens ticking several times a second, every leg and
 * every field — and the dashboard parsed each frame and threw it away. The desk
 * paid full bandwidth and full client parse cost for data nobody rendered, while
 * the LTP on screen moved only on the 15s REST poll.
 *
 * Two of the properties below are CORRECTNESS, not performance:
 *
 *  1. **An omitted field means UNCHANGED; an unknown value is an explicit
 *     `null`.** Conflate them and a leg the feed can no longer price keeps
 *     reporting its last known mark as though it were live. Both directions are
 *     pinned.
 *  2. **A fill sends the WHOLE row.** `qty`, `avgCost`, `realised` and the
 *     buy/sell figures are deliberately absent from a tick delta because a tick
 *     cannot move them — so a fill that does move them must not arrive as a
 *     diff the client cannot apply.
 *
 * The third is performance, and it is MEASURED rather than asserted by eye —
 * see the last describe in this file.
 */

function markedLeg(over: Partial<MarkedLeg> & { tradingsymbol: string }): MarkedLeg {
  return {
    qty: -100,
    avgCost: 15,
    mark: 12,
    unrealised: 300,
    realised: 0,
    buyQty: 0,
    buyValue: 0,
    sellQty: 100,
    sellValue: 1500,
    mtm: 300,
    ...over,
  }
}

function pnlRow(over: Partial<PnlRow> & { tag: string }): PnlRow {
  return {
    label: over.tag,
    mode: 'paper',
    realised: 0,
    unrealised: 300,
    total: 300,
    openLegs: 1,
    legs: [markedLeg({ tradingsymbol: 'BHEL26AUG420CE' })],
    unpriced: [],
    complete: true,
    ...over,
  }
}

/** The same row with its first leg re-marked, as a tick would produce it. */
function reMarked(row: PnlRow, mark: number | null, unrealised: number | null): PnlRow {
  const first = row.legs[0] as MarkedLeg
  return {
    ...row,
    unrealised,
    total: unrealised,
    complete: unrealised !== null,
    unpriced: unrealised === null ? [first.tradingsymbol] : [],
    legs: [{ ...first, mark, unrealised, mtm: unrealised }, ...row.legs.slice(1)],
  }
}

describe('what a delta says, and what it deliberately does not', () => {
  test('a row nobody moved produces NOTHING — not an empty delta', () => {
    // The commonest case in a quiet session: every held instrument ticked to
    // the price it already had. The cheapest frame is the one not sent.
    const row = pnlRow({ tag: 'DESK_BHEL' })
    assert.equal(pnlUpdateFor(row, pnlRow({ tag: 'DESK_BHEL' })).kind, 'none')
  })

  test('a first sighting is the WHOLE row — there is nothing to diff against', () => {
    assert.equal(pnlUpdateFor(undefined, pnlRow({ tag: 'DESK_BHEL' })).kind, 'full')
  })

  test('a moved mark sends the three fields a tick can move, AND NOTHING ELSE', () => {
    const before = pnlRow({ tag: 'DESK_BHEL' })
    const update = pnlUpdateFor(before, reMarked(before, 10, 500))
    assert.equal(update.kind, 'delta')
    if (update.kind !== 'delta') return
    const d = update.delta
    /**
     * THE FIELDS THAT NEED A FILL MUST NOT BE ON THE WIRE. `realised`, `qty`,
     * `avgCost`, the four buy/sell figures, `openLegs` and `label` cannot change
     * without one, and resending them on every tick is most of what the old
     * protocol spent its bandwidth on.
     */
    assert.deepEqual(Object.keys(d).sort(), ['legs', 'tag', 'total', 'unrealised'])
    assert.equal(d.unrealised, 500)
    assert.equal(d.total, 500)
    assert.equal(d.legs?.length, 1)
    assert.deepEqual(
      Object.keys(d.legs?.[0] ?? {}).sort(),
      ['mark', 'mtm', 'tradingsymbol', 'unrealised'],
    )
    assert.equal(d.legs?.[0]?.mark, 10)
    assert.equal(Object.hasOwn(d.legs?.[0] ?? {}, 'qty'), false)
    assert.equal(Object.hasOwn(d.legs?.[0] ?? {}, 'realised'), false)
  })

  test('a leg that did NOT move is left out entirely — absent means unchanged', () => {
    const two = pnlRow({
      tag: 'DESK_BHEL',
      openLegs: 2,
      legs: [
        markedLeg({ tradingsymbol: 'BHEL26AUG420CE' }),
        markedLeg({ tradingsymbol: 'BHEL26AUG400PE', mark: 9, unrealised: 200, mtm: 200 }),
      ],
    })
    const moved: PnlRow = {
      ...two,
      unrealised: 500,
      total: 500,
      legs: [
        { ...(two.legs[0] as MarkedLeg), mark: 10, unrealised: 500, mtm: 500 },
        two.legs[1] as MarkedLeg,
      ],
    }
    const update = pnlUpdateFor(two, moved)
    assert.equal(update.kind, 'delta')
    if (update.kind !== 'delta') return
    assert.equal(update.delta.legs?.length, 1, 'only the CE moved')
    assert.equal(update.delta.legs?.[0]?.tradingsymbol, 'BHEL26AUG420CE')
  })

  test('a leg that LOSES its mark is sent as an explicit null, never omitted', () => {
    /**
     * THE DANGEROUS ONE. "Omitted" and "null" are opposite claims — unchanged
     * versus unknown — and if a leg losing its quote arrived as an omission the
     * dashboard would keep rendering its last price beside a position whose
     * value nobody knows. Serialised here as well as inspected, because the rule
     * only holds if it survives `JSON.stringify`.
     */
    const before = pnlRow({ tag: 'DESK_BHEL' })
    const update = pnlUpdateFor(before, reMarked(before, null, null))
    assert.equal(update.kind, 'delta')
    if (update.kind !== 'delta') return
    const d = update.delta
    assert.equal(d.unrealised, null)
    assert.equal(d.total, null)
    assert.equal(d.complete, false)
    assert.deepEqual(d.unpriced, ['BHEL26AUG420CE'])
    assert.equal(d.legs?.[0]?.mark, null)
    assert.equal(d.legs?.[0]?.mtm, null)

    const wire = JSON.parse(JSON.stringify(d)) as Record<string, unknown>
    assert.equal(Object.hasOwn(wire, 'unrealised'), true, 'null must SURVIVE the wire')
    assert.equal(wire['unrealised'], null)
    const leg = (wire['legs'] as Record<string, unknown>[])[0] as Record<string, unknown>
    assert.equal(Object.hasOwn(leg, 'mark'), true)
    assert.equal(leg['mark'], null)
  })

  test('an omitted field really is ABSENT after serialisation', () => {
    // `JSON.stringify` drops `undefined` keys, which is what makes "absent"
    // expressible at all — but only if the field was never set. An
    // `{ mark: undefined }` is one serialiser change away from becoming a
    // transmitted `null`, i.e. from "unchanged" silently becoming "unknown".
    const before = pnlRow({ tag: 'DESK_BHEL' })
    const update = pnlUpdateFor(before, reMarked(before, 10, 500))
    if (update.kind !== 'delta') throw new Error('expected a delta')
    const wire = JSON.parse(JSON.stringify(update.delta)) as Record<string, unknown>
    assert.equal(Object.hasOwn(wire, 'complete'), false, 'unchanged, so not on the wire')
    assert.equal(Object.hasOwn(wire, 'unpriced'), false)
    assert.equal(Object.hasOwn(wire, 'realised'), false)
  })

  test('a FILL sends the whole row, because a tick delta cannot describe one', () => {
    const before = pnlRow({ tag: 'DESK_BHEL' })
    // Bought back 40 of the 100 short. `qty`, `realised` and the buy side all
    // move — none of which a tick delta carries.
    const after: PnlRow = {
      ...before,
      realised: 120,
      legs: [
        markedLeg({
          tradingsymbol: 'BHEL26AUG420CE',
          qty: -60,
          buyQty: 40,
          buyValue: 480,
          realised: 120,
        }),
      ],
    }
    assert.equal(pnlUpdateFor(before, after).kind, 'full')
  })

  test('a leg appearing, a leg going, or a relabel also sends the whole row', () => {
    const one = pnlRow({ tag: 'DESK_BHEL' })
    const two: PnlRow = {
      ...one,
      openLegs: 2,
      legs: [...one.legs, markedLeg({ tradingsymbol: 'BHEL26AUG400PE' })],
    }
    assert.equal(pnlUpdateFor(one, two).kind, 'full', 'a leg appeared')
    assert.equal(pnlUpdateFor(two, one).kind, 'full', 'a leg went')
    assert.equal(
      pnlUpdateFor(one, { ...one, label: 'renamed' }).kind,
      'full',
      'the label is not a tick field, so it rides on a full row',
    )
  })
})

// ------------------------------------------------- the socket, end to end

/**
 * A second server, with its own stream.
 *
 * Separate from the one above because this one has a snapshot provider, and a
 * snapshot frame arriving on every subscribe would change what the tests up
 * there collect. `pnlMs: 0` disables the flush timer so these drive `flushPnl()`
 * themselves — a test that slept past a real timer would be asserting on the
 * clock rather than on the protocol.
 */
describe('the P&L socket', () => {
  const DESK: readonly PnlRow[] = [
    pnlRow({ tag: 'DESK_BHEL' }),
    pnlRow({ tag: 'ORB_SCALP_BN', legs: [markedLeg({ tradingsymbol: 'BANKNIFTY26AUG52000CE' })] }),
  ]

  let pnlServer: Server
  let pnlStream: DeskStream
  let pnlPort = 0
  /** What the snapshot provider answers with. Mutable so a test can empty it. */
  let desk: readonly PnlRow[] | null = DESK

  /**
   * A tag no other test has published, and the two-leg row under it.
   *
   * THE DELTA BASELINE IS PER TAG AND LIVES FOR THE LIFE OF THE STREAM, which
   * is the whole point of it — so two tests re-marking the SAME tag would have
   * the second one diffing against the first one's last price and asserting on
   * a field the protocol correctly decided was unchanged. A fresh tag per test
   * is what makes each one a statement about the protocol rather than about
   * execution order.
   */
  let unique = 0
  function fresh(): { tag: string; row: PnlRow } {
    const tag = `T${++unique}`
    return { tag, row: pnlRow({ tag }) }
  }

  before(async () => {
    desk = DESK
    pnlStream = new DeskStream({
      heartbeatMs: 0,
      pnlMs: 0,
      now: () => 1_700_000_000_000,
      snapshot: async (mode) => (desk === null ? null : desk.map((r) => ({ ...r, mode }))),
    })
    pnlServer = createBridgeServer({
      gate,
      stream: pnlStream,
      routes: [streamRoutes({ stream: pnlStream })],
    })
    await new Promise<void>((resolve) => pnlServer.listen(0, '127.0.0.1', resolve))
    pnlPort = (pnlServer.address() as AddressInfo).port
  })

  after(async () => {
    await pnlStream.close()
    await new Promise<void>((resolve) => pnlServer.close(() => resolve()))
  })

  function client(): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${pnlPort}/v1/desk/stream`, {
        headers: { cookie: `${SESSION_COOKIE}=${GOOD}` },
      })
      ws.on('open', () => resolve(ws))
      ws.on('error', reject)
    })
  }

  /** Subscribe, and resolve on the SNAPSHOT rather than on the ack. */
  async function subscribed(
    ws: WebSocket,
    mode: 'paper' | 'live',
    tags?: readonly string[],
  ): Promise<StreamFrame[]> {
    const seen = frames(ws)
    ws.send(JSON.stringify({ type: 'subscribe', mode, ...(tags === undefined ? {} : { tags }) }))
    await waitFor(
      () => seen.find((f) => f.type === 'pnl-snapshot') ?? null,
      'the P&L snapshot',
    )
    return seen
  }

  const deltas = (seen: readonly StreamFrame[]): Extract<StreamFrame, { type: 'pnl-delta' }>[] =>
    seen.filter((f) => f.type === 'pnl-delta')

  test('subscribing gets a FULL snapshot of every row, before any delta', async () => {
    const ws = await client()
    const seen = await subscribed(ws, 'paper')
    const snap = seen.find((f) => f.type === 'pnl-snapshot')
    assert.ok(snap?.type === 'pnl-snapshot')
    assert.deepEqual(snap.rows.map((r) => r.tag), ['DESK_BHEL', 'ORB_SCALP_BN'])
    // Whole rows: this is the base every later delta is read against, so the
    // fields a delta never carries have to arrive here or nowhere.
    assert.equal(snap.rows[0]?.legs[0]?.avgCost, 15)
    assert.equal(snap.rows[0]?.realised, 0)
    ws.close()
  })

  test('a tag filter narrows the SNAPSHOT and the DELTAS to that one tag', async () => {
    // The strategy page renders one strategy. Pushing it the whole desk is the
    // waste this filter exists to remove — but it is BANDWIDTH only: the mode
    // filter above it is untouched and is what keeps the rails apart.
    const ws = await client()
    const seen = await subscribed(ws, 'paper', ['ORB_SCALP_BN'])
    const snap = seen.find((f) => f.type === 'pnl-snapshot')
    assert.ok(snap?.type === 'pnl-snapshot')
    assert.deepEqual(snap.rows.map((r) => r.tag), ['ORB_SCALP_BN'])

    pnlStream.publishPnl('paper', reMarked(DESK[0] as PnlRow, 10, 500))
    pnlStream.publishPnl('paper', reMarked(DESK[1] as PnlRow, 8, 700))
    pnlStream.flushPnl()

    const got = await waitFor(() => deltas(seen)[0] ?? null, 'a delta')
    const named = [...got.rows.map((r) => r.tag), ...got.deltas.map((d) => d.tag)]
    assert.deepEqual(named, ['ORB_SCALP_BN'], 'the other tag moved too and was not sent')
    ws.close()
  })

  test('an EMPTY tag list means none — a page with no P&L is sent no P&L', async () => {
    /**
     * Absent means every tag, so that a client that knows nothing about tags is
     * unaffected. Present-but-empty has to mean the opposite, or the Orders
     * page — which renders order events and no P&L at all — would keep pulling
     * the whole desk's marks for a table with no column for them.
     */
    const ws = await client()
    const seen = frames(ws)
    ws.send(JSON.stringify({ type: 'subscribe', mode: 'paper', tags: [] }))
    await waitFor(() => seen.find((f) => f.type === 'pnl-snapshot') ?? null, 'the snapshot')
    const snap = seen.find((f) => f.type === 'pnl-snapshot')
    assert.ok(snap?.type === 'pnl-snapshot')
    assert.deepEqual(snap.rows, [])

    pnlStream.publishPnl('paper', reMarked(DESK[0] as PnlRow, 10, 500))
    pnlStream.flushPnl()
    await new Promise((r) => setTimeout(r, 50))
    assert.deepEqual(deltas(seen), [], 'nothing was asked for, so nothing arrives')
    ws.close()
  })

  test('MANY ticks between flushes cost ONE frame — the coalescing', async () => {
    const { tag, row } = fresh()
    desk = [row]
    const ws = await client()
    const seen = await subscribed(ws, 'paper')

    // The baseline first: a tag this stream has never flushed has nothing to be
    // diffed against, so it correctly goes out whole.
    pnlStream.publishPnl('paper', row)
    pnlStream.flushPnl()
    await waitFor(() => deltas(seen)[0] ?? null, 'the first, whole-row, frame')
    assert.equal(deltas(seen)[0]?.rows.length, 1, 'a first sighting is the whole row')

    // Forty re-marks on the same tag, as forty ticks on a held instrument
    // would produce them. The old protocol sent forty complete rows.
    for (let i = 1; i <= 40; i++) {
      pnlStream.publishPnl('paper', reMarked(row, 12 - i * 0.05, 300 + i))
    }
    pnlStream.flushPnl()

    const got = await waitFor(() => deltas(seen)[1] ?? null, 'the coalesced flush')
    assert.equal(deltas(seen).length, 2, 'forty ticks, one frame')
    assert.equal(got.rows.length, 0, 'nothing here needed a whole row')
    assert.equal(got.deltas.length, 1)
    assert.equal(got.deltas[0]?.tag, tag)
    // And it carries the LAST price, not the first — a coalescer that kept the
    // stale one would be worse than no coalescer at all.
    assert.equal(got.deltas[0]?.legs?.[0]?.mark, 12 - 40 * 0.05)
    assert.equal(got.deltas[0]?.unrealised, 340)
    desk = DESK
    ws.close()
  })

  test('a flush where nothing actually moved sends NOTHING', async () => {
    const { row } = fresh()
    desk = [row]
    const ws = await client()
    const seen = await subscribed(ws, 'paper')
    // Re-marked to the price it already had — the common case in a quiet
    // session, and the cheapest frame is the one not sent. Twice, so the
    // baseline is established by the first and the second is the no-op.
    pnlStream.publishPnl('paper', reMarked(row, 11, 400))
    pnlStream.flushPnl()
    await waitFor(() => deltas(seen)[0] ?? null, 'the first, real, delta')
    pnlStream.publishPnl('paper', reMarked(row, 11, 400))
    pnlStream.flushPnl()
    await new Promise((r) => setTimeout(r, 50))
    assert.equal(deltas(seen).length, 1, 'the second flush had nothing to say')
    desk = DESK
    ws.close()
  })

  test('a PAPER client is never sent a LIVE delta', async () => {
    const paperTab = await client()
    const liveTab = await client()
    const paperSaw = await subscribed(paperTab, 'paper')
    const liveSaw = await subscribed(liveTab, 'live')

    pnlStream.publishPnl('live', { ...(DESK[0] as PnlRow), mode: 'live', unrealised: 9999, total: 9999 })
    pnlStream.flushPnl()

    await waitFor(() => deltas(liveSaw)[0] ?? null, 'the live delta')
    await new Promise((r) => setTimeout(r, 50))
    assert.deepEqual(deltas(paperSaw), [], 'real money must never reach a paper tab')
    paperTab.close()
    liveTab.close()
  })

  test('with no loaded book there is no snapshot AND no deltas', async () => {
    /**
     * An empty snapshot would say "this desk holds nothing", which is the
     * confident-wrong answer `LiveBook.ready` exists to avoid. And a delta with
     * no base under it is worse than no delta: the client would have nothing to
     * apply it to. So the socket is simply left on REST.
     */
    const { row } = fresh()
    desk = null
    try {
      const ws = await client()
      const seen = frames(ws)
      ws.send(JSON.stringify({ type: 'subscribe', mode: 'paper' }))
      await waitFor(() => seen.find((f) => f.type === 'subscribed') ?? null, 'the ack')
      // A tag nothing has published, so the flush genuinely has something to
      // send — otherwise the assertion below would pass for the wrong reason.
      pnlStream.publishPnl('paper', reMarked(row, 10, 500))
      pnlStream.flushPnl()
      await new Promise((r) => setTimeout(r, 50))
      assert.equal(seen.some((f) => f.type === 'pnl-snapshot'), false)
      assert.deepEqual(deltas(seen), [])
      ws.close()
    } finally {
      desk = DESK
    }
  })

  test('publishPnl and flushPnl never throw, whatever they are handed', () => {
    // Both run inside the process that routes orders — `publishPnl` on the
    // marketdata bus, `flushPnl` on a timer. Neither may become a new way for a
    // dashboard update to take the order path down.
    const circular = pnlRow({ tag: 'BAD' }) as PnlRow & { self?: unknown }
    circular.self = circular
    assert.doesNotThrow(() => pnlStream.publishPnl('paper', circular))
    assert.doesNotThrow(() => pnlStream.flushPnl())
  })
})

// ------------------------------------------------------------ the measurement

/**
 * WHAT THE COALESCING ACTUALLY SAVES, counted rather than estimated.
 *
 * The desk holds ~16 tokens and each ticks several times a second. The old
 * protocol sent one COMPLETE `PnlRow` per re-mark; the new one sends the changed
 * fields of the changed tags, once per 250ms flush. Both are measured here over
 * the same simulated minute, on the same rows, with real `JSON.stringify` — the
 * numbers in the commit message come from this test.
 */
describe('the bandwidth this replaced', () => {
  test('a simulated trading minute costs an order of magnitude less', () => {
    const FLUSH_MS = 250
    const SECONDS = 60
    /** 8 strategies of 2 legs = the ~16 held tokens the desk actually runs. */
    const STRATEGIES = 8
    const TOKENS = STRATEGIES * 2
    const TICKS_PER_TOKEN_PER_SEC = 6

    const book = new Map<string, PnlRow>()
    const tags: string[] = []
    for (let s = 0; s < STRATEGIES; s++) {
      const tag = `DESK_${s}`
      tags.push(tag)
      book.set(tag, pnlRow({
        tag,
        openLegs: 2,
        legs: [
          markedLeg({ tradingsymbol: `SENSEX26JUL${77000 + s * 100}CE` }),
          markedLeg({
            tradingsymbol: `SENSEX26JUL${76000 + s * 100}PE`,
            mark: 9,
            unrealised: 200,
            mtm: 200,
          }),
        ],
      }))
    }

    let beforeFrames = 0
    let beforeBytes = 0
    let afterFrames = 0
    let afterBytes = 0
    // The flush is measured through the same code the socket runs, minus the
    // socket: `pnlUpdateFor` against the baseline, then the real serialiser.
    const baseline = new Map<string, PnlRow>()
    let pending = new Map<string, PnlRow>()

    /** One tick every `TICK_MS`, round-robin across the held tokens. */
    const TICK_MS = 1000 / (TOKENS * TICKS_PER_TOKEN_PER_SEC)
    let nextFlushAt = FLUSH_MS
    const flush = (): void => {
      const rows: PnlRow[] = []
      const ds: unknown[] = []
      for (const [tag, row] of pending) {
        const update = pnlUpdateFor(baseline.get(tag), row)
        baseline.set(tag, row)
        if (update.kind === 'full') rows.push(row)
        else if (update.kind === 'delta') ds.push(update.delta)
      }
      pending = new Map()
      // A flush with nothing to say costs nothing, which is most of a quiet
      // session — so it is counted honestly rather than as a fixed 4/s.
      if (rows.length === 0 && ds.length === 0) return
      afterFrames++
      afterBytes += JSON.stringify({ type: 'pnl-delta', mode: 'paper', rows, deltas: ds }).length
    }

    for (let i = 0; i * TICK_MS < SECONDS * 1000; i++) {
      const ms = i * TICK_MS
      while (ms >= nextFlushAt) {
        flush()
        nextFlushAt += FLUSH_MS
      }
      const tag = tags[i % STRATEGIES] as string
      const row = book.get(tag) as PnlRow
      // Prices WANDER. A measurement on a frozen book would flatter the new
      // protocol by letting every delta come out empty.
      const mark = Math.round((10 + Math.sin(ms / 700 + i) * 2) * 20) / 20
      const next = reMarked(row, mark, 300 + Math.round(mark * 10))
      book.set(tag, next)
      pending.set(tag, next)
      // OLD: one COMPLETE row on the wire per re-mark, unthrottled.
      beforeFrames++
      beforeBytes += JSON.stringify({ type: 'pnl', mode: 'paper', row: next }).length
    }
    flush()

    // Printed so the improvement is a number somebody can read in the run
    // output rather than a ratio buried in an assertion.
    console.log(
      `[pnl push] before ${(beforeFrames / SECONDS).toFixed(1)} frames/s, ` +
        `${Math.round(beforeBytes / SECONDS)} B/s — ` +
        `after ${(afterFrames / SECONDS).toFixed(1)} frames/s, ` +
        `${Math.round(afterBytes / SECONDS)} B/s ` +
        `(${(beforeFrames / afterFrames).toFixed(0)}x fewer frames, ` +
        `${(beforeBytes / afterBytes).toFixed(0)}x fewer bytes)`,
    )

    // THE COALESCING IS THE HEADLINE: ~96 frames/s becomes at most 4/s, because
    // the cadence is the flush and not the feed.
    assert.ok(afterFrames <= SECONDS * (1000 / FLUSH_MS) + 1, 'at most one frame per flush')
    assert.ok(beforeFrames / afterFrames > 20, 'frames must fall by more than 20x')
    // And the payload shrinks ON TOP of that, because the fields that need a
    // fill are not on a tick delta at all.
    assert.ok(beforeBytes / afterBytes > 10, 'bytes must fall by more than 10x')
  })
})
