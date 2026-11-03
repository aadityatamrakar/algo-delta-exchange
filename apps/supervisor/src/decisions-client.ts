/**
 * THE SUPERVISOR'S ONE WIRE TO THE RAILS — and the three answers it must keep
 * apart (design spec §8's "fill flow", §9's contract).
 *
 * This process decides; desk-api owns the ledger, the gates and the broker.
 * `POST /v1/desk/engine/decisions` is the whole of what crosses that line, and
 * this file is the whole of this side of it. Everything here exists to make one
 * distinction the host cannot make for itself:
 *
 *   **REFUSED (4xx).** desk-api read the request and said no — a malformed
 *   package, a duplicate instrument, a browser principal, a paper contract that
 *   already has an order working. It answers `400 {error}` with NOTHING WRITTEN
 *   and NO decisionId claimed (`routes/engine.ts`), so nothing routed and
 *   nothing ever will under that id. The host rolls the decision's rule-state
 *   delta back, logs, and does not retry (spec §8: "A REFUSED (4xx) outcome is
 *   final").
 *
 *   **INDETERMINATE (5xx, a transport failure, a timeout, an unreadable body).**
 *   The answer was LOST. `applyDecision` writes its claim BEFORE the tranches go
 *   out, so a request whose response never arrived may be fully live at the
 *   broker. The host keeps the id `inFlight` and re-posts it verbatim; that is
 *   safe precisely because the unique index on `desk-decisions.decisionId`
 *   answers a replay with the ORIGINAL outcome instead of routing again.
 *
 *   **An outcome** — `DONE` / `FAILED` / `WORKING` / `ROUTING`, exactly as the
 *   endpoint decided it. This file never invents one.
 *
 * Reading either of the first two as the other is expensive in both directions.
 * A refusal read as indeterminate leaves a book holding an `inFlight` id that no
 * amount of polling will ever resolve — the supervisor stops forming packages
 * for that book for the rest of the session. An indeterminate read as a refusal
 * rolls the rule state back on a package that is at the broker right now.
 *
 * ── THE RETRY IS MODELLED ON `HttpOrderGateway` (`apps/runner/src/order-
 * gateway.ts:1311-1348`), deliberately, down to the numbers: three attempts, a
 * 200 ms pause between them, every one under the SAME id. That file is the
 * deployed statement of what a lost order response means on this desk, and a
 * second, differently-tuned answer to the same question is how two processes
 * come to disagree about whether an order is live.
 *
 * ── WHY A 200 CAN STILL BE INDETERMINATE ────────────────────────────────────
 * The endpoint answers 200 for skips and route errors alike — the body says what
 * happened to each action — so the STATUS is the outcome and the HTTP code only
 * says the request was processed. A 200 whose body is not a `DecisionResponse`,
 * or whose `decisionId` is not the one we asked about, is therefore not an
 * outcome at all: it is an answer we cannot read. Folding fills off it would
 * book another decision's trades into this book's P&L, and clearing `inFlight`
 * on it would abandon a package that is live. Both are worse than waiting.
 */

import { ENGINE_DECISIONS_PATH } from '@algomaker/desk-engine'
import type { DecisionRequest, DecisionResponse, Side, WireFill } from '@algomaker/desk-engine'

/** Attempts per post — all of them under the SAME `decisionId`. */
const ATTEMPTS = 3
/** Gap between those attempts. A lost response usually resolves on the next. */
const RETRY_DELAY_MS = 200
/**
 * The bound on ONE attempt. A desk-api that accepts the connection and never
 * answers would otherwise wedge the host's evaluation queue for the rest of the
 * session — no polls, no guard evaluation, no marks — because `evaluate()` is
 * serialised behind whatever is running. 20 s is far longer than a decision has
 * ever taken (the endpoint routes synchronously) and far shorter than a session.
 */
const TIMEOUT_MS = 20_000

/**
 * desk-api refused the request. FINAL: nothing was claimed and nothing routed.
 *
 * `body` is carried whole (truncated) because it is the only description of WHY
 * that ever exists — the endpoint's refusals are hand-written sentences naming
 * the instrument and the rule, and a host that logged only "400" would leave an
 * operator with a book that stopped trading and no way to find out why.
 */
