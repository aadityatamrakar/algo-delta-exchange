import { after, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { skipUnlessMongo } from '../../api/test/require-mongo.ts'
import { LegStore } from '../src/books/legs.ts'
import { makeApply } from '../src/ingest/apply.ts'
import { CANONICAL_HEADERS, canonicalPositions, canonicalTrades } from '../src/ingest/canonical.ts'
import { FileStore } from '../src/ingest/files.ts'
import { LedgerStore } from '../src/ingest/ledger-store.ts'
import { odinBseFoTrades } from '../src/ingest/odin/bse-fo-trades.ts'
import { odinNseEqTrades } from '../src/ingest/odin/nse-eq-trades.ts'
import { odinNseFoTrades } from '../src/ingest/odin/nse-fo-trades.ts'
import { odinNseOrders } from '../src/ingest/odin/nse-orders.ts'
import { CANONICAL_PARSERS, registerParsers, type FileParser, type ParsedFile, type ParsedPosition } from '../src/ingest/parsers.ts'
import { ingestUpload, reparseProblems, type IngestDeps } from '../src/ingest/pipeline.ts'
import { sha256hex } from '../src/hash.ts'
import { matchLeg } from '../src/market/master.ts'
import { Conflict, NotFound } from '../src/routes/kit.ts'
import type { ManualLegInput, StoredFile } from '../src/types.ts'
import { NIFTY_WK, OCT, TCS_OCT_FUT, TCS_SPOT, jslPE, octCE, testMaster } from './fixtures/master.ts'
import { connectSuite, wipe } from './mongo.ts'

const MASTER = testMaster()
const h = await connectSuite('apply')
const clock = { now: Date.parse('2026-10-19T10:30:00+05:30') }
let masterFails = 0
const legStore = h === null ? null! : new LegStore(h.db, () => clock.now)
const ledger = h === null ? null! : new LedgerStore(h.db)
const apply = h === null ? null! : makeApply({
  db: h.db, legs: legStore, ledger, now: () => clock.now,
  master: () => { if (masterFails > 0) { masterFails--; throw new Error('master not loaded') } return MASTER },
})
const deps: IngestDeps | null = h === null ? null : { files: new FileStore(h.db, () => clock.now), apply, log: () => {} }

if (h !== null) await h.db.ensureIndexes()
after(async () => { registerParsers(CANONICAL_PARSERS); await h?.handle.close() })
beforeEach(async () => {
  if (h === null) return
  registerParsers([odinNseFoTrades, odinNseEqTrades, odinBseFoTrades, odinNseOrders, ...CANONICAL_PARSERS])
  await wipe(h.handle); sent.clear(); masterFails = 0
  clock.now = Date.parse('2026-10-19T10:30:00+05:30')
})

// Scrubbed excerpts of a real trader's OnLineBackup folder (client C0001), CRLF kept.
const ROOT = fileURLToPath(new URL('./fixtures/odin', import.meta.url))
const readFixture = (p: string) => readFileSync(`${ROOT}/${p}`, 'latin1')

const sent = new Map<string, string>()   // trader|path -> the whole text the watcher has sent
async function upload(path: string, text: string, trader = 'ravi') {
  sent.set(`${trader}|${path}`, text)
  const body = Buffer.from(text, 'latin1')
  return await ingestUpload(deps!, trader, { path, mtime: clock.now, sha256: sha256hex(body), body, offset: null })
}
async function append(path: string, more: string, offset: number, trader = 'ravi') {
  const whole = (sent.get(`${trader}|${path}`) ?? '') + more
  sent.set(`${trader}|${path}`, whole)
  const body = Buffer.from(more, 'latin1')
  return await ingestUpload(deps!, trader, { path, mtime: clock.now, sha256: sha256hex(Buffer.from(whole, 'latin1')), body, offset })
}

// 'HH:MM' is on 2026-10-19; 'YYYY-MM-DD HH:MM' names its day. IST.
const at = (when: string) => `${when.length === 5 ? '2026-10-19' : when.slice(0, 10)}T${when.slice(-5)}:00+05:30`
type TradeRow = readonly [tradeNo: string, orderNo: string, side: 'Buy' | 'Sell', qty: number, price: number, when: string, client?: string]
/** Canonical trades in TCS 3500 CE OCT (or `contract`: stock,instrument,expiry,strike,type), client C1 unless the row names one. */
const tradesCsv = (rows: readonly TradeRow[], contract = `TCS,option,${OCT},3500,CE`) =>
  [CANONICAL_HEADERS.trades, ...rows.map(([t, o, side, qty, price, when, client = 'C1']) => `${t},${o},${client},${contract},${side},${qty},${price},${at(when)}`), ''].join('\n')
type PositionRow = readonly [client: string, stock: string, instrument: string, expiry: string, strike: number | '', type: string, qty: number, avg: number]
const positionsCsv = (rows: readonly PositionRow[]) => [CANONICAL_HEADERS.positions, ...rows.map((r) => r.join(',')), ''].join('\n')
/** Canonical orders: TCS 3500 CE OCT, client C1, Sell 350 at 40. */
const ordersCsv = (rows: readonly (readonly [orderNo: string, status: string, when: string])[]) =>
  [CANONICAL_HEADERS.orders, ...rows.map(([o, status, when]) => `${o},X${o},C1,TCS,option,${OCT},3500,CE,Sell,350,40,${status},,${at(when)}`), ''].join('\n')
const shares = (stock: string, qty: number, avgPrice: number): ManualLegInput =>
  ({ stock, instrument: 'share', expiry: '', strike: null, optType: null, qty, avgPrice, note: '' })
const pos = (stock: string, instrument: ParsedPosition['instrument'], expiry: string, strike: number | null, optType: 'CE' | 'PE' | null, qty: number, avgPrice: number, clientCode = 'C1'): ParsedPosition =>
  ({ clientCode, stock, instrument, expiry, strike, optType, qty, avgPrice })
const count = (name: 'traders-trades' | 'traders-orders' | 'traders-log' | 'traders-legs', trader = 'ravi') =>
  h!.db.collection(name).countDocuments({ trader })
const rows = (name: 'traders-trades' | 'traders-orders' | 'traders-log' | 'traders-legs' | 'traders-settings', sort: Record<string, 1>, trader = 'ravi') =>
  h!.db.collection(name).find({ trader }, { projection: { _id: 0 } }).sort(sort).toArray()
/** Everything apply writes for one trader. */
const state = async (trader = 'ravi') => ({
  trades: await rows('traders-trades', { day: 1, tradeNo: 1, orderNo: 1 }, trader),
  orders: await rows('traders-orders', { day: 1, orderNo: 1 }, trader),
  log: await rows('traders-log', { day: 1, seq: 1 }, trader),
  legs: await rows('traders-legs', { key: 1 }, trader),
  settings: await rows('traders-settings', { kind: 1 }, trader),
})
const storedFile = (path: string, parser: string): StoredFile =>
  ({ trader: 'ravi', path, sha256: '0'.repeat(64), size: 1, mtime: clock.now, receivedAt: clock.now, parser, parseError: null })
const FO_1019 = 'Nse Derivatives/Trades/1019TRD.TXT'

test('a changed ODIN layout is claimed and listed with the problems, never stored silently', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const lines = readFixture(FO_1019).split('\r\n')
  const crlf = (...l: string[]) => [...l, ''].join('\r\n')
  const changed = 'Nse Derivatives/Trades/1020TRD.TXT', mixed = 'Nse Derivatives/Trades/1021TRD.TXT'
  const r = await upload(changed, crlf(`${lines[0]!},x,x`, `${lines[1]!},x,x`))   // 27 fields: a layout no parser knows
  assert.deepEqual(r, { stored: true, parser: 'odin-nse-fo-trades', parseError: 'no line could be read; line 1: expected 25, 26 or 28 fields, got 27' })
  clock.now += 1_000
  await upload(mixed, crlf(lines[0]!, `${lines[1]!},x,x,x,x`))   // a 29-field line among known ones
  assert.equal(await count('traders-trades'), 1)
  clock.now += 1_000
  await upload('BSE Derivatives/Orders/DOR201026-01.0000.TXT', 'a|b|c\r\n')   // the one ODIN file stored and not read
  const p = await deps!.files.problems('ravi', 10)
  assert.deepEqual(p.files.map((f) => [f.path, f.parser, f.parseError, f.skipped]), [
    [mixed, 'odin-nse-fo-trades', null, [{ lineNo: 2, reason: 'expected 25, 26 or 28 fields, got 29' }]],
    [changed, 'odin-nse-fo-trades', 'no line could be read; line 1: expected 25, 26 or 28 fields, got 27', undefined],
  ])
  assert.equal(p.total, 2)
  const bse = (await deps!.files.list('ravi')).find((f) => f.path.startsWith('BSE'))
  assert.deepEqual([bse!.parser, bse!.parseError], [null, null])
})

