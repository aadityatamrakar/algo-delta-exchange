/**
 * decideBullS — spec §6.1 rules 1-9, one test per behaviour the plan names
 * (Task 3, step 1). Every book here is the daily preset (step 200, 50 → 150
 * contracts, max 4 open, loss cap 250, ask-side stop held 3 s) unless the
 * test overrides a dial, and every fill lands at once on the touch.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { hydrateBullState } from '../../src/bull-s/state.ts'
import { EMPTY_RULE_STATE } from '../../src/types.ts'
import { Run, T0, closesOf, dialsOf, key, model, opensOf, q, stateWith, sym } from './fixture.ts'

const S = 1_000

/**
 * Quotes for the straddle at `k` with each leg's ask at `ce` / `pe` × that
 * leg's own entry: 1.3 is past a 1.25 stop, 1.2 is under it. `null` takes the
 * side's quote away; 0 quotes it at zero.
 */
function asksAt(run: Run, k: number, ce: number | null, pe: number | null = ce) {
  const g = run.state.bs.groups.find((x) => x.strike === k)
  if (g === undefined) throw new Error(`no group at ${k}`)
  const side = (entry: number, r: number | null) =>
    r === null ? q(null, null, null) : q(Math.max(0, entry * r - 4), entry * r, entry * r)
  return { quotes: { [key(k, 'CE')]: side(g.ceEntry, ce), [key(k, 'PE')]: side(g.peEntry, pe) } }
}

test('first fresh ref after start sells the nearest level when bs_enter_on_start', () => {
  const run = new Run(dialsOf())
  const d = run.tick(80_090, T0)
  assert.equal(d.trigger, 'bs-entry')
  assert.deepEqual(opensOf(d), ['Sell 80000PE x50', 'Sell 80000CE x50'], 'PE first, then CE, at the start size')
  assert.equal(run.state.bs.groups.length, 1)
  assert.equal(run.state.bs.size, 100, 'the next straddle is one step bigger')

  // With it off, the first price is a baseline only, and the first CROSSING sells.
  const off = new Run(dialsOf({ bs_enter_on_start: false }))
  const first = off.tick(80_090, T0)
  assert.deepEqual(first.actions, [])
  assert.equal(off.state.bs.lastRef, 80_090)
  assert.deepEqual(opensOf(off.tick(80_150, T0 + S)), [], 'inside the grid cell: no crossing')
  assert.deepEqual(opensOf(off.tick(80_210, T0 + 2 * S)), ['Sell 80200PE x50', 'Sell 80200CE x50'])
})

test('crossing one grid level sells that strike at the current size, size steps, cap holds', () => {
  const run = new Run(dialsOf())
  run.tick(80_090, T0)
  assert.deepEqual(opensOf(run.tick(80_250, T0 + S)), ['Sell 80200PE x100', 'Sell 80200CE x100'])
  assert.deepEqual(opensOf(run.tick(80_450, T0 + 2 * S)), ['Sell 80400PE x150', 'Sell 80400CE x150'])
  assert.equal(run.state.bs.size, 150, 'capped at bs_lots_cap')
  assert.deepEqual(opensOf(run.tick(80_610, T0 + 3 * S)), ['Sell 80600PE x150', 'Sell 80600CE x150'])
  assert.equal(run.state.bs.size, 150)
  // Down through a level that already holds a straddle: nothing.
  assert.deepEqual(opensOf(run.tick(80_390, T0 + 4 * S)), [])

  // A step that overshoots the cap is clamped, never above it.
  const odd = new Run(dialsOf({ bs_lots_start: 40, bs_lots_step: 50, bs_lots_cap: 120 }))
  odd.tick(80_090, T0)
  odd.tick(80_250, T0 + S)
  assert.deepEqual(opensOf(odd.tick(80_450, T0 + 2 * S)), ['Sell 80400PE x120', 'Sell 80400CE x120'])
})

test('jump 2 ignores the in-between strike', () => {
  const run = new Run(dialsOf({ bs_strike_jump: 2 }))
  assert.deepEqual(opensOf(run.tick(80_090, T0)), ['Sell 80000PE x50', 'Sell 80000CE x50'])
  const mid = run.tick(80_250, T0 + S)
  assert.deepEqual(opensOf(mid), [], '80,200 is a listed strike but not a level of a 400 grid')
  assert.deepEqual(opensOf(run.tick(80_410, T0 + 2 * S)), ['Sell 80400PE x100', 'Sell 80400CE x100'])
})

