/**
 * Typed client for the desk bridge.
 *
 * Mirrors the server's response shapes exactly. Where the server distinguishes
 * "unknown" from "zero" — `netDelta` when legs are unpriced, `spot` with a dead
 * feed — that distinction is preserved here rather than defaulted away, because
 * the entire point of those fields is that a dashboard must not present an
 * incomplete number as authoritative.
 */

// `contract.ts` imports nothing, so this cannot form a cycle. `groupOrders`
// needs it to tell the Kite packing from the broker's own echo of a symbol.
import { formatContract } from './contract.ts'

export type DeskMode = 'paper' | 'live'

export interface LegGreeks {
  tradingsymbol: string
  qty: number
  iv: number | null
  price: number
  delta: number
  gamma: number
  vega: number
  theta: number
  positionDelta: number
  positionGamma: number
  positionVega: number
  positionTheta: number
}

export interface BookGreeks {
  legs: LegGreeks[]
  netDelta: number
  netGamma: number
  netVega: number
  netTheta: number
  /** Legs excluded from the totals. Non-empty means the totals are partial. */
  unpriced: string[]
  /**
   * Legs whose quote admitted no IV, priced INTO the totals theoretically —
   * model price off spot and expiry at the book's median solved vol. Their
   * figures are estimates and the rows say so. Optional: an older bridge
   * does not send it.
   */
  fallbackPriced?: string[]
}

export interface BridgeLeg {
  deskTag: string
  instrument: { tradingsymbol: string; instrumentToken?: number; lotSize: number }
  underlying: string
  expiry: string
  strike: number
  type: 'CE' | 'PE'
  side: 'Buy' | 'Sell'
  qty: number
  entryPrice: number
  openedTs: number
  /**
   * Who authored the order that opened this leg. `repair` legs are the ones the
   * repair Apply button placed, and the Python driver adopts them bot-managed.
   * Absent means manual — every leg the desk already holds omits it.
   */
  origin?: 'manual' | 'repair'
}

export interface PositionsResponse {
  /**
   * THE BOOK'S KEY, since Phase 0. A symbol can now carry several variants at
   * once, so `tag` — not `symbol` — is what identifies which book this is.
   */
  tag: string
  symbol: string
  mode: DeskMode
  legs: BridgeLeg[]
  greeks: BookGreeks
  spot: number | null
  asOf: number
  /** False means the greeks cover only a SUBSET of the book. */
  complete: boolean
  /** True when any mark is a persisted snapshot rather than a live tick. */
  stale?: boolean
  marksAsOf?: number | null
  /**
   * The bid/ask pair each leg's mark was valued off, by tradingsymbol —
   * absent from a bridge a deploy behind, and absent per leg when its book
   * could not answer.
   */
  quotes?: Record<string, LegQuote>
  /**
   * WHOSE greeks these are.
   *
   * `'strategy'` — the running Python desk's own, published on its
   * declaration. `'dashboard'` — computed by the bridge, because the strategy
   * published none or its set has gone stale.
   *
   * The two do not agree and cannot be made to: the strategy prices every leg
   * off the FUTURE, the bridge off cash spot, and the error compounds through
   * the IV inverted from the mark. On the live BHEL book they disagreed on the
   * SIGN of net delta. The strategy's is the one the book was traded on.
   *
   * OPTIONAL, because a server a deploy behind sends neither — the page must
   * render rather than white-screen, so absent reads as "not stated".
   */
  greeksSource?: 'strategy' | 'dashboard'
  /** When the served greeks were computed. Null when the bridge computed them. */
  greeksAt?: number | null
  /** The reference price they were computed against — the future, or cash. */
  greeksSpot?: number | null
  /**
   * WHAT THE STRATEGY STEERS BY, when that is not the whole book.
   *
   * Under `delta_shorts_only` the rules read their SHORT legs only, so on the
   * live BHEL book the book carried +408 delta while the shorts alone were
   * -1836 — opposite signs, the long hedge legs holding the positive delta.
   * `greeks` stays the whole book; this is the figure the Strategy panel
   * prints and the rules compare against their band.
   *
   * Null when the strategy reported none, or the set is stale.
   */
  steering?: { delta: number; gamma: number } | null
  /**
   * REALISED-TO-DATE for this tag — what the desk has BOOKED on closed
   * tranches, rolls and resizes, gross of costs, from the reconciler-corrected
   * fills. The Positions table adds it to the open legs' subtotal so the Total
   * is the book's NET, not the surviving legs' gain since entry (the +95k that
   * was a loss, 2026-08-18; audit F-52 is the labelling half of the story).
   *
   * OPTIONAL — an older bridge sends nothing — and NULL when the bridge could
   * not vouch for the figure (a capped fill read, an unreadable fill, a seeded
   * or long-carried book whose opens predate the window). Both render the
   * Total exactly as it always was: open legs only, labelled as such.
   */
  realised?: number | null
  /**
   * A MULTI-LEG REPAIR IS EXECUTING ON THIS BOOK RIGHT NOW.
   *
   * `heldAt` is when the run started, `untilMs` when the hold lapses on its own
   * (a desk-api that dies mid-run leaves the run document RUNNING forever, so
   * the hold is bounded rather than eternal). The Python driver polls this same
   * payload and stands down while it is non-null — see `repair-apply.ts` on the
   * bridge — which is what stops the desk's own rules routing orders into a
   * half-placed repair.
   *
   * The bridge always sends the key, null when nothing is running; OPTIONAL
   * here only because a bridge a deploy behind sends nothing at all, and
   * `undefined` must render as "not stated" rather than as "not held".
   */
  repairHold?: { applyId: string; heldAt: number; untilMs: number } | null
}

export interface BookSummary {
  /**
   * THE KEY, since Phase 0. `symbol` alone no longer identifies one book — a
   * symbol can carry several variants (several tags) open at once.
   */
  tag: string
  symbol: string
  legs: number
  netDelta: number | null
  /** What the strategy steers by, when that is not the whole book. */
  steeringDelta?: number
  /**
   * Distance from delta-neutral as a PERCENTAGE OF SPOT. The tab strip shows
   * this rather than a raw delta, which is not comparable across books at
   * different price levels — +176 means one thing on BHEL at 426 and another
   * on TCS at 2355, and the strip exists to be scanned across all three.
   */
  neutralPct?: number
  complete: boolean
  updatedAt: number
  /**
   * True when any displayed mark is a persisted snapshot rather than a live
   * tick — which is how every book looks outside a session.
   *
   * OPTIONAL BECAUSE AN OLDER BRIDGE DOES NOT SEND IT. Absent means "not
   * stated", which is not the same as `false`, and no reader may turn it into
   * one: `false` is a claim that these marks came off the wire just now.
   */
  stale?: boolean
  /** When the oldest displayed mark was true. Null when all of them are live. */
  marksAsOf?: number | null
}

export interface FeedStatus {
  feedAlive: boolean
  marksHeld: number
  subscribedTokens: number
  coverage: number
  msSinceLastTick: number | null
  /**
   * COUNTS, NOT SYMBOLS. This endpoint is unauthenticated, and the previous
   * shape listed every book by name with its leg count — what the desk is
   * positioned in, to anyone who could reach the port. The counts answer the
   * readiness question just as well; `/v1/desk/books` carries the detail behind
   * auth, which is where a page that needs the names gets them.
   */
  bookCount: number
  /** Books with at least one leg that could not be marked. 0 is the ready state. */
  booksIncomplete: number
  /**
   * `feedAlive && booksIncomplete === 0`.
   *
   * HOLDING NOTHING IS READY. It used to require at least one book, so on a
   * first paper day it was false forever beside a perfectly healthy feed —
   * and this is the field the deployment smoke test polls.
   */
  ready: boolean
  /**
   * WHICH RAIL THE BOOK COUNTS DESCRIBE.
   *
   * The endpoint hardcodes paper (`routes/health.ts` calls
   * `service.books('paper')`), so this is absent on the wire and the page
   * defaults to paper. Typed as optional rather than assumed, because the page
   * states the rail beside the counts and a hardcoded word there would silently
   * become a lie the moment the server starts answering for the mode you are
   * looking at. Reading it from the response keeps the label and the data the
   * same fact.
   */
  mode?: DeskMode
  /**
   * Was the market OPEN when the bridge answered — presentation only.
   *
   * `feedAlive` and `ready` are untouched by it, deliberately: `ready` is the
   * deployment smoke test and must stay the measured answer. This exists so the
   * page can tell a shut market from a broken feed, which look identical from
   * the tick counters alone and used to render identically, in red.
   *
   * ABSENT ON AN OLDER BRIDGE, and absent must keep today's loud behaviour. A
   * silence we cannot explain is still a silence worth shouting about.
   */
  sessionOpen?: boolean
}

/**
 * One process this desk is made of, judged by the ARTIFACT IT WRITES.
 *
 * The server's reasoning is in `apps/api/src/routes/system.ts` and the page must
 * not undo it: `state` is already the whole verdict, derived from `ageMs`
 * against a threshold that is several missed writes wide. NO ARITHMETIC HERE.
 * A browser re-deriving "stale" from `ageMs` and its own clock would disagree
 * with the server's answer on any machine whose clock is off, which is the one
 * disagreement a status page cannot afford.
 */
export interface SystemComponent {
  /** Stable key — the pm2 process name where there is one. */
  id: string
  name: string
  /**
   * `unknown` IS NOT A FAILURE. It is the honest answer for a component that
   * leaves no artifact to read — a gateway in simulate mode, a rail with no
   * books — and it is rendered grey and neutral, never amber.
   *
   * `attention` AND `stale` ARE DIFFERENT FACTS AND MUST STAY DIFFERENT WORDS.
   * `stale` means the artifact stopped arriving; `attention` means it arrived
   * on time and what it says needs a human — a positions comparison that ran
   * thirty seconds ago and found seventeen contracts disagreeing. Rendering the
   * second as the first would claim a healthy job had died, and folding it into
   * `ok` is what put `17 DIVERGENT` under a green pill on 2026-08-15.
   */
  state: 'ok' | 'stale' | 'attention' | 'unknown'
  detail: string
  lastSeenMs: number | null
  ageMs: number | null
  /**
   * How often the artifact is supposed to be rewritten. Null when there is no
   * cadence. It is what lets "4s ago" be read as fine rather than as three
   * missed polls, so the page prints it beside the age rather than dropping it.
   */
  expectedEveryMs: number | null
  extra?: Record<string, unknown>
}

export interface SystemReport {
  generatedAt: number
  components: SystemComponent[]
}

/**
 * ONE RECORDED MUTATION — who did what, to which book, and when.
 *
 * The server's collection is append-only and the endpoint is operator-only
 * (`apps/api/src/audit.ts`); this is the read model for the Status page's
 * "Recent operator actions" list, which exists to answer the question the desk
 * could not answer at all until roadmap 17: "who stopped BHEL yesterday?"
 *
 * `principalKind` is what separates 'the DESK did this' from 'a person did
 * this' — the day guard writes its automatic stops here under `'system'`, and
 * an entry that read as an operator's own act would be actively misleading.
 *
 * `detail` IS NOT RENDERED IN FULL and must not be: it is a small before/after
 * summary, its shape differs per action, and the server redacts credentials out
 * of it on the way in. The list shows the four fields every entry has.
 */
export interface AuditEntry {
  at: number
  /** The AUTHENTICATED principal's name, never one a request body claimed. */
  principal: string
  principalKind?: 'user' | 'machine' | 'system'
  /** The route path, or `'day-guard'` for the automatic stop loop. */
  source: string
  action: string
  tag?: string
  mode?: DeskMode
  detail?: Record<string, unknown>
}

export interface BookDiff {
  matched: DiffEntry[]
  mismatched: DiffEntry[]
  deskOnly: DiffEntry[]
  bridgeOnly: DiffEntry[]
  inSync: boolean
  declaredAt: number | null
}

export interface DiffEntry {
  strike: number
  type: string
  deskQty: number
  bridgeQty: number
}

/** One contract that actually traded. */
export interface Fill {
  op: 'open' | 'close' | 'roll' | 'resize'
  deskTag: string
  tradingsymbol: string
  side: 'Buy' | 'Sell'
  qty: number
  price: number
  orderType?: 'MARKET' | 'LIMIT'
  limitPrice?: number
  ts: number
}

/**
 * A leg the bridge did NOT act on, with the server's own reason.
 *
 * `action.ts` is the desk's leg tag, which is the only name a skip carries —
 * there is no tradingsymbol, because the action never got as far as resolving
 * one. Rendered as the tag rather than dropped: "3 legs were skipped" without
 * saying which is not something an operator can act on.
 */
export interface DecisionSkip {
  action: { op: string; ts: string }
  reason: string
}

/**
 * What close-all actually returns: a whole `DecisionResponse`, plus the legs
 * that had no mark to price against.
 *
 * TYPED IN FULL BECAUSE THE MISSING FIELDS WERE THE FAILURE. Declaring only
 * `{ fills, unpriceable }` dropped `skips`, `routeErrors` and `status` before
 * the page could see them, so a close-all where three legs were skipped and two
 * failed to route rendered as "1 fills" — a success line for a book that is
 * still open. The client type is where that evidence was being lost.
 */
export interface CloseAllResult {
  decisionId: string
  /** True when this decisionId had already run: NOTHING new was sent. */
  replayed: boolean
  status: 'ROUTING' | 'DONE' | 'FAILED'
  fills: Fill[]
  skips: DecisionSkip[]
  /** Routing failures, per fill. Distinct from `skips`, which never reached a rail. */
  routeErrors: { fill: Fill; error: string }[]
  /** The book AFTER the attempt. Empty is the only shape that means "flat". */
  book: BridgeLeg[]
  /** Legs sent as MARKET because nothing could price them. */
  unpriceable: string[]
}

/** Did a close-all leave anything unaccounted for? `fills` alone cannot say. */
export function closeAllFailed(r: CloseAllResult): boolean {
  return r.status === 'FAILED' || r.skips.length > 0 || r.routeErrors.length > 0 ||
    r.book.length > 0
}

/** What happened to one open contract during a flatten-by-tag. */
export interface FlattenLeg {
  tradingsymbol: string
  positionQty: number
  side: 'Buy' | 'Sell'
  qty: number
  orderType: 'MARKET' | 'LIMIT'
  limitPrice?: number
  routed: boolean
  error: string
  degraded: string
}

export interface FlattenResult {
  tag: string
  mode: DeskMode
  legs: FlattenLeg[]
  fills: unknown[]
  unpriceable: string[]
  /** Contracts with no instrument to route on. */
  unresolved: string[]
  /**
   * Contracts DELIBERATELY not flattened — the reconstruction looked truncated.
   * Acting on one could open exposure rather than close it, so the server holds
   * it back. Must be surfaced: it is the case where nothing happened on purpose.
   */
  truncated: string[]
  malformedFills: string[]
  /** The ONLY field that means "there is nothing left open". */
  flat: boolean
  /**
   * The fill window held nothing, so the position was rebuilt from nothing and
   * `flat` is false for that reason alone — the book may well still be open.
   * The retry that answers the question is a wider `sinceMs`, not the same one.
   */
  emptyWindow?: boolean
}

export class ApiError extends Error {
  status: number
  /**
   * The server refused because it wants the operator's password again
   * (403 + `reauthRequired`). Callers re-open the prompt rather than showing
   * this as a plain failure — the action is still available, it just has to be
   * confirmed by someone who knows the password.
   */
  reauthRequired: boolean
  /**
   * `close-all`'s 409 when a symbol maps to zero or several books: the tags it
   * could have meant (empty for the zero case). Undefined for every other
   * failure — a caller must not read `[]` as "the ambiguous case with no
   * candidates" when it really means "this wasn't that kind of failure at all".
   */
  candidates?: string[]
  constructor(status: number, message: string, reauthRequired = false, candidates?: string[]) {
    super(message)
    this.status = status
    this.reauthRequired = reauthRequired
    if (candidates !== undefined) this.candidates = candidates
  }
}

/**
 * A server refusal, said in the operator's terms. THE ONLY COPY.
 *
 * A 409 is the concurrency guard: someone changed this row between our read and
 * our write. Reloading is the honest instruction — silently re-applying is how
 * two harmless-looking edits combine into a live enable nobody confirmed. And
 * "Nothing was applied" is not padding: the sentence a refusal is read under
 * decides whether the operator goes looking for a half-done change.
 *
 * IT LIVES BESIDE `ApiError` BECAUSE EVERY PAGE NEEDS IT. Three pages had grown
 * their own, and the three had already drifted — one had dropped "Nothing was
 * applied", one had no 409 branch at all and told an operator only that the row
 * had moved. A refusal must read the same whichever page provoked it.
 */
export function explain(err: unknown): string {
  if (err instanceof ApiError && err.status === 409) {
    return `${err.message}. Nothing was applied. Reload and look at the current state ` +
      'before trying again.'
  }
  return err instanceof Error ? err.message : String(err)
}

