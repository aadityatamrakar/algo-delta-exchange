import { test } from 'node:test'
import assert from 'node:assert/strict'
import { OptionMaster, inferStrikeStep, parseInstrumentCsv, type InstrumentRow } from '../src/master.ts'

/** A KALYANKJIL-shaped chain: the real book on the Python side is 8 legs here. */
function stockChain(): InstrumentRow[] {
  const rows: InstrumentRow[] = []
  for (const strike of [495, 500, 505, 510, 530, 535, 540, 545]) {
    for (const type of ['CE', 'PE'] as const) {
      rows.push({
        instrument_token: 900000 + strike * 10 + (type === 'CE' ? 1 : 2),
        tradingsymbol: `KALYANKJIL26JUL${strike}${type}`,
        name: 'KALYANKJIL',
        expiry: '2026-07-28',
        strike,
        tick_size: 0.05,
        lot_size: 1350,
        instrument_type: type,
        segment: 'NFO-OPT',
        exchange: 'NFO',
      })
    }
  }
  // Next monthly, so nearestExpiry has something to choose between.
  rows.push({
    instrument_token: 999001,
    tradingsymbol: 'KALYANKJIL26AUG520CE',
    name: 'KALYANKJIL',
    expiry: '2026-08-25',
    strike: 520,
    tick_size: 0.05,
    lot_size: 1350,
    instrument_type: 'CE',
    segment: 'NFO-OPT',
    exchange: 'NFO',
  })
  rows.push({
    instrument_token: 888001,
    tradingsymbol: 'KALYANKJIL26JULFUT',
    name: 'KALYANKJIL',
    expiry: '2026-07-28',
    strike: 0,
    tick_size: 0.05,
    lot_size: 1350,
    instrument_type: 'FUT',
    segment: 'NFO-FUT',
    exchange: 'NFO',
  })
  return rows
}

test('resolves a listed stock-option contract with the dump lot size', () => {
  const m = new OptionMaster(stockChain())
  const ref = m.resolve('KALYANKJIL', '2026-07-28', 530, 'CE')
  assert.ok(ref !== null)
  assert.equal(ref.tradingsymbol, 'KALYANKJIL26JUL530CE')
  assert.equal(ref.lotSize, 1350)
  assert.equal(ref.exchange, 'NFO')
})

test('returns null for an UNLISTED strike rather than fabricating a symbol', () => {
  const m = new OptionMaster(stockChain())
  // 525 sits inside the range but is genuinely not listed in this chain.
  assert.equal(m.resolve('KALYANKJIL', '2026-07-28', 525, 'CE'), null)
  assert.equal(m.resolve('KALYANKJIL', '2026-07-28', 530, 'PE')?.tradingsymbol, 'KALYANKJIL26JUL530PE')
})

test('atmStrike snaps to a LISTED strike, never an arithmetic grid point', () => {
  const m = new OptionMaster(stockChain())
  // Spot 521 (the real KALYANKJIL CMP from the book sheet). The arithmetic grid
  // round(521/5)*5 = 520, which this chain does NOT list — the strangle ladder
  // leaves a hole between 510 and 530. Snapping to a listed strike gives 530
  // (9 away) over 510 (11 away).
  const atm = m.atmStrike('KALYANKJIL', '2026-07-28', 521)
  assert.ok(atm !== null)
  assert.ok(
    m.resolve('KALYANKJIL', '2026-07-28', atm, 'CE') !== null,
    `atmStrike returned ${atm}, which is not a listed contract`,
  )
  assert.equal(atm, 530)
})

test('nearestExpiry includes the expiry day itself', () => {
  const m = new OptionMaster(stockChain())
  assert.equal(m.nearestExpiry('KALYANKJIL', '2026-07-01'), '2026-07-28')
  // ON expiry day the contract is still tradable — must not roll a day early.
  assert.equal(m.nearestExpiry('KALYANKJIL', '2026-07-28'), '2026-07-28')
  assert.equal(m.nearestExpiry('KALYANKJIL', '2026-07-29'), '2026-08-25')
  assert.equal(m.nearestExpiry('KALYANKJIL', '2026-09-01'), null)
})

