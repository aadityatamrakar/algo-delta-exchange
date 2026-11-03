/**
 * WHAT THE BOT IS ABOUT TO DO, AND WHY — the machine-mind card.
 *
 * Every live stock book on this desk runs the `recenter-relief` playbook, and
 * the operator watching the payoff panel has no way to see what it is thinking:
 * the dashboard shows the book's greeks, the bot decides on a different pair of
 * numbers, and the two have opposite signs often enough that they read as a
 * contradiction. This module states the bot's rules back, in figures.
 *
 * IT IS NOT A PORT. Nothing here decides anything or emits an order — it reports
 * whether the two conditions the playbook actually gates on are met right now.
 * The conditions were read out of the desk's own source, and every claim below
 * cites the line it came from:
 *
 *   `sensibull-desk/sensibull_tools/sim/rules/playbooks.py`
 *     :472-477   DEFAULTS["recenter-relief"] — the shipped dials.
 *     :5394      REGISTRY maps "recenter-relief" (and -b1/-b2/-free) to
 *                `recenter_shift`, so that function IS this playbook.
 *     :3839      `recenter_shift` — two phases that merge into one decision.
 *
 * ── PHASE 1, THE SHIFT, AND ITS MARGIN GATE (:3902-3934) ────────────────────
 *
 *     _mfrac = float(p.get("shift_margin_frac", 0.0) or 0.0)   # :3910
 *     _margin_ok = True
 *     if _mfrac > 0:
 *         _margin_ok = _cap > 0 and (_mgn / _cap) >= _mfrac    # :3918
 *     if dte > int(p.get("min_sell_dte", 1)) and _margin_ok:   # :3920
 *         …every short at least `shift_itm_steps` strike steps ITM is closed
 *         and re-sold at the SAME lots `shift_land_steps` beyond ATM (:3921-3973)
 *
 * Three things that are easy to get wrong and are pinned by the tests:
 *
 *   1. The comparison is `>=`, not `>` — margin exactly at the fraction shifts.
 *   2. `shift_margin_frac` of 0 (or absent) disables THE GATE, not the shifting:
 *      `_margin_ok` stays `True` and the bot shifts at any margin at all. The
 *      docstring's "0 disables" (:3907) means the gate.
 *   3. An UNCAPPED book (`margin_cap` missing or 0) with a gate set does NOT
 *      shift — `_cap > 0 and …` is False. Deliberate: "no ceiling to be a
 *      fraction of … the safe reading is do not shift" (:3908-3909).
 *
 * `marginUsed` here is the BROKER's number (`desk-book-margin.brokerTotal`),
 * which is the figure the operator is looking at; the bot gates on the sim's own
 * `ctx["margin"]`. They answer the same question and are not the same number, so
 * this card reports a gate that is CLOSE to the bot's, not identical to it.
 *
 * ── PHASE 2, THE DELTA SHED, AND WHAT `delta_tol_pct` IS A TOLERANCE OF ─────
 *
 *     measured = abs(ng) * tol * spot          # :4014
 *     excess   = abs(nd) - allowed             # :4072   → act when > 0 (:4085)
 *
 * So `delta_tol_pct` is NOT a tolerance of delta. It is a tolerance of MOVE:
 * `allowed` is the delta a `delta_tol_pct` move would create through the book's
 * own gamma, so the rule holds while the book's zero-delta point — the peak of
 * the P&L parabola on a short-gamma book — sits within `delta_tol_pct` of spot,
 * either side (:3399-3404). The bot prints that quantity itself when it sheds:
 * `off = abs(nd / ng) / spot` (:4114). `deltaImbalance` IS that number, kept
 * SIGNED because its sign names the side that gets sold (`side = "CE" if nd > 0
 * else "PE"`, :4056), and `wouldRebalance` is `|deltaImbalance| > deltaTolPct`,
 * which is `excess > 0` divided through by `|netΓ|·spot`.
 *
 * WHICH DELTA AND GAMMA. `nd`/`ng` come from `_net_delta_for` / `_net_gamma_for`
 * (:2946, :2920), which read the SHORT LEGS ONLY when `delta_shorts_only` /
 * `gamma_shorts_only` are set — and they are set on every live relief-r book
 * (user-directed 2026-08-12, "buy legs are making issue so we ignore them from
 * the position … its just for hedge"). The difference is not cosmetic: on the
 * live BHEL book the whole book was +408 delta while the shorts alone were
 * -1836, opposite signs (`sim/rules/engine.py`:223-260, `steering_greeks` — the
 * desk has a second, unrelated `sim/engine.py`, so the path matters). That pair
 * is exactly what the bridge publishes as `steeringDelta`/`steeringGamma`, it is
 * what belongs in `ReliefState.steering`, and the notes say which greeks it is.
 *
 * ── WHAT THIS CARD CANNOT SEE, AND THEREFORE PROMISES CAREFULLY ─────────────
 *
 *   • The UNDER-ONE-LOT FLOOR (:4069-4084). Even with `excess > 0` the bot holds
 *     when `allowed` is thinner than one lot of the strike it would sell — "no
 *     convexity to centre". This is not an edge case: on the live TCS book
 *     (:439) the whole-book pair gave allowance 141 against a 225 lot and the
 *     rule was silent all session while the book carried +422 delta. Lot size is
 *     not in this state, so a firing verdict is reported WITH that caveat —
 *     except on the arms below, which change or remove the floor entirely.
 *   • `dte > min_sell_dte` gates both phases (:3920, :4088) — no fresh sells
 *     into expiry. No dte in this state either.
 *   • `hedge_after_shift` is False on relief (:476): a mark that shifted returns
 *     at :3979-3981 and never reaches the delta phase. So both triggers can read
 *     "armed" and only the shift happens on that mark. The notes say so. The
 *     Python reads it as `p.get("hedge_after_shift", True)`, so an ABSENT dial
 *     hedges — only a present, falsy one skips.
 *   • An open shift gate is not a shift: phase 1 is skipped wholesale inside
 *     `min_sell_dte` (:3920) and only touches shorts at least `shift_itm_steps`
 *     steps ITM, on a signed depth so an OTM leg is never moved (:3921-3933).
 *
 * ── THE -b1 / -b2 / -free ARMS RUN THIS SAME PLAYBOOK ───────────────────────
 *
 * The registry points them here too (:5397-5399; their DEFAULTS are spread from
 * relief's at :558-560), and their band dials change the arithmetic above:
 *
 *   `min_band_lots`  CLAMP (:4015): `allowed = max(measured, mbl x lot_size)`.
 *                    The clamp only ever WIDENS the band, so "inside the
 *                    measured tolerance" stays sound while "past it" stops being
 *                    a verdict — the lot size that sets the clamp is not in this
 *                    state. `wouldRebalance` is `null` there, never an
 *                    over-promise.
 *   `no_band_floor`  FREE: :4073 reads `if not (mbl > 0 or free)`, so the
 *                    under-one-lot guard does not exist on this arm and
 *                    repeating its caveat would describe a rule the book does
 *                    not run.
 *
 * BOTH ARE READ AS PYTHON READS THEM — `bool()`, not `=== true`. `dials` is
 * assembled from Mongo, where a flag routinely arrives as 1/0, and an identity
 * check would silently mis-state every one of these rules.
 *
 * FAIL-SOFT, AND NULL MEANS UNKNOWN. Every field is `number | null` /
 * `boolean | null` and a `null` is never a 0 or a false: this card sits next to
 * a live position and "the margin gate is shut" and "I could not read the
 * margin" are different sentences to the human deciding whether to intervene.
 */

