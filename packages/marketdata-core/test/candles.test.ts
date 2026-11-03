import test from 'node:test'
import assert from 'node:assert/strict'
import { CandleStore, bucketStart, intervalMs, type Candle } from '../src/candles.ts'

/** Epoch ms for an IST wall-clock time on 2026-07-27 (a Monday). */
const ist = (h: number, m: number, s = 0): number =>
  Date.UTC(2026, 6, 27, h, m, s) - 330 * 60 * 1000

const TOKEN = 256265

const bar = (h: number, m: number, o: number, hi: number, lo: number, c: number): Candle => ({
  ts: ist(h, m),
  open: o,
  high: hi,
  low: lo,
  close: c,
})

// --- bucketing: IST wall clock ----------------------------------------------

test('buckets are anchored to the 09:15 SESSION OPEN, not to midnight', () => {
  // Kite's own historical candles are session-anchored, and atr-band-nifty.js:113
  // relies on it: "Freeze the ATR at the 09:15-10:15 hourly candle (start ts
  // 09:15)". Anchoring hourly bars to midnight would give 09:00-10:00, so a
  // series seeded from Kite history and one advanced from live ticks would
  // disagree about where every hourly bar begins — and ATR-14 over them would
  // quietly differ from the value the legacy strategy trades on.
  assert.equal(bucketStart(ist(9, 17, 43), '60minute'), ist(9, 15))
  assert.equal(bucketStart(ist(10, 14, 0), '60minute'), ist(9, 15))
  assert.equal(bucketStart(ist(10, 16, 0), '60minute'), ist(10, 15), 'the 10:15 bar')
  assert.equal(bucketStart(ist(14, 45, 0), '60minute'), ist(14, 15))

  // Intervals that divide the session start evenly are indistinguishable from
  // wall-clock alignment, which is why this only shows up at 60minute.
  assert.equal(bucketStart(ist(9, 17, 43), '5minute'), ist(9, 15))
  assert.equal(bucketStart(ist(9, 17, 43), '15minute'), ist(9, 15))
  assert.equal(bucketStart(ist(9, 17, 43), '3minute'), ist(9, 15))

  // Flooring in UTC would land the hourly boundary at :30 IST — mid-bar.
  assert.notEqual(bucketStart(ist(9, 17, 43), '60minute') % (60 * 60_000), 0)
  // A day bar still starts at IST midnight, not 05:30 IST (UTC midnight).
  assert.equal(bucketStart(ist(9, 17, 43), 'day'), ist(0, 0))
})

test('a tick exactly on a boundary belongs to the NEW bar', () => {
  assert.equal(bucketStart(ist(9, 20, 0), '5minute'), ist(9, 20))
  assert.equal(bucketStart(ist(9, 19, 59), '5minute'), ist(9, 15))
  assert.equal(intervalMs('5minute'), 5 * 60_000)
})

// --- refcounting: one series however many readers ---------------------------

test('two subscribers wanting the same series share ONE series', () => {
  const s = new CandleStore()
  const d1 = s.declare('a', [{ token: TOKEN, interval: '5minute' }])
  assert.deepEqual(d1.activated, [{ token: TOKEN, interval: '5minute' }])

  const d2 = s.declare('b', [{ token: TOKEN, interval: '5minute' }])
  assert.deepEqual(d2.activated, [], 'the second declarer must not create a second series')
  assert.equal(s.seriesCount, 1)
})

test('a series is dropped only when the LAST subscriber leaves', () => {
  const s = new CandleStore()
  s.declare('a', [{ token: TOKEN, interval: '5minute' }])
  s.declare('b', [{ token: TOKEN, interval: '5minute' }])

  assert.deepEqual(s.remove('a').deactivated, [], 'one holder left')
  assert.deepEqual(s.remove('b').deactivated, [{ token: TOKEN, interval: '5minute' }])
  assert.equal(s.seriesCount, 0)
  assert.equal(s.isActive(TOKEN, '5minute'), false)
})

test('re-declaring the same set is a no-op; a narrower set deactivates', () => {
  const s = new CandleStore()
  s.declare('a', [
    { token: TOKEN, interval: '5minute' },
    { token: TOKEN, interval: '60minute' },
  ])
  assert.deepEqual(
    s.declare('a', [
      { token: TOKEN, interval: '5minute' },
      { token: TOKEN, interval: '60minute' },
    ]),
    { activated: [], deactivated: [] },
    're-declaring on restart must not churn the seed',
  )
  const narrowed = s.declare('a', [{ token: TOKEN, interval: '5minute' }])
  assert.deepEqual(narrowed.deactivated, [{ token: TOKEN, interval: '60minute' }])
  assert.equal(s.seriesCount, 1)
})

