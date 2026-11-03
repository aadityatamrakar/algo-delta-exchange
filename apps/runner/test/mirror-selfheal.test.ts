/**
 * The mirror-leg self-heal (audit F-6a/F-6d).
 *
 * The incident these tests encode: on 2026-08-10 `MIRROR_A006` was found
 * holding four legs, three of them SENSEX contracts that had EXPIRED on 6 Aug
 * and were gone from the instrument master. Nothing in the system could clear
 * them — `MirrorHost` squares nothing off by design, `main.ts` withholds the
 * MIRROR rows from `Runner` so the EOD backstop never sees them, and
 * `flattenTag` rebuilds positions from `desk-fills`, which has zero mirror
 * rows. The only way out was "stop desk-runner -> edit Mongo -> start", in that
 * order, because `ledgerFor()` caches each ledger at boot and the next `#save()`
 * silently undoes a live edit.
 *
 * Two properties are therefore load-bearing here:
 *
 *  - an entry whose contract has EXPIRED is swept, because no exit can ever
 *    arrive for it — but ONLY on a recorded expiry strictly before today, and
 *    NEVER on an entry with no expiry recorded, because dropping a leg the
 *    upstream account still holds books its eventual mirrored exit against an
 *    empty ledger and creates a phantom position the other way;
 *  - a clear is applied BY THE RUNNER, through the ledger it owns, from a
 *    request document — so the single-writer discipline that made the
 *    stop-edit-start runbook necessary is preserved rather than broken.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fixedClock } from '@algomaker/core'
import { MemoryStateStore, makeLogger, type CapturedLog } from '@algomaker/strategy-kit'
import {
  applyClearRequest,
  applySyncRequest,
  clearRequestTtlMs,
  CLEAR_REQUEST_KEY,
  DEFAULT_CLEAR_REQUEST_TTL_MS,
  DEFAULT_SYNC_REQUEST_TTL_MS,
  HttpOrderGateway,
  istDateOf,
  PositionLedger,
  sweepClearRequests,
  SYNC_REQUEST_KEY,
  syncRequestTtlMs,
  type ClearRequestIndex,
} from '../src/order-gateway.ts'

const SENSEX = {
  tradingsymbol: 'SENSEX2580681000CE',
  instrumentToken: 111,
  lotSize: 10,
  tickSize: 0.05,
  exchange: 'BFO',
  expiry: '2026-08-06',
}
const NIFTY = {
  tradingsymbol: 'NIFTY25AUG24000PE',
  instrumentToken: 222,
  lotSize: 75,
  tickSize: 0.05,
  exchange: 'NFO',
  expiry: '2026-08-28',
}
/** A leg booked before `expiry` was ever recorded — the migration case. */
const LEGACY = {
  tradingsymbol: 'BANKNIFTY25AUG56000CE',
  instrumentToken: 333,
  lotSize: 35,
  tickSize: 0.05,
  exchange: 'NFO',
}

const TODAY = '2026-08-10'
/** 09:30 IST on `TODAY`. Every clear below is timed against this. */
const NOW_MS = Date.UTC(2026, 7, 10, 4, 0)
/** The runner's default: a clear that has been parked for an hour is spent. */
const TTL = DEFAULT_CLEAR_REQUEST_TTL_MS
/** And a sync request the detector stopped re-filing five minutes ago is too. */
const SYNC_TTL = DEFAULT_SYNC_REQUEST_TTL_MS

async function ledgerWith(
  entries: readonly { inst: typeof SENSEX | typeof LEGACY; side: 'BUY' | 'SELL'; lots: number }[],
): Promise<{ ledger: PositionLedger; state: MemoryStateStore }> {
  const state = new MemoryStateStore()
  const ledger = new PositionLedger(state)
  await ledger.load()
  for (const e of entries) await ledger.apply(e.inst, e.side, e.lots, 12.5)
  return { ledger, state }
}

// ------------------------------------------------------- F-6a: expiry sweeper

test('apply() records the contract expiry when the instrument carries one', async () => {
  const { ledger } = await ledgerWith([{ inst: SENSEX, side: 'SELL', lots: 1 }])
  assert.equal(ledger.open()[0]?.expiry, '2026-08-06')
})

test('apply() records nothing when the instrument has no expiry — no guessing', async () => {
  const { ledger } = await ledgerWith([{ inst: LEGACY, side: 'BUY', lots: 2 }])
  assert.equal(ledger.open()[0]?.expiry, undefined)
})

test('dropExpired sweeps a leg whose contract expired BEFORE today and returns it', async () => {
  const { ledger, state } = await ledgerWith([
    { inst: SENSEX, side: 'SELL', lots: 3 },
    { inst: NIFTY, side: 'BUY', lots: 1 },
  ])
  const dropped = await ledger.dropExpired(TODAY)
  assert.deepEqual(
    dropped.map((d) => d.tradingsymbol),
    [SENSEX.tradingsymbol],
  )
  assert.equal(dropped[0]?.lots, -3, 'the sweep reports the signed size it removed')
  assert.deepEqual(
    ledger.open().map((e) => e.tradingsymbol),
    [NIFTY.tradingsymbol],
  )
  // PERSISTED, not just forgotten in memory: a sweep the next boot undoes is no
  // sweep at all.
  const stored = await state.get<{ tradingsymbol: string }[]>('runner:positions')
  assert.deepEqual(stored?.map((e) => e.tradingsymbol), [NIFTY.tradingsymbol])
})

