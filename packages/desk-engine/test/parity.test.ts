/**
 * THE WHOLE RECENTER FAMILY AGAINST THE PYTHON RECORD — 12 presets, 192
 * sequences, 1,152 marks, every one of them structurally.
 *
 * `parity-shift.test.ts` replays phase 1 of the six `recenter_shift` presets.
 * This file replays the DECISION: both phases of `recenter_shift` and the whole
 * of `recenter` — the EOD sweep, the gk-anchor, the trend budget, the LIFO
 * unwind, the recycle bank and the balance tier — over every recorded mark of
 * every recorded file. It is the claim the migration rests on: that this engine
 * answers a Python board the way Python answered it.
 *
 * ── WHAT "STRUCTURALLY EQUAL" MEANS HERE, AND WHY IT IS NOT WEAKER ──────────
 * Four things are compared, and each is a thing a real order would carry:
 *
 *   1. THE ACTION KIND. `A._adjust` returns "adjust" iff it was handed opens,
 *      closes or partial closes (`actions.py:50`); the engine adjusts iff it
 *      emitted an `EngineAction`. A port that held where Python acted, or acted
 *      where Python held, fails here first.
 *   2. THE OPEN PACKAGE, IN ORDER, WITH LOTS. Order matters and is asserted:
 *      Python's `open_legs` is `[shift…, sell] + recycled` and a set comparison
 *      would let a reordered or double-counted package through.
 *   3. THE EXIT SET, WITH THE PARTIAL'S SIZE. Python splits exits across
 *      `close_ids` (whole legs) and `close_parts` (`{id, lots}`, at most one);
 *      the engine spells the same two as `close` and `resize`. The canonical
 *      form below carries the RESULTING lot count, so a partial that took the
 *      wrong number of lots cannot pass as "the same instrument".
 *   4. `state_after`, ON THE FIELDS BOTH SIDES HAVE. `rcCredit`, `rcEodDay`,
 *      `gkAnchor`, `gkStreak` — the four `RuleState` numerics with a Python
 *      counterpart — plus Python's deferred `state_commit` against the engine's
 *      `creditCommit`, and an assertion that NOTHING ELSE in `RuleState` moved.
 *      Python's `rc_seen` has no counterpart by design (`tiers.ts` §6); the
 *      suite therefore also asserts that the only keys the recorded
 *      `state_after` ever grows are ones this list covers, so a Python key the
 *      adapter silently drops cannot hide a divergence.
 *
 * REASON STRINGS ARE NOT COMPARED. Their formatting deliberately differs (the
 * engine's reasons name the tier that acted; Python's are one run-on line), and
 * a suite that diffed prose would fail on punctuation and pass on arithmetic.
 *
 * ── THE COMPOSITION NOW LIVES IN `src/engine.ts` (ticket 08) ────────────────
 * `recenter_shift` merges phase 1 and phase 2 into ONE decision and sizes phase
 * 2 off the POST-shift greeks (`playbooks.py:4029`, `:4008-4009`). The engine
 * splits that: `phaseShift` returns the roll-forward as an ADJUSTMENT and
 * `phaseShed` takes the corridor as a parameter, precisely so the orchestrator
 * can hand it the post-shift band. The composer that used to live here is now
 * `decide()`, and `replay` below is the thin adapter onto it.
 *
 * ── WHAT THE FIXTURE IS A RECORD OF, AND THE ONE DIAL THAT FOLLOWS FROM IT ──
 * `scripts/gen-decision-fixtures.py:393` calls `fn(call_ctx, params)` — the
 * PLAYBOOK BODY — not `RuleEngine.decide`. So a recorded decision is phase S +
 * phase R and nothing else: no guard tier, no scrap tier, no sell gate, no
 * margin projection, no deferred commit. `decide()` runs all six, and a replay
 * is only a comparison where the six are inert on these inputs. Five of them
 * are, and it was MEASURED rather than assumed, over all 1,152 marks:
 *
 *   - target lock — 0 marks reach `total_pnl >= 250,000` (the highest is far
 *     under it), so the lock neither arms nor advances a streak;
 *   - margin guard — 0 marks are over cap (the highest is 85% of it);
 *   - expiry settle — 72 marks carry `dte 0`, all of them between 09:20 and
 *     09:45, and the settle fires only on the LAST mark of expiry day;
 *   - session gate — every mark is 09:20–15:30 on 2026-06-02, a Tuesday;
 *   - sell gate — 0 of the 522 recorded Sell opens is banned, sub-price or
 *     sub-delta at its own preset's dials;
 *   - margin projection — 0 of the 498 marks that open a sell under a cap
 *     projects over it.
 *
 * The SIXTH is not inert, and `playbookOnlyDials` below is the whole of the
 * accommodation: three presets ship `scrap_close_delta: 0.1` and the recorded
 * books carry 216 short legs under it. Python's real engine WOULD have scrapped
 * them (`engine.py:914-918`) — the fixture simply never asked it to. Turning
 * the tier off for the replay compares like with like and removes no assertion,
 * because there is no recorded scrap decision to compare against; `scrap.test.ts`
 * is where that tier is checked. It is spelled as a named function rather than
 * folded into `adaptDials` so that the deviation is visible at the call site.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  EMPTY_RULE_STATE,
  SESSION_OPEN_MIN,
  corridor,
  decide,
  phaseShift,
  rollForward,
  type AppliedCredit,
  type Corridor,
  type Dials,
  type EngineAction,
  type OptType,
  type RuleState,
  type Side,
} from '@algomaker/desk-engine'
import {
  adaptDials,
  adaptInputs,
  adaptState,
  loadDecisionFixture,
  type PyLeg,
  type PyMark,
  type PySequence,
} from './parity-adapter.ts'

/** Every preset the generator froze — `ticket-02-report.md`'s twelve keys. */
const FAMILY = [
  'recenter',
  'recenter-eod',
  'recenter-eod3',
  'recenter-trend',
  'recenter-reshift',
  'recenter-crossfill',
  'recenter-atm',
  'recenter-otm',
  'recenter-relief',
  'recenter-relief-b1',
  'recenter-relief-b2',
  'recenter-relief-free',
] as const