test('price gapping three levels sells only the nearest level', () => {
  const run = new Run(dialsOf())
  run.tick(80_090, T0)
  const gap = run.tick(80_650, T0 + S)
  assert.deepEqual(opensOf(gap), ['Sell 80600PE x100', 'Sell 80600CE x100'], 'one straddle, at the level nearest the price')
  assert.match(gap.reason, /80600/)
  // And no burst afterwards: the skipped levels were crossed once, and that was it.
  assert.deepEqual(opensOf(run.tick(80_650, T0 + 2 * S)), [])
  assert.deepEqual(opensOf(run.tick(80_660, T0 + 3 * S)), [])
  assert.equal(run.state.bs.groups.length, 2)
  // Down the same way: 80,400 and 80,200 crossed, 80,200 is nearest.
  assert.deepEqual(opensOf(run.tick(80_150, T0 + 4 * S)), ['Sell 80200PE x150', 'Sell 80200CE x150'])
})

test('unlisted strike at the level is skipped, never substituted', () => {
  const without = (strikes: readonly number[]) => strikes.filter((k) => k !== 80_200)
  const ladder = Array.from({ length: 101 }, (_, i) => 70_000 + i * 200)
  const run = new Run(dialsOf())
  run.tick(80_090, T0, { chain: { strikes: without(ladder) } })
  const d = run.tick(80_250, T0 + S, { chain: { strikes: without(ladder) } })
  assert.deepEqual(d.actions, [])
  assert.match(d.reason, /80200 is not listed/)
  // A level listed with one side missing is just as unlisted.
  const half = run.tick(80_410, T0 + 2 * S, { chain: { quotes: { [key(80_400, 'PE')]: null } } })
  assert.deepEqual(half.actions, [])
  assert.match(half.reason, /80400/)
  assert.deepEqual(run.state.bs.groups.map((g) => g.strike), [80_000], 'no other strike was sold in its place')
  // The crossing was spent: the next tick does not go back for it.
  assert.deepEqual(opensOf(run.tick(80_420, T0 + 3 * S)), [])
})

test('stop fires only after the summed ask has held ≥ mult × entry for confirm_s; recovery resets the clock', () => {
  const run = new Run(dialsOf())
  run.tick(80_090, T0)
  const g = run.state.bs.groups[0]
  assert.equal(g?.ceEntry, model(80_000, 'CE', 80_090, T0).bid, 'the entry is the sale price')
  assert.equal(g?.peEntry, model(80_000, 'PE', 80_090, T0).bid)
  const t = (s: number) => T0 + s * S
  // Every ask at 1.26 × its entry: the sum is past 1.25 × the sum.
  assert.deepEqual(closesOf(run.tick(80_090, t(10), { chain: asksAt(run, 80_000, 1.26) })), [])
  assert.equal(run.state.bs.groups[0]?.breachSinceMs, t(10))
  assert.deepEqual(closesOf(run.tick(80_090, t(12), { chain: asksAt(run, 80_000, 1.26) })), [], 'held 2 s of 3')
  // Recovery under the line — the clock resets.
  run.tick(80_090, t(12.5), { chain: asksAt(run, 80_000, 1.2) })
  assert.equal(run.state.bs.groups[0]?.breachSinceMs, 0)
  run.tick(80_090, t(13), { chain: asksAt(run, 80_000, 1.26) })
  assert.deepEqual(closesOf(run.tick(80_090, t(15.9), { chain: asksAt(run, 80_000, 1.26) })), [], 'a new 3 s, from 13 s')
  const stop = run.tick(80_090, t(16), { chain: asksAt(run, 80_000, 1.26) })
  assert.equal(stop.trigger, 'bs-stop')
  assert.deepEqual(closesOf(stop), [sym(80_000, 'PE'), sym(80_000, 'CE')], 'PE then CE')
  assert.match(stop.reason, /80000/)
  // A sum, not each leg: one leg far up and the other down still breaches.
  const sum = new Run(dialsOf({ bs_stop_confirm_s: 0 }))
  sum.tick(80_090, T0)
  assert.equal(closesOf(sum.tick(80_090, T0 + S, { chain: asksAt(sum, 80_000, 1.6, 0.9) })).length, 2)
  // Bought back: the group is gone at the next pass, and the level can be sold again.
  run.tick(80_090, t(17))
  assert.deepEqual(run.state.bs.groups, [])
  run.tick(80_150, t(18))
  assert.deepEqual(opensOf(run.tick(79_990, t(19))), ['Sell 80000PE x100', 'Sell 80000CE x100'], 'its next crossing, at the current size')
})

