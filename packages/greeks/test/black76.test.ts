import { test } from 'node:test'
import assert from 'node:assert/strict'
import { b76Price, b76Greeks, b76ImpliedVol } from '../src/black76.ts'
import * as pkg from '../src/index.ts'

const close = (a: number, b: number, eps: number, what = ''): void => {
  assert.ok(Math.abs(a - b) < eps, `${what} expected ~${b}, got ${a} (eps ${eps})`)
}

const atm = { future: 100, strike: 100, t: 1, vol: 0.2, rate: 0, type: 'CE' as const }

// `black76.ts` imports normCdf/normPdf from `index.ts`, which re-exports
// `black76.ts` — a real ES module cycle. It resolves because both halves are
// hoisted function declarations, but that is a property of HOW they are
// written, not a guarantee: turn either into a `const fn = () =>` and the
// package explodes on import with no type error to warn you. Hence this test.
test('the package re-exports Black-76 despite the import cycle', () => {
  assert.equal(typeof pkg.b76Price, 'function')
  assert.equal(typeof pkg.b76Greeks, 'function')
  assert.equal(typeof pkg.b76ImpliedVol, 'function')
  assert.equal(pkg.b76Price(atm), b76Price(atm))
})

test('ATM call, r=0: classic value', () => {
  assert.ok(Math.abs(b76Price(atm) - 7.9656) < 1e-3)
})

test('put-call parity at F=K, r=0', () => {
  assert.ok(Math.abs(b76Price(atm) - b76Price({ ...atm, type: 'PE' })) < 1e-9)
})

test('greeks at the ATM point', () => {
  const g = b76Greeks(atm)
  assert.ok(Math.abs(g.delta - 0.539828) < 1e-4)
  assert.ok(Math.abs(g.gamma - 0.0198476) < 1e-5)
  assert.ok(Math.abs(g.vega - 0.396953) < 1e-4) // per 1 vol point
  assert.ok(Math.abs(g.theta - -0.010876) < 1e-5) // per calendar day
})

test('expired option prices at intrinsic, zero greeks', () => {
  assert.equal(b76Price({ ...atm, t: 0, future: 110 }), 10)
  assert.deepEqual(b76Greeks({ ...atm, t: 0 }), { delta: 0, gamma: 0, theta: 0, vega: 0 })
})

test('impliedVol round-trips', () => {
  const px = b76Price(atm)
  const iv = b76ImpliedVol(px, { future: 100, strike: 100, t: 1, rate: 0, type: 'CE' })
  assert.ok(iv !== null && Math.abs(iv - 0.2) < 1e-4)
})

test('impliedVol: sub-intrinsic and above-ceiling quotes → null', () => {
  assert.equal(b76ImpliedVol(9.9, { future: 110, strike: 100, t: 0.1, rate: 0, type: 'CE' }), null)
  assert.equal(b76ImpliedVol(99.0, { future: 100, strike: 100, t: 0.05, rate: 0, type: 'CE' }), null)
})

// ------------------------------------------------- beyond the brief's cases

test('put-call parity off the forward: C − P == df·(F − K)', () => {
  const base = { future: 521, strike: 505, t: 0.12, vol: 0.31, rate: 0.065 }
  const c = b76Price({ ...base, type: 'CE' })
  const p = b76Price({ ...base, type: 'PE' })
  close(c - p, Math.exp(-base.rate * base.t) * (base.future - base.strike), 1e-8, 'parity')
})

test('delta matches a numerical derivative in F', () => {
  const base = { strike: 505, t: 0.12, vol: 0.31, rate: 0.065, type: 'PE' as const }
  const h = 0.01
  const up = b76Price({ ...base, future: 521 + h })
  const dn = b76Price({ ...base, future: 521 - h })
  close(b76Greeks({ ...base, future: 521 }).delta, (up - dn) / (2 * h), 1e-5, 'delta')
})

test('gamma matches the second numerical derivative in F', () => {
  const base = { strike: 505, t: 0.12, vol: 0.31, rate: 0.065, type: 'CE' as const }
  const h = 0.05
  const up = b76Price({ ...base, future: 521 + h })
  const mid = b76Price({ ...base, future: 521 })
  const dn = b76Price({ ...base, future: 521 - h })
  close(b76Greeks({ ...base, future: 521 }).gamma, (up - 2 * mid + dn) / (h * h), 1e-6, 'gamma')
})

