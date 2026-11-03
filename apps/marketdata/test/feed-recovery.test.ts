import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FeedRecovery } from '../src/feed-recovery.ts'

interface Harness {
  recovery: FeedRecovery
  logins: number
  applied: string[]
  logs: string[]
  clock: { now: number }
}

function harness(
  opts: { login?: () => Promise<string>; baseDelayMs?: number; loginTimeoutMs?: number } = {},
): Harness {
  const h: Harness = {
    logins: 0,
    applied: [],
    logs: [],
    clock: { now: 1_000_000 },
    // Assigned right below; the closures capture `h` itself, so every counter
    // the tests read is the one the callbacks mutate.
    recovery: undefined as unknown as FeedRecovery,
  }
  h.recovery = new FeedRecovery({
    login:
      opts.login ??
      (async () => {
        h.logins++
        return `token-${h.logins}`
      }),
    apply: (t) => h.applied.push(t),
    log: (msg) => h.logs.push(msg),
    baseDelayMs: opts.baseDelayMs ?? 60_000,
    ...(opts.loginTimeoutMs === undefined ? {} : { loginTimeoutMs: opts.loginTimeoutMs }),
    now: () => h.clock.now,
  })
  return h
}

test('a dead feed gets ONE fresh login and the pool gets the token', async () => {
  const h = harness()
  assert.equal(await h.recovery.trigger('socket 0 disconnected for 60000ms'), 'rotated')
  assert.equal(h.logins, 1)
  assert.deepEqual(h.applied, ['token-1'])
})

test('the sweep re-triggering while a login is in flight JOINS it, and does not stack logins', async () => {
  let release: (token: string) => void = () => {}
  let logins = 0
  const h = harness({
    login: () => {
      logins++
      return new Promise<string>((resolve) => {
        release = resolve
      })
    },
  })
  const first = h.recovery.trigger('noreconnect')
  // Joins rather than answering 'gated'. Both are "no login of your own", but
  // only one of them is about to produce a fresh token, and a caller that gave
  // up here would re-send a dead enctoken it was milliseconds from replacing.
  const second = h.recovery.trigger('sweep fired again')
  release('token-1')
  assert.deepEqual(await Promise.all([first, second]), ['rotated', 'rotated'])
  assert.equal(logins, 1)
  assert.deepEqual(h.applied, ['token-1'])
})

test('a gated trigger says so, rather than resolving as if it had logged in', async () => {
  const h = harness({ baseDelayMs: 60_000 })
  assert.equal(await h.recovery.trigger('down'), 'rotated')
  h.clock.now += 10_000
  assert.equal(await h.recovery.trigger('still down'), 'gated')
  assert.equal(h.logins, 1)
})

test('a FAILED login says so, rather than resolving as if it had rotated', async () => {
  const h = harness({ login: () => Promise.reject(new Error('connect ETIMEDOUT')) })
  assert.equal(await h.recovery.trigger('down'), 'failed')
  assert.equal(h.applied.length, 0)
})

test('consecutive attempts back off with doubling delays', async () => {
  const h = harness({ baseDelayMs: 60_000 })

  await h.recovery.trigger('down') // attempt 1, immediate
  assert.equal(h.logins, 1)

  h.clock.now += 10_000
  await h.recovery.trigger('still down') // inside the 60s window: gated
  assert.equal(h.logins, 1)

  h.clock.now += 55_000 // 65s after attempt 1
  await h.recovery.trigger('still down') // attempt 2
  assert.equal(h.logins, 2)

  h.clock.now += 60_000 // only 60s later, window is now 120s: gated
  await h.recovery.trigger('still down')
  assert.equal(h.logins, 2)

  h.clock.now += 65_000 // 125s after attempt 2
  await h.recovery.trigger('still down') // attempt 3
  assert.equal(h.logins, 3)
})

test('noteHealthy resets the backoff so the next outage recovers fast', async () => {
  const h = harness({ baseDelayMs: 60_000 })
  await h.recovery.trigger('down')
  h.clock.now += 65_000
  await h.recovery.trigger('still down')
  assert.equal(h.logins, 2)

  h.recovery.noteHealthy()
  h.clock.now += 1_000
  await h.recovery.trigger('down again') // immediate: no inherited delay
  assert.equal(h.logins, 3)
})

test('noteHealthy does NOT reset the TOKEN backoff — the 2026-08-05 shape', async () => {
  /**
   * The whole point of pacing the two faults apart. During a REST-only token
   * death every socket is connected, so the 10s health sweep calls
   * `noteHealthy` on every tick. If that reset the token backoff, each 30s
   * margin sweep would find an open gate and spend a real password+TOTP login
   * — ~120 an hour, indefinitely, on a live trading account — and the rate
   * limit that follows would take genuine feed recovery down with it.
   */
  const h = harness({ baseDelayMs: 60_000 })
  await h.recovery.trigger('basket margin: kite rejected the enctoken', 'token')
  assert.equal(h.logins, 1)

  for (let tick = 0; tick < 3; tick++) {
    h.clock.now += 10_000
    h.recovery.noteHealthy() // sockets are all connected, as they were all along
  }
  assert.equal(await h.recovery.trigger('rejected again', 'token'), 'gated')
  assert.equal(h.logins, 1, 'a healthy socket is not evidence the enctoken works')

  // Only a REST call that actually succeeded clears it — and only once the
  // conflicting-signal window below has passed, so a probe that answers while
  // the sweep is still being rejected cannot reopen the gate.
  h.clock.now += 600_001
  h.recovery.noteTokenAccepted()
  assert.equal(await h.recovery.trigger('rejected again', 'token'), 'rotated')
  assert.equal(h.logins, 2)
})

