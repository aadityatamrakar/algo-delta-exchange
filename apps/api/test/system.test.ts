/**
 * `GET /v1/desk/system` — is every process that this desk depends on actually
 * alive?
 *
 * The property under test throughout is the one the route exists for: LIVENESS
 * IS MEASURED FROM THE ARTIFACT, NEVER FROM A PROCESS TABLE. Each assertion
 * below drives a component's state purely by moving the clock against the last
 * write its owner is responsible for, because that is the only evidence the
 * bridge has — and it is strictly better evidence than pm2's `online`, which a
 * wedged or crash-looping process also reads.
 *
 * The second property is honesty. There are four states, and `unknown` is a
 * first-class one: a collection that has never been written, a rail with no
 * books on it and a gateway in simulate mode are all conditions where the
 * bridge genuinely cannot see whether the process is alive, and every one of
 * them must say so rather than pick a colour.
 *
 * The fourth state, `attention`, is the one exception to "liveness is the only
 * thing measured here", and it is deliberately narrow: `positions-truth` is the
 * single component whose artifact this route understands the MEANING of, and a
 * current comparison reporting a divergence is the one case where the age is
 * healthy and the content is not. See the positions-truth tests below for what
 * it must and must not fire on.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { systemRoutes, type SystemComponent } from '../src/routes/system.ts'
import type { ApiDeps, RouteCtx } from '../src/routes/kit.ts'
import type { DeskStore } from '../src/store.ts'
import type { BookRow, VariantRow } from '../src/books-registry.ts'

// ------------------------------------------------------------------ harness

const NOW = 1_760_000_000_000

/** Every document a fake database holds, keyed by collection name. */
interface Fixtures {
  readonly [collection: string]: Record<string, unknown>[]
}

/**
 * The narrow `Database` port, in memory.
 *
 * Only the four operations this route uses are modelled — `findOne`, `find`,
 * `countDocuments` and the cursor's `sort`/`limit`/`toArray`. A collection that
 * is ABSENT from the fixtures answers empty rather than throwing, because that
 * is exactly what Mongo does for a collection nothing has ever written, and it
 * is the case the `unknown` state exists for.
 */
function fakeDb(fixtures: Fixtures, failOn: string | null = null): ApiDeps['db'] {
  const matches = (doc: Record<string, unknown>, filter: Record<string, unknown>): boolean =>
    Object.entries(filter).every(([k, v]) => doc[k] === v)
  const db = {
    collection(name: string): unknown {
      const docs = fixtures[name] ?? []
      const guard = (): void => {
        if (failOn === name) throw new Error(`${name} is unreachable`)
      }
      const cursor = (rows: Record<string, unknown>[]): unknown => ({
        sort: () => cursor(rows),
        limit: (n: number) => cursor(rows.slice(0, n)),
        skip: () => cursor(rows),
        toArray: async () => {
          guard()
          return rows
        },
      })
      return {
        findOne: async (filter: Record<string, unknown>) => {
          guard()
          return docs.find((d) => matches(d, filter)) ?? null
        },
        find: (filter: Record<string, unknown>) => cursor(docs.filter((d) => matches(d, filter))),
        countDocuments: async (filter: Record<string, unknown>) => {
          guard()
          return docs.filter((d) => matches(d, filter)).length
        },
      }
    },
  }
  return db as ApiDeps['db']
}

const book = (over: Partial<BookRow>): BookRow => ({
  tag: 'BHEL-R',
  symbol: 'BHEL',
  expiry: '2026-08-25',
  mode: 'paper',
  variant: 'hold-recycle-r',
  series: 'BHEL-hold-recycle-r',
  dials: {},
  desired: 'running',
  actual: 'running',
  dx_paper_rail: 'sim',
  lastMarkAt: NOW - 5_000,
  lastDecision: 'hold',
  createdAt: NOW - 86_400_000,
  updatedAt: NOW - 5_000,
  ...over,
})

interface Harness {
  deps: ApiDeps
  route: ReturnType<typeof systemRoutes>
  setNow: (ms: number) => void
}

