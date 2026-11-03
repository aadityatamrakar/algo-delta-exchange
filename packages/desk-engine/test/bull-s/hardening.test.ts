/**
 * BULL-S hardening before live money (lane A, 3 Nov):
 *
 *   1. a STALE quote on a held leg — opens refused, named, the stop never read
 *      as safe off it, and after `bs_stale_exit_s` the straddle is closed
 *      (`bs-stale`);
 *   2. a LEG SIZE MISMATCH — the excess on the larger leg is bought back
 *      (`bs-balance`), the smaller leg is never added to;
 *   3. a HALF straddle is closed without waiting on an unrelated working order.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Run, T0, closesOf, dialsOf, key, model, opensOf, q, sym } from './fixture.ts'
import type { EngineDecision } from '../../src/types.ts'

const S = 1_000

/** The model's quote for a leg, but timestamped `asOf` — a frozen book frame. */
const frozen = (strike: number, opt: 'CE' | 'PE', ref: number, asOf: number) => {
  const m = model(strike, opt, ref, asOf)
  return q(m.bid, m.ask, m.ltp, asOf)
}

const resizesOf = (d: EngineDecision): string[] =>
  d.actions.flatMap((a) => (a.op === 'resize' ? [`${a.instrument}→${a.targetLots}`] : []))

// ── 1. stale quote on a held leg ───────────────────────────────────────────

test('a held leg whose quote is older than bs_quote_max_age_s refuses new straddles and names the leg', () => {
  const run = new Run(dialsOf())
  assert.equal(run.dials.bs_quote_max_age_s, 20, 'the default')
  assert.equal(run.dials.bs_stale_exit_s, 120, 'the default')
  run.tick(80_090, T0) // sells 80,000
  run.tick(80_090, T0 + 25 * S) // fresh, no crossing — keeps the reference unbroken
  // 30 s on, the 80,000 CE's book frame is from T0+5s: 25 s old. 80,200 is crossed.
  const d = run.tick(80_250, T0 + 30 * S, {
    chain: { quotes: { [key(80_000, 'CE')]: frozen(80_000, 'CE', 80_090, T0 + 5 * S) } },
  })
  assert.deepEqual(opensOf(d), [], 'no new straddle on a book that cannot see a leg it holds')
  assert.match(d.reason, /80000CE/)
  assert.match(d.reason, /stale/)
  assert.match(d.reason, /25s old/)
  assert.equal(d.markState.bs.groups[0]?.staleSinceMs, T0 + 25 * S, 'stale from the moment it passed the max age')
  // Fresh again: the clock clears, and the next crossing sells.
  run.tick(80_250, T0 + 31 * S)
  assert.equal(run.state.bs.groups[0]?.staleSinceMs, 0)
  assert.deepEqual(opensOf(run.tick(80_450, T0 + 32 * S)), ['Sell 80400PE x100', 'Sell 80400CE x100'])
})

test('a held leg with NO quote at all is stale too, from the first pass that sees it so', () => {
  const run = new Run(dialsOf())
  run.tick(80_090, T0)
  const d = run.tick(80_250, T0 + 5 * S, { chain: { quotes: { [key(80_000, 'PE')]: null } } })
  assert.deepEqual(opensOf(d), [])
  assert.match(d.reason, /80000PE/)
  assert.equal(d.markState.bs.groups[0]?.staleSinceMs, T0 + 5 * S)
})

test('a stale quote under the stop line never resets the breach clock: the straddle is not known to be safe', () => {
  const run = new Run(dialsOf({ bs_stop_confirm_s: 10 }))
  run.tick(80_090, T0)
  const g = run.state.bs.groups[0]!
  const ask = (entry: number, r: number, asOf: number) => q(entry * r - 4, entry * r, entry * r, asOf)
  // Breached on fresh quotes at 1 s.
  run.tick(80_090, T0 + S, {
    chain: { quotes: { [key(80_000, 'CE')]: ask(g.ceEntry, 1.3, T0 + S), [key(80_000, 'PE')]: ask(g.peEntry, 1.3, T0 + S) } },
  })
  assert.equal(run.state.bs.groups[0]?.breachSinceMs, T0 + S)
  // 30 s later the CE's quote is frozen at a calm price; the PE is fresh and calm.
  const d = run.tick(80_090, T0 + 31 * S, {
    chain: {
      quotes: {
        [key(80_000, 'CE')]: ask(g.ceEntry, 1.0, T0 + 2 * S),
        [key(80_000, 'PE')]: ask(g.peEntry, 1.0, T0 + 31 * S),
      },
    },
  })
  assert.equal(d.markState.bs.groups[0]?.breachSinceMs, T0 + S, 'the clock is left where it was')
  assert.match(d.reason, /80000CE/)
})

