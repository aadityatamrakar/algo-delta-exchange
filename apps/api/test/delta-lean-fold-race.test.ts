/**
 * THE INVARIANT THAT KEEPS THE BOOK FROM BUYING ITSELF TWICE.
 *
 * On the paper rail a leg is not written inside the request. The package goes
 * terminal, the working-package hold lets go, and only a later fold pass writes
 * the leg. For that whole window the delta-lean controller measures the book as
 * flat while the position exists at the broker, and its difference step reads
 * the entire target as missing.
 *
 * What stops it re-buying is the adjust cooldown (`dl_adjust_cooldown_s`),
 * gated at `build()`'s `openable`. That only works because the cooldown
 * OUTLASTS the fold interval. Nothing in either file mentions the other:
 * raise `DESK_PAPER_FOLD_MS` past the cooldown, or lower
 * `dl_adjust_cooldown_s` on a preset, and the double-buy comes back with
 * nothing to catch it — silently, at nine delta-lots, with every other test
 * still green.
 *
 * This is that missing link, asserted. It is not a unit test of either side; it
 * is the relationship between them.
 *
 * The cooldown is now 600 s (aggressive) / 900 s (conservative) — minutes, not
 * seconds — against a worst-case fold lag measured in single-digit seconds, so
 * the `>= WORST_CASE_FOLD_LAG_MS * 3` bar below clears with two orders of
 * magnitude of headroom rather than a little.
 *
 * The real fix is structural — book the leg inside the request, or hold the
 * working package until the leg lands — and until someone does that, this test
 * is the thing that notices.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { PRESETS, resolveDials } from '@algomaker/desk-engine'

/**
 * `apps/api/src/main.ts:839` — `positiveEnvMs('DESK_PAPER_FOLD_MS', 2_000)`.
 * Copied rather than imported: that line is inside `main()`, which opens Mongo
 * and a broker link. If it moves, the assertion below is the reason to come
 * back here rather than to discover it in a book carrying double size.
 */
const PAPER_FOLD_MS_DEFAULT = 2_000

/** The worst case a fold can take to land: one full interval, plus its own pass. */
const WORST_CASE_FOLD_LAG_MS = PAPER_FOLD_MS_DEFAULT * 2

const DELTA_LEAN_PRESETS = PRESETS.filter((p) => p.key.startsWith('delta-lean'))

test('there are delta-lean presets to check — this test is never vacuous', () => {
  // A rename that stopped matching would turn every assertion below into a
  // loop over nothing, which reads as green.
  // The intraday pair, their hold-to-expiry siblings (2026-10-05), and the two
  // zero books (2026-10-17).
  assert.equal(DELTA_LEAN_PRESETS.length, 6)
})

test('every delta-lean preset outlasts the paper fold by a clear margin', () => {
  for (const preset of DELTA_LEAN_PRESETS) {
    const { dials } = resolveDials(preset.dials as Record<string, number | boolean>)
    const cooldownMs = dials.dl_adjust_cooldown_s * 1_000
    assert.ok(
      cooldownMs > WORST_CASE_FOLD_LAG_MS,
      `${preset.key}: dl_adjust_cooldown_s is ${String(dials.dl_adjust_cooldown_s)}s (${String(
        cooldownMs,
      )}ms), which does not outlast a ${String(WORST_CASE_FOLD_LAG_MS)}ms worst-case fold lag. ` +
        'Inside that window the book measures flat and re-buys its whole target.',
    )
  }
})

test('the margin is generous, not marginal — a fold that stalls must not race', () => {
  // A cooldown merely LONGER than the fold is a race waiting for a slow pass.
  // Three times the worst case is the bar; below it, treat the structural fix
  // as due rather than nudging this number.
  for (const preset of DELTA_LEAN_PRESETS) {
    const { dials } = resolveDials(preset.dials as Record<string, number | boolean>)
    assert.ok(
      dials.dl_adjust_cooldown_s * 1_000 >= WORST_CASE_FOLD_LAG_MS * 3,
      `${preset.key}: the cooldown clears the fold, but not by enough to survive a slow pass.`,
    )
  }
})
