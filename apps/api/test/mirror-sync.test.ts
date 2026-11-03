/**
 * Mirror position sync — the DETECTOR half, Mongo-free behind ports.
 *
 * THE PROPERTY MOST OF THESE TESTS ARE REALLY ABOUT: this job files a
 * correction ONLY when it is sure, and says so out loud exactly once. The
 * 2026-08-18 incident it exists for — a cancelled order left the mirror ledger
 * at −65 while the broker held 0 — is the easy case; the tests below are
 * mostly about the cases where it must do NOTHING: a divergence seen once (a
 * fill racing the compare scan), an order still in flight, a contract claimed
 * by more than one tag (attribution is a human's question), a lot size the
 * master cannot answer or that does not divide the broker's quantity. A wrong
 * automatic repair on the money path is worse than the phantom it replaces,
 * because nobody is looking for it.
 *
 * And the constant is asserted AS A LITERAL: the runner side defines its own
 * matching `'runner:sync-request'`, so a rename here must go red rather than
 * quietly filing requests nothing will ever consume.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { InstrumentRef } from '@algomaker/order-bus'
import {
  createMirrorSync,
  mirrorSyncDisabled,
  mirrorTagPrefixes,
  SYNC_REQUEST_KEY,
  type MirrorSyncPorts,
  type SyncRequest,
} from '../src/mirror-sync.ts'
import type {
  PositionsCompareReport,
  SymbolCompare,
} from '../src/positions-compare.ts'

/** 2026-08-18 12:00 IST — the phantom-short day. */
const NOW = Date.parse('2026-08-18T06:30:00.000Z')
/** The mirror-sync cadence the harness advances by between passes. */
const TICK = 60_000

type Doc = Record<string, unknown>

/** The incident's contract: NIFTY weekly PE, lot size 65 — ledger −65 is one
 * short lot, broker 0 is the cancelled order's truth. */
const SYMBOL = 'NIFTY2681824200PE'
const LOT_SIZE = 65

const refOf = (tradingsymbol: string): InstrumentRef => ({
  tradingsymbol,
  lotSize: LOT_SIZE,
  tickSize: 0.05,
  exchange: 'NFO',
})

/** One divergent row, in the comparer's own shape. Defaults are the incident. */
const row = (over: Partial<SymbolCompare> = {}): SymbolCompare => ({
  symbol: SYMBOL,
  broker: 0,
  books: 0,
  ledger: -65,
  agree: false,
  claimedBy: ['MIRROR_A006'],
  note: 'the desk claims -65 (books 0, ledger -65); the broker reports nothing on this contract',
  ...over,
})

const reportOf = (
  rows: readonly SymbolCompare[],
  asOf: number,
  over: Partial<PositionsCompareReport> = {},
): PositionsCompareReport => ({
  asOf,
  day: '2026-08-18',
  mode: 'live',
  comparable: true,
  reason: '',
  brokerAsOf: asOf - 10_000,
  symbols: rows,
  divergent: rows.filter((r) => !r.agree).map((r) => r.symbol),
  unattributable: [],
  unmeasurable: [],
  intervalMs: 300_000,
  ...over,
})

/**
 * The harness. `state.rows` is what the fake comparer reports; `pass()`
 * advances the clock by one tick FIRST, so consecutive passes read reports
 * with distinct `asOf` stamps — exactly what two real comparer scans produce,
 * and what the same-scan guard requires to count them as two sightings.
 */
