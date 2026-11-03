/**
 * EXCHANGE-RESIDENT BACKSTOPS — the stop that is still there when the desk is not.
 *
 * Every stop the desk runs is decided inside the desk (dx-supervisor → dx-api →
 * dx-gateway). If a process or the box dies mid-pyramid, nothing rests on
 * Delta and the account is a set of naked short straddles with no stop. So for
 * every short option leg a book holds on a Delta rail (live, and the demo rail
 * so testnet exercises it), one reduce-only BUY STOP-LIMIT rests on Delta:
 *
 *   stop_order_type     stop_loss_order
 *   stop_trigger_method mark_price
 *   stop_price          the book's straddle stop line S for that leg's group,
 *                       S = (ceEntry + peEntry) × bs_stop_mult (basis 0
 *                       truncates, as the desk does), rounded UP to the tick
 *   limit_price         S × (1 + DX_BACKSTOP_LIMIT_PCT), up to the tick
 *                       (default 0.5 — market orders on options are unconfirmed)
 *   size                the contracts the book holds, never more than Delta's
 *                       short on that contract (reduce-only can never open)
 *
 * WHY S ON ONE LEG CAN NEVER FIRE BEFORE THE DESK'S OWN STOP. The desk stops a
 * straddle when CE + PE exit prices reach S. A single leg's mark at S already
 * puts the sum past S (the other leg is worth ≥ 0), so the backstop is
 * strictly later — it is the floor under the desk, not a second stop.
 *
 * THE LOOP (`run`, every ~15 s and shortly after each desk fill) is a pure
 * diff, `planBackstops`: the desired set from the desk's own records (registry
 * dials, supervisor groups, held legs — `deskBooksFrom`), the actual set from
 * Delta's open orders carrying the backstop id prefix. Missing → placed,
 * changed (size or stop) → edited, orphaned → cancelled, so a leftover
 * reduce-only stop can never hit a future position. Anything it cannot read
 * means it changes NOTHING that pass: an orphan sweep on missing data would
 * cancel every backstop exactly when something is already wrong.
 *
 * IDS. `bkstp` + a hash of (rail, book, contract): 32 chars, deterministic, and
 * never a desk id — `dxClientOrderId` passes a desk id through only when it is
 * ≤ 32 chars of `[A-Za-z0-9_-]` (desk ids carry `|`) and otherwise hashes it to
 * `h…`. The broker sweep and the fill watcher are told to leave these alone.
 *
 * THE DEAD-MAN SWITCH IS RETIRED while this runs: on testnet its
 * `cancel_orders` cancelled an untriggered stop (`dx-heartbeat.ts`).
 *
 * NEVER THROWS out of `run`; failures are logged and alerted (`desk-alerts`).
 */
import type { PlacedOrder } from '@algomaker/brokers'
import { backstopClientOrderId, isBackstopOrderId, type DxOrder, type DxOrderRequest, type DxPosition, type DxRest } from '@algomaker/dx'

export { DX_BACKSTOP_PREFIX, backstopClientOrderId, isBackstopOrderId } from '@algomaker/dx'
import { createDxHeartbeat, retireDxHeartbeat, DX_HEARTBEAT_MS } from './dx-heartbeat.ts'

type Env = Readonly<Record<string, string | undefined>>

/** The reconcile cadence. */
export const DX_BACKSTOP_MS = 15_000
/** How long after a desk fill the next reconcile runs: desk-books lags the fill by a few seconds. */
export const DX_BACKSTOP_NUDGE_MS = 3_000
export const DEFAULT_BACKSTOP_LIMIT_PCT = 0.5
/** BTC options tick (delta-api-reference.md §6). */
export const DX_OPTION_TICK = 0.1
/** A Delta short no book accounts for is alerted once it has lasted this long. */
export const DEFAULT_UNPROTECTED_GRACE_MS = 60_000

export type BackstopRail = 'live' | 'demo'
export type BookRail = BackstopRail | 'sim'