test('a Dials change to bs_stop_mult applies to an open straddle at the next decision', () => {
  const run = new Run(dialsOf({ bs_stop_confirm_s: 0 }))
  run.tick(80_090, T0)
  // 1.2 × entry: under 1.25, over 1.15.
  assert.deepEqual(closesOf(run.tick(80_090, T0 + S, { chain: asksAt(run, 80_000, 1.2) })), [])
  const tighter = dialsOf({ bs_stop_confirm_s: 0, bs_stop_mult: 1.15 })
  const d = run.tick(80_090, T0 + 2 * S, { chain: asksAt(run, 80_000, 1.2), dials: tighter })
  assert.deepEqual(closesOf(d), [sym(80_000, 'PE'), sym(80_000, 'CE')])
})

test('null ask holds the stop and names the leg', () => {
  const run = new Run(dialsOf())
  run.tick(80_090, T0)
  run.tick(80_090, T0 + S, { chain: asksAt(run, 80_000, 1.3) })
  const since = run.state.bs.groups[0]?.breachSinceMs
  assert.equal(since, T0 + S)
  // 5 s later the breach would be confirmed, but the CE has no ask.
  const blind = run.tick(80_090, T0 + 6 * S, { chain: asksAt(run, 80_000, null, 1.3) })
  assert.deepEqual(blind.actions, [], 'never a buy-back priced off nothing')
  assert.match(blind.reason, /80000CE/)
  assert.match(blind.reason, /no ask/)
  assert.equal(run.state.bs.groups[0]?.breachSinceMs, since, 'not reset: the straddle is not known to be safe')
  // A zero ask is no price either.
  const zero = run.tick(80_090, T0 + 7 * S, { chain: asksAt(run, 80_000, 0, 1.3) })
  assert.deepEqual(zero.actions, [])
  assert.match(zero.reason, /80000CE/)
  // The ask comes back still breached: the clock never stopped, so it fires now.
  const back = run.tick(80_090, T0 + 8 * S, { chain: asksAt(run, 80_000, 1.3) })
  assert.deepEqual(closesOf(back), [sym(80_000, 'PE'), sym(80_000, 'CE')])
})

test('stale ref neither enters nor crosses; fresh ref after a gap re-baselines', () => {
  const run = new Run(dialsOf({ bs_stop_confirm_s: 0 }))
  run.tick(80_090, T0)
  // 20 s old, against a 10 s bar.
  const stale = run.tick(80_250, T0 + 30 * S, { refAsOf: T0 + 10 * S })
  assert.deepEqual(stale.actions, [])
  assert.match(stale.reason, /stale/)
  assert.equal(run.state.bs.lastRef, 80_090, 'a stale price is not a baseline')
  // No price at all is the same.
  assert.deepEqual(run.tick(null, T0 + 31 * S).actions, [])
  // A stale price still lets a stop through.
  const stop = run.tick(80_250, T0 + 32 * S, { refAsOf: T0 + 10 * S, chain: asksAt(run, 80_000, 1.3) })
  assert.deepEqual(closesOf(stop), [sym(80_000, 'PE'), sym(80_000, 'CE')])
  // Fresh again, 22 s after the last fresh price: a baseline, not a crossing of 80,200 and 80,400.
  const back = run.tick(80_450, T0 + 33 * S)
  assert.deepEqual(opensOf(back), [])
  assert.match(back.reason, /re-baselined/)
  assert.equal(run.state.bs.lastRef, 80_450)
  // And from there, crossings count again.
  assert.deepEqual(opensOf(run.tick(80_610, T0 + 34 * S)), ['Sell 80600PE x100', 'Sell 80600CE x100'])
})