/**
 * Everything the card needs to state the bot's rules, as the bridge can
 * actually assemble it.
 *
 * `dials` is the registry row's dials laid over the variant defaults — the same
 * merge the Books page does — so an absent key here means the playbook really
 * does not declare it, and the Python's own default applies.
 */
export interface ReliefState {
  /**
   * The pair the RULE steers by (`desk-declarations` `steeringDelta` /
   * `steeringGamma`), which under the shorts-only dials is NOT the book's net
   * greeks. `null` when the engine reported none.
   */
  readonly steering: { readonly delta: number; readonly gamma: number } | null
  /**
   * Registry dials over variant defaults. A flag may arrive as `1`/`0` — every
   * flag here is read with Python's `bool()`, never an identity check.
   */
  readonly dials: Readonly<Record<string, number | boolean>>
  /** `desk-book-margin.brokerTotal` — rupees. `null` when it was never fetched. */
  readonly marginUsed: number | null
  /**
   * The price the delta band is a fraction OF (`allowed = |netΓ|·tol·spot`,
   * playbooks.py:4014). Optional because the two margin fields are readable
   * without it — but with no spot there is no band, and `deltaImbalance` comes
   * back `null` rather than guessed.
   */
  readonly spot?: number | null
}

/** The bot's two triggers, evaluated — plus the sentences that explain them. */
export interface ReliefTriggers {
  /** `delta_tol_pct` — a tolerance of MOVE, not of delta. See the file header. */
  readonly deltaTolPct: number | null
  /**
   * `netΔ / (|netΓ| · spot)`: how far the book's zero-delta point sits from
   * spot, as a fraction of spot. Signed — positive means the bot would sell CE.
   */
  readonly deltaImbalance: number | null
  /** `|deltaImbalance| > deltaTolPct`, i.e. the bot's `excess > 0`. */
  readonly wouldRebalance: boolean | null
  /** Is phase 1's margin gate open? `null` only when the margin is unknown. */
  readonly shiftEnabled: boolean | null
  /** `marginUsed / margin_cap`. */
  readonly marginFrac: number | null
  /** The hard flatten-and-bank level (`sim/rules/engine.py`:453-457). */
  readonly targetPnl: number | null
  /** Human sentences, each naming its numbers. Safe to render verbatim. */
  readonly notes: readonly string[]
}

