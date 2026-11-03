/**
 * `GET /v1/desk/positions/compare` — the broker, `desk-books` and the runner's
 * ledgers, side by side (audit roadmap 16).
 *
 * SERVED FROM THE LAST PASS, not computed per request. The comparison runs on
 * its own cadence (`DESK_POSITIONS_COMPARE_MS`) and this route hands back what
 * it produced, with the report's own `asOf` on it: a dashboard poll must not be
 * able to make three collection scans happen at whatever rate a browser feels
 * like. `?recompute=1` is the deliberate exception, for an operator who has
 * just changed something and wants the answer now — and it is a REQUEST, in
 * both directions: it is declined when the stored report is seconds old
 * (`RECOMPUTE_FLOOR_MS`), and a pass that FAILS still answers with the last
 * report rather than a 500. Either way the payload says what happened to the
 * attempt (`recomputed`, `recomputeError`, `recomputeNote`), so a caller can
 * never mistake a report from before a failed refresh for a fresh one.
 *
 * OPERATOR AND MACHINE BOTH. "Do my three records of this account agree?" is a
 * question a monitor should be able to ask without a browser session, which is
 * the same reasoning `routes/system.ts` states for itself. It is a READ — there
 * is nothing here that changes anything, in this file or behind it.
 *
 * WHAT THE ANSWER MEANS is in `positions-compare.ts`'s header and repeated in
 * the payload: `comparable: false` means NO VERDICT (and `divergent` is then
 * empty by construction, not by luck), and `unattributable` is a neutral
 * statement about broker rows the desk does not claim — routinely a manual
 * trade or another system on the same account, never on its own a fault.
 */

import type { PositionsCompareReport, PositionsComparer } from '../positions-compare.ts'
import type { ApiDeps, Route, RouteCtx } from './kit.ts'

/** The comparer `main.ts` also drives on the interval — one instance, one flight. */
type PositionsDeps = ApiDeps & { readonly compare: PositionsComparer }

/**
 * How fresh a stored report has to be for `?recompute=1` to be answered with it.
 *
 * A pass is THREE COLLECTION READS, and this is the one route that can trigger
 * one on demand — reachable by anything holding a session, including a
 * dashboard tab someone left open on the page and an operator clicking twice.
 * Five seconds is far below the 5-minute cadence and far above a double click,
 * so nothing an operator would notice is refused and nothing repeats the scans
 * for an answer that has not had time to change.
 */
export const RECOMPUTE_FLOOR_MS = 5_000

export function positionsRoutes(deps: PositionsDeps): Route {
  return async (ctx: RouteCtx): Promise<boolean> => {
    if (ctx.path !== '/v1/desk/positions/compare' || ctx.method !== 'GET') return false

    const recompute = ctx.url.searchParams.get('recompute') === '1'
    /**
     * A recompute that lands on a pass already in flight answers `null` — the
     * comparer is single-flight — and the correct response is the LAST report,
     * not an error and not a second pass. So the recompute is a request, and
     * the answer is whatever the freshest report is either way.
     *
     * WHICH IS ALSO TRUE WHEN THE PASS THROWS, and that is the reason for the
     * try/catch rather than tidiness. Those three reads hit the database at the
     * moment it is most likely to be struggling — which is exactly the moment
     * an operator asks this question — and an unguarded `await` turned that
     * into a 500 that took the LAST REPORT down with it: the answer the route
     * already had, dated and honest, thrown away because a refresh of it
     * failed. The failure is reported IN the payload instead, so a caller can
     * see that what it holds is from before the attempt.
     */
    let recomputed = false
    let recomputeError = ''
    let recomputeNote = ''
    let report = await lastQuietly(deps, ctx)
    if (recompute) {
      /**
       * THE FRESHNESS FLOOR. A report seconds old is the report a new pass
       * would produce, and this endpoint is the only way to make three
       * collection scans happen on demand — so inside the floor the stored one
       * is served and the scans are not paid for. `ageMs >= 0` because a clock
       * that went backwards must fall through to a real pass rather than pin
       * the route to a report from the future.
       */
      const ageMs = report === null ? null : deps.now() - report.asOf
      if (ageMs !== null && ageMs >= 0 && ageMs < RECOMPUTE_FLOOR_MS) {
        recomputeNote =
          `the stored report is ${Math.round(ageMs / 1000)}s old, inside the ${
            RECOMPUTE_FLOOR_MS / 1000
          }s floor — it is served as it stands rather than recomputed, because a pass this ` +
          'soon would read the same three collections for the same answer'
      } else {
        try {
          // `null` means a pass was already in flight and this one did nothing —
          // not a failure, and not a recompute either. Both are said plainly.
          const fresh = await deps.compare.run(deps.now())
          recomputed = fresh !== null
          if (fresh === null) {
            recomputeNote =
              'a pass was already in flight, so this request did not start a second one — ' +
              'the report below is whichever is freshest'
          }
        } catch (err) {
          recomputeError = err instanceof Error ? err.message : String(err)
          ctx.log('positions compare: an on-demand recompute failed — serving the last report', {
            error: recomputeError,
          })
        }
        report = await lastQuietly(deps, ctx)
      }
    }
    /** Said only when a recompute was asked for — silence elsewhere means nothing was attempted. */
    const attempt = recompute
      ? {
          recomputed,
          ...(recomputeError === '' ? {} : { recomputeError }),
          ...(recomputeNote === '' ? {} : { recomputeNote }),
        }
      : {}

    if (report === null) {
      /**
       * 200, not 404. "No comparison has run yet" is a state to render — the
       * normal one for the first interval after a restart — and nothing is
       * invented while it is true.
       */
      ctx.send(200, {
        available: false,
        ...attempt,
        reason:
          'no positions comparison has run yet — the pass runs on DESK_POSITIONS_COMPARE_MS ' +
          '(5 minutes by default) and publishes its first report one interval after this ' +
          'process starts; ?recompute=1 forces one now',
      })
      return true
    }

    ctx.send(200, {
      available: true,
      ageMs: deps.now() - report.asOf,
      ...attempt,
      report,
      /**
       * Said in the payload as well as in this file, because the machine
       * reading it is the one most likely to act on a bare `divergent` array.
       */
      note:
        'report only — nothing here repairs anything. `comparable: false` means no comparison ' +
        'was performed and no row disagrees with anything; `unattributable` lists broker ' +
        'positions no desk book or runner ledger claims, which is a fact to look at rather ' +
        'than a fault.',
    })
    return true
  }
}

/**
 * The last report, or null — never a rejection.
 *
 * `last()` reads the stored document when this process has not run a pass of
 * its own, which is precisely the state a just-restarted bridge is in, and a
 * database that cannot answer it is the same database the recompute just failed
 * against. "I have nothing to show you" is a state this route already renders;
 * a 500 is not.
 */
async function lastQuietly(
  deps: PositionsDeps,
  ctx: RouteCtx,
): Promise<PositionsCompareReport | null> {
  try {
    return await deps.compare.last()
  } catch (err) {
    ctx.log('positions compare: the last report could not be read', {
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}
