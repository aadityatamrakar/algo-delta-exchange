/**
 * THE REGISTRY POLL — the operator's switch, and the four ways it lies.
 *
 *   1. **A row that will not read is not a permission to trade.** A half-written
 *      document is dropped, not defaulted to running.
 *   2. **Stopping steers nothing; it closes nothing.** The one thing this pass
 *      may never do is place an order, and `stop` is the seam where an
 *      unattended flatten would have crept in (the runner's 2026-08-17 memory
 *      bounce).
 *   3. **A retune lands on a RUNNING book**, without a restart. That is the
 *      whole point of re-resolving the dials every pass.
 *   4. **An unknown dial key is loud exactly once.** Silent is F-29 — a knob the
 *      operator believes is in force. Every-five-seconds is noise that trains
 *      them to ignore it.
 *
 * Pure: the collection is an array, the callbacks are recorders.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_DIALS } from '@algomaker/desk-engine'
import {
  RegistryPoll,
  bookKey,
  desiredBooks,
  type ManagedBook,
  type RegistryPollDeps,
} from '../src/registry-poll.ts'
import type { HostLog } from '../src/engine-host.ts'

function logOf(): HostLog & { lines: string[] } {
  const lines: string[] = []
  // The ctx rides on the line as JSON, so a test can grep a field (`suppressed`)
  // the same way it greps the message.
  const push =
    (level: string) =>
    (msg: string, ctx?: Record<string, unknown>): void => {
      lines.push(`${level}: ${msg}${ctx === undefined ? '' : ` ${JSON.stringify(ctx)}`}`)
    }
  return { lines, debug: push('debug'), info: push('info'), warn: push('warn'), error: push('error') }
}

const rowOf = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  tag: 'TCS-2026-09-25-recenter-r',
  symbol: 'TCS',
  expiry: '2026-09-25',
  mode: 'paper',
  variant: 'recenter-relief-r',
  dials: {},
  desired: 'running',
  actual: 'stopped',
  ...over,
})

interface Harness {
  readonly poll: RegistryPoll
  readonly docs: Record<string, unknown>[]
  readonly started: string[]
  readonly stopped: string[]
  readonly retuned: ManagedBook[]
  readonly reported: string[]
  readonly log: HostLog & { lines: string[] }
  readonly running: Set<string>
}

function harness(over: Partial<RegistryPollDeps> = {}): Harness {
  const docs: Record<string, unknown>[] = []
  const started: string[] = []
  const stopped: string[] = []
  const retuned: ManagedBook[] = []
  const reported: string[] = []
  const running = new Set<string>()
  const log = logOf()
  const poll = new RegistryPoll({
    collection: { find: () => ({ toArray: async () => docs }) },
    log,
    running: () => running,
    start: async (book) => {
      started.push(book.key)
      running.add(book.key)
    },
    stop: async (key) => {
      stopped.push(key)
      running.delete(key)
    },
    retune: (book) => retuned.push(book),
    report: async (book) => {
      reported.push(book.key)
    },
    ...over,
  })
  return { poll, docs, started, stopped, retuned, reported, log, running }
}

// ── desiredBooks ────────────────────────────────────────────────────────────

test('only rows the operator asked to RUN are steered', () => {
  const books = desiredBooks([
    rowOf(),
    rowOf({ tag: 'OFF', desired: 'stopped' }),
    // `desired` unreadable → `bookFromDoc` falls back to 'stopped'.
    rowOf({ tag: 'JUNK', desired: 42 }),
    // No symbol at all: not a book, and not a default one either.
    rowOf({ tag: 'BROKEN', symbol: '' }),
  ])
  assert.deepEqual(
    books.map((b) => b.tag),
    ['TCS-2026-09-25-recenter-r'],
  )
})

test('desiredBooks reads the strategy switch — ON, OFF, and a missing row is null', () => {
  /**
   * The switch is `desk-strategies.modes[mode].enabled`, read through the SAME
   * `strategyFromDoc` desk-api's gate reads it through, so the host and the
   * gate can never disagree about a row. Three answers, not two: a row that is
   * not there is UNKNOWN, and unknown must not be off (`engine-host.ts`'s
   * `switchedOn`) — the api's `UnknownStrategy` refusal stays the guard.
   */
  const strategy = (tag: string, enabled: boolean): Record<string, unknown> => ({
    tag,
    kind: 'external',
    label: tag,
    liveLots: 0,
    modes: { paper: { enabled } },
    updatedAt: 1,
  })
  const books = desiredBooks(
    [rowOf({ tag: 'ON' }), rowOf({ tag: 'OFF' }), rowOf({ tag: 'NOROW' }), rowOf({ tag: 'LIVE', mode: 'live' })],
    // LIVE has a paper switch and no live one: for the live book that is "not
    // added", which `isOn` answers false — the row exists, so it is a reading.
    [strategy('ON', true), strategy('OFF', false), strategy('LIVE', true)],
  )
  const byTag = new Map(books.map((b) => [b.tag, b.enabled]))
  assert.equal(byTag.get('ON'), true)
  assert.equal(byTag.get('OFF'), false)
  assert.equal(byTag.get('NOROW'), null, 'no row is unknown, not off')
  assert.equal(byTag.get('LIVE'), false, 'the switch is per MODE')
  // No strategy docs at all (the collection is not wired): every book unknown.
  assert.ok(desiredBooks([rowOf()]).every((b) => b.enabled === null))
})

