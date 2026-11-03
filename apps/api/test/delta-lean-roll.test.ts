/**
 * THE DAILY BOOK ROLL, AND THE WAYS IT COULD COST MONEY OR HISTORY.
 *
 * `scripts/delta-lean-roll.mjs` is the automation of runbook §6/§7: every
 * trading morning it creates, starts and switches on TODAY's four delta-lean
 * paper books, stops yesterday's, and erases the ones older than that. It runs
 * from cron, at 08:45 IST, with nobody watching — which is the whole argument
 * for this file. A chore an operator performs badly is one mistake; a chore a
 * cron performs badly is the same mistake every morning until someone notices.
 *
 * Seven failures it prevents, in the order they would cost money:
 *
 *   1. A STOP THAT STRANDS A POSITION. A stop does NOT flatten (runbook §4) and
 *      a stopped book is not steered, so it will not flatten itself at 14:50
 *      either. Retiring a book that still holds legs abandons a position with
 *      nothing watching it. `planRoll` may only stop or erase a book it READ
 *      as holding nothing, "unknown" is not "flat", and `applyRoll` refuses
 *      again at the wire.
 *   2. A MORNING WITH NO BOOK ON THE DESK. Today's four are created, started
 *      and switched on BEFORE anything is stopped, and every stop goes out
 *      before any DELETE; a create that fails takes the run down before a
 *      single stop. Pinned by recording the order of the actual calls, not by
 *      reading the source. The playbook family, created last, is FENCED: its
 *      failure costs only its own retire, never the four's (review #2).
 *   3. A BOOK BORN SWITCHED OFF. Registration has landed the tag with the
 *      paper switch off (the API may come to land it on; the roll does not
 *      depend on which); a running book that is switched off decides all day
 *      and has every order refused INVALID (spec E3). So every start this run
 *      issues is followed by a PATCH that flips the switch on, regardless,
 *      and a PATCH that will not flip aborts (the playbook family's: fenced).
 *      A running book is PATCHed again only when this morning's switch-on
 *      plainly did not land — registered today, never marked, no day-guard
 *      stamp (review #8) — so a day guard that tripped a book is not undone
 *      by a hand re-run.
 *   4. A LIVE ROW. Same guarantee as the sibling script and the same five
 *      layers; `mode` is imported from it rather than restated so the two
 *      cannot drift. A live row in the registry read is a throw.
 *   5. TOUCHING SOMEBODY ELSE'S BOOK. Membership of this family is the variant
 *      AND the `delta_lean_enabled` dial together — never a tag substring. A
 *      recenter book whose tag happens to read `delta-lean` is not ours, and a
 *      row whose variant and dial disagree is reported rather than guessed at.
 *      The four LEGACY weekly-tag rows on the box are retired by that same
 *      rule, never by their tag shape.
 *   6. A ROLL THAT UNDOES ITSELF. Cron reruns, an operator reruns after a
 *      half-finished attempt, the box reboots and the entry fires late. A
 *      second run a second after the first must issue no calls at all.
 *   7. ERASING HISTORY. The erase is `DELETE ?mode=paper` and NOTHING ELSE —
 *      never `flatten=1`, never `purge=1`. The registry row and the `desk-books`
 *      document go; fills, order events, daily reports and the decisions
 *      journal stay for the Reports page. And the server's own fills guard can
 *      still say no (409): that is an ALARM in the summary, not an abort, so
 *      one stuck row does not stop the other three being erased.
 *
 * THE ERASE CUTOFF IS TODAY (operator, 2026-10-05: "which is done and closed,
 * why still on tab"): a flat book from any earlier session is stopped (if it
 * still runs) and erased in the same run, the morning after its own session.
 * Friday's book is stopped and erased on Monday. The fourth loop retires a
 * book whose contract expired before today; one expiring today is still live.
 *
 * OWN DATABASE NAME: `algomaker_dx_delta_lean_roll_test`, distinct from every
 * other Mongo suite here, because `node:test` runs files in parallel processes
 * and each one wipes its collections between tests.
 */

import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { skipUnlessMongo } from './require-mongo.ts'
import { startNudgeSink, type NudgeSink } from './nudge-sink.ts'
import { connectMongo, type MongoHandle } from '../src/mongo.ts'
import { createBridgeServer } from '../src/server.ts'
import { bearerGate } from '../src/authgate.ts'
import { DeskStore, COLLECTIONS } from '../src/store.ts'
import { booksRoutes } from '../src/routes/books.ts'
import { deskRoutes } from '../src/routes/desk.ts'
import type { ApiDeps } from '../src/routes/kit.ts'
import { isOn } from '../src/strategies.ts'
import { isArmed } from '../src/day-guard.ts'
import { DEFAULT_BOOK } from '../src/books-registry.ts'
import { OptionMaster } from '@algomaker/instruments'
import { DEFAULT_DIALS } from '@algomaker/desk-engine'

/**
 * The two scripts under test, imported through a URL rather than a literal
 * path — they are `.mjs` with no declaration file and `scripts/` is in no
 * tsconfig, so a literal specifier would be a typecheck error. The URL form is
 * opaque to the resolver, so the shapes are stated here instead, which is also
 * the only place the roll script's exported contract is written down.
 */
interface BookPlan {
  readonly tag: string
  readonly symbol: string
  readonly expiry: string
  readonly mode: string
  readonly variant: string
  /** Stated by every planned body; the legacy fixtures predate it. */
  readonly series?: string
  readonly dials: Readonly<Record<string, number | boolean>>
}
interface Expiries {
  readonly nifty: string
  readonly sensex: string
}
/** Only the one method `expiriesFrom` is allowed to reach for. */
interface MasterLike {
  nearestExpiry(underlying: string, onOrAfter: string): string | null
}
interface RegistryRow extends BookPlan {
  readonly desired: string
  readonly actual: string
  readonly createdAt: number
  /**
   * The supervisor's last mark (0 = never), and the registry's own stamp of
   * the row's last write — `bookFromDoc` always answers both; a fixture that
   * leaves them out is a row whose history this run cannot read.
   */
  readonly lastMarkAt?: number
  readonly updatedAt?: number
}
type RetireAction =
  | 'stop'
  | 'erase'
  | 'blocked'
  | 'holds-legs'
  | 'unknown'
  | 'stopped-flat'
  | 'stopped-holds-legs'
  | 'stopped-unknown'
  | 'settle-then-stop'
  | 'settle-then-erase'
interface RetireEntry {
  readonly row: RegistryRow
  readonly held: number | null
  /** The IST day the row was created, or null when `createdAt` is unreadable. */
  readonly day: string | null
  readonly action: RetireAction
}
interface EnsureEntry {
  readonly plan: BookPlan
  readonly why: 'missing' | 'stopped-but-needed' | 'created-not-started' | 'switched-off'
}
/** One tag's paper switch as `desk-strategies` holds it (`readSwitches`). */
interface SwitchState {
  readonly paper: 'on' | 'off' | 'not-added'
  /** The day guard's stamp on the paper rail, or null. */
  readonly guard: { readonly day: string; readonly trigger: string } | null
}
interface Holding {
  readonly row: RegistryRow
  readonly held: number | null
}
interface SymbolPlan {
  readonly symbol: string
  readonly targetExpiry: string
  readonly ensure: readonly EnsureEntry[]
  readonly onTarget: readonly Holding[]
  readonly leftStopped: readonly Holding[]
  readonly retire: readonly RetireEntry[]
}
/** The hold-to-expiry pairs: created per front contract, retired by expiry. */
interface HoldPlan {
  readonly ensure: readonly EnsureEntry[]
  readonly onTarget: readonly Holding[]
  /** A hold row on today's front contract that is stopped — the operator's call. */
  readonly leftStopped: readonly Holding[]
  /** Hold rows whose contract has not expired and that are not today's targets. */
  readonly carrying: readonly Holding[]
  readonly retire: readonly RetireEntry[]
}
/** The playbook family (spec 2026-10-16 §4.9): one book per preset per day, retired the morning after. */
interface PlaybookPlan {
  /** Why the family is not planned today (the gate), or null. While set, only `gated` is filled. */
  readonly blocked: string | null
  readonly ensure: readonly EnsureEntry[]
  readonly onTarget: readonly Holding[]
  /** One of today's playbook tags, registered but stopped — the operator's call, in ATTENTION. */
  readonly leftStopped: readonly Holding[]
  /** Playbook rows of TODAY that are not today's plans — never touched. */
  readonly ofToday: readonly Holding[]
  readonly retire: readonly RetireEntry[]
  /** Every playbook row on file while the family is gated — left exactly as it is. */
  readonly gated: readonly Holding[]
}
interface RollPlan {
  readonly todayIst: string
  readonly tradingDay: boolean
  readonly symbols: readonly SymbolPlan[]
  readonly hold: HoldPlan
  readonly playbook: PlaybookPlan
  /** The fourth loop: every OTHER paper row whose contract day is past. */
  readonly expiredBooks: readonly RetireEntry[]
  /** The series planned today and not created because SERIES_OFF names them — never an anomaly. */
  readonly switchedOff: readonly string[]
  readonly anomalies: readonly string[]
  readonly alarms: readonly string[]
}
interface WireResult {
  readonly status: number
  readonly body: unknown
  readonly text: string
}
type Method = 'POST' | 'PATCH' | 'DELETE'
type Request = (method: Method, path: string, body?: unknown) => Promise<WireResult>
interface RollInput {
  readonly targets: readonly BookPlan[]
  /** `planHoldBooks(expiries, todayIst)`; absent plans no hold pair. */
  readonly holdTargets?: readonly BookPlan[]
  readonly rows: readonly RegistryRow[]
  readonly heldByTag: Map<string, number | null> | Readonly<Record<string, number | null>>
  /** Open legs per tag whose contract expired before today. Absent reads as none. */
  readonly expiredByTag?: Map<string, number | null> | Readonly<Record<string, number | null>>
  readonly todayIst: string
  /** Why no hold pair was planned today (the engine gate), or null — an anomaly when set. */
  readonly holdBlocked?: string | null
  /** `planPlaybookBooks(master, todayIst)`; absent plans no playbook book (old ones still retire). */
  readonly playbookTargets?: readonly BookPlan[]
  /** Why the playbook family is not planned today, or null — an anomaly, and the family is left alone. */
  readonly playbookBlocked?: string | null
  /** Every tag's paper switch, as `main` reads it; absent, the plan is made without them. */
  readonly switchByTag?: Map<string, SwitchState> | Readonly<Record<string, SwitchState>>
  /** The series `main` dropped from the targets (`seriesSwitchedOff`); carried onto the plan. */
  readonly switchedOff?: readonly string[]
}
interface Done {
  readonly created: number
  readonly started: number
  readonly switchedOn: number
  readonly stopped: number
  readonly erased: number
  readonly settled: number
  readonly refused: readonly string[]
}
interface StrategyRowLike {
  readonly tag: string
  readonly kind: string
  readonly modes: { readonly paper?: unknown; readonly live?: unknown }
}
interface OrphanPlan {
  readonly prune: readonly { readonly tag: string; readonly modes: readonly string[] }[]
  readonly skipped: readonly string[]
}

const roll = (await import(
  new URL('../../../scripts/delta-lean-roll.mjs', import.meta.url).href
)) as {
  planRoll(input: RollInput): RollPlan
  planHoldTargets(
    expiries: Expiries,
    todayIst: string,
    knows?: () => boolean,
  ): { holdTargets: readonly BookPlan[]; holdBlocked: string | null }
  planPlaybookTargets(
    master: MasterLike,
    todayIst: string,
    knows?: () => boolean,
  ): { playbookTargets: readonly BookPlan[]; playbookBlocked: string | null }
  playbookSummary(plan: RollPlan): string
  switchedOffSummary(plan: RollPlan): string | null
  applyRoll(plan: RollPlan, io: { request: Request; log?: (line: string) => void }): Promise<Done>
  createdBooks(plan: RollPlan): readonly BookPlan[]
  stoppedTags(plan: RollPlan): readonly string[]
  erasedTags(plan: RollPlan): readonly string[]
  settledTags(plan: RollPlan): readonly string[]
  printPlan(plan: RollPlan): void
  isDeltaLean(row: { variant?: unknown; dials?: unknown }): boolean
  openLegCount(legs: unknown): number | null
  expiredLegCount(legs: unknown, todayIst: string): number | null
  readHoldings(
    rows: readonly { tag: string }[],
    bookDoc: (tag: string) => Promise<{ legs: unknown } | null>,
    todayIst: string,
  ): Promise<{ heldByTag: Map<string, number | null>; expiredByTag: Map<string, number | null> }>
  readSwitches(strategies: readonly { tag: string; modes?: unknown; disabledByGuard?: unknown }[]): Map<string, SwitchState>
  planOrphans(input: {
    strategies: readonly StrategyRowLike[]
    registered: ReadonlySet<string>
  }): OrphanPlan
  applyOrphans(plan: OrphanPlan, io: { request: Request; log?: (line: string) => void }): Promise<{ removedModes: number; deletedRows: number; refused: readonly string[] }>
  parseArgs(argv: readonly string[]): { apply: boolean; json: boolean; help: boolean; pruneOrphans: boolean }
  readonly HELP: string
  readonly PAPER: string
  readonly LEAN_DIAL: string
  readonly REGISTRY: string
}
const books = (await import(
  new URL('../../../scripts/delta-lean-books.mjs', import.meta.url).href
)) as {
  planBooks(expiries: Expiries, tradingDay: string): readonly BookPlan[]
  expiriesFrom(master: MasterLike, tradingDay: string): Expiries
  planHoldBooks(expiries: Expiries, today: string): readonly BookPlan[]
  isHold(row: { dials?: unknown }): boolean
  engineKnowsHoldDial(): boolean
  planPlaybookBooks(master: MasterLike, today: string): readonly BookPlan[]
  isPlaybook(row: { variant?: unknown; dials?: unknown }): boolean
  engineKnowsPlaybookDial(): boolean
  withoutSeriesOff(plans: readonly BookPlan[], off?: readonly string[]): readonly BookPlan[]
  seriesSwitchedOff(plans: readonly BookPlan[], off?: readonly string[]): string[]
  readonly SERIES_OFF: readonly string[]
  istDate(ms: number): string
  requestJson(base: string, method: Method, path: string, body: unknown, token: string): Promise<WireResult>
}

const { planRoll, applyRoll, createdBooks, stoppedTags, erasedTags } = roll

/**
 * Real dates off this desk's own dump, never `Date.now()`.
 *
 * 2026-09-22 is a Tuesday and the first morning the daily roll runs. NIFTY's
 * weekly expires that very day (and is traded — D6); SENSEX's on Thursday the
 * 24th. The previous trading day is Monday the 21st.
 */
const TODAY = '2026-09-22'
const YESTERDAY = '2026-09-21'
/** What `expiriesFrom(master, TODAY)` answers on the Tuesday. */
const LIVE: Expiries = { nifty: '2026-09-22', sensex: '2026-09-24' }
const TARGETS = books.planBooks(LIVE, TODAY)

const NIFTY_AGG = `NIFTY-delta-lean-aggressive-${TODAY}`
const NIFTY_CONS = `NIFTY-delta-lean-conservative-${TODAY}`
const SENSEX_AGG = `SENSEX-delta-lean-aggressive-${TODAY}`
const SENSEX_CONS = `SENSEX-delta-lean-conservative-${TODAY}`
const NIFTY_ZERO = `NIFTY-delta-lean-zero-${TODAY}`
const NIFTY_ZERO_0DTE = `NIFTY-delta-lean-zero-0dte-${TODAY}`
const SENSEX_ZERO = `SENSEX-delta-lean-zero-${TODAY}`
/**
 * Today's daily books in plan order — "the four" of the older tests below,
 * seven since the zero spec (2026-10-17): three presets a symbol, and NIFTY's
 * 0-DTE book because NIFTY's contract dies today. SENSEX's comes on the 24th.
 */
const TODAYS = [NIFTY_AGG, NIFTY_CONS, NIFTY_ZERO, NIFTY_ZERO_0DTE, SENSEX_AGG, SENSEX_CONS, SENSEX_ZERO]

/**
 * The four LEGACY weekly-tag rows really on the box, created 2026-09-15 at
 * 23:59:21 IST (`createdAt` 1789496961351 = 2026-09-15T18:29:21Z — 39 s
 * before IST midnight, which is why `istDate` and not a UTC slice decides the
 * day). The roll must retire them by variant + dial, never by tag shape.
 */
const LEGACY_CREATED_AT = 1789496961351
const LEGACY_TAGS = [
  'NIFTY-2026-09-22-delta-lean-aggressive',
  'NIFTY-2026-09-22-delta-lean-conservative',
  'SENSEX-2026-09-17-delta-lean-aggressive',
  'SENSEX-2026-09-17-delta-lean-conservative',
] as const
const LEGACY_SENSEX_AGG = LEGACY_TAGS[2]
const LEGACY_NIFTY_AGG = LEGACY_TAGS[0]

/** 09:00 IST on an IST date, as epoch ms — when a hand-run would have created a row. */
function nineAmIst(dateIst: string): number {
  const [y, m, d] = dateIst.split('-').map(Number) as [number, number, number]
  return Date.UTC(y, m - 1, d, 3, 30)
}

/** The four books of one trading day, as the registry holds them. */
function rowsFor(
  tradingDay: string,
  expiries: Expiries,
  opts: { desired?: 'running' | 'stopped'; createdAtMs?: number } = {},
): RegistryRow[] {
  const desired = opts.desired ?? 'running'
  const createdAt = opts.createdAtMs ?? nineAmIst(tradingDay)
  return books
    .planBooks(expiries, tradingDay)
    .map((b) => ({ ...b, desired, actual: desired, createdAt, ...history(desired, createdAt) }))
}

/** The legacy bodies, dials from the presets, so `isDeltaLean` reads true. */
function legacyBodies(): BookPlan[] {
  const dialsOf = (variant: string): BookPlan['dials'] =>
    (TARGETS.find((t) => t.variant === variant) as BookPlan).dials
  return LEGACY_TAGS.map((tag) => {
    const symbol = tag.startsWith('NIFTY') ? 'NIFTY' : 'SENSEX'
    const expiry = symbol === 'NIFTY' ? '2026-09-22' : '2026-09-17'
    const variant = tag.endsWith('aggressive') ? 'delta-lean-aggressive' : 'delta-lean-conservative'
    return { tag, symbol, expiry, mode: 'paper', variant, dials: dialsOf(variant) }
  })
}

function legacyRows(desired: 'running' | 'stopped' = 'running'): RegistryRow[] {
  return legacyBodies().map((b) => ({ ...b, desired, actual: desired, createdAt: LEGACY_CREATED_AT }))
}

/** Every tag flat, which is what 08:45 is supposed to look like. */
function allFlat(rows: readonly RegistryRow[]): Record<string, number | null> {
  return Object.fromEntries(rows.map((r) => [r.tag, 0]))
}

function symbolPlan(plan: RollPlan, symbol: string): SymbolPlan {
  const found = plan.symbols.find((s) => s.symbol === symbol)
  assert.ok(found !== undefined, `no plan for ${symbol}`)
  return found
}

function retireFor(plan: RollPlan, tag: string): RetireEntry {
  const found = plan.symbols.flatMap((s) => s.retire).find((e) => e.row.tag === tag)
  assert.ok(found !== undefined, `${tag} is not in the retire set`)
  return found
}

function plainPlan(rows: readonly RegistryRow[], todayIst = TODAY, targets = TARGETS): RollPlan {
  return planRoll({ targets, rows, heldByTag: allFlat(rows), todayIst })
}

// ------------------------------------------- expiry day is not special (D6)

/** A stand-in for `OptionMaster` that records what it was asked. */
function masterSpy(listed: Readonly<Record<string, readonly string[]>>): MasterLike & {
  readonly asked: ReadonlyArray<{ underlying: string; onOrAfter: string }>
} {
  const asked: Array<{ underlying: string; onOrAfter: string }> = []
  return {
    asked,
    nearestExpiry(underlying: string, onOrAfter: string): string | null {
      asked.push({ underlying, onOrAfter })
      // The real `nearestExpiry` uses `>=`, and so does this.
      for (const e of listed[underlying] ?? []) if (e >= onOrAfter) return e
      return null
    },
  }
}

test('the create target includes TODAY — the master is asked for today, not tomorrow', () => {
  // D6 rests on it: a book born on an expiry morning holds that day's
  // contract and trades its session. The roll uses the sibling's own
  // `expiriesFrom` so the two scripts cannot resolve different contracts.
  const spy = masterSpy({
    NIFTY: ['2026-09-22', '2026-09-29'],
    SENSEX: ['2026-09-17', '2026-09-24'],
  })
  const got = books.expiriesFrom(spy, TODAY)
  for (const a of spy.asked) assert.equal(a.onOrAfter, TODAY, 'asked for tomorrow, not today')
  assert.deepEqual(got, LIVE)
  // And on the Thursday SENSEX's own contract is still the one.
  assert.equal(books.expiriesFrom(masterSpy({ NIFTY: ['2026-09-29'], SENSEX: ['2026-09-24'] }), '2026-09-24').sensex, '2026-09-24')
})

test('a symbol the dump does not list fails loudly, naming the sync that fixes it', () => {
  const spy = masterSpy({ NIFTY: ['2026-09-22'] })
  assert.throws(
    () => books.expiriesFrom(spy, TODAY),
    (e: unknown) => {
      assert.ok(e instanceof Error)
      assert.match(e.message, /SENSEX/)
      assert.match(e.message, /make sync/)
      return true
    },
  )
})

// ----------------------------------------------------------- the daily rule

test('a non-trading day is a no-op: empty plan, and applyRoll issues no calls', async () => {
  // Ganesh Chaturthi (a Monday) and a Saturday. The cron line is weekdays
  // only, but a holiday weekday fires it, and a hand run can be any day. No
  // book is created for a session that will not happen, and nothing is
  // retired either — the retire half must not run without the create half.
  for (const todayIst of ['2026-09-14', '2026-09-19']) {
    const rows = legacyRows()
    const plan = planRoll({ targets: TARGETS, rows, heldByTag: allFlat(rows), todayIst })
    assert.equal(plan.tradingDay, false, `${todayIst} is not a trading day`)
    assert.equal(plan.symbols.length, 0)
    assert.deepEqual([...plan.alarms], [])
    assert.deepEqual([...createdBooks(plan)], [])
    assert.deepEqual([...stoppedTags(plan)], [])
    assert.deepEqual([...erasedTags(plan)], [])
    const rec = recorder()
    const done = await applyRoll(plan, { request: rec.request })
    assert.deepEqual(done, { created: 0, started: 0, switchedOn: 0, stopped: 0, erased: 0, settled: 0, refused: [] })
    assert.deepEqual(rec.calls, [])
  }
  assert.equal(plainPlan([]).tradingDay, true, 'and a Tuesday is')
})

test("today's four are created and started when absent", () => {
  const plan = plainPlan([])
  assert.equal(plan.tradingDay, true)
  assert.deepEqual(
    plan.symbols.flatMap((s) => s.ensure.map((e) => e.why)),
    TODAYS.map(() => 'missing'),
  )
  assert.deepEqual(createdBooks(plan).map((b) => b.tag), TODAYS)
  assert.equal(symbolPlan(plan, 'NIFTY').targetExpiry, '2026-09-22')
  assert.equal(symbolPlan(plan, 'SENSEX').targetExpiry, '2026-09-24')
  assert.deepEqual([...plan.alarms], [])
})

test("a converged desk — today's four running — creates, stops and erases nothing", () => {
  const plan = plainPlan(rowsFor(TODAY, LIVE))
  assert.deepEqual([...createdBooks(plan)], [])
  assert.deepEqual([...stoppedTags(plan)], [])
  assert.deepEqual([...erasedTags(plan)], [])
  assert.equal(plan.symbols.flatMap((s) => s.onTarget).length, TODAYS.length)
  assert.equal(plan.symbols.flatMap((s) => s.retire).length, 0)
  assert.deepEqual([...plan.alarms], [])
  assert.deepEqual([...plan.anomalies], [])
})

test("yesterday's book is erased this morning — stopped first, then DELETE", () => {
  // Monday's four, still running at 08:45 Tuesday: flat since 15:00 (D4), and
  // their day is before today. Operator, 2026-10-05: "which is done and
  // closed, why still on tab" — a finished book leaves the Books page the
  // same morning. Still running, so the erase is a stop THEN a DELETE.
  const yesterday = rowsFor(YESTERDAY, { nifty: '2026-09-22', sensex: '2026-09-24' })
  const plan = plainPlan(yesterday)
  for (const r of yesterday) {
    const entry = retireFor(plan, r.tag)
    assert.equal(entry.action, 'erase')
    assert.equal(entry.day, YESTERDAY)
  }
  assert.deepEqual([...stoppedTags(plan)].sort(), yesterday.map((r) => r.tag).sort(), 'a running row is stopped first')
  assert.deepEqual([...erasedTags(plan)].sort(), yesterday.map((r) => r.tag).sort())
  assert.equal(createdBooks(plan).length, TODAYS.length, "today's books are created in the same run")
  assert.deepEqual([...plan.alarms], [])
})

test('a book two sessions old is erased too — stop then DELETE', () => {
  // Friday the 18th's four, somehow still running on Tuesday (the Monday run
  // did not happen). Their day is before today, so they are erased, and
  // because they are still running the erase is a stop THEN a DELETE.
  const friday = rowsFor('2026-09-18', { nifty: '2026-09-22', sensex: '2026-09-24' })
  const plan = plainPlan(friday)
  for (const r of friday) {
    const entry = retireFor(plan, r.tag)
    assert.equal(entry.action, 'erase')
    assert.equal(entry.day, '2026-09-18')
  }
  assert.deepEqual([...stoppedTags(plan)].sort(), friday.map((r) => r.tag).sort(), 'a running row is stopped first')
  assert.deepEqual([...erasedTags(plan)].sort(), friday.map((r) => r.tag).sort())
  assert.deepEqual([...plan.alarms], [])
})

test("Monday after Friday: Friday's book is stopped AND erased on Monday, in one run", () => {
  // The cutoff is today. On Monday the 28th, Friday the 25th's book and
  // Thursday the 24th's are both from an earlier session: each is stopped
  // (still running) and erased in the same run.
  const monday = '2026-09-28'
  const expiries = { nifty: '2026-09-29', sensex: '2026-10-01' }
  const targetsMon = books.planBooks(expiries, monday)
  const fridays = rowsFor('2026-09-25', expiries)
  const thursdays = rowsFor('2026-09-24', expiries)
  const plan = plainPlan([...fridays, ...thursdays], monday, targetsMon)
  for (const r of fridays) assert.equal(retireFor(plan, r.tag).action, 'erase', `${r.tag} on Monday`)
  for (const r of thursdays) assert.equal(retireFor(plan, r.tag).action, 'erase', `${r.tag} on Monday`)
  const all = [...fridays, ...thursdays].map((r) => r.tag).sort()
  assert.deepEqual([...stoppedTags(plan)].sort(), all, 'every running row is stopped before its DELETE')
  assert.deepEqual([...erasedTags(plan)].sort(), all)

  // A Friday book left stopped and registered (a refused DELETE, say) is
  // erased on the next run without a second stop.
  const tuesday = '2026-09-29'
  const targetsTue = books.planBooks(expiries, tuesday)
  const fridaysStopped = rowsFor('2026-09-25', expiries, { desired: 'stopped' })
  const later = plainPlan(fridaysStopped, tuesday, targetsTue)
  for (const r of fridaysStopped) assert.equal(retireFor(later, r.tag).action, 'erase', `${r.tag} on Tuesday`)
  assert.deepEqual([...stoppedTags(later)], [], 'already stopped — no second stop')
  assert.deepEqual([...erasedTags(later)].sort(), fridaysStopped.map((r) => r.tag).sort())
})

