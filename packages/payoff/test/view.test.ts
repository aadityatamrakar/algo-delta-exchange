/**
 * THE ANSWER THE COCKPIT DRAWS — and the one place in this package where money
 * already BANKED is added back in.
 *
 * Everything underneath (`legs`, `expiry`, `surface`, `margin`) prices the OPEN
 * legs against their own entries and nothing else, deliberately: a surface
 * shifted by realised P&L would claim the surviving legs are worth more than
 * they can ever earn. But the question a human asks at 14:50 is not "what are
 * these three legs worth", it is "where does this RUN break even" — so the view
 * layer applies the offset, once, to every curve, every table cell and every
 * summary field that answers a book-level question. This suite's job is to pin
 * that it is applied EVERYWHERE and never twice.
 *
 * The book is a real short strangle, deliberately ASYMMETRIC (670PE/720CE off a
 * 700 future) so that the worst point on the scan is a unique price. A
 * symmetric one has two equal minima and `maxLossAt` would then be pinned to a
 * tie-break rather than to an answer.
 *
 * Hand-computed, not fixture-driven: there is no Python `build_payoff_view` to
 * be in parity with. Where a value is a composition of already-parity-tested
 * functions the test asserts the composition (`curve[i].expiry` IS
 * `expiryPnlAt + realised`, at every one of 121 points); where it is new
 * arithmetic (the mid date, the table's labels, the breakeven guard) the
 * expected value is written out by hand.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { close, type Tolerance } from './helpers.ts'
import { legGreeks, legPnl, type PayoffLeg } from '../src/legs.ts'
import { expiryBreakevens, expiryPnlAt } from '../src/expiry.ts'
import { buildPayoffView, type PayoffView } from '../src/view.ts'

const FUTURE = 700
const TODAY = '2026-08-19'
const EXPIRY = '2026-09-25'
/** 12 days left in August + 25 in September. Calendar days, over 365. */
const T0 = 37 / 365
/** Halfway is 18 days on (floor of 18.5), i.e. 2026-09-06, leaving 19. */
const MID_DATE = '2026-09-06'
const T_MID = 19 / 365
const REALISED = 50_000
const TARGET = 75_000
const RATE = 0.065

const PE: PayoffLeg = {
  id: 'pe670',
  instrument: 'option',
  qty: -3000,
  strike: 670,
  type: 'PE',
  expiry: EXPIRY,
  entry: 10,
  iv: 0.3,
}
const CE: PayoffLeg = {
  id: 'ce720',
  instrument: 'option',
  qty: -3000,
  strike: 720,
  type: 'CE',
  expiry: EXPIRY,
  entry: 12,
  iv: 0.26,
}
const LEGS = [PE, CE]

/** Book rupees on a ₹116,000 book. Float noise only — nothing here is approximate. */
const RUPEES: Tolerance = { abs: 1e-6, rel: 1e-12 }
/** Prices on a 700 ladder; 1e-9 is float reassociation, not disagreement. */
const PRICE: Tolerance = { abs: 1e-9, rel: 0 }

function reportAll(fails: readonly string[], what: string): void {
  assert.equal(
    fails.length,
    0,
    `${fails.length} ${what} mismatches:\n` +
      fails.slice(0, 20).join('\n') +
      (fails.length > 20 ? `\n… and ${fails.length - 20} more` : ''),
  )
}

function view(over: Partial<Parameters<typeof buildPayoffView>[0]> = {}): PayoffView {
  return buildPayoffView({
    legs: LEGS,
    future: FUTURE,
    expiry: EXPIRY,
    today: TODAY,
    realised: REALISED,
    targetPnl: TARGET,
    rate: RATE,
    ...over,
  })
}

/** The book's mark-to-market at `price` with `t` years left, by hand. */
function markAt(price: number, t: number): number {
  return LEGS.reduce((sum, leg) => sum + legPnl(leg, price, t, RATE), 0)
}

// ------------------------------------------------------------------ the curves

