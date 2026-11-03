import test from 'node:test'
import assert from 'node:assert/strict'
import { makeTestContext, replay, cronAtIstMinute } from '@algomaker/strategy-kit'
import { RangeBreakoutDirectionalStrategy } from '../src/range-breakout-directional/strategy.ts'
import { ORB_SCALP_BN } from '../src/range-breakout-directional/configs/orb-scalp.ts'
import { SESSION_STATE_KEY } from '../src/session-state.ts'

/**
 * OPENING-RANGE BAND SERIES + THE 09:45 CRON RACE — the 2026-08-11 ORB_SCALP
 * incident, reproduced. Three regressions against `archive/server/slive/orb-scalp.js`,
 * all of them in `#formBand`.
 *
 * WHAT HAPPENED. ORB_SCALP_BN bought BANKNIFTY26AUG57200PE at 09:45:00.300 IST with no
 * breakout of the line anybody could see on a chart, and time-stopped out at 11:15 for
 * -44.25 a unit. The same morning ORB_SCALP_NIFTY and ORB_SCALP_SNX took no trade at all
 * through a clean PE-side break, both persisting `bandReady:false, rangeHigh:0`.
 *
 * A — THE BAND WAS DRAWN ON THE FUTURE, THE SIGNAL READ FROM SPOT. `#formBand` took
 * `md.future(symbol) ?? spotToken(symbol)` while `#maybeCheckEntry` takes `spotToken` for
 * every `atm-option-of-side` config. The tell in production was that ORB_SCALP_BN's
 * persisted band was byte-identical to ORB_FUT_BN's — 57761.8 / 57401 — and that tag
 * bands the future BY DESIGN (`reference: 'current-future'`). ORB_SCALP's own config says
 * `reference: 'index-spot'`, and legacy fetched `cfg.spotToken` (orb-scalp.js:109-116).
 * BANKNIFTY's basis that morning was ~+62 points, so the PE line came out at
 * 57401 * 0.999 = 57343.60 while spot's 09:15-09:20 close was already 57338.60 — the
 * index opened BELOW its own trigger and the side was armed before the band existed.
 *
 * B — THE 09:45:00 CRON RACES A TICK-DRIVEN BAR CLOSE. A bar closes when the first tick
 * of the NEXT bucket arrives, never on a timer (`marketdata-core/src/candles.ts`), and
 * `candles()` serves `completed` bars only. So the sixth bar (09:40-09:45) exists only
 * once a tick lands at or after 09:45:00.000 — which is the instant the cron fires.
 * On five bars `computeOpeningRange` returns null and `#formBand` returned a bare `void`,
 * which the job runner reads as SUCCESS: no retry, no log, and no band for the rest of
 * the day. BANKNIFTY's future printed in time; NIFTY's and SENSEX's did not. Legacy fired
 * at 09:45:**20** and re-armed `setTimeout(setupRange, 30000)` while any index was still
 * pending (orb-scalp.js:141,292), logging `range candles not ready` each time. `JobSpec`
 * has supported exactly this all along — `{retry:true}`, `DEFAULT_JOB_RETRY_MS` 30s, and
 * a doc comment that says "a band that never forms retries all session and the log line
 * is the alert".
 *
 * C — THE FIRST ENTRY CHECK JUDGED THE BAND'S OWN LAST BAR. Nothing advanced
 * `lastEvaluatedBarTs` when the band formed, so the check 300ms later judged the 09:40
 * bar — one of the six that drew the band. `preopen-bars.test.ts` argues this is harmless
 * because "a candle cannot close outside a band drawn around its own close", and that is
 * true — but ONLY while the band and the signal come from one series. Defect A broke that
 * premise, which is why the 2026-08-10 cascade ran again one day later on a different tag.
 * Legacy could not reach it: range at 09:45:20, entry crons at `10 *\/5 9-13`, so its first
 * effective check was 09:50:10 on the 09:45-09:50 bar.
 */

const IST_OFFSET_MS = 330 * 60_000
/** An IST wall-clock instant on the incident's own date, 2026-08-11. */
const ist = (h: number, m: number, s = 0): number =>
  Date.UTC(2026, 7, 11, 0, 0, 0) + (h * 60 + m) * 60_000 + s * 1000 - IST_OFFSET_MS

const BN_SPOT_TOKEN = 260105
const BN_FUT_TOKEN = 14865154 // BANKNIFTY26AUGFUT, the contract md.future() resolves to

const FUT = {
  tradingsymbol: 'BANKNIFTY26AUGFUT', instrumentToken: BN_FUT_TOKEN,
  lotSize: 30, tickSize: 0.05, exchange: 'NFO',
} as const

/**
 * SPOT's opening range, 2026-08-11: low 57310, high 57699.15.
 * Its 09:15-09:20 close is the 57338.60 that `BN_BREAKOUT`'s own persisted band
 * (57390.20474 / 57286.99526, +/-0.09%) pins for that morning.
 */
