import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { odinBseFoTrades } from '../src/ingest/odin/bse-fo-trades.ts'
import { ParseError } from '../src/ingest/parsers.ts'

// Scrubbed excerpts of a real trader's OnLineBackup folder (client C0001, member and routing ids zeroed), CRLF kept.
const DIR = fileURLToPath(new URL('./fixtures/odin/BSE Derivatives/Trades', import.meta.url))
const text = (name: string) => readFileSync(`${DIR}/${name}`, 'latin1')
const PATH = 'BSE Derivatives/Trades/0827TRD.TXT'
const parse = (name: string) => odinBseFoTrades.parse(text(name), `BSE Derivatives/Trades/${name}`)
const pick = <T extends object>(o: T, keys: (keyof T)[]) => Object.fromEntries(keys.map((k) => [k, o[k]]))
const fileOf = (...lines: string[]) => [...lines, ''].join('\r\n')
const L27 = text('0827TRD.TXT').split('\r\n')   // two buys, then a sell (51 fields)
const L24 = text('0924TRD.TXT').split('\r\n')   // a sell, then a buy (48 fields)

test('buy and sell lines of both widths', () => {
  const rows = [...parse('0827TRD.TXT').trades!, ...parse('0924TRD.TXT').trades!]
  assert.deepEqual(rows.map((t) => t.side), ['Buy', 'Buy', 'Sell', 'Sell', 'Buy'])
  assert.deepEqual(pick(rows[0]!, ['stock', 'instrument', 'expiry', 'strike', 'optType', 'qty', 'price']), { stock: 'SENSEX', instrument: 'option', expiry: '2026-08-27', strike: 77000, optType: 'CE', qty: 20, price: 20.05 })
  assert.ok(rows.every((t) => /^\d{19}$/.test(t.orderNo) && /^C\d{4}$/.test(t.clientCode)))
})
test('a row carries every field the ledger and de-dup need', () => {
  const f = parse('0827TRD.TXT')
  assert.equal(f.kind, 'trades'); assert.equal(f.day, '2026-08-27'); assert.deepEqual(f.skipped, [])
  assert.deepEqual(f.trades![2], {
    tradeNo: '27894220', orderNo: '1787824741877516440', clientCode: 'C0001', stock: 'SENSEX', instrument: 'option',
    expiry: '2026-08-27', strike: 77000, optType: 'CE', side: 'Sell', qty: 220, price: 0.1,
    time: Date.parse('2026-08-27T15:31:43+05:30'), day: '2026-08-27', seq: 3,
  })
  assert.deepEqual(parse('0924TRD.TXT').trades!.map((t) => [t.seq, t.side, t.clientCode]), [[1, 'Sell', 'C0001'], [2, 'Buy', 'C0001']])
})
test('a side code that disagrees with the member-code column is skipped, not fatal', () => {
  const flipped = L27[0]!.replace(/,1,BSE OPT/, ',2,BSE OPT')
  const f = odinBseFoTrades.parse(fileOf(flipped, L27[1]!), PATH)
  assert.deepEqual(f.skipped, [{ lineNo: 1, reason: 'side code and member-code column disagree' }])
  assert.deepEqual(f.trades!.map((t) => t.seq), [2])
  const noCode = L24[1]!.replace(/,1$/, ',2')   // 48-field buy line flipped to sell
  assert.deepEqual(odinBseFoTrades.parse(fileOf(L24[0]!, noCode), PATH).skipped, [{ lineNo: 2, reason: 'side code and member-code column disagree' }])
})
test('only BSE Derivatives trade files are claimed, by path alone', () => {
  assert.equal(odinBseFoTrades.matches('BSE Derivatives/Trades/0827TRD.TXT', L27[0]!), true)
  assert.equal(odinBseFoTrades.matches('bse derivatives/trades/0924trd.txt', L24[0]!), true)
  for (const p of ['BSE Derivatives/Orders/DOR081026-01.0000.TXT', 'Nse Derivatives/Trades/0827TRD.TXT', 'BSE Derivatives/Trades/notes.txt', 'BSE Equities/Trades/0827TRD.TXT'])
    assert.equal(odinBseFoTrades.matches(p, L27[0]!), false, p)
  // layout and content are per-line checks, never a reason to leave the file unread
  for (const first of [L27[0]!.slice(0, 60), `${L27[0]!},x`, L27[0]!.replace(',11,', ',12,'), ''])
    assert.equal(odinBseFoTrades.matches(PATH, first), true, first)
  assert.throws(() => odinBseFoTrades.parse(`${L27[0]!},x\r\n`, PATH),
    (e: unknown) => e instanceof ParseError && e.message === 'no line could be read; line 1: expected 47, 48 or 51 fields, got 52')
})
test('every reason a line is skipped is named', () => {
  const set = (line: string, i: number, v: string) => { const f = line.split(','); f[i] = v; return f.join(',') }
  const f = odinBseFoTrades.parse(fileOf(L27[0]!, set(L27[1]!, 5, 'IF'), set(L27[1]!, 2, '12'), L27[1]!.split(',').slice(0, 40).join(','),
    set(L27[1]!, 8, '31 NOV 2026'), set(L27[1]!, 10, 'XX'), set(L27[1]!, 15, '0'), set(L27[1]!, 33, 'x'), set(L27[1]!, 31, ''), set(L27[1]!, 47, '3')), PATH)
  assert.equal(f.trades!.length, 1)
  assert.deepEqual(f.skipped, [
    { lineNo: 2, reason: 'BSE instrument "IF" not understood' },
    { lineNo: 3, reason: 'trade status "12" is not 11' },
    { lineNo: 4, reason: 'expected 47, 48 or 51 fields, got 40' },
    { lineNo: 5, reason: 'expiry "31 NOV 2026" is not an ODIN expiry' },
    { lineNo: 6, reason: 'option type "XX" must be CE or PE' },
    { lineNo: 7, reason: 'qty must be positive' },
    { lineNo: 8, reason: 'no 19-digit order number' },
    { lineNo: 9, reason: 'client code is empty' },
    { lineNo: 10, reason: 'side "3" must be 1 (buy) or 2 (sell)' },
  ])
})
test('an unterminated last line is held back; a file of only bad lines is a ParseError', () => {
  const t = text('0827TRD.TXT')
  assert.equal(odinBseFoTrades.parse(t.replace(/\r\n$/, ''), PATH).trades!.length, 2)
  assert.deepEqual(odinBseFoTrades.parse('', PATH), { kind: 'trades', day: '', trades: [], skipped: [] })
  assert.throws(() => odinBseFoTrades.parse(fileOf(L27[0]!.replace(',11,', ',12,')), PATH), { name: 'ParseError' })
})
test('the 47-field layout has no side code: the member-code column is the side', () => {
  const drop = (l: string) => l.split(',').slice(0, -1).join(',')   // a 48-field line without its trailing side code
  assert.deepEqual(L24.slice(0, 2).map((l) => l.split(',').length), [48, 48])
  const f = odinBseFoTrades.parse(fileOf(drop(L24[0]!), drop(L24[1]!)), PATH)
  assert.deepEqual(f.skipped, [])
  const full = odinBseFoTrades.parse(fileOf(L24[0]!, L24[1]!), PATH)
  assert.deepEqual(f.trades, full.trades)
  assert.deepEqual(f.trades!.map((t) => t.side), ['Sell', 'Buy'])
  const neither = drop(L24[0]!).split(','); neither[12] = ''; neither[13] = ''
  assert.deepEqual(odinBseFoTrades.parse(fileOf(neither.join(','), drop(L24[1]!)), PATH).skipped,
    [{ lineNo: 1, reason: 'no side code, and no member-code column to read the side from' }])
})
