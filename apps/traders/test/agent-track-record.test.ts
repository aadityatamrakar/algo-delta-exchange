/**
 * `get_track_record` through the whole app's deps on the suite's own Mongo: the P&L is the Booked page's net (read
 * from GET /booked itself), the rows are capped at 40 with the summary over all, a symbol that is not an NSE symbol is
 * dropped and counted, and no client code, order number, trade number or trader name ever reaches the result.
 * The history is a stub (the harness has no NSE folder); the clock is the harness's, Monday 19 Oct 2026.
 */

import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { skipUnlessMongo } from '../../api/test/require-mongo.ts'
import { LegAliases, Redactor } from '../src/agent/redact.ts'
import { droppedSymbols, ToolRefusal, type AgentDeps, type ToolCtx } from '../src/agent/tools/ctx.ts'
import { PlanCache } from '../src/agent/tools/plans.ts'
import { getTrackRecord } from '../src/agent/tools/track-record.ts'
import type { HistoryStore } from '../src/market/history.ts'
import type { TraderTrade } from '../src/types.ts'
import { OCT } from './fixtures/master.ts'
import { startTraders, type TradersHarness } from './harness.ts'

const SEP = '2026-09-29'
const CLIENT = 'ZQX9SENT'
const h: TradersHarness | null = await startTraders({ suite: 'track_record' })
after(async () => { await h?.close() })

let n = 0
const trade = (trader: string, side: 'Buy' | 'Sell', qty: number, price: number, day: string, o: Partial<TraderTrade> = {}): TraderTrade => {
  n++
  return {
    trader, tradeNo: `TRDSENT${n}`, orderNo: `ORDSENT${n}`, clientCode: CLIENT, stock: 'TCS', instrument: 'option', expiry: SEP, strike: 3150, optType: 'CE',
    side, qty, price, time: Date.parse(`${day}T10:00:00+05:30`), day, seq: n, ...o,
  }
}

/** 41 small losing series, so the rows are cut at 40. */
const FILLER = Array.from({ length: 41 }, (_, i) => `STK${i + 1}`)

before(async () => {
  if (h === null) return
  await h.addUser('ravi')
  const docs = [
    // TCS Sep: a strangle 5% out each side from the 3000 close, adjusted once, closed 15 Sep
    trade('ravi', 'Sell', 175, 40, '2026-09-01'), trade('ravi', 'Sell', 175, 30, '2026-09-01', { strike: 2850, optType: 'PE' }),
    trade('ravi', 'Buy', 175, 20, '2026-09-10', { strike: 2850, optType: 'PE' }),
    trade('ravi', 'Buy', 175, 10, '2026-09-15'),
    // TCS Oct, live
    trade('ravi', 'Sell', 175, 30, '2026-10-12', { expiry: OCT, strike: 3600 }),
    ...FILLER.flatMap((stock) => [trade('ravi', 'Sell', 100, 5, '2026-09-02', { stock }), trade('ravi', 'Buy', 100, 10, '2026-09-03', { stock })]),
    // a symbol that is file text, not an NSE symbol
    trade('ravi', 'Sell', 100, 10, '2026-09-02', { stock: 'bad stock' }), trade('ravi', 'Buy', 100, 5, '2026-09-03', { stock: 'bad stock' }),
    // another trader's series: never in ravi's record
    trade('sita', 'Sell', 175, 40, '2026-09-01', { stock: 'WIPRO' }),
  ]
  for (const doc of docs) await h.db.collection<TraderTrade>('traders-trades').insertOne(doc)
  await h.deps.ledger.noteHistory('ravi', '2026-09-01')
})

const history = {
  close: (stock: string, day: string) => (stock === 'TCS' && day === '2026-08-31' ? 3000 : stock === 'TCS' && day === '2026-10-09' ? 3500 : undefined),
  bars: (stock: string) => (stock !== 'TCS' ? [] : [
    { date: '2026-08-31', close: 3000 }, { date: '2026-09-04', close: 3240 }, { date: '2026-09-29', close: 2910 }, { date: '2026-10-09', close: 3500 },
  ]),
  version: () => 1,
} as unknown as HistoryStore

const ctxOf = (deps: AgentDeps): ToolCtx => ({
  trader: 'ravi', deps, aliases: new LegAliases(), plans: new PlanCache(), redactor: new Redactor({ trader: 'ravi', legs: [] }),
  counters: { toolCalls: 0, searches: 0 }, allowClose: false, userText: '', presets: [], view: null, stock: null, nextCardId: () => 'K1',
})
const depsOf = (hh: TradersHarness): AgentDeps => ({ ...hh.deps, history }) as unknown as AgentDeps

