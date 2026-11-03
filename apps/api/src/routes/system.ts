/**
 * `GET /v1/desk/system` — one report on every process this desk is made of.
 *
 * WHY THIS IS NOT A pm2 QUERY. `pm2 jlist` answers "is there a process with
 * this name in state online", and `online` is what a crash-looping process
 * reads between restarts, what a wedged one reads forever, and what a process
 * whose bus subscription threw an hour ago still reads while it publishes
 * nothing. Every one of those is the failure an operator opens this page to
 * find, and the process table reports all of them as healthy.
 *
 * So liveness here is measured from THE ARTIFACT EACH PROCESS IS RESPONSIBLE
 * FOR — the health frame marketdata publishes every 10s, the broker snapshot
 * the gateway writes every 30s, the runtime documents the runner rewrites every
 * second, the `actual` report each Python supervisor posts on every converge.
 * A process that is genuinely working cannot stop writing its artifact, and a
 * process that has stopped writing it is not doing its job whatever the process
 * table says. That is a strictly stronger signal, and it is the only one this
 * bridge can obtain without a shell.
 *
 * FOUR STATES, AND `unknown` IS A REAL ONE.
 *
 *   ok         the artifact was written within this component's tolerance
 *   stale      it exists, and it is older than that
 *   attention  it is CURRENT, and what it says needs a human
 *   unknown    there is no artifact to read at all
 *
 * The first three are three different facts and each needs its own word.
 * `stale` says "this stopped arriving"; `attention` says "this arrived on time
 * and is telling you something". Only `positions-truth` raises `attention`
 * today, and only for a comparison that IS comparable and DID diverge — the
 * report an operator was shown on 2026-08-15 as `17 DIVERGENT` under a green
 * pill, because age was the only thing any state here had ever measured. Making
 * that `stale` instead would have been a second wrong claim rather than a fix:
 * the report was thirty seconds old and perfectly healthy, and its content was
 * the alarm.
 *
 * NO OTHER COMPONENT GETS THIS BY DEFAULT. `attention` is a claim about the
 * MEANING of an artifact, and this route can only make that claim where it
 * actually understands the artifact's meaning. Everywhere else it measures ages
 * and says so, which is the discipline the rest of this header defends.
 *
 * `unknown` is not a soft failure — it is the honest answer for a signal that
 * does not exist: a gateway in simulate mode writes no broker snapshot, a rail
 * with no books has no supervisor report to make, and a collection nothing has
 * ever written says nothing about the process that would write it. Every one of
 * those carries the reason in `detail` rather than being coloured in.
 *
 * NOTHING HERE JUDGES THE MARKET. A quiet Saturday makes several of these
 * components legitimately stale — marketdata still publishes, but a supervisor
 * with no session to converge and a gateway with no orders behave exactly like
 * one that has died, and this route cannot tell the difference. It therefore
 * makes no red/green judgement beyond the age thresholds: it reports the age it
 * measured and the cadence it expected (`expectedEveryMs`), and leaves the page
 * to render "stale" as the neutral statement of fact it is. Inventing a
 * weekend exemption would mean inventing the one thing this route must never
 * do — a claim about a process it cannot see.
 *
 * IT NEVER THROWS. This is the page someone opens when something is already
 * wrong, so an unreadable collection degrades to one grey card with the error
 * in it, never to a 500 that hides the six components that were readable.
 */

import { COLLECTIONS, type DeskStore } from '../store.ts'
import {
  compareCardSummary,
  DEFAULT_COMPARE_MS,
  POSITIONS_COMPARE_COLLECTION,
  POSITIONS_COMPARE_ID,
} from '../positions-compare.ts'
import { RUNTIME_COLLECTION } from '../../../runner/src/runtime.ts'
import { ORDER_EVENTS_COLLECTION } from '../../../order-gateway/src/journal.ts'
import type { ApiDeps, Route, RouteCtx } from './kit.ts'
import type { DeskMode } from '../contract.ts'
import { readBrokerLinkDoc, type BrokerLinkState } from '../safety.ts'

/**
 * Written every 30s by the XTS gateway this desk was cloned from. THIS DESK'S
 * gateway (simulate or delta) writes none, so every read below treats an
 * absent document as the normal state, never an error. Named as a literal rather
 * than imported, exactly as `routes/desk.ts` names it, because importing the
 * gateway's `main.ts` would pull that whole process's module graph into the
 * bridge for one string.
 */
