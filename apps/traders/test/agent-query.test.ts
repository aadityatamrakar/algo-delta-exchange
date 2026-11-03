/**
 * The query language: validation, aggregation, ordering and truncation, over
 * rows built here (no Mongo). The sources that build real rows are exercised
 * through query_data in the assistant route suite.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CATALOGUE } from '../src/agent/query/catalogue.ts'
import { checkQuery, dataQuerySchema, QueryError, runQuery, type DataQuery, type Row } from '../src/agent/query/execute.ts'

const trade = (i: number, stock: string, side: 'Buy' | 'Sell', qty: number, price: number): Row => ({
  day: `2026-10-${String(10 + (i % 10)).padStart(2, '0')}`, time: `2026-10-${String(10 + (i % 10)).padStart(2, '0')} 10:00:0${i % 10}`,
  stock, instrument: 'option', expiry: '2026-10-27', strike: 3500 + i * 10, optType: i % 2 === 0 ? 'CE' : 'PE',
  side, qty, price, value: qty * price,
})
const TRADES: Row[] = Array.from({ length: 120 }, (_, i) => trade(i, i % 3 === 0 ? 'TCS' : 'INFY', i % 2 === 0 ? 'Buy' : 'Sell', 175 * (1 + (i % 4)), 10 + i / 3))

const parse = (q: unknown): DataQuery => dataQuerySchema.parse(q)

test('the schema refuses unknown keys, a bad stock, a limit over 200 and an unknown dataset', () => {
  assert.equal(dataQuerySchema.safeParse({ dataset: 'trades', sql: 'select *' }).success, false)
  assert.equal(dataQuerySchema.safeParse({ dataset: 'trades', params: { stock: 'tcs' } }).success, false)
  assert.equal(dataQuerySchema.safeParse({ dataset: 'trades', limit: 201 }).success, false)
  assert.equal(dataQuerySchema.safeParse({ dataset: 'mongo' }).success, false)
  assert.equal(dataQuerySchema.safeParse({ dataset: 'trades', where: [{ field: 'x', op: 'like', value: 1 }] }).success, false)
})

test('an unknown field is an error naming the valid ones', () => {
  assert.throws(() => runQuery(parse({ dataset: 'trades', where: [{ field: 'clientCode', op: '=', value: 'X' }] }), TRADES), (e: unknown) => {
    assert.ok(e instanceof QueryError)
    assert.match(e.message, /no field "clientCode" in trades; its fields are day, time, stock/)
    return true
  })
  assert.throws(() => runQuery(parse({ dataset: 'trades', select: ['orderNo'] }), TRADES), /no field "orderNo"/)
  assert.throws(() => runQuery(parse({ dataset: 'trades', aggregate: [{ fn: 'sum', field: 'side', as: 's' }] }), TRADES), /side is not a number/)
  assert.throws(() => runQuery(parse({ dataset: 'trades', where: [{ field: 'qty', op: 'contains', value: '1' }] }), TRADES), /only a text field/)
  assert.throws(() => runQuery(parse({ dataset: 'trades', where: [{ field: 'qty', op: 'between', value: [1] }] }), TRADES), /\[low, high\]/)
  assert.throws(() => runQuery(parse({ dataset: 'trades', orderBy: [{ field: 'n', dir: 'asc' }], groupBy: ['stock'], aggregate: [{ fn: 'count', as: 'c' }] }), TRADES), /not a column of the result/)
  assert.throws(() => runQuery(parse({ dataset: 'trades', select: ['qty'], groupBy: ['stock'] }), TRADES), /select lists raw rows/)
})

test('params are checked against the dataset: required, unknown and the 30-day reach of trades', () => {
  assert.throws(() => checkQuery(parse({ dataset: 'chain' })), /chain needs params.stock/)
  assert.throws(() => checkQuery(parse({ dataset: 'books', params: { days: 3 } })), /books takes no params/)
  assert.throws(() => checkQuery(parse({ dataset: 'trades', params: { days: 31 } })), /at most 30 days/)
  checkQuery(parse({ dataset: 'trades', params: { days: 30, stock: 'TCS' } }))
})

test('where, groupBy and aggregates: sums by stock and side match a hand count', () => {
  const r = runQuery(parse({
    dataset: 'trades', where: [{ field: 'stock', op: '=', value: 'TCS' }],
    groupBy: ['side'], aggregate: [{ fn: 'count', as: 'n' }, { fn: 'sum', field: 'qty', as: 'shares' }, { fn: 'avg', field: 'price', as: 'avgPrice' }],
    orderBy: [{ field: 'side', dir: 'asc' }],
  }), TRADES)
  assert.deepEqual(r.columns.map((c) => c.name), ['side', 'n', 'shares', 'avgPrice'])
  for (const side of ['Buy', 'Sell']) {
    const rows = TRADES.filter((t) => t['stock'] === 'TCS' && t['side'] === side)
    const row = r.rows.find((x) => x[0] === side)!
    assert.equal(row[1], rows.length)
    assert.equal(row[2], rows.reduce((s, t) => s + (t['qty'] as number), 0))
    assert.equal(row[3], Math.round(rows.reduce((s, t) => s + (t['price'] as number), 0) / rows.length * 1e4) / 1e4)
  }
  assert.equal(r.truncated, false)
})

test('an aggregate with no groupBy is one row; min, max, first, last, stddev', () => {
  const r = runQuery(parse({ dataset: 'trades', aggregate: [{ fn: 'min', field: 'price', as: 'lo' }, { fn: 'max', field: 'price', as: 'hi' }, { fn: 'first', field: 'stock', as: 'f' }, { fn: 'stddev', field: 'qty', as: 'sd' }] }), TRADES)
  assert.equal(r.rows.length, 1)
  assert.equal(r.rows[0]![0], 10)
  assert.equal(r.rows[0]![2], 'TCS')
  assert.ok((r.rows[0]![3] as number) > 0)
  const empty = runQuery(parse({ dataset: 'trades', where: [{ field: 'stock', op: '=', value: 'NONE' }], aggregate: [{ fn: 'count', as: 'n' }, { fn: 'sum', field: 'qty', as: 's' }] }), TRADES)
  assert.deepEqual(empty.rows, [[0, null]])
})

test('over the limit: the first rows, truncated, and a numeric summary over every matching row', () => {
  const r = runQuery(parse({ dataset: 'trades', select: ['stock', 'qty', 'price'], orderBy: [{ field: 'price', dir: 'desc' }], limit: 10 }), TRADES)
  assert.equal(r.total, 120)
  assert.equal(r.rows.length, 10)
  assert.equal(r.truncated, true)
  assert.ok((r.rows[0]![2] as number) >= (r.rows[9]![2] as number), 'ordered by price, descending')
  assert.equal(r.summary?.['qty']?.count, 120)
  assert.equal(r.summary?.['qty']?.sum, TRADES.reduce((s, t) => s + (t['qty'] as number), 0))
  assert.equal(r.summary?.['stock'], undefined, 'text columns have no summary')
  const dflt = runQuery(parse({ dataset: 'trades' }), TRADES)
  assert.equal(dflt.rows.length, 50, 'the default limit is 50')
})

test('between, in, contains, and nulls sort last', () => {
  const rows: Row[] = [{ ...TRADES[0]!, strike: null }, ...TRADES.slice(1, 6)]
  const between = runQuery(parse({ dataset: 'trades', where: [{ field: 'price', op: 'between', value: [10, 11] }], select: ['price'] }), TRADES)
  assert.ok(between.rows.every((x) => (x[0] as number) >= 10 && (x[0] as number) <= 11))
  const inn = runQuery(parse({ dataset: 'trades', where: [{ field: 'stock', op: 'in', value: ['TCS'] }] }), TRADES)
  assert.equal(inn.total, TRADES.filter((t) => t['stock'] === 'TCS').length)
  const contains = runQuery(parse({ dataset: 'trades', where: [{ field: 'stock', op: 'contains', value: 'inf' }] }), TRADES)
  assert.equal(contains.total, TRADES.filter((t) => t['stock'] === 'INFY').length)
  for (const dir of ['asc', 'desc'] as const) {
    const sorted = runQuery(parse({ dataset: 'trades', select: ['strike'], orderBy: [{ field: 'strike', dir }] }), rows)
    assert.equal(sorted.rows[sorted.rows.length - 1]![0], null, dir)
  }
})

test('the catalogue: every dataset of the spec, no field that names an identity', () => {
  assert.deepEqual(CATALOGUE.map((d) => d.name).sort(), ['band_events', 'books', 'chain', 'daily_bars', 'intraday_bars', 'legs', 'levels', 'orders', 'portfolio_months', 'trades', 'vol'])
  for (const d of CATALOGUE) {
    for (const f of d.fields) assert.equal(/client|trader|note|file|path|orderNo|tradeNo|reason|key/i.test(f.name), false, `${d.name}.${f.name}`)
  }
  assert.deepEqual(CATALOGUE.filter((d) => !d.available).map((d) => d.name), [], 'the market datasets are on since Lane 2')
})
