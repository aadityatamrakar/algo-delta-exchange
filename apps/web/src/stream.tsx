/**
 * The push socket, and the polling it falls back to.
 *
 * THE FALLBACK IS THE FEATURE. A polling UI fails loudly: the request errors and
 * a banner appears. A websocket fails SILENTLY — the socket dies, no error
 * fires, and the screen keeps showing the last numbers it received, which look
 * live. On a P&L display that is the same class of defect as rendering a
 * confident 0 for an unmarked leg, which this codebase already goes to lengths
 * to prevent. So every consumer here keeps polling REST, and the socket only
 * decides HOW OFTEN — and, for P&L, what moves in between.
 *
 * FOR ORDER EVENTS THE SOCKET SAYS *WHEN* AND REST SAYS *WHAT*. A pushed event
 * triggers an immediate re-fetch of the same endpoint the fallback uses, rather
 * than being merged into the table itself. Two code paths producing the order
 * log is two shapes to keep in step, and the one that drifts is the one showing
 * a fill the endpoint disagrees about.
 *
 * FOR P&L IT CARRIES THE NUMBERS, AND THAT IS A DELIBERATE EXCEPTION. Marks move
 * continuously; a nudge per tick would be ~100 REST requests a second, and the
 * old design — a complete row pushed per tick and then THROWN AWAY by
 * `onmessage` — paid full bandwidth for data nobody rendered while the LTP on
 * screen only moved on the 15s poll. So the server now sends a snapshot on
 * subscribe and coalesced field-level deltas thereafter (`apps/api/src/stream.ts`),
 * and this module merges them.
 *
 * THE MERGE ADDS NOTHING AND DERIVES NOTHING. Every figure applied here was
 * computed by `rollup.ts`/`pnlFromFills` on the server. There is no arithmetic
 * in this file: no `mtm`, no `total`, no `unrealised` is ever calculated in the
 * browser. A second implementation of that arithmetic is a second thing to get
 * wrong, and it cost a live bug to get right once already (`439fa6f5`).
 *
 * AN OMITTED DELTA FIELD MEANS UNCHANGED; AN EXPLICIT `null` MEANS UNKNOWN. They
 * are opposite claims and `mergeRow` distinguishes them with `hasOwnProperty`,
 * not with `!== undefined`. Collapse them and a leg the feed can no longer price
 * keeps displaying its last known mark as though it were live — the single most
 * dangerous thing this UI can do.
 *
 * REST STAYS THE BACKSTOP. `useLivePnl` keeps polling and DISCARDS the whole
 * accumulated overlay each time a response lands, so any drift self-heals within
 * one poll. That is why `LIVE_POLL_MS` is not raised and the poll is not turned
 * off.
 *
 * IT IS READ-ONLY. Nothing is ever sent up this socket but the mode filter and a
 * tag hint. Orders, flattens and the kill switch stay on HTTP, where a failure
 * is visible and retryable.
 *
 * THE HEARTBEAT IS WHY THE WATCHDOG EXISTS. A dropped NAT mapping leaves a
 * half-open TCP connection: no `close` event ever fires and the page believes it
 * is live forever. The server sends a frame every 15s precisely so that silence
 * becomes evidence; if none arrives for `STALE_MS` the socket is closed on
 * purpose, which puts the page back on polling AND on screen.
 *
 * ONE SOCKET PER (TAB, MODE), SHARED AND REFERENCE-COUNTED. Every hook instance
 * used to call `new WebSocket` in its own effect, so a page with a streamed
 * order log and streamed P&L cards held three or four connections, each with its
 * own subscribe, heartbeat and reconnect backoff. The server caps concurrent
 * sockets at 50 and refuses beyond it with a 503, so a handful of open tabs
 * would have started degrading real users. The connection now lives in this
 * module, keyed by mode: the first consumer opens it, the last one closes it.
 *
 * THE MODE IS STILL THE KEY, NOT A MESSAGE. Switching the navbar acquires a
 * DIFFERENT connection and releases the old one, which is what makes it
 * structurally impossible for a frame published for the rail you just left to be
 * rendered under the rail you are now on. The per-frame `frame.mode !== mode`
 * check stays as the second line of defence.
 */

