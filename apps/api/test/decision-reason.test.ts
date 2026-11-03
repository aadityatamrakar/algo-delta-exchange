/**
 * The decision reason and trigger the panel renders, at the wire that carries
 * them: `POST /v1/desk/engine/decisions`.
 *
 * THIS FILE MOVED IN THE D9 CUTOVER; the contract did not. It used to test
 * `validateActionsRequest`, which went with `POST /v1/desk/actions`, and the
 * two wires state these fields differently — worth knowing when reading an old
 * decision back:
 *
 *   ON THE REMOVED WIRE they were OPTIONAL, because the Python desk and this
 *   bridge were two repos that had to ship independently. A missing `reason`
 *   failing a request would have forced a coordinated mid-session deploy, and
 *   `desk-runner` squares off on SIGTERM.
 *
 *   ON THIS ONE `reason` is REQUIRED (it may be empty) and has been since the
 *   endpoint shipped. There is no second repo: the supervisor is in this tree
 *   and ships with this endpoint, so "no reason recorded" can be a choice
 *   somebody made rather than a field somebody forgot.
 *
 * Nothing about that was changed here. What this ticket did was retire one of
 * the two and point this file at the other.
 *
 * PURE VALIDATION ONLY — no Mongo, so these run everywhere. That the reason
 * reaches `desk-engine-decisions` and the registry row is covered by the
 * Mongo-gated tests in `engine-decisions.test.ts`.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateDecisionRequest } from '../src/routes/engine.ts'

const TAG = 'TCS-2026-08-25-recenter-relief-r'

/** A minimal valid decision. A HOLD posts exactly this: an EMPTY action list. */
function holdRequest(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    symbol: 'TCS',
    expiry: '2026-08-25',
    mode: 'live',
    tag: TAG,
    decisionId: `${TAG}:live:2026-08-05T11:10`,
    trigger: 'balance',
    reason: '',
    actions: [],
    ...extra,
  }
}

test('an EMPTY reason is valid — a hold with nothing to say is still a decision', () => {
  const r = validateDecisionRequest(holdRequest())
  assert.equal(r.ok, true)
  if (!r.ok) return
  assert.equal(r.value.reason, '')
  assert.equal(r.value.trigger, 'balance')
})

test('a MISSING reason is refused — the field is a choice, not an accident', () => {
  const body = holdRequest()
  delete body['reason']
  const r = validateDecisionRequest(body)
  assert.equal(r.ok, false)
  if (r.ok) return
  assert.match(r.error, /reason is required/)
})

test('trigger and reason are carried through verbatim', () => {
  const reason = 'recenter-otm: netΓ -3.8 — allowance 188 under one lot (225); no convexity to centre'
  const r = validateDecisionRequest(holdRequest({ trigger: 'shed', reason }))
  assert.equal(r.ok, true)
  if (!r.ok) return
  assert.equal(r.value.trigger, 'shed')
  // VERBATIM: the greek, the em dash and the parenthetical all survive. The
  // dashboard prints this string; nothing parses it.
  assert.equal(r.value.reason, reason)
})

test('a reason of the wrong TYPE is refused rather than coerced', () => {
  // `String(42)` would store "42" as the desk's own words for why it traded.
  for (const bad of [42, null, {}, [], true]) {
    const r = validateDecisionRequest(holdRequest({ reason: bad }))
    assert.equal(r.ok, false, `reason=${JSON.stringify(bad)} should be refused`)
  }
})

test('the trigger is checked against its literal set, never cast', () => {
  const r = validateDecisionRequest(holdRequest({ trigger: 'vibes' }))
  assert.equal(r.ok, false)
  if (r.ok) return
  assert.match(r.error, /trigger must be one of/)
})

test('the telemetry fields do not weaken any real gate — a bad mode still fails', () => {
  const r = validateDecisionRequest(
    holdRequest({ mode: 'paper-ish', trigger: 'shift', reason: 'x' }),
  )
  assert.equal(r.ok, false)
})