function harness(over: Partial<MirrorSyncPorts> = {}): {
  pass: () => Promise<void>
  clock: { ms: number }
  state: { rows: SymbolCompare[] }
  runs: () => number
  /** The upsert store, keyed (tag, key) — one entry per instance, replaced. */
  docs: Map<string, Doc>
  filed: { instance: string; request: SyncRequest }[]
  journalled: Doc[]
  notified: Doc[]
  logs: string[]
  pending: Set<string>
} {
  const clock = { ms: NOW }
  const state = { rows: [] as SymbolCompare[] }
  let runs = 0
  const docs = new Map<string, Doc>()
  const filed: { instance: string; request: SyncRequest }[] = []
  const journalled: Doc[] = []
  const notified: Doc[] = []
  const logs: string[] = []
  const pending = new Set<string>()
  const ports: MirrorSyncPorts = {
    now: () => clock.ms,
    log: (msg) => logs.push(msg),
    disabled: () => false,
    tagPrefixes: () => ['MIRROR_'],
    comparer: {
      run: async (nowMs) => {
        runs++
        return reportOf(state.rows, nowMs)
      },
      last: async () => reportOf(state.rows, clock.ms),
    },
    pendingOrder: async (tag, tradingsymbol) => pending.has(`${tag}|${tradingsymbol}`),
    resolveSymbol: (tradingsymbol) => refOf(tradingsymbol),
    file: async (instance, request, nowMs) => {
      filed.push({ instance, request })
      docs.set(`${instance}|${SYNC_REQUEST_KEY}`, {
        tag: instance,
        key: SYNC_REQUEST_KEY,
        value: request,
        updatedAt: nowMs,
      })
    },
    journal: async (events) => {
      journalled.push(...events)
    },
    notify: (_mode, event) => notified.push(event),
    ...over,
  }
  const sync = createMirrorSync(ports)
  return {
    pass: async () => {
      clock.ms += TICK
      await sync.run()
    },
    clock,
    state,
    runs: () => runs,
    docs,
    filed,
    journalled,
    notified,
    logs,
    pending,
  }
}

// -------------------------------------------------------------- the contract

test('the request key is the literal the runner side must match', () => {
  // The runner defines its own copy of this string (same pattern as
  // CLEAR_REQUEST_KEY). If either side renames, this line is the red build.
  assert.equal(SYNC_REQUEST_KEY, 'runner:sync-request')
})

// ------------------------------------------------------- the stability guard

test('one sighting files NOTHING; the second consecutive sighting files the correction', async () => {
  const h = harness()
  h.state.rows = [row()]

  await h.pass()
  assert.equal(h.filed.length, 0, 'a divergence seen once may be a fill racing the scan')
  assert.equal(h.journalled.length, 0)

  await h.pass()
  assert.equal(h.filed.length, 1, 'the same divergence twice is confirmed')
  const { instance, request } = h.filed[0] as { instance: string; request: SyncRequest }
  assert.equal(instance, 'MIRROR_A006:live', 'filed under the TAG:mode scope the runner reads')
  assert.equal(request.requestedBy, 'mirror-sync')
  assert.equal(request.requestedAt, h.clock.ms)
  assert.deepEqual(request.corrections, [
    // TARGET signed lots — broker 0 units / 65 per lot. The full InstrumentRef
    // rides along so the runner can build an entry it never held.
    { tradingsymbol: SYMBOL, lots: 0, instrument: refOf(SYMBOL) },
  ])
})

test('the journal names the repair in the operator’s numbers, and pushes it', async () => {
  const h = harness()
  h.state.rows = [row()]
  await h.pass()
  await h.pass()
  assert.equal(h.journalled.length, 1)
  const event = h.journalled[0] as Doc
  assert.equal(event['phase'], 'STATUS')
  assert.equal(event['ok'], false)
  assert.equal(event['tag'], 'MIRROR_A006')
  assert.equal(event['tradingsymbol'], SYMBOL)
  assert.match(String(event['error']), /mirror sync/)
  assert.match(String(event['error']), /ledger -65 → 0 \(broker truth\)/)
  assert.match(String(event['error']), /correction filed for MIRROR_A006/)
  assert.deepEqual(h.notified, h.journalled, 'the dashboard hears what the feed records')
})