test('dropExpired keeps a contract expiring TODAY — it is still tradable', async () => {
  const { ledger } = await ledgerWith([{ inst: SENSEX, side: 'SELL', lots: 1 }])
  const dropped = await ledger.dropExpired('2026-08-06')
  assert.equal(dropped.length, 0)
  assert.equal(ledger.openCount, 1)
})

test('dropExpired NEVER drops a leg with no recorded expiry', async () => {
  const { ledger } = await ledgerWith([{ inst: LEGACY, side: 'BUY', lots: 2 }])
  assert.equal((await ledger.dropExpired('2030-01-01')).length, 0)
  assert.equal(ledger.openCount, 1)
})

test('istDateOf reads the IST calendar day, not the host timezone', () => {
  // 2026-08-10 19:00 UTC is already 2026-08-11 in IST (+05:30).
  assert.equal(istDateOf(Date.UTC(2026, 7, 10, 19, 0)), '2026-08-11')
  assert.equal(istDateOf(Date.UTC(2026, 7, 10, 18, 0)), '2026-08-10')
})

// ------------------------------------------------------------- signed net

test('netLots answers the signed net for a symbol, and 0 for one it has never seen', async () => {
  const { ledger } = await ledgerWith([
    { inst: SENSEX, side: 'SELL', lots: 2 },
    { inst: NIFTY, side: 'BUY', lots: 4 },
  ])
  assert.equal(ledger.netLots(SENSEX.tradingsymbol), -2)
  assert.equal(ledger.netLots(NIFTY.tradingsymbol), 4)
  assert.equal(ledger.netLots('NOT_A_SYMBOL'), 0)
})

// --------------------------------------------------- F-6d: the audited clear

function clearDeps(
  ledger: PositionLedger,
  state: MemoryStateStore,
  logs: CapturedLog[],
): Parameters<typeof applyClearRequest>[0] {
  return {
    instance: 'MIRROR_A006:paper',
    ledger,
    state,
    todayIst: TODAY,
    nowMs: NOW_MS,
    ttlMs: TTL,
    log: makeLogger(logs),
  }
}

test('a symbols clear-request drops exactly the named legs, through the ledger', async () => {
  const { ledger, state } = await ledgerWith([
    { inst: SENSEX, side: 'SELL', lots: 3 },
    { inst: NIFTY, side: 'BUY', lots: 1 },
  ])
  await state.set(CLEAR_REQUEST_KEY, {
    symbols: [SENSEX.tradingsymbol],
    requestedBy: 'aaditya',
    requestedAt: NOW_MS,
  })
  const logs: CapturedLog[] = []

  const dropped = await applyClearRequest(clearDeps(ledger, state, logs))

  assert.deepEqual(dropped.map((d) => d.tradingsymbol), [SENSEX.tradingsymbol])
  assert.deepEqual(ledger.open().map((e) => e.tradingsymbol), [NIFTY.tradingsymbol])
  // The request is CONSUMED, or the next sync would clear the same legs again.
  assert.equal(await state.get(CLEAR_REQUEST_KEY), null)
  // Journalled with the operator's name and the legs, not just a count.
  assert.ok(
    logs.some(
      (l) =>
        l.level === 'warn' &&
        l.msg.includes('cleared') &&
        String(l.ctx?.['requestedBy']).includes('aaditya') &&
        String(l.ctx?.['legs']).includes(SENSEX.tradingsymbol),
    ),
    `expected a journalled clear, got ${JSON.stringify(logs)}`,
  )
})

test("a clear-request of 'expired' drops only the past-dated legs", async () => {
  const { ledger, state } = await ledgerWith([
    { inst: SENSEX, side: 'SELL', lots: 3 },
    { inst: NIFTY, side: 'BUY', lots: 1 },
    { inst: LEGACY, side: 'BUY', lots: 1 },
  ])
  await state.set(CLEAR_REQUEST_KEY, { symbols: 'expired', requestedBy: 'aaditya', requestedAt: NOW_MS })

  const dropped = await applyClearRequest(clearDeps(ledger, state, []))

  assert.deepEqual(dropped.map((d) => d.tradingsymbol), [SENSEX.tradingsymbol])
  assert.equal(ledger.openCount, 2)
  assert.equal(await state.get(CLEAR_REQUEST_KEY), null)
})