export class RefusedError extends Error {
  readonly status: number
  readonly body: string

  constructor(status: number, body: string) {
    super(`decision refused: HTTP ${String(status)}: ${body}`)
    this.name = 'RefusedError'
    this.status = status
    this.body = body
  }
}

/**
 * WHAT AN OPERATOR SHOULD DO ABOUT THIS REFUSAL — because the answers differ so
 * much that one message for all of them is no message at all.
 *
 * Every 4xx is final for its decisionId, but only some of them are ABOUT the
 * decision. A 400 is desk-api reading the package and refusing it on its merits:
 * one book, one intent, and the body says which rule. A 404, a 401 or a 405 is a
 * DEPLOYMENT FAULT — the endpoint is not there, the token is wrong, the URL is
 * pointing at the wrong process — and it will refuse every package for every
 * book until somebody fixes it, silently, because each individual refusal looks
 * exactly like a book that had nothing to do.
 *
 * A 429 is the third shape: nothing is wrong with the package and nothing is
 * wrong with the deployment. The supervisor's own `cooldown_s` is the backoff —
 * a refused intent that is still true re-forms under a NEW id after it — so the
 * honest instruction is "leave it alone", not "retry".
 */
export function refusalGuidance(status: number): string {
  if (status === 401 || status === 403) {
    return (
      'DEPLOYMENT FAULT: desk-api would not authenticate this supervisor. Check DESK_API_TOKEN ' +
      'and that the endpoint sees a MACHINE principal — every book is refused until it does.'
    )
  }
  if (status === 404 || status === 405) {
    return (
      'DEPLOYMENT FAULT: there is no engine decision endpoint at this URL. Check DESK_API_URL ' +
      'and that desk-api is on a build that carries it — every book is refused until it is.'
    )
  }
  if (status === 429) {
    return 'rate limited — cooldown_s is the backoff; the intent re-forms under a new id if it is still true'
  }
  return 'desk-api refused this package on its merits — the body names the rule; the rule state is rolled back to the mark'
}

/**
 * The client as the host depends on it — one method, so a test fakes it in four
 * lines and the host never reaches for `fetch` itself.
 */
export interface DecisionsPort {
  submit(req: DecisionRequest): Promise<DecisionResponse | 'INDETERMINATE'>
}

export interface DecisionsClientOptions {
  /** Injected by the tests. Defaults to the global `fetch`. */
  readonly fetch?: typeof globalThis.fetch | undefined
  readonly timeoutMs?: number | undefined
  readonly retryDelayMs?: number | undefined
  readonly attempts?: number | undefined
  /** Named so a lost answer is visible in the log, not only in its effect. */
  readonly log?: ((msg: string, ctx?: Record<string, unknown>) => void) | undefined
}

const STATUSES = new Set(['DONE', 'FAILED', 'ROUTING', 'WORKING'])
const SIDES = new Set(['Buy', 'Sell'])

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * A fill, read back defensively.
 *
 * `null` for a row that is not a fill — dropped rather than zero-filled,
 * because every field of it is arithmetic the host is about to do on real
 * money: a `qty` that is not a number folds `NaN` into `cumRealized`, and every
 * later comparison against it is false, silently.
 */
function readFill(raw: unknown): WireFill | null {
  if (!isObject(raw)) return null
  const instrument = raw['instrument']
  const side = raw['side']
  const qty = raw['qty']
  const price = raw['price']
  if (typeof instrument !== 'string' || instrument === '') return null
  if (typeof side !== 'string' || !SIDES.has(side)) return null
  if (typeof qty !== 'number' || !Number.isFinite(qty)) return null
  if (typeof price !== 'number' || !Number.isFinite(price)) return null
  return {
    instrument,
    side: side as Side,
    qty,
    price,
    ...(raw['resting'] === true ? { resting: true } : {}),
  }
}

/**
 * The body as a `DecisionResponse`, or `null` when it is not one.
 *
 * The arrays are rebuilt rather than trusted: they are walked by the fold, and
 * a missing one is a desk-api that predates the field rather than a reason to
 * throw inside the host's evaluation queue.
 */