// ── the thin adapter onto `decide` ──────────────────────────────────────────

/**
 * The dials a PLAYBOOK-BODY record can be replayed against — see the header.
 *
 * The scrap tier is the one part of `decide` that is live on these inputs and
 * has no counterpart in the recording, so it is switched off by its own two
 * off-states rather than by a flag inside the engine. Nothing else is touched:
 * `min_sell_px` / `min_sell_delta` stay exactly as `adaptDials` mapped them,
 * and the sell gate they drive runs for real on all 522 recorded Sell opens.
 */
const playbookOnlyDials = (dials: Dials): Dials => ({
  ...dials,
  scrap_close_px: 0,
  scrap_close_delta: 0,
})

interface Replayed {
  readonly actions: ReadonlyArray<EngineAction>
  readonly stateAfter: RuleState
  readonly commit: AppliedCredit | null
  readonly reason: string
  /** The band phase R was handed — post-shift where a shift fired. `null` on a
   * mark that returned before the delta phase ran at all. */
  readonly cor: Corridor | null
}

/**
 * One recorded mark through `decide`, plus the corridor it sized off.
 *
 * THE CORRIDOR IS RE-DERIVED, NOT RE-IMPLEMENTED. `decide` does not report the
 * band it handed phase R — it is an internal measurement, not part of a
 * decision — so the band checks below rebuild it from the SAME two exported
 * functions `decide` itself calls, `corridor()` and `rollForward()`. That is
 * what the composer this file used to carry did too, except that `rollForward`
 * was a copy living here; it is now the one in `src/engine.ts`, so the 1,072
 * band comparisons check the shipped arithmetic rather than a test's echo of
 * it. The `shift.fired && !hedge_after_shift` branch is the only thing restated,
 * and it is restated as `cor: null` — the same "phase R never ran" the old
 * composer reported.
 */