test("a clear-request of 'all' empties the ledger", async () => {
  const { ledger, state } = await ledgerWith([
    { inst: SENSEX, side: 'SELL', lots: 3 },
    { inst: NIFTY, side: 'BUY', lots: 1 },
  ])
  await state.set(CLEAR_REQUEST_KEY, { symbols: 'all', requestedBy: 'aaditya', requestedAt: NOW_MS })

  const dropped = await applyClearRequest(clearDeps(ledger, state, []))

  assert.equal(dropped.length, 2)
  assert.equal(ledger.openCount, 0)
})

test('a clear-request that matches NOTHING is still consumed — it must not wedge the loop', async () => {
  const { ledger, state } = await ledgerWith([{ inst: NIFTY, side: 'BUY', lots: 1 }])
  await state.set(CLEAR_REQUEST_KEY, {
    symbols: ['A_SYMBOL_THAT_IS_NOT_HELD'],
    requestedBy: 'aaditya',
    requestedAt: NOW_MS,
  })
  const logs: CapturedLog[] = []

  const dropped = await applyClearRequest(clearDeps(ledger, state, logs))

  assert.equal(dropped.length, 0)
  assert.equal(ledger.openCount, 1, 'nothing else may be touched')
  assert.equal(await state.get(CLEAR_REQUEST_KEY), null, 'the request is deleted anyway')
  assert.ok(logs.some((l) => l.msg.includes('matched nothing')))
})

test('no clear-request is a no-op — the common case must be free', async () => {
  const { ledger, state } = await ledgerWith([{ inst: NIFTY, side: 'BUY', lots: 1 }])
  const logs: CapturedLog[] = []
  const dropped = await applyClearRequest(clearDeps(ledger, state, logs))
  assert.equal(dropped.length, 0)
  assert.equal(ledger.openCount, 1)
  assert.equal(logs.length, 0)
})

test('a malformed clear-request is REFUSED loudly and consumed, never guessed at', async () => {
  const { ledger, state } = await ledgerWith([{ inst: NIFTY, side: 'BUY', lots: 1 }])
  await state.set(CLEAR_REQUEST_KEY, { symbols: 'everything' })
  const logs: CapturedLog[] = []

  const dropped = await applyClearRequest(clearDeps(ledger, state, logs))

  assert.equal(dropped.length, 0)
  assert.equal(ledger.openCount, 1)
  assert.equal(await state.get(CLEAR_REQUEST_KEY), null)
  assert.ok(logs.some((l) => l.level === 'error' && l.msg.toLowerCase().includes('unreadable')))
})

// ------------------------------- a clear is a NOW-intention, not a standing order

/**
 * THE PARKED REQUEST THAT FIRES WEEKS LATER.
 *
 * `POST /v1/desk/runner/positions/clear` 202-accepts any instance whose
 * `runner:positions` document exists, and the runner only ever looked at the
 * instances it currently hosts — so a clear raised for a tag that had been
 * retired from the catalogue sat in Mongo indefinitely. Re-add the tag a month
 * later and the runner's first sync applies it, at a size and against a book
 * that have nothing to do with what the operator was looking at when they
 * clicked. With `symbols: 'all'` that empties a live ledger.
 */
test('a clear-request older than the TTL is REFUSED and deleted, and its age is named', async () => {
  const { ledger, state } = await ledgerWith([{ inst: NIFTY, side: 'BUY', lots: 1 }])
  await state.set(CLEAR_REQUEST_KEY, {
    symbols: 'all',
    requestedBy: 'aaditya',
    requestedAt: NOW_MS - TTL - 1,
  })
  const logs: CapturedLog[] = []

  const dropped = await applyClearRequest(clearDeps(ledger, state, logs))

  assert.equal(dropped.length, 0)
  assert.equal(ledger.openCount, 1, 'a spent request must never empty a ledger')
  assert.equal(await state.get(CLEAR_REQUEST_KEY), null, 'and it is deleted, not left to fire later')
  const refusal = logs.find((l) => l.level === 'error' && /stale/i.test(l.msg))
  assert.ok(refusal !== undefined, `expected a loud refusal, got ${JSON.stringify(logs)}`)
  assert.equal(refusal.ctx?.['ageMs'], TTL + 1, 'the log names how old the request was')
  assert.equal(refusal.ctx?.['ttlMs'], TTL)
})

test('a clear-request raised just INSIDE the TTL is still applied', async () => {
  const { ledger, state } = await ledgerWith([{ inst: NIFTY, side: 'BUY', lots: 1 }])
  await state.set(CLEAR_REQUEST_KEY, {
    symbols: 'all',
    requestedBy: 'aaditya',
    requestedAt: NOW_MS - TTL,
  })

  const dropped = await applyClearRequest(clearDeps(ledger, state, []))

  assert.equal(dropped.length, 1)
  assert.equal(ledger.openCount, 0)
})

