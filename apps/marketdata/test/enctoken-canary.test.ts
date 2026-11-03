/**
 * The enctoken canary (audit F-13) — proof the REST session is alive, taken on
 * a schedule instead of on demand.
 *
 * WHAT IT IS FOR. Both REST consumers of the enctoken route a rejection into
 * `FeedRecovery`, and both are DEMAND-DRIVEN: the margin sweep prices a handful
 * of slots a day and only for live books, history only when the runner asks. A
 * Kite-web login elsewhere kills the enctoken while the sockets keep streaming
 * — an established socket survives its token being invalidated — so on
 * 2026-08-05 every REST call 403'd for a whole session while `md.health` stayed
 * green and nothing triggered a re-login.
 *
 * WHAT IT MUST NOT DO, which is most of this file. `login()` is a real
 * password+TOTP login against a live trading account, and a canary is by
 * definition a call nobody asked for — so every path that could turn it into a
 * login loop is pinned here: the window, the pacing, single-flight, and the
 * rule that a rejection triggers recovery ONCE and never retries itself.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CANARY_FROM_MIN,
  CANARY_TO_MIN,
  canaryWindowOpen,
  createEnctokenCanary,
  DEFAULT_CANARY_MS,
} from '../src/main.ts'

/** 2026-07-24 is a Friday. IST = UTC + 05:30, no DST, so these are exact. */
const fri = (h: number, m: number): number => Date.UTC(2026, 6, 24, h - 5, m - 30)
/** 2026-07-25 is a Saturday. */
const sat = (h: number, m: number): number => Date.UTC(2026, 6, 25, h - 5, m - 30)

/** A `historyData` that records what it was asked for. */
function source(reply: () => Promise<unknown>) {
  const calls: { token: number; interval: string; from: string; to: string }[] = []
  return {
    calls,
    historyData: async (token: number, interval: string, from: string, to: string): Promise<unknown> => {
      calls.push({ token, interval, from, to })
      return await reply()
    },
  }
}

interface Recorder {
  rejected: number
  accepted: number
}

function canaryFor(
  src: ReturnType<typeof source>,
  now: () => number,
  rec: Recorder,
  everyMs = DEFAULT_CANARY_MS,
) {
  return createEnctokenCanary({
    source: () => src,
    token: () => 256265,
    onRejected: async () => {
      rec.rejected++
    },
    onAccepted: () => {
      rec.accepted++
    },
    everyMs,
    now,
    log: () => {},
  })
}

// ------------------------------------------------------------------ window

test('the window is a WEEKDAY 08:30-16:00 IST and nothing else', () => {
  assert.equal(CANARY_FROM_MIN, 8 * 60 + 30)
  assert.equal(CANARY_TO_MIN, 16 * 60)
  assert.equal(canaryWindowOpen(fri(8, 29)), false, 'before the desk has a session to protect')
  assert.equal(canaryWindowOpen(fri(8, 30)), true)
  assert.equal(canaryWindowOpen(fri(15, 59)), true)
  assert.equal(canaryWindowOpen(fri(16, 0)), false, 'the session is over; a dead token costs nothing')
  assert.equal(canaryWindowOpen(fri(23, 30)), false)
  /**
   * THE WEEKEND ARM IS THE POINT. Zerodha expires the web session overnight and
   * over the weekend as a matter of course, so an unwindowed canary would earn
   * a 401 every two minutes from Friday evening to Monday morning and spend a
   * real password+TOTP login on each one — a login loop against a live trading
   * account, running unattended, to fix a token nothing needs until Monday.
   */
  assert.equal(canaryWindowOpen(sat(10, 0)), false, 'a weekend 401 must not thrash logins')
})

test('outside the window the canary makes NO call and burns NO login', async () => {
  const src = source(async () => {
    throw { error_type: 'TokenException', message: 'Incorrect `api_key` or `access_token`.' }
  })
  const rec: Recorder = { rejected: 0, accepted: 0 }
  const canary = canaryFor(src, () => sat(10, 0), rec)
  await canary.tick()
  await canary.tick()
  assert.equal(src.calls.length, 0)
  assert.equal(rec.rejected, 0)
  assert.equal(canary.lastVerifiedAt, null)
})

// ------------------------------------------------------------------ the call

test('the call is the CHEAPEST authenticated read the session exposes: one token, one day', async () => {
  const src = source(async () => [])
  const rec: Recorder = { rejected: 0, accepted: 0 }
  let now = fri(9, 30)
  const canary = canaryFor(src, () => now, rec)
  await canary.tick()
  assert.deepEqual(src.calls, [{ token: 256265, interval: 'day', from: '2026-07-24', to: '2026-07-24' }])
  assert.equal(rec.accepted, 1, 'a call that answered is the only proof the session is live')
  assert.equal(canary.lastVerifiedAt, now)
})

test('with no session or no token yet it simply does not fire', async () => {
  const rec: Recorder = { rejected: 0, accepted: 0 }
  const canary = createEnctokenCanary({
    source: () => null,
    token: () => 256265,
    onRejected: async () => void rec.rejected++,
    onAccepted: () => void rec.accepted++,
    everyMs: DEFAULT_CANARY_MS,
    now: () => fri(9, 30),
    log: () => {},
  })
  await canary.tick()
  assert.equal(rec.accepted, 0)
  assert.equal(rec.rejected, 0)
})

// ------------------------------------------------------------------ pacing