const BROKER_SNAPSHOT_COLLECTION = 'desk-broker-snapshot'
/** The gateway's XTS token document, one `_id: 'xts'` row. */
const BROKER_SESSION_COLLECTION = 'desk-broker-session'
/** The live rail the gateway claims from; `PENDING` is "not yet claimed". */
const GATEWAY_ORDERS_COLLECTION = 'desk-gateway-orders'
/** The kill switch and the broker link — `store.ts`'s `COLLECTIONS.safety`. */
const SAFETY_COLLECTION = 'desk-safety'

// ------------------------------------------------------------- the contract

export type ComponentState = 'ok' | 'stale' | 'attention' | 'unknown'

export interface SystemComponent {
  /** Stable key — the pm2 process name where there is one. */
  readonly id: string
  readonly name: string
  readonly state: ComponentState
  /** One line an operator can act on. Never empty. */
  readonly detail: string
  /** Epoch ms of the newest artifact this component owns; null when there is none. */
  readonly lastSeenMs: number | null
  readonly ageMs: number | null
  /**
   * How often the artifact is SUPPOSED to be rewritten. Null when the component
   * has no cadence (it answered this very request). The page renders it beside
   * the age so "4s ago" can be read as fine or as three missed polls.
   */
  readonly expectedEveryMs: number | null
  readonly extra?: Record<string, unknown>
}

export interface SystemReport {
  readonly generatedAt: number
  readonly components: readonly SystemComponent[]
}

// ------------------------------------------------------------- the cadences

/**
 * Tolerances, each stated as SEVERAL missed writes rather than one.
 *
 * One slow poll must not paint a card amber: an amber that appears on a healthy
 * desk is an amber nobody reads on the day it matters. Each pair below is the
 * publisher's own cadence and roughly three of them.
 */
const CADENCE = {
  /** `md.health` is published every 10s (`marketdata/src/main.ts`). */
  marketdata: { every: 10_000, okWithin: 30_000 },
  /** The broker snapshot is written every 30s (`BROKER_SNAPSHOT_MS`). */
  gateway: { every: 30_000, okWithin: 90_000 },
  /** `runtimePublisher` rewrites every supervised instance about once a second. */
  runner: { every: 1_000, okWithin: 30_000 },
  /**
   * ONE 5-MINUTE MARK — the cadence of the field this actually measures.
   *
   * `lastSeenMs` for a supervisor is `newest(lastMarkAt)`, and that field moves
   * ONCE PER MARK: `supervisor/engine-host.ts:#journal` returns early unless
   * `markCtx.isNewMark`, and `MARK_STEP_MIN` is 5 (`desk-engine/src/session.ts`).
   * The engine evaluates several times a SECOND; it just does not journal that
   * often, and journalling is what this card can see.
   *
   * It used to read `{ every: 30_000, okWithin: 120_000 }`, and the comment said
   * why: "the Python supervisors' `converge()` runs every 30s". Python was
   * retired at the 2026-08-22 cutover and the constant came through unchanged,
   * so the card judged a 5-minutely field against a 2-minute tolerance and read
   * STALE for most of every window on a healthy desk — observed on prod
   * 2026-09-07 with three running relief-r books and the engine logging `hold`
   * continuously (`relief-r-paper-books-2026-09-07`).
   *
   * `okWithin` is two marks, keeping this row's own rule — several missed
   * writes, never one — so a single skipped journal is not an alarm.
   */
  supervisor: { every: 300_000, okWithin: 600_000 },
} as const

// ------------------------------------------------------------------ helpers

/**
 * `ok` / `stale` from an age, `unknown` from an absence.
 *
 * NO AGE IS NOT A FRESH AGE. A missing timestamp read as 0 dates the artifact
 * to 1970 and paints the component stale, which is a claim; read as absent it
 * is the truth, and the caller supplies the reason.
 */
function classify(ageMs: number | null, okWithinMs: number): ComponentState {
  if (ageMs === null) return 'unknown'
  return ageMs <= okWithinMs ? 'ok' : 'stale'
}

/** "4s" / "2m" / "1h 2m" — short enough to sit inside a one-line detail. */
export function humanAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return h < 24 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** The largest positive number in a list, or null when there is none. */
function newest(values: readonly number[]): number | null {
  const real = values.filter((v) => typeof v === 'number' && Number.isFinite(v) && v > 0)
  return real.length === 0 ? null : Math.max(...real)
}