test("over a holiday: the Tuesday after Ganesh Chaturthi, Friday's book is erased", () => {
  // 2026-09-14 (Monday) was a holiday, so the session before Tuesday the 15th
  // is Friday the 11th. The cutoff is today, so the gap changes nothing:
  // Friday's book is from an earlier session and goes this morning.
  const tuesday = '2026-09-15'
  const expiries = { nifty: '2026-09-15', sensex: '2026-09-17' }
  const targets = books.planBooks(expiries, tuesday)
  const fridays = rowsFor('2026-09-11', expiries)
  const plan = plainPlan(fridays, tuesday, targets)
  for (const r of fridays) assert.equal(retireFor(plan, r.tag).action, 'erase')
  assert.deepEqual([...stoppedTags(plan)].sort(), fridays.map((r) => r.tag).sort())
  assert.deepEqual([...erasedTags(plan)].sort(), fridays.map((r) => r.tag).sort())
})

test("a book created TODAY that is not one of today's four is only stopped — the one place `stop` stays terminal", () => {
  // A hand-registered extra delta-lean row from this morning: not before the
  // cutoff, so it is not erased; it is not a target, so it is stopped.
  const extra = rowsFor(TODAY, LIVE).map((r) => ({ ...r, tag: `${r.tag}-extra` }))
  const plan = plainPlan([...rowsFor(TODAY, LIVE), ...extra])
  for (const r of extra) assert.equal(retireFor(plan, r.tag).action, 'stop', r.tag)
  assert.deepEqual([...stoppedTags(plan)].sort(), extra.map((r) => r.tag).sort())
  assert.deepEqual([...erasedTags(plan)], [])
})

test('the four legacy weekly-tag rows are retired by variant and dial on the first run', () => {
  // Their tags carry an expiry and no trading day. The roll never reads the
  // tag: the rows are ours because `variant` names a preset and the dial is
  // on, and their day is `istDate(createdAt)` = 2026-09-15, well before the
  // cutoff — so all four are erased (stop then DELETE) on 2026-09-22.
  const rows = legacyRows()
  const plan = plainPlan(rows)
  for (const tag of LEGACY_TAGS) {
    const entry = retireFor(plan, tag)
    assert.equal(entry.action, 'erase', tag)
    assert.equal(entry.day, '2026-09-15', 'IST day, not the UTC slice (which would say the 15th too — but 39 s later it would not)')
  }
  assert.deepEqual([...stoppedTags(plan)].sort(), [...LEGACY_TAGS].sort())
  assert.deepEqual([...erasedTags(plan)].sort(), [...LEGACY_TAGS].sort())
  assert.equal(createdBooks(plan).length, TODAYS.length)
  assert.deepEqual([...plan.alarms], [])
  assert.deepEqual([...plan.anomalies], [])
})

test('an already-stopped flat row from yesterday, or older, is erased without a stop', () => {
  const yesterdayStopped = rowsFor(YESTERDAY, LIVE, { desired: 'stopped' })
  const fridayStopped = rowsFor('2026-09-18', LIVE, { desired: 'stopped' })
  const plan = plainPlan([...yesterdayStopped, ...fridayStopped])
  for (const r of yesterdayStopped) assert.equal(retireFor(plan, r.tag).action, 'erase', r.tag)
  for (const r of fridayStopped) assert.equal(retireFor(plan, r.tag).action, 'erase', r.tag)
  assert.deepEqual([...stoppedTags(plan)], [], 'nothing here is running, so nothing is stopped')
  assert.deepEqual(
    [...erasedTags(plan)].sort(),
    [...yesterdayStopped, ...fridayStopped].map((r) => r.tag).sort(),
  )
  assert.deepEqual([...plan.alarms], [], 'a stopped flat row is normal, not an alarm')
})

test('a holder or an unreadable book from an earlier session is neither stopped nor erased', () => {
  const friday = rowsFor('2026-09-18', LIVE)
  const [holder, unreadable] = friday as [RegistryRow, RegistryRow, ...RegistryRow[]]
  const plan = planRoll({
    targets: TARGETS,
    rows: friday,
    heldByTag: { ...allFlat(friday), [holder.tag]: 3, [unreadable.tag]: null },
    todayIst: TODAY,
  })
  assert.equal(retireFor(plan, holder.tag).action, 'holds-legs')
  assert.equal(retireFor(plan, unreadable.tag).action, 'unknown')
  assert.ok(!stoppedTags(plan).includes(holder.tag))
  assert.ok(!stoppedTags(plan).includes(unreadable.tag))
  assert.ok(!erasedTags(plan).includes(holder.tag))
  assert.ok(!erasedTags(plan).includes(unreadable.tag))
  assert.equal(erasedTags(plan).length, friday.length - 2, 'the flat others are still erased')

  const alarm = plan.alarms.find((a) => a.includes(holder.tag))
  assert.ok(alarm !== undefined, 'a book left running with legs must be reported')
  assert.match(alarm, /NOT STOPPED/)
  // The operator needs the count and the reason, not just the tag: "3 open
  // legs" is what tells them whether to flatten by hand before 15:00.
  assert.match(alarm, /3 open leg/)
  assert.match(alarm, /flatten/)
  assert.ok(plan.alarms.some((a) => a.includes(unreadable.tag) && /CANNOT TELL/.test(a)))
  // The new books are created ANYWAY. A book that cannot be retired must not
  // also block today's books from being covered.
  assert.equal(createdBooks(plan).length, TODAYS.length)
})

test('a row with no readable createdAt is stopped but never erased, and reported', () => {
  // The shape production actually produces: `bookFromDoc` (books-registry.ts)
  // answers `createdAt: 0` for a document that has none or carries a
  // non-number, never NaN. `Number.isFinite(0)` is true and `istDate(0)` is
  // 1970-01-01, which is before every cutoff — so a guard that only asked
  // "is it finite" would ERASE such a row. 0 must read as unknown.
  for (const [label, bad] of [['0 (bookFromDoc sentinel)', 0], ['NaN', Number.NaN]] as const) {
    const rows = rowsFor(YESTERDAY, LIVE).map((r, i) => (i === 0 ? ({ ...r, createdAt: bad } as RegistryRow) : r))
    const [odd] = rows as [RegistryRow, ...RegistryRow[]]
    const plan = plainPlan(rows)
    const entry = retireFor(plan, odd.tag)
    assert.equal(entry.action, 'stop', label)
    assert.equal(entry.day, null, label)
    assert.ok(stoppedTags(plan).includes(odd.tag), label)
    assert.ok(!erasedTags(plan).includes(odd.tag), label)
    assert.ok(
      plan.anomalies.some((a) => a.includes(odd.tag) && /createdAt/.test(a) && /never erased/.test(a)),
      label,
    )

    // Its three flat twins from yesterday are erased; it is not.
    const twins = rows.filter((r) => r.tag !== odd.tag).map((r) => r.tag).sort()
    assert.deepEqual([...erasedTags(plan)].sort(), twins, label)

    // The same row already stopped: left alone, and still reported — while
    // the twins, stopped too, are erased without a stop.
    const stopped = plainPlan(rows.map((r) => ({ ...r, desired: 'stopped', actual: 'stopped' })))
    assert.equal(retireFor(stopped, odd.tag).action, 'stopped-flat', label)
    assert.deepEqual([...erasedTags(stopped)].sort(), twins, label)
    assert.deepEqual([...stoppedTags(stopped)], [], label)
    assert.ok(stopped.anomalies.some((a) => a.includes(odd.tag)), label)
  }
})

test("retire is withheld when today's books would not all be running", () => {
  // The one way a symbol ends the ensure step uncovered: one of today's NIFTY
  // rows was stopped by hand and nothing old is RUNNING to justify starting
  // it — but the old, already-stopped legacy rows are past the cutoff. On
  // NIFTY the erase is withheld; on SENSEX, fully covered, it goes ahead.
  const today = rowsFor(TODAY, LIVE).map((r) =>
    r.tag === NIFTY_CONS ? { ...r, desired: 'stopped', actual: 'stopped' } : r,
  )
  const rows = [...today, ...legacyRows('stopped')]
  const plan = plainPlan(rows)
  assert.deepEqual(symbolPlan(plan, 'NIFTY').leftStopped.map((t) => t.row.tag), [NIFTY_CONS])
  assert.equal(retireFor(plan, LEGACY_TAGS[0]).action, 'blocked')
  assert.equal(retireFor(plan, LEGACY_TAGS[1]).action, 'blocked')
  assert.equal(retireFor(plan, LEGACY_TAGS[2]).action, 'erase')
  assert.equal(retireFor(plan, LEGACY_TAGS[3]).action, 'erase')
  assert.deepEqual([...stoppedTags(plan)], [])
  assert.deepEqual([...erasedTags(plan)].sort(), [LEGACY_TAGS[2], LEGACY_TAGS[3]].sort())
  assert.ok(plan.alarms.some((a) => a.includes(LEGACY_TAGS[0]) && /RETIRE WITHHELD/.test(a) && /NIFTY/.test(a)))

  // The same with the legacy rows still RUNNING: today's stopped row is
  // started for the retire ('stopped-but-needed'), so nothing is withheld.
  const covered = plainPlan([...today, ...legacyRows()])
  assert.deepEqual(symbolPlan(covered, 'NIFTY').ensure.map((e) => e.why), ['stopped-but-needed'])
  for (const tag of LEGACY_TAGS) assert.equal(retireFor(covered, tag).action, 'erase')
})

test('a symbol with NO target books is never covered: every retire on it is withheld', () => {
  // `planBooks` iterates every symbol and throws on a missing expiry, so this
  // cannot happen through `main` today. It is pinned anyway: a plan that
  // dropped a symbol must not read "all zero of its books are running" as
  // covered and retire every book of that symbol with nothing replacing it —
  // the one case the WITHHELD guard exists for.
  const niftyOnly = TARGETS.filter((t) => t.symbol === 'NIFTY')
  const plan = plainPlan(legacyRows(), TODAY, niftyOnly)
  assert.equal(retireFor(plan, LEGACY_TAGS[0]).action, 'erase', 'NIFTY is covered by its two targets')
  assert.equal(retireFor(plan, LEGACY_TAGS[1]).action, 'erase')
  assert.equal(retireFor(plan, LEGACY_TAGS[2]).action, 'blocked', 'SENSEX has no target, so nothing may go')
  assert.equal(retireFor(plan, LEGACY_TAGS[3]).action, 'blocked')
  assert.deepEqual([...stoppedTags(plan)].sort(), [LEGACY_TAGS[0], LEGACY_TAGS[1]].sort())
  assert.deepEqual([...erasedTags(plan)].sort(), [LEGACY_TAGS[0], LEGACY_TAGS[1]].sort())
  for (const tag of [LEGACY_TAGS[2], LEGACY_TAGS[3]]) {
    assert.ok(plan.alarms.some((a) => a.includes(tag) && /RETIRE WITHHELD/.test(a) && /SENSEX/.test(a)))
  }
})

test("a stopped book on today's tag is started only when something needs retiring", () => {
  // The two halves of one rule. With legacy rows still running, today's
  // stopped row has to run before they can go ('stopped-but-needed'). With
  // nothing to retire, a stopped book on today's tag is the operator's call.
  const todayStopped = rowsFor(TODAY, LIVE, { desired: 'stopped' })
  const needed = plainPlan([...todayStopped, ...legacyRows()])
  assert.deepEqual(
    needed.symbols.flatMap((s) => s.ensure.map((e) => e.why)),
    TODAYS.map(() => 'stopped-but-needed'),
  )
  const alone = plainPlan(todayStopped)
  assert.deepEqual([...createdBooks(alone)], [])
  assert.equal(alone.symbols.flatMap((s) => s.leftStopped).length, TODAYS.length)
})

test("a stopped book on today's tag is NOT started for an old book this run will leave running", () => {
  // "Needed" means a retire is actually going to happen. An old book that
  // holds legs (or cannot be read) is left running whatever today's books do,
  // so it is no reason to reverse the operator's stop — and, since every
  // start is followed by the switch PATCH, no reason to flip that book's
  // switch either. Runbook §7.1: restarted ONLY when needed to retire one.
  const todayStopped = rowsFor(TODAY, LIVE, { desired: 'stopped' })
  const rows = [...todayStopped, ...legacyRows()]
  const plan = planRoll({
    targets: TARGETS,
    rows,
    heldByTag: {
      ...allFlat(rows),
      [LEGACY_TAGS[0]]: 2, // NIFTY aggressive: holding
      [LEGACY_TAGS[1]]: 1, // NIFTY conservative: holding
      [LEGACY_TAGS[2]]: null, // SENSEX aggressive: unreadable
      [LEGACY_TAGS[3]]: null, // SENSEX conservative: unreadable
    },
    todayIst: TODAY,
  })
  assert.deepEqual(plan.symbols.flatMap((s) => s.ensure), [], 'nothing is started, so nothing is switched on')
  assert.equal(plan.symbols.flatMap((s) => s.leftStopped).length, TODAYS.length)
  assert.deepEqual([...stoppedTags(plan)], [])
  assert.deepEqual([...erasedTags(plan)], [])
  assert.equal(retireFor(plan, LEGACY_TAGS[0]).action, 'holds-legs')
  assert.equal(retireFor(plan, LEGACY_TAGS[2]).action, 'unknown')

  // Mixed: one old NIFTY book flat and running, the other holding. The flat
  // one WILL be retired, so today's NIFTY books are needed; SENSEX, whose old
  // books are both unreadable, is not.
  const mixed = planRoll({
    targets: TARGETS,
    rows,
    heldByTag: { ...allFlat(rows), [LEGACY_TAGS[1]]: 1, [LEGACY_TAGS[2]]: null, [LEGACY_TAGS[3]]: null },
    todayIst: TODAY,
  })
  assert.deepEqual(
    symbolPlan(mixed, 'NIFTY').ensure.map((e) => e.why),
    TODAYS.filter((t) => t.startsWith('NIFTY')).map(() => 'stopped-but-needed'),
  )
  assert.deepEqual(symbolPlan(mixed, 'SENSEX').ensure, [])
  assert.equal(retireFor(mixed, LEGACY_TAGS[0]).action, 'erase')
  assert.equal(retireFor(mixed, LEGACY_TAGS[1]).action, 'holds-legs')
})

// ------------------------------------------ the retire that must not happen

test('a stopped book still holding is an alarm, not a silence', () => {
  // Nothing here can fix it — the roll will not restart a book to flatten it —
  // so the only useful act is to say so every morning until someone does.
  const rows = [...rowsFor(TODAY, LIVE), ...legacyRows('stopped').filter((r) => r.tag === LEGACY_SENSEX_AGG)]
  const plan = planRoll({
    targets: TARGETS,
    rows,
    heldByTag: { ...allFlat(rows), [LEGACY_SENSEX_AGG]: 2 },
    todayIst: TODAY,
  })
  assert.equal(retireFor(plan, LEGACY_SENSEX_AGG).action, 'stopped-holds-legs')
  assert.deepEqual([...stoppedTags(plan)], [])
  assert.deepEqual([...erasedTags(plan)], [])
  assert.deepEqual([...createdBooks(plan)], [], 'a stopped old book is not a reason to create anything')
  assert.ok(plan.alarms.some((a) => a.includes(LEGACY_SENSEX_AGG) && /does not flatten itself/.test(a)))

  const unknown = planRoll({ targets: TARGETS, rows, heldByTag: { ...allFlat(rows), [LEGACY_SENSEX_AGG]: null }, todayIst: TODAY })
  assert.equal(retireFor(unknown, LEGACY_SENSEX_AGG).action, 'stopped-unknown')
  assert.deepEqual([...erasedTags(unknown)], [])
})

test('openLegCount: a zero-qty leg is flat, an unreadable one is unknown', () => {
  assert.equal(roll.openLegCount([]), 0, 'a book that has traded and closed out is flat')
  assert.equal(roll.openLegCount([{ qty: -20 }, { qty: 40 }]), 2)
  // Legs are counted, never netted: two opposite legs on one contract are still
  // two positions, and counting them as holding errs toward NOT stopping.
  assert.equal(roll.openLegCount([{ qty: 20 }, { qty: -20 }]), 2)
  assert.equal(roll.openLegCount([{ qty: 0 }]), 0, 'a leg that reached zero is not a position')
  assert.equal(roll.openLegCount(undefined), null, 'a document with no legs array answers nothing')
  assert.equal(roll.openLegCount([{ qty: Number.NaN }]), null)
  assert.equal(roll.openLegCount([{ qty: 20 }, {}]), null, 'one unreadable leg makes the whole answer unknown')
})

// -------------------------------------------------- never somebody else's book

test('a book that is not delta-lean is invisible to the roll, tag or no tag', () => {
  const foreign: RegistryRow = {
    // The tag SAYS delta-lean and the row is old. Filtering on a substring
    // would erase a live recenter book on a symbol this script does not even
    // manage.
    tag: 'TCS-delta-lean-aggressive-2026-09-15',
    symbol: 'TCS',
    expiry: '2026-09-29',
    mode: 'paper',
    variant: 'recenter-relief-r',
    dials: { margin_cap: 120000 },
    desired: 'running',
    actual: 'running',
    createdAt: LEGACY_CREATED_AT,
  }
  const rows = [...rowsFor(TODAY, LIVE), foreign]
  const plan = plainPlan(rows)
  assert.equal(roll.isDeltaLean(foreign), false)
  assert.deepEqual([...stoppedTags(plan)], [])
  assert.deepEqual([...erasedTags(plan)], [])
  assert.deepEqual([...createdBooks(plan)], [])
  // Not an anomaly either — somebody else's book is normal, not a fault.
  assert.deepEqual([...plan.anomalies], [])
})

test('a row whose variant and dial disagree is reported, never guessed at', () => {
  // A row carrying a delta-lean variant but running the recenter engine is a
  // misconfiguration. Rolling it would be acting on a book whose behaviour this
  // script has mis-read; picking the other reading would be worse.
  const confused: RegistryRow = {
    ...(legacyRows().find((b) => b.tag === LEGACY_SENSEX_AGG) as RegistryRow),
    dials: { delta_lean_enabled: false },
  }
  const rows = [...rowsFor(TODAY, LIVE), confused]
  const plan = plainPlan(rows)
  assert.deepEqual([...stoppedTags(plan)], [])
  assert.deepEqual([...erasedTags(plan)], [])
  assert.equal(plan.anomalies.length, 1)
  assert.match(plan.anomalies[0] ?? '', new RegExp(LEGACY_SENSEX_AGG))
  assert.match(plan.anomalies[0] ?? '', /LEFT UNTOUCHED/)
})

test('a delta-lean row on a symbol this script does not manage is reported, not rolled', () => {
  const orphan: RegistryRow = {
    tag: 'BANKNIFTY-delta-lean-aggressive-2026-09-15',
    symbol: 'BANKNIFTY',
    expiry: '2026-09-24',
    mode: 'paper',
    variant: 'delta-lean-aggressive',
    dials: { delta_lean_enabled: true },
    desired: 'running',
    actual: 'running',
    createdAt: LEGACY_CREATED_AT,
  }
  const rows = [...rowsFor(TODAY, LIVE), orphan]
  const plan = plainPlan(rows)
  assert.deepEqual([...stoppedTags(plan)], [])
  assert.deepEqual([...erasedTags(plan)], [])
  assert.ok(plan.anomalies.some((a) => a.includes('BANKNIFTY')))
})

// ------------------------------------- legs on a dead contract (spec §WS1 1a)

/**
 * Monday 2026-10-05, the first roll after the box was found holding legs on
 * contracts that expired days earlier. The previous trading day is Thursday
 * the 1st — Friday the 2nd was Gandhi Jayanti. The erase cutoff is today.
 */
const MON = '2026-10-05'
const MON_LIVE: Expiries = { nifty: '2026-10-06', sensex: '2026-10-08' }
const MON_TARGETS = books.planBooks(MON_LIVE, MON)
const SENSEX_1001 = 'SENSEX-delta-lean-aggressive-2026-10-01'
const SENSEX_0930 = 'SENSEX-delta-lean-aggressive-2026-09-30'

function dlRow(tag: string, createdDay: string, desired: 'running' | 'stopped' = 'running'): RegistryRow {
  const dials = (TARGETS.find((t) => t.variant === 'delta-lean-aggressive') as BookPlan).dials
  return {
    tag,
    symbol: 'SENSEX',
    expiry: '2026-10-01',
    mode: 'paper',
    variant: 'delta-lean-aggressive',
    dials,
    desired,
    actual: desired,
    createdAt: nineAmIst(createdDay),
  }
}

/** A September stock book — not delta-lean, contract expired 09-29. */
function stockRow(symbol: string, desired: 'running' | 'stopped' = 'running', expiry = '2026-09-29'): RegistryRow {
  return {
    tag: `${symbol}-2026-09-29-recenter-relief-r`,
    symbol,
    expiry,
    mode: 'paper',
    variant: 'recenter-relief-r',
    dials: { margin_cap: 5000000, target_pnl: 50000, delta_shorts_only: true, gamma_shorts_only: true },
    desired,
    actual: desired,
    createdAt: nineAmIst('2026-09-07'),
  }
}

function monPlan(
  extra: readonly RegistryRow[],
  held: Readonly<Record<string, number | null>>,
  expired: Readonly<Record<string, number | null>>,
): RollPlan {
  const rows = [...rowsFor(MON, MON_LIVE), ...extra]
  return planRoll({
    targets: MON_TARGETS,
    rows,
    heldByTag: { ...allFlat(rows), ...held },
    expiredByTag: expired,
    todayIst: MON,
  })
}

function expiredFor(plan: RollPlan, tag: string): RetireEntry {
  const found = plan.expiredBooks.find((e) => e.row.tag === tag)
  assert.ok(found !== undefined, `${tag} is not in the expired-books set`)
  return found
}

test('expiredLegCount: an open leg whose contract expired before today counts; today, zero and unreadable do not', () => {
  const legs = [
    { qty: 80, expiry: '2026-10-01' },
    { qty: -40, expiry: '2026-10-05' }, // expires TODAY — still trading
    { qty: 0, expiry: '2026-09-29' }, // reached zero — not a position
  ]
  assert.equal(roll.expiredLegCount(legs, MON), 1)
  assert.equal(roll.expiredLegCount([], MON), 0)
  assert.equal(roll.expiredLegCount(undefined, MON), null)
  assert.equal(roll.expiredLegCount([{ qty: 80 }], MON), null, 'a leg with no expiry is unknown, never "live"')
  assert.equal(roll.expiredLegCount([{ qty: Number.NaN, expiry: '2026-10-01' }], MON), null)
})

test('a delta-lean book holding ONLY expired legs is settled, then retired by the usual day rule', () => {
  const sameDay = 'SENSEX-delta-lean-aggressive-2026-10-05-extra'
  const plan = monPlan(
    [dlRow(SENSEX_1001, '2026-10-01'), dlRow(SENSEX_0930, '2026-09-30', 'stopped'), dlRow(sameDay, MON)],
    { [SENSEX_1001]: 1, [SENSEX_0930]: 1, [sameDay]: 1 },
    { [SENSEX_1001]: 1, [SENSEX_0930]: 1, [sameDay]: 1 },
  )
  // Created on the previous trading day and still running: settled, stopped
  // and erased in this one run.
  assert.equal(retireFor(plan, SENSEX_1001).action, 'settle-then-erase')
  // Older and already stopped: settled and erased, no stop.
  assert.equal(retireFor(plan, SENSEX_0930).action, 'settle-then-erase')
  // Created TODAY but not one of today's four: settled and only stopped.
  assert.equal(retireFor(plan, sameDay).action, 'settle-then-stop')
  assert.deepEqual([...stoppedTags(plan)].sort(), [SENSEX_1001, sameDay].sort())
  assert.deepEqual([...erasedTags(plan)].sort(), [SENSEX_0930, SENSEX_1001].sort())
  assert.deepEqual([...plan.alarms], [], 'a leg on a dead contract is a settlement, not an alarm')
})

test('a delta-lean book holding one expired and one LIVE leg is left running and alarmed, as before', () => {
  const plan = monPlan([dlRow(SENSEX_0930, '2026-09-30')], { [SENSEX_0930]: 2 }, { [SENSEX_0930]: 1 })
  assert.equal(retireFor(plan, SENSEX_0930).action, 'holds-legs')
  assert.deepEqual([...stoppedTags(plan)], [])
  assert.deepEqual([...erasedTags(plan)], [])
  assert.ok(plan.alarms.some((a) => a.includes(SENSEX_0930) && /NOT STOPPED/.test(a)))
})

test('the fourth loop: every OTHER paper book whose contract expired before today is retired', () => {
  const tcs = stockRow('TCS')
  const tata = stockRow('TATASTEEL')
  const kalyan = stockRow('KALYANKJIL', 'stopped')
  const october = { ...stockRow('INFY'), tag: 'INFY-2026-10-27-recenter-relief-r', expiry: '2026-10-27' }
  // Expired on the previous session (Thursday the 1st; the 2nd was a
  // holiday) — "yesterday" as the desk counts it: retired this morning.
  const lastSession = { ...stockRow('ITC'), tag: 'ITC-2026-10-01-recenter-relief-r', expiry: '2026-10-01' }
  // Expires TODAY: still trading, so not yet.
  const today = { ...stockRow('HDFCBANK'), tag: 'HDFCBANK-2026-10-05-recenter-relief-r', expiry: MON }
  const plan = monPlan([tcs, tata, kalyan, october, lastSession, today], { [tcs.tag]: 1 }, { [tcs.tag]: 1 })

  assert.equal(expiredFor(plan, tcs.tag).action, 'settle-then-erase')
  assert.equal(expiredFor(plan, tata.tag).action, 'erase')
  assert.equal(expiredFor(plan, kalyan.tag).action, 'erase')
  assert.equal(expiredFor(plan, lastSession.tag).action, 'erase')
  assert.ok(!plan.expiredBooks.some((e) => e.row.tag === october.tag), 'a book on a live contract is not touched')
  assert.ok(!plan.expiredBooks.some((e) => e.row.tag === today.tag), 'a contract expiring today is still live')
  // A running one is stopped before its erase; a stopped one is only erased.
  assert.deepEqual([...stoppedTags(plan)].sort(), [lastSession.tag, tcs.tag, tata.tag].sort())
  assert.deepEqual([...erasedTags(plan)].sort(), [kalyan.tag, lastSession.tag, tata.tag, tcs.tag].sort())
  // The delta-lean half is not disturbed by the other family.
  assert.deepEqual(plan.symbols.flatMap((s) => s.retire), [])

  // Calendar yesterday on an ordinary Tuesday: expired Monday the 21st is
  // retired on the 22nd; expiring the 22nd is not.
  const monday = { ...stockRow('SBIN'), tag: 'SBIN-2026-09-21-recenter-relief-r', expiry: YESTERDAY }
  const tuesday = { ...stockRow('SBIN'), tag: 'SBIN-2026-09-22-recenter-relief-r', expiry: TODAY }
  const tue = plainPlan([...rowsFor(TODAY, LIVE), monday, tuesday])
  assert.equal(tue.expiredBooks.find((e) => e.row.tag === monday.tag)?.action, 'erase')
  assert.ok(!tue.expiredBooks.some((e) => e.row.tag === tuesday.tag), 'a contract expiring today is still live')
})