test('files and lines refused before their parser knew the layout are read again from what is stored', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const good = FO_1019, bad = 'Nse Derivatives/Trades/1020TRD.TXT', mixed = 'Nse Derivatives/Trades/1021TRD.TXT'
  const lines = readFixture(FO_1019).split('\r\n')
  await upload(good, readFixture(FO_1019))
  const n = await count('traders-trades')
  assert.ok(n > 0)
  await upload(bad, [`${lines[0]!},x,x`, ''].join('\r\n'))   // 27 fields: still no parser's layout
  await upload(mixed, [lines[0]!, lines[1]!, ''].join('\r\n'))   // two good lines
  // as an older parser left it: refused, nothing applied
  await deps!.files.setParse('ravi', good, 'odin-nse-fo-trades', 'no line could be read; line 1: expected 25 or 28 fields, got 26')
  await deps!.files.setParse('ravi', mixed, 'odin-nse-fo-trades', null, [{ lineNo: 2, reason: 'expected 25 or 28 fields, got 26' }])
  await h.db.collection('traders-trades').deleteMany({ trader: 'ravi' })
  assert.deepEqual(await reparseProblems(deps!), { tried: 3, left: 1 })
  assert.equal(await count('traders-trades'), n)
  const files = await deps!.files.list('ravi')
  assert.deepEqual(files.map((f) => [f.path, f.parseError]).sort(), [
    [good, null], [bad, 'no line could be read; line 1: expected 25, 26 or 28 fields, got 27'], [mixed, null],
  ].sort())
  assert.equal((await deps!.files.list('ravi')).find((f) => f.path === mixed)!.skipped, undefined)
  assert.deepEqual(await reparseProblems(deps!), { tried: 1, left: 1 })   // again: only the bad one is tried, nothing lands twice
  assert.equal(await count('traders-trades'), n)
})