test('a clear-request with NO requestedAt cannot be aged, so it is refused and consumed', async () => {
  const { ledger, state } = await ledgerWith([{ inst: NIFTY, side: 'BUY', lots: 1 }])
  await state.set(CLEAR_REQUEST_KEY, { symbols: 'all', requestedBy: 'aaditya' })
  const logs: CapturedLog[] = []

  const dropped = await applyClearRequest(clearDeps(ledger, state, logs))

  assert.equal(dropped.length, 0)
  assert.equal(ledger.openCount, 1)
  assert.equal(await state.get(CLEAR_REQUEST_KEY), null)
  assert.ok(logs.some((l) => l.level === 'error' && /undated/i.test(l.msg)))
})

test('the TTL is one hour by default and overridable, and a junk override is ignored', () => {
  assert.equal(DEFAULT_CLEAR_REQUEST_TTL_MS, 3_600_000)
  assert.equal(clearRequestTtlMs({}), DEFAULT_CLEAR_REQUEST_TTL_MS)
  assert.equal(clearRequestTtlMs({ DESK_CLEAR_REQUEST_TTL_MS: '   ' }), DEFAULT_CLEAR_REQUEST_TTL_MS)
  assert.equal(clearRequestTtlMs({ DESK_CLEAR_REQUEST_TTL_MS: '0' }), DEFAULT_CLEAR_REQUEST_TTL_MS)
  assert.equal(clearRequestTtlMs({ DESK_CLEAR_REQUEST_TTL_MS: '-1' }), DEFAULT_CLEAR_REQUEST_TTL_MS)
  assert.equal(clearRequestTtlMs({ DESK_CLEAR_REQUEST_TTL_MS: '15m' }), DEFAULT_CLEAR_REQUEST_TTL_MS)
  assert.equal(clearRequestTtlMs({ DESK_CLEAR_REQUEST_TTL_MS: '900000' }), 900_000)
})

// ------------------------------------- the sweep, over instances we do NOT host

/** Only the instances that really have a request parked, like the real query. */
function finderOver(stores: ReadonlyMap<string, MemoryStateStore>): ClearRequestIndex {
  return {
    find: () => ({
      toArray: async () => {
        const out: Record<string, unknown>[] = []
        for (const [instance, s] of stores) {
          // Both request kinds, exactly as the real `$in` query answers.
          for (const key of [CLEAR_REQUEST_KEY, SYNC_REQUEST_KEY]) {
            if ((await s.get(key)) !== null) out.push({ tag: instance, key })
          }
        }
        return out
      },
    }),
  }
}

/** A `runner:positions` document for an instance this process does NOT host. */
async function retiredInstance(
  entries: readonly { inst: typeof SENSEX | typeof NIFTY; side: 'BUY' | 'SELL'; lots: number }[],
): Promise<MemoryStateStore> {
  const { state } = await ledgerWith(entries)
  // The ledger is DISCARDED here on purpose: that is the whole retired case —
  // the document exists and no live object is holding it.
  return state
}

function sweepDeps(
  stores: ReadonlyMap<string, MemoryStateStore>,
  ledgers: ReadonlyMap<string, PositionLedger>,
  logs: CapturedLog[],
): Parameters<typeof sweepClearRequests>[0] {
  return {
    collection: finderOver(stores),
    ledgers,
    stateFor: (instance) => {
      const s = stores.get(instance)
      if (s === undefined) throw new Error(`no state store for ${instance}`)
      return s
    },
    todayIst: TODAY,
    nowMs: NOW_MS,
    ttlMs: TTL,
    syncTtlMs: SYNC_TTL,
    log: makeLogger(logs),
  }
}

test('a clear for a RETIRED tag is applied to its document, though no ledger is cached', async () => {
  const state = await retiredInstance([
    { inst: SENSEX, side: 'SELL', lots: 3 },
    { inst: NIFTY, side: 'BUY', lots: 1 },
  ])
  await state.set(CLEAR_REQUEST_KEY, {
    symbols: [SENSEX.tradingsymbol],
    requestedBy: 'aaditya',
    requestedAt: NOW_MS,
  })
  const stores = new Map([['MIRROR_RETIRED:paper', state]])
  const logs: CapturedLog[] = []

  await sweepClearRequests(sweepDeps(stores, new Map(), logs))

  const stored = await state.get<{ tradingsymbol: string }[]>('runner:positions')
  assert.deepEqual(stored?.map((e) => e.tradingsymbol), [NIFTY.tradingsymbol])
  assert.equal(await state.get(CLEAR_REQUEST_KEY), null, 'and the request is consumed, not left parked')
  assert.ok(
    logs.some((l) => l.msg.includes('cleared') && String(l.ctx?.['legs']).includes(SENSEX.tradingsymbol)),
    `the drop is journalled identically, got ${JSON.stringify(logs)}`,
  )
})

test('a STALE clear for a retired tag is deleted without ever being applied', async () => {
  const state = await retiredInstance([{ inst: NIFTY, side: 'BUY', lots: 1 }])
  await state.set(CLEAR_REQUEST_KEY, {
    symbols: 'all',
    requestedBy: 'aaditya',
    requestedAt: NOW_MS - TTL - 60_000,
  })
  const stores = new Map([['MIRROR_RETIRED:paper', state]])

  await sweepClearRequests(sweepDeps(stores, new Map(), []))

  const stored = await state.get<{ tradingsymbol: string }[]>('runner:positions')
  assert.equal(stored?.length, 1, 'the retired book is untouched')
  assert.equal(await state.get(CLEAR_REQUEST_KEY), null)
})

