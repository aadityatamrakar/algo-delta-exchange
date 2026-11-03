/**
 * `GET /v1/desk/stream` — the read-only push socket.
 *
 * WHY IT LIVES IN THIS PROCESS. `desk-api` already owns the book, the marks and
 * the auth gate. A separate socket process would need its own copy of all three,
 * and the copy that drifts is the one that shows a position nobody holds.
 *
 * IT IS READ-ONLY, and that is a safety property rather than a simplification.
 * Orders, flattens and the kill switch stay on HTTP: a failed request is a
 * failure you can SEE and retry, while a command dropped into a socket that died
 * ten seconds ago produces no error anywhere. The only thing a client may send
 * here is `{ type: 'subscribe', mode }`, which selects a filter and can move
 * nothing; every other inbound frame is ignored.
 *
 * NOTHING IS PUSHED THAT WAS NOT ASKED FOR. A socket starts subscribed to
 * NEITHER mode and receives nothing until it names one. A paper tab that
 * received a live figure would be the most expensive kind of wrong — real money
 * rendered under a badge that says PAPER — so the filter is per socket and the
 * publish loop reads it, rather than a broadcast that clients filter locally
 * (which is what `@algomaker/bus` does, and is why this does not reuse it).
 *
 * NO CHANGE STREAMS. Production Mongo is a standalone, not a replica set, so
 * they do not exist there. Every event on this socket is handed to `publish()`
 * by the code that just wrote it — `PaperRail.route`, `SubmitService`, or the
 * gateway's notify — and nothing here watches a collection.
 *
 * THE HEARTBEAT IS NOT OPTIONAL. A websocket can die without firing `close`: a
 * dropped NAT mapping leaves a half-open TCP connection, the browser reports
 * nothing, and the page keeps showing the last numbers it received, which LOOK
 * live. That is the same class of defect as rendering a confident 0 for an
 * unmarked leg. A frame every `heartbeatMs` gives the client something to miss,
 * so silence becomes detectable and the page can fall back to polling and say
 * so.
 *
 * P&L IS SNAPSHOT-THEN-DELTA, AND THE DELTAS ARE COALESCED. It used to be one
 * COMPLETE `PnlRow` per tick per held instrument, unthrottled: ~16 held tokens
 * ticking several times a second, every leg and every field, and the dashboard
 * parsed each frame and threw it away. Both halves of that were waste. Now a
 * socket is sent one full snapshot when it subscribes, and thereafter a flush
 * every `pnlMs` carrying ONLY the tags whose numbers moved and, within a tag,
 * only the fields a tick can move. THE COALESCING IS THE WIN — shrinking the
 * payload alone would still be ~100 frames a second.
 *
 * AN OMITTED FIELD MEANS UNCHANGED; A FIELD THAT HAS BECOME UNKNOWN IS SENT AS
 * AN EXPLICIT `null`. Those are not the same thing and conflating them is the
 * most dangerous defect this protocol could carry: a leg whose feed stopped
 * pricing it would keep displaying its last known mark as though it were live.
 * `JSON.stringify` drops `undefined` keys, so "absent" falls out of building the
 * delta with the field simply not set — which is why `pnlUpdateFor` uses
 * conditional spreads rather than assigning `undefined`.
 *
 * THE TAG FILTER IS BANDWIDTH, NEVER SECURITY. A socket may name the tags it
 * cares about so a page showing one strategy is not sent the whole desk. The
 * SECURITY boundary is the mode filter above it and it is untouched: one mode
 * per socket, enforced here, whatever the tag list says.
 */

import { WebSocketServer, WebSocket } from 'ws'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import type { DeskMode } from './contract.ts'
import type { Log } from './routes/kit.ts'
import type { LegQuote, PnlRow } from './pnl-jobs.ts'
import type { MarkedLeg } from './rollup.ts'

export const STREAM_PATH = '/v1/desk/stream'