/**
 * The answer when there is no state at all — note the difference from a state
 * whose `dials` happen to be empty, which is a real book that declares no margin
 * gate. FROZEN because it is handed out by reference on every such call.
 */
const NOTHING: ReliefTriggers = Object.freeze({
  deltaTolPct: null,
  deltaImbalance: null,
  wouldRebalance: null,
  shiftEnabled: null,
  marginFrac: null,
  targetPnl: null,
  notes: Object.freeze(['no relief state to read']),
})

/** A finite number, or `null`. A boolean dial is NOT a number — `true` is not 1. */
function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/**
 * Python `bool()` on a dial value, for the dials the playbook reads as flags.
 *
 * The Python asks `p.get("delta_shorts_only")` and `bool(p.get("no_band_floor"))`
 * — plain truthiness, never an identity check — and `dials` here is assembled
 * from Mongo, where a boolean routinely arrives as `1`/`0`. Testing `=== true`
 * would print "the whole book, longs included" over a shorts-only book, which is
 * the one sentence this card exists to prevent. `0` (and `0.0`) are the only
 * falsy numbers in Python; `NaN` is TRUE there, and is here too.
 */
function truthy(v: unknown): boolean {
  if (typeof v === 'boolean') return v
  if (typeof v === 'number') return v !== 0
  if (typeof v === 'string') return v !== ''
  return v !== undefined && v !== null
}

/** `0.41` → `"41%"`, `0.0458` → `"4.6%"`. At most one decimal, no trailing `.0`. */
function pct(v: number): string {
  return `${String(Number((v * 100).toFixed(1)))}%`
}

/**
 * Indian grouping — `250000` → `"2,50,000"`. Written out rather than handed to
 * `Intl` because the note text is asserted in tests and `en-IN` grouping depends
 * on the ICU build the box happens to have.
 */
function inr(v: number): string {
  const n = Math.round(Math.abs(v))
  const s = String(n)
  const head = s.length > 3 ? s.slice(0, -3) : ''
  const tail = s.length > 3 ? s.slice(-3) : s
  const grouped = head === '' ? tail : `${head.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${tail}`
  return `${v < 0 ? '-' : ''}₹${grouped}`
}

/**
 * Evaluate the `recenter-relief` playbook's two triggers against a book's
 * current state. Pure, total, and never throws — see the file header for the
 * semantics and the playbooks.py lines each one came from.
 */