test('a hosted instance still goes through the CACHED ledger — never a second writer', async () => {
  const { ledger, state } = await ledgerWith([
    { inst: SENSEX, side: 'SELL', lots: 3 },
    { inst: NIFTY, side: 'BUY', lots: 1 },
  ])
  await state.set(CLEAR_REQUEST_KEY, {
    symbols: [SENSEX.tradingsymbol],
    requestedBy: 'aaditya',
    requestedAt: NOW_MS,
  })
  const instance = 'MIRROR_A006:paper'
  const stores = new Map([[instance, state]])

  await sweepClearRequests(sweepDeps(stores, new Map([[instance, ledger]]), []))

  // THE CACHED OBJECT saw the drop. Had the sweep built its own ledger, this
  // one would still hold the leg and its next `#save()` would restore it.
  assert.deepEqual(ledger.open().map((e) => e.tradingsymbol), [NIFTY.tradingsymbol])
  assert.equal(await state.get(CLEAR_REQUEST_KEY), null)
})

test('one unreadable instance does not stop the rest of the sweep', async () => {
  const good = await retiredInstance([{ inst: NIFTY, side: 'BUY', lots: 1 }])
  await good.set(CLEAR_REQUEST_KEY, { symbols: 'all', requestedBy: 'aaditya', requestedAt: NOW_MS })
  const logs: CapturedLog[] = []
  const deps = {
    ...sweepDeps(new Map([['GOOD:paper', good]]), new Map(), logs),
    collection: {
      find: () => ({
        toArray: async () => [
          { tag: 'BROKEN:paper', key: CLEAR_REQUEST_KEY },
          { tag: 'GOOD:paper', key: CLEAR_REQUEST_KEY },
        ],
      }),
    },
  } as Parameters<typeof sweepClearRequests>[0]

  await sweepClearRequests(deps)

  assert.equal((await good.get<unknown[]>('runner:positions'))?.length, 0, 'the readable one was still cleared')
  assert.ok(logs.some((l) => l.level === 'error' && l.msg.includes('BROKEN:paper')))
})

// -------------------------------------------- the gateway records the expiry

test('the gateway books the expiry its instrument index answers with', async () => {
  const state = new MemoryStateStore()
  const ledger = new PositionLedger(state)
  await ledger.load()
  const gateway = new HttpOrderGateway({
    baseUrl: 'http://bridge:8890',
    token: 'tok',
    tag: 'MIRROR_A006',
    mode: 'paper',
    underlying: null,
    clock: fixedClock(Date.UTC(2026, 7, 10, 4, 0)),
    log: makeLogger(),
    ledger,
    state,
    retryDelayMs: 0,
    // What `main.ts` injects: the instrument dump's own expiry, keyed by
    // tradingsymbol. `InstrumentRef` does not carry one.
    expiryOf: (inst) => (inst.tradingsymbol === LEGACY.tradingsymbol ? '2026-08-28' : null),
    fetch: (async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ accepted: true, status: 'DONE', clientOrderId: 'c', routedLots: 1 }),
    })) as unknown as typeof globalThis.fetch,
  })

  await gateway.submit({ instrument: LEGACY, side: 'BUY', lots: 1 })

  assert.equal(ledger.open()[0]?.expiry, '2026-08-28')
})

// ----------------------------------------- set(): broker truth is an ABSOLUTE

test('set() creates an entry the ledger never held, and persists it', async () => {
  const { ledger, state } = await ledgerWith([])

  await ledger.set(NIFTY, 4)

  assert.equal(ledger.netLots(NIFTY.tradingsymbol), 4)
  const stored = await state.get<{ tradingsymbol: string; lots: number }[]>('runner:positions')
  assert.deepEqual(stored?.map((e) => [e.tradingsymbol, e.lots]), [[NIFTY.tradingsymbol, 4]])
})

test('set() REPLACES the net — it is an absolute, never a fold', async () => {
  const { ledger } = await ledgerWith([{ inst: NIFTY, side: 'BUY', lots: 3 }])

  await ledger.set(NIFTY, 5)

  // A fold would read 8 here, and applying the same correction twice would
  // read 13 — the whole reason broker truth travels as an absolute.
  assert.equal(ledger.netLots(NIFTY.tradingsymbol), 5)
  await ledger.set(NIFTY, 5)
  assert.equal(ledger.netLots(NIFTY.tradingsymbol), 5, 'idempotent: same truth, same book')
})

test('set() to zero REMOVES the entry — openCount means open positions', async () => {
  const { ledger, state } = await ledgerWith([{ inst: SENSEX, side: 'SELL', lots: 3 }])

  await ledger.set(SENSEX, 0)

  assert.equal(ledger.openCount, 0)
  assert.deepEqual(await state.get('runner:positions'), [])
})