/**
 * The API base, DERIVED FROM THE PAGE'S OWN HOSTNAME by default.
 *
 * This is not a convenience — it is what makes the session cookie work.
 *
 * `localhost` and `127.0.0.1` resolve to the same machine but are DIFFERENT
 * HOSTS, and therefore different SITES. A `SameSite=Strict` cookie set by
 * `127.0.0.1:8890` is never sent from a page served at `localhost:5184`. The
 * failure is silent and looks nothing like its cause: login succeeds, the
 * cookie is stored, the very next request arrives anonymous, and the app bounces
 * straight back to the login page as though the password were wrong.
 *
 * Ports do not affect same-site, so :5184 talking to :8890 on the SAME hostname
 * is fine. Matching the hostname is the whole requirement.
 *
 * An explicit `VITE_DESK_API` still wins, for pointing at a remote bridge — but
 * whoever sets it has to keep the hostname aligned with wherever the dashboard
 * is served, or the cookie silently stops being sent.
 */
const BASE =
  import.meta.env['VITE_DESK_API'] ??
  `${window.location.protocol}//${window.location.hostname}:8890`

/**
 * The same base, for the websocket in `stream.tsx`.
 *
 * EXPORTED RATHER THAN RECOMPUTED THERE. The hostname rule above is the whole
 * reason the session cookie is sent at all, and a second copy of it is a second
 * place for `localhost` vs `127.0.0.1` to diverge — which is the failure that
 * looks like a wrong password.
 */
export const API_BASE = BASE

// ------------------------------------------------------------------ session

/**
 * THIS CLIENT HOLDS NO TOKEN. There is no variable here to hold one, and that
 * is the design rather than an omission.
 *
 * The session is an httpOnly `SameSite=Strict` cookie: the browser attaches it,
 * no script on the page can read it, and a reload keeps you signed in. A copy
 * kept in a module variable would be readable by anything that ends up on the
 * page and could move real money.
 *
 * The build-time `VITE_DESK_TOKEN` bearer that used to live here is GONE. It
 * compiled a credential that bypasses the operator login into the browser
 * bundle, and it could never sign anyone in anyway — the gate accepted it as a
 * `machine` principal, which `AuthProvider` refuses outright, so all it ever
 * produced was a dashboard that looked signed in and failed every live switch
 * with "this session cannot confirm it".
 */
let onUnauthorized: (() => void) | null = null

/** Called when any request comes back 401, so the gate can drop to login. */
export function setUnauthorizedHandler(fn: (() => void) | null): void {
  onUnauthorized = fn
}

/**
 * The hard deadline on a READ, in milliseconds.
 *
 * Long enough that a warming feed or a slow greeks recompute answers inside it,
 * short enough that an operator reading a stale screen learns it is stale while
 * the decision still matters. Exported so a test can hold the client to it.
 */
export const REQUEST_TIMEOUT_MS = 8_000

/**
 * The hard deadline on a WRITE. Much longer, and the asymmetry is the point.
 *
 * A read that gives up early costs a stale screen and a retry. A WRITE that
 * gives up early costs a second set of real orders: `close-all` over a big book
 * routes leg by leg and can take well past 8s server-side, the abort re-enables
 * the button, and the retry mints a FRESH `decisionId` — which is a new
 * decision, so the idempotency lock that exists precisely to stop double-selling
 * never sees it. The desk ends up reversing a position it had already reversed.
 *
 * Giving a mutation 30s does not make that impossible; it makes it rare, and
 * the message below is what covers the rest.
 */
export const MUTATION_TIMEOUT_MS = 30_000

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const hasBody = body !== undefined
  // GET is the only method that changes nothing, so it is the only one that may
  // be abandoned cheaply.
  const isRead = method === 'GET'
  const timeoutMs = isRead ? REQUEST_TIMEOUT_MS : MUTATION_TIMEOUT_MS
  /**
   * THE WHOLE EXCHANGE IS INSIDE THIS TRY, fetch AND body, and that is the fix
   * rather than a tidy-up.
   *
   * `fetch` resolves when the HEADERS arrive; `res.json()` reads the rest of
   * the stream under the very same signal, with the deadline still running. So
   * a response that starts and then stalls aborts inside `json()` — which used
   * to sit outside the try, so that abort escaped as a raw DOMException, and
   * `explain` (which only knows how to read an ApiError) rendered "signal timed
   * out" to an operator. The one failure the deadline exists to name arrived
   * unnamed.
   */
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      /**
       * A HUNG CONNECTION NEVER REJECTS ON ITS OWN. A wedged bridge or a dropped
       * NAT mapping leaves the socket open forever, so without a deadline the
       * catch below never runs, `usePoll` never sets its error, and the
       * dashboard renders last-good numbers forever while claiming to refresh —
       * the exact failure the stale-notice machinery exists to surface.
       */
      signal: AbortSignal.timeout(timeoutMs),
      /**
       * REQUIRED, and the whole reason a refresh no longer signs you out.
       *
       * The session is an httpOnly `SameSite=Strict` cookie the browser attaches
       * on its own. Without `credentials: 'include'` a cross-origin fetch —
       * which every call is in dev, :5184 talking to :8890 — sends no cookie at
       * all, so the API sees an anonymous request and answers 401. The symptom
       * is indistinguishable from an expired session, which is what makes it
       * worth a comment rather than a one-word option.
       */
      credentials: 'include',
      headers: hasBody ? { 'content-type': 'application/json' } : {},
      ...(hasBody ? { body: JSON.stringify(body) } : {}),
    })
    if (!res.ok) {
      const b = (await res.json().catch(() => ({}))) as {
        error?: string; reauthRequired?: boolean; candidates?: unknown
      }
      // A 401 anywhere means the session died mid-session — expiry, a restart, a
      // revoked token. The login route is excluded because a rejected LOGIN is
      // the expected answer to a wrong password, not a session that just ended.
      if (res.status === 401 && path !== '/v1/auth/login') onUnauthorized?.()
      const candidates = Array.isArray(b.candidates)
        ? b.candidates.filter((x): x is string => typeof x === 'string')
        : undefined
      // Thrown from INSIDE the try, and the catch lets it straight back out: an
      // ApiError is not a DOMException, so a 409 can never be relabelled as a
      // timeout on its way past.
      throw new ApiError(res.status, b.error ?? res.statusText, b.reauthRequired === true, candidates)
    }
    return (await res.json()) as T
  } catch (err) {
    // The abort arrives as a DOMException whose message is "signal timed out" —
    // true, and useless to whoever is looking at the screen. Every page renders
    // failures through `explain`, which reads an ApiError, so the deadline has
    // to speak the same language as a refusal. Status 0: nothing answered, so
    // there is no status to report.
    if (err instanceof DOMException && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      /**
       * TWO DIFFERENT FACTS, so two different sentences.
       *
       * A read that timed out did nothing, and saying "the desk API is not
       * answering" is the whole truth. A WRITE that timed out may have been
       * accepted, executed and completed — the client simply stopped listening.
       * Telling an operator the same "not answering" there invites the retry
       * that places the orders a second time, so this says what the client
       * genuinely does not know and names the check that resolves it.
       */
      throw new ApiError(
        0,
        isRead
          ? `no response after ${timeoutMs / 1000}s — the desk API is not answering`
          : `no response after ${timeoutMs / 1000}s — the request may STILL BE EXECUTING ` +
            'on the desk; verify the book before retrying',
        false,
      )
    }
    throw err
  }
}

async function get<T>(path: string): Promise<T> {
  return request<T>('GET', path)
}

export interface OrderEvent {
  clientOrderId: string
  phase: string
  ok: boolean
  tag: string
  tradingsymbol: string
  ts: number
  error?: string
  /**
   * A caveat on an OK event (gateway `OrderEvent.warning`). A note, never a
   * failure: the order went out, with something the operator should know —
   * "no freeze limit for SENSEX, sending 9 lots as ONE order". It used to
   * arrive as a second `ok: false` row and painted every such order REJECTED.
   */
  warning?: string
  brokerOrderId?: string
  status?: string
  filledQty?: number
  avgPrice?: number | null
  /** 'BUY' / 'SELL'. Carried by a paper fill; absent on a routing event. */
  side?: string
  /**
   * The order's own INTENT, stamped on the read from the desk order document
   * (`withOrderContext` in the bridge) — what was ASKED, never what filled.
   * A routing event (PLANNED/SUBMITTED) journals no fill, so without these
   * the "every step" dialog read every such row as an order for nothing.
   * Absent on paper fills (they carry their own figures) and on any order
   * whose document the join could not find.
   */
  limitPrice?: number
  /** Contract quantity the desk order asked for (lots x lot size). */
  orderQty?: number
  /**
   * WHY the order went out: the supervisor's `trigger` (`dl-open`, `eod`…) and
   * its `reason` sentence, stamped on the read from the decision journal
   * (`withDecisionContext` in the bridge). Only the reports order log asks for
   * them; absent on any order no supervisor decision placed.
   */
  trigger?: string
  reason?: string
  detail?: Record<string, unknown>
}

export interface KillSwitch {
  enabled: boolean
  reason: string
  setBy: string
  setAt: number
}

/**
 * The broker link — the operator's "turn XTS off" switch.
 *
 * TWO HALVES IN ONE DOCUMENT. `desired`/`reason`/`setBy`/`setAt` are the WISH
 * this dashboard writes; `applied`/`appliedAt`/`appliedError` are the order
 * gateway's ACK, written when it has actually logged out (or back in). Right
 * after a release the two disagree for a couple of seconds, and the page must
 * show that honestly rather than claim the session is gone.
 */
export interface BrokerLink {
  desired: 'connected' | 'released'
  reason: string
  setBy: string
  setAt: number
  /** Null until the gateway has ever answered. */
  applied: 'connected' | 'released' | null
  appliedAt: number
  /** Why the ack is not clean — a failed logout, a failed reconnect login. */
  appliedError: string
}

async function post<T>(path: string, body: unknown): Promise<T> {
  return request<T>('POST', path, body)
}

// ------------------------------------------------------------------- auth

export interface Session {
  username: string
  kind: 'user' | 'machine'
  /** Null for a machine principal — an env bearer does not expire. */
  expiresAt: number | null
}

/**
 * NO TOKEN. The session comes back as an httpOnly cookie the browser stores and
 * attaches itself.
 *
 * If the server also returned the token here, the page would keep a copy in a
 * variable and any script that can read that variable would have the session —
 * which is exactly the exposure `httpOnly` exists to remove. Nothing in this
 * client ever sees the session value, and that is the point rather than an
 * inconvenience to work around.
 */
export interface LoginResult {
  username: string
  expiresAt: number
}

// ---------------------------------------------------------------- brokers

export type BrokerKind = 'xts' | 'zerodha'

/**
 * `unreadable` is NOT `absent`. "No XTS configured" and "XTS configured but the
 * ciphertext will not open" need different responses from the operator: the
 * first is a setup step, the second means the master key changed and re-typing
 * the credential is the only fix.
 */
export type BrokerState = 'absent' | 'ok' | 'error' | 'unreadable'

/**
 * The broker's own order book and positions, as the gateway last read them.
 *
 * ROWS ARE `Record<string, unknown>`, DELIBERATELY. XTS field names vary by
 * endpoint and by whether the account is investor or dealer, and inventing a
 * desk-side shape here would mean silently dropping any column the mapping did
 * not anticipate — on the one screen whose entire purpose is showing what the
 * broker actually says. The page renders whatever keys arrive.
 *
 * `available: false` is the normal simulate-mode answer, not an error.
 */
export interface BrokerView {
  readonly available: boolean
  readonly reason?: string
  readonly asOf?: number
  readonly ageMs?: number
  readonly stale?: boolean
  readonly ok?: boolean
  readonly error?: string
  readonly orders?: Record<string, unknown>[]
  readonly positions?: Record<string, unknown>[]
  /** What EXECUTED, as distinct from what was ordered. */
  readonly trades?: Record<string, unknown>[]
  /**
   * Present only when a list came back empty, saying WHICH KIND of empty:
   * `array(0)` means the broker answered with a real empty list, anything else
   * means the reply could not be read as one. Both render as an empty table.
   */
  readonly emptyDiagnostic?: { orders?: string; positions?: string; trades?: string }
  /**
   * WHICH FAMILY the failure belongs to, as the gateway classified it when it
   * failed: a dead session, a broker-side hiccup, or a real refusal.
   *
   * With `sessionOpenAtSnapshot` it is what lets the page tell an expired token
   * over a weekend — nothing was being ordered, nothing is wrong — from an
   * expired token at 11:00 on a Tuesday, which means live orders are failing
   * right now and must stay as loud as it has always been.
   *
   * ABSENT FROM AN OLDER GATEWAY, and absent must read as "unexplained", which
   * is the loud case. Every quietening here is conditioned on the field being
   * PRESENT and saying so.
   */
  readonly errorClass?: 'session' | 'transient' | 'fatal'
  /**
   * Was the market open AT `asOf` — the moment of the snapshot, not of this
   * render. A failure that happened mid-session stays a mid-session failure
   * however long it sits unread.
   */
  readonly sessionOpenAtSnapshot?: boolean
}

/**
 * MARGIN AT THE ACCOUNT, never per book — and the label on screen has to keep
 * saying so.
 *
 * There is no per-book margin anywhere in this system, and the reason is not an
 * omission: SPAN + exposure is computed by the exchange over the whole account
 * and is NOT additive across books, so two books that hedge each other consume
 * less together than either does alone. Splitting one account figure across the
 * open books would produce a number no broker statement agrees with, on the one
 * screen an operator sizes the next trade from.
 *
 * `available: false` IS THE NORMAL ANSWER TODAY, and it is a 200. The gateway
 * publishes an order book, positions and trades but not the account's balance,
 * so `reason` is what the tile renders instead of a figure. A dash with a reason
 * is the honest shape; a computed guess would not be.
 */
export interface BrokerFunds {
  readonly available: boolean
  readonly reason?: string
  readonly asOf?: number
  readonly ageMs?: number
  readonly stale?: boolean
  readonly ok?: boolean
  /** Margin blocked by open positions and resting orders, in rupees. */
  readonly utilised?: number | null
  /** Margin still free, in rupees. */
  readonly availableMargin?: number | null
  /** `utilised / (utilised + available)`, 0..1. Null unless BOTH halves arrived. */
  readonly utilisation?: number | null
  /** Whatever the broker actually sent, for when the two figures above are null. */
  readonly funds?: Record<string, unknown>
}

/**
 * What THIS book costs to hold, standalone, with hedge benefit — the companion
 * to `BrokerFunds` and the answer to the question it cannot answer.
 *
 * NOT A SHARE OF THE ACCOUNT FIGURE. SPAN scans the whole portfolio at once, so
 * per-book standalone figures do not sum to account utilisation. Two books that
 * hedge each other cost less together than either alone.
 */
export interface BookMargin {
  readonly available: boolean
  readonly reason?: string
  readonly asOf?: number
  readonly ageMs?: number
  readonly stale?: boolean
  /** False when the LAST refresh failed — the figures are the last good ones. */
  readonly ok?: boolean
  readonly source?: string
  /**
   * WHAT THE BROKER ACTUALLY CHARGES: broker-rate span + exposure + premium
   * paid. This is the headline. `total` below is Zerodha's narrower "Total
   * margin" and is kept only for the derivation on the hover.
   */
  readonly brokerTotal?: number
  readonly brokerSpan?: number
  readonly brokerExposure?: number
  /** False when no XTS ratio could be derived — figures are at Zerodha rates. */
  readonly calibrated?: boolean
  readonly spanRatio?: number
  readonly exposureRatio?: number
  /** Long-leg premium debit. The broker blocks it; Zerodha's calculator omits it. */
  readonly premiumPaid?: number
  readonly span?: number
  readonly exposure?: number
  /** Net premium received, positive when the book is a net credit. */
  readonly premium?: number
  /** `span + exposure` — what Kite's calculator prints as "Total margin". */
  readonly total?: number
  readonly legs?: readonly { tradingsymbol: string; span: number; exposure: number; total: number }[]
  readonly diagnostic?: string
}

export interface BrokerRow {
  kind: BrokerKind
  label: string
  /** Non-sensitive values only (base URL, user id). Never a credential. */
  meta: Record<string, unknown>
  configured: boolean
  state: BrokerState
  lastVerifiedAt: number | null
  lastError: string | null
}

/** A failed broker LOGIN is a 200 with `ok: false` — the request itself worked. */
export interface BrokerTestResult {
  ok: boolean
  verifiedAt?: number
  error?: string
  /**
   * The server's qualification of what a success actually proves. MUST be
   * rendered.
   *
   * The Zerodha test reuses a live session from the shared cookie jar when one
   * exists, so a pass can mean "this account is reachable" rather than "this
   * password is correct". The backend writes that distinction out deliberately;
   * dropping it here turns a careful statement into the flat overclaim it was
   * written to avoid.
   */
  note?: string
}

export interface BrokerSave {
  label?: string
  meta?: Record<string, unknown>
  /** Omitted or `{}` leaves the stored credential untouched. */
  secret?: Record<string, string>
}

// ------------------------------------------------------------- strategies

export type RuntimeState = 'stopped' | 'waiting' | 'running' | 'squared-off' | 'failed'