test('strike step is inferred from what is listed, not configured', () => {
  const m = new OptionMaster(stockChain())
  assert.equal(m.strikeStep('KALYANKJIL', '2026-07-28'), 5)
})

test('inferStrikeStep takes the MODE, so stray old-regime strikes do not skew it', () => {
  // A stock that halved: dense 5-wide grid near spot, plus stale wide strikes.
  assert.equal(inferStrikeStep([100, 105, 110, 115, 120, 200, 300]), 5)
  assert.equal(inferStrikeStep([500]), null)
  assert.equal(inferStrikeStep([]), null)
})

test('the EQ spot row resolves — greeks have no other source for spot', () => {
  const rows = [
    ...stockChain(),
    {
      instrument_token: 112129, tradingsymbol: 'BHEL', name: 'BHEL', expiry: '',
      strike: 0, tick_size: 0.05, lot_size: 1, instrument_type: 'EQ',
      segment: 'NSE', exchange: 'NSE',
    },
  ]
  const m = new OptionMaster(rows)
  assert.equal(m.spotToken('BHEL'), 112129)
  assert.equal(m.spot('BHEL')?.tradingsymbol, 'BHEL')
  assert.deepEqual(m.spotUnderlyings(), ['BHEL'])
})

test('an index resolves spot by TOKEN, despite the name mismatch', () => {
  // The dump names differ between an index's derivatives and its spot row:
  // NIFTY options list under 'NIFTY', but the index itself is "NIFTY 50".
  // Only SENSEX matches by name, which is why it was the one that resolved.
  const m = new OptionMaster([
    {
      instrument_token: 256265, tradingsymbol: 'NIFTY 50', name: 'NIFTY 50', expiry: '',
      strike: 0, tick_size: 0.05, lot_size: 1, instrument_type: 'EQ',
      segment: 'INDICES', exchange: 'NSE',
    },
    {
      instrument_token: 260105, tradingsymbol: 'NIFTY BANK', name: 'NIFTY BANK', expiry: '',
      strike: 0, tick_size: 0.05, lot_size: 1, instrument_type: 'EQ',
      segment: 'INDICES', exchange: 'NSE',
    },
  ])
  assert.equal(m.spotToken('NIFTY'), 256265, 'the DERIVATIVE underlying must resolve')
  assert.equal(m.spotToken('BANKNIFTY'), 260105)
  // The dump's own name still works, pointing at the same row.
  assert.equal(m.spotToken('NIFTY 50'), 256265)
  assert.equal(m.spotToken('NIFTY BANK'), 260105)
})

test('an unrelated index is NOT claimed as a canonical underlying', () => {
  const m = new OptionMaster([
    {
      instrument_token: 256777, tradingsymbol: 'NIFTY MIDCAP 100', name: 'NIFTY MIDCAP 100',
      expiry: '', strike: 0, tick_size: 0.05, lot_size: 1, instrument_type: 'EQ',
      segment: 'INDICES', exchange: 'NSE',
    },
  ])
  assert.equal(m.spotToken('NIFTY'), null)
  assert.equal(m.spotToken('MIDCPNIFTY'), null)
  assert.equal(m.spotToken('NIFTY MIDCAP 100'), 256777)
})

test('an INDICES row is spot too', () => {
  const m = new OptionMaster([
    {
      instrument_token: 256265, tradingsymbol: 'NIFTY 50', name: 'NIFTY', expiry: '',
      strike: 0, tick_size: 0.05, lot_size: 1, instrument_type: 'EQ',
      segment: 'INDICES', exchange: 'NSE',
    },
  ])
  assert.equal(m.spotToken('NIFTY'), 256265)
})

test('a missing spot returns null rather than substituting a future', () => {
  // Null means the sync dropped the cash row and greeks are uncomputable for
  // that underlying — a condition to surface, not to paper over.
  const m = new OptionMaster(stockChain())
  assert.equal(m.spotToken('KALYANKJIL'), null)
  assert.equal(m.spot('KALYANKJIL'), null)
})

test('the spot row does not pollute the option index', () => {
  const m = new OptionMaster([
    ...stockChain(),
    {
      instrument_token: 112129, tradingsymbol: 'BHEL', name: 'BHEL', expiry: '',
      strike: 0, tick_size: 0.05, lot_size: 1, instrument_type: 'EQ',
      segment: 'NSE', exchange: 'NSE',
    },
  ])
  // 8 July strikes x CE/PE, plus the single August contract. The EQ row is not
  // among them.
  assert.equal(m.optionCount, 17)
  assert.equal(m.resolve('BHEL', '', 0, 'CE'), null)
})

