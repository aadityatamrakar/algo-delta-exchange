/**
 * The book registry and the variant catalogue.
 *
 * See `books-registry.ts` for the row shape, the validation rules and the
 * reasoning; this file is the HTTP surface over it, in the prefix-dispatch
 * shape `routes/brokers.ts` uses.
 *
 * MODE IS ALWAYS STATED EXPLICITLY, never defaulted, on every write here — the
 * same discipline `validateStrategyCreate` and `validateSeedRequest` hold the
 * rest of the bridge to. A registry row is keyed by `{tag, mode}`, so guessing
 * the mode on a `/start` would risk arming the wrong rail.
 */

import type { DeskMode } from '../contract.ts'
import {
  DEFAULT_BOOK,
  bookIdentityConflict,
  engineSwitchChanges,
  validateActualReport,
  validateBookCreate,
  validateBookDialsPatch,
  validateDialsAgainstCatalogue,
  isPaperRail,
  type BookRow,
  type DialValue,
} from '../books-registry.ts'
import { isObject, istDate, modeOf, suffixOf, type ApiDeps, type Route, type RouteCtx } from './kit.ts'
import { heldFromFills, type HeldFromFills } from '../held-position.ts'
import { aggressionPctError } from '../validate.ts'
import type { AuthGate } from '../authgate.ts'
import { auditLog } from '../audit.ts'
import { notifySupervisor } from '../engine-notify.ts'
import { resolveDials } from '@algomaker/desk-engine'
import { isArmed } from '../day-guard.ts'
import { validateDailyLimits } from '../strategies.ts'
import { recordSeries } from '../book-series.ts'
import { handleSettleExpired } from '../settle-expired.ts'
import { SUPERVISOR_STATE_COLLECTION, stateKey } from '../../../supervisor/src/state-store.ts'
import type { Database } from '../store.ts'
import { liveBudgetRefusal } from '../bull-s-live.ts'

/**
 * The shared bag plus the password gate, exactly as `routes/desk.ts` takes it.
 *
 * The gate is here for ONE endpoint — the dials PATCH on a live book. Retuning
 * a running live book rewrites the risk parameters real orders are sized by,
 * which is the same class of act as arming a live strategy, and that has cost
 * the password since spec §5.
 */
type BooksDeps = ApiDeps & { readonly gate: AuthGate }

const REGISTRY_PREFIX = '/v1/desk/books/registry'
const VARIANTS_PATH = '/v1/desk/variants'

function bodyObject(raw: unknown): Record<string, unknown> {
  return isObject(raw) ? raw : {}
}

/**
 * `mode` read from the JSON body, required and never defaulted.
 *
 * Deliberately NOT `modeOf(url)` (`kit.ts`), which defaults to `'paper'` for
 * GET listings where guessing wrong only hides a row. Every write below moves
 * a specific `{tag, mode}` row, and a caller that forgot to state the mode
 * must be told rather than silently landed on paper.
 */
function requireMode(body: Record<string, unknown>): DeskMode | null {
  return body['mode'] === 'paper' || body['mode'] === 'live' ? body['mode'] : null
}

/**
 * The same rule as `requireMode`, read from the QUERY STRING, for a request
 * with no body to put it in.
 *
 * Deliberately not `kit.ts`'s `modeOf`, which answers 'paper' for anything
 * that is not exactly 'live'. That default is fine on a read and dangerous on
 * a DELETE: `?moed=live` would quietly erase the paper book instead.
 */
function requiredModeParam(url: URL): DeskMode | null {
  const raw = url.searchParams.get('mode')
  return raw === 'paper' || raw === 'live' ? raw : null
}

const MODE_REQUIRED = { error: "mode must be stated explicitly as 'paper' or 'live' in the request body" }
const MODE_PARAM_REQUIRED = { error: "mode must be stated explicitly as '?mode=paper' or '?mode=live'" }

// ------------------------------------------------------ the day guard (T12)

/**
 * A BOOK GETS THE DESK'S DAY GUARD TOO — the second stop, behind the engine's.
 *
 * `day-guard.ts` never imports this registry. It iterates `listStrategies()`
 * and filters on `isArmed`, and only a `StrategyRow` carries `dailyLimits`, so
 * the companion row a registration creates was armed on nothing and `runGuards`
 * skipped every book in SILENCE. A delta-lean book therefore had exactly one
 * stop: the engine's own `dl_day_max_loss` check. This gives it a second, for
 * the case where the engine is the thing that is wrong — a stuck mark, a decide
 * path that never reaches its own stop, a supervisor that is not running the
 * book it thinks it is.
 *
 * DEFENCE IN DEPTH, NOT A REPLACEMENT. Nothing here changes how an
 * already-armed strategy is judged: it only decides what `dailyLimits` a book's
 * companion row starts life with, through the same `patchStrategy` the
 * operator's own edit takes.
 *
 * THE NUMBER IS RESOLVED, NEVER READ RAW. A book's stored `dials` is an
 * OVERRIDE document — `{ delta_lean_enabled: true }` is a complete and normal
 * one — so `dials['dl_day_max_loss']` is very often absent, and a guard armed at
 * `undefined` is an unarmed guard that looks armed. `resolveDials` folds the
 * document onto `DEFAULT_DIALS` exactly as the supervisor's own poll does
 * (`apps/supervisor/src/registry-poll.ts`), so the desk derives its stop from the
 * same number the engine is running on (at 1.5 x — see `guardStopFor`).
 *
 * ONLY ON THE DELTA-LEAN PATH. A recenter book is registered exactly as it
 * always was, with no limits: those books have run unguarded here since day one
 * and arming them silently would be a behaviour change nobody asked for, on a
 * stop value (`dl_day_max_loss`) their playbook does not read.
 *
 * Returns null when this book is not delta-lean, or when its day budget is not
 * something `PATCH /v1/desk/strategies/:tag` would have accepted — a zero, a
 * negative, or a number past `DAILY_LIMIT_MAX`. `validateDailyLimits` is asked
 * rather than reimplemented, because this path writes through the store instead
 * of over the wire and must not be able to produce a row the wire could not.
 */
function bookGuardStop(dials: Readonly<Record<string, DialValue>>): number | null {
  const { dials: resolved } = resolveDials(dials)
  if (!resolved.delta_lean_enabled) return null
  const limits = validateDailyLimits({ stop: guardStopFor(resolved.dl_day_max_loss) })
  return limits.ok && limits.value !== null ? (limits.value.stop ?? null) : null
}

/**
 * THE DESK'S STOP SITS BEHIND THE ENGINE'S, NOT ON IT: 1.5 x `dl_day_max_loss`,
 * rounded UP to the next ₹1,000.
 *
 * The two stops act differently, and firing them on the same line is the
 * hazard. The engine's `dl-stop` flattens through its own working package (1 s
 * cadence). The day guard's exit for a delta-lean tag — which has no runtime
 * row — is `flattenTag` (`day-guard.ts`, the "host unknown" branch), which does
 * not check for orders already out and rebuilds the book from `desk-decisions`
 * fills that lag the paper fold. Both firing at once can close the same leg
 * twice and flip the book. With the guard half again further out, the engine
 * exits first and the guard is left for the case it exists for: an engine that
 * is not exiting at all. At the aggressive ₹30,000 (R1, 2026-10-05) that is
 * ₹45,000; at the conservative ₹15,000, ₹23,000.
 */
