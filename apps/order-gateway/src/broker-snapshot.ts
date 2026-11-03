/**
 * WHAT THE BROKER THINKS, captured so the desk can be compared against it.
 *
 * The desk's own journal is a record of what it BELIEVES it did. The broker's
 * order book is what actually exists. Those two disagreeing is a real failure
 * mode and a documented one — `xts-rest.ts`'s `getOrderBook` carries the note
 * that a dealer account calling the investor route reconciles "against an empty
 * order book" and concludes nothing happened, while the order is live.
 *
 * Measured 2026-07-30: a smoke-test order rested at the broker (`1240043411`)
 * with nothing on any desk screen showing it, because no code ever asked the
 * broker what it was holding.
 *
 * THE GATEWAY TAKES THIS SNAPSHOT, not desk-api, because the gateway already
 * owns the XTS session. A second session in desk-api would share the one
 * `desk-broker-session` token document, and either process re-logging in could
 * invalidate the other's token mid-order. The cost is staleness, which `asOf`
 * makes visible rather than hiding.
 */

import { classifyXtsError, type XtsErrorClass } from '@algomaker/brokers'
import { fixedClock, isMarketOpen } from '@algomaker/core'

/** The subset of the XTS client this needs. Both methods are optional on it. */
export interface BrokerReader {
  getOrderBook?(req?: Record<string, unknown>): Promise<{
    result?: unknown
    error?: { message?: string }
  }>
  getPosition?(req?: Record<string, unknown>): Promise<{
    result?: unknown
    error?: { message?: string }
  }>
  getTradeBook?(req?: Record<string, unknown>): Promise<{
    result?: unknown
    error?: { message?: string }
  }>
  getBalance?(): Promise<{
    result?: unknown
    error?: { message?: string }
  }>
}

export interface BrokerSnapshot {
  /** When this was taken. A stale snapshot must read as stale, not as truth. */
  readonly asOf: number
  /** False when either call failed; `orders`/`positions` are then untrustworthy. */
  readonly ok: boolean
  readonly error: string
  readonly orders: readonly Record<string, unknown>[]
  readonly positions: readonly Record<string, unknown>[]
  /**
   * What actually EXECUTED. Distinct from `orders`, which says what was asked
   * for and what the broker currently believes; a partially filled order
   * appears in both saying different things, and neither substitutes for the
   * other when reconciling.
   */
  readonly trades: readonly Record<string, unknown>[]
  /**
   * Funds/margin as the broker reported them, verbatim subtree — or null.
   *
   * ADVISORY, NEVER PART OF `ok`: this snapshot exists so the desk can be
   * reconciled against the broker's book, and a margin figure that failed to
   * arrive must not redden the one page whose warnings have to stay
   * trustworthy. XTS varies the balance schema by build and publishes none at
   * all for some dealer accounts, so the subtree is stored as sent and
   * desk-api's `/v1/desk/broker/funds` digs it by key name. ALWAYS WRITTEN
   * (null, not absent) so a `$set` of a later snapshot can never leave a stale
   * figure looking current.
   */
  readonly funds: Record<string, unknown> | readonly unknown[] | null
  /** Why `funds` is null, when it is: the broker's error or the reply's shape. */
  readonly fundsDiagnostic: string
  /**
   * What the reply LOOKED like, recorded only when a list came back empty.
   *
   * "The broker holds nothing" and "the reply was not a shape we could read"
   * are the same empty array, and confusing them is the exact failure
   * `getOrderBook` warns about: a dealer account reconciling against an empty
   * order book concludes nothing happened while the order is live. An operator
   * staring at an empty table needs to know which one they are looking at, so
   * the shape is recorded rather than inferred.
   *
   * Keys only, never values — an order book is not something to copy wholesale
   * into another collection.
   */
  readonly emptyDiagnostic?: {
    readonly orders?: string
    readonly positions?: string
    readonly trades?: string
  }
  /**
   * WHICH FAMILY the failure belongs to — only on a failed snapshot.
   *
   * The gateway already classifies the error to decide whether to re-login, and
   * used to throw that answer away. It is recorded because the classification
   * is the difference between two failures that read identically in the doc:
   * a dead session (the token expired overnight and nothing was being ordered
   * anyway) and a real rejection. Only the reader can act on that distinction,
   * and only if it is told.
   */
  readonly errorClass?: XtsErrorClass
  /**
   * Was the market OPEN at `asOf` — only on a failed snapshot.
   *
   * Stamped at the moment the snapshot was taken, never inferred at read time.
   * A snapshot that failed at 11:00 on a Tuesday is a mid-session failure
   * forever; read back at midnight it must not soften into "the market was
   * shut", because the orders it could not see were live orders.
   *
   * NO HOLIDAY CALENDAR, deliberately, here or anywhere: a weekday exchange
   * holiday reads as open, which errs towards the loud answer.
   */
  readonly sessionOpenAtSnapshot?: boolean
}

/**
 * A short, value-free description of a payload: enough to tell "the broker said
 * nothing" from "we could not read the reply".
 *
 * IT DESCRIBES THE LIST THAT WAS LOCATED, not the envelope around it. XTS
 * wraps positions as `{positionList: []}`, and reporting that as
 * `object{positionList}` made a perfectly good empty list look unreadable —
 * crying wolf on the exact screen whose warnings have to stay trustworthy.
 * A located list therefore always reads `array(n)`, wrapped or not.
 */