// The numeric-derivative checks below are bounded by `normCdf`'s own accuracy
// (Abramowitz & Stegun 7.1.26, max abs error 1.5e-7), which a difference of two
// prices at F ~ 521 cannot see past. They are here to pin the UNITS and the
// signs — an eps this loose still separates vega-per-vol-point (0.67) from
// vega-per-1.0-of-vol (67), and theta-per-day from theta-per-year.
test('vega is per 1 vol point, not per 1.0 of vol', () => {
  const base = { future: 521, strike: 505, t: 0.12, rate: 0.065, type: 'CE' as const }
  const up = b76Price({ ...base, vol: 0.31 + 0.005 })
  const dn = b76Price({ ...base, vol: 0.31 - 0.005 })
  close(b76Greeks({ ...base, vol: 0.31 }).vega, up - dn, 1e-4, 'vega')
})

test('theta is per calendar day', () => {
  const base = { future: 521, strike: 505, vol: 0.31, rate: 0.065, type: 'CE' as const }
  const halfDay = 0.5 / 365
  // Centred in t, so the O(h) term drops out: a one-day-wide difference taken
  // AROUND t is the decay rate at t, which is what theta claims to be.
  const before = b76Price({ ...base, t: 0.12 + halfDay })
  const after = b76Price({ ...base, t: 0.12 - halfDay })
  close(b76Greeks({ ...base, t: 0.12 }).theta, after - before, 1e-5, 'theta')
})

test('degenerate inputs return zero greeks, NOT a step delta', () => {
  const zero = { delta: 0, gamma: 0, theta: 0, vega: 0 }
  // Deep ITM at expiry: spot-BS `greeks()` would answer delta 1 here.
  assert.deepEqual(b76Greeks({ ...atm, t: 0, future: 150 }), zero)
  assert.deepEqual(b76Greeks({ ...atm, vol: 0 }), zero)
  assert.deepEqual(b76Greeks({ ...atm, future: 0 }), zero)
  assert.deepEqual(b76Greeks({ ...atm, strike: 0 }), zero)
})

test('a degenerate price is DISCOUNTED intrinsic', () => {
  close(
    b76Price({ future: 110, strike: 100, t: 0.5, vol: 0, rate: 0.065, type: 'CE' }),
    Math.exp(-0.065 * 0.5) * 10,
    1e-12,
    'discounted intrinsic',
  )
  assert.equal(b76Price({ future: 90, strike: 100, t: 0, vol: 0.2, rate: 0.065, type: 'CE' }), 0)
})

test('impliedVol round-trips a real put off the forward', () => {
  const i = { future: 521, strike: 505, t: 0.12, rate: 0.065, type: 'PE' as const }
  const iv = b76ImpliedVol(b76Price({ ...i, vol: 0.274 }), i)
  assert.ok(iv !== null && Math.abs(iv - 0.274) < 1e-4, `expected ~0.274, got ${iv}`)
})

test('impliedVol: degenerate inputs → null', () => {
  const i = { future: 100, strike: 100, rate: 0, type: 'CE' as const }
  assert.equal(b76ImpliedVol(5, { ...i, t: 0 }), null)
  assert.equal(b76ImpliedVol(5, { ...i, t: -1 }), null)
  assert.equal(b76ImpliedVol(5, { ...i, t: 1, future: 0 }), null)
  assert.equal(b76ImpliedVol(5, { ...i, t: 1, strike: 0 }), null)
})

test('impliedVol honours a lowered ceiling — the pinned bound is refused', () => {
  const i = { future: 100, strike: 100, t: 1, rate: 0, type: 'CE' as const }
  const px = b76Price({ ...i, vol: 1.2 })
  assert.ok(b76ImpliedVol(px, i) !== null, 'solvable under the default ceiling')
  assert.equal(b76ImpliedVol(px, i, { hiVol: 0.8 }), null, 'above the lowered ceiling')
})

