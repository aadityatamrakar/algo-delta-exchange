import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { b76Price } from '@algomaker/greeks'
import { DEFAULT_RATE } from '@algomaker/payoff'
import { isNseTradingDay } from '../src/analytics/calendar.ts'
import { HistoryStore, atmIvOf, consecutiveDays } from '../src/market/history.ts'

function folder(t: { after(fn: () => void): void }): { root: string; write(day: string, body: unknown): void } {
  const root = mkdtempSync(join(tmpdir(), 'traders-history-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'history'))
  return { root, write: (day, body) => writeFileSync(join(root, 'history', `${day}.json`), typeof body === 'string' ? body : JSON.stringify(body)) }
}

/** The ATM CE/PE closes Black-76 gives at `vol`, off forward `f`, `days` to expiry. */
function atmAt(f: number, k: number, days: number, vol: number): { strike: number; ce: number; pe: number } {
  const t = days / 365
  return {
    strike: k,
    ce: Math.round(b76Price({ future: f, strike: k, t, vol, rate: DEFAULT_RATE, type: 'CE' }) * 100) / 100,
    pe: Math.round(b76Price({ future: f, strike: k, t, vol, rate: DEFAULT_RATE, type: 'PE' }) * 100) / 100,
  }
}

function tcs(day: string, c: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    o: c - 10, h: c + 15, l: c - 20, c, v: 1000,
    fut: { expiry: '2026-10-27', c: c + 2, oi: 5000 },
    opt: {
      expiry: '2026-10-27', ceOi: 650, peOi: 600, atm: atmAt(c + 2, 2500, Date.parse('2026-10-27') / 86_400_000 - Date.parse(day) / 86_400_000, 0.25),
      walls: { ce: [[2600, 300], [2500, 200]], pe: [[2400, 300]] }, maxPain: 2500,
    },
    ...extra,
  }
}

test('bars: every day of a stock, oldest → newest, at most n; an unknown stock has none', async (t) => {
  const f = folder(t)
  f.write('2026-10-21', { date: '2026-10-21', symbols: { TCS: tcs('2026-10-21', 2490) } })
  f.write('2026-10-22', { date: '2026-10-22', symbols: { TCS: tcs('2026-10-22', 2506.9), INFY: { ...tcs('2026-10-22', 1500), opt: null, fut: null } } })
  f.write('2026-10-20', { date: '2026-10-20', symbols: { INFY: { ...tcs('2026-10-20', 1490), opt: null, fut: null } } })
  const h = new HistoryStore({ dir: f.root })
  await h.refresh()
  const bars = h.bars('TCS', 400)
  assert.deepEqual(bars.map((b) => [b.date, b.close]), [['2026-10-21', 2490], ['2026-10-22', 2506.9]])
  const b = bars[1]!
  assert.deepEqual([b.open, b.high, b.low, b.volume, b.futClose, b.futOi, b.ceOi, b.peOi, b.maxPain, b.src],
    [2496.9, 2521.9, 2486.9, 1000, 2508.9, 5000, 650, 600, 2500, 'cash'])
  assert.ok(Math.abs((b.atmIv as number) - 0.25) < 5e-4, `${b.atmIv}`)
  assert.deepEqual(h.bars('TCS', 1).map((x) => x.date), ['2026-10-22'])
  assert.deepEqual(h.bars('INFY', 400).map((x) => [x.date, x.futClose, x.atmIv, x.ceOi]), [['2026-10-20', null, null, null], ['2026-10-22', null, null, null]])
  assert.deepEqual(h.bars('NOPE', 400), [])
  assert.deepEqual(h.bars('TCS', 0), [])
  const last = h.latest('TCS')
  assert.equal(last?.date, '2026-10-22')
  assert.deepEqual(last?.opt?.walls, { ce: [[2600, 300], [2500, 200]], pe: [[2400, 300]] })
  assert.equal(h.latest('NOPE'), null)
  assert.deepEqual(h.status(), { days: 3, first: '2026-10-20', last: '2026-10-22', problems: [] })
})

test('ATM IV: off the future when it is the option expiry, else off parity; null when a side has no close', () => {
  const day = '2026-10-22'
  // a stock: the future is the option month's
  const stock = atmIvOf(day, { expiry: '2026-10-27', close: 2505.2 }, { expiry: '2026-10-27', atm: atmAt(2505.2, 2500, 5, 0.3) })
  assert.ok(Math.abs((stock as number) - 0.3) < 5e-4, `${stock}`)
  // an index weekly: the future is the month's, so the weekly's forward is K + (C − P)·e^{rt}
  const weekly = atmAt(22690, 22700, 1, 0.12)
  const idx = atmIvOf(day, { expiry: '2026-10-27', close: 22711.3 }, { expiry: '2026-10-23', atm: weekly })
  assert.ok(Math.abs((idx as number) - 0.12) < 2e-3, `${idx}`)
  assert.equal(atmIvOf(day, { expiry: '2026-10-27', close: 2505.2 }, { expiry: '2026-10-27', atm: { strike: 2500, ce: 30.1, pe: null } }), null)
  assert.equal(atmIvOf(day, null, { expiry: '2026-10-27', atm: { strike: 2500, ce: 30.1, pe: 25.9 } }) === null, false, 'no future: parity')
  assert.equal(atmIvOf(day, { expiry: '2026-10-27', close: 2505.2 }, { expiry: '2026-10-27', atm: null }), null)
  // an expiry on the day itself has no time left
  assert.equal(atmIvOf(day, { expiry: day, close: 2505.2 }, { expiry: day, atm: atmAt(2505.2, 2500, 5, 0.3) }), null)
  // a premium no vol can reach
  assert.equal(atmIvOf(day, { expiry: '2026-10-27', close: 2505.2 }, { expiry: '2026-10-27', atm: { strike: 2500, ce: 2000, pe: 2000 } }), null)
})

test('a corrupt file is skipped with a warning; the rest load', async (t) => {
  const f = folder(t)
  f.write('2026-10-21', '{"date": "2026-10-21", "symbols": {"TCS": ')
  f.write('2026-10-22', { date: '2026-10-22', symbols: { TCS: tcs('2026-10-22', 2506.9) } })
  f.write('2026-10-23', { date: '2026-10-20', symbols: {} })
  f.write('2026-10-19', { date: '2026-10-19', symbols: { TCS: { o: 'x', h: 1, l: 1, c: 1, v: 1 }, 'BAD;SYM': tcs('2026-10-19', 1), INFY: { ...tcs('2026-10-19', 1500), fut: { expiry: 'soon', c: -1 } } } })
  writeFileSync(join(f.root, 'history', 'notes.txt'), 'not a day')
  const logged: { msg: string; ctx: Record<string, unknown> | undefined }[] = []
  const h = new HistoryStore({ dir: f.root, log: (msg, ctx) => logged.push({ msg, ctx }) })
  await h.refresh()
  assert.deepEqual(h.bars('TCS', 10).map((b) => b.date), ['2026-10-22'], 'the bad TCS row of the 19th is left out')
  assert.deepEqual(h.bars('INFY', 10).map((b) => [b.date, b.futClose]), [['2026-10-19', null]], 'a bad future is no future, the bar stays')
  const problems = h.status().problems
  assert.equal(problems.length, 2, problems.join('\n'))
  assert.match(problems[0]!, /^2026-10-21\.json: /)
  assert.equal(problems[1], '2026-10-23.json: the file says it is 2026-10-20')
  assert.deepEqual(logged.map((l) => [l.msg, l.ctx?.['file']]), [['history file skipped', '2026-10-21.json'], ['history file skipped', '2026-10-23.json']])
  // the same bad file is not read (nor logged) again; fixed, it is
  await h.refresh()
  assert.equal(logged.length, 2)
  f.write('2026-10-21', { date: '2026-10-21', symbols: { TCS: tcs('2026-10-21', 2490) } })
  await h.refresh()
  assert.deepEqual(h.bars('TCS', 10).map((b) => b.date), ['2026-10-21', '2026-10-22'])
  assert.equal(h.status().problems.length, 1)
})

test('new files are read on the next refresh; at most maxDays days are held', async (t) => {
  const f = folder(t)
  const h = new HistoryStore({ dir: f.root, maxDays: 3 })
  await h.refresh()
  assert.deepEqual(h.status(), { days: 0, first: null, last: null, problems: [] })
  for (const d of ['2026-10-15', '2026-10-16', '2026-10-19', '2026-10-20']) f.write(d, { date: d, symbols: { TCS: tcs(d, 2500) } })
  await h.refresh()
  assert.deepEqual(h.bars('TCS', 400).map((b) => b.date), ['2026-10-16', '2026-10-19', '2026-10-20'])
  f.write('2026-10-21', { date: '2026-10-21', symbols: { TCS: tcs('2026-10-21', 2510) } })
  await h.refresh()
  assert.deepEqual(h.bars('TCS', 400).map((b) => b.date), ['2026-10-19', '2026-10-20', '2026-10-21'])
  assert.equal(h.latest('TCS')?.date, '2026-10-21')
})

test('only the newest ten days keep their OI summaries; older days keep their bars', async (t) => {
  const f = folder(t)
  const days = Array.from({ length: 12 }, (_, i) => new Date(Date.UTC(2026, 9, 1 + i)).toISOString().slice(0, 10))
  // INFY is listed on the first day only, TCS every day
  days.forEach((d, i) => f.write(d, { date: d, symbols: { TCS: tcs(d, 2500 + i), ...(i === 0 ? { INFY: tcs(d, 1500) } : {}) } }))
  const h = new HistoryStore({ dir: f.root })
  await h.refresh()
  assert.equal(h.bars('INFY', 400).length, 1)
  assert.equal(h.latest('INFY'), null, 'its one summary is older than the newest ten days')
  assert.equal(h.latest('TCS')?.date, days.at(-1))
})

test('no history folder: nothing, and no throw', async () => {
  const h = new HistoryStore({ dir: join(tmpdir(), 'algomaker-traders-test-no-nse-history') })
  await h.refresh()
  assert.deepEqual(h.bars('TCS', 10), [])
  assert.deepEqual(h.status(), { days: 0, first: null, last: null, problems: [] })
})

test('an index day carries src fut', async (t) => {
  const f = folder(t)
  f.write('2026-10-22', { date: '2026-10-22', symbols: { NIFTY: { ...tcs('2026-10-22', 22711.3), src: 'fut' } } })
  const h = new HistoryStore({ dir: f.root })
  await h.refresh()
  assert.equal(h.bars('NIFTY', 1)[0]?.src, 'fut')
  assert.equal(h.latest('NIFTY')?.src, 'fut')
})

test('settlement closes: a cash bar\'s close, an index\'s own close (ic) or none, raw, and the version settlement reads', async (t) => {
  const f = folder(t)
  const h = new HistoryStore({ dir: f.root })
  await h.refresh()
  const v0 = h.version()
  assert.deepEqual(h.closeDays(), { days: 0, first: null })
  f.write('2026-09-29', { date: '2026-09-29', symbols: { TCS: tcs('2026-09-29', 2032.4), NIFTY: { ...tcs('2026-09-29', 22865.7), src: 'fut' }, BANKNIFTY: { ...tcs('2026-09-29', 54897.4), src: 'fut', ic: 54500.1 } } })
  f.write('2026-09-30', { date: '2026-09-30', symbols: { TCS: tcs('2026-09-30', 2050, { pc: 1016.2 }) } })
  await h.refresh()
  assert.ok(h.version() > v0)
  // raw, not back-adjusted: the 30th's previous close halves the older bars, never this close
  assert.equal(h.close('TCS', '2026-09-29'), 2032.4)
  assert.equal(h.bars('TCS', 2)[0]?.close, 1016.2)
  assert.equal(h.close('NIFTY', '2026-09-29'), null)   // its bar is the near future's: nothing to settle at
  assert.equal(h.close('BANKNIFTY', '2026-09-29'), 54500.1)
  assert.equal(h.close('INFY', '2026-09-29'), undefined)
  assert.equal(h.hasCloses('2026-09-29'), true)
  assert.equal(h.hasCloses('2026-09-28'), false)
  assert.deepEqual(h.closeDays(), { days: 2, first: '2026-09-29' })
  // an unchanged folder is no new version; a rewritten day is
  const v1 = h.version()
  await h.refresh()
  assert.equal(h.version(), v1)
  f.write('2026-09-29', { date: '2026-09-29', symbols: { TCS: tcs('2026-09-29', 2032.45) } })
  await h.refresh()
  assert.ok(h.version() > v1)
  assert.equal(h.close('TCS', '2026-09-29'), 2032.45)
})

test('closes are kept for every file on disk, past the bars\' window; a file gone from disk drops its close', async (t) => {
  const f = folder(t)
  const h = new HistoryStore({ dir: f.root, maxDays: 2 })
  const days = ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01']
  days.forEach((d, i) => f.write(d, { date: d, symbols: { TCS: tcs(d, 2000 + i) } }))
  f.write('2026-09-25', 'not json')
  await h.refresh()
  assert.deepEqual(h.bars('TCS', 400).map((b) => b.date), ['2026-09-30', '2026-10-01'])
  assert.deepEqual(days.map((d) => h.close('TCS', d)), [2000, 2001, 2002, 2003])
  assert.deepEqual(h.closeDays(), { days: 4, first: '2026-09-28' })
  assert.equal(h.status().problems.length, 1)   // the bad old file is named, and its day has no close
  assert.equal(h.hasCloses('2026-09-25'), false)
  // a newer day pushes one more out of the window: its close stays
  const v = h.version()
  f.write('2026-10-05', { date: '2026-10-05', symbols: { TCS: tcs('2026-10-05', 2010) } })
  await h.refresh()
  assert.equal(h.close('TCS', '2026-09-30'), 2002)
  assert.ok(h.version() > v)
  rmSync(join(f.root, 'history', '2026-09-28.json'))
  await h.refresh()
  assert.equal(h.hasCloses('2026-09-28'), false)
})

test('the ranked IV is the fixed tenor\'s (ivAtm, the first expiry a week or more out); an older file keeps the nearest expiry\'s', async (t) => {
  const f = folder(t)
  const nov = { expiry: '2026-11-23', ...atmAt(2521, 2520, 32, 0.28), fut: 2521 }
  f.write('2026-10-22', { date: '2026-10-22', symbols: {
    TCS: tcs('2026-10-22', 2506.9, { ivAtm: nov }),
    INFY: tcs('2026-10-22', 1500, { ivAtm: { ...nov, pe: null } }),
    SBIN: tcs('2026-10-22', 2506.9),
  } })
  const h = new HistoryStore({ dir: f.root })
  await h.refresh()
  assert.ok(Math.abs((h.bars('TCS', 1)[0]!.atmIv as number) - 0.28) < 5e-4, 'November\'s 28%, not the 5-day October 25%')
  assert.equal(h.bars('INFY', 1)[0]!.atmIv, null, 'an unsolvable tenor IV is none, not the nearest expiry\'s')
  assert.ok(Math.abs((h.bars('SBIN', 1)[0]!.atmIv as number) - 0.25) < 5e-4, 'no ivAtm in the file: the nearest expiry\'s')
})

/** A plain day of `stock` at close `c` with NSE's previous close `pc`. */
const plain = (c: number, pc?: number, extra: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ o: c, h: c + 1, l: c - 1, c, v: 1000, fut: null, opt: null, ...(pc === undefined ? {} : { pc }), ...extra })