test('the fourth loop alarms on a leg in a live contract and on an unreadable book, and touches neither', () => {
  const rolled = stockRow('TCS')
  const unreadable = stockRow('TATASTEEL')
  const plan = monPlan([rolled, unreadable], { [rolled.tag]: 2, [unreadable.tag]: null }, { [rolled.tag]: 1 })
  assert.equal(expiredFor(plan, rolled.tag).action, 'holds-legs')
  assert.equal(expiredFor(plan, unreadable.tag).action, 'unknown')
  assert.deepEqual([...stoppedTags(plan)], [])
  assert.deepEqual([...erasedTags(plan)], [])
  assert.ok(plan.alarms.some((a) => a.includes(rolled.tag) && /live contract/.test(a)))
  assert.ok(plan.alarms.some((a) => a.includes(unreadable.tag)))
})

test('the fourth loop never takes a row whose variant and dial disagree — that stays an anomaly', () => {
  const confused: RegistryRow = { ...stockRow('TCS'), variant: 'delta-lean-aggressive', dials: { delta_lean_enabled: false } }
  const plan = monPlan([confused], {}, {})
  assert.deepEqual([...plan.expiredBooks], [])
  assert.ok(plan.anomalies.some((a) => a.includes(confused.tag)))
})

// ---------------------------------------------------- orphan strategy rows

test('planOrphans: an EXTERNAL row with no registry row on either rail — never a hosted one, never by tag', () => {
  const plan = roll.planOrphans({
    strategies: [
      // A hosted strategy has no book by design. Never an orphan.
      { tag: 'MIRROR_A006', kind: 'hosted', modes: { paper: { enabled: false } } },
      // Emptied by an erase that predates the row delete.
      { tag: 'BHEL-2026-08-25-recenter-r', kind: 'external', modes: {} },
      // Erased book, switch left ON.
      { tag: 'NIFTY-delta-lean-aggressive-2026-09-29', kind: 'external', modes: { paper: { enabled: true } } },
      // Still registered — its book is on the desk.
      { tag: 'TCS-2026-09-29-recenter-relief-r', kind: 'external', modes: { paper: { enabled: true } } },
      // A live membership is never removed from here.
      { tag: 'OLD-LIVE-BOOK', kind: 'external', modes: { live: { enabled: false } } },
    ],
    registered: new Set(['TCS-2026-09-29-recenter-relief-r']),
  })
  assert.deepEqual(plan.prune, [
    { tag: 'BHEL-2026-08-25-recenter-r', modes: [] },
    { tag: 'NIFTY-delta-lean-aggressive-2026-09-29', modes: ['paper'] },
  ])
  assert.deepEqual([...plan.skipped], ['OLD-LIVE-BOOK'])
})

test('--prune-orphans is a flag of its own, documented in --help', () => {
  assert.equal(roll.parseArgs(['--prune-orphans']).pruneOrphans, true)
  assert.equal(roll.parseArgs(['--prune-orphans']).apply, false, 'a dry run unless --apply')
  assert.equal(roll.parseArgs([]).pruneOrphans, false)
  assert.match(roll.HELP, /--prune-orphans/)
})

// ----------------------------------------------------------- paper, always

test('nothing this script can produce is live', () => {
  const plan = plainPlan(legacyRows())
  for (const b of createdBooks(plan)) assert.equal(b.mode, 'paper', `${b.tag} is not paper`)
  for (const s of plan.symbols) for (const e of s.retire) assert.equal(e.row.mode, 'paper')
  assert.equal(roll.PAPER, 'paper')
})

test('a live row reaching the registry read is a refusal, not a case to handle', () => {
  const rows = legacyRows().map((r, i) => (i === 0 ? { ...r, mode: 'live' } : r))
  assert.throws(
    () => plainPlan(rows),
    (e: unknown) => {
      assert.ok(e instanceof Error)
      assert.match(e.message, /REFUSED/)
      assert.match(e.message, /live/)
      return true
    },
  )
})

test('an unrecognised flag is a hard error — there is no flag that changes the mode', () => {
  assert.throws(() => roll.parseArgs(['--mode', 'live']), /unrecognised argument/)
  assert.throws(() => roll.parseArgs(['--force']), /unrecognised argument/)
  assert.equal(roll.parseArgs([]).apply, false, 'the DEFAULT is a dry run')
  assert.equal(roll.parseArgs(['--apply']).apply, true)
})

test('the IST date is the IST date — the box clock is UTC', () => {
  // ONE implementation, in the sibling: both scripts must agree on what day
  // it is or they would plan different tags within the same minute.
  assert.equal(books.istDate(Date.UTC(2026, 8, 22, 3, 15)), '2026-09-22', 'the cron slot')
  // A run by hand at 19:00 UTC is already the next day in Mumbai.
  assert.equal(books.istDate(Date.UTC(2026, 8, 21, 19, 0)), '2026-09-22')
  assert.equal((roll as unknown as Record<string, unknown>)['istDate'], undefined, 'the roll does not restate it')
})

// ----------------------------------------------- the order, against a recorder

/** Records every call in order and answers as a healthy desk-api would. */
function recorder(overrides: Readonly<Record<string, WireResult>> = {}): {
  readonly calls: string[]
  readonly request: Request
} {
  const calls: string[] = []
  return {
    calls,
    async request(method: Method, path: string, body?: unknown): Promise<WireResult> {
      const key = `${method} ${path}`
      calls.push(key)
      const override = overrides[key]
      if (override !== undefined) return override
      if (path.includes('/settle-expired?')) {
        return { status: 200, body: { settled: [{ tradingsymbol: 'X' }], remaining: 0 }, text: '' }
      }
      if (method === 'DELETE') return { status: 200, body: { deleted: path.split('/').at(-1)?.split('?')[0] }, text: '' }
      if (method === 'PATCH') {
        return { status: 200, body: { tag: path.split('/').at(-1), modes: { paper: { enabled: true } } }, text: '' }
      }
      const status = path.endsWith('/start') || path.endsWith('/stop') ? 200 : 201
      return { status, body: { ...(body as object), mode: 'paper' }, text: '' }
    },
  }
}

const REG = '/v1/desk/books/registry'
const STRAT = '/v1/desk/strategies'

test('creates, starts and switch-ons go out first, then every stop, then every delete — and never flatten or purge', async () => {
  const plan = plainPlan(legacyRows())
  const rec = recorder()
  const done = await applyRoll(plan, { request: rec.request })

  assert.deepEqual(done, { created: 7, started: 7, switchedOn: 7, stopped: 4, erased: 4, settled: 0, refused: [] })
  const expected: string[] = []
  for (const tag of TODAYS) {
    expected.push(`POST ${REG}`, `POST ${REG}/${tag}/start`, `PATCH ${STRAT}/${tag}`)
  }
  for (const tag of [LEGACY_TAGS[0], LEGACY_TAGS[1], LEGACY_TAGS[2], LEGACY_TAGS[3]]) expected.push(`POST ${REG}/${tag}/stop`)
  for (const tag of [LEGACY_TAGS[0], LEGACY_TAGS[1], LEGACY_TAGS[2], LEGACY_TAGS[3]]) expected.push(`DELETE ${REG}/${tag}?mode=paper`)
  assert.deepEqual(rec.calls, expected)

  // Not "the source reads that way" — the recorded order says so.
  const lastStart = Math.max(...rec.calls.map((c, i) => (c.endsWith('/start') ? i : -1)))
  const lastStop = Math.max(...rec.calls.map((c, i) => (c.endsWith('/stop') ? i : -1)))
  const firstDelete = rec.calls.findIndex((c) => c.startsWith('DELETE '))
  const firstStop = rec.calls.findIndex((c) => c.endsWith('/stop'))
  assert.ok(firstStop > lastStart, `a stop went out at ${firstStop}, before the start at ${lastStart}`)
  assert.ok(firstDelete > lastStop, `a delete went out at ${firstDelete}, before the stop at ${lastStop}`)
  // The erase is the bare DELETE. `flatten=1` would place orders; `purge=1`
  // would erase the fills and decisions the Reports page is built on.
  assert.ok(!rec.calls.some((c) => /flatten|purge/.test(c)))
})

test('a DELETE 409 is an alarm, not an abort — the other erases still go out', async () => {
  // The server rebuilds the position from the fills and can disagree with
  // `desk-books`. That is its guard doing its job; the row stays stopped and
  // registered, and the operator reads it in ATTENTION. The other three must
  // not be held hostage by it.
  const plan = plainPlan(legacyRows())
  const stuck = LEGACY_SENSEX_AGG
  const text = `'${stuck}' still holds 1 open position(s) in paper — SENSEX26917810000PE -20. Deleting the book would erase the desk's only record of a position that still exists.`
  const rec = recorder({
    [`DELETE ${REG}/${stuck}?mode=paper`]: { status: 409, body: { error: text, legs: ['SENSEX26917810000PE'] }, text },
  })
  const done = await applyRoll(plan, { request: rec.request })
  assert.equal(done.erased, 3)
  assert.equal(done.stopped, 4)
  assert.equal(done.refused.length, 1)
  assert.match(done.refused[0] ?? '', new RegExp(stuck))
  assert.match(done.refused[0] ?? '', /409/)
  assert.match(done.refused[0] ?? '', /still holds 1 open position/)
  assert.equal(rec.calls.filter((c) => c.startsWith('DELETE ')).length, 4, 'all four DELETEs were attempted')
})

test('a DELETE that is not 200 or 409 aborts the run', async () => {
  const plan = plainPlan(legacyRows())
  const rec = recorder({
    [`DELETE ${REG}/${LEGACY_TAGS[1]}?mode=paper`]: { status: 500, body: null, text: 'mongo is down' },
  })
  await assert.rejects(applyRoll(plan, { request: rec.request }), /500/)
})

test('the paper switch is PATCHed on after every start this run issues, and a switch that will not flip aborts', async () => {
  const plan = plainPlan(legacyRows())
  const rec = recorder({
    [`PATCH ${STRAT}/${NIFTY_AGG}`]: {
      status: 400,
      body: null,
      text: `'${NIFTY_AGG}' is not added to paper, so there is no switch to flip`,
    },
  })
  await assert.rejects(applyRoll(plan, { request: rec.request }), /switch on .* 400/)
  // The first book's start went out and its PATCH failed; nothing was stopped.
  assert.deepEqual(rec.calls, [`POST ${REG}`, `POST ${REG}/${NIFTY_AGG}/start`, `PATCH ${STRAT}/${NIFTY_AGG}`])
  assert.deepEqual(rec.calls.filter((c) => c.endsWith('/stop')), [])
  assert.deepEqual(rec.calls.filter((c) => c.startsWith('DELETE')), [])
})

test('the roll never PATCHes a book the day guard switched off — a hand re-run does not undo a guard trip', async () => {
  // A day guard that tripped a running book turns its paper switch off and
  // stamps `disabledByGuard`. A hand re-run the same day must not flip it
  // back on. Today's four running, planned without the switches, with every
  // switch on, and with one tripped by the guard: no call at all.
  const rows = rowsFor(TODAY, LIVE)
  const on: Record<string, SwitchState> = Object.fromEntries(rows.map((r) => [r.tag, { paper: 'on', guard: null }]))
  const tripped: Record<string, SwitchState> = { ...on, [NIFTY_AGG]: { paper: 'off', guard: { day: TODAY, trigger: 'stop' } } }
  for (const switches of [null, on, tripped]) {
    const plan = planRoll({
      targets: TARGETS,
      rows,
      heldByTag: allFlat(rows),
      ...(switches === null ? {} : { switchByTag: switches }),
      todayIst: TODAY,
    })
    assert.deepEqual([...createdBooks(plan)], [])
    assert.deepEqual([...plan.anomalies], [], 'a guard trip is the desk working, not ATTENTION')
    const rec = recorder()
    const done = await applyRoll(plan, { request: rec.request })
    assert.deepEqual(done, { created: 0, started: 0, switchedOn: 0, stopped: 0, erased: 0, settled: 0, refused: [] })
    assert.deepEqual(rec.calls, [])
  }
})

test("a flat running book from yesterday is stopped, then DELETEd, in one applyRoll", async () => {
  // The new morning rule end to end on the wire: today's books already run,
  // so nothing is created; yesterday's six (no 0-DTE book: Monday was no
  // expiry) are running and flat, so each is stopped — every stop before any
  // DELETE — and erased in this same run.
  const yesterday = rowsFor(YESTERDAY, LIVE)
  assert.equal(yesterday.length, 6)
  const plan = plainPlan([...rowsFor(TODAY, LIVE), ...yesterday])
  const rec = recorder()
  const done = await applyRoll(plan, { request: rec.request })
  assert.deepEqual(done, { created: 0, started: 0, switchedOn: 0, stopped: 6, erased: 6, settled: 0, refused: [] })
  assert.deepEqual(rec.calls, [
    ...yesterday.map((r) => `POST ${REG}/${r.tag}/stop`),
    ...yesterday.map((r) => `DELETE ${REG}/${r.tag}?mode=paper`),
  ])
  for (const r of yesterday) {
    const stop = rec.calls.indexOf(`POST ${REG}/${r.tag}/stop`)
    const del = rec.calls.indexOf(`DELETE ${REG}/${r.tag}?mode=paper`)
    assert.ok(stop >= 0 && del > stop, `${r.tag}: stop at ${stop}, DELETE at ${del}`)
  }
})

test('an already-stopped row from an earlier session is deleted without a stop', async () => {
  const plan = plainPlan([...rowsFor(TODAY, LIVE), ...legacyRows('stopped')])
  const rec = recorder()
  const done = await applyRoll(plan, { request: rec.request })
  assert.deepEqual(done, { created: 0, started: 0, switchedOn: 0, stopped: 0, erased: 4, settled: 0, refused: [] })
  assert.deepEqual(
    rec.calls,
    LEGACY_TAGS.map((tag) => `DELETE ${REG}/${tag}?mode=paper`),
  )
})

test('a create that fails takes the run down before a single stop goes out', async () => {
  const plan = plainPlan(legacyRows())
  const rec = recorder({
    [`POST ${REG}`]: { status: 409, body: null, text: 'a different book holds this tag' },
  })
  await assert.rejects(applyRoll(plan, { request: rec.request }), /409/)
  // The old books are still running. A half-rolled desk with books too many
  // is recoverable; one with none is a session lost silently.
  assert.deepEqual(rec.calls.filter((c) => c.endsWith('/stop')), [])
  assert.deepEqual(rec.calls.filter((c) => c.startsWith('DELETE')), [])
})

test('a registry that echoes a mode other than paper aborts the run', async () => {
  const plan = plainPlan(legacyRows())
  const rec = recorder({
    [`POST ${REG}`]: { status: 201, body: { mode: 'live' }, text: '' },
  })
  await assert.rejects(applyRoll(plan, { request: rec.request }), /REFUSED/)
  assert.deepEqual(rec.calls.filter((c) => c.endsWith('/stop')), [])
})

test('applyRoll refuses at the wire to stop or erase a book it was told holds legs', async () => {
  // Belt and braces over `planRoll`. The stop and the DELETE are the
  // irreversible halves, so the lines that actually send them check again.
  const plan = plainPlan([...rowsFor(TODAY, LIVE), ...legacyRows()])
  const tampered: RollPlan = {
    ...plan,
    symbols: plan.symbols.map((s) => ({
      ...s,
      retire: s.retire.map((e) => ({ ...e, held: 4 })),
    })),
  }
  const rec = recorder()
  await assert.rejects(applyRoll(tampered, { request: rec.request }), /REFUSED at the wire/)
  assert.deepEqual(rec.calls.filter((c) => c.endsWith('/stop')), [])
  assert.deepEqual(rec.calls.filter((c) => c.startsWith('DELETE')), [])

  // And the DELETE half on its own: rows already stopped, so no stop is sent,
  // and the erase must still refuse.
  const stoppedPlan = plainPlan([...rowsFor(TODAY, LIVE), ...legacyRows('stopped')])
  const tamperedStopped: RollPlan = {
    ...stoppedPlan,
    symbols: stoppedPlan.symbols.map((s) => ({ ...s, retire: s.retire.map((e) => ({ ...e, held: 1 })) })),
  }
  const rec2 = recorder()
  await assert.rejects(applyRoll(tamperedStopped, { request: rec2.request }), /REFUSED at the wire/)
  assert.deepEqual(rec2.calls, [])
})

const settlePath = (tag: string): string => `POST ${REG}/${tag}/settle-expired?mode=paper`

test('settles go out before their stops, and the fourth loop runs after every delta-lean loop: settle → stop → erase', async () => {
  const tcs = stockRow('TCS')
  const tata = stockRow('TATASTEEL')
  const plan = monPlan(
    [dlRow(SENSEX_1001, '2026-10-01'), dlRow(SENSEX_0930, '2026-09-30'), tcs, tata],
    { [SENSEX_1001]: 1, [tcs.tag]: 1 },
    { [SENSEX_1001]: 1, [tcs.tag]: 1 },
  )
  const rec = recorder()
  const done = await applyRoll(plan, { request: rec.request })
  assert.deepEqual(rec.calls, [
    // delta-lean: settle, then stops, then erases
    settlePath(SENSEX_1001),
    `POST ${REG}/${SENSEX_1001}/stop`,
    `POST ${REG}/${SENSEX_0930}/stop`,
    `DELETE ${REG}/${SENSEX_1001}?mode=paper`,
    `DELETE ${REG}/${SENSEX_0930}?mode=paper`,
    // the fourth loop, after all of that: settle, then stops, then erases
    settlePath(tcs.tag),
    `POST ${REG}/${tcs.tag}/stop`,
    `POST ${REG}/${tata.tag}/stop`,
    `DELETE ${REG}/${tcs.tag}?mode=paper`,
    `DELETE ${REG}/${tata.tag}?mode=paper`,
  ])
  assert.deepEqual(done, { created: 0, started: 0, switchedOn: 0, stopped: 4, erased: 4, settled: 2, refused: [] })
  assert.ok(!rec.calls.some((c) => /flatten|purge/.test(c)))
})

test('a settle the server refuses (409, no close on file) leaves that book running and registered; the rest still go', async () => {
  const tcs = stockRow('TCS')
  const tata = stockRow('TATASTEEL')
  const plan = monPlan(
    [dlRow(SENSEX_1001, '2026-10-01'), tcs, tata],
    { [SENSEX_1001]: 1, [tcs.tag]: 1 },
    { [SENSEX_1001]: 1, [tcs.tag]: 1 },
  )
  const text = "no close for TCS on 2026-09-29 — NOTHING WAS SETTLED"
  const rec = recorder({
    [settlePath(tcs.tag)]: { status: 409, body: { error: text, leg: 'TCS26SEP2080PE' }, text },
    // A settle that leaves something behind is not a flat book either.
    [settlePath(SENSEX_1001)]: { status: 200, body: { settled: [], remaining: 1 }, text: '' },
  })
  const done = await applyRoll(plan, { request: rec.request })
  assert.ok(!rec.calls.includes(`POST ${REG}/${tcs.tag}/stop`), 'an unsettled book was stopped')
  assert.ok(!rec.calls.includes(`DELETE ${REG}/${tcs.tag}?mode=paper`), 'an unsettled book was erased')
  assert.ok(!rec.calls.includes(`POST ${REG}/${SENSEX_1001}/stop`), 'a book still holding after settle was stopped')
  assert.ok(!rec.calls.includes(`DELETE ${REG}/${SENSEX_1001}?mode=paper`), 'a book still holding after settle was erased')
  assert.ok(rec.calls.includes(`DELETE ${REG}/${tata.tag}?mode=paper`), 'the flat book was held hostage')
  assert.equal(done.settled, 0)
  assert.equal(done.refused.length, 2)
  assert.ok(done.refused.some((r) => r.includes(tcs.tag) && /409/.test(r)))
  assert.ok(done.refused.some((r) => r.includes(SENSEX_1001) && /remaining/.test(r)))
})

test('ANY non-200 settle (a 404 from a desk-api not yet on this build, a 500) is a per-book refusal, never an abort', async () => {
  // Monday 08:50 against a desk-api still on the old build: the settle route
  // does not exist. Aborting there would skip every stop and erase after the
  // creates; instead each such book is left alone and named.
  const tcs = stockRow('TCS')
  const tata = stockRow('TATASTEEL')
  const plan = monPlan(
    [dlRow(SENSEX_1001, '2026-10-01'), dlRow(SENSEX_0930, '2026-09-30'), tcs, tata],
    { [SENSEX_1001]: 1, [tcs.tag]: 1 },
    { [SENSEX_1001]: 1, [tcs.tag]: 1 },
  )
  const rec = recorder({
    [settlePath(SENSEX_1001)]: { status: 404, body: null, text: 'not found' },
    [settlePath(tcs.tag)]: { status: 500, body: null, text: 'mongo is down' },
  })
  const done = await applyRoll(plan, { request: rec.request })
  assert.ok(rec.calls.includes(`DELETE ${REG}/${SENSEX_0930}?mode=paper`), 'the flat delta-lean erase still went')
  assert.ok(rec.calls.includes(`DELETE ${REG}/${tata.tag}?mode=paper`), 'the flat stock erase still went')
  assert.ok(!rec.calls.some((c) => c.includes(`${SENSEX_1001}/stop`) || c.includes(`${tcs.tag}/stop`)))
  assert.ok(!rec.calls.some((c) => c.startsWith('DELETE') && (c.includes(SENSEX_1001) || c.includes(tcs.tag))))
  assert.equal(done.refused.length, 2)
  assert.ok(done.refused.some((r) => r.includes(SENSEX_1001) && /404/.test(r)))
  assert.ok(done.refused.some((r) => r.includes(tcs.tag) && /500/.test(r)))
})

// ------------------------------------------- the hold-to-expiry pairs (2026-10-05)

/**
 * The weekly sibling: per symbol, an aggressive and a conservative book with
 * `dl_hold_to_expiry: true`, tagged by the CONTRACT, created the first morning
 * that contract is the front one, carried overnight, and retired the morning
 * after it expires. The first week, off the real dump:
 *
 *   Mon 10-05  front NIFTY 10-06, SENSEX 10-08 — (the roll has no hold half yet)
 *   Tue 10-06  NIFTY's expiry day: no NIFTY pair; the SENSEX 10-08 pair is created
 *   Wed 10-07  the NIFTY 10-13 pair is created; the SENSEX pair is already there
 *   Thu 10-08  SENSEX's expiry day: no SENSEX pair; the 10-08 pair carries to the close
 *   Fri 10-09  the SENSEX 10-08 pair is retired; the SENSEX 10-15 pair is created
 */
const TUE6 = '2026-10-06'
const TUE6_LIVE: Expiries = { nifty: '2026-10-06', sensex: '2026-10-08' }
const WED7 = '2026-10-07'
const WED7_LIVE: Expiries = { nifty: '2026-10-13', sensex: '2026-10-08' }
const FRI9 = '2026-10-09'
const FRI9_LIVE: Expiries = { nifty: '2026-10-13', sensex: '2026-10-15' }
const TUE13 = '2026-10-13'
const TUE13_LIVE: Expiries = { nifty: '2026-10-13', sensex: '2026-10-15' }
const WED14 = '2026-10-14'
const WED14_LIVE: Expiries = { nifty: '2026-10-19', sensex: '2026-10-15' }

const holdTag = (symbol: string, column: 'aggressive' | 'conservative', expiry: string): string =>
  `${symbol}-delta-lean-hold-${column}-${expiry}`
const SX_HOLD_AGG_08 = holdTag('SENSEX', 'aggressive', '2026-10-08')
const SX_HOLD_CONS_08 = holdTag('SENSEX', 'conservative', '2026-10-08')
const NF_HOLD_AGG_13 = holdTag('NIFTY', 'aggressive', '2026-10-13')
const NF_HOLD_CONS_13 = holdTag('NIFTY', 'conservative', '2026-10-13')

/**
 * The history a registry row carries, as `bookFromDoc` answers it: a RUNNING
 * row was started a second after its create (the start advanced `updatedAt`);
 * a STOPPED one here was registered and never started — nothing has written
 * to it since its create, and the supervisor never reported it. A row stopped
 * by hand after it ran is built explicitly where a test needs one.
 */
function history(desired: 'running' | 'stopped', createdAt: number): { lastMarkAt: number; updatedAt: number } {
  return { lastMarkAt: 0, updatedAt: desired === 'running' ? createdAt + 1_000 : createdAt }
}

/** The hold pairs `planHoldBooks` made on `createdDay`, as the registry holds them. */
function holdRowsFor(
  createdDay: string,
  expiries: Expiries,
  opts: { desired?: 'running' | 'stopped' } = {},
): RegistryRow[] {
  const desired = opts.desired ?? 'running'
  const createdAt = nineAmIst(createdDay)
  return books
    .planHoldBooks(expiries, createdDay)
    .map((b) => ({ ...b, desired, actual: desired, createdAt, ...history(desired, createdAt) }))
}

/**
 * The roll as `main` plans it at 08:50 on `todayIst`: today's four and today's
 * hold pairs as targets, against `rows` — which do not yet include today's four.
 */
function holdDayPlan(
  todayIst: string,
  expiries: Expiries,
  rows: readonly RegistryRow[],
  held: Readonly<Record<string, number | null>> = {},
  expired: Readonly<Record<string, number | null>> = {},
): RollPlan {
  return planRoll({
    targets: books.planBooks(expiries, todayIst),
    holdTargets: books.planHoldBooks(expiries, todayIst),
    rows,
    heldByTag: { ...allFlat(rows), ...held },
    expiredByTag: expired,
    todayIst,
  })
}

function holdRetireFor(plan: RollPlan, tag: string): RetireEntry {
  const found = plan.hold.retire.find((e) => e.row.tag === tag)
  assert.ok(found !== undefined, `${tag} is not in the hold retire set`)
  return found
}

/** Is this tag anywhere in the creation-day retire of the daily books? */
const inDailyRetire = (plan: RollPlan, tag: string): boolean =>
  plan.symbols.some((s) => s.retire.some((e) => e.row.tag === tag))

test('2026-10-06, NIFTY expiry Tuesday: no NIFTY hold pair, the SENSEX pair is created for 10-08 — after the four', () => {
  const plan = holdDayPlan(TUE6, TUE6_LIVE, rowsFor(MON, MON_LIVE))
  assert.deepEqual(plan.hold.ensure.map((e) => [e.plan.tag, e.why]), [
    [SX_HOLD_AGG_08, 'missing'],
    [SX_HOLD_CONS_08, 'missing'],
  ])
  for (const e of plan.hold.ensure) {
    assert.equal(e.plan.expiry, '2026-10-08')
    assert.equal(e.plan.dials['dl_hold_to_expiry'], true)
    assert.equal(e.plan.mode, 'paper')
  }
  assert.ok(!createdBooks(plan).some((b) => b.symbol === 'NIFTY' && books.isHold(b)), 'a NIFTY hold book on a contract that dies today')
  // Today's four first, then the pair — the order `applyRoll` sends them in.
  assert.deepEqual(createdBooks(plan).map((b) => b.tag), [
    ...books.planBooks(TUE6_LIVE, TUE6).map((b) => b.tag),
    SX_HOLD_AGG_08,
    SX_HOLD_CONS_08,
  ])
  // Monday's four go as usual.
  assert.deepEqual([...erasedTags(plan)].sort(), rowsFor(MON, MON_LIVE).map((r) => r.tag).sort())
  assert.deepEqual([...plan.hold.retire], [])
  assert.deepEqual([...plan.alarms], [])
  assert.deepEqual([...plan.anomalies], [])
})