test('trades become ODIN legs with the net price and a matched token', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  await upload('trades.csv', tradesCsv([['T1', 'O1', 'Sell', 350, 40, '09:20']]))
  const [leg] = await legStore.open('ravi', 'TCS')
  assert.deepEqual([leg!.key, leg!.qty, leg!.avgPrice, leg!.token, leg!.source], ['C1|option|TCS|2026-10-27|3500|CE', -350, 40, octCE(3500), 'odin'])
  const [trade] = await rows('traders-trades', { day: 1 })
  assert.deepEqual([trade!['qty'], trade!['side']], [350, 'Sell'])   // qty positive, the sign is in side
})

test('an append lands only its new lines; a half-written line is held back', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const lines = readFixture(FO_1019).split('\r\n')
  const first = lines.slice(0, 10).join('\r\n') + '\r\n', next = lines.slice(10, 12).join('\r\n') + '\r\n'
  await upload(FO_1019, first)
  assert.equal(await count('traders-trades'), 10)
  const r = await append(FO_1019, next, Buffer.byteLength(first))
  assert.equal(r.parseError, null)
  assert.equal(await count('traders-trades'), 12)
  await upload(FO_1019, first + next + lines[12]!.slice(0, 30))
  assert.equal(await count('traders-trades'), 12)
  assert.deepEqual((await rows('traders-trades', { seq: 1 })).map((x) => x['seq']), Array.from({ length: 12 }, (_, i) => i + 1))
  assert.equal(await ledger.historyFrom('ravi'), '2026-10-19')   // $min on no document yet creates it
})

