/**
 * A RESTART MUST NOT BRING BACK A STRATEGY ROW THAT WAS REMOVED ON PURPOSE.
 *
 * Until 2026-10-30 the bridge's boot registered — external, SWITCHED ON —
 * every tag in the last 50 decisions of each symbol's books that had no
 * `desk-strategies` row. It was the per-tag gate's migration. By then the only
 * tags it ever found were rows removed deliberately: the roll's erase of
 * yesterday's books, and `--prune-orphans`. Each restart put them back on,
 * with no book behind them; the 30 Oct audit counted 24, every one of them
 * that seed's.
 *
 * Two halves:
 *
 *   - THE SOURCE SCAN is the regression guard. `main.ts` itself writes no
 *     strategy row, so the boot's one writer is `seedHostedStrategies`, whose
 *     table names hosted tags only. Put a journal seed back in `main()` and
 *     this fails; nothing else here could, because `main()` cannot be booted
 *     in a test (bus, ports, broker keys).
 *   - THE MONGO HALF drives the exact state that seed fed on — a book erased
 *     through the route and an orphan pruned through the roll's own
 *     `applyOrphans`, both with decisions still in the journal, and a sibling
 *     book on the same symbol in `desk-books` — through the boot's store
 *     writes, twice, and asks the roll's own orphan rule (`planOrphans`) what
 *     is left. Not restated here: the rule is the script's, and a copy would
 *     drift from it.
 *
 * Routes run against a nudge sink (`./nudge-sink.ts`): the registry routes
 * nudge the supervisor, and on the desk box the default port is the live one.
 *
 * OWN DATABASE NAME: `algomaker_dx_boot_registry_test`, distinct from every other
 * Mongo suite here, because `node:test` runs files in parallel processes and
 * each one wipes its collections between tests.
 */

import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { skipUnlessMongo } from './require-mongo.ts'
import { startNudgeSink, type NudgeSink } from './nudge-sink.ts'
import { connectMongo, type MongoHandle } from '../src/mongo.ts'
import { createBridgeServer } from '../src/server.ts'
import { bearerGate } from '../src/authgate.ts'
import { DeskStore, COLLECTIONS } from '../src/store.ts'
import { booksRoutes } from '../src/routes/books.ts'
import { deskRoutes } from '../src/routes/desk.ts'
import type { ApiDeps } from '../src/routes/kit.ts'
import { isOn } from '../src/strategies.ts'
import { HOSTED_STRATEGIES, seedHostedStrategies } from '../src/registry-seed.ts'
import { backfillSeriesFromAudit } from '../src/migrate.ts'

type Request = (
  method: string,
  path: string,
  body?: unknown,
) => Promise<{ status: number; body: unknown; text: string }>

interface OrphanPlan {
  readonly prune: readonly { readonly tag: string; readonly modes: readonly string[] }[]
  readonly skipped: readonly string[]
}

const roll = (await import(new URL('../../../scripts/delta-lean-roll.mjs', import.meta.url).href)) as {
  planOrphans(input: {
    strategies: readonly { tag: string; kind: string; modes: { paper?: unknown; live?: unknown } }[]
    registered: ReadonlySet<string>
  }): OrphanPlan
  applyOrphans(
    plan: OrphanPlan,
    io: { request: Request },
  ): Promise<{ removedModes: number; deletedRows: number; refused: readonly string[] }>
}
const books = (await import(new URL('../../../scripts/delta-lean-books.mjs', import.meta.url).href)) as {
  requestJson(base: string, method: string, path: string, body: unknown, token: string): ReturnType<Request>
}

// ------------------------------------------------------------ the source

const MAIN = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8')