test('every curve point is the exact expiry payoff plus the money already banked', () => {
  const v = view()

  // 121 points, ±10%, step band/60 — dense enough that the chart needs no
  // smoothing and the floor is read off the curve rather than interpolated.
  assert.equal(v.curve.length, 121)
  assert.ok(close(v.curve[0]?.price ?? 0, 630, PRICE))
  assert.ok(close(v.curve[120]?.price ?? 0, 770, PRICE))
  assert.ok(close(v.curve[60]?.price ?? 0, 700, PRICE))

  const fails: string[] = []
  let prev = -Infinity
  for (const p of v.curve) {
    if (!(p.price > prev)) fails.push(`prices not strictly ascending at ${p.price}`)
    prev = p.price
    const wantExpiry = expiryPnlAt(LEGS, p.price) + REALISED
    if (!close(p.expiry, wantExpiry, RUPEES)) {
      fails.push(`expiry@${p.price}: want ${wantExpiry}, got ${p.expiry}`)
    }
    const wantT0 = markAt(p.price, T0) + REALISED
    if (!close(p.t0, wantT0, RUPEES)) fails.push(`t0@${p.price}: want ${wantT0}, got ${p.t0}`)
    const wantMid = markAt(p.price, T_MID) + REALISED
    if (!close(p.mid, wantMid, RUPEES)) fails.push(`mid@${p.price}: want ${wantMid}, got ${p.mid}`)
  }
  reportAll(fails, 'curve')
})

test('the three expiry values that were worked out on paper', () => {
  // Credit 3000x10 + 3000x12 = 66,000, plus 50,000 banked = 116,000 at rest.
  // 40 points through the put at 3000 shares costs 120,000; 50 through the call
  // costs 150,000. Nothing here comes out of the implementation.
  const v = view()
  const at = (price: number): number => {
    const p = v.curve.find((c) => close(c.price, price, PRICE))
    assert.ok(p !== undefined, `no curve point at ${price}`)
    return p.expiry
  }
  assert.ok(close(at(630), 116_000 - 120_000, RUPEES), `630: ${at(630)}`)
  assert.ok(close(at(700), 116_000, RUPEES), `700: ${at(700)}`)
  assert.ok(close(at(770), 116_000 - 150_000, RUPEES), `770: ${at(770)}`)
})

test('the mid date is the calendar halfway point, and it is what mid is priced on', () => {
  const v = view()
  assert.equal(v.midDate, MID_DATE)
  // Not merely announced — used. At spot, the half-life mark must sit strictly
  // between today's mark and the expiry payoff for a short-premium book.
  const spot = v.curve[60]
  assert.ok(spot !== undefined)
  assert.ok(spot.t0 < spot.mid, `t0 ${spot.t0} !< mid ${spot.mid}`)
  assert.ok(spot.mid < spot.expiry, `mid ${spot.mid} !< expiry ${spot.expiry}`)
})

// ------------------------------------------------------------------- the table

test('the table is spot, every strike, both breakevens and the standard moves', () => {
  const v = view()
  // 700 spot, strikes 670/720, breakevens 631.33/758.67, and +-{1,2,3,5,8}%.
  // Fifteen distinct prices: nothing collides inside the 0.01 dedupe window
  // (the nearest pair is 720 and 721 = +3%).
  assert.deepEqual(
    v.table.map((r) => r.label),
    [
      'BE 631.33',
      '-8%',
      '-5%',
      'strike 670',
      '-3%',
      '-2%',
      '-1%',
      'spot',
      '+1%',
      '+2%',
      'strike 720',
      '+3%',
      '+5%',
      '+8%',
      'BE 758.67',
    ],
  )

  const fails: string[] = []
  let prev = -Infinity
  for (const r of v.table) {
    if (!(r.price > prev)) fails.push(`table not ascending at ${r.label} (${r.price})`)
    prev = r.price
    // Every row carries the same three numbers the curve does, at ITS price —
    // read off the same arithmetic, never interpolated from the chart.
    const wantExpiry = expiryPnlAt(LEGS, r.price) + REALISED
    if (!close(r.expiry, wantExpiry, RUPEES)) {
      fails.push(`${r.label}.expiry: want ${wantExpiry}, got ${r.expiry}`)
    }
    if (!close(r.t0, markAt(r.price, T0) + REALISED, RUPEES)) fails.push(`${r.label}.t0`)
    if (!close(r.mid, markAt(r.price, T_MID) + REALISED, RUPEES)) fails.push(`${r.label}.mid`)
  }
  reportAll(fails, 'table')

  const spot = v.table.find((r) => r.label === 'spot')
  assert.ok(spot !== undefined && close(spot.price, FUTURE, PRICE))
  const strikes = v.table.filter((r) => r.label.startsWith('strike ')).map((r) => r.price)
  assert.deepEqual(strikes, [670, 720])
  // A breakeven row is worth ~zero at expiry BY DEFINITION — the cheapest
  // possible check that the row prices and the breakeven maths agree.
  for (const r of v.table.filter((x) => x.label.startsWith('BE '))) {
    assert.ok(Math.abs(r.expiry) < 1e-6, `${r.label} is not flat at expiry: ${r.expiry}`)
  }
})