test('the same trade number on another day or another order is another trade; a re-sent trade changes nothing', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  await upload('trades.csv', tradesCsv([['T1', 'O1', 'Buy', 175, 30, '2026-10-16 10:00'], ['T1', 'O1', 'Buy', 175, 30, '10:00'], ['T1', 'O2', 'Buy', 175, 30, '10:05']]))
  assert.equal(await count('traders-trades'), 3)
  await upload('again.csv', tradesCsv([['T1', 'O1', 'Buy', 175, 99, '10:00']]))
  assert.equal(await count('traders-trades'), 3)
  const kept = await h.db.collection('traders-trades').findOne({ trader: 'ravi', day: '2026-10-19', tradeNo: 'T1', orderNo: 'O1' })
  assert.equal(kept!['price'], 30)
})

test('a canonical positions file is an opening balance at the close of its day', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  await upload('positions-2026-10-16.csv', positionsCsv([['C1', 'TCS', 'option', OCT, 3500, 'CE', -350, 40]]))
  await upload('trades.csv', tradesCsv([['T0', 'O0', 'Sell', 999, 1, '2026-10-16 15:00'], ['T1', 'O1', 'Buy', 175, 30, '2026-10-19 10:15']]))
  const [leg] = await legStore.open('ravi'); assert.deepEqual([leg!.qty, leg!.avgPrice], [-175, 50])
})

test('a positions file without its date in the name is refused, and nothing is applied', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const why = 'a positions file needs its date in the name, e.g. positions-2026-10-16.csv — the balance is the positions at the close of that day'
  const r = await upload('positions.csv', positionsCsv([['C1', 'TCS', 'option', OCT, 3500, 'CE', -350, 40]]))
  assert.deepEqual(r, { stored: true, parser: 'canonical-positions', parseError: why })
  const file = await h.db.collection('traders-files').findOne({ trader: 'ravi', path: 'positions.csv' })
  assert.equal(file!['parseError'], why)
  assert.deepEqual(await state(), { trades: [], orders: [], log: [], legs: [], settings: [] })
})

test('a positions file dated after today, or today before the 15:40 close, is refused; yesterday is accepted', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const csv = positionsCsv([['C1', 'TCS', 'option', OCT, 3500, 'CE', -350, 40]])
  const notYet = (day: string) => `a positions file is the positions at the close of its date — ${day} has not closed yet`
  const refused = (day: string) => ({ stored: true, parser: 'canonical-positions', parseError: notYet(day) })
  assert.deepEqual(await upload('positions-2026-10-20.csv', csv), refused('2026-10-20'))      // tomorrow, at 10:30
  clock.now = Date.parse('2026-10-19T15:39:59+05:30')
  assert.deepEqual(await upload('positions-2026-10-19.csv', csv), refused('2026-10-19'))      // today, before the close
  assert.deepEqual(await state(), { trades: [], orders: [], log: [], legs: [], settings: [] })
  const file = await h.db.collection('traders-files').findOne({ trader: 'ravi', path: 'positions-2026-10-19.csv' })
  assert.equal(file!['parseError'], notYet('2026-10-19'))
  clock.now = Date.parse('2026-10-19T15:40:00+05:30')
  // the same file again once the day has closed is applied: a refusal for the clock is not the file's fault
  assert.deepEqual(await upload('positions-2026-10-19.csv', csv), { stored: true, parser: 'canonical-positions', parseError: null })
  assert.deepEqual((await legStore.open('ravi')).map((l) => [l.qty, l.avgPrice]), [[-350, 40]])
  clock.now = Date.parse('2026-10-20T00:10:00+05:30')
  assert.deepEqual(await upload('positions-2026-10-20.csv', csv), refused('2026-10-20'))      // its day has begun, not closed
  assert.deepEqual(await upload('positions-2026-10-19.csv', csv), { stored: true, parser: 'canonical-positions', parseError: null })   // yesterday
})