export interface StrategyRuntime {
  state: RuntimeState
  startedAt: number | null
  lastError: string | null
  openPositions: number
  /**
   * Nothing has rewritten this state for 90s — so it is the LAST thing that was
   * true, not what is true now.
   *
   * Computed server-side rather than sent as a timestamp: the runner rewrites
   * these documents about once a second, and a raw `updatedAt` on the wire would
   * make every 8s poll look like a change. It matters because nothing removes a
   * dead runner's last documents, so `running` sat on this page indefinitely
   * after the process that published it was gone.
   */
  stale: boolean
}

/** Membership of one mode. Present means ADDED to that mode's table. */
export interface ModeMembership {
  enabled: boolean
}

/**
 * The switch: per mode, and THREE STATES, not two.
 *
 *   key absent           — not added to that mode. Invisible on its table.
 *   key present, off     — added, listed, not trading.
 *   key present, enabled — trading.
 *
 * A single boolean cannot express this, and the failure is concrete: the table
 * lists only what is added, so with one flag switching a strategy off would
 * remove it from the very table its switch lives in. Pausing for an afternoon
 * would mean deleting the row and recreating it — losing its live lots and
 * autostart on the way.
 *
 * This replaces the old `enabled` + `mode` pair outright rather than aliasing
 * it. Two fields that can disagree about whether live trading is on is exactly
 * the state a gate must never arbitrate.
 */
export interface StrategyModes {
  paper?: ModeMembership
  live?: ModeMembership
}

/** On this mode's table at all? Membership, not permission. */
export function isAdded(modes: StrategyModes, mode: DeskMode): boolean {
  return modes[mode] !== undefined
}

/**
 * THE PERMISSION: added AND switched on. `?.enabled === true`, so "not added"
 * and "added but off" both answer false and neither can be reached by a truthy
 * value out of a hand-edited document.
 */
export function isOn(modes: StrategyModes, mode: DeskMode): boolean {
  return modes[mode]?.enabled === true
}

/**
 * THE DAY GUARD'S TWO LINES, in rupees, BOTH POSITIVE.
 *
 * `stop: 3000` means "stop this strategy for the day at minus three thousand".
 * The sign is not the operator's to choose, because a signed field is a control
 * that can be armed backwards — a stop-loss that only fires on a profit — and
 * nothing on the page would look wrong. Absent means unarmed; there is no zero
 * that means "no limit".
 */
export interface DailyLimits {
  target?: number
  stop?: number
}

/**
 * Today's guard record for the rail being viewed. Present ONLY when the guard
 * has already stopped this rail today.
 *
 * It is why the switch beside it is off. Without it, a strategy the guard
 * stopped at 11:04 is indistinguishable from one an operator paused — and the
 * two want opposite responses.
 */
export interface DayGuardFired {
  fired: true
  trigger: 'target' | 'stop'
  pnlAtTrigger: number
  firedAt: number
  /** The figure came from realised alone, so it UNDERSTATES the move. */
  incomplete: boolean
}

export interface StrategyRow {
  tag: string
  kind: 'external' | 'hosted'
  label: string
  modes: StrategyModes
  liveLots: number
  /** Absent = the day guard is unarmed on this row. Applies to both rails. */
  dailyLimits?: DailyLimits
  /** Absent = the guard has not fired on this rail today. */
  dayGuard?: DayGuardFired
  /** IST 'HHmm', or '' for "starts with the process". Never null. */
  autostartAt: string
  /** Epoch ms, or 0 for "has never checked in". Never null. */
  lastSeenAt: number
  /**
   * Why a human switched this row off, when one recorded a reason. Null or
   * empty means nobody did — which is the normal state of a row nobody has
   * turned on, NOT something to render as text.
   */
  disabledReason: string | null
  updatedAt: number
  /** Absent for `external` rows: we do not supervise Python processes. */
  runtime?: StrategyRuntime
}

export interface StrategyPatch {
  /**
   * Partial: sending only `{ live: { enabled: true } }` leaves paper alone.
   *
   * A patch can only flip a switch on a mode the row has already been ADDED to
   * — the server answers 400 otherwise. Membership is created by the add modal
   * and removed by `removeStrategyMode`, never by a toggle.
   */
  modes?: { paper?: ModeMembership; live?: ModeMembership }
  liveLots?: number
  autostartAt?: string
  disabledReason?: string
  /**
   * The day guard's lines, replaced WHOLESALE. `null` disarms the guard.
   *
   * On a row that is switched on for LIVE the server gates this behind the
   * operator's password, exactly like arming live — widening or clearing a
   * stop-loss on a strategy trading real money is the removal of the control
   * that stops it, and it leaves no badge behind to notice.
   */
  dailyLimits?: DailyLimits | null
  /** Present only when re-authentication is required. */
  password?: string
}

/**
 * Add a strategy to ONE mode's table, creating its row if it is new.
 *
 * `mode` has no default for the same reason `/submit` has none: guessing paper
 * silently fails to add the live row the operator asked for, and guessing live
 * is catastrophic. The row always arrives switched OFF — adding a strategy and
 * permitting it to trade are separate acts, and a form that did both would make
 * a typo a live order.
 */
export interface StrategyCreate {
  tag: string
  kind: 'external' | 'hosted'
  mode: DeskMode
  label?: string
  autostartAt?: string
  liveLots?: number
}

/** A catalogue tag the runner can actually run and no row claims yet. */
export interface AvailableStrategy {
  tag: string
  label: string | null
  /** The runner catalogue only offers hosted tags; external rows are typed. */
  kind: 'hosted'
  autostartAt: string
}

/**
 * The contract names `GET /v1/desk/strategies/available` but does not pin its
 * body, and the add form is unusable if we guess wrong. So every plausible
 * shape is accepted and normalised here, in one place: a bare array, or an
 * object keyed `available` / `strategies` / `tags`, holding either plain tags
 * or `{ tag, label }` records.
 *
 * Anything unrecognised normalises to an EMPTY list, which the form renders as
 * "the catalogue could not be read" and refuses to create a hosted row from.
 * Inventing a tag from a shape we do not understand is how you register a
 * hosted strategy no implementation matches — a switch that looks armed and
 * runs nothing.
 */
function normaliseAvailable(body: unknown): AvailableStrategy[] {
  const raw = Array.isArray(body)
    ? body
    : ((): unknown[] => {
        const o = (body ?? {}) as Record<string, unknown>
        for (const key of ['available', 'strategies', 'tags']) {
          if (Array.isArray(o[key])) return o[key]
        }
        return []
      })()

  const out: AvailableStrategy[] = []
  for (const entry of raw) {
    if (typeof entry === 'string') {
      if (entry !== '') out.push({ tag: entry, label: null, kind: 'hosted', autostartAt: '' })
      continue
    }
    if (entry === null || typeof entry !== 'object') continue
    const rec = entry as Record<string, unknown>
    const tag = typeof rec['tag'] === 'string' ? rec['tag'] : null
    if (tag === null || tag === '') continue
    const label = typeof rec['label'] === 'string' && rec['label'] !== ''
      ? rec['label']
      : typeof rec['underlying'] === 'string' ? rec['underlying'] : null
    out.push({
      tag,
      label,
      kind: 'hosted',
      autostartAt: typeof rec['autostartAt'] === 'string' ? rec['autostartAt'] : '',
    })
  }
  return out
}

/** A row the bulk switch could NOT change, with the server's own reason. */
export interface BulkSkip {
  tag: string
  reason: string
}

/** A switched-off tag that still holds a position — see `BulkResult.stranded`. */
export interface StrandedTag {
  tag: string
  /** Null when the server said "it holds something" without saying how much. */
  openPositions: number | null
}

export interface BulkResult {
  changed: string[]
  unchanged: string[]
  skipped: BulkSkip[]
  /**
   * Rows switched OFF that still hold an open position.
   *
   * Switching a strategy off blocks its EXITS as well as its entries — that
   * asymmetry is deliberate — so a mass-off does not flatten anything, it
   * strands it. This list is the difference between "everything is stopped" and
   * "nothing is being managed", and the page shouts about it rather than
   * reporting a clean success.
   */
  stranded: StrandedTag[]
}

/**
 * `changed` / `unchanged` / `skipped` are pinned by the contract; the
 * open-position signal is not, so it is read from whichever of the plausible
 * keys carries it and normalised. An unreadable signal yields an EMPTY list and
 * the page says only what it knows — it never claims "nothing is stranded".
 */
function normaliseBulk(body: unknown): BulkResult {
  const o = (body ?? {}) as Record<string, unknown>
  const tags = (v: unknown): string[] =>
    (Array.isArray(v) ? v : []).filter((x): x is string => typeof x === 'string')

  const skipped: BulkSkip[] = (Array.isArray(o['skipped']) ? o['skipped'] : [])
    .map((e) => e as Record<string, unknown>)
    .filter((e) => typeof e?.['tag'] === 'string')
    .map((e) => ({
      tag: e['tag'] as string,
      reason: typeof e['reason'] === 'string' && e['reason'] !== '' ? e['reason'] : 'no reason given',
    }))

  // `strandedPositions` is what the server actually sends; the others are kept
  // because this list is the difference between "everything stopped" and
  // "nothing is being managed" and must not go quiet on a rename.
  const strandedRaw = ['strandedPositions', 'stranded', 'holdingPositions', 'openPositions']
    .map((k) => o[k])
    .find((v) => Array.isArray(v))
  const stranded: StrandedTag[] = (Array.isArray(strandedRaw) ? strandedRaw : [])
    .map((e): StrandedTag | null => {
      if (typeof e === 'string') return e === '' ? null : { tag: e, openPositions: null }
      const rec = (e ?? {}) as Record<string, unknown>
      const tag = typeof rec['tag'] === 'string' ? rec['tag'] : null
      if (tag === null || tag === '') return null
      const n = rec['openPositions'] ?? rec['openLegs']
      return { tag, openPositions: typeof n === 'number' ? n : null }
    })
    .filter((x): x is StrandedTag => x !== null)

  return {
    changed: tags(o['changed']),
    unchanged: tags(o['unchanged']),
    skipped,
    stranded,
  }
}

/**
 * A row whose `modes` did not arrive — an older bridge, a half-written
 * document — reads as ADDED TO NOTHING.
 *
 * Every unreadable field falls back to the safe value, and the safe value for
 * membership is absence: an unreadable row disappears from the table rather
 * than appearing there with a switch nobody can trust. A mode key that is
 * present but malformed keeps its membership and loses its permission, because
 * "it is on this page" and "it may trade" are different claims and only the
 * second one can move money.
 *
 * The old `enabled`/`mode` pair is deliberately NOT mapped forward here: the
 * server owns that migration, and a client that quietly reconstructs a live
 * switch from fields the contract has removed is a second source of truth about
 * whether real money can move.
 */
function normaliseModes(body: { strategies?: unknown }): { strategies: StrategyRow[] } {
  const rows = Array.isArray(body.strategies) ? body.strategies : []
  return {
    strategies: rows.map((r) => {
      const row = r as StrategyRow
      const raw = (row.modes ?? {}) as Record<string, unknown>
      const modes: StrategyModes = {}
      for (const m of ['paper', 'live'] as const) {
        const v = raw[m]
        if (v === undefined || v === null) continue
        modes[m] = { enabled: (v as ModeMembership).enabled === true }
      }
      return { ...row, modes }
    }),
  }
}

// -------------------------------------------------------------------- pnl

export interface PnlStrategy {
  tag: string
  label: string
  mode: DeskMode
  realised: number
  /** Null when any open leg could not be marked. NEVER coerce this to 0. */
  unrealised: number | null
  total: number | null
  /**
   * The BOOK-STATE figure, present only for tags with a desk book: open legs
   * against their stored entries plus realised-to-date — the same number the
   * book page shows. One P&L per stock book, everywhere (2026-08-18). Null
   * when any open leg is unpriced; ABSENT for hosted tags.
   */
  sinceEntry?: number | null
  openLegs: number
  /**
   * The legs `openLegs` counted, marked — THE positions source for a strategy.
   *
   * Read from here rather than from `/v1/desk/books` because `desk-books` is
   * only ever written by the Python desk's `declare`; a hosted strategy holds
   * its position internally and journals fills, so every hosted tag rendered
   * "No open legs under this tag" beside a P&L that had just counted six of
   * them. Same tick computes both, so the table and the count cannot disagree.
   */
  legs: PnlLeg[]
  /**
   * The bid/ask pair each marked leg is valued off, keyed by tradingsymbol.
   * Absent for a leg whose book could not answer — exactly the legs
   * `unpriced` names. `basis` says which side priced the mark; `asOf` is the
   * book frame's own time, so the table can say how old the book is.
   */
  quotes?: Record<string, LegQuote>
  /** The legs missing a mark, by tradingsymbol. Non-empty ⇒ partial. */
  unpriced: string[]
  complete: boolean
}

/** The pair behind a leg's mark. Same-frame bid and ask — never blended. */
export interface LegQuote {
  bid: number
  ask: number
  basis: 'bid' | 'ask' | 'mid' | 'snapshot'
  asOf: number
}

export interface PnlLeg {
  tradingsymbol: string
  /** SIGNED: negative is short. ZERO means a closed round trip. */
  qty: number
  avgCost: number
  /**
   * The EXIT side of the book — a long is valued at the bid, a short at the
   * ask (never LTP; see `LegQuote`). Null when the feed could not price it.
   * NEVER render this as 0.
   */
  mark: number | null
  unrealised: number | null
  realised: number
  /** `qty === buyQty - sellQty` always. Values are cash traded, not averages. */
  buyQty: number
  buyValue: number
  sellQty: number
  sellValue: number
  /** Realised + open. Null when open and unmarked — never render as 0. */
  mtm: number | null
}

export interface PnlResponse {
  mode: DeskMode
  strategies: PnlStrategy[]
  totals: { realised: number; unrealised: number | null; total: number | null; complete: boolean }
}

export interface PnlPoint {
  ts: number
  realised: number
  unrealised: number | null
  total: number | null
}

/**
 * Bucket an intraday P&L series so the line reads as a trend rather than as
 * noise. Pure, and exported for the tests.
 *
 * WHY. Snapshots are written every ~15 seconds, so a full session is ~1,500
 * points squeezed into a few hundred pixels. Every one of them is a real mark,
 * but the result is a band of vertical hair through which the actual shape of
 * the day — drawdown, recovery, where it turned — cannot be seen. The chart is
 * read to answer "how has this gone", and it was answering "here is everything
 * that happened, you work it out".
 *
 * MEAN WITHIN A BUCKET, and that is the smoothing. A P&L series is a LEVEL, so
 * the mean of a minute of marks is itself a P&L the book genuinely held at some
 * point in that minute — unlike, say, averaging a rate. Taking last-in-bucket
 * would decimate rather than smooth: it keeps every spike that happens to land
 * on a boundary and drops the ones that do not, which is noise with a different
 * shape rather than less of it.
 *
 * THE FINAL POINT IS NEVER AVERAGED. It is the number the MTM tile is showing,
 * and a chart whose right-hand end disagrees with the tile beside it is worse
 * than a jagged one — the operator has to work out which is lying. So the last
 * bucket is replaced by the true latest point.
 *
 * A NULL `total` BREAKS THE LINE, and must keep doing so. Null means the book
 * could not be marked, which is a hole in the record, and averaging across it
 * would draw a confident line through a period we know nothing about. A bucket
 * containing any null yields null.
 *
 * Under `minPoints` the series is returned UNCHANGED: a book opened ten minutes
 * ago has nothing to smooth, and bucketing it would leave three dots.
 */
export function smoothSeries(
  points: readonly PnlPoint[],
  bucketMs = 60_000,
  minPoints = 120,
): PnlPoint[] {
  if (points.length <= minPoints || bucketMs <= 0) return [...points]

  const out: PnlPoint[] = []
  let bucket: PnlPoint[] = []
  let key = Math.floor((points[0]?.ts ?? 0) / bucketMs)

  const flush = (): void => {
    if (bucket.length === 0) return
    const mean = (pick: (p: PnlPoint) => number | null): number | null => {
      let sum = 0
      for (const p of bucket) {
        const v = pick(p)
        // One unmarkable snapshot makes the whole bucket unknown — see above.
        if (v === null || !Number.isFinite(v)) return null
        sum += v
      }
      return Math.round((sum / bucket.length) * 100) / 100
    }
    out.push({
      // The bucket's LAST timestamp, so the x-axis never runs ahead of the
      // clock: a mid-bucket stamp would put the newest point in the future.
      ts: bucket[bucket.length - 1]?.ts ?? 0,
      realised: mean((p) => p.realised) ?? 0,
      unrealised: mean((p) => p.unrealised),
      total: mean((p) => p.total),
    })
    bucket = []
  }

  for (const p of points) {
    const k = Math.floor(p.ts / bucketMs)
    if (k !== key) {
      flush()
      key = k
    }
    bucket.push(p)
  }
  flush()

  // The true latest mark, verbatim — see above.
  const last = points[points.length - 1]
  if (last !== undefined && out.length > 0) out[out.length - 1] = last
  return out
}

export interface PnlSeries {
  tag: string
  mode: DeskMode
  points: PnlPoint[]
}

// ---------------------------------------------------------------- reports