/**
 * One order event, as it goes over the wire.
 *
 * Shaped like `apps/order-gateway`'s `OrderEvent` and like `paperFillEvent`,
 * because the Orders page already renders that shape and a second vocabulary for
 * the same fact is a second thing to keep in sync.
 *
 * EVERY UNKNOWN IS `null`, NEVER `0` OR `''`. A PLANNED event has no fill, so it
 * has no quantity and no price; a `0` in either column is a claim about a fill
 * that did not happen, and `avgPrice: 0` in particular reads as a free option.
 * The rule is the one `rollup.ts` and `pnl.tsx` already state — unknown is null
 * on the wire and an em-dash on screen — and it does not stop being true because
 * the transport changed.
 */
export interface StreamOrderEvent {
  readonly clientOrderId: string
  readonly phase: string
  /** False for anything a human should look at. */
  readonly ok: boolean
  readonly tag: string
  readonly tradingsymbol: string
  readonly ts: number
  /** 'BUY' / 'SELL'. Null on a routing event, which has no side of its own. */
  readonly side: string | null
  /** Null when this event carried no fill. NEVER 0. */
  readonly filledQty: number | null
  /** Null when nothing priced it. NEVER 0 — see the interface docstring. */
  readonly avgPrice: number | null
  readonly status: string | null
  readonly error: string | null
  readonly detail: Record<string, unknown> | null
}

/**
 * One leg's moving parts, as a DIFF.
 *
 * `tradingsymbol` identifies it and is always present. The other three are
 * present ONLY when they changed since the last flush — and when a field IS
 * present its value is authoritative, including `null`, which means "the feed
 * can no longer price this" and must render as an em-dash. An absent field is
 * UNCHANGED; the two readings are opposite and the client must not collapse
 * them.
 *
 * Nothing else about a leg is here, because nothing else about a leg can move
 * on a tick: `qty`, `avgCost`, `realised` and the four buy/sell figures need a
 * FILL, and a fill sends the whole row instead (see `pnlUpdateFor`).
 */
export interface PnlLegDelta {
  readonly tradingsymbol: string
  readonly mark?: number | null
  readonly unrealised?: number | null
  readonly mtm?: number | null
  /**
   * The pair the mark is valued off, when it moved. `null` means the book can
   * no longer answer for this leg — same absent-vs-null rule as `mark`. A pair
   * can move while the exit-side mark holds still (the other side ticked), so
   * this is diffed in its own right.
   */
  readonly quote?: LegQuote | null
}

/**
 * One strategy row's moving parts, as a DIFF. Same absent-means-unchanged rule
 * as `PnlLegDelta`.
 *
 * `realised`, `openLegs` and `label` are absent by construction — they cannot
 * change without a fill or a registry edit. `unpriced` IS here even though the
 * brief's minimum did not name it: it changes on a tick exactly when `complete`
 * does (a leg losing its mark), and `pnl.tsx` renders it as "Cannot mark: …".
 * Leaving it out would leave that sentence naming the wrong legs, which is the
 * same stale-but-confident failure the null rule exists to prevent.
 */
export interface PnlRowDelta {
  readonly tag: string
  readonly unrealised?: number | null
  readonly total?: number | null
  readonly complete?: boolean
  readonly unpriced?: readonly string[]
  /** Only the legs that moved. A leg not listed is unchanged. */
  readonly legs?: readonly PnlLegDelta[]
}

/** Server -> client. The client ignores any `type` it does not know. */
export type StreamFrame =
  | { readonly type: 'subscribed'; readonly mode: DeskMode }
  /** Proof of life, so a half-open socket becomes detectable. See the header. */
  | { readonly type: 'heartbeat'; readonly ts: number }
  | { readonly type: 'order'; readonly mode: DeskMode; readonly event: StreamOrderEvent }
  /**
   * THE BASE EVERY LATER DELTA IS READ AGAINST. Sent once, on subscribe, and
   * again on every re-subscribe (which is how a client widens or narrows its
   * tag filter). `rows` is the COMPLETE set for this mode and this filter, so
   * the client replaces rather than merges — a row that has gone away is gone.
   *
   * The rows are exactly what `GET /v1/desk/pnl` puts in `strategies[]`, field
   * for field, because they come from the same `pnlRowFor`. A second vocabulary
   * for "what is this tag worth" would be a second thing to keep in step with
   * `rollup.ts`'s arithmetic, and the copy that drifts is the one showing a
   * total the P&L page disagrees with.
   */
  | { readonly type: 'pnl-snapshot'; readonly mode: DeskMode; readonly rows: readonly PnlRow[] }
  /**
   * One coalesced flush. Both lists may be empty individually; a frame with
   * both empty is never sent.
   *
   * `rows` carries WHOLE rows, for tags where something a tick cannot move has
   * moved — a fill changed `qty`/`avgCost`/`realised`, or a leg appeared. It is
   * an upsert by tag, NOT a replacement of the set (that is what a snapshot is
   * for). `deltas` carries the tick-driven diffs.
   */
  | {
      readonly type: 'pnl-delta'
      readonly mode: DeskMode
      readonly rows: readonly PnlRow[]
      readonly deltas: readonly PnlRowDelta[]
    }