// ----------------------------------------------------------------- the summary

test('the summary is the realised-shifted book, floor and maxLoss the same number', () => {
  const v = view()

  // Breakevens are the EXACT kinks method, realised-shifted — not the surface's
  // grid-interpolated ones. Compared against a direct call so a future change
  // to either has to break this.
  assert.deepEqual(v.summary.breakevens, expiryBreakevens(LEGS, FUTURE, REALISED))
  assert.ok(v.summary.breakevens.down !== null && v.summary.breakevens.up !== null)
  assert.ok(close(v.summary.breakevens.down, 670 - 116_000 / 3000, { abs: 1e-9, rel: 0 }))
  assert.ok(close(v.summary.breakevens.up, 720 + 116_000 / 3000, { abs: 1e-9, rel: 0 }))

  // The floor IS the max loss: one number, two names, because the chart draws a
  // line and the summary prints a figure and they must not be able to disagree.
  assert.equal(v.summary.floor, v.summary.maxLoss)
  assert.ok(close(v.summary.maxLoss, 116_000 - 150_000, RUPEES))
  assert.ok(close(v.summary.maxLossAt, 770, PRICE))
  assert.ok(close(v.summary.maxProfit, 116_000, RUPEES))

  // Premium collected on the option legs, which realised must NOT touch.
  assert.ok(close(v.summary.netCredit, 66_000, RUPEES))
  assert.equal(v.summary.booked, REALISED)
  assert.equal(v.summary.targetPnl, TARGET)
  assert.ok(v.summary.pop > 0 && v.summary.pop < 1, `pop ${v.summary.pop}`)

  // Worst same-day shock is book-level, so it carries the banked money too.
  const worst = Math.min(...[0.9, 0.95, 1.05, 1.1].map((m) => markAt(FUTURE * m, T0)))
  assert.ok(close(v.summary.worstShock, worst + REALISED, { abs: 1e-6, rel: 1e-9 }))

  assert.deepEqual(v.warnings, [])
})

test('the greeks are the book now, at spot, summed from the legs', () => {
  const v = view()
  const want = LEGS.map((l) => legGreeks(l, FUTURE, T0, RATE))
  const fails: string[] = []
  for (const k of ['delta', 'gamma', 'theta', 'vega'] as const) {
    const sum = want.reduce((a, g) => a + g[k], 0)
    if (!close(v.greeks[k], sum, { abs: 1e-9, rel: 1e-9 })) {
      fails.push(`${k}: want ${sum}, got ${v.greeks[k]}`)
    }
  }
  reportAll(fails, 'greeks')
  // A short strangle is short gamma and short vega, and collects theta.
  assert.ok(v.greeks.gamma < 0 && v.greeks.vega < 0 && v.greeks.theta > 0)
})

test('realised shifts everything exactly once — the same book with none banked', () => {
  const withMoney = view()
  const without = view({ realised: 0 })
  const fails: string[] = []
  for (let i = 0; i < withMoney.curve.length; i++) {
    const a = withMoney.curve[i]
    const b = without.curve[i]
    if (a === undefined || b === undefined) {
      fails.push(`curve length mismatch at ${i}`)
      continue
    }
    for (const k of ['expiry', 't0', 'mid'] as const) {
      if (!close(a[k] - b[k], REALISED, RUPEES)) {
        fails.push(`curve[${i}].${k}: shift ${a[k] - b[k]}, want ${REALISED}`)
      }
    }
  }
  reportAll(fails, 'realised shift')
  assert.ok(close(withMoney.summary.maxLoss - without.summary.maxLoss, REALISED, RUPEES))
  assert.ok(close(withMoney.summary.maxProfit - without.summary.maxProfit, REALISED, RUPEES))
  assert.ok(close(withMoney.summary.worstShock - without.summary.worstShock, REALISED, RUPEES))
  // netCredit is a property of the OPEN legs' entries. Shifting it by banked
  // money would report a credit that was never collected.
  assert.equal(withMoney.summary.netCredit, without.summary.netCredit)
})

// -------------------------------------------------- the 3x endpoint, guarded

