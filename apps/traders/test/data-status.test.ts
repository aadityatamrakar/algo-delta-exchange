/**
 * The admin's data status: the trading days, the grid and the flag (pure); then the route over a real Mongo — files
 * counted by the day the PC wrote them, trade lines, orders, rejects, the watcher line, admin only; and that none
 * of its queries scans.
 */
import { after, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { skipUnlessMongo } from '../../api/test/require-mongo.ts'
import {
  FILES_PROJECTION, dataStatusOf, filesFilter, lastTradingDays, ordersPipeline, tradesPipeline, type TraderCounts,
} from '../src/analytics/data-status.ts'
import { startTraders, type TradersHarness } from './harness.ts'
import { wipe } from './mongo.ts'

const ist = (iso: string): number => Date.parse(`${iso}+05:30`)

test('the last trading days run back from today over weekends and holidays, newest first', () => {
  // Fri 23 Oct 2026; Tue 20 Oct is Dussehra, closed
  assert.deepEqual(lastTradingDays(ist('2026-10-23T10:00:00'), 5), ['2026-10-23', '2026-10-22', '2026-10-21', '2026-10-19', '2026-10-16'])
  // a Saturday and a Sunday start from Friday; before the open today is still the first row
  assert.deepEqual(lastTradingDays(ist('2026-10-24T10:00:00'), 2), ['2026-10-23', '2026-10-22'])
  assert.deepEqual(lastTradingDays(ist('2026-10-25T23:00:00'), 1), ['2026-10-23'])
  assert.deepEqual(lastTradingDays(ist('2026-10-26T08:00:00'), 2), ['2026-10-26', '2026-10-23'])
  assert.deepEqual(lastTradingDays(ist('2026-10-23T10:00:00'), 0), [])
})

const day = (files: number, trades: number, orders = trades, rejected = 0) => ({ files, trades, orders, rejected })
const hb = (at: number) => ({ lastHeartbeatAt: at, lastUploadAt: at - 1000, version: '1.2.0', folder: 'C:\\ODIN', fileCount: 9 })
const NOW = ist('2026-10-22T11:00:00')
const DAYS = ['2026-10-22', '2026-10-21', '2026-10-19', '2026-10-16', '2026-10-15', '2026-10-14', '2026-10-13', '2026-10-12']

test('no files while another trader had trade lines is the flag; nobody trading is not', () => {
  const counts: TraderCounts[] = [
    { trader: 'zed', disabled: false, status: hb(NOW - 60_000), days: [day(2, 79), day(3, 105), day(2, 153), day(1, 57), day(2, 397), day(0, 0), day(0, 0), day(2, 307)] },
    { trader: 'amy', disabled: false, status: hb(NOW - 500_000), days: [day(3, 295), day(3, 392), day(1, 177), day(1, 129), day(3, 215), day(2, 142), day(2, 131), day(0, 0)] },
    { trader: 'old', disabled: true, status: null, days: [day(0, 0), day(0, 0), day(0, 0), day(0, 0), day(0, 0), day(0, 0), day(0, 0), day(0, 0)] },
  ]
  const v = dataStatusOf(DAYS, counts, NOW)
  assert.deepEqual(v.traders.map((t) => t.trader), ['amy', 'old', 'zed'])
  const zed = v.traders[2]!
  // 14 and 13 Oct: zed sent nothing while amy traded; 12 Oct: amy sent nothing, but zed traded
  assert.deepEqual(zed.days.filter((d) => d.noFilesWhileOthersTraded).map((d) => d.day), ['2026-10-14', '2026-10-13'])
  assert.deepEqual(v.traders[0]!.days.filter((d) => d.noFilesWhileOthersTraded).map((d) => d.day), ['2026-10-12'])
  assert.equal(v.traders[1]!.days.some((d) => d.noFilesWhileOthersTraded), false, 'a disabled trader is expected to send nothing')
  assert.deepEqual(v.flags, ['amy: no files on 12 Oct while others traded', 'zed: no files on 14 Oct, 13 Oct while others traded'])
  assert.deepEqual(v.days, DAYS)
  assert.ok(v.notes.some((n) => /modified time/.test(n)))
})

test('a day with no trade lines anywhere flags nobody, and a trader with files but no trades is fine', () => {
  const v = dataStatusOf(['2026-10-22', '2026-10-21'], [
    { trader: 'a', disabled: false, status: null, days: [day(0, 0), day(2, 0)] },
    { trader: 'b', disabled: false, status: null, days: [day(0, 0), day(1, 40)] },
  ], NOW)
  assert.deepEqual(v.flags, [])
  assert.equal(v.traders[0]!.days[1]!.noFilesWhileOthersTraded, false)
})

test('the watcher line: last heartbeat, version, and offline by the 180 s rule — never connected is offline', () => {
  const v = dataStatusOf(['2026-10-22'], [
    { trader: 'live', disabled: false, status: hb(NOW - 180_000), days: [day(1, 1)] },
    { trader: 'late', disabled: false, status: hb(NOW - 180_001), days: [day(1, 1)] },
    { trader: 'never', disabled: false, status: null, days: [day(1, 1)] },
  ], NOW)
  const by = Object.fromEntries(v.traders.map((t) => [t.trader, t.watcher]))
  assert.deepEqual(by['live'], { lastHeartbeatAt: NOW - 180_000, lastUploadAt: NOW - 181_000, version: '1.2.0', offline: false })
  assert.equal(by['late']!.offline, true)
  assert.deepEqual(by['never'], { lastHeartbeatAt: null, lastUploadAt: null, version: null, offline: true })
})

test('a long run of flagged days is named briefly', () => {
  const days = Array.from({ length: 9 }, (_, i) => `2026-10-${String(9 - i).padStart(2, '0')}`)
  const v = dataStatusOf(days, [
    { trader: 'a', disabled: false, status: null, days: days.map(() => day(0, 0)) },
    { trader: 'b', disabled: false, status: null, days: days.map(() => day(1, 50)) },
  ], ist('2026-10-10T10:00:00'))
  assert.deepEqual(v.flags, ['a: no files on 09 Oct, 08 Oct, 07 Oct, 06 Oct, 05 Oct, 04 Oct and 3 more while others traded'])
})

// ---- over Mongo --------------------------------------------------------------------

const h: TradersHarness | null = await startTraders({ suite: 'datastatus' })
after(async () => { await h?.close() })

let seq = 0
const file = (trader: string, path: string, mtime: number, receivedAt = mtime) =>
  ({ trader, path, sha256: `h${seq++}`, size: 10, mtime, receivedAt, parser: null, parseError: null, content: 'x' })
const trade = (trader: string, d: string) =>
  ({ trader, tradeNo: `t${seq}`, orderNo: `o${seq++}`, clientCode: 'C9', stock: 'TCS', instrument: 'option', expiry: '2026-10-27', strike: 3000, optType: 'CE', side: 'Buy', qty: 1, price: 1, time: 1, day: d, seq })
const order = (trader: string, d: string, status: string) =>
  ({ trader, orderNo: `o${seq++}`, exchOrderNo: 'e', clientCode: 'C9', stock: 'TCS', instrument: 'option', expiry: '2026-10-27', strike: 3000, optType: 'CE', side: 'Buy', qty: 1, price: 1, status, reason: '', time: 1, day: d, filledQty: null, updateTime: 1 })

// the harness clock: Mon 19 Oct 2026 09:30 IST. Days: 19, 16, 15 Oct.
beforeEach(async () => {
  if (h === null) return
  await wipe(h.handle)
  h.clock.now = ist('2026-10-19T16:00:00')
  await h.addUser('amy'); await h.addUser('zed'); await h.addUser('boss', 'admin')
  const files = h.handle.db.collection('traders-files')
  // amy's PC wrote a file on each of 15, 16 and 19 Oct, but everything was UPLOADED on the 19th (a backfill)
  await files.insertMany([
    file('amy', 'Nse Derivatives/Trades/1015TRD.TXT', ist('2026-10-15T15:50:00'), ist('2026-10-19T10:00:00')),
    file('amy', 'Nse Derivatives/Orders/1015ORD.TXT', ist('2026-10-15T15:51:00'), ist('2026-10-19T10:00:00')),
    file('amy', 'Nse Derivatives/Trades/1016TRD.TXT', ist('2026-10-16T15:50:00'), ist('2026-10-19T10:00:00')),
    file('amy', 'Nse Derivatives/Trades/1019TRD.TXT', ist('2026-10-19T15:35:00')),
    file('amy', 'Nse Derivatives/Trades/0901TRD.TXT', ist('2026-09-01T15:50:00')),                  // older than the window
    // zed: only the 16th and 19th; 15 Oct is missing while amy traded
    file('zed', 'Nse Derivatives/Trades/1016TRD.TXT', ist('2026-10-16T15:40:00')),
    file('zed', 'Nse Derivatives/Trades/1019TRD.TXT', ist('2026-10-19T15:40:00')),
  ])
  const trades = h.handle.db.collection('traders-trades')
  await trades.insertMany([
    trade('amy', '2026-10-15'), trade('amy', '2026-10-15'), trade('amy', '2026-10-16'), trade('amy', '2026-10-19'),
    trade('zed', '2026-10-16'), trade('zed', '2026-10-16'), trade('zed', '2026-10-16'), trade('zed', '2026-10-19'),
  ])
  await h.handle.db.collection('traders-orders').insertMany([
    order('amy', '2026-10-15', 'Traded (4)'), order('amy', '2026-10-15', 'Rejected (6)'), order('amy', '2026-10-16', 'Cancelled (5)'),
    order('zed', '2026-10-16', 'Rejected (6)'), order('zed', '2026-10-16', 'Order Rejected'), order('zed', '2026-10-16', 'Open (1)'),
  ])
  await h.app.deps.status.record('amy', { version: '1.3.0', folder: 'C:\\ODIN', lastUploadAt: h.clock.now - 10_000, fileCount: 5 }, h.clock.now - 60_000)
  await h.app.deps.status.record('zed', { version: '1.2.0', folder: 'C:\\ODIN', lastUploadAt: null, fileCount: 2 }, h.clock.now - 3_600_000)
})

const get = async (who: string, path: string): Promise<{ status: number; body: any }> => {
  const r = await h!.as(who)(path)
  return { status: r.status, body: await r.json() }
}

test('GET /admin/data-status: files by the PC\'s day, trade lines, orders, rejects, the flag and the watcher line', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const r = await get('boss', '/v1/traders/admin/data-status?days=3')
  assert.equal(r.status, 200)
  assert.deepEqual(r.body.days, ['2026-10-19', '2026-10-16', '2026-10-15'])
  assert.equal(r.body.asOf, h.clock.now)
  const [amy, zed] = r.body.traders
  assert.deepEqual([amy.trader, zed.trader], ['amy', 'zed'])
  const cells = (t: any) => t.days.map((d: any) => [d.day.slice(8), d.files, d.trades, d.orders, d.rejected, d.noFilesWhileOthersTraded])
  assert.deepEqual(cells(amy), [['19', 1, 1, 0, 0, false], ['16', 1, 1, 1, 0, false], ['15', 2, 2, 2, 1, false]])
  assert.deepEqual(cells(zed), [['19', 1, 1, 0, 0, false], ['16', 1, 3, 3, 2, false], ['15', 0, 0, 0, 0, true]])
  assert.deepEqual(r.body.flags, ['zed: no files on 15 Oct while others traded'])
  assert.deepEqual(amy.watcher, { lastHeartbeatAt: h.clock.now - 60_000, lastUploadAt: h.clock.now - 10_000, version: '1.3.0', offline: false })
  assert.deepEqual([zed.watcher.version, zed.watcher.offline], ['1.2.0', true])
  assert.equal(JSON.stringify(r.body).includes('C9'), false, 'no client code')
  assert.equal(JSON.stringify(r.body).includes('TRD.TXT'), false, 'no file names')
})