test('futures resolve by nearest expiry', () => {
  const m = new OptionMaster(stockChain())
  assert.equal(m.future('KALYANKJIL')?.tradingsymbol, 'KALYANKJIL26JULFUT')
  assert.equal(m.future('NOTLISTED'), null)
})

test('resolveSymbol round-trips the tradingsymbol the Python book speaks', () => {
  const m = new OptionMaster(stockChain())
  const ref = m.resolveSymbol('KALYANKJIL26JUL495PE')
  assert.equal(ref?.lotSize, 1350)
  assert.equal(m.resolveSymbol('NOPE26JUL100CE'), null)
})

/**
 * THE ONE IDENTIFIER THE BROKER AND THE DESK BOTH HOLD.
 *
 * Zerodha packs its token as `exchange_token * 256 + segment`; XTS speaks the
 * unpacked half, which is why the gateway divides by 256 before placing an
 * order and why an XTS position row can only be read back into a tradingsymbol
 * through this index. The two systems' NAMES for one contract differ
 * (`BHEL26AUG415CE` vs `BHEL 25AUG2026 CE 415`) and joining them by string is
 * what produced the 2026-08-15 `17 DIVERGENT` report on a desk that matched.
 */
/**
 * REAL PACKED TOKENS, because the packing is the thing under test. `stockChain`
 * numbers its contracts a few apart, so several of its rows genuinely share an
 * exchange token — a useful accident in the ambiguity test below, and a useless
 * one here.
 */
function bhelChain(): InstrumentRow[] {
  const option = (strike: number, type: 'CE' | 'PE', exchangeToken: number): InstrumentRow => ({
    // The dump's own packing: exchange_token * 256 + the NFO segment byte.
    instrument_token: exchangeToken * 256 + 2,
    tradingsymbol: `BHEL26AUG${strike}${type}`,
    name: 'BHEL',
    expiry: '2026-08-25',
    strike,
    tick_size: 0.05,
    lot_size: 5250,
    instrument_type: type,
    segment: 'NFO-OPT',
    exchange: 'NFO',
  })
  return [
    option(375, 'PE', 149461),
    option(415, 'CE', 149471),
    {
      instrument_token: 149490 * 256 + 2,
      tradingsymbol: 'BHEL26AUGFUT',
      name: 'BHEL',
      expiry: '2026-08-25',
      strike: 0,
      tick_size: 0.05,
      lot_size: 5250,
      instrument_type: 'FUT',
      segment: 'NFO-FUT',
      exchange: 'NFO',
    },
  ]
}

test('resolveExchangeToken finds the contract by the number XTS sends', () => {
  const m = new OptionMaster(bhelChain())
  // `"ExchangeInstrumentId":"149471"` in the broker's own reply.
  assert.equal(m.resolveExchangeToken(149471)?.tradingsymbol, 'BHEL26AUG415CE')
  assert.equal(m.resolveExchangeToken(149461)?.lotSize, 5250)
  // Futures are reachable the same way — the desk holds those too.
  assert.equal(m.resolveExchangeToken(149490)?.tradingsymbol, 'BHEL26AUGFUT')
})

test('THE PACKED TOKEN IS NOT THE ID: the segment byte is not multiplied back', () => {
  /**
   * `149471 * 256` is 38264576 and the contract's real token is 38264578 — the
   * exchange segment lives in that bottom byte and XTS never sends it. So the
   * index is keyed by the DIVIDED token and the multiplication never happens;
   * looking the packed number up as though it were an id must find nothing.
   */
  const m = new OptionMaster(bhelChain())
  assert.equal(m.resolveExchangeToken(149471 * 256), null)
  assert.equal(m.resolveSymbol('BHEL26AUG415CE')?.instrumentToken, 149471 * 256 + 2)
})