test('a 1:1 bonus: the older bars are halved from the ex-date back, said once, so HV sees no 69% gap', async (t) => {
  const f = folder(t)
  f.write('2026-10-15', { date: '2026-10-15', symbols: { TCS: plain(2500, 2490) } })
  f.write('2026-10-16', { date: '2026-10-16', symbols: { TCS: plain(2520, 2500) } })
  f.write('2026-10-19', { date: '2026-10-19', symbols: { TCS: plain(1265, 1260) } })   // ex-date: NSE's pc is 2520 / 2
  f.write('2026-10-20', { date: '2026-10-20', symbols: { TCS: plain(1270, 1265) } })
  const h = new HistoryStore({ dir: f.root })
  await h.refresh()
  const bars = h.bars('TCS', 10)
  assert.deepEqual(bars.map((b) => b.close), [1250, 1260, 1265, 1270])
  assert.deepEqual([bars[0]!.open, bars[0]!.high, bars[0]!.volume], [1250, 1250.5, 2000])
  assert.deepEqual(h.adjustments('TCS', 10), [{ date: '2026-10-19', ratio: 0.5, kind: 'corporate' }])
})

test('a gap is closed when every weekday in it is a known holiday (2025 included) or recorded unpublished, else missing', async (t) => {
  assert.equal(isNseTradingDay('2025-12-25'), false, 'NSE\'s 2025 holidays are in the traders calendar')
  assert.equal(isNseTradingDay('2025-12-24'), true)
  assert.equal(consecutiveDays('2025-12-24', '2025-12-26'), true, 'Christmas 2025 between them')
  assert.equal(consecutiveDays('2027-01-05', '2027-01-07'), false, 'a 2027 weekday the calendar does not know is missing')
  assert.equal(consecutiveDays('2027-01-05', '2027-01-07', new Set(['2027-01-06'])), true, 'unless the backfill recorded it')
  const f = folder(t)
  f.write('2025-12-24', { date: '2025-12-24', symbols: { TCS: plain(3000) } })
  f.write('2025-12-26', { date: '2025-12-26', symbols: { TCS: plain(1520, 1500) } })   // a 1:1 bonus across Christmas
  f.write('2027-01-05', { date: '2027-01-05', symbols: { TCS: plain(1600) } })
  f.write('2027-01-07', { date: '2027-01-07', symbols: { TCS: plain(820, 800) } })     // a split across an unknown weekday
  const h = new HistoryStore({ dir: f.root })
  await h.refresh()
  assert.deepEqual(h.adjustments('TCS', 10).map((a) => a.date), ['2025-12-26'], '2027-01-06 is not known closed: no adjustment')
  writeFileSync(join(f.root, 'history', 'unpublished.json'), JSON.stringify({ days: ['2027-01-06'] }))
  await h.refresh()
  assert.deepEqual(h.adjustments('TCS', 10).map((a) => a.date), ['2025-12-26', '2027-01-07'])
  assert.deepEqual(h.bars('TCS', 10).map((b) => b.close), [750, 760, 800, 820])
})