const SPOT_RANGE = [
  { ts: ist(9, 15), open: 57420.5, high: 57470.0, low: 57310.0, close: 57338.6 },
  { ts: ist(9, 20), open: 57338.6, high: 57402.1, low: 57325.4, close: 57390.0 },
  { ts: ist(9, 25), open: 57390.0, high: 57515.6, low: 57380.2, close: 57500.4 },
  { ts: ist(9, 30), open: 57500.4, high: 57699.15, low: 57495.0, close: 57640.8 },
  { ts: ist(9, 35), open: 57640.8, high: 57660.0, low: 57560.3, close: 57580.1 },
  { ts: ist(9, 40), open: 57580.1, high: 57600.0, low: 57330.0, close: 57340.0 },
]

/**
 * The SAME six buckets on the FUTURE, carried ~62 points up by the basis. Windowed by
 * `computeOpeningRange` this yields 57401 / 57761.8 — the band ORB_SCALP_BN actually
 * persisted, and the reason these two series must never be mixed.
 */
const FUT_RANGE = SPOT_RANGE.map((c) => ({
  ts: c.ts, open: c.open + 62.4, high: c.high + 62.65, low: c.low + 91.0, close: c.close + 62.4,
}))

/** The band the SPOT series must produce: low 57310, high 57699.15, range 389.15. */
const SPOT_LOW = 57310
const SPOT_HIGH = 57699.15

interface PersistedDay {
  readonly value: {
    readonly day: {
      readonly bandReady: boolean
      readonly rangeHigh: number
      readonly rangeLow: number
      readonly lastEvaluatedBarTs: number
      readonly dayBlocked: boolean
    }
  }
}

/** A wired-up BANKNIFTY book: spot, the future, and both ATM PE contracts quoted. */
function bnParts(nowMs: number): ReturnType<typeof makeTestContext> {
  const parts = makeTestContext({ nowMs })
  parts.md.setUnderlying('BANKNIFTY', BN_SPOT_TOKEN, 100)
  parts.md.setFuture('BANKNIFTY', FUT)
  parts.md.setQuote({ token: BN_FUT_TOKEN, lastPrice: 57402.4, ts: 0 })
  // Both strikes an ATM-of-spot lookup can land on around 57300-57400, each with a
  // quote, so a wrong entry REACHES the gateway instead of returning early and
  // turning a red test green for the wrong reason.
  for (const strike of [57300, 57400]) {
    const inst = {
      tradingsymbol: `BANKNIFTY26AUG${strike}PE`, instrumentToken: 15125506 + strike,
      lotSize: 30, tickSize: 0.05, exchange: 'NFO',
    }
    parts.md.setOption('BANKNIFTY', strike, 'PE', inst)
    parts.md.setQuote({ token: inst.instrumentToken, lastPrice: 504, ts: 0 })
  }
  return parts
}

async function persistedDay(parts: ReturnType<typeof makeTestContext>): Promise<PersistedDay['value']['day']> {
  const rec = await parts.state.get<PersistedDay>(SESSION_STATE_KEY)
  assert.ok(rec !== null, 'formBand must persist the session record')
  return rec.value.day
}

test('A: orb_scalp bands the SPOT series, never the future', async () => {
  const parts = bnParts(ist(9, 44))
  parts.md.setCandles(BN_SPOT_TOKEN, '5minute', [...SPOT_RANGE])
  parts.md.setCandles(BN_FUT_TOKEN, '5minute', [...FUT_RANGE])

  const s = new RangeBreakoutDirectionalStrategy(parts.ctx, ORB_SCALP_BN)
  await replay(s, parts, [{ ts: ist(9, 46), quote: { token: BN_SPOT_TOKEN, lastPrice: 57340, ts: 1 } }])

  const day = await persistedDay(parts)
  assert.equal(day.bandReady, true, 'six session bars are present — the band must form')
  assert.deepEqual({ lo: day.rangeLow, hi: day.rangeHigh }, { lo: SPOT_LOW, hi: SPOT_HIGH },
    'config says reference: index-spot and the entry check reads spot — 57401/57761.8 here means the band came off the FUTURE')
})

test('A: a spot close under the FUTURES-derived line is not a breakout', async () => {
  // 57330 sits between the two PE lines: below the futures band's 57401*0.999 = 57343.60,
  // and comfortably above the real spot band's 57310*0.999 = 57252.69. One number that
  // separates a phantom entry from a correct pass.
  const parts = bnParts(ist(9, 44))
  parts.md.setCandles(BN_SPOT_TOKEN, '5minute', [...SPOT_RANGE])
  parts.md.setCandles(BN_FUT_TOKEN, '5minute', [...FUT_RANGE])

  const s = new RangeBreakoutDirectionalStrategy(parts.ctx, ORB_SCALP_BN)
  await replay(s, parts, [{ ts: ist(9, 46), quote: { token: BN_SPOT_TOKEN, lastPrice: 57340, ts: 1 } }])

  // A closed 09:45-09:50 spot bar at 57330 — a legal bar to judge, and no breakout.
  parts.md.setCandles(BN_SPOT_TOKEN, '5minute', [
    ...SPOT_RANGE, { ts: ist(9, 45), open: 57340.0, high: 57355.0, low: 57320.0, close: 57330.0 },
  ])
  const res = await replay(s, parts, [{ ts: ist(9, 51), quote: { token: BN_SPOT_TOKEN, lastPrice: 57330, ts: 2 } }])

  assert.deepEqual(res.orders, [],
    '57330 breaks the futures-drawn PE line (57343.60) but not the spot one (57252.69) — an order here is the 09:45:00.300 phantom PE')
})

