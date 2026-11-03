/**
 * The broker link — the operator's "turn XTS off" switch, as the gateway obeys it.
 *
 * WHAT IS PINNED HERE. XTS allows ONE session per API key: logging in anywhere
 * else kills the gateway's, and the gateway's re-login kills the other. So when
 * the desk wants the key for another use, the gateway must not merely stop
 * placing — it must LOG OUT, forget the token, drop the interactive socket, and
 * above all NEVER LOG BACK IN until told to. Every property below is one of
 * those, or the ordering between them:
 *
 *   - the state flips BEFORE any IO, so the placement gate and the relogin
 *     guard engage even if the logout itself hangs;
 *   - a logout that fails is still a release — the gateway will not touch XTS
 *     again — and the failure is RECORDED, not swallowed, so the operator knows
 *     the server-side session may still be alive;
 *   - reconnecting is a fresh login; a failed one stays released, records why,
 *     and is not retried on every 2s poll (XTS rate-limits logins);
 *   - the first reconcile after boot always writes an ack, so a dashboard that
 *     released the link before a restart sees THIS process confirm it.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  BrokerLink,
  DEFAULT_LINK_DESIRE,
  RECONNECT_RETRY_MS,
  readLinkDesire,
  releasedSnapshot,
  type BrokerLinkAck,
  type BrokerLinkPorts,
} from '../src/broker-link.ts'

const T0 = 1_756_700_000_000

interface Harness {
  link: BrokerLink
  /** The SAME object the link holds — a test swaps a port by assigning here. */
  readonly ports: BrokerLinkPorts
  readonly calls: string[]
  readonly acks: BrokerLinkAck[]
  readonly lines: string[]
  now: number
  failLogout: Error | null
  failLogin: Error | null
  failClear: Error | null
}

function harness(initial: 'connected' | 'released' = 'connected'): Harness {
  const h: Harness = {
    link: null as unknown as BrokerLink,
    ports: null as unknown as BrokerLinkPorts,
    calls: [],
    acks: [],
    lines: [],
    now: T0,
    failLogout: null,
    failLogin: null,
    failClear: null,
  }
  const ports: BrokerLinkPorts = {
    logout: async () => {
      h.calls.push('logout')
      if (h.failLogout !== null) throw h.failLogout
    },
    login: async () => {
      h.calls.push('login')
      if (h.failLogin !== null) throw h.failLogin
    },
    closeSocket: () => void h.calls.push('closeSocket'),
    clearStoredToken: async () => {
      h.calls.push('clearStoredToken')
      if (h.failClear !== null) throw h.failClear
    },
    record: async (ack) => {
      h.calls.push(`record:${ack.applied}`)
      h.acks.push(ack)
    },
    now: () => h.now,
    log: (m, c) => void h.lines.push(`${m} ${c === undefined ? '' : JSON.stringify(c)}`),
  }
  ;(h as { ports: BrokerLinkPorts }).ports = ports
  h.link = new BrokerLink(ports, initial)
  return h
}

const released = (reason = 'need the key elsewhere') => ({
  desired: 'released' as const,
  reason,
  setBy: 'aaditya',
  setAt: T0 - 1000,
})
const connected = () => ({ desired: 'connected' as const, reason: '', setBy: 'aaditya', setAt: T0 })

// ---------------------------------------------------------------- reading

test('a missing or malformed document is the default: connected', () => {
  assert.deepEqual(readLinkDesire(null), DEFAULT_LINK_DESIRE)
  assert.deepEqual(readLinkDesire(undefined), DEFAULT_LINK_DESIRE)
  assert.deepEqual(readLinkDesire('garbage'), DEFAULT_LINK_DESIRE)
  // Only the literal word releases. A hand-edited row cannot half-release.
  assert.equal(readLinkDesire({ desired: 'RELEASED' }).desired, 'connected')
  assert.equal(readLinkDesire({ desired: true }).desired, 'connected')
})

test('a released document reads back with who, why and when', () => {
  const got = readLinkDesire({ desired: 'released', reason: 'x', setBy: 'op', setAt: 5, applied: 'connected' })
  assert.deepEqual(got, { desired: 'released', reason: 'x', setBy: 'op', setAt: 5 })
})

// ---------------------------------------------------------------- release

test('release: state flips first, then socket, logout, token, ack — in that order', async () => {
  const h = harness()
  assert.equal(h.link.connected, true)
  assert.equal(h.link.refusal(), null)

  await h.link.reconcile(released())

  assert.equal(h.link.connected, false)
  assert.deepEqual(h.calls, ['closeSocket', 'logout', 'clearStoredToken', 'record:released'])
  const ack = h.acks[0]
  assert.ok(ack)
  assert.equal(ack.applied, 'released')
  assert.equal(ack.appliedAt, T0)
  assert.equal(ack.appliedError, '')
  assert.match(h.link.refusal() ?? '', /released by operator/)
  assert.match(h.link.refusal() ?? '', /need the key elsewhere/)
})

test('release: the state is released BEFORE the logout runs, so a hanging logout still gates', async () => {
  const h = harness()
  let seenDuringLogout: boolean | null = null
  const original = h.ports.logout
  h.ports.logout = async () => {
    seenDuringLogout = h.link.connected
    await original()
  }
  await h.link.reconcile(released())
  assert.equal(seenDuringLogout, false)
})

test('release: a logout that throws is still a release, and the error is recorded', async () => {
  const h = harness()
  h.failLogout = new Error('fetch failed')
  await h.link.reconcile(released())
  assert.equal(h.link.connected, false)
  assert.deepEqual(h.calls, ['closeSocket', 'logout', 'clearStoredToken', 'record:released'])
  assert.match(h.acks[0]?.appliedError ?? '', /logout failed: fetch failed/)
  // And the token is still forgotten — a dead-or-alive bearer must not be
  // reused by the next boot either way.
  assert.ok(h.calls.includes('clearStoredToken'))
})