test('target halts and closes all; after_halt 0 stays flat; after_halt 1 re-arms with a new baseline and size reset', () => {
  for (const afterHalt of [0, 1]) {
    const run = new Run(dialsOf({ bs_target: 100, bs_after_halt: afterHalt }))
    run.tick(80_090, T0)
    run.tick(80_250, T0 + S)
    assert.equal(run.state.bs.size, 150)
    run.cum += 120 // banked elsewhere in the book: P&L since the arm is now ≥ 100
    const hit = run.tick(80_250, T0 + 2 * S)
    assert.equal(hit.trigger, 'bs-target')
    assert.equal(hit.action, 'flatten')
    assert.equal(closesOf(hit).length, 4, 'every leg of both straddles')
    assert.deepEqual(closesOf(hit).slice(0, 2), [sym(80_000, 'PE'), sym(80_000, 'CE')])
    assert.equal(run.state.bs.halted, true)
    assert.equal(run.state.bs.haltReason, 'target')
    assert.deepEqual(hit.markState.bs.halted, true, 'latched on the mark state too, so a pre-empted pass keeps it')

    const next = run.tick(80_420, T0 + 3 * S) // flat now, and 80,400 is crossed
    assert.deepEqual(next.actions, [])
    if (afterHalt === 0) {
      assert.equal(run.state.bs.halted, true)
      assert.match(next.reason, /Re-arm/)
      assert.deepEqual(opensOf(run.tick(80_610, T0 + 4 * S)), [], 'stays flat')
    } else {
      assert.equal(run.state.bs.halted, false)
      assert.equal(run.state.bs.size, 50, 'size back to start')
      assert.equal(run.state.bs.pnlBaseline, run.cum, 'the new baseline is the P&L at the re-arm')
      assert.match(next.reason, /re-armed/)
      // Trades again from the NEXT crossing, at the start size.
      assert.deepEqual(opensOf(run.tick(80_610, T0 + 4 * S)), ['Sell 80600PE x50', 'Sell 80600CE x50'])
    }
  }
})

test('loss cap mirrors target', () => {
  for (const afterHalt of [0, 1]) {
    const run = new Run(dialsOf({ bs_after_halt: afterHalt }))
    run.tick(80_090, T0)
    run.cum -= 260 // past the daily preset's 250 loss cap
    const hit = run.tick(80_090, T0 + S)
    assert.equal(hit.trigger, 'bs-loss')
    assert.deepEqual(closesOf(hit), [sym(80_000, 'PE'), sym(80_000, 'CE')])
    assert.equal(run.state.bs.haltReason, 'loss')
    run.tick(80_090, T0 + 2 * S)
    assert.equal(run.state.bs.halted, afterHalt === 0)
    const after = run.tick(80_250, T0 + 3 * S)
    assert.equal(opensOf(after).length, afterHalt === 0 ? 0 : 2)
  }
  // 0 is off: no loss is a loss cap.
  const off = new Run(dialsOf({ bs_loss_cap: 0 }))
  off.tick(80_090, T0)
  off.cum -= 1_000_000
  assert.notEqual(off.tick(80_090, T0 + S).trigger, 'bs-loss')
})

test('bs_close_req +1 closes all and halts once; bs_rearm_req +1 clears the halt once', () => {
  const run = new Run(dialsOf())
  run.tick(80_090, T0)
  run.tick(80_250, T0 + S)
  const close = run.tick(80_250, T0 + 2 * S, { dials: dialsOf({ bs_close_req: 1 }) })
  assert.equal(close.trigger, 'bs-close')
  assert.equal(closesOf(close).length, 4)
  assert.equal(run.state.bs.closeReqSeen, 1)
  assert.equal(run.state.bs.haltReason, 'close')
  // The counter still reads 1: acted on once, so a crossing sells nothing and nothing re-closes.
  const held = run.tick(80_420, T0 + 3 * S, { dials: dialsOf({ bs_close_req: 1 }) })
  assert.deepEqual(held.actions, [])
  assert.equal(run.state.bs.halted, true)

  // Re-arm: new baseline, size back to start, and the first price sells the nearest level.
  const rearmed = run.tick(80_430, T0 + 4 * S, { dials: dialsOf({ bs_close_req: 1, bs_rearm_req: 1 }) })
  assert.equal(run.state.bs.halted, false)
  assert.equal(run.state.bs.rearmReqSeen, 1)
  assert.equal(run.state.bs.pnlBaseline, run.cum)
  assert.deepEqual(opensOf(rearmed), ['Sell 80400PE x50', 'Sell 80400CE x50'])
  // Once: the same counter again re-arms nothing and resets nothing.
  run.tick(80_610, T0 + 5 * S, { dials: dialsOf({ bs_close_req: 1, bs_rearm_req: 1 }) })
  assert.equal(run.state.bs.size, 150)

  // A fresh book adopts whatever the counters read: a copied row never fires a stale command.
  const copied = new Run(dialsOf({ bs_close_req: 3, bs_rearm_req: 2 }))
  const first = copied.tick(80_090, T0)
  assert.equal(first.trigger, 'bs-entry')
  assert.equal(copied.state.bs.closeReqSeen, 3)
  assert.equal(copied.state.bs.rearmReqSeen, 2)
})