import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { Banner } from '@astryxdesign/core/Banner'
import { API_BASE, api, type DeskMode, type LegQuote, type PnlLeg, type PnlResponse, type PnlStrategy } from './api.ts'
import { usePoll } from './shell.tsx'

const STREAM_PATH = '/v1/desk/stream'

/** The existing REST cadence. What the page falls back to, and says it has. */
export const FALLBACK_POLL_MS = 10_000

/**
 * REST is still polled while the socket is up — just less often.
 *
 * Not `0`/never: the socket carries order events and P&L deltas, and a figure
 * that changed for any other reason (a switch flipped in another tab, a
 * strategy registered a moment ago, a delta this page never received) would
 * otherwise sit stale on screen. This is the floor under everything the push
 * does not cover, and it is what makes accumulated delta drift self-healing
 * rather than permanent.
 *
 * IT IS 15s, NOT THE 60s IT SHIPPED AS, and the reason is the failure this
 * whole module exists to prevent.
 *
 * `connected` proves the SOCKET is alive — the subscribe ack and the
 * heartbeats. It does not prove the PRODUCER is. Live order events reach the
 * socket only through the gateway's best-effort notify, which is deliberately
 * silent about its own failures (`notify.ts`: swallow, log once a minute,
 * never block an order). So a `DESK_API_TOKEN` mismatch, a notifier disabled at
 * gateway boot, or a firewall between the two processes leaves heartbeats
 * flowing, the watchdog quiet, `degraded` false — and fills arriving up to a
 * MINUTE late with no banner, during live trading.
 *
 * That is "looks live while stale", which is exactly what the fallback
 * indicator exists to make impossible, and at 60s it was WORSE than the 10s
 * poll this replaced. Until the heartbeat can carry proof of the producer
 * (last live event seen), the floor stays close enough that a dead notifier
 * costs latency rather than a wrong screen.
 */
export const LIVE_POLL_MS = 15_000

/** No frame for this long means the socket is dead whatever the browser thinks. */
const STALE_MS = 45_000

/** Reconnect backoff. Capped, so a bridge that is down is retried politely. */
const RETRY_MIN_MS = 1000
const RETRY_MAX_MS = 15_000

/**
 * How long a change of interest waits before it is sent.
 *
 * Every re-subscribe costs a full snapshot from the server, and navigating
 * between strategy pages changes the tag union on every hop. Coalescing them
 * means walking through five strategies costs one snapshot, not five.
 */
const RESUBSCRIBE_MS = 50

/** One order event, exactly as `apps/api/src/stream.ts` puts it on the wire. */
export interface StreamOrderEvent {
  clientOrderId: string
  phase: string
  ok: boolean
  tag: string
  tradingsymbol: string
  ts: number
  /** Null, NEVER 0 — see `stream.ts`. An unknown renders as an em dash. */
  side: string | null
  filledQty: number | null
  avgPrice: number | null
  status: string | null
  error: string | null
  detail: Record<string, unknown> | null
}

interface OrderFrame {
  type: 'order'
  mode: DeskMode
  event: StreamOrderEvent
}

/**
 * One leg's moving parts, as the server diffed them.
 *
 * A FIELD THAT IS ABSENT IS UNCHANGED. A field that is present is
 * authoritative — including `null`, which means the feed can no longer price
 * this leg and the cell must show an em-dash rather than the last price it had.
 */
export interface PnlLegDelta {
  tradingsymbol: string
  mark?: number | null
  unrealised?: number | null
  mtm?: number | null
  /**
   * The pair behind the mark, when it moved. `null` means the book can no
   * longer answer for this leg — same absent-vs-null rule as `mark`.
   */
  quote?: LegQuote | null
}