test('positions and trades uploaded at once land the same in either order', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const trades = tradesCsv([['T1', 'O1', 'Buy', 175, 30, '2026-10-19 10:15']])
  const balance = positionsCsv([['C1', 'TCS', 'option', OCT, 3500, 'CE', -350, 40]])
  await Promise.all([
    upload('trades.csv', trades, 'ravi'), upload('positions-2026-10-16.csv', balance, 'ravi'),
    upload('positions-2026-10-16.csv', balance, 'sita'), upload('trades.csv', trades, 'sita'),
  ])
  for (const who of ['ravi', 'sita']) {
    assert.deepEqual((await legStore.open(who)).map((l) => [l.qty, l.avgPrice]), [[-175, 50]], who)
  }
})

test('an ODIN upload never touches a manual leg', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const manual = await legStore.addManual('ravi', shares('TCS', 1000, 3000), TCS_SPOT)
  const before = await h.db.collection('traders-legs').findOne({ key: manual.key })
  clock.now += 60_000
  await upload('trades.csv', tradesCsv([['T1', 'O1', 'Sell', 350, 40, '09:20'], ['T2', 'O2', 'Buy', 350, 30, '09:30']]))
  assert.deepEqual((await legStore.open('ravi')).map((l) => l.key), [manual.key])
  assert.deepEqual(await h.db.collection('traders-legs').findOne({ key: manual.key }), before)
})

test('two client codes on one contract are two legs', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  await upload('trades.csv', tradesCsv([['T1', 'O1', 'Sell', 350, 40, '09:20', 'C1'], ['T2', 'O2', 'Buy', 175, 38, '09:21', 'C2']]))
  assert.deepEqual((await legStore.open('ravi')).map((l) => [l.key, l.qty]), [
    ['C1|option|TCS|2026-10-27|3500|CE', -350], ['C2|option|TCS|2026-10-27|3500|CE', 175]])
})

test('a balance row and an ODIN trade on the same contract are one leg', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  // canonical.ts and nse-fo-trades.ts both trim, upper-case the stock and read the strike as a number ('1000.00' -> 1000)
  await upload('positions-2026-10-16.csv', positionsCsv([['C0001', 'JINDALSTEL', 'option', OCT, 1000, 'PE', -1250, 8]]))
  await upload(FO_1019, readFixture(FO_1019).split('\r\n')[0]! + '\r\n')   // C0001 buys 625 JINDALSTEL 1000 PE OCT at 7.30
  const legs = await legStore.open('ravi')
  assert.deepEqual(legs.map((l) => [l.key, l.qty, Number(l.avgPrice.toFixed(4)), l.token]), [['C0001|option|JINDALSTEL|2026-10-27|1000|PE', -625, 8.7, jslPE(1000)]])
  assert.equal(await count('traders-legs'), 1)
})

test('a client code typed in another case in a balance file is still the same leg', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  await upload('positions-2026-10-16.csv', positionsCsv([['c0001', 'jindalstel', 'option', OCT, 1000, 'PE', -1250, 8]]))
  await upload(FO_1019, readFixture(FO_1019).split('\r\n')[0]! + '\r\n')
  assert.deepEqual((await legStore.open('ravi')).map((l) => [l.key, l.clientCode, l.qty]), [['C0001|option|JINDALSTEL|2026-10-27|1000|PE', 'C0001', -625]])
})

test('the opening balance reads back as the ledger walks it: client codes upper-cased; none is null', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  assert.equal(await ledger.balance('ravi'), null)
  await upload('positions-2026-10-16.csv', positionsCsv([['c0001', 'TCS', 'option', OCT, 3500, 'CE', -350, 40]]))
  const b = await ledger.balance('ravi')
  assert.deepEqual([b?.day, b?.positions.map((p) => [p.clientCode, p.stock, p.qty, p.avgPrice])], ['2026-10-16', [['C0001', 'TCS', -350, 40]]])
  assert.equal(await ledger.balance('sita'), null)
})

