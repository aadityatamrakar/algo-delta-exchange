/**
 * Zerodha's basket-margin endpoint — the computation behind the Kite margin
 * calculator, which is the number an operator compares against.
 *
 * HOST IS PINNED TO `kite.zerodha.com/oms`. `api.kite.trade` serves the same
 * route but rejects an enctoken with a 400 (measured 2026-08-04); it wants a
 * Kite Connect `api_key`/`access_token`, which this desk does not have. Any
 * "fallback host" here would be a fallback to a guaranteed failure.
 *
 * `final`, NEVER `initial`. `initial` is the pre-hedge-benefit figure — on the
 * live DLF book it was 5,92,895 against `final`'s 2,26,004, 2.6x larger. The
 * whole point of this feature is that the operator was reading a number that
 * did not describe their book; shipping `initial` would repeat that in a new
 * place. See the spec's D5 and the fixture test that locks it.
 */
import type { BasketOrder } from './basket.ts'
import { isKiteAuthFailure } from '../kite-auth.ts'

/**
 * `consider_positions=false` IS DELIBERATE AND MUST STAY.
 *
 * The flag nets the basket against positions held in the KITE account we
 * authenticate as — IJ0574, the feed account. The desk's legs live at Jainam
 * under `PRO111`, which Zerodha has never seen, so there is nothing there to
 * net against and the flag cannot improve accuracy. Measured 2026-08-04: both
 * settings return byte-identical figures.
 *
 * It is a no-op only for as long as IJ0574 holds no Zerodha F&O. The day
 * someone takes a position in that account — a manual trade, a test — `true`
 * would silently net every book's margin against unrelated legs, with no error
 * raised and no way to see it on the tile. `false` keeps the figure a property
 * of the book rather than of whatever else is in the feed account.
 *
 * `true` answers a different question anyway ("what does ADDING this cost"),
 * which would need the Kite account to mirror the real book to mean anything.
 */
const BASKET_URL = 'https://kite.zerodha.com/oms/margins/basket?consider_positions=false'

export interface MarginQuote {
  readonly span: number
  readonly exposure: number
  /** Net premium: positive when the book RECEIVES premium. */
  readonly premium: number
  /**
   * Premium DEBITED for the long legs — `initial.option_premium`, which is the
   * gross buy-side premium before any sell credit nets against it.
   *
   * It is carried because the BROKER BLOCKS IT AS MARGIN. Zerodha's calculator
   * excludes it from "Total margin", but the XTS account's `MarginUsed` is
   * `span + exposure + this`, exact to the paisa. A tile that omits it
   * understates what holding the book actually costs.
   */
  readonly premiumPaid: number
  /** `span + exposure` — what the Kite calculator prints as "Total margin". */
  readonly total: number
  readonly legs: readonly MarginLeg[]
}

export interface MarginLeg {
  readonly tradingsymbol: string
  readonly span: number
  readonly exposure: number
  readonly total: number
}

/** The one networked seam, so everything above it is testable without a socket. */
export interface KiteMarginClient {
  basketMargin(orders: readonly BasketOrder[]): Promise<MarginQuote>
}

function num(v: unknown): number {
  const n = typeof v === 'string' ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) ? n : 0
}

/**
 * Parse a basket reply. Exported so the fixture test can assert the
 * `final`-not-`initial` choice against a real recorded response.
 *
 * Throws rather than returning zeros when `final` is missing: a book that
 * genuinely needs no margin still returns the block with zeros in it, so an
 * absent block means the shape changed, and a silent 0 would read on the tile
 * as "this book is free to hold".
 */