/** `DX_BACKSTOP`: on unless exactly `0`. */
export function backstopEnabled(env: Env): boolean {
  return env['DX_BACKSTOP'] !== '0'
}

/** `DX_BACKSTOP_LIMIT_PCT`: how far above the stop the stop-limit may pay. A typo stops the boot. */
export function backstopLimitPct(env: Env): number {
  const raw = env['DX_BACKSTOP_LIMIT_PCT']
  if (raw === undefined || raw.trim() === '') return DEFAULT_BACKSTOP_LIMIT_PCT
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`DX_BACKSTOP_LIMIT_PCT='${raw}' is not a positive number — the backstop will not guess its limit`)
  }
  return n
}

// ------------------------------------------------------------- desk view

export interface BackstopGroup {
  readonly strike: number
  readonly ceEntry: number
  readonly peEntry: number
  readonly ceOpen: boolean
  readonly peOpen: boolean
}

export interface BackstopLeg {
  readonly symbol: string
  readonly strike: number
  readonly optType: 'CE' | 'PE'
  /** Short contracts held. */
  readonly contracts: number
  readonly entryPrice: number
}

export interface DeskBookView {
  readonly tag: string
  readonly mode: 'paper' | 'live'
  readonly rail: BookRail
  /** `bs_stop_mult`; null when the book has none (not a BULL-S book, or a bad row). */
  readonly stopMult: number | null
  readonly stopBasis: number
  readonly groups: readonly BackstopGroup[]
  readonly legs: readonly BackstopLeg[]
}

type Doc = Record<string, unknown>
const obj = (v: unknown): Doc | null => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Doc) : null)
const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/**
 * The rail a book's legs are on. Live is live. A paper book is where its legs
 * were opened (`dx_rail_used`, stamped by the gateway), else its setting —
 * which defaults to demo exactly as the gateway's router does.
 */
export function bookRailOf(row: Doc): BookRail {
  if (row['mode'] === 'live') return 'live'
  if (row['mode'] !== 'paper') return 'sim'
  const used = row['dx_rail_used']
  if (used === 'demo' || used === 'sim') return used
  return row['dx_paper_rail'] === 'sim' ? 'sim' : 'demo'
}

/** Registry rows + `desk-supervisor-state` rows + `desk-books` rows → one view per book. */
export function deskBooksFrom(registry: readonly Doc[], states: readonly Doc[], books: readonly Doc[]): DeskBookView[] {
  const stateBy = new Map<string, Doc>()
  for (const s of states) if (typeof s['key'] === 'string') stateBy.set(s['key'], s)
  const booksBy = new Map<string, Doc>()
  for (const b of books) if (typeof b['tag'] === 'string') booksBy.set(`${b['tag']}:${String(b['mode'])}`, b)
  const out: DeskBookView[] = []
  for (const r of registry) {
    const tag = r['tag']
    const mode = r['mode']
    if (typeof tag !== 'string' || (mode !== 'paper' && mode !== 'live')) continue
    const dials = obj(r['dials']) ?? {}
    const mult = dials['bs_stop_mult']
    const basis = dials['bs_stop_basis']
    const bs = obj(obj(stateBy.get(`${tag}:${mode}`)?.['ruleState'])?.['bs'])
    const groups: BackstopGroup[] = []
    for (const g of Array.isArray(bs?.['groups']) ? (bs['groups'] as unknown[]) : []) {
      const o = obj(g)
      if (o === null || !fin(o['strike']) || !fin(o['ceEntry']) || !fin(o['peEntry'])) continue
      groups.push({ strike: o['strike'], ceEntry: o['ceEntry'], peEntry: o['peEntry'], ceOpen: o['ceOpen'] === true, peOpen: o['peOpen'] === true })
    }
    const legs: BackstopLeg[] = []
    const rawLegs = booksBy.get(`${tag}:${mode}`)?.['legs']
    for (const l of Array.isArray(rawLegs) ? (rawLegs as unknown[]) : []) {
      const o = obj(l)
      const inst = obj(o?.['instrument'])
      if (o === null || inst === null) continue
      const symbol = inst['tradingsymbol']
      const lot = inst['lotSize']
      const qty = o['qty']
      const type = o['type']
      if (typeof symbol !== 'string' || !fin(lot) || lot <= 0 || !fin(qty) || qty >= 0) continue
      if (type !== 'CE' && type !== 'PE') continue
      const contracts = Math.round(-qty / lot)
      if (contracts <= 0 || !fin(o['strike'])) continue
      legs.push({ symbol, strike: o['strike'], optType: type, contracts, entryPrice: fin(o['entryPrice']) ? o['entryPrice'] : 0 })
    }
    out.push({
      tag,
      mode,
      rail: bookRailOf(r),
      stopMult: fin(mult) && mult > 0 ? mult : null,
      stopBasis: fin(basis) ? basis : 1,
      groups,
      legs,
    })
  }
  return out
}