test('B: five completed bars at 09:45 asks for a retry, it does not silently succeed', async () => {
  // The sixth bar (09:40-09:45) has not closed because no tick at/after 09:45:00 has been
  // processed yet. This is the ordinary state of a slower-printing instrument at the
  // instant the cron fires — NIFTY and SENSEX both sat here on 2026-08-11.
  const parts = bnParts(ist(9, 45, 20))
  parts.md.setCandles(BN_SPOT_TOKEN, '5minute', SPOT_RANGE.slice(0, 5))

  const s = new RangeBreakoutDirectionalStrategy(parts.ctx, ORB_SCALP_BN)
  await s.start()
  const formBand = s.jobs().find((j) => j.name === 'formBand')
  assert.ok(formBand !== undefined, 'formBand job must exist')

  const outcome = await formBand.run()

  assert.deepEqual(outcome, { retry: true },
    'a bare void is read as SUCCESS by the job runner — the band would never form again all session')
  assert.ok(parts.logs.some((l) => /range candles not ready|not enough|bars/i.test(l.msg)),
    'legacy logged `range candles not ready` on every pass — the log line IS the alert (JobSpec.maxRetries)')
})

test('B: the retry forms the band once the sixth bar closes', async () => {
  const parts = bnParts(ist(9, 45, 20))
  parts.md.setCandles(BN_SPOT_TOKEN, '5minute', SPOT_RANGE.slice(0, 5))

  const s = new RangeBreakoutDirectionalStrategy(parts.ctx, ORB_SCALP_BN)
  await s.start()
  const formBand = s.jobs().find((j) => j.name === 'formBand')
  assert.ok(formBand !== undefined)

  assert.deepEqual(await formBand.run(), { retry: true }, 'five bars — not yet')

  // 30 seconds later the first post-09:45 tick has landed and closed the sixth bar.
  parts.clock.set(ist(9, 45, 50))
  parts.md.setCandles(BN_SPOT_TOKEN, '5minute', [...SPOT_RANGE])

  assert.equal(await formBand.run(), undefined, 'six bars — the retry must now succeed and stop re-arming')
  const day = await persistedDay(parts)
  assert.deepEqual({ ready: day.bandReady, lo: day.rangeLow, hi: day.rangeHigh },
    { ready: true, lo: SPOT_LOW, hi: SPOT_HIGH },
    'the band the retry forms is the same spot range, 30 seconds late')
})

test('B: formBand fires at 09:45:20, giving the sixth bar time to close', () => {
  const s = new RangeBreakoutDirectionalStrategy(makeTestContext({ nowMs: ist(9, 44) }).ctx, ORB_SCALP_BN)
  const formBand = s.jobs().find((j) => j.name === 'formBand')
  assert.ok(formBand !== undefined)
  assert.equal(formBand.cron, '20 45 9 * * 1-5',
    'legacy fired at 09:45:20 (orb-scalp.js:292); firing at :00 races the tick that closes the sixth bar')
})

test('B: cronAtIstMinute can express a seconds offset, and still defaults to :00', () => {
  assert.equal(cronAtIstMinute(9 * 60 + 45, '1-5', 20), '20 45 9 * * 1-5')
  assert.equal(cronAtIstMinute(9 * 60 + 45), '0 45 9 * * 1-5', 'every existing caller must be untouched')
})

test('C: the band does not let the entry check judge its own last bar', async () => {
  const parts = bnParts(ist(9, 44))
  parts.md.setCandles(BN_SPOT_TOKEN, '5minute', [...SPOT_RANGE])

  const s = new RangeBreakoutDirectionalStrategy(parts.ctx, ORB_SCALP_BN)
  await replay(s, parts, [{ ts: ist(9, 46), quote: { token: BN_SPOT_TOKEN, lastPrice: 57340, ts: 1 } }])

  const day = await persistedDay(parts)
  // Behaviourally unreachable with a single series — a bar cannot close outside a band
  // its own high/low helped draw — so the observable is the cursor the band leaves behind.
  // It has to sit at or past the last bar of the range window, which makes the first
  // judgeable bar the 09:45-09:50 one, exactly as legacy's 09:50:10 check did.
  assert.ok(day.lastEvaluatedBarTs >= ist(9, 40),
    'a band formed from 09:15-09:45 must not leave its own 09:40 bar judgeable — that is the bar the 2026-08-11 PE fired on')
})