function component(
  base: Omit<SystemComponent, 'ageMs' | 'state'> & {
    okWithinMs: number | null
    /**
     * "This artifact is current AND what it says needs a human."
     *
     * ONLY EVER UPGRADES `ok`. A stale report's content is not a fact about
     * now — the pass that would have refreshed it has not run — so `stale`
     * wins, and so does `unknown`. The age verdict is computed first and this
     * is applied on top of it, never instead of it.
     */
    needsAttention?: boolean
  },
  nowMs: number,
): SystemComponent {
  const ageMs = base.lastSeenMs === null ? null : nowMs - base.lastSeenMs
  const aged = base.okWithinMs === null
    // No cadence to miss: the component answered this request itself.
    ? (base.lastSeenMs === null ? 'unknown' : 'ok')
    : classify(ageMs, base.okWithinMs)
  const state: ComponentState = aged === 'ok' && base.needsAttention === true ? 'attention' : aged
  return {
    id: base.id,
    name: base.name,
    state,
    detail: base.detail,
    lastSeenMs: base.lastSeenMs,
    ageMs,
    expectedEveryMs: base.expectedEveryMs,
    ...(base.extra === undefined ? {} : { extra: base.extra }),
  }
}

/** A component that could not be read at all. Grey, with the reason on it. */
function unreadable(id: string, name: string, expectedEveryMs: number | null, err: unknown): SystemComponent {
  return {
    id,
    name,
    state: 'unknown',
    detail: `could not be read: ${errorText(err)}`,
    lastSeenMs: null,
    ageMs: null,
    expectedEveryMs,
  }
}

// ------------------------------------------------------------- the collectors

/** 1. This process. Trivially alive — it is answering. */
function deskApi(deps: ApiDeps, nowMs: number, uptimeMs: number): SystemComponent {
  /**
   * The bus client's socket state, when the deployment wired one in.
   *
   * ABSENT IS NOT DISCONNECTED. Every test builds `ApiDeps` without a bus, and
   * so does a bridge for the first moments of its life; reporting those as
   * "disconnected" would be a claim about a socket that was never asked for.
   */
  const connected = deps.busConnected?.() ?? null
  const bus = connected === null
    ? 'bus state not observable (no client attached)'
    : connected ? 'bus connected' : 'bus DISCONNECTED — no marks are arriving'
  return component(
    {
      id: 'dx-api',
      name: 'Bridge API',
      detail: `up ${humanAge(uptimeMs)} · ${bus}`,
      lastSeenMs: nowMs,
      expectedEveryMs: null,
      okWithinMs: null,
      extra: { uptimeMs, busConnected: connected },
    },
    nowMs,
  )
}

/**
 * 2. The market-data process, from the LAST `md.health` FRAME IT PUBLISHED.
 *
 * This is a purer signal than anything in Mongo: marketdata writes no artifact
 * this process reads, so its liveness is the arrival of its own broadcast. A
 * frame that stopped arriving means the process is gone, its publish loop is
 * wedged, or the bus between us is down — three different faults with the same
 * correct response, which is to look.
 *
 * A DISCONNECTED SOCKET IS NOT A DEAD PROCESS. The socket count is reported in
 * the detail and deliberately does not move the state: a broker socket dropping
 * is the FEED's problem and `/v1/desk/feed` is the page for it, while this card
 * answers only "is the process that would tell us still speaking?".
 */