test('set() preserves the recorded lastPrice when none is given, and takes a new one', async () => {
  // `ledgerWith` books every leg at 12.5.
  const { ledger } = await ledgerWith([{ inst: NIFTY, side: 'BUY', lots: 3 }])

  await ledger.set(NIFTY, 5)
  assert.equal(ledger.open()[0]?.lastPrice, 12.5, 'a stale price is still a usable referencePrice')

  await ledger.set(NIFTY, 2, 44.4)
  assert.equal(ledger.open()[0]?.lastPrice, 44.4)
})

test('set() preserves a recorded expiry the instrument itself does not carry', async () => {
  const state = new MemoryStateStore()
  const ledger = new PositionLedger(state)
  await ledger.load()
  // LEGACY states no expiry; it was recorded off the instrument dump at book time.
  await ledger.apply(LEGACY, 'BUY', 2, 10, '2026-08-28')

  await ledger.set(LEGACY, 5)

  assert.equal(ledger.open()[0]?.expiry, '2026-08-28', 'an entry that loses its expiry is unsweepable')
})

// --------------------------------- the mirror sync: broker truth as a request

function syncDeps(
  ledger: PositionLedger,
  state: MemoryStateStore,
  logs: CapturedLog[],
): Parameters<typeof applySyncRequest>[0] {
  return {
    instance: 'MIRROR_A006:paper',
    ledger,
    state,
    nowMs: NOW_MS,
    ttlMs: SYNC_TTL,
    log: makeLogger(logs),
  }
}

test('applySyncRequest sets each correction as an ABSOLUTE and reports both sides', async () => {
  const { ledger, state } = await ledgerWith([
    { inst: SENSEX, side: 'SELL', lots: 3 }, // ledger says -3; broker says -1
    { inst: NIFTY, side: 'BUY', lots: 1 }, // ledger says 1; broker never filled it
  ])
  await state.set(SYNC_REQUEST_KEY, {
    corrections: [
      { tradingsymbol: SENSEX.tradingsymbol, lots: -1, instrument: SENSEX },
      { tradingsymbol: NIFTY.tradingsymbol, lots: 0, instrument: NIFTY },
    ],
    requestedBy: 'mirror-sync',
    requestedAt: NOW_MS,
  })
  const logs: CapturedLog[] = []

  const changed = await applySyncRequest(syncDeps(ledger, state, logs))

  assert.deepEqual(changed, [
    { tradingsymbol: SENSEX.tradingsymbol, from: -3, to: -1 },
    { tradingsymbol: NIFTY.tradingsymbol, from: 1, to: 0 },
  ])
  assert.equal(ledger.netLots(SENSEX.tradingsymbol), -1)
  assert.equal(ledger.netLots(NIFTY.tradingsymbol), 0, 'a zero-lot correction removes the leg')
  assert.equal(ledger.openCount, 1)
  // Consumed, or the next sync would re-apply an absolute against a moved book.
  assert.equal(await state.get(SYNC_REQUEST_KEY), null)
  // Every applied correction is journalled at ERROR visibility, naming both sides.
  const line = logs.find((l) => l.level === 'error' && l.msg.includes('mirror sync applied'))
  assert.ok(line !== undefined, `expected a loud journal, got ${JSON.stringify(logs)}`)
  assert.ok(/-3 → -1 lot\(s\) \(broker truth\)/.test(line.msg), line.msg)
  assert.ok(line.msg.includes('requestedBy mirror-sync'))
})

test('a correction the ledger already agrees with applies nothing, and is still consumed', async () => {
  const { ledger, state } = await ledgerWith([{ inst: NIFTY, side: 'BUY', lots: 2 }])
  await state.set(SYNC_REQUEST_KEY, {
    corrections: [{ tradingsymbol: NIFTY.tradingsymbol, lots: 2, instrument: NIFTY }],
    requestedAt: NOW_MS,
  })
  const logs: CapturedLog[] = []

  const changed = await applySyncRequest(syncDeps(ledger, state, logs))

  assert.equal(changed.length, 0)
  assert.equal(ledger.netLots(NIFTY.tradingsymbol), 2)
  assert.equal(await state.get(SYNC_REQUEST_KEY), null)
  assert.ok(logs.some((l) => l.level === 'warn' && l.msg.includes('matched nothing')))
  assert.ok(!logs.some((l) => l.level === 'error'), 'no false alarm when nothing was wrong')
})

test('no sync-request is a no-op — the common case must be free', async () => {
  const { ledger, state } = await ledgerWith([{ inst: NIFTY, side: 'BUY', lots: 1 }])
  const logs: CapturedLog[] = []
  const changed = await applySyncRequest(syncDeps(ledger, state, logs))
  assert.equal(changed.length, 0)
  assert.equal(ledger.openCount, 1)
  assert.equal(logs.length, 0)
})