/** Read the three collections the view is built from. Throws on a failed read — `run` then changes nothing. */
export async function readDeskBooks(db: { collection(name: string): unknown }): Promise<DeskBookView[]> {
  const all = async (name: string, projection: Doc): Promise<Doc[]> =>
    (await (db.collection(name) as { find(q: Doc, o: Doc): { toArray(): Promise<Doc[]> } }).find({}, { projection }).toArray())
  const [registry, states, books] = await Promise.all([
    all('desk-books-registry', { tag: 1, mode: 1, dials: 1, dx_paper_rail: 1, dx_rail_used: 1 }),
    all('desk-supervisor-state', { key: 1, 'ruleState.bs.groups': 1 }),
    all('desk-books', { tag: 1, mode: 1, legs: 1 }),
  ])
  return deskBooksFrom(registry, states, books)
}

// ------------------------------------------------------------- stop line

const EPS = 1e-6
const sameStrike = (a: number, b: number): boolean => Math.abs(a - b) < EPS

function decimalsOf(tick: number): number {
  const s = String(tick)
  const i = s.indexOf('.')
  return i < 0 ? 0 : s.length - i - 1
}

/** Up to the tick, with float noise forgiven (4737.5000001 stays 4737.5). */
function ceilTick(x: number, tick: number): number {
  const d = decimalsOf(tick)
  return Number((Math.ceil(Number((x / tick).toFixed(6))) * tick).toFixed(d))
}

export interface DesiredLeg {
  readonly tag: string
  readonly mode: 'paper' | 'live'
  readonly symbol: string
  readonly contracts: number
  readonly stopPrice: number
}

export interface BackstopProblem {
  readonly key: string
  readonly tag: string
  readonly message: string
}

/**
 * Every short leg of every book on `rail`, at its group's stop line. A leg no
 * group accounts for takes its entries from the held legs at its strike (what
 * the desk adopts a straddle from); with no partner leg, twice its own entry.
 */
export function desiredStops(
  books: readonly DeskBookView[],
  rail: BackstopRail,
  tick = DX_OPTION_TICK,
): { legs: DesiredLeg[]; problems: BackstopProblem[] } {
  const legs: DesiredLeg[] = []
  const problems: BackstopProblem[] = []
  for (const b of books) {
    if (b.rail !== rail || b.legs.length === 0) continue
    if (b.stopMult === null) {
      problems.push({
        key: `backstop:${rail}:${b.tag}:no-mult`,
        tag: b.tag,
        message: `${b.tag} holds ${b.legs.length} short leg(s) on ${rail} but has no stop multiple (bs_stop_mult) — NO exchange backstop can be placed`,
      })
      continue
    }
    for (const l of b.legs) {
      const g = b.groups.find((x) => sameStrike(x.strike, l.strike) && (l.optType === 'CE' ? x.ceOpen : x.peOpen))
      let ce: number
      let pe: number
      if (g !== undefined) {
        ce = g.ceEntry
        pe = g.peEntry
      } else {
        const partner = b.legs.find((x) => sameStrike(x.strike, l.strike) && x.optType !== l.optType)
        const other = partner?.entryPrice ?? l.entryPrice
        ce = l.optType === 'CE' ? l.entryPrice : other
        pe = l.optType === 'PE' ? l.entryPrice : other
      }
      const raw = (ce + pe) * b.stopMult
      const line = b.stopBasis === 0 ? Math.trunc(raw) : raw
      if (!(line > 0)) {
        problems.push({
          key: `backstop:${rail}:${b.tag}:${l.symbol}:no-line`,
          tag: b.tag,
          message: `${b.tag} ${l.symbol}: no usable stop line (entries ${ce} + ${pe}) — NO exchange backstop`,
        })
        continue
      }
      legs.push({ tag: b.tag, mode: b.mode, symbol: l.symbol, contracts: l.contracts, stopPrice: ceilTick(line, tick) })
    }
  }
  return { legs, problems }
}

