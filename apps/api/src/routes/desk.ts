/**
 * The bridge's original endpoints — books, positions, decisions, safety.
 *
 * Moved verbatim out of `server.ts` when the routing seam was introduced. The
 * behaviour and the reasoning in the comments are unchanged; only the dispatch
 * mechanism around them is new.
 */

import type { ApiDeps, Route, RouteCtx } from './kit.ts'
import { isObject, limitOf, modeOf, suffixOf } from './kit.ts'
import { venueDay } from '../venue.ts'
import { aggressionPctError, validateDeclareRequest, validateSeedRequest } from '../validate.ts'
import { heldFromFills } from '../held-position.ts'
import {
  isAdded,
  isOn,
  validateBulkSwitch,
  validateStrategyCreate,
  validateStrategyPatch,
  type StrategyRow,
} from '../strategies.ts'
import type { DeskMode } from '../contract.ts'
import type { AuthGate } from '../authgate.ts'
import {
  runtimeKey,
  RUNTIME_COLLECTION,
  toRuntimeView,
  type RuntimeView,
} from '../../../runner/src/runtime.ts'
import { guardStore } from '../day-guard.ts'
import { AUDIT_DEFAULT_LIMIT, AUDIT_MAX_LIMIT, auditLog, ensureAuditIndex } from '../audit.ts'
import { hostedTags, isHostedTag } from '../../../runner/src/catalogue.ts'
import { HOSTED_STRATEGIES } from '../registry-seed.ts'
import { buildChain, chainExpiries } from '../chain.ts'
import { repairHoldLookup, type RepairHold } from '../repair-apply.ts'
import type { PositionsResponse } from '../service.ts'
import {
  BOOK_MARGIN_STALE_MS,
  brokerCalibration,
  brokerFigures,
  findNumber,
} from '../book-margin.ts'
import { COLLECTIONS } from '../store.ts'

/**
 * What this module is built with: the shared bag plus the password gate the
 * live-arming endpoints re-authenticate against.
 */
type DeskDeps = ApiDeps & { readonly gate: AuthGate }

/**
 * What `GET /v1/desk/positions?tag=` answers with: the book, plus whether a
 * multi-leg repair is executing on it right now.
 *
 * THE HOLD IS ADDED HERE RATHER THAN IN `service.ts` because it is not part of
 * the book — nothing about the positions changes while a repair runs. It is a
 * fact about the ORDER PATH, and this is simply the payload the Python driver
 * already polls every tick, which is why it rides along instead of costing a
 * second endpoint and a second poll.
 *
 * `repairHold` IS ALWAYS PRESENT, null when nothing is running. The driver
 * reads one stable key: an absent field and a null one are the same to a
 * `.get()`, but they are not the same to a reader that has to tell "no hold"
 * apart from "this bridge cannot say", and only one of those may let it act.
 */
export type PositionsPayload = PositionsResponse & {
  readonly repairHold: RepairHold | null
}

/**
 * How old the broker snapshot may be before it is flagged stale. The gateway
 * refreshes every 30s, so 90s is three missed polls — long enough not to blink
 * on one slow call, short enough that a dead poll loop is visible fast.
 */
const BROKER_SNAPSHOT_STALE_MS = 90_000

/**
 * Current runner state per `tag:mode`.
 *
 * KEYED BY MODE AS WELL AS TAG, because one row can now be supervised twice —
 * a paper instance and a live instance of the same strategy, each with its own
 * position count and its own failures. Keying by tag alone would render one of
 * them under the other's name, and "0 open positions" borrowed from the paper
 * instance is exactly the reading that talks an operator out of investigating a
 * stranded live leg.
 *
 * NEVER THROWS. The runner is a separate process that may legitimately not be
 * running, and a registry listing that 500s because of that would take the
 * portal's on/off switches down with it — the one surface an operator needs
 * most when something is wrong.
 *
 * AND THAT IS EXACTLY WHY EACH VIEW CARRIES `stale`. The runner not running is a
 * normal condition here, but nothing removes its last documents when it goes —
 * the delete sweep in `runtimePublisher` only runs while the runner is alive to
 * run it — so a dead runner leaves `running` on the strategies page indefinitely.
 * One clock read is taken for the whole listing (see `toRuntimeView`) so two
 * rows cannot be judged against two different instants.
 */
