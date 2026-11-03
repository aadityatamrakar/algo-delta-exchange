import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { InstrumentRow } from '@algomaker/instruments'
import { planSync, tokensForBook } from '../src/instrument-sync.ts'

const row = (over: Partial<InstrumentRow> & { instrument_token: number }): InstrumentRow => ({
  tradingsymbol: 'X',
  name: 'KALYANKJIL',
  expiry: '2026-07-28',
  strike: 530,
  tick_size: 0.05,
  lot_size: 1350,
  instrument_type: 'CE',
  segment: 'NFO-OPT',
  exchange: 'NFO',
  ...over,
})

const TODAY = '2026-07-27'

test('stock options are kept — the exact gap that blocks live routing today', () => {
  const dump = [
    row({ instrument_token: 1, name: 'KALYANKJIL' }),
    row({ instrument_token: 2, name: 'NIFTY' }),
    row({ instrument_token: 3, name: 'RELIANCE' }),
  ]
  const plan = planSync({
    dump,
    existing: [],
    universe: { names: ['NIFTY', 'KALYANKJIL'] },
    today: TODAY,
    referencedTokens: new Set(),
  })
  assert.deepEqual(plan.toUpsert.map((r) => r.instrument_token).sort(), [1, 2])
  assert.equal(plan.counts.inUniverse, 2)
})

test('the EQ spot row is KEPT — greeks have no other source for spot', () => {
  // Verified against the live dump: filtering EQ out left BHEL with no spot
  // instrument, so marks.spot() was permanently null and every leg dropped as
  // unpriceable. The book then reports no delta whatsoever.
  const dump = [
    row({ instrument_token: 1, instrument_type: 'CE' }),
    row({ instrument_token: 2, instrument_type: 'FUT' }),
    row({ instrument_token: 3, instrument_type: 'EQ', expiry: '', segment: 'NSE' }),
  ]
  const plan = planSync({
    dump,
    existing: [],
    universe: { names: ['KALYANKJIL'] },
    today: TODAY,
    referencedTokens: new Set(),
  })
  assert.deepEqual([...plan.toUpsert.map((r) => r.instrument_token)].sort(), [1, 2, 3])
})

test('an index SPOT row is kept by token, even though its name differs', () => {
  // 'NIFTY' options list against an index row named "NIFTY 50". A pure name
  // filter drops it, and the underlying then has no spot at all.
  const dump = [
    row({ instrument_token: 1, name: 'NIFTY', instrument_type: 'CE' }),
    row({
      instrument_token: 256265, name: 'NIFTY 50', tradingsymbol: 'NIFTY 50',
      instrument_type: 'EQ', expiry: '', segment: 'INDICES', exchange: 'NSE',
    }),
    row({
      instrument_token: 256777, name: 'NIFTY MIDCAP 100', tradingsymbol: 'NIFTY MIDCAP 100',
      instrument_type: 'EQ', expiry: '', segment: 'INDICES', exchange: 'NSE',
    }),
  ]
  const plan = planSync({
    dump,
    existing: [],
    universe: { names: ['NIFTY'] },
    today: TODAY,
    referencedTokens: new Set(),
  })
  const kept = [...plan.toUpsert.map((r) => r.instrument_token)].sort((a, b) => a - b)
  assert.deepEqual(kept, [1, 256265], 'the NIFTY option and the NIFTY 50 index row')
  assert.ok(!kept.includes(256777), 'an unrelated index must not be pulled in')
})

test('index spot rows are only kept for underlyings in the universe', () => {
  const dump = [
    row({
      instrument_token: 260105, name: 'NIFTY BANK', tradingsymbol: 'NIFTY BANK',
      instrument_type: 'EQ', expiry: '', segment: 'INDICES', exchange: 'NSE',
    }),
  ]
  const plan = planSync({
    dump,
    existing: [],
    universe: { names: ['NIFTY'] }, // BANKNIFTY not requested
    today: TODAY,
    referencedTokens: new Set(),
  })
  assert.equal(plan.toUpsert.length, 0)
})