function marketdata(deps: ApiDeps, nowMs: number): SystemComponent {
  const held = deps.feedHealth
  const payload = held?.payload ?? null
  const receivedAt = held?.receivedAt ?? null
  if (payload === null || receivedAt === null) {
    return component(
      {
        id: 'dx-marketdata',
        name: 'Market data',
        detail:
          'no md.health frame has arrived — desk-marketdata is not publishing, or the bus between ' +
          'it and this process is down',
        lastSeenMs: null,
        expectedEveryMs: CADENCE.marketdata.every,
        okWithinMs: CADENCE.marketdata.okWithin,
      },
      nowMs,
    )
  }
  const sockets = Array.isArray(payload['sockets'])
    ? (payload['sockets'] as { connected?: boolean }[])
    : []
  const up = sockets.filter((s) => s.connected === true).length
  const tokens = typeof payload['tokens'] === 'number' ? payload['tokens'] : 0
  const syncDay = typeof payload['instrumentSyncDay'] === 'string' ? payload['instrumentSyncDay'] : null
  const instrumentsStale = payload['instrumentsStale'] === true
  /**
   * FROZEN TICKS ON A CONNECTED SOCKET (audit F-14), stated only while the
   * market is open. Outside 09:15-15:30 IST every token is legitimately stale,
   * so reporting it then would put a permanent scary number on an idle desk and
   * teach everyone to ignore the one line that matters at 11:00. Like the
   * socket count, it does NOT move `state`: this card answers "is the process
   * still speaking", and a frozen feed is `/v1/desk/feed`'s subject.
   *
   * `staleTokens` is counted by desk-marketdata against its FREEZE window
   * (`DESK_FREEZE_STALE_MS`, 3 minutes — see `DEFAULT_FREEZE_STALE_MS` in
   * apps/marketdata/src/main.ts), never against a tradability window: a stock
   * chain's wings print only every 30-60s, so a tighter threshold would put a
   * three-figure "NOT TICKING" count in front of the operator every ordinary
   * session and teach them the line means nothing.
   */
  const session = payload['session'] === true
  const staleTokens = typeof payload['staleTokens'] === 'number' ? payload['staleTokens'] : 0
  const oldestAgeMs = typeof payload['oldestAgeMs'] === 'number' ? payload['oldestAgeMs'] : 0
  const showStale = session && staleTokens > 0
  const parts = [
    `${up} of ${sockets.length} sockets connected`,
    `${tokens} tokens`,
    // A stale instrument master raises no error anywhere — contracts simply
    // fail to resolve and strategies quietly decline to trade — so it is only
    // ever visible if it is stated.
    instrumentsStale
      ? `instruments NOT SYNCED TODAY (last ${syncDay ?? 'never'})`
      : `instruments synced ${syncDay ?? 'never'}`,
    ...(showStale
      ? [`${staleTokens} tokens NOT TICKING (oldest ${Math.round(oldestAgeMs / 1000)}s)`]
      : []),
  ]
  return component(
    {
      id: 'dx-marketdata',
      name: 'Market data',
      detail: parts.join(' · '),
      lastSeenMs: receivedAt,
      expectedEveryMs: CADENCE.marketdata.every,
      okWithinMs: CADENCE.marketdata.okWithin,
      extra: {
        socketsConnected: up,
        socketsTotal: sockets.length,
        tokens,
        instrumentSyncDay: syncDay,
        instrumentsStale,
        sessionOpen: session,
        ...(showStale ? { staleTokens, oldestAgeMs } : {}),
      },
    },
    nowMs,
  )
}

/**
 * 3. The order gateway, from the broker snapshot it publishes every 30s.
 *
 * A FAILED SNAPSHOT IS STILL PROOF OF LIFE. `ok: false` says the BROKER could
 * not be reached; the document was still written, on time, by a gateway that is
 * plainly running. Folding the broker's health into the process's would report
 * the gateway dead every time an XTS token expires overnight, and send someone
 * to restart a process that is fine — so the broker's own verdict goes in the
 * detail and in `extra.brokerReachable`, never into `state`.
 *
 * IN SIMULATE MODE THERE IS NO SNAPSHOT AT ALL. The writer is inside the `else`
 * branch of the gateway's broker-mode switch, and its own comment says so: the
 * simulator's book is our invention and publishing it as "the broker's view"
 * would defeat the purpose of having one. So an absent snapshot is `unknown`
 * with that reason, and the most recent gateway-written journal event is
 * offered alongside as the only other trace the gateway leaves — WITHOUT
 * promoting it to `ok`, because a desk that has placed no orders today leaves
 * no trace either, and silence there is not evidence of anything.
 */