test("2026-10-07: the NIFTY pair is created for 10-13; yesterday's SENSEX pair converges — on target, no call, and not retired by its day", () => {
  // Review Focus 4: the SENSEX pair was created on the 6th, before today's
  // cutoff — exactly what the daily retire takes. It is a hold book by its
  // dial, so the daily retire never sees it.
  const sensexPair = holdRowsFor(TUE6, TUE6_LIVE)
  const plan = holdDayPlan(WED7, WED7_LIVE, [...rowsFor(TUE6, TUE6_LIVE), ...sensexPair])
  assert.deepEqual(plan.hold.ensure.map((e) => e.plan.tag), [NF_HOLD_AGG_13, NF_HOLD_CONS_13])
  assert.deepEqual(plan.hold.onTarget.map((h) => h.row.tag), [SX_HOLD_AGG_08, SX_HOLD_CONS_08])
  for (const r of sensexPair) {
    assert.ok(!inDailyRetire(plan, r.tag), `${r.tag} is in the creation-day retire`)
    assert.ok(!stoppedTags(plan).includes(r.tag), `${r.tag} would be stopped`)
    assert.ok(!erasedTags(plan).includes(r.tag), `${r.tag} would be erased`)
  }
  // ...while Tuesday's four daily books are erased.
  assert.deepEqual([...erasedTags(plan)].sort(), rowsFor(TUE6, TUE6_LIVE).map((r) => r.tag).sort())
  assert.deepEqual([...plan.alarms], [])
  assert.deepEqual([...plan.anomalies], [])
})

test('the daily retire still takes an intraday row whose hold dial is absent or false', () => {
  // Review Focus 4's other half: membership of the hold family is the dial
  // being TRUE. Rows registered before the engine knew the dial carry no key
  // at all; rows registered after carry `false`. Both are daily books.
  const [absent, explicitFalse, ...rest] = rowsFor(TUE6, TUE6_LIVE)
  assert.ok(absent !== undefined && explicitFalse !== undefined)
  const noKey: RegistryRow = {
    ...absent,
    dials: Object.fromEntries(Object.entries(absent.dials).filter(([k]) => k !== 'dl_hold_to_expiry')),
  }
  const withFalse: RegistryRow = { ...explicitFalse, dials: { ...explicitFalse.dials, dl_hold_to_expiry: false } }
  const plan = holdDayPlan(WED7, WED7_LIVE, [noKey, withFalse, ...rest, ...holdRowsFor(TUE6, TUE6_LIVE)])
  assert.equal(retireFor(plan, noKey.tag).action, 'erase')
  assert.equal(retireFor(plan, withFalse.tag).action, 'erase')
  assert.equal(plan.hold.retire.length, 0)
})

test("a stopped hold row from an EARLIER morning is the operator's decision — left stopped, never started, and named in ATTENTION", () => {
  // Not quiet: a cron run that leaves a week-long book off the desk must not
  // pass with exit 0. It is an anomaly line, so the run exits 1.
  const stoppedPair = holdRowsFor(TUE6, TUE6_LIVE, { desired: 'stopped' })
  const plan = holdDayPlan(WED7, WED7_LIVE, stoppedPair)
  assert.deepEqual(plan.hold.leftStopped.map((h) => h.row.tag), [SX_HOLD_AGG_08, SX_HOLD_CONS_08])
  assert.ok(!createdBooks(plan).some((b) => b.symbol === 'SENSEX' && books.isHold(b)), 'a stopped hold book was planned for a start')
  assert.deepEqual([...plan.hold.retire], [])
  for (const tag of [SX_HOLD_AGG_08, SX_HOLD_CONS_08]) {
    assert.ok(plan.anomalies.some((a) => a.includes(tag) && /stopped/i.test(a)), `${tag} left stopped silently`)
  }
  assert.deepEqual([...plan.alarms], [], 'flat, so not an alarm — an anomaly')
})

test('30 Oct 2026 — a carried hold-conservative row on the OLD dials (4 adjustments) is on target Monday: recognised, no call, not converged, no alarm', async () => {
  // The conservative column went to `dl_max_adjusts_day: 0` on 30 Oct. The
  // two hold-conservative books then on file — NIFTY 11-03 (registered Wed
  // 28 Oct) and SENSEX 11-05 (Fri 30 Oct) — were registered with 4, carry
  // legs, and are Monday 2 Nov's own hold targets. Membership is the variant,
  // `delta_lean_enabled` and `dl_hold_to_expiry`, none of which moved, so the
  // roll still knows them; a RUNNING target gets no call at all, so it never
  // rewrites their dials either. The 0 reaches them only by a dials PATCH
  // (runbook §7.8) — and every pair created from Wed 4 Nov on carries it.
  const MON2 = '2026-11-02'
  const MON2_LIVE: Expiries = { nifty: '2026-11-03', sensex: '2026-11-05' }
  const NF_CONS = holdTag('NIFTY', 'conservative', '2026-11-03')
  const SX_CONS = holdTag('SENSEX', 'conservative', '2026-11-05')
  const NF_AGG = holdTag('NIFTY', 'aggressive', '2026-11-03')
  const SX_AGG = holdTag('SENSEX', 'aggressive', '2026-11-05')
  /** As `desk-books-registry` holds them: the pre-30 Oct column, and no
   * `dl_rupee_hold_s` (registered before that dial too). */
  const onFile = (r: RegistryRow): RegistryRow => {
    const { dl_rupee_hold_s: _absent, ...dials } = r.dials
    return r.variant === 'delta-lean-hold-conservative'
      ? { ...r, dials: { ...dials, dl_max_adjusts_day: 4 } }
      : { ...r, dials }
  }
  const niftyPair = holdRowsFor('2026-10-28', { nifty: '2026-11-03', sensex: '2026-10-29' })
    .filter((r) => r.symbol === 'NIFTY')
    .map(onFile)
  const sensexPair = holdRowsFor('2026-10-30', MON2_LIVE).filter((r) => r.symbol === 'SENSEX').map(onFile)
  const carried = [...niftyPair, ...sensexPair]
  assert.deepEqual(carried.map((r) => r.tag).sort(), [NF_AGG, NF_CONS, SX_AGG, SX_CONS].sort())
  for (const r of carried.filter((x) => x.variant === 'delta-lean-hold-conservative')) {
    assert.equal(r.dials['dl_max_adjusts_day'], 4, `${r.tag} is on the old dials`)
  }

  // Friday's daily books go as usual; the four hold rows hold legs.
  const plan = holdDayPlan(MON2, MON2_LIVE, [...rowsFor('2026-10-30', MON2_LIVE), ...carried], {
    [NF_CONS]: 10, [SX_CONS]: 3, [NF_AGG]: 6, [SX_AGG]: 4,
  })
  // Monday's plan states the NEW column for these very tags...
  const planned = books.planHoldBooks(MON2_LIVE, MON2)
  assert.equal(planned.find((b) => b.tag === NF_CONS)?.dials['dl_max_adjusts_day'], 0)
  assert.equal(planned.find((b) => b.tag === SX_CONS)?.dials['dl_max_adjusts_day'], 0)
  // ...and the rows on file are on target regardless: nothing created,
  // started, stopped, settled or erased, and nothing in ATTENTION.
  assert.deepEqual(plan.hold.onTarget.map((h) => h.row.tag).sort(), [NF_AGG, NF_CONS, SX_AGG, SX_CONS].sort())
  assert.deepEqual([...plan.hold.ensure], [])
  assert.deepEqual([...plan.hold.leftStopped], [])
  assert.deepEqual([...plan.hold.retire], [])
  assert.deepEqual([...plan.alarms], [])
  assert.deepEqual([...plan.anomalies], [])
  for (const tag of [NF_CONS, SX_CONS]) {
    assert.ok(!inDailyRetire(plan, tag), `${tag} is in the creation-day retire`)
    assert.ok(!createdBooks(plan).some((b) => b.tag === tag), `${tag} would be re-created`)
    assert.ok(!stoppedTags(plan).includes(tag), `${tag} would be stopped`)
    assert.ok(!erasedTags(plan).includes(tag), `${tag} would be erased`)
  }

  // On the wire: Monday's daily books are created and Friday's erased, and
  // not one call names a hold book.
  const rec = recorder()
  await applyRoll(plan, { request: rec.request })
  assert.ok(rec.calls.length > 0, 'the daily half still rolls')
  for (const tag of [NF_AGG, NF_CONS, SX_AGG, SX_CONS]) {
    assert.deepEqual(rec.calls.filter((c) => c.includes(tag)), [], `${tag} was sent a call`)
  }
})

test('a stopped, flat hold target registered TODAY is a run that died between create and start — the roll finishes it', async () => {
  // The NIFTY 10-13 pair registered at 08:50 on the 7th, and the run died
  // before the starts. A re-run the same morning must put it on the desk;
  // left alone it would stay off for the whole week.
  const halfBorn = holdRowsFor(WED7, WED7_LIVE, { desired: 'stopped' }).filter((r) => r.symbol === 'NIFTY')
  const plan = holdDayPlan(WED7, WED7_LIVE, [...rowsFor(WED7, WED7_LIVE), ...holdRowsFor(TUE6, TUE6_LIVE), ...halfBorn])
  assert.deepEqual(plan.hold.ensure.map((e) => [e.plan.tag, e.why]), [
    [NF_HOLD_AGG_13, 'created-not-started'],
    [NF_HOLD_CONS_13, 'created-not-started'],
  ])
  assert.deepEqual([...plan.hold.leftStopped], [])
  assert.deepEqual([...plan.anomalies], [])
  const rec = recorder()
  const done = await applyRoll(plan, { request: rec.request })
  // The create converges on the existing row (200 on a real registry), then
  // the start and the switch — the same three calls as a fresh book.
  assert.deepEqual(rec.calls, [
    `POST ${REG}`,
    `POST ${REG}/${NF_HOLD_AGG_13}/start`,
    `PATCH ${STRAT}/${NF_HOLD_AGG_13}`,
    `POST ${REG}`,
    `POST ${REG}/${NF_HOLD_CONS_13}/start`,
    `PATCH ${STRAT}/${NF_HOLD_CONS_13}`,
  ])
  assert.equal(done.started, 2)

  // Holding a leg, or unreadable, it is NOT started — and it is an alarm.
  const holding = holdDayPlan(WED7, WED7_LIVE, halfBorn, { [NF_HOLD_AGG_13]: 1, [NF_HOLD_CONS_13]: null })
  assert.deepEqual([...holding.hold.ensure].filter((e) => e.why === 'created-not-started'), [])
  assert.deepEqual(holding.hold.leftStopped.map((h) => h.row.tag), [NF_HOLD_AGG_13, NF_HOLD_CONS_13])
  for (const tag of [NF_HOLD_AGG_13, NF_HOLD_CONS_13]) {
    assert.ok(holding.alarms.some((a) => a.includes(tag)), `${tag} stopped and not flat, not alarmed`)
  }
})

test('Review #3 — a hold pair stopped by hand on its first morning is NOT restarted by a re-run, even one stopped before its first mark', () => {
  // The NIFTY 10-13 pair was registered and started at 09:00 on the 7th; the
  // operator stopped the aggressive book at 09:20, before the supervisor had
  // marked it — so `lastMarkAt` is still 0 and `actual` reads stopped again.
  // Only the registry's own `updatedAt` says a start (and the stop) reached
  // the row; that is what separates it from a run that died before its start.
  const createdAt = nineAmIst(WED7)
  const [agg, cons] = holdRowsFor(WED7, WED7_LIVE).filter((r) => r.symbol === 'NIFTY') as [RegistryRow, RegistryRow]
  const stoppedByHand: RegistryRow = { ...agg, desired: 'stopped', actual: 'stopped', lastMarkAt: 0, updatedAt: createdAt + 20 * 60_000 }
  const plan = holdDayPlan(WED7, WED7_LIVE, [...rowsFor(WED7, WED7_LIVE), ...holdRowsFor(TUE6, TUE6_LIVE), stoppedByHand, cons])
  assert.deepEqual([...plan.hold.ensure], [], 'a hand-stopped hold book was planned for a start')
  assert.deepEqual(plan.hold.leftStopped.map((h) => h.row.tag), [NF_HOLD_AGG_13])
  assert.ok(plan.anomalies.some((a) => a.includes(NF_HOLD_AGG_13) && /STOPPED/.test(a)), 'left stopped silently')
  assert.deepEqual([...createdBooks(plan)], [])
})

test('a STOPPED hold book that is not flat — on target or carrying — is an alarm: a position nothing steers for days', () => {
  // On Tuesday 10-13 the NIFTY 10-13 pair is carrying to today's close and the
  // SENSEX 10-15 pair is on its tag; all four stopped, three of them holding
  // or unreadable.
  const nifty13 = holdRowsFor(WED7, WED7_LIVE, { desired: 'stopped' }).filter((r) => r.symbol === 'NIFTY')
  const sensex15 = holdRowsFor(FRI9, FRI9_LIVE, { desired: 'stopped' }).filter((r) => r.symbol === 'SENSEX')
  const [sxAgg15, sxCons15] = sensex15.map((r) => r.tag) as [string, string]
  const plan = holdDayPlan(TUE13, TUE13_LIVE, [...nifty13, ...sensex15], {
    [NF_HOLD_AGG_13]: 2,
    [NF_HOLD_CONS_13]: 0,
    [sxAgg15]: null,
    [sxCons15]: 1,
  })
  assert.deepEqual(plan.hold.carrying.map((h) => h.row.tag), [NF_HOLD_AGG_13, NF_HOLD_CONS_13])
  assert.deepEqual(plan.hold.leftStopped.map((h) => h.row.tag), [sxAgg15, sxCons15])
  for (const tag of [NF_HOLD_AGG_13, sxAgg15, sxCons15]) {
    assert.ok(plan.alarms.some((a) => a.includes(tag) && /STOPPED/.test(a)), `${tag}: stopped and not flat, not alarmed`)
  }
  assert.ok(!plan.alarms.some((a) => a.includes(NF_HOLD_CONS_13)), 'a stopped FLAT carrying book is not an alarm')

  // A RUNNING book holding legs is the normal state of a hold book.
  const running = holdDayPlan(TUE13, TUE13_LIVE, holdRowsFor(WED7, WED7_LIVE).filter((r) => r.symbol === 'NIFTY'), {
    [NF_HOLD_AGG_13]: 2,
    [NF_HOLD_CONS_13]: 2,
  })
  assert.deepEqual([...running.alarms], [])
})

test('the engine gate: on a build that does not know dl_hold_to_expiry no pair is planned, the run names it, and the rest still rolls', async () => {
  // The flag follows the engine on disk — true once the engine branch has
  // put the dial into DEFAULT_DIALS, false before.
  assert.equal(books.engineKnowsHoldDial(), Object.hasOwn(DEFAULT_DIALS, 'dl_hold_to_expiry'))

  const known = roll.planHoldTargets(FRI9_LIVE, FRI9, () => true)
  assert.equal(known.holdBlocked, null)
  assert.deepEqual(known.holdTargets.map((b) => b.tag), books.planHoldBooks(FRI9_LIVE, FRI9).map((b) => b.tag))

  const unknown = roll.planHoldTargets(FRI9_LIVE, FRI9, () => false)
  assert.deepEqual([...unknown.holdTargets], [])
  assert.ok(unknown.holdBlocked !== null)
  assert.match(unknown.holdBlocked, /dl_hold_to_expiry/)
  assert.match(unknown.holdBlocked, /restart desk-supervisor/)

  // Never a throw: today's four are created, Thursday's retired, and the
  // SENSEX 10-08 pair past its contract still retires by expiry.
  const rows = [...rowsFor('2026-10-08', TUE6_LIVE), ...holdRowsFor(TUE6, TUE6_LIVE)]
  const plan = planRoll({
    targets: books.planBooks(FRI9_LIVE, FRI9),
    holdTargets: unknown.holdTargets,
    holdBlocked: unknown.holdBlocked,
    rows,
    heldByTag: allFlat(rows),
    todayIst: FRI9,
  })
  assert.ok(plan.anomalies.includes(unknown.holdBlocked), 'the gate is not in ATTENTION, so the run would exit 0')
  assert.deepEqual(createdBooks(plan).map((b) => b.tag), books.planBooks(FRI9_LIVE, FRI9).map((b) => b.tag))
  assert.deepEqual(plan.hold.retire.map((e) => [e.row.tag, e.action]), [
    [SX_HOLD_AGG_08, 'erase'],
    [SX_HOLD_CONS_08, 'erase'],
  ])
  const rec = recorder()
  const done = await applyRoll(plan, { request: rec.request })
  // Six daily books (no expiry on the 9th); Thursday's seven — SENSEX's 0-DTE
  // book among them — and the pair past its contract retire.
  assert.deepEqual(done, { created: 6, started: 6, switchedOn: 6, stopped: 9, erased: 9, settled: 0, refused: [] })

  // And the gate's line is printed in the ATTENTION block.
  const lines: string[] = []
  const original = console.log
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '))
  }
  try {
    roll.printPlan(plan)
  } finally {
    console.log = original
  }
  const text = lines.join('\n')
  assert.ok(text.indexOf('ATTENTION') >= 0 && text.indexOf(unknown.holdBlocked) > text.indexOf('ATTENTION'))
})

test('Review Focus 3 — on an expiry morning the hold pair on the dying contract is carried, not retired; it goes the morning after', () => {
  // Tuesday 10-13: NIFTY's 10-13 pair (created 10-07) holds to this
  // afternoon's close. No NIFTY pair is created for a contract dying today,
  // and the existing one is NOT retired — its expiry is today, not before.
  const nifty13 = holdRowsFor(WED7, WED7_LIVE).filter((r) => r.symbol === 'NIFTY')
  const sensex15 = holdRowsFor(FRI9, FRI9_LIVE).filter((r) => r.symbol === 'SENSEX')
  const tue = holdDayPlan(TUE13, TUE13_LIVE, [...nifty13, ...sensex15])
  assert.deepEqual(tue.hold.ensure.map((e) => e.plan.tag), [], 'nothing to create: NIFTY dies today, SENSEX 10-15 is on the desk')
  assert.deepEqual(tue.hold.carrying.map((h) => h.row.tag), [NF_HOLD_AGG_13, NF_HOLD_CONS_13])
  assert.deepEqual(tue.hold.onTarget.map((h) => h.row.tag), sensex15.map((r) => r.tag))
  assert.deepEqual([...tue.hold.retire], [])
  for (const r of nifty13) {
    assert.ok(!stoppedTags(tue).includes(r.tag) && !erasedTags(tue).includes(r.tag), `${r.tag} retired on its own expiry day`)
  }

  // Wednesday 10-14: the 10-13 pair is past its contract — retired (flat:
  // stop, then erase) — and NIFTY's 10-19 pair is created in the same run (Monday:
  // Tuesday 10-20 is Dussehra, so that week's contract expires on the 19th).
  const wed = holdDayPlan(WED14, WED14_LIVE, [...nifty13, ...sensex15])
  for (const r of nifty13) assert.equal(holdRetireFor(wed, r.tag).action, 'erase')
  assert.deepEqual(wed.hold.ensure.map((e) => e.plan.tag), [
    holdTag('NIFTY', 'aggressive', '2026-10-19'),
    holdTag('NIFTY', 'conservative', '2026-10-19'),
  ])
  for (const r of nifty13) {
    assert.ok(stoppedTags(wed).includes(r.tag), `${r.tag} is running and must be stopped before its DELETE`)
    assert.ok(erasedTags(wed).includes(r.tag))
  }
})

test("2026-10-09: the SENSEX 10-08 pair is retired by its expiry — flat → stop + erase; every leg on the dead contract → settle, then erase", () => {
  const pair = holdRowsFor(TUE6, TUE6_LIVE)
  const nifty13 = holdRowsFor(WED7, WED7_LIVE).filter((r) => r.symbol === 'NIFTY')
  const plan = holdDayPlan(
    FRI9,
    FRI9_LIVE,
    [...rowsFor('2026-10-08', TUE6_LIVE), ...pair, ...nifty13],
    { [SX_HOLD_CONS_08]: 2 },
    { [SX_HOLD_CONS_08]: 2 },
  )
  assert.equal(holdRetireFor(plan, SX_HOLD_AGG_08).action, 'erase')
  assert.equal(holdRetireFor(plan, SX_HOLD_CONS_08).action, 'settle-then-erase')
  assert.deepEqual([...plan.alarms], [], 'a leg on the dead contract is a settlement, not an alarm')
  for (const tag of [SX_HOLD_AGG_08, SX_HOLD_CONS_08]) {
    assert.ok(stoppedTags(plan).includes(tag))
    assert.ok(erasedTags(plan).includes(tag))
  }
  // The next SENSEX pair, for 10-15, is created; NIFTY's 10-13 pair runs on.
  assert.deepEqual(plan.hold.ensure.map((e) => e.plan.tag), [
    holdTag('SENSEX', 'aggressive', '2026-10-15'),
    holdTag('SENSEX', 'conservative', '2026-10-15'),
  ])
  assert.deepEqual(plan.hold.onTarget.map((h) => h.row.tag), [NF_HOLD_AGG_13, NF_HOLD_CONS_13])
})

test('a hold book past expiry with a LIVE-contract leg, or unreadable, is alarmed and untouched; a stopped flat one is erased without a stop', () => {
  const [agg, cons] = holdRowsFor(TUE6, TUE6_LIVE)
  assert.ok(agg !== undefined && cons !== undefined)
  const stoppedFlat: RegistryRow = { ...agg, tag: `${agg.tag}-x`, desired: 'stopped', actual: 'stopped' }
  const plan = holdDayPlan(FRI9, FRI9_LIVE, [agg, cons, stoppedFlat], { [agg.tag]: 2, [cons.tag]: null }, { [agg.tag]: 1 })
  assert.equal(holdRetireFor(plan, agg.tag).action, 'holds-legs')
  assert.equal(holdRetireFor(plan, cons.tag).action, 'unknown')
  assert.equal(holdRetireFor(plan, stoppedFlat.tag).action, 'erase')
  assert.ok(!stoppedTags(plan).some((t) => t === agg.tag || t === cons.tag || t === stoppedFlat.tag))
  assert.deepEqual([...erasedTags(plan)].filter((t) => t.includes('hold')), [stoppedFlat.tag])
  assert.ok(plan.alarms.some((a) => a.includes(agg.tag) && /live contract/.test(a)))
  assert.ok(plan.alarms.some((a) => a.includes(cons.tag) && /CANNOT TELL/.test(a)))
})

test('a row whose variant and hold dial disagree is an anomaly, untouched by both retires', () => {
  // A hold variant whose dials do not carry the hold dial would be an
  // intraday engine under a weekly tag; an intraday variant carrying it would
  // be a weekly engine under a daily tag. Neither is guessed at.
  const [holdAgg] = holdRowsFor(TUE6, TUE6_LIVE)
  const [dailyAgg] = rowsFor(TUE6, TUE6_LIVE)
  assert.ok(holdAgg !== undefined && dailyAgg !== undefined)
  const holdNoDial: RegistryRow = { ...holdAgg, dials: { ...holdAgg.dials, dl_hold_to_expiry: false } }
  const dailyWithDial: RegistryRow = { ...dailyAgg, dials: { ...dailyAgg.dials, dl_hold_to_expiry: true } }
  const plan = holdDayPlan(FRI9, FRI9_LIVE, [holdNoDial, dailyWithDial])
  for (const r of [holdNoDial, dailyWithDial]) {
    assert.ok(!inDailyRetire(plan, r.tag), `${r.tag} in the daily retire`)
    assert.ok(!plan.hold.retire.some((e) => e.row.tag === r.tag), `${r.tag} in the hold retire`)
    assert.ok(!plan.expiredBooks.some((e) => e.row.tag === r.tag), `${r.tag} in the fourth loop`)
    assert.ok(plan.anomalies.some((a) => a.includes(r.tag) && /dl_hold_to_expiry/.test(a)), `${r.tag} not reported`)
  }
  assert.equal(roll.isDeltaLean(holdAgg), true, 'a hold book is a delta-lean book')
})

test('a non-trading day plans no hold pair either', () => {
  // Saturday 10-10, with a pair planned and a pair on file: nothing either way.
  const plan = planRoll({
    targets: books.planBooks(FRI9_LIVE, '2026-10-10'),
    holdTargets: books.planHoldBooks(FRI9_LIVE, '2026-10-10'),
    rows: holdRowsFor(TUE6, TUE6_LIVE),
    heldByTag: {},
    todayIst: '2026-10-10',
  })
  assert.equal(plan.tradingDay, false)
  assert.deepEqual([...plan.hold.ensure], [])
  assert.deepEqual([...plan.hold.retire], [])
})

test('applyRoll: every create (the four, then the hold pair) before any stop; then the daily retire, the hold retire, the fourth loop — each settle → stop → erase', async () => {
  const pair = holdRowsFor(TUE6, TUE6_LIVE)
  const nifty13 = holdRowsFor(WED7, WED7_LIVE).filter((r) => r.symbol === 'NIFTY')
  const thursdays = rowsFor('2026-10-08', TUE6_LIVE)
  const tcs = stockRow('TCS')
  const plan = holdDayPlan(
    FRI9,
    FRI9_LIVE,
    [...thursdays, ...pair, ...nifty13, tcs],
    { [SX_HOLD_CONS_08]: 2 },
    { [SX_HOLD_CONS_08]: 2 },
  )
  const rec = recorder()
  const done = await applyRoll(plan, { request: rec.request })

  const expected: string[] = []
  const created = [...books.planBooks(FRI9_LIVE, FRI9), ...books.planHoldBooks(FRI9_LIVE, FRI9).filter((b) => b.symbol === 'SENSEX')]
  for (const b of created) expected.push(`POST ${REG}`, `POST ${REG}/${b.tag}/start`, `PATCH ${STRAT}/${b.tag}`)
  // the daily books of Thursday: stops, then erases
  for (const r of thursdays) expected.push(`POST ${REG}/${r.tag}/stop`)
  for (const r of thursdays) expected.push(`DELETE ${REG}/${r.tag}?mode=paper`)
  // the hold pair past its expiry: settle, stops, erases
  expected.push(settlePath(SX_HOLD_CONS_08))
  expected.push(`POST ${REG}/${SX_HOLD_AGG_08}/stop`, `POST ${REG}/${SX_HOLD_CONS_08}/stop`)
  expected.push(`DELETE ${REG}/${SX_HOLD_AGG_08}?mode=paper`, `DELETE ${REG}/${SX_HOLD_CONS_08}?mode=paper`)
  // and only then every other family past expiry
  expected.push(`POST ${REG}/${tcs.tag}/stop`, `DELETE ${REG}/${tcs.tag}?mode=paper`)
  assert.deepEqual(rec.calls, expected)
  assert.deepEqual(done, { created: 8, started: 8, switchedOn: 8, stopped: 10, erased: 10, settled: 1, refused: [] })

  // NIFTY's running 10-13 pair is never written to.
  assert.ok(!rec.calls.some((c) => c.includes(NF_HOLD_AGG_13) || c.includes(NF_HOLD_CONS_13)))
  const lastCreate = Math.max(...rec.calls.map((c, i) => (c.startsWith('PATCH ') ? i : -1)))
  const firstRetire = rec.calls.findIndex((c) => c.endsWith('/stop') || c.includes('settle-expired'))
  assert.ok(firstRetire > lastCreate, 'a retire call went out before the last create')
  assert.ok(!rec.calls.some((c) => /flatten|purge/.test(c)))
})

test('a hold create that fails takes the run down before a single stop', async () => {
  const plan = holdDayPlan(TUE6, TUE6_LIVE, rowsFor(MON, MON_LIVE))
  const rec = recorder({ [`POST ${REG}/${SX_HOLD_AGG_08}/start`]: { status: 500, body: null, text: 'boom' } })
  await assert.rejects(applyRoll(plan, { request: rec.request }), new RegExp(`start ${SX_HOLD_AGG_08} failed`))
  assert.ok(!rec.calls.some((c) => c.endsWith('/stop') || c.startsWith('DELETE ')))
})

