import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { ParseError } from '../src/ingest/parsers.ts'
import { ODIN_ORDER_STATUS, odinNseOrders } from '../src/ingest/odin/nse-orders.ts'

// Scrubbed excerpts of a real trader's OnLineBackup folder (client C0001, user U0001), CRLF and padding kept.
const ROOT = fileURLToPath(new URL('./fixtures/odin', import.meta.url))
const read = (path: string) => readFileSync(`${ROOT}/${path}`, 'latin1')
const parse = (path: string) => odinNseOrders.parse(read(path), path)
const fileOf = (...lines: string[]) => [...lines, ''].join('\r\n')
const FO = 'Nse Derivatives/Orders/1019ORD.TXT'
const FO_LINES = read(FO).split('\r\n')
const withField = (line: string, i: number, v: string) => { const f = line.split(','); f[i] = v; return f.join(',') }

test('status labels and quantities', () => {
  const [cancelled, tradedZeroQty] = parse('Nse Derivatives/Orders/NSE_25082026Ord.txt').orders!
  assert.deepEqual([cancelled!.status, cancelled!.qty, cancelled!.filledQty], ['Cancelled (5)', 3200, 0])
  assert.deepEqual([tradedZeroQty!.status, tradedZeroQty!.qty, tradedZeroQty!.filledQty], ['Traded (4)', 325, 325])
  const [partly, open] = parse('Nse Derivatives/Orders/0825ORD.TXT').orders!
  assert.deepEqual([partly!.status, partly!.qty, partly!.filledQty], ['Partly traded (3)', 9600, 6400])
  assert.equal(open!.status, 'Open (1)')
})
test('a full row', () => {
  const [o] = parse('Nse Derivatives/Orders/NSE_25082026Ord.txt').orders!
  assert.deepEqual(o, {
    orderNo: '2600000000806486', exchOrderNo: '2600000000806486', clientCode: 'C0001', stock: 'TMPV', instrument: 'option',
    expiry: '2026-09-29', strike: 335, optType: 'CE', side: 'Sell', qty: 3200, price: 3, status: 'Cancelled (5)', reason: '',
    time: Date.parse('2026-08-25T09:16:03+05:30'), day: '2026-08-25', filledQty: 0, updateTime: Date.parse('2026-08-25T09:16:39+05:30'),
  })
})
test('both ODIN time styles; entry vs last update', () => {
  const [local, traded] = parse(FO).orders!
  assert.equal(traded!.time, Date.parse('2026-10-19T09:21:00+05:30')); assert.equal(traded!.updateTime, Date.parse('2026-10-19T09:21:09+05:30'))
  assert.equal(local!.time, Date.parse('2026-10-19T09:18:42+05:30'))
})
test('an order the exchange never numbered gets a stable local number', () => {
  const a = parse(FO).orders![0]!, b = parse(FO).orders![0]!
  assert.equal(a.exchOrderNo, '0'); assert.match(a.orderNo, /^local:[0-9a-f]{16}$/); assert.equal(a.orderNo, b.orderNo); assert.equal(a.clientCode, '')
  assert.equal(a.qty, 300)
  const other = odinNseOrders.parse(fileOf(withField(FO_LINES[0]!, 21, '96.20')), FO).orders![0]!
  assert.notEqual(other.orderNo, a.orderNo)
})
test('code 6 reads Rejected; an unknown code is shown as itself', () => {
  assert.equal(parse(FO).orders![2]!.status, 'Rejected (6)')
  assert.equal(odinNseOrders.parse(fileOf(withField(FO_LINES[1]!, 1, '9 ')), FO).orders![0]!.status, 'code 9')
  assert.deepEqual(ODIN_ORDER_STATUS, { '1': 'Open', '3': 'Partly traded', '4': 'Traded', '5': 'Cancelled', '6': 'Rejected' })
})
test('the equities layout gives share orders', () => {
  const f = parse('Nse Equities/Orders/NSE_25082026Ord.txt')
  assert.equal(f.kind, 'orders'); assert.equal(f.day, '2026-08-25')
  const o = f.orders![0]!
  assert.deepEqual([o.instrument, o.stock, o.side, o.price, o.qty, o.filledQty, o.status, o.clientCode], ['share', 'BAJFINANCE', 'Sell', 1083, 1, 1, 'Traded (4)', 'C0001'])
  assert.deepEqual([o.expiry, o.strike, o.optType], ['', null, null])
  assert.equal(o.time, Date.parse('2026-08-25T15:07:02+05:30'))
})
test('an order with no last update time (never accepted) is read, its update time its entry time', () => {
  const f = odinNseOrders.parse(fileOf(withField(FO_LINES[1]!, 31, '                     ')), FO)
  assert.equal(f.skipped?.length ?? 0, 0)
  assert.equal(f.orders!.length, 1)
  assert.equal(f.orders![0]!.updateTime, f.orders![0]!.time)
})