async function gateway(deps: ApiDeps, nowMs: number): Promise<SystemComponent> {
  const snap = (await deps.db
    .collection(BROKER_SNAPSHOT_COLLECTION)
    .findOne({ _id: 'xts' })) as Record<string, unknown> | null

  const pending = await deps.db
    .collection(GATEWAY_ORDERS_COLLECTION)
    .countDocuments({ state: 'PENDING' })

  /**
   * The gateway's session document. It carries `token`/`userID`/`clientCodes`
   * and an `updatedAt` STAMPED AT LOGIN — not a heartbeat. It therefore says
   * when the gateway last logged in, which is worth showing and is NOT used to
   * decide liveness: a healthy gateway can go all day without re-logging in.
   */
  const session = (await deps.db
    .collection(BROKER_SESSION_COLLECTION)
    .findOne({ _id: 'xts' })) as Record<string, unknown> | null
  const sessionAt = typeof session?.['updatedAt'] === 'number' ? session['updatedAt'] : null
  const sessionText = session === null || session['token'] === undefined || session['token'] === ''
    ? 'no broker session stored'
    : `broker session logged in ${sessionAt === null ? 'at an unrecorded time' : `${humanAge(nowMs - sessionAt)} ago`}`

  /**
   * The broker link. A RELEASED link is the one reading on this page where
   * "broker not reachable" is the intended state, so it is named FIRST in the
   * detail — an operator who released the session an hour ago must not be
   * sent to restart a gateway that is doing exactly what it was told.
   */
  let link: BrokerLinkState = readBrokerLinkDoc(null)
  try {
    link = readBrokerLinkDoc(
      await deps.db.collection(SAFETY_COLLECTION).findOne({ _id: 'broker-link' as never }),
    )
  } catch {
    // Unreadable reads as the default; the snapshot below still tells the truth.
  }
  const linkText = brokerLinkText(link, nowMs)

  if (snap === null) {
    // The only other thing the gateway writes. Phases it alone produces —
    // `INVALID` is desk-api's own gate refusal and would be no evidence at all.
    let journalAt: number | null = null
    try {
      const rows = (await deps.db
        .collection(ORDER_EVENTS_COLLECTION)
        .find({})
        .sort({ ts: -1 })
        .limit(25)
        .toArray()) as Record<string, unknown>[]
      journalAt = newest(
        rows
          .filter((r) => r['phase'] !== 'INVALID')
          .map((r) => (typeof r['ts'] === 'number' ? r['ts'] : 0)),
      )
    } catch {
      journalAt = null
    }
    const trace = journalAt === null
      ? 'and it has journalled no order event'
      : `its last journalled order event was ${humanAge(nowMs - journalAt)} ago`
    return component(
      {
        id: 'dx-gateway',
        name: 'Order gateway',
        detail:
          (linkText === null ? '' : `${linkText} · `) +
          `no broker snapshot — this desk's gateway writes none (simulate or delta; the XTS ` +
          `writer is gone), so its liveness cannot be observed from here; ${trace}. ` +
          `${pending} orders pending`,
        lastSeenMs: null,
        expectedEveryMs: CADENCE.gateway.every,
        okWithinMs: CADENCE.gateway.okWithin,
        extra: { pendingOrders: pending, lastJournalEventAt: journalAt, snapshot: false, brokerLink: link },
      },
      nowMs,
    )
  }

  const asOf = typeof snap['asOf'] === 'number' ? snap['asOf'] : null
  const brokerOk = snap['ok'] === true
  const brokerError = typeof snap['error'] === 'string' ? snap['error'] : ''
  const parts = [
    ...(linkText === null ? [] : [linkText]),
    brokerOk
      ? 'broker reachable'
      : `broker NOT reachable: ${brokerError === '' ? 'no reason recorded' : brokerError}`,
    sessionText,
    `${pending} orders pending`,
  ]
  return component(
    {
      id: 'dx-gateway',
      name: 'Order gateway',
      detail: parts.join(' · '),
      lastSeenMs: asOf,
      expectedEveryMs: CADENCE.gateway.every,
      okWithinMs: CADENCE.gateway.okWithin,
      extra: {
        pendingOrders: pending,
        brokerReachable: brokerOk,
        brokerError,
        brokerSessionAt: sessionAt,
        snapshot: true,
        brokerLink: link,
      },
    },
    nowMs,
  )
}

/** One phrase for a released link — wish, who, and whether the gateway has done it. Null when connected. */
function brokerLinkText(link: BrokerLinkState, nowMs: number): string | null {
  if (link.desired !== 'released') return null
  const who = link.setBy === '' ? 'operator' : link.setBy
  const when = link.setAt === 0 ? '' : ` ${humanAge(nowMs - link.setAt)} ago`
  const why = link.reason === '' ? '' : ` (${link.reason})`
  const ack =
    link.applied === 'released'
      ? `gateway logged out${link.appliedError === '' ? '' : ` with errors: ${link.appliedError}`}`
      : 'gateway has NOT confirmed the logout yet'
  return `XTS session RELEASED by ${who}${when}${why} — ${ack}`
}