// --- (1) aggregate once per tick per series, not once per reader -------------

test('a bar advances ONCE per tick however many readers there are', () => {
  const s = new CandleStore()
  s.declare('a', [{ token: TOKEN, interval: '5minute' }])
  s.declare('b', [{ token: TOKEN, interval: '5minute' }])
  s.declare('c', [{ token: TOKEN, interval: '5minute' }])

  s.onTick(TOKEN, 100, ist(9, 16))
  s.onTick(TOKEN, 105, ist(9, 17))
  s.onTick(TOKEN, 95, ist(9, 18))
  s.onTick(TOKEN, 102, ist(9, 19))
  // Reading three times must not move anything.
  s.candles(TOKEN, '5minute', 10)
  s.candles(TOKEN, '5minute', 10)
  s.onTick(TOKEN, 110, ist(9, 20)) // closes the 09:15 bar

  const out = s.candles(TOKEN, '5minute', 10)
  assert.equal(out.length, 1)
  assert.deepEqual(out[0], { ts: ist(9, 15), open: 100, high: 105, low: 95, close: 102 })
})

test('one tick advances EVERY interval registered on the token', () => {
  const s = new CandleStore()
  s.declare('a', [
    { token: TOKEN, interval: '5minute' },
    { token: TOKEN, interval: '60minute' },
  ])
  // The last tick is past 10:15 deliberately: with SESSION anchoring the hourly
  // bar runs 09:15-10:15, so a 10:01 tick is still inside it and closes nothing.
  for (const [h, m, p] of [
    [9, 16, 100],
    [9, 21, 110],
    [9, 26, 90],
    [10, 1, 105],
    [10, 16, 102],
  ] as const) {
    s.onTick(TOKEN, p, ist(h, m))
  }
  // 5-minute: 09:15, 09:20, 09:25, 10:00 closed (10:15 forming).
  assert.deepEqual(
    s.candles(TOKEN, '5minute', 10).map((c) => c.ts),
    [ist(9, 15), ist(9, 20), ist(9, 25), ist(10, 0)],
  )
  // 60-minute: the same ticks produced ONE closed 09:15 bar carrying the high
  // and low of everything inside it — advanced by the same tick stream, once.
  const hourly = s.candles(TOKEN, '60minute', 10)
  assert.equal(hourly.length, 1)
  assert.deepEqual(hourly[0], { ts: ist(9, 15), open: 100, high: 110, low: 90, close: 105 })
})

test('a tick for an undeclared token is ignored', () => {
  const s = new CandleStore()
  s.onTick(999, 100, ist(9, 16))
  assert.deepEqual(s.candles(999, '5minute', 10), [])
})

test('an undated or implausible tick never reaches OHLC', () => {
  const s = new CandleStore()
  s.declare('a', [{ token: TOKEN, interval: '5minute' }])
  s.onTick(TOKEN, 100) // no timestamp anywhere
  s.onTick(TOKEN, { lastPrice: 100 })
  s.onTick(TOKEN, 0, ist(9, 16))
  s.onTick(TOKEN, Number.NaN, ist(9, 16))
  assert.equal(s.formingBar(TOKEN, '5minute'), null)

  // A tick object carrying its own ts is accepted.
  s.onTick(TOKEN, { lastPrice: 100, ts: ist(9, 16) })
  assert.equal(s.formingBar(TOKEN, '5minute')?.open, 100)
})

// --- (2) immutable slice -----------------------------------------------------

test('the returned slice is frozen so one reader cannot corrupt another', () => {
  const s = new CandleStore()
  s.declare('a', [{ token: TOKEN, interval: '5minute' }])
  s.seed(TOKEN, '5minute', [bar(9, 15, 1, 2, 0.5, 1.5), bar(9, 20, 1.5, 3, 1, 2)])

  const out = s.candles(TOKEN, '5minute', 10)
  assert.throws(() => (out as Candle[]).pop(), TypeError)
  assert.throws(() => (out as Candle[]).reverse(), TypeError)
  assert.throws(() => (out as Candle[]).push(bar(9, 25, 1, 1, 1, 1)), TypeError)
  // Individual bars are frozen too — an in-place close edit is just as corrupting.
  assert.throws(() => {
    ;(out[0] as { close: number }).close = 999
  }, TypeError)

  // A second reader still sees the untouched series.
  assert.equal(s.candles(TOKEN, '5minute', 10).length, 2)
  assert.equal(s.candles(TOKEN, '5minute', 10)[0]?.close, 1.5)
})

// --- (3) only completed bars -------------------------------------------------