test('genuinely unrelated instrument types are still filtered out', () => {
  const dump = [
    row({ instrument_token: 1, instrument_type: 'CE' }),
    row({ instrument_token: 9, instrument_type: 'COM', expiry: '' }),
  ]
  const plan = planSync({
    dump,
    existing: [],
    universe: { names: ['KALYANKJIL'] },
    today: TODAY,
    referencedTokens: new Set(),
  })
  assert.deepEqual(plan.toUpsert.map((r) => r.instrument_token), [1])
})

test('expired contracts are deleted — the accumulation bug in exchangeToken.js', () => {
  const plan = planSync({
    dump: [row({ instrument_token: 10, expiry: '2026-08-25' })],
    existing: [
      { instrument_token: 99, expiry: '2025-01-30' }, // long expired
      { instrument_token: 98, expiry: '2026-07-26' }, // expired yesterday
      { instrument_token: 10, expiry: '2026-08-25' }, // still listed
    ],
    universe: { names: ['KALYANKJIL'] },
    today: TODAY,
    referencedTokens: new Set(),
  })
  assert.deepEqual([...plan.toDelete].sort((a, b) => a - b), [98, 99])
})

test('a contract expiring TODAY is not deleted — it is still tradable', () => {
  const plan = planSync({
    dump: [],
    existing: [{ instrument_token: 50, expiry: TODAY }],
    universe: { names: ['KALYANKJIL'] },
    today: TODAY,
    referencedTokens: new Set(),
  })
  assert.equal(plan.toDelete.length, 0)
})

test('an expired contract held in an OPEN POSITION is retained, not deleted', () => {
  // Deleting it would strand the position: the exit could not be routed because
  // xtsOrder.js could no longer resolve the symbol.
  const plan = planSync({
    dump: [],
    existing: [
      { instrument_token: 77, expiry: '2026-07-20' },
      { instrument_token: 78, expiry: '2026-07-20' },
    ],
    universe: { names: ['KALYANKJIL'] },
    today: TODAY,
    referencedTokens: new Set([77]),
  })
  assert.deepEqual(plan.toDelete, [78])
  assert.deepEqual(plan.retainedExpired, [77])
  assert.equal(plan.counts.retained, 1)
})

test('a contract absent from the dump but unexpired is NOT deleted', () => {
  // A truncated or partially-failed download must degrade to stale data, never
  // to a wiped collection.
  const plan = planSync({
    dump: [],
    existing: [{ instrument_token: 60, expiry: '2026-12-31' }],
    universe: { names: ['KALYANKJIL'] },
    today: TODAY,
    referencedTokens: new Set(),
  })
  assert.equal(plan.toDelete.length, 0)
})

test('cash instruments (no expiry) are never treated as expired', () => {
  const plan = planSync({
    dump: [],
    existing: [{ instrument_token: 5, expiry: '' }],
    universe: { names: ['KALYANKJIL'] },
    today: TODAY,
    referencedTokens: new Set(),
  })
  assert.equal(plan.toDelete.length, 0)
})

// ------------------------------------------------------------ subscriptions

test('tokensForBook covers every open leg', () => {
  const tokens = tokensForBook({
    legs: [{ instrumentToken: 111 }, { instrumentToken: 222 }],
    underlying: 'KALYANKJIL',
    expiry: '2026-07-28',
    spot: null,
    rollWindow: 0,
    resolve: () => null,
    strikes: [],
  })
  assert.deepEqual(tokens.sort((a, b) => a - b), [111, 222])
})