test('stale past bs_stale_exit_s closes the whole straddle with bs-stale; 0 is off', () => {
  const run = new Run(dialsOf())
  run.tick(80_090, T0)
  const at = (s: number) => ({
    chain: { quotes: { [key(80_000, 'CE')]: frozen(80_000, 'CE', 80_090, T0) } },
    refAsOf: T0 + s * S,
  })
  // Stale from T0+20s. At 139 s it has been stale 119 s: held, opens refused.
  const before = run.tick(80_090, T0 + 139 * S, at(139))
  assert.deepEqual(closesOf(before), [])
  const d = run.tick(80_090, T0 + 140 * S, at(140))
  assert.equal(d.trigger, 'bs-stale')
  assert.deepEqual(closesOf(d), [sym(80_000, 'PE'), sym(80_000, 'CE')], 'PE then CE, the whole group')
  assert.match(d.reason, /80000/)
  assert.match(d.reason, /stale/)

  const off = new Run(dialsOf({ bs_stale_exit_s: 0 }))
  off.tick(80_090, T0)
  const held = off.tick(80_250, T0 + 600 * S, {
    chain: { quotes: { [key(80_000, 'CE')]: frozen(80_000, 'CE', 80_090, T0) } },
  })
  assert.deepEqual(held.actions, [], 'off: no exit — but still no new straddle')
  assert.match(held.reason, /stale/)
})

// ── 2. leg size mismatch ───────────────────────────────────────────────────

test('a straddle whose CE and PE sizes differ buys back the excess on the larger leg (bs-balance)', () => {
  const run = new Run(dialsOf())
  run.tick(80_090, T0)
  run.tick(80_090, T0 + S) // settled: the straddle opened
  // The CE is somehow 70 held against the PE's 50 (a partial close, a manual fill).
  const ce = run.book.get(sym(80_000, 'CE'))!
  run.book.set(sym(80_000, 'CE'), { ...ce, lots: 70 })
  const d = run.tick(80_090, T0 + 2 * S)
  assert.equal(d.trigger, 'bs-balance')
  assert.deepEqual(resizesOf(d), [`${sym(80_000, 'CE')}→50`])
  assert.deepEqual(opensOf(d), [], 'never adds to the smaller leg')
  assert.match(d.reason, /true straddle/)
  assert.match(d.reason, /CE 70/)
  assert.equal(run.book.get(sym(80_000, 'CE'))?.lots, 50)
  // Balanced: nothing more.
  assert.deepEqual(run.tick(80_090, T0 + 3 * S).actions, [])
})

test('the balance waits while an order works, and an ADOPTED mismatched pair is balanced too', () => {
  const run = new Run(dialsOf())
  run.tick(80_090, T0)
  run.tick(80_090, T0 + S)
  const pe = run.book.get(sym(80_000, 'PE'))!
  run.book.set(sym(80_000, 'PE'), { ...pe, lots: 80 })
  assert.deepEqual(resizesOf(run.tick(80_090, T0 + 2 * S, { pendingLots: 10, fill: false })), [], 'something is pending')
  // The book's row lost the straddle: it is adopted at max(ce, pe) — and balanced in the same pass.
  run.state = { ...run.state, bs: { ...run.state.bs, groups: [] } }
  const d = run.tick(80_090, T0 + 3 * S)
  assert.equal(d.trigger, 'bs-balance')
  assert.deepEqual(resizesOf(d), [`${sym(80_000, 'PE')}→50`])
})

// ── 3. half straddle and a working order ───────────────────────────────────

test('a half straddle is closed even while an UNRELATED order of the book is working', () => {
  const run = new Run(dialsOf())
  run.tick(80_090, T0)
  run.tick(80_090, T0 + S) // settled, filled
  run.book.delete(sym(80_000, 'CE')) // the CE is gone (assigned, closed by hand)
  const d = run.tick(80_090, T0 + 2 * S, { pendingLots: 100, fill: false })
  assert.deepEqual(closesOf(d), [sym(80_000, 'PE')], 'the naked PE does not wait for the other order')
  assert.match(d.reason, /half straddle at 80000/)
})

test('the OWN entry stuck on one wing: the filled wing is closed once the entry has worked past the grace', () => {
  const run = new Run(dialsOf())
  run.tick(80_090, T0, { refuse: ['CE'] }) // only the PE filled; the CE order is still working
  const early = run.tick(80_090, T0 + 5 * S, { pendingLots: 50, fill: false })
  assert.deepEqual(closesOf(early), [], 'an entry in the middle of filling is not a half straddle yet')
  const late = run.tick(80_090, T0 + 31 * S, { pendingLots: 50, fill: false })
  assert.deepEqual(closesOf(late), [sym(80_000, 'PE')])
  assert.match(late.reason, /half straddle at 80000/)
})