test('printPlan names the hold books: what it creates, what it carries, what it retires, and the expiry-day symbol', () => {
  const lines: string[] = []
  const original = console.log
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '))
  }
  try {
    roll.printPlan(holdDayPlan(TUE6, TUE6_LIVE, rowsFor(MON, MON_LIVE)))
    roll.printPlan(
      holdDayPlan(
        FRI9,
        FRI9_LIVE,
        [...holdRowsFor(TUE6, TUE6_LIVE), ...holdRowsFor(WED7, WED7_LIVE, { desired: 'stopped' }).filter((r) => r.symbol === 'NIFTY')],
        { [SX_HOLD_CONS_08]: 2 },
        { [SX_HOLD_CONS_08]: 2 },
      ),
    )
    roll.printPlan(holdDayPlan(TUE13, TUE13_LIVE, holdRowsFor(WED7, WED7_LIVE)))
  } finally {
    console.log = original
  }
  const text = lines.join('\n')
  assert.match(text, /HOLD-TO-EXPIRY/)
  assert.match(text, new RegExp(`CREATE \\+ START \\+ SWITCH ON\\s+${SX_HOLD_AGG_08}`))
  assert.match(text, /NIFTY .*2026-10-06 is TODAY — no hold pair/)
  assert.match(text, new RegExp(`SETTLE \\+ STOP \\+ ERASE\\s+${SX_HOLD_CONS_08}`))
  assert.match(text, new RegExp(`left stopped\\s+${NF_HOLD_AGG_13}`))
  assert.match(text, new RegExp(`carrying\\s+${NF_HOLD_AGG_13}`))
  // The summary line counts them on their own.
  assert.match(text, /hold-to-expiry: 2 to create/)
  assert.match(roll.HELP, /hold-to-expiry/i)
})

test('applyOrphans: each paper membership is removed, then the empty row; a refusal is reported, not an abort', async () => {
  const plan: OrphanPlan = {
    prune: [
      { tag: 'BHEL-2026-08-25-recenter-r', modes: [] },
      { tag: 'NIFTY-delta-lean-aggressive-2026-09-29', modes: ['paper'] },
      { tag: 'STUCK', modes: [] },
    ],
    skipped: [],
  }
  const rec = recorder({
    [`DELETE ${STRAT}/STUCK`]: { status: 409, body: null, text: 'a book is registered under it' },
  })
  const done = await roll.applyOrphans(plan, { request: rec.request })
  assert.deepEqual(rec.calls, [
    `DELETE ${STRAT}/BHEL-2026-08-25-recenter-r`,
    `DELETE ${STRAT}/NIFTY-delta-lean-aggressive-2026-09-29/modes/paper`,
    `DELETE ${STRAT}/NIFTY-delta-lean-aggressive-2026-09-29`,
    `DELETE ${STRAT}/STUCK`,
  ])
  assert.deepEqual({ ...done, refused: done.refused.length }, { removedModes: 1, deletedRows: 2, refused: 1 })
  assert.ok(!rec.calls.some((c) => /modes\/live/.test(c)), 'a live membership is never removed')
})

test('printPlan renders every branch without throwing', () => {
  // A dry run that crashes on an unusual plan is a cron log with no plan in
  // it. Rendered into a sink, not asserted line by line.
  const stoppedHolder = rowsFor('2026-09-17', LIVE, { desired: 'stopped' })[0] as RegistryRow
  const rows = [...rowsFor(YESTERDAY, LIVE), ...legacyRows(), stoppedHolder]
  const plan = planRoll({
    targets: TARGETS,
    rows,
    heldByTag: { ...allFlat(rows), [LEGACY_SENSEX_AGG]: 2, [LEGACY_NIFTY_AGG]: null, [stoppedHolder.tag]: 1 },
    todayIst: TODAY,
  })
  const lines: string[] = []
  const original = console.log
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '))
  }
  try {
    roll.printPlan(plan)
    roll.printPlan(plainPlan(rowsFor(TODAY, LIVE)))
    roll.printPlan(planRoll({ targets: TARGETS, rows: [], heldByTag: {}, todayIst: '2026-09-19' }))
    const tcs = stockRow('TCS')
    const rolled = stockRow('TATASTEEL')
    roll.printPlan(
      monPlan(
        [dlRow(SENSEX_1001, '2026-10-01'), tcs, rolled, stockRow('KALYANKJIL', 'stopped')],
        { [SENSEX_1001]: 1, [tcs.tag]: 1, [rolled.tag]: 2 },
        { [SENSEX_1001]: 1, [tcs.tag]: 1, [rolled.tag]: 1 },
      ),
    )
  } finally {
    console.log = original
  }
  const text = lines.join('\n')
  assert.match(text, /DAILY BOOK ROLL/)
  assert.match(text, /CREATE \+ START \+ SWITCH ON/)
  assert.match(text, /STOP \+ ERASE/)
  assert.match(text, /STOPPED, HOLDING/)
  assert.match(text, /LEFT RUNNING/)
  assert.match(text, /not a trading day/)
  assert.match(text, /DELETE \/v1\/desk\/books\/registry\/[^\s]+\?mode=paper/)
  assert.match(text, /SETTLE \+ STOP/)
  assert.match(text, /SETTLE \+ STOP \+ ERASE/)
  assert.match(text, /POST \/v1\/desk\/books\/registry\/[^\s]+\/settle-expired\?mode=paper/)
  assert.match(text, /OTHER PAPER BOOKS PAST EXPIRY/)
  // The prose may say "a stop does not flatten"; the WIRE lines must not.
  const wire = lines.filter((l) => /\b(POST|PATCH|DELETE) \//.test(l))
  assert.ok(wire.length > 0)
  assert.ok(!wire.some((l) => /flatten|purge/.test(l)), 'a printed call carries flatten or purge')
})

// ------------------------------------------- the playbook family (2026-10-16)

/**
 * The third family (spec 2026-10-16 §4.9): per symbol, the three intraday
 * playbooks every session, each on the nearest contract with its
 * `pb_min_dte` trading days to go, and the three expiry playbooks on the
 * symbol's own expiry day from 2026-10-21. One row per preset per DAY,
 * retired the morning after. Its own create and retire, OUTSIDE the daily
 * four's single-expiry check and their "not one of today's four" loop — a
 * Wing Straddle on NIFTY 10-27 beside the four's 10-19 must neither throw
 * "two target expiries" nor be stopped as an extra.
 *
 * The dump: NIFTY 10-19 (Monday — Dussehra is Tuesday the 20th), 10-27,
 * 11-03; SENSEX 10-22, 10-29, 11-05.
 */
const PB_LISTED: Readonly<Record<string, readonly string[]>> = {
  NIFTY: ['2026-10-19', '2026-10-27', '2026-11-03'],
  SENSEX: ['2026-10-22', '2026-10-29', '2026-11-05'],
}
/** The real `nearestExpiry` uses `>=`, and so does this. */
const PB_MASTER: MasterLike = {
  nearestExpiry(underlying: string, onOrAfter: string): string | null {
    for (const e of PB_LISTED[underlying] ?? []) if (e >= onOrAfter) return e
    return null
  },
}
const FRI16 = '2026-10-16'
const MON19 = '2026-10-19'
const THU22 = '2026-10-22'
const pbTag = (symbol: string, variant: string, day: string): string => `${symbol}-${variant}-${day}`

/** Today's playbook plans, as the registry holds them once created on `day`. */
function pbRowsFor(day: string, opts: { desired?: 'running' | 'stopped' } = {}): RegistryRow[] {
  const desired = opts.desired ?? 'running'
  const createdAt = nineAmIst(day)
  return books
    .planPlaybookBooks(PB_MASTER, day)
    .map((b) => ({ ...b, desired, actual: desired, createdAt, ...history(desired, createdAt) }))
}

/** The four of `day`, off the same dump. */
const fourFor = (day: string): readonly BookPlan[] => books.planBooks(books.expiriesFrom(PB_MASTER, day), day)

/**
 * The roll as `main` plans it on `todayIst`: the four, the hold pairs and the
 * playbook family off ONE master, the playbooks through their engine gate.
 */
function pbDayPlan(
  todayIst: string,
  rows: readonly RegistryRow[],
  held: Readonly<Record<string, number | null>> = {},
  opts: {
    knows?: () => boolean
    master?: MasterLike
    /** Open legs per tag on a contract that expired before today; absent reads as none known. */
    expired?: Readonly<Record<string, number | null>>
    /** Every tag's paper switch, as `main` reads them; absent, planned without them. */
    switches?: Readonly<Record<string, SwitchState>>
  } = {},
): RollPlan {
  const expiries = books.expiriesFrom(PB_MASTER, todayIst)
  const { playbookTargets, playbookBlocked } = roll.planPlaybookTargets(
    opts.master ?? PB_MASTER,
    todayIst,
    opts.knows ?? (() => true),
  )
  return planRoll({
    targets: books.planBooks(expiries, todayIst),
    holdTargets: books.planHoldBooks(expiries, todayIst),
    playbookTargets,
    playbookBlocked,
    rows,
    heldByTag: { ...allFlat(rows), ...held },
    ...(opts.expired === undefined ? {} : { expiredByTag: opts.expired }),
    ...(opts.switches === undefined ? {} : { switchByTag: opts.switches }),
    todayIst,
  })
}

function pbRetireFor(plan: RollPlan, tag: string): RetireEntry {
  const found = plan.playbook.retire.find((e) => e.row.tag === tag)
  assert.ok(found !== undefined, `${tag} is not in the playbook retire set`)
  return found
}

/** Is this tag anywhere a loop of ANOTHER family would act on it? */
function inOtherFamily(plan: RollPlan, tag: string): boolean {
  return (
    plan.symbols.some((s) => [...s.ensure.map((e) => e.plan.tag), ...s.retire.map((e) => e.row.tag)].includes(tag)) ||
    plan.symbols.some((s) => [...s.onTarget, ...s.leftStopped].some((h) => h.row.tag === tag)) ||
    plan.hold.retire.some((e) => e.row.tag === tag) ||
    plan.hold.carrying.some((h) => h.row.tag === tag) ||
    plan.expiredBooks.some((e) => e.row.tag === tag)
  )
}

/** Every call the recorder answered for a set of created books: create, start, switch on. */
const createCalls = (created: readonly BookPlan[]): string[] =>
  created.flatMap((b) => [`POST ${REG}`, `POST ${REG}/${b.tag}/start`, `PATCH ${STRAT}/${b.tag}`])

test('2026-10-16: six playbook books are created, started and switched on — after the four and the hold pairs, and outside both', async () => {
  const plan = pbDayPlan(FRI16, [])
  const playbooks = books.planPlaybookBooks(PB_MASTER, FRI16)
  assert.equal(playbooks.length, 6)
  assert.deepEqual(plan.playbook.ensure.map((e) => [e.plan.tag, e.why]), playbooks.map((b) => [b.tag, 'missing']))
  // The four keep their ONE target expiry per symbol, although Wing Straddle's
  // NIFTY contract is 10-27 and SENSEX's is 10-29.
  assert.equal(symbolPlan(plan, 'NIFTY').targetExpiry, '2026-10-19')
  assert.equal(symbolPlan(plan, 'SENSEX').targetExpiry, '2026-10-22')
  assert.ok(plan.symbols.every((s) => s.ensure.every((e) => !books.isPlaybook(e.plan))), 'a playbook in the four')
  assert.ok(plan.hold.ensure.every((e) => !books.isPlaybook(e.plan)), 'a playbook among the hold pairs')
  // Today's four, then the pairs, then the playbooks — the order `applyRoll` sends them in.
  const hold = books.planHoldBooks(books.expiriesFrom(PB_MASTER, FRI16), FRI16)
  assert.deepEqual(createdBooks(plan).map((b) => b.tag), [...fourFor(FRI16), ...hold, ...playbooks].map((b) => b.tag))
  assert.deepEqual([...plan.alarms], [])
  assert.deepEqual([...plan.anomalies], [])
  for (const e of plan.playbook.ensure) assert.equal(e.plan.mode, 'paper')

  // Why they are a family of their own: folded into the four's targets, the
  // single-expiry check refuses the whole plan.
  assert.throws(
    () => planRoll({ targets: [...fourFor(FRI16), ...playbooks], rows: [], heldByTag: {}, todayIst: FRI16 }),
    /two target expiries/,
  )

  const rec = recorder()
  const done = await applyRoll(plan, { request: rec.request })
  assert.deepEqual(rec.calls, createCalls([...fourFor(FRI16), ...hold, ...playbooks]))
  assert.deepEqual(done, { created: 16, started: 16, switchedOn: 16, stopped: 0, erased: 0, settled: 0, refused: [] })
})

test("a converged desk — today's playbook books running beside the four — is not written to: no playbook row is an 'extra' to stop", async () => {
  // The four's retire stops a delta-lean row born today that is not one of
  // today's four. A playbook row never reaches that loop.
  const expiries = books.expiriesFrom(PB_MASTER, FRI16)
  const rows = [...rowsFor(FRI16, expiries), ...holdRowsFor(FRI16, expiries), ...pbRowsFor(FRI16)]
  const plan = pbDayPlan(FRI16, rows)
  assert.deepEqual(plan.playbook.onTarget.map((h) => h.row.tag), pbRowsFor(FRI16).map((r) => r.tag))
  assert.deepEqual([...createdBooks(plan)], [])
  assert.deepEqual([...stoppedTags(plan)], [])
  assert.deepEqual([...erasedTags(plan)], [])
  assert.deepEqual(plan.symbols.flatMap((s) => s.retire), [])
  assert.deepEqual([...plan.alarms], [])
  assert.deepEqual([...plan.anomalies], [])
  const rec = recorder()
  assert.deepEqual(await applyRoll(plan, { request: rec.request }), {
    created: 0, started: 0, switchedOn: 0, stopped: 0, erased: 0, settled: 0, refused: [],
  })
  assert.deepEqual(rec.calls, [], 'a converged desk is not written to')
})

test("2026-10-19: Friday's playbook books are retired — flat → stop + erase, stopped flat → erase; a holder or an unreadable one is an ALARM, untouched", () => {
  const [trendN, wingN, revN, trendS, wingS, revS] = pbRowsFor(FRI16) as [
    RegistryRow, RegistryRow, RegistryRow, RegistryRow, RegistryRow, RegistryRow,
  ]
  const stopped = (r: RegistryRow): RegistryRow => ({ ...r, desired: 'stopped', actual: 'stopped' })
  const rows = [trendN, wingN, revN, stopped(trendS), stopped(wingS), revS]
  const plan = pbDayPlan(MON19, rows, { [wingN.tag]: 2, [revN.tag]: null, [wingS.tag]: 1 })

  assert.equal(pbRetireFor(plan, trendN.tag).action, 'erase')
  assert.equal(pbRetireFor(plan, wingN.tag).action, 'holds-legs')
  assert.equal(pbRetireFor(plan, revN.tag).action, 'unknown')
  assert.equal(pbRetireFor(plan, trendS.tag).action, 'erase')
  assert.equal(pbRetireFor(plan, wingS.tag).action, 'stopped-holds-legs')
  assert.equal(pbRetireFor(plan, revS.tag).action, 'erase')
  for (const r of rows) assert.equal(pbRetireFor(plan, r.tag).day, FRI16)
  // Stopped first only when still running; erased only when flat.
  assert.deepEqual([...stoppedTags(plan)].filter((t) => t.includes('-pb-')).sort(), [trendN.tag, revS.tag].sort())
  assert.deepEqual([...erasedTags(plan)].filter((t) => t.includes('-pb-')).sort(), [trendN.tag, trendS.tag, revS.tag].sort())
  const alarm = (tag: string): string | undefined => plan.alarms.find((a) => a.includes(tag))
  assert.match(alarm(wingN.tag) ?? '', /HOLDS 2 open leg/)
  assert.match(alarm(wingN.tag) ?? '', /NOT STOPPED/)
  assert.match(alarm(revN.tag) ?? '', /CANNOT TELL/)
  assert.match(alarm(wingS.tag) ?? '', /ALREADY STOPPED/)
  assert.equal(plan.alarms.length, 3)
  // No other family's loop ever saw them, and today's six are created as usual.
  for (const r of rows) assert.ok(!inOtherFamily(plan, r.tag), `${r.tag} reached another family's loop`)
  assert.deepEqual(plan.playbook.ensure.map((e) => e.plan.tag), books.planPlaybookBooks(PB_MASTER, MON19).map((b) => b.tag))
})

test('Review #6 — a playbook book whose every open leg is on a contract that has expired is SETTLED, then stopped and erased; a refused settle leaves it in ATTENTION', async () => {
  // Thursday 10-22, SENSEX's expiry: the Expiry Theta fly's long wing, ₹0.05
  // at the close with no bid, could not be sold and expired with the
  // contract (spec O23). On Friday the row holds one leg on a dead contract.
  // No flatten can ever fill it, so this retire used to ALARM it every
  // morning and leave it running — its host asking each pass to close a leg
  // it could no longer name — until somebody settled it by hand. The four,
  // the hold books and the fourth loop already settled such a book.
  const FRI23 = '2026-10-23'
  const thu = pbRowsFor(THU22)
  const theta = pbTag('SENSEX', 'pb-expiry-theta', THU22)
  const drive = pbTag('SENSEX', 'pb-expiry-drive', THU22)
  // The Wing Straddle sits on a LIVE contract (NIFTY 11-03): a position, not a settlement.
  const wingN = pbTag('NIFTY', 'pb-wing-straddle', THU22)
  assert.equal(thu.find((r) => r.tag === theta)?.expiry, THU22)
  const plan = pbDayPlan(FRI23, thu, { [theta]: 1, [wingN]: 2 }, { expired: { [theta]: 1, [wingN]: 0 } })
  assert.equal(pbRetireFor(plan, theta).action, 'settle-then-erase')
  assert.equal(pbRetireFor(plan, drive).action, 'erase')
  assert.equal(pbRetireFor(plan, wingN).action, 'holds-legs')
  assert.ok(roll.settledTags(plan).includes(theta))
  assert.ok(stoppedTags(plan).includes(theta) && erasedTags(plan).includes(theta), 'settled, then stopped and erased')
  assert.ok(!plan.alarms.some((a) => a.includes(theta)), 'a leg on a dead contract is a settlement, not an alarm')
  assert.ok(plan.alarms.some((a) => a.includes(wingN) && /NOT STOPPED/.test(a)), 'a live-contract leg is still an alarm')

  // On the wire: settle, then the stops, then the erases — inside the
  // playbook retire, after every create and before the fourth loop.
  const rec = recorder()
  const done = await applyRoll(plan, { request: rec.request })
  const at = (call: string): number => rec.calls.indexOf(call)
  assert.ok(at(settlePath(theta)) > at(`PATCH ${STRAT}/${pbTag('SENSEX', 'pb-reversal', FRI23)}`), 'a settle before the last create')
  assert.ok(at(`POST ${REG}/${theta}/stop`) > at(settlePath(theta)), 'stopped before it was settled')
  assert.ok(at(`DELETE ${REG}/${theta}?mode=paper`) > at(`POST ${REG}/${theta}/stop`))
  const lastStop = Math.max(...rec.calls.map((c, i) => (c.endsWith('/stop') ? i : -1)))
  assert.ok(rec.calls.findIndex((c) => c.startsWith('DELETE ')) > lastStop, 'an erase before a stop')
  assert.ok(!rec.calls.some((c) => c.includes(wingN)), 'the live holder was touched')
  assert.equal(done.settled, 1)
  assert.deepEqual([...done.refused], [])

  // A settle the server refuses (no close on file) leaves the book exactly
  // where it is, named in ATTENTION; the other playbook rows still go.
  const text = 'no close for SENSEX on 2026-10-22 — NOTHING WAS SETTLED'
  const refusing = recorder({ [settlePath(theta)]: { status: 409, body: { error: text }, text } })
  const after = await applyRoll(plan, { request: refusing.request })
  assert.ok(!refusing.calls.includes(`POST ${REG}/${theta}/stop`), 'an unsettled book was stopped')
  assert.ok(!refusing.calls.includes(`DELETE ${REG}/${theta}?mode=paper`), 'an unsettled book was erased')
  assert.ok(refusing.calls.includes(`DELETE ${REG}/${drive}?mode=paper`), 'the flat rows were held hostage')
  assert.equal(after.settled, 0)
  assert.equal(after.refused.length, 1)
  assert.match(after.refused[0] ?? '', new RegExp(`${theta}.*409`))
})

test('a playbook row of TODAY that is not one of the plans is never touched — and one with no readable day is an anomaly', () => {
  // A hand-registered Expiry Drive on NIFTY's 10-19 expiry, before the date
  // the roll creates them from (Review Focus 4: the frame refuses the entry
  // or trades it; the roll does neither). Running and flat: carried, silently.
  const [proto] = books.planPlaybookBooks(PB_MASTER, THU22).filter((b) => b.variant === 'pb-expiry-drive')
  assert.ok(proto !== undefined)
  const extra: RegistryRow = {
    ...proto,
    tag: pbTag('NIFTY', 'pb-expiry-drive', MON19),
    symbol: 'NIFTY',
    expiry: MON19,
    series: 'NIFTY-pb-expiry-drive',
    desired: 'running',
    actual: 'running',
    createdAt: nineAmIst(MON19),
  }
  const stoppedHolder: RegistryRow = { ...extra, tag: `${extra.tag}-b`, desired: 'stopped', actual: 'stopped' }
  // createdAt lost (bookFromDoc answers 0): Friday's tag still names its day,
  // so it retires by that; a tag that names no day leaves it unknown.
  const [fri] = pbRowsFor(FRI16) as [RegistryRow]
  const lostCreatedAt: RegistryRow = { ...fri, createdAt: 0 }
  const noDay: RegistryRow = { ...fri, tag: 'NIFTY-pb-trend-drive-by-hand', createdAt: 0 }
  const plan = pbDayPlan(MON19, [extra, stoppedHolder, lostCreatedAt, noDay], { [stoppedHolder.tag]: 2 })

  assert.deepEqual(plan.playbook.ofToday.map((h) => h.row.tag), [extra.tag, stoppedHolder.tag])
  for (const tag of [extra.tag, stoppedHolder.tag, noDay.tag]) {
    assert.ok(!stoppedTags(plan).includes(tag) && !erasedTags(plan).includes(tag), `${tag} was touched`)
    assert.ok(!plan.playbook.retire.some((e) => e.row.tag === tag), `${tag} is in the retire`)
  }
  assert.ok(!plan.alarms.some((a) => a.includes(extra.tag) && !a.includes(stoppedHolder.tag)), 'a running extra is not trouble')
  assert.ok(plan.alarms.some((a) => a.includes(stoppedHolder.tag) && /STOPPED/.test(a)), 'a stopped holder of today, silent')
  assert.equal(pbRetireFor(plan, lostCreatedAt.tag).action, 'erase')
  assert.equal(pbRetireFor(plan, lostCreatedAt.tag).day, FRI16, "the tag's date stands in for a lost createdAt")
  assert.ok(plan.anomalies.some((a) => a.includes(noDay.tag) && /LEFT UNTOUCHED/.test(a)))
})

test("a stopped, flat playbook target registered THIS morning is a run that died — started; any other stopped target is ATTENTION", async () => {
  const halfBorn = pbRowsFor(MON19, { desired: 'stopped' })
  const plan = pbDayPlan(MON19, [...rowsFor(MON19, books.expiriesFrom(PB_MASTER, MON19)), ...halfBorn])
  assert.deepEqual(
    plan.playbook.ensure.map((e) => [e.plan.tag, e.why]),
    halfBorn.map((r) => [r.tag, 'created-not-started']),
  )
  assert.deepEqual([...plan.playbook.leftStopped], [])
  assert.deepEqual([...plan.anomalies], [])
  const rec = recorder()
  await applyRoll(plan, { request: rec.request })
  const hold = books.planHoldBooks(books.expiriesFrom(PB_MASTER, MON19), MON19)
  assert.deepEqual(rec.calls, createCalls([...hold, ...books.planPlaybookBooks(PB_MASTER, MON19)]))

  // Registered on an earlier day, or holding: left stopped, and named.
  const [earlier, holding, ...rest] = halfBorn as [RegistryRow, RegistryRow, ...RegistryRow[]]
  const odd = pbDayPlan(MON19, [{ ...earlier, createdAt: nineAmIst(FRI16) }, holding, ...rest], { [holding.tag]: 1 })
  assert.deepEqual(odd.playbook.leftStopped.map((h) => h.row.tag), [earlier.tag, holding.tag])
  assert.ok(odd.anomalies.some((a) => a.includes(earlier.tag) && /STOPPED/.test(a)), 'a stopped target, silent')
  assert.ok(odd.alarms.some((a) => a.includes(holding.tag) && /HOLDS 1 open leg/.test(a)), 'a stopped holder, not alarmed')
  assert.ok(!createdBooks(odd).some((b) => b.tag === earlier.tag || b.tag === holding.tag))
})

test("Review #3 — a playbook target the operator stopped by hand this morning is left stopped by a same-day re-run; only a row no start has reached is a run that died", async () => {
  // 19 Oct: the rows were registered and started at 09:00. The operator stops
  // the SENSEX Wing Straddle at 09:40 (flat). A re-run at 10:05 — to clear
  // some other ATTENTION — used to read "stopped, flat, registered today" as a
  // run that died between create and start, and restarted it with its switch
  // on, inside its 09:30-12:30 entry window.
  const createdAt = nineAmIst(MON19)
  const ex19 = books.expiriesFrom(PB_MASTER, MON19)
  const wingS = pbTag('SENSEX', 'pb-wing-straddle', MON19)
  const todays = pbRowsFor(MON19)
  const proto = todays.find((r) => r.tag === wingS) as RegistryRow
  const rest = [...rowsFor(MON19, ex19), ...holdRowsFor(MON19, ex19), ...todays.filter((r) => r.tag !== wingS)]
  const stoppedByHand: RegistryRow = {
    ...proto,
    desired: 'stopped',
    actual: 'stopped',
    lastMarkAt: createdAt + 35 * 60_000,
    updatedAt: createdAt + 40 * 60_000,
  }
  const plan = pbDayPlan(MON19, [...rest, stoppedByHand])
  assert.deepEqual([...plan.playbook.ensure], [], 'a hand-stopped book was planned for a start')
  assert.deepEqual(plan.playbook.leftStopped.map((h) => h.row.tag), [wingS])
  assert.ok(plan.anomalies.some((a) => a.includes(wingS) && /STOPPED/.test(a)), 'left stopped silently')
  const rec = recorder()
  await applyRoll(plan, { request: rec.request })
  assert.deepEqual(rec.calls, [], 'a desk whose only odd row is a hand-stopped book is not written to')

  // ANY sign that a start ever reached the row is enough on its own...
  const untouched: RegistryRow = { ...proto, desired: 'stopped', actual: 'stopped', lastMarkAt: 0, updatedAt: createdAt }
  for (const [sign, row] of [
    ['a write after its create (the start; the stop)', { ...untouched, updatedAt: createdAt + 1 }],
    ['a mark the supervisor reported', { ...untouched, lastMarkAt: createdAt + 5_000 }],
    ['the supervisor still reporting it running', { ...untouched, actual: 'running' }],
  ] as const) {
    const p = pbDayPlan(MON19, [...rest, row])
    assert.deepEqual(p.playbook.leftStopped.map((h) => h.row.tag), [wingS], sign)
    assert.deepEqual([...p.playbook.ensure], [], sign)
  }
  // ...a row read without its history proves nothing, so it is left too...
  const bare = Object.fromEntries(
    Object.entries(untouched).filter(([k]) => k !== 'updatedAt' && k !== 'lastMarkAt'),
  ) as unknown as RegistryRow
  assert.deepEqual(pbDayPlan(MON19, [...rest, bare]).playbook.leftStopped.map((h) => h.row.tag), [wingS], 'no history')
  // ...and a row nothing has touched since its create is still finished.
  const died = pbDayPlan(MON19, [...rest, untouched])
  assert.deepEqual(died.playbook.ensure.map((e) => [e.plan.tag, e.why]), [[wingS, 'created-not-started']])
  assert.deepEqual([...died.playbook.leftStopped], [])
})