test('applying the same parsed files again leaves exactly the same stored state', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const files: [FileParser, string, string][] = [
    [canonicalPositions, 'positions-2026-10-16.csv', positionsCsv([['C0001', 'JINDALSTEL', 'option', OCT, 1000, 'PE', -1250, 8]])],
    [odinNseFoTrades, FO_1019, readFixture(FO_1019)],
    [odinNseFoTrades, 'Nse Derivatives/Trades/1016TRD.TXT', readFixture('Nse Derivatives/Trades/1016TRD.TXT')],
    [odinNseOrders, 'Nse Derivatives/Orders/1019ORD.TXT', readFixture('Nse Derivatives/Orders/1019ORD.TXT')],
    [canonicalTrades, 'trades.csv', tradesCsv([['T1', 'O1', 'Sell', 350, 40, '09:20']])],
  ]
  const applyAll = async () => { for (const [p, path, text] of files) await apply('ravi', p.parse(text, path), storedFile(path, p.id)) }
  await applyAll()
  const once = await state(), v = legStore.version('ravi')
  assert.ok(once.trades.length > 40 && once.orders.length === 3 && once.legs.length > 5)
  clock.now += 3_600_000
  await applyAll()
  assert.deepEqual(await state(), once)
  assert.equal(legStore.version('ravi'), v)   // nothing changed, nothing written
})

test('an apply that died half-way is finished by the identical resend', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const text = tradesCsv([['T1', 'O1', 'Sell', 350, 40, '09:20']])
  masterFails = 1
  await assert.rejects(upload('trades.csv', text), /master not loaded/)
  assert.equal(await count('traders-trades'), 1)                    // the trades landed, the legs did not
  assert.deepEqual(await legStore.open('ravi'), [])
  const r = await upload('trades.csv', text)
  assert.deepEqual(r, { stored: true, parser: 'canonical-trades', parseError: null })
  assert.equal(await count('traders-trades'), 1)
  assert.deepEqual((await legStore.open('ravi')).map((l) => [l.qty, l.avgPrice, l.token]), [[-350, 40, octCE(3500)]])
})

test('an older orders file never overwrites a newer state', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  await upload('orders-a.csv', ordersCsv([['O1', 'Traded (4)', '10:00']]))
  await upload('orders-b.csv', ordersCsv([['O1', 'Open (1)', '09:30'], ['O2', 'Open (1)', '09:31']]))
  const got = await rows('traders-orders', { orderNo: 1 })
  assert.deepEqual(got.map((o) => [o['orderNo'], o['status']]), [['O1', 'Traded (4)'], ['O2', 'Open (1)']])
  await upload('orders-c.csv', ordersCsv([['O2', 'Cancelled (5)', '09:45']]))
  assert.equal((await h.db.collection('traders-orders').findOne({ trader: 'ravi', orderNo: 'O2' }))!['status'], 'Cancelled (5)')
})

test('two ODIN order files for one day, one per name style, keep the newest state of each order', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const dated = readFixture('Nse Derivatives/Orders/NSE_25082026Ord.txt'), plain = readFixture('Nse Derivatives/Orders/0825ORD.TXT')
  const cancelled = dated.split('\r\n')[0]!   // 2600000000806486, status 5, last update 09:16:39
  const withFields = (line: string, status: string, update: string) => { const f = line.split(','); f[1] = status; f[31] = update; return f.join(',') }
  await upload('Nse Derivatives/Orders/NSE_25082026Ord.txt', dated)
  await upload('Nse Derivatives/Orders/0825ORD.TXT', plain + withFields(cancelled, '1 ', '25 AUG 2026 09:16:10') + '\r\n')   // an older copy of that order
  const all = await rows('traders-orders', { orderNo: 1 })
  assert.equal(all.length, 4)
  assert.ok(all.every((o) => o['day'] === '2026-08-25'))
  const status = async () => (await h.db.collection('traders-orders').findOne({ trader: 'ravi', orderNo: '2600000000806486' }))!['status']
  assert.equal(await status(), 'Cancelled (5)')
  await upload('Nse Derivatives/Orders/0825ORD.TXT', plain + withFields(cancelled, '4 ', '25 AUG 2026 09:17:00') + '\r\n')   // a newer one
  assert.equal(await status(), 'Traded (4)')
  assert.equal(await count('traders-orders'), 4)
})