test('a broker number that MOVED between passes restarts the count', async () => {
  const h = harness()
  // Pass 1 sees −130 at the broker; by pass 2 it is −65. Same symbol, same
  // tag — but not the same divergence, so nothing is confirmed yet.
  h.state.rows = [row({ broker: -130 })]
  await h.pass()
  h.state.rows = [row({ broker: -65 })]
  await h.pass()
  assert.equal(h.filed.length, 0, 'a moving target is a position mid-flight, not a phantom')
  // Only when −65 is seen AGAIN is it a fact worth acting on.
  await h.pass()
  assert.equal(h.filed.length, 1)
  assert.equal((h.filed[0] as { request: SyncRequest }).request.corrections[0]?.lots, -1)
})

// --------------------------------------------------------------- the guards

test('a PLACED gateway order suppresses the correction while it is in flight', async () => {
  const h = harness()
  h.state.rows = [row()]
  h.pending.add(`MIRROR_A006|${SYMBOL}`)
  await h.pass()
  await h.pass()
  await h.pass()
  assert.equal(h.filed.length, 0, 'an in-flight order may be about to resolve this itself')
  // The order settles (or is cancelled) — the standing sightings mean the very
  // next pass may act, with no fresh confirmation wait.
  h.pending.delete(`MIRROR_A006|${SYMBOL}`)
  await h.pass()
  assert.equal(h.filed.length, 1)
})

test('a mirror tag among MULTIPLE claimants is an alert, and is never filed', async () => {
  const h = harness()
  h.state.rows = [row({ books: -65, ledger: -65, broker: -65, claimedBy: ['BHEL-R', 'MIRROR_A006'] })]
  await h.pass()
  await h.pass()
  await h.pass()
  assert.equal(h.filed.length, 0, 'the broker number is a sum over claimants — attribution is a human’s question')
  // LOUD: the ALERT is in the feed. NOT NOISY: the identical fact is said once.
  assert.equal(h.journalled.length, 1)
  const alert = h.journalled[0] as Doc
  assert.match(String(alert['error']), /ALERT/)
  assert.match(String(alert['error']), /ambiguous/i)
  assert.equal(alert['tradingsymbol'], SYMBOL)
})

test('a divergence with desk-book quantity on the contract is not this job’s to repair', async () => {
  const h = harness()
  h.state.rows = [row({ books: -65, ledger: -65, broker: -65 })]
  await h.pass()
  await h.pass()
  assert.equal(h.filed.length, 0)
  assert.equal(h.journalled.length, 0)
})

test('a broker quantity that is not a whole number of lots alerts, never files', async () => {
  const h = harness()
  // −70 units against a 65 lot size: the lot size on file is wrong, or the
  // position is not what it looks like. A correction would be a guess.
  h.state.rows = [row({ broker: -70, ledger: -65 })]
  await h.pass()
  await h.pass()
  await h.pass()
  assert.equal(h.filed.length, 0)
  assert.equal(h.journalled.length, 1)
  assert.match(String((h.journalled[0] as Doc)['error']), /whole number of lots|fractional/i)
})

test('a contract the master cannot resolve alerts, never files', async () => {
  const h = harness({ resolveSymbol: () => null })
  h.state.rows = [row()]
  await h.pass()
  await h.pass()
  assert.equal(h.filed.length, 0, 'an unsizable quantity cannot become a lots target')
  assert.equal(h.journalled.length, 1)
  assert.match(String((h.journalled[0] as Doc)['error']), /master/i)
})

test('a divergence claimed by no mirror tag is simply not this job’s business', async () => {
  const h = harness()
  h.state.rows = [row({ claimedBy: ['BHEL-R'] })]
  await h.pass()
  await h.pass()
  assert.equal(h.filed.length, 0)
  assert.equal(h.journalled.length, 0, 'the positions-compare report already tells the operator')
})

// ---------------------------------------------------------- the kill switch

test('the disabled dial stops the pass before it reads anything', async () => {
  const h = harness({ disabled: () => true })
  h.state.rows = [row()]
  await h.pass()
  await h.pass()
  assert.equal(h.runs(), 0, 'not even the comparer is driven while switched off')
  assert.equal(h.filed.length, 0)
  assert.equal(h.journalled.length, 0)
})

