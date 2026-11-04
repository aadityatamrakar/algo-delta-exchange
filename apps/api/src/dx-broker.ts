/**
 * THE DELTA BROKER PAGE'S DATA (operator, 4 Nov: "broker page not showing …
 * do 1, 2 both").
 *
 *   GET /v1/desk/broker/delta?rail=live|demo
 *
 * What DELTA holds on one account, as the gateway last read it — never the
 * desk's own record:
 *
 *   positions     `desk-broker-snapshot` (`gateway-heartbeat.ts`), the same
 *                 read the positions comparison uses;
 *   openOrders,   `desk-broker-orders` (`dx-broker-orders.ts`): the resting
 *   recentOrders, book (stops included), the newest closed/cancelled orders
 *   fills         and the newest fills;
 *   margin        `desk-broker-margin`, through `accountMarginView`.
 *
 * `rail=live` is the production account (`_id: 'delta'`), `rail=demo` the
 * testnet one (`'delta-demo'`). The NSE page's `/v1/desk/broker` (the XTS
 * snapshot) is untouched.
 *
 * EVERY SECTION SAYS WHAT IT IS. `absent` (never written — with the reason),
 * `failed` (Delta refused or timed out — with the error, and NO rows, never
 * the previous list), `stale` (older than three missed reads — rows kept but
 * flagged), else `ok`. An absent or failed section has `rows: []` beside that
 * state; the state is what says "unknown", not the empty list. An unreadable
 * figure is null, never 0.
 *
 * READ-ONLY. Nothing here cancels or places anything.
 */
import { accountMarginView, BROKER_MARGIN_COLLECTION, type AccountMarginRow } from './dx-margin.ts'
import type { ApiDeps, RouteCtx } from './routes/kit.ts'

export const DX_BROKER_SNAPSHOT_COLLECTION = 'desk-broker-snapshot'
export const DX_BROKER_ORDERS_COLLECTION = 'desk-broker-orders'
/** The gateway reads every 30 s; three missed reads is stale. */
export const DX_BROKER_STALE_MS = 90_000
const INR_PER_USD = 85

export type DxBrokerRail = 'live' | 'demo'
export type DxBrokerState = 'ok' | 'stale' | 'failed' | 'absent'

export interface DxBrokerSection<T> {
  readonly state: DxBrokerState
  readonly asOf: number | null
  readonly ageMs: number | null
  /** Delta's refusal, when `failed`. */
  readonly error: string
  /** Why there is nothing, when `absent`. */
  readonly reason: string
  readonly rows: readonly T[]
}

export interface DxBrokerPosition {
  readonly symbol: string
  /** BTC, signed: negative is short. */
  readonly netQty: number | null
  readonly avgPrice: number | null
}

/** A `desk-broker-orders` row, as the gateway wrote it (`BrokerOrderRow`). */
export type DxBrokerOrder = Readonly<Record<string, unknown>>
/** A `desk-broker-orders` fill, as the gateway wrote it (`BrokerFillRow`). */
export type DxBrokerFill = Readonly<Record<string, unknown>>

export interface DxBrokerView {
  readonly rail: DxBrokerRail
  readonly label: 'Live' | 'Demo'
  readonly host: string | null
  readonly staleAfterMs: number
  readonly inrPerUsd: number
  readonly positions: DxBrokerSection<DxBrokerPosition>
  readonly openOrders: DxBrokerSection<DxBrokerOrder>
  readonly recentOrders: DxBrokerSection<DxBrokerOrder>
  readonly fills: DxBrokerSection<DxBrokerFill>
  readonly margin: AccountMarginRow
}

type Doc = Record<string, unknown>

const fin = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const isObj = (v: unknown): v is Doc => v !== null && typeof v === 'object' && !Array.isArray(v)

function section<T>(
  asOf: number | null,
  nowMs: number,
  ok: boolean,
  error: string,
  rows: readonly T[],
): DxBrokerSection<T> {
  const ageMs = asOf === null ? null : nowMs - asOf
  if (!ok) return { state: 'failed', asOf, ageMs, error, reason: '', rows: [] }
  const stale = ageMs === null || ageMs > DX_BROKER_STALE_MS
  return { state: stale ? 'stale' : 'ok', asOf, ageMs, error: '', reason: '', rows }
}

