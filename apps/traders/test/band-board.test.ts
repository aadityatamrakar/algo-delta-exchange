import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { BandEvent, BandStatus } from '../src/analytics/band.ts'
import { BandBoard } from '../src/analytics/band-board.ts'
import type { BandState } from '../src/types.ts'

const at = (day: string, hhmm: string): number => Date.parse(`${day}T${hhmm}:00+05:30`)
const MON = '2026-10-19'

function status(state: BandState): BandStatus {
  const known = state !== 'unknown'
  return {
    state, netDelta: known ? -125 : null, bandShares: known ? 120 : null, bandLots: known ? 4.8 : null,
    outByLots: state === 'out' ? 1 : 0, lotSize: 25, source: 'engine', toNeutralize: null, marketOpen: true, sentence: state,
  }
}

/** A reading of the last prices with the market closed, as the band gives it from 15:40. */
function closed(state: BandState): BandStatus {
  return { ...status(state), marketOpen: false, sentence: `${state} (market closed)` }
}

/** A BookRisk whose answers are scripted per book, one per call; a book with no script left has no open book (null). */
function scripted(script: Record<string, (BandState | BandStatus)[]>) {
  const calls: string[] = []
  return {
    calls,
    band: async (trader: string, stock: string): Promise<BandStatus | null> => {
      calls.push(`${trader}|${stock}`)
      const next = script[`${trader}|${stock}`]?.shift()
      return next === undefined ? null : typeof next === 'string' ? status(next) : next
    },
  }
}

function memoryEvents(prior: BandEvent[] = []) {
  const added: BandEvent[] = []
  return {
    added,
    add: async (e: BandEvent): Promise<void> => { added.push(e) },
    lastBand: async (): Promise<BandEvent[]> => prior,
  }
}

function board(script: Record<string, (BandState | BandStatus)[]>, o: { prior?: BandEvent[]; books?: { trader: string; stock: string }[]; log?: (m: string) => void } = {}) {
  const risk = scripted(script)
  const events = memoryEvents(o.prior)
  const books = o.books ?? Object.keys(script).map((k) => ({ trader: k.split('|')[0] as string, stock: k.split('|')[1] as string }))
  const b = new BandBoard({ risk, events, legs: { openBooks: async () => books }, now: () => at(MON, '10:00'), ...(o.log === undefined ? {} : { log: o.log }) })
  return { b, risk, events }
}

test('in → out → in writes two events', async () => {
  const { b, events } = board({ 'ravi|TCS': ['in', 'out', 'in'] })
  await b.load()
  assert.equal(await b.tick(at(MON, '10:00')), 0)
  assert.equal(b.state('ravi', 'TCS'), 'in')
  assert.equal(await b.tick(at(MON, '10:01')), 1)
  assert.equal(b.state('ravi', 'TCS'), 'out')
  assert.equal(await b.tick(at(MON, '10:02')), 1)
  assert.deepEqual(events.added.map((e) => ({ from: e.from, to: e.to })), [{ from: 'in', to: 'out' }, { from: 'out', to: 'in' }])
  assert.deepEqual(events.added[0], {
    trader: 'ravi', stock: 'TCS', kind: 'band', from: 'in', to: 'out', at: at(MON, '10:01'),
    netDelta: -125, bandShares: 120, lotSize: 25, outByLots: 1, source: 'engine',
  })
})

test('a new book that starts out writes in → out', async () => {
  const { b, events } = board({ 'ravi|TCS': ['out', 'out'], 'sita|NIFTY': ['in', 'in'] })
  await b.load()
  assert.equal(await b.tick(at(MON, '10:00')), 1)
  assert.equal(await b.tick(at(MON, '10:01')), 0)
  assert.deepEqual(events.added.map((e) => [e.trader, e.stock, e.from, e.to]), [['ravi', 'TCS', 'in', 'out']])
  assert.equal(b.state('sita', 'NIFTY'), 'in')
  assert.equal(b.state('sita', 'TCS'), null)
})

test('unknown writes nothing and keeps the last state', async () => {
  const { b, events } = board({ 'ravi|TCS': ['out', 'unknown', 'out', 'unknown', 'in'] })
  await b.load()
  await b.tick(at(MON, '10:00'))
  await b.tick(at(MON, '10:01'))
  assert.equal(b.state('ravi', 'TCS'), 'unknown')   // what the books list shows
  await b.tick(at(MON, '10:02'))                    // out again: the last state is still out, so no event
  await b.tick(at(MON, '10:03'))
  await b.tick(at(MON, '10:04'))
  assert.deepEqual(events.added.map((e) => [e.from, e.to, e.at]), [['in', 'out', at(MON, '10:00')], ['out', 'in', at(MON, '10:04')]])
})

