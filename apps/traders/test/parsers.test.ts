import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CANONICAL_PARSERS, decodeText, firstLineOf, parserFor, registerParsers } from '../src/ingest/parsers.ts'
import { CANONICAL_HEADERS, canonicalOrders, canonicalPositions, canonicalTrades } from '../src/ingest/canonical.ts'
import { splitCsvLine } from '../src/ingest/csv.ts'

const P = CANONICAL_HEADERS.positions
const T = CANONICAL_HEADERS.trades

test('parserFor picks by exact first line, BOM and CRLF tolerated', () => {
  assert.equal(parserFor('x.csv', P)?.id, 'canonical-positions')
  assert.equal(parserFor('x.csv', firstLineOf(decodeText(Buffer.from('﻿' + P + '\r\nrow'))))?.id, 'canonical-positions')
  assert.equal(parserFor('x.csv', 'something,else'), null)
  assert.deepEqual(CANONICAL_PARSERS.map((p) => p.id), ['canonical-positions', 'canonical-orders', 'canonical-trades'])
})
test('registerParsers: first match wins', () => {
  const fake = { id: 'fake', matches: () => true, parse: () => ({ kind: 'log' as const, day: '' }) }
  try {
    registerParsers([fake, ...CANONICAL_PARSERS])
    assert.equal(parserFor('x', P)?.id, 'fake')
  } finally { registerParsers(CANONICAL_PARSERS) }
  assert.equal(parserFor('x', P)?.id, 'canonical-positions')
})
test('splitCsvLine handles quotes', () => {
  assert.deepEqual(splitCsvLine('a,"b,c","d ""e""",'), ['a', 'b,c', 'd "e"', ''])
})
test('positions rows', () => {
  const f = canonicalPositions.parse([P, 'C1,tcs,option,2026-10-27,3500,CE,-350,41.25', '', 'C1,TCS,future,2026-10-27,,,175,3480', 'C1,TCS,share,,,,1000,3000'].join('\n'), 'positions-2026-10-19.csv')
  assert.equal(f.kind, 'positions'); assert.equal(f.day, '2026-10-19')
  assert.deepEqual(f.positions, [
    { clientCode: 'C1', stock: 'TCS', instrument: 'option', expiry: '2026-10-27', strike: 3500, optType: 'CE', qty: -350, avgPrice: 41.25 },
    { clientCode: 'C1', stock: 'TCS', instrument: 'future', expiry: '2026-10-27', strike: null, optType: null, qty: 175, avgPrice: 3480 },
    { clientCode: 'C1', stock: 'TCS', instrument: 'share', expiry: '', strike: null, optType: null, qty: 1000, avgPrice: 3000 },
  ])
})
test('positions: negative avg_price and zero qty allowed; no date anywhere gives day empty', () => {
  const f = canonicalPositions.parse(`${P}\nC1,TCS,future,2026-10-27,,,0,-5\n`, 'p.csv')
  assert.equal(f.positions![0]!.avgPrice, -5); assert.equal(f.day, '')
})
test('positions errors name the line', () => {
  const bad = (row: string) => () => canonicalPositions.parse(`${P}\n${row}`, 'p.csv')
  assert.throws(bad('C1,TCS,opt,2026-10-27,3500,CE,-350,40'), { name: 'ParseError', message: 'line 2: instrument "opt" must be option, future or share' })
  assert.throws(bad('C1,TCS,option,2026-10-27,3500,,-350,40'), { message: 'line 2: an option needs type CE or PE' })
  assert.throws(bad('C1,TCS,share,2026-10-27,,,10,40'), { message: 'line 2: a share has no expiry, strike or type' })
  assert.throws(bad('C1,TCS,future,2026-10-27,,,x,40'), { message: 'line 2: qty "x" is not a whole number' })
  assert.throws(bad('C1,TCS,future,2026-10-27,,,1'), { message: 'line 2: expected 8 columns, got 7' })
  assert.throws(bad('C1,TCS,option,2026-10-27,0,CE,1,40'), { message: 'line 2: strike must be positive' })
  assert.throws(bad('C1,T CS,share,,,,1,40'), { message: 'line 2: stock "T CS" is not a valid symbol' })
})
test('orders: quoted reason, side normalised, IST day from the offset time', () => {
  const f = canonicalOrders.parse([CANONICAL_HEADERS.orders,
    'O1,X1,C1,TCS,option,2026-10-27,3500,CE,BUY,175,30,Rejected,"RMS: margin, exceeded",2026-10-19T10:15:00+05:30'].join('\n'), 'orders.csv')
  const o = f.orders![0]!
  assert.equal(o.side, 'Buy'); assert.equal(o.reason, 'RMS: margin, exceeded'); assert.equal(o.filledQty, null)
  assert.equal(o.time, Date.parse('2026-10-19T04:45:00Z')); assert.equal(o.updateTime, o.time); assert.equal(o.day, '2026-10-19')
  assert.equal(f.day, '2026-10-19')
  assert.throws(() => canonicalOrders.parse(`${CANONICAL_HEADERS.orders}\nO1,X1,C1,TCS,future,2026-10-27,,,Sell,175,3500,Complete,,2026-10-19 10:15`, 'o.csv'), { message: 'line 2: time "2026-10-19 10:15" needs an ISO 8601 offset' })
})
test('trades carry their line number as seq', () => {
  const f = canonicalTrades.parse([T,
    'T1,O1,C1,TCS,option,2026-10-27,3500,CE,Sell,175,41.5,2026-10-19T10:15:00+05:30',
    'T2,O1,C1,TCS,option,2026-10-27,3500,CE,sell,175,41.5,2026-10-19T23:45:00Z'].join('\r\n'), 'trades.csv')
  assert.deepEqual(f.trades!.map((t) => t.seq), [2, 3])
  assert.equal(f.trades![1]!.day, '2026-10-20'); assert.equal(f.day, '2026-10-20')
  assert.throws(() => canonicalTrades.parse(`${T}\nT1,O1,C1,TCS,future,2026-10-27,,,Buy,-1,41.5,2026-10-19T10:15:00Z`, 't.csv'), { message: 'line 2: qty must be positive' })
  assert.throws(() => canonicalTrades.parse(`${T}\nT1,O1,C1,TCS,future,2026-10-27,,,Buy,1,-4,2026-10-19T10:15:00Z`, 't.csv'), { message: 'line 2: price must not be negative' })
})
test('decodeText reads UTF-16LE with a BOM', () => {
  assert.equal(decodeText(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('a,b', 'utf16le')])), 'a,b')
  assert.equal(decodeText(Buffer.from('﻿a,b')), 'a,b')
})
