/**
 * DELTA'S OWN ORDER BOOK AND FILLS, for the Broker page (operator, 4 Nov:
 * "broker page not showing … do 1, 2 both").
 *
 * Every 30 s each configured rail's own client reads, through its own key and
 * host only:
 *
 *   - `open`   — `GET /v2/orders?states=open,pending`, every page: what rests
 *                on Delta now, untriggered stops included (`pending`);
 *   - `recent` — ONE page of `GET /v2/orders/history`: the newest 50 closed and
 *                cancelled orders;
 *   - `fills`  — ONE page of `GET /v2/fills`: the newest 50 executions;
 *
 * and writes `desk-broker-orders` `{_id: 'delta' | 'delta-demo', asOf, broker,
 * host, open, recent, fills}`, each list `{ok, error, rows}`. Rows are in the
 * desk's units — BTC (contracts × the step) and dollars as numbers, times as
 * epoch ms — so the page formats them the way every other DX screen does.
 *
 * A SEPARATE COLLECTION, ON PURPOSE. `desk-broker-snapshot` (positions) is what
 * the positions comparison and the live halt read, and its `asOf` is the
 * moment the in-flight grace is measured from. Nothing here touches it, delays
 * it or can fail it: a slow or refused order read is this display's problem
 * only.
 *
 * DISPLAY ONLY. Nothing reconciles, cancels or decides from these rows.
 *
 * A FAILED READ IS RECORDED AS FAILED: `ok: false`, the error, `rows: null` —
 * never the previous list (it would read as current) and never `[]` (an empty
 * book is a claim). Each list fails on its own. NEVER THROWS: a failed write
 * is logged and the next take tries again.
 */
import type { DxFill, DxOrder } from '@algomaker/dx'
import { num, qtyOfContracts } from '@algomaker/dx'

export const BROKER_ORDERS_COLLECTION = 'desk-broker-orders'
export const DELTA_ORDERS_ID = 'delta'
export const DELTA_DEMO_ORDERS_ID = 'delta-demo'
export const DELTA_ORDERS_MS = 30_000

/** BTC per contract on Delta's BTC options. */
const DEFAULT_STEP = 0.001

export interface BrokerOrderRow {
  readonly id: string
  readonly symbol: string
  readonly side: string
  /** `limit` | `market` | `stop` | `take-profit`, else Delta's own word. */
  readonly kind: string
  /** Delta's: `open` | `pending` (an untriggered stop) | `closed` | `cancelled`. */
  readonly state: string
  /** BTC. */
  readonly qty: number | null
  /** BTC. */
  readonly filledQty: number | null
  readonly limitPrice: number | null
  readonly stopPrice: number | null
  readonly avgFillPrice: number | null
  readonly reduceOnly: boolean
  readonly clientOrderId: string | null
  readonly cancellationReason: string | null
  readonly createdAt: number | null
  readonly updatedAt: number | null
}

export interface BrokerFillRow {
  readonly id: string
  readonly orderId: string | null
  readonly symbol: string
  readonly side: string
  /** BTC. */
  readonly qty: number | null
  readonly price: number | null
  /** USD, as Delta charged it. */
  readonly commission: number | null
  readonly role: string | null
  readonly fillType: string | null
  readonly at: number | null
}

export interface BrokerList<T> {
  readonly ok: boolean
  readonly error: string
  readonly rows: readonly T[] | null
}

type Log = (msg: string, ctx?: Record<string, unknown>) => void
const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** An ISO stamp as epoch ms; null when absent or unreadable. */
function msOf(v: unknown): number | null {
  if (typeof v !== 'string' || v === '') return null
  const t = Date.parse(v)
  return Number.isFinite(t) ? t : null
}

function textOrNull(v: unknown): string | null {
  return v === null || v === undefined || v === '' ? null : String(v)
}

function btcOf(contracts: unknown, step: number): number | null {
  const n = num(contracts)
  return n === null ? null : qtyOfContracts(n, step)
}

