import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { skipUnlessMongo } from '../../api/test/require-mongo.ts'
import type { LiveFrame } from '../src/analytics/r3-wire.ts'
import { matchLeg, spotTokenOf } from '../src/market/master.ts'
import { OCT, fakeQuotes, priceChain, r3Master } from './fixtures/r3-market.ts'
import { startTraders, type TradersHarness } from './harness.ts'

const M = r3Master()
const T0 = Date.UTC(2026, 9, 19, 4, 0, 0)   // the harness clock: Monday 09:30 IST, in session
const quotes = fakeQuotes()
quotes.set(spotTokenOf(M, 'TCS') as number, { price: 3395, asOf: T0 })
quotes.set(M.options.future('TCS', OCT)?.instrumentToken as number, { price: 3400, bid: 3399.5, ask: 3400.5, asOf: T0 })
priceChain(quotes, M, 'TCS', OCT, 3400, 0.25, T0)
const CE3300 = matchLeg(M, { stock: 'TCS', instrument: 'option', expiry: OCT, strike: 3300, optType: 'CE' }) as number

const h: TradersHarness | null = await startTraders({ suite: 'live', master: M, quotes })
after(async () => { await h?.close() })

let ravi: (path: string, init?: RequestInit) => Promise<Response>

before(async () => {
  if (h === null) return
  await h.addUser('ravi')
  ravi = h.as('ravi')
  const r = await ravi('/v1/traders/books/TCS/legs', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ instrument: 'option', expiry: OCT, strike: 3300, optType: 'CE', qty: -175, avgPrice: 120 }),
  })
  assert.equal(r.status, 201, await r.text())
})

/** The stream's events as they come: the next `frame`, or null when none comes within `ms`. */
function frames(r: Response): { next(ms: number): Promise<LiveFrame | null>; close(): Promise<void> } {
  const reader = r.body!.getReader()
  const dec = new TextDecoder()
  let buf = ''
  let pending: ReturnType<typeof reader.read> | null = null
  return {
    async next(ms) {
      const deadline = Date.now() + ms
      for (;;) {
        const m = /event: frame\ndata: (.*)\n\n/.exec(buf)
        if (m !== null) { buf = buf.slice(m.index + m[0].length); return JSON.parse(m[1]!) as LiveFrame }
        const left = deadline - Date.now()
        if (left <= 0) return null
        pending ??= reader.read()
        const got = await Promise.race([pending, new Promise<null>((res) => setTimeout(() => res(null), left))])
        if (got === null) return null
        pending = null
        if (got.done) return null
        buf += dec.decode(got.value)
      }
    },
    async close() { await reader.cancel() },
  }
}

test('the stream: a frame at once, a new one when a price moves, nothing while it does not', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const r = await ravi('/v1/traders/books/TCS/live')
  assert.equal(r.status, 200)
  assert.equal(r.headers.get('content-type'), 'text/event-stream; charset=utf-8')
  assert.equal(r.headers.get('cache-control'), 'no-store')
  assert.equal(r.headers.get('content-encoding'), null)
  const s = frames(r)
  try {
    const first = await s.next(3_000)
    assert.ok(first !== null)
    assert.equal(first.stock, 'TCS')
    assert.equal(first.legs.length, 1)
    assert.equal(first.legs[0]!.ltp, quotes.quote(CE3300)!.price)
    assert.equal(first.spot, 3395)
    // P&L: the book's series net at the frame's prices, the book's own figure (a manual leg: nothing booked, no charges)
    const book = async (): Promise<any> => (await ravi('/v1/traders/books/TCS')).json()
    assert.equal(first.seriesNet, (await book()).seriesTotal.net)
    assert.equal(await s.next(1_600), null, 'an unchanged market sends no frame')
    quotes.set(CE3300, { price: 133.25, asOf: T0 })
    const moved = await s.next(3_000)
    assert.ok(moved !== null)
    assert.equal(moved.legs[0]!.ltp, 133.25)
    assert.equal(moved.legs[0]!.grossMtm, -175 * (133.25 - 120))
    assert.deepEqual([moved.seriesNet, moved.seriesOpen, moved.seriesBooked, moved.seriesCharges], [-175 * (133.25 - 120), -175 * (133.25 - 120), 0, 0])
    assert.equal(moved.seriesNet, (await book()).seriesTotal.net)
  } finally {
    await s.close()
  }
})

test('a book the trader does not hold is a 404 before any stream opens; no session is a 401', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  assert.equal((await ravi('/v1/traders/books/INFY/live')).status, 404)
  assert.equal((await fetch(`${h.url}/v1/traders/books/TCS/live`)).status, 401)
})