/**
 * What the order path is handed. ONE method, and calling it must be free of
 * consequences: an emit that throws, blocks or rejects would make a dashboard
 * update capable of failing an order, which inverts the priority entirely.
 */
export type PublishOrderEvent = (mode: DeskMode, raw: Record<string, unknown>) => void

/** A finite number, or null. `0` is preserved; `undefined`/junk becomes null. */
function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  return null
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null
}

/**
 * Normalise a journalled document into the wire shape.
 *
 * Pure and exported because the null discipline above is the thing worth
 * pinning: it is one `?? 0` away from being lost, and the loss is invisible —
 * the page renders a number instead of a dash and nobody can tell it apart from
 * a real one.
 *
 * `ts` falls back to `nowMs` rather than 0: a missing timestamp rendered as
 * 1970 in a table sorted by time, which buries the newest row at the bottom.
 */
export function streamOrderEvent(raw: Record<string, unknown>, nowMs: number): StreamOrderEvent {
  const detail = raw['detail']
  return {
    clientOrderId: String(raw['clientOrderId'] ?? ''),
    phase: String(raw['phase'] ?? ''),
    // Only an explicit `true` is ok. An absent field is not a success.
    ok: raw['ok'] === true,
    tag: String(raw['tag'] ?? ''),
    tradingsymbol: String(raw['tradingsymbol'] ?? ''),
    ts: num(raw['ts']) ?? nowMs,
    side: str(raw['side']),
    filledQty: num(raw['filledQty']),
    avgPrice: num(raw['avgPrice']),
    status: str(raw['status']),
    error: str(raw['error']),
    detail:
      typeof detail === 'object' && detail !== null && !Array.isArray(detail)
        ? (detail as Record<string, unknown>)
        : null,
  }
}

/** Only these two words select a filter; anything else subscribes to nothing. */
function modeOf(v: unknown): DeskMode | null {
  return v === 'paper' || v === 'live' ? v : null
}

/**
 * The tag filter a subscribe asked for. `null` means EVERY tag.
 *
 * ABSENT MEANS ALL; A PRESENT ARRAY MEANS EXACTLY THOSE, EMPTY INCLUDED. The
 * asymmetry is deliberate and it is what makes the filter worth having: a page
 * that renders order events and no P&L at all (the Orders page) has to be able
 * to say "none", and if empty meant "all" it would keep receiving the whole
 * desk — which is the waste this protocol exists to remove. Absent still means
 * all, so a client that knows nothing about tags is unaffected.
 *
 * Junk entries are dropped rather than rejected: this is a bandwidth hint, and
 * refusing a subscription over one is a page that shows nothing instead of a
 * page that shows too much.
 */
function tagsOf(v: unknown): ReadonlySet<string> | null {
  if (!Array.isArray(v)) return null
  const out = new Set<string>()
  for (const t of v as readonly unknown[]) if (typeof t === 'string' && t !== '') out.add(t)
  return out
}

/** What one socket asked for. */
interface ClientState {
  /** The ONE mode it named. `null` means it has named none and is sent nothing. */
  mode: DeskMode | null
  /** Tags it wants P&L for; `null` is all of them. See `tagsOf`. */
  tags: ReadonlySet<string> | null
  /**
   * True once its snapshot has gone out. Deltas are withheld until then.
   *
   * WITHOUT THIS A DELTA CAN OVERTAKE THE SNAPSHOT IT IS READ AGAINST: the
   * snapshot is computed asynchronously, a flush during that window would carry
   * NEWER marks, and the snapshot landing afterwards would roll them backwards.
   * Dropping those deltas loses nothing — the snapshot supersedes them, and the
   * next flush diffs against a baseline no newer than the snapshot, so anything
   * that moved in between is re-sent.
   */
  pnlReady: boolean
  /**
   * Bumped on every subscribe. An in-flight snapshot whose epoch has moved on
   * belongs to a filter the client has already replaced, and sending it would
   * hand the page a row set it did not ask for.
   */
  epoch: number
}