test('an UNREADABLE sync-request is consumed loudly with NOTHING applied — never guessed at', async () => {
  const malformed: unknown[] = [
    { corrections: 'everything', requestedAt: NOW_MS }, // not an array
    { corrections: [], requestedAt: NOW_MS }, // empty carries no instruction
    { requestedAt: NOW_MS }, // missing outright
    {
      // one bad row poisons the whole snapshot: NaN lots
      corrections: [
        { tradingsymbol: NIFTY.tradingsymbol, lots: 2, instrument: NIFTY },
        { tradingsymbol: SENSEX.tradingsymbol, lots: Number.NaN, instrument: SENSEX },
      ],
      requestedAt: NOW_MS,
    },
    {
      // missing instrument: the ledger cannot create an entry from a bare symbol
      corrections: [{ tradingsymbol: NIFTY.tradingsymbol, lots: 2 }],
      requestedAt: NOW_MS,
    },
    {
      // instrument names a DIFFERENT symbol: it would correct the wrong leg
      corrections: [{ tradingsymbol: NIFTY.tradingsymbol, lots: 2, instrument: SENSEX }],
      requestedAt: NOW_MS,
    },
  ]
  for (const request of malformed) {
    const { ledger, state } = await ledgerWith([{ inst: NIFTY, side: 'BUY', lots: 1 }])
    await state.set(SYNC_REQUEST_KEY, request)
    const logs: CapturedLog[] = []

    const changed = await applySyncRequest(syncDeps(ledger, state, logs))

    assert.equal(changed.length, 0, JSON.stringify(request))
    assert.equal(ledger.netLots(NIFTY.tradingsymbol), 1, 'not even the readable half is applied')
    assert.equal(await state.get(SYNC_REQUEST_KEY), null, 'consumed, or it re-logs forever')
    assert.ok(
      logs.some((l) => l.level === 'error' && l.msg.toLowerCase().includes('unreadable')),
      `expected a loud refusal for ${JSON.stringify(request)}`,
    )
  }
})

test('an UNDATED sync-request cannot be shown to be current, so it is refused and consumed', async () => {
  const { ledger, state } = await ledgerWith([{ inst: NIFTY, side: 'BUY', lots: 1 }])
  await state.set(SYNC_REQUEST_KEY, {
    corrections: [{ tradingsymbol: NIFTY.tradingsymbol, lots: 5, instrument: NIFTY }],
  })
  const logs: CapturedLog[] = []

  const changed = await applySyncRequest(syncDeps(ledger, state, logs))

  assert.equal(changed.length, 0)
  assert.equal(ledger.netLots(NIFTY.tradingsymbol), 1)
  assert.equal(await state.get(SYNC_REQUEST_KEY), null)
  assert.ok(logs.some((l) => l.level === 'error' && /undated/i.test(l.msg)))
})

test('a STALE sync-request is one the detector stopped vouching for — refused, deleted, aged', async () => {
  const { ledger, state } = await ledgerWith([{ inst: NIFTY, side: 'BUY', lots: 1 }])
  await state.set(SYNC_REQUEST_KEY, {
    corrections: [{ tradingsymbol: NIFTY.tradingsymbol, lots: 5, instrument: NIFTY }],
    requestedAt: NOW_MS - SYNC_TTL - 1,
  })
  const logs: CapturedLog[] = []

  const changed = await applySyncRequest(syncDeps(ledger, state, logs))

  assert.equal(changed.length, 0)
  assert.equal(ledger.netLots(NIFTY.tradingsymbol), 1, 'an old absolute must never land on a moved book')
  assert.equal(await state.get(SYNC_REQUEST_KEY), null, 'deleted, not left to fire later')
  const refusal = logs.find((l) => l.level === 'error' && /stale/i.test(l.msg))
  assert.ok(refusal !== undefined, `expected a loud refusal, got ${JSON.stringify(logs)}`)
  assert.equal(refusal.ctx?.['ageMs'], SYNC_TTL + 1, 'the log names how old the request was')
  assert.equal(refusal.ctx?.['ttlMs'], SYNC_TTL)
})

test('a sync-request raised just INSIDE its TTL is still applied', async () => {
  const { ledger, state } = await ledgerWith([{ inst: NIFTY, side: 'BUY', lots: 1 }])
  await state.set(SYNC_REQUEST_KEY, {
    corrections: [{ tradingsymbol: NIFTY.tradingsymbol, lots: 5, instrument: NIFTY }],
    requestedAt: NOW_MS - SYNC_TTL,
  })

  const changed = await applySyncRequest(syncDeps(ledger, state, []))

  assert.equal(changed.length, 1)
  assert.equal(ledger.netLots(NIFTY.tradingsymbol), 5)
})