test('a forming bar is NEVER served by candles()', () => {
  const s = new CandleStore()
  s.declare('a', [{ token: TOKEN, interval: '5minute' }])
  s.onTick(TOKEN, 100, ist(9, 16))
  s.onTick(TOKEN, 130, ist(9, 17)) // a spike inside the forming bar

  assert.deepEqual(s.candles(TOKEN, '5minute', 10), [], 'nothing has closed yet')
  assert.equal(s.formingBar(TOKEN, '5minute')?.high, 130, 'but it IS forming')

  s.onTick(TOKEN, 101, ist(9, 20))
  const out = s.candles(TOKEN, '5minute', 10)
  assert.equal(out.length, 1)
  assert.equal(out.at(-1)?.ts, ist(9, 15), 'last bar is the CLOSED one, not the forming one')
  assert.equal(s.lastCandle(TOKEN, '5minute')?.high, 130)
})

test('count clamps to what exists and count<=0 returns empty', () => {
  const s = new CandleStore()
  s.declare('a', [{ token: TOKEN, interval: '5minute' }])
  s.seed(TOKEN, '5minute', [
    bar(9, 15, 1, 1, 1, 1),
    bar(9, 20, 2, 2, 2, 2),
    bar(9, 25, 3, 3, 3, 3),
  ])
  assert.equal(s.candles(TOKEN, '5minute', 99).length, 3)
  assert.deepEqual(
    s.candles(TOKEN, '5minute', 2).map((c) => c.close),
    [2, 3],
    'the LAST count bars, oldest -> newest',
  )
  assert.deepEqual(s.candles(TOKEN, '5minute', 0), [])
  assert.deepEqual(s.candles(TOKEN, '5minute', -1), [])
})

// --- gaps: no fabricated bars ------------------------------------------------

test('a gap with no ticks does not fabricate bars', () => {
  const s = new CandleStore()
  s.declare('a', [{ token: TOKEN, interval: '5minute' }])
  s.onTick(TOKEN, 100, ist(9, 16))
  // ...30 minutes of silence (a halted or illiquid instrument)...
  s.onTick(TOKEN, 108, ist(9, 51))
  s.onTick(TOKEN, 109, ist(9, 56))

  assert.deepEqual(
    s.candles(TOKEN, '5minute', 10).map((c) => c.ts),
    [ist(9, 15), ist(9, 50)],
    'no flat filler bars between 09:20 and 09:45',
  )
})

// --- seed + live ------------------------------------------------------------

test('seed then live ticks produce ONE continuous series', () => {
  const s = new CandleStore()
  s.declare('a', [{ token: TOKEN, interval: '5minute' }])
  assert.equal(
    s.seed(TOKEN, '5minute', [
      bar(9, 15, 100, 104, 99, 103),
      bar(9, 20, 103, 106, 102, 105),
      bar(9, 25, 105, 107, 104, 106),
    ]),
    true,
  )
  s.onTick(TOKEN, 107, ist(9, 31))
  s.onTick(TOKEN, 110, ist(9, 33))
  s.onTick(TOKEN, 108, ist(9, 36)) // closes 09:30

  assert.deepEqual(
    s.candles(TOKEN, '5minute', 10).map((c) => c.ts),
    [ist(9, 15), ist(9, 20), ist(9, 25), ist(9, 30)],
    'contiguous across the seed/live join',
  )
  assert.deepEqual(s.candles(TOKEN, '5minute', 1)[0], {
    ts: ist(9, 30),
    open: 107,
    high: 110,
    low: 107,
    close: 110,
  })
})

test('a tick inside an already-seeded bar cannot resurrect it', () => {
  const s = new CandleStore()
  s.declare('a', [{ token: TOKEN, interval: '5minute' }])
  s.seed(TOKEN, '5minute', [bar(9, 15, 100, 104, 99, 103), bar(9, 20, 103, 106, 102, 105)])
  s.onTick(TOKEN, 500, ist(9, 21)) // a late tick for a bar history already closed

  assert.equal(s.candles(TOKEN, '5minute', 10).length, 2)
  assert.equal(s.candles(TOKEN, '5minute', 1)[0]?.high, 106, 'the seeded bar is untouched')
  assert.equal(s.formingBar(TOKEN, '5minute'), null)
})

test('an out-of-order tick never rewrites the forming bar backwards', () => {
  const s = new CandleStore()
  s.declare('a', [{ token: TOKEN, interval: '5minute' }])
  s.onTick(TOKEN, 100, ist(9, 21))
  s.onTick(TOKEN, 500, ist(9, 16)) // arrives late, belongs to the previous bucket
  assert.equal(s.formingBar(TOKEN, '5minute')?.high, 100)
})