test('the default is 20 trading days, the most is 60, and a bad count is 400', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  assert.equal((await get('boss', '/v1/traders/admin/data-status')).body.days.length, 20)
  assert.equal((await get('boss', '/v1/traders/admin/data-status?days=60')).body.days.length, 60)
  for (const bad of ['0', '61', '2.5', 'x']) assert.equal((await h.as('boss')(`/v1/traders/admin/data-status?days=${bad}`)).status, 400, bad)
})

test('a trader who has sent and traded nothing is a row of zeros, flagged on the days others traded; no traders at all is an empty grid', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  await h.addUser('quiet')
  const r = await get('boss', '/v1/traders/admin/data-status?days=2')
  const quiet = r.body.traders.find((x: any) => x.trader === 'quiet')
  assert.deepEqual(quiet.days.map((d: any) => [d.files, d.trades, d.orders, d.rejected, d.noFilesWhileOthersTraded]), [[0, 0, 0, 0, true], [0, 0, 0, 0, true]])
  const { readDataStatus } = await import('../src/analytics/data-status.ts')
  await h.handle.db.collection('traders-users').deleteMany({ role: 'trader' })
  const none = await readDataStatus(h.deps, 3, h.clock.now)
  assert.deepEqual([none.traders, none.flags, none.days.length], [[], [], 3])
})