test('a half-member is an anomaly, untouched by every loop: the variant, delta_lean_enabled and pb_playbook must all agree', () => {
  const [base] = pbRowsFor(FRI16) as [RegistryRow]
  const [daily] = rowsFor(FRI16, books.expiriesFrom(PB_MASTER, FRI16)) as [RegistryRow]
  const without = (r: RegistryRow, key: string): RegistryRow => ({
    ...r,
    dials: Object.fromEntries(Object.entries(r.dials).filter(([k]) => k !== key)),
  })
  const halfMembers: RegistryRow[] = [
    { ...base, tag: `${base.tag}-a`, dials: { ...base.dials, pb_playbook: 0 } },
    { ...without(base, 'pb_playbook'), tag: `${base.tag}-b` },
    { ...base, tag: `${base.tag}-c`, dials: { ...base.dials, delta_lean_enabled: false } },
    // The reverse: a daily variant whose dials would hand it to the playbook frame.
    { ...daily, tag: `${daily.tag}-d`, dials: { ...daily.dials, pb_playbook: 2 } },
    // ...and the stock book of another family carrying the dial.
    { ...stockRow('TCS'), tag: 'TCS-2026-09-29-recenter-relief-r-e', dials: { margin_cap: 5000000, pb_playbook: 3 } },
  ]
  // A playbook carrying the hold dial is a weekly engine under a daily tag.
  const holdToo: RegistryRow = { ...base, tag: `${base.tag}-f`, dials: { ...base.dials, dl_hold_to_expiry: true } }
  const plan = pbDayPlan(MON19, [...halfMembers, holdToo])
  for (const r of [...halfMembers, holdToo]) {
    assert.ok(!inOtherFamily(plan, r.tag), `${r.tag} reached another family's loop`)
    assert.ok(
      ![...plan.playbook.retire.map((e) => e.row.tag), ...plan.playbook.ofToday.map((h) => h.row.tag)].includes(r.tag),
      `${r.tag} is in the playbook family`,
    )
    assert.ok(!stoppedTags(plan).includes(r.tag) && !erasedTags(plan).includes(r.tag), `${r.tag} was touched`)
  }
  for (const r of halfMembers) {
    assert.ok(
      plan.anomalies.some((a) => a.includes(r.tag) && /pb_playbook/.test(a) && /LEFT UNTOUCHED/.test(a)),
      `${r.tag} not reported`,
    )
  }
  assert.ok(plan.anomalies.some((a) => a.includes(holdToo.tag) && /dl_hold_to_expiry/.test(a)))
  assert.equal(plan.anomalies.length, halfMembers.length + 1)
  assert.equal(roll.isDeltaLean(base), true, 'a playbook book is one of ours')
})

test('Review #5 — a row of a preset since removed from PLAYBOOK_PRESET_KEYS is still a playbook book by its dials: retired the morning after, never an orphan', () => {
  // Runbook §8.4 switches a preset off by stopping its rows and removing its
  // key. Its rows still say what they are where the engine reads it —
  // `delta_lean_enabled` true, `pb_playbook` 3 — and that, not the list the
  // roll CREATES from, is what makes them this family's to retire. Read off
  // the list, every such row was an anomaly "LEFT UNTOUCHED by every loop":
  // trading on under its old tag if it was left running, and an exit 1 every
  // morning if it was stopped. (A variant outside the list stands in for the
  // removed key.)
  const proto = pbRowsFor(FRI16).find((r) => r.variant === 'pb-reversal') as RegistryRow
  const removed = (tag: string, over: Partial<RegistryRow> = {}): RegistryRow => ({
    ...proto,
    tag,
    variant: 'pb-retired',
    series: 'NIFTY-pb-retired',
    ...over,
  })
  const running = removed('NIFTY-pb-retired-2026-10-16')
  const stopped = removed('NIFTY-pb-retired-b-2026-10-16', { desired: 'stopped', actual: 'stopped' })
  const holding = removed('NIFTY-pb-retired-c-2026-10-16')
  assert.equal(books.isPlaybook(running), true, 'membership read off the list of presets')
  assert.equal(roll.isDeltaLean(running), true)

  const plan = pbDayPlan(MON19, [running, stopped, holding], { [holding.tag]: 2 })
  assert.equal(pbRetireFor(plan, running.tag).action, 'erase')
  assert.equal(pbRetireFor(plan, stopped.tag).action, 'erase')
  assert.equal(pbRetireFor(plan, holding.tag).action, 'holds-legs')
  assert.ok(stoppedTags(plan).includes(running.tag), 'a running row is stopped before its DELETE')
  assert.ok(!stoppedTags(plan).includes(stopped.tag), 'an already-stopped row is only erased')
  assert.ok(erasedTags(plan).includes(running.tag) && erasedTags(plan).includes(stopped.tag))
  assert.ok(!stoppedTags(plan).includes(holding.tag) && !erasedTags(plan).includes(holding.tag))
  assert.ok(plan.alarms.some((a) => a.includes(holding.tag) && /NOT STOPPED/.test(a)), 'a holder, not alarmed')
  assert.deepEqual([...plan.anomalies], [], 'a removed preset row is an orphan in ATTENTION')
  for (const r of [running, stopped, holding]) assert.ok(!inOtherFamily(plan, r.tag), `${r.tag} reached another family's loop`)
  // Never a target: the roll creates only the presets in the list.
  assert.ok(!plan.playbook.ensure.some((e) => e.plan.variant === 'pb-retired'))

  // The four and the hold pairs state pb_playbook 0, so membership by the
  // dials never captures them, whatever their variant.
  const ex16 = books.expiriesFrom(PB_MASTER, FRI16)
  for (const r of [...rowsFor(FRI16, ex16), ...holdRowsFor(FRI16, ex16)]) {
    assert.equal(r.dials['pb_playbook'], 0, r.tag)
    assert.equal(books.isPlaybook(r), false, r.tag)
  }
})

test('the engine gate: on a build that does not know pb_playbook no playbook book is created or retired, the run names it — and the four and the pairs roll unchanged', async () => {
  const known = roll.planPlaybookTargets(PB_MASTER, MON19, () => true)
  assert.equal(known.playbookBlocked, null)
  assert.deepEqual(known.playbookTargets.map((b) => b.tag), books.planPlaybookBooks(PB_MASTER, MON19).map((b) => b.tag))
  assert.equal(books.engineKnowsPlaybookDial(), Object.hasOwn(DEFAULT_DIALS, 'pb_playbook'))

  const gate = roll.planPlaybookTargets(PB_MASTER, MON19, () => false)
  assert.deepEqual([...gate.playbookTargets], [])
  assert.ok(gate.playbookBlocked !== null)
  assert.match(gate.playbookBlocked, /pb_playbook/)
  assert.match(gate.playbookBlocked, /restart desk-supervisor/)

  // Friday's whole desk on Monday morning: the four, the pairs, the playbooks.
  const ex16 = books.expiriesFrom(PB_MASTER, FRI16)
  const others = [...rowsFor(FRI16, ex16), ...holdRowsFor(FRI16, ex16)]
  const playbookRows = pbRowsFor(FRI16)
  const gated = pbDayPlan(MON19, [...others, ...playbookRows], {}, { knows: () => false })
  assert.deepEqual([...gated.playbook.ensure], [])
  assert.deepEqual([...gated.playbook.retire], [])
  assert.deepEqual(gated.playbook.gated.map((h) => h.row.tag), playbookRows.map((r) => r.tag))
  assert.ok(gated.anomalies.includes(gate.playbookBlocked), 'the gate is not in ATTENTION, so the run would exit 0')
  assert.deepEqual([...gated.anomalies], [gate.playbookBlocked])

  // The other families: exactly the plan they make with no playbook family at all.
  const ex19 = books.expiriesFrom(PB_MASTER, MON19)
  const alone = planRoll({
    targets: books.planBooks(ex19, MON19),
    holdTargets: books.planHoldBooks(ex19, MON19),
    rows: others,
    heldByTag: allFlat(others),
    todayIst: MON19,
  })
  assert.deepEqual(gated.symbols, alone.symbols)
  assert.deepEqual(gated.hold, alone.hold)
  assert.deepEqual(gated.expiredBooks, alone.expiredBooks)
  const gatedCalls = recorder()
  const aloneCalls = recorder()
  const done = await applyRoll(gated, { request: gatedCalls.request })
  await applyRoll(alone, { request: aloneCalls.request })
  assert.ok(!gatedCalls.calls.some((c) => c.includes('-pb-')), 'a playbook call went out through the gate')
  assert.deepEqual(gatedCalls.calls, aloneCalls.calls)
  assert.ok(done.created > 0 && done.erased > 0, 'the four and the pairs still roll')

  // ...and the line is printed in the ATTENTION block.
  const lines: string[] = []
  const original = console.log
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '))
  }
  try {
    roll.printPlan(gated)
  } finally {
    console.log = original
  }
  const text = lines.join('\n')
  assert.ok(text.indexOf('ATTENTION') >= 0 && text.indexOf(gate.playbookBlocked) > text.indexOf('ATTENTION'))
  assert.match(text, /GATED/)
})

test("a playbook plan that cannot be made (the dump lists no contract far enough out) gates the family; the four and the pairs still roll", () => {
  // A dump with only NIFTY's front weekly: Wing Straddle has no contract.
  // Planning throws; the roll reads that as the family's gate, never as a
  // reason to leave the four uncreated.
  const thin: MasterLike = {
    nearestExpiry: (u, onOrAfter) => (u === 'NIFTY' ? (onOrAfter <= '2026-10-19' ? '2026-10-19' : null) : PB_MASTER.nearestExpiry(u, onOrAfter)),
  }
  const blocked = roll.planPlaybookTargets(thin, FRI16, () => true)
  assert.deepEqual([...blocked.playbookTargets], [])
  assert.ok(blocked.playbookBlocked !== null)
  assert.match(blocked.playbookBlocked, /make sync/)
  assert.match(blocked.playbookBlocked, /pb-wing-straddle/)
  const plan = pbDayPlan(FRI16, pbRowsFor('2026-10-15'), {}, { master: thin })
  assert.deepEqual([...plan.playbook.ensure], [])
  assert.deepEqual([...plan.playbook.retire], [], 'the retire half never runs without the create half')
  assert.ok(plan.anomalies.includes(blocked.playbookBlocked))
  assert.equal(createdBooks(plan).filter((b) => !books.isPlaybook(b)).length, 10, 'the six daily books and the pairs')
})

test('a non-trading day plans no playbook book either', () => {
  const plan = pbDayPlan('2026-10-17', pbRowsFor(FRI16))
  assert.equal(plan.tradingDay, false)
  assert.deepEqual([...plan.playbook.ensure], [])
  assert.deepEqual([...plan.playbook.retire], [])
})

test('applyRoll with all three families: every create (four, pairs, playbooks) before any stop; then the daily, hold, playbook and fourth-loop retires', async () => {
  // Monday 10-19 over Friday's desk, plus a September stock book past its contract.
  const ex16 = books.expiriesFrom(PB_MASTER, FRI16)
  const fours = rowsFor(FRI16, ex16)
  const pairs = holdRowsFor(FRI16, ex16)
  const fri = pbRowsFor(FRI16)
  const tcs = stockRow('TCS')
  const plan = pbDayPlan(MON19, [...fours, ...pairs, ...fri, tcs])
  const rec = recorder()
  const done = await applyRoll(plan, { request: rec.request })

  // NIFTY's 10-19 pair carries to today's close; SENSEX's 10-22 pair is on
  // target — so no pair is created this morning.
  assert.deepEqual([...plan.hold.ensure], [])
  const expected = createCalls([...fourFor(MON19), ...books.planPlaybookBooks(PB_MASTER, MON19)])
  for (const r of fours) expected.push(`POST ${REG}/${r.tag}/stop`)
  for (const r of fours) expected.push(`DELETE ${REG}/${r.tag}?mode=paper`)
  for (const r of fri) expected.push(`POST ${REG}/${r.tag}/stop`)
  for (const r of fri) expected.push(`DELETE ${REG}/${r.tag}?mode=paper`)
  expected.push(`POST ${REG}/${tcs.tag}/stop`, `DELETE ${REG}/${tcs.tag}?mode=paper`)
  assert.deepEqual(rec.calls, expected)
  // Seven daily books on NIFTY's expiry Monday, six playbooks; Friday's six
  // daily, six playbook and the stock book retire.
  assert.deepEqual(done, { created: 13, started: 13, switchedOn: 13, stopped: 13, erased: 13, settled: 0, refused: [] })
  assert.ok(!rec.calls.some((c) => pairs.some((p) => c.includes(p.tag))), 'a hold pair was written to')
  assert.ok(!rec.calls.some((c) => /flatten|purge/.test(c)))
})

/**
 * A recorder whose answer to ONE book's create (by the tag in its body — every
 * create shares a path) is `answer`; every other call as `recorder` answers.
 */
function failingCreate(tag: string, answer: WireResult, overrides: Readonly<Record<string, WireResult>> = {}): {
  readonly calls: string[]
  readonly request: Request
} {
  const rec = recorder(overrides)
  return {
    calls: rec.calls,
    async request(method: Method, path: string, body?: unknown): Promise<WireResult> {
      if (method === 'POST' && path === REG && (body as { tag?: unknown } | undefined)?.tag === tag) {
        rec.calls.push(`${method} ${path}`)
        return answer
      }
      return await rec.request(method, path, body)
    },
  }
}

test("Review #2 — a playbook create, start or switch-on that fails costs only the playbook family: yesterday's four still go, the fourth loop still runs, the playbook retire is skipped", async () => {
  // Monday 10-19 over Friday's desk. Today's four are created fine; then
  // desk-api answers 503 to one playbook create. Before the fence the whole
  // run threw there — no stop, no erase — and Friday's four, flat and still
  // running, re-opened beside today's: eight intraday books, twice the
  // exposure on both symbols, until somebody read the 08:50 log.
  const ex16 = books.expiriesFrom(PB_MASTER, FRI16)
  const fours = rowsFor(FRI16, ex16)
  const fri = pbRowsFor(FRI16)
  const tcs = stockRow('TCS')
  const plan = pbDayPlan(MON19, [...fours, ...holdRowsFor(FRI16, ex16), ...fri, tcs])
  const todays = books.planPlaybookBooks(PB_MASTER, MON19)
  const wingN = pbTag('NIFTY', 'pb-wing-straddle', MON19)
  const trendS = pbTag('SENSEX', 'pb-trend-drive', MON19)
  assert.deepEqual(todays.map((b) => b.tag).slice(0, 4), [pbTag('NIFTY', 'pb-trend-drive', MON19), wingN, pbTag('NIFTY', 'pb-reversal', MON19), trendS])

  // The create, the start and the switch-on, each failing in turn.
  const failures: ReadonlyArray<{ readonly label: string; readonly rec: { calls: string[]; request: Request }; readonly sent: readonly string[] }> = [
    {
      label: 'create 503',
      rec: failingCreate(wingN, { status: 503, body: null, text: 'desk-api busy' }),
      // NIFTY Trend Drive went out whole; the Wing Straddle's create is the last playbook call.
      sent: [...createCalls(todays.slice(0, 1)), `POST ${REG}`],
    },
    {
      label: 'start 500',
      rec: recorder({ [`POST ${REG}/${wingN}/start`]: { status: 500, body: null, text: 'mongo is down' } }),
      sent: [...createCalls(todays.slice(0, 1)), `POST ${REG}`, `POST ${REG}/${wingN}/start`],
    },
    {
      label: 'switch-on 400',
      rec: recorder({ [`PATCH ${STRAT}/${trendS}`]: { status: 400, body: null, text: `'${trendS}' is not added to paper` } }),
      sent: createCalls(todays.slice(0, 4)),
    },
  ]
  for (const { label, rec, sent } of failures) {
    const done = await applyRoll(plan, { request: rec.request })
    const expected = [...createCalls(fourFor(MON19)), ...sent]
    for (const r of fours) expected.push(`POST ${REG}/${r.tag}/stop`)
    for (const r of fours) expected.push(`DELETE ${REG}/${r.tag}?mode=paper`)
    // ...no playbook retire: the retire half never runs without the create half...
    expected.push(`POST ${REG}/${tcs.tag}/stop`, `DELETE ${REG}/${tcs.tag}?mode=paper`)
    assert.deepEqual(rec.calls, expected, label)
    assert.ok(!rec.calls.some((c) => fri.some((r) => c.includes(r.tag))), `${label}: a playbook row of Friday was retired`)
    // ...and the run says so: one ATTENTION line, so it exits 1.
    assert.equal(done.refused.length, 1, label)
    const line = done.refused[0] ?? ''
    assert.match(line, label === 'switch-on 400' ? new RegExp(trendS) : new RegExp(wingN), label)
    assert.match(line, /playbook retire .*SKIPPED/i, label)
    assert.equal(done.erased, fours.length + 1, label)
  }
})

test('Review #2 — a stop or erase that fails in the playbook retire is an ATTENTION line, never an abort: the fourth loop still runs', async () => {
  const fri = pbRowsFor(FRI16)
  const tcs = stockRow('TCS')
  const plan = pbDayPlan(MON19, [...fri, tcs])
  const [first] = fri as [RegistryRow]
  for (const [label, key, answer] of [
    ['stop 500', `POST ${REG}/${first.tag}/stop`, { status: 500, body: null, text: 'mongo is down' }],
    ['erase 503', `DELETE ${REG}/${first.tag}?mode=paper`, { status: 503, body: null, text: 'busy' }],
  ] as const) {
    const rec = recorder({ [key]: answer })
    const done = await applyRoll(plan, { request: rec.request })
    assert.ok(rec.calls.includes(key), `${label}: the failing call was not sent`)
    assert.deepEqual(rec.calls.slice(-2), [`POST ${REG}/${tcs.tag}/stop`, `DELETE ${REG}/${tcs.tag}?mode=paper`], `${label}: the fourth loop did not run`)
    assert.equal(done.refused.length, 1, label)
    assert.match(done.refused[0] ?? '', new RegExp(`${first.tag}.*${answer.status}`), label)
  }
})

test('the fence is for failures, not for refusals: a playbook create the registry echoes as LIVE still aborts the run before any stop', async () => {
  // Layer 5 says a create whose response echoes any other mode aborts the
  // run. The playbook fence does not soften that: a paper or flat check on
  // the line that sends is never an ATTENTION line.
  const plan = pbDayPlan(MON19, [...rowsFor(FRI16, books.expiriesFrom(PB_MASTER, FRI16)), ...pbRowsFor(FRI16)])
  const rec = failingCreate(pbTag('NIFTY', 'pb-reversal', MON19), { status: 201, body: { mode: 'live' }, text: '' })
  await assert.rejects(applyRoll(plan, { request: rec.request }), /REFUSED/)
  assert.ok(!rec.calls.some((c) => c.endsWith('/stop') || c.startsWith('DELETE ')))
})

test('readSwitches: the paper switch and the day guard\'s paper stamp, per tag, as desk-strategies holds them', () => {
  const got = roll.readSwitches([
    { tag: 'ON', modes: { paper: { enabled: true } } },
    { tag: 'OFF', modes: { paper: { enabled: false } } },
    { tag: 'LIVE-ONLY', modes: { live: { enabled: false } } },
    { tag: 'NOTHING', modes: {} },
    { tag: 'TRIPPED', modes: { paper: { enabled: false } }, disabledByGuard: { paper: { day: MON19, trigger: 'stop' } } },
    // A stamp on the LIVE rail says nothing about the paper one.
    { tag: 'LIVE-TRIPPED', modes: { paper: { enabled: true } }, disabledByGuard: { live: { day: MON19, trigger: 'target' } } },
  ])
  assert.deepEqual(Object.fromEntries(got), {
    ON: { paper: 'on', guard: null },
    OFF: { paper: 'off', guard: null },
    'LIVE-ONLY': { paper: 'not-added', guard: null },
    NOTHING: { paper: 'not-added', guard: null },
    TRIPPED: { paper: 'off', guard: { day: MON19, trigger: 'stop' } },
    'LIVE-TRIPPED': { paper: 'on', guard: null },
  })
})

test("Review #8 — a running target of this morning whose paper switch is off and that has never marked is switched on by the re-run; the day guard's switch-off is never touched, and any other is ATTENTION", async () => {
  // 19 Oct, 08:50: one book's switch-on PATCH failed after its start, and
  // the message said "fix the cause and re-run". The re-run found the book
  // running, counted it on target and sent nothing — so it decided all day
  // with its switch off and filled nothing, the oldest bug on this desk. The
  // re-run now reads the switches and finishes exactly the books whose
  // switch-on cannot have landed: registered THIS morning, not stamped by the
  // day guard, and never marked — a switched-off flat book idles before its
  // mark, so one whose switch has been off since its start never marks.
  const ex16 = books.expiriesFrom(PB_MASTER, FRI16)
  const ex19 = books.expiriesFrom(PB_MASTER, MON19)
  const niftyAgg = `NIFTY-delta-lean-aggressive-${MON19}`
  const trendS = pbTag('SENSEX', 'pb-trend-drive', MON19)
  const revN = pbTag('NIFTY', 'pb-reversal', MON19)
  const wingS = pbTag('SENSEX', 'pb-wing-straddle', MON19)
  // Friday's SENSEX 10-22 pair is this morning's hold target, but registered on Friday.
  const pairAgg = holdTag('SENSEX', 'aggressive', '2026-10-22')
  const rows = [...rowsFor(MON19, ex19), ...holdRowsFor(FRI16, ex16), ...pbRowsFor(MON19)].map((r) =>
    // The NIFTY Reversal has been deciding since 09:15 — and marking.
    r.tag === revN ? { ...r, lastMarkAt: istMs(MON19, '09:45') } : r,
  )
  const switches: Record<string, SwitchState> = Object.fromEntries(
    rows.filter((r) => r.tag !== wingS).map((r) => [r.tag, { paper: 'on', guard: null }]),
  )
  switches[niftyAgg] = { paper: 'off', guard: null } // the switch-on that failed
  switches[trendS] = { paper: 'off', guard: { day: MON19, trigger: 'stop' } } // the day guard's
  switches[revN] = { paper: 'off', guard: null } // switched off after it had been deciding
  switches[pairAgg] = { paper: 'off', guard: null } // off since Friday
  // ...and the SENSEX Wing Straddle has no strategy row at all.
  const plan = pbDayPlan(MON19, rows, {}, { switches })

  assert.deepEqual(symbolPlan(plan, 'NIFTY').ensure.map((e) => [e.plan.tag, e.why]), [[niftyAgg, 'switched-off']])
  assert.deepEqual(plan.playbook.ensure.map((e) => [e.plan.tag, e.why]), [[wingS, 'switched-off']])
  assert.deepEqual([...plan.hold.ensure], [], 'a week-long book switched off on an earlier day was switched on')
  for (const tag of [trendS, revN]) assert.ok(plan.playbook.onTarget.some((h) => h.row.tag === tag), `${tag} not on target`)
  assert.ok(plan.hold.onTarget.some((h) => h.row.tag === pairAgg))
  // The guard's is the desk working; the other two are somebody's decision, named.
  assert.ok(!plan.anomalies.some((a) => a.includes(trendS)), "the day guard's switch-off is in ATTENTION")
  for (const tag of [revN, pairAgg]) {
    assert.ok(
      plan.anomalies.some((a) => a.includes(tag) && /RUNNING/.test(a) && /switch is OFF/.test(a) && /Strategies page/.test(a)),
      `${tag} runs switched off, silently`,
    )
  }
  assert.equal(plan.anomalies.length, 2)
  // Covered all the same: today's NIFTY books are all on the desk — four on
  // its expiry Monday, the 0-DTE zero book among them.
  assert.equal(symbolPlan(plan, 'NIFTY').ensure.length + symbolPlan(plan, 'NIFTY').onTarget.length, 4)

  // On the wire: the same three calls as any book the roll finishes — the
  // create converges, the start is a no-op on a running row, the PATCH flips
  // it — in the family's own place; nothing for the other three.
  const rec = recorder()
  const done = await applyRoll(plan, { request: rec.request })
  assert.deepEqual(rec.calls, [
    `POST ${REG}`,
    `POST ${REG}/${niftyAgg}/start`,
    `PATCH ${STRAT}/${niftyAgg}`,
    `POST ${REG}`,
    `POST ${REG}/${wingS}/start`,
    `PATCH ${STRAT}/${wingS}`,
  ])
  assert.deepEqual(done, { created: 2, started: 2, switchedOn: 2, stopped: 0, erased: 0, settled: 0, refused: [] })

  // The dry run says so, with the three calls it will send.
  const lines: string[] = []
  const original = console.log
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '))
  }
  try {
    roll.printPlan(plan)
  } finally {
    console.log = original
  }
  const text = lines.join('\n')
  assert.match(text, new RegExp(`SWITCH ON\\s+${niftyAgg}`))
  assert.match(text, /RUNNING with its paper switch off and never marked/)
  assert.match(text, new RegExp(`PATCH ${STRAT}/${wingS}`))
  assert.ok(text.indexOf('ATTENTION') >= 0 && text.lastIndexOf(revN) > text.indexOf('ATTENTION'), 'not named in ATTENTION')

  // A row read without its marks is never taken for one that never marked:
  // named, not switched.
  const unreadMarks = rows.map((r) =>
    r.tag === niftyAgg ? (Object.fromEntries(Object.entries(r).filter(([k]) => k !== 'lastMarkAt')) as unknown as RegistryRow) : r,
  )
  const unread = pbDayPlan(MON19, unreadMarks, {}, { switches })
  assert.deepEqual([...symbolPlan(unread, 'NIFTY').ensure], [])
  assert.ok(unread.anomalies.some((a) => a.includes(niftyAgg) && /cannot read whether it has ever marked/.test(a)))

  // Planned without the switches (every other test here), nothing changes.
  assert.deepEqual([...createdBooks(pbDayPlan(MON19, rows))], [])
})

test('printPlan and the summary name the playbook books on their own — created, retired, left alone', () => {
  const lines: string[] = []
  const original = console.log
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '))
  }
  const [trendN, wingN] = pbRowsFor(FRI16) as [RegistryRow, RegistryRow]
  const plan = pbDayPlan(MON19, [trendN, wingN], { [wingN.tag]: 2 })
  try {
    roll.printPlan(plan)
  } finally {
    console.log = original
  }
  const text = lines.join('\n')
  assert.match(text, /PLAYBOOK BOOKS/)
  assert.match(text, new RegExp(`CREATE \\+ START \\+ SWITCH ON\\s+${pbTag('NIFTY', 'pb-trend-drive', MON19)}`))
  assert.match(text, new RegExp(`STOP \\+ ERASE\\s+${trendN.tag}`))
  assert.match(text, new RegExp(`LEFT RUNNING\\s+${wingN.tag}`))
  // The section comes after the hold pairs, and before the totals.
  assert.ok(text.indexOf('PLAYBOOK BOOKS') > text.indexOf('HOLD-TO-EXPIRY BOOKS'))
  const summary = roll.playbookSummary(plan)
  assert.match(summary, /^playbook: 6 to create\/start\/switch on/)
  assert.match(summary, new RegExp(`1 to retire \\(${trendN.tag}\\)`))
  assert.match(summary, new RegExp(`1 from an earlier day LEFT ALONE \\(${wingN.tag}\\)`))
  assert.ok(text.includes(summary), 'the summary line is printed')
  assert.match(roll.playbookSummary(pbDayPlan(MON19, [trendN], {}, { knows: () => false })), /GATED/)
  assert.match(roll.HELP, /playbook/i)
  assert.match(roll.HELP, /2026-10-21/)
})