/** What a flush decided to do about one tag. */
export type PnlUpdate =
  | { readonly kind: 'none' }
  /** Something a tick cannot move has moved. The whole row goes. */
  | { readonly kind: 'full' }
  | { readonly kind: 'delta'; readonly delta: PnlRowDelta }

/** Fields of a leg that a FILL changes and a tick cannot. */
function legStructureMoved(a: MarkedLeg, b: MarkedLeg): boolean {
  return (
    a.tradingsymbol !== b.tradingsymbol ||
    a.qty !== b.qty ||
    a.avgCost !== b.avgCost ||
    a.realised !== b.realised ||
    a.buyQty !== b.buyQty ||
    a.buyValue !== b.buyValue ||
    a.sellQty !== b.sellQty ||
    a.sellValue !== b.sellValue
  )
}

function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

function sameQuote(a: LegQuote | null, b: LegQuote | null): boolean {
  if (a === null || b === null) return a === b
  return a.bid === b.bid && a.ask === b.ask && a.basis === b.basis && a.asOf === b.asOf
}

/**
 * What to send for one tag: nothing, the whole row, or a diff.
 *
 * PURE AND EXPORTED, because this is where the protocol's one dangerous mistake
 * would live. It decides "unchanged" (omit) versus "now unknown" (send `null`),
 * and getting that backwards makes a leg the feed dropped keep showing its last
 * price as though it were live.
 *
 * IT DERIVES "A FILL HAPPENED" FROM THE DATA rather than trusting a caller to
 * flag it. A flag is a thing to forget; comparing the fill-driven fields cannot
 * be forgotten, and it also covers a leg appearing, disappearing or being
 * relabelled — every case where a diff would describe a row the client cannot
 * reconstruct.
 *
 * NO ARITHMETIC HERE. Every value copied out is one `rollup.ts`/`pnlFromFills`
 * already computed; this only decides which of them to put on the wire.
 */
export function pnlUpdateFor(prev: PnlRow | undefined, next: PnlRow): PnlUpdate {
  // Nothing to diff against, so there is no such thing as "unchanged".
  if (prev === undefined) return { kind: 'full' }
  if (
    prev.label !== next.label ||
    prev.realised !== next.realised ||
    prev.openLegs !== next.openLegs ||
    prev.legs.length !== next.legs.length ||
    // The price source and its fallback list are rare changes and carry the
    // "incomplete" warning — a full row, never a partial one that drops them.
    prev.marksSource !== next.marksSource ||
    !sameStrings(prev.marksFallback ?? [], next.marksFallback ?? [])
  ) {
    return { kind: 'full' }
  }
  const legs: PnlLegDelta[] = []
  for (let i = 0; i < next.legs.length; i++) {
    const a = prev.legs[i] as MarkedLeg
    const b = next.legs[i] as MarkedLeg
    if (legStructureMoved(a, b)) return { kind: 'full' }
    const mark = a.mark !== b.mark
    const unrealised = a.unrealised !== b.unrealised
    const mtm = a.mtm !== b.mtm
    const qa = prev.quotes?.[b.tradingsymbol] ?? null
    const qb = next.quotes?.[b.tradingsymbol] ?? null
    const quote = !sameQuote(qa, qb)
    if (!mark && !unrealised && !mtm && !quote) continue
    legs.push({
      tradingsymbol: b.tradingsymbol,
      // Conditional spreads, NOT `mark: undefined`. `exactOptionalPropertyTypes`
      // rejects the latter, and more importantly an explicitly-undefined key is
      // one `JSON.stringify` change away from becoming a transmitted `null`.
      ...(mark ? { mark: b.mark } : {}),
      ...(unrealised ? { unrealised: b.unrealised } : {}),
      ...(mtm ? { mtm: b.mtm } : {}),
      ...(quote ? { quote: qb } : {}),
    })
  }
  const unrealised = prev.unrealised !== next.unrealised
  const total = prev.total !== next.total
  const complete = prev.complete !== next.complete
  const unpriced = !sameStrings(prev.unpriced, next.unpriced)
  if (!unrealised && !total && !complete && !unpriced && legs.length === 0) {
    return { kind: 'none' }
  }
  return {
    kind: 'delta',
    delta: {
      tag: next.tag,
      ...(unrealised ? { unrealised: next.unrealised } : {}),
      ...(total ? { total: next.total } : {}),
      ...(complete ? { complete: next.complete } : {}),
      ...(unpriced ? { unpriced: next.unpriced } : {}),
      ...(legs.length > 0 ? { legs } : {}),
    },
  }
}