function harness(opts: {
  fixtures?: Fixtures
  books?: Partial<Record<'paper' | 'live', BookRow[]>>
  variants?: VariantRow[]
  feedHealth?: ApiDeps['feedHealth']
  busConnected?: (() => boolean) | undefined
  failOn?: string | null
} = {}): Harness {
  let now = NOW
  const store = {
    listBooks: async (mode: 'paper' | 'live') => opts.books?.[mode] ?? [],
    listVariants: async () => opts.variants ?? [],
  } as unknown as DeskStore
  const deps: ApiDeps = {
    db: fakeDb(opts.fixtures ?? {}, opts.failOn ?? null),
    store,
    service: null as unknown as ApiDeps['service'],
    master: null as unknown as ApiDeps['master'],
    ...(opts.feedHealth === undefined ? {} : { feedHealth: opts.feedHealth }),
    ...(opts.busConnected === undefined ? {} : { busConnected: opts.busConnected }),
    log: () => {},
    now: () => now,
  }
  return {
    deps,
    route: systemRoutes(deps, { uptimeMs: () => 3_725_000 }),
    setNow: (ms) => {
      now = ms
    },
  }
}

async function report(h: Harness): Promise<{ generatedAt: number; components: SystemComponent[] }> {
  const url = new URL('http://desk/v1/desk/system')
  let body: unknown = null
  let status = 0
  const ctx: RouteCtx = {
    req: null as unknown as IncomingMessage,
    res: null as unknown as ServerResponse,
    url,
    path: url.pathname,
    method: 'GET',
    principal: { kind: 'user', name: 'operator' },
    log: () => {},
    readJson: async () => ({}),
    send: (s, b) => {
      status = s
      body = b
    },
  }
  assert.equal(await h.route(ctx), true, '/v1/desk/system was not handled')
  assert.equal(status, 200)
  return body as { generatedAt: number; components: SystemComponent[] }
}

const find = (r: { components: SystemComponent[] }, id: string): SystemComponent => {
  const c = r.components.find((x) => x.id === id)
  assert.ok(c !== undefined, `no component '${id}' in the report`)
  return c
}

// ------------------------------------------------------------ the fresh desk

/** Everything written moments ago, by every process, on both rails. */
function healthyFixtures(): Fixtures {
  return {
    'desk-broker-snapshot': [{ _id: 'xts', asOf: NOW - 4_000, ok: true, error: '' }],
    'desk-broker-session': [{ _id: 'xts', token: 'tok', userID: 'U1', updatedAt: NOW - 60_000 }],
    'desk-gateway-orders': [{ state: 'FILLED' }],
    'desk-strategy-runtime': [
      { tag: 'ORB_SCALP_BN', mode: 'paper', state: 'running', openPositions: 2, updatedAt: NOW - 800 },
      { tag: 'BN_BREAKOUT', mode: 'paper', state: 'waiting', openPositions: 0, updatedAt: NOW - 900 },
    ],
    'desk-safety': [],
    // The positions comparison's own report (roadmap 16). A healthy desk has
    // run one within its cadence and found the three records in agreement.
    //
    // THE CONTRACTS ARE NAMED IN THE DESK'S SPELLING, which is the only
    // spelling that ever reaches this document: the comparison joins the broker
    // to the desk by exchange token and keys every row by the tradingsymbol the
    // desk already speaks (`positions-compare.ts`). A fixture carrying XTS's
    // `BHEL 25AUG2026 CE 415` here would be describing a report this code can no
    // longer produce.
    'desk-positions-compare': [comparison()],
  }
}

/**
 * One stored positions-comparison report. Agreeing, current and comparable
 * unless a test says otherwise.
 */
function comparison(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    _id: 'live',
    asOf: NOW - 30_000,
    day: '2026-10-09',
    mode: 'live',
    comparable: true,
    reason: '',
    brokerAsOf: NOW - 34_000,
    symbols: [
      { symbol: 'BHEL26AUG375PE', broker: -5250, books: -5250, ledger: 0, agree: true, claimedBy: ['BHEL-R'] },
      { symbol: 'BHEL26AUG415CE', broker: -5250, books: -5250, ledger: 0, agree: true, claimedBy: ['BHEL-R'] },
    ],
    divergent: [],
    unattributable: [],
    unmeasurable: [],
    intervalMs: 300_000,
    ...over,
  }
}