export function guardStopFor(dlDayMaxLoss: number): number {
  return Math.ceil((dlDayMaxLoss * 1.5) / 1_000) * 1_000
}

/**
 * Put that stop on the tag's companion strategy row.
 *
 * `replace` is the whole difference between the two callers:
 *
 *   REGISTRATION passes false. A row that already carries limits is left alone,
 *   the same discipline `addStrategyMode` holds for the label, the kind and the
 *   live lots — and for the same reason. A re-register does not apply the
 *   incoming dials to the book either (`bookIdentityConflict` excludes them and
 *   the existing row keeps its own), so moving the limit DERIVED from them would
 *   be the one write on that path that was not a no-op. It would also loosen a
 *   stop an operator had tightened by hand, which is the direction that costs
 *   money. Registering the same tag on the OTHER rail lands here too: one row,
 *   one `dailyLimits`, and the first book's stop stands.
 *
 *   THE DIALS PATCH passes true, but only when the patch actually restated the
 *   day budget or the delta-lean switch. That patch IS the operator changing
 *   this number, so a guard left holding the registration's value would be a
 *   second stop that silently disagrees with the one on the screen. A patch
 *   that touches neither key must not rewrite the limit at all, or every
 *   unrelated dial save would clobber a hand-set stop.
 *
 * An existing `target` is carried through: this arms the LOSS line and has no
 * business deleting a profit line an operator set.
 */
async function armBookDayGuard(input: {
  readonly store: ApiDeps['store']
  readonly log: ApiDeps['log']
  readonly tag: string
  readonly dials: Readonly<Record<string, DialValue>>
  readonly nowMs: number
  readonly replace: boolean
}): Promise<void> {
  const stop = bookGuardStop(input.dials)
  if (stop === null) return
  const row = await input.store.loadStrategy(input.tag)
  // No row means the add above did not land, and conjuring one HERE would
  // create a trading identity out of a risk control. The next registration
  // converges it.
  if (row === null) return
  if (!input.replace && isArmed(row)) return
  if (row.dailyLimits?.stop === stop) return
  await input.store.patchStrategy(
    input.tag,
    { dailyLimits: { ...row.dailyLimits, stop } },
    input.nowMs,
  )
  input.log('book day guard armed', { tag: input.tag, stop })
}

/**
 * The legs a `desk-books` document lists with a nonzero qty, by
 * tradingsymbol — or null when the document cannot answer: no leg array, or
 * a leg whose qty is not a finite number. No document at all is a book that
 * has never traded, which holds nothing.
 *
 * Null is never read as flat. F9 refuses an engine switch on it exactly as
 * on a held leg: "cannot tell" is the case in which handing a position to a
 * different engine would be found out last.
 */
function heldOnFile(doc: { readonly legs?: unknown } | null): string[] | null {
  if (doc === null) return []
  if (!Array.isArray(doc.legs)) return null
  const held: string[] = []
  for (const leg of doc.legs as readonly unknown[]) {
    const l = (isObject(leg) ? leg : {}) as {
      readonly qty?: unknown
      readonly deskTag?: unknown
      readonly instrument?: { readonly tradingsymbol?: unknown }
    }
    if (typeof l.qty !== 'number' || !Number.isFinite(l.qty)) return null
    if (l.qty === 0) continue
    const symbol = isObject(l.instrument) ? l.instrument.tradingsymbol : undefined
    held.push(typeof symbol === 'string' ? symbol : typeof l.deskTag === 'string' ? l.deskTag : 'an unnamed leg')
  }
  return held
}

/**
 * The decision the supervisor still has WORKING on this book, or null — the
 * other half of "holds legs" for F9 (integration review finding 7).
 *
 * Read raw from the supervisor's own collection, one document per
 * `${tag}:${mode}`: `inFlight` is a decision posted whose outcome it has not
 * yet seen, `workingPackage` one it is still executing. No document is
 * nothing working (a book no supervisor has steered).
 */
async function workingOnFile(db: Database, tag: string, mode: DeskMode): Promise<string | null> {
  const doc = await db.collection(SUPERVISOR_STATE_COLLECTION).findOne({ key: stateKey(tag, mode) })
  if (doc === null) return null
  const inFlight = doc['inFlight']
  if (typeof inFlight === 'string' && inFlight !== '') return inFlight
  const wp = doc['workingPackage']
  if (isObject(wp)) return typeof wp['decisionId'] === 'string' ? wp['decisionId'] : 'an unnamed package'
  return null
}

/**
 * How many delete-with-flatten attempts one tag gets in one IST day.
 *
 * A bound, not a budget. Each one places a full set of exit orders, so a control
 * that re-mints forever would turn a stuck book into a loop of real orders on a
 * rail that keeps refusing them. Five is generous for the case this exists for
 * (switch the live rail on, click again) and small enough that the sixth click
 * is a signal to go and look.
 */
const MAX_DELETE_FLATTEN_ATTEMPTS = 5

/**
 * The decisionId for `DELETE ?flatten=1` — reused after a success, re-minted
 * after a failure.
 *
 * F-33 made this id DETERMINISTIC PER DAY: it used to be
 * `delete-flatten-${tag}-${now()}`, a fresh id per click, so a proxy timeout
 * plus a second click routed a SECOND full exit set against a book the first
 * click may already have closed. That fix was right and is kept.
 *
 * WHAT IT MISSED. `flattenTag` claims the id BEFORE it routes and replays it
 * forever after, so an attempt that FAILED — the live switch off, the allowlist
 * refusing the tag, the rail down — spends the id having routed nothing. Every
 * retry then replays the FAILED record, routes nothing, the re-read still finds
 * the position, and the control 409s for the rest of the IST day. The one button
 * an operator reaches for after a failed flatten was the one button that could
 * not work after a failed flatten.
 *
 * So the id is chosen on the OUTCOME of the attempts already made today:
 *
 *  - NEVER USED — take it. The ordinary first click.
 *  - `ROUTING` — take it anyway. The claim is written before the orders go out,
 *    so this is either an attempt still in flight (a proxy timeout is exactly
 *    how you get here) or one that died mid-route. Minting a new id would route
 *    a second set of exits on top of orders that may already be live, which is
 *    precisely F-33. A replay routes nothing and the caller gets the ordinary
 *    "still holds N positions" refusal, which for a crashed route is the honest
 *    answer: go and look.
 *  - `DONE` AND FLAT — take it. It worked; the replay is a safe no-op and this
 *    is F-33's retry protection doing its job.
 *  - ANYTHING ELSE — failed, or ran and closed nothing (a `DONE` run over an
 *    empty window), or the id was consumed by another caller entirely. The id
 *    is spent and re-using it can only replay a non-result, so move to the next
 *    `-rN` suffix, which is a NEW id the rail has never seen.
 *
 * Past the bound it refuses rather than minting a sixth: five failed exit
 * attempts in a day is a broken rail or a book that needs eyes, not another
 * click.
 */
