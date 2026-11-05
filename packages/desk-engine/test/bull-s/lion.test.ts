/**
 * LION-S — `bs_per_leg` on the BULL-S decide path (operator, 5 Nov: "same
 * features as bull, rest stop and re-entry as suggested, straddle or fill
 * leg"). Every book here is the `lion-s-btc-daily` preset: step 200, a flat
 * 50 contracts, max 4 open, loss cap 250, each leg's own ask-side stop at
 * 1.25x its own entry held 3 s.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { hydrateBullState } from '../../src/bull-s/state.ts'
import { Run, T0, closesOf, dialsOf, key, opensOf, q, sym } from './fixture.ts'

const S = 1_000
const LION = 'lion-s-btc-daily'
const t = (s: number): number => T0 + s * S

/** Each leg's ask at `ce` / `pe` x its own entry (1.3 is past a 1.25 stop). */
function asksAt(run: Run, k: number, ce: number, pe: number) {
  const g = run.state.bs.groups.find((x) => x.strike === k)
  if (g === undefined) throw new Error(`no group at ${k}`)
  const side = (entry: number, r: number) => q(Math.max(0, entry * r - 4), entry * r, entry * r)
  return { quotes: { [key(k, 'CE')]: side(g.ceEntry, ce), [key(k, 'PE')]: side(g.peEntry, pe) } }
}

test('the preset is BULL-S with per-leg stops and a flat size', () => {
  const d = dialsOf({}, LION)
  assert.equal(d.bs_enabled, true)
  assert.equal(d.bs_per_leg, true)
  assert.equal(d.bs_lots_start, 50)
  assert.equal(d.bs_lots_step, 0)
  assert.equal(d.bs_lots_cap, 50)
  assert.equal(d.bs_loss_cap, 250)
})

test('the first price sells a straddle, each leg with its own stop line', () => {
  const run = new Run(dialsOf({}, LION))
  const d = run.tick(80_090, T0)
  assert.deepEqual(opensOf(d), ['Sell 80000PE x50', 'Sell 80000CE x50'])
  assert.match(d.reason, /leg stops CE .* \/ PE /)
  const g = run.state.bs.groups[0]
  assert.equal(g?.ceBreachSinceMs, 0)
  assert.equal(g?.peBreachSinceMs, 0)
  assert.equal(run.state.bs.size, 50, 'flat: the next size is the same')
})

test('a leg past its OWN line is bought back alone, after confirm_s — the combined sum would not have stopped', () => {
  const run = new Run(dialsOf({}, LION))
  run.tick(80_090, T0)
  // CE at 1.3x its entry, PE at 1.0x: the sum is ~1.15x, under a combined 1.25.
  assert.deepEqual(closesOf(run.tick(80_090, t(10), { chain: asksAt(run, 80_000, 1.3, 1.0) })), [])
  assert.equal(run.state.bs.groups[0]?.ceBreachSinceMs, t(10))
  assert.equal(run.state.bs.groups[0]?.peBreachSinceMs, 0)
  assert.deepEqual(closesOf(run.tick(80_090, t(12), { chain: asksAt(run, 80_000, 1.3, 1.0) })), [], 'held 2 s of 3')
  const stop = run.tick(80_090, t(13), { chain: asksAt(run, 80_000, 1.3, 1.0) })
  assert.equal(stop.trigger, 'bs-stop')
  assert.deepEqual(closesOf(stop), [sym(80_000, 'CE')])
  assert.match(stop.reason, /stop at 80000 CE: .*buying back the CE only/)

  // The PE is KEPT: no half-straddle close, the group stays with one leg.
  const next = run.tick(80_090, t(14))
  assert.deepEqual(closesOf(next), [])
  assert.doesNotMatch(next.reason, /half straddle/)
  assert.equal(run.state.bs.groups[0]?.ceOpen, false)
  assert.equal(run.state.bs.groups[0]?.peOpen, true)
})

