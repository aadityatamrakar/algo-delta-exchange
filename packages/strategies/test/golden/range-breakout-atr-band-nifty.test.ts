import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { runLegacyShadow, type RecordedLegacyOrder, type ShadowHistoryCandle } from '@algomaker/legacy-shadow-runner'
import { makeTestContext, replay, diffIntents, type ReplayTick, type RecordedOrder } from '@algomaker/strategy-kit'
import { RangeBreakoutDirectionalStrategy } from '../../src/range-breakout-directional/strategy.ts'
import { ATR_BAND_NIFTY } from '../../src/range-breakout-directional/configs/atr-band-nifty.ts'

/**
 * I2: the class-level golden day for `atr-band-nifty.js` — the last of the 4 remaining
 * strategies with NO orchestration-level comparison to its legacy launcher (only pure-function
 * parity against `atr-band-logic.js`, in `range-breakout-remaining.test.ts`).
 *
 * Unlike bn-breakout/orb-scalp (a single-phase band), atr-band-nifty.js forms its band in TWO
 * separate phases at TWO separate times, off TWO DIFFERENT candle series:
 *   - 10:15:20 `computeWidth()`: ATR-14/3 WIDTH from 60-MINUTE spot candles.
 *   - 11:40:20 `computeLines()`: the actual HIGH/LOW LINES, anchored on the 11:35-11:40 5-MINUTE
 *     spot candle's CLOSE (not the 60-minute candle at all) +/- that width.
 *
 * This test was written `{ todo }` against a port that got BOTH of those wrong, and it is kept
 * as the regression guard for the fix. The two defects it reproduced:
 *
 *   1. ONE-STEP BAND. `BandSource`'s `'atr-anchor'` variant carried a single `formAtIstMinute`,
 *      and `#formBand()` computed width AND lines together off the SAME 60-minute set — using
 *      `candles[candles.length-1].close` (a 60-minute close, at 10:15) as the anchor for
 *      `atrLines()` instead of waiting 85 more minutes for the real 5-minute anchor. Fixed by
 *      splitting the phases: `formBand` (10:15, `widthInterval`) then `anchorBand` (11:40,
 *      `anchorInterval`), each selecting the bar that had CLOSED at its own IST minute.
 *   2. OPTION-SCALE STOP. `#checkOptionExit`'s atr-anchor branch read 5-minute candles for
 *      `this.#optionPosition.instrument.instrumentToken` — the OPTION's own token — and compared
 *      that PREMIUM (tens to low hundreds) against `rangeHigh`/`rangeLow`, which are SPOT-index
 *      boundaries (~22,000s). For a CE, `atrStopHitOnClose` became `optionClose < lowLine`, true
 *      for ANY premium against ANY spot-scale lowLine, so every CE was force-closed on a bogus
 *      "stop" one check after entry; a PE never got the check to fire at all. Fixed by evaluating
 *      the band against the UNDERLYING's series, which is what legacy reads (`spotToken`).
 *
 * Neither bug was visible to `atr-band-logic.js`'s pure-function tests, which only ever get fed
 * CORRECT highLine/lowLine values and correctly-scoped candles as arguments — exactly the I2 gap.
 *
 * The fixture is engineered so both would show up in the recorded ORDER SEQUENCE (not just in
 * internal highLine/lowLine state, which `diffIntents` cannot see): the bogus early CE close
 * freed the ported class to also enter a PE that legacy never reaches, because legacy's CE
 * position — correctly held open all day — blocks ANY further entry attempt (`position` is a
 * SINGLE slot). Pre-fix this printed `order COUNT differs: legacy=2 ported=4` plus an extra
 * BUY/SELL NIFTY22350PE pair. The legacy side below is untouched from when it recorded that.
 */

const SLIVE = path.join(import.meta.dirname, '..', '..', '..', '..', 'archive', 'server', 'slive')
const SPOT_TOKEN = 256265 // NIFTY 50 index, atr-band-nifty.js's own literal