function replay(seq: PySequence, mark: PyMark): Replayed {
  const dials = playbookOnlyDials(adaptDials(seq.seed, mark.ctx))
  const inputs = adaptInputs(seq, mark)
  const state = adaptState(mark.ctx.state)
  // Every recorded mark IS a 5-minute mark of the same session, threaded in
  // order (`ticket-02-report.md`), which is exactly what `markCtx` describes.
  const markCtx = {
    isNewMark: true,
    markIndexToday: Math.max(0, Math.round((inputs.minuteOfDay - SESSION_OPEN_MIN) / 5)),
  }

  const out = decide(inputs, dials, state, markCtx)

  const shift = phaseShift(inputs, dials, state)
  const base = corridor(inputs, dials)
  const cor =
    shift.fired && !dials.hedge_after_shift
      ? null
      : shift.fired
        ? rollForward(base, shift, inputs, dials)
        : base

  return {
    actions: out.actions,
    stateAfter: out.stateAfter,
    commit: out.creditCommit,
    reason: out.reason,
    // The EOD sweep is the corridor at tolerance 0 and `phaseShed` derives that
    // internally, so the band Python NAMES on a swept mark is not this one.
    // Marked by the reason itself below.
    cor,
  }
}

// ── the band, read back out of Python's own numbers ─────────────────────────

/**
 * THE ONE THING THE PACKAGE COMPARISON CANNOT SEE: the post-shift corridor.
 *
 * `rollForward` is the arithmetic `recenter_shift` does in place at `:4008-4009`
 * — and on every recorded shift mark phase R then holds on the convexity floor,
 * BEFORE and AFTER the roll. So a composer that handed phase R the PRE-shift
 * band would produce a byte-identical package on all 1,152 marks. (Measured: on
 * the 36 shift-and-hedge marks the allowance is 28 pre-shift and 77 post, both
 * under the 100 lot.)
 *
 * Python writes both figures into its reason — `netΓ {ng:+.1f}` and
 * `allowance/allowed {allowed:,.0f}` — so the numbers ARE recorded even though
 * the decision they produced is the same either way. Reading them back is the
 * same technique `parity-shift.test.ts` uses for the shift notes, and it is the
 * difference between "the packages agree" and "the measurements agree".
 *
 * `{:,.0f}` and `{:+.1f}` are Python's formats; `n0`/`f1` below are the shapes
 * `shed.ts` already reproduces for the same numbers.
 */
const n0 = (x: number): string => Math.round(x).toLocaleString('en-US')
const f1 = (x: number): string => `${x >= 0 ? '+' : '-'}${Math.abs(x).toFixed(1)}`

/** Python's first `allowance N` / `allowed N` in a reason, or null. The pattern
 * ends on a DIGIT so the sentence's own comma ("allowed 111, shed 89") cannot
 * be swallowed into the group and turn a match into a mismatch. */
function recordedAllowed(reason: string): string | null {
  return /allow(?:ance|ed) (\d[\d,]*\d|\d)/.exec(reason)?.[1] ?? null
}

/** Python's first `netΓ ±N.N`, or null. The `|netΓ| N.N` form of the in-band
 * line is unsigned and is matched separately so a sign error cannot hide. */
function recordedGamma(reason: string): { signed: string | null; magnitude: string | null } {
  return {
    signed: /netΓ ([+-][\d.]+)/.exec(reason)?.[1] ?? null,
    magnitude: /\|netΓ\| ([\d.]+)/.exec(reason)?.[1] ?? null,
  }
}

// ── the two decisions, in one vocabulary ────────────────────────────────────

interface Package {
  readonly action: 'hold' | 'adjust'
  readonly opens: ReadonlyArray<string>
  readonly exits: ReadonlyArray<string>
}

const openKey = (strike: number, optType: OptType, side: Side, lots: number): string =>
  `open ${lots}x ${strike}${optType} ${side}`

/** `close <id>` or `resize <id> -> <lots>`; sorted, because Python's exit ORDER
 * carries no meaning downstream (both lists are consumed by id) while its
 * membership and the surviving lot count carry all of it. */
const exitKeys = (raw: ReadonlyArray<string>): ReadonlyArray<string> => [...raw].sort()