function healthy(): Harness {
  return harness({
    fixtures: healthyFixtures(),
    books: {
      paper: [book({}), book({ tag: 'TCS-R', lastMarkAt: NOW - 12_000, updatedAt: NOW - 12_000 })],
      live: [book({ mode: 'live', tag: 'DLF-R', lastMarkAt: NOW - 9_000, updatedAt: NOW - 9_000 })],
    },
    variants: [{ key: 'hold-recycle-r', decider: 'rule-engine', playbook: 'p', defaults: {} }],
    feedHealth: {
      payload: {
        sockets: [{ socket: 0, connected: true, tokens: 900, downForMs: null }],
        tokens: 900,
        instrumentSyncDay: '2026-10-09',
        instrumentsStale: false,
      },
      receivedAt: NOW - 3_000,
    },
    busConnected: () => true,
  })
}

test('a desk where every process just wrote reports every component ok', async () => {
  const r = await report(healthy())
  assert.equal(r.generatedAt, NOW)
  const notOk = r.components.filter((c) => c.state !== 'ok')
  assert.deepEqual(
    notOk.map((c) => `${c.id}:${c.state} (${c.detail})`),
    [],
    'a fully healthy desk must show no amber and no grey',
  )
  // Every process this desk runs is accounted for. A report that silently
  // omits one is worse than no report: absence reads as "nothing to worry
  // about" on the page whose whole job is saying what is not running.
  assert.deepEqual(
    r.components.map((c) => c.id),
    [
      'dx-api',
      'dx-marketdata',
      'dx-gateway',
      'dx-runner',
      'dx-supervisor',
      'dx-supervisor-live',
      'positions-truth',
      'mongo',
    ],
  )
})

test('every component states the cadence it is judged against', async () => {
  const r = await report(healthy())
  /**
   * `expectedEveryMs` is what lets the page say "last seen 4s ago · expected
   * every 10s" instead of an age with nothing to read it against. Four seconds
   * is fine for marketdata and three missed polls for the gateway; without the
   * cadence the operator cannot tell those apart.
   */
  assert.equal(find(r, 'dx-marketdata').expectedEveryMs, 10_000)
  assert.equal(find(r, 'dx-gateway').expectedEveryMs, 30_000)
  assert.equal(find(r, 'dx-runner').expectedEveryMs, 1_000)
  // One 5-minute MARK, not the retired Python supervisor's 30s converge.
  assert.equal(find(r, 'dx-supervisor').expectedEveryMs, 300_000)
  assert.equal(find(r, 'dx-supervisor-live').expectedEveryMs, 300_000)

  // And the age is derived from the same clock the report is stamped with, so
  // `lastSeenMs + ageMs === generatedAt` for anything that has been seen.
  for (const c of r.components) {
    if (c.lastSeenMs === null) {
      assert.equal(c.ageMs, null, `${c.id} has an age with nothing to age from`)
      continue
    }
    assert.equal(c.lastSeenMs + (c.ageMs ?? 0), r.generatedAt, `${c.id}'s age does not match its clock`)
  }
})

// ------------------------------------------------------------------- staleness

test('staleness is measured from the ARTIFACT, not from a process table', async () => {
  /**
   * The whole premise. Nothing about the fixtures changes — every process's
   * last write stays exactly where it was — and only the clock moves. A process
   * table would still report all four `online`; the artifacts say otherwise.
   */
  const h = healthy()
  // Past the LARGEST `okWithin` on the table, which is the supervisor's two
  // 5-minute marks (600s). The number carries no meaning beyond that: it is
  // "long enough that every artifact is old", and it moves whenever the
  // slowest cadence does.
  h.setNow(NOW + 700_000)
  const r = await report(h)
  for (const id of ['dx-marketdata', 'dx-gateway', 'dx-runner', 'dx-supervisor', 'dx-supervisor-live']) {
    assert.equal(find(r, id).state, 'stale', `${id} should read stale 700s after its last write`)
  }
  // desk-api is answering this very request and Mongo just replied, so those
  // two are not stale — they are the two whose evidence is the request itself.
  assert.equal(find(r, 'dx-api').state, 'ok')
  assert.equal(find(r, 'mongo').state, 'ok')
})