function toRecorded(legacy: readonly RecordedLegacyOrder[]): RecordedOrder[] {
  return legacy.map((o) => ({ symbol: o.tradingsymbol, side: o.side, lots: o.lots, orderType: 'MARKET' }))
}

const CE = { tradingsymbol: 'NIFTY22450CE', instrumentToken: 900001, lotSize: 75, tickSize: 0.05, exchange: 'NFO' }
const PE = { tradingsymbol: 'NIFTY22350PE', instrumentToken: 900002, lotSize: 75, tickSize: 0.05, exchange: 'NFO' }
const OPTIONS_FIXTURE = {
  '22450CE': { instrument_token: CE.instrumentToken, tradingsymbol: CE.tradingsymbol, strike: 22450, lot_size: 75 },
  '22350PE': { instrument_token: PE.instrumentToken, tradingsymbol: PE.tradingsymbol, strike: 22350, lot_size: 75 },
}

// ---- 60-minute candles: flat at 22400 (O=C=22400, H=+10, L=-10) for all 15 -> constant
// TrueRange=20 on every candle -> wilderATR(14)=20 exactly -> width=20/3=6.6667. 14 "prior day"
// candles (any ts, kept by legacy's date filter since day != today) + 1 "today 09:15" candle
// (the only one legacy's computeWidth keeps for TODAY, since it drops any later-forming hourly
// candle from today) — this is EXACTLY the 15 candles the ported side also reads
// (`ctx.md.candles(token,'60minute',atrPeriod+1)` = last 15), so ATR/width match on both sides
// and the whole divergence below is isolated to the anchor, not confounded by a differing ATR.
const SIXTY_MIN_PRIOR: ShadowHistoryCandle[] = Array.from({ length: 14 }, () => ({
  ts: '2026-07-17 09:15:00', open: 22400, high: 22410, low: 22390, close: 22400,
}))
const SIXTY_MIN_TODAY: ShadowHistoryCandle = { ts: '2026-07-24 09:15:00', open: 22400, high: 22410, low: 22390, close: 22400 }
const SIXTY_MIN_CANDLES: ShadowHistoryCandle[] = [...SIXTY_MIN_PRIOR, SIXTY_MIN_TODAY]
// The 60-minute close is 22400. The REAL anchor is the 11:35-11:40 5-MINUTE close (22300,
// below), so the two disagree by 100 points on purpose: correct lines are
// highLine=22306.667/lowLine=22293.333, and the one-step port's were 22406.667/22393.333.
// DECLINE_PAIR below sits between the two lowLines, so it is a stop under the WRONG band and
// harmless under the right one — that is what makes the anchor bug order-visible.

// ---- 5-minute candles: flat/doji filler 09:15-11:35 (never signals: open=close="doji" fails
// both bothGreen/bothRed), then a green ENTRY pair (11:40, 11:45) that clears BOTH bands' highLine
// (so CE entry is IDENTICAL on both sides), then — appended only AFTER entry — a red DECLINE pair
// (11:50, 11:55) that closes BELOW the port's (wrong, higher) lowLine=22393.333 but stays ABOVE
// legacy's (real, lower) lowLine=22293.333, so it fires a genuine PE entry signal for whichever
// side is free to check it, without ever tripping legacy's real CE stop.
function fiveMinTs(hh: number, mm: number): string {
  return `2026-07-24 ${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00`
}
const FLAT_FILLER: ShadowHistoryCandle[] = []
for (let mins = 9 * 60 + 15; mins <= 11 * 60 + 35; mins += 5) {
  FLAT_FILLER.push({ ts: fiveMinTs(Math.floor(mins / 60), mins % 60), open: 22300, high: 22310, low: 22290, close: 22300 })
}
const ENTRY_PAIR: ShadowHistoryCandle[] = [
  { ts: fiveMinTs(11, 40), open: 22300, high: 22430, low: 22290, close: 22420 }, // green, closes > both highLines
  { ts: fiveMinTs(11, 45), open: 22420, high: 22460, low: 22410, close: 22450 }, // green, closes > both highLines
]
const DECLINE_PAIR: ShadowHistoryCandle[] = [
  { ts: fiveMinTs(11, 50), open: 22450, high: 22460, low: 22360, close: 22370 }, // red, < port lowLine, > legacy lowLine
  { ts: fiveMinTs(11, 55), open: 22370, high: 22380, low: 22340, close: 22350 }, // red, < port lowLine, > legacy lowLine
]

