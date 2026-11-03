/**
 * The hosted runner's own position ledgers, over the bridge (audit F-6d).
 *
 * WHAT THIS RETIRES: "stop desk-runner -> edit Mongo -> start", in that order.
 * Until now that was the ONLY way to clear a stuck leg from a hosted strategy
 * or a signal mirror, and every part of it was bad. It cost a full restart of
 * every hosted strategy to fix one dead contract; it had to be done after 15:30
 * because the restart is not free; it left no record of who removed what; and
 * getting the order wrong silently did nothing, because `main.ts` caches one
 * `PositionLedger` per `tag:mode` at boot and the next `#save()` rewrites the
 * whole document — so an edit made while the runner is up is undone by the next
 * booked order.
 *
 * The incident behind it (2026-08-10): `MIRROR_A006` was found holding four
 * legs, three of them SENSEX contracts from the 6 Aug expiry — gone from the
 * instrument master, unroutable, and structurally invisible to `flattenTag`,
 * which rebuilds positions from `desk-fills` and has zero mirror rows in it.
 * `MirrorHost` squares nothing off by design and `main.ts` withholds the MIRROR
 * tags from `Runner`, so no backstop covered them either.
 *
 * THE RULE THIS FILE IS BUILT AROUND: **THE API NEVER WRITES THE LEDGER.**
 * A clear writes a REQUEST document under the same `TAG:mode` scope; the runner
 * reads it on its own sync cadence, applies it through the `PositionLedger` it
 * owns, journals exactly which legs it dropped and deletes the request. The
 * single-writer discipline that made the old runbook necessary is preserved
 * rather than suspended for the duration of an admin action — which also means
 * the runner does not have to be stopped, and the clear cannot be lost to a
 * later save.
 *
 * AND IT PLACES NO ORDERS. Clearing is BOOKKEEPING: it says "this leg is not
 * real", which is true for an expired contract and a judgement call for
 * anything else. Dropping a leg the upstream account still holds means its
 * eventual mirrored exit books against an empty ledger and opens a phantom
 * position the other way — so the request carries the operator's name, the
 * runner names every leg it dropped in the log, and `/v1/desk/flatten` remains
 * the control for closing something that is actually open.
 */

import type { ApiDeps, Route, RouteCtx } from './kit.ts'
import { isObject } from './kit.ts'
import type { AuthGate } from '../authgate.ts'
import { auditLog } from '../audit.ts'
import { CLEAR_REQUEST_KEY, POSITIONS_KEY } from '../../../runner/src/order-gateway.ts'
import { STATE_COLLECTION } from '../../../runner/src/state-store.ts'

/** The password gate, for the same reason every other irreversible route takes one. */
type RunnerDeps = ApiDeps & { readonly gate: AuthGate }

/**
 * The runner's state collection and the key its ledgers live under are IMPORTED
 * FROM THE RUNNER, not restated here (audit F-53).
 *
 * Not through `store.ts`: `DeskStore` is the desk's book, and this collection
 * belongs to another process entirely — a narrow read of two well-known keys is
 * the whole dependency. But the keys are the runner's to name. Typed out again,
 * they agreed with the writer only by coincidence: renaming either one at the
 * source would leave this endpoint reading a key nothing writes, which does not
 * fail — it reports a desk with no ledgers at all, on the page an operator
 * opens precisely to find a stuck leg.
 */

/** How many symbols one clear may name. A list is an operator's list, not a script's. */
const MAX_SYMBOLS = 100

/** One instance's ledger, as the operator sees it. */
interface LedgerView {
  readonly tag: string
  readonly mode: 'paper' | 'live'
  readonly openCount: number
  readonly entries: readonly Record<string, unknown>[]
  readonly updatedAt: number | null
}