test('the sync TTL is five minutes by default and overridable, and a junk override is ignored', () => {
  assert.equal(DEFAULT_SYNC_REQUEST_TTL_MS, 300_000)
  assert.equal(syncRequestTtlMs({}), DEFAULT_SYNC_REQUEST_TTL_MS)
  assert.equal(syncRequestTtlMs({ DESK_SYNC_REQUEST_TTL_MS: '   ' }), DEFAULT_SYNC_REQUEST_TTL_MS)
  assert.equal(syncRequestTtlMs({ DESK_SYNC_REQUEST_TTL_MS: '0' }), DEFAULT_SYNC_REQUEST_TTL_MS)
  assert.equal(syncRequestTtlMs({ DESK_SYNC_REQUEST_TTL_MS: '-1' }), DEFAULT_SYNC_REQUEST_TTL_MS)
  assert.equal(syncRequestTtlMs({ DESK_SYNC_REQUEST_TTL_MS: '5m' }), DEFAULT_SYNC_REQUEST_TTL_MS)
  assert.equal(syncRequestTtlMs({ DESK_SYNC_REQUEST_TTL_MS: '60000' }), 60_000)
})

// ------------------------------------ the sweep consumes both, clear FIRST

test('a sync-request for a HOSTED instance goes through the CACHED ledger on the sweep', async () => {
  const { ledger, state } = await ledgerWith([{ inst: SENSEX, side: 'SELL', lots: 3 }])
  await state.set(SYNC_REQUEST_KEY, {
    corrections: [{ tradingsymbol: SENSEX.tradingsymbol, lots: -1, instrument: SENSEX }],
    requestedAt: NOW_MS,
  })
  const instance = 'MIRROR_A006:paper'
  const stores = new Map([[instance, state]])

  await sweepClearRequests(sweepDeps(stores, new Map([[instance, ledger]]), []))

  // THE CACHED OBJECT saw the correction — a second writer's edit would be
  // silently undone by its next #save().
  assert.equal(ledger.netLots(SENSEX.tradingsymbol), -1)
  assert.equal(await state.get(SYNC_REQUEST_KEY), null)
})

test('a sync-request for a RETIRED tag edits its document directly, like a clear', async () => {
  const state = await retiredInstance([{ inst: NIFTY, side: 'BUY', lots: 4 }])
  await state.set(SYNC_REQUEST_KEY, {
    corrections: [{ tradingsymbol: NIFTY.tradingsymbol, lots: 2, instrument: NIFTY }],
    requestedAt: NOW_MS,
  })
  const stores = new Map([['MIRROR_RETIRED:paper', state]])
  const logs: CapturedLog[] = []

  await sweepClearRequests(sweepDeps(stores, new Map(), logs))

  const stored = await state.get<{ tradingsymbol: string; lots: number }[]>('runner:positions')
  assert.deepEqual(stored?.map((e) => [e.tradingsymbol, e.lots]), [[NIFTY.tradingsymbol, 2]])
  assert.equal(await state.get(SYNC_REQUEST_KEY), null)
  assert.ok(logs.some((l) => l.msg.includes('does NOT host')))
})

test('when a clear and a sync are parked in the SAME tick, the operator clear is consumed first', async () => {
  const { ledger, state } = await ledgerWith([
    { inst: SENSEX, side: 'SELL', lots: 3 }, // the phantom leg the operator is clearing
    { inst: NIFTY, side: 'BUY', lots: 1 }, // a real divergence the detector found
  ])
  await state.set(CLEAR_REQUEST_KEY, {
    symbols: [SENSEX.tradingsymbol],
    requestedBy: 'aaditya',
    requestedAt: NOW_MS,
  })
  // The detector saw the same phantom (broker holds 0 of it) plus a NIFTY size gap.
  await state.set(SYNC_REQUEST_KEY, {
    corrections: [
      { tradingsymbol: SENSEX.tradingsymbol, lots: 0, instrument: SENSEX },
      { tradingsymbol: NIFTY.tradingsymbol, lots: 2, instrument: NIFTY },
    ],
    requestedAt: NOW_MS,
  })
  const instance = 'MIRROR_A006:paper'
  const stores = new Map([[instance, state]])
  const logs: CapturedLog[] = []

  await sweepClearRequests(sweepDeps(stores, new Map([[instance, ledger]]), logs))

  // Both requests consumed, one pass.
  assert.equal(await state.get(CLEAR_REQUEST_KEY), null)
  assert.equal(await state.get(SYNC_REQUEST_KEY), null)
  assert.equal(ledger.netLots(SENSEX.tradingsymbol), 0)
  assert.equal(ledger.netLots(NIFTY.tradingsymbol), 2)
  // The SENSEX drop is on the record as the OPERATOR's action — the clear ran
  // first, so the sync found that leg already gone and applied nothing to it.
  assert.ok(
    logs.some((l) => l.msg.includes('by operator request') && String(l.ctx?.['legs']).includes(SENSEX.tradingsymbol)),
    `the operator's clear is the journalled action, got ${JSON.stringify(logs)}`,
  )
  const synced = logs.filter((l) => l.msg.includes('mirror sync applied'))
  assert.equal(synced.length, 1, 'only the NIFTY gap was an auto-correction')
  assert.ok(synced[0]?.msg.includes(NIFTY.tradingsymbol))
})
