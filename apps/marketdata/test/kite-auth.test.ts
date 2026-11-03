/**
 * ONE classifier for "Kite has rejected the SESSION" — the question that
 * decides whether a real password+TOTP login is spent against a live trading
 * account.
 *
 * WHY IT IS SHARED (audit F-13 follow-up). There were two of these, and they
 * had drifted in OPPOSITE directions:
 *
 *   - the history/canary one matched `TokenException` and the exact
 *     "Incorrect api_key or access_token" string only, so a
 *     `SessionException: Invalid session token` — a documented real wording of
 *     the same fault — and the login PAGE a web host answers a dead session
 *     with both read as "not an auth problem". The 2026-08-05 outage class
 *     slipped straight through the guardrail built for it;
 *   - the margin one had been widened to `403 && /token/i`, which reads an
 *     ENTITLEMENT 403 that merely mentions a token as session death. No login
 *     fixes an entitlement, so that is a login every sweep for as long as the
 *     entitlement problem lasts.
 *
 * Too narrow misses the outage; too wide is a login storm. Both consumers now
 * answer the question here, so they cannot disagree about it again.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isKiteAuthFailure } from '../src/kite-auth.ts'

// ------------------------------------------------------- the real wordings

test('every wording the same fault has actually been seen in counts', () => {
  // The OMS's own error_type, and the message that comes with it.
  assert.ok(
    isKiteAuthFailure({
      status: 403,
      body: '{"message":"Incorrect `api_key` or `access_token`.","error_type":"TokenException"}',
    }),
  )
  // The SAME condition, different wording — missed by the old canary matcher.
  assert.ok(
    isKiteAuthFailure({
      status: 403,
      body: '{"message":"Invalid session token","error_type":"SessionException"}',
    }),
  )
  // And without either exception name attached to it.
  assert.ok(isKiteAuthFailure({ body: 'kite: invalid session, please log in again' }))
  // A bare 401 says nothing in its body and does not need to.
  assert.ok(isKiteAuthFailure({ status: 401, body: '{"status":"error","message":"unauthorised"}' }))
  assert.ok(isKiteAuthFailure({ status: 401, body: '' }))
})

test('the login PAGE a web host answers a dead session with counts', () => {
  /**
   * `kite.zerodha.com` is the WEB host: a dead session earns HTML, not JSON,
   * and often with a 200 on it. Reading that as "not an auth problem" is how
   * the same outage returns wearing a different hat — the canary would call a
   * dead token healthy, and the margin client would blame JSON.
   */
  assert.ok(isKiteAuthFailure({ status: 200, body: '<!doctype html><title>Kite</title>' }))
  assert.ok(isKiteAuthFailure({ status: 302, body: '<html><body>Login to Kite</body></html>' }))
})

test('an HTML page from a 5xx is an upstream error page, not a login page', () => {
  // A proxy's own 502 page mentions no session and no login fixes it. Spending
  // a password+TOTP login on every one of those during a Zerodha outage is the
  // login storm this classifier exists to bound.
  assert.equal(isKiteAuthFailure({ status: 502, body: '<html><body>502 Bad Gateway</body></html>' }), false)
})

// ------------------------------------------------------- what must NOT count

test('an ENTITLEMENT 403 never counts, however much it says the word token', () => {
  /**
   * The widening defect. `checkSession` finds the cookie jar perfectly
   * healthy, hands back the SAME enctoken, and the retry earns an identical
   * 403 — forever, once per book per sweep, each one a real login.
   */
  assert.equal(
    isKiteAuthFailure({
      status: 403,
      body: '{"message":"This app is not allowed","error_type":"PermissionException"}',
    }),
    false,
  )
  assert.equal(
    isKiteAuthFailure({
      status: 403,
      body: '{"message":"your access_token is not permitted on this route","error_type":"PermissionException"}',
    }),
    false,
    'PermissionException NEVER matches, whatever else the body says',
  )
  assert.equal(
    isKiteAuthFailure({ status: 403, body: 'token rejected: this account has no entitlement for margins' }),
    false,
  )
  assert.equal(
    isKiteAuthFailure({ status: 403, body: 'this token is not allowed to price baskets' }),
    false,
  )
})

test('a bad minute at Zerodha is not a dead session', () => {
  assert.equal(isKiteAuthFailure({ status: 500, body: 'upstream boom' }), false)
  assert.equal(isKiteAuthFailure({ status: 429, body: 'kite: too many requests' }), false)
  assert.equal(isKiteAuthFailure({ body: 'socket hang up' }), false)
  assert.equal(isKiteAuthFailure({ status: 403, body: '{"message":"order is frozen"}' }), false,
    'a BARE 403 has to NAME the session problem — that is the narrow half')
})