test('a token this dump does not carry answers NOTHING, never a near miss', () => {
  // An expired contract is gone from the dump entirely, and that is exactly the
  // row a positions comparison most needs reported rather than guessed at.
  const m = new OptionMaster(bhelChain())
  assert.equal(m.resolveExchangeToken(149472), null)
  assert.equal(m.resolveExchangeToken(0), null)
  assert.equal(m.resolveExchangeToken(Number.NaN), null)
})

test('an exchange token two contracts want resolves to NEITHER', () => {
  /**
   * The packed token is what makes two segments' contracts distinct; the
   * exchange half alone can collide. Answering with whichever row was read
   * first would attribute a broker position to a contract nobody holds, so an
   * ambiguous number is treated as one the dump cannot answer.
   */
  const rows = bhelChain()
  const twin = rows[1] as InstrumentRow
  const m = new OptionMaster([
    ...rows,
    // Same exchange token, different segment byte, a different contract entirely.
    {
      ...twin,
      instrument_token: twin.instrument_token + 1,
      tradingsymbol: 'OTHER26AUG900CE',
      name: 'OTHER',
      strike: 900,
    },
  ])
  assert.equal(m.resolveExchangeToken(149471), null)
  // And the ambiguity does not leak into the lookups that were never confused:
  // both rows are still reachable by the name each of them carries.
  assert.equal(m.resolveSymbol('BHEL26AUG415CE')?.instrumentToken, 149471 * 256 + 2)
})

test('parses the exchange dump CSV, including quoted name fields', () => {
  const csv = [
    'instrument_token,exchange_token,tradingsymbol,name,last_price,expiry,strike,tick_size,lot_size,instrument_type,segment,exchange',
    '262676230,1026079,EURINR24AUGFUT,"EURINR",0,2024-08-28,0,0.0025,1,FUT,BCD-FUT,BCD',
    '900001,3516,KALYANKJIL26JUL530CE,"KALYANKJIL",0,2026-07-28,530,0.05,1350,CE,NFO-OPT,NFO',
  ].join('\n')
  const rows = parseInstrumentCsv(csv)
  assert.equal(rows.length, 2)
  assert.equal(rows[1]?.name, 'KALYANKJIL')
  assert.equal(rows[1]?.lot_size, 1350)
  const m = new OptionMaster(rows)
  assert.equal(m.resolve('KALYANKJIL', '2026-07-28', 530, 'CE')?.instrumentToken, 900001)
  // The BCD future must not have leaked into the option index.
  assert.equal(m.optionCount, 1)
})

/** A cash equity row: `name` is the COMPANY name, `tradingsymbol` the symbol. */
function cashRow(
  over: Partial<InstrumentRow> & { instrument_token: number },
): InstrumentRow {
  return {
    tradingsymbol: 'BAJFINANCE',
    name: 'BAJAJ FINANCE',
    expiry: '',
    strike: 0,
    tick_size: 0.05,
    lot_size: 1,
    instrument_type: 'EQ',
    segment: 'NSE',
    exchange: 'NSE',
    ...over,
  }
}

test("a stock's spot resolves by tradingsymbol when its name is the company name", () => {
  // Options list under name='BAJFINANCE'; the cash row is name='BAJAJ FINANCE'.
  // Keying spot by `name` alone left spot('BAJFINANCE') null, and marketdata
  // logged "open books with no spot instrument — their greeks cannot be
  // computed" against a real book every 30 seconds. Indices already had this
  // solved via INDEX_SPOT_TOKENS; stocks need no list, because for a cash row
  // the tradingsymbol IS the underlying.
  const m = new OptionMaster([cashRow({ instrument_token: 81153 })])
  assert.equal(m.spotToken('BAJFINANCE'), 81153)
  assert.notEqual(m.spot('BAJFINANCE'), null)
  assert.ok(m.spotUnderlyings().includes('BAJFINANCE'))
})

test('the NSE cash row wins over the BSE one for the same symbol', () => {
  // ITC lists a cash row on BOTH exchanges (NSE 424961, BSE 128224004). Before
  // this, whichever the dump happened to yield LAST silently became spot. The
  // desk trades NFO, so the NSE row is the correct forward reference — and the
  // answer must not depend on dump ordering.
  const bse = cashRow({
    instrument_token: 128224004, tradingsymbol: 'ITC', name: 'ITC',
    segment: 'BSE', exchange: 'BSE',
  })
  const nse = cashRow({
    instrument_token: 424961, tradingsymbol: 'ITC', name: 'ITC',
    segment: 'NSE', exchange: 'NSE',
  })
  assert.equal(new OptionMaster([bse, nse]).spotToken('ITC'), 424961, 'BSE then NSE')
  assert.equal(new OptionMaster([nse, bse]).spotToken('ITC'), 424961, 'NSE then BSE')
})

