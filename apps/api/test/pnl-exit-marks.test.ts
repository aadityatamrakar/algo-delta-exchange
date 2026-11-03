/**
 * Exit-side P&L marks (spec 2026-08-21-exit-side-marks-design.md).
 *
 * The resolver values each open leg at the side of the book that would close
 * it — long at bid, short at ask — and LTP never substitutes. Born from the
 * BHEL +25k display incident (2026-08-21).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { QuoteCache, type ExitSide } from '../src/marks.ts'
import { defaultMarkResolver, defaultQuoteResolver, pnlRowFor } from '../src/pnl-jobs.ts'
import type { ApiDeps } from '../src/routes/kit.ts'
import type { StampedFill } from '../src/rollup.ts'

const T0 = 1_000_000

/**
 * The resolver's rule now turns on whether the SESSION is open, so every test
 * has to say which side of 15:30 it is standing on. Both are the same Monday.
 */
const IST_OPEN = Date.parse('2026-09-07T12:00:00+05:30')
const IST_CLOSED = Date.parse('2026-09-07T18:52:00+05:30')

const fill = (
  tradingsymbol: string,
  side: 'Buy' | 'Sell',
  qty: number,
  price: number,
  ts = T0,
): StampedFill => ({ tradingsymbol, side, qty, price, ts })

test('pnlRowFor hands the resolver each open symbol with its EXIT side', () => {
  const seen: Array<ReadonlyMap<string, ExitSide>> = []
  const row = pnlRowFor({
    tag: 'T',
    label: 'T',
    mode: 'paper',
    fills: [
      fill('XCE', 'Sell', 100, 10), // short → closes with a Buy → ask
      fill('XPE', 'Buy', 100, 4), // long → closes with a Sell → bid
      fill('XFLAT', 'Buy', 50, 2),
      fill('XFLAT', 'Sell', 50, 3), // round trip — no open qty, no exit side
    ],
    boundary: T0 - 1,
    marksOf: (symbols, exits) => {
      seen.push(exits)
      return {
        XCE: exits.get('XCE') === 'Buy' ? 10.2 : -1,
        XPE: exits.get('XPE') === 'Sell' ? 3.8 : -1,
      }
    },
    malformed: [],
  })
  assert.equal(seen[0]?.get('XCE'), 'Buy')
  assert.equal(seen[0]?.get('XPE'), 'Sell')
  assert.equal(seen[0]?.has('XFLAT'), false, 'a flat contract needs no mark')
  const xce = row.legs.find((l) => l.tradingsymbol === 'XCE')
  assert.equal(xce?.mark, 10.2, 'the short leg is valued at the ask')
})

test('defaultMarkResolver prices off the book side, never the last print', () => {
  let now = IST_OPEN
  const cache = new QuoteCache({ now: () => now })
  cache.update(11, 10.0, undefined, { bid: 9.8, ask: 10.2 })
  cache.update(12, 4.0, undefined, { bid: 3.8, ask: 4.1 })
  cache.update(13, 7.77) // LTP only, no book ever — must resolve to NOTHING
  const master = {
    current: () => ({
      resolveSymbol: (s: string) => {
        const token = { XCE: 11, XPE: 12, XNB: 13 }[s]
        return token === undefined
          ? null
          : { tradingsymbol: s, instrumentToken: token, lotSize: 1, tickSize: 0.05, exchange: 'NFO' }
      },
    }),
  }
  const deps = { marks: cache, master, now: () => now } as unknown as ApiDeps
  const resolve = defaultMarkResolver(deps)
  const exits = new Map<string, ExitSide>([
    ['XCE', 'Buy'],
    ['XPE', 'Sell'],
    ['XNB', 'Buy'],
  ])
  const marks = resolve(['XCE', 'XPE', 'XNB'], exits)
  assert.equal(marks['XCE'], 10.2, 'short: valued at the ask')
  assert.equal(marks['XPE'], 3.8, 'long: valued at the bid')
  assert.equal('XNB' in marks, false, 'no book frame ever seen → unpriced, never the print')
})