function kindOf(o: DxOrder): string {
  const stop = o.stop_order_type ?? ''
  if (stop === 'stop_loss_order') return 'stop'
  if (stop === 'take_profit_order') return 'take-profit'
  if (stop !== '') return stop
  const t = o.order_type ?? ''
  if (t === 'limit_order') return 'limit'
  if (t === 'market_order') return 'market'
  return t
}

/** One Delta order in the desk's units. Pure. */
export function orderRowOf(o: DxOrder, step: number = DEFAULT_STEP): BrokerOrderRow {
  const size = num(o.size)
  const unfilled = num(o.unfilled_size)
  return {
    id: String(o.id),
    symbol: o.product_symbol ?? '',
    side: o.side,
    kind: kindOf(o),
    state: o.state,
    qty: btcOf(size, step),
    filledQty: size === null || unfilled === null ? null : qtyOfContracts(size - unfilled, step),
    limitPrice: num(o.limit_price),
    stopPrice: num(o.stop_price),
    avgFillPrice: num(o.average_fill_price),
    reduceOnly: o.reduce_only === true,
    clientOrderId: textOrNull(o.client_order_id),
    cancellationReason: textOrNull(o.cancellation_reason),
    createdAt: msOf(o.created_at),
    updatedAt: msOf(o.updated_at),
  }
}

/** One Delta fill in the desk's units. Pure. */
export function fillRowOf(f: DxFill, step: number = DEFAULT_STEP): BrokerFillRow {
  return {
    id: String(f.id),
    orderId: textOrNull(f.order_id),
    symbol: f.product_symbol ?? '',
    side: f.side ?? '',
    qty: btcOf(f.size, step),
    price: num(f.price),
    commission: num(f.commission),
    role: textOrNull(f.role),
    fillType: textOrNull(f.fill_type),
    at: msOf(f.created_at),
  }
}

/** Newest first; a row with no time sorts last, in Delta's order. */
const newestFirst = (a: BrokerOrderRow, b: BrokerOrderRow): number => (b.createdAt ?? -Infinity) - (a.createdAt ?? -Infinity)

export function createDeltaOrdersSnapshot(deps: {
  readonly openOrders: () => Promise<readonly DxOrder[]>
  readonly recentOrders: () => Promise<readonly DxOrder[]>
  readonly fills: () => Promise<readonly DxFill[]>
  readonly collection: {
    updateOne(filter: Record<string, unknown>, update: Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown>
  }
  readonly now: () => number
  readonly host: string | null
  readonly log: Log
  /** BTC per contract. Default 0.001. */
  readonly step?: number
  /** Default the production account: `_id: 'delta'`, broker `delta`. */
  readonly id?: string
  readonly broker?: 'delta' | 'delta-demo'
}): { take(): Promise<void> } {
  const id = deps.id ?? DELTA_ORDERS_ID
  const broker = deps.broker ?? 'delta'
  const venue = broker === 'delta-demo' ? 'Delta testnet' : 'Delta'
  const step = deps.step ?? DEFAULT_STEP
  let running = false

  async function list<S, T>(what: string, read: () => Promise<readonly S[]>, row: (s: S) => T): Promise<BrokerList<T>> {
    try {
      return { ok: true, error: '', rows: (await read()).map(row) }
    } catch (err) {
      return { ok: false, error: `${venue} ${what} failed: ${errorText(err)}`, rows: null }
    }
  }

  return {
    async take(): Promise<void> {
      if (running) return
      running = true
      try {
        const [open, recent, fills] = await Promise.all([
          list('open orders', deps.openOrders, (o: DxOrder) => orderRowOf(o, step)),
          list('order history', deps.recentOrders, (o: DxOrder) => orderRowOf(o, step)),
          list('fills', deps.fills, (f: DxFill) => fillRowOf(f, step)),
        ])
        const set = {
          asOf: deps.now(),
          broker,
          host: deps.host,
          open: open.rows === null ? open : { ...open, rows: [...open.rows].sort(newestFirst) },
          recent,
          fills,
        }
        await deps.collection.updateOne({ _id: id }, { $set: set }, { upsert: true })
      } catch (err) {
        deps.log('Delta orders snapshot write failed', { id, error: errorText(err) })
      } finally {
        running = false
      }
    },
  }
}