test('the 3x endpoint artefact is never presented as an upside breakeven', () => {
  // A put sold for nothing is worth nothing above its strike, so the expiry
  // payoff is flat at EXACTLY zero out to `expiryBreakevens`' synthetic 3x
  // endpoint — which the Python, and therefore our port, then reports as a
  // crossing. It is faithful and it is meaningless: no desk defends a level at
  // three times spot. See expiry.ts:129-140 and expiry.test.ts.
  const freebie: PayoffLeg = { ...PE, id: 'pe670_free', entry: 0 }
  const direct = expiryBreakevens([freebie], FUTURE, 0)
  assert.deepEqual(direct, { down: 700, up: 2100 }, 'the quirk itself must still be there')

  const v = view({ legs: [freebie], realised: 0 })
  assert.equal(v.summary.breakevens.up, null)
  assert.equal(v.summary.breakevens.down, 700)
  assert.ok(
    v.warnings.some((w) => w.includes('2100')),
    `no warning naming the discarded level: ${JSON.stringify(v.warnings)}`,
  )
  // And it must not reach the table as a row either.
  assert.ok(!v.table.some((r) => r.price > 800), `table reached the artefact: ${JSON.stringify(v.table.map((r) => r.label))}`)
})

// ------------------------------------------------------------------ fail-soft

test('nothing the caller can pass makes the view throw', () => {
  const bad = [
    ['no legs', view({ legs: [] })],
    ['null legs', view({ legs: null as unknown as PayoffLeg[] })],
    ['future 0', view({ future: 0 })],
    ['future NaN', view({ future: Number.NaN })],
    ['bad today', view({ today: 'yesterday' })],
    ['bad expiry', view({ expiry: '2026-02-31' })],
    ['no inputs', buildPayoffView(undefined as unknown as Parameters<typeof buildPayoffView>[0])],
  ] as const

  const fails: string[] = []
  for (const [what, v] of bad) {
    if (v.warnings.length === 0) fails.push(`${what}: degraded silently`)
    if (v.curve.length !== 0 || v.table.length !== 0) fails.push(`${what}: drew a curve anyway`)
    const nums = [
      v.summary.maxProfit,
      v.summary.maxLoss,
      v.summary.maxLossAt,
      v.summary.floor,
      v.summary.pop,
      v.summary.netCredit,
      v.summary.worstShock,
      v.summary.booked,
      v.greeks.delta,
      v.greeks.gamma,
      v.greeks.theta,
      v.greeks.vega,
    ]
    if (!nums.every(Number.isFinite)) fails.push(`${what}: emitted a non-finite summary`)
    if (v.summary.breakevens.down !== null || v.summary.breakevens.up !== null) {
      fails.push(`${what}: invented a breakeven`)
    }
  }
  reportAll(fails, 'fail-soft')
})

test('an unreadable realised is treated as nothing banked, and said so', () => {
  const v = view({ realised: Number.NaN })
  assert.equal(v.summary.booked, 0)
  assert.ok(
    v.warnings.some((w) => w.toLowerCase().includes('realised')),
    JSON.stringify(v.warnings),
  )
  // Everything else still prices — an unknown banked figure must cost the
  // OFFSET, not the whole answer.
  assert.equal(v.curve.length, 121)
  assert.ok(close(v.curve[60]?.expiry ?? 0, 66_000, RUPEES))
})

test('a leg on another expiry is priced at the book tenor, and named', () => {
  // Mixed expiries are deferred (design: v1.5+). The book's own tenor is used
  // for every leg, so a stray leg is a WRONG mark, not a missing one — it has
  // to be visible.
  const stray: PayoffLeg = { ...CE, id: 'ce720_next', expiry: '2026-10-30' }
  const v = view({ legs: [PE, stray] })
  assert.ok(
    v.warnings.some((w) => w.includes('ce720_next') && w.includes('2026-10-30')),
    JSON.stringify(v.warnings),
  )
  assert.equal(v.curve.length, 121)
})

test('a book whose expiry has passed marks at intrinsic, and says so', () => {
  const v = view({ today: '2026-09-26' })
  assert.ok(
    v.warnings.some((w) => w.includes('2026-09-25') && w.includes('2026-09-26')),
    JSON.stringify(v.warnings),
  )
  // Nothing left to decay: all three curves collapse onto the expiry payoff.
  const fails: string[] = []
  for (const p of v.curve) {
    if (!close(p.t0, p.expiry, RUPEES)) fails.push(`t0@${p.price}: ${p.t0} vs ${p.expiry}`)
    if (!close(p.mid, p.expiry, RUPEES)) fails.push(`mid@${p.price}: ${p.mid} vs ${p.expiry}`)
  }
  reportAll(fails, 'expired book')
  assert.equal(v.midDate, '2026-09-26')
})

test('a target is echoed, including its absence', () => {
  assert.equal(view({ targetPnl: null }).summary.targetPnl, null)
  assert.equal(view({ targetPnl: 0 }).summary.targetPnl, 0)
  assert.equal(view({ targetPnl: Number.NaN }).summary.targetPnl, null)
})
