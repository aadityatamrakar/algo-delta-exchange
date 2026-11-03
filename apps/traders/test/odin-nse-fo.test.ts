import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { legsFromTrades, ledgerTradeOf } from '../src/ingest/ledger.ts'
import { odinExpiry, odinLines, odinTime } from '../src/ingest/odin/common.ts'
import { odinNseFoTrades } from '../src/ingest/odin/nse-fo-trades.ts'
import { ParseError } from '../src/ingest/parsers.ts'

// Scrubbed excerpts of a real trader's OnLineBackup folder (client C0001, user U0001), CRLF kept.
const DIR = fileURLToPath(new URL('./fixtures/odin/Nse Derivatives/Trades', import.meta.url))
const PATH = 'Nse Derivatives/Trades/1019TRD.TXT'
const parseFile = (name: string) => odinNseFoTrades.parse(readFileSync(`${DIR}/${name}`, 'latin1'), `Nse Derivatives/Trades/${name}`)

test('the 28- and 25-field layouts parse to the same row shape', () => {
  const a = parseFile('0825TRD.TXT').trades![0]!, b = parseFile('1019TRD.TXT').trades![0]!
  assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort())
  assert.equal(a.stock, 'NIFTY'); assert.equal(a.instrument, 'option'); assert.equal(a.expiry, '2026-08-25'); assert.equal(a.day, '2026-08-25')
  assert.equal(b.stock, 'JINDALSTEL'); assert.equal(b.expiry, '2026-10-27'); assert.match(b.clientCode, /^C\d{4}$/)
})
test('a row carries every field the ledger and de-dup need', () => {
  const f = parseFile('1019TRD.TXT')
  assert.equal(f.kind, 'trades'); assert.equal(f.day, '2026-10-19'); assert.equal(f.trades!.length, 27); assert.deepEqual(f.skipped, [])
  assert.deepEqual(f.trades![0], {
    tradeNo: '187679', orderNo: '2400000042158162', clientCode: 'C0001', stock: 'JINDALSTEL', instrument: 'option',
    expiry: '2026-10-27', strike: 1000, optType: 'PE', side: 'Buy', qty: 625, price: 7.3,
    time: Date.parse('2026-10-19T10:00:22+05:30'), day: '2026-10-19', seq: 1,
  })
  assert.deepEqual(f.trades!.map((t) => t.seq), Array.from({ length: 27 }, (_, i) => i + 1))
})
test('a futures line has no strike or type', () => {
  const t = parseFile('0915TRD.TXT').trades![0]!
  assert.deepEqual([t.instrument, t.strike, t.optType], ['future', null, null])
})
test('an unterminated last line is held back', () => {
  const text = readFileSync(`${DIR}/1019TRD.TXT`, 'latin1'); const n = odinNseFoTrades.parse(text, PATH).trades!.length
  assert.equal(odinNseFoTrades.parse(text.replace(/\r\n$/, ''), PATH).trades!.length, n - 1)
  assert.equal(odinNseFoTrades.parse(text + text.split('\r\n')[0]!.slice(0, 40), PATH).trades!.length, n)
})
test('odinLines: CRLF or LF, blank lines skipped, line numbers kept, fields trimmed', () => {
  assert.deepEqual(odinLines('a , b\r\n\r\n c,d \nhalf'), [{ lineNo: 1, fields: ['a', 'b'] }, { lineNo: 3, fields: ['c', 'd'] }])
  assert.deepEqual(odinLines(''), [])
})
test('JINDALSTEL net quantities and net prices match VolHedge', () => {
  const trades = ['1006', '1012', '1013', '1014', '1015', '1016', '1019'].flatMap((d) => parseFile(`${d}TRD.TXT`).trades!.map((t) => ledgerTradeOf({ ...t, trader: 'x' })))
  assert.equal(trades.length, 202)
  const legs = new Map(legsFromTrades(null, trades).map((l) => [`${l.strike} ${l.optType}`, l]))
  const want: [string, number, number][] = [['1060 CE', -10625, 11.91], ['1080 CE', 3750, 9.33], ['1100 CE', 7500, 5.46],
    ['940 PE', 1875, 5.62], ['960 PE', 5625, 4.57], ['980 PE', 5000, -13.07], ['1020 PE', -8125, 12.23]]   // VolHedge shows 980 PE at -13.08 (rounding); 1000 PE is left out — the copy appears to miss a trade
  for (const [k, q, p] of want) { assert.equal(legs.get(k)?.qty, q, k); assert.equal(Number(legs.get(k)!.avgPrice.toFixed(2)), p, k) }
  for (const k of ['1040 PE', '1120 CE', '1140 CE', '1160 CE', '900 PE']) assert.equal(legs.get(k)?.qty, 0, k)
})
test('only Nse Derivatives trade files are claimed, by path alone', () => {
  const line = readFileSync(`${DIR}/1019TRD.TXT`, 'latin1').split('\r\n')[0]!
  assert.equal(odinNseFoTrades.matches('Nse Derivatives/Trades/1019TRD.TXT', line), true)
  assert.equal(odinNseFoTrades.matches('nse derivatives/trades/0825trd.txt', readFileSync(`${DIR}/0825TRD.TXT`, 'latin1').split('\r\n')[0]!), true)
  for (const p of ['Nse Derivatives/Trades/DOCOMMiocp.log', 'Nse Derivatives/Spread/Logs/20260825112750086_CrossCurr.csv', 'MCX Derivatives/Trades/0928TRD.TXT', 'Nse Equities/Trades/0825TRD.TXT'])
    assert.equal(odinNseFoTrades.matches(p, line), false, p)
  // a changed ODIN layout is still this file: claimed, and `parse` reports every line it cannot read
  for (const first of [line.slice(0, 40), `${line},x`, `${line},x,x,x,x`, ''])
    assert.equal(odinNseFoTrades.matches(PATH, first), true, first)
})
// The 1019 fixture's lines, field `i` (0-based) of line `n` (0-based) set to `v`.
const LINES = readFileSync(`${DIR}/1019TRD.TXT`, 'latin1').split('\r\n')
const withField = (n: number, i: number, v: string) => { const f = LINES[n]!.split(','); f[i] = v; return f.join(',') }
const fileOf = (...lines: string[]) => [...lines, ''].join('\r\n')