/**
 * 4. The hosted-strategy runner, from `desk-strategy-runtime`.
 *
 * Every supervised instance is rewritten about once a second, and the publisher
 * DELETES what it no longer supervises — so an empty collection means either
 * "no strategy is switched on" or "the runner is not running", which are
 * indistinguishable from here and are reported as exactly that.
 */
async function runner(deps: ApiDeps, nowMs: number): Promise<SystemComponent> {
  const docs = (await deps.db.collection(RUNTIME_COLLECTION).find({}).toArray()) as Record<
    string,
    unknown
  >[]
  if (docs.length === 0) {
    return component(
      {
        id: 'dx-runner',
        name: 'Strategy runner',
        detail:
          'nothing published — either no hosted strategy is switched on, or desk-runner is not ' +
          'running. The runner deletes what it no longer supervises, so the two look identical here',
        lastSeenMs: null,
        expectedEveryMs: CADENCE.runner.every,
        okWithinMs: CADENCE.runner.okWithin,
        extra: { instances: 0 },
      },
      nowMs,
    )
  }
  const byState: Record<string, number> = {}
  let openPositions = 0
  for (const d of docs) {
    const state = typeof d['state'] === 'string' ? d['state'] : 'unknown'
    byState[state] = (byState[state] ?? 0) + 1
    if (typeof d['openPositions'] === 'number') openPositions += d['openPositions']
  }
  const lastSeenMs = newest(docs.map((d) => (typeof d['updatedAt'] === 'number' ? d['updatedAt'] : 0)))
  const counts = Object.entries(byState).map(([s, n]) => `${n} ${s}`).join(', ')
  return component(
    {
      id: 'dx-runner',
      name: 'Strategy runner',
      detail: `${counts} · ${openPositions} open positions`,
      lastSeenMs,
      expectedEveryMs: CADENCE.runner.every,
      okWithinMs: CADENCE.runner.okWithin,
      extra: { instances: docs.length, byState, openPositions },
    },
    nowMs,
  )
}

/**
 * 5. One Python supervisor, from the `actual` reports its books post back.
 *
 * The supervisors are a separate deployment with no database driver at all
 * (`bridge.py` is HTTP-only), so the only trace either of them leaves here is
 * `POST /v1/desk/books/registry/{tag}/actual`, which lands on `lastMarkAt`.
 * That field is written by NOTHING ELSE — `/start`, `/stop` and the dials patch
 * only ever move `desired` and `updatedAt` — which is what makes it a
 * supervisor heartbeat rather than a record of operator activity.
 *
 * `updatedAt` IS THE FALLBACK, AND IT IS LABELLED AS ONE. A supervisor that
 * posts `actual` without a `lastMarkAt` leaves it at 0 (`validateActualReport`
 * defaults it), and in that case `updatedAt` is the only timestamp there is —
 * but it also moves when an operator edits a dial, so it cannot silently be
 * presented as the supervisor's own clock.
 *
 * NO BOOKS ON A RAIL IS `unknown`, NOT `stale`. There is no live book most
 * days; a supervisor with nothing to converge writes nothing, and colouring
 * that as a fault would put a permanent amber on a rail behaving exactly as
 * intended.
 */
async function supervisor(
  store: DeskStore,
  mode: DeskMode,
  nowMs: number,
  extraFields: Record<string, unknown>,
): Promise<SystemComponent> {
  const id = mode === 'live' ? 'dx-supervisor-live' : 'dx-supervisor'
  const name = mode === 'live' ? 'Supervisor (live)' : 'Supervisor (paper)'
  const rows = await store.listBooks(mode)
  if (rows.length === 0) {
    return component(
      {
        id,
        name,
        detail: `no books registered on this rail — there is nothing for the ${mode} supervisor to converge, so it publishes nothing`,
        lastSeenMs: null,
        expectedEveryMs: CADENCE.supervisor.every,
        okWithinMs: CADENCE.supervisor.okWithin,
        extra: { books: 0, ...extraFields },
      },
      nowMs,
    )
  }
  const marks = newest(rows.map((r) => r.lastMarkAt))
  const touched = newest(rows.map((r) => r.updatedAt))
  const lastSeenMs = marks ?? touched
  const source = marks !== null ? 'lastMarkAt' : touched !== null ? 'updatedAt' : null
  const running = rows.filter((r) => r.actual === 'running').length
  const wanted = rows.filter((r) => r.desired === 'running').length
  const parts = [
    `${rows.length} books registered`,
    `${running} reporting running of ${wanted} asked to run`,
  ]
  if (source === 'updatedAt') {
    // Said out loud, because this timestamp also moves when an operator edits
    // a dial — it is weaker evidence than the field it stands in for.
    parts.push('no book has ever reported lastMarkAt; age is from updatedAt, which an operator edit also moves')
  }
  if (source === null) {
    parts.push('no book has ever been reported on — the supervisor may never have run')
  }
  return component(
    {
      id,
      name,
      detail: parts.join(' · '),
      lastSeenMs,
      expectedEveryMs: CADENCE.supervisor.every,
      okWithinMs: CADENCE.supervisor.okWithin,
      extra: {
        books: rows.length,
        reportingRunning: running,
        desiredRunning: wanted,
        ageSource: source,
        ...extraFields,
      },
    },
    nowMs,
  )
}