function readResponse(raw: unknown, decisionId: string): DecisionResponse | null {
  if (!isObject(raw)) return null
  if (raw['decisionId'] !== decisionId) return null
  const status = raw['status']
  if (typeof status !== 'string' || !STATUSES.has(status)) return null
  const fills: WireFill[] = []
  for (const row of Array.isArray(raw['fills']) ? raw['fills'] : []) {
    const fill = readFill(row)
    if (fill !== null) fills.push(fill)
  }
  const skips: { instrument: string; reason: string }[] = []
  for (const row of Array.isArray(raw['skips']) ? raw['skips'] : []) {
    if (!isObject(row)) continue
    skips.push({ instrument: String(row['instrument'] ?? ''), reason: String(row['reason'] ?? '') })
  }
  const routeErrors = (Array.isArray(raw['routeErrors']) ? raw['routeErrors'] : []).map((e) =>
    String(e),
  )
  return {
    decisionId,
    replayed: raw['replayed'] === true,
    status: status as DecisionResponse['status'],
    fills,
    skips,
    routeErrors,
  }
}

export class DecisionsClient implements DecisionsPort {
  readonly #url: string
  readonly #token: string
  readonly #fetch: typeof globalThis.fetch
  readonly #timeoutMs: number
  readonly #retryDelayMs: number
  readonly #attempts: number
  readonly #log: (msg: string, ctx?: Record<string, unknown>) => void

  constructor(baseUrl: string, token: string, opts: DecisionsClientOptions = {}) {
    // Trailing slashes are the ordinary shape of a hand-set env var, and
    // `//v1/...` is a 404 that reads as "desk-api refused the decision".
    this.#url = `${baseUrl.replace(/\/+$/, '')}${ENGINE_DECISIONS_PATH}`
    this.#token = token
    this.#fetch = opts.fetch ?? globalThis.fetch
    this.#timeoutMs = opts.timeoutMs ?? TIMEOUT_MS
    this.#retryDelayMs = opts.retryDelayMs ?? RETRY_DELAY_MS
    this.#attempts = opts.attempts ?? ATTEMPTS
    this.#log = opts.log ?? ((): void => undefined)
  }

  /**
   * Post one decision. Throws `RefusedError` and NOTHING ELSE — every other
   * failure is `'INDETERMINATE'`, because the host's only safe response to an
   * unknown outcome is to keep the id and ask again.
   */
  async submit(req: DecisionRequest): Promise<DecisionResponse | 'INDETERMINATE'> {
    const body = JSON.stringify(req)
    let lastError = ''

    for (let attempt = 1; attempt <= this.#attempts; attempt++) {
      try {
        const { status, text } = await this.#post(body)
        if (status >= 400 && status < 500) throw new RefusedError(status, text.slice(0, 500))
        if (status !== 200) {
          lastError = `HTTP ${String(status)}: ${text.slice(0, 200)}`
        } else {
          let parsed: unknown = null
          try {
            parsed = JSON.parse(text)
          } catch {
            parsed = null
          }
          const response = readResponse(parsed, req.decisionId)
          if (response !== null) return response
          // A 200 we cannot read is not an outcome — see the header. Retried
          // like any lost answer, and INDETERMINATE if it stays unreadable.
          lastError = `unreadable 200 for ${req.decisionId}: ${text.slice(0, 200)}`
        }
      } catch (err) {
        if (err instanceof RefusedError) throw err
        lastError = err instanceof Error ? err.message : String(err)
      }
      if (attempt < this.#attempts) await this.#pause()
    }

    this.#log('decision outcome UNKNOWN — keeping the id and replaying it', {
      decisionId: req.decisionId,
      tag: req.tag,
      mode: req.mode,
      error: lastError,
    })
    return 'INDETERMINATE'
  }

  /**
   * One attempt, bounded. The abort timer is `unref`'d so a pending post is
   * never the reason a shutdown waits.
   */
  async #post(body: string): Promise<{ status: number; text: string }> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs)
    timer.unref?.()
    try {
      const res = await this.#fetch(this.#url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.#token}`,
        },
        body,
        signal: controller.signal,
      })
      return { status: res.status, text: await res.text() }
    } finally {
      clearTimeout(timer)
    }
  }

  async #pause(): Promise<void> {
    if (this.#retryDelayMs <= 0) return
    await new Promise((resolve) => setTimeout(resolve, this.#retryDelayMs))
  }
}