export function parseBasketReply(body: unknown): MarginQuote {
  const data = (body as { data?: Record<string, unknown> } | null)?.data
  const final = data?.['final'] as Record<string, unknown> | undefined
  if (final === undefined || typeof final !== 'object') {
    throw new Error('basket margin reply carried no `data.final` block')
  }
  const initial = data?.['initial'] as Record<string, unknown> | undefined
  const span = num(final['span'])
  const exposure = num(final['exposure'])
  /**
   * `initial.option_premium` is the LONG-leg debit, before the short credit
   * nets against it — verified against the live DLF book, where it was 34,675
   * and the two long legs were 18,762.50 + 15,912.50. The one field from
   * `initial` this reads; everything else comes from `final`.
   */
  const premiumPaid = initial === undefined ? 0 : Math.max(0, num(initial['option_premium']))
  const orders = Array.isArray(data?.['orders']) ? (data['orders'] as Record<string, unknown>[]) : []
  return {
    span,
    exposure,
    // Kite reports premium from the ACCOUNT's side: negative when premium is
    // received. The desk reads "premium received" as a positive credit, so the
    // sign flips here rather than in the tile.
    premium: -num(final['option_premium']),
    premiumPaid,
    total: span + exposure,
    legs: orders.map((o) => ({
      tradingsymbol: String(o['tradingsymbol'] ?? ''),
      span: num(o['span']),
      exposure: num(o['exposure']),
      total: num(o['total']),
    })),
  }
}

/**
 * Has Kite rejected the SESSION, as opposed to failing for any other reason?
 *
 * ONE LINE, because the answer is shared: `kite-auth.ts` holds it, and
 * `history.ts` — the other REST consumer of the same enctoken, and the one the
 * enctoken canary classifies through — asks the identical question there. They
 * used to answer it separately and had drifted in opposite directions, this one
 * too WIDE and that one too NARROW, so the desk could miss an outage and spend
 * logins on a non-outage in the same session.
 *
 * WHAT THE LOCAL VERSION GOT WRONG. It was `401 || TokenException || (403 &&
 * /token/i)`. The last arm reads an ENTITLEMENT 403 that merely mentions a
 * token — "your access_token is not permitted on this route" — as session
 * death, and no login fixes an entitlement: `checkSession` finds the cookie jar
 * perfectly healthy, hands back the SAME enctoken, and the retry earns an
 * identical 403. One real password+TOTP login per book per sweep, indefinitely,
 * against a live trading account. The shared classifier keeps the widening that
 * mattered (`SessionException`, the login page, a bare 401) and excludes the
 * entitlement wordings that made it dangerous.
 *
 * KEPT AS AN EXPORT with its original signature: the widening is asserted
 * directly in the tests rather than inferred from a retry count.
 */
export function isTokenRejection(status: number, body: string): boolean {
  return isKiteAuthFailure({ status, body })
}