export interface ReportRow extends Record<string, unknown> {
  /** The IST calendar day this row files under. */
  date: string
  tag: string
  mode: DeskMode
  realised: number
  total: number | null
  maxProfit: number | null
  maxLoss: number | null
  orderCount: number
  closingPositions: number
  writtenAt: number | null
  /**
   * `rollup` came from the day-end write; `computed` was rebuilt from fills
   * because the rollup was missing. Rendered differently on purpose — a
   * recomputed number must not pass itself off as one written at day end.
   *
   * ABSENT on the range endpoint, which reads only what was written: replaying
   * three months of fills on every page load is not a thing to do, so a day
   * with no rollup is simply not in the range rather than being repaired.
   */
  source?: 'rollup' | 'computed'
  /**
   * How the day's CLOSING mark was obtained.
   *
   * `marks` — priced at the close. `snapshot` — borrowed from the last fully
   * marked snapshot of the afternoon. `none` — could not be marked at all, and
   * `total` is null.
   *
   * A `rollup`-sourced row can still be `snapshot`, so `source` does not cover
   * this: "marked at the close" and "marked at the last good tick of the
   * afternoon" are different claims about the same rupee figure.
   */
  closingSource?: 'marks' | 'snapshot' | 'none'
  /** Snapshots the extremes were drawn from. 0 means both are null. */
  snapshots?: number
}

/*
 * `GET /v1/desk/reports?date=` and `/reports/dates` are NOT bound here.
 *
 * They served the whole-day desk summary, which the reports page replaced with
 * a per-strategy range. The endpoints still exist on the server; a typed client
 * method for a page that no longer exists is an invitation to rebuild it.
 */

/**
 * One strategy across a DATE RANGE — what the reports page is built on.
 *
 * Days with no stored rollup are ABSENT from `rows` rather than zero-filled,
 * and `missingDays` counts them. A gap where the process was down and a genuine
 * flat day must not draw the same line.
 */
export interface ReportHistory {
  tag: string
  mode: DeskMode
  from: string
  to: string
  rows: ReportRow[]
  /** `total` is null when ANY day in the range could not be marked. */
  totals: { realised: number; total: number | null; orderCount: number; days: number }
  missingDays: number
}

/**
 * One SERIES on one rail — the durable name a run of dated books reports under
 * (`NIFTY-delta-lean-aggressive` for every daily `NIFTY-delta-lean-aggressive-
 * YYYY-MM-DD` book). Mirrors `SeriesSummary` in `apps/api/src/book-series.ts`.
 */
export interface SeriesSummary {
  series: string
  symbol: string
  variant: string
  /** Every tag filed under it, oldest registration first. */
  tags: string[]
  /** tag -> that book's contract expiry. */
  expiries: Record<string, string>
  /** First/last day any of its tags reported; null when none has yet. */
  firstDate: string | null
  lastDate: string | null
}

/** `GET /v1/desk/reports/series`: the series, and the variants (strategies) across symbols. */
export interface ReportSeries {
  series: SeriesSummary[]
  variants: string[]
}

/** Which grouping a range is read for. Exactly one — the server refuses two. */
export type ReportGroup = { series: string } | { variant: string }

/**
 * One IST day of a series or a variant: its tags' rollups summed. `total` (and
 * the extremes) are null when ANY contributing tag's was — never a partial sum.
 */
export interface GroupDayRow {
  date: string
  mode: DeskMode
  realised: number
  total: number | null
  maxProfit: number | null
  maxLoss: number | null
  orderCount: number
  closingPositions: number
  closingSource: 'marks' | 'snapshot' | 'none'
  /** The tags that reported this day — each one's order log is a link. */
  tags: string[]
  /** A contributing book's contract expired on this day. */
  expiryDay: boolean
  expiryTags: string[]
  /**
   * The day split per symbol — on the VARIANT (combined) view only. A symbol
   * that did not report that day is absent, not zero. Each symbol's `total` is
   * null when any of its tags' was.
   */
  bySymbol?: Record<string, { realised: number; total: number | null; tags: string[] }>
}

/** `GET /v1/desk/reports/history?series=|variant=` — one row per day. */
export interface GroupHistory {
  series?: string
  variant?: string
  mode: DeskMode
  from: string
  to: string
  /** Every tag in the grouping, whether or not it reported in the range. */
  tags: string[]
  /** Every symbol in the grouping, sorted — the variant view only. */
  symbols?: string[]
  rows: GroupDayRow[]
  totals: { realised: number; total: number | null; orderCount: number; days: number }
  missingDays: number
}

export interface PruneDay {
  date: string
  snapshots: number
  action: string
  reason: string
}

export interface PruneResult {
  wouldDelete?: number
  deleted?: number
  /**
   * The retention window the server actually applied, in days.
   *
   * MUST BE RENDERED. The client sends no `keepDays`, so the number is the
   * server's own configuration and the operator has no other way to learn it —
   * without it, "Prune now" is a destructive button whose scope was never
   * stated on screen.
   */
  keepDays: number
  dryRun: boolean
  days: PruneDay[]
}

// -------------------------------------------------------- desk books registry

/**
 * The operator's ask, or the supervisor's report — never both meanings in one
 * field. Mirrors `BookState` in `apps/api/src/books-registry.ts`.
 */
export type BookState = 'stopped' | 'running'

/**
 * A dial's value. Mirrors `DialValue` in `apps/api/src/books-registry.ts`:
 * numbers AND booleans, because the playbooks these reach carry as many
 * boolean switches (`hedge_after_shift`, `no_buy`, `gamma_shorts_only`) as
 * numeric thresholds.
 */
export type DialValue = number | boolean

/**
 * One row of `desk-books-registry`: what a book IS (its variant, its dials,
 * the operator's intent), as opposed to `BookSummary`/`PositionsResponse`,
 * which describe what it currently HOLDS.
 *
 * `desired` and `actual` are SEPARATE FIELDS on purpose — see
 * `books-registry.ts`'s module comment. The gap between them, not either one
 * alone, is the fact this whole page exists to show.
 */
export interface BookRow {
  tag: string
  symbol: string
  expiry: string
  mode: DeskMode
  variant: string
  /**
   * The series this book reports under. Optional only because a desk that
   * predates WS2 does not send it — read it through `seriesOf`.
   */
  series?: string
  dials: Readonly<Record<string, DialValue>>
  desired: BookState
  actual: BookState
  /** Epoch ms of the supervisor's last mark, 0 when it has never reported. */
  lastMarkAt: number
  lastDecision: string
  createdAt: number
  updatedAt: number
}

/**
 * A book's series: the one the registry sent, or — from a desk that predates
 * the field — the same `${symbol}-${variant}` the API derives. Built from the
 * row's fields; the tag is never parsed.
 */
export function seriesOf(row: Pick<BookRow, 'symbol' | 'variant' | 'series'>): string {
  return row.series !== undefined && row.series !== '' ? row.series : `${row.symbol}-${row.variant}`
}

/** One decision that actually traded, as the registry's `actionLog` holds it. */
export interface DecisionActionRow {
  at: number
  decisionId: string
  action: string
  reason: string
  fills: readonly { deskTag: string; tradingsymbol: string; side: string; qty: number; price: number }[]
}

/**
 * The STRATEGY panel's payload — two different questions together.
 *
 * `lastReason` is the CURRENT state, rewritten every mark, and answers "why is
 * it doing nothing right now". `actions` is the history of decisions that
 * traded. A quiet book has a reason and an empty history, and that is its
 * healthy state rather than a missing one.
 *
 * Every field nullable: a book whose desk has not shipped the reason yet
 * reports nulls, and the panel must show "no reason recorded" rather than
 * treating it as broken.
 */
export interface BookDecisions {
  tag: string
  mode: DeskMode
  lastReason: string | null
  lastAction: string | null
  lastReasonAt: number | null
  /**
   * ABSENT, not empty, when the caller asked not to be sent it (`actions:
   * false`). An empty array is a real answer — a book that has never traded —
   * and a suppressed log must not be able to claim it.
   */
  actions?: readonly DecisionActionRow[]
}

/**
 * `POST /v1/desk/books/registry` body. `desired`/`actual` cannot be set here
 * — a book is ALWAYS created stopped; see `BookState` and `books-registry.ts`.
 */
export interface BookCreate {
  tag: string
  symbol: string
  expiry: string
  mode: DeskMode
  variant: string
  dials: Readonly<Record<string, DialValue>>
}

/** One leg of an already-open position, as `POST /v1/desk/seed` accepts it. */
export interface SeedLeg {
  strike: number
  type: 'CE' | 'PE'
  /** SIGNED contract quantity: negative is short. */
  qty: number
  /**
   * The price actually paid, per unit. NEVER zero — seeding at 0 silently
   * erases the position's cost basis. The create wizard used to catch this at
   * the form (`legError`); with the wizard deleted, the server-side rule in
   * `apps/api/src/validate.ts:validateSeedRequest` ("rate must be a positive
   * entry price") is the only one, which is where it always belonged.
   */
  rate: number
}

export interface SeedRequestBody {
  tag: string
  symbol: string
  expiry: string
  mode: DeskMode
  /** Refuses to overwrite a non-empty book unless set — see `apps/api/src/seed.ts`. */
  replace: boolean
  legs: readonly SeedLeg[]
  /**
   * REQUIRED BY THE SERVER when `mode` is live or `replace` is set, and refused
   * without it (403 + `reauthRequired`).
   *
   * A seed routes no orders, which is exactly why it is guarded: it is the one
   * call that can write a position into the desk out of nothing, or — with
   * `replace` — erase the record of one that really exists. See
   * `routes/desk.ts`. A paper seed with no replace still asks for nothing.
   */
  password?: string
}

export interface SeedResult {
  booked: BridgeLeg[]
  unresolved: { strike: number; type: string; reason: string }[]
}

/**
 * `GET /v1/desk/instruments/:underlying` — `apps/api/src/routes/desk.ts` answers this with
 * `OptionMaster.chain()`'s `ChainMeta` (`packages/instruments/src/master.ts`) spread with
 * `expiries`. This is static contract metadata ONLY — lot size, tick size, exchange and the
 * listed strike grid. There is no `spot`, `future` or per-strike quote here, and no `feedAlive`;
 * a live-quotes chain endpoint does not exist on this branch. A caller that needs quotes must
 * not read them off this type.
 */
export interface InstrumentsResponse {
  underlying: string
  expiry: string
  lotSize: number
  tickSize: number
  exchange: string
  /** Inferred from the listed strikes; null when fewer than 2 strikes list. */
  strikeStep: number | null
  strikes: readonly number[]
  expiries: readonly string[]
}

// ------------------------------------------------------------ payoff cockpit

/**
 * THE PAYOFF WIRE — mirrors of `apps/api/src/routes/payoff.ts` and the types it
 * re-serves from `@algomaker/payoff` (`PayoffView`, `ReliefTriggers`).
 *
 * WRITTEN OUT HERE RATHER THAN IMPORTED, like every other shape in this file.
 * The bridge's route module imports `node:crypto` and the whole payoff engine;
 * pulling its types across would drag that graph into the browser bundle, and
 * `@algomaker/payoff` is not a dependency of this app. The cost is the usual
 * one: a field renamed on the server is a field silently absent here, which is
 * why nothing below is read without a null check and why `inr`/`money` render a
 * dash for a value that is not a number.
 *
 * EVERY HALF IS INDEPENDENTLY NULLABLE because every half fails independently:
 * no future kills `view` and leaves `machine` intact, and a book with no
 * registry row is the reverse.
 */
export interface PayoffPoint {
  /** The underlying price this column is valued at. */
  readonly price: number
  /** Intrinsic payoff at expiry — no model, no vol. Realised INCLUDED. */
  readonly expiry: number
  /** Mark-to-market today. */
  readonly t0: number
  /** Mark-to-market halfway to expiry. */
  readonly mid: number
}

/** A price worth naming: `spot`, `BE 421.4`, `strike 470`, `+2%`. */
export interface PayoffRow extends PayoffPoint {
  readonly label: string
}

/** Null on a side is UNBOUNDED, not zero — the book never crosses there. */
export interface PayoffBreakevens {
  readonly down: number | null
  readonly up: number | null
}

export interface PayoffSummary {
  /**
   * Best and worst ON THE ±10% SCAN, never a bound on the position: a short
   * strangle's real downside is unbounded and `maxLossAt` sitting on the scan's
   * own edge is the normal case for short premium. The panel says so beside
   * them — see `payoff.tsx`.
   */
  readonly maxProfit: number
  readonly maxLoss: number
  readonly maxLossAt: number
  readonly breakevens: PayoffBreakevens
  /** Probability the OPEN LEGS finish green, 0–1 — NOT the run's. */
  readonly pop: number
  /** Premium the open legs collected at entry. Realised never touches it. */
  readonly netCredit: number
  /** Worst of ±5%/±10% TODAY, plus realised. */
  readonly worstShock: number
  /** The shocked price it happens at. Absent on a bridge one deploy behind. */
  readonly worstShockAt?: number
  /** The dense expiry curve's minimum — `maxLoss` under the chart's name. */
  readonly floor: number
  /** What has already been banked, echoed so a reader sees what was added. */
  readonly booked: number
  readonly targetPnl: number | null
}

/** Book greeks now, Black-76, per point of FUTURE. */
export interface PayoffGreeks {
  readonly delta: number
  readonly gamma: number
  readonly theta: number
  readonly vega: number
}

export interface PayoffView {
  /** The dense scan — 121 points across ±10% of the future. */
  readonly curve: readonly PayoffPoint[]
  readonly table: readonly PayoffRow[]
  /** ISO date halfway from today to expiry, which the `mid` curve is dated by. */
  readonly midDate: string
  readonly summary: PayoffSummary
  readonly greeks: PayoffGreeks
  /**
   * THE VIEW'S OWN CHANNEL, which the envelope does NOT fold in — see
   * `payoffOf` in the route. A panel reading only `PayoffResponse.warnings`
   * silently drops every per-leg "no IV" sentence.
   */
  readonly warnings: readonly string[]
}

/**
 * What the bot is about to do about this book, evaluated — `packages/payoff`'s
 * `reliefTriggers`. NULL IS UNKNOWN AND NEVER A ZERO on every field here: "the
 * margin gate is shut" and "I could not read the margin" are different
 * sentences to whoever is deciding whether to intervene.
 */
export interface ReliefTriggers {
  /** `delta_tol_pct` — a tolerance of MOVE, not of delta. */
  readonly deltaTolPct: number | null
  /** How far the book's zero-delta point sits from spot, as a fraction of it. */
  readonly deltaImbalance: number | null
  readonly wouldRebalance: boolean | null
  /** Is the shift's margin gate open? */
  readonly shiftEnabled: boolean | null
  readonly marginFrac: number | null
  readonly targetPnl: number | null
  /** Human sentences, each naming its own numbers. Rendered VERBATIM. */
  readonly notes: readonly string[]
}

export interface PayoffResponse {
  readonly tag: string
  readonly mode: DeskMode
  readonly symbol: string
  readonly expiry: string
  /** The Black-76 mark everything is priced off. Null and there is no view. */
  readonly future: number | null
  readonly spot: number | null
  readonly asOf: number
  readonly view: PayoffView | null
  readonly machine: ReliefTriggers | null
  readonly warnings: readonly string[]
  /**
   * Market closed — everything above is display marks, the last session's.
   * Optional because an older bridge omits it, and absent must read as "not
   * known to be closed", never as closed.
   */
  readonly marketClosed?: boolean
  /** Set ONLY when the tag names no book. Absent on every other answer. */
  readonly error?: string
  /*
    `ivs` — the whole chain's solved volatilities — IS ON THE WIRE and is
    deliberately not mirrored: nothing on this dashboard renders it, and a type
    that exists only to be ignored is a type nobody keeps true. The provenance
    that matters (a leg marked at an interpolated vol, or at none) already
    arrives as a named sentence in `warnings`, which the panel prints.
  */
}

// ------------------------------------------------- the what-if and the repair

/**
 * ONE PROPOSED CONTRACT, in SIGNED SHARES — negative to sell.
 *
 * The sign is the side and nothing else is: `routes/payoff.ts` turns a
 * proposal into `{op: qty < 0 ? 'add' : 'hedge'}` and `applyMoves` then reads
 * the sign again and never the word. A caller that sends lots here, or an
 * unsigned quantity with the side in a separate field, prices a long strangle
 * for an operator who asked about a short one.
 *
 * `price` is a FILL ASSUMPTION — "what if I get filled at 12" — and absent it
 * the chain's own mark is used. It is never a limit and never an order.
 */
export interface ProposedLeg {
  readonly strike: number
  readonly type: 'CE' | 'PE'
  readonly qty: number
  readonly price?: number
}

