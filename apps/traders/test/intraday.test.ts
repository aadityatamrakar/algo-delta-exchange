import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'
import { spotTokenOf } from '../src/market/master.ts'
import { IntradayBars } from '../src/market/intraday.ts'
import { fakeQuotes, r3Master } from './fixtures/r3-market.ts'

const M = r3Master()
const SPOT = spotTokenOf(M, 'TCS') as number
const OCT_FUT = M.options.future('TCS', '2026-10-27')?.instrumentToken as number
/** Monday 19 Oct 2026, 09:15 IST. */
const OPEN = Date.parse('2026-10-19T09:15:00+05:30')
const S = 1000
const MIN = 60_000

function rig(): { q: ReturnType<typeof fakeQuotes>; ib: IntradayBars; tick(token: number, price: number, at: number, volume?: number | null): void } {
  const q = fakeQuotes()
  const ib = new IntradayBars({ master: () => M, quotes: q, now: () => OPEN })
  return {
    q, ib,
    tick(token, price, at, volume = null) {
      q.set(token, { price, asOf: at, volume })
      ib.sample(at + 500)
    },
  }
}

test('5-minute bars from sampled ticks: OHLC by tick time, volume from the cumulative day volume', () => {
  const { ib, tick } = rig()
  ib.sample(OPEN - 10 * MIN)   // sampling began before the open
  tick(SPOT, 3400, OPEN + 10 * S, 1000)
  tick(SPOT, 3410, OPEN + 2 * MIN, 1500)
  tick(SPOT, 3390, OPEN + 5 * MIN - S, 1800)   // 09:19:59, still the first bar
  ib.sample(OPEN + 5 * MIN)                     // no new tick: nothing changes
  tick(SPOT, 3420, OPEN + 5 * MIN + 5 * S, 2000) // 09:20:05, the second bar
  assert.deepEqual(ib.bars('TCS', '5m'), [
    { t: OPEN, o: 3400, h: 3410, l: 3390, c: 3390, v: 800 },
    { t: OPEN + 5 * MIN, o: 3420, h: 3420, l: 3420, c: 3420, v: 200 },
  ])
  assert.deepEqual(ib.bars('TCS', '15m'), [{ t: OPEN, o: 3400, h: 3420, l: 3390, c: 3420, v: 1000 }])
  assert.deepEqual(ib.bars('TCS', '5m', 'future'), [], 'the future has not ticked')
  assert.deepEqual(ib.coverage(), { day: '2026-10-19', since: OPEN - 10 * MIN })
  assert.deepEqual(ib.bars('INFY', '5m'), [])
})

test('the near future is its own series; no volume is volume 0; ticks outside the session are not bars', () => {
  const { q, ib, tick } = rig()
  tick(OCT_FUT, 3412.5, OPEN - 5 * MIN)           // 09:10, pre-open: not a bar
  tick(OCT_FUT, 3415, OPEN + 16 * MIN)            // 09:31
  tick(OCT_FUT, 3411, OPEN + 17 * MIN)
  assert.deepEqual(ib.bars('TCS', '5m', 'future'), [{ t: OPEN + 15 * MIN, o: 3415, h: 3415, l: 3411, c: 3411, v: 0 }])
  assert.deepEqual(ib.bars('TCS', '15m', 'future'), [{ t: OPEN + 15 * MIN, o: 3415, h: 3415, l: 3411, c: 3411, v: 0 }])
  // a quote from the stored snapshot of an earlier day is not today's
  q.set(SPOT, { price: 3300, asOf: OPEN - 24 * 60 * MIN })
  ib.sample(OPEN + 18 * MIN)
  assert.deepEqual(ib.bars('TCS', '5m'), [])
  // after the 15:40 close nothing is added
  tick(OCT_FUT, 3500, Date.parse('2026-10-19T15:41:00+05:30'))
  assert.equal(ib.bars('TCS', '5m', 'future').length, 1)
})

test('a new IST day starts empty', () => {
  const { ib, tick } = rig()
  tick(SPOT, 3400, OPEN + MIN, 10)
  assert.equal(ib.bars('TCS', '5m').length, 1)
  const wednesday = OPEN + 2 * 24 * 60 * MIN   // Tuesday the 20th is Dussehra
  ib.sample(wednesday - 20 * MIN)   // 08:55 Wednesday
  assert.deepEqual(ib.bars('TCS', '5m'), [])
  assert.deepEqual(ib.coverage(), { day: '2026-10-21', since: wednesday - 20 * MIN })
  tick(SPOT, 3450, wednesday + 2 * MIN, 50)
  assert.deepEqual(ib.bars('TCS', '5m'), [{ t: wednesday, o: 3450, h: 3450, l: 3450, c: 3450, v: 0 }])
})

test('the sampler runs on its timer until stopped, and a failing master does not throw out of it', async () => {
  const q = fakeQuotes()
  let now = OPEN + MIN
  let broken = true
  const ib = new IntradayBars({
    master: () => { if (broken) throw new Error('the instrument master is not loaded yet'); return M },
    quotes: q, now: () => now, everyMs: 5,
  })
  q.set(SPOT, { price: 3400, asOf: OPEN + MIN })
  ib.start()
  ib.start()   // a second start is a no-op, not a second timer
  await sleep(30)
  assert.deepEqual(ib.bars('TCS', '5m'), [])
  broken = false
  await sleep(30)
  assert.equal(ib.bars('TCS', '5m').length, 1)
  ib.stop()
  q.set(SPOT, { price: 3500, asOf: OPEN + 6 * MIN })
  now = OPEN + 6 * MIN
  await sleep(30)
  assert.equal(ib.bars('TCS', '5m').length, 1, 'stopped: no more samples')
  ib.stop()
})