test('entry window and weekday mask gate entries but never stops', () => {
  const windowed = dialsOf({ bs_entry_from_min: 600, bs_entry_to_min: 900, bs_stop_confirm_s: 0 })
  const run = new Run(windowed)
  run.tick(80_090, T0, { minuteOfDay: 690 })
  const late = run.tick(80_250, T0 + S, { minuteOfDay: 905 })
  assert.deepEqual(late.actions, [])
  assert.match(late.reason, /window/)
  const stop = run.tick(80_250, T0 + 2 * S, { minuteOfDay: 905, chain: asksAt(run, 80_000, 1.3) })
  assert.deepEqual(closesOf(stop), [sym(80_000, 'PE'), sym(80_000, 'CE')], 'stops run at every hour')

  // A window that wraps midnight: 22:00 to 02:00.
  const night = new Run(dialsOf({ bs_entry_from_min: 1320, bs_entry_to_min: 120 }))
  assert.equal(opensOf(night.tick(80_090, T0, { minuteOfDay: 60 })).length, 2)
  const day = new Run(dialsOf({ bs_entry_from_min: 1320, bs_entry_to_min: 120 }))
  assert.equal(opensOf(day.tick(80_090, T0, { minuteOfDay: 690 })).length, 0)

  // 2026-11-04 is a Wednesday, bit 3. Every day but Wednesday:
  const noWed = new Run(dialsOf({ bs_entry_weekdays: 127 & ~(1 << 3), bs_stop_confirm_s: 0 }))
  const wed = noWed.tick(80_090, T0)
  assert.deepEqual(wed.actions, [])
  assert.match(wed.reason, /Wednesday/)
  const T1 = T0 + 86_400_000
  noWed.tick(80_090, T1, { dateIst: '2026-11-05' }) // a night later: a baseline
  assert.equal(opensOf(noWed.tick(80_250, T1 + S, { dateIst: '2026-11-05' })).length, 2, 'Thursday sells')
  const hydrated = new Run(dialsOf({ bs_entry_weekdays: 0, bs_stop_confirm_s: 0 }), noWed.state)
  for (const [k, h] of noWed.book) hydrated.book.set(k, h)
  const wedStop = hydrated.tick(80_250, T1 + 2 * S, { chain: asksAt(hydrated, 80_200, 1.3) })
  assert.deepEqual(closesOf(wedStop), [sym(80_200, 'PE'), sym(80_200, 'CE')], 'a mask of 0 stops nothing')
})

test('no entry inside the expiry blackout; flat_before_expiry closes at the minute; no orders at or after the expiry instant', () => {
  const run = new Run(dialsOf({ bs_stop_confirm_s: 0 }))
  run.tick(80_090, T0, { minutesToExpiry: 120 })
  const black = run.tick(80_250, T0 + S, { minutesToExpiry: 60 })
  assert.deepEqual(black.actions, [], 'the daily preset stops entries 60 min out')
  assert.match(black.reason, /expiry/)

  const flatter = new Run(dialsOf({ bs_flat_before_expiry_min: 30 }))
  flatter.tick(80_090, T0, { minutesToExpiry: 120 })
  assert.deepEqual(flatter.tick(80_090, T0 + S, { minutesToExpiry: 31 }).actions, [])
  const flat = flatter.tick(80_090, T0 + 2 * S, { minutesToExpiry: 30 })
  assert.equal(flat.trigger, 'bs-flat')
  assert.deepEqual(closesOf(flat), [sym(80_000, 'PE'), sym(80_000, 'CE')])
  assert.equal(flatter.state.bs.haltReason, 'flat')

  // At the instant, and after it, nothing at all — not even a breached stop.
  for (const m of [0, -1]) {
    const held = new Run(dialsOf({ bs_stop_confirm_s: 0 }))
    held.tick(80_090, T0, { minutesToExpiry: 90 })
    const d = held.tick(80_450, T0 + S, { minutesToExpiry: m, chain: asksAt(held, 80_000, 1.3) })
    assert.deepEqual(d.actions, [])
    assert.equal(d.trigger, 'bs-expiry')
    assert.match(d.reason, /settle/)
    assert.equal(held.state.bs.haltReason, 'expiry')
  }
})