test('load() restores the last state, so a restart writes no duplicate', async () => {
  const prior: BandEvent[] = [{
    trader: 'ravi', stock: 'TCS', kind: 'band', from: 'in', to: 'out', at: at(MON, '09:40'),
    netDelta: -125, bandShares: 120, lotSize: 25, outByLots: 1, source: 'engine',
  }]
  const { b, events } = board({ 'ravi|TCS': ['out', 'in'] }, { prior })
  await b.load()
  assert.equal(b.state('ravi', 'TCS'), null)   // nothing evaluated since the restart
  assert.equal(await b.tick(at(MON, '10:00')), 0)
  assert.equal(await b.tick(at(MON, '10:01')), 1)
  assert.deepEqual(events.added.map((e) => [e.from, e.to]), [['out', 'in']])
})

test('no event outside the session', async () => {
  const { b, risk, events } = board({ 'ravi|TCS': ['out', 'out', 'out', 'out'] })
  await b.load()
  for (const when of [at(MON, '09:16'), at(MON, '09:19'), at(MON, '15:41'), at('2026-10-24', '10:00'), at('2026-10-20', '10:00')]) {
    assert.equal(await b.tick(when), 0)
  }
  assert.deepEqual(risk.calls, [], 'a closed session evaluates nothing')
  assert.deepEqual(events.added, [])
  // 09:20 and 15:40 are inside
  assert.equal(await b.tick(at(MON, '09:20')), 1)
  assert.equal(await b.tick(at(MON, '15:40')), 0)
  assert.equal(risk.calls.length, 2)
})

test('a reading with the market closed writes nothing and keeps the last state: at 15:40 the band reads closed (R3 final fix, Review Focus 4)', async () => {
  const { b, risk, events } = board({ 'ravi|TCS': ['out', closed('in'), 'out'] })
  await b.load()
  assert.equal(await b.tick(at(MON, '15:39')), 1)                // in → out
  assert.equal(await b.tick(at(MON, '15:40')), 0)                // reads in, '(market closed)': no event
  assert.equal(b.state('ravi', 'TCS'), 'in')                     // what the books list shows
  assert.equal(await b.tick(at('2026-10-21', '09:20')), 0)       // out again next session: the last state is still out
  assert.equal(risk.calls.length, 3)
  assert.deepEqual(events.added.map((e) => [e.from, e.to, e.at]), [['in', 'out', at(MON, '15:39')]])
})

test('a book that throws is logged and the others still tick; a failed write is retried next minute', async () => {
  const logs: string[] = []
  const risk = scripted({ 'ravi|TCS': ['out', 'out'] })
  const added: BandEvent[] = []
  let failWrite = true
  const flaky = new BandBoard({
    risk: { band: async (trader, stock) => { if (trader === 'sita') throw new Error('mongo went away'); return await risk.band(trader, stock) } },
    events: { add: async (e) => { if (failWrite) { failWrite = false; throw new Error('write failed') } added.push(e) }, lastBand: async () => [] },
    legs: { openBooks: async () => [{ trader: 'ravi', stock: 'TCS' }, { trader: 'sita', stock: 'NIFTY' }] },
    now: () => at(MON, '10:00'), log: (m) => logs.push(m),
  })
  await flaky.load()
  assert.equal(await flaky.tick(at(MON, '10:00')), 0)
  assert.equal(logs.length, 2)
  assert.equal(flaky.state('ravi', 'TCS'), 'out')
  assert.equal(await flaky.tick(at(MON, '10:01')), 1)
  assert.deepEqual(added.map((e) => [e.trader, e.from, e.to, e.at]), [['ravi', 'in', 'out', at(MON, '10:01')]])
  assert.equal(logs.length, 3)   // sita again
})

test('a book that closed drops off the board', async () => {
  const { b } = board({ 'ravi|TCS': ['in'] })
  await b.tick(at(MON, '10:00'))
  assert.equal(b.state('ravi', 'TCS'), 'in')
  await b.tick(at(MON, '10:01'))   // no open book any more
  assert.equal(b.state('ravi', 'TCS'), null)
})

test('start() ticks once a minute off its clock; stop() ends it', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  let ticks = 0
  const b = new BandBoard({
    risk: { band: async () => { ticks++; return status('in') } },
    events: memoryEvents(),
    legs: { openBooks: async () => [{ trader: 'ravi', stock: 'TCS' }] },
    now: () => at(MON, '10:00'),
  })
  b.start()
  b.start()   // a second start is a no-op, not a second loop
  t.mock.timers.tick(59_999)
  await new Promise(setImmediate)
  assert.equal(ticks, 0)
  t.mock.timers.tick(1)
  for (let i = 0; i < 5; i++) await new Promise(setImmediate)
  assert.equal(ticks, 1)
  b.stop()
  t.mock.timers.tick(120_000)
  for (let i = 0; i < 5; i++) await new Promise(setImmediate)
  assert.equal(ticks, 1)
  b.stop()   // idempotent
})