test('main.ts writes no strategy row of its own: the hosted seed is the boot\'s one writer', () => {
  // Every store method that creates or rewrites a `desk-strategies` row. A
  // read (`loadStrategy`, `listStrategies`) is not a re-creation and is not
  // listed.
  const writes = [...MAIN.matchAll(/\.(registerStrategy|addStrategyMode|patchStrategy|removeStrategyMode)\s*\(/g)]
  assert.deepEqual(
    writes.map((m) => m[1]),
    [],
    'the bridge boot makes strategy rows only through seedHostedStrategies',
  )
  assert.doesNotMatch(MAIN, /kind:\s*['"]external['"]/, 'an external row is a registration\'s, never the boot\'s')
  assert.equal([...MAIN.matchAll(/\bseedHostedStrategies\(/g)].length, 1, 'the hosted seed still runs, once')
})

test('the hosted seed\'s table names hosted tags only, never a dated book', () => {
  // The other half of "the boot's one writer": whatever it writes is hosted,
  // which no erase and no prune ever removes.
  for (const s of HOSTED_STRATEGIES) {
    assert.doesNotMatch(s.tag, /\d{4}-\d{2}-\d{2}/, `${s.tag} reads like a dated book tag`)
  }
})

// ------------------------------------------------------------ over Mongo

const URL_MONGO = process.env['DESK_TEST_MONGO'] ?? 'mongodb://127.0.0.1:27017/algomaker_dx_boot_registry_test'
const TOKEN = 'machine-token-do-not-use-in-prod'
/** Thu 2026-10-29 08:50 IST — the roll's slot, the morning after the 28th's books. */
const NOW = Date.UTC(2026, 9, 29, 3, 20)
const DAY_MS = 86_400_000

const REG = '/v1/desk/books/registry'
/** Yesterday's book: the roll's erase takes it, and its switch row with it. */
const ERASED = 'NIFTY-delta-lean-aggressive-2026-10-28'
/** Today's book on the same symbol. Its `desk-books` document is what led the old seed to NIFTY's journal. */
const TODAY = 'NIFTY-delta-lean-aggressive-2026-10-29'
/** An orphan from before erases took the row, switched ON, cleared by `--prune-orphans --apply`. */
const PRUNED = 'NIFTY-delta-lean-conservative-2026-10-22'

let handle: MongoHandle | null = null
let store: DeskStore
let server: Server | null = null
let base = ''
let available = false
let sink: NudgeSink | null = null

function itMongo(name: string, fn: () => Promise<void>): void {
  test(name, async (t) => {
    if (!available) {
      skipUnlessMongo(t)
      return
    }
    await fn()
  })
}

/** The same `request` the roll builds in its `main`, pointed at the test server. */
const request: Request = (method, path, body) => books.requestJson(base, method, path, body, TOKEN)

before(async () => {
  try {
    handle = await connectMongo(URL_MONGO, { serverSelectionTimeoutMS: 2500 })
  } catch {
    available = false
    return
  }
  store = new DeskStore(handle.db)
  await store.ensureIndexes()
  const apiDeps = {
    db: handle.db,
    store,
    // The one service method the prune's mode removal reaches for — the roll
    // suite's cast; nothing else on `service` is touched by these routes.
    service: {
      removeStrategyMode: (tag: string, mode: 'paper' | 'live') => store.removeStrategyMode(tag, mode, NOW),
    } as unknown as ApiDeps['service'],
    log: () => {},
    now: () => NOW,
    gate: bearerGate(TOKEN),
  } as unknown as Parameters<typeof booksRoutes>[0] & Parameters<typeof deskRoutes>[0]
  server = createBridgeServer({
    gate: bearerGate(TOKEN),
    routes: [booksRoutes(apiDeps), deskRoutes(apiDeps)],
  })
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`
  sink = await startNudgeSink()
  available = true
})

after(async () => {
  if (server !== null) await new Promise<void>((r) => server!.close(() => r()))
  if (sink !== null) await sink.close()
  if (handle !== null) await handle.close()
})

beforeEach(async () => {
  if (!available) return
  for (const c of [...Object.values(COLLECTIONS), 'desk-audit-log']) await handle!.db.collection(c).deleteMany({})
  await store.ensureIndexes()
  if (sink !== null) sink.nudges.length = 0
})

/**
 * What `main()` writes to the store before it serves, in its order: the
 * indexes, the series backfill, the hosted seed. The source scan above pins
 * that nothing else in `main.ts` writes a strategy row.
 */
async function bootWrites(): Promise<void> {
  await store.ensureIndexes()
  await backfillSeriesFromAudit(handle!.db)
  await seedHostedStrategies(store, NOW, () => {})
}

/** The roll's own orphan read: every external row with no registry row on either rail. */
async function orphans(): Promise<OrphanPlan> {
  const registered = new Set([
    ...(await store.listBooks('paper')).map((r) => r.tag),
    ...(await store.listBooks('live')).map((r) => r.tag),
  ])
  return roll.planOrphans({ strategies: await store.listStrategies(), registered })
}

async function journal(tag: string, n: number): Promise<void> {
  for (let i = 1; i <= n; i++) {
    await store.recordDecision({
      decisionId: `${tag}:paper:${i}`,
      symbol: 'NIFTY',
      expiry: '2026-11-03',
      mode: 'paper',
      tag,
      fills: [],
      skips: [],
      createdAt: NOW - DAY_MS + i * 60_000,
    })
  }
}

const bookBody = (tag: string, variant: string): Record<string, unknown> => ({
  tag,
  symbol: 'NIFTY',
  expiry: '2026-11-03',
  mode: 'paper',
  variant,
  dials: {},
})

itMongo('a book the roll erased and an orphan --prune-orphans removed stay removed across two restarts', async () => {
  // Yesterday's book and today's, both registered through the route — which
  // is what makes each one's switch row, born ON.
  for (const tag of [ERASED, TODAY]) {
    const created = await request('POST', REG, bookBody(tag, 'delta-lean-aggressive'))
    assert.equal(created.status, 201, `${tag}: ${created.text}`)
  }
  assert.equal(isOn((await store.loadStrategy(ERASED))!.modes, 'paper'), true)
  // Today's book holds a `desk-books` document on NIFTY.
  await store.saveBook({ tag: TODAY, mode: 'paper', symbol: 'NIFTY', expiry: '2026-11-03' }, [], NOW)

  // An orphan from before erases took the row: no book, switched ON.
  await store.addStrategyMode({ tag: PRUNED, kind: 'external', label: PRUNED }, 'paper', NOW)
  await store.patchStrategy(PRUNED, { modes: { paper: { enabled: true } } }, NOW)

  // Both traded on NIFTY, and the journal keeps that: an erase is not a purge.
  await journal(ERASED, 3)
  await journal(PRUNED, 2)

  // The roll's erase: stop is moot (registered stopped), DELETE ?mode=paper.
  const erased = await request('DELETE', `${REG}/${ERASED}?mode=paper`)
  assert.equal(erased.status, 200, erased.text)
  assert.equal(await store.loadStrategy(ERASED), null, 'the erase takes the switch row')

  // `--prune-orphans --apply`, through the script's own functions.
  const plan = await orphans()
  assert.deepEqual(plan.prune.map((p) => p.tag), [PRUNED])
  const done = await roll.applyOrphans(plan, { request })
  assert.deepEqual([...done.refused], [])
  assert.equal(done.deletedRows, 1)
  assert.equal(await store.loadStrategy(PRUNED), null)

  // THE STATE THE OLD SEED RE-CREATED BOTH FROM: a NIFTY book in `desk-books`,
  // and both tags in NIFTY's last 50 decisions with no strategy row.
  assert.ok((await store.allBooks('paper')).some((b) => b.symbol === 'NIFTY'))
  const recent = new Set((await store.listDecisions('NIFTY', 50)).map((d) => d.tag))
  assert.ok(recent.has(ERASED) && recent.has(PRUNED), 'both tags are still in the journal')

  for (const restart of [1, 2]) {
    await bootWrites()
    assert.equal(await store.loadStrategy(ERASED), null, `restart ${restart}: the erased book's row came back`)
    assert.equal(await store.loadStrategy(PRUNED), null, `restart ${restart}: the pruned orphan came back`)
    assert.deepEqual(await orphans(), { prune: [], skipped: [] }, `restart ${restart}: the boot left an orphan`)
  }

  // Nothing else moved. Today's book keeps its row, still ON; it is the only
  // external row. The hosted seed did run — so the boot above wrote — and
  // every row it made is hosted and OFF.
  const rows = await store.listStrategies()
  assert.deepEqual(rows.filter((r) => r.kind === 'external').map((r) => r.tag), [TODAY])
  assert.equal(isOn(rows.find((r) => r.tag === TODAY)!.modes, 'paper'), true)
  const hosted = rows.filter((r) => r.kind === 'hosted')
  assert.deepEqual(hosted.map((r) => r.tag).sort(), HOSTED_STRATEGIES.map((s) => s.tag).sort())
  for (const r of hosted) {
    assert.equal(isOn(r.modes, 'paper') || isOn(r.modes, 'live'), false, `${r.tag} was seeded ON`)
  }
})
