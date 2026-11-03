/**
 * THE FRAME AGAINST A HOSTILE DESK — a property test of D1 and D2 through
 * whole simulated sessions.
 *
 * The frame's unit suite pins each staging rule on one hand-built pass. This
 * file asks the question those rules exist to answer, on whole days: whatever
 * the desk does with each order — fills it, skips it, fails it, sits on it for
 * a while — is the book EVER short an option it is not long, lot for lot, and
 * is it ALWAYS flat by 15:00?
 *
 * THE STRATEGY is a scripted stager that alternates the two structures the
 * frame stages: an iron fly (two wings, then the two shorts each against its
 * own wing) and a debit spread (the long, then the short against it). It
 * re-enters as often as the dials allow and holds each trade twelve minutes,
 * leaving by a worked close on one trade and an urgent one on the next, so
 * the latch, its escalation and the D2 order all run under the same hostile
 * fills as the opens.
 *
 * THE DESK, per seed: opens are skipped, failed, part-filled, held back a few
 * passes, or held back past the 300 s stage-1 window; closes are skipped,
 * failed, part-filled, held back a few passes, or held back past the 60 s a
 * worked close is given before it escalates. A part-filled wing is the case
 * lot pairing exists for: a fly whose CE wing holds one lot of two must sell
 * one CE short, not two. The outcomes are seeded, so a red run is re-runnable bit
 * for bit. The scenario harness models what the host does with each
 * (`scenario/paths.ts` `FillOutcome`): a skipped open is rolled back to the
 * mark, a failed one keeps its state, and while a fill is held back the book
 * is in flight — nothing routes, and only an exit pre-empts.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { makeDecidePlaybook } from '../src/delta-lean/playbook/decide.ts'
import { debitByBands, debitByStraddle, flyPlan } from '../src/delta-lean/playbook/kit.ts'
import type { Playbook } from '../src/delta-lean/playbook/types.ts'
import type { EngineAction } from '../src/types.ts'
import type { FillOutcome, ScenarioSpec } from './scenario/paths.ts'
import { runSession, type SimResult } from './scenario/sim.ts'
import { dialsOf } from './playbook-fixture.ts'

const STAGER: Playbook = {
  id: 97,
  name: 'stager',
  enter(ctx) {
    if (ctx.pb.entries % 2 === 0) {
      const fly = flyPlan(ctx)
      return fly === null
        ? { kind: 'wait', reason: 'no fly on this board' }
        : { kind: 'open', plan: { side: 'none', protective: fly.protective, shorts: fly.shorts, lots: 2, reason: 'an iron fly' } }
    }
    const side = ctx.spot !== null && ctx.spot < ctx.pb.dayOpen ? 'down' : 'up'
    const spread = debitByBands(ctx, side) ?? debitByStraddle(ctx, side)
    return spread === null
      ? { kind: 'wait', reason: 'no spread on this board' }
      : { kind: 'open', plan: { side, protective: spread.protective, shorts: spread.shorts, lots: 2, reason: `a ${side} debit spread` } }
  },
  exits(ctx) {
    if (ctx.nowMs - ctx.pb.tradeOpenMs < 12 * 60_000) return {}
    return { exit: { reason: 'twelve minutes held', urgency: ctx.pb.entries % 2 === 0 ? 'urgent' : 'passive', final: false } }
  },
  adds: () => ({}),
}

const decide = makeDecidePlaybook(new Map([[STAGER.id, STAGER]]))
const DIALS = dialsOf({
  pb_playbook: STAGER.id,
  pb_max_entries: 12,
  pb_reentry_cooldown_s: 60,
  pb_entry_start_min: 570,
  pb_entry_end_min: 870,
  pb_trade_target: 0,
})

/** mulberry32, seeded: the desk's dice. */
function dice(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

/** A desk that fills under half the opens whole and at once, and most closes. */
function hostile(seed: number): (passIndex: number, action: EngineAction) => FillOutcome {
  const roll = dice(seed)
  return (_pass, action) => {
    const u = roll()
    if (action.op === 'open') {
      if (u < 0.15) return 'skip'
      if (u < 0.25) return 'fail'
      if (u < 0.4) return { delayPasses: 1 + Math.floor(roll() * 12) }
      if (u < 0.45) return { delayPasses: 80 + Math.floor(roll() * 20) } // past the 300 s stage-1 window
      if (u < 0.6) return { fillLots: 1 } // a wing at one lot of its two
      return 'fill'
    }
    if (u < 0.1) return 'skip'
    if (u < 0.15) return 'fail'
    if (u < 0.3) return { delayPasses: 1 + Math.floor(roll() * 8) }
    if (u < 0.4) return { delayPasses: 16 + Math.floor(roll() * 10) } // a worked close past the 60 s escalation
    if (u < 0.5) return { fillLots: 1 } // a buy-back that takes one lot off
    return 'fill'
  }
}

/** A NIFTY day with a seeded shape: a morning leg, a reversal, an afternoon drift. */
function day(seed: number): ScenarioSpec {
  const r = dice(seed * 7919)
  const sign = (): number => (r() < 0.5 ? -1 : 1)
  return {
    name: `hostile desk ${seed}`, symbol: 'NIFTY', dateIst: '2026-10-16', expiry: '2026-10-19',
    open: 25_000, baseIv: 0.12, seed,
    segments: [
      { minutes: 60, drift: sign() * (40 + 80 * r()), noise: 5 },
      { minutes: 90, drift: sign() * (30 + 60 * r()), noise: 7 },
      { minutes: 225, drift: sign() * 60 * r(), noise: 6 },
    ],
    fills: hostile(seed),
  }
}

const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8]
const runs: Array<{ readonly seed: number; readonly r: SimResult }> = SEEDS.map((seed) => ({
  seed,
  r: runSession(decide, DIALS, day(seed)),
}))