export interface DeskStreamDeps {
  readonly log?: Log
  now?(): number
  /**
   * How often a proof-of-life frame goes out. See the header — this is what
   * makes a half-open socket detectable by the client rather than silent.
   */
  readonly heartbeatMs?: number
  /**
   * A cap on concurrent sockets, refused with 503 beyond it.
   *
   * This process also routes orders. A dashboard stuck in a reconnect loop, or
   * a tab left open on twenty screens, must not be able to exhaust it — and a
   * refused socket falls back to REST polling and says so on screen, which is a
   * degradation the operator can see.
   */
  readonly maxClients?: number
  /**
   * How often the accumulated P&L changes are flushed. Defaults to 250ms.
   *
   * THE COALESCING IS THE WHOLE OPTIMISATION. ~16 held tokens ticking several
   * times a second produced ~100 frames a second, each a complete row; at 250ms
   * that becomes 4 frames a second carrying only what moved.
   */
  readonly pnlMs?: number
  /**
   * Every row for one mode, right now — `LiveBook.summary`'s `strategies`.
   *
   * `null` means THERE IS NO BOOK TO SNAPSHOT (it has not loaded yet), and the
   * socket is then sent no snapshot and no deltas: an empty snapshot would be a
   * confident "this desk holds nothing", which is the one answer this codebase
   * keeps refusing to give. The client stays on REST, which has its own
   * fallback for exactly this state.
   */
  readonly snapshot?: (mode: DeskMode) => Promise<readonly PnlRow[] | null>
}

export class DeskStream {
  readonly path = STREAM_PATH
  readonly #wss: WebSocketServer
  /** socket -> what it asked for. See `ClientState`. */
  readonly #clients = new Map<WebSocket, ClientState>()
  readonly #log: Log
  readonly #now: () => number
  readonly #maxClients: number
  readonly #heartbeat: NodeJS.Timeout | null
  readonly #pnlTimer: NodeJS.Timeout | null
  readonly #snapshot: ((mode: DeskMode) => Promise<readonly PnlRow[] | null>) | null

  /**
   * Rows re-marked since the last flush, newest wins. THIS is the coalescing:
   * a token ticking forty times between flushes overwrites the same map entry
   * forty times and costs one frame.
   */
  readonly #dirty = new Map<DeskMode, Map<string, PnlRow>>()
  /**
   * What the last flush put on the wire, per mode — the baseline every delta is
   * computed against.
   *
   * PER MODE, NOT PER SOCKET, and that is safe rather than a shortcut. A socket
   * that subscribes mid-stream gets a snapshot of the truth NOW, which is never
   * older than this baseline, so the next flush's diff is a SUPERSET of what
   * that socket needs — and every value in a delta is absolute, so re-sending
   * one it already had changes nothing. Per-socket baselines would cost a copy
   * of the desk per tab and buy exactly that.
   */
  readonly #sent = new Map<DeskMode, Map<string, PnlRow>>()