test('hydrated state with ceOpen=false peOpen=true does not re-enter the level', () => {
  // As a row comes back from Mongo after a restart: the PE filled, the CE did not.
  const stored = JSON.parse(JSON.stringify({
    groups: [{ strike: 80_000, lots: 50, ceEntry: 300, peEntry: 300, openedMs: T0, ceOpen: false, peOpen: true, breachSinceMs: 0 }],
    size: 100, lastRef: 80_090, lastRefMs: T0, halted: false, haltReason: '',
    armedAtMs: T0, pnlBaseline: 0, closeReqSeen: 0, rearmReqSeen: 0,
  }))
  const run = new Run(dialsOf(), { ...EMPTY_RULE_STATE, bs: hydrateBullState(stored) })
  run.book.set(sym(80_000, 'PE'), { strike: 80_000, opt: 'PE', lots: 50, entry: 300, lotSize: 0.001 })
  // The restart's first price crosses back down through the level.
  const d = run.tick(79_950, T0 + 6 * S)
  assert.deepEqual(opensOf(d), [], 'no second straddle at 80,000')
  assert.deepEqual(closesOf(d), [sym(80_000, 'PE')], 'the half straddle is closed, not left naked')
  assert.match(d.reason, /half/)
  // While a package is still working, the half group is left alone.
  const working = new Run(dialsOf(), { ...EMPTY_RULE_STATE, bs: hydrateBullState(stored) })
  working.book.set(sym(80_000, 'PE'), { strike: 80_000, opt: 'PE', lots: 50, entry: 300, lotSize: 0.001 })
  const w = working.tick(79_950, T0 + 6 * S, { pendingLots: 50 })
  assert.deepEqual(w.actions, [])
})

test('max_open caps concurrent straddles', () => {
  const run = new Run(dialsOf({ bs_max_open: 2 }))
  run.tick(80_090, T0)
  run.tick(80_250, T0 + S)
  const third = run.tick(80_450, T0 + 2 * S)
  assert.deepEqual(third.actions, [])
  assert.match(third.reason, /2 open/)
  // 0 is unlimited.
  const open = new Run(dialsOf({ bs_max_open: 0, bs_lots_cap: 0, bs_loss_cap: 0 }))
  for (let i = 0; i < 6; i++) open.tick(80_090 + i * 200, T0 + i * S)
  assert.equal(open.state.bs.groups.length, 6)
})

test('pendingLots > 0 blocks a new entry but not a stop', () => {
  const run = new Run(dialsOf({ bs_stop_confirm_s: 0 }))
  run.tick(80_090, T0)
  const blocked = run.tick(80_250, T0 + S, { pendingLots: 50 })
  assert.deepEqual(blocked.actions, [])
  assert.match(blocked.reason, /working/)
  const stop = run.tick(80_250, T0 + 2 * S, { pendingLots: 50, chain: asksAt(run, 80_000, 1.3) })
  assert.equal(stop.trigger, 'bs-stop')
  assert.deepEqual(closesOf(stop), [sym(80_000, 'PE'), sym(80_000, 'CE')])
})

test('a book that is off, or has no strike step, holds and says why', () => {
  const off = new Run(dialsOf({ bs_enabled: false }))
  assert.match(off.tick(80_090, T0).reason, /off/)
  // Built by hand: `resolveDials` refuses a 0 step on an enabled book, so only a
  // hand-made Dials can carry one — and the engine must still hold.
  const noStep = new Run({ ...dialsOf(), bs_strike_step: 0 })
  const d = noStep.tick(80_090, T0)
  assert.deepEqual(d.actions, [])
  assert.match(d.reason, /bs_strike_step/)
})

test('legs the state lost are adopted, so a short is never left without a stop', () => {
  const run = new Run(dialsOf({ bs_stop_confirm_s: 0 }), stateWith({ armedAtMs: T0, size: 100, lastRef: 80_090, lastRefMs: T0 }))
  run.book.set(sym(80_000, 'PE'), { strike: 80_000, opt: 'PE', lots: 50, entry: 2_000, lotSize: 0.001 })
  run.book.set(sym(80_000, 'CE'), { strike: 80_000, opt: 'CE', lots: 50, entry: 2_000, lotSize: 0.001 })
  const d = run.tick(80_090, T0 + S)
  assert.deepEqual(d.actions, [])
  assert.deepEqual(run.state.bs.groups.map((g) => [g.strike, g.lots, g.ceEntry, g.peEntry, g.ceOpen, g.peOpen]), [
    [80_000, 50, 2_000, 2_000, true, true],
  ])
  assert.deepEqual(closesOf(run.tick(80_090, T0 + 2 * S, { chain: asksAt(run, 80_000, 1.3) })), [sym(80_000, 'PE'), sym(80_000, 'CE')])
})