export function reliefTriggers(s: ReliefState): ReliefTriggers {
  if (s === null || typeof s !== 'object') return NOTHING

  const dials: Record<string, unknown> =
    s.dials !== null && typeof s.dials === 'object' ? (s.dials as Record<string, unknown>) : {}
  const notes: string[] = []

  const deltaTolPct = num(dials['delta_tol_pct'])
  const targetPnl = num(dials['target_pnl'])
  const cap = num(dials['margin_cap'])
  const marginUsed = num(s.marginUsed)
  const spot = num(s.spot)
  const steering =
    s.steering !== null && typeof s.steering === 'object'
      ? { delta: num(s.steering.delta), gamma: num(s.steering.gamma) }
      : null

  // ---- phase 2: the delta shed ------------------------------------------
  const shortsOnly = truthy(dials['delta_shorts_only']) || truthy(dials['gamma_shorts_only'])
  // The -b1/-b2/-free arms (playbooks.py:5397-5399, DEFAULTS spread at :558-560)
  // run this same function with the band dials set. They change what `allowed`
  // is and whether the under-one-lot floor exists at all — see the file header.
  const bandLots = num(dials['min_band_lots']) ?? 0
  const noFloor = truthy(dials['no_band_floor'])
  let deltaImbalance: number | null = null
  let wouldRebalance: boolean | null = null

  if (steering === null || steering.delta === null || steering.gamma === null) {
    notes.push('steering greeks unknown — no verdict on the delta rule')
  } else {
    const { delta, gamma } = steering
    notes.push(
      shortsOnly
        ? `steering delta ${delta.toFixed(0)}, gamma ${gamma.toFixed(2)} — SHORTS ONLY: the ` +
          'dials tell the rule to ignore the bought legs, so this is not the book you see on the tiles'
        : `steering delta ${delta.toFixed(0)}, gamma ${gamma.toFixed(2)} — the whole book, longs included`,
    )
    if (gamma === 0) {
      // playbooks.py:4014 gives allowance 0, which the under-one-lot floor
      // (:4073) always refuses; the band-dial arms hard-code the same hold
      // (:4017-4027). Every configuration holds, and the ratio is a division by
      // zero this card must not print.
      wouldRebalance = false
      notes.push(
        `gamma is exactly 0 — the bot holds the delta phase whatever the delta is (no convexity to centre), ` +
          `and a zero-delta point cannot be measured`,
      )
    } else if (spot === null || spot <= 0) {
      notes.push('spot unknown — the delta band is a fraction OF spot, so there is nothing to compare')
    } else {
      deltaImbalance = delta / (Math.abs(gamma) * spot)
      if (deltaTolPct === null) {
        notes.push(
          `the zero-delta point sits ${pct(Math.abs(deltaImbalance))} of spot away, but no delta tolerance is set — no verdict`,
        )
      } else {
        const out = pct(Math.abs(deltaImbalance))
        const side = deltaImbalance > 0 ? 'CE' : 'PE'
        const pastTol = Math.abs(deltaImbalance) > deltaTolPct
        // playbooks.py:4088 — the no-fresh-sells gate; the Python default is 1.
        const dte = num(dials['min_sell_dte']) ?? 1

        if (bandLots > 0) {
          // A -b arm: `allowed = max(measured, min_band_lots x lot_size)`
          // (playbooks.py:4015). The clamp can only WIDEN the band, so "inside
          // the measured tolerance" is still sound — but "past it" is not a
          // verdict any more, because the lot size that sets the clamp is not in
          // this state. Unknowable is `null`, never an over-promise.
          wouldRebalance = pastTol ? null : false
          notes.push(
            pastTol
              ? `the zero-delta point is ${out} of spot out, past the ${pct(deltaTolPct)} tolerance — but this ` +
                `book clamps its band to a floor of ${bandLots} lots (min_band_lots), and without the lot size ` +
                'there is no telling whether the delta clears it'
              : `delta inside tolerance: the zero-delta point is ${out} of spot out, tolerance ` +
                `${pct(deltaTolPct)} — and the ${bandLots}-lot floor only widens that band`,
          )
        } else {
          wouldRebalance = pastTol
          notes.push(
            pastTol
              ? `delta rebalance armed: the zero-delta point is ${out} of spot out, past the ` +
                `${pct(deltaTolPct)} tolerance — the bot sheds by selling ${side}`
              : `delta inside tolerance: the zero-delta point is ${out} of spot out, tolerance ${pct(deltaTolPct)}`,
          )
          if (pastTol) {
            notes.push(
              noFloor
                ? // A -free arm: playbooks.py:4073 is `if not (mbl > 0 or free)`,
                  // so the under-one-lot guard is simply gone here.
                  `this book has no under-one-lot floor (no_band_floor), so nothing holds the shed back except ` +
                    `the no-fresh-sells gate at ${dte} day(s) to expiry`
                : // The floor that held the live TCS book silent all session
                  // (playbooks.py:4073-4084, and the measured case at :439).
                  'it can still hold this mark: the band must also clear one lot of the strike it would sell ' +
                    `("no convexity to centre"), and it makes no fresh sells with ${dte} day(s) or less to ` +
                    'expiry — neither is visible here',
            )
          }
        }
      }
    }
  }

  // ---- phase 1: the shift, and its margin gate ---------------------------
  const marginFrac = marginUsed !== null && cap !== null && cap > 0 ? marginUsed / cap : null
  const mfrac = num(dials['shift_margin_frac']) ?? 0
  let shiftEnabled: boolean | null
  if (mfrac <= 0) {
    // playbooks.py:3910-3918 — `_margin_ok` is only overwritten when the dial is
    // above 0, so no dial means no gate, not no shifting.
    shiftEnabled = true
    notes.push('no margin gate on shifting: a deep-enough short is moved at any margin')
  } else if (cap === null || cap <= 0) {
    shiftEnabled = false
    notes.push(
      `shift disabled: this book has no margin cap, and a gate of ${pct(mfrac)} of a cap that does not exist ` +
        'is read as "do not shift"',
    )
  } else if (marginUsed === null || marginFrac === null) {
    shiftEnabled = null
    notes.push(`margin unknown — cannot say whether the ${pct(mfrac)} shift gate is open`)
  } else {
    shiftEnabled = marginFrac >= mfrac
    const itm = num(dials['shift_itm_steps'])
    const land = num(dials['shift_land_steps'])
    const where =
      itm !== null && land !== null
        ? ` — shorts ${itm} strikes or more ITM get re-sold ${land} strikes beyond ATM, same size`
        : ''
    notes.push(
      shiftEnabled
        ? `shift armed: margin ${inr(marginUsed)} is ${pct(marginFrac)} of the ${inr(cap)} cap, at or past the ` +
          `${pct(mfrac)} gate${where}`
        : `shift disabled: margin ${inr(marginUsed)} is ${pct(marginFrac)} of the ${inr(cap)} cap, and the gate ` +
          `opens at ${pct(mfrac)}`,
    )
    if (shiftEnabled) {
      // An open gate is not a shift. The whole phase is skipped when
      // `dte <= min_sell_dte` (playbooks.py:3920) — a shift contains a fresh
      // sell — and within it only shorts at least `shift_itm_steps` steps ITM
      // are touched, on a signed depth so an OTM leg is never moved (:3921-3933).
      const dte = num(dials['min_sell_dte']) ?? 1
      const deep = itm !== null ? `${itm} strikes` : 'far enough'
      notes.push(
        `an open gate is not a shift: it still needs a short at least ${deep} ITM, and it shifts nothing with ` +
          `${dte} day(s) or less to expiry — neither is visible here`,
      )
    }
  }

  // playbooks.py:3979 reads `p.get("hedge_after_shift", True)`, so an ABSENT
  // dial hedges — only a present, falsy one skips the delta phase.
  const hedgeAfterShift =
    dials['hedge_after_shift'] === undefined ? true : truthy(dials['hedge_after_shift'])
  if (shiftEnabled === true && !hedgeAfterShift) {
    // playbooks.py:3979-3981 — the shift returns before phase 2 ever runs.
    notes.push(
      'a mark that shifts does NOT also hedge: the delta phase is skipped on the same mark (hedge_after_shift is off)',
    )
  }

  if (targetPnl !== null) {
    notes.push(
      `target ${inr(targetPnl)} — the engine flattens the whole book and banks it the moment total P&L reaches it`,
    )
  }

  return { deltaTolPct, deltaImbalance, wouldRebalance, shiftEnabled, marginFrac, targetPnl, notes }
}