test('an ACCEPT cannot reopen the gate while a token trigger is still fresh', async () => {
  /**
   * THE CONFLICTING-SIGNAL REGIME, and the login storm it used to produce.
   *
   * The canary probes one instrument every 120s and calls `noteTokenAccepted`
   * whenever it answers; the margin sweep prices books and triggers 'token'
   * whenever it is rejected. Those two CAN disagree — a token entitled to
   * history but not to margins, a partial outage, an entitlement 403 the
   * classifier once read as session death — and while they disagree the accept
   * wiped the backoff clean every two minutes, so the very next rejection found
   * an open gate. A real password+TOTP login at SWEEP CADENCE, indefinitely,
   * against a live trading account.
   *
   * So the reset is refused while a token trigger is fresh. Backoff still
   * doubles, so the regime costs at most ONE login per backoff step — never one
   * per sweep — and the pacing is structural rather than a matter of the
   * classifier being right about every wording Zerodha invents.
   */
  const h = harness({ baseDelayMs: 60_000 })
  let sweeps = 0
  // 40 minutes of alternating "probe says alive" / "sweep says dead", at the
  // real cadences: an accept every 2 minutes, a rejection every 30 seconds.
  for (let elapsed = 0; elapsed < 40 * 60_000; elapsed += 30_000) {
    if (elapsed % 120_000 === 0) h.recovery.noteTokenAccepted()
    await h.recovery.trigger('basket margin: kite rejected the enctoken', 'token')
    sweeps++
    h.clock.now += 30_000
  }
  assert.equal(sweeps, 80, 'eighty sweeps went past')
  assert.ok(
    h.logins <= 8,
    // The ladder over 40 minutes is 60s,120s,240s,480s,600s,600s,600s — seven
    // steps, against eighty sweeps and twenty accepts. Before the guard this
    // was one login per accepted probe, forever.
    `at most one login per backoff step — got ${String(h.logins)} for 40 minutes`,
  )
  assert.ok(h.logins >= 1, 'and the fault is still being acted on, not ignored')
})

test('once the token fault is genuinely over, an accept DOES reset the backoff', async () => {
  // The other half: the guard is a window, not a latch. Ten quiet minutes with
  // no further rejection means the disagreement is over, and the next outage
  // must get an immediate first attempt rather than inheriting this one's cap.
  const h = harness({ baseDelayMs: 60_000 })
  await h.recovery.trigger('token rejected', 'token')
  assert.equal(h.logins, 1)
  h.clock.now += 600_001
  h.recovery.noteTokenAccepted()
  assert.equal(await h.recovery.trigger('token rejected again, much later', 'token'), 'rotated')
  assert.equal(h.logins, 2)
})

test('a token fault does not slow down recovery from a later feed outage', async () => {
  // The counterpart: the two counters are independent in both directions, so
  // an unresolved token fault cannot leave a dead socket waiting out a backoff
  // it had no part in.
  const h = harness({ baseDelayMs: 60_000 })
  await h.recovery.trigger('token rejected', 'token')
  h.clock.now += 1_000
  assert.equal(await h.recovery.trigger('socket 0 died', 'feed'), 'rotated')
  assert.equal(h.logins, 2)
})

test('an auth-shaped login failure is logged for a HUMAN, not just retried', async () => {
  const h = harness({
    login: () => Promise.reject(new Error('Zerodha login failed for IJ0574')),
  })
  await h.recovery.trigger('down')
  assert.equal(h.applied.length, 0)
  assert.ok(
    h.logs.some((l) => l.includes('need a HUMAN')),
    `expected a human-attention line in: ${JSON.stringify(h.logs)}`,
  )
})

test('a HUNG login times out and releases the gate instead of wedging recovery', async () => {
  const h = harness({
    login: () => new Promise<string>(() => {}), // never settles
    loginTimeoutMs: 20,
  })
  await h.recovery.trigger('down')
  assert.equal(h.applied.length, 0)
  assert.ok(h.logs.some((l) => l.includes('will retry')))
  // The gate is free again: once the backoff window passes, the next sweep
  // gets another attempt — a hung login must never be a permanent outage.
  // (The old vendored process.exit(1) papered over exactly this stuck state.)
  h.clock.now += 65_000
  await h.recovery.trigger('still down')
  assert.equal(h.logs.filter((l) => l.includes('fresh zerodha login')).length, 2)
})

test('a network-shaped login failure logs as a retryable failure', async () => {
  const h = harness({
    login: () => Promise.reject(new Error('connect ETIMEDOUT 104.18.32.1:443')),
  })
  await h.recovery.trigger('down')
  assert.equal(h.applied.length, 0)
  assert.ok(h.logs.some((l) => l.includes('will retry')))
  assert.ok(!h.logs.some((l) => l.includes('need a HUMAN')))
})