// ------------------------------------------------------------------ plan

export interface StopOrder {
  readonly clientOrderId: string
  readonly tag: string
  readonly symbol: string
  readonly productId: number
  readonly size: number
  readonly stopPrice: string
  readonly limitPrice: string
}

export interface BackstopPlan {
  readonly place: StopOrder[]
  readonly edit: { readonly order: DxOrder; readonly want: StopOrder }[]
  readonly cancel: DxOrder[]
  /** Delta shorts no desired leg covers (contracts uncovered). */
  readonly unprotected: { readonly symbol: string; readonly contracts: number }[]
}

export function planBackstops(input: {
  readonly rail: BackstopRail
  readonly desired: readonly DesiredLeg[]
  readonly positions: readonly DxPosition[]
  readonly open: readonly DxOrder[]
  readonly limitPct: number
  readonly tick?: number
}): BackstopPlan {
  const tick = input.tick ?? DX_OPTION_TICK
  const d = decimalsOf(tick)
  const shortBy = new Map<string, { productId: number; contracts: number }>()
  for (const p of input.positions) {
    if (p.size < 0) shortBy.set(p.product_symbol, { productId: p.product_id, contracts: -p.size })
  }
  const want = new Map<string, StopOrder>()
  const left = new Map<string, number>()
  for (const [s, v] of shortBy) left.set(s, v.contracts)
  const sorted = [...input.desired].sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0))
  for (const l of sorted) {
    const short = shortBy.get(l.symbol)
    if (short === undefined) continue
    const room = left.get(l.symbol) ?? 0
    const size = Math.min(l.contracts, room)
    if (size <= 0) continue
    left.set(l.symbol, room - size)
    const id = backstopClientOrderId(input.rail, l.tag, l.symbol)
    want.set(id, {
      clientOrderId: id,
      tag: l.tag,
      symbol: l.symbol,
      productId: short.productId,
      size,
      stopPrice: l.stopPrice.toFixed(d),
      limitPrice: ceilTick(l.stopPrice * (1 + input.limitPct), tick).toFixed(d),
    })
  }
  const unprotected: { symbol: string; contracts: number }[] = []
  for (const [s, n] of left) if (n > 0) unprotected.push({ symbol: s, contracts: n })

  const place: StopOrder[] = []
  const edit: { order: DxOrder; want: StopOrder }[] = []
  const cancel: DxOrder[] = []
  const seen = new Set<string>()
  for (const o of input.open) {
    const id = o.client_order_id ?? null
    if (!isBackstopOrderId(id) || id === null) continue
    const w = want.get(id)
    if (w === undefined || seen.has(id)) {
      cancel.push(o)
      continue
    }
    seen.add(id)
    // Triggered: a working buy limit now. Leave it to fill.
    if (o.state !== 'pending') continue
    const differs =
      o.size !== w.size || Number(o.stop_price) !== Number(w.stopPrice) || Number(o.limit_price) !== Number(w.limitPrice)
    if (differs) edit.push({ order: o, want: w })
  }
  for (const [id, w] of want) if (!seen.has(id)) place.push(w)
  return { place, edit, cancel, unprotected }
}

// ------------------------------------------------------------------ loop

