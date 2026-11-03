/**
 * RESTART DRILLS — the supervisor against its operators, not against its author.
 *
 * The unit suites in the directory above prove that `stop()` sets a flag, that a
 * compare-and-set refuses a stale writer, and that a boot replays an id. Every
 * one of those is a statement about an object inside one process, and every one
 * of them is still true of a process that never survives a `kill -9` — because
 * the thing a kill destroys is exactly the part a unit test supplies for itself.
 *
 * So these four drills spawn the deployed launcher, `bin/desk-supervisor.mjs`,
 * against a real mongod, a real bus server and a stub desk-api, and then do to it
 * the three things that actually happen to a process on this desk:
 *
 *   1. **`kill -9` mid-decision.** The OOM killer, a `max_memory_restart`, a
 *      developer's impatience. The package is saved, the POST is in flight, and
 *      the process is gone between the two. On restart the desk must place that
 *      package exactly ONCE — never twice, and never not at all.
 *   2. **`kill -9` mid-working-package.** The same kill, one step later: some of
 *      the tranches have filled. The remainder is a CURSOR, and a restart that
 *      forgot it would re-offer lots the book has already sold.
 *   3. **SIGTERM.** Every restart path on this desk sends it — `make restart`, a
 *      deploy, a reboot, and the one nobody is watching. It must place NOTHING,
 *      including on a book screaming to shed, and including while the boot is
 *      still waiting for a lease it is never going to get.
 *
 * ── HOW EACH ONE IS MADE RACE-FREE ──────────────────────────────────────────
 * A drill that says "kill it and see" proves whatever the scheduler felt like
 * that morning. Each of these has an exact barrier instead:
 *
 *   - the stub api PARKS the decision post — records it, claims it, and never
 *     answers. "The stub has seen a post" is then a precise statement that the
 *     child has already written its `seq` and its `inFlight` to Mongo, because
 *     `#route` saves BEFORE it posts;
 *   - the SIGTERM drills open the feed only AFTER the signal has been sent, so
 *     the window in which the child could have decided anything is not a
 *     narrow race but an empty set;
 *   - the standby drill holds the lease under another owner, which parks the
 *     child's boot at a point it cannot leave.
 *
 * Assertions are made against the DATABASE and the stub's decision store —
 * never against the child's own account of itself.
 *
 * ── THE SKIP ────────────────────────────────────────────────────────────────
 * No mongod, no drill. `DESK_REQUIRE_MONGO=1` turns that skip into a failure
 * (`../require-mongo.ts`), which is what CI sets: a drill suite that quietly
 * skips is a claim that restart is safe, made by nobody.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import type { DecisionRequest, WireAction } from '@algomaker/desk-engine'
import { skipUnlessMongo } from '../require-mongo.ts'
import { Drill, TAG, symbolOf, type Answer } from './harness.ts'

/**
 * The one action of a shed package, narrowed to the arm that carries a quantity.
 *
 * `WireAction` is a union and only `open` has a `qty` — which is the shape phase
 * R produces (a sale). Asserting the arm rather than casting means a package that
 * arrived as something else fails HERE, naming what it was, instead of reading
 * `undefined` into the arithmetic three lines down.
 */
function openAction(req: DecisionRequest): Extract<WireAction, { op: 'open' }> {
  const action = req.actions[0]
  assert.ok(action !== undefined, 'the package names an action')
  assert.equal(action.op, 'open', `the shed package is a sale, not a ${action.op}`)
  return action as Extract<WireAction, { op: 'open' }>
}

/** The id the very first decision of a fresh book is burnt under. */
const FIRST = `${TAG}:paper:1`

const sleep = async (ms: number): Promise<void> =>
  await new Promise((resolve) => setTimeout(resolve, ms))

/** Poll an ASYNC predicate — for the ones that have to read Mongo. */
async function eventually(
  ready: () => Promise<boolean>,
  what: string,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await ready())) {
    if (Date.now() > deadline) throw new Error(`drill timed out waiting for ${what}`)
    await sleep(50)
  }
}

/** The working package as it stands on disk, or null. */
async function workingPackage(drill: Drill): Promise<Record<string, unknown> | null> {
  const doc = await drill.state()
  const wp = doc?.['workingPackage']
  return typeof wp === 'object' && wp !== null ? (wp as Record<string, unknown>) : null
}

/** The first remaining action's qty — the tranche cursor, as a number. */
async function remainingQty(drill: Drill): Promise<number | null> {
  const wp = await workingPackage(drill)
  const remaining = wp?.['remaining']
  if (!Array.isArray(remaining) || remaining.length === 0) return null
  const qty = (remaining[0] as Record<string, unknown>)['qty']
  return typeof qty === 'number' ? qty : null
}

// ─────────────────────────────────────────────────────── 1. mid-decision

