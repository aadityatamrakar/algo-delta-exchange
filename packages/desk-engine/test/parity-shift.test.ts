/**
 * PHASE S AGAINST THE PYTHON RECORD — the shift family, mark for mark.
 *
 * Six presets, 16 sequences each, 6 marks per sequence: 576 recorded Python
 * decisions, every one of them from a function whose phase 1 this file is the
 * port of. The suite makes two claims, and it needs both — either alone is
 * passable by a broken port:
 *
 *   POSITIVE — on every mark where Python's phase 1 acted, `phaseShift`
 *   produces the SAME package: the same merged opens (strike, wing, side,
 *   lots, in merge order) and the same set of closed instruments.
 *
 *   NEGATIVE — on every OTHER mark in the same six files, `phaseShift` is
 *   SILENT. Without this a port that shifted on every mark would pass the
 *   positive half and be caught three tickets later, on a book.
 *
 * ── WHY THE EXPECTATION IS READ OUT OF PYTHON'S REASON ──────────────────────
 * `recenter_shift` merges phase 1 and phase 2 into ONE decision, and two of the
 * six presets here (`recenter-atm`, `recenter-otm`) carry no
 * `hedge_after_shift`, so their recorded `open_legs` may hold a phase-2 sell
 * beside the shift. Comparing a phase-S-only result against the whole recorded
 * decision would therefore fail for a reason that is not a defect.
 *
 * Python writes one `shift {lots} {ot} {from}->{to}` note per shifted leg and
 * prefixes those notes to every exit of the function (`playbooks.py:4165`), so
 * the notes ARE the phase-1 record — and `close_ids` is phase 1's alone, since
 * nothing after `:4029` ever appends to it. The suite therefore asserts:
 *
 *   1. TS opens == the notes, merged (this is the phase-1 comparison);
 *   2. those merged opens are CONTAINED in the recorded `open_legs`, which ties
 *      the prose back to the decision so step 1 is not merely parsing English;
 *   3. TS closes == `close_ids`, exactly, as sets;
 *   4. `state_after` == `ctx.state`, raw dicts and adapted `RuleState` alike —
 *      the parity claim available to a STATELESS phase, and the assertion that
 *      fails if a regenerated fixture ever produces a shift mark that writes
 *      state.
 *
 * When `hedge_after_shift` is false the recorded decision IS phase 1 alone, and
 * the suite additionally demands exact equality with `open_legs` — 24 of the 60
 * shift marks get that stronger check for free.
 *
 * Every mismatch prints the recorded decision and the engine's result side by
 * side; nothing here compares reason STRINGS, whose formatting deliberately
 * differs.
 *
 * The rest of the family — the phase-2 sells, the unwind, the recycle, the
 * EOD sweep and the six `recenter` presets — is the next ticket's run.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { phaseShift, type EngineAction, type OptType } from '@algomaker/desk-engine'
import {
  adaptDials,
  adaptInputs,
  adaptState,
  loadDecisionFixture,
  mergedShiftOpens,
  shiftNotes,
  type PyDecision,
  type PyMark,
  type PyOpenLeg,
  type PySequence,
} from './parity-adapter.ts'

/**
 * The shift family: every preset the registry maps onto `recenter_shift`
 * (`ticket-02-report.md` — 12 keys, two functions). `recenter-reshift` is NOT
 * one of them; its name contains the word and its `fn` is `recenter`.
 */
const SHIFT_FAMILY = [
  'recenter-atm',
  'recenter-otm',
  'recenter-relief',
  'recenter-relief-b1',
  'recenter-relief-b2',
  'recenter-relief-free',
] as const

interface Tally {
  marks: number
  shiftMarks: number
  silentMarks: number
  sequences: number
  exactMarks: number
}

const TALLY: Tally = { marks: 0, shiftMarks: 0, silentMarks: 0, sequences: 0, exactMarks: 0 }

const openKey = (a: { strike: number; optType: OptType; lots: number }) =>
  `${a.strike}:${a.optType}:${a.lots}`

/** The recorded opens in the same vocabulary as an `EngineAction` open, so a
 * containment check is a comparison of like with like. */
const pyOpen = (o: PyOpenLeg) => ({
  op: 'open' as const,
  strike: o.strike,
  optType: o.opt_type,
  side: (String(o.side).trim().toLowerCase() === 'sell' ? 'Sell' : 'Buy') as 'Sell' | 'Buy',
  lots: Math.trunc(o.lots),
})