test('seed snaps bar timestamps onto the bucket grid and dedups a re-sent bar', () => {
  const s = new CandleStore()
  s.declare('a', [{ token: TOKEN, interval: '5minute' }])
  s.seed(TOKEN, '5minute', [
    { ts: ist(9, 20, 12), open: 1, high: 2, low: 1, close: 2 },
    { ts: ist(9, 15), open: 9, high: 9, low: 9, close: 9 },
    { ts: ist(9, 20, 47), open: 1, high: 3, low: 1, close: 3 },
  ])
  const out = s.candles(TOKEN, '5minute', 10)
  assert.deepEqual(
    out.map((c) => c.ts),
    [ist(9, 15), ist(9, 20)],
    'sorted oldest-first and one bar per bucket',
  )
  assert.equal(out[1]?.close, 3, 'the later copy of a re-sent bar wins')
})

test('re-seeding replaces history rather than appending duplicates', () => {
  const s = new CandleStore()
  s.declare('a', [{ token: TOKEN, interval: '5minute' }])
  s.seed(TOKEN, '5minute', [bar(9, 15, 1, 1, 1, 1), bar(9, 20, 2, 2, 2, 2)])
  s.seed(TOKEN, '5minute', [bar(9, 15, 1, 1, 1, 1), bar(9, 20, 2, 2, 2, 2), bar(9, 25, 3, 3, 3, 3)])
  assert.equal(s.candles(TOKEN, '5minute', 99).length, 3)
})

test('seeding an undeclared series reports false instead of throwing', () => {
  const s = new CandleStore()
  // A history fetch can land after the last subscriber left; throwing here would
  // take down the whole seeding batch.
  assert.equal(s.seed(TOKEN, '5minute', [bar(9, 15, 1, 1, 1, 1)]), false)
  assert.deepEqual(s.candles(TOKEN, '5minute', 10), [])
})

test('retention trims the oldest bars', () => {
  const s = new CandleStore({ maxBars: 3 })
  s.declare('a', [{ token: TOKEN, interval: '1minute' }])
  for (let i = 0; i < 6; i++) s.onTick(TOKEN, 100 + i, ist(9, 15 + i))
  const out = s.candles(TOKEN, '1minute', 99)
  assert.equal(out.length, 3)
  assert.deepEqual(
    out.map((c) => c.ts),
    [ist(9, 17), ist(9, 18), ist(9, 19)],
  )
})

test('dropping a series discards its data; re-declaring starts clean', () => {
  const s = new CandleStore()
  s.declare('a', [{ token: TOKEN, interval: '5minute' }])
  s.seed(TOKEN, '5minute', [bar(9, 15, 1, 1, 1, 1)])
  s.remove('a')
  s.declare('a', [{ token: TOKEN, interval: '5minute' }])
  assert.deepEqual(s.candles(TOKEN, '5minute', 10), [], 'stale bars must not survive a restart')
  assert.deepEqual(s.activeSeries(), [{ token: TOKEN, interval: '5minute' }])
})

test('day bars bucket the whole IST session into one bar', () => {
  const s = new CandleStore()
  s.declare('a', [{ token: TOKEN, interval: 'day' }])
  s.onTick(TOKEN, 100, ist(9, 15))
  s.onTick(TOKEN, 120, ist(12, 0))
  s.onTick(TOKEN, 90, ist(15, 29))
  assert.deepEqual(s.candles(TOKEN, 'day', 5), [], 'the day is still open')
  s.onTick(TOKEN, 95, ist(24 + 9, 15)) // next day's open
  assert.deepEqual(s.candles(TOKEN, 'day', 5)[0], {
    ts: ist(0, 0),
    open: 100,
    high: 120,
    low: 90,
    close: 90,
  })
})

// --- bar-completion push -----------------------------------------------------

/**
 * WHY these exist: `StrategyBase.onCandle` is documented as "pushed when a
 * declared series completes a bar", and nothing pushed. `#complete` closed bars
 * silently, so `handleCandle` had no production caller at all — a strategy could
 * declare a 5-minute series, implement `onCandle`, and never once be called. The
 * store is the only place that knows a bar closed, so the event has to originate
 * here; the host wires it to `handleCandle`.
 */
