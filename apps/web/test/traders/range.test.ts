import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rangeRows, type RangeInput, type RangeRow } from '../../src/traders/range.ts'

const BASE: RangeInput = { cmp: 7229, startDate: '2026-10-19', vol: 27.7, iterations: 30, step: 1 }

function rows(input: RangeInput): RangeRow[] {
  const r = rangeRows(input)
  assert.ok(Array.isArray(r), JSON.stringify(r))
  return r
}

const near = (a: number, b: number, tol: number): void => assert.ok(Math.abs(a - b) <= tol, `${a} is not within ${tol} of ${b}`)

test('the VolHedge screenshot, exactly', () => {
  const r = rows(BASE)
  assert.equal(r.length, 30)
  const first = r[0]!
  assert.equal(first.day, 1)
  assert.equal(first.date, '2026-10-20')
  assert.equal(first.changePct.toFixed(2), '1.45')
  assert.equal(Math.round(first.s1.lower), 7124)
  assert.equal(Math.round(first.s1.upper), 7334)
  assert.equal(Math.round(first.s1.points), 105)
  near(first.s2.lower, 7019.376, 1e-3)
  near(first.s3.upper, 7543.436, 1e-3)
  const last = r[29]!
  assert.equal(last.day, 30)
  near(last.changePct, 7.9413, 1e-3)
  near(last.s1.points, 574.08, 1e-2)
})

test('step 5 gives days 5, 10, 15', () => {
  const r = rows({ ...BASE, iterations: 3, step: 5 })
  assert.deepEqual(r.map((x) => x.day), [5, 10, 15])
  assert.deepEqual(r.map((x) => x.date), ['2026-10-24', '2026-10-29', '2026-11-03'])
})

test('errors name the field', () => {
  const err = (over: Partial<RangeInput>): string => {
    const r = rangeRows({ ...BASE, ...over })
    assert.ok(!Array.isArray(r))
    return r.error
  }
  assert.match(err({ cmp: 0 }), /cmp/)
  assert.match(err({ vol: -1 }), /vol/)
  assert.match(err({ iterations: 0 }), /iterations/)
  assert.match(err({ iterations: 400 }), /iterations/)
  assert.match(err({ startDate: '19-10-2026' }), /startDate/)
  assert.match(err({ startDate: '2026-02-30' }), /startDate/)
  assert.match(err({ step: 0 }), /step/)
  assert.match(err({ cmp: Number.NaN }), /cmp/)
  assert.match(err({ iterations: 1, step: 1e9 }), /step/)
  assert.match(err({ iterations: 30, step: 122 }), /step/)
  assert.equal(Array.isArray(rangeRows({ ...BASE, iterations: 30, step: 121 })), true)
})