/**
 * SERIES_OFF (2026-10-30): `main` drops the switched-off series from each
 * family's targets (`withoutSeriesOff`) and hands their names to `planRoll`.
 * The ROWS are never filtered — a switched-off series' row of an earlier day
 * is just not a target, and its family retires it like any other.
 */
const FRI23 = '2026-10-23'

/** The roll exactly as `main` plans it: every family in full, then the switched-off series dropped. */
function offDayPlan(
  todayIst: string,
  rows: readonly RegistryRow[],
  held: Readonly<Record<string, number | null>> = {},
  expired: Readonly<Record<string, number | null>> = {},
): RollPlan {
  const expiries = books.expiriesFrom(PB_MASTER, todayIst)
  const daily = books.planBooks(expiries, todayIst)
  const hold = books.planHoldBooks(expiries, todayIst)
  const { playbookTargets: playbooks, playbookBlocked } = roll.planPlaybookTargets(PB_MASTER, todayIst, () => true)
  return planRoll({
    targets: books.withoutSeriesOff(daily),
    holdTargets: books.withoutSeriesOff(hold),
    playbookTargets: books.withoutSeriesOff(playbooks),
    playbookBlocked,
    switchedOff: books.seriesSwitchedOff([...daily, ...hold, ...playbooks]),
    rows,
    heldByTag: { ...allFlat(rows), ...held },
    expiredByTag: expired,
    todayIst,
  })
}

const isOff = (r: { series?: string }): boolean => books.SERIES_OFF.includes(r.series ?? '')

/** Every line `fn` printed, joined. */
function printed(fn: () => void): string {
  const lines: string[] = []
  const original = console.log
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '))
  }
  try {
    fn()
  } finally {
    console.log = original
  }
  return lines.join('\n')
}

test("SERIES_OFF — Fri 2026-10-23: Thursday's flat rows of the switched-off series are stopped and erased like any other, and none of those series is created", async () => {
  // Thursday's whole desk, created before the switch-off: every series on.
  const ex22 = books.expiriesFrom(PB_MASTER, THU22)
  const thursday = [...rowsFor(THU22, ex22), ...holdRowsFor(THU22, ex22), ...pbRowsFor(THU22)]
  const off = thursday.filter(isOff)
  assert.deepEqual(off.map((r) => r.tag), [
    'SENSEX-delta-lean-conservative-2026-10-22',
    'SENSEX-delta-lean-zero-2026-10-22',
    'NIFTY-pb-trend-drive-2026-10-22',
    'NIFTY-pb-wing-straddle-2026-10-22',
    'SENSEX-pb-trend-drive-2026-10-22',
    'SENSEX-pb-wing-straddle-2026-10-22',
    'SENSEX-pb-reversal-2026-10-22',
    'SENSEX-pb-expiry-drive-2026-10-22',
    'SENSEX-pb-expiry-theta-2026-10-22',
    'SENSEX-pb-expiry-gamma-2026-10-22',
  ])

  const plan = offDayPlan(FRI23, thursday)
  for (const r of off) {
    const e = books.isPlaybook(r) ? pbRetireFor(plan, r.tag) : retireFor(plan, r.tag)
    assert.equal(e.action, 'erase', r.tag)
    assert.ok(stoppedTags(plan).includes(r.tag), `${r.tag} is not stopped first`)
    assert.ok(erasedTags(plan).includes(r.tag), `${r.tag} is not erased`)
  }
  // Fewer targets on SENSEX is not a fault: aggressive alone covers its retire.
  assert.deepEqual(symbolPlan(plan, 'SENSEX').ensure.map((e) => e.plan.tag), [`SENSEX-delta-lean-aggressive-${FRI23}`])
  assert.ok(!plan.symbols.some((s) => s.retire.some((e) => e.action === 'blocked')), 'a retire was withheld')
  assert.deepEqual([...plan.alarms], [])
  assert.deepEqual([...plan.anomalies], [], 'a switch-off is in ATTENTION, so the run would exit 1 every morning')

  // Created: the kept series only — NIFTY's three and SENSEX aggressive, the
  // new SENSEX hold pair, and NIFTY's Reversal.
  assert.deepEqual(createdBooks(plan).map((b) => b.tag), [
    `NIFTY-delta-lean-aggressive-${FRI23}`,
    `NIFTY-delta-lean-conservative-${FRI23}`,
    `NIFTY-delta-lean-zero-${FRI23}`,
    `SENSEX-delta-lean-aggressive-${FRI23}`,
    'SENSEX-delta-lean-hold-aggressive-2026-10-29',
    'SENSEX-delta-lean-hold-conservative-2026-10-29',
    `NIFTY-pb-reversal-${FRI23}`,
  ])
  assert.deepEqual([...plan.switchedOff], [
    'SENSEX-delta-lean-conservative',
    'SENSEX-delta-lean-zero',
    'NIFTY-pb-trend-drive',
    'NIFTY-pb-wing-straddle',
    'SENSEX-pb-trend-drive',
    'SENSEX-pb-wing-straddle',
    'SENSEX-pb-reversal',
  ])

  // On the wire: every switched-off row DELETEd, no switched-off series of today touched.
  const rec = recorder()
  const done = await applyRoll(plan, { request: rec.request })
  const offToday = plan.switchedOff.map((s) => `${s}-${FRI23}`)
  assert.ok(!rec.calls.some((c) => offToday.some((t) => c.includes(t))), 'a switched-off series of today went on the wire')
  for (const r of off) assert.ok(rec.calls.includes(`DELETE ${REG}/${r.tag}?mode=paper`), r.tag)
  assert.equal(done.created, 7)
  assert.deepEqual([...done.refused], [])

  // The log says why fewer books were created — one line, not ATTENTION.
  const text = printed(() => roll.printPlan(plan))
  const line = roll.switchedOffSummary(plan)
  assert.ok(line !== null)
  assert.ok(line.startsWith('switched off (SERIES_OFF): SENSEX-delta-lean-conservative, SENSEX-delta-lean-zero, NIFTY-pb-trend-drive,'), line)
  assert.ok(text.includes(line), 'the switched-off line is not printed')
  assert.ok(!text.includes('ATTENTION'))
})

test("SERIES_OFF — a switched-off series' row that still HOLDS legs gets the same ALARM as any other; one whose legs all expired is settled, then erased", () => {
  const ex22 = books.expiriesFrom(PB_MASTER, THU22)
  const consS = 'SENSEX-delta-lean-conservative-2026-10-22'
  const trendS = 'SENSEX-pb-trend-drive-2026-10-22'
  const wingN = 'NIFTY-pb-wing-straddle-2026-10-22'
  const gammaS = 'SENSEX-pb-expiry-gamma-2026-10-22'
  const rows = [...rowsFor(THU22, ex22), ...pbRowsFor(THU22)].map((r) =>
    r.tag === wingN ? { ...r, desired: 'stopped', actual: 'stopped' } : r,
  )
  const held = { [consS]: 2, [trendS]: 1, [wingN]: 3, [gammaS]: 1 }
  // The 0-DTE gamma leg is on Thursday's contract, dead by Friday.
  const expired = { [gammaS]: 1 }
  const plan = offDayPlan(FRI23, rows, held, expired)

  assert.equal(retireFor(plan, consS).action, 'holds-legs')
  assert.equal(pbRetireFor(plan, trendS).action, 'holds-legs')
  assert.equal(pbRetireFor(plan, wingN).action, 'stopped-holds-legs')
  assert.equal(pbRetireFor(plan, gammaS).action, 'settle-then-erase')
  const alarm = (tag: string): string => plan.alarms.find((a) => a.includes(tag)) ?? ''
  assert.match(alarm(consS), /HOLDS 2 open leg.*NOT STOPPED/)
  assert.match(alarm(trendS), /NOT STOPPED/)
  assert.match(alarm(wingN), /ALREADY STOPPED/)
  assert.equal(plan.alarms.length, 3)
  for (const tag of [consS, trendS, wingN]) {
    assert.ok(!stoppedTags(plan).includes(tag) && !erasedTags(plan).includes(tag), `${tag} was retired holding legs`)
  }
  assert.ok(roll.settledTags(plan).includes(gammaS) && erasedTags(plan).includes(gammaS))

  // The list never decides a row's fate: every one of Thursday's rows gets
  // exactly what it gets with nothing switched off.
  const unfiltered = pbDayPlan(FRI23, rows, held, { expired })
  const fate = (p: RollPlan): Map<string, RetireAction> =>
    new Map([...p.symbols.flatMap((s) => s.retire), ...p.playbook.retire].map((e) => [e.row.tag, e.action]))
  assert.deepEqual(fate(plan), fate(unfiltered))
  assert.deepEqual(plan.alarms, unfiltered.alarms)
  assert.deepEqual(plan.anomalies, unfiltered.anomalies)
})

test("SERIES_OFF — Tue 2026-10-27, NIFTY's expiry: NIFTY's Reversal is the one playbook book created; its 0-DTE zero book still is", () => {
  const TUE27 = '2026-10-27'
  const plan = offDayPlan(TUE27, [])
  assert.deepEqual(plan.playbook.ensure.map((e) => e.plan.tag), [`NIFTY-pb-reversal-${TUE27}`])
  assert.ok(createdBooks(plan).some((b) => b.tag === `NIFTY-delta-lean-zero-0dte-${TUE27}`))
  assert.ok(createdBooks(plan).every((b) => !isOff(b)))
  for (const s of ['NIFTY-pb-expiry-drive', 'NIFTY-pb-expiry-theta', 'NIFTY-pb-expiry-gamma', 'SENSEX-pb-reversal']) {
    assert.ok(plan.switchedOff.includes(s), s)
  }
  assert.deepEqual([...plan.anomalies], [])
})

test('SERIES_OFF — a plan that creates a series it names as switched off is refused; with none named the plan says nothing', () => {
  // `main` filters before it plans. Targets that still carry a switched-off
  // series would make the log line a lie.
  assert.throws(
    () => planRoll({ targets: fourFor(FRI23), rows: [], heldByTag: {}, todayIst: FRI23, switchedOff: ['SENSEX-delta-lean-conservative'] }),
    /SENSEX-delta-lean-conservative-2026-10-23.*switched off \(SERIES_OFF\).*not filtered/,
  )
  const plain = planRoll({ targets: fourFor(FRI23), rows: [], heldByTag: {}, todayIst: FRI23 })
  assert.deepEqual([...plain.switchedOff], [])
  assert.equal(roll.switchedOffSummary(plain), null)
  assert.ok(!printed(() => roll.printPlan(plain)).includes('switched off'))
  assert.match(roll.HELP, /SERIES_OFF/)
})

// -------------------------------------------------- against a real registry

const URL_MONGO =
  process.env['DESK_TEST_MONGO'] ?? 'mongodb://127.0.0.1:27017/algomaker_dx_delta_lean_roll_test'
const TOKEN = 'machine-token-do-not-use-in-prod'
/** A real instant: 2026-09-22 08:45 IST, a Tuesday — the first daily run. */
const FIRST_RUN = Date.UTC(2026, 8, 22, 3, 15)
let NOW = FIRST_RUN

let handle: MongoHandle | null = null
let store: DeskStore
let server: Server | null = null
let base = ''
let available = false
/**
 * The registry start/stop routes this suite drives — 100 of them across the
 * `itMongo` tests below — call `notifySupervisor` on success. Without this,
 * every one of those nudges reached the live desk-supervisor. See
 * `./nudge-sink.ts`.
 */
let sink: NudgeSink | null = null

function itMongo(name: string, fn: () => Promise<void>): void {
  test(name, async (t) => {
    if (!available) {
      skipUnlessMongo(t)
      return
    }
    await fn()
  })
}

/** The same `request` the script builds in `main`, pointed at the test server. */
const request: Request = (method, path, body) => books.requestJson(base, method, path, body, TOKEN)

function recordingRequest(calls: string[], inner: Request = request): Request {
  return async (method, path, body) => {
    calls.push(`${method} ${path}`)
    return await inner(method, path, body)
  }
}

/** The registry read and the leg read the script's `main` performs, verbatim. */
async function readDesk(todayIst = TODAY): Promise<{
  rows: RegistryRow[]
  heldByTag: Map<string, number | null>
  expiredByTag: Map<string, number | null>
}> {
  const rows = (await store.listBooks('paper')) as unknown as RegistryRow[]
  const { heldByTag, expiredByTag } = await roll.readHoldings(rows, (tag) => store.bookDoc(tag, 'paper'), todayIst)
  return { rows, heldByTag, expiredByTag }
}

/**
 * One roll against the test server. `hold: true` plans the hold-to-expiry
 * pairs exactly as `main` does (`planHoldBooks` off the same expiries);
 * `playbook` plans the playbook family off that master, through the same
 * gate `main` uses. The daily-book tests below leave both off, so their
 * counts stay the four's. The paper switches are always read, as `main`
 * reads them; `request`, when given, answers in place of the test server
 * (and is recorded all the same).
 */
async function runRoll(
  todayIst: string,
  expiries: Expiries,
  calls: string[] = [],
  opts: { hold?: boolean; playbook?: MasterLike; request?: Request } = {},
): Promise<{ plan: RollPlan; done: Done }> {
  const targets = books.planBooks(expiries, todayIst)
  const holdTargets = opts.hold === true ? books.planHoldBooks(expiries, todayIst) : []
  const { playbookTargets, playbookBlocked } =
    opts.playbook === undefined
      ? { playbookTargets: [], playbookBlocked: null }
      : roll.planPlaybookTargets(opts.playbook, todayIst)
  const { rows, heldByTag, expiredByTag } = await readDesk(todayIst)
  const switchByTag = roll.readSwitches(await store.listStrategies())
  const plan = planRoll({
    targets,
    holdTargets,
    playbookTargets,
    playbookBlocked,
    rows,
    heldByTag,
    expiredByTag,
    switchByTag,
    todayIst,
  })
  const done = await applyRoll(plan, { request: recordingRequest(calls, opts.request) })
  return { plan, done }
}

/** Register and start a set of bodies, as the sibling's first two calls do. */
async function standUp(bodies: readonly BookPlan[]): Promise<void> {
  for (const b of bodies) {
    const created = await request('POST', REG, b)
    assert.equal(created.status, 201, `${b.tag}: ${created.text}`)
    const started = await request('POST', `${REG}/${b.tag}/start`, { mode: 'paper' })
    assert.equal(started.status, 200, `${b.tag}: ${started.text}`)
  }
}

/**
 * The four legacy rows as the box has them: registered and started under the
 * weekly tags, then backdated — `createdAt` is server-set (`books.ts`), so it
 * is written directly.
 */
async function standUpLegacy(): Promise<void> {
  await standUp(legacyBodies())
  for (const tag of LEGACY_TAGS) {
    await handle!.db
      .collection(COLLECTIONS.booksRegistry)
      .updateOne({ tag, mode: 'paper' }, { $set: { createdAt: LEGACY_CREATED_AT } })
  }
}

const LEG = {
  deskTag: 'PE81000#lean',
  instrument: {
    tradingsymbol: 'SENSEX26917810000PE',
    instrumentToken: 274762245,
    lotSize: 20,
    tickSize: 0.05,
    exchange: 'BFO' as const,
  },
  underlying: 'SENSEX',
  expiry: '2026-09-17',
  strike: 81000,
  type: 'PE' as const,
  side: 'Sell' as const,
  qty: -20,
  entryPrice: 140,
  openedTs: FIRST_RUN,
}

before(async () => {
  try {
    handle = await connectMongo(URL_MONGO, { serverSelectionTimeoutMS: 2500 })
  } catch {
    available = false
    return
  }
  store = new DeskStore(handle.db)
  await store.ensureIndexes()
  const apiDeps = {
    db: handle.db,
    store,
    // The one service method the strategy PATCH reaches for — the same cast
    // style as `audit.test.ts`; nothing else on `service` is touched by the
    // routes this suite drives.
    service: {
      patchStrategy: (tag: string, patch: unknown, expected?: number) =>
        store.patchStrategy(tag, patch as Parameters<DeskStore['patchStrategy']>[1], NOW, expected),
      // ...and the one the orphan prune's mode removal reaches for.
      removeStrategyMode: (tag: string, mode: 'paper' | 'live') => store.removeStrategyMode(tag, mode, NOW),
    } as unknown as ApiDeps['service'],
    // settle-expired asks the master for the underlying's spot token. An empty
    // one answers none, so a settlement here prices off the book's own marks.
    master: { current: () => new OptionMaster([]) },
    log: () => {},
    now: () => NOW,
    gate: bearerGate(TOKEN),
  } as unknown as Parameters<typeof booksRoutes>[0] & Parameters<typeof deskRoutes>[0]
  server = createBridgeServer({
    gate: bearerGate(TOKEN),
    routes: [booksRoutes(apiDeps), deskRoutes(apiDeps)],
  })
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`
  sink = await startNudgeSink()
  available = true
})

after(async () => {
  if (server !== null) await new Promise<void>((r) => server!.close(() => r()))
  if (sink !== null) await sink.close()
  if (handle !== null) await handle.close()
})

beforeEach(async () => {
  if (!available) return
  for (const c of [...Object.values(COLLECTIONS), 'desk-fills', 'desk-book-marks', 'desk-marks', 'desk-audit-log']) {
    await handle!.db.collection(c).deleteMany({})
  }
  await store.ensureIndexes()
  NOW = FIRST_RUN
  if (sink !== null) sink.nudges.length = 0
})

async function switchOn(tag: string): Promise<boolean> {
  const row = await store.loadStrategy(tag)
  assert.ok(row !== null, `no strategy row for ${tag}`)
  return isOn(row.modes, 'paper')
}

itMongo('the dial that says "delta-lean" survives the registry round trip, and so does createdAt', async () => {
  // `bookFromDoc` once dropped BOOLEAN dials on the way back out, so a book
  // could be registered delta-lean and read back looking like anything else.
  // Every judgement this script makes rests on that dial being readable —
  // and now on `createdAt` too, which is the day the erase cutoff compares.
  await standUp(TARGETS)
  const { rows } = await readDesk()
  assert.equal(rows.length, TODAYS.length)
  for (const row of rows) {
    assert.equal(roll.isDeltaLean(row), true, `${row.tag} did not read as delta-lean`)
    assert.equal(typeof row.createdAt, 'number')
    assert.equal(books.istDate(row.createdAt), TODAY)
  }
})

itMongo("first daily run: today's four created, started and switched on; the four legacy rows are stopped then erased, except the one still holding a leg", async () => {
  await standUpLegacy()
  // One legacy SENSEX book is still holding a short put at 08:45 — its
  // expiry-day flatten did not complete.
  await store.saveBook({ tag: LEGACY_SENSEX_AGG, mode: 'paper', symbol: 'SENSEX', expiry: '2026-09-17' }, [LEG], NOW)

  const { heldByTag } = await readDesk()
  assert.equal(heldByTag.get(LEGACY_SENSEX_AGG), 1, 'the leg is read off desk-books under {tag, mode}')
  assert.equal(heldByTag.get(LEGACY_TAGS[3]), 0, 'a book with no document at all has never traded')

  const calls: string[] = []
  const { plan, done } = await runRoll(TODAY, LIVE, calls)
  // Its put expired on the 17th, so the roll asks the server to SETTLE it —
  // and with no close for SENSEX on the 17th on file, the server refuses
  // (409) and writes nothing. The book is then neither stopped nor erased:
  // a settlement price is never guessed, and a holder is never stopped.
  assert.equal(retireFor(plan, LEGACY_SENSEX_AGG).action, 'settle-then-erase')
  assert.deepEqual({ ...done, refused: done.refused.length }, { created: 7, started: 7, switchedOn: 7, stopped: 3, erased: 3, settled: 0, refused: 1 })
  assert.match(done.refused[0] ?? '', new RegExp(`${LEGACY_SENSEX_AGG}: settle-expired refused \\(HTTP 409\\)`))
  assert.ok(!calls.includes(`POST ${REG}/${LEGACY_SENSEX_AGG}/stop`))
  assert.equal((await store.bookDoc(LEGACY_SENSEX_AGG, 'paper'))?.legs.length, 1, 'nothing was settled')

  // Today's books: running, paper, switched ON, day guard armed.
  for (const tag of TODAYS) {
    const row = await store.getBook(tag, 'paper')
    assert.ok(row !== null, `${tag} was not registered`)
    assert.equal(row.desired, 'running')
    assert.equal(row.mode, 'paper')
    assert.equal(await switchOn(tag), true, `${tag} was born switched off`)
    const strategy = await store.loadStrategy(tag)
    assert.ok(strategy !== null)
    assert.equal(isArmed(strategy), true, `${tag}'s day guard is not armed`)
  }
  assert.equal((await store.getBook(SENSEX_AGG, 'paper'))?.expiry, '2026-09-24')

  // The three erased: registry row gone, desk-books doc gone, switch removed.
  for (const tag of [LEGACY_TAGS[0], LEGACY_TAGS[1], LEGACY_TAGS[3]]) {
    assert.equal(await store.getBook(tag, 'paper'), null, `${tag} still registered`)
    assert.equal(await store.bookDoc(tag, 'paper'), null, `${tag} still has a desk-books document`)
    // The whole row, not just the paper mode: an external row added to
    // nothing is an orphan, and the roll would leave four a day.
    assert.equal(await store.loadStrategy(tag), null, `${tag} still has a strategy row`)
  }
  // The holder: untouched, still running, still registered.
  const holder = await store.getBook(LEGACY_SENSEX_AGG, 'paper')
  assert.equal(holder?.desired, 'running')
  assert.equal((await store.listBooks('live')).length, 0, 'nothing reached the live registry')

  // Every DELETE after every stop after every start, on the real server.
  const idx = (pred: (c: string) => boolean): number[] => calls.map((c, i) => (pred(c) ? i : -1)).filter((i) => i >= 0)
  const starts = idx((c) => c.endsWith('/start'))
  const stops = idx((c) => c.endsWith('/stop'))
  const deletes = idx((c) => c.startsWith('DELETE'))
  assert.equal(deletes.length, 3)
  assert.ok(Math.min(...stops) > Math.max(...starts))
  assert.ok(Math.min(...deletes) > Math.max(...stops))
  assert.ok(!calls.some((c) => /flatten|purge/.test(c)))

  // Load-bearing, not just a silencer (see ./nudge-sink.ts): every registry
  // start and stop nudges the supervisor with kind registry — the four
  // `standUpLegacy` starts plus this roll's own starts and stops.
  assert.ok(sink !== null)
  assert.equal(sink.nudges.length, 4 + starts.length + stops.length)
  assert.ok(sink.nudges.every((n) => n['kind'] === 'registry'))
})

itMongo('erase keeps the history: fills, order events and decisions survive a purge:false erase', async () => {
  await standUpLegacy()
  const tag = LEGACY_TAGS[1]
  const db = handle!.db
  // A closed round trip in the decisions journal (net zero, so the server's
  // fills guard reads flat), a gateway fill row, and an order event.
  await db.collection(COLLECTIONS.decisions).insertOne({
    tag,
    mode: 'paper',
    createdAt: nineAmIst('2026-09-16') + 3_600_000,
    fills: [
      { tradingsymbol: 'NIFTY2692224900PE', side: 'Sell', qty: 65, price: 100, ts: nineAmIst('2026-09-16') + 3_600_000 },
      { tradingsymbol: 'NIFTY2692224900PE', side: 'Buy', qty: 65, price: 90, ts: nineAmIst('2026-09-16') + 7_200_000 },
    ],
  })
  await db.collection('desk-fills').insertOne({
    clientOrderId: 'x-1',
    tag,
    mode: 'paper',
    tradingsymbol: 'NIFTY2692224900PE',
    side: 'Sell',
    filledQty: 65,
    status: 'FILLED',
    ts: nineAmIst('2026-09-16') + 3_600_000,
  })
  await db.collection(COLLECTIONS.orderEvents).insertOne({ tag, mode: 'paper', ts: nineAmIst('2026-09-16'), kind: 'PLANNED' })

  const { done } = await runRoll(TODAY, LIVE)
  assert.equal(done.erased, 4)
  assert.deepEqual([...done.refused], [])
  assert.equal(await store.getBook(tag, 'paper'), null)
  assert.equal(await db.collection(COLLECTIONS.decisions).countDocuments({ tag }), 1, 'decisions survive')
  assert.equal(await db.collection('desk-fills').countDocuments({ tag }), 1, 'fills survive')
  assert.equal(await db.collection(COLLECTIONS.orderEvents).countDocuments({ tag }), 1, 'order events survive')
})

itMongo('a legacy row that is flat in desk-books but not by its fills is stopped, still registered, and its 409 is in refused', async () => {
  await standUpLegacy()
  const tag = LEGACY_NIFTY_AGG
  // The server's DELETE guard rebuilds the position from the decisions
  // journal's fills, not from `desk-books`. One open short, never closed.
  await handle!.db.collection(COLLECTIONS.decisions).insertOne({
    tag,
    mode: 'paper',
    createdAt: nineAmIst('2026-09-16'),
    fills: [{ tradingsymbol: 'NIFTY2692224900PE', side: 'Sell', qty: 65, price: 100, ts: nineAmIst('2026-09-16') }],
  })
  await store.saveBook({ tag, mode: 'paper', symbol: 'NIFTY', expiry: '2026-09-22' }, [], NOW)

  const { done } = await runRoll(TODAY, LIVE)
  assert.equal(done.stopped, 4)
  assert.equal(done.erased, 3)
  assert.equal(done.refused.length, 1)
  assert.match(done.refused[0] ?? '', new RegExp(tag))
  assert.match(done.refused[0] ?? '', /still holds/)
  const row = await store.getBook(tag, 'paper')
  assert.ok(row !== null, 'the refused row is still registered')
  assert.equal(row.desired, 'stopped')
})

itMongo('a legacy row with no createdAt at all is stopped, left registered, and named as an anomaly', async () => {
  // The real shape of the defect: a registry document with no `createdAt`
  // field reads back through `bookFromDoc` as `createdAt: 0`. 0 is 1970 in
  // IST, which is before every cutoff, so a naive guard would erase the row
  // — and its lastReason snapshot with it — on the strength of a field it
  // never had. It must be stopped like any other old flat row and then LEFT.
  await standUpLegacy()
  const tag = LEGACY_NIFTY_AGG
  await handle!.db.collection(COLLECTIONS.booksRegistry).updateOne({ tag, mode: 'paper' }, { $unset: { createdAt: '' } })
  const { rows } = await readDesk()
  assert.equal(rows.find((r) => r.tag === tag)?.createdAt, 0, 'bookFromDoc answers 0 for a missing createdAt')

  const { plan, done } = await runRoll(TODAY, LIVE)
  assert.equal(retireFor(plan, tag).action, 'stop')
  assert.equal(retireFor(plan, tag).day, null)
  assert.ok(plan.anomalies.some((a) => a.includes(tag) && /createdAt/.test(a) && /never erased/.test(a)))
  assert.deepEqual(done, { created: 7, started: 7, switchedOn: 7, stopped: 4, erased: 3, settled: 0, refused: [] })
  const row = await store.getBook(tag, 'paper')
  assert.ok(row !== null, 'the row without a createdAt is still registered')
  assert.equal(row.desired, 'stopped')
  for (const other of [LEGACY_TAGS[1], LEGACY_TAGS[2], LEGACY_TAGS[3]]) {
    assert.equal(await store.getBook(other, 'paper'), null, `${other} should still be erased`)
  }
})