function enginePackage(actions: ReadonlyArray<EngineAction>): Package {
  const opens: string[] = []
  const exits: string[] = []
  for (const a of actions) {
    if (a.op === 'open') opens.push(openKey(a.strike, a.optType, a.side, a.lots))
    else if (a.op === 'close') exits.push(`close ${a.instrument}`)
    else exits.push(`resize ${a.instrument} -> ${a.targetLots}`)
  }
  return { action: actions.length > 0 ? 'adjust' : 'hold', opens, exits: exitKeys(exits) }
}

function pythonPackage(mark: PyMark): Package {
  const { decision } = mark
  const held = new Map<string, number>()
  for (const l of mark.ctx.marked_book.legs ?? []) held.set(l.id, Math.trunc(l.lots))

  const opens = decision.open_legs.map((o) =>
    openKey(
      o.strike,
      o.opt_type,
      String(o.side).trim().toLowerCase() === 'sell' ? 'Sell' : 'Buy',
      Math.trunc(o.lots),
    ),
  )
  const exits = [
    ...decision.close_ids.map((id) => `close ${id}`),
    // A partial close of `lots` leaves `held − lots` standing, which is exactly
    // what `resize` names. Reading it as a set of instruments would let a
    // 1-lot buy-back pass as a 5-lot one.
    ...(decision.close_parts ?? []).map(
      (p) => `resize ${p.id} -> ${(held.get(p.id) ?? 0) - Math.trunc(p.lots)}`,
    ),
  ]
  return {
    action: decision.action === 'adjust' ? 'adjust' : 'hold',
    opens,
    exits: exitKeys(exits),
  }
}

// ── state ───────────────────────────────────────────────────────────────────

/**
 * The `st[...]` keys a recorded `state_after` may carry. `rc_seen` is Python's
 * derived provenance ledger and has no `RuleState` counterpart by design
 * (`tiers.ts` §6); the other four do, and are compared field for field. A key
 * outside this list means Python grew state the port does not know about, and
 * the suite says so by name rather than passing.
 */
const KNOWN_STATE_KEYS = new Set(['rc_seen', 'rc_credit', 'rc_eod_day', 'gk_anchor', 'gk_streak'])

/** The four fields both sides have — `adaptState` maps them, and everything
 * else in `RuleState` is checked separately for having NOT moved. */
const shared = (s: RuleState) => ({
  rcCredit: s.rcCredit,
  rcEodDay: s.rcEodDay,
  gkAnchor: s.gkAnchor,
  gkStreak: s.gkStreak,
})

/**
 * Python's deferred `state_commit`, in `AppliedCredit`'s vocabulary — including
 * `keptLots`, counted off PYTHON's OWN surviving Sell opens.
 *
 * `_commit_state` (`engine.py:996-998`) sums the decision's Sell opens at the
 * commit's `opt_type` AND `strike`; the strike match is the 2026-08-03 recycle
 * fix, because the crossfill's recycle leg shares the residual sell's opt_type
 * and a dropped recycle would otherwise be debited for the residual's lots.
 * Counting it here means the engine's own `keptLots` is compared against
 * Python's on every banking mark, not just the resulting rupees.
 */
function pythonCommit(mark: PyMark): AppliedCredit | null {
  const c = mark.decision.state_commit
  if (c === undefined || c === null) return null
  const optType = String(c['opt_type']) as OptType
  const strike = Number(c['strike'])
  let keptLots = 0
  for (const o of mark.decision.open_legs) {
    if (String(o.side).trim().toLowerCase() !== 'sell') continue
    if (o.opt_type !== optType || Number(o.strike) !== strike) continue
    keptLots += Math.trunc(o.lots)
  }
  return {
    base: Number(c['base']),
    value: Number(c['value']),
    lots: Math.trunc(Number(c['lots'])),
    optType,
    strike,
    keptLots,
  }
}