async function deleteFlattenId(
  store: { flattenOutcome(id: string): Promise<{ status: string; flat: boolean } | null> },
  tag: string,
  mode: DeskMode,
  istDay: string,
): Promise<{ id: string; error?: undefined } | { id: null; error: string }> {
  const first = `delete-flatten-${tag}-${mode}-${istDay}`
  for (let attempt = 1; attempt <= MAX_DELETE_FLATTEN_ATTEMPTS; attempt++) {
    const id = attempt === 1 ? first : `${first}-r${attempt}`
    const outcome = await store.flattenOutcome(id)
    if (outcome === null) return { id }
    if (outcome.status === 'ROUTING') return { id }
    if (outcome.status === 'DONE' && outcome.flat) return { id }
  }
  return {
    id: null,
    error:
      `'${tag}' has already had ${MAX_DELETE_FLATTEN_ATTEMPTS} delete-with-flatten attempts today in ` +
      `${mode} and none of them closed the book. Nothing further was routed. Flatten it with ` +
      `POST /v1/desk/close-all { tag, mode, style, decisionId } and inspect why the exits are not ` +
      `going through before deleting.`,
  }
}

export function booksRoutes(deps: BooksDeps): Route {
  const { store, log, now, gate } = deps
  /**
   * WHO DID WHAT (roadmap 17). Every write below records one line; none of them
   * can fail on it — see `audit.ts`. The catalogue POST and the supervisor's
   * `/actual` report are deliberately NOT audited: they are machine sync, they
   * arrive every few seconds, and an audit log full of them is one nobody reads.
   */
  const audit = auditLog(deps)

  return async (ctx: RouteCtx): Promise<boolean> => {
    const { path, method, url, send } = ctx

    /**
     * ------------------------------------------------------------ variants
     *
     * READ-ONLY AS OF THE D9 CUTOVER. `POST` was the Python supervisor's sync
     * point: it published its whole `list_variants()` output on every start,
     * wholesale. There is no Python supervisor, the engine ships its presets in
     * code (`@algomaker/desk-engine/presets`), and the Build screen reads those
     * rather than this catalogue.
     *
     * THE GET STAYS, AND SO DO THE STORED ROWS. `desk-variants` is what
     * `routes/payoff.ts` resolves a book's dial DEFAULTS against and what the
     * dials PATCH checks an unknown key against — for books registered under a
     * published variant, that is the only statement of what knobs they had.
     * Both readers already degrade correctly to "unpublished" for a variant the
     * catalogue does not carry (`validateDialsAgainstCatalogue` falls back to
     * the engine's own schema plus the row's current dials), so a catalogue
     * that stops growing costs nothing and dropping it would lose history.
     */
    if (path === VARIANTS_PATH && method === 'GET') {
      send(200, { variants: await store.listVariants() })
      return true
    }

    // ------------------------------------------------------------ registry

    if (path === REGISTRY_PREFIX && method === 'GET') {
      const mode = modeOf(url)
      send(200, { books: await store.listBooks(mode) })
      return true
    }

    /**
     * Register a new book. ALWAYS `desired: 'stopped'` — see `DEFAULT_BOOK`.
     *
     * Also upserts a `desk-strategies` row for the same tag, added to this
     * book's mode, so the supervisor's first decision does not 403 with
     * `UnknownStrategy` (`service.ts` gates every decision on a registry row
     * existing). A NEW paper row is born switched ON — see the new-row branch
     * below for why — while a live row is added OFF behind its password, and
     * a row that already existed is converged and its switch left alone. The
     * book itself is still `stopped` either way: `start` is a separate call.
     */
    if (path === REGISTRY_PREFIX && method === 'POST') {
      const parsed = validateBookCreate(await ctx.readJson())
      if (!parsed.ok) {
        send(400, { error: parsed.error })
        return true
      }
      const create = parsed.value
      /**
       * ALREADY REGISTERED: CONVERGE, don't refuse.
       *
       * The registry row and the strategy row are separate records, and
       * removing a book from the Strategies page removes only the second. The
       * 409 used to return HERE, before `addStrategyMode` — the one call that
       * could have put the strategy row back — so a delete-then-rebuild left
       * the tag registered with no switch, and step 3 refused with "is not
       * added to paper, so there is no switch to flip". There was no way
       * forward from the UI.
       *
       * A DIFFERENT book on the same tag is still a conflict and still 409s:
       * converging must not silently re-point a book that may already hold a
       * position. The existing row is returned untouched either way — this
       * path never rewrites it, and never touches `desired`.
       */
      const existing = await store.getBook(create.tag, create.mode)
      if (existing !== null) {
        const conflict = bookIdentityConflict(existing, create)
        if (conflict !== null) {
          send(409, {
            error:
              `'${create.tag}' already has a DIFFERENT book registered in ${create.mode} ` +
              `(${conflict}) — deregister it or use another tag`,
          })
          return true
        }
        // Idempotent, and documented as preserving an existing row's label,
        // kind and live lots. Added OFF, exactly as a first registration is.
        const convergedAt = now()
        await store.addStrategyMode(
          { tag: create.tag, kind: 'external', label: create.tag },
          create.mode,
          convergedAt,
        )
        // From the row's OWN dials, not the incoming create's — this path never
        // applies those. A book whose strategy row was deleted from the
        // Strategies page and rebuilt here would otherwise come back with a
        // switch and no stop, which looks exactly like a guarded one.
        await armBookDayGuard({
          store,
          log,
          tag: existing.tag,
          dials: existing.dials,
          nowMs: convergedAt,
          replace: false,
        })
        log('book already registered — strategy row converged', {
          tag: existing.tag,
          mode: existing.mode,
        })
        await audit.record({
          principal: ctx.principal,
          source: REGISTRY_PREFIX,
          action: "converged an existing book's strategy row",
          tag: existing.tag,
          mode: existing.mode,
          // Nothing about the book itself moved on this path — said explicitly,
          // so this entry is never read as a re-registration.
          detail: { variant: existing.variant, bookUnchanged: true },
        })
        send(200, existing)
        return true
      }
      const nowMs = now()
      const row: BookRow = {
        tag: create.tag,
        symbol: create.symbol,
        expiry: create.expiry,
        mode: create.mode,
        variant: create.variant,
        series: create.series,
        ...DEFAULT_BOOK,
        dials: create.dials,
        createdAt: nowMs,
        updatedAt: nowMs,
      }
      await store.upsertBook(row)
      /**
       * THE SERIES ROW — the one record of this book that outlives its erase.
       *
       * Insert-only (`recordSeries`), and best effort: the registry row above
       * is already durable, so failing the create here would report a book
       * that exists as one that does not. A miss is not lost either — the
       * audit line below carries symbol and variant, and the boot backfill
       * (`migrate.ts`) records any reported tag that has no series row.
       */
      try {
        await recordSeries(deps.db, {
          tag: row.tag,
          mode: row.mode,
          series: row.series,
          symbol: row.symbol,
          variant: row.variant,
          expiry: row.expiry,
          createdAt: nowMs,
        })
      } catch (err) {
        log('book series NOT recorded — the boot backfill will retry it from the audit log', {
          tag: row.tag,
          mode: row.mode,
          error: err instanceof Error ? err.message : String(err),
        })
      }
      // Added, not registered wholesale: an existing strategy row (the tag may
      // already trade the OTHER mode, or already exist from a prior book on
      // this same tag) must keep its label, kind and live lots untouched.
      const added = await store.addStrategyMode(
        { tag: create.tag, kind: 'external', label: create.tag },
        create.mode,
        nowMs,
      )
      /**
       * A FRESH PAPER ROW IS BORN SWITCHED ON (spec E3, D3).
       *
       * `addStrategyMode` writes `{ enabled: false }` and that is not the
       * caller's to choose — it is shared with `POST /v1/desk/strategies`,
       * where the add form must not be a trading permission. But a REGISTRY
       * create is the operator asking for a book: the switch exists to STOP
       * one, and a row that did not exist a moment ago has nothing to stop.
       * Born OFF, a fresh daily paper book (D1) decides all day and fills
       * nothing — three books did exactly that from 09-16 to 09-18, 835
       * refused orders, and "purged book comes back switched off" is in the
       * operator's memory file for the same reason.
       *
       * PAPER ONLY, and ONLY on this branch:
       *   - live keeps its password. Turning `modes.live` on is the one
       *     password-gated action on the desk (`routes/desk.ts`, contract §1)
       *     and a registry create must not be a second door to it.
       *   - the CONVERGE branch above is untouched. An existing row is one an
       *     operator may have switched off on purpose, and a re-run of the
       *     register script must not switch it back on.
       *   - `'exists'` means paper was ALREADY on the row — added from the
       *     Strategies page first, or a concurrent create won the insert
       *     (`addStrategyMode` answers it for the MODE, not the row) — and an
       *     existing mode's switch is the operator's. A row that exists for
       *     the OTHER mode gets paper added here and turned on: the paper
       *     membership is new even though the row is not, and it is the
       *     membership that was born off. That concurrent-create race leaves a
       *     fresh row OFF; it is negligible and it fails safe.
       *
       * Through `patchStrategy`, which is the path the day guard's re-arm
       * takes and advances the row's version like any other switch flip.
       */
      if (create.mode === 'paper' && added !== 'exists') {
        await store.patchStrategy(create.tag, { modes: { paper: { enabled: true } } }, nowMs)
      }
      // The desk's own day stop, behind the engine's — see `armBookDayGuard`.
      // Only for a book whose dials turn the delta-lean path on; a recenter
      // book is registered exactly as it always was.
      await armBookDayGuard({ store, log, tag: row.tag, dials: row.dials, nowMs, replace: false })
      log('book registered (stopped)', { tag: row.tag, mode: row.mode, variant: row.variant })
      await audit.record({
        principal: ctx.principal,
        source: REGISTRY_PREFIX,
        action: 'registered a book (stopped)',
        tag: row.tag,
        mode: row.mode,
        // `series` too: this line is kept forever and is what the boot
        // backfill (`migrate.ts`) rebuilds a lost series row from.
        detail: { symbol: row.symbol, expiry: row.expiry, variant: row.variant, series: row.series, dials: row.dials },
      })
      send(201, row)
      return true
    }

    const rest = suffixOf(path, `${REGISTRY_PREFIX}/`)
    if (rest !== null) {
      const parts = rest.split('/')
      const tag = parts[0] ?? ''

      // Settle a paper leg whose contract has expired — see `settle-expired.ts`.
      if (parts.length === 2 && parts[1] === 'settle-expired' && method === 'POST') return await handleSettleExpired(deps, ctx, tag)

      /**
       * `POST .../:tag/paper-rail` — `{ mode: 'paper', rail: 'demo' | 'sim' }`.
       *
       * WHERE THIS PAPER BOOK'S ORDERS GO. `demo` (the default) is Delta's
       * testnet whenever a verified `delta-demo` key exists, else the
       * simulator; `sim` forces the simulator. The gateway reads it per order,
       * so it applies from the book's next order.
       *
       * NOT REFUSED ON A HOLDING BOOK, because the gateway already keeps a
       * book that holds legs on the rail it last traded (`dx_rail_used`) until
       * it is flat — a close must reach the exchange its open went to, and
       * that is enforced where the order is routed, which also covers a demo
       * key being added or failing its Test under a holding book.
       *
       * PAPER ONLY: a live order goes to Delta production or nowhere, and no
       * row field can change that. No password — nothing on either rail can
       * move real money.
       */
      if (parts.length === 2 && parts[1] === 'paper-rail' && method === 'POST') {
        const body = bodyObject(await ctx.readJson())
        const mode = requireMode(body)
        if (mode === null) {
          send(400, MODE_REQUIRED)
          return true
        }
        if (mode !== 'paper') {
          send(400, { error: 'the rail choice is for paper books only — a live order always goes to Delta production' })
          return true
        }
        const rail = body['rail']
        if (!isPaperRail(rail)) {
          send(400, { error: "rail must be 'demo' or 'sim'" })
          return true
        }
        const existing = await store.getBook(tag, 'paper')
        if (existing === null) {
          send(404, { error: `'${tag}' has no book registered in paper` })
          return true
        }
        const row = await store.setPaperRail(tag, rail, now(), ctx.principal.name)
        log('book paper rail set', { tag, rail, before: existing.dx_paper_rail, setBy: ctx.principal.name })
        await audit.record({
          principal: ctx.principal,
          source: `${REGISTRY_PREFIX}/:tag/paper-rail`,
          action: "set a paper book's rail",
          tag,
          mode: 'paper',
          detail: { before: existing.dx_paper_rail, after: rail },
        })
        send(200, row)
        return true
      }

      if (parts.length === 2 && parts[1] === 'start' && method === 'POST') {
        const body = bodyObject(await ctx.readJson())
        const mode = requireMode(body)
        if (mode === null) {
          send(400, MODE_REQUIRED)
          return true
        }
        const existing = await store.getBook(tag, mode)
        if (existing === null) {
          send(404, { error: `'${tag}' has no book registered in ${mode}` })
          return true
        }
        // A live BULL-S book does not start without a margin budget (`bull-s-live.ts`).
        const noBudget = mode === 'live' ? liveBudgetRefusal(tag, existing.dials) : null
        if (noBudget !== null) {
          send(400, { error: noBudget })
          return true
        }
        const row = await store.setDesired(tag, mode, 'running', now())
        log('book started', { tag, mode })
        /**
         * TELL THE SUPERVISOR NOW rather than letting it find the change at its
         * next convergence pass — the same reason the dial patch nudges
         * (see `${REGISTRY_PREFIX}/:tag` below), and the reason `NudgeKind` has
         * a `registry` member at all.
         *
         * Pressing Start is an operator waiting for a book to come up. Without
         * this the row sits `desired: running` for up to 30s while the page
         * shows nothing happening, which reads as a broken button.
         *
         * BEST EFFORT, AND IT CANNOT FAIL THE START. The row is already durable
         * by this line and the supervisor converges it regardless, so a
         * supervisor that is down must not be the reason a start reports
         * failure. `notifySupervisor` never throws and never rejects.
         */
        await notifySupervisor('registry', { tag, mode, desired: 'running' }, { log })
        // Both sides: the row was read to check it exists, so "it was already
        // running and someone pressed start again" is recordable rather than
        // indistinguishable from the start that actually moved it.
        await audit.record({
          principal: ctx.principal,
          source: `${REGISTRY_PREFIX}/:tag/start`,
          action: 'started a book',
          tag,
          mode,
          detail: { before: existing.desired, after: 'running' },
        })
        send(200, row)
        return true
      }

      /**
       * ERASE A BOOK, so one can be cleared and rebuilt.
       *
       * Until this existed there was no way to remove a book at all. The
       * Strategies page removes the STRATEGY row's mode; the registry row and
       * the stored position both survive that, and nothing anywhere deleted
       * either — so a book you were finished with stayed on the Books page
       * forever, and re-registering the tag hit the duplicate path instead of
       * starting clean.
       *
       * TWO REFUSALS, both one click away from being satisfied:
       *
       *  - It still HOLDS legs. Erasing then would delete the desk's only
       *    record of a position that still exists at the broker — the P&L, the
       *    delta, the thing that tells you it is there. Flatten first; the
       *    refusal names what is held and where to do it.
       *  - It is still `desired: running`. The supervisor converges this row
       *    every 30s, and deleting it mid-cycle races a worker that is placing
       *    orders under the tag. Stop is a button on the same page.
       *
       * All THREE records go together — see `eraseBook` — because leaving any
       * one behind is what made this broken in the first place.
       */
      if (parts.length === 1 && method === 'DELETE') {
        // NOT `modeOf`, which silently defaults to paper. That default is
        // harmless on a read and unacceptable here: a mistyped `?mode=` on a
        // DELETE would erase the PAPER book without ever being asked for.
        // Same rule the create route states — guessing paper silently does the
        // wrong thing, so the mode is stated or the request is refused.
        const mode = requiredModeParam(url)
        if (mode === null) {
          send(400, MODE_PARAM_REQUIRED)
          return true
        }
        const existing = await store.getBook(tag, mode)
        if (existing === null) {
          send(404, { error: `'${tag}' has no book registered in ${mode}` })
          return true
        }
        if (existing.desired === 'running') {
          send(409, {
            error:
              `'${tag}' is still asked to run in ${mode} — stop it first, or the supervisor ` +
              `will be converging a book that no longer exists`,
          })
          return true
        }
        /**
         * REFUSE ON A REAL POSITION, NOT ON A STALE RECORD.
         *
         * The first version of this guard read `desk-books` and refused while
         * it listed any leg. That is the same record the delete would erase, so
         * a book that had gone stale could never be deleted BECAUSE it was
         * stale — and until 8e32f006 and c1799e66 neither `submit` nor
         * `flattenTag` maintained it, so BAJFINANCE and BHEL were both left
         * permanently undeletable after flattening perfectly cleanly.
         *
         * The position is therefore rebuilt from the FILLS — the same
         * `loadFills` + `buildPositions` pair `flattenTag` uses, and the same
         * one Phase B's P&L runs on. A contract with a non-zero net quantity is
         * a position that really exists and the delete is refused. A book whose
         * legs net to zero is demonstrably stale, and erasing it erases nothing.
         *
         * `heldFromFills` is the shared implementation — the SAME function the
         * seed guard in `routes/desk.ts` calls (F-53: it was copied there under
         * another name). Its header carries the window argument and the F-32
         * flags in full; both are properties of the guard, not of this route.
         */
        const openNow = (): Promise<HeldFromFills> => heldFromFills(store, tag, mode)

        const blockingFlags = (r: HeldFromFills): string | null => {
          if (r.unreadable.length > 0) {
            return (
              `${r.unreadable.length} stored fill(s) for '${tag}' could not be read, so the ` +
              `position rebuilt from them may be WRONG — and deleting the book erases the desk's ` +
              `only record of it. ${r.unreadable.join('; ')}`
            )
          }
          if (r.capped) {
            return (
              `the fill read for '${tag}' hit its cap, so the position rebuilt from it may be ` +
              `UNDERSTATED — and this delete cannot be undone`
            )
          }
          return null
        }

        let fillsRead = await openNow()
        const badRead = blockingFlags(fillsRead)
        if (badRead !== null) {
          send(409, {
            error: badRead,
            malformedFills: fillsRead.unreadable,
            fillsTruncated: fillsRead.capped,
          })
          return true
        }
        let held = fillsRead.held
        /**
         * `?flatten=1` — CLOSE IT AND THEN DELETE, in one act.
         *
         * Opt-in, and deliberately not the default. This is the only control in
         * the system where one click both PLACES ORDERS and erases a record,
         * and a delete that quietly traded would be indefensible: the operator
         * has to have asked for it. With the flag the refusal becomes the
         * pointless step it looked like — "flatten it first" when flattening is
         * exactly what you wanted — without ever making trading implicit.
         *
         * The position is re-read AFTER the flatten rather than trusting its
         * return: if anything failed to route, the delete must not proceed, and
         * the same fills-derived count that guards the delete is what says so.
         */
        if (held.length > 0 && url.searchParams.get('flatten') === '1') {
          const attempt = await deleteFlattenId(store, tag, mode, istDate(now()))
          if (attempt.id === null) {
            send(409, { error: attempt.error, attemptsSpent: MAX_DELETE_FLATTEN_ATTEMPTS })
            return true
          }
          await deps.service.flattenTag({
            tag,
            mode,
            /**
             * DETERMINISTIC PER DAY, never `now()` — and re-minted only after a
             * flatten that demonstrably did not work. See `deleteFlattenId`.
             */
            decisionId: attempt.id,
            style: 'fast',
            /**
             * THE SAME WINDOW AS THE GUARD — every fill that exists. Left at
             * `flattenTag`'s one-trading-day default, a positional book whose
             * opens were journalled on an earlier day flattened NOTHING, and
             * the unbounded re-read below then refused the delete with
             * "flatten it first" — which is what the caller had just asked
             * for (NIFTY-2026-08-25-recenter-r, 2026-08-03). Two reads that
             * answer "what does this tag hold" inside one act must not be
             * given two different windows.
             */
            sinceMs: 0,
          })
          fillsRead = await openNow()
          const afterFlatten = blockingFlags(fillsRead)
          if (afterFlatten !== null) {
            send(409, {
              error: afterFlatten,
              malformedFills: fillsRead.unreadable,
              fillsTruncated: fillsRead.capped,
            })
            return true
          }
          held = fillsRead.held
        }
        if (held.length > 0) {
          send(409, {
            error:
              `'${tag}' still holds ${held.length} open position(s) in ${mode} — ` +
              `${held.map((p) => `${p.tradingsymbol} ${p.qty > 0 ? '+' : ''}${p.qty}`).join(', ')}. ` +
              `Deleting the book would erase the desk's only record of a position that still ` +
              `exists. Flatten it first with POST /v1/desk/close-all { tag, mode, style, decisionId }.`,
            legs: held.map((p) => p.tradingsymbol),
          })
          return true
        }
        /**
         * `?purge=1` — ALSO erase this tag's trading history.
         *
         * For rebuilding a structure on the same day. Trades, decisions and
         * P&L are keyed by TAG, not by book, so they survive a delete and the
         * next book on the same tag inherits them: rebuild BHEL today and its
         * P&L starts at the earlier round trip's realised loss. Since the tag
         * is `symbol-expiry-variant`, rebuilding the same structure the same
         * day necessarily reuses it.
         *
         * PAPER ONLY. On the live rail these rows are the desk's copy of
         * orders that really reached a broker, whose own record cannot be
         * deleted — purging would leave the two permanently disagreeing with
         * no way to tell which is right.
         *
         * And only once the tag is verifiably FLAT, which the guard above has
         * already established by this line. These fills ARE the source of
         * truth for what a tag holds — `flattenTag` and the guard both
         * reconstruct the position from them — so erasing them while anything
         * is open would make the position unknowable rather than merely
         * unrecorded.
         */
        const purge = url.searchParams.get('purge') === '1'
        if (purge && mode !== 'paper') {
          send(409, {
            error:
              `purge is refused on the live rail: these rows are the desk's copy of orders that ` +
              `really reached the broker, and deleting them would leave the desk and the broker ` +
              `permanently out of step`,
          })
          return true
        }
        const purged = purge ? await store.purgeTagHistory(tag) : null

        await store.eraseBook(tag, mode)
        // The switch goes too. A tag left added-but-bookless still looks
        // tradable on the Strategies page, and an order under it would be
        // gated by a row whose book nobody can see.
        const remaining = await store.removeStrategyMode(tag, mode, now())
        /**
         * AND WHEN THAT WAS THE ROW'S LAST MODE, THE ROW GOES WITH IT — but
         * only from HERE, and only once no registry row is left for the tag on
         * EITHER rail. The daily roll would otherwise leave four `modes: {}`
         * orphans a day (`store.deleteOrphanStrategy` says where they surface).
         *
         * Why not in `removeStrategyMode` itself: that is also the Strategies
         * page's route, and taking a running book's only mode off that page
         * must leave the row EMPTIED, not missing — the supervisor's registry
         * poll reads `modes: {}` as OFF and stands a flat book down quietly,
         * but reads NO row as UNKNOWN, keeps deciding, and turns every post
         * into an `UnknownStrategy` 403 storm. The other-rail check is the same
         * argument one step on: a live book whose mode was removed from the
         * page has left the row empty while it is still registered, and a
         * paper erase must not be the thing that deletes the row from under it.
         * `remaining` is the row as the removal left it, so an `'absent'`
         * (the page had already taken the mode off) is still followed by the
         * orphan check — the row may be empty either way.
         */
        const other: DeskMode = mode === 'paper' ? 'live' : 'paper'
        const orphan =
          remaining !== null &&
          (remaining === 'absent' || (remaining.kind === 'external' && Object.keys(remaining.modes).length === 0)) &&
          (await store.getBook(tag, other)) === null
        const rowDeleted = orphan ? await store.deleteOrphanStrategy(tag) : false
        log('book DELETED', { tag, mode, variant: existing.variant, rowDeleted, ...(purged ?? {}) })
        /**
         * THE MOST IRREVERSIBLE CONTROL ON THE PAGE, and until now the only
         * record of who used it was a log file. `flattened` and `purged` travel
         * with it because they are separate acts folded into this one request:
         * one placed real orders, the other erased trading history.
         */
        await audit.record({
          principal: ctx.principal,
          source: `${REGISTRY_PREFIX}/:tag`,
          action: 'DELETED a book',
          tag,
          mode,
          detail: {
            variant: existing.variant,
            flattenRequested: url.searchParams.get('flatten') === '1',
            purged: purged ?? false,
          },
        })
        send(200, { deleted: tag, mode, ...(purged === null ? {} : { purged }) })
        return true
      }

      /**
       * CLOSE ONE STRIKE out of a running book, leaving the rest of the
       * structure standing.
       *
       * The operator's case: a short option whose delta has decayed to ~0.10
       * does no work in the structure any more, but it still costs margin and
       * still carries the tail. This closes exactly that contract.
       *
       * REFUSED WHILE THE BOOK IS NOT `actual: running`, and that gate is the
       * whole reason this endpoint can be safe.
       *
       * The Python driver owns `state["book"]`, and that book only ever changes
       * through `translate.apply_fills` (fills for orders THE DRIVER placed) and
       * `translate.reconcile`, whose contract is explicitly "no matching row in
       * book -> left unchanged". Neither can hear about a close initiated here.
       * What DOES hear about it is the driver's own book-vs-bridge absorb pass,
       * which runs each tick and drops legs the bridge no longer holds — and a
       * driver that is not running never runs it. Closing the leg anyway would
       * leave the strategy hedging, recentring and sizing against a position
       * that no longer exists, and it would keep doing so across a restart,
       * because it reloads the same state file.
       *
       * So the refusal is not bureaucracy: `actual: running` is the statement
       * that something is alive to absorb this. 409 rather than 404 for the same
       * reason `close-all` uses one — the one thing an operator must never read
       * an exit refusal as is "already done".
       */
      if (parts.length === 2 && parts[1] === 'close-leg' && method === 'POST') {
        const body = bodyObject(await ctx.readJson())
        const mode = requireMode(body)
        if (mode === null) {
          send(400, MODE_REQUIRED)
          return true
        }
        const tradingsymbol = body['tradingsymbol']
        if (typeof tradingsymbol !== 'string' || tradingsymbol === '') {
          send(400, { error: 'tradingsymbol is required — it names the one contract to close' })
          return true
        }
        const style = body['style']
        if (style !== 'fast' && style !== 'limit') {
          // Stated, never defaulted — the same rule `close-all` holds. 'fast'
          // is MARKET (certain fill, uncontrolled price) and 'limit' prices
          // through the mark; picking for the operator picks a tradeoff in the
          // one situation where they are most likely to care which.
          send(400, { error: "style must be stated explicitly as 'fast' or 'limit'" })
          return true
        }
        if (typeof body['decisionId'] !== 'string' || body['decisionId'] === '') {
          send(400, { error: 'decisionId is required — it makes a retried close safe' })
          return true
        }
        // A FRACTION, and bounded. `safety.ts` prices the exit at
        // `mark × (1 + aggression)` with no ceiling of its own, so an
        // unchecked `5` (meaning 5%) buys a ₹40 short back at ₹240 (F-34).
        const aggressionBad = aggressionPctError(body['aggressionPct'])
        if (aggressionBad !== null) {
          send(400, { error: aggressionBad })
          return true
        }
        const registered = await store.getBook(tag, mode)
        if (registered === null) {
          send(404, { error: `'${tag}' has no book registered in ${mode}` })
          return true
        }
        if (registered.actual !== 'running') {
          send(409, {
            error:
              `'${tag}' is not running in ${mode} (the supervisor last reported ` +
              `'${registered.actual}'): NOTHING WAS CLOSED. The strategy would go on managing ` +
              `a leg that no longer exists, because only a running driver reconciles its book ` +
              `against the bridge. Start the book first, or flatten the whole thing with ` +
              `POST /v1/desk/close-all.`,
            tag,
            mode,
            actual: registered.actual,
            desired: registered.desired,
          })
          return true
        }
        const result = await deps.service.closeLeg({
          tag,
          mode,
          tradingsymbol,
          decisionId: body['decisionId'],
          style,
          ...(typeof body['aggressionPct'] === 'number'
            ? { aggressionPct: body['aggressionPct'] }
            : {}),
        })
        if (!result.ok) {
          // Both refusals mean NOTHING WAS CLOSED, and `no-leg` names what the
          // book does hold: the realistic cause is a stale dashboard, where the
          // strategy closed the contract itself between the render and the click.
          const detail =
            result.reason === 'no-book'
              ? `the desk holds no ${mode} book document for it`
              : result.held.length === 0
                ? `the book is flat`
                : `it holds ${result.held.join(', ')}`
          log('CLOSE-LEG REFUSED', { tag, mode, tradingsymbol, reason: result.reason })
          send(409, {
            error:
              `'${tag}' has nothing open on ${tradingsymbol} in ${mode} — ${detail}. ` +
              `NOTHING WAS CLOSED.`,
            tag,
            mode,
            tradingsymbol,
            reason: result.reason,
            held: result.held,
          })
          return true
        }
        log('CLOSE-LEG', {
          tag,
          mode,
          tradingsymbol,
          style,
          legs: result.closed.length,
          fills: result.fills.length,
          skips: result.skips.length,
          unpriceable: result.unpriceable.length,
        })
        await audit.record({
          principal: ctx.principal,
          source: `${REGISTRY_PREFIX}/:tag/close-leg`,
          action: 'closed one leg of a book',
          tag,
          mode,
          detail: {
            tradingsymbol,
            style,
            decisionId: body['decisionId'],
            legs: result.closed.length,
            fills: result.fills.length,
            skips: result.skips.length,
          },
        })
        // 200 even when a leg failed to route: the request WAS processed, and
        // `skips`/`fills` say per leg what happened. A 4xx would invite a blind
        // retry of a close that already partly went out.
        send(200, result)
        return true
      }

      if (parts.length === 2 && parts[1] === 'stop' && method === 'POST') {
        const body = bodyObject(await ctx.readJson())
        const mode = requireMode(body)
        if (mode === null) {
          send(400, MODE_REQUIRED)
          return true
        }
        const existing = await store.getBook(tag, mode)
        if (existing === null) {
          send(404, { error: `'${tag}' has no book registered in ${mode}` })
          return true
        }
        const row = await store.setDesired(tag, mode, 'stopped', now())
        log('book stopped', { tag, mode })
        /**
         * AND THE STOP NUDGES TOO — the half that actually matters. Start is a
         * convenience; stop is an operator taking a book off the desk, and up
         * to a convergence interval of a strategy that has been told to stop
         * still deciding is the window they were trying to close. Best effort
         * on the same terms as the start above: the row is durable, the
         * supervisor converges regardless, and this cannot fail the stop.
         */
        await notifySupervisor('registry', { tag, mode, desired: 'stopped' }, { log })
        await audit.record({
          principal: ctx.principal,
          source: `${REGISTRY_PREFIX}/:tag/stop`,
          action: 'stopped a book',
          tag,
          mode,
          detail: { before: existing.desired, after: 'stopped' },
        })
        send(200, row)
        return true
      }

      /**
       * `GET .../:tag/decisions` — what the strategy says it is doing.
       *
       * Two different questions in one payload, because the run page asks them
       * together: `lastReason` is the CURRENT state (rewritten every mark, so
       * it answers "why is it doing nothing right now"), and `actions` is the
       * history of decisions that actually traded.
       *
       * AN UNREGISTERED BOOK ANSWERS 200 WITH EMPTY FIELDS, not 404. A book
       * created a minute ago has no reason yet and neither does one whose desk
       * predates the feature; both are normal, and a 404 here would put an
       * error state on a page that is working. `/actual` above returns 404 for
       * the same book because a supervisor reporting state for a book that
       * does not exist IS a fault — a reader asking about one is not.
       */
      if (parts.length === 2 && parts[1] === 'decisions' && method === 'GET') {
        const mode = requiredModeParam(url)
        if (mode === null) {
          send(400, MODE_PARAM_REQUIRED)
          return true
        }
        const row = await store.getBookRaw(tag, mode)
        const log_ = Array.isArray(row?.['actionLog']) ? (row['actionLog'] as unknown[]) : []
        /**
         * `?actions=0` OMITS the log — it does not empty it.
         *
         * The log is capped at 200 entries and callers that render only
         * `lastReason` (the one-line strip above the positions tiles) were
         * pulling all of it every ten seconds to discard it. Sending `[]`
         * instead would be a lie in the shape of an answer: an empty log means
         * "this book has never traded", which is a real and different state.
         */
        const withActions = url.searchParams.get('actions') !== '0'
        send(200, {
          tag,
          mode,
          lastReason: typeof row?.['lastReason'] === 'string' ? row['lastReason'] : null,
          lastAction: typeof row?.['lastAction'] === 'string' ? row['lastAction'] : null,
          lastReasonAt: typeof row?.['lastReasonAt'] === 'number' ? row['lastReasonAt'] : null,
          // Stored oldest-last by `$push`, which is already the order the panel
          // reads in. No reversal here — see the web component.
          ...(withActions ? { actions: log_ } : {}),
        })
        return true
      }

      /**
       * `POST .../:tag/actual` — the supervisor reporting its own state back.
       *
       * The only writer of `actual` (see `books-registry.ts`). Not gated on the
       * book being `desired: 'running'`: a supervisor that is still winding
       * down after a stop must be able to report `actual: 'running'` for one
       * more poll, or the page would show it stopped before it is.
       */
      if (parts.length === 2 && parts[1] === 'actual' && method === 'POST') {
        const body = bodyObject(await ctx.readJson())
        const mode = requireMode(body)
        if (mode === null) {
          send(400, MODE_REQUIRED)
          return true
        }
        const parsed = validateActualReport(body)
        if (!parsed.ok) {
          send(400, { error: parsed.error })
          return true
        }
        const existing = await store.getBook(tag, mode)
        if (existing === null) {
          send(404, { error: `'${tag}' has no book registered in ${mode}` })
          return true
        }
        const row = await store.setActual(
          tag,
          mode,
          parsed.value.actual,
          parsed.value.lastMarkAt,
          parsed.value.lastDecision,
          now(),
        )
        send(200, row)
        return true
      }

      /**
       * `PATCH .../:tag` — dials only. See `validateBookDialsPatch`.
       *
       * THIS IS A RISK CONTROL, NOT A PREFERENCE PANEL. The supervisor pushes
       * these into the live worker before every tick, so a save here reaches a
       * RUNNING live book at its next 5-minute mark and changes the size and
       * the shape of the orders it places. F-29 found it with none of the
       * defences the other money-moving endpoints have: no re-auth, no record
       * of who, and no check that the knob being set is one the playbook reads.
       * All three are here now, in the order that costs the operator least: the
       * typo is answered before the password prompt, never after it.
       */
      if (parts.length === 1 && tag !== '' && method === 'PATCH') {
        const body = bodyObject(await ctx.readJson())
        const mode = requireMode(body)
        if (mode === null) {
          send(400, MODE_REQUIRED)
          return true
        }
        const parsed = validateBookDialsPatch(body)
        if (!parsed.ok) {
          send(400, { error: parsed.error })
          return true
        }
        const existing = await store.getBook(tag, mode)
        if (existing === null) {
          send(404, { error: `'${tag}' has no book registered in ${mode}` })
          return true
        }
        // The catalogue is the only statement of what knobs this variant has.
        // A variant it does not carry gives `null`, which the validator reports
        // as "unpublished" rather than as the operator's typo.
        const variants = await store.listVariants()
        const catalogue = variants.find((v) => v.key === existing.variant)
        const checked = validateDialsAgainstCatalogue({
          dials: parsed.value.dials,
          current: existing.dials,
          variant: existing.variant,
          defaults: catalogue?.defaults ?? null,
        })
        if (!checked.ok) {
          send(400, { error: checked.error })
          return true
        }
        // A live BULL-S book is never left without a margin budget: a patch that
        // would turn BULL-S on at 0, or take the budget to 0, is refused — set
        // the budget in the same patch (`bull-s-live.ts`). Before the password.
        if (mode === 'live') {
          const noBudget = liveBudgetRefusal(tag, { ...existing.dials, ...checked.value })
          if (noBudget !== null) {
            send(400, { error: noBudget })
            return true
          }
        }
        /**
         * NO ENGINE SWITCH UNDER HELD LEGS (six-playbooks spec §3, F9).
         *
         * `delta_lean_enabled` and `pb_playbook` choose which engine steers
         * this book, and `dl_parity_forward` the forward it is priced on
         * (`engineSwitchChanges`). Changed while the book holds legs, the new
         * engine inherits a position it did not open and whose exits it does
         * not know — a recenter corridor handed to the delta-lean clock, a
         * Wing Straddle's shorts handed to Trend Drive — or the same engine
         * re-reads every delta off a forward 300-odd points away and trades on
         * it. So a patch that CHANGES any of them, as the engine resolves them, is
         * refused while `desk-books` lists a leg with a nonzero qty, or
         * cannot be read. Restating a value, a flat book, and every other dial
         * on a holding book all go through: retightening a running book is
         * what this PATCH is for.
         *
         * Before the password prompt, like the typo: a refusal the password
         * cannot change is answered before the operator is asked for it.
         */
        const switches = engineSwitchChanges(existing.dials, checked.value)
        if (switches.length > 0) {
          const held = heldOnFile(await store.bookDoc(tag, mode))
          const change = switches
            .map((s) => `${s.key} ${JSON.stringify(s.before)} -> ${JSON.stringify(s.after)}`)
            .join(' and ')
          if (held === null) {
            send(409, {
              error:
                `'${tag}' in ${mode}: this patch changes ${change} — the dial(s) that choose which engine ` +
                `steers the book, or the forward it is priced on — and its desk-books document cannot be read (no leg array, or a leg with ` +
                `no usable qty), so the desk cannot tell whether it holds legs. Nothing was written. Check ` +
                `the book by hand; every other dial can still be patched.`,
              dials: switches.map((s) => s.key),
            })
            return true
          }
          if (held.length > 0) {
            send(409, {
              error:
                `'${tag}' holds ${held.length} open leg(s) in ${mode} — ${held.join(', ')} — and this patch ` +
                `changes ${change}, the dial(s) that choose which engine steers the book or the forward it ` +
                `is priced on. The book would be steered on legs it did not open, or on deltas re-read off ` +
                `a different forward. Nothing was written. Flatten the book first ` +
                `(POST /v1/desk/close-all { tag, mode, style, decisionId }), then change the switch; every ` +
                `other dial can still be patched.`,
              legs: held,
              dials: switches.map((s) => s.key),
            })
            return true
          }
          // FLAT ON FILE IS NOT YET FLAT AT THE BROKER (integration review
          // finding 7). A playbook's stage-1 wings rest for a peg before they
          // fill, and `desk-books` lists nothing until they do: switched in
          // that window, they fill under an engine that never opened them,
          // beside a plan that holds shorts against them. So a decision the
          // supervisor still has working refuses the switch too.
          const working = await workingOnFile(deps.db, tag, mode)
          if (working !== null) {
            send(409, {
              error:
                `'${tag}' in ${mode}: this patch changes ${change}, and the supervisor still has decision ` +
                `${working} working on the book — orders that may yet fill under the new setting. Nothing was ` +
                `written. Wait for it to finish, then change the switch; every other dial can still be patched.`,
              decisionId: working,
              dials: switches.map((s) => s.key),
            })
            return true
          }
        }
        /**
         * LIVE COSTS THE PASSWORD, exactly as arming a live strategy does
         * (`routes/desk.ts`'s strategy PATCH and bulk switch). A machine
         * principal cannot satisfy this at all — `authsvc` refuses re-auth for
         * one by design — so the shared bearer the Python desk carries can no
         * longer retune a live book on its own, which is what F-29 reported.
         * PAPER is unchanged: no prompt, because nothing there can move money.
         */
        if (mode === 'live') {
          const denied = await gate.reauth(ctx.principal, body['password'])
          if (denied !== null) {
            send(403, { error: denied, reauthRequired: true })
            return true
          }
        }
        // `dialsSetBy` is the AUTHENTICATED principal, never the body — the
        // same rule the kill switch's `setBy` holds. Written in the SAME update
        // as the dials so a knob can never land without the record of who set
        // it. And the VALUES are logged, not just the key names: "dials
        // patched: [shift_margin_frac]" cannot answer "what was it changed to?"
        // the next morning.
        const row = await store.patchBookDials(
          tag,
          mode,
          checked.value,
          now(),
          ctx.principal.name,
        )
        log('book dials patched', {
          tag,
          mode,
          dials: checked.value,
          setBy: ctx.principal.name,
        })
        /**
         * KEEP THE DESK'S DAY STOP IN STEP WITH THE BOOK'S — see
         * `armBookDayGuard`. Only when this patch restated the day budget or
         * the delta-lean switch, and read off the MERGED dials the store just
         * returned, so `{ delta_lean_enabled: true }` alone resolves the budget
         * from the rest of the row rather than from this patch's two keys.
         *
         * TURNING THE SWITCH OFF DOES NOT DISARM ANYTHING, and that is
         * deliberate: `bookGuardStop` answers null for a book that is no longer
         * delta-lean, so the existing stop simply stands. Removing a stop as a
         * SIDE EFFECT of a dial save is the one direction that can only cost
         * money; an operator who wants it gone sends `dailyLimits: null` to
         * `PATCH /v1/desk/strategies/:tag`, which asks for it out loud.
         */
        if (
          row !== null &&
          (checked.value['dl_day_max_loss'] !== undefined ||
            checked.value['delta_lean_enabled'] !== undefined)
        ) {
          await armBookDayGuard({ store, log, tag, dials: row.dials, nowMs: now(), replace: true })
        }
        /**
         * BEFORE AND AFTER, for the knobs this patch actually touched.
         *
         * `dialsSetBy` on the row answers "who last set the dials"; it cannot
         * answer "what was `shift_margin_frac` before Tuesday?", which is the
         * question a book that changed behaviour raises. The before is narrowed
         * to the touched keys so the entry stays a summary — the whole dial set
         * is on the row.
         *
         * The password is in `body` and is NOT passed here. `redactDetail`
         * would strip it anyway; not handing it over is the first line.
         */
        /**
         * TELL THE SUPERVISOR NOW, rather than letting it find out at its next
         * 5-minute mark.
         *
         * These are risk controls — the header above says so — and the whole
         * reason they are patchable on a RUNNING book is that an operator
         * watching a position go wrong can retighten it without a restart. Up
         * to five minutes of the old corridor is exactly the window they were
         * trying to close.
         *
         * BEST EFFORT, AND IT CANNOT FAIL THE PATCH. The dials are already
         * durable by this line and the supervisor re-reads them at its next
         * mark regardless, so a supervisor that is down (or not deployed yet)
         * must not be the reason an operator cannot change a limit. See
         * `engine-notify.ts` — it never throws, and its timeout bounds this.
         *
         * NO CREDENTIAL IS PASSED HERE AND THAT IS NOT AN OVERSIGHT: the
         * notifier presents `DESK_API_TOKEN` by default, so every call site is
         * authenticated by construction rather than by each one remembering.
         */
        await notifySupervisor('dials', { tag, mode }, { log })

        const touched = Object.keys(checked.value)
        await audit.record({
          principal: ctx.principal,
          source: `${REGISTRY_PREFIX}/:tag`,
          action: 'patched a book\'s dials',
          tag,
          mode,
          detail: {
            before: Object.fromEntries(touched.map((k) => [k, existing.dials[k] ?? null])),
            after: checked.value,
          },
        })
        send(200, row)
        return true
      }
    }

    return false
  }
}