test('log lines are insert-if-new on (day, seq)', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const log = (lines: [number, string][]): ParsedFile => ({ kind: 'log', day: '2026-10-19', log: lines.map(([seq, text]) => ({ day: '2026-10-19', seq, time: clock.now, text })) })
  await apply('ravi', log([[1, 'a'], [2, 'b']]), storedFile('x.log', 'some-log'))
  await apply('ravi', log([[2, 'changed'], [3, 'c']]), storedFile('x.log', 'some-log'))
  assert.deepEqual((await rows('traders-log', { seq: 1 })).map((l) => [l['seq'], l['text']]), [[1, 'a'], [2, 'b'], [3, 'c']])
})

test('historyFrom is the earliest ODIN trade file\'s day', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  assert.equal(await ledger.historyFrom('ravi'), null)
  await upload('positions-2026-10-12.csv', positionsCsv([['C0001', 'JINDALSTEL', 'option', OCT, 1000, 'PE', -625, 8]]))   // a balance first: its document must not block $min
  assert.equal(await ledger.historyFrom('ravi'), null)
  await upload(FO_1019, readFixture(FO_1019))
  assert.equal(await ledger.historyFrom('ravi'), '2026-10-19')
  await upload('Nse Derivatives/Trades/1016TRD.TXT', readFixture('Nse Derivatives/Trades/1016TRD.TXT'))
  assert.equal(await ledger.historyFrom('ravi'), '2026-10-16')
  await upload(FO_1019, readFixture(FO_1019) + readFixture(FO_1019).split('\r\n')[0]!.slice(0, 20))   // a later file again: no move
  assert.equal(await ledger.historyFrom('ravi'), '2026-10-16')
  await upload('old.csv', tradesCsv([['T9', 'O9', 'Buy', 175, 10, '2026-08-01 10:00']]))            // canonical: never moves it
  assert.equal(await ledger.historyFrom('ravi'), '2026-10-16')
  await upload('BSE Derivatives/Trades/0827TRD.TXT', readFixture('BSE Derivatives/Trades/0827TRD.TXT'))   // every odin-*-trades parser counts
  assert.equal(await ledger.historyFrom('ravi'), '2026-08-27')
  await upload('Nse Derivatives/Orders/0825ORD.TXT', readFixture('Nse Derivatives/Orders/0825ORD.TXT'))  // orders do not
  assert.equal(await ledger.historyFrom('ravi'), '2026-08-27')
  assert.equal(await ledger.historyFrom('sita'), null)
})

test('editing or deleting an ODIN leg is a Conflict; an unknown key is NotFound; every write bumps version', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const v0 = legStore.version('ravi'), sita0 = legStore.version('sita')
  await upload('trades.csv', tradesCsv([['T1', 'O1', 'Sell', 350, 40, '09:20']]))
  assert.equal(legStore.version('ravi'), v0 + 1)
  const [odin] = await legStore.open('ravi')
  await assert.rejects(legStore.patchManual('ravi', odin!.key, { qty: 1 }), (e) => e instanceof Conflict && e.message === 'an ODIN leg cannot be edited; it follows the ODIN files')
  await assert.rejects(legStore.deleteManual('ravi', odin!.key), Conflict)
  await assert.rejects(legStore.patchManual('ravi', 'manual:nope', { qty: 1 }), NotFound)
  await assert.rejects(legStore.deleteManual('ravi', 'manual:nope'), NotFound)
  assert.equal(legStore.version('ravi'), v0 + 1)   // a refused write is no write

  const m = await legStore.addManual('ravi', shares('TCS', 1000, 3000), TCS_SPOT)
  assert.match(m.key, /^manual:[0-9a-f-]{36}$/)
  assert.deepEqual({ ...m, key: '' }, {
    trader: 'ravi', stock: 'TCS', instrument: 'share', expiry: '', strike: null, optType: null, qty: 1000, avgPrice: 3000,
    clientCode: '', source: 'manual', key: '', token: TCS_SPOT, note: '', updatedAt: clock.now })
  assert.equal(legStore.version('ravi'), v0 + 2)
  await assert.rejects(legStore.patchManual('sita', m.key, { qty: 1 }), NotFound)   // another trader's key
  await assert.rejects(legStore.deleteManual('sita', m.key), NotFound)

  clock.now += 1000
  const p = await legStore.patchManual('ravi', m.key, { qty: 500, note: 'carried' })
  assert.deepEqual(p, { ...m, qty: 500, note: 'carried', updatedAt: clock.now })
  assert.deepEqual((await legStore.open('ravi')).find((l) => l.key === m.key), p)
  assert.equal(legStore.version('ravi'), v0 + 3)
  await legStore.deleteManual('ravi', m.key)
  assert.equal(legStore.version('ravi'), v0 + 4)
  assert.deepEqual((await legStore.open('ravi')).map((l) => l.source), ['odin'])
  assert.equal(legStore.version('sita'), sita0)
})