test('release: forgetting the token failing is recorded beside a logout failure, not instead of it', async () => {
  const h = harness()
  h.failLogout = new Error('logout boom')
  h.failClear = new Error('mongo boom')
  await h.link.reconcile(released())
  const err = h.acks[0]?.appliedError ?? ''
  assert.match(err, /logout failed: logout boom/)
  assert.match(err, /token not cleared: mongo boom/)
})

test('release is idempotent: a second poll with the same wish does nothing', async () => {
  const h = harness()
  await h.link.reconcile(released())
  const before = h.calls.length
  await h.link.reconcile(released())
  await h.link.reconcile(released())
  assert.equal(h.calls.length, before)
})

// -------------------------------------------------------------- reconnect

test('reconnect: a fresh login, then the ack says connected', async () => {
  const h = harness()
  await h.link.reconcile(released())
  h.calls.length = 0
  h.now = T0 + 60_000

  await h.link.reconcile(connected())

  assert.equal(h.link.connected, true)
  assert.equal(h.link.refusal(), null)
  assert.deepEqual(h.calls, ['login', 'record:connected'])
  assert.equal(h.acks.at(-1)?.appliedAt, T0 + 60_000)
  assert.equal(h.acks.at(-1)?.appliedError, '')
})

test('reconnect: a failed login stays released, records why, and is not retried every poll', async () => {
  const h = harness()
  await h.link.reconcile(released())
  h.calls.length = 0
  h.failLogin = new Error('XTS login failed: e-session-0002')

  await h.link.reconcile(connected())
  assert.equal(h.link.connected, false)
  assert.deepEqual(h.calls, ['login', 'record:released'])
  assert.match(h.acks.at(-1)?.appliedError ?? '', /reconnect failed: XTS login failed/)

  // The 2s poll keeps asking; the login must not be hammered.
  h.now += 2_000
  await h.link.reconcile(connected())
  h.now += 2_000
  await h.link.reconcile(connected())
  assert.equal(h.calls.filter((c) => c === 'login').length, 1)

  // After the retry window it tries again — and this time succeeds.
  h.failLogin = null
  h.now += RECONNECT_RETRY_MS
  await h.link.reconcile(connected())
  assert.equal(h.link.connected, true)
  assert.equal(h.calls.filter((c) => c === 'login').length, 2)
})

test('reconnect: a released → connected → released flip while a login is in flight is not lost', async () => {
  const h = harness()
  await h.link.reconcile(released())
  h.calls.length = 0
  // Single-flight: a second reconcile during the first awaits it rather than
  // racing a login against a logout.
  let release: () => void = () => {}
  const gate = new Promise<void>((r) => (release = r))
  h.ports.login = async () => {
    h.calls.push('login')
    await gate
  }
  const first = h.link.reconcile(connected())
  const second = h.link.reconcile(released())
  release()
  await Promise.all([first, second])
  // The reconnect completed, then the release ran over it: the LAST wish wins.
  assert.equal(h.link.connected, false)
  assert.deepEqual(h.calls, ['login', 'record:connected', 'closeSocket', 'logout', 'clearStoredToken', 'record:released'])
})

// ------------------------------------------------------------------- boot

test('the first reconcile after boot always acks, even when nothing changes', async () => {
  const c = harness('connected')
  await c.link.reconcile(connected())
  assert.deepEqual(c.calls, ['record:connected'])
  await c.link.reconcile(connected())
  assert.deepEqual(c.calls, ['record:connected'], 'the steady state must not re-ack every poll')

  // Booted released (the operator released before a restart): the gateway
  // performed no login — and it still RUNS the release once, because the wish
  // may have been written while it was down, leaving a stored token and an
  // open server-side session that nothing has yet closed. (Logging out with no
  // token is a no-op at the client, so a release that already happened is free.)
  const r = harness('released')
  await r.link.reconcile(released('before the restart'))
  assert.deepEqual(r.calls, ['closeSocket', 'logout', 'clearStoredToken', 'record:released'])
  assert.equal(r.link.connected, false)
  assert.match(r.link.refusal() ?? '', /before the restart/)
  assert.equal(r.link.reason, 'before the restart')
  // And only once.
  await r.link.reconcile(released('before the restart'))
  assert.equal(r.calls.length, 4)

  // Booted released but the wish flipped back to connected while down: a
  // plain reconnect, no logout of a session that was never established.
  const rc = harness('released')
  await rc.link.reconcile(connected())
  assert.deepEqual(rc.calls, ['login', 'record:connected'])
  assert.equal(rc.link.connected, true)
})

test('an ack that cannot be written never escapes', async () => {
  const h = harness()
  h.ports.record = async () => {
    throw new Error('mongo down')
  }
  await assert.doesNotReject(h.link.reconcile(released()))
  assert.equal(h.link.connected, false)
  assert.ok(h.lines.some((l) => /ack/.test(l) && /mongo down/.test(l)))
})

// --------------------------------------------------------------- snapshot

test('the released snapshot is a failed snapshot that names the operator, and archives nothing', () => {
  const snap = releasedSnapshot(T0, 'need the key elsewhere')
  assert.equal(snap.ok, false)
  assert.equal(snap.asOf, T0)
  assert.match(snap.error, /released by operator/)
  assert.match(snap.error, /need the key elsewhere/)
  assert.deepEqual(snap.orders, [])
  assert.deepEqual(snap.positions, [])
  assert.deepEqual(snap.trades, [])
  assert.equal(snap.funds, null)
  // NOT `session`: that class is what the snapshot loop re-logs in on.
  assert.notEqual(snap.errorClass, 'session')
})