/**
 * Both sides get the SAME timestamps. The legacy launcher selects its two anchor bars purely by
 * timestamp (`ts.substr(11,5) <= '09:15'` and `<= '11:35'`), and so does the port now
 * (`logic.candlesClosedBy`), so handing the port array indices as `Candle.ts` — as this helper
 * originally did — would have made it structurally impossible for it to anchor the way legacy
 * does, and the comparison would have been testing the harness rather than the strategy.
 * `Candle.ts` is epoch ms of the bar's OPEN; the fixture strings are IST wall clock.
 */
const IST_OFFSET_MS = 330 * 60_000
function withIstTs(candles: readonly ShadowHistoryCandle[]): { ts: number; open: number; high: number; low: number; close: number }[] {
  return candles.map((c) => {
    // `ShadowHistoryCandle.ts` is optional because most legacy files never read it. This one
    // anchors both its phases on it, so an undated bar is a broken fixture, not a defaultable one.
    if (c.ts === undefined) throw new Error('fixture candle has no ts — both band phases anchor by timestamp')
    const [date, time] = c.ts.split(' ') as [string, string]
    const [y, mo, d] = date.split('-').map(Number) as [number, number, number]
    const [hh, mm, ss] = time.split(':').map(Number) as [number, number, number]
    return { ts: Date.UTC(y, mo - 1, d, hh, mm, ss) - IST_OFFSET_MS, open: c.open, high: c.high, low: c.low, close: c.close }
  })
}

const AT_10_15 = Date.UTC(2026, 6, 24, 4, 45, 0)
const AT_11_45 = Date.UTC(2026, 6, 24, 6, 15, 0)
const AT_11_50 = Date.UTC(2026, 6, 24, 6, 20, 0)
const AT_11_55 = Date.UTC(2026, 6, 24, 6, 25, 0)

/**
 * Drive a fresh instance through BOTH band phases with `fiveMin` appended to the flat filler
 * BEFORE the 11:40 anchor job runs — i.e. the anchor job can see bars it must reject by
 * timestamp, exactly as on the legacy side.
 */
async function throughBandPhases(fiveMin: readonly ShadowHistoryCandle[]): Promise<{
  parts: ReturnType<typeof makeTestContext>
  s: RangeBreakoutDirectionalStrategy
}> {
  const parts = makeTestContext({ nowMs: Date.UTC(2026, 6, 24, 3, 49, 0) }) // 09:19 IST
  parts.md.setUnderlying('NIFTY', SPOT_TOKEN, 50)
  parts.md.setOption('NIFTY', 22450, 'CE', CE)
  parts.md.setOption('NIFTY', 22350, 'PE', PE)
  parts.md.setCandles(SPOT_TOKEN, '60minute', withIstTs(SIXTY_MIN_CANDLES))
  parts.md.setCandles(SPOT_TOKEN, '5minute', withIstTs(FLAT_FILLER))
  const s = new RangeBreakoutDirectionalStrategy(parts.ctx, ATR_BAND_NIFTY)
  await replay(s, parts, [{ ts: AT_10_15, quote: { token: SPOT_TOKEN, lastPrice: 22300, ts: 0 } }])
  parts.md.setCandles(SPOT_TOKEN, '5minute', withIstTs([...FLAT_FILLER, ...fiveMin]))
  return { parts, s }
}