/**
 * The recorded `state_after` WITH `_commit_state` applied — `engine.py:946-1006`
 * transliterated onto the recorded side.
 *
 * The generator stops at the playbook body, so a fixture's `state_after` is
 * PRE-commit and its `state_commit` is still deferred; `decide` runs the commit
 * as step 10 and its `stateAfter` is therefore post-commit. Comparing the two
 * raw would report a divergence on the 30 marks that bank, and comparing only
 * `creditCommit` structurally would leave the SCALING untested. So both are
 * asserted, and they do different jobs. This reconstruction REPRODUCES
 * `_commit_state` on the recorded side — it restates the arithmetic rather than
 * pinning it, so on its own it could agree with a port that made the same
 * mistake. What pins the port is `assert.deepEqual(out.commit, wantCommit)`
 * below, which compares `base`, `value`, `lots`, `optType`, `strike` AND
 * `keptLots` field for field against numbers read straight out of the fixture.
 */
function pythonCommitted(mark: PyMark): RuleState {
  const st = adaptState(mark.state_after)
  const c = pythonCommit(mark)
  if (c === null || mark.decision.action !== 'adjust' || c.lots <= 0) return st
  if (c.keptLots <= 0) return st
  return {
    ...st,
    rcCredit: c.base + (c.value - c.base) * Math.min(1, c.keptLots / c.lots),
  }
}

// ── the run ─────────────────────────────────────────────────────────────────

interface Tally {
  marks: number
  adjust: number
  hold: number
  opens: number
  exits: number
  commits: number
  stateMoves: number
  bandChecks: number
  gammaChecks: number
}

const ZERO = (): Tally => ({
  marks: 0,
  adjust: 0,
  hold: 0,
  opens: 0,
  exits: 0,
  commits: 0,
  stateMoves: 0,
  bandChecks: 0,
  gammaChecks: 0,
})

const TOTAL = ZERO()
const PER_FILE = new Map<string, Tally>()

/** Both decisions side by side — the message every assertion below carries. */
function side(where: string, want: Package, got: Package, mark: PyMark, out: Replayed): string {
  return [
    `\n${where}`,
    `  PYTHON  ${want.action}  opens=${JSON.stringify(want.opens)}  exits=${JSON.stringify(want.exits)}`,
    `          state_after=${JSON.stringify(mark.state_after)}`,
    `          reason=${JSON.stringify(mark.decision.reason)}`,
    `  ENGINE  ${got.action}  opens=${JSON.stringify(got.opens)}  exits=${JSON.stringify(got.exits)}`,
    `          state_after=${JSON.stringify(shared(out.stateAfter))}`,
    `          reason=${JSON.stringify(out.reason)}`,
  ].join('\n')
}

function runMark(preset: string, tally: Tally, seq: PySequence, mark: PyMark, i: number): void {
  const where = `${preset} / ${seq.seed.case} / mark ${i} @ ${mark.ctx.time}`
  const out = replay(seq, mark)
  const got = enginePackage(out.actions)
  const want = pythonPackage(mark)
  const msg = side(where, want, got, mark, out)

  tally.marks += 1
  if (want.action === 'adjust') tally.adjust += 1
  else tally.hold += 1
  tally.opens += want.opens.length
  tally.exits += want.exits.length

  // 1 + 2 + 3: the package.
  assert.equal(got.action, want.action, `action differs${msg}`)
  assert.deepEqual(got.opens, want.opens, `open package differs${msg}`)
  assert.deepEqual(got.exits, want.exits, `exit package differs${msg}`)

  // 4: the state, and the assertion that the adapter is not hiding a key.
  for (const key of Object.keys(mark.state_after)) {
    assert.ok(KNOWN_STATE_KEYS.has(key), `Python grew an unknown state key ${key}${msg}`)
  }
  const pyState = pythonCommitted(mark)
  assert.deepEqual(shared(out.stateAfter), shared(pyState), `state_after differs${msg}`)
  if (JSON.stringify(shared(pyState)) !== JSON.stringify(shared(adaptState(mark.ctx.state)))) {
    tally.stateMoves += 1
  }

  // Nothing else in `RuleState` may move: the engine's own extra fields belong
  // to phases this file does not run, and `rcStack` is written by whoever
  // APPLIES a decision — never by a replay, which executes nothing.
  const before = adaptState(mark.ctx.state)
  assert.deepEqual(out.stateAfter.rcStack, before.rcStack, `rcStack moved on a replay${msg}`)
  assert.deepEqual(out.stateAfter.scrapBanned, before.scrapBanned, `scrapBanned moved${msg}`)
  assert.equal(out.stateAfter.targetStreak, before.targetStreak, `targetStreak moved${msg}`)
  assert.equal(out.stateAfter.targetLocked, before.targetLocked, `targetLocked moved${msg}`)

  const wantCommit = pythonCommit(mark)
  if (wantCommit !== null) tally.commits += 1
  assert.deepEqual(out.commit, wantCommit, `state_commit differs${msg}`)

  // 5: the MEASUREMENT, where Python recorded one. The EOD sweep is excluded
  // because `phaseShed` derives its tolerance-0 band internally and Python's
  // swept line names no allowance at all — there is nothing to compare.
  if (out.cor !== null && !/sweep —/.test(mark.decision.reason)) {
    const band = recordedAllowed(mark.decision.reason)
    if (band !== null) {
      tally.bandChecks += 1
      assert.equal(n0(out.cor.allowed), band, `the band Python measured differs${msg}`)
    }
    const g = recordedGamma(mark.decision.reason)
    if (g.signed !== null) {
      tally.gammaChecks += 1
      assert.equal(f1(out.cor.netGamma), g.signed, `netΓ differs${msg}`)
    }
    if (g.magnitude !== null) {
      tally.gammaChecks += 1
      assert.equal(Math.abs(out.cor.netGamma).toFixed(1), g.magnitude, `|netΓ| differs${msg}`)
    }
  }
}