test('an unreadable strategies collection leaves enabled null and warns once', async () => {
  /**
   * Unknown is not off. A Mongo blip on `desk-strategies` must not stand every
   * book on the desk down — the same principle as the registry read itself,
   * which leaves every book as it was. And it is said once a minute, not once
   * per 5 s pass, because a collection that stays unreadable is one condition.
   */
  let now = 0
  const h = harness({
    strategies: {
      find: () => ({
        toArray: async () => {
          throw new Error('connection reset')
        },
      }),
    },
    now: () => now,
  })
  h.docs.push(rowOf())
  await h.poll.run()
  assert.deepEqual(h.started, ['TCS-2026-09-25-recenter-r:paper'], 'the book still starts')
  now += 5_000
  await h.poll.run()
  now += 5_000
  await h.poll.run()
  const warned = h.log.lines.filter((l) => l.includes('switch state UNKNOWN'))
  assert.equal(warned.length, 1, 'three passes inside the minute: one line')
  assert.ok(h.retuned.every((b) => b.enabled === null))
  now += 60_000
  await h.poll.run()
  assert.equal(h.log.lines.filter((l) => l.includes('switch state UNKNOWN')).length, 2)
})

test('one tag in paper and in live is TWO books', () => {
  const books = desiredBooks([rowOf(), rowOf({ mode: 'live' })])
  assert.deepEqual(
    books.map((b) => b.key).sort(),
    ['TCS-2026-09-25-recenter-r:live', 'TCS-2026-09-25-recenter-r:paper'],
  )
  assert.equal(bookKey('T', 'live'), 'T:live')
})

test('the dials are RESOLVED, and what did not resolve is reported', () => {
  const [book] = desiredBooks([
    rowOf({ dials: { delta_tol_pct: 0.05, cooldown_min: 3, lot_size: 25 } }),
  ])
  assert.ok(book !== undefined)
  assert.equal(book.dials.delta_tol_pct, 0.05)
  // Everything not written stays at the engine's own default.
  assert.equal(book.dials.confirm_ms, DEFAULT_DIALS.confirm_ms)
  // `cooldown_min` died in the port; `lot_size` is refused by name (spec §7).
  assert.deepEqual([...book.unknownDials].sort(), ['cooldown_min', 'lot_size'])
})

// ── convergence ─────────────────────────────────────────────────────────────