  constructor(deps: DeskStreamDeps = {}) {
    // `noServer`: the handshake is completed by `server.ts` AFTER the same auth
    // gate every other route goes through. A `WebSocketServer` bound to a port
    // of its own would be a second front door with its own idea of who is
    // allowed in.
    this.#wss = new WebSocketServer({ noServer: true })
    this.#log = deps.log ?? ((): void => {})
    this.#now = deps.now ?? ((): number => Date.now())
    this.#maxClients = deps.maxClients ?? 50

    /**
     * A non-numeric override falls back to the default rather than disabling
     * the heartbeat: a typo'd `DESK_STREAM_HEARTBEAT_MS` would otherwise take
     * away the one signal a client has for telling a live socket from a dead
     * one, and it would do it silently. `0` still disables it, deliberately —
     * that is what the tests pass.
     */
    const raw = deps.heartbeatMs
    const beatMs = raw === undefined || !Number.isFinite(raw) ? 15_000 : raw
    this.#heartbeat = beatMs > 0 ? setInterval(() => this.#beat(), beatMs) : null
    // Never hold the process open for a heartbeat: a shutdown that waits on it
    // is a pm2 restart that takes the kill timeout every time.
    this.#heartbeat?.unref()

    // Same rule as the heartbeat above, for the same reason: a typo'd
    // `DESK_STREAM_PNL_MS` must not silently stop the P&L push. `0` disables
    // the timer, deliberately — that is what the tests pass so they can drive
    // `flushPnl()` themselves instead of racing a real one.
    const pnlRaw = deps.pnlMs
    const pnlMs = pnlRaw === undefined || !Number.isFinite(pnlRaw) ? 250 : pnlRaw
    this.#pnlTimer = pnlMs > 0 ? setInterval(() => this.flushPnl(), pnlMs) : null
    this.#pnlTimer?.unref()

    this.#snapshot = deps.snapshot ?? null
  }

  get clientCount(): number {
    return this.#clients.size
  }