test('the roll window walks the LISTED grid, not an arithmetic one', () => {
  // Gap between 510 and 530: an arithmetic +/-5 walk would request 515/520/525,
  // none of which exist.
  const strikes = [495, 500, 505, 510, 530, 535, 540, 545]
  const resolve = (strike: number, type: 'CE' | 'PE'): { instrumentToken: number } | null =>
    strikes.includes(strike) ? { instrumentToken: strike * 10 + (type === 'CE' ? 1 : 2) } : null

  const tokens = tokensForBook({
    legs: [],
    underlying: 'KALYANKJIL',
    expiry: '2026-07-28',
    spot: 521,
    rollWindow: 1,
    resolve,
    strikes,
  })
  // Nearest listed to 521 is 530; one each side gives 510, 530, 535.
  assert.deepEqual(tokens.sort((a, b) => a - b), [5101, 5102, 5301, 5302, 5351, 5352])
})

test('re-declaring the same book yields an identical set — idempotent', () => {
  const strikes = [530, 535]
  const resolve = (strike: number, type: 'CE' | 'PE'): { instrumentToken: number } => ({
    instrumentToken: strike * 10 + (type === 'CE' ? 1 : 2),
  })
  const input = {
    legs: [{ instrumentToken: 999 }],
    underlying: 'KALYANKJIL',
    expiry: '2026-07-28',
    spot: 531,
    rollWindow: 1,
    resolve,
    strikes,
  }
  const a = tokensForBook(input).sort((x, y) => x - y)
  const b = tokensForBook(input).sort((x, y) => x - y)
  assert.deepEqual(a, b, 'a Python process calls this every tick; it must not churn the socket')
})

test('a leg with no token does not produce an undefined subscription', () => {
  const tokens = tokensForBook({
    legs: [{ instrumentToken: 111 }, {}],
    underlying: 'K', expiry: '2026-07-28', spot: null, rollWindow: 0,
    resolve: () => null, strikes: [],
  })
  assert.deepEqual(tokens, [111])
})

test("an equity's spot row is matched by TRADINGSYMBOL, not its company name", () => {
  // Measured against the live dump 2026-07-30. The NSE cash row for Bajaj
  // Finance is:
  //   81153,317,BAJFINANCE,"BAJAJ FINANCE",...,EQ,NSE,NSE
  // `name` is the COMPANY name; `tradingsymbol` is the symbol its options list
  // under. Filtering on `name` alone therefore dropped the spot row for every
  // stock whose company name differs from its symbol — 10 of the desk's 13.
  // BHEL, ITC and DLF survived only because for them the two happen to match,
  // which is why the gap went unnoticed. The visible failure was marketdata
  // logging "open books with no spot instrument — their greeks cannot be
  // computed {underlyings:[BAJFINANCE]}" every 30s against a real book.
  const dump = [
    row({
      instrument_token: 81153,
      tradingsymbol: 'BAJFINANCE',
      name: 'BAJAJ FINANCE',
      instrument_type: 'EQ',
      segment: 'NSE',
      exchange: 'NSE',
      expiry: '',
      strike: 0,
    }),
    row({ instrument_token: 2, tradingsymbol: 'BAJFINANCE26AUG1070CE', name: 'BAJFINANCE' }),
  ]
  const plan = planSync({
    dump,
    existing: [],
    universe: { names: ['BAJFINANCE'] },
    today: TODAY,
    referencedTokens: new Set(),
  })
  assert.deepEqual(
    plan.toUpsert.map((r) => r.instrument_token).sort((a, b) => a - b),
    [2, 81153],
    'the EQ row must be kept even though its name is the company name',
  )
})

test('a company name matching by tradingsymbol still respects the type filter', () => {
  // The tradingsymbol escape hatch is for CASH rows only. It must not become a
  // second way for an unwanted instrument type to enter the collection.
  const dump = [
    row({
      instrument_token: 9,
      tradingsymbol: 'BAJFINANCE',
      name: 'BAJAJ FINANCE',
      instrument_type: 'CE',
    }),
  ]
  const plan = planSync({
    dump,
    existing: [],
    universe: { names: ['BAJFINANCE'], instrumentTypes: ['EQ'] },
    today: TODAY,
    referencedTokens: new Set(),
  })
  assert.deepEqual(plan.toUpsert, [], 'a CE row must not ride in on its tradingsymbol')
})