/** One strategy row's moving parts. Same absent-means-unchanged rule. */
export interface PnlRowDelta {
  tag: string
  unrealised?: number | null
  total?: number | null
  complete?: boolean
  unpriced?: string[]
  /** Only the legs that moved. */
  legs?: PnlLegDelta[]
}

/** The complete row set for a mode and filter. It REPLACES, it does not merge. */
interface PnlSnapshotFrame {
  type: 'pnl-snapshot'
  mode: DeskMode
  rows: PnlStrategy[]
}

/**
 * One coalesced flush. `rows` are whole rows (a fill moved something a tick
 * cannot) and upsert by tag; `deltas` are field diffs.
 */
interface PnlDeltaFrame {
  type: 'pnl-delta'
  mode: DeskMode
  rows: PnlStrategy[]
  deltas: PnlRowDelta[]
}

type Frame =
  | OrderFrame
  | PnlSnapshotFrame
  | PnlDeltaFrame
  | { type: 'subscribed'; mode: DeskMode }
  | { type: 'heartbeat'; ts: number }

export function streamUrl(): string {
  // `https:` -> `wss:` by the same substitution. Derived from `API_BASE` so the
  // socket goes to the same host the cookie was set on.
  return `${API_BASE.replace(/^http/, 'ws')}${STREAM_PATH}`
}

export interface DeskStreamState {
  /** True only once the server has ACKNOWLEDGED the subscription. */
  connected: boolean
  /** Increments on every pushed ORDER event. Consumers re-fetch when it changes. */
  nudge: number
  /** The last order event pushed for this mode, or null. */
  last: StreamOrderEvent | null
  /**
   * Server-computed rows by tag: the snapshot with every delta since applied.
   * Empty until one arrives, and emptied whenever the socket goes — a stale
   * merged number must never outlive the connection that made it look live.
   */
  pnl: Readonly<Record<string, PnlStrategy>>
}

/**
 * What one consumer wants P&L for.
 *
 * `'none'` is not the same as an empty list of tags — it is what a consumer
 * that renders no P&L at all (an order log, via `useStreamedPoll`) contributes
 * to the union, and it is why such a consumer is sent nothing on this channel.
 */
export type PnlInterest = 'none' | 'all' | readonly string[]

// ------------------------------------------------ the shared connection

/**
 * The frames merged into state, and the plumbing that keeps one socket alive
 * for as long as at least one consumer wants it.
 *
 * `state` is REPLACED rather than mutated on every change, because
 * `useSyncExternalStore` compares snapshots by identity — mutating it in place
 * would make React skip the render that was the point of the frame.
 */
interface Conn {
  readonly mode: DeskMode
  ws: WebSocket | null
  refs: number
  attempt: number
  lastFrameAt: number
  retry: ReturnType<typeof setTimeout> | null
  watch: ReturnType<typeof setInterval> | null
  resubscribe: ReturnType<typeof setTimeout> | null
  /** consumer id -> what it wants. The union of these is what we subscribe to. */
  readonly interests: Map<number, PnlInterest>
  /** The last subscribe frame sent, so an unchanged union costs nothing. */
  sent: string | null
  readonly listeners: Set<() => void>
  state: DeskStreamState
}

const EMPTY_PNL: Readonly<Record<string, PnlStrategy>> = Object.freeze({})

const conns = new Map<DeskMode, Conn>()
let nextConsumerId = 1

function connFor(mode: DeskMode): Conn {
  const existing = conns.get(mode)
  if (existing !== undefined) return existing
  const conn: Conn = {
    mode,
    ws: null,
    refs: 0,
    attempt: 0,
    lastFrameAt: Date.now(),
    retry: null,
    watch: null,
    resubscribe: null,
    interests: new Map(),
    sent: null,
    listeners: new Set(),
    state: { connected: false, nudge: 0, last: null, pnl: EMPTY_PNL },
  }
  conns.set(mode, conn)
  return conn
}