test('replaceOdin: a contract the ledger no longer has goes to qty 0; an unchanged leg is not rewritten', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const opt = pos('TCS', 'option', OCT, 3500, 'CE', -350, 40), fut = pos('TCS', 'future', OCT, null, null, 175, 3500)
  const match = (c: Parameters<typeof matchLeg>[1]) => matchLeg(MASTER, c)
  await legStore.replaceOdin('ravi', [opt, fut], match)
  const t0 = clock.now, v = legStore.version('ravi')
  clock.now += 1000
  await legStore.replaceOdin('ravi', [opt, fut], match)
  assert.equal(legStore.version('ravi'), v)
  assert.deepEqual((await legStore.open('ravi')).map((l) => [l.key, l.token, l.updatedAt]), [
    ['C1|future|TCS|2026-10-27||', TCS_OCT_FUT, t0], ['C1|option|TCS|2026-10-27|3500|CE', octCE(3500), t0]])
  clock.now += 1000
  await legStore.replaceOdin('ravi', [opt], match)
  assert.equal(legStore.version('ravi'), v + 1)
  const all = await rows('traders-legs', { key: 1 })
  assert.deepEqual(all.map((l) => [l['key'], l['qty'], l['avgPrice'], l['updatedAt']]), [
    ['C1|future|TCS|2026-10-27||', 0, 0, clock.now], ['C1|option|TCS|2026-10-27|3500|CE', -350, 40, t0]])
})

test('openBooks lists every trader\'s open (trader, stock)', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  await legStore.replaceOdin('ravi', [
    pos('TCS', 'option', OCT, 3500, 'CE', -350, 40),
    pos('JINDALSTEL', 'option', '2026-09-29', 1000, 'PE', 625, 5),   // expired with qty left
    pos('M&M', 'future', OCT, null, null, 0, 0),                     // flat
  ], () => null)
  await legStore.addManual('sita', { stock: 'NIFTY', instrument: 'option', expiry: NIFTY_WK, strike: 25500, optType: 'CE', qty: -65, avgPrice: 80, note: '' }, null)
  await legStore.addManual('sita', shares('BAJFINANCE', 10, 900), null)   // a share never expires
  await legStore.addManual('sita', { stock: 'TCS', instrument: 'future', expiry: '2026-09-29', strike: null, optType: null, qty: 175, avgPrice: 3400, note: '' }, null)
  assert.deepEqual(await legStore.openBooks(), [{ trader: 'ravi', stock: 'TCS' }, { trader: 'sita', stock: 'BAJFINANCE' }, { trader: 'sita', stock: 'NIFTY' }])
  assert.deepEqual((await legStore.allOpen()).map((l) => `${l.trader} ${l.stock}`), ['ravi JINDALSTEL', 'ravi TCS', 'sita BAJFINANCE', 'sita NIFTY', 'sita TCS'])
  assert.deepEqual((await legStore.open('sita', 'TCS')).map((l) => l.expiry), ['2026-09-29'])   // open() does not look at expiry
})