// -------------------------------------------------------- loud but not noisy

test('an unchanged correction set keeps refreshing the request but journals ONCE', async () => {
  const h = harness()
  h.state.rows = [row()]
  await h.pass()
  await h.pass()
  await h.pass()
  await h.pass()
  // The upsert repeats — `requestedAt` is what the runner's TTL judges, and a
  // request that stopped being refreshed would expire into silence.
  assert.equal(h.filed.length, 3, 'every confirmed pass re-files')
  assert.equal(
    (h.filed[2] as { request: SyncRequest }).request.requestedAt,
    h.clock.ms,
    'the latest filing carries the latest stamp',
  )
  // But the humans' line went out exactly once for this correction set.
  assert.equal(h.journalled.length, 1)
})

test('repeats REPLACE the parked request — one document per instance, never a stack', async () => {
  const h = harness()
  h.state.rows = [row()]
  await h.pass()
  await h.pass()
  await h.pass()
  assert.equal(h.docs.size, 1, 'upserted on (tag, key)')
  const doc = h.docs.get(`MIRROR_A006:live|${SYNC_REQUEST_KEY}`) as Doc
  assert.equal(doc['updatedAt'], h.clock.ms, 'and it is the LATEST request that stands')
})

test('a CHANGED correction set is news, and is journalled again', async () => {
  const h = harness()
  h.state.rows = [row()]
  await h.pass()
  await h.pass()
  assert.equal(h.journalled.length, 1)
  // The phantom worsens: the broker now reports a real short the ledger has
  // wrong. New target, new sentence — after its own two-pass confirmation.
  h.state.rows = [row({ broker: -130 })]
  await h.pass()
  await h.pass()
  assert.equal(h.journalled.length, 2)
  assert.match(String((h.journalled[1] as Doc)['error']), /→ -130 \(broker truth\)/)
})

// ------------------------------------------------- when there is no evidence

test('a report with no verdict is a no-op that neither confirms nor refutes', async () => {
  // Pass 2's broker snapshot goes unreadable: comparable:false, and by
  // construction nothing is divergent in that report. It must file nothing —
  // AND it must not erase pass 1's sighting, or one flaky broker poll would
  // reset every confirmation on the desk.
  const h = harness({
    comparer: {
      run: async (nowMs) =>
        nowMs === NOW + 2 * TICK
          ? reportOf([], nowMs, { comparable: false, reason: 'the broker snapshot is INCOMPLETE' })
          : reportOf([row()], nowMs),
      last: async () => null,
    },
  })
  await h.pass() // sighting 1
  await h.pass() // no verdict — files nothing, forgets nothing
  assert.equal(h.filed.length, 0)
  await h.pass() // the same divergence again — confirmed across the gap
  assert.equal(h.filed.length, 1)
})

test('a comparer pass already in flight (run() null) falls back to last()', async () => {
  let lastCalls = 0
  const h = harness({
    comparer: {
      run: async () => null,
      // A FRESH stored report each time — the 5-minute interval's own passes
      // keep landing while this job's run() calls keep colliding with them.
      last: async () => reportOf([row()], NOW + ++lastCalls),
    },
  })
  await h.pass()
  await h.pass()
  assert.equal(lastCalls, 2, 'the stored report is the fallback answer')
  assert.equal(h.filed.length, 1, 'two distinct stored reports are two sightings')
})

test('ONE comparer scan read twice is ONE sighting, not a confirmation', async () => {
  // run() stays in flight forever; last() keeps serving the SAME report. Two
  // reads of one scan must never satisfy the two-pass guard — that would be
  // the stability guard confirming itself.
  const frozen = reportOf([row()], NOW)
  const h = harness({
    comparer: { run: async () => null, last: async () => frozen },
  })
  await h.pass()
  await h.pass()
  await h.pass()
  assert.equal(h.filed.length, 0)
})

