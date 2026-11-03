/**
 * THE ENGINE ON A VENUE'S CLOCK — Delta's 24x7 market and 12:00 UTC expiry.
 *
 * `EngineInputs.venue` absent is NSE, and every other suite in this package
 * runs that way unchanged. These tests are the DX side only: no NSE session
 * gate, tenor priced to the 12:00 UTC instant, no orders once a contract has
 * settled, and quantities on a 0.001 grid that survive the margin model.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_DIALS,
  EMPTY_RULE_STATE,
  decide,
  spanLiteMargin,
  yearFrac,
  type ChainSnap,
  type Dials,
  type EngineInputs,
  type LegView,
  type MarkContext,
  type Quote,
} from '@algomaker/desk-engine'
import { DX, NSE } from '@algomaker/venue'

const IST_MS = 330 * 60_000
const EXPIRY = '2026-11-06' // a Friday
const istDate = (ms: number): string => new Date(ms + IST_MS).toISOString().slice(0, 10)
const istMinute = (ms: number): number => {
  const d = new Date(ms + IST_MS)
  return d.getUTCHours() * 60 + d.getUTCMinutes()
}

const q = (bid: number, ask: number, asOf: number): Quote => ({ bid, ask, ltp: null, asOf })

function chainAt(nowMs: number): ChainSnap {
  return {
    symbol: 'BTC',
    expiry: EXPIRY,
    step: 200,
    lotSize: 0.001,
    future: q(70_000, 70_001, nowMs),
    spot: 70_000,
    strikes: [69_600, 69_800, 70_000, 70_200, 70_400].map((k) => ({
      strike: k,
      ce: q(300, 310, nowMs),
      pe: q(300, 310, nowMs),
    })),
    asOf: nowMs,
  }
}

function legAt(nowMs: number): LegView {
  return {
    instrument: 'C-BTC-70000-061126',
    strike: 70_000,
    optType: 'CE',
    side: 'Sell',
    lots: 50,
    lotSize: 0.001,
    entry: 305,
    openedByEngine: true,
    leanId: '',
    iv: 0.5,
    delta: 0.5,
    gamma: 0.0001,
    theta: 0,
    vega: 0,
    hasGreeks: true,
    mtm: 0,
    exit: q(300, 310, nowMs),
  }
}

function inputsAt(nowMs: number, over: Partial<EngineInputs> = {}): EngineInputs {
  const dateIst = istDate(nowMs)
  const dte = Math.round((Date.parse(`${EXPIRY}T00:00:00Z`) - Date.parse(`${dateIst}T00:00:00Z`)) / 86_400_000)
  return {
    tag: 'BTC-D',
    mode: 'paper',
    nowMs,
    dateIst,
    minuteOfDay: istMinute(nowMs),
    dte,
    chain: chainAt(nowMs),
    legs: [legAt(nowMs)],
    protectedQty: {},
    cumRealized: 0,
    margin: { value: 0, source: 'broker', asOf: nowMs, fresh: true },
    pendingLots: 0,
    repairHold: false,
    pricing: 'live',
    venue: DX,
    ...over,
  }
}

const dials: Dials = { ...DEFAULT_DIALS, shift_enabled: false, margin_cap: 0 }
const mark: MarkContext = { isNewMark: true, markIndexToday: 0 }

// ─────────────────────────────────────────────────── the expiry settle

test('DX: no settle at 15:30 IST on expiry day — the contract trades to 12:00 UTC', () => {
  // 16:00 IST on expiry day: minute 960 ≥ 930 and dte 0, which on NSE is the
  // expiry flatten. On Delta the contract still has 90 minutes of life.
  const now = Date.UTC(2026, 10, 6, 10, 30)
  const d = decide(inputsAt(now), dials, EMPTY_RULE_STATE, mark)
  assert.notEqual(d.trigger, 'expiry')
  assert.doesNotMatch(d.reason, /15:30/)
  assert.doesNotMatch(d.reason, /NSE/)
})

test('DX: the same moment without a venue is the NSE flatten (absent venue = NSE)', () => {
  const now = Date.UTC(2026, 10, 6, 10, 30)
  const { venue: _dx, ...nse } = inputsAt(now)
  const d = decide(nse, dials, EMPTY_RULE_STATE, mark)
  assert.equal(d.trigger, 'expiry')
  assert.equal(d.action, 'flatten')
  const explicit = decide(inputsAt(now, { venue: NSE }), dials, EMPTY_RULE_STATE, mark)
  assert.deepEqual(explicit, d)
})

test('DX: at and after the 12:00:00 UTC expiry instant the engine sends no orders', () => {
  for (const now of [Date.UTC(2026, 10, 6, 12, 0, 0), Date.UTC(2026, 10, 6, 12, 0, 1), Date.UTC(2026, 10, 6, 13)]) {
    const d = decide(inputsAt(now), dials, EMPTY_RULE_STATE, mark)
    assert.equal(d.action, 'hold', new Date(now).toISOString())
    assert.deepEqual(d.actions, [])
    assert.match(d.reason, /settle/i)
    assert.match(d.reason, /12:00 UTC/)
  }
})

test('DX: one second before the instant is still a live market', () => {
  const now = Date.UTC(2026, 10, 6, 11, 59, 59)
  const d = decide(inputsAt(now), dials, EMPTY_RULE_STATE, mark)
  assert.doesNotMatch(d.reason, /settled/i)
  assert.notEqual(d.trigger, 'expiry')
})

test('DX: a Sunday at 03:00 UTC is decided, not held as a non-trading day', () => {
  const now = Date.UTC(2026, 10, 1, 3) // Sunday 1 Nov
  const d = decide(inputsAt(now), dials, EMPTY_RULE_STATE, mark)
  assert.doesNotMatch(d.reason, /trading day/)
  assert.doesNotMatch(d.reason, /09:20/)
})

test('DX: an unparseable chain expiry holds rather than throws', () => {
  const now = Date.UTC(2026, 10, 6, 6)
  const inputs = inputsAt(now)
  const d = decide({ ...inputs, chain: { ...inputs.chain, expiry: 'soon' } }, dials, EMPTY_RULE_STATE, mark)
  assert.equal(d.action, 'hold')
  assert.deepEqual(d.actions, [])
})

// ─────────────────────────────────────────────────────────── the tenor

test('yearFrac DX prices to the 12:00 UTC instant: 06:00Z on expiry day is 6 hours', () => {
  const now = Date.UTC(2026, 10, 6, 6)
  const t = yearFrac(istDate(now), EXPIRY, istMinute(now), DX)
  assert.ok(Math.abs(t - 6 / (365 * 24)) < 1e-12, String(t))
})

test('yearFrac DX runs on calendar time before expiry day, clock included', () => {
  // Thursday 18:00 UTC → Friday 12:00 UTC = 18 hours, which NSE would call 1 day.
  const now = Date.UTC(2026, 10, 5, 18)
  const t = yearFrac(istDate(now), EXPIRY, istMinute(now), DX)
  assert.ok(Math.abs(t - 18 / (365 * 24)) < 1e-12, String(t))
})

test('yearFrac DX is 0 at and after the instant', () => {
  const at = Date.UTC(2026, 10, 6, 12)
  assert.equal(yearFrac(istDate(at), EXPIRY, istMinute(at), DX), 0)
  const after = Date.UTC(2026, 10, 6, 14)
  assert.equal(yearFrac(istDate(after), EXPIRY, istMinute(after), DX), 0)
})

test('yearFrac without a venue is the NSE function, unchanged', () => {
  assert.equal(yearFrac('2026-11-03', EXPIRY, 600), 3 / 365)
  assert.equal(yearFrac('2026-11-03', EXPIRY, 600, NSE), 3 / 365)
  assert.equal(yearFrac(EXPIRY, EXPIRY, 600), (930 - 600) / 1440 / 365)
})

// ───────────────────────────────────────────────────────────── margin

test('margin: lotSize 0.001 × 50 lots is 0.05 BTC of short exposure, not 0', () => {
  const r = spanLiteMargin(
    [{ strike: 70_000, optType: 'CE', side: 'Sell', lots: 50, lotSize: 0.001, iv: 0.5, expiry: EXPIRY }],
    70_000,
    '2026-11-03',
  )
  assert.ok(Math.abs(r.shortNotional - 70_000 * 0.05) < 1e-6, String(r.shortNotional))
  assert.equal(r.shortLots, 50)
  assert.ok(r.total > 0)
})