test('a book the operator switched on is started and reported', async () => {
  const h = harness()
  h.docs.push(rowOf())
  await h.poll.run()
  assert.deepEqual(h.started, ['TCS-2026-09-25-recenter-r:paper'])
  assert.deepEqual(h.reported, ['TCS-2026-09-25-recenter-r:paper'])
  assert.deepEqual(h.retuned, [])
})

test('a second pass RETUNES rather than restarting — a dial change lands live', async () => {
  const h = harness()
  h.docs.push(rowOf())
  await h.poll.run()
  h.docs[0] = rowOf({ dials: { delta_tol_pct: 0.09 } })
  await h.poll.run()

  assert.deepEqual(h.started, ['TCS-2026-09-25-recenter-r:paper'])
  assert.equal(h.retuned.length, 1)
  assert.equal(h.retuned[0]?.dials.delta_tol_pct, 0.09)
})

test('SWITCHING A BOOK OFF STOPS STEERING IT AND PLACES NOTHING', async () => {
  // The whole callback surface is start/stop/retune/report. There is no order
  // path here at all, and that is the design: `stop` must never be able to
  // flatten a book nobody asked to close.
  const h = harness()
  h.docs.push(rowOf())
  await h.poll.run()
  h.docs[0] = rowOf({ desired: 'stopped' })
  await h.poll.run()

  assert.deepEqual(h.stopped, ['TCS-2026-09-25-recenter-r:paper'])
  assert.equal(h.running.size, 0)
  // Not reported: `actual` for a book we let go is main's to report once.
  assert.deepEqual(h.reported, ['TCS-2026-09-25-recenter-r:paper'])
})

test('an unknown dial is ERRORED once per distinct set, not once per poll', async () => {
  const h = harness()
  h.docs.push(rowOf({ dials: { nonsense: 1 } }))
  await h.poll.run()
  await h.poll.run()
  await h.poll.run()
  const complaints = h.log.lines.filter((l) => l.startsWith('error:'))
  assert.equal(complaints.length, 1)
  assert.match(complaints[0] ?? '', /NOT read by the engine/)

  // A DIFFERENT typo is news again.
  h.docs[0] = rowOf({ dials: { nonsense: 1, alsoWrong: 2 } })
  await h.poll.run()
  assert.equal(h.log.lines.filter((l) => l.startsWith('error:')).length, 2)
})

test('an unreadable registry leaves every book exactly as it was', async () => {
  // The dangerous reading of "the query threw" is "nothing is desired", which
  // would stop every book on one Mongo blip.
  const h = harness()
  h.docs.push(rowOf())
  await h.poll.run()

  const dead = new RegistryPoll({
    collection: {
      find: () => ({
        toArray: async () => {
          throw new Error('connection reset')
        },
      }),
    },
    log: h.log,
    running: () => h.running,
    start: async () => assert.fail('nothing may start'),
    stop: async () => assert.fail('nothing may stop'),
    retune: () => assert.fail('nothing may retune'),
    report: async () => assert.fail('nothing may report'),
  })
  await dead.run()
  assert.equal(h.running.size, 1)
  assert.ok(h.log.lines.some((l) => l.includes('desired state is UNKNOWN')))
})

test('TWO OVERLAPPING PASSES BUILD ONE BOOK — the nudge joins the timer', async () => {
  // The timer and desk-api's nudge overlap the moment an operator hits Start
  // while a slow pass is reading. Both would see `running()` empty and both
  // would call `start` — two hosts for one (tag, mode), each with its own
  // damping clock and its own idea of what is in flight.
  let release = (): void => {}
  const slow = new Promise<void>((resolve) => {
    release = resolve
  })
  const started: string[] = []
  const running = new Set<string>()
  const docs = [rowOf()]
  const poll = new RegistryPoll({
    collection: {
      find: () => ({
        toArray: async (): Promise<Record<string, unknown>[]> => {
          await slow
          return docs
        },
      }),
    },
    log: logOf(),
    running: () => running,
    start: async (book) => {
      // A start that YIELDS before it registers — reading a margin figure,
      // replaying an in-flight decision. The guard has to hold whatever `start`
      // does inside itself, not depend on it registering synchronously.
      await Promise.resolve()
      started.push(book.key)
      running.add(book.key)
    },
    stop: async () => {},
    retune: () => {},
    report: async () => {},
  })

  const first = poll.run()
  const second = poll.run()
  release()
  await Promise.all([first, second])

  assert.deepEqual(started, ['TCS-2026-09-25-recenter-r:paper'])
})

