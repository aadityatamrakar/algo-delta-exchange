/**
 * Order event journal — what happened to every submission, and why.
 *
 * The question this answers is "the desk says it sent an order; where did it
 * go?". Today the honest answer would be a Telegram line and a console log on a
 * box nobody is reading (`xtsOrder.js:115`). Every attempt is recorded here
 * instead, success and failure alike, so a bad afternoon is queryable after the
 * fact rather than reconstructed from memory.
 *
 * WHAT IS RECORDED, in order of a normal life:
 *   ACCEPTED   the bridge wrote the order durably
 *   PLANNED    resolved + split into N broker orders (or refused, with reason)
 *   SUBMITTED  handed to the broker; carries the raw response
 *   ACK        broker returned an id
 *   STATUS     every transition, partial fills included
 *   FAILED     broker refused; carries the message AND its classification
 *
 * Errors keep their classification (`transient` / `session` / `fatal`) because
 * that is the difference between "the OMS hiccuped, it retried, fine" and "the
 * account is out of margin" — indistinguishable in a raw log, and they demand
 * completely different responses from whoever is reading.
 *
 * APPEND-ONLY. Nothing here is ever updated: the sequence IS the evidence, and
 * an event overwritten by a later one destroys the thing being looked for.
 */

export type OrderEventPhase =
  | 'ACCEPTED'
  | 'PLANNED'
  | 'SUBMITTED'
  | 'ACK'
  | 'STATUS'
  | 'FAILED'
  | 'INVALID'

export interface OrderEvent {
  readonly clientOrderId: string
  readonly phase: OrderEventPhase
  /** False for anything a human should look at. Indexed. */
  readonly ok: boolean
  readonly tag: string
  readonly tradingsymbol: string
  readonly ts: number
  /**
   * WHICH RAIL THIS ORDER IS ON — folded into `detail.mode` by `record()`.
   *
   * The Orders page is scoped by mode, and its filter is "paper iff the event
   * says so" (`service.ts:orderEvents`, `PnlStore.orderEvents`). That was safe
   * while this gateway only ever saw live orders, and stopped being safe when
   * it started working the engine's PAPER orders through the same queue: every
   * PLANNED, SUBMITTED, ACK, STATUS and refusal it wrote for a rehearsal was
   * an unstamped row, which those filters read as LIVE. A paper rehearsal's
   * routing rendered on the live Orders tab and was missing from the paper one.
   *
   * SUPPLIED PER EVENT, because the mode is a property of the ORDER and this
   * process works both from one queue — there is no process-wide answer. Every
   * site takes it from the order document it already has in hand (`orderMode`),
   * which is the same fail-closed rule `isPaperOrder` states.
   *
   * ABSENT IS LIVE, and stays that way rather than becoming a default here:
   * every row this journal has ever written is unstamped, and the readers'
   * `$ne 'paper'` already answers for them correctly. A site that genuinely
   * cannot name the mode is telling the truth by omitting it.
   */
  readonly mode?: 'paper' | 'live'
  /** Broker/transport error message, verbatim. */
  readonly error?: string
  /**
   * A caveat on an event that is OK. Rendered as a note, never as a failure;
   * the failures feed (`ok: false`) never sees it.
   *
   * The distinction exists because of the freeze-unknown case (spec D5): an
   * order whose underlying has no freeze row still goes out, whole, and
   * writing that fact as a second `ok: false` row painted every SENSEX order
   * REJECTED on the book page although every one of them filled. What is true
   * of such an order is "placed, with a caveat" — this field says exactly that.
   */
  readonly warning?: string
  /** transient | session | fatal — see xts-protocol.classifyXtsError. */
  readonly errorClass?: string
  readonly brokerOrderId?: string
  readonly status?: string
  readonly filledQty?: number
  readonly avgPrice?: number | null
  /** Attempt number, so a retried order's history reads in order. */
  readonly attempt?: number
  /** Raw broker payload, truncated. The thing you actually want at 3pm. */
  readonly raw?: string
  readonly detail?: Record<string, unknown>
}

/** Raw payloads are capped: a journal that fills the disk stops being one. */
const MAX_RAW = 4000

export interface JournalCollection {
  insertOne(doc: Record<string, unknown>): Promise<unknown>
  find(filter: Record<string, unknown>): {
    sort(spec: Record<string, 1 | -1>): { limit(n: number): { toArray(): Promise<Record<string, unknown>[]> } }
  }
  createIndex(spec: Record<string, 1 | -1>, options?: { unique?: boolean }): Promise<unknown>
}

export const ORDER_EVENTS_COLLECTION = 'desk-order-events'

/**
 * WHICH RAIL A QUEUED ORDER DOCUMENT IS ON. Asked of the document, FAIL-CLOSED
 * TO PAPER (Delta desk, spec §8).
 *
 * Only an EXACT `mode: 'live'` answers live. Everything else — `'paper'`, no
 * mode at all, `'Live'`, `true` — is paper. On the NSE desk the default ran the
 * other way (absent was live, because every live order ever written carried no
 * mode). This desk starts with no such history, and the safety argument is now
 * the plain one: paper can never reach Delta by accident. A live order
 * mistaken for paper is a missing position, visible immediately; a paper order
 * mistaken for live places real money from a rehearsal.
 *
 * This is the DECLARED rail. Whether a live-declared document actually reaches
 * Delta also needs `DESK_DX_LIVE=1` and a `delta` broker — see
 * `main.ts:routesToDelta`; without both, the whole gateway simulates.
 *
 * It lives in the JOURNAL module because the journal is what every part of this
 * gateway already imports, and because "what does this row say it is" is the
 * question this module answers for readers downstream.
 */