test('a completing bar is PUSHED to subscribers, with the closed bar attached', () => {
  const store = new CandleStore()
  store.declare('s1', [{ token: TOKEN, interval: '5minute' }])
  const seen: { token: number; interval: string; ts: number; close: number }[] = []
  store.onBarComplete((b) => {
    seen.push({ token: b.token, interval: b.interval, ts: b.candle.ts, close: b.candle.close })
  })

  store.onTick(TOKEN, 100, ist(9, 16))
  store.onTick(TOKEN, 105, ist(9, 18))
  assert.deepEqual(seen, [], 'a forming bar has not completed')

  // The first tick of the NEXT bucket is what closes the 09:15 bar. There is no
  // timer: the store is pure and has no clock.
  store.onTick(TOKEN, 107, ist(9, 21))
  assert.deepEqual(seen, [{ token: TOKEN, interval: '5minute', ts: ist(9, 15), close: 105 }])
})

test('every interval on a token pushes its own completion, and only when it closes', () => {
  const store = new CandleStore()
  store.declare('s1', [
    { token: TOKEN, interval: '5minute' },
    { token: TOKEN, interval: '60minute' },
  ])
  const seen: string[] = []
  store.onBarComplete((b) => {
    seen.push(b.interval)
  })

  store.onTick(TOKEN, 100, ist(9, 16))
  store.onTick(TOKEN, 101, ist(9, 21)) // closes 5minute only
  assert.deepEqual(seen, ['5minute'])

  store.onTick(TOKEN, 102, ist(10, 16)) // closes both the 10:10 5min and the 09:15 60min
  assert.deepEqual(seen, ['5minute', '5minute', '60minute'])
})

test('the pushed bar is already readable through candles(), not merely announced', () => {
  const store = new CandleStore()
  store.declare('s1', [{ token: TOKEN, interval: '5minute' }])
  let readBack: readonly Candle[] = []
  store.onBarComplete((b) => {
    // A host forwarding this to a strategy will have that strategy immediately
    // read the series; the bar it was just told about must be in it.
    readBack = store.candles(b.token, b.interval, 5)
  })
  store.onTick(TOKEN, 100, ist(9, 16))
  store.onTick(TOKEN, 101, ist(9, 21))
  assert.equal(readBack.length, 1)
  assert.equal(readBack[0]?.ts, ist(9, 15))
})

test('seed() does NOT push — seeded bars closed before this process existed', () => {
  // Replaying warm-up history as completions would re-trigger every strategy
  // decision for the whole seeded window on every single restart.
  const store = new CandleStore()
  store.declare('s1', [{ token: TOKEN, interval: '5minute' }])
  let pushes = 0
  store.onBarComplete(() => {
    pushes++
  })
  store.seed(TOKEN, '5minute', [bar(9, 15, 1, 2, 0.5, 1.5), bar(9, 20, 1, 2, 0.5, 1.5)])
  assert.equal(pushes, 0)
})

test('unsubscribing stops the push, and a handler unsubscribing itself does not skip its neighbours', () => {
  const store = new CandleStore()
  store.declare('s1', [{ token: TOKEN, interval: '5minute' }])
  let a = 0
  let b = 0
  const offA = store.onBarComplete(() => {
    a++
    offA() // a strategy stopping on the very bar that closed it out
  })
  store.onBarComplete(() => {
    b++
  })

  store.onTick(TOKEN, 100, ist(9, 16))
  store.onTick(TOKEN, 101, ist(9, 21))
  assert.equal(a, 1)
  assert.equal(b, 1, 'the second handler still ran despite the first removing itself mid-emit')

  store.onTick(TOKEN, 102, ist(9, 26))
  assert.equal(a, 1, 'unsubscribed')
  assert.equal(b, 2)
})

test('a THROWING subscriber cannot break aggregation for the other series on the token', () => {
  // `#complete` runs inside the loop over a token's series, so an escaping throw
  // would leave every other interval un-advanced — a data-corruption bug that
  // would present as a strategy bug and be debugged in the wrong file.
  const errors: unknown[] = []
  const store = new CandleStore({ onError: (err) => errors.push(err) })
  store.declare('s1', [
    { token: TOKEN, interval: '5minute' },
    { token: TOKEN, interval: '60minute' },
  ])
  store.onBarComplete((b) => {
    if (b.interval === '5minute') throw new Error('subscriber blew up')
  })
  const good: string[] = []
  store.onBarComplete((b) => good.push(b.interval))

  store.onTick(TOKEN, 100, ist(9, 16))
  store.onTick(TOKEN, 101, ist(10, 16))

  assert.equal(errors.length, 1, 'the throw was reported, not swallowed')
  assert.deepEqual(good, ['5minute', '60minute'], 'the other subscriber still got everything')
  assert.equal(store.candles(TOKEN, '60minute', 5).length, 1, 'the 60-minute series still advanced')
  assert.equal(store.lastCandle(TOKEN, '5minute')?.ts, ist(9, 15))
})