test('a start that keeps failing is reported once a minute per key, with the count, and forgotten once it starts', async () => {
  /**
   * A row whose chain the master no longer lists (the 09-18 sync pruned the
   * SENSEX 09-17 chain under two `desired: running` rows) fails `start` on
   * every 5 s pass for as long as it stays in the registry. That is one
   * condition, not 700 alarms a hour — so it is one ERROR a minute per key
   * with the count, and the moment the start succeeds the throttle is
   * forgotten, so a NEW failure later is reported at once.
   */
  let now = 0
  let fail = true
  const h = harness({
    start: async (book) => {
      if (fail) throw new Error(`no chain for ${book.symbol}`)
      h.running.add(book.key)
    },
    now: () => now,
  })
  h.docs.push(rowOf())
  const errors = () => h.log.lines.filter((l) => l.includes('could NOT be started'))
  for (let i = 0; i < 3; i += 1) {
    await h.poll.run()
    now += 5_000
  }
  assert.equal(errors().length, 1, 'three failures inside the minute: one line')

  now += 60_000
  await h.poll.run()
  assert.equal(errors().length, 2, 'the next minute: a second line')
  assert.ok(h.log.lines.some((l) => l.includes('could NOT be started') && l.includes('"suppressed":2')))

  // It starts: the key is forgotten. Stop it, break it again — reported at once.
  fail = false
  await h.poll.run()
  assert.deepEqual([...h.running], ['TCS-2026-09-25-recenter-r:paper'])
  h.running.clear()
  fail = true
  now += 1_000
  await h.poll.run()
  assert.equal(errors().length, 3, 'a fresh failure after a success is not folded into the old window')
})

test('a key that never started is forgotten when its row is RETIRED — a re-add is a fresh incident', async () => {
  /**
   * The row this throttle exists for — one whose start fails on every pass —
   * is never in `running()`, so the stop loop never sees it go. If the retire
   * were the only place the throttle was dropped, the SENSEX 09-17 rows the
   * roll retires would leave a Throttle each behind forever, and a row
   * re-added under the same key inside the old window would inherit its
   * quiet period and its count: the first ERROR of the new failure swallowed,
   * and the two incidents folded into one number.
   */
  let now = 0
  const h = harness({
    start: async (book) => {
      throw new Error(`no chain for ${book.symbol}`)
    },
    now: () => now,
  })
  h.docs.push(rowOf())
  const errors = () => h.log.lines.filter((l) => l.includes('could NOT be started'))
  await h.poll.run()
  assert.equal(errors().length, 1)

  // Retired: the row is gone from the registry, and the key was never running.
  h.docs.length = 0
  now += 5_000
  await h.poll.run()
  assert.deepEqual(h.stopped, [], 'nothing to stop — it never started')

  // Re-added 5 s later, well inside the retired incident's minute.
  h.docs.push(rowOf())
  now += 5_000
  await h.poll.run()
  assert.equal(errors().length, 2, 'a re-added key is a fresh incident, reported at once')
  assert.ok(errors()[1]?.includes('"suppressed":0'), 'with no count carried over from the retired row')
})

test('a start that throws is named, and the pass carries on', async () => {
  const h = harness({
    start: async (book) => {
      throw new Error(`no chain for ${book.symbol}`)
    },
  })
  h.docs.push(rowOf())
  await h.poll.run()
  assert.ok(h.log.lines.some((l) => l.includes('could NOT be started')))
  // Nothing reported for a book that is not running: `actual` must not claim it.
  assert.deepEqual(h.reported, [])
})