export function orderMode(doc: Record<string, unknown>): 'paper' | 'live' {
  return doc['mode'] === 'live' ? 'live' : 'paper'
}

export class OrderJournal {
  readonly #c: JournalCollection
  readonly #now: () => number
  readonly #onError: (err: unknown) => void
  readonly #notify: ((event: OrderEvent) => void) | null

  constructor(deps: {
    collection: JournalCollection
    now?: () => number
    onError?: (err: unknown) => void
    /**
     * Told about every event this journal records, so `desk-api` can push it to
     * a dashboard (`notify.ts`).
     *
     * HOOKED HERE rather than at the call sites because this method is the one
     * place every gateway event already passes through — a PLANNED, an ACK, a
     * broker rejection and a fill all arrive as `record()`. Notifying from the
     * call sites instead would be six places to remember and one to forget.
     *
     * It is expected to be synchronous, to return nothing, and to swallow its
     * own errors; it is called inside a `try` anyway, because "expected to" is
     * not a guarantee and this is the order path.
     */
    notify?: (event: OrderEvent) => void
  }) {
    this.#c = deps.collection
    this.#now = deps.now ?? ((): number => Date.now())
    this.#onError =
      deps.onError ??
      ((err): void => {
        console.error('[journal] write failed', err)
      })
    this.#notify = deps.notify ?? null
  }

  async ensureIndexes(): Promise<void> {
    await this.#c.createIndex({ clientOrderId: 1, ts: 1 })
    // The query that matters most: "what went wrong today".
    await this.#c.createIndex({ ok: 1, ts: -1 })
    await this.#c.createIndex({ ts: -1 })
    await this.#c.createIndex({ tag: 1, ts: -1 })
  }

  /**
   * Record an event.
   *
   * NEVER THROWS. A journal failure must not take down the order path — losing
   * the record of a placement is bad, failing the placement because we could
   * not write the record is worse.
   */
  async record(event: OrderEvent): Promise<void> {
    const { mode, ...rest } = event
    const stamped = {
      ...rest,
      ts: event.ts === 0 ? this.#now() : event.ts,
      ...(event.raw === undefined ? {} : { raw: truncate(event.raw) }),
      /**
       * THE RAIL, FOLDED INTO `detail` — see `OrderEvent.mode`.
       *
       * Done HERE and not at the twenty call sites, because `detail.mode` is
       * the shape the readers query and a site that spelled it `mode` at the
       * top level would write a row that scopes as live while looking stamped.
       * The caller states the fact; this states where the fact goes.
       *
       * It merges into whatever `detail` the site supplied rather than
       * replacing it, and it WINS over a `mode` already in there: the two would
       * only ever disagree by mistake, and the order document is the better
       * authority on which rail its own order is on.
       */
      ...(mode === undefined ? {} : { detail: { ...(event.detail ?? {}), mode } }),
    }
    try {
      await this.#c.insertOne(stamped)
    } catch (err) {
      this.#onError(err)
    }
    /**
     * The push, in its OWN try/catch and OUTSIDE the write's.
     *
     * Inside it, a notify that threw would land in `#onError` and be reported as
     * "journal write failed" for a row that was written perfectly — a log line
     * that sends whoever reads it to look at Mongo. And it runs even when the
     * write failed, because the event still happened: the dashboard losing an
     * update and the journal losing a row are separate failures with separate
     * consequences, and neither is a reason to inflict the other.
     *
     * Nothing thrown here escapes `record()`, which is what makes a broken
     * dashboard notifier incapable of failing an order.
     */
    if (this.#notify !== null) {
      try {
        this.#notify(stamped)
      } catch {
        /* a dashboard that missed an update is an inconvenience */
      }
    }
  }

  /** Full history for one order, oldest first — the audit trail. */
  async history(clientOrderId: string, limit = 100): Promise<Record<string, unknown>[]> {
    const rows = await this.#c
      .find({ clientOrderId })
      .sort({ ts: 1 })
      .limit(limit)
      .toArray()
    return rows
  }

  /** Recent failures, newest first. The dashboard's error feed. */
  async failures(limit = 100): Promise<Record<string, unknown>[]> {
    return await this.#c.find({ ok: false }).sort({ ts: -1 }).limit(limit).toArray()
  }

  async recent(limit = 200): Promise<Record<string, unknown>[]> {
    return await this.#c.find({}).sort({ ts: -1 }).limit(limit).toArray()
  }
}

function truncate(s: string): string {
  return s.length <= MAX_RAW ? s : `${s.slice(0, MAX_RAW)}…[${s.length - MAX_RAW} more]`
}

/**
 * Serialise a broker response for the journal.
 *
 * Guards against a circular payload, which would otherwise throw INSIDE the
 * error path — the single worst place for a new exception.
 */
export function safeRaw(value: unknown): string {
  try {
    return typeof value === 'string' ? value : JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/**
 * A one-line human summary. Goes in the log next to the journal write, so the
 * console and the collection never disagree about what happened.
 */
export function describe(event: OrderEvent): string {
  const head = `${event.phase} ${event.tradingsymbol} [${event.clientOrderId}]`
  if (event.ok) {
    const bits = [
      event.brokerOrderId === undefined ? null : `broker=${event.brokerOrderId}`,
      event.status === undefined ? null : `status=${event.status}`,
      event.filledQty === undefined ? null : `filled=${event.filledQty}`,
      event.avgPrice === undefined || event.avgPrice === null ? null : `@${event.avgPrice}`,
    ].filter((b): b is string => b !== null)
    return bits.length === 0 ? head : `${head} ${bits.join(' ')}`
  }
  return `${head} FAILED${event.errorClass === undefined ? '' : ` (${event.errorClass})`}: ${event.error ?? 'unknown'}`
}