// ------------------------------------------------------- parity with Python
//
// The point of porting this pricer rather than writing a new one is that the
// two sides of the bridge can be compared number-for-number. These references
// are the OUTPUT of the Python original — `sensibull_tools/gfdl/greeks.py`,
// BACKEND "python" — run over the same inputs.
//
// The two do not agree bit-for-bit and cannot: Python uses `math.erf`, this
// package uses Abramowitz & Stegun 7.1.26 (max abs CDF error 1.5e-7). Every
// tolerance below is that error budget carried through, plus the 8-10 decimal
// places the Python rounds its greeks to. Anything WIDER than these would stop
// catching a real formula difference, which is the whole job of the table.
const PARITY = [
  {
    i: { type: 'CE', future: 100, strike: 100, t: 1, rate: 0, vol: 0.2 },
    price: 7.965567455405804,
    g: { delta: 0.53982784, gamma: 0.0198476274, theta: -0.01087541, vega: 0.39695255 },
    iv: 0.19999999671876428,
  },
  {
    i: { type: 'PE', future: 100, strike: 100, t: 1, rate: 0, vol: 0.2 },
    price: 7.965567455405804,
    g: { delta: -0.46017216, gamma: 0.0198476274, theta: -0.01087541, vega: 0.39695255 },
    iv: 0.19999999671876428,
  },
  {
    i: { type: 'CE', future: 521, strike: 505, t: 0.12, rate: 0.065, vol: 0.31 },
    price: 30.64624778767245,
    g: { delta: 0.6297035, gamma: 0.0066682723, theta: -0.23282339, vega: 0.67333581 },
    iv: 0.3099999940000475,
  },
  {
    i: { type: 'PE', future: 521, strike: 505, t: 0.12, rate: 0.065, vol: 0.31 },
    price: 14.770562330680708,
    g: { delta: -0.36252684, gamma: 0.0066682723, theta: -0.23565056, vega: 0.67333581 },
    iv: 0.3099999940000475,
  },
  {
    // A weekly index call, ~7 calendar days out.
    i: { type: 'CE', future: 24800, strike: 25200, t: 0.0192, rate: 0.065, vol: 0.11 },
    price: 28.814540726994654,
    g: { delta: 0.14849047, gamma: 0.0006124124, theta: -6.23810619, vega: 7.95501977 },
    iv: 0.1100000008481089,
  },
  {
    // Expiry morning, high vol — where every approximation is worst.
    i: { type: 'PE', future: 24800, strike: 24000, t: 0.0027, rate: 0.065, vol: 0.45 },
    price: 20.80679548254229,
    g: { delta: -0.07866664, gamma: 0.0002531176, theta: -43.1807926, vega: 1.89148101 },
    iv: 0.4500000015461818,
  },
  {
    i: { type: 'CE', future: 1500, strike: 1500, t: 2, rate: 0.07, vol: 0.9 },
    price: 620.0459233175242,
    g: { delta: 0.64136109, gamma: 0.0001483595, theta: -0.25147782, vega: 6.00856084 },
    iv: 0.8999999995255377,
  },
] as const

test('prices, greeks and IV match the Python original', () => {
  for (const row of PARITY) {
    const { vol, ...rest } = row.i
    const i = { ...rest, vol }
    const what = `${i.type}/${i.future}/${i.strike}/${i.t}/${i.rate}/${i.vol}`
    const px = b76Price(i)
    close(px / row.price, 1, 1e-5, `${what} price`)
    const g = b76Greeks(i)
    close(g.delta, row.g.delta, 2e-7, `${what} delta`)
    close(g.gamma, row.g.gamma, 1e-9, `${what} gamma`)
    close(g.theta, row.g.theta, 1e-6, `${what} theta`)
    close(g.vega, row.g.vega, 1e-7, `${what} vega`)
    // `rest` carries no `vol` — the solver is given only what a quote gives it.
    const iv = b76ImpliedVol(px, rest)
    assert.ok(iv !== null, `${what} iv must solve`)
    close(iv, row.iv, 1e-5, `${what} iv`)
  }
})

test('degenerate cases match the Python original', () => {
  const zero = { delta: 0, gamma: 0, theta: 0, vega: 0 }
  const expired = { type: 'CE' as const, future: 110, strike: 100, t: 0, rate: 0.065, vol: 0.2 }
  assert.equal(b76Price(expired), 10)
  assert.deepEqual(b76Greeks(expired), zero)
  assert.equal(b76ImpliedVol(10, expired), null)

  const zeroVol = { type: 'PE' as const, future: 90, strike: 100, t: 0.5, rate: 0, vol: 0 }
  assert.equal(b76Price(zeroVol), 10)
  assert.deepEqual(b76Greeks(zeroVol), zero)
})

test('IV edge cases match the Python original', () => {
  // A quote well inside the bracket: a genuine 119.97% vol, not a pinned bound.
  const rich = b76ImpliedVol(45.1393, { future: 100, strike: 100, t: 1, rate: 0, type: 'CE' })
  assert.ok(rich !== null, 'a 120% vol quote is a real root, not a pinned bound')
  close(rich, 1.1996976, 1e-5, 'rich ATM call iv')
  // A near-worthless weekly call still solves, at a low but real vol.
  const cheap = b76ImpliedVol(0.05, {
    future: 24800,
    strike: 25200,
    t: 0.0192,
    rate: 0.065,
    type: 'CE',
  })
  assert.ok(cheap !== null, 'a near-worthless call still has an IV')
  close(cheap, 0.0384325, 1e-5, 'cheap weekly call iv')
})