test('KILL -9 MID-DECISION: the restart replays the SAME id, and the desk routes it exactly once', async (t) => {
  const drill = await Drill.start()
  if (drill === null) return skipUnlessMongo(t)
  try {
    await drill.seed()
    // THE BARRIER: the post is recorded and claimed, and never answered.
    drill.api.park(true)

    const first = await drill.spawn()
    await first.waitForLog('supervisor up')
    await drill.awaitSubscriber()
    await drill.feedUntil(() => drill.api.posts.length > 0, 'the first decision to reach desk-api')

    // The package was PERSISTED before it was posted — that ordering is the
    // whole of the exactly-once property, and it is the only reason the id the
    // next process finds is the id the broker may already be working.
    const before = await drill.state()
    assert.equal(before?.['inFlight'], FIRST, 'the flight is on disk before the post is answered')
    assert.equal(before?.['seq'], 1, 'the seq is burnt')

    await first.kill9()

    assert.equal(drill.api.posts.length, 1, 'exactly one post reached the wire before the kill')
    assert.equal(drill.api.routed.size, 1)

    // The desk answers now. The restart is where a restart really is: past the
    // dead holder's lease TTL, which a `kill -9` did not release (see
    // `Drill.advance`; drill 4 pins what happens before it lapses).
    drill.api.park(false)
    drill.advance(Drill.LEASE_TTL_MS + 1_000)
    const second = await drill.spawn()
    await second.waitForLog('lease acquired — this process is steering')
    await second.until(
      () => drill.api.postsOf(FIRST).length === 2,
      'the boot replay of the decision the book was left holding',
    )

    // VERBATIM (spec §7). A request rebuilt from today's market would be a
    // package this supervisor never decided on, posted under an id that is
    // already claimed.
    assert.deepEqual(drill.api.posts[1], drill.api.posts[0])

    // THE ASSERTION THIS DRILL EXISTS FOR: one decision, one routing. The stub
    // claims an id on the way IN, so a replay it answered by routing again would
    // show up here as a second entry.
    assert.equal(drill.api.routed.size, 1, 'exactly one decision was ever routed')

    // And the flight is cleared by the outcome, so the book is free to decide.
    await eventually(async () => (await drill.state())?.['inFlight'] === null, 'the flight to clear')
    assert.equal(await workingPackage(drill), null)

    assert.deepEqual(drill.api.unhandled, [], 'the supervisor asked for no route this stub lacks')
    assert.deepEqual(
      drill.api.unauthorised,
      [],
      'every request carried the bearer token — a launcher that stopped passing DESK_API_TOKEN ' +
        'would refuse every package for every book, and each refusal looks like a quiet book',
    )
    assert.equal(await second.sigterm(), 0)
  } finally {
    await drill.close()
  }
})

// ──────────────────────────────────────────────────────── 2. mid-package

test('KILL -9 MID-PACKAGE: the tranche cursor is on disk, and a short answer cannot wind it back up', async (t) => {
  const drill = await Drill.start()
  if (drill === null) return skipUnlessMongo(t)
  try {
    await drill.seed()

    /**
     * HALF THE PACKAGE HAS FILLED and the rest is still working — the state a
     * gateway working a package in tranches is in for most of its life.
     */
    let filledQty = 0
    const halfFilled: Answer = (req: DecisionRequest) => {
      const action = openAction(req)
      filledQty = Math.floor(action.qty / 2)
      return {
        status: 'WORKING',
        fills: [{ instrument: action.instrument, side: action.side, qty: filledQty, price: 2.5 }],
        skips: [],
        routeErrors: [],
      }
    }
    drill.api.answer(halfFilled)

    const first = await drill.spawn()
    await first.waitForLog('supervisor up')
    await drill.awaitSubscriber()
    await drill.feedUntil(() => drill.api.posts.length > 0, 'the first decision to reach desk-api')

    const posted = drill.api.posts[0]
    assert.ok(posted !== undefined)
    const fullQty = openAction(posted).qty
    assert.ok(fullQty > 0, 'the shed package names a quantity')

    await eventually(
      async () => (await remainingQty(drill)) === fullQty - filledQty,
      'the cursor to shrink to what is still outstanding',
    )

    await first.kill9()

    const cursor = await remainingQty(drill)
    assert.equal(cursor, fullQty - filledQty, 'the cursor survived the kill because it was on disk')
    assert.equal((await drill.state())?.['inFlight'], FIRST)

    /**
     * THE SHORT ANSWER — desk-api's record read before its fills were pushed
     * back onto it, which is an ordinary thing for a busy endpoint to return.
     * A supervisor that rebuilt `remaining` from the REQUEST would read "nothing
     * has filled" and re-offer the whole package; one that resumes from the
     * persisted cursor takes the smaller of the two and does not move.
     */
    drill.api.answer(() => ({ status: 'WORKING', fills: [], skips: [], routeErrors: [] }))
    const postsBefore = drill.api.postsOf(FIRST).length
    drill.advance(Drill.LEASE_TTL_MS + 1_000)
    const second = await drill.spawn()
    await second.until(
      () => drill.api.postsOf(FIRST).length > postsBefore,
      'the boot replay of the working package',
    )
    // Let the 1 s poll ask again, so this is not merely "it has not got to it yet".
    await sleep(1_500)

    assert.equal(
      await remainingQty(drill),
      cursor,
      'the cursor is still what the fills left it at — the package was not re-offered whole',
    )
    assert.equal(drill.api.routed.size, 1, 'still exactly one routed decision')

    assert.equal(await second.sigterm(), 0)
  } finally {
    await drill.close()
  }
})