for (const preset of FAMILY) {
  test(`${preset}: every recorded decision, mark for mark`, () => {
    const tally = ZERO()
    PER_FILE.set(preset, tally)
    for (const seq of loadDecisionFixture(preset)) {
      seq.marks.forEach((mark, i) => {
        runMark(preset, tally, seq, mark, i)
      })
    }
    for (const k of Object.keys(tally) as (keyof Tally)[]) TOTAL[k] += tally[k]
  })
}

test('the fixture set is the one this suite claims to have replayed', () => {
  // 12 presets x 16 sequences x 6 marks. A filter that matched nothing, or a
  // file that lost sequences in a regeneration, would otherwise pass every
  // assertion above by running none of them.
  assert.equal(TOTAL.marks, 1_152)

  // Per file, on EXACT numbers rather than "greater than zero", because these
  // are the coverage claim: `ticket-02-report.md`'s regenerated table says 588
  // of 1,152 marks are non-hold and names which files reach `close_ids` and
  // which reach `close_parts`. A regeneration that quietly stopped exercising
  // an arm would keep this suite green on a smaller claim; this fails instead.
  const table: Record<string, [marks: number, adjust: number, exits: number, commits: number]> = {
    recenter: [96, 48, 30, 0],
    'recenter-eod': [96, 42, 0, 0],
    'recenter-eod3': [96, 42, 0, 0],
    'recenter-trend': [96, 48, 30, 0],
    'recenter-reshift': [96, 48, 30, 6],
    'recenter-crossfill': [96, 48, 30, 24],
    'recenter-atm': [96, 54, 18, 0],
    'recenter-otm': [96, 54, 18, 0],
    'recenter-relief': [96, 42, 6, 0],
    'recenter-relief-b1': [96, 60, 6, 0],
    'recenter-relief-b2': [96, 30, 6, 0],
    'recenter-relief-free': [96, 72, 6, 0],
  }
  for (const preset of FAMILY) {
    const t = PER_FILE.get(preset)
    assert.deepEqual(
      [t?.marks, t?.adjust, t?.exits, t?.commits],
      table[preset],
      `${preset}: [marks, adjust, exits, commits] moved`,
    )
  }

  // And the totals the whole family has to reach for "parity" to mean anything.
  assert.equal(TOTAL.adjust, 588, 'the non-hold count from ticket-02 §b')
  assert.equal(TOTAL.hold, 564)
  assert.equal(TOTAL.opens, 522)
  assert.equal(TOTAL.exits, 180, 'unwinds and shifts, whole legs and partials')
  assert.equal(TOTAL.commits, 30, 'the recycle bank deferred a debit 30 times')
  assert.equal(TOTAL.stateMoves, 50, 'marks whose state_after differs from the state they got')

  // The measurement checks, which are what make the post-shift roll-forward
  // observable at all (see the block above `recordedAllowed`).
  assert.equal(TOTAL.bandChecks, 1_072, 'marks whose recorded reason names an allowance')
  assert.equal(TOTAL.gammaChecks, 546, 'marks whose recorded reason names a netΓ')
})

