/**
 * NSE PARITY — the BULL golden tape through `decideBullS` (spec §6.3
 * acceptance (a), plan Task 3 step 2).
 *
 * The tape is the one `packages/strategies/test/golden/premium-leg-book-bull.test.ts`
 * replays: BANKNIFTY, step 100, strikes 50,000 and 50,100, three days. That
 * suite proves `PremiumLegBookStrategy` emits what the legacy `bull-s-1.js`
 * emits; this one runs `PremiumLegBookStrategy` on the same tape, here, and
 * asserts `decideBullS` emits the same ordered `(op, strike, optType, side,
 * lots)` list, with every fill at the tape price.
 *
 * The dials are the legacy book's: step 100, jump 1, the summed-LTP stop with
 * the legacy `trunc` (basis 0), 1.25×, size 1 stepping 1 UNCAPPED, no open
 * limit, the first price sells ATM. Two more are written out because the
 * legacy book has neither: `bs_stop_confirm_s` 0 (it stops on the tick the sum
 * crosses) and no loss cap.
 *
 * ONE DECLARED DIFFERENCE, AND ONLY ONE: the order of the two sales inside a
 * straddle. The legacy book sells CE then PE; spec §6.1 rule 9 has BULL-S
 * open PE then CE (as it closes), so the ported side's adjacent
 * `SELL CE k, SELL PE k` pair is compared as `PE, CE`. Closes, sizes, strikes
 * and the order of straddles are compared exactly.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { makeTestContext, replay, type RecordedOrder, type ReplayTick } from '@algomaker/strategy-kit'
import { PremiumLegBookStrategy } from '../../../strategies/src/premium-leg-book/strategy.ts'
import { BULL_S_1 } from '../../../strategies/src/premium-leg-book/configs/bull-s.ts'
import { resolveDials } from '../../src/dials.ts'
import { EMPTY_RULE_STATE } from '../../src/types.ts'
import type { ChainSnap, EngineAction, LegView, OptType, Quote, RuleState } from '../../src/types.ts'
import { decideBullS } from '../../src/bull-s/decide.ts'

// ── the tape's instruments, exactly as the golden suite defines them ─────────
const FUT = { tradingsymbol: 'BANKNIFTY-FUT', instrumentToken: 999001, lotSize: 35, tickSize: 0.05, exchange: 'NFO' }
const CE = { tradingsymbol: 'BANKNIFTY50000CE', instrumentToken: 999002, lotSize: 35, tickSize: 0.05, exchange: 'NFO' }
const PE = { tradingsymbol: 'BANKNIFTY50000PE', instrumentToken: 999003, lotSize: 35, tickSize: 0.05, exchange: 'NFO' }
const CE2 = { tradingsymbol: 'BANKNIFTY50100CE', instrumentToken: 999004, lotSize: 35, tickSize: 0.05, exchange: 'NFO' }
const PE2 = { tradingsymbol: 'BANKNIFTY50100PE', instrumentToken: 999005, lotSize: 35, tickSize: 0.05, exchange: 'NFO' }

const OPTIONS = [
  { inst: CE, strike: 50_000, opt: 'CE' as const },
  { inst: PE, strike: 50_000, opt: 'PE' as const },
  { inst: CE2, strike: 50_100, opt: 'CE' as const },
  { inst: PE2, strike: 50_100, opt: 'PE' as const },
]
const BY_SYMBOL = new Map(OPTIONS.map((o) => [o.inst.tradingsymbol, o]))

interface Day {
  readonly ticks: readonly ReplayTick[]
  readonly seed: ReadonlyArray<{ token: number; lastPrice: number }>
}

// ── the three days, transcribed from the golden suite ───────────────────────
const DAYS: Readonly<Record<string, Day>> = {
  'day 1 — entry + combined stop': {
    ticks: [
      { ts: 0, quote: { token: FUT.instrumentToken, lastPrice: 50000, ts: 0 } },
      { ts: 1, quote: { token: CE.instrumentToken, lastPrice: 130, ts: 1 } },
      { ts: 2, quote: { token: PE.instrumentToken, lastPrice: 120, ts: 2 } }, // 250 = trunc(200 × 1.25): the stop
    ],
    seed: [{ token: CE.instrumentToken, lastPrice: 100 }, { token: PE.instrumentToken, lastPrice: 100 }],
  },
  'day 2 — flat day, no crossover': {
    ticks: [],
    seed: [],
  },
  'day 3 — the pyramid, uncapped': {
    ticks: [
      { ts: 0, quote: { token: FUT.instrumentToken, lastPrice: 50000, ts: 0 } },
      { ts: 1, quote: { token: FUT.instrumentToken, lastPrice: 50100, ts: 1 } },
    ],
    seed: [
      { token: PE.instrumentToken, lastPrice: 100 }, { token: CE.instrumentToken, lastPrice: 100 },
      { token: PE2.instrumentToken, lastPrice: 90 }, { token: CE2.instrumentToken, lastPrice: 90 },
    ],
  },
}

type Row = string // `${op} ${strike}${optType} ${side} x${lots}`

async function portedSide(day: Day): Promise<Row[]> {
  const parts = makeTestContext({ nowMs: Date.UTC(2026, 6, 24, 3, 46, 0) })
  parts.md.setUnderlying('BANKNIFTY', 260105, 100)
  parts.md.setFuture('BANKNIFTY', FUT)
  for (const o of OPTIONS) parts.md.setOption('BANKNIFTY', o.strike, o.opt, o.inst)
  for (const s of day.seed) parts.md.setQuote({ token: s.token, lastPrice: s.lastPrice, ts: 0 })
  const strategy = new PremiumLegBookStrategy(parts.ctx, BULL_S_1)
  const res = await replay(strategy, parts, day.ticks)
  return res.orders.map((o: RecordedOrder) => {
    const leg = BY_SYMBOL.get(o.symbol)
    if (leg === undefined) throw new Error(`unknown symbol ${o.symbol}`)
    return o.side === 'SELL'
      ? `open ${leg.strike}${leg.opt} Sell x${o.lots}`
      : `close ${leg.strike}${leg.opt} Buy x${o.lots}`
  })
}

/** The ported side's CE-then-PE sale pair, as rule 9 orders it. */
function peFirst(rows: readonly Row[]): Row[] {
  const out = [...rows]
  for (let i = 0; i + 1 < out.length; i++) {
    const a = /^open (\d+)CE Sell (x\d+)$/.exec(out[i]!)
    const b = /^open (\d+)PE Sell (x\d+)$/.exec(out[i + 1]!)
    if (a !== null && b !== null && a[1] === b[1] && a[2] === b[2]) {
      ;[out[i], out[i + 1]] = [out[i + 1]!, out[i]!]
      i++
    }
  }
  return out
}