/**
 * DEFECT 1, pinned on its own.
 *
 * The golden day below only fails when BOTH defects are present at once — with the exit fixed,
 * a wrong band merely moves the CE exit earlier, and `diffIntents` compares the order SEQUENCE,
 * not its timing, so it cannot see that. Verified by mutation on 2026-07-27. This test closes
 * that gap by choosing an entry pair that sits BETWEEN the two candidate bands:
 *
 *   correct band — anchored on the 11:35-11:40 5-MINUTE close, 22300 -> highLine 22306.667
 *   one-step band — anchored on the 10:15 60-MINUTE close,     22400 -> highLine 22406.667
 *
 * Closes of 22350 and 22380 clear the first and not the second, so "did the band form in two
 * phases off two series?" becomes a BUY that either exists or does not.
 */
const NARROW_ENTRY_PAIR: ShadowHistoryCandle[] = [
  { ts: fiveMinTs(11, 40), open: 22300, high: 22360, low: 22295, close: 22350 },
  { ts: fiveMinTs(11, 45), open: 22350, high: 22390, low: 22345, close: 22380 },
]

test('the band anchors on the 11:35-11:40 FIVE-MINUTE close, not the 10:15 SIXTY-MINUTE close', async () => {
  const { parts, s } = await throughBandPhases(NARROW_ENTRY_PAIR)
  parts.md.setQuote({ token: CE.instrumentToken, lastPrice: 100, ts: 0 })
  const res = await replay(s, parts, [
    { ts: AT_11_45, quote: { token: SPOT_TOKEN, lastPrice: 22450, ts: 1 } },
  ])
  assert.deepEqual([...res.orders], [
    { symbol: 'NIFTY22450CE', side: 'BUY', lots: 1, orderType: 'MARKET' },
  ], 'two green 5-min closes at 22350/22380 clear the real highLine (22306.667); a band anchored ' +
     'on the 60-minute 22400 close would put highLine at 22406.667 and take no trade at all')
})

/**
 * DEFECT 2, pinned on its own — and pinned in BOTH directions, so that deleting the stop
 * outright fails just as loudly as evaluating it on the wrong series.
 *
 * The option's own 5-minute series is deliberately present and deliberately far below the band,
 * because that is the real runtime situation: the whole option chain is subscribed, so
 * CandleStore holds a series per option token, and a premium is three orders of magnitude below
 * a NIFTY spot line. Reading it makes `atrStopHitOnClose('CE', 100, ..., 22293.3)` permanently
 * true — a stop that fires one check after every single CE entry, forever.
 */
test('the candle-close stop is evaluated on the UNDERLYING series, never on the option premium series', async () => {
  const { parts, s } = await throughBandPhases(ENTRY_PAIR)
  parts.md.setQuote({ token: CE.instrumentToken, lastPrice: 100, ts: 0 })
  await replay(s, parts, [{ ts: AT_11_45, quote: { token: SPOT_TOKEN, lastPrice: 22450, ts: 1 } }])
  assert.equal(parts.gateway.orders.length, 1, 'sanity: the CE entry happened')

  // The option's premium bars: close 100, i.e. ~22,193 points below lowLine (22293.333).
  parts.md.setCandles(CE.instrumentToken, '5minute', withIstTs([
    { ts: fiveMinTs(11, 45), open: 98, high: 102, low: 95, close: 100 },
  ]))
  // The UNDERLYING's latest close, 22350, is comfortably INSIDE the band. Nothing has stopped out.
  parts.md.setCandles(SPOT_TOKEN, '5minute', withIstTs([...FLAT_FILLER, ...ENTRY_PAIR,
    { ts: fiveMinTs(11, 50), open: 22450, high: 22460, low: 22340, close: 22350 },
  ]))
  const held = await replay(s, parts, [
    { ts: AT_11_50, quote: { token: SPOT_TOKEN, lastPrice: 22350, ts: 2 } },
  ])
  assert.equal(held.orders.length, 1,
    'the CE must still be OPEN: the underlying closed at 22350, above lowLine 22293.333. Only a ' +
    'stop reading the OPTION\'s own 100-rupee close against a 22,293 line would have closed it')

  // Now a genuine breach of the same line by the same series — the stop must still work.
  parts.md.setCandles(SPOT_TOKEN, '5minute', withIstTs([...FLAT_FILLER, ...ENTRY_PAIR,
    { ts: fiveMinTs(11, 50), open: 22450, high: 22460, low: 22340, close: 22350 },
    { ts: fiveMinTs(11, 55), open: 22350, high: 22355, low: 22270, close: 22280 },
  ]))
  const stopped = await replay(s, parts, [
    { ts: AT_11_55, quote: { token: SPOT_TOKEN, lastPrice: 22280, ts: 3 } },
  ])
  assert.deepEqual([...stopped.orders], [
    { symbol: 'NIFTY22450CE', side: 'BUY', lots: 1, orderType: 'MARKET' },
    { symbol: 'NIFTY22450CE', side: 'SELL', lots: 1, orderType: 'MARKET' },
  ], 'an underlying close of 22280 IS below lowLine 22293.333, so the stop must fire — moving it ' +
     'to the right series must not quietly amount to removing it')
})