test('D1 under a hostile desk: on no pass of any seed is the book short an option it is not long, lot for lot', () => {
  for (const { seed, r } of runs) {
    assert.equal(r.nakedShortPasses, 0, `seed ${seed}: ${r.nakedShortPasses} naked pass(es)`)
  }
})

test('every hostile day ends flat by 15:00', () => {
  for (const { seed, r } of runs) {
    for (const t of r.trades) {
      assert.ok(t.closeMin !== null && t.closeMin <= 900, `seed ${seed}: a trade still open after 15:00: ${JSON.stringify(t)}`)
    }
  }
})

test('the property ran on what it claims: both structures staged, every outcome drawn, the aborts and the latch exercised', () => {
  const all = runs.flatMap(({ r }) => r.decisions)
  const saw = (re: RegExp): number => all.filter((d) => re.test(d.reason)).length
  assert.ok(saw(/stager: an iron fly — stage 1/) > 0, 'a fly staged')
  assert.ok(saw(/stager: a (up|down) debit spread — stage 1/) > 0, 'a spread staged')
  assert.ok(saw(/stager: stage 2 — selling 2 short/) > 0, 'a fly completed stage 2')
  assert.ok(saw(/stager: stage 2 — selling 1 short/) > 0, 'a spread completed stage 2 (or a fly re-sent one short)')
  assert.ok(saw(/stage-1 abort/) > 0, 'a stage 1 aborted')
  assert.ok(saw(/stager: twelve minutes held — buying back/) > 0, 'an exit bought shorts back first')
  assert.ok(saw(/escalated to urgent/) > 0, 'a worked exit escalated')
  const totals = runs.reduce(
    (s, { r }) => ({
      skipped: s.skipped + r.outcomes.skipped, failed: s.failed + r.outcomes.failed,
      delayed: s.delayed + r.outcomes.delayed, partial: s.partial + r.outcomes.partial,
      cancelled: s.cancelled + r.outcomes.cancelled, trades: s.trades + r.trades.length,
    }),
    { skipped: 0, failed: 0, delayed: 0, partial: 0, cancelled: 0, trades: 0 },
  )
  assert.ok(totals.skipped > 0 && totals.failed > 0 && totals.delayed > 0 && totals.partial > 0, JSON.stringify(totals))
  assert.ok(saw(/stage 2 — selling .*: 1 \d+(CE|PE) against 1 /) > 0, 'a short sold at one lot against a one-lot cover')
  assert.ok(totals.trades >= SEEDS.length * 3, `only ${totals.trades} trades over ${SEEDS.length} days`)
})