test('a fresh RuleState is what the first mark of every sequence is handed', () => {
  // The generator threads `ctx.state` from each mark's `state_after`, so mark 0
  // starts empty and the sequence is a real state machine rather than six
  // independent marks (`ticket-02-report.md`). If that ever stopped being true
  // the state assertions above would be comparing a book to itself.
  let seeded = 0
  for (const preset of FAMILY) {
    for (const seq of loadDecisionFixture(preset)) {
      const first = seq.marks[0]
      if (first === undefined) continue
      assert.deepEqual(adaptState(first.ctx.state), EMPTY_RULE_STATE, `${preset}/${seq.seed.case}`)
      seeded += 1
    }
  }
  assert.equal(seeded, 192)
})

test('the legs a decision names are legs the book actually holds, and BOTH exit branches are reached', () => {
  // Two claims in one walk.
  //
  // First, a guard on the COMPARISON rather than on the engine: `pythonPackage`
  // reads a partial close's surviving lot count off the book, and an id it could
  // not find would silently render as `-> -1` on both sides of a diff that then
  // agreed. Nothing may close what is not there.
  //
  // Second, the WHOLE-vs-PARTIAL split, per file. `ticket-02-report.md`'s
  // follow-up records that these two swapped places when the fixtures were
  // regenerated for physical consistency — on a consistent book the positive net
  // delta COMES FROM the short puts, so `excess` is always less than one whole
  // leg and `_rc_unwind`'s `take >= lots` branch cannot fire on a one-leg-a-side
  // book. A global "at least one partial exists somewhere" would keep passing if
  // a regeneration moved the whole family onto one branch; this names which file
  // covers which, so that move fails instead.
  const table: Record<string, [wholes: number, parts: number]> = {
    recenter: [0, 30],
    'recenter-eod': [0, 0],
    'recenter-eod3': [0, 0],
    'recenter-trend': [30, 0],
    'recenter-reshift': [0, 30],
    'recenter-crossfill': [0, 30],
    'recenter-atm': [18, 0],
    'recenter-otm': [18, 0],
    'recenter-relief': [6, 0],
    'recenter-relief-b1': [6, 0],
    'recenter-relief-b2': [6, 0],
    'recenter-relief-free': [6, 0],
  }
  let wholesSeen = 0
  let partsSeen = 0

  for (const preset of FAMILY) {
    let wholes = 0
    let parts = 0
    for (const seq of loadDecisionFixture(preset)) {
      for (const mark of seq.marks) {
        const ids = new Set((mark.ctx.marked_book.legs ?? []).map((l: PyLeg) => l.id))
        for (const id of mark.decision.close_ids) {
          assert.ok(ids.has(String(id)), `${preset}/${seq.seed.case}: closed a phantom ${id}`)
          wholes += 1
        }
        for (const p of mark.decision.close_parts ?? []) {
          assert.ok(ids.has(p.id), `${preset}/${seq.seed.case}: part-closed a phantom ${p.id}`)
          parts += 1
        }
      }
    }
    assert.deepEqual([wholes, parts], table[preset], `${preset}: [close_ids, close_parts] moved`)
    // Every exit a file has is one branch or the other, and the totals above
    // already agree with the per-file `exits` count in the coverage test.
    wholesSeen += wholes
    partsSeen += parts
  }

  assert.equal(wholesSeen, 90, 'whole-leg unwinds and shift closes')
  assert.equal(partsSeen, 90, 'the partial-unwind branch')
  assert.equal(wholesSeen + partsSeen, 180, 'and together they are every exit compared above')
})