test('the record: P&L is the Booked page\'s net, 40 rows newest first with the summary over all, the notes, and nothing private', async (t) => {
  if (h === null) return skipUnlessMongo(t)
  const out = await getTrackRecord.run(ctxOf(depsOf(h)), {})
  const r = out.result as any
  const text = JSON.stringify(r)
  for (const bad of [CLIENT, CLIENT.toUpperCase(), 'ORDSENT', 'TRDSENT', 'ravi', 'sita', 'WIPRO', 'bad stock', 'clientCode', 'orderNo', 'tradeNo']) {
    assert.equal(text.includes(bad), false, bad)
  }
  for (const k of ['asOf', 'closed', 'feedAlive', 'stale', 'warnings']) assert.ok(k in r, k)
  assert.deepEqual([r.stock, r.months, r.from], [null, 12, '2025-10-19'])
  assert.deepEqual(r.rows, { shown: 40, total: 43, truncated: true })
  assert.equal(r.rowsNote, 'the newest 40 of 43 series are listed; the summary covers all of them')
  assert.equal(r.series.length, 40)
  assert.deepEqual([r.series[0].stock, r.series[0].expiry, r.series[0].open, r.series[0].pnl], ['TCS', OCT, true, null])
  assert.equal(r.summary.stock.n, 42, 'TCS Sep and the 41 fillers, though only 39 of them are listed')
  assert.equal(r.summary.index, null)
  assert.ok(r.warnings.includes(droppedSymbols(1)), JSON.stringify(r.warnings))
  assert.ok(r.warnings.includes('Figures count from 01 Sep 2026: the trade history the app holds starts there, and nothing before it is in them.'), JSON.stringify(r.warnings))
  assert.ok(r.warnings.some((w: string) => /charges rates not confirmed/.test(w)))
  assert.equal(out.summary, '42 expired series, 1 won; 1 open')

  // the Booked page's own figure for TCS Sep
  const page = await (await h.as('ravi')('/v1/traders/booked?from=2026-09&to=2026-09')).json() as any
  const row = page.rows.find((x: any) => x.stock === 'TCS' && x.expiry === SEP)
  assert.ok(row && typeof row.net === 'number', JSON.stringify(page.rows.slice(0, 3)))
  const tcs = (await getTrackRecord.run(ctxOf(depsOf(h)), { stock: 'tcs' })).result as any
  const sep = tcs.series.find((x: any) => x.expiry === SEP)
  assert.equal(sep.pnl, Math.round(row.net * 100) / 100)
  assert.ok(sep.pnl < (40 - 10) * 175 + (30 - 20) * 175, 'after charges')
  assert.deepEqual(
    [sep.entryDay, sep.dteAtEntry, sep.adjustDays, sep.lastDay, sep.dteAtLast, sep.contracts, sep.shortCallPct, sep.shortPutPct, sep.wings],
    ['2026-09-01', 28, 2, '2026-09-15', 14, 2, 5, 5, false],
  )
  assert.deepEqual([sep.maxUpPct, sep.maxDownPct, sep.heldToExpiry], [8, 0, false], 'closed 15 Sep: the 29 Sep fall is not its move')
  assert.deepEqual([tcs.stock, tcs.series.length, tcs.summary.stock.n, tcs.summary.stock.wins], ['TCS', 2, 1, 1])
})

test('the input: an NSE symbol or a refusal, months 1–18, strict; the label names the stock', async (t) => {
  assert.equal(getTrackRecord.label({}), 'reading your track record')
  assert.equal(getTrackRecord.label({ stock: 'tcs' }), 'reading your track record on TCS')
  assert.equal(getTrackRecord.input.safeParse({ months: 18 }).success, true)
  assert.equal(getTrackRecord.input.safeParse({ months: 19 }).success, false)
  assert.equal(getTrackRecord.input.safeParse({ months: 0 }).success, false)
  assert.equal(getTrackRecord.input.safeParse({ trader: 'sita' }).success, false, 'strict: no trader argument')
  if (h === null) return skipUnlessMongo(t)
  await assert.rejects(getTrackRecord.run(ctxOf(depsOf(h)), { stock: 'bad stock!' }), ToolRefusal)
  const month = (await getTrackRecord.run(ctxOf(depsOf(h)), { months: 1 })).result as any
  assert.equal(month.from, '2026-09-19')
  assert.equal(month.rows.total, 43, 'every series here expires on or after 19 Sep')
})