// ────────────────────────────────────────────────────────────── 3. SIGTERM

test('SIGTERM: the feed opens AFTER the signal and not one order reaches the wire', async (t) => {
  const drill = await Drill.start()
  if (drill === null) return skipUnlessMongo(t)
  try {
    await drill.seed()

    const proc = await drill.spawn()
    await proc.waitForLog('supervisor up')
    await drill.awaitSubscriber()

    // NOT A RACE, AN EMPTY SET: no tick has been published, so there is nothing
    // this process could have decided even in principle.
    assert.equal(drill.api.posts.length, 0)
    assert.equal(await drill.state(), null, 'no seq has been burnt')

    /**
     * The signal is SENT here (`kill` is synchronous), and only then does the
     * market open. Everything that follows — the ticks, the coalesced pass they
     * would have driven, the shed they would have formed — happens to a process
     * that has already been told to stop.
     */
    const exited = proc.sigterm()
    for (let i = 0; i < 24; i++) {
      drill.publishFrame()
      await sleep(25)
    }

    assert.equal(await exited, 0, 'the shutdown completed on its own, without the fuse')
    assert.ok(
      proc.output.includes('SIGTERM received — stopping WITHOUT touching a book'),
      `the stop said what it does not do:\n${proc.output}`,
    )

    assert.equal(drill.api.posts.length, 0, 'NOTHING was posted after the signal')
    assert.deepEqual(drill.api.cancels, [], 'and nothing was cancelled either')
    assert.equal(await drill.state(), null, 'and no decision was burnt on the way out')

    // The book's legs are exactly where the operator left them.
    const books = (await (
      drill.db.collection('desk-books') as unknown as {
        findOne(f: unknown): Promise<Record<string, unknown> | null>
      }
    ).findOne({ tag: TAG, mode: 'paper' })) as Record<string, unknown> | null
    const legs = books?.['legs'] as Record<string, unknown>[] | undefined
    assert.equal(legs?.length, 1)
    assert.equal((legs?.[0]?.['instrument'] as Record<string, unknown>)['tradingsymbol'], symbolOf(360, 'PE'))
    assert.equal(legs?.[0]?.['qty'], -100)
  } finally {
    await drill.close()
  }
})

// ──────────────────────────────────────────────── 4. SIGTERM during boot

test('SIGTERM ON A STANDBY: the decision it was left holding is never replayed', async (t) => {
  const drill = await Drill.start()
  if (drill === null) return skipUnlessMongo(t)
  try {
    await drill.seed()
    // Somebody else is steering, and their lease has ten minutes left on it.
    await drill.holdLease('another-host:4242', 10 * 60_000)

    /**
     * A BOOK LEFT HOLDING A PACKAGE. A supervisor that won the lease would
     * re-post this verbatim during `#start` — which is exactly what drill 1
     * proves it does — so if a standby's interrupted boot were to reach that
     * line, this stub would see it.
     */
    const request: DecisionRequest = {
      tag: TAG,
      mode: 'paper',
      decisionId: FIRST,
      symbol: 'TCS',
      expiry: '2026-08-28',
      trigger: 'shed',
      reason: 'a package this book was left holding',
      actions: [{ op: 'open', instrument: symbolOf(330, 'CE'), side: 'Sell', qty: 250 }],
    }
    await drill.putState({
      key: `${TAG}:paper`,
      inFlight: FIRST,
      seq: 1,
      updatedAt: drill.now(),
      workingPackage: {
        decisionId: FIRST,
        remaining: request.actions,
        request,
        basis: [
          {
            instrument: symbolOf(330, 'CE'),
            strike: 330,
            optType: 'CE',
            side: 'Sell',
            op: 'open',
            entry: 0,
            lots: 0,
            lotSize: 25,
            intentQty: 250,
          },
        ],
        formedAt: drill.now(),
        formedSpot: 300,
      },
    })

    const proc = await drill.spawn()
    await proc.waitForLog('another supervisor holds the lease — STANDING BY')

    // A standby steers nothing, so it has replayed nothing.
    assert.equal(drill.api.posts.length, 0)

    const exited = proc.sigterm()
    // The market runs through the shutdown, as it would through a deploy.
    for (let i = 0; i < 12; i++) {
      drill.publishFrame()
      await sleep(25)
    }
    assert.equal(await exited, 0, 'a standby exits cleanly on the signal rather than hanging on its lease wait')

    assert.equal(drill.api.posts.length, 0, 'the boot replay never happened')
    assert.equal(drill.api.routed.size, 0)
    // And the flight is still there for whoever does win the lease.
    assert.equal((await drill.state())?.['inFlight'], FIRST)
  } finally {
    await drill.close()
  }
})