test('the stopped leg alone is sold again at the level’s next crossing, at the straddle’s own size', () => {
  const run = new Run(dialsOf({ bs_stop_confirm_s: 0 }, LION))
  run.tick(80_090, T0)
  run.tick(80_090, t(1), { chain: asksAt(run, 80_000, 1.3, 1.0) })
  run.tick(80_090, t(2))
  assert.equal(run.state.bs.groups[0]?.ceOpen, false)

  run.tick(80_150, t(3))
  const fill = run.tick(79_990, t(4))
  assert.equal(fill.trigger, 'bs-entry')
  assert.deepEqual(opensOf(fill), ['Sell 80000CE x50'], 'only the missing leg')
  assert.match(fill.reason, /refilling the 80000 CE, 50 contracts, at .*the PE is still held/)
  assert.equal(run.state.bs.size, 50, 'a refill is not a pyramid step')

  // Both legs held again: the next crossing of the level is occupied.
  run.tick(80_150, t(5))
  const occupied = run.tick(79_990, t(6))
  assert.deepEqual(opensOf(occupied), [])
  assert.match(occupied.reason, /80000 already holds a straddle/)
})

test('both legs stopped: the level is free, and its next crossing sells a whole straddle', () => {
  const run = new Run(dialsOf({ bs_stop_confirm_s: 0 }, LION))
  run.tick(80_090, T0)
  const both = run.tick(80_090, t(1), { chain: asksAt(run, 80_000, 1.3, 1.3) })
  assert.deepEqual(closesOf(both), [sym(80_000, 'PE'), sym(80_000, 'CE')], 'each on its own line, PE then CE')
  run.tick(80_090, t(2))
  assert.deepEqual(run.state.bs.groups, [])
  run.tick(80_150, t(3))
  assert.deepEqual(opensOf(run.tick(79_990, t(4))), ['Sell 80000PE x50', 'Sell 80000CE x50'])
})

test('a wing the exchange refused is kept as an opened straddle and refilled — not closed as a half', () => {
  const run = new Run(dialsOf({}, LION))
  run.tick(80_090, T0, { refuse: ['CE'] })
  const next = run.tick(80_090, t(1))
  assert.deepEqual(closesOf(next), [], 'the PE stays')
  assert.equal(run.state.bs.groups[0]?.filled, true)
  assert.equal(run.state.bs.cooldowns.length, 0, 'not a refused entry: no cooldown')
  run.tick(80_150, t(2))
  assert.deepEqual(opensOf(run.tick(79_990, t(3))), ['Sell 80000CE x50'])
})

test('the BULL-S book features hold: the loss cap closes every leg and halts', () => {
  const run = new Run(dialsOf({ bs_loss_cap: 1 }, LION))
  run.tick(80_090, T0)
  const d = run.tick(80_090, t(1), { chain: asksAt(run, 80_000, 1.3, 1.3) })
  assert.equal(d.trigger, 'bs-loss')
  assert.equal(closesOf(d).length, 2)
  assert.equal(run.state.bs.halted, true)
})

test('straddle mode is untouched: a BULL-S group carries no per-leg clocks, and stops on the sum', () => {
  const run = new Run(dialsOf({ bs_stop_confirm_s: 0 }))
  run.tick(80_090, T0)
  const g = run.state.bs.groups[0]
  assert.equal(g !== undefined && 'ceBreachSinceMs' in g, false)
  // The same 1.3 / 1.0 asks that stop a LION-S CE do not stop a BULL-S straddle.
  assert.deepEqual(closesOf(run.tick(80_090, t(1), { chain: asksAt(run, 80_000, 1.3, 1.0) })), [])
})

test('the per-leg clocks survive a save; a BULL-S row reads back without them', () => {
  const lion = hydrateBullState({
    groups: [{
      strike: 80_000, lots: 50, ceEntry: 900, peEntry: 800, openedMs: T0, ceOpen: false, peOpen: true,
      breachSinceMs: 0, filled: true, staleSinceMs: 0, ceBreachSinceMs: 0, peBreachSinceMs: t(5),
    }],
  })
  assert.equal(lion.groups[0]?.peBreachSinceMs, t(5))
  assert.equal(lion.groups[0]?.ceBreachSinceMs, 0)
  const bull = hydrateBullState({
    groups: [{
      strike: 80_000, lots: 50, ceEntry: 900, peEntry: 800, openedMs: T0, ceOpen: true, peOpen: true,
      breachSinceMs: 0, filled: true, staleSinceMs: 0,
    }],
  })
  assert.deepEqual(Object.keys(bull.groups[0] ?? {}), [
    'strike', 'lots', 'ceEntry', 'peEntry', 'openedMs', 'ceOpen', 'peOpen', 'breachSinceMs', 'filled', 'staleSinceMs',
  ])
})
