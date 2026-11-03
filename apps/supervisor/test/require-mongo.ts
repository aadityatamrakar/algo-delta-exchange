/**
 * "No Mongo" is a legitimate skip on a laptop and a LIE in CI (audit F-48).
 *
 * BOTH suites in this directory are database suites and nothing else: the
 * state store's compare-and-set and the lease's contention are properties of
 * the DATABASE — two writers, one document, one winner — and no in-memory fake
 * can prove them, because a fake that models the race is just a second
 * implementation of the thing under test. So when Mongo is missing these files
 * skip themselves, and a green run has proved NOTHING about the two guards
 * that stop two supervisors steering one book.
 *
 * `DESK_REQUIRE_MONGO=1` turns that skip into a FAILURE. CI sets it
 * (`.github/workflows/check.yml` stands a `mongo:8` service container up), and
 * anyone can set it locally to prove their run was real.
 *
 * COPIED, not imported, from `apps/api/test/require-mongo.ts` — which is the
 * source of truth for the CI story and carries the longer telling. A test
 * directory is not a workspace's product (nothing is exported from it, and
 * `apps/api` publishes no entry point), so a suite here reaching into another
 * app's test folder would be a dependency neither package.json can see. The
 * duplicated surface is one env var and one sentence; if a third workspace
 * ever needs it, that is the moment it becomes a shared test package.
 *
 * The suites choose their own URL — a per-suite `DESK_TEST_MONGO_*`, else a
 * per-suite database on `mongodb://127.0.0.1:27017`. The per-suite default is
 * load bearing: node:test runs files in parallel processes and each of these
 * wipes its collections between tests, so pointing them all at ONE database
 * would have them deleting each other's fixtures.
 */

/**
 * Every test database in the Delta clone is `algomaker_dx_*`, and so must any
 * URL a shell hands in through a `DESK_TEST_MONGO_*` var: anything else is the
 * live desk's `algomaker`, the clone's own desk database `algomaker_dx`, or one
 * of the live repo's test databases, and these suites wipe what they touch.
 * Copied from `apps/api/test/require-mongo.ts` for the reason given above.
 */
for (const [name, url] of Object.entries(process.env)) {
  if (!name.startsWith('DESK_TEST_MONGO') || url === undefined || url === '') continue
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
        `(URL from the suite's own DESK_TEST_MONGO_* var, else its 127.0.0.1:27017 database)${
          detail === '' ? '' : `: ${detail}`
        }`,
    )
  }
  t.skip('no MongoDB reachable')
}