test('the thresholds are several missed writes, not one', async () => {
  // A single slow poll must not paint the page amber, or the amber stops being
  // read. marketdata publishes every 10s and is given 30s; the gateway writes
  // every 30s and is given 90s.
  const h = healthy()
  h.setNow(NOW + 20_000)
  const near = await report(h)
  assert.equal(find(near, 'dx-marketdata').state, 'ok', '23s is two missed publishes, not a dead feed')
  assert.equal(find(near, 'dx-gateway').state, 'ok')

  h.setNow(NOW + 40_000)
  const past = await report(h)
  assert.equal(find(past, 'dx-marketdata').state, 'stale')
  assert.equal(find(past, 'dx-gateway').state, 'ok', 'the gateway writes every 30s — 44s is one missed poll')
})

// --------------------------------------------------------------- the unknowns

test('a collection nothing has ever written is UNKNOWN, and says why', async () => {
  const r = await report(harness())

  const md = find(r, 'dx-marketdata')
  assert.equal(md.state, 'unknown')
  assert.equal(md.lastSeenMs, null)
  assert.match(md.detail, /md\.health/, 'the detail must name the signal that is missing')

  const gw = find(r, 'dx-gateway')
  assert.equal(gw.state, 'unknown')
  // The honest reason, not a guess: in simulate mode the gateway writes NO
  // snapshot at all, so an absent one is the normal state of a working desk.
  assert.match(gw.detail, /simulate/i)

  const runner = find(r, 'dx-runner')
  assert.equal(runner.state, 'unknown')
  assert.match(runner.detail, /no hosted strategy|nothing published/i)
})

test('a rail with no books says so instead of reporting its supervisor dead', async () => {
  /**
   * There is no live book on most days. A supervisor with nothing to converge
   * writes nothing, and calling that `stale` would put a permanent amber on the
   * page for a rail that is behaving exactly as intended.
   */
  const r = await report(harness({ fixtures: healthyFixtures(), books: { paper: [book({})] } }))
  const live = find(r, 'dx-supervisor-live')
  assert.equal(live.state, 'unknown')
  assert.equal(live.lastSeenMs, null)
  assert.match(live.detail, /no books registered on this rail/)
  // …while the rail that HAS a book is measured normally.
  assert.equal(find(r, 'dx-supervisor').state, 'ok')
})

test('a supervisor between 5-minute marks is OK, not stale', async () => {
  /**
   * THE CADENCE MUST MATCH THE PROCESS THAT ACTUALLY WRITES THE FIELD.
   *
   * `lastSeenMs` for a supervisor is `newest(lastMarkAt)`, and the TS supervisor
   * journals that ONCE PER 5-MINUTE MARK — `engine-host.ts:#journal` returns
   * early unless `markCtx.isNewMark`, and `MARK_STEP_MIN` is 5
   * (`packages/desk-engine/src/session.ts`). So a perfectly healthy supervisor's
   * newest mark is routinely ~300s old, and anything under one full mark window
   * is not evidence of anything.
   *
   * The 30s/120s this shipped with was the PYTHON supervisor's `converge()`
   * cadence, and the comment at the constant said so. Python was retired at the
   * 2026-08-22 cutover, and the constant came through unchanged — so the Status
   * card read "stale" for most of every five minutes on a healthy desk
   * (observed on prod 2026-09-07: three running relief-r books, engine logging
   * `hold` several times a second, card saying "last seen 3m ago").
   */
  const r = await report(
    harness({
      fixtures: healthyFixtures(),
      books: { paper: [book({ lastMarkAt: NOW - 240_000, updatedAt: NOW - 240_000 })] },
    }),
  )
  const sup = find(r, 'dx-supervisor')
  assert.equal(sup.state, 'ok', 'four minutes is INSIDE one mark window — the supervisor is fine')
})

test('books that exist but have never reported are unknown, not running', async () => {
  // `lastMarkAt: 0` is the registry's "the supervisor has never said anything".
  // Reading that as a timestamp would date the supervisor's last mark to 1970
  // and paint it stale; reading it as absent is the truth.
  const r = await report(
    harness({
      fixtures: healthyFixtures(),
      books: { paper: [book({ lastMarkAt: 0, updatedAt: 0, actual: 'stopped' })] },
    }),
  )
  const sup = find(r, 'dx-supervisor')
  assert.equal(sup.state, 'unknown')
  assert.equal(sup.lastSeenMs, null)
})