test(
  'ATR_BAND_NIFTY class-level golden day — two-phase band (60min width at 10:15, 5min anchor at 11:40) and an underlying-scale exit stop reproduce the legacy order sequence exactly',
  { timeout: 60_000 },
  async () => {
    const historyFixture: Record<string, ShadowHistoryCandle[]> = {
      [`${SPOT_TOKEN}:60minute`]: SIXTY_MIN_CANDLES,
      [`${SPOT_TOKEN}:5minute`]: [...FLAT_FILLER, ...ENTRY_PAIR],
    }
    const run = await runLegacyShadow({
      legacyFile: path.join(SLIVE, 'atr-band-nifty.js'),
      futureToken: 999999, // atr-band-nifty.js never reads a future token
      currentExpiryOptions: OPTIONS_FIXTURE,
      nowMs: Date.UTC(2026, 6, 24, 3, 49, 0), // 09:19 IST
      historyData: historyFixture,
    })
    await run.advance(56 * 60_000 + 20_000) // -> 10:15:20 IST, computeWidth
    await run.advance(85 * 60_000) // -> 11:40:20 IST, computeLines (anchor = 11:35 candle, close=22300)
    await run.tick([
      { instrument_token: SPOT_TOKEN, last_price: 22450 },
      { instrument_token: CE.instrumentToken, last_price: 100 },
    ])
    await run.advance(4 * 60_000 + 50_000) // -> 11:45:10 IST, next checkEntryQ -> CE signal -> enters
    historyFixture[`${SPOT_TOKEN}:5minute`] = [...FLAT_FILLER, ...ENTRY_PAIR, ...DECLINE_PAIR]
    await run.advance(5 * 60_000) // -> 11:50:10 IST, CE still ACTIVE -> stop check on close=22350: safe (> legacy lowLine)
    // Legacy's OWN 60-min time-stop timer (armed at entry, atr-band-nifty.js:251) fires at
    // ~12:45:10 — well before EOD (15:15) — so CE exits via 'TIME', not 'EOD'. Either way, CE
    // stays open, uninterrupted, from entry to this single exit: `position` is never freed for a
    // PE attempt in between, which is the whole point of this fixture.
    await run.advance(3 * 60 * 60_000 + 24 * 60_000 + 50_000) // -> 15:15:00 IST (past the 60-min time-stop too)
    run.stop()
    const legacyOrders = toRecorded(run.orders)
    assert.ok(legacyOrders.length > 0, 'sanity: legacy side must not be vacuously empty')
    assert.equal(legacyOrders.length, 2, 'legacy: BUY CE entry + SELL CE time-stop exit (~60 min later) — CE stays open uninterrupted, PE never attempted (position slot never frees up)')

    const parts = makeTestContext({ nowMs: Date.UTC(2026, 6, 24, 3, 49, 0) })
    parts.md.setUnderlying('NIFTY', SPOT_TOKEN, 50)
    parts.md.setOption('NIFTY', 22450, 'CE', CE)
    parts.md.setOption('NIFTY', 22350, 'PE', PE)
    parts.md.setCandles(SPOT_TOKEN, '60minute', withIstTs(SIXTY_MIN_CANDLES))
    parts.md.setCandles(SPOT_TOKEN, '5minute', withIstTs(FLAT_FILLER))
    const s = new RangeBreakoutDirectionalStrategy(parts.ctx, ATR_BAND_NIFTY)

    await replay(s, parts, [
      { ts: Date.UTC(2026, 6, 24, 4, 45, 0), quote: { token: SPOT_TOKEN, lastPrice: 22300, ts: 0 } }, // 10:15, phase 1: WIDTH only (ATR-14/3 = 6.667). No lines yet -> no entry check can pass.
    ])
    // The 11:40 and 11:45 bars are in the store BEFORE the 11:40 anchor job runs, exactly as they
    // are on the legacy side (its `historyData` fixture holds them too). Both sides must therefore
    // reject them by TIMESTAMP and anchor on the 11:35-11:40 bar, close=22300. Any port that takes
    // "the last bar in the array" lands on 22450 here and the entry below never fires.
    parts.md.setCandles(SPOT_TOKEN, '5minute', withIstTs([...FLAT_FILLER, ...ENTRY_PAIR]))
    parts.md.setQuote({ token: CE.instrumentToken, lastPrice: 100, ts: 0 })
    await replay(s, parts, [
      { ts: Date.UTC(2026, 6, 24, 6, 15, 0), quote: { token: SPOT_TOKEN, lastPrice: 22450, ts: 1 } }, // 11:40 phase 2 (lines), then 11:45 tick -> CE entry
    ])
    // DELIBERATE TRAP, and load-bearing: the OPTION's own 5-minute series is present in the store,
    // because the strategy subscribes the whole option chain and CandleStore keeps a series per
    // subscribed token. A correct exit path must never read it — its closes are premiums (~100)
    // and the band is spot-scale (~22,300), so `atrStopHitOnClose('CE', 100, ...)` is `100 <
    // 22293.3` = an instant, permanent, bogus stop. Removing this line does not make the test
    // "cleaner", it makes it blind: with no option series the buggy read returns [] and the bug
    // silently passes. Verified by mutation on 2026-07-27.
    parts.md.setCandles(CE.instrumentToken, '5minute', withIstTs([{ ts: '2026-07-24 11:40:00', open: 98, high: 102, low: 95, close: 100 }]))
    await replay(s, parts, [
      { ts: Date.UTC(2026, 6, 24, 6, 16, 0), quote: { token: SPOT_TOKEN, lastPrice: 22450, ts: 2 } }, // 11:46 heartbeat: the stop check reads the UNDERLYING's close (22450), not that ~100 premium
    ])
    parts.md.setCandles(SPOT_TOKEN, '5minute', withIstTs([...FLAT_FILLER, ...ENTRY_PAIR, ...DECLINE_PAIR]))
    parts.md.setQuote({ token: PE.instrumentToken, lastPrice: 80, ts: 0 })
    await replay(s, parts, [
      { ts: Date.UTC(2026, 6, 24, 6, 20, 0), quote: { token: SPOT_TOKEN, lastPrice: 22350, ts: 3 } }, // 11:50, close=22350: above the REAL lowLine (22293.3), so CE holds and PE is never reached
    ])
    const res = await replay(s, parts, [
      { ts: Date.UTC(2026, 6, 24, 9, 45, 0), quote: { token: SPOT_TOKEN, lastPrice: 22350, ts: 4 } }, // 15:15, squareOff closes the still-open CE
    ])

    // Both sides: BUY NIFTY22450CE, then one SELL of the same instrument, and nothing else. The
    // exit REASONS differ legitimately and are not compared — legacy's ambient 60-minute
    // setTimeout fires at ~12:45 ('TIME'), while the port checks elapsed time on ticks (I1) and
    // there is no tick between 11:50 and 15:15, so squareOff closes it ('EOD'). What the fixture
    // is guarding is the SEQUENCE: no bogus intermediate SL, and therefore no PE pair.
    const diff = diffIntents(legacyOrders, [...res.orders])
    assert.equal(diff.match, true, diff.differences.join('\n'))
  },
)
