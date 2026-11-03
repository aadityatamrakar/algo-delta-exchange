/**
 * THE DRILLS' CLOCK, SHIFTED — loaded into the spawned supervisor with
 * `--import`, so the process under test is `bin/desk-supervisor.mjs` UNMODIFIED.
 *
 * The engine's very first gate is the session gate: not a trading day, or before
 * 09:20 IST, and `decide()` holds (`engine.ts:249`). A drill that ran on the wall
 * clock would therefore prove nothing on a Saturday and everything on a Tuesday
 * afternoon — the worst possible test, because it is green on the machine that
 * wrote it and red in CI at the wrong hour.
 *
 * WHY A PRELOAD AND NOT AN ENV VAR IN `main.ts`. The whole point of a process
 * drill is that it runs the deployed launcher. A `DESK_CLOCK_OFFSET_MS` read by
 * the composition root would be a test hook living in production code, on the
 * one process whose clock decides whether the market is open — and the day
 * somebody sets it in `.env.local` the desk trades a session that is not
 * happening. Here the hook exists only for the child the drill spawns, and
 * `bin/desk-supervisor.mjs` does not know it is under test.
 *
 * AN OFFSET, NOT A PIN. `Date.now()` still advances in real time; it simply sits
 * on a Friday morning in the session. Pinning it would freeze the mark clock, the
 * lease heartbeat's TTL arithmetic and every `asOf` comparison at one instant,
 * which is a different process from the one that runs in production. Timers are
 * unaffected either way — libuv counts on a monotonic clock, not on `Date`.
 *
 * Zero-argument `new Date()` is shifted with `Date.now()` because the logger uses
 * it (`main.ts:makeLogger`); every other constructor form is left exactly alone,
 * so a millisecond value the supervisor parses out of Mongo still means what it
 * says.
 */

const OFFSET = Number(process.env['DESK_DRILL_CLOCK_OFFSET_MS'] ?? '0')

if (Number.isFinite(OFFSET) && OFFSET !== 0) {
  const RealDate = Date

  class ShiftedDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(RealDate.now() + OFFSET)
      else super(...args)
    }

    static now() {
      return RealDate.now() + OFFSET
    }
  }

  globalThis.Date = ShiftedDate
}