test('a Mongo that will not answer is UNKNOWN, and does not take the report with it', async () => {
  /**
   * NEVER THROWS. This page is what an operator opens when something is wrong,
   * so one unreachable collection must degrade to one grey card — not a 500
   * that hides the seven components that were readable.
   */
  const r = await report(harness({ fixtures: healthyFixtures(), failOn: 'desk-safety' }))
  const mongo = find(r, 'mongo')
  assert.equal(mongo.state, 'unknown')
  assert.match(mongo.detail, /unreachable/)
  // The rest of the report survived.
  assert.equal(find(r, 'dx-api').state, 'ok')
  assert.equal(r.components.length, 8)
})

test('one unreadable collection greys only its own component', async () => {
  const r = await report(harness({ fixtures: healthyFixtures(), failOn: 'desk-strategy-runtime' }))
  assert.equal(find(r, 'dx-runner').state, 'unknown')
  assert.equal(find(r, 'dx-gateway').state, 'ok')
  assert.equal(find(r, 'mongo').state, 'ok')
})

// ------------------------------------------------------------------- details

test('marketdata reports sockets, tokens and whether the instruments are today\'s', async () => {
  const h = harness({
    fixtures: healthyFixtures(),
    feedHealth: {
      payload: {
        sockets: [
          { socket: 0, connected: true, tokens: 900, downForMs: null },
          { socket: 1, connected: false, tokens: 120, downForMs: 40_000 },
        ],
        tokens: 1020,
        instrumentSyncDay: '2026-10-08',
        instrumentsStale: true,
      },
      receivedAt: NOW - 2_000,
    },
  })
  const md = find(await report(h), 'dx-marketdata')
  assert.equal(md.state, 'ok', 'a disconnected socket is the FEED\'s problem, not evidence the process died')
  assert.match(md.detail, /1 of 2 sockets/)
  assert.match(md.detail, /1020 tokens/)
  // A stale instrument master resolves no newly listed contract and raises no
  // error anywhere — so it has to be stated, or it is invisible.
  assert.match(md.detail, /not synced today/i)
  assert.equal(md.extra?.['instrumentsStale'], true)
  assert.equal(md.extra?.['instrumentSyncDay'], '2026-10-08')
})

test('frozen ticks are stated on the card WHILE THE MARKET IS OPEN (F-14)', async () => {
  const feedHealth = (session: boolean): NonNullable<ApiDeps['feedHealth']> => ({
    payload: {
      sockets: [{ socket: 0, connected: true, tokens: 900, downForMs: null }],
      tokens: 900,
      instrumentSyncDay: '2026-10-09',
      instrumentsStale: false,
      staleTokens: 640,
      oldestAgeMs: 305_000,
      session,
    },
    receivedAt: NOW - 2_000,
  })

  const open = find(await report(harness({ fixtures: healthyFixtures(), feedHealth: feedHealth(true) })), 'dx-marketdata')
  assert.match(open.detail, /640 tokens NOT TICKING/)
  assert.match(open.detail, /305s/)
  assert.equal(open.extra?.['staleTokens'], 640)
  assert.equal(open.state, 'ok', 'a frozen feed is /v1/desk/feed\'s subject; this card is process liveness')

  // Out of hours every token is legitimately stale, and a permanent scary
  // number is how the one that matters at 11:00 gets ignored.
  const closed = find(await report(harness({ fixtures: healthyFixtures(), feedHealth: feedHealth(false) })), 'dx-marketdata')
  assert.doesNotMatch(closed.detail, /NOT TICKING/)
  assert.equal(closed.extra?.['staleTokens'], undefined)
})

test('the gateway reports its broker session and what is queued behind it', async () => {
  const fixtures = healthyFixtures()
  const gw = find(
    await report(
      harness({
        fixtures: {
          ...fixtures,
          'desk-gateway-orders': [{ state: 'PENDING' }, { state: 'PENDING' }, { state: 'FILLED' }],
        },
      }),
    ),
    'dx-gateway',
  )
  assert.equal(gw.state, 'ok')
  assert.equal(gw.extra?.['pendingOrders'], 2)
  assert.match(gw.detail, /2 orders pending/)
})