function patch(conn: Conn, next: Partial<DeskStreamState>): void {
  conn.state = { ...conn.state, ...next }
  for (const l of [...conn.listeners]) l()
}

/**
 * The union of every live consumer's interest.
 *
 * `'all'` wins outright: a page rendering the whole desk needs every tag, and
 * intersecting it with a narrower consumer would starve it. An empty set is a
 * real answer — nobody wants P&L — and the server honours it as "send none".
 */
function unionOf(conn: Conn): 'all' | ReadonlySet<string> {
  const out = new Set<string>()
  for (const want of conn.interests.values()) {
    if (want === 'all') return 'all'
    if (want === 'none') continue
    for (const tag of want) out.add(tag)
  }
  return out
}

/**
 * Tell the server what this socket wants, if it has changed.
 *
 * Sent on open and whenever the union moves. `tags` is OMITTED for `'all'`,
 * because absent means every tag on the wire — and present-but-empty means
 * none, which is what a tab with no P&L consumer sends.
 */
function sendSubscribe(conn: Conn): void {
  const ws = conn.ws
  if (ws === null) return
  const want = unionOf(conn)
  const frame = want === 'all'
    ? { type: 'subscribe', mode: conn.mode }
    : { type: 'subscribe', mode: conn.mode, tags: [...want].sort() }
  const text = JSON.stringify(frame)
  if (text === conn.sent) return
  conn.sent = text
  try {
    ws.send(text)
  } catch {
    // The socket died between open and send; `onclose` will retry, and the
    // reopen clears `sent` so the subscribe is sent again rather than skipped.
    conn.sent = null
  }
}

function scheduleSubscribe(conn: Conn): void {
  if (conn.resubscribe !== null) return
  conn.resubscribe = setTimeout(() => {
    conn.resubscribe = null
    sendSubscribe(conn)
  }, RESUBSCRIBE_MS)
}

/** `hasOwnProperty`, because "absent" and "present and null" are opposite claims. */
function has(o: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, key)
}

/**
 * Apply one leg diff.
 *
 * `?? null` rather than a cast: the field is only read when the key is present,
 * and a present key off the wire is `number` or `null`. Writing it this way
 * makes an accidental `undefined` land as the em-dash rather than as a stale
 * number, which is the safe direction for this particular mistake.
 */
function mergeLeg(base: PnlLeg, d: PnlLegDelta): PnlLeg {
  const out: PnlLeg = { ...base }
  if (has(d, 'mark')) out.mark = d.mark ?? null
  if (has(d, 'unrealised')) out.unrealised = d.unrealised ?? null
  if (has(d, 'mtm')) out.mtm = d.mtm ?? null
  return out
}

/**
 * Apply one row diff to the row the client already holds.
 *
 * EVERYTHING NOT MENTIONED IS CARRIED THROUGH UNTOUCHED — `realised`, `qty`,
 * `avgCost`, the buy/sell figures, `openLegs`, `label`. The server does not send
 * them on a tick because a tick cannot change them; when a fill does change
 * them it sends the whole row instead, which lands in `rows` and replaces this
 * outright.
 *
 * A leg named in the diff but absent from the base is DROPPED rather than
 * invented: a leg with no `qty` or `avgCost` is not a position, and rendering
 * one would put a row on the positions table that nothing traded.
 */
