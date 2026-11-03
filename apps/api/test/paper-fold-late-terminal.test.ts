/**
 * A PAPER ORDER THAT GOES TERMINAL LATE IS STILL FOLDED — the 2026-10-01 case.
 *
 * `SENSEX-delta-lean-aggressive-2026-10-01:paper:5#4`, the 14:50 passive close
 * of the long 71800PE hedge, rested in the simulator after its one cross. On
 * 4 Oct the gateway restarted, its paper sweep marked the order REJECTED with
 * nothing traded (`resolvedAt` 4 Oct), and the GATEWAY'S record was right:
 * `state: REJECTED, filledQty: 0, avgPrice: null`. desk-api never heard: its
 * fold pass only looks at documents CREATED in the last two hours, this one was
 * created three days earlier, so the decision stayed `WORKING` in
 * `desk-decisions`, the supervisor kept holding it `inFlight`, and the book was
 * wedged behind an order the gateway had already closed.
 *
 * The window is meant to keep a first deploy from re-folding history; an order
 * that went terminal a minute ago is not history, whenever it was created.
 *
 * Skips itself when no Mongo is reachable; `DESK_REQUIRE_MONGO=1` turns that
 * skip into a failure (see `require-mongo.ts`).
 */
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { OptionMaster } from '@algomaker/instruments'
import { skipUnlessMongo } from './require-mongo.ts'
import { startNudgeSink, type NudgeSink } from './nudge-sink.ts'
import { connectMongo, type MongoHandle } from '../src/mongo.ts'
import { DeskStore, COLLECTIONS } from '../src/store.ts'
import { createPaperFillFolder, listFoldable } from '../src/paper-fold.ts'

const URL_MONGO =
  process.env['DESK_TEST_MONGO'] ?? 'mongodb://127.0.0.1:27017/algomaker_dx_paper_fold_late_test'
const TAG = 'SENSEX-delta-lean-aggressive-2026-10-01'
const DECISION = `${TAG}:paper:5`
const HEDGE = 'SENSEX26O0171800PE'
/** 2026-10-01 14:50:00 IST, when the flatten formed. */
const FORMED = Date.UTC(2026, 9, 1, 9, 20)
/** 2026-10-04 22:18:34 IST, when the gateway's paper sweep condemned it. */
const RESOLVED = Date.UTC(2026, 9, 4, 16, 48, 34)
const NOW = RESOLVED + 60_000

let handle: MongoHandle | null = null
let store: DeskStore
let sink: NudgeSink | null = null
let available = false

before(async () => {
  try {
    handle = await connectMongo(URL_MONGO, { serverSelectionTimeoutMS: 2500 })
  } catch {
    available = false
    return
  }
  store = new DeskStore(handle.db)
  await store.ensureIndexes()
  sink = await startNudgeSink()
  available = true
})

after(async () => {
  if (sink !== null) await sink.close()
  if (handle !== null) await handle.close()
})

beforeEach(async () => {
  if (!available) return
  for (const c of [COLLECTIONS.decisions, COLLECTIONS.gatewayOrders, COLLECTIONS.books]) {
    await handle!.db.collection(c).deleteMany({})
  }
})

function itMongo(name: string, fn: () => Promise<void>): void {
  test(name, async (t) => {
    if (!available) {
      skipUnlessMongo(t)
      return
    }
    await fn()
  })
}