test('a stock whose name already equals its symbol keeps resolving', () => {
  // BHEL is the case that masked the bug; it must not regress.
  const m = new OptionMaster([
    cashRow({ instrument_token: 112129, tradingsymbol: 'BHEL', name: 'BHEL' }),
  ])
  assert.equal(m.spotToken('BHEL'), 112129)
})

/**
 * A master the size of a real NFO dump. The live desk syncs ~8,500 contracts;
 * this builds wider so the difference between a scan and an index is
 * unmistakable rather than marginal.
 */
function wideDump(optionCount: number): InstrumentRow[] {
  const rows: InstrumentRow[] = []
  for (let i = 0; i < optionCount; i++) {
    const strike = 100 + (i % 500) * 5
    rows.push({
      instrument_token: 1_000_000 + i,
      tradingsymbol: `WIDE${i}26SEP${strike}CE`,
      name: `WIDE${i % 40}`,
      expiry: '2026-09-29',
      strike,
      tick_size: 0.05,
      lot_size: 50,
      instrument_type: 'CE',
      segment: 'NFO-OPT',
      exchange: 'NFO',
    })
  }
  return rows
}

/**
 * `resolveSymbol` must not walk the dump.
 *
 * WHY THIS IS A TEST AND NOT A COMMENT: `#rowForSymbol` scanned every option
 * row on every call, and `expiryOf` did the same. Each call is O(contracts),
 * so cost scales with the dump (~8,500 live) TIMES the number of legs the
 * bridge re-indexes per pass — which grows through the session as fills
 * accumulate. On 2026-09-15 that saturated the bridge's event loop for up to
 * eight minutes at a stretch: the dashboard stopped answering, and every
 * periodic pass (reconcile, mirror sync, day guard, P&L) failed against a
 * Mongo that was perfectly healthy, because the driver's own heartbeat could
 * not get a turn on the loop either.
 *
 * The threshold is deliberately loose. An indexed lookup does this in single
 * -digit milliseconds; the scan it replaces takes seconds. Anything in between
 * means someone reintroduced a walk.
 */
test('resolveSymbol and expiryOf are indexed, not scanned', () => {
  const m = new OptionMaster(wideDump(20_000))
  const started = Date.now()
  // Misses are the worst case: a scan cannot exit early, so it walks the
  // whole dump every time.
  for (let i = 0; i < 2_000; i++) {
    assert.equal(m.resolveSymbol(`ABSENT${i}26SEP100CE`), null)
    assert.equal(m.expiryOf(`ABSENT${i}26SEP100CE`), null)
  }
  const elapsed = Date.now() - started
  assert.ok(elapsed < 50, `4,000 lookups over a 20,000-row dump took ${elapsed}ms — that is a scan, not an index`)
})

/** The index must answer exactly what the scan answered, futures included. */
test('the symbol index preserves options-first resolution and futures fallback', () => {
  const m = new OptionMaster(stockChain())
  // An option resolves, and carries its expiry.
  assert.equal(m.resolveSymbol('KALYANKJIL26JUL495PE')?.tradingsymbol, 'KALYANKJIL26JUL495PE')
  assert.equal(m.expiryOf('KALYANKJIL26JUL495PE'), '2026-07-28')
  // A FUTURE resolves through the same call...
  assert.equal(m.resolveSymbol('KALYANKJIL26JULFUT')?.tradingsymbol, 'KALYANKJIL26JULFUT')
  // ...but answers null for expiry, options-only by design: the one caller
  // widens a marketable buffer on premium collapse, which a future does not do.
  assert.equal(m.expiryOf('KALYANKJIL26JULFUT'), null)
  // An absent symbol is null from both.
  assert.equal(m.resolveSymbol('NOPE26JUL100CE'), null)
  assert.equal(m.expiryOf('NOPE26JUL100CE'), null)
})