test('a line that cannot be read is skipped and reported; the rest land', () => {
  const f = odinNseOrders.parse(fileOf(FO_LINES[1]!, withField(FO_LINES[1]!, 13, '7'), 'junk,1'), FO)
  assert.equal(f.orders!.length, 1)
  assert.deepEqual(f.skipped!.map((s) => s.lineNo), [2, 3])
  assert.throws(() => odinNseOrders.parse(fileOf('junk,1'), FO), ParseError)
})
test('each folder reads its own layout; a file of none is a ParseError', () => {
  const eq = read('Nse Equities/Orders/NSE_25082026Ord.txt').split('\r\n')[0]!
  assert.throws(() => odinNseOrders.parse(fileOf(eq), FO),
    (e: unknown) => e instanceof ParseError && e.message === 'no line could be read; line 1: expected 35 fields, got 34')
  assert.throws(() => odinNseOrders.parse(fileOf(FO_LINES[1]!), 'Nse Equities/Orders/NSE_25082026Ord.txt'),
    (e: unknown) => e instanceof ParseError && e.message === 'no line could be read; line 1: expected 34 fields, got 35')
  const mixed = odinNseOrders.parse(fileOf(FO_LINES[1]!, `${FO_LINES[1]!},x`), FO)
  assert.equal(mixed.orders!.length, 1); assert.deepEqual(mixed.skipped, [{ lineNo: 2, reason: 'expected 35 fields, got 36' }])
})
test('an unterminated last line is held back', () => {
  const text = read(FO)
  assert.equal(odinNseOrders.parse(text.replace(/\r\n$/, ''), FO).orders!.length, 2)
})
test('both name styles, either segment, by path alone; nothing else is claimed', () => {
  const fo = FO_LINES[0]!, eq = read('Nse Equities/Orders/NSE_25082026Ord.txt').split('\r\n')[0]!
  for (const p of ['Nse Derivatives/Orders/1019ORD.TXT', 'nse derivatives/orders/NSE_25082026Ord.txt', 'x/Nse Derivatives/Orders/0825ord.txt'])
    assert.equal(odinNseOrders.matches(p, fo), true, p)
  assert.equal(odinNseOrders.matches('Nse Equities/Orders/NSE_25082026Ord.txt', eq), true)
  // the layout is a per-line check against the folder's, never a reason to leave the file unread
  for (const first of [fo, `${eq},x,x`, ''])
    assert.equal(odinNseOrders.matches('Nse Equities/Orders/NSE_25082026Ord.txt', first), true, first)
  for (const first of [eq, `${fo},x`, ''])
    assert.equal(odinNseOrders.matches('Nse Derivatives/Orders/1019ORD.TXT', first), true, first)
  for (const p of ['Nse Derivatives/Trades/1019TRD.TXT', 'Nse Derivatives/Orders/x.log', 'MCX Derivatives/Orders/1019ORD.TXT', 'Nse Derivatives/Orders/sub/1019ORD.TXT'])
    assert.equal(odinNseOrders.matches(p, fo), false, p)
})