export function shapeOf(result: unknown): string {
  if (result === null) return 'null'
  if (result === undefined) return 'undefined'
  if (Array.isArray(result)) return `array(${result.length})`
  if (typeof result !== 'object') return typeof result
  const entries = Object.entries(result as Record<string, unknown>)
  for (const [k, v] of entries) {
    if (Array.isArray(v)) return `array(${v.length}) in ${k}`
  }
  if (entries.length === 0) return 'object{}'
  return `object{${entries.map(([k]) => k).slice(0, 8).join(',')}}`
}

/**
 * XTS returns `result` as either a bare array or an object wrapping one under a
 * name that differs by endpoint and account type (`orderList`, `positionList`,
 * `dealerpositions`...). Rather than enumerate them, take the first array-valued
 * property. Anything else yields `[]` — an empty list, never a fabricated row.
 */
export function rowsOf(result: unknown): readonly Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[]
  if (typeof result === 'object' && result !== null) {
    for (const v of Object.values(result as Record<string, unknown>)) {
      if (Array.isArray(v)) return v as Record<string, unknown>[]
    }
  }
  return []
}

/**
 * One snapshot. NEVER THROWS — a broker that is down or a token that expired
 * must leave `ok: false` with the reason, not take the gateway's poll loop with
 * it. A failed snapshot is still written, so the dashboard can say "the broker
 * could not be reached at HH:MM" instead of silently showing the last good one
 * as though it were current.
 */
/**
 * XTS answers an EMPTY book with `"Data Not Available"` (e-orders-0005 /
 * e-portfolio-0005) rather than an empty list — verified against this account
 * on 2026-08-04 with zero orders, and it is the reply the legacy system's
 * try/catch swallowed for years. It means "you hold nothing", not "the query
 * failed", so it must not mark the snapshot incomplete: a permanently red
 * snapshot teaches the operator to ignore the one page that exists to be
 * believed.
 */
function isEmptyBookReply(message: string): boolean {
  return /data not available/i.test(message)
}

export async function takeBrokerSnapshot(
  client: BrokerReader,
  nowMs: number,
): Promise<BrokerSnapshot> {
  const problems: string[] = []
  const diagnostic: { orders?: string; positions?: string; trades?: string } = {}
  let orders: readonly Record<string, unknown>[] = []
  let positions: readonly Record<string, unknown>[] = []
  let trades: readonly Record<string, unknown>[] = []

  try {
    if (client.getOrderBook === undefined) throw new Error('adapter exposes no getOrderBook')
    const res = await client.getOrderBook()
    const msg = res.error?.message ?? ''
    if (msg !== '' && !isEmptyBookReply(msg)) {
      problems.push(`orders: ${msg}`)
    }
    orders = rowsOf(res.result)
    if (orders.length === 0) {
      diagnostic.orders = isEmptyBookReply(msg) ? 'empty (Data Not Available)' : shapeOf(res.result)
    }
  } catch (err) {
    problems.push(`orders: ${err instanceof Error ? err.message : String(err)}`)
  }

  try {
    if (client.getTradeBook === undefined) throw new Error('adapter exposes no getTradeBook')
    const res = await client.getTradeBook()
    const msg = res.error?.message ?? ''
    if (msg !== '' && !isEmptyBookReply(msg)) {
      problems.push(`trades: ${msg}`)
    }
    trades = rowsOf(res.result)
    if (trades.length === 0) {
      diagnostic.trades = isEmptyBookReply(msg) ? 'empty (Data Not Available)' : shapeOf(res.result)
    }
  } catch (err) {
    problems.push(`trades: ${err instanceof Error ? err.message : String(err)}`)
  }

  let funds: BrokerSnapshot['funds'] = null
  let fundsDiagnostic = ''
  try {
    if (client.getBalance === undefined) throw new Error('adapter exposes no getBalance')
    const res = await client.getBalance()
    const msg = res.error?.message ?? ''
    if (typeof res.result === 'object' && res.result !== null) {
      funds = res.result as Record<string, unknown>
    } else {
      fundsDiagnostic = msg !== ''
        ? (isEmptyBookReply(msg) ? 'empty (Data Not Available)' : msg)
        : shapeOf(res.result)
    }
  } catch (err) {
    // Deliberately NOT pushed onto `problems` — see the field's doc comment.
    fundsDiagnostic = err instanceof Error ? err.message : String(err)
  }

  try {
    if (client.getPosition === undefined) throw new Error('adapter exposes no getPosition')
    const res = await client.getPosition()
    const msg = res.error?.message ?? ''
    if (msg !== '' && !isEmptyBookReply(msg)) {
      problems.push(`positions: ${msg}`)
    }
    positions = rowsOf(res.result)
    if (positions.length === 0) {
      diagnostic.positions = isEmptyBookReply(msg) ? 'empty (Data Not Available)' : shapeOf(res.result)
    }
  } catch (err) {
    problems.push(`positions: ${err instanceof Error ? err.message : String(err)}`)
  }

  const error = problems.join('; ')
  return {
    asOf: nowMs,
    ok: problems.length === 0,
    error,
    orders,
    positions,
    trades,
    funds,
    fundsDiagnostic,
    ...(Object.keys(diagnostic).length === 0 ? {} : { emptyDiagnostic: diagnostic }),
    /**
     * Only on a failure, because on a healthy snapshot there is nothing to
     * classify and a `sessionOpen: false` beside good data would invite a
     * reader to discount it. `fixedClock(nowMs)` asks the ONE session rule in
     * `@algomaker/core` about this instant — the same rule the runner gates on,
     * not a second copy of the hours.
     */
    ...(problems.length === 0
      ? {}
      : {
          errorClass: classifyXtsError(error),
          sessionOpenAtSnapshot: isMarketOpen(fixedClock(nowMs)),
        }),
  }
}