export function mergeRow(base: PnlStrategy, d: PnlRowDelta): PnlStrategy {
  const out: PnlStrategy = { ...base }
  if (has(d, 'unrealised')) out.unrealised = d.unrealised ?? null
  if (has(d, 'total')) out.total = d.total ?? null
  if (has(d, 'complete')) out.complete = d.complete === true
  if (has(d, 'unpriced')) out.unpriced = [...(d.unpriced ?? [])]
  const legs = d.legs
  if (legs !== undefined && legs.length > 0) {
    const byName = new Map(legs.map((l) => [l.tradingsymbol, l]))
    out.legs = base.legs.map((l) => {
      const hit = byName.get(l.tradingsymbol)
      return hit === undefined ? l : mergeLeg(l, hit)
    })
    // The row-level quote map follows the same authority rule as the leg
    // fields: a present `quote` replaces (null deletes), an absent one leaves
    // the held pair untouched.
    let quotes: Record<string, LegQuote> | undefined
    for (const l of legs) {
      if (!has(l, 'quote')) continue
      quotes ??= { ...(base.quotes ?? {}) }
      if (l.quote === null || l.quote === undefined) delete quotes[l.tradingsymbol]
      else quotes[l.tradingsymbol] = l.quote
    }
    if (quotes !== undefined) out.quotes = quotes
  }
  return out
}

/**
 * Fold one flush into the overlay.
 *
 * A delta for a tag the client has no base for is IGNORED, not partially
 * applied. It happens legitimately — a strategy that first traded after this
 * socket's snapshot — and the next REST poll or re-subscribe brings the whole
 * row. Half a row on a P&L table is worse than a row that is 15 seconds late.
 */
function applyDelta(
  prev: Readonly<Record<string, PnlStrategy>>,
  frame: PnlDeltaFrame,
): Readonly<Record<string, PnlStrategy>> {
  const next: Record<string, PnlStrategy> = { ...prev }
  for (const row of frame.rows) next[row.tag] = row
  for (const d of frame.deltas) {
    const base = next[d.tag]
    if (base === undefined) continue
    next[d.tag] = mergeRow(base, d)
  }
  return next
}

function onFrame(conn: Conn, raw: string): void {
  conn.lastFrameAt = Date.now()
  let frame: Frame
  try {
    frame = JSON.parse(raw) as Frame
  } catch {
    return
  }
  if (frame.type === 'subscribed') {
    conn.attempt = 0
    if (!conn.state.connected) patch(conn, { connected: true })
    return
  }
  if (frame.type === 'heartbeat') return
  // Belt and braces. The server filters per socket; this is the second check,
  // because "live figures under a PAPER badge" is the one bug worth paying two
  // lines for. It is the SECURITY check — the tag filter beside it is only
  // bandwidth and is never allowed to stand in for this.
  if (frame.mode !== conn.mode) return
  if (frame.type === 'order') {
    patch(conn, { last: frame.event, nudge: conn.state.nudge + 1 })
    return
  }
  if (frame.type === 'pnl-snapshot') {
    // REPLACES. A row missing from a snapshot is a row that is gone, and
    // merging would keep a position on screen after it closed.
    const rows: Record<string, PnlStrategy> = {}
    for (const r of frame.rows) rows[r.tag] = r
    patch(conn, { pnl: rows })
    return
  }
  if (frame.type === 'pnl-delta') {
    patch(conn, { pnl: applyDelta(conn.state.pnl, frame) })
  }
}

function open(conn: Conn): void {
  if (conn.refs === 0) return
  let ws: WebSocket
  try {
    ws = new WebSocket(streamUrl())
  } catch {
    // A browser that refuses to construct it at all (a bad URL, a blocked
    // mixed-content upgrade). Polling continues; there is nothing to fix from
    // here, so it is retried like any other failure.
    schedule(conn)
    return
  }
  conn.ws = ws
  conn.sent = null
  conn.lastFrameAt = Date.now()

  ws.onopen = (): void => {
    // Subscribed EXPLICITLY, and SYNCHRONOUSLY rather than on the debounce: the
    // server sends nothing to a socket that has not named a rail, so a page
    // that waited 50ms to say so would spend 50ms unable to receive anything.
    sendSubscribe(conn)
  }
  ws.onmessage = (ev: MessageEvent): void => {
    if (conn.ws !== ws) return
    onFrame(conn, String(ev.data))
  }
  ws.onerror = (): void => {
    // Never surfaced as a page error: a socket that will not open is a
    // degradation the banner already describes, and a red banner per reconnect
    // attempt would train the operator to ignore all of them.
    try {
      ws.close()
    } catch {
      /* already closing */
    }
  }
  ws.onclose = (): void => {
    if (conn.ws !== ws) return
    conn.ws = null
    conn.sent = null
    // THE OVERLAY GOES WITH THE SOCKET. Merged numbers that outlived the
    // connection would sit on screen looking live while nothing was updating
    // them — the exact failure the fallback notice exists to prevent.
    patch(conn, { connected: false, pnl: EMPTY_PNL })
    schedule(conn)
  }
}