async function loadRuntime(deps: ApiDeps): Promise<Map<string, RuntimeView>> {
  const out = new Map<string, RuntimeView>()
  const now = Date.now()
  try {
    for (const doc of await deps.db.collection(RUNTIME_COLLECTION).find({}).toArray()) {
      const tag = doc['tag']
      const mode = doc['mode']
      const view = toRuntimeView(doc, now)
      // A doc with no `mode` predates the per-mode runner and describes a
      // supervision that is no longer running. It is DROPPED rather than shown
      // against one of the two instances: a stale state rendered as current is
      // worse than an absent one, which the page already knows how to say.
      if (typeof tag !== 'string' || (mode !== 'paper' && mode !== 'live') || view === null) continue
      out.set(runtimeKey(tag, mode), view)
    }
  } catch (err) {
    deps.log('runtime state unavailable', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
  return out
}

/**
 * Attach `runtime` to hosted rows, for the mode the caller is looking at.
 *
 * The join stays ONE-SIDED: `runtime` is attached only to `hosted` rows,
 * because we do not supervise the external Python processes and "stopped" is
 * exactly the wrong thing to show for a desk that is running fine and simply is
 * not ours to watch (contract §6).
 *
 * On the management listing (`?all=1`) there is no single mode being viewed, so
 * LIVE wins when the row is added to it. That is a choice the addendum does not
 * make: the alternative is showing the paper instance's state beside a live
 * switch, and of the two possible confusions, under-reporting a live strategy's
 * trouble is the one that costs money.
 */
function withRuntime(
  row: StrategyRow,
  runtimeByKey: Map<string, RuntimeView>,
  viewMode: DeskMode | null,
): StrategyRow | (StrategyRow & { runtime: RuntimeView }) {
  if (row.kind !== 'hosted') return row
  const mode = viewMode ?? (isAdded(row.modes, 'live') ? 'live' : 'paper')
  const runtime = runtimeByKey.get(runtimeKey(row.tag, mode))
  return runtime === undefined ? row : { ...row, runtime }
}

/**
 * What the page renders when the day guard has already stopped a rail today.
 *
 * `dailyLimits` needs nothing here — it is a field of the row and travels with
 * it. This is the OTHER half, which lives in its own collection: whether the
 * limits have actually been hit today, so a switch that is off can say WHY it
 * is off rather than looking like an operator's own stop.
 */
export interface DayGuardView {
  readonly fired: true
  readonly trigger: 'target' | 'stop'
  readonly pnlAtTrigger: number
  readonly firedAt: number
  /** The figure above came from realised alone, so it understates the move. */
  readonly incomplete: boolean
}

/**
 * Today's guard records, keyed like the runtime map.
 *
 * NEVER THROWS, for the same reason `loadRuntime` does not: the switches on
 * this page are the control an operator reaches for when something is wrong,
 * and taking the whole listing down over a decoration would be the worst
 * possible trade.
 *
 * Read only when some row is actually armed. On a desk with no limits set this
 * is a query that could only ever return nothing.
 */
async function loadDayGuards(
  deps: ApiDeps,
  nowMs: number,
): Promise<Map<string, DayGuardView>> {
  const out = new Map<string, DayGuardView>()
  try {
    for (const record of await guardStore(deps.db).today(venueDay(nowMs, deps.venue))) {
      out.set(runtimeKey(record.tag, record.mode), {
        fired: true,
        trigger: record.trigger,
        pnlAtTrigger: record.pnlAtTrigger,
        firedAt: record.firedAt,
        incomplete: record.incomplete,
      })
    }
  } catch (err) {
    deps.log('day guard records unavailable', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
  return out
}

/** Attach today's guard record for the rail being viewed, when there is one. */
function withDayGuard<T extends StrategyRow>(
  row: T,
  guardsByKey: Map<string, DayGuardView>,
  viewMode: DeskMode | null,
): T | (T & { dayGuard: DayGuardView }) {
  // Same rule as `withRuntime` on the management listing: with no single rail
  // in view, LIVE wins where the row is on it. Under-reporting a live stop is
  // the confusion that costs money.
  const mode = viewMode ?? (isAdded(row.modes, 'live') ? 'live' : 'paper')
  const guard = guardsByKey.get(runtimeKey(row.tag, mode))
  return guard === undefined ? row : { ...row, dayGuard: guard }
}

export function deskRoutes(deps: DeskDeps): Route {
  const { service, master, marks, store, gate } = deps
  /**
   * The apply service's OWN definition of a held tag, as a function of the
   * database — a run inside its TTL, plus the adoption grace a finished one
   * serves out (`REPAIR_HOLD_GRACE_MS`). Asked through `repairHoldLookup`
   * rather than re-queried here for the reason `routes/repair.ts` gives at
   * length: a second hand-written query agrees today and drifts the first time
   * either end of that rule moves, and here a drift means the driver trading
   * into a repair the server believes is still in flight.
   */
  const repairHold = repairHoldLookup(deps.db, deps.now)
  /**
   * WHO DID WHAT. One writer for this module's mutations, and the reader behind
   * `GET /v1/desk/audit`. Fail-soft by construction — see `audit.ts`: no line
   * below can fail the act it describes.
   */
  const audit = auditLog(deps)
  // Created HERE and only here, though four modules write the collection: this
  // is the module that READS it, and one boot-time attempt is enough. See
  // `ensureAuditIndex` for why it is fire-and-forget.
  ensureAuditIndex(deps)

  return async (ctx: RouteCtx): Promise<boolean> => {
    const { path, method, url, send, log } = ctx

    if (path === '/v1/desk/positions' && method === 'GET') {
      // Books are keyed by TAG, not symbol — see store.ts. `tag` names ONE
      // book. `symbol` is no longer a key, only a filter: a symbol can carry
      // several tags' books at once, so it answers with all of them.
      const tag = url.searchParams.get('tag')
      const symbol = url.searchParams.get('symbol')
      const mode = modeOf(url)
      if (tag !== null) {
        // The ONE caller that asks for realised-to-date: this is the payload
        // the book page draws its Positions table from, and the Total row
        // needs the booked figure to show the net (see the field's docstring).
        // The symbol branch below and the books() loops never ask, so the tab
        // strip's per-book polls stay off the fill journal.
        //
        // The hold rides on THIS branch only. The `symbol` listing below and
        // the tab strip are dashboard reads; the tag payload is what the Python
        // driver polls every tick, and it is the driver that has to stand down.
        //
        // A READ THAT THROWS IS NOT ANSWERED WITH `null`. It propagates, and the
        // driver sees a failed poll — which it already has to survive — rather
        // than a payload claiming no repair is running on the strength of a
        // register nobody could read. Fail-soft here would be the one direction
        // this answer must never be wrong in (`routes/repair.ts`, same rule).
        //
        // BESIDE THE BOOK, NOT AFTER IT. The two reads share nothing — one
        // prices the legs, the other looks up one run document — so awaiting
        // them in series would add the register's round trip to the latency of
        // a poll the driver makes every tick on every book. Both are started
        // before either is awaited.
        const [book, hold] = await Promise.all([
          service.positions(tag, mode, { realised: true }),
          repairHold(tag),
        ])
        const payload: PositionsPayload = { ...book, repairHold: hold }
        send(200, payload)
        return true
      }
      /**
       * `symbol` is a LIST filter now, not a key. It used to name one book,
       * which is exactly the assumption that let two variants overwrite each
       * other. Answering with an array rather than picking one is the honest
       * shape — there is no "the" book for a symbol any more.
       */
      if (symbol !== null) {
        const rows = await service.booksForSymbol(symbol, mode)
        send(200, { books: rows })
        return true
      }
      send(400, { error: 'tag or symbol is required' })
      return true
    }

    if (path === '/v1/desk/diff' && method === 'GET') {
      const tag = url.searchParams.get('tag')
      if (tag === null) {
        send(400, { error: 'tag is required' })
        return true
      }
      send(200, await service.diff(tag, modeOf(url)))
      return true
    }

    if (path === '/v1/desk/declare' && method === 'POST') {
      const parsed = validateDeclareRequest(await ctx.readJson())
      if (!parsed.ok) {
        send(400, { error: parsed.error })
        return true
      }
      await service.declare(
        parsed.value.tag,
        parsed.value.symbol,
        parsed.value.legs,
        parsed.value.greeks,
      )
      send(200, { ok: true })
      return true
    }

    /**
     * SEED — record legs already held at the broker. It routes nothing, and
     * that is exactly why it needs guarding: it is the one endpoint that can
     * write a position into the desk out of nothing, or erase one.
     *
     * TWO THINGS COST THE PASSWORD (F-30):
     *
     *  - `mode: 'live'`, because the legs written here become what the desk
     *    believes the live account holds — the number every exit, every delta
     *    and every P&L on the live rail is computed from.
     *  - `replace: true` in either mode, because the legs handed in ARE the
     *    book afterwards. That is the same erasure the book DELETE refuses on
     *    principle, and it was reachable by any credential that got this far,
     *    including the shared machine bearer the Python desk carries.
     *
     * A MACHINE PRINCIPAL THEREFORE CANNOT DO EITHER, ever: `authsvc` refuses
     * re-authentication for a machine by design ("an automated client must not
     * be able to turn live trading on by itself"), and this is the same class
     * of act. The operator-run CLI is unaffected — `cli.ts seed` calls
     * `seedBook` directly against Mongo and never comes through here.
     */
    if (path === '/v1/desk/seed' && method === 'POST') {
      const raw = bodyObject(await ctx.readJson())
      const parsed = validateSeedRequest(raw)
      if (!parsed.ok) {
        send(400, { error: parsed.error })
        return true
      }
      if (parsed.value.mode === 'live' || parsed.value.replace) {
        const denied = await gate.reauth(ctx.principal, raw['password'])
        if (denied !== null) {
          send(403, { error: denied, reauthRequired: true })
          return true
        }
      }
      /**
       * AND REPLACE IS REFUSED WHILE ANYTHING IS OPEN.
       *
       * `seedBook`'s own guard asks `desk-books` whether it holds legs — the
       * very record the replace overwrites — so a book that had gone stale (or
       * had never been written) satisfied it while a real position stood
       * behind it. The fills are the independent answer, and the refusal names
       * the contracts so the next step is obvious.
       */
      if (parsed.value.replace) {
        const open = await heldFromFills(store, parsed.value.tag, parsed.value.mode)
        if (open.unreadable.length > 0 || open.capped) {
          send(409, {
            error:
              `the stored fills for '${parsed.value.tag}' could not be read completely, so the ` +
              `desk cannot tell whether this book is open — and a replace would overwrite its ` +
              `legs either way. ` +
              (open.unreadable.length > 0
                ? open.unreadable.join('; ')
                : 'the fill read hit its cap'),
            malformedFills: open.unreadable,
            fillsTruncated: open.capped,
          })
          return true
        }
        if (open.held.length > 0) {
          send(409, {
            error:
              `'${parsed.value.tag}' still holds ${open.held.length} open position(s) in ` +
              `${parsed.value.mode} — ` +
              `${open.held.map((p) => `${p.tradingsymbol} ${p.qty > 0 ? '+' : ''}${p.qty}`).join(', ')}. ` +
              `A replace would make these legs the book, erasing the desk's record of what is ` +
              `really open. Flatten it first, or seed without replace.`,
            legs: open.held.map((p) => p.tradingsymbol),
          })
          return true
        }
      }
      try {
        const result = await service.seed(parsed.value)
        log('book seeded', {
          symbol: parsed.value.symbol,
          mode: parsed.value.mode,
          booked: result.booked.length,
          unresolved: result.unresolved.length,
        })
        // The one endpoint that can write a position into the desk out of
        // nothing, or erase one. `replace` is named in the action rather than
        // hidden in the detail — the two are different acts.
        await audit.record({
          principal: ctx.principal,
          source: '/v1/desk/seed',
          action: parsed.value.replace ? 'REPLACED a book by seeding it' : 'seeded legs into a book',
          tag: parsed.value.tag,
          mode: parsed.value.mode,
          detail: {
            symbol: parsed.value.symbol,
            booked: result.booked.length,
            unresolved: result.unresolved.length,
          },
        })
        send(200, result)
      } catch (err) {
        // Refusing to overwrite a non-empty book is a client error, not a bug:
        // the caller has to say `replace` deliberately.
        send(409, { error: err instanceof Error ? err.message : String(err) })
      }
      return true
    }

    if (path === '/v1/desk/killswitch' && method === 'GET') {
      send(200, await service.killSwitch())
      return true
    }

    /** The broker link — wish and gateway ack in one answer. See `safety.ts`. */
    if (path === '/v1/desk/broker-link' && method === 'GET') {
      send(200, await service.brokerLink())
      return true
    }

    /**
     * THE OPERATOR AUDIT LOG — every mutation this bridge made, newest first.
     *
     * OPERATOR-ONLY, deliberately. The Python desk's shared bearer can read
     * almost everything else here, and this one list is different in kind: it
     * names the people who act on this desk and the order in which they did it.
     * A machine has no use for it and every automated client that ever holds
     * that token would inherit the read. `403`, not an empty list, so a client
     * that expected data learns why it has none.
     *
     * Capped hard (`AUDIT_MAX_LIMIT`) rather than trusted to the caller: this
     * collection is append-only and grows for the life of the desk.
     */
    if (path === '/v1/desk/audit' && method === 'GET') {
      if (ctx.principal.kind !== 'user') {
        send(403, {
          error:
            'the audit log is an operator surface — a machine token may not read who did what',
        })
        return true
      }
      send(200, {
        entries: await audit.recent(limitOf(url, AUDIT_DEFAULT_LIMIT, AUDIT_MAX_LIMIT)),
      })
      return true
    }

    if (path === '/v1/desk/killswitch' && method === 'POST') return handleKillSwitchSet(deps, ctx)

    if (path === '/v1/desk/broker-link' && method === 'POST') return handleBrokerLinkSet(deps, ctx)

    if (path === '/v1/desk/close-all' && method === 'POST') return handleCloseAll(deps, ctx)

    /**
     * The strategy registry — the portal's per-mode on/off switches.
     *
     * THE LISTING IS FILTERED BY MEMBERSHIP, NOT BY THE SWITCH (contract
     * addendum §3/§4). Paper and live are separate pages so "am I looking at
     * real money?" is answered by where you are rather than by a control you
     * have to notice, and each page asks for its own mode — returning every row
     * ADDED to it, switched on or off. Filtering on `enabled` instead would
     * take a strategy out of the table the moment it was paused, and the only
     * way back would be to delete and re-add the row.
     *
     * `?all=1` is the management surface and returns everything, including rows
     * added to neither, so the add modal knows what is still available.
     *
     * A bare `GET` with neither means PAPER, per contract §0's rule that an
     * absent `mode` defaults to paper. The addendum does not say what a bare
     * GET returns, and this is the safe reading: defaulting to `all` would make
     * the growing registry the default view, while defaulting to live would put
     * live rows in front of a caller that never asked for them.
     *
     * Runtime lives in a SIBLING collection rather than on the row: the runner
     * heartbeats every second, `patchStrategy` is a read-modify-write, and a
     * heartbeat landing between that read and that write would clobber a switch
     * the operator had just flipped.
     */
    if (path === '/v1/desk/strategies' && method === 'GET') {
      const all = url.searchParams.get('all') === '1'
      const viewMode = all ? null : modeOf(url)
      const rows = (await service.strategies()).filter(
        (r) => viewMode === null || isAdded(r.modes, viewMode),
      )
      const hosted = rows.some((r) => r.kind === 'hosted')
      // Only pay for the lookup when there is a hosted row to attach it to.
      const runtimeByKey = hosted ? await loadRuntime(deps) : new Map<string, RuntimeView>()
      // Likewise: no row carries limits, so no row can have tripped them.
      const guardsByKey = rows.some((r) => r.dailyLimits !== undefined)
        ? await loadDayGuards(deps, deps.now())
        : new Map<string, DayGuardView>()
      send(200, {
        strategies: rows.map((row) =>
          withDayGuard(withRuntime(row, runtimeByKey, viewMode), guardsByKey, viewMode),
        ),
      })
      return true
    }

    /**
     * Catalogue tags NOT YET ADDED TO THIS MODE — the add form's options.
     *
     * Filtered on membership of the mode being added to, not on the existence
     * of a row. A strategy already running on paper is exactly the one an
     * operator wants to add to live, and excluding it because it "already
     * exists" would make that impossible from the form. `registered` says which
     * case each row is, so the modal can show "add to live" differently from
     * "register and add".
     *
     * Read from the RUNNER's own hosted-tag list, not from a second list of
     * names — and from `hostedTags()`, which spans BOTH hosting paths.
     * `CATALOGUE` alone excludes the MIRROR_* tags, which are hosted by
     * `MirrorHost`; asking it whether a tag can run told the operator three
     * fully-implemented strategies did not exist.
     * A hand-maintained copy would drift, and the drift shows up as a form that
     * offers a tag `POST` then refuses with a 400, or worse offers nothing at
     * all after a new strategy is added. The label comes from the Phase C seed
     * table where there is one, so a tag the operator has never seen still
     * arrives with the name it is called everywhere else.
     */
    if (path === '/v1/desk/strategies/available' && method === 'GET') {
      const mode = modeOf(url)
      const rows = new Map((await service.strategies()).map((r) => [r.tag, r]))
      const labels = new Map(HOSTED_STRATEGIES.map((s) => [s.tag, s]))
      send(200, {
        mode,
        available: hostedTags()
          .filter((tag) => {
            const row = rows.get(tag)
            return row === undefined || !isAdded(row.modes, mode)
          })
          .sort()
          .map((tag) => ({
            tag,
            kind: 'hosted' as const,
            label: rows.get(tag)?.label ?? labels.get(tag)?.label ?? tag,
            autostartAt: rows.get(tag)?.autostartAt ?? labels.get(tag)?.autostartAt ?? '',
            /** True when the tag has a row already and is only gaining a mode. */
            registered: rows.has(tag),
          })),
      })
      return true
    }

    if (path === '/v1/desk/strategies' && method === 'POST') return handleStrategyAdd(deps, ctx)

    if (method === 'DELETE') {
      const rest = suffixOf(path, '/v1/desk/strategies/')
      const parts = rest === null ? [] : rest.split('/')
      if (parts.length === 3 && parts[1] === 'modes') {
        return handleStrategyModeRemove(deps, ctx, parts[0] ?? '', parts[2])
      }
      if (parts.length === 1 && parts[0] !== '') return handleOrphanStrategyDelete(deps, ctx, parts[0] ?? '')
    }

    if (path === '/v1/desk/strategies/bulk' && method === 'POST') return handleBulkSwitch(deps, ctx)

    if (method === 'PATCH') {
      const tag = suffixOf(path, '/v1/desk/strategies/')
      if (tag !== null) return handleStrategyPatch(deps, ctx, tag)
    }

    if (path === '/v1/desk/orders' && method === 'GET') {
      const failuresOnly = url.searchParams.get('failures') === '1'
      send(200, {
        events: await service.orderEvents({
          limit: limitOf(url, 200),
          failuresOnly,
          // Scoped like every other page: PAPER shows the paper rail's own
          // fills plus its refusals, LIVE shows live routing.
          mode: modeOf(url),
        }),
      })
      return true
    }

    if (path === '/v1/desk/trades' && method === 'GET') {
      /**
       * ONE ENDPOINT, TWO RAILS, and on paper TWO WRITERS — see
       * `service.paperTrades`. The synchronous paper rail writes
       * `desk-paper-trade`; an engine paper order is worked through the gateway
       * queue and its fill lands in `desk-fills` stamped `mode: 'paper'`. Both
       * are paper trades and both belong on this answer, which is why the paper
       * branch is a union and the live one is not.
       */
      const limit = limitOf(url, 200)
      const mode = modeOf(url)
      const tag = url.searchParams.get('tag')
      const symbol = url.searchParams.get('symbol')
      send(200, {
        trades:
          mode === 'live'
            ? await service.fills({ tag, limit })
            : await service.paperTrades({ tag, symbol, limit }),
      })
      return true
    }

    if (path === '/v1/desk/books' && method === 'GET') {
      send(200, { books: await service.books(modeOf(url)) })
      return true
    }

    /**
     * CANCEL A BROKER ORDER.
     *
     * Records the REQUEST; the order-gateway performs it, because that process
     * owns the XTS session and a second session here would share the one token
     * document and could invalidate the gateway's mid-order. Same split
     * `desk-gateway-orders` already uses for placements.
     *
     * The caller sends ONLY an order id. `clientID` — which a raw curl must
     * supply on a dealer account, and whose absence returns `e-orders-0002` —
     * is sourced by the gateway from the order row itself.
     *
     * 202, not 200: the cancel has been ACCEPTED, not performed. Reporting
     * success here would be a lie the operator might act on. Poll
     * `GET /v1/desk/broker/cancels` or watch the order leave the Broker page.
     *
     * The order id is the `_id`, so re-requesting a cancel is idempotent and a
     * double-click cannot queue two.
     */
    {
      const cancelId = suffixOf(path, '/v1/desk/broker/orders/')
      if (cancelId !== null && cancelId.endsWith('/cancel') && method === 'POST') {
        const id = cancelId.slice(0, -'/cancel'.length)
        if (id === '') {
          send(400, { error: 'an order id is required' })
          return true
        }
        await deps.db.collection('desk-broker-cancels').updateOne(
          { _id: id as never },
          {
            $set: { status: 'pending', requestedAt: deps.now(), error: '' },
            /**
             * THE PRINCIPAL, not the literal `'desk'` this used to store (F-53).
             * Cancelling a working order at the broker is an act on the money
             * path and it was the one such control that recorded nobody at all.
             *
             * `$setOnInsert`, so the row keeps the FIRST requester: the id is
             * the order id, a second click is the same request, and rewriting
             * the name would file the cancel under whoever retried it. Every
             * request — including the retries — is in the audit log below.
             */
            $setOnInsert: { requestedBy: ctx.principal.name },
          },
          { upsert: true },
        )
        log('broker cancel requested', { appOrderID: id, requestedBy: ctx.principal.name })
        await audit.record({
          principal: ctx.principal,
          source: '/v1/desk/broker/orders/:id/cancel',
          action: 'requested a broker order cancel',
          detail: { appOrderID: id },
        })
        send(202, { accepted: true, appOrderID: id, status: 'pending' })
        return true
      }
    }

    /** The outcome of recent cancel requests, so a caller can see what happened. */
    if (path === '/v1/desk/broker/cancels' && method === 'GET') {
      const rows = await deps.db
        .collection('desk-broker-cancels')
        .find({})
        .sort({ requestedAt: -1 })
        .limit(50)
        .toArray()
      send(200, { cancels: rows })
      return true
    }

    /**
     * MARGIN, AT THE ACCOUNT. Checked before `/v1/desk/broker` so the longer
     * path is not swallowed by the prefix beside it.
     */
    if (path === '/v1/desk/broker/funds' && method === 'GET') return handleBrokerFunds(deps, ctx)
    if (path === '/v1/desk/margin' && method === 'GET') return handleBookMargin(deps, ctx)

    if (path === '/v1/desk/broker' && method === 'GET') return handleBrokerSnapshot(deps, ctx)

    /**
     * EVERY UNDERLYING THE MASTER ACTUALLY LISTS — the source for the Symbol
     * picker on the Build-book screen.
     *
     * It exists because the alternative is a symbol typed from memory. A
     * mistyped name does not fail here: `/v1/desk/instruments/BAJFINANC` 404s
     * with "no listed expiries", the operator reads that as "the master is
     * behind", and the real answer — that this name is not a thing — is never
     * said. Serving the list means the name cannot be wrong in the first place.
     *
     * `underlyings()`, NOT `spotUnderlyings()`. The two differ: the first is
     * every name with a listed OPTION CHAIN, the second every name with a
     * resolvable SPOT row. A book is built out of option legs, so a name with a
     * spot and no chain is one this picker must not offer — choosing it would
     * put the operator straight back at the 404 this endpoint removes. Every
     * name here is guaranteed to answer `?expiry=` with something.
     *
     * No auth exception and no filtering by mode: it is static contract
     * metadata, the same list the chain endpoint next to it already exposes one
     * name at a time.
     */
    if (method === 'GET' && path === '/v1/desk/instruments') {
      send(200, { underlyings: master.current().underlyings() })
      return true
    }

    if (method === 'GET') {
      const underlying = suffixOf(path, '/v1/desk/instruments/')
      if (underlying !== null) {
        const m = master.current()
        const expiry = url.searchParams.get('expiry') ?? m.expiries(underlying)[0]
        if (expiry === undefined) {
          send(404, { error: `no listed expiries for '${underlying}'` })
          return true
        }
        const chain = m.chain(underlying, expiry)
        if (chain === null) {
          send(404, { error: `no chain for ${underlying} ${expiry}` })
          return true
        }
        send(200, { ...chain, expiries: m.expiries(underlying) })
        return true
      }
    }

    if (method === 'GET') {
      /**
       * The Python desk's chain feed: raw price/oi/volume per strike per side,
       * plus spot and the near-future, each with its own `asOf`. See
       * `chain.ts` for why greeks are never served from here.
       */
      const chainFor = suffixOf(path, '/v1/desk/chain/')
      /**
       * `GET /v1/desk/chain/:symbol/expiries` — the listed option expiries, for
       * the option chain page's tabs. Read off the master alone, so it answers
       * on a dead feed too: a list of contracts is not a price.
       */
      if (chainFor !== null && chainFor.endsWith('/expiries')) {
        const underlying = chainFor.slice(0, -'/expiries'.length)
        if (underlying === '' || underlying.includes('/')) {
          send(404, { error: 'no such route' })
          return true
        }
        send(200, chainExpiries(master.current(), underlying))
        return true
      }
      if (chainFor !== null) {
        if (marks === undefined) {
          send(503, { error: 'quote cache unavailable' })
          return true
        }
        const m = master.current()
        const expiry = url.searchParams.get('expiry') ?? m.expiries(chainFor)[0]
        if (expiry === undefined) {
          send(404, { error: `no listed expiries for '${chainFor}'` })
          return true
        }
        send(200, buildChain({ master: m, marks, now: () => deps.now() }, chainFor, expiry))
        return true
      }
    }

    return false
  }
}

/** POST /v1/desk/killswitch — engage or release the halt. */
async function handleKillSwitchSet(deps: DeskDeps, ctx: RouteCtx): Promise<boolean> {
  const { send, log } = ctx
  const { service, gate } = deps
  // `bodyObject`, not a bare cast: `readBody` returns `{}` only for an EMPTY
  // body, so a literal `null` (or `"x"`, or `[]`) arrives as itself and the
  // very next property read throws — turning a malformed request into a 500
  // on the endpoint that engages the emergency brake. Anything that is not
  // an object becomes `{}` and falls into the 400 below.
  const body = bodyObject(await ctx.readJson())
  if (typeof body['enabled'] !== 'boolean') {
    send(400, { error: 'enabled must be a boolean' })
    return true
  }
  // RELEASING the halt is one of the two actions spec §5 puts behind a
  // password. Engaging it is not: making someone re-authenticate to STOP
  // trading would put a delay in front of the emergency brake.
  if (body['enabled'] === false) {
    const denied = await gate.reauth(ctx.principal, body['password'])
    if (denied !== null) {
      send(403, { error: denied, reauthRequired: true })
      return true
    }
  }
  // `setBy` is the AUTHENTICATED principal, never the request body. This is
  // the audit trail for the most dangerous control on the desk; letting the
  // caller name themselves makes it worthless — whoever released the halt
  // could file it under anyone.
  const state = await service.setKillSwitch(
    body['enabled'],
    typeof body['reason'] === 'string' ? body['reason'] : '',
    ctx.principal.name,
  )
  log(state.enabled ? 'KILL SWITCH ENGAGED' : 'kill switch released', {
    reason: state.reason,
    setBy: state.setBy,
  })
  // The one control that has always recorded who. It now records it in the
  // place every other control does as well, so the halt and everything around
  // it read as one sequence rather than one field and a log file.
  await auditLog(deps).record({
    principal: ctx.principal,
    source: '/v1/desk/killswitch',
    action: state.enabled ? 'ENGAGED the kill switch' : 'released the kill switch',
    detail: { enabled: state.enabled, reason: state.reason },
  })
  send(200, state)
  return true
}

/**
 * The broker link — pause live execution (`released`) or resume it (`connected`).
 *
 * THE SAME ASYMMETRY AS THE KILL SWITCH, for the same reason. PAUSING stops
 * live execution: the safe direction, so it carries no password — a prompt in
 * front of it would be a delay in front of the brake. RESUMING makes real
 * money placeable again, so it re-authenticates like releasing the halt does
 * (spec §5).
 *
 * The bridge writes the wish and enforces it itself (`brokerLinkRefusal`, in
 * `submit.ts` and `service.ts`). The answer here is the whole document.
 */
async function handleBrokerLinkSet(deps: DeskDeps, ctx: RouteCtx): Promise<boolean> {
  const { send, log } = ctx
  const { service, gate } = deps
  const body = bodyObject(await ctx.readJson())
  const desired = body['desired']
  if (desired !== 'connected' && desired !== 'released') {
    send(400, { error: "desired must be 'connected' or 'released'" })
    return true
  }
  if (desired === 'connected') {
    const denied = await gate.reauth(ctx.principal, body['password'])
    if (denied !== null) {
      send(403, { error: denied, reauthRequired: true })
      return true
    }
  }
  // `setBy` is the AUTHENTICATED principal, never the body — see the kill switch.
  const state = await service.setBrokerLink(
    desired,
    typeof body['reason'] === 'string' ? body['reason'] : '',
    ctx.principal.name,
  )
  log(desired === 'released' ? 'LIVE EXECUTION PAUSED — live orders are refused' : 'live execution resumed', {
    reason: state.reason,
    setBy: state.setBy,
  })
  await auditLog(deps).record({
    principal: ctx.principal,
    source: '/v1/desk/broker-link',
    action: desired === 'released' ? 'PAUSED live execution' : 'resumed live execution',
    detail: { desired, reason: state.reason },
  })
  send(200, state)
  return true
}

/**
 * Flatten. Works while the kill switch is engaged, by design.
 *
 * TWO WAYS TO NAME WHAT TO FLATTEN, and exactly one must be given:
 *
 *   - `symbol` — a desk book in `desk-books`. THE SHAPE MOVED: books are
 *     keyed by TAG now, so a symbol is a lookup, not a key, and it is
 *     RESOLVED against the stored books below. It used to synthesise
 *     `DESK_${symbol}` as the key, which after the re-keying named a book
 *     that does not exist — `loadBook` answered `[]` and the endpoint
 *     reported `DONE` with no fills over an open position, on the one
 *     control an operator uses to get OUT. Do not reintroduce a derived
 *     tag here; a symbol with no book, or with several, is refused.
 *   - `tag` — a HOSTED strategy's position, reconstructed from the fills
 *     `/v1/desk/submit` journalled. A hosted strategy has no book, which is
 *     why `symbol` could never reach one (2026-07-27 audit, C4).
 *
 * Requiring exactly one rather than preferring one is deliberate. A body
 * carrying both would be a caller that does not know which position it is
 * about to close, and silently picking for it is how the wrong book gets
 * flattened.
 *
 * `style` must be stated on both paths: 'fast' is MARKET (certain fill,
 * uncontrolled price) and 'limit' prices through the mark. Defaulting either
 * way picks a tradeoff the operator did not choose, in the one situation
 * where they are most likely to care which.
 */
async function handleCloseAll(deps: ApiDeps, ctx: RouteCtx): Promise<boolean> {
  const { send, log } = ctx
  const { service } = deps
  // See the kill switch above: a JSON `null` body must be a 400, not a 500.
  const body = bodyObject(await ctx.readJson())
  const raw = body['symbol']
  const style = body['style']
  const rawTag = body['tag']
  const symbol = typeof raw === 'string' && raw !== '' ? raw : null
  // A tag alone selects the hosted path. With a symbol present, `tag` keeps
  // its original meaning — the order-bus tag the book's exits route under.
  const hostedTag =
    symbol === null && typeof rawTag === 'string' && rawTag !== '' ? rawTag : null
  if (symbol === null && hostedTag === null) {
    send(400, {
      error:
        "state what to flatten: 'symbol' for a desk book, or 'tag' for a hosted strategy",
    })
    return true
  }
  if (style !== 'fast' && style !== 'limit') {
    send(400, { error: "style must be stated explicitly as 'fast' or 'limit'" })
    return true
  }
  if (body['mode'] !== 'paper' && body['mode'] !== 'live') {
    send(400, { error: "mode must be stated explicitly as 'paper' or 'live'" })
    return true
  }
  if (typeof body['decisionId'] !== 'string' || body['decisionId'] === '') {
    send(400, { error: 'decisionId is required — it makes a retried close-all safe' })
    return true
  }
  if (body['sinceMs'] !== undefined && typeof body['sinceMs'] !== 'number') {
    send(400, { error: 'sinceMs must be an epoch-ms number when present' })
    return true
  }
  /**
   * AGGRESSION IS A FRACTION, AND IT HAS A CEILING — checked once here, so
   * BOTH exits below (the hosted-tag path and the book path) are covered.
   *
   * `safety.ts:priceExit` computes `mark × (1 + aggression)` with no finiteness
   * check and no bound of its own, and this file's own doctrine — every numeric
   * field checked for finiteness, because a malformed number does not fail
   * loudly, it prices an order wrong — was simply not applied on the
   * money-moving path (F-34). `aggressionPct: 5`, the natural way to mistype
   * "5%", buys a ₹40 short back at a ₹240 limit.
   */
  const aggressionBad = aggressionPctError(body['aggressionPct'])
  if (aggressionBad !== null) {
    send(400, { error: aggressionBad })
    return true
  }
  if (hostedTag !== null) {
    const result = await service.flattenTag({
      tag: hostedTag,
      mode: body['mode'],
      decisionId: body['decisionId'],
      style,
      ...(typeof body['aggressionPct'] === 'number'
        ? { aggressionPct: body['aggressionPct'] }
        : {}),
      ...(typeof body['sinceMs'] === 'number' ? { sinceMs: body['sinceMs'] } : {}),
    })
    // Logged at the same level whether or not it worked: a flatten that
    // only partly went out is the case an operator most needs to see, and
    // `flat` is the field that says which happened.
    log('FLATTEN TAG', {
      tag: result.tag,
      mode: result.mode,
      flat: result.flat,
      legs: result.legs.length,
      routed: result.fills.length,
      failed: result.legs.filter((l) => !l.routed).map((l) => l.tradingsymbol),
      unpriceable: result.unpriceable.length,
      unresolved: result.unresolved,
      malformedFills: result.malformedFills.length,
    })
    // `flat` travels with it: "flattened" and "tried to flatten and did not get
    // there" are the two outcomes an audit reader most needs to tell apart.
    await auditLog(deps).record({
      principal: ctx.principal,
      source: '/v1/desk/close-all',
      action: 'flattened a hosted tag',
      tag: result.tag,
      mode: result.mode,
      detail: {
        style,
        decisionId: body['decisionId'],
        legs: result.legs.length,
        routed: result.fills.length,
        flat: result.flat,
      },
    })
    // 200 even when `flat` is false: the request WAS processed and the body
    // says per leg what happened. A 4xx would invite a blind retry of a
    // flatten that already partially routed.
    send(200, result)
    return true
  }
  if (symbol === null) {
    // Unreachable: the guard above rejects a body with neither. Written as a
    // branch rather than an assertion so the symbol path below is narrowed
    // by the compiler, not by a cast that a later edit could invalidate.
    send(400, { error: 'symbol is required' })
    return true
  }
  /**
   * WHICH BOOK. An explicit `tag` alongside a `symbol` still names it
   * outright — the caller has said which book it means. Without one the
   * symbol is resolved against what is actually stored, and anything other
   * than exactly one book is REFUSED.
   *
   * 409, not 404, for both refusals. This is the control an operator
   * reaches for to get out of a position, and the one thing they must never
   * be able to read the answer as is "already flat". A 404 on a flatten
   * says "nothing here" — which is the sentence a stale or mistyped symbol
   * would produce and the sentence a flat book would produce, and they are
   * opposite situations. A 409 says the desk's state cannot satisfy this
   * request as written, which is true of both "no such book" and "several
   * books, name one", and reads as something to act on rather than
   * something already done. The message names the symbol (and the
   * candidates) so the next request can be the right one.
   */
  let bookTag: string
  const tags = await service.bookTagsForSymbol(symbol, body['mode'])
  if (typeof rawTag === 'string' && rawTag !== '') {
    /**
     * A NAMED TAG STILL HAS TO NAME A REAL BOOK. The dashboard always sends
     * one, so this is the hot path — and it used to skip the refusals below
     * entirely: a mistyped tag loaded an empty book, closed nothing, answered
     * 200 DONE, and `saveBook` upserted a phantom row under the typo. The
     * 409 is the same one the tagless path already earned, for the same
     * reason: "no such book" must never be readable as "already flat".
     */
    if (!tags.includes(rawTag)) {
      log('CLOSE-ALL REFUSED', {
        symbol,
        mode: body['mode'],
        tag: rawTag,
        reason: 'unknown tag',
      })
      send(409, {
        error:
          `no ${body['mode']} book '${rawTag}' on ${symbol}: NOTHING WAS CLOSED. ` +
          `Check the tag${tags.length > 0 ? ` — this symbol's books are: ${tags.join(', ')}` : ''}.`,
        symbol,
        mode: body['mode'],
        candidates: tags,
      })
      return true
    }
    bookTag = rawTag
  } else {
    const first = tags[0]
    if (first === undefined) {
      log('CLOSE-ALL REFUSED', { symbol, mode: body['mode'], reason: 'no book' })
      send(409, {
        error:
          `no ${body['mode']} book for ${symbol}: NOTHING WAS CLOSED. This is not a ` +
          `report that the position is flat — the desk holds no book under that symbol ` +
          `at all. Check the symbol, or name the book with 'tag'.`,
        symbol,
        mode: body['mode'],
        candidates: [],
      })
      return true
    }
    if (tags.length > 1) {
      log('CLOSE-ALL REFUSED', { symbol, mode: body['mode'], reason: 'ambiguous', tags })
      send(409, {
        error:
          `${symbol} carries ${tags.length} ${body['mode']} books (${tags.join(', ')}): ` +
          `NOTHING WAS CLOSED. Name the one to flatten with 'tag'.`,
        symbol,
        mode: body['mode'],
        candidates: tags,
      })
      return true
    }
    bookTag = first
  }
  const result = await service.closeAll({
    symbol,
    mode: body['mode'],
    tag: bookTag,
    decisionId: body['decisionId'],
    style,
    ...(typeof body['aggressionPct'] === 'number'
      ? { aggressionPct: body['aggressionPct'] }
      : {}),
  })
  log('CLOSE-ALL', {
    symbol,
    // The book actually flattened. Logging only the symbol left no record
    // of WHICH of a symbol's books the operator closed.
    tag: bookTag,
    mode: body['mode'],
    style,
    fills: result.fills.length,
    unpriceable: result.unpriceable.length,
  })
  await auditLog(deps).record({
    principal: ctx.principal,
    source: '/v1/desk/close-all',
    action: 'closed a book',
    tag: bookTag,
    mode: body['mode'],
    detail: {
      symbol,
      style,
      decisionId: body['decisionId'],
      fills: result.fills.length,
      unpriceable: result.unpriceable.length,
    },
  })
  send(200, result)
  return true
}

/**
 * ADD a strategy to one mode's page, creating its row if it is new.
 *
 * The old "there is no POST" reasoning is superseded in its CONCLUSION only
 * — the reason behind it stands, and it is why three things are enforced:
 *
 *  - **The added mode arrives switched OFF**, enforced in
 *    `store.addStrategyMode` rather than trusted to this handler. Adding a
 *    strategy to a page and granting it permission to trade there are
 *    separate acts; a form that did both would make a typo a live order,
 *    with no moment at which a human confirmed the switch.
 *  - **A `hosted` tag with no runner implementation is a 400.** A hosted row
 *    nothing in the catalogue matches is a switch that LOOKS ARMED and runs
 *    nothing: the runner reports it `stopped`, the operator reads that as
 *    "not started yet", and the strategy they believe is trading has never
 *    existed. `external` is not checked, because an external row is a name
 *    for a Python process we deliberately do not know about.
 *  - **An existing row keeps everything but the new mode key.** Adding
 *    BN_BREAKOUT to live must not reset the label, kind, live lots or
 *    autostart it has been running on paper with.
 */
async function handleStrategyAdd(deps: ApiDeps, ctx: RouteCtx): Promise<boolean> {
  const { send, log } = ctx
  const { service } = deps
  const parsed = validateStrategyCreate(await ctx.readJson())
  if (!parsed.ok) {
    send(400, { error: parsed.error })
    return true
  }
  const add = parsed.value
  if (add.kind === 'hosted' && !isHostedTag(add.tag)) {
    send(400, {
      error:
        `no hosted implementation is registered for '${add.tag}' — the runner would ` +
        `supervise nothing, so the row would be a switch that looks armed and runs nothing. ` +
        `Add it to the runner catalogue first, or register it as 'external'.`,
    })
    return true
  }
  const row = await service.addStrategyMode(
    {
      tag: add.tag,
      kind: add.kind,
      label: add.label,
      autostartAt: add.autostartAt,
      liveLots: add.liveLots,
      lastSeenAt: 0,
      disabledReason: '',
    },
    add.mode,
  )
  if (row === 'exists') {
    // 409, never an overwrite: the tag names a row somebody may be trading
    // on, and "add" must not be able to reset its switches.
    send(409, { error: `'${add.tag}' is already added to ${add.mode}` })
    return true
  }
  log('strategy added to a mode (switched off)', {
    tag: row.tag,
    kind: row.kind,
    mode: add.mode,
  })
  await auditLog(deps).record({
    principal: ctx.principal,
    source: '/v1/desk/strategies',
    action: 'added a strategy to a mode',
    tag: row.tag,
    mode: add.mode,
    // `enabled: false` is stated rather than assumed: the row arrives switched
    // off by design, and an audit trail that leaves it out reads as an arming.
    detail: { kind: row.kind, enabled: false, liveLots: add.liveLots },
  })
  send(201, row)
  return true
}

/**
 * REMOVE a strategy from one mode's page. The row and its other mode
 * survive — "remove from live" is not "delete this strategy".
 *
 * REFUSED WHILE THE RUNNER REPORTS AN OPEN POSITION on that rail. A row
 * that vanishes off the page while holding risk is the trapped-position
 * failure again, and worse than the original: the operator cannot even see
 * the row to switch it back on, and `close-all` by tag is the only way out.
 * So the refusal names that route rather than doing it — flattening on a
 * removal would be the operator's decision made for them.
 *
 * Modelled as a DELETE on the membership rather than a PATCH that nulls the
 * key, so this check has exactly one place to live. `validateStrategyPatch`
 * rejects `modes.x: null` for the same reason.
 */
async function handleStrategyModeRemove(
  deps: ApiDeps,
  ctx: RouteCtx,
  tag: string,
  mode: string | undefined,
): Promise<boolean> {
  const { send, log } = ctx
  const { service } = deps
  if (mode !== 'paper' && mode !== 'live') {
    send(400, { error: "mode must be 'paper' or 'live'" })
    return true
  }
  const current = await deps.store.loadStrategy(tag)
  if (current === null || !isAdded(current.modes, mode)) {
    send(404, { error: `'${tag}' is not added to ${mode}` })
    return true
  }
  const open =
    current.kind === 'hosted'
      ? ((await loadRuntime(deps)).get(runtimeKey(tag, mode))?.openPositions ?? 0)
      : 0
  if (open > 0) {
    send(409, {
      error:
        `'${tag}' still holds ${open} open position(s) in ${mode} — removing it would take ` +
        `the row off the page while the risk is still on. Flatten it first with ` +
        `POST /v1/desk/close-all { tag, mode, style, decisionId }.`,
      openPositions: open,
    })
    return true
  }
  const removed = await service.removeStrategyMode(tag, mode)
  if (removed === null || removed === 'absent') {
    // Lost a race with another remove. Same answer either way.
    send(404, { error: `'${tag}' is not added to ${mode}` })
    return true
  }
  // Logged at WARN-level detail because removing a mode that was still
  // switched on is a stop as well as a removal, and the operator may not
  // have read it that way.
  log('strategy removed from a mode', {
    tag,
    mode,
    wasEnabled: isOn(current.modes, mode),
  })
  await auditLog(deps).record({
    principal: ctx.principal,
    source: '/v1/desk/strategies/:tag/modes/:mode',
    action: 'removed a strategy from a mode',
    tag,
    mode,
    // Removing a mode that was still ON is a stop as well as a removal, and the
    // operator may not have read it that way. The record says which it was.
    detail: { wasEnabled: isOn(current.modes, mode), kind: current.kind },
  })
  send(200, removed)
  return true
}

/**
 * DELETE an ORPHAN strategy row — `DELETE /v1/desk/strategies/:tag`.
 *
 * The row a book's registration made (`kind: 'external'`) and that its erase
 * did not take with it: added to NOTHING, and no registry row for the tag on
 * EITHER rail. Exactly the precondition the book erase applies before its own
 * `deleteOrphanStrategy` (`routes/books.ts`), offered on its own so the
 * leftovers of erases that predate that step — and of books purged by hand —
 * can be cleared.
 *
 * Everything else is a 409: a hosted row (a runner strategy has no book by
 * design), a row still added to a mode (remove the membership first, through
 * the route above, which owns that check), and a tag that still has a book.
 */
async function handleOrphanStrategyDelete(deps: ApiDeps, ctx: RouteCtx, tag: string): Promise<boolean> {
  const { send } = ctx
  const row = await deps.store.loadStrategy(tag)
  if (row === null) {
    send(404, { error: `'${tag}' has no strategy row` })
    return true
  }
  if (row.kind !== 'external') {
    send(409, { error: `'${tag}' is a ${row.kind} strategy, not a book's switch — it is never deleted here` })
    return true
  }
  if (Object.keys(row.modes).length > 0) {
    send(409, {
      error: `'${tag}' is still added to ${Object.keys(row.modes).join(', ')} — remove it from each mode first`,
    })
    return true
  }
  if ((await deps.store.getBook(tag, 'paper')) !== null || (await deps.store.getBook(tag, 'live')) !== null) {
    send(409, { error: `'${tag}' still has a book registered — erase the book, which takes its row with it` })
    return true
  }
  const deleted = await deps.store.deleteOrphanStrategy(tag)
  if (!deleted) {
    // Lost a race with an add: the filter is the precondition, so nothing went.
    send(409, { error: `'${tag}' changed while it was being deleted — nothing was deleted` })
    return true
  }
  ctx.log('orphan strategy row deleted', { tag })
  await auditLog(deps).record({
    principal: ctx.principal,
    source: '/v1/desk/strategies/:tag',
    action: 'deleted an orphan strategy row',
    tag,
    detail: { kind: row.kind },
  })
  send(200, { deleted: tag })
  return true
}

/**
 * Switch EVERY row on or off, one mode at a time.
 *
 * ONE MODE PER CALL. "Turn everything on" across both rails would let one
 * click arm live trading on fifteen strategies, and the mode is the whole
 * thing the operator is trying to keep straight.
 *
 * Turning ON in live costs the password, exactly as the per-row PATCH does.
 * Turning OFF never does, in either mode: a password prompt in front of a
 * mass stop is the same mistake as putting one in front of the kill switch.
 *
 * IT ACTS ON THE ROWS THE PAGE SHOWS: those ADDED to that mode. A row that
 * has never been added to live is not on the live page, and "turn
 * everything on" must not reach past what the operator can see and arm it.
 *
 * IT REPORTS PER TAG, never a count. A bulk action that says "15 changed"
 * while three silently did nothing is how an operator ends up believing a
 * strategy is off when it is running — so every row lands in exactly one of
 * `changed`, `unchanged` or `skipped`, and a skip names its reason.
 *
 * AND IT FLATTENS NOTHING. Switching a strategy off blocks its EXITS as
 * well as its entries (the deliberate asymmetry in `strategies.ts`), so a
 * bulk-off over strategies holding positions STRANDS them — the only way
 * out is `close-all`, which runs as the operator. Mass-liquidating on a
 * switch flip would be far worse than stranding, so the response carries
 * what is stranded and the operator chooses.
 */
async function handleBulkSwitch(deps: DeskDeps, ctx: RouteCtx): Promise<boolean> {
  const { send, log } = ctx
  const { service, gate } = deps
  const raw = bodyObject(await ctx.readJson())
  const parsed = validateBulkSwitch(raw)
  if (!parsed.ok) {
    send(400, { error: parsed.error })
    return true
  }
  const { mode, on } = parsed.value
  if (mode === 'live' && on) {
    const denied = await gate.reauth(ctx.principal, raw['password'])
    if (denied !== null) {
      send(403, { error: denied, reauthRequired: true })
      return true
    }
  }

  // Only the rows on that page. `isAdded`, not `isOn` — the table shows
  // switched-off rows, and those are precisely what a bulk-on is for.
  const rows = (await service.strategies()).filter((r) => isAdded(r.modes, mode))
  const runtimeByKey = rows.some((r) => r.kind === 'hosted')
    ? await loadRuntime(deps)
    : new Map<string, RuntimeView>()

  const changed: string[] = []
  const unchanged: string[] = []
  const skipped: { tag: string; reason: string }[] = []
  const stranded: { tag: string; openPositions: number }[] = []

  for (const row of rows) {
    if (isOn(row.modes, mode) === on) {
      unchanged.push(row.tag)
      continue
    }
    // Turning ON a hosted row nothing implements is the same "armed switch
    // over nothing" the POST refuses. Turning OFF is always allowed — an
    // unimplemented row that is somehow on must still be stoppable.
    if (on && row.kind === 'hosted' && !isHostedTag(row.tag)) {
      skipped.push({
        tag: row.tag,
        reason: 'no hosted implementation is registered for this tag — nothing would run',
      })
      continue
    }
    // The SAME write path as the per-row PATCH, version pin included. A
    // second, looser writer for the bulk case is how the two would drift
    // and how a bulk-on would eventually skip a guard the single toggle has.
    // Written as a branch rather than a computed key so the patch is typed
    // as the partial it is: `{ [mode]: on }` widens to an index signature
    // and would let a typo'd mode through as a field nothing reads.
    const updated = await service.patchStrategy(
      row.tag,
      { modes: mode === 'live' ? { live: { enabled: on } } : { paper: { enabled: on } } },
      row.updatedAt,
    )
    if (updated === 'conflict') {
      skipped.push({
        tag: row.tag,
        reason: 'changed by someone else while this ran — reload and retry',
      })
      continue
    }
    if (updated === null) {
      // Deleted between the listing and the write.
      skipped.push({ tag: row.tag, reason: 'no longer registered' })
      continue
    }
    changed.push(row.tag)
    if (!on) {
      const openPositions = runtimeByKey.get(runtimeKey(row.tag, mode))?.openPositions ?? 0
      if (openPositions > 0) stranded.push({ tag: row.tag, openPositions })
    }
  }

  log(on ? 'BULK strategy switch ON' : 'bulk strategy switch OFF', {
    mode,
    changed: changed.length,
    unchanged: unchanged.length,
    skipped: skipped.length,
    stranded: stranded.length,
  })
  // The tags CHANGED, by name, not a count — this is the one action that can
  // arm or stop fifteen strategies at once, and "12 changed" cannot answer
  // "was mine one of them?". `redactDetail` bounds the list if it is long.
  await auditLog(deps).record({
    principal: ctx.principal,
    source: '/v1/desk/strategies/bulk',
    action: on ? 'BULK-SWITCHED strategies ON' : 'bulk-switched strategies OFF',
    mode,
    detail: {
      changed,
      unchanged: unchanged.length,
      skipped: skipped.length,
      stranded: stranded.map((s) => s.tag),
    },
  })
  send(200, {
    mode,
    on,
    changed,
    unchanged,
    skipped,
    /**
     * Switched off while still holding something. Reported rather than
     * acted on — see the header. The warning is spelled out here rather
     * than left to the UI so the asymmetry cannot be lost in a redesign.
     */
    strandedPositions: stranded,
    warning:
      stranded.length === 0
        ? null
        : `${stranded.length} strategy(ies) were switched off while still holding a ` +
          `position. Switching off blocks their EXITS too, so nothing will close them — ` +
          `use close-all (which runs as you, not as the strategy) on each.`,
  })
  return true
}

/** PATCH /v1/desk/strategies/:tag — the per-row switches. */
async function handleStrategyPatch(
  deps: DeskDeps,
  ctx: RouteCtx,
  tag: string,
): Promise<boolean> {
  const { send, log } = ctx
  const { service, gate } = deps
  const parsed = validateStrategyPatch(await ctx.readJson())
  if (!parsed.ok) {
    send(400, { error: parsed.error })
    return true
  }
  /**
   * Contract §1 / addendum §3: turning `modes.live` ON is the
   * password-gated action. Turning `modes.paper` on is not — it cannot
   * move money.
   *
   * The decision is made against `current`, and the write below pins
   * `current.updatedAt` so the two cannot disagree. WITHOUT THAT PIN the
   * gate was outright bypassable under the old `enabled` + `mode` pair:
   * two concurrent patches, `{enabled:true}` and `{mode:'live'}`, each
   * read the same paper-and-disabled row, each individually looked
   * harmless and skipped the password — and they COMBINED into a live
   * strategy nobody was ever asked to confirm, which a machine token
   * could do unaided. `modes` removes that particular split, because the
   * live permission is now ONE field that one write either sets or does
   * not. The pin stays anyway: it is what makes the row the operator saw
   * the row that gets written, and the bulk switch above rides the same
   * path.
   *
   * The condition is on the PATCH, not on the resulting row: a patch that
   * does not mention `modes.live` cannot turn it on, and one that asserts
   * `modes.live: true` is asking for live trading whether or not the row
   * already had it. Editing `liveLots` on an already-live row is not a
   * re-arming and does not re-prompt.
   */
  const current = await deps.store.loadStrategy(tag)
  if (current === null) {
    send(404, { error: `no strategy registered as '${tag}'` })
    return true
  }
  /**
   * A patch may only flip a switch on a mode the row has been ADDED to.
   *
   * `applyStrategyPatch` ignores the rest, so this is the only place that
   * can tell the operator their toggle went nowhere — and silently
   * returning 200 on a switch that did not move is the worst possible
   * answer to "did my change land?". It is also a gate: if a toggle could
   * create membership, "add to live" would be reachable without the add
   * form's catalogue check.
   */
  for (const mode of ['paper', 'live'] as const) {
    if (parsed.value.modes?.[mode] === undefined) continue
    if (isAdded(current.modes, mode)) continue
    send(400, {
      error:
        `'${tag}' is not added to ${mode}, so there is no switch to flip — ` +
        `POST /v1/desk/strategies { tag, kind, mode: '${mode}' } adds it first`,
    })
    return true
  }
  const armingLive = parsed.value.modes?.live?.enabled === true
  /**
   * EDITING THE DAY GUARD'S LINES ON A LIVE ROW COSTS THE PASSWORD TOO.
   *
   * Widening a stop-loss — or clearing it — on a strategy that is trading real
   * money is not an edit to a setting, it is the removal of the control that
   * stops it. It is reachable in one click from the same table as the live
   * switch, and of the two, this is the one that leaves no badge behind. The
   * condition is the ROW's current state rather than the patch's, because there
   * is no such thing as "arming limits" to gate on: the danger is that live is
   * already on.
   *
   * A paper-only row is not gated. Nothing there can move money, and a password
   * in front of an edit that cannot is how an operator learns to type it
   * without reading the dialog.
   */
  const editingLiveLimits = parsed.value.dailyLimits !== undefined && isOn(current.modes, 'live')

  /**
   * Hosted strategies were BLOCKED from live here. The block is lifted.
   *
   * The 2026-07-27 audit found three defects, each established by driving
   * the real strategy classes rather than reading them, and each enough to
   * lose money quietly. All three are now fixed and mutation-tested:
   *
   *  - Every square-off path placed NOTHING while the portal reported
   *    `squared-off` — no class overrode `onDayEnd`. All four now do, and
   *    the runner re-reads its ledger after the exit and reports `failed`
   *    rather than `squared-off` when anything is still open.
   *  - A mid-session restart abandoned the position and could open a
   *    second one — no class overrode `onRecover` or persisted state. All
   *    four now persist session state and rebuild from it.
   *  - A disabled hosted tag's position was unreachable by `close-all`,
   *    which reads `desk-books`, a collection `/submit` never writes.
   *    `close-all` now accepts a `tag` and reconstructs from fills.
   *
   * WHAT STILL GUARDS LIVE, and it is deliberately more than one thing:
   * `modes.live` must be on (enforced on the order path too, not just in
   * the portal), the operator must re-enter their password below, and the
   * tag must be named in `DESK_LIVE_TAGS` — an environment change, so
   * turning a strategy live is a deployment act and not only a click.
   *
   * NONE OF THIS HAS TRADED LIVE YET. Paper first is a judgement for the
   * operator, not something this endpoint should pretend to enforce — and
   * it is now expressible without taking the paper run down, which is the
   * point of the per-mode switch.
   */
  if (armingLive || editingLiveLimits) {
    const raw = bodyObject(await ctx.readJson())
    const denied = await gate.reauth(ctx.principal, raw['password'])
    if (denied !== null) {
      send(403, { error: denied, reauthRequired: true })
      return true
    }
  }
  const updated = await service.patchStrategy(tag, parsed.value, current.updatedAt)
  if (updated === 'conflict') {
    // 409 rather than a silent retry: the row the operator was looking at
    // is not the row that exists now, and re-applying blind is how the two
    // halves of a split live-enable would recombine.
    send(409, {
      error: `'${tag}' was changed by someone else while you were editing it — reload and try again`,
    })
    return true
  }
  if (updated === null) {
    // 404, never an implicit create: a typo in the URL would otherwise make
    // a phantom row nothing runs, while the real strategy stays untouched.
    send(404, { error: `no strategy registered as '${tag}'` })
    return true
  }
  // Logged with BOTH switches, not with "on"/"off": the whole point of
  // the change is that a row can be on for one rail and off for the
  // other, and a single word cannot say which one just moved.
  log(
    isOn(updated.modes, 'live') ? 'strategy switch changed — LIVE IS ON' : 'strategy switch changed',
    {
      tag: updated.tag,
      paper: isAdded(updated.modes, 'paper') ? isOn(updated.modes, 'paper') : 'not added',
      live: isAdded(updated.modes, 'live') ? isOn(updated.modes, 'live') : 'not added',
      liveLots: updated.liveLots,
      reason: updated.disabledReason,
      // Named on every switch change, not only on the edits that set them: a
      // rail armed with a ₹3,000 stop and one with none are different things to
      // have turned on, and the log line is where that is reconstructed later.
      dailyLimits: updated.dailyLimits ?? null,
    },
  )
  /**
   * BOTH SIDES, because this handler already holds them.
   *
   * `current` was read to make the re-auth decision and pinned into the write,
   * so the row before and the row after are both in hand — and for the two
   * fields that matter (is live armed, and what stops it) a before/after pair
   * is the whole record. Arming live and widening a stop-loss are the two acts
   * here that cost the password; they are also the two that a week later
   * nobody can reconstruct from a switch's current position alone.
   */
  await auditLog(deps).record({
    principal: ctx.principal,
    source: '/v1/desk/strategies/:tag',
    action: armingLive ? 'ARMED a strategy for LIVE' : 'changed a strategy',
    tag: updated.tag,
    detail: {
      before: {
        paper: isOn(current.modes, 'paper'),
        live: isOn(current.modes, 'live'),
        liveLots: current.liveLots,
        dailyLimits: current.dailyLimits ?? null,
      },
      after: {
        paper: isOn(updated.modes, 'paper'),
        live: isOn(updated.modes, 'live'),
        liveLots: updated.liveLots,
        dailyLimits: updated.dailyLimits ?? null,
      },
    },
  })
  send(200, updated)
  return true
}

/**
 * WHAT THE BROKER HOLDS — its own order book and positions, not ours.
 *
 * Served from the snapshot the ORDER-GATEWAY writes, because the gateway
 * owns the XTS session; desk-api opening a second one would share the same
 * token document and the two could invalidate each other's session
 * mid-order. See `order-gateway/src/broker-snapshot.ts`.
 *
 * `asOf` and `stale` are part of the answer, not decoration. A broker view
 * silently frozen at 14:00 is worse than no broker view at all, because it
 * reads as confirmation.
 *
 * An ABSENT snapshot is a 200 with `available: false`, not a 404: the
 * normal reason is that the gateway is in simulate mode and has no broker
 * to report, which is a state to display rather than an error.
 */
async function handleBrokerSnapshot(deps: ApiDeps, ctx: RouteCtx): Promise<boolean> {
  const { send } = ctx
  const doc = (await deps.db
    .collection('desk-broker-snapshot')
    .findOne({ _id: 'xts' })) as Record<string, unknown> | null
  if (doc === null) {
    send(200, {
      available: false,
      reason:
        'no broker snapshot — this desk\'s gateway publishes none (simulate or delta)',
    })
    return true
  }
  const asOf = Number(doc['asOf'] ?? 0)
  send(200, {
    available: true,
    asOf,
    ageMs: deps.now() - asOf,
    stale: deps.now() - asOf > BROKER_SNAPSHOT_STALE_MS,
    ok: doc['ok'] === true,
    error: String(doc['error'] ?? ''),
    orders: doc['orders'] ?? [],
    positions: doc['positions'] ?? [],
    // What actually EXECUTED, as distinct from what was ordered.
    trades: doc['trades'] ?? [],
    // Only present when a list came back empty. Says whether the broker
    // answered with a real empty list or with something unreadable — the
    // two are the same empty array otherwise.
    ...(doc['emptyDiagnostic'] === undefined
      ? {}
      : { emptyDiagnostic: doc['emptyDiagnostic'] }),
    /**
     * WHY it failed and WHETHER THE MARKET WAS OPEN when it did — the
     * gateway's own stamps, forwarded verbatim.
     *
     * An expired token at 03:00 on a Sunday and an expired token at 11:00
     * on a Tuesday are otherwise the same document, and only the second one
     * means live orders are failing right now. FORWARDED ONLY WHEN PRESENT:
     * a gateway that has not been redeployed writes neither, and inventing
     * a class for an unclassified failure would let the page quieten a red
     * state on the strength of a value nobody measured.
     */
    ...(doc['errorClass'] === undefined ? {} : { errorClass: doc['errorClass'] }),
    ...(doc['sessionOpenAtSnapshot'] === undefined
      ? {}
      : { sessionOpenAtSnapshot: doc['sessionOpenAtSnapshot'] }),
  })
  return true
}

/**
 * MARGIN UTILISATION, AT THE ACCOUNT — never per book.
 *
 * NOTHING ON THIS DESK ATTRIBUTES MARGIN TO A BOOK, and this endpoint does not
 * invent an attribution. SPAN + exposure is computed by the exchange over the
 * WHOLE account and is not additive across books: two books that hedge each
 * other consume less together than either alone, so a per-book split would be a
 * number no broker statement agrees with. The dashboard therefore labels this
 * "(account)" and the caller must keep that word.
 *
 * SERVED FROM THE GATEWAY'S SNAPSHOT, for the same reason `/v1/desk/broker` is:
 * the gateway owns the XTS session, and desk-api opening a second one would
 * share the single `desk-broker-session` token document — either process
 * re-logging in could invalidate the other's token mid-order. So this reads
 * whatever funds the gateway has published and says so plainly when there are
 * none. It never calls a broker itself.
 *
 * `available: false` IS A 200. "The gateway publishes no funds" is a state to
 * render — and, today, the normal one — not a failed request.
 */
async function handleBrokerFunds(deps: ApiDeps, ctx: RouteCtx): Promise<boolean> {
  const { send } = ctx
  const doc = (await deps.db
    .collection('desk-broker-snapshot')
    .findOne({ _id: 'xts' })) as Record<string, unknown> | null
  if (doc === null) {
    send(200, {
      available: false,
      reason:
        'no broker snapshot — this desk\'s gateway publishes none (simulate or delta)',
    })
    return true
  }
  const asOf = Number(doc['asOf'] ?? 0)
  const age = { asOf, ageMs: deps.now() - asOf, stale: deps.now() - asOf > BROKER_SNAPSHOT_STALE_MS }
  /**
   * `funds` OR `balance`, whichever the gateway wrote. Two names because the
   * gateway is a separate deploy: pinning one would make this endpoint depend on
   * a rename landing in both repos in the same minute.
   */
  const funds = doc['funds'] ?? doc['balance'] ?? null
  if (funds === null || typeof funds !== 'object') {
    /**
     * The gateway now says WHY it published none (`fundsDiagnostic`) — the
     * broker's own error or the reply's shape. An older gateway wrote neither
     * field, which is the "does not read the balance yet" case.
     */
    const diagnostic = typeof doc['fundsDiagnostic'] === 'string' ? doc['fundsDiagnostic'] : ''
    send(200, {
      available: false,
      ...age,
      reason: diagnostic !== ''
        ? `the broker published no funds: ${diagnostic}`
        : 'the broker snapshot carries no funds — the gateway does not read the ' +
          "broker's balance yet, so no margin figure exists to show",
    })
    return true
  }
  const utilised = findNumber(funds, /margin.?utili[sz]ed|utili[sz]ed.?margin/i)
  const availableMargin = findNumber(funds, /net.?margin.?available|margin.?available|cash.?available/i)
  /**
   * A RATIO ONLY WHEN BOTH HALVES ARE KNOWN AND THE DENOMINATOR IS REAL.
   * Utilised alone is not a utilisation, and `used / 0` is not 100% — it is an
   * account with no limit published, which must read as unknown.
   */
  const total = utilised === null || availableMargin === null ? null : utilised + availableMargin
  send(200, {
    available: true,
    ...age,
    ok: doc['ok'] === true,
    utilised,
    availableMargin,
    utilisation: total === null || total <= 0 ? null : utilised === null ? null : utilised / total,
    // Verbatim, like the order and position rows next door: whatever keys the
    // broker sent are what an operator needs when the two numbers above are null.
    funds,
  })
  return true
}

/**
 * PER-BOOK margin — what THIS book would cost to hold, standalone.
 *
 * The companion to `handleBrokerFunds` and the answer to the question that one
 * cannot answer. `marginUtilized` is an ACCOUNT figure: with a DLF and a TCS
 * book open it read 9.6L, against DLF's own basket margin of 4.4L, on the tile
 * an operator sizes the next trade from. This endpoint serves the per-book
 * number instead, priced by Zerodha's own basket-margin endpoint with hedge
 * benefit applied — the same computation behind the Kite margin calculator.
 *
 * SERVED FROM MONGO, NEVER FROM A BROKER. desk-marketdata owns the Kite session
 * and publishes; this only reads. Identical to the funds endpoint above and for
 * the same reason: two processes logging into one Kite account invalidate each
 * other's token, which is the 2026-08-04 feed outage.
 *
 * PER-BOOK FIGURES DO NOT SUM TO THE ACCOUNT TOTAL, and nothing here pretends
 * otherwise. SPAN scans the whole portfolio at once, so two books that hedge
 * each other consume less together than the sum of their standalone figures.
 * This is a standalone reference cost, not a share of the account.
 */
async function handleBookMargin(deps: ApiDeps, ctx: RouteCtx): Promise<boolean> {
  const { send, url } = ctx
  const tag = url.searchParams.get('tag') ?? ''
  if (tag === '') {
    send(400, { error: 'tag is required' })
    return true
  }
  const doc = (await deps.db
    .collection(COLLECTIONS.bookMargin)
    .findOne({ _id: tag })) as Record<string, unknown> | null
  if (doc === null) {
    send(200, {
      available: false,
      reason:
        'no margin figure for this book yet — desk-marketdata prices each book ' +
        'on the SPAN schedule and on any leg change, so a book opened moments ' +
        'ago has not been priced',
    })
    return true
  }
  const asOf = Number(doc['asOf'] ?? 0)
  /**
   * `asOf === 0` means every attempt so far has failed — the row exists only to
   * carry the diagnostic. That is NOT a figure to render as zero margin.
   */
  if (asOf === 0) {
    send(200, {
      available: false,
      reason:
        typeof doc['diagnostic'] === 'string' && doc['diagnostic'] !== ''
          ? `this book has never priced successfully: ${String(doc['diagnostic'])}`
          : 'this book has never priced successfully',
    })
    return true
  }
  const ageMs = deps.now() - asOf
  const span = Number(doc['span'] ?? 0)
  const exposure = Number(doc['exposure'] ?? 0)
  /**
   * PREMIUM PAID IS PART OF THE REQUIREMENT. Zerodha's calculator excludes it
   * from "Total margin" and reports it separately, but the XTS account blocks
   * it: `MarginUsed` reconciled to `span + exposure + premiumPaid` exactly.
   * A book's cost is what the broker takes, not what a calculator itemises.
   *
   * The arithmetic lives in `book-margin.ts` because the payoff cockpit's
   * machine card divides the SAME figure by the book's `margin_cap` — two
   * copies of it would put two "margin used" numbers on one screen.
   */
  const cal = await brokerCalibration(deps)
  const figures = brokerFigures(doc, cal)
  send(200, {
    available: true,
    asOf,
    ageMs,
    stale: ageMs > BOOK_MARGIN_STALE_MS,
    /**
     * THE HEADLINE FIGURE — what this book costs at the broker actually
     * holding it. Uncalibrated it is still the right shape (span + exposure +
     * premium paid), just at Zerodha's rates; `calibrated` says which.
     */
    brokerTotal: figures.brokerTotal,
    brokerSpan: figures.brokerSpan,
    brokerExposure: figures.brokerExposure,
    calibrated: cal !== null,
    ...(cal === null ? {} : { spanRatio: cal.spanRatio, exposureRatio: cal.exposureRatio }),
    premiumPaid: figures.premiumPaid,
    // `ok:false` with a real `asOf` is the DEGRADED case, not an error: the
    // figures below are the last good ones and the age says how old. The tile
    // renders them with their age rather than blanking.
    ok: doc['ok'] === true,
    source: doc['source'] ?? 'kite',
    // Zerodha's own figures, kept so the tile can show the derivation.
    span,
    exposure,
    premium: Number(doc['premium'] ?? 0),
    total: Number(doc['total'] ?? 0),
    legs: Array.isArray(doc['legs']) ? doc['legs'] : [],
    diagnostic: typeof doc['diagnostic'] === 'string' ? doc['diagnostic'] : '',
  })
  return true
}

/**
 * A request body as a property bag, whatever actually arrived.
 *
 * `server.ts:readBody` substitutes `{}` only for an EMPTY body; every other
 * valid JSON document comes through as itself, so a literal `null` reaches a
 * handler and the first `body['field']` read throws a TypeError that the
 * dispatcher can only turn into a 500. A malformed body is a client error and
 * has to read as one — 400 with the field that is missing — on these endpoints
 * above all, since they are the kill switch and close-all.
 */
function bodyObject(raw: unknown): Record<string, unknown> {
  return isObject(raw) ? raw : {}
}