export interface WhatIfResponse {
  /**
   * The book AS IT STANDS. `null` when it could not be priced at all — which
   * is a state the panel must render as a dash: a before/after pair whose
   * "before" silently reads ₹0 claims a book that cannot lose money.
   */
  readonly current: PayoffSummary | null
  /**
   * THE SENTENCES ABOUT THIS REQUEST AND NOTHING ELSE — one per proposal the
   * bridge could not read plus one per move it refused, verbatim and UNDEDUPED
   * so the panel can count them against what it sent. This is the ONLY honest
   * way to tell the plan's own failures apart from book-level warnings: the
   * envelope's list folds both together, and a set-difference against the last
   * poll's envelope misattributes any book-level warning that appeared since
   * (a feed that died between the poll and the load) to the plan.
   */
  readonly dropped: readonly string[]
  /** The same envelope `GET /v1/desk/payoff` serves, over book + proposal. */
  readonly combined: PayoffResponse
  /** Reserved: today every sentence arrives on `combined.warnings`. */
  readonly warnings?: readonly string[]
}

/** The four searches, in the order the engine returns them. */
export type RepairGoal = 'REDUCE-LOSS' | 'PROFITABLE-BY-EXPIRY' | 'CHEAP-TAIL-CAP' | 'MAX-CREDIT-SAFE'

/**
 * ONE PROPOSED CHANGE. `add`/`hedge` open a new contract; `shift` re-strikes an
 * existing leg; `close` takes one off.
 *
 * THE OP IS A LABEL, THE SIGN IS THE SIDE — `add` and `hedge` are the
 * operator's two words for the same operation and the server treats them
 * identically. Reading the op as the side is what turns a long wing into a
 * short one on the screen.
 *
 * `shift` and `close` address a leg BY ID, which is why neither can become a
 * `ProposedLeg`: the what-if endpoint proposes contracts and cannot un-hold one
 * the book already carries. See `payoff.tsx` for what the panel does about it.
 */
export type RepairMove =
  | { readonly op: 'add' | 'hedge'; readonly strike: number; readonly type: 'CE' | 'PE'; readonly qty: number }
  | { readonly op: 'shift'; readonly legId: string; readonly toStrike: number }
  | { readonly op: 'close'; readonly legId: string }

/**
 * What a plan would do to the book. Which figures carry realised P&L is not
 * cosmetic and is settled in `packages/payoff/src/goals.ts`: `credit` and the
 * three margin figures are TRADE-level (realised excluded), everything else is
 * RUN-level (realised included), and `pop` is the OPEN LEGS' probability.
 */
export interface PlanScore {
  /** Cash this plan moves: premium in less premium out. Positive is cash in. */
  readonly credit: number
  /** Worst run P&L on the ±10% expiry ladder — the scan's edge, not a bound. */
  readonly maxLoss: number
  readonly maxLossAt: number
  readonly breakevens: readonly number[]
  readonly worstShock: number
  /** The shocked price it happens at. Absent on a bridge one deploy behind. */
  readonly worstShockAt?: number
  readonly marginBefore: number
  readonly marginAfter: number
  /** `after − before`. Positive means the plan costs capital. */
  readonly marginDelta: number
  /** Share of the ladder finishing at or above zero, 0–100 — ALREADY percent. */
  readonly profitableWidthPct: number
  readonly pop: number
}

export interface RepairPlan {
  readonly goal: RepairGoal
  /** In the order they would be placed. EMPTY on the do-nothing baseline. */
  readonly moves: readonly RepairMove[]
  readonly score: PlanScore
  /**
   * `baseline`, `no-feasible-plan`, `degrades-floor`, `bot-may-reshift`,
   * `bot-rebalance-pending` — in that order, so a rendered chip row does not
   * reshuffle itself.
   */
  readonly flags: readonly string[]
}

/**
 * ONLY `lotSize` IS MIRRORED, on the same rule as `PayoffResponse.ivs`: the
 * wire carries the whole `RepairDials` record and this dashboard renders one
 * field of it. `lotSize` is here because it is the number that turns the
 * what-if editor's LOTS into the signed shares the wire wants — and it is 0,
 * never a guess, when the instrument master does not know the contract.
 */
export interface RepairDials {
  readonly lotSize: number
}

export interface RepairResponse {
  readonly tag: string
  readonly mode: DeskMode
  readonly asOf: number
  readonly dials: RepairDials
  readonly goals: readonly { readonly goal: RepairGoal; readonly plans: readonly RepairPlan[] }[]
  /**
   * How big the search's alphabet was, so a menu that came back thin can be
   * told from one that came back thin BECAUSE the chain was.
   */
  readonly universe: { readonly atomic: number; readonly evaluated: number }
  /**
   * THE LEGS THESE PLANS ADDRESS, FINGERPRINTED.
   *
   * Every `shift` and `close` above names its leg by an id that is POSITIONAL,
   * and this menu is read for minutes: a book that loses one pocket of a
   * doubled contract in that window re-points `…CE#2` at a leg the card was
   * never about. Carry it into `repairPreflight`, which refuses every
   * legId-addressed move when it no longer matches the book it recomputes.
   *
   * NOT `bookPrint`. That one moves with every quote — right between a preview
   * and the orders it authorises, useless in front of a menu nobody could ever
   * click in time. This moves when the LEGS move and not otherwise.
   */
  readonly legsPrint: string
  readonly warnings: readonly string[]
  /** Set ONLY when the tag names no book. Absent on every other answer. */
  readonly error?: string
}

/**
 * WHAT THE BROKER WOULD HOLD — the same four fields the per-book margin tile
 * reads, through the same `brokerFigures` function.
 *
 * `total` is `span + exposure + premiumPaid` at the ACCOUNT'S CALIBRATED RATES,
 * not Zerodha's calculator headline (`span + exposure`): the broker blocks the
 * long legs' premium as margin too. Serving the calculator's figure would put a
 * smaller number here than the tile shows for the same book, on exactly the
 * books that hold a long leg — and a smaller margin reads as headroom.
 */
export interface BrokerMargin {
  readonly total: number
  readonly span: number
  readonly exposure: number
  /** Premium DEBITED for the long legs. Zero on an all-short book. */
  readonly premiumPaid: number
  /**
   * Whether the account's measured span/exposure multipliers were applied.
   *
   * FALSE MEANS ZERODHA'S OWN RATES, not "slightly less accurate": with no
   * usable broker snapshot the bridge's `brokerFigures` is the identity, so the
   * four figures above are the calculator's, in this account's shape. The panel
   * changes its sentence on it — claiming a calibration that was never applied
   * is the same class of defect as two "margin used" figures on one screen.
   *
   * OPTIONAL on the wire: a bridge that has not been redeployed sends the four
   * figures without it, and an absent flag must read as "not calibrated" rather
   * than as a silent yes.
   */
  readonly calibrated?: boolean
}

export interface VerifyMarginResponse {
  /** SPAN-lite over the combined book. ALWAYS present, even with no broker. */
  readonly estimated: number
  /** The broker's own figure, or null with a sentence saying why not. */
  readonly broker: BrokerMargin | null
  readonly warnings: readonly string[]
}

// ---------------------------------------------------- the repair Apply button

/**
 * ONE BROKER-BOUND ORDER a move expands into — the SERVER's expansion, never
 * this dashboard's. `/repair/apply` resolves the moves again on its own side,
 * so what is rendered from these is a PREVIEW of what would be placed and not
 * the thing that gets placed.
 *
 * `lots`, not units. The desk's order path counts lots and multiplies by
 * `instrument.lotSize` itself, so a screen that showed units beside a field the
 * server reads as lots is how a 25-lot repair goes out.
 */
export interface PlannedOrderWire {
  /** Closes execute before opens, and the grouping is part of the plan. */
  readonly wave: 'close' | 'open'
  /** Which sentence on the card this order came from. A shift's two share one. */
  readonly moveIndex: number
  readonly side: 'Buy' | 'Sell'
  readonly instrument: {
    readonly tradingsymbol: string
    readonly instrumentToken: number
    readonly lotSize: number
    readonly tickSize: number
    readonly exchange: string
  }
  readonly strike: number
  readonly type: 'CE' | 'PE'
  readonly expiry: string
  readonly lots: number
  /**
   * Does this order NET DOWN the contract's existing exposure, or add new? The
   * same rule the Manual Order dialog's `classifyExposure` applies, decided
   * server-side over the book as served — one word for one order on both
   * screens.
   */
  readonly reducesExposure: boolean
  /**
   * The desk leg a CLOSE takes off, by the Python driver's own id — served so
   * this mirror stays field-for-field with `repair-plan.ts:PlannedOrder`, and
   * rendered nowhere: it is bookkeeping between the bridge and the driver (the
   * fill is booked under it, which is what banks the repair's realized P&L).
   */
  readonly deskTag?: string
}

/**
 * WHAT THIS SIZE WOULD PAY, from walking the book — not what the last print
 * said. A two-lot order into a one-lot touch is priced at what the second lot
 * costs too.
 */
export interface FillEstimate {
  /**
   * Qty-weighted average across the levels walked. Null when none were — and
   * null WITH the rest of this object filled in when the quote is too stale to
   * price off, which is the bridge withdrawing the price and keeping the facts
   * that explain why there is none.
   */
  readonly price: number | null
  /** The whole visible side, consumed or not — how much room there was. */
  readonly coveredQty: number
  /** `coveredQty` is short of the size asked for. The rest fills behind it. */
  readonly exceedsDepth: boolean
  readonly quoteAgeMs: number | null
}

/**
 * A planned order with what the market says about it RIGHT NOW.
 *
 * `mark` is the chain's own price for the contract — already the MID when the
 * tick carried two sides — so the reference price in this modal is the same one
 * the greeks, the paper fills and the marketable-limit pricer all read.
 *
 * `est` is what this SIZE would pay, which is a different number and the one
 * that matters on an order screen. Null ONLY when the chain has no quote at all
 * for the contract; a quote with an empty book still answers, with a null
 * `price` and `exceedsDepth` set — "no depth on this tick" and "no market" are
 * not the same fact to a reader.
 */
export interface PricedOrder extends PlannedOrderWire {
  readonly mark: number | null
  readonly est: FillEstimate | null
}

/**
 * THE POSITIONS ENGINE'S FIGURES, not the cockpit's Black-76 ones. This panel
 * is read against the Positions tiles, and two models in one comparison is how
 * a hedge gets sized against a delta that no other screen agrees with.
 *
 * Null is "nothing here could be priced", never zero — the whole reason these
 * are nullable is that a flat book and an unpriceable one must not render the
 * same.
 */
export interface DeltaFigures {
  readonly netDelta: number | null
  readonly netGamma: number | null
  /** The underlying price at which this book is flat, and how far that is. */
  readonly neutral: { readonly price: number; readonly pct: number } | null
}

/** The whole book, and the set the recenter rules actually steer by. */
export interface DeltaPicture {
  readonly all: DeltaFigures
  readonly shortsOnly: DeltaFigures
}

/**
 * THE ONLY SCREEN BETWEEN A REPAIR CARD AND REAL ORDERS.
 *
 * Answered against the book AS IT STANDS NOW rather than against the snapshot
 * the card was searched on, which is the point of asking at all: `orders` is
 * what a broker would actually be sent, `dropped` is every move that could not
 * be crossed, `margin` is the verify run without anyone having to remember it,
 * and `delta` is the book now beside the book this plan would leave.
 *
 * FAIL-SOFT. Everything but a missing tag answers 200 and says what went wrong
 * in `warnings`, because this renders inside a modal beside a live position and
 * a failed fetch there is a blank panel at exactly the moment the operator
 * needs to read one.
 */
export interface RepairPreflightResponse {
  readonly tag: string
  readonly mode: DeskMode
  readonly asOf: number
  /**
   * The INPUTS this plan was priced against, fingerprinted — for the record and
   * for the snapshot archive. The server stamps it on the run.
   *
   * DO NOT SEND IT BACK AS A STALENESS CHECK. It hashes every live chain price,
   * the spot and the future, so it moves on the next tick of any strike on the
   * board: a guard keyed on it refuses the Confirm of anyone who paused to read
   * the modal. `legsPrint` is the one `repairApply` compares.
   */
  readonly bookPrint: string
  /**
   * THE LEGS THIS PLAN ADDRESSES, fingerprinted — the same value
   * `RepairResponse` serves beside the cards.
   *
   * CARRY THIS ONE INTO `repairApply`. It is what the operator actually
   * confirmed — which contracts, at what size, entered where — and it does not
   * move when a quote does. Serve-and-accept, so a modal that has preflighted
   * again can carry the FRESH value rather than the one the menu was drawn with.
   */
  readonly legsPrint: string
  readonly orders: readonly PricedOrder[]
  /**
   * Every move that could not be crossed, named. `repairApply` REFUSES a plan
   * carrying any of these outright — a repair is a shape, and executing the
   * half the bridge understood is how a book ends up naked on the other half —
   * so Confirm has to be disabled by it.
   */
  readonly dropped: readonly string[]
  readonly margin: VerifyMarginResponse
  readonly delta: { readonly current: DeltaPicture; readonly after: DeltaPicture }
  /** An apply is already running for this tag — the button stays held. */
  readonly holdActive: boolean
  readonly warnings: readonly string[]
}

/**
 * WHAT `repairApply` PLACES, and why three of these are unguessable.
 *
 * `legsPrint` is the PREFLIGHT's value — the legs this plan was written
 * against. The server recomputes it and answers 409 when a leg has been opened,
 * closed or resized since, because every `close` and `shift` names its leg by a
 * POSITIONAL id and a book that lost a pocket re-points one of those sentences
 * onto a leg that was never on screen.
 *
 * NOT `bookPrint`, and that is a correction rather than a relaxation. That hash
 * moves with every quote, so a 409 keyed on it fired on essentially every
 * mid-session Confirm — a guard that refuses plans nobody changed teaches its
 * user that the button is broken. Nothing here executes at a previewed price
 * anyway: the server re-reads the quote at submit time and prices each order
 * off the live touch, so the PRICES never needed a fingerprint. The legs did.
 *
 * `decisionId` is the CLAIM the run executes under, and it is what makes a lost
 * 202 safe to retry — the same id executes once, however many times it is asked
 * for, so it must be minted per PLAN and not per click, and NEVER re-used
 * across books (an id that already owns another book's run is refused, not
 * answered with that run). Keep it to 128 printable characters with no spaces:
 * it becomes the run's id and the stem of every order id under it.
 *
 * `password` is the live re-auth, exactly as arming a live strategy pays it;
 * omit the key entirely in paper.
 */
export interface RepairApplyRequest {
  readonly tag: string
  readonly mode: DeskMode
  /** The plan's OWN moves, verbatim. The server expands them again itself. */
  readonly moves: readonly RepairMove[]
  /** `RepairPreflightResponse.legsPrint`, from the answer the operator read. */
  readonly legsPrint: string
  readonly decisionId: string
  /**
   * `fast` steps THROUGH the touch this side would have to take, by the same
   * buffer every other desk order pays. `limit` rests at the mid for a spread
   * too wide to cross, and the existing chaser walks it in.
   */
  readonly style: 'fast' | 'limit'
  /** LIVE only — a live apply re-authenticates or 403s with `reauthRequired`. */
  readonly password?: string
}

/**
 * ACCEPTED IS A 202 AND NOT A RESULT. The run is DETACHED and its waves take up
 * to ten minutes, so `applyId` is what `repairApplyStatus` polls — immediately
 * if it likes: the run document is written before this answer is sent.
 *
 * `accepted: false` arrives as a 200, because the REQUEST was fine and it is the
 * PLAN that is refused — something in it dropped, it places nothing, a run
 * already owns this tag, or the `decisionId` already owns a run on another
 * book. The other two refusals are NOT in this union: legs that have moved
 * (409) and a live apply without a password (403 + `reauthRequired`) both
 * arrive as a thrown `ApiError`, and a caller that only reads `accepted` will
 * never see them.
 */
export type RepairApplyResponse =
  | { readonly accepted: true; readonly applyId: string }
  | { readonly accepted: false; readonly reason: string }

/**
 * ONE ORDER'S ROW IN THE RUN'S LEDGER.
 *
 * `status` is the RUN's reading, not the gateway's: `SUBMITTED` means the rail
 * took it and the fill is still being waited on, `FILLED` means every contract
 * traded. A PARTIAL at the broker lands here as `FAILED` and stops the run — it
 * is a real position of a size nobody asked for, and the rest of the plan is
 * sized against a leg that is only half there.
 */
export interface RepairRunOrder {
  readonly clientOrderId: string
  readonly wave: 'close' | 'open'
  readonly planned: PlannedOrderWire
  readonly status: 'QUEUED' | 'SUBMITTED' | 'FILLED' | 'FAILED'
  /** Why it is where it is — the rail's refusal, verbatim, when there was one. */
  readonly detail?: string
}

/**
 * THE RUN'S LEDGER, WHILE AND AFTER IT RUNS — what `repairApplyStatus` polls.
 *
 * `HALTED` is not a failure to hide: it is the record of what actually executed
 * before the run stopped, and it is what the operator finishes by hand from.
 * `haltReason` says why in words. A run also leaves RUNNING behind when the
 * process that owned it died, which is why the hold it projects has its own TTL.
 */
export interface RepairRunDoc {
  /** The applyId, which is the `decisionId` this run was claimed under. */
  readonly _id: string
  readonly tag: string
  readonly mode: DeskMode
  readonly style: 'fast' | 'limit'
  /** The book fingerprint the plan was built against, kept for the record. */
  readonly bookPrint: string
  readonly state: 'RUNNING' | 'DONE' | 'HALTED'
  readonly haltReason?: string
  readonly orders: readonly RepairRunOrder[]
  readonly createdAt: number
  readonly updatedAt: number
}