/**
 * 6. The positions comparison — broker vs `desk-books` vs runner ledgers.
 *
 * A COMPONENT LIKE ANY OTHER IN ITS AGE, AND THE ONE EXCEPTION IN ITS CONTENT.
 * It is a job inside this process that writes an artifact on a cadence, so
 * `stale` here means exactly what it means everywhere else on this page: the
 * comparison has not run recently. It NEVER means the desk and the broker
 * disagree.
 *
 * A LIVE DIVERGENCE IS `attention`, WHICH IS ITS OWN WORD FOR ITS OWN FACT.
 * The original build put the divergence in the detail line in capitals and left
 * the pill to the age, and the reasoning was right about what it refused:
 * calling a thirty-second-old report `stale` would have been a false claim
 * about the job, and painting it into the page's "have not written recently"
 * banner would have put it under the wrong heading. What it had no word for was
 * the true one — a report that arrived exactly on time and is telling you
 * seventeen contracts do not match. On 2026-08-15 that read `17 DIVERGENT`
 * beside a green `ok`, which is the one thing a status page must never say.
 * `attention` is that missing third word, and it is raised ONLY when the last
 * report is `comparable` (a comparison actually happened) AND `divergent` is
 * non-empty. An aged-out report stays `stale` whatever its verdict says, for
 * the reason `component` states: the numbers in a stale report are not a claim
 * about now.
 *
 * A divergence is also journalled into the order feed once a day and logged
 * when it changes, so the card is not the only place it can be seen.
 *
 * AN ABSENT REPORT IS `unknown`, with the reason. A bridge in its first five
 * minutes has run no pass, and inventing "everything agrees" for it would be
 * the one thing this page must never do. NO VERDICT IS NOT A DIVERGENCE either:
 * a report with `comparable: false` names no divergent contracts at all, so an
 * unreadable broker view stays `ok`-by-age with its reason in the detail line,
 * rather than borrowing an alarm it has no evidence for.
 */
async function positionsTruth(deps: ApiDeps, nowMs: number): Promise<SystemComponent> {
  const doc = (await deps.db
    .collection(POSITIONS_COMPARE_COLLECTION)
    .findOne({ _id: POSITIONS_COMPARE_ID })) as Record<string, unknown> | null
  const card = compareCardSummary(doc, nowMs)
  return component(
    {
      id: 'positions-truth',
      name: 'Positions truth',
      detail: card.detail,
      lastSeenMs: card.lastSeenMs,
      expectedEveryMs: card.expectedEveryMs,
      // Three missed passes, the same tolerance rule as every cadence above.
      okWithinMs: card.expectedEveryMs * 3,
      // Read from the card's own `extra`, which is derived from the stored
      // report in ONE place — so the pill and the words beside it can never
      // come from two different readings of the same document.
      needsAttention: card.extra['comparable'] === true && Number(card.extra['divergent'] ?? 0) > 0,
      extra: card.extra,
    },
    nowMs,
  )
}

/**
 * 7. Mongo, by an actual round trip.
 *
 * A `findOne`, not `serverStatus`: the narrow `Database` port this bridge
 * reaches the driver through (see `store.ts`) exposes `collection()` and
 * nothing else, deliberately, and widening it for a diagnostic would undo the
 * confinement that keeps driver 3.7 in one file. The read answers the question
 * that matters anyway — can this process reach the database, and how long did
 * it take — because it is the same call every other route makes.
 */