function schedule(conn: Conn): void {
  if (conn.refs === 0 || conn.retry !== null) return
  const wait = Math.min(RETRY_MIN_MS * 2 ** conn.attempt, RETRY_MAX_MS)
  conn.attempt += 1
  conn.retry = setTimeout(() => {
    conn.retry = null
    open(conn)
  }, wait)
}

/**
 * The watchdog. A half-open socket fires no `close`, so without this the page
 * would sit on numbers that stopped updating while still claiming to be live.
 */
function startWatch(conn: Conn): void {
  if (conn.watch !== null) return
  conn.watch = setInterval(() => {
    const ws = conn.ws
    if (ws === null) return
    if (Date.now() - conn.lastFrameAt < STALE_MS) return
    patch(conn, { connected: false, pnl: EMPTY_PNL })
    try {
      ws.close()
    } catch {
      /* it is already gone; the reconnect below still runs */
    }
    schedule(conn)
  }, 5000)
}

function acquire(mode: DeskMode): Conn {
  const conn = connFor(mode)
  conn.refs += 1
  if (conn.refs === 1) {
    conn.attempt = 0
    startWatch(conn)
    open(conn)
  }
  return conn
}

function release(mode: DeskMode): void {
  const conn = conns.get(mode)
  if (conn === undefined) return
  conn.refs -= 1
  if (conn.refs > 0) return
  conn.refs = 0
  if (conn.retry !== null) clearTimeout(conn.retry)
  if (conn.watch !== null) clearInterval(conn.watch)
  if (conn.resubscribe !== null) clearTimeout(conn.resubscribe)
  conn.retry = null
  conn.watch = null
  conn.resubscribe = null
  const ws = conn.ws
  conn.ws = null
  if (ws !== null) {
    // Detached before closing: an `onclose` firing here would schedule a
    // reconnect for a connection nobody is holding.
    ws.onclose = null
    ws.onmessage = null
    ws.onerror = null
    ws.onopen = null
    try {
      ws.close()
    } catch {
      /* nothing to do */
    }
  }
  conns.delete(mode)
}

/**
 * Re-base the overlay on a fresh REST response.
 *
 * This is how "REST replaces the merged state wholesale" is implemented: a
 * fresh `GET /v1/desk/pnl` is authoritative for every field of every row, so
 * the deltas layered on the previous one are discarded. Any drift is bounded by
 * one poll instead of accumulating for as long as the tab is open.
 *
 * IT RE-SEEDS RATHER THAN CLEARS, and the difference is the whole feature.
 *
 * A delta carries only what moved, so `applyDelta` needs a base row to fold it
 * into and IGNORES one it has no base for — correctly, because half a row on a
 * P&L table is worse than a row that is a poll late. The only thing that ever
 * created a base was the `pnl-snapshot`, sent ONCE when the socket subscribes.
 * So clearing the overlay here did not merely discard drift, it destroyed the
 * base every later delta needed: the first poll after connecting silently
 * switched the page back to pure 15-second REST for the rest of its life. On
 * screen that is a P&L that updates for a few seconds after load and then
 * freezes — which is exactly what it did.
 *
 * Seeding from the response keeps both properties: REST is still authoritative
 * for every field, and the deltas that follow still have something to apply to.
 */