export function runnerRoutes(deps: RunnerDeps): Route {
  const { gate } = deps
  /** WHO CLEARED WHAT (roadmap 17). Fail-soft — see `audit.ts`. */
  const audit = auditLog(deps)

  return async (ctx: RouteCtx): Promise<boolean> => {
    const { path, method, send, log } = ctx

    if (path === '/v1/desk/runner/positions' && method === 'GET') {
      send(200, { positions: await listLedgers(deps) })
      return true
    }

    if (path === '/v1/desk/runner/positions/clear' && method === 'POST') {
      const raw = await ctx.readJson()
      const body = isObject(raw) ? raw : {}
      const parsed = validateClear(body)
      if (!parsed.ok) {
        send(400, { error: parsed.error })
        return true
      }
      const { tag, mode, symbols } = parsed.value
      const instance = `${tag}:${mode}`

      /**
       * RE-AUTH BEFORE ANYTHING IS WRITTEN, and before the existence check —
       * an unauthenticated caller must not be able to probe which tags have
       * ledgers. `authsvc.reauth` refuses a `machine` principal unconditionally,
       * so this is also what makes the endpoint operator-only: the runner's own
       * bearer token can read its ledgers back but can never empty one.
       */
      const denied = await gate.reauth(ctx.principal, body['password'])
      if (denied !== null) {
        send(403, { error: denied, reauthRequired: true })
        return true
      }

      const collection = deps.db.collection(STATE_COLLECTION)
      const ledger = await collection.findOne({ tag: instance, key: POSITIONS_KEY })
      if (ledger === null) {
        // 404 rather than an accepted no-op: a typo'd tag would otherwise leave
        // a request document nothing will ever consume, and the operator would
        // be told their clear was accepted.
        send(404, {
          error: `no runner ledger for ${instance} — check the tag and the mode against GET /v1/desk/runner/positions`,
        })
        return true
      }

      const requestedAt = deps.now()
      /**
       * UPSERT ON `(tag, key)`, which is the collection's unique index: a
       * second click REPLACES the pending request instead of stacking a
       * duplicate the runner would apply twice. `'all'` applied twice would
       * drop every leg opened between the two syncs.
       */
      await collection.updateOne(
        { tag: instance, key: CLEAR_REQUEST_KEY },
        {
          $set: {
            tag: instance,
            key: CLEAR_REQUEST_KEY,
            value: { symbols, requestedBy: ctx.principal.name, requestedAt },
            updatedAt: requestedAt,
          },
        },
        { upsert: true },
      )

      // Logged HERE as well as by the runner: these are two processes, and the
      // bridge's log is the one that records who asked.
      log('runner ledger clear requested', {
        tag,
        mode,
        symbols: Array.isArray(symbols) ? symbols.join(',') : symbols,
        requestedBy: ctx.principal.name,
      })
      /**
       * AND IN THE AUDIT LOG, which outlives both the log file and the request
       * document — the runner DELETES the request as it applies it, so without
       * this the only durable trace of a clear would be the runner's own log
       * line. `requested`, not `applied`: nothing has been cleared yet.
       */
      await audit.record({
        principal: ctx.principal,
        source: '/v1/desk/runner/positions/clear',
        action: 'requested a runner ledger clear',
        tag,
        mode,
        detail: { symbols, applied: false },
      })

      /**
       * 202, not 200. Nothing has been cleared yet — the runner applies it on
       * its next sync (15 seconds), and if the runner is down when the request
       * is raised it is applied at its next boot. Answering 200 would claim a
       * state change this process cannot observe.
       *
       * AND IT EXPIRES. The runner refuses a request older than
       * `DESK_CLEAR_REQUEST_TTL_MS` (an hour by default) and deletes it unapplied
       * — a clear is an operator's now-intention, not a standing order. This
       * route accepts a clear for any instance with a `runner:positions`
       * document, including a tag the runner no longer hosts, so without the
       * expiry a request could sit armed until the tag was re-added and then
       * fire against a book nobody was looking at. The note says so rather than
       * promising an application that may never come.
       */
      send(202, {
        accepted: true,
        tag,
        mode,
        symbols,
        requestedBy: ctx.principal.name,
        requestedAt,
        note:
          'the runner applies this on its next sync; nothing is cleared until it does, and the ' +
          'request expires unapplied if the runner has not consumed it within the hour',
      })
      return true
    }

    return false
  }
}

/**
 * Every `runner:positions` document, split back into its tag and its rail.
 *
 * The scope is `TAG:mode` — one string, because `MongoStateStore` namespaces by
 * whatever it is handed — so the split happens here. A document whose scope has
 * no recognisable mode is DROPPED rather than shown under a guessed rail: a
 * live position rendered as paper is exactly the reading that talks an operator
 * out of investigating it.
 */
async function listLedgers(deps: ApiDeps): Promise<readonly LedgerView[]> {
  const docs = await deps.db
    .collection(STATE_COLLECTION)
    .find({ key: POSITIONS_KEY })
    .toArray()

  const out: LedgerView[] = []
  for (const doc of docs) {
    const scope = doc['tag']
    if (typeof scope !== 'string') continue
    const at = scope.lastIndexOf(':')
    const tag = at <= 0 ? scope : scope.slice(0, at)
    const mode = at <= 0 ? '' : scope.slice(at + 1)
    if (mode !== 'paper' && mode !== 'live') continue
    const value = doc['value']
    const entries = Array.isArray(value) ? value.filter(isObject) : []
    const updatedAt = doc['updatedAt']
    out.push({
      tag,
      mode,
      openCount: entries.length,
      // Verbatim, including `lastPrice` and `expiry`: the operator deciding
      // whether a leg is real needs the contract's date, and this endpoint is
      // the only place it is visible.
      entries,
      updatedAt: typeof updatedAt === 'number' ? updatedAt : null,
    })
  }
  return out
}

type Validated =
  | { ok: true; value: { tag: string; mode: 'paper' | 'live'; symbols: readonly string[] | 'expired' | 'all' } }
  | { ok: false; error: string }

/**
 * The request body, refused rather than coerced.
 *
 * `tag` is checked for `.` and `$` because it goes into a Mongo filter, and for
 * a length because it becomes a document key. `symbols` accepts a list or one
 * of two selectors and nothing else — an unreadable selector must not degrade
 * into "everything".
 */
function validateClear(body: Record<string, unknown>): Validated {
  const tag = body['tag']
  if (typeof tag !== 'string' || tag.trim() === '' || tag.length > 64) {
    return { ok: false, error: 'tag is required and must be 1-64 characters' }
  }
  if (tag.includes('.') || tag.includes('$') || tag.includes(':')) {
    return { ok: false, error: "tag must not contain '.', '$' or ':'" }
  }
  const mode = body['mode']
  if (mode !== 'paper' && mode !== 'live') {
    return { ok: false, error: "mode must be 'paper' or 'live'" }
  }

  const symbols = body['symbols']
  if (symbols === 'expired' || symbols === 'all') {
    return { ok: true, value: { tag, mode, symbols } }
  }
  if (!Array.isArray(symbols) || symbols.length === 0 || symbols.length > MAX_SYMBOLS) {
    return {
      ok: false,
      error: `symbols must be 'expired', 'all', or a list of 1-${MAX_SYMBOLS} trading symbols`,
    }
  }
  const named: string[] = []
  for (const s of symbols) {
    if (typeof s !== 'string' || s.trim() === '' || s.length > 64) {
      return {
        ok: false,
        error: `every entry of symbols must be a trading symbol; 'expired' and 'all' are the only selectors`,
      }
    }
    named.push(s)
  }
  return { ok: true, value: { tag, mode, symbols: named } }
}