test('a failed broker snapshot is still PROOF THE GATEWAY IS ALIVE', async () => {
  /**
   * The distinction the whole module rests on. `ok: false` means the BROKER
   * could not be reached; the snapshot document was still written, on time, by
   * a gateway that is plainly running. Conflating the two would report the
   * gateway dead every time an XTS token expires overnight — and send someone
   * to restart a process that is fine.
   */
  const gw = find(
    await report(
      harness({
        fixtures: {
          ...healthyFixtures(),
          'desk-broker-snapshot': [
            { _id: 'xts', asOf: NOW - 4_000, ok: false, error: 'Token/Authorization not found' },
          ],
        },
      }),
    ),
    'dx-gateway',
  )
  assert.equal(gw.state, 'ok', 'the gateway wrote 4s ago — it is running')
  assert.match(gw.detail, /Token\/Authorization not found/)
  assert.equal(gw.extra?.['brokerReachable'], false)
})

test('the runner reports its instances by state and its open positions', async () => {
  const runner = find(
    await report(
      harness({
        fixtures: {
          ...healthyFixtures(),
          'desk-strategy-runtime': [
            { tag: 'A', mode: 'paper', state: 'running', openPositions: 2, updatedAt: NOW - 500 },
            { tag: 'B', mode: 'paper', state: 'waiting', openPositions: 0, updatedAt: NOW - 600 },
            { tag: 'C', mode: 'live', state: 'failed', openPositions: 1, updatedAt: NOW - 700 },
          ],
        },
      }),
    ),
    'dx-runner',
  )
  assert.equal(runner.state, 'ok')
  assert.match(runner.detail, /1 running/)
  assert.match(runner.detail, /1 waiting/)
  assert.match(runner.detail, /1 failed/)
  assert.match(runner.detail, /3 open positions/)
  assert.deepEqual(runner.extra?.['byState'], { running: 1, waiting: 1, failed: 1 })
})

// -------------------------------------------------------- the positions truth

const truth = async (over: Record<string, unknown>): Promise<SystemComponent> =>
  find(
    await report(
      harness({
        fixtures: { ...healthyFixtures(), 'desk-positions-compare': [comparison(over)] },
      }),
    ),
    'positions-truth',
  )

test('a comparison that ran on time and agreed is ok', async () => {
  const c = await truth({})
  assert.equal(c.state, 'ok')
  assert.match(c.detail, /2 desk contracts compared to the broker/)
  assert.doesNotMatch(c.detail, /DIVERGENT/)
})

/**
 * THE 2026-08-15 CARD, AND WHY `ok` WAS THE WRONG WORD FOR IT.
 *
 * The report was thirty seconds old and perfectly healthy — the pass ran, the
 * broker was readable, a verdict was given. Its verdict was that seventeen
 * contracts did not match, and the pill above it said `ok`, because age was the
 * only thing any state on this page had ever measured. `stale` would have been
 * a different lie (the job had not stopped; it was working), so the divergence
 * gets the word that is actually true of it.
 */
test('a comparison that ran on time and DIVERGED needs attention, not "ok"', async () => {
  const c = await truth({
    divergent: ['BHEL26AUG415CE'],
    symbols: [
      { symbol: 'BHEL26AUG415CE', broker: -5250, books: -7000, ledger: 0, agree: false, claimedBy: ['BHEL-R'] },
    ],
  })
  assert.equal(c.state, 'attention')
  assert.match(c.detail, /^1 DIVERGENT/)
  // The pill is a different fact from the age, and the age is still honest.
  assert.equal(c.ageMs, 30_000)
})

test('an AGED-OUT report is stale whatever its verdict said', async () => {
  /**
   * A divergence in a report nobody has refreshed for an hour is not a claim
   * about now — the pass that would have confirmed it has not run. `stale` is
   * the fact about this card, and it outranks the content for exactly that
   * reason.
   */
  const c = await truth({ asOf: NOW - 3_600_000, divergent: ['BHEL26AUG415CE'] })
  assert.equal(c.state, 'stale')
})

test('NO VERDICT is not a divergence — an unreadable broker view stays ok', async () => {
  // `comparable: false` names no divergent contracts at all, so there is no
  // evidence to raise an alarm on. The reason is in the detail line instead.
  const c = await truth({
    comparable: false,
    reason: 'the broker snapshot is INCOMPLETE (positions: Token not found)',
    divergent: [],
  })
  assert.equal(c.state, 'ok')
  assert.match(c.detail, /NOT compared: .*Token not found/)
})