export type BackstopRest = Pick<DxRest, 'positions' | 'openOrders' | 'placeOrder' | 'editOrder' | 'cancelOrder'>

export interface BackstopAlert {
  readonly severity: 'critical' | 'warn' | 'info'
  readonly key: string
  readonly message: string
  readonly tag?: string
}

export interface BackstopRunReport {
  readonly desired: number
  readonly placed: number
  readonly edited: number
  readonly cancelled: number
  readonly failed: number
}

export interface DxBackstop {
  /** One reconcile; null when it could not read what it needs (and so changed nothing). */
  run(): Promise<BackstopRunReport | null>
  /** Reconcile soon (after a desk fill). */
  nudge(): void
  /** True when the update is a backstop's own — the caller must not hand it to the fill watcher. */
  onOrderUpdate(update: PlacedOrder): boolean
}

const msgOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

export function createDxBackstop(deps: {
  readonly rail: BackstopRail
  readonly rest: BackstopRest
  readonly readDesk: () => Promise<DeskBookView[]>
  readonly alert: (a: BackstopAlert) => void
  readonly log: (msg: string, ctx?: Record<string, unknown>) => void
  readonly now: () => number
  readonly limitPct: number
  readonly tick?: number
  readonly unprotectedGraceMs?: number
  readonly nudgeMs?: number
}): DxBackstop {
  const rail = deps.rail
  const RAIL = rail.toUpperCase()
  let running = false
  let nudgeTimer: ReturnType<typeof setTimeout> | null = null
  /** symbol → first seen unprotected. */
  const unprotectedSince = new Map<string, number>()

  const toRequest = (w: StopOrder): DxOrderRequest => ({
    product_id: w.productId,
    size: w.size,
    side: 'buy',
    order_type: 'limit_order',
    limit_price: w.limitPrice,
    stop_order_type: 'stop_loss_order',
    stop_price: w.stopPrice,
    stop_trigger_method: 'mark_price',
    reduce_only: true,
    time_in_force: 'gtc',
    client_order_id: w.clientOrderId,
  })

  const place = async (w: StopOrder): Promise<boolean> => {
    try {
      await deps.rest.placeOrder(toRequest(w))
      deps.log(`DX BACKSTOP ${RAIL} placed`, { tag: w.tag, symbol: w.symbol, size: w.size, stop: w.stopPrice, limit: w.limitPrice })
      return true
    } catch (err) {
      deps.log(`DX BACKSTOP ${RAIL} NOT PLACED`, { tag: w.tag, symbol: w.symbol, error: msgOf(err) })
      deps.alert({
        severity: 'critical',
        key: `backstop:${rail}:${w.tag}:${w.symbol}:place`,
        tag: w.tag,
        message:
          `${RAIL} backstop NOT placed for ${w.symbol} (${w.tag}): ${w.size} contracts, stop ${w.stopPrice} — ` +
          `${msgOf(err)}. This leg has NO exchange-resident stop.`,
      })
      return false
    }
  }

  const run = async (): Promise<BackstopRunReport | null> => {
    if (running) return null
    running = true
    try {
      let books: DeskBookView[]
      let positions: DxPosition[]
      let open: DxOrder[]
      try {
        books = await deps.readDesk()
      } catch (err) {
        deps.log(`DX BACKSTOP ${RAIL}: desk view unreadable — nothing changed this pass`, { error: msgOf(err) })
        return null
      }
      try {
        ;[positions, open] = await Promise.all([deps.rest.positions(), deps.rest.openOrders()])
      } catch (err) {
        deps.log(`DX BACKSTOP ${RAIL}: Delta positions/orders unreadable — nothing changed this pass`, { error: msgOf(err) })
        return null
      }
      const { legs, problems } = desiredStops(books, rail, deps.tick)
      const p = planBackstops({ rail, desired: legs, positions, open, limitPct: deps.limitPct, ...(deps.tick === undefined ? {} : { tick: deps.tick }) })
      let placed = 0
      let edited = 0
      let cancelled = 0
      let failed = 0
      for (const o of p.cancel) {
        try {
          await deps.rest.cancelOrder(o.id, o.product_id)
          cancelled++
          deps.log(`DX BACKSTOP ${RAIL} orphan cancelled`, { symbol: o.product_symbol, id: o.id, clientOrderId: o.client_order_id })
        } catch (err) {
          failed++
          deps.log(`DX BACKSTOP ${RAIL} orphan cancel FAILED`, { id: o.id, error: msgOf(err) })
        }
      }
      for (const { order, want } of p.edit) {
        try {
          await deps.rest.editOrder({ id: order.id, productId: order.product_id, limitPrice: want.limitPrice, size: want.size, stopPrice: want.stopPrice })
          edited++
          deps.log(`DX BACKSTOP ${RAIL} resized`, { symbol: want.symbol, size: want.size, stop: want.stopPrice })
        } catch (err) {
          deps.log(`DX BACKSTOP ${RAIL} edit refused — replacing`, { symbol: want.symbol, error: msgOf(err) })
          try {
            await deps.rest.cancelOrder(order.id, order.product_id)
          } catch {
            // Gone already (filled or cancelled) — the place below decides.
          }
          if (await place(want)) placed++
          else failed++
        }
      }
      for (const w of p.place) {
        if (await place(w)) placed++
        else failed++
      }
      for (const pr of problems) deps.alert({ severity: 'critical', key: pr.key, tag: pr.tag, message: pr.message })

      const now = deps.now()
      const grace = deps.unprotectedGraceMs ?? DEFAULT_UNPROTECTED_GRACE_MS
      const still = new Set<string>()
      for (const u of p.unprotected) {
        still.add(u.symbol)
        const since = unprotectedSince.get(u.symbol) ?? now
        unprotectedSince.set(u.symbol, since)
        if (now - since >= grace) {
          deps.alert({
            severity: 'critical',
            key: `backstop:${rail}:${u.symbol}:unprotected`,
            message:
              `${RAIL}: Delta shows ${u.contracts} short ${u.symbol} contracts that no desk book accounts for — ` +
              'no stop line, so NO exchange backstop. Reconcile the book or flatten the position.',
          })
        }
      }
      for (const s of [...unprotectedSince.keys()]) if (!still.has(s)) unprotectedSince.delete(s)

      return { desired: legs.length, placed, edited, cancelled, failed }
    } finally {
      running = false
    }
  }

  return {
    run: async () => {
      try {
        return await run()
      } catch (err) {
        deps.log(`DX BACKSTOP ${RAIL} pass threw`, { error: msgOf(err) })
        return null
      }
    },
    nudge(): void {
      if (nudgeTimer !== null) return
      nudgeTimer = setTimeout(() => {
        nudgeTimer = null
        void run().catch(() => {})
      }, deps.nudgeMs ?? DX_BACKSTOP_NUDGE_MS)
      nudgeTimer.unref?.()
    },
    onOrderUpdate(u: PlacedOrder): boolean {
      if (!isBackstopOrderId(u.clientOrderId)) return false
      if (u.filledQty > 0) {
        deps.alert({
          severity: 'critical',
          key: `backstop:${rail}:${u.brokerOrderId}:fired:${u.filledQty}`,
          message:
            `${RAIL} backstop FIRED on ${u.tradingsymbol ?? 'an option'}: bought back ${u.filledQty} BTC` +
            `${u.avgPrice === null ? '' : ` at ${u.avgPrice}`} (Delta order ${u.brokerOrderId}). ` +
            "The desk's book still shows the short until it is reconciled — check the desk is alive and the book.",
        })
      }
      return true
    },
  }
}