const DIALS = (() => {
  const { dials, unknown } = resolveDials({
    bs_enabled: true,
    bs_strike_step: 100,
    bs_strike_jump: 1,
    bs_stop_basis: 0,
    bs_stop_mult: 1.25,
    bs_lots_start: 1,
    bs_lots_step: 1,
    bs_lots_cap: 0,
    bs_max_open: 0,
    bs_enter_on_start: true,
    bs_stop_confirm_s: 0,
  })
  assert.deepEqual(unknown, [])
  return dials
})()

const BASE = Date.UTC(2026, 6, 24, 3, 46, 0) // 09:16 IST, the golden suite's clock

function engineSide(day: Day): Row[] {
  const ltp = new Map<number, number>(day.seed.map((s) => [s.token, s.lastPrice]))
  // Legacy reads its future from a cache that starts at 0: no price, no crossing.
  let ref: number | null = null
  let refAsOf = 0
  const held = new Map<string, { strike: number; opt: OptType; lots: number; entry: number }>()
  let cum = 0
  let state: RuleState = EMPTY_RULE_STATE
  const rows: Row[] = []

  const quote = (token: number, asOf: number): Quote | null => {
    const p = ltp.get(token)
    return p === undefined ? null : { bid: p, ask: p, ltp: p, asOf }
  }
  // Day 2's legacy tick is a future at 0 — a price the engine must ignore.
  const tape = day.ticks.length === 0
    ? [{ ts: 0, quote: { token: FUT.instrumentToken, lastPrice: 0, ts: 0 } }]
    : day.ticks
  for (const t of tape) {
    const nowMs = BASE + t.ts * 1_000
    if (t.quote.token === FUT.instrumentToken) {
      ref = t.quote.lastPrice
      refAsOf = nowMs
    } else {
      ltp.set(t.quote.token, t.quote.lastPrice)
    }
    const chain: ChainSnap = {
      symbol: 'BANKNIFTY',
      expiry: '2026-07-30',
      step: 100,
      lotSize: 35,
      future: { bid: ref, ask: ref, ltp: ref, asOf: refAsOf },
      spot: ref ?? 0,
      strikes: [50_000, 50_100].map((k) => ({
        strike: k,
        ce: quote(k === 50_000 ? CE.instrumentToken : CE2.instrumentToken, nowMs),
        pe: quote(k === 50_000 ? PE.instrumentToken : PE2.instrumentToken, nowMs),
      })),
      asOf: nowMs,
    }
    const legs: LegView[] = [...held.entries()].map(([instrument, h]) => {
      const opt = OPTIONS.find((o) => o.inst.tradingsymbol === instrument)!
      const mark = ltp.get(opt.inst.instrumentToken) ?? h.entry
      return {
        instrument, strike: h.strike, optType: h.opt, side: 'Sell', lots: h.lots, lotSize: 35, entry: h.entry,
        openedByEngine: true, leanId: '', iv: null, delta: 0, gamma: 0, theta: 0, vega: 0, hasGreeks: false,
        mtm: -(mark - h.entry) * h.lots * 35,
        exit: { bid: mark, ask: mark, ltp: mark, asOf: nowMs },
      }
    })
    const d = decideBullS(
      {
        tag: 'Bull_S-1', mode: 'paper', nowMs, dateIst: '2026-07-24', minuteOfDay: 556, dte: 6, chain, legs,
        protectedQty: {}, cumRealized: cum, margin: { value: 0, source: 'model', asOf: nowMs, fresh: false },
        pendingLots: 0, repairHold: false, pricing: 'parity', ref, refAsOf, minutesToExpiry: 6 * 1_440, leverage: [],
      },
      DIALS,
      state,
      { isNewMark: false, markIndexToday: 0 },
    )
    state = d.stateAfter
    // Fill everything at the tape price.
    for (const a of d.actions as EngineAction[]) {
      if (a.op === 'open') {
        const o = OPTIONS.find((x) => x.strike === a.strike && x.opt === a.optType)!
        const px = ltp.get(o.inst.instrumentToken)!
        held.set(o.inst.tradingsymbol, { strike: a.strike, opt: a.optType, lots: a.lots, entry: px })
        rows.push(`open ${a.strike}${a.optType} ${a.side} x${a.lots}`)
      } else if (a.op === 'close') {
        const h = held.get(a.instrument)!
        const o = BY_SYMBOL.get(a.instrument)!
        cum += (h.entry - (ltp.get(o.inst.instrumentToken) ?? h.entry)) * h.lots * 35
        held.delete(a.instrument)
        rows.push(`close ${h.strike}${h.opt} Buy x${h.lots}`)
      }
    }
  }
  return rows
}

for (const [name, day] of Object.entries(DAYS)) {
  test(`NSE parity, ${name}: decideBullS emits PremiumLegBookStrategy's sequence`, async () => {
    const ported = await portedSide(day)
    const engine = engineSide(day)
    assert.deepEqual(engine, peFirst(ported))
  })
}

test('NSE parity: the tapes are not vacuous', async () => {
  const day1 = await portedSide(DAYS['day 1 — entry + combined stop']!)
  assert.deepEqual(day1, [
    'open 50000CE Sell x1', 'open 50000PE Sell x1', 'close 50000PE Buy x1', 'close 50000CE Buy x1',
  ])
  const day3 = await portedSide(DAYS['day 3 — the pyramid, uncapped']!)
  assert.deepEqual(day3, [
    'open 50000CE Sell x1', 'open 50000PE Sell x1', 'open 50100CE Sell x2', 'open 50100PE Sell x2',
  ])
  assert.deepEqual(await portedSide(DAYS['day 2 — flat day, no crossover']!), [])
})