async function mongo(deps: ApiDeps, nowMs: number): Promise<SystemComponent> {
  const started = deps.now()
  await deps.db.collection(COLLECTIONS.safety).findOne({ _id: '__system_ping__' })
  const roundTripMs = Math.max(0, deps.now() - started)
  return component(
    {
      id: 'mongo',
      name: 'MongoDB',
      detail: `round trip ${roundTripMs}ms`,
      lastSeenMs: nowMs,
      expectedEveryMs: null,
      okWithinMs: null,
      extra: { roundTripMs },
    },
    nowMs,
  )
}

// ---------------------------------------------------------------- the report

export interface SystemOptions {
  /** Injected so a test can pin the uptime; production reads `process.uptime()`. */
  uptimeMs?: () => number
}

/**
 * Every component, collected independently.
 *
 * SEQUENTIAL, NOT `Promise.all`. This is a diagnostic page polled every five
 * seconds by however many browsers are open, and the failure it is most likely
 * to be looked at during is a struggling Mongo — firing six concurrent reads
 * per poll at a database that is already slow is the wrong thing to do to it.
 * Each collector is wrapped on its own so one unreadable collection greys one
 * card instead of emptying the report.
 */
export async function buildSystemReport(
  deps: ApiDeps,
  opts: SystemOptions = {},
): Promise<SystemReport> {
  const nowMs = deps.now()
  const uptimeMs = opts.uptimeMs?.() ?? Math.round(process.uptime() * 1000)
  const components: SystemComponent[] = [deskApi(deps, nowMs, uptimeMs), marketdata(deps, nowMs)]

  const collect = async (
    id: string,
    name: string,
    expectedEveryMs: number | null,
    fn: () => Promise<SystemComponent>,
  ): Promise<void> => {
    try {
      components.push(await fn())
    } catch (err) {
      deps.log('system report: a component could not be read', { id, error: errorText(err) })
      components.push(unreadable(id, name, expectedEveryMs, err))
    }
  }

  await collect('dx-gateway', 'Order gateway', CADENCE.gateway.every, () => gateway(deps, nowMs))
  await collect('dx-runner', 'Strategy runner', CADENCE.runner.every, () => runner(deps, nowMs))

  /**
   * The variant catalogue's recency is GENUINELY UNKNOWABLE, and is reported
   * as such rather than faked. Its rows are `{key, decider, playbook,
   * defaults}` with no timestamp on any of them, so there is no field from
   * which "when was this catalogue last written?" could be answered. The count
   * is real; the age is null with that meaning.
   *
   * IT IS NOW A FROZEN COUNT (D9). The writer — the Python supervisor's
   * wholesale republish — is gone with `POST /v1/desk/variants`, so this number
   * describes what a past deployment published and stops moving. Kept because
   * the rows are still READ (a book registered under a published variant
   * resolves its dial defaults from them), so "how many are there" remains a
   * real question about a real collection.
   */
  let variantCount: number | null = null
  try {
    variantCount = (await deps.store.listVariants()).length
  } catch (err) {
    deps.log('system report: variant catalogue unreadable', { error: errorText(err) })
  }

  await collect('dx-supervisor', 'Supervisor (paper)', CADENCE.supervisor.every, () =>
    supervisor(deps.store, 'paper', nowMs, { variantCount, variantsUpdatedAt: null }))
  await collect('dx-supervisor-live', 'Supervisor (live)', CADENCE.supervisor.every, () =>
    supervisor(deps.store, 'live', nowMs, {}))
  await collect('positions-truth', 'Positions truth', DEFAULT_COMPARE_MS, () =>
    positionsTruth(deps, nowMs))
  await collect('mongo', 'MongoDB', null, () => mongo(deps, nowMs))

  return { generatedAt: nowMs, components }
}

/**
 * Registered among the AUTHENTICATED routes in `main.ts`, beside every other
 * desk GET. Machine principals read it too — the same bearer the Python desk
 * uses — because "is the bridge's view of my process healthy?" is a question a
 * monitor should be able to ask without a browser session. Unlike `/health`
 * and `/v1/desk/feed` it is NOT public: it names every process, its cadence and
 * its broker session state, which is a map of the desk for anyone who can reach
 * the port.
 */
export function systemRoutes(deps: ApiDeps, opts: SystemOptions = {}): Route {
  return async (ctx: RouteCtx): Promise<boolean> => {
    if (ctx.path !== '/v1/desk/system' || ctx.method !== 'GET') return false
    ctx.send(200, await buildSystemReport(deps, opts))
    return true
  }
}
