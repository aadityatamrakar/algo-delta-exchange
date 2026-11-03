import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { legsFromTrades, ledgerTradeOf } from '../src/ingest/ledger.ts'
import { odinNseEqTrades } from '../src/ingest/odin/nse-eq-trades.ts'
import { ParseError } from '../src/ingest/parsers.ts'

// A scrubbed excerpt of a real trader's OnLineBackup folder (client C0001), CRLF and padding kept; the buy line is hand-made.
const DIR = fileURLToPath(new URL('./fixtures/odin/Nse Equities/Trades', import.meta.url))
const PATH = 'Nse Equities/Trades/0825TRD.TXT'
const TEXT = readFileSync(`${DIR}/0825TRD.TXT`, 'latin1')
const LINES = TEXT.split('\r\n')
const parse = (text = TEXT) => odinNseEqTrades.parse(text, PATH)
const withField = (n: number, i: number, v: string) => { const f = LINES[n]!.split(','); f[i] = v; return f.join(',') }
const fileOf = (...lines: string[]) => [...lines, ''].join('\r\n')

test('an equity trade is a share row', () => {
  const f = parse(), t = f.trades![0]!
  assert.deepEqual(
    { stock: t.stock, instrument: t.instrument, expiry: t.expiry, strike: t.strike, optType: t.optType, side: t.side, qty: t.qty, price: t.price },
    { stock: 'BAJFINANCE', instrument: 'share', expiry: '', strike: null, optType: null, side: 'Sell', qty: 1, price: 1083 })
  assert.equal(t.day, '2026-08-25'); assert.match(t.clientCode, /^C\d{4}$/)
  assert.deepEqual(t, {
    tradeNo: '5826556', orderNo: '1000000056517171', clientCode: 'C0001', stock: 'BAJFINANCE', instrument: 'share', expiry: '', strike: null, optType: null,
    side: 'Sell', qty: 1, price: 1083, time: Date.parse('2026-08-25T15:07:02+05:30'), day: '2026-08-25', seq: 1,
  })
  assert.deepEqual([f.kind, f.day, f.trades!.length, f.trades![1]!.seq, f.trades![1]!.side, f.skipped], ['trades', '2026-08-25', 2, 2, 'Buy', []])
})
test('shares bought and sold net into one share leg', () => {
  const legs = legsFromTrades(null, parse().trades!.map((t) => ledgerTradeOf({ ...t, trader: 'x' })))
  assert.equal(legs.length, 1)
  assert.deepEqual([legs[0]!.stock, legs[0]!.instrument, legs[0]!.expiry, legs[0]!.strike, legs[0]!.optType, legs[0]!.qty], ['BAJFINANCE', 'share', '', null, null, 2])
  assert.equal(legs[0]!.avgPrice, (3 * 1080 - 1083) / 2)
})
test('derivative files are not claimed, and equity files are by path alone', () => {
  const line = LINES[0]!
  assert.equal(odinNseEqTrades.matches(PATH, line), true)
  assert.equal(odinNseEqTrades.matches('nse equities/trades/0825trd.txt', line), true)
  assert.equal(odinNseEqTrades.matches('OnLineBackup/Nse Equities/Trades/0825TRD.TXT', line), true)
  for (const p of ['Nse Derivatives/Trades/0825TRD.TXT', 'Bse Equities/Trades/0825TRD.TXT', 'Nse Equities/Trades/notes.txt', 'Nse Equities/Trades/0825TRD.TXT.bak'])
    assert.equal(odinNseEqTrades.matches(p, line), false, p)
  // layout and content are per-line checks, never a reason to leave the file unread
  for (const first of [line.split(',').slice(0, 25).join(','), `${line},x`, withField(0, 1, '12'), ''])
    assert.equal(odinNseEqTrades.matches(PATH, first), true, first)
  assert.throws(() => odinNseEqTrades.parse(`${line},x\r\n`, PATH),
    (e: unknown) => e instanceof ParseError && e.message === 'no line could be read; line 1: expected 23 or 26 fields, got 27')
})
test('an unterminated last line is held back', () => {
  assert.equal(parse(TEXT.replace(/\r\n$/, '')).trades!.length, 1)
  assert.equal(parse(TEXT + LINES[0]!.slice(0, 40)).trades!.length, 2)
})
test('a line that cannot be read is skipped with its number and reason; the good lines land', () => {
  const bad = (n: number, i: number, v: string) => withField(n, i, v)
  const f = parse(fileOf(LINES[0]!, bad(1, 1, '12'), bad(1, 10, '3 '), bad(1, 11, '0        '), bad(1, 12, '-1'), bad(1, 2, '   '), bad(1, 3, ''), bad(1, 0, ''), bad(1, 21, ''),
    bad(1, 19, '25 AUG 2026 25:00:00'), LINES[1]!.split(',').slice(0, 25).join(','), LINES[1]!))
  assert.deepEqual(f.trades!.map((t) => t.seq), [1, 12])
  assert.deepEqual(f.skipped, [
    { lineNo: 2, reason: 'trade status "12" is not 11' },
    { lineNo: 3, reason: 'side "3" must be 1 (buy) or 2 (sell)' },
    { lineNo: 4, reason: 'qty must be positive' },
    { lineNo: 5, reason: 'price must not be negative' },
    { lineNo: 6, reason: 'symbol is empty' },
    { lineNo: 7, reason: 'series is empty' },
    { lineNo: 8, reason: 'trade no and exchange order no are required' },
    { lineNo: 9, reason: 'trade no and exchange order no are required' },
    { lineNo: 10, reason: 'time "25 AUG 2026 25:00:00" is not an ODIN time' },
    { lineNo: 11, reason: 'expected 23 or 26 fields, got 25' },
  ])
})
test('a file whose every complete line is bad is a ParseError; one with no complete line is empty', () => {
  assert.throws(() => parse(fileOf(withField(0, 10, '3 '), withField(1, 1, '12')) + LINES[0]!),
    { name: 'ParseError', message: 'no line could be read; line 1: side "3" must be 1 (buy) or 2 (sell)' })
  assert.deepEqual(parse(LINES[0]!.slice(0, 40)), { kind: 'trades', day: '', trades: [], skipped: [] })
  assert.deepEqual(parse(''), { kind: 'trades', day: '', trades: [], skipped: [] })
})
test('the 23-field layout (no trailing NSE Eq and blanks) reads as the 26-field one', () => {
  const short = LINES.filter((l) => l !== '').map((l) => l.split(',').slice(0, 23).join(','))
  assert.ok(LINES[0]!.split(',').length === 26 && short[0]!.split(',').length === 23)
  assert.deepEqual(parse(fileOf(...short)), parse())
})