  /** How many sockets are listening to one rail. Read by the tests and the log. */
  subscriberCount(mode: DeskMode): number {
    let n = 0
    for (const s of this.#clients.values()) if (s.mode === mode) n++
    return n
  }

  /**
   * Adopt a socket whose upgrade `server.ts` has already authenticated.
   *
   * `principalName` is carried only for the log line. NOTHING on this socket is
   * scoped by who opened it: every authenticated operator sees the same desk,
   * exactly as they do over REST.
   */
  accept(req: IncomingMessage, socket: Duplex, head: Buffer, principalName: string): void {
    if (this.#clients.size >= this.#maxClients) {
      refuse(socket, 503, 'too many stream clients')
      this.#log('stream upgrade refused — client cap reached', { max: this.#maxClients })
      return
    }
    this.#wss.handleUpgrade(req, socket, head, (ws) => {
      // Subscribed to NOTHING until it says which rail. See the header.
      this.#clients.set(ws, { mode: null, tags: null, pnlReady: false, epoch: 0 })
      ws.on('message', (raw) => this.#onMessage(ws, String(raw)))
      ws.on('close', () => this.#clients.delete(ws))
      // A socket error is a dropped client, not an incident: it must never
      // reach the process's error handler in the process that routes orders.
      ws.on('error', () => {
        this.#clients.delete(ws)
        try {
          ws.terminate()
        } catch {
          /* already gone */
        }
      })
      this.#log('stream client connected', { principal: principalName, clients: this.#clients.size })
    })
  }

  /**
   * Fan one event out to the sockets that asked for THIS mode.
   *
   * NEVER THROWS. It is called from inside the order path — `PaperRail.route`
   * has just written a fill, `SubmitService` has just journalled a refusal — and
   * the same rule applies as to `OrderJournal.record` and `journalBlocked`:
   * losing the notification is an inconvenience, failing the order because we
   * could not send it is an outage.
   */
  publish(mode: DeskMode, raw: Record<string, unknown>): void {
    try {
      const frame: StreamFrame = {
        type: 'order',
        mode,
        event: streamOrderEvent(raw, this.#now()),
      }
      this.#send(mode, frame)
    } catch (err) {
      this.#log('stream publish failed — the order path is unaffected', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  /**
   * A strategy was re-marked. RECORD IT; the flush timer decides what goes out.
   *
   * NOTHING IS SENT HERE — no JSON, no socket write, no diff. This is called
   * from `LiveBook.onTick`, on the marketdata bus, inside the process that
   * routes orders, and it used to serialise a complete row and fan it out on
   * every tick of every held instrument. Now it is one map write, and a token
   * that ticks forty times between flushes costs forty map writes and one
   * frame.
   *
   * NEVER THROWS, for the same reason `publish` does not: a tick handler that
   * could throw would take the bus subscription — and with it every mark on the
   * desk — down over a dead socket.
   */
  publishPnl(mode: DeskMode, row: PnlRow): void {
    try {
      const pending = this.#dirty.get(mode)
      if (pending === undefined) this.#dirty.set(mode, new Map([[row.tag, row]]))
      else pending.set(row.tag, row)
    } catch (err) {
      this.#log('stream pnl publish failed — the tick path is unaffected', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  /**
   * Send everything that moved since the last flush.
   *
   * PUBLIC so the tests drive it deterministically instead of sleeping past a
   * timer, which is the difference between a test that asserts the protocol and
   * one that asserts the clock. NEVER THROWS — it runs on a timer inside the
   * order-routing process.
   */
  flushPnl(): void {
    try {
      for (const [mode, pending] of this.#dirty) {
        if (pending.size === 0) continue
        const baseline = this.#sent.get(mode) ?? new Map<string, PnlRow>()
        const rows: PnlRow[] = []
        const deltas: PnlRowDelta[] = []
        for (const [tag, row] of pending) {
          const update = pnlUpdateFor(baseline.get(tag), row)
          // The baseline advances whether or not anything is sent: it is what
          // this process KNOWS the wire has described, and a tag held back
          // because nothing changed is still described correctly by it.
          baseline.set(tag, row)
          if (update.kind === 'full') rows.push(row)
          else if (update.kind === 'delta') deltas.push(update.delta)
        }
        this.#sent.set(mode, baseline)
        pending.clear()
        // A flush where every held instrument ticked to the same price sends
        // NOTHING. That is the common case late in a quiet session and it is
        // the cheapest frame there is.
        if (rows.length === 0 && deltas.length === 0) continue
        this.#sendPnlDelta(mode, rows, deltas)
      }
    } catch (err) {
      this.#log('stream pnl flush failed — the tick path is unaffected', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  async close(): Promise<void> {
    if (this.#heartbeat !== null) clearInterval(this.#heartbeat)
    if (this.#pnlTimer !== null) clearInterval(this.#pnlTimer)
    for (const ws of this.#clients.keys()) ws.terminate()
    this.#clients.clear()
    this.#dirty.clear()
    this.#sent.clear()
    await new Promise<void>((resolve) => this.#wss.close(() => resolve()))
  }

  // ------------------------------------------------------------- internals

  #onMessage(ws: WebSocket, raw: string): void {
    let msg: { type?: unknown; mode?: unknown; tags?: unknown }
    try {
      msg = JSON.parse(raw) as { type?: unknown; mode?: unknown; tags?: unknown }
    } catch {
      // A malformed frame is dropped, never fatal. One bad client must not be
      // able to disconnect anything, least of all this process.
      return
    }
    if (msg.type !== 'subscribe') return
    const mode = modeOf(msg.mode)
    if (mode === null) return
    const state = this.#clients.get(ws)
    if (state === undefined) return
    // ONE mode per socket, replaced rather than accumulated: a tab shows one
    // rail, and a socket holding both is one bug away from rendering live
    // figures under the paper badge. The tag list rides alongside and cannot
    // widen this — it only narrows what P&L is sent WITHIN the mode.
    state.mode = mode
    state.tags = tagsOf(msg.tags)
    // A re-subscribe invalidates the old base: the client is about to be given
    // a different row set, so nothing may be diffed against what it used to
    // hold until the new snapshot has landed.
    state.pnlReady = false
    state.epoch++
    trySend(ws, { type: 'subscribed', mode })
    void this.#sendSnapshot(ws, state, state.epoch)
  }

  /**
   * The base every later delta is read against.
   *
   * ASYNC, and everything that can have changed while it was in flight is
   * re-checked before it goes out: the socket may have closed, or re-subscribed
   * to another mode or another tag list, and a snapshot answering a question
   * the client has withdrawn is a row set it never asked for. `epoch` is what
   * detects that.
   */
  async #sendSnapshot(ws: WebSocket, state: ClientState, epoch: number): Promise<void> {
    const provider = this.#snapshot
    if (provider === null) return
    const mode = state.mode
    if (mode === null) return
    try {
      const rows = await provider(mode)
      // No loaded book. Sending `[]` would say "this desk holds nothing", which
      // is the confident-wrong answer; the client stays on REST instead, and
      // stays out of the delta set so it can never be handed a diff with no
      // base under it.
      if (rows === null) return
      if (this.#clients.get(ws) !== state || state.epoch !== epoch) return
      if (ws.readyState !== WebSocket.OPEN) return
      trySend(ws, { type: 'pnl-snapshot', mode, rows: filterRows(rows, state.tags) })
      state.pnlReady = true
    } catch (err) {
      // The socket simply never joins the delta set. A page with no snapshot
      // keeps polling REST and says so; a throw here would be an unhandled
      // rejection in the process that routes orders.
      this.#log('stream could not build a P&L snapshot — that client stays on REST', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  /**
   * Fan one flush out, filtered per socket.
   *
   * The unfiltered text is built ONCE and reused for every socket that wants
   * the whole desk, which is the common case (the Positions page). Only a
   * socket with a narrower filter pays for its own `JSON.stringify`.
   */
  #sendPnlDelta(mode: DeskMode, rows: readonly PnlRow[], deltas: readonly PnlRowDelta[]): void {
    const all: StreamFrame = { type: 'pnl-delta', mode, rows, deltas }
    let allText: string | null = null
    for (const [ws, state] of this.#clients) {
      if (state.mode !== mode || !state.pnlReady) continue
      if (ws.readyState !== WebSocket.OPEN) continue
      if (state.tags === null) {
        allText ??= JSON.stringify(all)
        trySend(ws, all, allText)
        continue
      }
      const mine = filterRows(rows, state.tags)
      const myDeltas = deltas.filter((d) => state.tags?.has(d.tag) === true)
      if (mine.length === 0 && myDeltas.length === 0) continue
      trySend(ws, { type: 'pnl-delta', mode, rows: mine, deltas: myDeltas })
    }
  }

  #send(mode: DeskMode, frame: StreamFrame): void {
    const text = JSON.stringify(frame)
    for (const [ws, state] of this.#clients) {
      if (state.mode !== mode) continue
      if (ws.readyState !== WebSocket.OPEN) continue
      trySend(ws, frame, text)
    }
  }

  #beat(): void {
    const frame: StreamFrame = { type: 'heartbeat', ts: this.#now() }
    const text = JSON.stringify(frame)
    for (const ws of this.#clients.keys()) {
      // Sent to EVERY client, including one that has not subscribed: the
      // heartbeat says "this socket is alive", which is a fact about the
      // connection and not about a rail.
      if (ws.readyState === WebSocket.OPEN) trySend(ws, frame, text)
    }
  }
}

/**
 * The rows one socket asked for. `null` tags is every row.
 *
 * A BANDWIDTH FILTER, NOT A PERMISSION CHECK — the rows are already scoped to
 * the socket's mode by the caller, which is the boundary that matters.
 */
function filterRows(rows: readonly PnlRow[], tags: ReadonlySet<string> | null): readonly PnlRow[] {
  if (tags === null) return rows
  return rows.filter((r) => tags.has(r.tag))
}

/** A send that cannot take the process down. A dead socket is not our problem. */
function trySend(ws: WebSocket, frame: StreamFrame, text?: string): void {
  try {
    ws.send(text ?? JSON.stringify(frame))
  } catch {
    /* the socket is gone; `close` will clean it up */
  }
}

/**
 * Refuse an upgrade with a real HTTP response before the socket becomes a
 * websocket.
 *
 * A plain `socket.destroy()` gives the browser a connection reset, which its
 * console reports as a network error indistinguishable from the bridge being
 * down. A status line means "you are not signed in" arrives as itself.
 */
export function refuse(socket: Duplex, status: number, message: string): void {
  try {
    socket.write(
      `HTTP/1.1 ${status} ${message}\r\n` +
        'connection: close\r\n' +
        'content-length: 0\r\n' +
        '\r\n',
    )
  } catch {
    /* the peer is already gone */
  }
  socket.destroy()
}