// ---------------------------------------------------------------- alerts

/**
 * A `desk-alerts` writer (the shared alert contract). In-process dedupe per
 * key for `dedupeMs` (default 10 min) so a 15 s loop does not page every pass.
 * Never throws.
 */
export function createDeskAlertSink(deps: {
  readonly collection: { insertOne(doc: Doc): Promise<unknown> }
  readonly source: string
  readonly mode: 'paper' | 'live'
  readonly now: () => number
  readonly log: (msg: string, ctx?: Record<string, unknown>) => void
  readonly dedupeMs?: number
}): (a: BackstopAlert) => void {
  const last = new Map<string, number>()
  const window = deps.dedupeMs ?? 10 * 60_000
  return (a) => {
    const now = deps.now()
    const prev = last.get(a.key)
    if (prev !== undefined && now - prev < window) return
    last.set(a.key, now)
    const doc: Doc = {
      at: now,
      severity: a.severity,
      source: deps.source,
      mode: deps.mode,
      key: a.key,
      message: a.message,
      ...(a.tag === undefined ? {} : { tag: a.tag }),
    }
    deps.log(`ALERT ${a.severity.toUpperCase()}: ${a.message}`)
    void deps.collection.insertOne(doc).catch((err: unknown) => deps.log('desk-alerts insert failed', { error: msgOf(err) }))
  }
}