test('it is paced to DESK_ENCTOKEN_CANARY_MS, not to the 10s health sweep', async () => {
  const src = source(async () => [])
  const rec: Recorder = { rejected: 0, accepted: 0 }
  let now = fri(9, 30)
  const canary = canaryFor(src, () => now, rec, 120_000)

  await canary.tick()
  now += 10_000
  await canary.tick()
  now += 10_000
  await canary.tick()
  assert.equal(src.calls.length, 1, 'the health timer ticks every 10s; the canary must not')

  now += 100_001
  await canary.tick()
  assert.equal(src.calls.length, 2)
})

test('a call still in flight is never doubled up', async () => {
  let release: (() => void) | null = null
  const src = source(
    async () =>
      await new Promise<unknown>((resolve) => {
        release = (): void => resolve([])
      }),
  )
  const rec: Recorder = { rejected: 0, accepted: 0 }
  let now = fri(9, 30)
  const canary = canaryFor(src, () => now, rec, 1)

  const first = canary.tick()
  now += 10_000
  await canary.tick()
  assert.equal(src.calls.length, 1, 'the window and the pacing both say yes — only the gate says no')
  ;(release as unknown as () => void)()
  await first
})

// ------------------------------------------------------------------ rejection

test('a rejected enctoken triggers recovery ONCE and does not retry itself', async () => {
  /**
   * The canary's job ends at "this token is dead". Retrying the history call
   * here would either re-send the token that was just rejected (recovery gated
   * or failed) or duplicate the work the next tick does anyway — and a canary
   * that retries is a canary that can loop.
   */
  const src = source(async () => {
    throw { error_type: 'TokenException', message: 'Incorrect `api_key` or `access_token`.' }
  })
  const rec: Recorder = { rejected: 0, accepted: 0 }
  let now = fri(11, 0)
  const canary = canaryFor(src, () => now, rec, 120_000)

  await canary.tick()
  assert.equal(rec.rejected, 1)
  assert.equal(rec.accepted, 0)
  assert.equal(src.calls.length, 1, 'exactly one call — no self-retry')
  assert.equal(canary.lastVerifiedAt, null, 'a rejection verifies nothing')

  // And the failure does NOT unpace it: the next attempt waits the full
  // interval, so `FeedRecovery`'s own per-kind backoff is the only thing that
  // ever has to decide whether to spend a login.
  now += 10_000
  await canary.tick()
  assert.equal(src.calls.length, 1)
  assert.equal(rec.rejected, 1)
})

test('a SessionException is the SAME fault and must trigger the same recovery', async () => {
  /**
   * The narrowness defect. The canary classified with a matcher that knew only
   * `TokenException` and the exact "Incorrect api_key or access_token" string
   * — so `SessionException: Invalid session token`, a documented real wording
   * of the very outage this canary was built for, read as "not an auth
   * problem" and was logged and dropped. The guardrail was blind to its own
   * incident class.
   */
  const src = source(async () => {
    throw { error_type: 'SessionException', message: 'Invalid session token' }
  })
  const rec: Recorder = { rejected: 0, accepted: 0 }
  const canary = canaryFor(src, () => fri(11, 0), rec)
  await canary.tick()
  assert.equal(rec.rejected, 1)
  assert.equal(rec.accepted, 0)
  assert.equal(canary.lastVerifiedAt, null)
})

test('the login PAGE a dead web session earns triggers recovery too', async () => {
  // `kite.zerodha.com` is a WEB host: it answers a dead session with HTML.
  const src = source(async () => {
    throw '<!doctype html><title>Kite — Login</title>'
  })
  const rec: Recorder = { rejected: 0, accepted: 0 }
  const canary = canaryFor(src, () => fri(11, 0), rec)
  await canary.tick()
  assert.equal(rec.rejected, 1)
})

test('an ENTITLEMENT refusal burns no login, however much it says token', async () => {
  // No login on earth fixes a PermissionException: the same enctoken comes
  // back and the next sweep earns an identical 403.
  const src = source(async () => {
    throw { error_type: 'PermissionException', message: 'access_token is not allowed on this route' }
  })
  const rec: Recorder = { rejected: 0, accepted: 0 }
  const canary = canaryFor(src, () => fri(11, 0), rec)
  await canary.tick()
  assert.equal(rec.rejected, 0)
  assert.equal(rec.accepted, 0)
})

test('a NON-token failure burns no login at all', async () => {
  // A network blip or a 500 is Zerodha having a bad minute. Re-logging in for
  // it would hammer a live trading account to no purpose — the same narrowness
  // `book-margin/kite.ts` and `history.ts` already apply.
  const src = source(async () => {
    throw new Error('socket hang up')
  })
  const rec: Recorder = { rejected: 0, accepted: 0 }
  const canary = canaryFor(src, () => fri(11, 0), rec)
  await canary.tick()
  assert.equal(rec.rejected, 0)
  assert.equal(rec.accepted, 0)
  assert.equal(canary.lastVerifiedAt, null)
})

test('the canary never rejects — the health timer must not need to catch it', async () => {
  const src = source(async () => {
    throw { error_type: 'TokenException', message: 'dead' }
  })
  const canary = createEnctokenCanary({
    source: () => src,
    token: () => 1,
    onRejected: async () => {
      throw new Error('recovery itself exploded')
    },
    onAccepted: () => {
      throw new Error('unreachable')
    },
    everyMs: 1,
    now: () => fri(11, 0),
    log: () => {},
  })
  await canary.tick()
})