export const api = {
  /**
   * The order feed for ONE rail.
   *
   * `mode` is not cosmetic. In PAPER the server merges the paper rail's own
   * fills (`desk-paper-trade` — price and time included) with the refusals that
   * rail journalled; in LIVE it returns live routing. Unscoped, this page
   * showed "0 events" all through a paper session, because paper fills were
   * never in the collection it read.
   */
  orders: (mode: DeskMode, failuresOnly = false) =>
    get<{ events: OrderEvent[] }>(
      `/v1/desk/orders?mode=${mode}&limit=200${failuresOnly ? '&failures=1' : ''}`,
    ),
  killSwitch: () => get<KillSwitch>('/v1/desk/killswitch'),
  /**
   * RELEASING the halt carries `password`; engaging it does not. Making someone
   * re-authenticate to STOP trading would put a delay in front of the emergency
   * brake, which is the opposite of what the brake is for.
   *
   * No `setBy`: the server stamps it from the authenticated principal and
   * ignores anything the body claims, so sending 'dashboard' only produced a
   * field that looked like it came from here and never did.
   */
  setKillSwitch: (enabled: boolean, reason: string, password?: string) =>
    post<KillSwitch>('/v1/desk/killswitch', {
      enabled, reason,
      ...(password === undefined ? {} : { password }),
    }),
  brokerLink: () => get<BrokerLink>('/v1/desk/broker-link'),
  /**
   * Same asymmetry as the kill switch: RELEASING (log the gateway out of XTS,
   * stop live execution) carries no password; RECONNECTING does. No `setBy` —
   * the server stamps the authenticated principal.
   */
  setBrokerLink: (desired: 'connected' | 'released', reason: string, password?: string) =>
    post<BrokerLink>('/v1/desk/broker-link', {
      desired, reason,
      ...(password === undefined ? {} : { password }),
    }),
  /**
   * `tag` is sent ALONGSIDE `symbol`, not instead of it — the server takes
   * `symbol` with `tag` present as naming the exact book directly, which is
   * what actually avoids the 409: a symbol alone can now match zero or several
   * books, and the picker this is called from already knows which book was
   * chosen. Still typed to accept `null` for a caller that only has a symbol,
   * so an ambiguous or bookless refusal surfaces as the 409 it is rather than
   * being pre-empted here.
   */
  closeAll: (symbol: string, tag: string | null, mode: DeskMode, style: 'fast' | 'limit') =>
    post<CloseAllResult>('/v1/desk/close-all', {
      symbol, ...(tag === null ? {} : { tag }), mode, style,
      decisionId: `ui-close-${symbol}-${Date.now()}`,
    }),
  /**
   * Flatten a HOSTED strategy by tag. Needs no symbol — the position is
   * reconstructed from the fills `/v1/desk/submit` journalled.
   *
   * This is the escape hatch for a strategy that has been switched OFF: the
   * switch deliberately blocks the strategy's own exits, so without this the
   * position is unreachable by anything but the broker's own website.
   */
  flattenTag: (tag: string, mode: DeskMode, style: 'fast' | 'limit') =>
    post<FlattenResult>('/v1/desk/close-all', {
      tag, mode, style, decisionId: `ui-flatten-${tag}-${Date.now()}`,
    }),
  feed: () => get<FeedStatus>('/v1/desk/feed'),
  /**
   * Every process this desk runs, and whether it is actually alive.
   *
   * AUTHENTICATED, unlike `feed()`. It names each process, its cadence and its
   * broker session state — a map of the desk — so it sits behind the session
   * cookie rather than on the open port the readiness check lives on.
   */
  system: () => get<SystemReport>('/v1/desk/system'),
  /**
   * The operator audit log, newest first.
   *
   * OPERATOR-ONLY at the server, which is why this is read from the Status page
   * and nowhere a machine principal reads: a bearer token gets a 403, by
   * design. The limit is stated by the caller and clamped again server-side —
   * the collection is append-only and grows for the life of the desk.
   */
  audit: (limit = 25) => get<{ entries: AuditEntry[] }>(`/v1/desk/audit?limit=${limit}`),
  books: (mode: DeskMode) => get<{ books: BookSummary[] }>(`/v1/desk/books?mode=${mode}`),
  /**
   * ONE book, by its tag. `?symbol=` used to be the key here; since Phase 0 it
   * answers with `{books: [...]}` because a symbol no longer identifies a
   * single book — reading it as one (`.legs`, `.greeks` off the array) is
   * exactly the bug this method exists to not have.
   */
  positions: (tag: string, mode: DeskMode) =>
    get<PositionsResponse>(`/v1/desk/positions?tag=${encodeURIComponent(tag)}&mode=${mode}`),
  /**
   * Every book on a symbol. `symbol` is a FILTER now, not a key — a symbol can
   * carry several variants at once, which is the whole point of the re-key.
   */
  booksForSymbol: (symbol: string, mode: DeskMode) =>
    get<{ books: PositionsResponse[] }>(`/v1/desk/positions?symbol=${encodeURIComponent(symbol)}&mode=${mode}`),
  /** Tag-only since Phase 0: a symbol can no longer say which book to diff. */
  diff: (tag: string, mode: DeskMode) =>
    get<BookDiff>(`/v1/desk/diff?tag=${encodeURIComponent(tag)}&mode=${mode}`),

  /**
   * THE ENGINE'S OPERATOR CONTROLS — today, protection and nothing else.
   *
   * `protectedQty` is a QUANTITY PER INSTRUMENT in the supervisor's own state
   * (spec §4, D12): lots the engine may not spend on a shift, a shed, a scrap
   * or a close. Not a flag per leg, because `desk-books` legally holds one
   * contract across several legs and desk-api folds them — a per-leg flag
   * would be attached to an identity that does not survive the fold.
   *
   * IN LOTS, like every other quantity the engine reasons in. The leg rows
   * show contracts; the control converts, and says which it is asking for.
   */
  engine: {
    /** Everything pinned on this book, `{instrument: lots}`. `{}` is normal. */
    protection: (tag: string, mode: DeskMode) =>
      get<{ tag: string; mode: DeskMode; protectedQty: Readonly<Record<string, number>> }>(
        `/v1/desk/engine/protect?tag=${encodeURIComponent(tag)}&mode=${mode}`,
      ),
    /**
     * Pin (or, with 0, release) lots on one contract. Answers with the whole
     * map, so a caller never has to guess what the merge produced.
     *
     * REQUIRES THE PASSWORD ON A LIVE BOOK, and is refused without it (403 +
     * `reauthRequired`) — deciding what the desk may not touch on a real
     * position is the same class of act as retuning it.
     */
    protect: (
      tag: string,
      mode: DeskMode,
      instrument: string,
      protectedQty: number,
      password?: string,
    ) =>
      request<{ tag: string; mode: DeskMode; protectedQty: Readonly<Record<string, number>> }>(
        'POST',
        '/v1/desk/engine/protect',
        {
          tag,
          mode,
          instrument,
          protectedQty,
          ...(password === undefined ? {} : { password }),
        },
      ),
  },

  // -- desk books registry (lifecycle: create, start, stop)
  bookRegistry: {
    /** Every book registered for this mode — including ones never started. */
    list: (mode: DeskMode) =>
      get<{ books: BookRow[] }>(`/v1/desk/books/registry?mode=${mode}`).then((r) => r.books),
    /**
     * What the strategy says it is doing, for the run page's STRATEGY panel.
     *
     * 200 with nulls for a book that has never reported one — a book created a
     * minute ago and a desk that predates the feature are both normal, so this
     * never 404s and the caller renders an empty state rather than an error.
     */
    decisions: (tag: string, mode: DeskMode, opts?: { actions?: boolean }) =>
      get<BookDecisions>(
        `/v1/desk/books/registry/${encodeURIComponent(tag)}/decisions?mode=${mode}` +
          // Opt OUT, so every existing caller keeps the full payload. A caller
          // that only renders `lastReason` should not be pulling 200 action
          // rows down every poll to throw them away.
          (opts?.actions === false ? '&actions=0' : ''),
      ),
    /** 201 with the created row, ALWAYS `desired: 'stopped'`. 409 if the tag already has a book in this mode. */
    create: (body: BookCreate) => post<BookRow>('/v1/desk/books/registry', body),
    /**
     * Retune a book's dials — INCLUDING one that is running.
     *
     * The supervisor pushes the row's current dials into the live worker before
     * every tick, so a saved edit takes effect at the next 5-minute mark with
     * no restart. That matters: restarting a book is not free, because
     * desk-runner squares off on SIGTERM and a rebuilt worker loses its history
     * seed. Before that push existed, an edit here was saved and then silently
     * ignored by the running book, which is why this call had no UI at all.
     *
     * Dials ONLY. `desired`, `variant` and the identity fields are rejected by
     * the endpoint — lifecycle moves through `start`/`stop` so it stays an
     * explicit act, and re-pointing a book that may hold a position at another
     * variant is a new book, not an edit.
     *
     * A MERGE, not a replace: the store `$set`s `dials.<key>` per key, so
     * sending `{a: 1}` leaves every other dial exactly as it was. Omitting a
     * key does NOT remove it — nothing here can, `null` included, which is
     * deliberate (see `patchBookDials`). Removing a knob is a different, more
     * explicit operation than this.
     */
    patchDials: (
      tag: string,
      mode: DeskMode,
      dials: Readonly<Record<string, DialValue>>,
      /**
       * REQUIRED BY THE SERVER ON A LIVE BOOK, and refused without it (403 +
       * `reauthRequired`). Retuning a running live book rewrites the risk
       * parameters real orders are sized by, which is the same class of act as
       * arming a live strategy — see `routes/books.ts`. Paper never asks.
       */
      password?: string,
    ) =>
      request<BookRow>('PATCH', `/v1/desk/books/registry/${encodeURIComponent(tag)}`, {
        mode,
        dials,
        ...(password === undefined ? {} : { password }),
      }),
    /**
     * CLOSE ONE STRIKE out of the book, leaving the structure around it.
     *
     * For a short whose delta has decayed to ~0.10: it does no work in the
     * structure any more, but it still costs margin and still carries the tail.
     * `close-all` is the only other exit and it is all-or-nothing.
     *
     * EVERY leg on the contract goes, not the first match — a book can hold the
     * same strike more than once, and the table this is clicked from shows the
     * NETTED contract.
     *
     * REFUSED WITH 409 WHILE THE BOOK IS NOT `actual: running`. The Python
     * driver learns about this close only through its own book-vs-bridge pass,
     * which runs each tick; a driver that is not running never runs it and
     * would go on managing a leg that no longer exists, across restarts. The
     * caller should render the server's message rather than paraphrase it.
     *
     * `decisionId` is what makes a double-click safe — the same unique index
     * `close-all` relies on.
     */
    closeLeg: (
      tag: string,
      mode: DeskMode,
      tradingsymbol: string,
      decisionId: string,
      style: 'fast' | 'limit' = 'fast',
    ) =>
      post<{
        fills: unknown[]
        /** Per-action refusals. `reason` is the sentence to show the operator. */
        skips: { reason?: string }[]
        closed: string[]
        unpriceable: string[]
      }>(
        `/v1/desk/books/registry/${encodeURIComponent(tag)}/close-leg`,
        { mode, tradingsymbol, decisionId, style },
      ),
    /** Sets `desired: 'running'`. `actual` follows once the supervisor next polls and reports in. */
    start: (tag: string, mode: DeskMode) =>
      post<BookRow>(`/v1/desk/books/registry/${encodeURIComponent(tag)}/start`, { mode }),
    /** Sets `desired: 'stopped'`. Does not flatten anything — see `strategies.tsx`'s Flatten. */
    stop: (tag: string, mode: DeskMode) =>
      post<BookRow>(`/v1/desk/books/registry/${encodeURIComponent(tag)}/stop`, { mode }),
    /**
     * ERASE the book: registry row, stored position record and strategy mode,
     * all three together.
     *
     * 409 while it still HOLDS legs — the refusal names the contracts, because
     * deleting then would erase the desk's only record of a position that
     * still exists — and 409 while it is still `desired: 'running'`. Both are
     * one click away on this same page: Stop, then Flatten, then Delete.
     *
     * `?mode=` is REQUIRED and is not defaulted server-side, unlike every read
     * endpoint: a mistyped mode on a delete would erase the paper book.
     */
    remove: (tag: string, mode: DeskMode, flatten = false, purge = false) =>
      request<{ deleted: string; mode: DeskMode; purged?: { decisions: number; orders: number } }>(
        'DELETE',
        `/v1/desk/books/registry/${encodeURIComponent(tag)}?mode=${mode}` +
          (flatten ? '&flatten=1' : '') +
          (purge ? '&purge=1' : ''),
      ),
  },
  /**
   * NO `variants()` CLIENT — deliberately, and this note is the whole record.
   *
   * `GET /v1/desk/variants` still exists and is still read SERVER-side:
   * `routes/payoff.ts` resolves a book's dial defaults against the stored
   * `desk-variants` rows, and the dials PATCH checks unknown keys against
   * them. It is read-only since the D9 cutover — the `POST` went with the
   * Python supervisor — so the catalogue no longer grows and an empty result
   * is the normal state of a fresh deployment.
   *
   * The DASHBOARD does not call it. The Build screen and the dials panel
   * resolve against `@algomaker/desk-engine`'s presets, which ship in code.
   * The one caller was `book-create.tsx`, the superseded create wizard,
   * unreachable from any route and deleted with its `VariantRow` type.
   */
  /**
   * Seed an ALREADY-OPEN position into a book, at the price actually paid.
   * Emits no orders — see `apps/api/src/seed.ts`.
   */
  seed: (body: SeedRequestBody) => post<SeedResult>('/v1/desk/seed', body),
  /**
   * Place ONE order. Used by the Build-book screen to open a structure leg by
   * leg. `lots` is what the caller wants; on the LIVE rail the strategy row's
   * `liveLots` REPLACES it, so the two must agree or the size that goes out is
   * not the size that was asked for.
   */
  submitOrder: (body: {
    tag: string
    mode: DeskMode
    clientOrderId: string
    instrument: {
      tradingsymbol: string
      instrumentToken: number
      lotSize: number
      tickSize: number
      exchange: string
    }
    side: 'Buy' | 'Sell'
    lots: number
    orderType: 'LIMIT' | 'MARKET'
    limitPrice?: number
    /** A positional book's leg: size exactly as asked, no liveLots override. */
    exactLots?: boolean
    /** Deliberately pending: sit at limitPrice, never chased. Requires LIMIT. */
    resting?: boolean
    /**
     * THIS ORDER IS AN EXIT — it reduces a position the book already holds.
     *
     * The bridge derives `op` from this and from nothing else (`submit.ts`),
     * and `op: 'open'` on a contract the book does not hold CREATES a leg. So
     * a caller that omits it while meaning an exit books a phantom position of
     * the opposite sign, which the supervisor then adopts and eventually
     * flattens for real. Only send it when the book is KNOWN to hold the
     * contract on the other side — see `classifyExposure`, which is where the
     * Manual Order dialog decides it. It is also the only thing that lets an
     * order past the kill switch, so a false one is a control removed.
     */
    reducesExposure?: boolean
  }) =>
    post<{
      accepted: boolean
      status: string
      clientOrderId: string
      routedLots?: number
      intendedLots?: number
      reason?: string
    }>('/v1/desk/submit', body),
  /**
   * Live prices per strike, PLUS the contract behind each side. The contract is
   * what lets a caller act on a strike without reconstructing the exchange's
   * own tradingsymbol format client-side.
   */
  chain: (underlying: string, expiry: string) =>
    get<{
      spot: number | null
      future: number | null
      /** The instrument master's lot size for this expiry — knowable without a repair search. */
      lotSize?: number | null
      rows?: {
        strike: number
        /** `price` is the MID whenever bid/ask are present — see the bridge's `Quote`. */
        CE?: { price: number; ageMs: number; bid?: number | null; ask?: number | null } | null
        PE?: { price: number; ageMs: number; bid?: number | null; ask?: number | null } | null
        ceContract?: { tradingsymbol: string; instrumentToken: number }
        peContract?: { tradingsymbol: string; instrumentToken: number }
      }[]
    }>(
      `/v1/desk/chain/${encodeURIComponent(underlying)}?expiry=${encodeURIComponent(expiry)}`,
    ),
  /**
   * Every underlying the instrument master lists an option chain for.
   *
   * Feeds the Symbol picker on the Build-book screen, and is deliberately NOT
   * mirrored as a constant in this repo: the master is synced from the broker
   * and a client-side list is stale the day a name is added or delisted — which
   * is the maintenance problem the picker replaces, not one to reintroduce here.
   *
   * An unreadable body normalises to an EMPTY list rather than throwing,
   * because the caller renders an empty list as "type the symbol yourself".
   * A screen that cannot be used at all is worse than one whose picker is
   * missing.
   */
  underlyings: () =>
    get<{ underlyings?: string[] }>('/v1/desk/instruments').then((r) =>
      Array.isArray(r.underlyings) ? r.underlyings.filter((u) => typeof u === 'string') : [],
    ),
  /** The chain for one underlying, plus every expiry the master lists for it. */
  instruments: (underlying: string, expiry?: string) =>
    get<InstrumentsResponse>(
      `/v1/desk/instruments/${encodeURIComponent(underlying)}` +
      (expiry === undefined ? '' : `?expiry=${encodeURIComponent(expiry)}`),
    ),

  // -- auth
  login: (username: string, password: string) =>
    post<LoginResult>('/v1/auth/login', { username, password }),
  logout: () => post<{ ok: boolean }>('/v1/auth/logout', {}),
  me: () => get<Session>('/v1/auth/me'),

  // -- brokers
  brokers: () => get<{ brokers: BrokerRow[] }>('/v1/desk/brokers'),
  /**
   * What the BROKER holds, from the gateway's snapshot. Rows are passed through
   * verbatim as the broker sent them — see `BrokerView` for why they are not
   * reshaped into a desk-side type.
   */
  brokerView: () => get<BrokerView>('/v1/desk/broker'),
  /**
   * Account margin, from the same snapshot. SEPARATE FROM `brokerView` on
   * purpose: that response carries the whole order book, position list and trade
   * book, and the Positions page polls this every few seconds for two numbers.
   */
  brokerFunds: () => get<BrokerFunds>('/v1/desk/broker/funds'),
  bookMargin: (tag: string) => get<BookMargin>(`/v1/desk/margin?tag=${encodeURIComponent(tag)}`),
  /**
   * Ask the gateway to cancel a broker order. 202 — ACCEPTED, not performed:
   * the gateway does it within ~2s and the order leaves the Broker table.
   * Only an id is needed; clientID comes off the order row at the gateway.
   */
  cancelBrokerOrder: (appOrderId: string) =>
    request<{ accepted: boolean; appOrderID: string; status: string }>(
      'POST',
      `/v1/desk/broker/orders/${encodeURIComponent(appOrderId)}/cancel`,
    ),
  saveBroker: (kind: BrokerKind, body: BrokerSave) =>
    request<{ ok: boolean; kind: string }>('PUT', `/v1/desk/brokers/${kind}`, body),
  testBroker: (kind: BrokerKind) =>
    post<BrokerTestResult>(`/v1/desk/brokers/${kind}/test`, {}),

  // -- strategies
  /**
   * Rows ADDED to `mode` — including the ones switched off.
   *
   * Filtered by membership, not by the switch. Filtering on `enabled` would
   * take a strategy out of the table the moment it was paused, and the only way
   * back would be to delete and re-add the row.
   */
  strategies: (mode: DeskMode) =>
    get<{ strategies: StrategyRow[] }>(`/v1/desk/strategies?mode=${mode}`).then(normaliseModes),
  /** Every registered row, added to any mode or none. Feeds the add modal. */
  allStrategies: () =>
    get<{ strategies: StrategyRow[] }>('/v1/desk/strategies?all=1').then(normaliseModes),
  /**
   * Catalogue tags the runner can run that are not on THIS MODE's table yet.
   *
   * `mode` is required rather than defaulted. The server filters availability by
   * membership of the mode it is asked about and falls back to paper when not
   * told, so an add-to-LIVE modal was being offered the list of "not yet in
   * paper" — which silently omits every strategy that is already running on
   * paper, i.e. exactly the ones you promote to live.
   */
  availableStrategies: (mode: DeskMode) =>
    get<unknown>(`/v1/desk/strategies/available?mode=${mode}`).then(normaliseAvailable),
  /** 201 with the created row, always OFF. 409 if it is already on that mode. */
  createStrategy: (body: StrategyCreate) => post<StrategyRow>('/v1/desk/strategies', body),
  /**
   * Take a strategy off ONE mode's table. The row and its other mode survive —
   * "remove from live" is not "delete this strategy".
   *
   * 409 while the runner reports an open position on that rail: a row that
   * vanishes while holding risk cannot even be switched back on.
   */
  removeStrategyMode: (tag: string, mode: DeskMode) =>
    request<StrategyRow>('DELETE', `/v1/desk/strategies/${encodeURIComponent(tag)}/modes/${mode}`),
  patchStrategy: (tag: string, patch: StrategyPatch) =>
    request<StrategyRow>('PATCH', `/v1/desk/strategies/${encodeURIComponent(tag)}`, patch),
  /**
   * Switch every row on or off FOR ONE MODE. Never both — one click that arms
   * live trading everywhere is the ambiguity the switch exists to remove.
   */
  bulkStrategies: (mode: DeskMode, on: boolean, password?: string) =>
    post<unknown>('/v1/desk/strategies/bulk', {
      mode, on, ...(password === undefined ? {} : { password }),
    }).then(normaliseBulk),

  // -- pnl
  pnl: (mode: DeskMode) => get<PnlResponse>(`/v1/desk/pnl?mode=${mode}`),
  pnlSeries: (tag: string, mode: DeskMode, from?: number, to?: number) =>
    get<PnlSeries>(
      `/v1/desk/pnl/series?tag=${encodeURIComponent(tag)}&mode=${mode}` +
      `${from === undefined ? '' : `&from=${from}`}${to === undefined ? '' : `&to=${to}`}`,
    ),

  // -- payoff cockpit
  /**
   * ONE BOOK'S WHOLE SHAPE: three curves, the named price table, and what the
   * bot is about to do about it.
   *
   * TAG-ONLY, and the server 400s without one — there is no "all books" payoff,
   * and picking one would label another strategy's curve with this one's name.
   *
   * IT IS NOT A 5-SECOND ENDPOINT. Every successful read solves the whole
   * chain's volatilities, prices 121 curve points on three dates, scans the
   * realised fill journal and files a snapshot; the panel polls it at 60s and
   * the Books page's cadence would be twelve times that work for a curve that
   * moves with the future. See `PayoffPanel`.
   *
   * A 200 CAN STILL CARRY `error` — "no such book" is answered that way on
   * purpose, so a polling dashboard renders a sentence instead of a failed
   * fetch. Callers read `error` as well as the status.
   */
  payoff: (tag: string, mode: DeskMode) =>
    get<PayoffResponse>(`/v1/desk/payoff?tag=${encodeURIComponent(tag)}&mode=${mode}`),

  /**
   * THE SAME BOOK WITH A PROPOSAL FOLDED IN — a pure calculation, not an order.
   *
   * `mode` RIDES IN THE BODY AND ONLY IN THE BODY. `routes/payoff.ts` reads it
   * from `body['mode']` and defaults to paper; a mode put on the query string
   * would be ignored in silence and a live book priced as a paper one.
   *
   * `proposed` is SIGNED SHARES — see `ProposedLeg`. It is a POST because the
   * proposal is a list, not because anything is written: this endpoint holds no
   * rail and reaches no gate.
   */
  payoffWhatif: (tag: string, mode: DeskMode, proposed: readonly ProposedLeg[]) =>
    post<WhatIfResponse>('/v1/desk/payoff/whatif', { tag, mode, proposed }),

  /**
   * THE SAME CURVE, FROM A REPAIR PLAN'S OWN MOVES.
   *
   * `proposed` above speaks CONTRACTS and has no way to take a leg OFF, so a
   * plan of pure closes translated to an EMPTY proposal: the panel drew the
   * unchanged book under the label "if placed" and a flatten previewed as "this
   * repair changes nothing". `moves` is the repairer's language — `close` and
   * `shift` included — and the server applies it through the same `applyMoves`
   * that SCORED the plan, so the fourth line on the chart is the plan itself
   * rather than the strictly riskier subset of it that could be said as
   * contracts.
   *
   * ONE VOCABULARY PER CALL, deliberately. The leg editor sends `proposed` and
   * the repair menu sends `moves`; the server accepts both in one body and
   * defines the order, but the panel never gives one overlay two authors.
   */
  payoffPlanWhatif: (tag: string, mode: DeskMode, moves: readonly RepairMove[]) =>
    post<WhatIfResponse>('/v1/desk/payoff/whatif', { tag, mode, moves }),

  /**
   * FOUR GOALS, RANKED PLANS, AND THE BASELINE THEY ARE SCORED AGAINST.
   *
   * NOT POLLED, EVER, AND THAT IS A LOAD DECISION. Each call runs a beam search
   * that prices hundreds of candidate books through the same surface engine the
   * chart draws — the payoff beside it is the cheap endpoint and it already
   * polls at 60s. This one runs when a human presses a button.
   *
   * A 200 CAN CARRY `error` for the same reason `payoff` can: "no such book" is
   * a sentence to render, not a failed fetch.
   */
  repair: (tag: string, mode: DeskMode) =>
    get<RepairResponse>(`/v1/desk/repair?tag=${encodeURIComponent(tag)}&mode=${mode}`),

  /**
   * WHAT THE BROKER WOULD HOLD AGAINST A PLAN, beside this desk's own estimate.
   *
   * EVERY CALL SPENDS A REAL KITE REQUEST, ledgered against the account and made
   * on the one enctoken the feed also lives on. Callers single-flight it — see
   * `PayoffPanel`; a double-click that sends two is the cheapest way to waste
   * the one resource this desk cannot re-issue mid-session.
   *
   * `moves` are the plan's OWN moves, verbatim. The server applies them to the
   * stored book and prices the RESULT, because a broker prices a portfolio: the
   * short a proposed wing caps is what makes the wing cheap, and posting the
   * wing alone would price a naked long option — margin nil — for a plan that
   * still carries two shorts.
   */
  repairVerifyMargin: (tag: string, mode: DeskMode, moves: readonly RepairMove[]) =>
    post<VerifyMarginResponse>('/v1/desk/repair/verify-margin', { tag, mode, moves }),

  /**
   * WHAT THESE MOVES WOULD ACTUALLY PLACE — the screen in front of the orders.
   *
   * `legsPrint` is the CARD'S copy, taken off the `repair()` answer the plan was
   * read from. Threading it is what lets the server refuse a card that has
   * outlived its book: a legId is positional, so a book that loses one pocket of
   * a doubled contract re-points the id onto the pocket behind it and every
   * screen still reads correct while the close goes out at the survivor's full
   * size. Omitted, that check simply is not made — so omit it only for a plan
   * that addresses no leg at all.
   *
   * SAFE TO RE-ASK. Nothing is written and no rail is reached; the answer is a
   * fresh reading of the book, which is exactly what makes it worth re-asking
   * before Confirm rather than rendering a preview taken minutes ago.
   */
  repairPreflight: (tag: string, mode: DeskMode, moves: readonly RepairMove[], legsPrint?: string) =>
    post<RepairPreflightResponse>('/v1/desk/repair/preflight', {
      tag, mode, moves,
      ...(legsPrint === undefined ? {} : { legsPrint }),
    }),

  /**
   * THE PLAN BECOMES ORDERS. The one call on this client that places a repair.
   *
   * THREE ANSWERS, and a caller that reads only the first two is wrong. A 202
   * resolves to `{accepted: true}` with the id to poll; a refused PLAN resolves
   * to `{accepted: false, reason}`; LEGS that have moved (409) and a live apply
   * that has not re-authenticated (403 + `reauthRequired`) both THROW an
   * `ApiError`, as does a timeout — and the timeout's sentence is the honest one
   * for a write, because the run may already be executing.
   *
   * ON A 409, RE-PREFLIGHT AND SHOW THE NEW ANSWER — do not retry with the same
   * body. It means a leg was opened, closed or resized under the plan, so the
   * moves on screen no longer address what the operator thinks they do.
   *
   * `decisionId` IS THE IDEMPOTENCY, so it is the caller's to mint and the
   * caller's to keep: re-sending the same id after a lost answer re-claims the
   * same run instead of placing the plan twice. Minting a fresh one on retry is
   * the one mistake this endpoint cannot protect anyone from — and re-using one
   * across books is the other, which is why the server refuses that outright.
   */
  repairApply: (body: RepairApplyRequest) =>
    post<RepairApplyResponse>('/v1/desk/repair/apply', body),

  /**
   * THE RUN'S LEDGER — polled, because the apply answered before it finished.
   *
   * Readable the instant `repairApply` resolves (the document is written before
   * the 202) and worth reading after `state` leaves `RUNNING` too: on a HALTED
   * run this is the record of what executed, which is what the rest gets
   * finished by hand from. A 404 — no run under this id — arrives as a thrown
   * `ApiError`.
   */
  repairApplyStatus: (applyId: string) =>
    get<RepairRunDoc>(`/v1/desk/repair/apply/${encodeURIComponent(applyId)}`),

  // -- reports
  /**
   * Tags that have been rolled up ON THIS RAIL. Populates the reports picker's
   * last group (tags no series claims). The server filters by `mode`.
   */
  reportTags: (mode: DeskMode) => get<{ tags: string[] }>(`/v1/desk/reports/tags?mode=${mode}`),
  /** The series and the variants on this rail — the picker's first two groups. */
  reportSeries: (mode: DeskMode) => get<ReportSeries>(`/v1/desk/reports/series?mode=${mode}`),
  /** ONE strategy over a range of IST days. `from`/`to` are `YYYY-MM-DD`. */
  reportHistory: (tag: string, mode: DeskMode, from: string, to: string) =>
    get<ReportHistory>(
      `/v1/desk/reports/history?tag=${encodeURIComponent(tag)}&mode=${mode}` +
      `&from=${from}&to=${to}`,
    ),
  /** A series, or a variant across symbols, one row per IST day. */
  reportGroupHistory: (group: ReportGroup, mode: DeskMode, from: string, to: string) =>
    get<GroupHistory>(
      `/v1/desk/reports/history?${'series' in group
        ? `series=${encodeURIComponent(group.series)}`
        : `variant=${encodeURIComponent(group.variant)}`}&mode=${mode}&from=${from}&to=${to}`,
    ),
  /**
   * The order journal up to an IST day, optionally for ONE strategy.
   *
   * `from` IS WHAT A POSITIONAL BOOK NEEDS, and nothing else passes it. It
   * widens the window backwards to that IST day (inclusive), so a book opened
   * three weeks ago shows the trade that opened it instead of a log that begins
   * at this morning's open. An intraday strategy omits it and reads exactly the
   * one day it always did.
   *
   * THE TAG FILTER IS APPLIED HERE, NOT ON THE SERVER, and that is the fix for
   * a log that could never show a fill. `?tag=` is an exact match on the stored
   * event, and the gateway writes its `STATUS` events with `tag: ''` — the
   * STATUS phase being the only one that carries `status`, `filledQty` and
   * `avgPrice`. So a server-side tag filter structurally excluded every fill
   * and every rejection, leaving a per-strategy log that could only ever show
   * "submitted".
   *
   * So the day is fetched whole and correlated by `clientOrderId`: the phases
   * that DO carry the tag (PLANNED / SUBMITTED / ACK / FAILED / INVALID) name
   * the order ids belonging to this strategy, and an untagged event on one of
   * those ids belongs to it too. Slices are matched on the base id, because the
   * gateway splits a large order into `<id>.1`, `<id>.2` while the PLANNED
   * event keeps the base.
   *
   * This stays correct if the gateway starts writing the tag: those events then
   * match directly and the correlation adds nothing.
   */
  reportOrders: async (
    date: string,
    mode: DeskMode,
    tag?: string,
    failuresOnly = false,
    from?: string,
  ) => {
    // `from` is omitted when it IS the day: a window of one day is the default
    // said twice, and two spellings of one request read as two windows.
    const range = `date=${date}${from === undefined || from === date ? '' : `&from=${from}`}`
    if (tag === undefined) {
      return await get<{ date: string; events: OrderEvent[] }>(
        `/v1/desk/reports/orders?${range}&mode=${mode}${failuresOnly ? '&failures=1' : ''}`,
      )
    }
    // The whole day, unfiltered: `failures=1` is applied after the correlation
    // too, since an ACK (ok) is what names the ids a rejection belongs to.
    const all = await get<{ date: string; events: OrderEvent[] }>(
      `/v1/desk/reports/orders?${range}&mode=${mode}&limit=2000`,
    )
    const mine = eventsForTag(all.events, tag)
    return { date: all.date, events: failuresOnly ? mine.filter((e) => !e.ok) : mine }
  },
  /**
   * `keepDays` is deliberately not sent: the retention window is the server's
   * configuration, and a dashboard that quietly passed its own would delete a
   * different set of days than the one the operator was told about.
   */
  prune: (dryRun: boolean) => post<PruneResult>('/v1/desk/reports/prune', { dryRun }),
}