// ------------------------------------------------------------- the hooks main calls

/** The `desk-alerts` collection (the shared alert contract). */
export const DESK_ALERTS_COLLECTION = 'desk-alerts'

/**
 * Arm one rail's backstop loop: a pass now, one every `DX_BACKSTOP_MS`, and
 * one shortly after each desk fill (`nudge`). Null when `DX_BACKSTOP=0`.
 */
export function startDxBackstop(opts: {
  readonly rail: BackstopRail
  readonly rest: BackstopRest
  readonly db: { collection(name: string): unknown }
  readonly log: (msg: string, ctx?: Record<string, unknown>) => void
  readonly env: Env
}): DxBackstop | null {
  if (!backstopEnabled(opts.env)) {
    opts.log(`DX BACKSTOP ${opts.rail.toUpperCase()} OFF (DX_BACKSTOP=0) — no exchange-resident stops`)
    return null
  }
  const bs = createDxBackstop({
    rail: opts.rail,
    rest: opts.rest,
    readDesk: () => readDeskBooks(opts.db),
    alert: createDeskAlertSink({
      collection: opts.db.collection(DESK_ALERTS_COLLECTION) as never,
      source: 'dx-gateway/backstop',
      mode: opts.rail === 'live' ? 'live' : 'paper',
      now: () => Date.now(),
      log: opts.log,
    }),
    log: opts.log,
    now: () => Date.now(),
    limitPct: backstopLimitPct(opts.env),
  })
  void bs.run()
  setInterval(() => void bs.run(), DX_BACKSTOP_MS).unref()
  opts.log(`DX BACKSTOP ${opts.rail.toUpperCase()} armed — a reduce-only stop rests on Delta for every short leg`)
  return bs
}

/**
 * The dead-man switch for one rail's REST client. With backstops on it is
 * RETIRED (its cancel_orders cancels stop orders too — testnet, 3 Nov 2026)
 * and null is returned; with `DX_BACKSTOP=0` it runs as before.
 */
export function startDxDeadman(opts: {
  readonly rest: Pick<DxRest, 'heartbeat'> & Partial<Pick<DxRest, 'heartbeatAck'>>
  readonly log: (msg: string, ctx?: Record<string, unknown>) => void
  readonly env: Env
}): { readonly healthy: boolean } | null {
  if (backstopEnabled(opts.env)) {
    const ack = opts.rest.heartbeatAck
    if (ack === undefined) {
      opts.log('DX HEARTBEAT: this client cannot retire the switch — none is created')
      return null
    }
    const retirer = retireDxHeartbeat({ rest: { heartbeatAck: (ttl) => ack.call(opts.rest, ttl) }, log: opts.log })
    void retirer.beat()
    const t = setInterval(() => {
      if (retirer.retired) clearInterval(t)
      else void retirer.beat()
    }, DX_HEARTBEAT_MS)
    t.unref()
    return null
  }
  const hb = createDxHeartbeat({ rest: opts.rest, log: opts.log })
  void hb.beat()
  setInterval(() => void hb.beat(), DX_HEARTBEAT_MS).unref()
  return hb
}