/** Decision 5 as `desk-decisions` held it: six closes folded, #4 still owed. */
async function seed(): Promise<void> {
  const symbolOf = (i: number): string => (i === 4 ? HEDGE : `SENSEX26O01LEG${String(i)}`)
  const ids = Array.from({ length: 7 }, (_, i) => `${DECISION}#${String(i)}`)
  await handle!.db.collection(COLLECTIONS.decisions).insertOne({
    decisionId: DECISION,
    symbol: 'SENSEX',
    expiry: '2026-10-01',
    mode: 'paper',
    tag: TAG,
    via: 'engine',
    status: 'WORKING',
    fills: [],
    plannedFills: ids.map((_, i) => ({
      op: 'close',
      deskTag: symbolOf(i),
      tradingsymbol: symbolOf(i),
      side: i === 4 ? 'Sell' : 'Buy',
      qty: 80,
      price: 149.15,
      ts: FORMED,
    })),
    skips: [],
    routeErrors: [],
    createdAt: FORMED,
    workingOrderIds: ids,
    foldedOrders: ids.filter((id) => !id.endsWith('#4')),
  })
  await handle!.db.collection(COLLECTIONS.gatewayOrders).insertOne({
    clientOrderId: `${DECISION}#4`,
    mode: 'paper',
    tag: TAG,
    tradingsymbol: HEDGE,
    transaction_type: 'SELL',
    quantity: 80,
    desk_op: 'close',
    createdAt: FORMED,
    placedAt: FORMED + 6_000,
    // The gateway's paper sweep, after the restart: terminal, nothing traded.
    state: 'REJECTED',
    filledQty: 0,
    avgPrice: null,
    resolvedAt: RESOLVED,
  })
}

function folder(): { run(): Promise<{ scanned: number }> } {
  return createPaperFillFolder({
    store,
    master: () => new OptionMaster([]),
    now: () => NOW,
    log: () => {},
  })
}

itMongo('an order that went terminal a minute ago is folded, however long ago it was created', async () => {
  await seed()
  const pass = await folder().run()
  assert.equal(pass.scanned, 1, 'the REJECTED order is in the pass')

  const decision = await handle!.db.collection(COLLECTIONS.decisions).findOne({ decisionId: DECISION })
  assert.equal(decision?.['status'], 'DONE', 'desk-api agrees with the gateway: the package is over')
  assert.deepEqual(decision?.['fills'], [], 'and nothing was traded on it')
  const doc = await handle!.db
    .collection(COLLECTIONS.gatewayOrders)
    .findOne({ clientOrderId: `${DECISION}#4` })
  assert.equal(doc?.['deskFolded'], true)
})

itMongo('the one-off catch-up (cli fold-paper): a wider window lists, then folds, what the 2 h pass missed', async () => {
  // The SENSEX 10-01 pair went terminal on 4 Oct 22:18 IST; by the time anything
  // restarts that is far outside two hours. `listFoldable` is the dry run the
  // CLI prints, and the same window handed to the folder is its --apply.
  await seed()
  const DAY_LATER = RESOLVED + 24 * 3_600_000
  const narrow = await listFoldable(store, DAY_LATER, 2 * 3_600_000)
  assert.deepEqual(narrow, [], 'the ordinary pass would never see it again')

  const wide = await listFoldable(store, DAY_LATER, 48 * 3_600_000)
  assert.deepEqual(
    wide.map((d) => [d['clientOrderId'], d['state']]),
    [[`${DECISION}#4`, 'REJECTED']],
  )
  // Listing writes nothing.
  const still = await handle!.db.collection(COLLECTIONS.decisions).findOne({ decisionId: DECISION })
  assert.equal(still?.['status'], 'WORKING')

  const pass = await createPaperFillFolder(
    { store, master: () => new OptionMaster([]), now: () => DAY_LATER, log: () => {} },
    { lookbackMs: 48 * 3_600_000 },
  ).run()
  assert.equal(pass.scanned, 1)
  const decision = await handle!.db.collection(COLLECTIONS.decisions).findOne({ decisionId: DECISION })
  assert.equal(decision?.['status'], 'DONE')
  assert.deepEqual(await listFoldable(store, DAY_LATER, 48 * 3_600_000), [], 'and it is folded once')
})

itMongo('history stays history: an order created AND resolved long ago is still not re-folded', async () => {
  await seed()
  await handle!.db
    .collection(COLLECTIONS.gatewayOrders)
    .updateOne({ clientOrderId: `${DECISION}#4` }, { $set: { resolvedAt: FORMED + 30_000 } })
  assert.equal((await folder().run()).scanned, 0)
  const decision = await handle!.db.collection(COLLECTIONS.decisions).findOne({ decisionId: DECISION })
  assert.equal(decision?.['status'], 'WORKING')
})
