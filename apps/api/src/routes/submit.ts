/**
 * `/v1/desk/submit` — one order from a hosted intraday strategy, through the
 * same gates and the same journal as the Python desk's book-shaped actions.
 *
 * The HTTP layer here is deliberately thin: validate, call, send. Every gate
 * and every refusal reason lives in `submit.ts`, so the whole of the endpoint's
 * behaviour is testable without a socket.
 *
 * `UnknownStrategy` is NOT caught here. `server.ts` already turns it into a
 * 403, exactly as it does for `/actions`, and catching it locally would mean
 * two places decide what an unregistered tag looks like on the wire.
 */

import { FreezeLimits } from '@algomaker/instruments'
import { loadFreezeLimits } from '../../../marketdata/src/sync-runner.ts'
import { liveTagsFromEnv, SubmitService, validateSubmitRequest } from '../submit.ts'
import { liveAllowlistFromStrategies } from '../strategies.ts'
import { marketableFromEnv } from '../marketable.ts'
import { LiveRail, LIVE_COLLECTION, PaperRail, type PaperFillEmit } from '../rail.ts'
import type { JournalEntry } from '../livebook.ts'
import { COLLECTIONS } from '../store.ts'
import type { ApiDeps, Route, RouteCtx } from './kit.ts'

/** How often the freeze table is re-read from Mongo. `make sync` writes it. */
const FREEZE_REFRESH_MS = 15 * 60_000

/**
 * The websocket push, or nothing at all.
 *
 * `undefined` rather than a no-op function when no socket is attached, so the
 * rail can skip the call entirely — and so "is anything listening?" is one
 * readable check rather than a closure that silently does nothing.
 */
function emitOf(deps: ApiDeps): PaperFillEmit | undefined {
  const stream = deps.stream
  if (stream === undefined) return undefined
  return (mode, event) => stream.publish(mode, event)
}