function resetPnl(mode: DeskMode, rows: readonly PnlStrategy[] | undefined): void {
  const conn = conns.get(mode)
  if (conn === undefined) return
  /**
   * `rows` IS TYPED NON-NULL AND CHECKED ANYWAY. `PnlResponse.strategies` is
   * declared as an array, so this cannot be undefined as far as the compiler is
   * concerned — but it is parsed from the network, and a truncated or errored
   * body deserialises into whatever it deserialises into. Iterating that threw
   * inside an effect and took the WHOLE STRATEGY PAGE down to a blank div; a
   * P&L overlay failing to re-base must degrade to "no overlay", never to "no
   * page". The type is a statement about the happy path, not a guarantee about
   * the wire.
   */
  if (!Array.isArray(rows)) return
  const next: Record<string, PnlStrategy> = {}
  for (const row of rows) next[row.tag] = row
  patch(conn, { pnl: next })
}

/** Stable across renders, so the effect that registers interest does not thrash. */
function interestKey(want: PnlInterest): string {
  if (want === 'none') return 'none'
  if (want === 'all') return '*'
  return `#${[...want].sort().join(',')}`
}

function interestFrom(key: string): PnlInterest {
  if (key === 'none') return 'none'
  if (key === '*') return 'all'
  return key.slice(1).split(',').filter((t) => t !== '')
}

// -------------------------------------------------------------- the hooks

/**
 * Join the shared socket for ONE mode.
 *
 * `want` names the tags this consumer needs P&L for; the connection subscribes
 * to the UNION of what its consumers want, so a page showing one strategy
 * beside a page-wide order log does not pull the whole desk.
 *
 * A CONSUMER STILL FILTERS WHAT IT RENDERS. A union subscription means rows for
 * tags this consumer did not ask for arrive legitimately, and a strategy page
 * that rendered whatever turned up would show another strategy's numbers.
 */
export function useDeskStream(mode: DeskMode, want: PnlInterest = 'none'): DeskStreamState {
  const key = interestKey(want)
  // One identity per hook instance, so two consumers of the same mode are two
  // entries in the union rather than one overwriting the other.
  const id = useRef(0)
  if (id.current === 0) id.current = nextConsumerId++

  const subscribe = useCallback(
    (onChange: () => void): (() => void) => {
      const conn = acquire(mode)
      conn.listeners.add(onChange)
      return () => {
        conn.listeners.delete(onChange)
        release(mode)
      }
    },
    [mode],
  )
  const snapshot = useCallback((): DeskStreamState => connFor(mode).state, [mode])

  useEffect(() => {
    const conn = connFor(mode)
    conn.interests.set(id.current, interestFrom(key))
    scheduleSubscribe(conn)
    const consumer = id.current
    return () => {
      const live = conns.get(mode)
      if (live === undefined) return
      live.interests.delete(consumer)
      scheduleSubscribe(live)
    }
  }, [mode, key])

  return useSyncExternalStore(subscribe, snapshot, snapshot)
}

export interface StreamedPoll<T> {
  data: T | null
  error: string | null
  /** True while the page is on REST polling. Render `<LiveFeedNotice />`. */
  degraded: boolean
  refresh: () => void
}

/**
 * `usePoll`, accelerated by the socket.
 *
 * Identical in shape to `usePoll` plus `degraded`, so adopting it at a call
 * site is one line and abandoning it is one line back. The REST call it is
 * given is unchanged and remains the only source of what is rendered.
 *
 * IT ASKS FOR NO P&L. This is the order-event path; a consumer that renders no
 * P&L must contribute nothing to the tag union, or an order log would keep
 * pulling every strategy's marks for a table that has no column for them.
 */
export function useStreamedPoll<T>(
  fn: () => Promise<T>,
  mode: DeskMode,
  deps: readonly unknown[] = [],
): StreamedPoll<T> {
  const { connected, nudge } = useDeskStream(mode, 'none')
  // `nudge` in the dependency list is what turns a pushed event into an
  // immediate re-fetch; `connected` is what drops the cadence back to 10s the
  // moment the socket goes.
  const polled = usePoll(fn, connected ? LIVE_POLL_MS : FALLBACK_POLL_MS, [
    ...deps,
    connected,
    nudge,
  ])
  return { ...polled, degraded: !connected }
}