test('a file of an unknown layout is a ParseError; a mixed file lands its known lines and names the rest', () => {
  assert.throws(() => odinNseFoTrades.parse(fileOf(`${LINES[0]!},x,x`, `${LINES[1]!},x,x`), PATH),
    (e: unknown) => e instanceof ParseError && e.message === 'no line could be read; line 1: expected 25, 26 or 28 fields, got 27')
  const f = odinNseFoTrades.parse(fileOf(LINES[0]!, `${LINES[1]!},x,x,x,x`), PATH)
  assert.equal(f.trades!.length, 1)
  assert.deepEqual(f.skipped, [{ lineNo: 2, reason: 'expected 25, 26 or 28 fields, got 29' }])
})

test('a file is claimed by path: a first line with status 12 is claimed, then skipped', () => {
  const first = withField(0, 1, '12')
  assert.equal(odinNseFoTrades.matches(PATH, first), true)
  assert.equal(odinNseFoTrades.matches(PATH, LINES[0]!.replace('OPTSTK', 'EQUITY')), true)   // the instrument is a per-line check too
  const f = odinNseFoTrades.parse(fileOf(first, LINES[1]!), PATH)
  assert.deepEqual(f.skipped, [{ lineNo: 1, reason: 'trade status "12" is not 11' }])
  assert.deepEqual(f.trades!.map((t) => t.seq), [2])
})
test('a line that cannot be read is skipped with its number and reason; the good lines land', () => {
  const f = odinNseFoTrades.parse(fileOf(LINES[0]!, withField(1, 1, '12'), LINES[2]!, withField(3, 14, '0        '), LINES[4]!), PATH)
  assert.deepEqual(f.trades!.map((t) => [t.seq, t.tradeNo]), [[1, LINES[0]!.split(',')[0]!.trim()], [3, LINES[2]!.split(',')[0]!.trim()], [5, LINES[4]!.split(',')[0]!.trim()]])
  assert.deepEqual(f.skipped, [{ lineNo: 2, reason: 'trade status "12" is not 11' }, { lineNo: 4, reason: 'qty must be positive' }])
  assert.equal(f.day, '2026-10-19')
})
test('every reason a line is skipped is named', () => {
  const f = odinNseFoTrades.parse(fileOf(LINES[0]!, withField(1, 13, '3 '), LINES[1]!.split(',').slice(0, 24).join(','), LINES[2]!.replace('OPTSTK', 'OPTCUR'),
    withField(2, 15, '-1.00'), withField(2, 5, '0.00'), withField(2, 3, ''), withField(2, 0, ''), withField(2, 23, ''), withField(2, 21, '19 OCT 2026 25:00:00'), withField(2, 4, '31NOV2026')), PATH)
  assert.equal(f.trades!.length, 1)
  assert.deepEqual(f.skipped, [
    { lineNo: 2, reason: 'side "3" must be 1 (buy) or 2 (sell)' },
    { lineNo: 3, reason: 'expected 25, 26 or 28 fields, got 24' },
    { lineNo: 4, reason: 'instrument "OPTCUR" is not OPTSTK, OPTIDX, FUTSTK or FUTIDX' },
    { lineNo: 5, reason: 'price must not be negative' },
    { lineNo: 6, reason: 'strike must be positive' },
    { lineNo: 7, reason: 'symbol is empty' },
    { lineNo: 8, reason: 'trade no and exchange order no are required' },
    { lineNo: 9, reason: 'trade no and exchange order no are required' },
    { lineNo: 10, reason: 'time "19 OCT 2026 25:00:00" is not an ODIN time' },
    { lineNo: 11, reason: 'expiry "31NOV2026" is not an ODIN expiry' },
  ])
})
test('a file whose every complete line is bad is a ParseError; one with no complete line is empty', () => {
  assert.throws(() => odinNseFoTrades.parse(fileOf(withField(0, 13, '3 '), withField(1, 1, '12')) + LINES[2]!, PATH),
    { name: 'ParseError', message: 'no line could be read; line 1: side "3" must be 1 (buy) or 2 (sell)' })
  assert.deepEqual(odinNseFoTrades.parse(LINES[0]!.slice(0, 40), PATH), { kind: 'trades', day: '', trades: [], skipped: [] })
  assert.deepEqual(odinNseFoTrades.parse('', PATH), { kind: 'trades', day: '', trades: [], skipped: [] })
})
test('odinTime reads both ODIN date styles as IST', () => {
  assert.equal(odinTime('19 OCT 2026 09:21:09'), Date.parse('2026-10-19T09:21:09+05:30'))
  assert.equal(odinTime('19 Oct 26 09:18:42  '.trim()), Date.parse('2026-10-19T09:18:42+05:30'))
  for (const bad of ['', '2026-10-19 09:21:09', '31 SEP 2026 09:21:09', '19 OCT 2026 24:00:00']) assert.throws(() => odinTime(bad), { message: `time "${bad}" is not an ODIN time` })
})
test('odinExpiry reads both expiry styles', () => {
  assert.equal(odinExpiry('27OCT2026'), '2026-10-27')
  assert.equal(odinExpiry('08 OCT 2026'), '2026-10-08')
  assert.equal(odinExpiry('29sep2026'), '2026-09-29')
  for (const bad of ['', '2026-10-27', '32OCT2026', '27XYZ2026']) assert.throws(() => odinExpiry(bad), { message: `expiry "${bad}" is not an ODIN expiry` })
})
test('the 26-field layout (one number after NIL) reads as the 25-field one', () => {
  const text = readFileSync(`${DIR}/1019TRD.TXT`, 'latin1')
  const lines = text.split('\r\n').filter((l) => l !== '')
  assert.ok(lines.every((l) => l.split(',').length === 25))
  assert.deepEqual(odinNseFoTrades.parse(fileOf(...lines.map((l) => `${l},1234567`)), PATH), odinNseFoTrades.parse(text, PATH))
})