test('unattributable broker rows alone are NOT an alarm', async () => {
  /**
   * A manual trade or another system on the same account is a fact to report,
   * not a fault — rule 2 of `positions-compare.ts`. Raising `attention` for one
   * would put a permanent amber on a desk behaving exactly as intended, which is
   * how amber stops being read.
   */
  const c = await truth({ unattributable: [{ symbol: 'TCS26AUG3200CE', broker: -300 }] })
  assert.equal(c.state, 'ok')
  assert.match(c.detail, /cannot attribute/)
})

test('desk-api answers for itself, with its uptime and the bus', async () => {
  const api = find(await report(healthy()), 'dx-api')
  assert.equal(api.state, 'ok')
  assert.equal(api.ageMs, 0, 'it is answering this request')
  assert.match(api.detail, /1h 2m/, 'uptime, read from the process')
  assert.match(api.detail, /bus connected/)

  const noBus = find(
    await report(harness({ fixtures: healthyFixtures(), busConnected: () => false })),
    'dx-api',
  )
  assert.match(noBus.detail, /bus DISCONNECTED/)
  // Still `ok`: the bridge is up and serving. A dropped bus is marketdata's
  // card going grey, not this one lying about whether the API is running.
  assert.equal(noBus.state, 'ok')
})

test('the variant catalogue is reported with the honest gap in its record', async () => {
  /**
   * `desk-variants` rows are `{key, decider, playbook, defaults}` and carry NO
   * timestamp, so the catalogue's age is genuinely unknowable from this side
   * and the report says that rather than inventing a freshness it cannot
   * observe. Since the D9 cutover the count is also FROZEN — the wholesale
   * republish that wrote these rows went with the Python supervisor — which
   * makes the null age more honest still, not less.
   */
  const sup = find(await report(healthy()), 'dx-supervisor')
  assert.equal(sup.extra?.['variantCount'], 1)
  assert.equal(sup.extra?.['variantsUpdatedAt'], null)
})

test('an unknown path is left for the next route module', async () => {
  const h = healthy()
  const url = new URL('http://desk/v1/desk/feed')
  const ctx = {
    url,
    path: url.pathname,
    method: 'GET',
    principal: { kind: 'user', name: 'operator' },
    log: () => {},
    readJson: async () => ({}),
    send: () => assert.fail('the system route answered a path that is not its own'),
  } as unknown as RouteCtx
  assert.equal(await h.route(ctx), false)
})

test('paused live execution is named FIRST in the gateway detail', async () => {
  /**
   * The one reading on this page where "broker not reachable" is the intended
   * state. An operator who paused live execution must not be sent to restart a
   * gateway that is doing exactly what it was told.
   */
  const asked = find(
    await report(
      harness({
        fixtures: {
          ...healthyFixtures(),
          'desk-broker-snapshot': [
            { _id: 'xts', asOf: NOW - 4_000, ok: false, error: 'XTS session released by operator' },
          ],
          'desk-safety': [
            { _id: 'broker-link', desired: 'released', reason: 'key needed elsewhere', setBy: 'aaditya', setAt: NOW - 60_000 },
          ],
        },
      }),
    ),
    'dx-gateway',
  )
  assert.equal(asked.state, 'ok', 'the process is alive — the broker is off by choice')
  assert.match(asked.detail, /^Live execution PAUSED by aaditya/)
  assert.match(asked.detail, /key needed elsewhere/)
  assert.match(asked.detail, /refuses every live order/)

  const done = find(
    await report(
      harness({
        fixtures: {
          ...healthyFixtures(),
          'desk-safety': [
            { _id: 'broker-link', desired: 'released', setBy: 'aaditya', setAt: NOW - 60_000, applied: 'released', appliedAt: NOW - 58_000 },
          ],
        },
      }),
    ),
    'dx-gateway',
  )
  assert.match(done.detail, /^Live execution PAUSED by aaditya/)
  assert.equal((done.extra?.['brokerLink'] as { applied?: string } | undefined)?.applied, 'released')
})
