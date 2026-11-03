/**
 * The unauthenticated surface: liveness and feed readiness.
 *
 * Both are deliberately open. A health check that needs a secret is one more
 * thing to get wrong in a pm2 restart loop, and feed readiness carries no
 * position or price detail — only counts and a boolean.
 *
 * THAT LAST SENTENCE IS A CONSTRAINT, NOT A DESCRIPTION. It was untrue: the
 * response listed every book by SYMBOL, with its leg count, to anyone who could
 * reach the port. What the desk is positioned in is the single most valuable
 * thing this API knows, so what leaves here is counted, never named.
 */

import { fixedClock, isMarketOpen } from '@algomaker/core'
import type { ApiDeps, Route, RouteCtx } from './kit.ts'

/**
 * How long a computed book summary may be reused.
 *
 * `service.books()` runs a FULL GREEKS COMPUTATION per book — Black-Scholes per
 * leg — and this endpoint is unauthenticated and unrated. Recomputing it per
 * request makes an open port an arbitrarily expensive one; anyone who can reach
 * it can pin a core. Readiness is a 60-90 second warm-up question, so answering
 * it from a value up to a few seconds old costs nothing real and bounds the work
 * at one computation per window however many callers arrive.
 */
const BOOKS_TTL_MS = 3_000

export function healthRoutes(deps: ApiDeps): Route {
  type BookSummary = Awaited<ReturnType<ApiDeps['service']['books']>>
  let cached: { at: number; value: BookSummary } | null = null
  // Concurrent callers share the ONE in-flight computation rather than each
  // starting their own — otherwise a burst defeats the cache entirely.
  let inflight: Promise<BookSummary> | null = null

  const booksSnapshot = async (): Promise<BookSummary> => {
    const fresh = cached !== null && deps.now() - cached.at < BOOKS_TTL_MS
    if (fresh && cached !== null) return cached.value
    inflight ??= deps.service.books('paper').then(
      (value) => {
        cached = { at: deps.now(), value }
        inflight = null
        return value
      },
      (err: unknown) => {
        inflight = null
        throw err
      },
    )
    return await inflight
  }

  return async (ctx: RouteCtx): Promise<boolean> => {
    if (ctx.path === '/health' && ctx.method === 'GET') {
      ctx.send(200, { ok: true })
      return true
    }

    /**
     * Feed readiness.
     *
     * Measured on the live BHEL chain: after a restart it takes 60-90 SECONDS
     * for every subscribed contract to tick once, because far strikes trade
     * rarely. Until then an action on a not-yet-ticked strike is skipped as "no
     * mark" — correct (we will not invent a price) but indistinguishable, from
     * the desk's side, from a strike that does not exist. So the desk needs to
     * be able to ask whether we are warm before it acts.
     */
    if (ctx.path === '/v1/desk/feed' && ctx.method === 'GET') {
      const m = deps.marks
      const held = m?.size ?? 0
      const subscribed = deps.feedState?.subscribedTokens ?? 0
      // Coverage, not merely "some marks arrived". 6 of 72 strikes marked is not
      // ready: an action on any of the other 66 is skipped as "no mark".
      const coverage = subscribed > 0 ? held / subscribed : 0
      // Chain coverage PLATEAUS around 90% on the live BHEL chain — roughly
      // seven far strikes never trade at all, so a chain-wide threshold is
      // unreachable and the wrong bar anyway. What decides whether the desk can
      // act is narrower: are the legs it actually HOLDS marked. An action on
      // some other strike is skipped with an explicit reason.
      const books = await booksSnapshot()
      const incomplete = books.filter((b) => !b.complete).length
      const feedAlive = m?.feedAlive() ?? false
      /**
       * NO BOOK IS NOT UNREADY.
       *
       * `ready` was `books.length > 0 && every(complete)`, so on the first paper
       * day — before the desk has opened anything — it was FALSE FOREVER beside
       * a perfectly healthy feed. `docs/DEPLOYMENT.md` §9 tells the operator to
       * poll exactly this field to decide the system came up, so the documented
       * smoke test could never pass on a fresh deployment.
       *
       * Readiness asks "can the desk act on what it holds?". Holding nothing
       * answers that vacuously YES: there is no leg whose mark is missing. The
       * feed still has to be alive, because a dead feed refuses every order.
       */
      ctx.send(200, {
        feedAlive,
        marksHeld: held,
        cachedMarks: m?.cachedCount ?? 0,
        subscribedTokens: subscribed,
        coverage: Number(coverage.toFixed(3)),
        staleMarks: m?.staleCount() ?? 0,
        msSinceLastTick: m?.ageOfNewestTick() ?? null,
        /**
         * COUNTS ONLY, under NEW NAMES. Naming the symbols told an
         * unauthenticated caller what the desk is positioned in; the counts
         * answer the readiness question just as well, and `/v1/desk/books`
         * carries the detail behind auth.
         *
         * The old `books` key is GONE rather than redefined as a number. A
         * client still reading it gets `undefined`, which its own `?? []`
         * renders as an empty list — the detail simply disappears. Reusing the
         * key for a scalar would instead hand `.map` a number and crash the page
         * that was merely out of date.
         */
        bookCount: books.length,
        booksIncomplete: incomplete,
        ready: feedAlive && incomplete === 0,
        /**
         * WAS THE MARKET OPEN when this was answered. PRESENTATION ONLY.
         *
         * It changes nothing here: `feedAlive` is still the measured value and
         * `ready` is still `feedAlive && incomplete === 0`, because `ready` is
         * what `docs/DEPLOYMENT.md` §9 polls to decide a deployment came up —
         * softening it on a Saturday would let that smoke test pass against a
         * bridge that cannot price anything.
         *
         * What it buys is on the page: a silent feed at 11:00 on a Saturday is
         * how a shut market looks, and rendering that as "Feed is down" in red
         * every weekend is how an operator learns to ignore the colour red.
         * `isMarketOpen` from `@algomaker/core` is the one server-side session
         * rule — the runner gates on the same function — asked about THIS
         * route's clock rather than wall time, so a test can drive it.
         */
        sessionOpen: isMarketOpen(fixedClock(deps.now())),
      })
      return true
    }

    return false
  }
}