/**
 * The base id a slice belongs to: `ORB-123.2` -> `ORB-123`.
 *
 * The gateway's rule (`gateway.ts baseClientOrderId`): only a TRAILING numeric
 * `.N` is a tranche suffix. An id may carry dots of its own (`atr.v2-171#3`),
 * and cutting at the first dot grouped every `atr.*` order together.
 */
export function baseOrderId(id: string): string {
  const m = /^(.*)\.\d+$/.exec(id)
  return m?.[1] ?? id
}

/**
 * The events belonging to one strategy: those carrying its tag, plus the
 * untagged ones sharing an order id with them. See `api.reportOrders`.
 *
 * Exported for the tests — the correlation is the whole reason a fill is
 * visible at all, and it is worth pinning independently of a live journal.
 */
export function eventsForTag(events: readonly OrderEvent[], tag: string): OrderEvent[] {
  const ids = new Set<string>()
  for (const e of events) {
    if (e.tag === tag && e.clientOrderId !== '') ids.add(baseOrderId(e.clientOrderId))
  }
  return events.filter(
    (e) => e.tag === tag || (e.tag === '' && ids.has(baseOrderId(e.clientOrderId))),
  )
}

// -------------------------------------------------------- one row per order

/** One order and everything that happened to it. See `groupOrders`. */
export interface OrderGroup {
  /** The base `clientOrderId` — the identity of the ORDER, tranches included. */
  readonly id: string
  /** The most recent event's timestamp: when this order last did anything. */
  readonly ts: number
  readonly tag: string
  readonly tradingsymbol: string
  readonly side: string
  /** Contract quantity actually filled, summed across tranches. */
  readonly filledQty: number
  /** Quantity-weighted average, or null when nothing filled. */
  readonly avgPrice: number | null
  /** The furthest state the order reached, or the latest phase if it never got a status. */
  readonly status: string
  /** False if ANY part of the order failed. */
  readonly ok: boolean
  /** The first failure's own sentence, when there is one. */
  readonly error?: string
  /** The newest event's caveat, when any event carries one. Never affects `ok`. */
  readonly warning?: string
  /** Every event, newest first — what the detail view shows. */
  readonly events: readonly OrderEvent[]
}

