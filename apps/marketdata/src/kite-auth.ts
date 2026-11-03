/**
 * ONE answer to "has Kite rejected the SESSION?" — the question that decides
 * whether a real password+TOTP login is spent against a live trading account.
 *
 * WHY IT IS SHARED. There were two of these and they had drifted in OPPOSITE
 * directions, which is how the guardrail and the thing it guards ended up
 * failing in different ways at once:
 *
 *   - `history.ts` (and through it the enctoken canary) matched `TokenException`
 *     and the exact "Incorrect api_key or access_token" string, and NOTHING
 *     else. `SessionException: Invalid session token` and the login PAGE a web
 *     host answers a dead session with — both documented real wordings of the
 *     2026-08-05 outage — read as "not an auth problem", were logged, and were
 *     dropped. The canary built for that outage class was blind to most of it.
 *   - `book-margin/kite.ts` had been widened to `403 && /token/i`, which reads
 *     an ENTITLEMENT 403 that merely mentions a token as session death. No
 *     login fixes an entitlement — `checkSession` finds the cookie jar healthy
 *     and hands back the SAME enctoken — so that is one real login per book per
 *     sweep for as long as the entitlement problem lasts.
 *
 * TOO NARROW MISSES THE OUTAGE; TOO WIDE IS A LOGIN STORM. Both consumers now
 * ask the question here, so they cannot disagree about it again — and the one
 * place they ask it is directly testable (`test/kite-auth.test.ts`) rather than
 * inferred from a retry count.
 *
 * THE CLASSIFIER IS NOT THE ONLY BOUND, and must not be trusted as one.
 * `FeedRecovery` refuses to reset its token backoff while a token trigger is
 * fresh, so even a wording this file gets wrong costs at most one login per
 * backoff step. Correctness here buys a faster recovery, not the rate limit.
 */

/**
 * The wordings the SAME fault has actually been observed in. Any of them, at
 * any status: the OMS is inconsistent about which status it pairs them with —
 * 2026-08-05 was a 403 carrying `TokenException`, and the same condition has
 * been seen as a 401.
 */
const AUTH_WORDING =
  /TokenException|SessionException|Incorrect\s+`?api_key`?\s+or\s+`?access_token`?|invalid\s+session/i

/**
 * An entitlement, not a session — and no login on earth fixes one. Checked
 * INSIDE the bare-403 arm, where the only evidence is the word "token"
 * appearing somewhere in the body.
 */
const ENTITLEMENT_WORDING = /permission|entitlement|not allowed/i

/**
 * The reply is an HTML DOCUMENT where a JSON API reply was expected.
 *
 * `kite.zerodha.com` is the WEB host: a dead session earns the login page,
 * frequently with a 200 on it. The basket and history routes have no other
 * reason to answer HTML, so an HTML document from them IS the login page.
 *
 * EXCEPT ON A 5xx, which is the narrow half. A proxy's own "502 Bad Gateway"
 * page is also HTML, mentions no session, and is fixed by waiting rather than
 * by logging in — and re-logging in on every one of those through a Zerodha
 * outage is exactly the storm this file exists to bound. An UNKNOWN status
 * (the vendored history client rejects with a body and no status) counts,
 * since there is nothing there to exonerate it.
 */
const HTML_DOCUMENT = /^\s*(?:<!doctype\s+html|<html[\s>])/i

export interface KiteReply {
  /** HTTP status, when the caller has one. */
  readonly status?: number
  /** The response body, or a described rejection (`describeHistoryError`). */
  readonly body: string
}

export function isKiteAuthFailure(reply: KiteReply): boolean {
  const body = reply.body
  const status = reply.status

  /**
   * `PermissionException` NEVER matches, whatever else the body says. It is
   * the one error_type that is definitionally about entitlement rather than
   * identity, and a body pairing it with the word `access_token` ("your
   * access_token is not permitted on this route") is precisely the shape the
   * widened margin matcher turned into an unbounded login loop.
   */
  if (/PermissionException/i.test(body)) return false

  if (AUTH_WORDING.test(body)) return true
  if (HTML_DOCUMENT.test(body) && (status === undefined || status < 500)) return true
  // A 401 needs no body at all: the OMS has answered a dead enctoken with an
  // empty one.
  if (status === 401) return true
  /**
   * A BARE 403 IS NOT ENOUGH, and that is the narrow part: the OMS answers an
   * entitlement refusal with 403 too. So a 403 has to NAME the session problem
   * and must not be naming an entitlement while it does.
   */
  if (status === 403) return /token|session/i.test(body) && !ENTITLEMENT_WORDING.test(body)
  return false
}