test('rows carry the quote pair beside each marked leg', () => {
  const row = pnlRowFor({
    tag: 'T',
    label: 'T',
    mode: 'paper',
    fills: [fill('XCE', 'Sell', 100, 10)],
    boundary: T0 - 1,
    marksOf: () => ({ XCE: 10.2 }),
    quotesOf: (_symbols, exits) => ({
      XCE: { bid: 9.8, ask: 10.2, basis: exits.get('XCE') === 'Buy' ? 'ask' : 'bid', asOf: T0 },
    }),
    malformed: [],
  })
  assert.deepEqual(row.quotes?.['XCE'], { bid: 9.8, ask: 10.2, basis: 'ask', asOf: T0 })
})

test('a moved pair reaches the wire even when the exit-side mark did not move', async () => {
  const { pnlUpdateFor } = await import('../src/stream.ts')
  const rowWith = (bid: number, asOf: number) =>
    pnlRowFor({
      tag: 'T',
      label: 'T',
      mode: 'paper',
      fills: [fill('XCE', 'Sell', 100, 10)],
      boundary: T0 - 1,
      marksOf: () => ({ XCE: 10.2 }), // the ask — unchanged, so the mark is too
      quotesOf: () => ({ XCE: { bid, ask: 10.2, basis: 'ask', asOf } }),
      malformed: [],
    })
  const base = rowWith(9.8, T0)
  const moved = rowWith(9.9, T0 + 5000)
  const update = pnlUpdateFor(base, moved)
  assert.equal(update.kind, 'delta')
  if (update.kind === 'delta') {
    assert.deepEqual(update.delta.legs?.[0]?.quote, { bid: 9.9, ask: 10.2, basis: 'ask', asOf: T0 + 5000 })
  }
  assert.equal(pnlUpdateFor(base, rowWith(9.8, T0)).kind, 'none', 'an unchanged pair sends nothing')
})

/**
 * THE NIGHTLY BLACKOUT (2026-09-07).
 *
 * `defaultMarkResolver` refuses on a dead feed, which is right DURING a
 * session — a stale price presented as "today's P&L" is the frozen-price
 * failure `marks.ts` exists to prevent. But the feed is *supposed* to be dead
 * after 15:30, and the rule made every open leg on the desk unpriced every
 * evening: on prod at 18:52 IST all four relief-r stock books and all three
 * MIRROR_* tags read `total: null` with every leg badged `no mark`, while the
 * persisted close pairs for those exact tokens sat in `desk-marks` and the
 * Positions page rendered them fine off `displayExitQuote`. Two pages
 * disagreeing about one book, nightly.
 *
 * At the close the last two-sided book IS the valuation — that is what EOD
 * MTM means. The distinction that matters is not "is the feed alive" but "is
 * the session open".
 */
const closedDeps = (now: number): ApiDeps => {
  const cache = new QuoteCache({ now: () => now })
  // No `update()` ever: the feed is dead, exactly as it is after 15:30.
  cache.loadSnapshot([{ token: 11, price: 10.0, ts: now - 3 * 3600_000, bid: 9.8, ask: 10.2 }])
  const master = {
    current: () => ({
      resolveSymbol: (s: string) =>
        s === 'XCE'
          ? { tradingsymbol: s, instrumentToken: 11, lotSize: 1, tickSize: 0.05, exchange: 'NFO' }
          : null,
    }),
  }
  return { marks: cache, master, now: () => now } as unknown as ApiDeps
}

test('after the close, an open leg is priced off the persisted pair, not left unpriced', () => {
  const marks = defaultMarkResolver(closedDeps(IST_CLOSED))(
    ['XCE'],
    new Map<string, ExitSide>([['XCE', 'Buy']]),
  )
  assert.equal(marks['XCE'], 10.2, 'short closes at the ask of the last book frame')
})

test('after the close, the pair beside the leg says it came from the snapshot', () => {
  const quotes = defaultQuoteResolver(closedDeps(IST_CLOSED))(
    ['XCE'],
    new Map<string, ExitSide>([['XCE', 'Buy']]),
  )
  assert.equal(quotes['XCE']?.basis, 'snapshot', 'never dressed up as a live frame')
  assert.equal(quotes['XCE']?.ask, 10.2)
})

test('DURING the session a dead feed still prices NOTHING — the frozen-price rule is intact', () => {
  const marks = defaultMarkResolver(closedDeps(IST_OPEN))(
    ['XCE'],
    new Map<string, ExitSide>([['XCE', 'Buy']]),
  )
  assert.equal('XCE' in marks, false, 'a stale mark inside market hours is a lie, not a fallback')
})