export interface LivePnl {
  /** The REST response with live rows merged in, or null before the first read. */
  data: PnlResponse | null
  error: string | null
  degraded: boolean
  refresh: () => void
}

/**
 * `GET /v1/desk/pnl`, with the socket's live marks merged over it.
 *
 * `tags` narrows what this consumer asks the socket for; omit it to ask for the
 * whole desk (which is what the Positions page needs, since it renders every
 * strategy). THE REST CALL IS UNCHANGED either way — it still fetches every
 * strategy and the caller still picks out its own. Narrowing that is a separate,
 * more invasive change.
 *
 * WHAT COMES FROM WHERE:
 *   - the LIST of strategies, and every field of any tag the socket has not
 *     spoken about, is REST's;
 *   - a tag the socket has a row for is served from that row, which is a
 *     server-computed `PnlRow` at most one flush old;
 *   - `totals` is REST's, ALWAYS. The socket pushes rows, not desk totals, and
 *     re-summing them here would be exactly the browser-side P&L arithmetic this
 *     module refuses to do. It is at most `LIVE_POLL_MS` behind, which is what
 *     the `totals are partial` badge has always been.
 *
 * WHEN THE SOCKET IS DOWN THE OVERLAY IS NOT USED AT ALL. `degraded` is true,
 * the notice goes up, the poll speeds back to 10s, and the figures on screen are
 * REST's — stale-but-labelled, never stale-looking-live.
 */
export function useLivePnl(mode: DeskMode, tags?: readonly string[]): LivePnl {
  const want: PnlInterest = tags === undefined ? 'all' : tags
  const { connected, pnl } = useDeskStream(mode, want)
  /**
   * NO `nudge` IN THE DEPENDENCIES, unlike `useStreamedPoll`.
   *
   * An order event would re-fetch the whole desk's P&L, and it does not need
   * to: a fill re-marks the book immediately (`LiveBook.onJournal`) and the
   * fields only a fill can move arrive as a WHOLE row on the next flush. Adding
   * the nudge here would put a full P&L fetch behind every fill during a busy
   * open, for a number the socket already delivered.
   */
  const polled = usePoll(() => api.pnl(mode), connected ? LIVE_POLL_MS : FALLBACK_POLL_MS, [
    mode,
    connected,
  ])

  // The backstop. Each REST response is authoritative for every field, so it
  // REPLACES the base the deltas are folded into — see `resetPnl`, which
  // re-seeds rather than clears precisely so the deltas after it still land.
  useEffect(() => {
    if (polled.data !== null) resetPnl(mode, polled.data.strategies)
  }, [polled.data, mode])

  const data = useMemo<PnlResponse | null>(() => {
    const base = polled.data
    if (base === null || !connected) return base
    let live = false
    const strategies = base.strategies.map((s) => {
      const pushed = pnl[s.tag]
      if (pushed === undefined) return s
      live = true
      return pushed
    })
    return live ? { ...base, strategies } : base
  }, [polled.data, pnl, connected])

  return { data, error: polled.error, degraded: !connected, refresh: polled.refresh }
}

/**
 * The notice. NOT OPTIONAL POLISH.
 *
 * It states the cadence in seconds rather than saying "reconnecting", because
 * the question an operator has in front of a live P&L is "how old is this
 * number, at worst?" — and a silent socket answers that question wrongly by
 * saying nothing at all.
 */
export function LiveFeedNotice(props: { intervalMs?: number }): React.ReactElement {
  const seconds = Math.round((props.intervalMs ?? FALLBACK_POLL_MS) / 1000)
  return (
    <Banner
      status="warning"
      title={`Live feed down — updating every ${seconds}s`}
      description="Reconnecting in the background. The figures below are still being refreshed over the API."
    />
  )
}