test('no adjustment across a missing day, or for a previous close within 1%', async (t) => {
  const f = folder(t)
  f.write('2026-10-14', { date: '2026-10-14', symbols: { TCS: plain(2500) } })
  // 15 Oct is missing: the 16th's pc (the 15th's close) says nothing about the 14th's
  f.write('2026-10-16', { date: '2026-10-16', symbols: { TCS: plain(2600, 2560) } })
  f.write('2026-10-19', { date: '2026-10-19', symbols: { TCS: plain(2610, 2595) } })   // 0.2% off: rounding, not an action
  const h = new HistoryStore({ dir: f.root })
  await h.refresh()
  assert.deepEqual(h.bars('TCS', 10).map((b) => b.close), [2500, 2600, 2610])
  assert.deepEqual(h.adjustments('TCS', 10), [])
})

test('an index\'s bars move to the next future at its expiry: chained off the new contract\'s own previous close', async (t) => {
  const f = folder(t)
  const fut = (expiry: string, c: number) => ({ expiry, c, oi: 1 })
  f.write('2026-10-26', { date: '2026-10-26', symbols: { NIFTY: plain(22600, 22500, { src: 'fut', fut: fut('2026-10-27', 22600) }) } })
  f.write('2026-10-27', { date: '2026-10-27', symbols: { NIFTY: plain(22700, 22650, { src: 'fut', fut: fut('2026-10-27', 22700) }) } })
  // the 27 Oct contract expired: the 28th's bar is November's, whose own close on the 27th was 22830
  f.write('2026-10-28', { date: '2026-10-28', symbols: { NIFTY: plain(22900, 22830, { src: 'fut', fut: fut('2026-11-24', 22900) }) } })
  const h = new HistoryStore({ dir: f.root })
  await h.refresh()
  const r = 22830 / 22700
  const closes = h.bars('NIFTY', 10).map((b) => b.close)
  assert.ok(Math.abs((closes[0] as number) - 22600 * r) < 1e-9 && Math.abs((closes[1] as number) - 22830) < 1e-9, closes.join(' '))
  assert.equal(closes[2], 22900)
  assert.deepEqual(h.adjustments('NIFTY', 10).map((a) => [a.date, a.kind]), [['2026-10-28', 'roll']])
})