test('admin only: a trader is refused, no session is 401', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  assert.equal((await h.as('amy')('/v1/traders/admin/data-status')).status, 403)
  assert.equal((await fetch(`${h.url}/v1/traders/admin/data-status`)).status, 401)
})

// ---- no query scans ---------------------------------------------------------------

function ixscans(x: unknown, out: string[] = []): string[] {
  if (Array.isArray(x)) for (const v of x) ixscans(v, out)
  else if (x !== null && typeof x === 'object') {
    const o = x as Record<string, unknown>
    if (o['stage'] === 'IXSCAN' && typeof o['keyPattern'] === 'object') out.push(JSON.stringify(o['keyPattern']))
    if (o['stage'] === 'COLLSCAN') out.push('COLLSCAN')
    for (const v of Object.values(o)) ixscans(v, out)
  }
  return out
}

test('the three queries are index ranges whatever the traders and days: files and trade lines from an index alone, the orders by index', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  type Raw = { find(f: unknown, o?: unknown): { explain(v?: string): Promise<any> }; aggregate(p: unknown, o?: unknown): { toArray(): Promise<any[]> } }
  const coll = (name: string) => h!.handle.db.collection(name) as unknown as Raw
  const days = ['2026-10-19', '2026-10-16', '2026-10-15']
  const traders = ['amy', 'zed']
  const stages = (x: unknown, out: string[] = []): string[] => {
    if (Array.isArray(x)) for (const v of x) stages(v, out)
    else if (x !== null && typeof x === 'object') {
      const o = x as Record<string, unknown>
      if (typeof o['stage'] === 'string') out.push(o['stage'])
      for (const v of Object.values(o)) stages(v, out)
    }
    return out
  }
  const piped = async (name: string, pipeline: unknown) => {
    const [p] = await coll(name).aggregate(pipeline, { explain: true }).toArray()
    return { scans: [...new Set(ixscans(p.queryPlanner.winningPlan))], stages: stages(p.queryPlanner.winningPlan) }
  }

  const files = await coll('traders-files').find(filesFilter(traders, days[2]!), { projection: FILES_PROJECTION }).explain('executionStats')
  assert.deepEqual([...new Set(ixscans(files.queryPlanner.winningPlan))], [JSON.stringify({ trader: 1, mtime: -1, path: 1 })])
  assert.equal(files.executionStats.totalDocsExamined, 0, 'covered: no file content is read')

  const trades = await piped('traders-trades', tradesPipeline(traders, days))
  assert.deepEqual(trades.scans, [JSON.stringify({ trader: 1, day: 1 })])
  assert.ok(trades.stages.includes('PROJECTION_COVERED'), 'the counts come from the index alone')
  const orders = await piped('traders-orders', ordersPipeline(traders, days))
  assert.deepEqual(orders.scans, [JSON.stringify({ trader: 1, day: 1, orderNo: 1 })])
  for (const q of [trades, orders]) assert.equal(q.stages.includes('COLLSCAN'), false)

  // the daily record's reads
  const plan = async (filter: unknown): Promise<string[]> => {
    const p = await coll('traders-daily').find(filter).explain('executionStats')
    return [...new Set(ixscans(p.queryPlanner.winningPlan))]
  }
  assert.deepEqual(await plan({ trader: 'amy', day: { $gte: '2026-10-01' } }), [JSON.stringify({ trader: 1, day: -1 })])
  assert.equal((await plan({ trader: 'amy', day: '2026-10-19' })).includes('COLLSCAN'), false)
})