export function createKiteMarginClient(opts: {
  /** Read fresh on EVERY call — the pool rotates the token on reconnect. */
  readonly enctoken: () => string
  /**
   * Kite rejected the enctoken: re-login and rotate it, then this retries once.
   *
   * WHY THE REST PATH NEEDS ITS OWN TRIGGER (the 2026-08-05 outage). An
   * established websocket SURVIVES its enctoken being invalidated — that is
   * documented on `KiteFeedPool.reconnect`, which for the same reason leaves
   * connected sockets alone. So when a second IJ0574 login killed the token,
   * the feed kept streaming, `FeedRecovery` — which triggers on feed DEATH —
   * never fired, and every basket call 403'd for a whole session while the
   * tile aged and the dashboard looked healthy.
   *
   * A LIVE FEED IS NOT EVIDENCE OF A LIVE SESSION. This call is the only thing
   * that exercises the token over REST, so it is the only thing that can
   * notice, and it has to be able to say so.
   *
   * RESOLVES TRUE ONLY IF THE TOKEN ACTUALLY ROTATED. Recovery can decline to
   * act — its backoff is shut, or the login itself failed — and both leave the
   * enctoken exactly as it was. Reporting that honestly is what stops the
   * retry below re-sending a token that was just rejected.
   *
   * Optional: absent, a rejection throws exactly as it did before. Callers
   * wire it to `FeedRecovery.trigger`, whose own per-fault backoff does the
   * pacing — nothing here needs to pace itself.
   */
  readonly onAuthFailure?: () => Promise<boolean>
  /**
   * A call SUCCEEDED on the token currently held.
   *
   * The counterpart to `onAuthFailure`, and the only proof a session is live:
   * this is the one thing in the process that exercises the enctoken over
   * REST, so it is also the only thing that can clear a token fault. Without
   * it, recovery could never tell a rotation that worked from one that was
   * killed again a second later.
   */
  readonly onTokenAccepted?: () => void
  /** Bounds ONE attempt, not the whole call — a retry pays it again. */
  readonly timeoutMs?: number
  readonly fetchImpl?: typeof fetch
}): KiteMarginClient {
  const doFetch = opts.fetchImpl ?? fetch

  /** One attempt. Returns the parsed quote, or the raw failure for the caller to judge. */
  async function attempt(
    orders: readonly BasketOrder[],
  ): Promise<{ ok: true; quote: MarginQuote } | { ok: false; status: number; text: string }> {
    const token = opts.enctoken()
    if (token === '') throw new Error('no enctoken held — the feed has not logged in yet')
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 15_000)
    try {
      const res = await doFetch(BASKET_URL, {
        method: 'POST',
        headers: {
          authorization: `enctoken ${token}`,
          'content-type': 'application/json',
          'x-kite-version': '3',
        },
        body: JSON.stringify(orders),
        signal: ctl.signal,
      })
      const text = await res.text()
      if (!res.ok) return { ok: false, status: res.status, text }
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        /**
         * A 2xx WHOSE BODY IS NOT JSON IS STILL A FAILURE, and it has to reach
         * the caller's classification rather than throwing a SyntaxError past
         * it. `kite.zerodha.com` is the WEB host, and a web host answers a
         * dead session with a login PAGE — a 200 carrying HTML. Letting that
         * escape as "Unexpected token '<'" is how a token death would go
         * unnoticed a second time, in a new disguise.
         */
        return { ok: false, status: res.status, text }
      }
      return { ok: true, quote: parseBasketReply(parsed) }
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    async basketMargin(orders) {
      if (orders.length === 0) throw new Error('basket margin called with no orders')

      const first = await attempt(orders)
      if (first.ok) {
        opts.onTokenAccepted?.()
        return first.quote
      }

      const retryable = opts.onAuthFailure !== undefined && isTokenRejection(first.status, first.text)
      if (!retryable) {
        throw new Error(`basket margin HTTP ${String(first.status)}: ${first.text.slice(0, 200)}`)
      }

      /**
       * Rotate the token, then try again ONCE — and only if it really rotated.
       *
       * `onAuthFailure` RESOLVING IS NOT PROOF OF A NEW TOKEN. Recovery
       * answers 'gated' while its backoff is shut and 'failed' when the login
       * broke, and both leave the enctoken untouched; retrying on those
       * re-sends the token that was just rejected and then reports a re-login
       * that never happened — which is the sentence an operator reads off the
       * tile's `diagnostic` while deciding whether the credentials are broken.
       *
       * Exactly once, never a loop. A rotation followed by a second rejection
       * means the fresh session was killed too, and the honest move is to fail
       * this refresh, leave the tile showing its last good figure with an
       * ageing `asOf` (see `refresh.ts`), and let the next SPAN slot try again.
       */
      const rotated = await opts.onAuthFailure()
      if (!rotated) {
        throw new Error(
          `basket margin HTTP ${String(first.status)} — the enctoken was rejected and NO fresh login was available (recovery gated or failed): ${first.text.slice(0, 200)}`,
        )
      }
      const second = await attempt(orders)
      if (second.ok) {
        opts.onTokenAccepted?.()
        return second.quote
      }
      throw new Error(
        `basket margin HTTP ${String(second.status)} after re-login: ${second.text.slice(0, 200)}`,
      )
    },
  }
}