itMongo('a second run a second later issues no calls at all', async () => {
  await standUpLegacy()
  await runRoll(TODAY, LIVE)

  // Re-read the world exactly as a fresh process would, one second later.
  NOW += 1_000
  const calls: string[] = []
  const { plan, done } = await runRoll(TODAY, LIVE, calls)
  assert.deepEqual([...createdBooks(plan)], [], 'nothing left to create')
  assert.deepEqual([...stoppedTags(plan)], [], 'nothing left to stop')
  assert.deepEqual([...erasedTags(plan)], [], 'nothing left to erase')
  assert.deepEqual([...plan.alarms], [])
  assert.deepEqual([...plan.anomalies], [])
  assert.deepEqual(done, { created: 0, started: 0, switchedOn: 0, stopped: 0, erased: 0, settled: 0, refused: [] })
  assert.deepEqual(calls, [], 'a converged desk is not written to')
  assert.deepEqual(
    (await store.listBooks('paper')).map((r) => r.tag).sort(),
    [...TODAYS].sort(),
    "exactly today's books remain",
  )
})

itMongo("the next morning: yesterday's four are stopped and erased in the same run — only today's four remain", async () => {
  const wed = '2026-09-23'
  const thu = '2026-09-24'
  const wedExpiries: Expiries = { nifty: '2026-09-29', sensex: '2026-09-24' }
  const thuExpiries: Expiries = wedExpiries
  const todays = (day: string, ex: Expiries): string[] => books.planBooks(ex, day).map((b) => b.tag).sort()

  await runRoll(TODAY, LIVE)

  NOW = Date.UTC(2026, 8, 23, 3, 15)
  const calls2: string[] = []
  const run2 = await runRoll(wed, wedExpiries, calls2)
  // Wednesday's six (no expiry); Tuesday's seven, NIFTY's 0-DTE book with them.
  assert.deepEqual(run2.done, { created: 6, started: 6, switchedOn: 6, stopped: 7, erased: 7, settled: 0, refused: [] })
  for (const tag of TODAYS) {
    assert.equal(await store.getBook(tag, 'paper'), null, `${tag} should be erased on Wednesday`)
    const stop = calls2.indexOf(`POST ${REG}/${tag}/stop`)
    const del = calls2.indexOf(`DELETE ${REG}/${tag}?mode=paper`)
    assert.ok(stop >= 0 && del > stop, `${tag}: stopped at ${stop}, then DELETEd at ${del}`)
  }
  assert.deepEqual((await store.listBooks('paper')).map((r) => r.tag).sort(), todays(wed, wedExpiries))

  NOW = Date.UTC(2026, 8, 24, 3, 15)
  const run3 = await runRoll(thu, thuExpiries)
  // Thursday is SENSEX's expiry: seven, its 0-DTE book the seventh.
  assert.deepEqual(run3.done, { created: 7, started: 7, switchedOn: 7, stopped: 6, erased: 6, settled: 0, refused: [] })
  for (const b of books.planBooks(wedExpiries, wed)) {
    assert.equal(await store.getBook(b.tag, 'paper'), null, `${b.tag} should be erased on Thursday`)
  }
  // D6: Thursday's SENSEX book holds Thursday's own contract.
  const thuSensex = await store.getBook(`SENSEX-delta-lean-aggressive-${thu}`, 'paper')
  assert.equal(thuSensex?.expiry, '2026-09-24')
  assert.equal(thuSensex?.desired, 'running')
  assert.deepEqual((await store.listBooks('paper')).map((r) => r.tag).sort(), todays(thu, thuExpiries))
})

itMongo('a half-finished roll converges: the created-but-not-started books are started and switched on', async () => {
  // The failure this repairs: a run that registered today's books and died
  // before starting them leaves rows that exist, are stopped, and hold nothing
  // — while the legacy books still run. Re-running must finish the job rather
  // than refuse with a 409 or, worse, retire the old ones anyway.
  await standUpLegacy()
  for (const b of TARGETS) assert.equal((await request('POST', REG, b)).status, 201)

  const { rows, heldByTag } = await readDesk()
  const plan = planRoll({ targets: TARGETS, rows, heldByTag, todayIst: TODAY })
  assert.deepEqual(
    plan.symbols.flatMap((s) => s.ensure).map((e) => e.why),
    TODAYS.map(() => 'stopped-but-needed'),
  )
  const done = await applyRoll(plan, { request })
  assert.deepEqual(done, { created: 7, started: 7, switchedOn: 7, stopped: 4, erased: 4, settled: 0, refused: [] })
  for (const tag of TODAYS) {
    assert.equal((await store.getBook(tag, 'paper'))?.desired, 'running')
    assert.equal(await switchOn(tag), true)
  }
  for (const tag of LEGACY_TAGS) assert.equal(await store.getBook(tag, 'paper'), null)
})

itMongo("a book stopped by hand on today's tag is left stopped, and its switch untouched, when nothing needs retiring", async () => {
  // With nothing to retire, a stopped book on today's tag is a decision
  // somebody made, and 08:45 is not the moment to reverse it — nor to flip
  // its switch, which is why the switch stays exactly as registration left it.
  await standUp(TARGETS)
  assert.equal((await request('POST', `${REG}/${SENSEX_AGG}/stop`, { mode: 'paper' })).status, 200)
  const before = await switchOn(SENSEX_AGG)

  const calls: string[] = []
  const { plan, done } = await runRoll(TODAY, LIVE, calls)
  assert.deepEqual([...createdBooks(plan)], [])
  assert.deepEqual(symbolPlan(plan, 'SENSEX').leftStopped.map((t) => t.row.tag), [SENSEX_AGG])
  assert.deepEqual(calls, [])
  assert.deepEqual(done, { created: 0, started: 0, switchedOn: 0, stopped: 0, erased: 0, settled: 0, refused: [] })
  assert.equal((await store.getBook(SENSEX_AGG, 'paper'))?.desired, 'stopped')
  assert.equal(await switchOn(SENSEX_AGG), before)
})

itMongo('the first hold week on a real registry: SENSEX pair on 10-06, NIFTY pair on 10-07, carried through 10-08, SENSEX pair retired on 10-09', async () => {
  const at0850 = (dateIst: string): number => {
    const [y, m, d] = dateIst.split('-').map(Number) as [number, number, number]
    return Date.UTC(y, m - 1, d, 3, 20)
  }
  const THU8 = '2026-10-08'
  const THU8_LIVE: Expiries = { nifty: '2026-10-13', sensex: '2026-10-08' }
  const touches = (calls: readonly string[], tag: string): boolean => calls.some((c) => c.includes(tag))

  // Tuesday 10-06 — NIFTY's expiry day. The daily seven (NIFTY's 0-DTE book
  // the seventh), then the SENSEX pair only.
  NOW = at0850(TUE6)
  const tue: string[] = []
  const r1 = await runRoll(TUE6, TUE6_LIVE, tue, { hold: true })
  assert.deepEqual(r1.done, { created: 9, started: 9, switchedOn: 9, stopped: 0, erased: 0, settled: 0, refused: [] })
  for (const tag of [SX_HOLD_AGG_08, SX_HOLD_CONS_08]) {
    const row = await store.getBook(tag, 'paper')
    assert.ok(row !== null, `${tag} was not registered`)
    assert.equal(row.desired, 'running')
    assert.equal(row.expiry, '2026-10-08')
    assert.equal(row.dials['dl_hold_to_expiry'], true, 'the dial did not survive the registry')
    assert.equal(books.isHold(row), true)
    assert.equal(await switchOn(tag), true, `${tag} was born switched off`)
    const strategy = await store.loadStrategy(tag)
    assert.ok(strategy !== null && isArmed(strategy), `${tag}'s day guard is not armed`)
  }
  assert.ok(!(await store.listBooks('paper')).some((r) => r.symbol === 'NIFTY' && books.isHold(r)), 'a NIFTY pair on its expiry day')

  // Wednesday 10-07. Tuesday's seven go and six come; the NIFTY 10-13 pair
  // comes; the SENSEX pair — created yesterday — is not written to at all.
  NOW = at0850(WED7)
  const wed: string[] = []
  const r2 = await runRoll(WED7, WED7_LIVE, wed, { hold: true })
  assert.deepEqual(r2.done, { created: 8, started: 8, switchedOn: 8, stopped: 7, erased: 7, settled: 0, refused: [] })
  assert.ok(!touches(wed, SX_HOLD_AGG_08) && !touches(wed, SX_HOLD_CONS_08), 'the SENSEX pair was touched on 10-07')
  for (const tag of [NF_HOLD_AGG_13, NF_HOLD_CONS_13]) {
    assert.equal((await store.getBook(tag, 'paper'))?.desired, 'running', `${tag} is not running`)
    assert.equal(await switchOn(tag), true)
  }
  assert.equal((await store.getBook(SX_HOLD_AGG_08, 'paper'))?.desired, 'running')

  // Thursday 10-08 — SENSEX's expiry day: no SENSEX pair is created, and the
  // 10-08 pair carries to the close, untouched.
  NOW = at0850(THU8)
  const thu: string[] = []
  const r3 = await runRoll(THU8, THU8_LIVE, thu, { hold: true })
  assert.equal(r3.done.created, 7, "the daily seven, SENSEX's 0-DTE book the seventh")
  assert.deepEqual(r3.plan.hold.carrying.map((h) => h.row.tag), [SX_HOLD_AGG_08, SX_HOLD_CONS_08])
  assert.ok(!thu.some((c) => c.includes('-hold-')), 'a hold book was written to on 10-08')

  // Friday 10-09: the SENSEX 10-08 pair is past its contract — stopped, then
  // DELETEd; the 10-15 pair is created; NIFTY's pair runs on.
  NOW = at0850(FRI9)
  const fri: string[] = []
  const r4 = await runRoll(FRI9, FRI9_LIVE, fri, { hold: true })
  assert.deepEqual(r4.done, { created: 8, started: 8, switchedOn: 8, stopped: 9, erased: 9, settled: 0, refused: [] })
  for (const tag of [SX_HOLD_AGG_08, SX_HOLD_CONS_08]) {
    const stop = fri.indexOf(`POST ${REG}/${tag}/stop`)
    const del = fri.indexOf(`DELETE ${REG}/${tag}?mode=paper`)
    assert.ok(stop >= 0 && del > stop, `${tag}: stopped at ${stop}, DELETEd at ${del}`)
    assert.equal(await store.getBook(tag, 'paper'), null, `${tag} is still registered`)
  }
  assert.ok(!touches(fri, NF_HOLD_AGG_13) && !touches(fri, NF_HOLD_CONS_13))
  assert.deepEqual(
    (await store.listBooks('paper')).map((r) => r.tag).sort(),
    [
      ...books.planBooks(FRI9_LIVE, FRI9).map((b) => b.tag),
      NF_HOLD_AGG_13,
      NF_HOLD_CONS_13,
      holdTag('SENSEX', 'aggressive', '2026-10-15'),
      holdTag('SENSEX', 'conservative', '2026-10-15'),
    ].sort(),
  )

  // And a second run a second later issues no calls at all.
  NOW += 1_000
  const again: string[] = []
  const r5 = await runRoll(FRI9, FRI9_LIVE, again, { hold: true })
  assert.deepEqual(again, [])
  assert.deepEqual([...r5.plan.alarms], [])
  assert.deepEqual([...r5.plan.anomalies], [])
  assert.equal((await store.listBooks('live')).length, 0, 'nothing reached the live registry')
})

itMongo('a hold pair registered this morning but never started is started and switched on by the re-run — the create converges on 200', async () => {
  NOW = Date.UTC(2026, 9, 6, 3, 20) // Tuesday 10-06, 08:50 IST
  for (const b of books.planHoldBooks(TUE6_LIVE, TUE6)) assert.equal((await request('POST', REG, b)).status, 201)

  const calls: string[] = []
  const { plan, done } = await runRoll(TUE6, TUE6_LIVE, calls, { hold: true })
  assert.deepEqual(plan.hold.ensure.map((e) => e.why), ['created-not-started', 'created-not-started'])
  assert.deepEqual([...plan.anomalies], [])
  assert.equal(done.started, 9, "NIFTY's expiry Tuesday: the daily seven and the pair")
  for (const tag of [SX_HOLD_AGG_08, SX_HOLD_CONS_08]) {
    assert.equal((await store.getBook(tag, 'paper'))?.desired, 'running', `${tag} was not started`)
    assert.equal(await switchOn(tag), true)
  }
})

/** `HH:MM` IST on an IST date, as epoch ms. */
function istMs(dateIst: string, hhmm: string): number {
  const [y, m, d] = dateIst.split('-').map(Number) as [number, number, number]
  const [hh, mm] = hhmm.split(':').map(Number) as [number, number]
  return Date.UTC(y, m - 1, d, hh, mm) - (5 * 60 + 30) * 60_000
}

itMongo('Review #3 on a real registry: a playbook book and a hold book stopped by hand after the 08:50 run are left stopped by a same-day re-run', async () => {
  // No supervisor here, so `actual` stays stopped and `lastMarkAt` 0 on every
  // row — the state of a book stopped before its first mark. What the
  // registry does record is the start and the stop: `updatedAt` moved.
  const ex19 = books.expiriesFrom(PB_MASTER, MON19)
  NOW = istMs(MON19, '08:50')
  await runRoll(MON19, ex19, [], { hold: true, playbook: PB_MASTER })
  const wingS = pbTag('SENSEX', 'pb-wing-straddle', MON19)
  const pairAgg = holdTag('SENSEX', 'aggressive', '2026-10-22')
  for (const tag of [wingS, pairAgg]) assert.equal((await store.getBook(tag, 'paper'))?.desired, 'running', tag)

  NOW = istMs(MON19, '09:40')
  for (const tag of [wingS, pairAgg]) {
    assert.equal((await request('POST', `${REG}/${tag}/stop`, { mode: 'paper' })).status, 200, tag)
  }
  const switches = { [wingS]: await switchOn(wingS), [pairAgg]: await switchOn(pairAgg) }

  NOW = istMs(MON19, '10:05')
  const calls: string[] = []
  const { plan, done } = await runRoll(MON19, ex19, calls, { hold: true, playbook: PB_MASTER })
  assert.deepEqual(calls, [], 'a book stopped by hand was written to by the re-run')
  assert.deepEqual(done, { created: 0, started: 0, switchedOn: 0, stopped: 0, erased: 0, settled: 0, refused: [] })
  assert.deepEqual(plan.playbook.leftStopped.map((h) => h.row.tag), [wingS])
  assert.deepEqual(plan.hold.leftStopped.map((h) => h.row.tag), [pairAgg])
  for (const tag of [wingS, pairAgg]) {
    assert.equal((await store.getBook(tag, 'paper'))?.desired, 'stopped', `${tag} was restarted`)
    assert.equal(await switchOn(tag), switches[tag], `${tag}'s switch was flipped`)
    assert.ok(plan.anomalies.some((a) => a.includes(tag)), `${tag} left stopped silently`)
  }
})

itMongo('Review #8 on a real registry: a switch-on that failed is finished by the advised re-run — and a book the day guard switched off is not', async () => {
  const ex19 = books.expiriesFrom(PB_MASTER, MON19)
  NOW = istMs(MON19, '08:50')
  // A switch row already on file for one of today's tags, paper OFF — what a
  // purged book leaves behind. The create adds nothing to it and lands
  // nothing ON, so the roll's PATCH is the only thing that turns it on.
  const revS = pbTag('SENSEX', 'pb-reversal', MON19)
  await store.addStrategyMode({ tag: revS, kind: 'external', label: revS }, 'paper', NOW)
  const busy: Request = async (method, path, body) =>
    method === 'PATCH' && path === `${STRAT}/${revS}`
      ? { status: 503, body: null, text: 'desk-api busy' }
      : await request(method, path, body)
  const first = await runRoll(MON19, ex19, [], { playbook: PB_MASTER, request: busy })
  assert.equal(first.done.refused.length, 1)
  assert.match(first.done.refused[0] ?? '', new RegExp(`switch on ${revS} failed`))
  assert.equal((await store.getBook(revS, 'paper'))?.desired, 'running')
  assert.equal(await switchOn(revS), false, 'the book is running with its switch off')

  // 09:05: the day guard trips another of today's books.
  NOW = istMs(MON19, '09:05')
  const trendN = pbTag('NIFTY', 'pb-trend-drive', MON19)
  const trip = await store.patchStrategy(
    trendN,
    { modes: { paper: { enabled: false } }, disabledByGuard: { paper: { day: MON19, trigger: 'stop' } } },
    NOW,
  )
  assert.ok(trip !== null && trip !== 'conflict')

  // 09:10: the re-run the message advised.
  NOW = istMs(MON19, '09:10')
  const calls: string[] = []
  const { plan, done } = await runRoll(MON19, ex19, calls, { playbook: PB_MASTER })
  assert.deepEqual(plan.playbook.ensure.map((e) => [e.plan.tag, e.why]), [[revS, 'switched-off']])
  assert.deepEqual(calls, [`POST ${REG}`, `POST ${REG}/${revS}/start`, `PATCH ${STRAT}/${revS}`])
  assert.deepEqual(done, { created: 1, started: 1, switchedOn: 1, stopped: 0, erased: 0, settled: 0, refused: [] })
  assert.equal(await switchOn(revS), true, 'the re-run left it running switched off')
  assert.equal(await switchOn(trendN), false, 'the re-run undid a day-guard trip')
  assert.deepEqual([...plan.anomalies], [], 'a guard trip is the desk working, not ATTENTION')

  // And a run after that has nothing left to do.
  NOW = istMs(MON19, '09:11')
  const again: string[] = []
  await runRoll(MON19, ex19, again, { playbook: PB_MASTER })
  assert.deepEqual(again, [])
})

itMongo('the playbook family on a real registry: six on 10-16, retired and replaced on 10-19 and 10-21, nine on 10-22 — and a second run issues no calls', async () => {
  const at0850 = (dateIst: string): number => {
    const [y, m, d] = dateIst.split('-').map(Number) as [number, number, number]
    return Date.UTC(y, m - 1, d, 3, 20)
  }
  const WED21 = '2026-10-21'
  const day = async (todayIst: string, calls: string[] = []): Promise<{ plan: RollPlan; done: Done }> => {
    NOW = at0850(todayIst)
    return await runRoll(todayIst, books.expiriesFrom(PB_MASTER, todayIst), calls, { playbook: PB_MASTER })
  }
  const tagsOf = (todayIst: string): string[] => books.planPlaybookBooks(PB_MASTER, todayIst).map((b) => b.tag)
  const desk = async (): Promise<string[]> => (await store.listBooks('paper')).map((r) => r.tag).sort()

  // Friday: the six daily books and the six playbooks, each created, started
  // and switched on.
  const r1 = await day(FRI16)
  assert.deepEqual(r1.done, { created: 12, started: 12, switchedOn: 12, stopped: 0, erased: 0, settled: 0, refused: [] })
  for (const b of books.planPlaybookBooks(PB_MASTER, FRI16)) {
    const row = await store.getBook(b.tag, 'paper')
    assert.ok(row !== null, `${b.tag} was not registered`)
    assert.equal(row.desired, 'running')
    assert.equal(row.expiry, b.expiry)
    assert.equal(books.isPlaybook(row), true, `${b.tag} did not read back as a playbook`)
    assert.equal(await switchOn(b.tag), true, `${b.tag} was born switched off`)
    const strategy = await store.loadStrategy(b.tag)
    assert.ok(strategy !== null && isArmed(strategy), `${b.tag}'s day guard is not armed`)
  }
  // ...and a second run a second later issues no calls at all.
  NOW += 1_000
  const again: string[] = []
  const r1b = await runRoll(FRI16, books.expiriesFrom(PB_MASTER, FRI16), again, { playbook: PB_MASTER })
  assert.deepEqual(again, [])
  assert.deepEqual([...r1b.plan.alarms], [])
  assert.deepEqual([...r1b.plan.anomalies], [])

  // Monday, then Wednesday: yesterday's books go — stop, then DELETE — and
  // today's come. Monday is NIFTY's expiry, so its daily books are seven (the
  // 0-DTE zero book the seventh) beside the six playbooks; Wednesday's six.
  for (const [today, before, made, gone] of [[MON19, FRI16, 13, 12], [WED21, MON19, 12, 13]] as const) {
    const calls: string[] = []
    const r = await day(today, calls)
    assert.deepEqual(r.done, { created: made, started: made, switchedOn: made, stopped: gone, erased: gone, settled: 0, refused: [] }, today)
    for (const tag of tagsOf(before)) {
      const stop = calls.indexOf(`POST ${REG}/${tag}/stop`)
      const del = calls.indexOf(`DELETE ${REG}/${tag}?mode=paper`)
      assert.ok(stop >= 0 && del > stop, `${tag}: stopped at ${stop}, DELETEd at ${del}`)
      assert.equal(await store.getBook(tag, 'paper'), null, `${tag} is still registered on ${today}`)
    }
    assert.deepEqual(await desk(), [...fourFor(today).map((b) => b.tag), ...tagsOf(today)].sort())
  }

  // Thursday, SENSEX's expiry: the three expiry presets on today's contract,
  // and SENSEX's 0-DTE zero book among the daily seven.
  const r4 = await day(THU22)
  assert.deepEqual(r4.done, { created: 16, started: 16, switchedOn: 16, stopped: 12, erased: 12, settled: 0, refused: [] })
  for (const variant of ['pb-expiry-drive', 'pb-expiry-theta', 'pb-expiry-gamma']) {
    const row = await store.getBook(pbTag('SENSEX', variant, THU22), 'paper')
    assert.equal(row?.expiry, THU22, `${variant} is not on SENSEX's own contract`)
    assert.equal(row?.desired, 'running')
  }
  assert.deepEqual(await desk(), [...fourFor(THU22).map((b) => b.tag), ...tagsOf(THU22)].sort())
  assert.equal((await store.listBooks('live')).length, 0, 'nothing reached the live registry')
})

// --------------------------------- the fourth loop and the prune, for real

/** The September TCS book as the box holds it: running, one long put on a dead contract. */
async function standUpStockHolder(): Promise<string> {
  const tag = 'TCS-2026-09-29-recenter-relief-r'
  const openedTs = Date.UTC(2026, 8, 7, 7, 50)
  await store.upsertBook({
    tag,
    symbol: 'TCS',
    expiry: '2026-09-29',
    mode: 'paper',
    variant: 'recenter-relief-r',
    ...DEFAULT_BOOK,
    dials: { margin_cap: 5000000 },
    desired: 'running',
    actual: 'running',
    createdAt: nineAmIst('2026-09-07'),
    updatedAt: nineAmIst('2026-09-07'),
  })
  await store.addStrategyMode({ tag, kind: 'external', label: tag }, 'paper', NOW)
  await store.saveBook(
    { tag, mode: 'paper', symbol: 'TCS', expiry: '2026-09-29' },
    [
      {
        deskTag: 'PE2080#seed',
        instrument: { tradingsymbol: 'TCS26SEP2080PE', instrumentToken: 39412482, lotSize: 225, tickSize: 0.05, exchange: 'NFO' },
        underlying: 'TCS',
        expiry: '2026-09-29',
        strike: 2080,
        type: 'PE',
        side: 'Buy',
        qty: 1125,
        entryPrice: 6.05,
        openedTs,
      },
    ],
    openedTs,
  )
  await handle!.db.collection(COLLECTIONS.decisions).insertOne({
    decisionId: 'entry-1788767681-TCS26SEP2080PE-Buy',
    tag,
    mode: 'paper',
    source: 'submit',
    createdAt: openedTs,
    fills: [{ op: 'open', deskTag: 'PE2080#seed', tradingsymbol: 'TCS26SEP2080PE', side: 'Buy', qty: 1125, price: 6.05, ts: openedTs }],
  })
  // The supervisor's journal of expiry day: TCS closed at 2044.85.
  await handle!.db.collection('desk-book-marks').insertOne({
    tag,
    mode: 'paper',
    dateIst: '2026-09-29',
    mark: 75,
    ts: Date.UTC(2026, 8, 29, 10, 0),
    spot: 2044.85,
  })
  return tag
}

itMongo('the fourth loop on a real registry: a stock book holding a dead contract is settled, stopped and erased', async () => {
  const tag = await standUpStockHolder()
  NOW = Date.UTC(2026, 9, 5, 3, 20) // Monday 08:50 IST
  const { heldByTag, expiredByTag } = await readDesk(MON)
  assert.equal(heldByTag.get(tag), 1)
  assert.equal(expiredByTag.get(tag), 1)

  const calls: string[] = []
  const { plan, done } = await runRoll(MON, MON_LIVE, calls)
  assert.equal(expiredFor(plan, tag).action, 'settle-then-erase')
  assert.equal(done.settled, 1)
  assert.deepEqual([...done.refused], [])
  const mine = calls.filter((c) => c.includes(tag))
  assert.deepEqual(mine, [settlePath(tag), `POST ${REG}/${tag}/stop`, `DELETE ${REG}/${tag}?mode=paper`])

  // Gone from the desk, kept in the history: the settlement is in the journal
  // at intrinsic, 2080 − 2044.85 = 35.15.
  assert.equal(await store.getBook(tag, 'paper'), null)
  const settle = await handle!.db.collection(COLLECTIONS.decisions).findOne({ tag, source: 'settle' })
  assert.ok(settle !== null)
  assert.deepEqual(
    (settle['fills'] as Record<string, unknown>[]).map((f) => [f['side'], f['qty'], f['price']]),
    [['Sell', 1125, 35.15]],
  )
  assert.equal(await store.loadStrategy(tag), null, 'its switch row went with it')
})

itMongo('--prune-orphans on a real registry: an external row with no book loses its paper switch and then the row', async () => {
  // An erased book whose switch row survived, switched ON.
  const orphan = 'NIFTY-delta-lean-aggressive-2026-09-29'
  await store.addStrategyMode({ tag: orphan, kind: 'external', label: orphan }, 'paper', NOW)
  await store.patchStrategy(orphan, { modes: { paper: { enabled: true } } }, NOW)
  // An emptied one, from before erases deleted the row.
  const emptied = 'BHEL-2026-08-25-recenter-r'
  await store.registerStrategy({ tag: emptied, kind: 'external', modes: {} }, NOW)
  // A book still on the desk, and a hosted strategy: neither is an orphan.
  const tag = await standUpStockHolder()
  await store.registerStrategy({ tag: 'MIRROR_A006', kind: 'hosted', modes: { paper: { enabled: false } } }, NOW)

  const registered = new Set([
    ...(await store.listBooks('paper')).map((r) => r.tag),
    ...(await store.listBooks('live')).map((r) => r.tag),
  ])
  const plan = roll.planOrphans({ strategies: await store.listStrategies(), registered })
  assert.deepEqual(plan.prune.map((p) => p.tag).sort(), [emptied, orphan].sort())

  const done = await roll.applyOrphans(plan, { request })
  assert.deepEqual([...done.refused], [])
  assert.equal(done.deletedRows, 2)
  assert.equal(await store.loadStrategy(orphan), null)
  assert.equal(await store.loadStrategy(emptied), null)
  assert.notEqual(await store.loadStrategy(tag), null, 'a registered book keeps its switch')
  assert.notEqual(await store.loadStrategy('MIRROR_A006'), null, 'a hosted strategy is never pruned')

  // The row DELETE itself refuses everything that is not an orphan.
  assert.equal((await request('DELETE', `${STRAT}/${tag}`)).status, 409, 'a registered book')
  assert.equal((await request('DELETE', `${STRAT}/MIRROR_A006`)).status, 409, 'a hosted row')
  assert.equal((await request('DELETE', `${STRAT}/NOPE`)).status, 404)
})