export function submitRoutes(deps: ApiDeps): Route {
  /**
   * `DESK_LIVE_TAGS` is the optional BOX-LEVEL PIN, not the allowlist — the
   * allowlist is the password-gated `modes.live` switch on the strategy row.
   * Empty means no pin. See `liveAllowlistFromStrategies`.
   */
  const livePin = liveTagsFromEnv()

  /**
   * The freeze table, refreshed in the background.
   *
   * Starts EMPTY rather than blocking boot on a Mongo read: an empty table
   * means `maxLotsPerOrder` returns null, which `submit.ts` sends as one order
   * and logs as unknown. That is the honest degradation — the alternative,
   * inventing a limit, is what put stale hardcoded values (FINNIFTY 45,
   * MIDCPNIFTY 56) above the real freeze quantity and got orders rejected by
   * the exchange.
   */
  let freeze = new FreezeLimits()
  const refreshFreeze = async (): Promise<void> => {
    try {
      freeze = await loadFreezeLimits(deps.db.collection('desk-freeze-limits'))
      deps.log('freeze limits loaded', { symbols: freeze.size })
    } catch (err) {
      deps.log('freeze limit load failed — keeping the previous table', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  void refreshFreeze()
  const timer = setInterval(() => void refreshFreeze(), FREEZE_REFRESH_MS)
  timer.unref()

  /**
   * The rails are built HERE rather than taken off `ApiDeps`, which does not
   * carry them. They are the same two objects by construction — the paper
   * collection and the gateway queue — and `LiveRail` re-checks the allowlist
   * itself, so the live path has the same two independent gates it has on the
   * `/actions` side.
   */
  const emit = emitOf(deps)
  const book = deps.book

  const rails = {
    // The paper rail pushes its own fills at the point it writes them; the live
    // rail cannot, because the fill happens in `apps/order-gateway` and arrives
    // back through `POST /v1/desk/stream/notify`.
    paper: new PaperRail(deps.db, emit),
    // THIS ROUTE BUILDS ITS OWN RAILS, separate from `main.ts`'s. Both must be
    // given the same allowlist source or they disagree — which they did: this
    // one was left on the env set while `main.ts` moved to the strategy row, so
    // a tag switched ON in the portal was still refused here, by the rail,
    // naming a gate the operator had already satisfied.
    live: new LiveRail(
      deps.db,
      liveAllowlistFromStrategies(deps.db.collection('desk-strategies'), livePin),
    ),
  }

  /**
   * Where each rail puts its orders, read OFF the rails rather than restated.
   *
   * A replay of a submission stuck in `ROUTING` reconciles against these
   * collections to find out what actually went out. Probing the wrong one
   * would report a live order as never routed, which is the single answer that
   * talks a caller into placing it a second time — so the live name comes from
   * the rail's own executor choice (`LiveExecutor`) and moves with it.
   */
  const orderCollections = {
    paper: COLLECTIONS.paperTrade,
    live: LIVE_COLLECTION[rails.live.executor],
  }

  const service = new SubmitService({
    store: deps.store,
    rails,
    master: deps.master,
    // `marks` is optional on ApiDeps (tests build it without one). Without a
    // mark source every paper submit is refused rather than booked at 0, which
    // is the safe direction: a paper book with fabricated prices is worse than
    // no paper book.
    marks: deps.marks ?? { price: () => null, spot: () => null },
    freeze: () => freeze,
    liveTags: livePin,
    orderCollections,
    /**
     * The SAME dials the decision path prices with, so the two endpoints
     * cannot send different order types for the same intent. Without this a
     * submit that states no `orderType` reaches the gateway as MARKET, and the
     * broker rejects market orders — see `submit.ts`'s pricing block.
     */
    marketable: marketableFromEnv(),
    now: deps.now,
    log: deps.log,
    // The desk-wide risk limits (F-28), when the operator configured any. Same
    // gate, same limits and same wording as the decision path — one desk, one
    // set of caps, whichever rail an order arrives on.
    ...(deps.risk === undefined ? {} : { risk: deps.risk }),
    // Carries the REFUSALS this endpoint journals. Omitted entirely when no
    // socket is attached — `exactOptionalPropertyTypes` means an explicit
    // `undefined` is not the same as an absent key.
    ...(emit === undefined ? {} : { emit }),
    /**
     * The in-memory book, told about a hosted strategy's fills as they are
     * journalled. Omitted entirely when no book is attached, for the same reason
     * `emit` is — and the book's own 60s reconcile means the worst case of it
     * being absent is a minute of staleness, never a lost position.
     */
    ...(book === undefined ? {} : { journal: (e: JournalEntry) => book.onJournal(e) }),
  })

  return async (ctx: RouteCtx): Promise<boolean> => {
    const { path, method, send, log } = ctx
    if (path !== '/v1/desk/submit' || method !== 'POST') return false

    const parsed = validateSubmitRequest(await ctx.readJson())
    if (!parsed.ok) {
      send(400, { error: parsed.error })
      return true
    }

    const result = await service.submit(parsed.value)
    /**
     * Three outcomes, three log lines. "refused" and "outcome UNKNOWN" are both
     * `accepted: false` on the wire, and collapsing them here would hide the
     * one an operator actually has to act on: an indeterminate submission may
     * have real exposure behind it that no ledger has booked.
     */
    const headline = result.accepted
      ? 'order submitted'
      : result.status === 'ROUTING'
        ? 'order outcome UNKNOWN — claimed, never reported back'
        : 'order refused'
    log(headline, {
      tag: parsed.value.tag,
      mode: parsed.value.mode,
      symbol: parsed.value.instrument.tradingsymbol,
      clientOrderId: result.clientOrderId,
      replayed: result.replayed,
      status: result.status,
      ...(result.accepted
        ? {
            orders: result.orders.length,
            // The routed size, not the intended one: a log that reports the
            // intent makes a partial route invisible in exactly the place
            // someone would go looking for it.
            routedLots: result.routedLots,
            intendedLots: result.intendedLots,
          }
        : { reason: result.reason }),
    })
    // 200 even on a refusal: the request WAS processed and the body says
    // exactly which gate refused. A 4xx would invite the strategy to retry an
    // order that may have partly routed.
    send(200, result)
    return true
  }
}