/** Both decisions, side by side — the message every assertion below carries. */
function side(
  where: string,
  decision: PyDecision,
  actions: ReadonlyArray<EngineAction>,
): string {
  return [
    `\n${where}`,
    `  PYTHON  action=${decision.action}`,
    `          opens=${JSON.stringify(decision.open_legs.map(pyOpen))}`,
    `          closes=${JSON.stringify(decision.close_ids)}`,
    `          reason=${JSON.stringify(decision.reason)}`,
    `  ENGINE  actions=${JSON.stringify(actions)}`,
  ].join('\n')
}

function runMark(preset: string, seq: PySequence, mark: PyMark, i: number): void {
  const where = `${preset} / ${seq.seed.case} / mark ${i} @ ${mark.ctx.time}`
  const dials = adaptDials(seq.seed, mark.ctx)
  const inputs = adaptInputs(seq, mark)
  const out = phaseShift(inputs, dials, adaptState(mark.ctx.state))
  const notes = shiftNotes(mark.decision.reason)
  const msg = side(where, mark.decision, out.actions)

  TALLY.marks += 1

  if (notes.length === 0) {
    // NEGATIVE: Python's phase 1 emitted nothing, so neither may phase S.
    TALLY.silentMarks += 1
    assert.deepEqual(out.actions, [], `expected silence${msg}`)
    assert.equal(out.fired, false, `expected fired=false${msg}`)
    return
  }

  TALLY.shiftMarks += 1
  assert.equal(out.fired, true, `expected the shift to fire${msg}`)
  assert.equal(mark.decision.action, 'adjust', `Python shifted but did not adjust${msg}`)

  // 1. the opens, merged, in merge order.
  const expected = mergedShiftOpens(notes)
  const opens = out.actions.filter((a) => a.op === 'open')
  assert.deepEqual(opens, expected, `open package differs${msg}`)

  // 2. and those opens really are in the recorded decision.
  const pool = mark.decision.open_legs.map(pyOpen)
  for (const want of expected) {
    const at = pool.findIndex((o) => openKey(o) === openKey(want) && o.side === want.side)
    assert.notEqual(at, -1, `${JSON.stringify(want)} is not in Python's open_legs${msg}`)
    pool.splice(at, 1)
  }

  // 3. the closes, exactly. Nothing in the fixtures is protected, so a resize
  //    here would mean the netting fired on a book that has no protected qty.
  const exits = out.actions.filter((a) => a.op !== 'open')
  for (const e of exits) assert.equal(e.op, 'close', `unexpected ${e.op} on an unprotected book${msg}`)
  assert.deepEqual(
    new Set(exits.map((e) => (e.op === 'close' ? e.instrument : ''))),
    new Set(mark.decision.close_ids),
    `close set differs${msg}`,
  )

  // 4. a stateless phase against a mark that wrote no state.
  assert.deepEqual(mark.state_after, mark.ctx.state, `phase 1 wrote rule state${msg}`)
  assert.deepEqual(adaptState(mark.state_after), adaptState(mark.ctx.state), `RuleState differs${msg}`)

  // The stronger check, where the recorded decision IS phase 1 alone.
  if (!dials.hedge_after_shift) {
    TALLY.exactMarks += 1
    assert.deepEqual(
      opens,
      mark.decision.open_legs.map(pyOpen),
      `hedge_after_shift is false, so the whole decision must be the shift${msg}`,
    )
  }
}

for (const preset of SHIFT_FAMILY) {
  test(`${preset}: phase S reproduces every recorded shift, and is silent on every other mark`, () => {
    const seqs = loadDecisionFixture(preset)
    for (const seq of seqs) {
      assert.equal(
        seq.seed.fn,
        'recenter_shift',
        `${preset}/${seq.seed.case}: not a shift-family preset — the registry maps it to ${seq.seed.fn}`,
      )
      const acted = seq.marks.some((m) => shiftNotes(m.decision.reason).length > 0)
      if (acted) TALLY.sequences += 1
      seq.marks.forEach((mark, i) => { runMark(preset, seq, mark, i) })
    }
  })
}

test('the shift subset is not empty — a filter that matched nothing would pass every assertion above', () => {
  // 10 sequences x 6 marks, from `ticket-02-report.md`'s coverage table: the
  // margin-armed row in each of the four relief presets, plus the armed,
  // below-gate and uncapped rows in each of recenter-atm and recenter-otm
  // (whose `shift_margin_frac` is absent, so their gate never closes).
  assert.equal(TALLY.marks, 576)
  assert.equal(TALLY.sequences, 10)
  assert.equal(TALLY.shiftMarks, 60)
  assert.equal(TALLY.silentMarks, 516)
  assert.equal(TALLY.exactMarks, 24)
})