// ------------------------------------------------------------- never rejects

test('the pass never rejects — a comparer that throws twice is a log line', async () => {
  const h = harness({
    comparer: {
      run: async () => {
        throw new Error('mongo is down')
      },
      last: async () => {
        throw new Error('mongo is still down')
      },
    },
  })
  await assert.doesNotReject(h.pass())
  assert.ok(h.logs.some((l) => /mirror sync/.test(l)), 'and it says why')
})

test('one bad row never stops the pass — the other phantom is still repaired', async () => {
  const OTHER = 'BANKNIFTY2681852000CE'
  const h = harness({
    resolveSymbol: (s) => {
      if (s === OTHER) throw new Error('master exploded on this one')
      return refOf(s)
    },
  })
  h.state.rows = [
    row({ symbol: OTHER, claimedBy: ['MIRROR_A007'] }),
    row(),
  ]
  await h.pass()
  await h.pass()
  assert.equal(h.filed.length, 1, 'the readable row is still filed')
  assert.equal((h.filed[0] as { instance: string }).instance, 'MIRROR_A006:live')
})

test('two passes cannot overlap — the second is dropped, not queued', async () => {
  let release: () => void = () => {}
  const gate = new Promise<void>((res) => {
    release = res
  })
  let runsStarted = 0
  const clockRef = { ms: NOW + TICK }
  const h = harness({
    comparer: {
      run: async (nowMs) => {
        runsStarted++
        await gate
        return reportOf([], nowMs)
      },
      last: async () => reportOf([], clockRef.ms),
    },
  })
  const first = h.pass()
  const second = h.pass()
  release()
  await Promise.all([first, second])
  assert.equal(runsStarted, 1, 'the overlapping pass did nothing')
})

// ------------------------------------------------------------------ the dials

test('the mirror set defaults to the MIRROR_ prefix and reads a comma list', () => {
  assert.deepEqual(mirrorTagPrefixes({}), ['MIRROR_'])
  assert.deepEqual(mirrorTagPrefixes({ DESK_MIRROR_SYNC_TAGS: '' }), ['MIRROR_'])
  assert.deepEqual(
    mirrorTagPrefixes({ DESK_MIRROR_SYNC_TAGS: 'MIRROR_, SIG_' }),
    ['MIRROR_', 'SIG_'],
  )
  // A list of empty items is no list at all — the default stands rather than
  // an empty set that could never match anything (a silently dead job).
  assert.deepEqual(mirrorTagPrefixes({ DESK_MIRROR_SYNC_TAGS: ' , ' }), ['MIRROR_'])
})

test('the kill switch is OFF unless deliberately set', () => {
  assert.equal(mirrorSyncDisabled({}), false)
  assert.equal(mirrorSyncDisabled({ DESK_MIRROR_SYNC_DISABLED: '0' }), false)
  assert.equal(mirrorSyncDisabled({ DESK_MIRROR_SYNC_DISABLED: 'false' }), false)
  assert.equal(mirrorSyncDisabled({ DESK_MIRROR_SYNC_DISABLED: '1' }), true)
  assert.equal(mirrorSyncDisabled({ DESK_MIRROR_SYNC_DISABLED: 'yes' }), true)
})

test('a custom prefix set governs who may be corrected', async () => {
  const h = harness({ tagPrefixes: () => ['SIG_'] })
  h.state.rows = [row()] // claimed by MIRROR_A006 — outside the configured set
  await h.pass()
  await h.pass()
  assert.equal(h.filed.length, 0)
  const h2 = harness({ tagPrefixes: () => ['SIG_'] })
  h2.state.rows = [row({ claimedBy: ['SIG_X01'] })]
  await h2.pass()
  await h2.pass()
  assert.equal(h2.filed.length, 1)
  assert.equal((h2.filed[0] as { instance: string }).instance, 'SIG_X01:live')
})
