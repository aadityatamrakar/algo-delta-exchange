/**
 * "No Mongo" is a legitimate skip on a laptop and a LIE in CI (audit F-48).
 *
 * Five suites in this directory — auth routes, books registry, brokers, the
 * HTTP server and the service integration — need a real MongoDB, and each one
 * skips itself when it cannot connect. That is right for `npm test` on a
 * machine without docker. It is wrong everywhere the database is supposed to be
 * there: `npm run test:node` exits 0 with **165 skipped**, and the skipped set
 * is exactly the tests that prove the money-path gates hold — including
 * "bulk ON in LIVE needs the password". A green run that proved none of that is
 * worse than a red one, because it is indistinguishable from a run that did.
 *
 * `DESK_REQUIRE_MONGO=1` therefore turns the skip into a FAILURE. CI sets it
 * (`.github/workflows/check.yml`, which stands a `mongo:8` service container
 * up), and anyone can set it locally to prove their run was real.
 *
 * The suites choose their own URL — `DESK_TEST_MONGO`, else a per-suite
 * database on `mongodb://127.0.0.1:27017`. The per-suite default is load
 * bearing: node:test runs files in parallel processes and each of these wipes
 * its collections between tests, so pointing them all at ONE database would
 * have them deleting each other's fixtures. Set `DESK_TEST_MONGO` only to move
 * the HOST, and only when running one file.
 */

import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * DEFENSE IN DEPTH: every Mongo-backed api test imports this module, so this
 * is the one place that runs before all of them.
 *
 * `notifySupervisor` (`../src/engine-notify.ts`) resolves the supervisor's
 * port from `DESK_SUPERVISOR_PORT` per call and, when that is unset, falls
 * back to 8893 — the REAL desk-supervisor's port. A test file that drives the
 * registry, dials or paper-fold routes without starting a
 * `startNudgeSink()` (`./nudge-sink.ts`) would otherwise nudge the live
 * supervisor with no bearer token, one refusal logged per call. That is
 * exactly what audit.test.ts, delta-lean-registration.test.ts,
 * delta-lean-roll.test.ts and paper-stamp.test.ts did — 107 refusals per api
 * suite run.
 *
 * So: if `DESK_SUPERVISOR_PORT` is not currently a usable port, point it at a
 * loopback port that is guaranteed to have nothing listening, so a stray
 * nudge fails fast with ECONNREFUSED instead of reaching 8893. "Usable" is
 * checked the same way `envPort()` in `engine-notify.ts` checks it —
 * `Number.isInteger(raw) && raw > 0` — and deliberately MIRRORS it rather
 * than only testing `=== undefined`: `envPort()` treats an EMPTY STRING or
 * `"0"` as unset too and falls back to the 8893 default regardless, so a
 * shell that exports `DESK_SUPERVISOR_PORT=` blank (rather than leaving it
 * unset) would skip a guard that only checked `undefined` and reach the live
 * supervisor again. `0` does not work as the installed value either, for the
 * same reason — it would round-trip back through `envPort()` as "unset". The
 * safe way to get a real, currently-unused port number is to bind a
 * throwaway server on port 0, read what the OS handed it, and close it again
 * immediately; the OS will not reuse that number right away.
 *
 * A test that starts its own `startNudgeSink()` overwrites this value in its
 * `before()`, and that sink's `close()` restores exactly the value read here
 * — whatever it is, including an empty string — never deleting it unless it
 * truly was `undefined`. The two are written to agree, so suites can run one
 * after another in the same process without either leaking into the next.
 */
async function throwawayPort(): Promise<number> {
  const probe = createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const port = (probe.address() as AddressInfo).port
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  return port
}

/** Exactly `envPort()`'s own test for "is this a port I can use?". */
function isUsablePort(raw: string | undefined): boolean {
  const n = Number(raw ?? '')
  return Number.isInteger(n) && n > 0
}

/**
 * THE DELTA CLONE'S EXTRA GUARD. This checkout shares a box with the live NSE
 * desk, whose processes listen on 8790-8799. A shell that exports the live
 * desk's `DESK_SUPERVISOR_PORT` passes `isUsablePort()` and would point every
 * stray nudge at the live supervisor, so a port in that range is replaced too.
 */
function isLiveDeskPort(raw: string | undefined): boolean {
  const n = Number(raw ?? '')
  return n >= 8790 && n <= 8799
}

if (!isUsablePort(process.env['DESK_SUPERVISOR_PORT']) || isLiveDeskPort(process.env['DESK_SUPERVISOR_PORT'])) {
  process.env['DESK_SUPERVISOR_PORT'] = String(await throwawayPort())
}

/**
 * Every test database in this clone is `algomaker_dx_*`, and so must any URL a
 * shell hands in through `DESK_TEST_MONGO` (or a per-suite `DESK_TEST_MONGO_*`).
 * Anything else is the live desk's `algomaker`, this clone's own desk database
 * `algomaker_dx`, or one of the live repo's test databases — and each of these
 * suites wipes its collections. Refused at import, before any suite connects.
 */
export function assertCloneTestDb(name: string, url: string): void {
  let db = ''
  try {
    db = new URL(url).pathname.replace(/^\//, '')
  } catch {
    throw new Error(`${name} is not a Mongo URL`)
  }
  if (!db.startsWith('algomaker_dx_')) {
    throw new Error(`${name} names database "${db}" — the Delta clone's tests only use algomaker_dx_* databases`)
  }
}

for (const [name, url] of Object.entries(process.env)) {
  if (name.startsWith('DESK_TEST_MONGO') && url !== undefined && url !== '') assertCloneTestDb(name, url)
}

/** The `t` of a `node:test` callback, narrowed to what this needs. */
export interface Skippable {
  skip(message?: string): void
}

/**
 * Skip the test — unless `DESK_REQUIRE_MONGO=1`, in which case THROW.
 *
 * Called from inside the test body rather than at registration time, because
 * `available` is only known after `before()` has run, which is after every
 * `test()` call has been registered.
 */
export function skipUnlessMongo(t: Skippable, detail = ''): void {
  if ((process.env['DESK_REQUIRE_MONGO'] ?? '') === '1') {
    throw new Error(
      'Mongo required but unreachable — DESK_REQUIRE_MONGO=1 forbids skipping this suite ' +
        `(URL from DESK_TEST_MONGO, else the suite's own 127.0.0.1:27017 database)${
          detail === '' ? '' : `: ${detail}`
        }`,
    )
  }
  t.skip('no MongoDB reachable')
}