function absent<T>(reason: string): DxBrokerSection<T> {
  return { state: 'absent', asOf: null, ageMs: null, error: '', reason, rows: [] }
}

function positionsOf(doc: Doc | null, nowMs: number, rail: DxBrokerRail): DxBrokerSection<DxBrokerPosition> {
  if (doc === null) {
    return absent(
      `not written: the gateway has not read the ${rail} account's positions — ` +
        (rail === 'live' ? 'the live rail is off or has no delta key' : 'no delta-demo key, or the demo rail is not up yet'),
    )
  }
  const raw = Array.isArray(doc['positions']) ? (doc['positions'] as unknown[]) : []
  const rows = raw.filter(isObj).map((p) => ({
    symbol: String(p['tradingsymbol'] ?? ''),
    netQty: fin(p['netQty']),
    avgPrice: fin(p['avgPrice']),
  }))
  return section(fin(doc['asOf']), nowMs, doc['ok'] === true, String(doc['error'] ?? ''), rows)
}

function listOf(doc: Doc | null, key: 'open' | 'recent' | 'fills', nowMs: number): DxBrokerSection<Doc> {
  if (doc === null) {
    return absent(
      "not written: the gateway has not read this account's orders and fills yet — " +
        'it is running a build from before the Broker page, or the rail is off',
    )
  }
  const list = doc[key]
  if (!isObj(list)) return absent(`not written: the gateway's orders snapshot has no '${key}' list`)
  const rows = Array.isArray(list['rows']) ? (list['rows'] as unknown[]).filter(isObj) : []
  return section(fin(doc['asOf']), nowMs, list['ok'] === true, String(list['error'] ?? ''), rows)
}

/** One account's broker view. Pure. */
export function dxBrokerView(input: {
  readonly rail: DxBrokerRail
  readonly positionsDoc: Doc | null
  readonly ordersDoc: Doc | null
  readonly marginDocs: readonly Doc[]
  readonly nowMs: number
  readonly inrPerUsd?: number
}): DxBrokerView {
  const { rail, positionsDoc, ordersDoc, nowMs } = input
  const inrPerUsd = input.inrPerUsd ?? INR_PER_USD
  const id = rail === 'live' ? 'delta' : 'delta-demo'
  const margin = accountMarginView(input.marginDocs, nowMs, inrPerUsd).accounts.find((a) => a.id === id)
  if (margin === undefined) throw new Error(`accountMarginView lists no '${id}' account`)
  const hostOf = (d: Doc | null): string | null => (d !== null && typeof d['host'] === 'string' && d['host'] !== '' ? d['host'] : null)
  return {
    rail,
    label: rail === 'live' ? 'Live' : 'Demo',
    host: hostOf(positionsDoc) ?? hostOf(ordersDoc),
    staleAfterMs: DX_BROKER_STALE_MS,
    inrPerUsd,
    positions: positionsOf(positionsDoc, nowMs, rail),
    openOrders: listOf(ordersDoc, 'open', nowMs),
    recentOrders: listOf(ordersDoc, 'recent', nowMs),
    fills: listOf(ordersDoc, 'fills', nowMs),
    margin,
  }
}

export async function handleDxBroker(deps: Pick<ApiDeps, 'db' | 'now' | 'venue'>, ctx: RouteCtx): Promise<boolean> {
  const rail = ctx.url.searchParams.get('rail')
  if (rail !== 'live' && rail !== 'demo') {
    ctx.send(400, { error: "rail must be 'live' or 'demo'" })
    return true
  }
  const id = rail === 'live' ? 'delta' : 'delta-demo'
  const [positionsDoc, ordersDoc, marginDocs] = await Promise.all([
    deps.db.collection(DX_BROKER_SNAPSHOT_COLLECTION).findOne({ _id: id as never }),
    deps.db.collection(DX_BROKER_ORDERS_COLLECTION).findOne({ _id: id as never }),
    deps.db.collection(BROKER_MARGIN_COLLECTION).find({}).toArray(),
  ])
  ctx.send(
    200,
    dxBrokerView({
      rail,
      positionsDoc: positionsDoc as Doc | null,
      ordersDoc: ordersDoc as Doc | null,
      marginDocs: marginDocs as Doc[],
      nowMs: deps.now(),
      inrPerUsd: deps.venue?.inrPerUnit ?? INR_PER_USD,
    }),
  )
  return true
}