/**
 * How far through its life a status is. The MAXIMUM across an order's events is
 * the state it reached, which is what a single row has to report.
 *
 * Ranked rather than "the latest by timestamp" because the journal stamps a
 * whole burst of phases within the same second — the prod BHEL order has
 * PLANNED, SUBMITTED, PENDING_NEW and four fills all at 09:20:15 — so ordering
 * by time is a coin flip among them, and the coin decides whether the operator
 * reads FILLED or PLANNED.
 */
const STATUS_RANK: Readonly<Record<string, number>> = {
  PLANNED: 0,
  SUBMITTED: 1,
  ACK: 2,
  PENDING_NEW: 2,
  PENDING: 2,
  OPEN: 3,
  PARTIALLY_FILLED: 4,
  PARTIAL: 4,
  COMPLETE: 5,
  FILLED: 5,
  // A HALT OUTRANKS A FILL, and that is the whole point of the entry: a halted
  // order journals its stopped state under the BASE id while the tranches that
  // did trade journal COMPLETE under theirs, so without this the row for an
  // order the gateway deliberately stopped read FILLED — the operator's only
  // notice that a decision was two-thirds executed, reported as done.
  HALTED: 6,
  // Above it, the one state that is worse: nothing traded and the broker said
  // no. Ranked so HALTED sits where it belongs, between what filled and what
  // was refused.
  REJECTED: 7,
}

const rankOf = (s: string): number => STATUS_RANK[s.toUpperCase()] ?? -1

/**
 * Collapse a per-phase journal into ONE ROW PER ORDER, newest first.
 *
 * WHY. The log is written per PHASE and per TRANCHE, so a single 3-lot BHEL
 * order occupied eleven rows: PLANNED, SUBMITTED, PENDING_NEW, then a
 * progressive PARTIALLY_FILLED for each step of the fill — each of them
 * repeated under a SECOND contract spelling, because the broker echoes its own
 * symbol (`BHEL 25AUG2026 PE 410`) while the routing events carry the Kite
 * packing (`BHEL26AUG410PE`). Answering "what actually traded" meant counting.
 * Grouping on the order id merges both spellings for free.
 *
 * THE ARITHMETIC, AND THE TRAP IN IT. `filledQty` on a STATUS event is
 * CUMULATIVE FOR ITS TRANCHE, not incremental. Summing every event
 * multiply-counts every partial, and a 3-lot order reads as 6 lots. So the
 * furthest-progressed event PER TRANCHE is picked first, and only those are
 * summed — which also dedups a tranche journalled twice, and is why the pick is
 * by greatest `filledQty` rather than by timestamp (see `STATUS_RANK`: the
 * whole burst shares one second).
 *
 * Tranches themselves DO sum: `<id>.1` and `<id>.2` are separate broker orders
 * against one desk order, and the price is their quantity-WEIGHTED average.
 * 1800 @ 100 and 450 @ 130 is 106, not 130 — taking the last tranche's price is
 * Rs.54,000 out on one 30-lot NIFTY order, which is the same mistake
 * `aggregateTranches` exists to prevent server-side.
 *
 * ANY FAILURE MAKES THE WHOLE ORDER NOT-OK, while the filled quantity still
 * reports what DID go on. A split order with one tranche refused has real
 * exposure at the broker AND a refusal to explain; reporting only one of the
 * two is a lie either way.
 *
 * PURE, and exported for the tests: this arithmetic is the whole reason the
 * collapsed row can be trusted, and it is worth pinning without a DOM.
 */
export function groupOrders(events: readonly OrderEvent[]): OrderGroup[] {
  const byOrder = new Map<string, OrderEvent[]>()
  for (const e of events) {
    const id = baseOrderId(e.clientOrderId)
    const bucket = byOrder.get(id)
    if (bucket === undefined) byOrder.set(id, [e])
    else bucket.push(e)
  }

  const out: OrderGroup[] = []
  for (const [id, all] of byOrder) {
    // Newest first, and STABLE — the detail view reads top-down as a history.
    const ordered = [...all].sort((a, b) => b.ts - a.ts)

    // The furthest-progressed event per TRANCHE, keyed on the full
    // clientOrderId rather than the base. See the docstring.
    const perTranche = new Map<string, OrderEvent>()
    for (const e of all) {
      if (typeof e.filledQty !== 'number' || !Number.isFinite(e.filledQty)) continue
      const best = perTranche.get(e.clientOrderId)
      if (best === undefined || e.filledQty > (best.filledQty ?? 0)) perTranche.set(e.clientOrderId, e)
    }

    /*
      TWO ACCOUNTS OF ONE QUANTITY — TAKE THE LARGER, NEVER THE SUM.

      `FillWatcher.reconcile` journals a SUMMARY once the order resolves,
      carrying the whole order's `filledQty` and quantity-weighted `avgPrice`,
      under the BASE id — while each tranche has already journalled its own
      progress under `<base>.N`. Adding the summary in as though it were one
      more tranche DOUBLES a split order: 1800 + 450 + 2250 = 4500.

      Taking the larger is right in all four states this reaches:
        - split, resolved   -> summary 2250 vs tranches 2250, agree
        - split, in flight  -> no summary yet, the tranches are the only account
        - split, base row is a bare PENDING_NEW at qty 0 -> the tranches win,
          where trusting the base row outright would report a filled order as 0
        - unsplit -> the tranche id IS the base id, there are no others, and the
          max over that one row is what it always was

      The price comes from whichever account won, because an average belongs to
      the quantity it was computed over.
    */
    const summary = perTranche.get(id)
    let filledQty = 0
    let notional = 0
    for (const [tranche, e] of perTranche) {
      if (tranche === id && perTranche.size > 1) continue
      const qty = e.filledQty ?? 0
      filledQty += qty
      if (qty > 0 && typeof e.avgPrice === 'number' && Number.isFinite(e.avgPrice)) {
        notional += qty * e.avgPrice
      }
    }
    const summaryQty = summary?.filledQty ?? 0
    if (perTranche.size > 1 && summaryQty > filledQty) {
      filledQty = summaryQty
      notional =
        typeof summary?.avgPrice === 'number' && Number.isFinite(summary.avgPrice)
          ? summaryQty * summary.avgPrice
          : 0
    }

    const failure = ordered.find((e) => !e.ok)
    // A caveat rides the group the way a failure does, but on its own field:
    // it must never be able to turn `ok` false or displace a real error.
    const warned = ordered.find((e) => typeof e.warning === 'string' && e.warning !== '')
    let status = ''
    let best = -Infinity
    for (const e of all) {
      const candidate = e.status ?? e.phase
      if (candidate === undefined || candidate === '') continue
      const r = rankOf(candidate)
      if (r > best) {
        best = r
        status = candidate
      }
    }

    /*
      THE KITE PACKING WINS when both spellings are present. It is the symbol
      `formatContract` can shorten to `BHEL 410 PE`, and the one the rest of the
      desk keys on; the broker's echo is display-hostile and joins to nothing.
      Detected by asking `formatContract` whether it recognises the string,
      rather than by matching the broker's format — a format that is theirs to
      change.
    */
    const named = all.map((e) => e.tradingsymbol).filter((s) => s !== '' && s !== undefined)
    const tradingsymbol =
      named.find((s) => formatContract(s) !== s) ?? named[0] ?? ''

    out.push({
      id,
      ts: ordered[0]?.ts ?? 0,
      tag: all.find((e) => e.tag !== '')?.tag ?? '',
      tradingsymbol,
      side: all.find((e) => e.side !== undefined && e.side !== '')?.side ?? '',
      filledQty,
      // Null, never 0: a price of zero is a claim about a fill that did not
      // happen — the same rule the nullable field itself exists for.
      avgPrice: filledQty > 0 && notional > 0 ? round2(notional / filledQty) : null,
      status: failure !== undefined ? (failure.status ?? 'REJECTED') : status,
      ok: failure === undefined,
      ...(failure?.error === undefined ? {} : { error: failure.error }),
      ...(warned === undefined ? {} : { warning: warned.warning }),
      events: ordered,
    })
  }

  return out.sort((a, b) => b.ts - a.ts)
}

/** Two decimals, without the float dust that `1800*100/2250` leaves behind. */
function round2(n: number): number {
  return Math.round(n * 100) / 100
}

// ------------------------------------------------------------- formatting

// Moved to ./format.ts (a leaf the traders page shares); re-exported so every desk import is unchanged.
import { inr } from './format.ts'
export { inr, signed, inrCompact, RED, GREEN, sign, money } from './format.ts'

/**
 * A cell that must never wrap — identifiers and timestamps break badly
 * mid-token, so they scroll instead.
 *
 * `Time` at `pixel(100)` used to render "10:07:50 AM" and wrap to two lines,
 * doubling the height of those rows and leaving the log ragged. `localTime`
 * below is the actual fix; this is belt and braces for a narrower viewport,
 * where even the shorter string would overflow again. Shared, beside the other
 * style objects, because the orders table and the positions table have to make
 * the same promise about their columns.
 */
export const NOWRAP = { whiteSpace: 'nowrap' } as const


/**
 * One line describing how an order event ended.
 *
 * The error wins when there is one: on a failed submission the broker's own
 * sentence is the only thing worth reading, and a status field beside it just
 * dilutes it.
 */
export function orderDetail(e: OrderEvent): string {
  if (e.error !== undefined && e.error !== '') return e.error
  const parts = [
    e.status,
    e.filledQty === undefined ? null : `filled ${inr(e.filledQty)}`,
    e.avgPrice === undefined || e.avgPrice === null ? null : `@${e.avgPrice}`,
  ].filter((x): x is string => typeof x === 'string' && x !== '')
  return parts.length === 0 ? '—' : parts.join(' ')
}

// ------------------------------------------------------------------- dates

const IST_DAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
})

/**
 * The IST calendar day, which is the day this desk files everything under.
 * The browser may sit in any zone; a 15:30 IST fill still belongs to its own
 * trading day, so the local date is never the right answer.
 */
export function istDate(at: number = Date.now()): string {
  return IST_DAY.format(new Date(at))
}

/**
 * The IST day `days` before another one, as `YYYY-MM-DD`.
 *
 * Goes through epoch ms rather than arithmetic on the string so month and year
 * ends are the calendar's problem, not ours. IST has no daylight saving, so a
 * fixed 24h step lands on the same wall-clock time every day of the year.
 */
export function istDaysBefore(date: string, days: number): string {
  return istDate(Date.parse(`${date}T12:00:00+05:30`) - days * 86_400_000)
}

/** `2026-07-12` -> `12 Jul`. A three-month axis has no room for the year. */
export function istDayLabel(date: string): string {
  const at = Date.parse(`${date}T12:00:00+05:30`)
  return Number.isNaN(at)
    ? date
    : new Date(at).toLocaleDateString('en-IN', {
        timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short',
      })
}

/** Clock time in IST — a chart axis labelled in the reader's zone lies to them. */
export function istTime(ms: number): string {
  return new Date(ms).toLocaleTimeString('en-IN', {
    timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false,
  })
}

/*
  THE LOCAL CLOCK, 24-HOUR, PINNED TO `en-GB` RATHER THAN THE BROWSER'S LOCALE.

  The default `toLocaleTimeString()` renders "10:07:50 AM" on an en-US machine,
  which does not fit the log's Time column and wrapped to two lines — the rows
  went double-height and the log read ragged. 24-hour is three characters
  shorter, is what a trading log is kept in, and has no AM/PM to parse when
  scanning down a column. The locale is fixed rather than left to the browser
  because a column width is a fixed decision and the string it has to hold must
  not depend on whose laptop is open. It is still the LOCAL clock — only the
  formatting is pinned, and this desk runs in IST.

  ONE COPY, because the fix stopped holding the moment it was retyped: the
  orders log on two pages had it, and the report log and the broker page were
  still calling the browser's default and rendering the very format this
  replaced.
*/

/** Wall-clock time, `HH:MM:SS`. See the note above. */
export function localTime(ms: number): string {
  return new Date(ms).toLocaleTimeString('en-GB')
}

/**
 * The same pinned clock carrying its date, for a lone timestamp with no column
 * around it to date it — "last verified", "set at".
 */
export function localStamp(ms: number): string {
  return new Date(ms).toLocaleString('en-GB')
}

/** `29 Jul` — the same day-then-month order as `istDayLabel`'s chart axis. */
const LOCAL_DAY = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short' })

/**
 * Wall-clock time CARRYING ITS DAY, `29 Jul 10:42:15`.
 *
 * For a log that spans days — a positional book's order journal runs from the
 * day it was opened until expiry, and "10:42:15" in that table names no moment
 * at all: three weeks of entries all look like this morning's. The clock half
 * is `localTime` unchanged, so a row cannot render one format in one log and a
 * different one in another.
 *
 * `localStamp`'s `28/07/2026, 10:42:15` is the same fact and is four characters
 * longer with the month as a digit — fine for a lone timestamp in a sentence,
 * wrong for a column scanned top to bottom, where `29 Jul` is read at a glance
 * and `07` has to be counted out.
 */
export function localDayTime(ms: number): string {
  return `${LOCAL_DAY.format(new Date(ms))} ${localTime(ms)}`
}

/**
 * True when these stamps do NOT all fall on one calendar day.
 *
 * What decides whether a log's Time column carries its day. It is asked of the
 * rows on screen rather than of the book's age, so an intraday log is never
 * widened and a positional book that has only traded today is not day-stamped
 * for the sake of it — the ambiguity is what the day is spent on, and a
 * one-day log has none.
 *
 * THE SAME CLOCK THE COLUMN RENDERS IN. Comparing IST days while rendering
 * local ones would disagree for a browser outside IST, and the disagreement
 * would show up as a column that says the day when there is one day on screen.
 * Only the extremes are formatted: two days apart cannot look the same.
 */
export function spansDays(stamps: readonly number[]): boolean {
  if (stamps.length === 0) return false
  let lo = Infinity
  let hi = -Infinity
  for (const t of stamps) {
    if (!Number.isFinite(t)) continue
    if (t < lo) lo = t
    if (t > hi) hi = t
  }
  if (lo > hi) return false
  const day = (ms: number): string => new Date(ms).toLocaleDateString('en-GB')
  return day(lo) !== day(hi)
}

const IST_CLOCK = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short',
})

/**
 * Weekday, 09:15–15:30 IST — this desk's trading session.
 *
 * SHARED, because two pages had to agree about it. The Books page uses it to
 * hold the STALLED alarm outside market hours (a quiet feed at 21:00 is not a
 * fault, and an alarm that fires every night teaches an operator to ignore
 * alarms); the Strategies page uses it to say "Market closed" rather than
 * leaving a table of `waiting` rows looking like a desk that has failed to
 * start. A second copy of this rule is a second answer to "is the market open?",
 * and the two would eventually disagree on a Saturday.
 *
 * Mirrors `isMarketOpen` in `@algomaker/core`, which is what the runner gates on
 * — the browser cannot import from the server packages, so this is the same rule
 * stated in the one place the frontend can share.
 */
export function inSession(atMs: number): boolean {
  const parts = IST_CLOCK.formatToParts(new Date(atMs))
  const part = (t: string): string => parts.find((p) => p.type === t)?.value ?? ''
  if (part('weekday') === 'Sat' || part('weekday') === 'Sun') return false
  const mins = Number(part('hour')) * 60 + Number(part('minute'))
  return mins >= 9 * 60 + 15 && mins <= 15 * 60 + 30
}

export function ago(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return 'never'
  if (ms < 1000) return 'now'
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`
  return `${Math.round(ms / 60_000)}m ago`
}
