/**
 * FOUR BOOKS, AND NOT ONE OF THEM LIVE.
 *
 * `scripts/delta-lean-books.mjs` is the whole plan's deliverable: the
 * reproducible way to put NIFTY and SENSEX on the desk, each with the
 * aggressive and the conservative preset, in PAPER. There is no CLI path for a
 * registry row — creation is HTTP, two calls per book — so the script is the
 * only artefact that says what those four rows are, and this file is the only
 * thing standing between a typo in it and four live index books.
 *
 * Four failures it prevents, in the order they would cost money:
 *
 *   1. A LIVE ROW. The gates behind this are good and the cheapest place to be
 *      certain is here, before any of them. `planBooks` hardcodes paper and
 *      `assertAllPaper` is a throw, not a warning — both are pinned below.
 *   2. A PRESET NAME INSTEAD OF NUMBERS. A preset is a one-time prefill copied
 *      into the book's own dials, never a runtime indirection. The aggressive
 *      preset states only its base, because `DEFAULT_DIALS` already IS spec
 *      §9's aggressive column — so a row carrying only that base would move the
 *      day the engine default moves, silently, on a running book. The payload
 *      therefore carries resolved numbers: `dl_open_lots: 4` is asserted
 *      here, on the payload, not looked up.
 *   3. A HARDCODED WEEKDAY OR LOT SIZE. `INDEX_UNDERLYINGS` says NIFTY expires
 *      Thursday and its lot is 75. Both are stale (Tuesday, 65) and its own
 *      comment says so. Expiries come from `OptionMaster.nearestExpiry`, asked
 *      for TODAY onward: a daily book has no tomorrow to protect, and expiry
 *      day is traded like any other (D6), so a contract expiring today is the
 *      one a book born today should hold.
 *   3b. A BOOK THAT OUTLIVES ITS DAY. A delta-lean book lives ONE trading day
 *      (spec D1): the tag is `${symbol}-${variant}-${tradingDay}`, so each
 *      morning's four are new rows and yesterday's page is one clean day. The
 *      trading day is an ARGUMENT, never defaulted from the clock — a plan
 *      whose day moves with `Date.now()` cannot be tested, and a script that
 *      guessed the day could register tomorrow's tag at 23:59 IST.
 *   4. A PAYLOAD THE REGISTRY WOULD REFUSE, discovered at 09:15. Every planned
 *      body is run through the registry's own `validateBookCreate`, and the
 *      Mongo half posts all four at a real `booksRoutes` server and pins the
 *      two-call create-then-start shape the script performs.
 *
 * OWN DATABASE NAME: `algomaker_dx_delta_lean_registration_test`, distinct from
 * every other Mongo suite here, because `node:test` runs files in parallel
 * processes and each one wipes its collections between tests.
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
import { booksRoutes, guardStopFor } from '../src/routes/books.ts'
import { validateBookCreate } from '../src/books-registry.ts'
import { isArmed } from '../src/day-guard.ts'
import { DEFAULT_DIALS, PRESETS, resolveDials, tradingDaysToExpiry, isTradingDay } from '@algomaker/desk-engine'
import type { StrategyRow } from '../src/strategies.ts'

/**
 * The script under test, imported through a URL rather than a literal path.
 *
 * It is a `.mjs` with no declaration file, and the root tsconfig carries no
 * `allowJs` — a literal specifier would be a typecheck error on a file that is
 * deliberately outside the TS projects (`scripts/` is in neither `include`).
 * The URL form is opaque to the resolver, so the shape is stated here instead,
 * which is also the only place the script's exported contract is written down.
 */
interface BookPlan {
  readonly tag: string
  readonly symbol: string
  readonly expiry: string
  readonly mode: string
  readonly variant: string
  /** The durable name the dated books report under (WS2) — never read off the tag. */
  readonly series: string
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

const script = (await import(
  new URL('../../../scripts/delta-lean-books.mjs', import.meta.url).href
)) as {
  planBooks(expiries: Expiries, tradingDay: string): readonly BookPlan[]
  expiriesFrom(master: MasterLike, tradingDay: string): Expiries
  assertAllPaper(books: readonly BookPlan[]): readonly BookPlan[]
  istDate(ms: number): string
  yesterdayIst(dateIst: string): string
  previousTradingDay(dateIst: string, isTrading?: (dateIst: string) => boolean): string
  planHoldBooks(expiries: Expiries, today: string): readonly BookPlan[]
  isHold(row: { dials?: unknown }): boolean
  planPlaybookBooks(master: MasterLike, today: string): readonly BookPlan[]
  isPlaybook(row: { variant?: unknown; dials?: unknown }): boolean
  engineKnowsPlaybookDial(): boolean
  dayAfterIst(dateIst: string): string
  withoutSeriesOff(plans: readonly BookPlan[], off?: readonly string[]): readonly BookPlan[]
  seriesSwitchedOff(plans: readonly BookPlan[], off?: readonly string[]): string[]
  readonly SERIES_OFF: readonly string[]
  readonly HOLD_PRESET_KEYS: readonly string[]
  readonly HOLD_DIAL: string
  readonly EXPIRY_DAY_DIAL: string
  readonly PLAYBOOK_PRESET_KEYS: readonly string[]
  readonly PLAYBOOK_DIAL: string
  readonly PLAYBOOK_EXPIRY_FROM: string
  readonly PAPER: string
  readonly STRATEGIES: string
  readonly PAPER_ON: { readonly modes: { readonly paper: { readonly enabled: true } } }
}
const { planBooks, expiriesFrom, assertAllPaper, istDate, yesterdayIst, previousTradingDay, planHoldBooks, isHold } = script
const { planPlaybookBooks, isPlaybook, dayAfterIst } = script

/**
 * Real answers off this desk's own dump for 2026-09-22, a Tuesday: NIFTY's
 * weekly expires THAT DAY (and is traded — D6), SENSEX's on the Thursday.
 * Never `Date.now()` — a suite whose fixtures move with the clock proves
 * nothing on the day it breaks.
 */
const TRADING_DAY = '2026-09-22'
const EXPIRIES: Expiries = { nifty: '2026-09-22', sensex: '2026-09-24' }
/** The day the `expiriesFrom` fixtures are asked about — a NIFTY expiry Tuesday. */
const TODAY = '2026-09-15'

const AGGRESSIVE_TAG = 'NIFTY-delta-lean-aggressive-2026-09-22'
const CONSERVATIVE_TAG = 'NIFTY-delta-lean-conservative-2026-09-22'

// ------------------------------------------------------------- the planning

test('every book the script plans is paper', () => {
  const books = planBooks(EXPIRIES, TRADING_DAY)
  // Three presets on each symbol, and NIFTY's 0-DTE book: 2026-09-22 is its
  // expiry (zero spec D3).
  assert.equal(books.length, 7)
  for (const b of books) assert.equal(b.mode, 'paper', `${b.tag} is not paper`)
})

test('the daily books: two symbols times three presets, and the 0-DTE book on the symbol that expires today', () => {
  const books = planBooks(EXPIRIES, TRADING_DAY)
  assert.deepEqual(
    books.map((b) => b.tag).sort(),
    [
      'NIFTY-delta-lean-aggressive-2026-09-22',
      'NIFTY-delta-lean-conservative-2026-09-22',
      'NIFTY-delta-lean-zero-2026-09-22',
      'NIFTY-delta-lean-zero-0dte-2026-09-22',
      'SENSEX-delta-lean-aggressive-2026-09-22',
      'SENSEX-delta-lean-conservative-2026-09-22',
      'SENSEX-delta-lean-zero-2026-09-22',
    ].sort(),
  )
})

test('each book carries its preset dials, resolved not referenced', () => {
  const books = planBooks(EXPIRIES, TRADING_DAY)
  const agg = books.find((b) => b.tag === AGGRESSIVE_TAG)
  assert.ok(agg !== undefined)
  assert.equal(agg.dials['delta_lean_enabled'], true)
  // The number the aggressive PRESET does not state — it inherits it from
  // DEFAULT_DIALS. Present on the payload is the whole point: the row is a
  // complete statement of the book, not a pointer at a default that can move.
  assert.equal(agg.dials['dl_open_lots'], 4)
  // Read by the HOST's damping, which both decide paths share. At the recenter
  // default (30s) a delta-lean cut would wait out a window longer than the
  // move it is cutting.
  assert.equal(agg.dials['cooldown_s'], 0)
  assert.equal(agg.dials['confirm_ms'], 1_000)

  const cons = books.find((b) => b.tag === CONSERVATIVE_TAG)
  assert.ok(cons !== undefined)
  assert.equal(cons.dials['dl_open_lots'], 2)
  assert.equal(cons.dials['dl_stuck_loss'], 15_000)
  assert.equal(cons.dials['margin_cap'], 2_500_000)
  // R1 (2026-10-05): the backstop is sized to each book.
  assert.equal(agg.dials['dl_day_max_loss'], 30_000)
  assert.equal(cons.dials['dl_day_max_loss'], 15_000)
  // 30 Oct 2026: the conservative column is opened and held — no adjustment —
  // against aggressive adjusting as before.
  assert.equal(agg.dials['dl_max_adjusts_day'], 6)
  assert.equal(cons.dials['dl_max_adjusts_day'], 0)
  // Same shape, different risk: the two rows must differ on the risk dials and
  // agree on the switch, or one of the two presets never made it through.
  assert.equal(cons.dials['delta_lean_enabled'], true)
})

test('the resolved dial-set is complete — every dial the engine reads has a value', () => {
  // A partial row resolves the rest against DEFAULT_DIALS at RUNTIME. That is
  // the indirection this script exists to remove, so the payload carries the
  // engine's whole vocabulary and nothing is left to be looked up later.
  for (const b of planBooks(EXPIRIES, TRADING_DAY)) {
    for (const key of Object.keys(DEFAULT_DIALS)) {
      assert.notEqual(b.dials[key], undefined, `${b.tag} has no value for ${key}`)
    }
    assert.equal(Object.keys(b.dials).length, Object.keys(DEFAULT_DIALS).length)
  }
})

test('the variant names the preset the dials came from', () => {
  for (const b of planBooks(EXPIRIES, TRADING_DAY)) {
    assert.equal(b.tag, `${b.symbol}-${b.variant}-${TRADING_DAY}`)
    assert.match(b.variant, /^delta-lean-(aggressive|conservative|zero|zero-0dte)$/)
  }
})

test('each payload states its series — symbol and variant, the same every day, sent explicitly', () => {
  // The daily tag changes every morning; the series is what the Reports page
  // groups those tags under, so it must be identical across days and stated
  // on the wire rather than left for the API to derive.
  // NIFTY's next expiry morning, so the 0-DTE book is on both days.
  const today = planBooks(EXPIRIES, TRADING_DAY)
  const nextWeek = planBooks({ nifty: '2026-09-29', sensex: '2026-10-01' }, '2026-09-29')
  for (const b of today) assert.equal(b.series, `${b.symbol}-${b.variant}`)
  assert.deepEqual(today.map((b) => b.series), nextWeek.map((b) => b.series))
  assert.deepEqual(
    today.map((b) => b.series).sort(),
    [
      'NIFTY-delta-lean-aggressive',
      'NIFTY-delta-lean-conservative',
      'NIFTY-delta-lean-zero',
      'NIFTY-delta-lean-zero-0dte',
      'SENSEX-delta-lean-aggressive',
      'SENSEX-delta-lean-conservative',
      'SENSEX-delta-lean-zero',
    ],
  )
  // Exactly these keys go on the wire — nothing more.
  for (const b of today) {
    assert.deepEqual(Object.keys(b).sort(), ['dials', 'expiry', 'mode', 'series', 'symbol', 'tag', 'variant'])
  }
})

test('the tag is symbol, variant, trading day — and the expiry is a separate field the tag does not carry', () => {
  // D1: a book lives one trading day, so the DAY is what the tag names. The
  // contract it trades is a field on the row — nothing anywhere parses a tag
  // (verified: no `tag.split('-')` in the repo), so the SENSEX books can carry
  // Thursday's expiry under a tag that ends in Tuesday's date.
  const books = planBooks(EXPIRIES, TRADING_DAY)
  for (const b of books.filter((b) => b.symbol === 'SENSEX')) {
    assert.equal(b.expiry, '2026-09-24')
    assert.ok(b.tag.endsWith(`-${TRADING_DAY}`), `${b.tag} does not end in the trading day`)
    assert.ok(!b.tag.includes(b.expiry), `${b.tag} carries the expiry, which nothing should read off it`)
  }
  for (const b of books.filter((b) => b.symbol === 'NIFTY')) assert.equal(b.expiry, '2026-09-22')
  for (const b of books) {
    const parsed = validateBookCreate(b)
    assert.equal(parsed.ok, true, parsed.ok ? '' : `${b.tag}: ${parsed.error}`)
  }
})

test('planBooks refuses a missing or malformed trading day — it is never defaulted from the clock', () => {
  // A plan whose day came from `Date.now()` cannot be tested, and a script
  // that guessed would register tomorrow's tag on a hand run after 18:30 UTC.
  assert.throws(() => planBooks(EXPIRIES, '22-09-2026'), /trading day/)
  assert.throws(() => (planBooks as unknown as (e: Expiries) => unknown)(EXPIRIES), /trading day/)
  assert.throws(() => planBooks(EXPIRIES, ''), /trading day/)
})

test('nothing in a payload asks for a state — a book is always created stopped', () => {
  // `validateBookCreate` refuses a create that states `desired` or `actual`,
  // deliberately: creating a book and granting it permission to trade are
  // separate acts, and the script performs them as two separate calls.
  for (const b of planBooks(EXPIRIES, TRADING_DAY)) {
    const raw = b as unknown as Record<string, unknown>
    assert.equal(raw['desired'], undefined)
    assert.equal(raw['actual'], undefined)
  }
})

test('every payload is a BookCreate the registry accepts exactly as written', () => {
  // The validator itself, not a copy of its rules: the tag charset, the ISO
  // expiry, the explicit mode and the number-or-boolean dial values. A payload
  // that fails here fails at 09:15 instead.
  for (const b of planBooks(EXPIRIES, TRADING_DAY)) {
    const parsed = validateBookCreate(b)
    assert.equal(parsed.ok, true, parsed.ok ? '' : `${b.tag}: ${parsed.error}`)
  }
})

// ------------------------------------------------------------- the refusal

test('assertAllPaper is a hard failure on a live book, never a warning', () => {
  const books = planBooks(EXPIRIES, TRADING_DAY)
  const tampered = books.map((b, i) => (i === 2 ? { ...b, mode: 'live' } : b))
  assert.throws(
    () => assertAllPaper(tampered),
    (e: unknown) => {
      // The message has to NAME the book, or an operator reading a refusal
      // cannot tell which of the rows is the problem.
      assert.ok(e instanceof Error)
      assert.match(e.message, /live/)
      assert.match(e.message, new RegExp(books[2]!.tag))
      return true
    },
  )
  assert.equal(assertAllPaper(books).length, books.length, 'every paper book passes through untouched')
})

test('planBooks runs the refusal itself — the guard is not something a caller may skip', () => {
  // Belt and braces. `planBooks` hardcodes the mode, so the only way this can
  // fire is a future edit that makes it a parameter; that edit must not be
  // able to land quietly.
  for (const b of planBooks(EXPIRIES, TRADING_DAY)) assert.equal(b.mode, 'paper')
  assert.equal(assertAllPaper(planBooks(EXPIRIES, TRADING_DAY)).length, 7)
})

// --------------------------------------------- the zero books (2026-10-17)

test('the 0-DTE zero book is planned only for a symbol whose contract expires that day — by its dial', () => {
  // Zero spec D3/D4: the engine opens it only on its expiry day, so a morning
  // it could never trade does not put it on the desk at all.
  const variants = (books: readonly BookPlan[], symbol: string) =>
    books.filter((b) => b.symbol === symbol).map((b) => b.variant)
  // Wednesday: neither expires.
  const wed = planBooks(EXPIRIES, '2026-09-23')
  assert.equal(wed.length, 6)
  assert.ok(!wed.some((b) => b.variant === 'delta-lean-zero-0dte'))
  // Thursday: SENSEX's day, NIFTY's next contract a week out.
  const thu = planBooks({ nifty: '2026-09-29', sensex: '2026-09-24' }, '2026-09-24')
  assert.deepEqual(variants(thu, 'SENSEX'), ['delta-lean-aggressive', 'delta-lean-conservative', 'delta-lean-zero', 'delta-lean-zero-0dte'])
  assert.deepEqual(variants(thu, 'NIFTY'), ['delta-lean-aggressive', 'delta-lean-conservative', 'delta-lean-zero'])
  // Every planned 0-DTE book carries the dial and today's contract; no other
  // daily book carries the dial at all.
  for (const b of [...planBooks(EXPIRIES, TRADING_DAY), ...thu]) {
    const expiryOnly = b.dials[script.EXPIRY_DAY_DIAL] === true
    assert.equal(expiryOnly, b.variant === 'delta-lean-zero-0dte', b.tag)
    if (expiryOnly) assert.equal(b.expiry, b.tag.slice(-10), `${b.tag} holds the contract that dies today`)
  }
})

test('the zero payloads carry the tuned column, resolved — the window, the fallback, no target, no adjusts', () => {
  const books = planBooks(EXPIRIES, TRADING_DAY)
  const zero = books.find((b) => b.tag === 'SENSEX-delta-lean-zero-2026-09-22')
  const odte = books.find((b) => b.tag === 'NIFTY-delta-lean-zero-0dte-2026-09-22')
  assert.ok(zero !== undefined && odte !== undefined)
  for (const b of [zero, odte]) {
    assert.equal(b.dials['delta_lean_enabled'], true, b.tag)
    assert.equal(b.dials['dl_warmup_min'], 569)
    assert.equal(b.dials['dl_open_by_min'], 571)
    assert.equal(b.dials['dl_day_target'], 0, 'the old-build fail-safe, on the wire (D9)')
    assert.equal(b.dials['dl_day_max_loss'], 20_000)
    assert.equal(b.dials['dl_stuck_loss'], 20_000)
    assert.equal(b.dials['dl_max_adjusts_day'], 0)
    assert.equal(b.dials['dl_flatten_passive_min'], 870)
    assert.equal(b.dials['dl_open_lots'], 2)
    assert.equal(b.dials['dl_hold_to_expiry'], false, 'a daily book, never a hold one')
  }
  assert.equal(zero.dials['dl_open_fallback'], true)
  assert.equal(zero.dials['dl_expiry_day_only'], false)
  assert.equal(odte.dials['dl_open_fallback'], false)
  assert.equal(odte.dials['dl_open_trend_up'], false)
  assert.equal(odte.dials['dl_open_quiet'], false)
  assert.equal(odte.dials['dl_open_trend_down'], true)
  assert.equal(odte.dials['dl_expiry_day_only'], true)
  assert.equal(isHold(zero), false)
  assert.equal(isPlaybook(zero), false)
})

// ------------------------------------------------- expiries from the master

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

test('expiries come from the instrument master, never from a hardcoded weekday', () => {
  // INDEX_UNDERLYINGS says NIFTY expires Thursday and its lot is 75. Both are
  // stale. Anything reading them mis-sizes every order in the book.
  const spy = masterSpy({
    NIFTY: ['2026-09-15', '2026-09-22', '2026-09-29'],
    SENSEX: ['2026-09-17', '2026-09-24'],
  })
  const got = expiriesFrom(spy, TODAY)
  assert.equal(spy.asked.length, 2)
  assert.deepEqual([...spy.asked].map((a) => a.underlying).sort(), ['NIFTY', 'SENSEX'])
  for (const a of spy.asked) assert.equal(a.onOrAfter, TODAY, 'the master is asked for today, not tomorrow')
  // NIFTY's Tuesday (today) and SENSEX's Thursday — read off the dump, not computed.
  assert.deepEqual(got, { nifty: '2026-09-15', sensex: '2026-09-17' })
})

test('a contract expiring TODAY is the one chosen — expiry day is traded (D6), a daily book has no tomorrow to protect', () => {
  // 2026-09-15 IS a NIFTY expiry (a Tuesday) and it is listed first. The old
  // weekly book asked for tomorrow so it would not spend its first session
  // rolling; a daily book has no second session, so today's own contract is
  // exactly what it should hold. The ask is `>= today`.
  const spy = masterSpy({ NIFTY: ['2026-09-15', '2026-09-22'], SENSEX: ['2026-09-17'] })
  const got = expiriesFrom(spy, TODAY)
  for (const a of spy.asked) assert.equal(a.onOrAfter, TODAY)
  assert.equal(got.nifty, '2026-09-15')
  assert.throws(() => expiriesFrom(spy, '15-09-2026'), /trading day/)
})

test('yesterdayIst crosses a month and a year end', () => {
  // String arithmetic on an IST date. `'2026-10-01' - 1` and `'2027-01-01' - 1`
  // are where a naive decrement produces '2026-10-00'.
  assert.equal(yesterdayIst('2026-10-01'), '2026-09-30')
  assert.equal(yesterdayIst('2027-01-01'), '2026-12-31')
  assert.equal(yesterdayIst('2026-03-01'), '2026-02-28')
  assert.equal(yesterdayIst('2026-09-22'), '2026-09-21')
  assert.throws(() => yesterdayIst('2026-9-22'), /IST date/)
  assert.throws(() => yesterdayIst('2026-13-45'), /IST date/)
})

test('previousTradingDay walks back over weekends and NSE holidays, one calendar day at a time', () => {
  // Used by the roll to say which session came before today (the erase
  // cutoff itself is now today — a finished book goes the morning after). It
  // needs the engine's calendar, not `yesterdayIst`: the session before Monday is
  // Friday, and the one before Tuesday 2026-09-15 is Friday 2026-09-11,
  // because Monday the 14th was Ganesh Chaturthi.
  assert.equal(previousTradingDay('2026-09-22'), '2026-09-21', 'Tuesday -> Monday')
  assert.equal(previousTradingDay('2026-09-28'), '2026-09-25', 'Monday -> Friday')
  assert.equal(previousTradingDay('2026-09-15'), '2026-09-11', 'Tuesday after a Monday holiday -> Friday')
  assert.equal(previousTradingDay('2026-10-05'), '2026-10-01', 'Monday after Gandhi Jayanti (Fri 10-02) -> Thursday')
  // A non-trading day itself still has a previous trading day.
  assert.equal(previousTradingDay('2026-09-19'), '2026-09-18', 'Saturday -> Friday')
  assert.throws(() => previousTradingDay('2026-9-22'), /IST date/)
  // Capped: a calendar that never answers yes is a bug, not a longer walk.
  assert.throws(() => previousTradingDay('2026-09-22', () => false), /10 days/)
})

test('istDate buckets by the IST calendar, not UTC', () => {
  // The legacy rows' real createdAt: 2026-09-15T18:29:21Z is 23:59:21 IST, so
  // the IST day is the 15th. Forty seconds later UTC is still the 15th but IST
  // is the 16th — the erase cutoff compares IST days, so this has to be right.
  assert.equal(istDate(1789496961351), '2026-09-15')
  assert.equal(istDate(Date.UTC(2026, 8, 15, 18, 31)), '2026-09-16')
  assert.equal(istDate(Date.UTC(2026, 8, 21, 18, 31)), '2026-09-22')
  assert.equal(istDate(Date.UTC(2026, 8, 22, 3, 20)), '2026-09-22', 'the 03:20 UTC cron slot is 08:50 the same IST day')
})

test('a symbol the dump does not list fails loudly, naming the sync that fixes it', () => {
  // The alternative is a book registered against `null`, or against whatever
  // the fallback table said. An operator on a box with a stale dump needs to
  // be told to run `make sync`, here, not to debug a 400 from the registry.
  const spy = masterSpy({ NIFTY: ['2026-09-22'] })
  assert.throws(
    () => expiriesFrom(spy, TODAY),
    (e: unknown) => {
      assert.ok(e instanceof Error)
      assert.match(e.message, /SENSEX/)
      assert.match(e.message, /make sync/)
      return true
    },
  )
})

// ------------------------------------------------- the hold-to-expiry pair

/**
 * The weekly sibling (spec 2026-10-05, hold-to-expiry): per symbol, ONE pair
 * per front contract — the aggressive and conservative columns with the one
 * dial `dl_hold_to_expiry: true` — created the first trading day whose front
 * expiry is new, and tagged by the CONTRACT, not the day.
 *
 * The first week is short: Tuesday 2026-10-06 is NIFTY's expiry, so only the
 * SENSEX pair (for Thursday the 8th) is created that morning; NIFTY's first
 * pair comes on Wednesday the 7th, for Tuesday the 13th.
 */
const HOLD_TUE = '2026-10-06'
const HOLD_TUE_EXPIRIES: Expiries = { nifty: '2026-10-06', sensex: '2026-10-08' }
const HOLD_WED = '2026-10-07'
const HOLD_WED_EXPIRIES: Expiries = { nifty: '2026-10-13', sensex: '2026-10-08' }
const SENSEX_HOLD_AGG = 'SENSEX-delta-lean-hold-aggressive-2026-10-08'
const SENSEX_HOLD_CONS = 'SENSEX-delta-lean-hold-conservative-2026-10-08'

/** The intraday payload of the same symbol and column, on the same morning. */
function intradayTwin(hold: BookPlan, expiries: Expiries, day: string): BookPlan {
  const intradayVariant = hold.variant.replace('delta-lean-hold-', 'delta-lean-')
  const twin = planBooks(expiries, day).find((b) => b.symbol === hold.symbol && b.variant === intradayVariant)
  assert.ok(twin !== undefined, `no intraday twin for ${hold.tag}`)
  return twin
}

test('the hold preset keys and the dial are the contract with the engine branch', () => {
  assert.deepEqual([...script.HOLD_PRESET_KEYS], ['delta-lean-hold-aggressive', 'delta-lean-hold-conservative'])
  assert.equal(script.HOLD_DIAL, 'dl_hold_to_expiry')
})

test('on an expiry morning no hold book is created for the contract that dies today', () => {
  // 2026-10-06: NIFTY's front contract IS today. A hold book born on it would
  // live one session, which is the intraday book's job. SENSEX's front is
  // Thursday, so its pair is created now.
  const hold = planHoldBooks(HOLD_TUE_EXPIRIES, HOLD_TUE)
  assert.deepEqual(hold.map((b) => b.tag), [SENSEX_HOLD_AGG, SENSEX_HOLD_CONS])
  for (const b of hold) {
    assert.equal(b.symbol, 'SENSEX')
    assert.equal(b.expiry, '2026-10-08')
    assert.equal(b.mode, 'paper')
  }
})

test("the day after NIFTY's expiry its first hold pair is created, for next Tuesday — tagged by the contract", () => {
  const hold = planHoldBooks(HOLD_WED_EXPIRIES, HOLD_WED)
  assert.deepEqual(hold.map((b) => b.tag), [
    'NIFTY-delta-lean-hold-aggressive-2026-10-13',
    'NIFTY-delta-lean-hold-conservative-2026-10-13',
    SENSEX_HOLD_AGG,
    SENSEX_HOLD_CONS,
  ])
  // The SENSEX tags are the SAME as Tuesday's plan: the tag names the
  // contract, so the roll converges on the rows it made yesterday.
  assert.deepEqual(
    hold.filter((b) => b.symbol === 'SENSEX').map((b) => b.tag),
    planHoldBooks(HOLD_TUE_EXPIRIES, HOLD_TUE).map((b) => b.tag),
  )
  for (const b of hold) {
    assert.equal(b.tag, `${b.symbol}-${b.variant}-${b.expiry}`)
    assert.equal(b.series, `${b.symbol}-${b.variant}`)
    assert.ok(!b.tag.includes(HOLD_WED), `${b.tag} names the day it was created`)
  }
})

test('the hold payload pins the dial, the variant and the series — exactly the intraday column plus dl_hold_to_expiry', () => {
  // Review Focus 5. The dial is the ONLY thing that makes these books hold
  // overnight; a script or an API that dropped it would register an intraday
  // book under a hold tag, and it would flatten at 15:00 on its first day.
  const hold = planHoldBooks(HOLD_TUE_EXPIRIES, HOLD_TUE)
  const agg = hold.find((b) => b.tag === SENSEX_HOLD_AGG)
  const cons = hold.find((b) => b.tag === SENSEX_HOLD_CONS)
  assert.ok(agg !== undefined && cons !== undefined)

  assert.equal(agg.variant, 'delta-lean-hold-aggressive')
  assert.equal(agg.series, 'SENSEX-delta-lean-hold-aggressive')
  assert.equal(cons.variant, 'delta-lean-hold-conservative')
  assert.equal(cons.series, 'SENSEX-delta-lean-hold-conservative')
  for (const b of [agg, cons]) {
    assert.equal(b.dials['dl_hold_to_expiry'], true, `${b.tag} does not carry the hold dial`)
    assert.equal(b.dials['delta_lean_enabled'], true)
    assert.deepEqual(Object.keys(b).sort(), ['dials', 'expiry', 'mode', 'series', 'symbol', 'tag', 'variant'])
    // Same column, same numbers, one dial more. The numbers come from the
    // INTRADAY preset of the same column, folded onto the engine defaults.
    assert.deepEqual(b.dials, { ...intradayTwin(b, HOLD_TUE_EXPIRIES, HOLD_TUE).dials, dl_hold_to_expiry: true })
    // Complete: every dial the engine reads, plus the hold dial (which the
    // engine branch adds to DEFAULT_DIALS — the union is the same set either way).
    const expectedKeys = new Set([...Object.keys(DEFAULT_DIALS), 'dl_hold_to_expiry'])
    assert.deepEqual(Object.keys(b.dials).sort(), [...expectedKeys].sort())
    const parsed = validateBookCreate(b)
    assert.equal(parsed.ok, true, parsed.ok ? '' : `${b.tag}: ${parsed.error}`)
  }
  // The columns stay distinct.
  assert.equal(agg.dials['dl_open_lots'], 4)
  assert.equal(cons.dials['dl_open_lots'], 2)
  assert.equal(cons.dials['dl_stuck_loss'], 15_000)
  // ...and since 30 Oct 2026 the conservative hold book is opened and held.
  assert.equal(agg.dials['dl_max_adjusts_day'], 6)
  assert.equal(cons.dials['dl_max_adjusts_day'], 0)
})

test('when the engine ships the hold presets, they resolve to EXACTLY the payload the roll already sends', () => {
  // The scripts build a hold book's dials from the intraday preset of the same
  // column plus `dl_hold_to_expiry: true`, so the roll does not depend on the
  // engine branch having landed. The engine branch declares the two presets as
  // that same column plus that same dial. Once they exist this test compares
  // the two statements, and a drift between them — a hold preset that states a
  // number the intraday column does not — fails HERE, not on a running book.
  // Before they land there is nothing to compare against, and it passes empty.
  for (const key of script.HOLD_PRESET_KEYS) {
    const preset = PRESETS.find((p) => p.key === key)
    if (preset === undefined) continue
    const { dials, unknown } = resolveDials(preset.dials as Record<string, number | boolean>)
    assert.deepEqual(unknown, [], `preset ${key} states dials the engine refuses`)
    for (const b of planHoldBooks(HOLD_WED_EXPIRIES, HOLD_WED).filter((b) => b.variant === key)) {
      assert.deepEqual(b.dials, { ...dials }, `${b.tag}: the roll's payload and preset ${key} disagree`)
    }
  }
})

test('isHold reads the dial and nothing else — true only for a literal true', () => {
  const [agg] = planHoldBooks(HOLD_TUE_EXPIRIES, HOLD_TUE)
  assert.ok(agg !== undefined)
  assert.equal(isHold(agg), true)
  // The intraday books: dial absent (before the engine lands) or false (after).
  for (const b of planBooks(HOLD_TUE_EXPIRIES, HOLD_TUE)) assert.equal(isHold(b), false, b.tag)
  assert.equal(isHold({ dials: { dl_hold_to_expiry: false } }), false)
  assert.equal(isHold({ dials: { dl_hold_to_expiry: 1 } }), false)
  assert.equal(isHold({ dials: { dl_hold_to_expiry: 'true' } }), false)
  assert.equal(isHold({ dials: null }), false)
  assert.equal(isHold({}), false)
  // Never the tag, never the variant: a row that SAYS hold in both but whose
  // dials do not carry it is not a hold book.
  assert.equal(isHold({ ...agg, dials: { ...agg.dials, dl_hold_to_expiry: false } }), false)
})

test('every hold book is paper, and assertAllPaper refuses a tampered one', () => {
  const hold = planHoldBooks(HOLD_WED_EXPIRIES, HOLD_WED)
  assert.equal(hold.length, 4)
  for (const b of hold) assert.equal(b.mode, 'paper')
  const tampered = hold.map((b, i) => (i === 1 ? { ...b, mode: 'live' } : b))
  assert.throws(() => assertAllPaper(tampered), new RegExp(`REFUSED.*${hold[1]!.tag}`))
})

test('planHoldBooks refuses a malformed day, and an expiry already behind today', () => {
  assert.throws(() => planHoldBooks(HOLD_TUE_EXPIRIES, '06-10-2026'), /trading day/)
  assert.throws(() => planHoldBooks({ nifty: '2026-10-06', sensex: 'Thursday' }, HOLD_TUE), /expiries\.sensex/)
  // `expiriesFrom` never answers a contract before today; a plan that has one
  // is incoherent, and a hold book on a dead contract is not a book.
  assert.throws(() => planHoldBooks({ nifty: '2026-10-01', sensex: '2026-10-08' }, HOLD_TUE), /before/)
})

// ------------------------------------------------------ the playbook family

/**
 * The six playbooks (spec 2026-10-16 §4.9): per symbol, the three INTRADAY
 * presets every trading day, each on the nearest listed contract with at
 * least its `pb_min_dte` TRADING days to go, and the three EXPIRY presets
 * only on the symbol's own expiry day, from `PLAYBOOK_EXPIRY_FROM`.
 *
 * The dump as the first playbook fortnight will meet it. NIFTY's weekly is a
 * Tuesday except the 19th, which Dussehra (Tue 10-20) moved to the Monday;
 * SENSEX's is a Thursday. The sessions, holidays out:
 *
 *   Fri 16 | Mon 19 | (Tue 20 Dussehra) | Wed 21 | Thu 22 | Fri 23
 *   Mon 26 | Tue 27 | Wed 28 | Thu 29 | Fri 30 | Mon 2 Nov | Tue 3 | Wed 4 | Thu 5
 *
 * Every expected contract below was counted by hand off that grid, not
 * computed by the function under test.
 */
const PB_LISTED: Readonly<Record<string, readonly string[]>> = {
  NIFTY: ['2026-10-19', '2026-10-27', '2026-11-03'],
  SENSEX: ['2026-10-22', '2026-10-29', '2026-11-05'],
}

/** Today's playbook plan as `[tag, expiry]`, in the order the roll sends it. */
const pbPlan = (day: string): Array<[string, string]> =>
  planPlaybookBooks(masterSpy(PB_LISTED), day).map((b) => [b.tag, b.expiry])

test('the playbook keys, the dial and the expiry-from date are the contract with the engine', () => {
  // Spec order, which is `pb_playbook` 1-6: three intraday, then three expiry-day.
  assert.deepEqual([...script.PLAYBOOK_PRESET_KEYS], [
    'pb-trend-drive',
    'pb-wing-straddle',
    'pb-reversal',
    'pb-expiry-drive',
    'pb-expiry-theta',
    'pb-expiry-gamma',
  ])
  assert.equal(script.PLAYBOOK_DIAL, 'pb_playbook')
  // The first day the expiry presets may be created: the first playbook
  // session (Mon 10-19) runs the intraday presets alone (spec §10).
  assert.equal(script.PLAYBOOK_EXPIRY_FROM, '2026-10-21')
  script.PLAYBOOK_PRESET_KEYS.forEach((key, i) => {
    const preset = PRESETS.find((p) => p.key === key)
    assert.ok(preset !== undefined, `the engine ships no preset ${key}`)
    assert.equal(preset.dials.pb_playbook, i + 1, `${key} selects the wrong playbook`)
  })
})

test('Fri 2026-10-16: six books — the three intraday presets per symbol, each contract counted in trading days', () => {
  // Trend Drive and Reversal (pb_min_dte 1): NIFTY 10-19 is one session out
  // (Sat, Sun, Mon), SENSEX 10-22 three (19, 21, 22). Wing Straddle (5):
  // NIFTY 10-19 is too close, 10-27 is six (19, 21, 22, 23, 26, 27); SENSEX
  // 10-22's three are too few, 10-29 is eight. No expiry preset: neither
  // symbol expires today.
  assert.deepEqual(pbPlan('2026-10-16'), [
    ['NIFTY-pb-trend-drive-2026-10-16', '2026-10-19'],
    ['NIFTY-pb-wing-straddle-2026-10-16', '2026-10-27'],
    ['NIFTY-pb-reversal-2026-10-16', '2026-10-19'],
    ['SENSEX-pb-trend-drive-2026-10-16', '2026-10-22'],
    ['SENSEX-pb-wing-straddle-2026-10-16', '2026-10-29'],
    ['SENSEX-pb-reversal-2026-10-16', '2026-10-22'],
  ])
})

test("Mon 2026-10-19, NIFTY's expiry: six books — no NIFTY expiry preset before PLAYBOOK_EXPIRY_FROM, and no intraday book on 0-DTE", () => {
  // NIFTY's front contract IS today (0 sessions), so every intraday preset
  // moves to 10-27: five sessions (21, 22, 23, 26, 27) — enough even for
  // Wing Straddle's five. SENSEX 10-22 is two sessions (21, 22): fine for 1,
  // not for 5, whose contract is 10-29 (seven). The NIFTY expiry presets would
  // qualify on the contract alone, but 10-19 is before 2026-10-21.
  assert.deepEqual(pbPlan('2026-10-19'), [
    ['NIFTY-pb-trend-drive-2026-10-19', '2026-10-27'],
    ['NIFTY-pb-wing-straddle-2026-10-19', '2026-10-27'],
    ['NIFTY-pb-reversal-2026-10-19', '2026-10-27'],
    ['SENSEX-pb-trend-drive-2026-10-19', '2026-10-22'],
    ['SENSEX-pb-wing-straddle-2026-10-19', '2026-10-29'],
    ['SENSEX-pb-reversal-2026-10-19', '2026-10-22'],
  ])
})

test('Wed 2026-10-21: six books — the date has come, but neither symbol expires today', () => {
  // NIFTY 10-27 is four sessions (22, 23, 26, 27): Wing Straddle walks on to
  // 11-03 (nine). SENSEX 10-22 is one session (22): Trend Drive and Reversal
  // take it; Wing Straddle takes 10-29 (six).
  assert.deepEqual(pbPlan('2026-10-21'), [
    ['NIFTY-pb-trend-drive-2026-10-21', '2026-10-27'],
    ['NIFTY-pb-wing-straddle-2026-10-21', '2026-11-03'],
    ['NIFTY-pb-reversal-2026-10-21', '2026-10-27'],
    ['SENSEX-pb-trend-drive-2026-10-21', '2026-10-22'],
    ['SENSEX-pb-wing-straddle-2026-10-21', '2026-10-29'],
    ['SENSEX-pb-reversal-2026-10-21', '2026-10-22'],
  ])
})

test("Thu 2026-10-22, SENSEX's expiry: nine books — the three expiry presets on SENSEX's own contract", () => {
  // SENSEX's front contract is today: the expiry presets take it, and every
  // intraday SENSEX preset moves to 10-29 (five: 23, 26, 27, 28, 29). NIFTY
  // 10-27 is three sessions (23, 26, 27): Wing Straddle takes 11-03 (eight).
  assert.deepEqual(pbPlan('2026-10-22'), [
    ['NIFTY-pb-trend-drive-2026-10-22', '2026-10-27'],
    ['NIFTY-pb-wing-straddle-2026-10-22', '2026-11-03'],
    ['NIFTY-pb-reversal-2026-10-22', '2026-10-27'],
    ['SENSEX-pb-trend-drive-2026-10-22', '2026-10-29'],
    ['SENSEX-pb-wing-straddle-2026-10-22', '2026-10-29'],
    ['SENSEX-pb-reversal-2026-10-22', '2026-10-29'],
    ['SENSEX-pb-expiry-drive-2026-10-22', '2026-10-22'],
    ['SENSEX-pb-expiry-theta-2026-10-22', '2026-10-22'],
    ['SENSEX-pb-expiry-gamma-2026-10-22', '2026-10-22'],
  ])
})

test("Tue 2026-10-27, NIFTY's first expiry after the date: its three expiry presets come too", () => {
  // The other symbol, once the date has passed. NIFTY's intraday presets take
  // 11-03 (five: 28, 29, 30, 2, 3); SENSEX 10-29 is two sessions (28, 29), so
  // Wing Straddle takes 11-05 (seven).
  assert.deepEqual(pbPlan('2026-10-27'), [
    ['NIFTY-pb-trend-drive-2026-10-27', '2026-11-03'],
    ['NIFTY-pb-wing-straddle-2026-10-27', '2026-11-03'],
    ['NIFTY-pb-reversal-2026-10-27', '2026-11-03'],
    ['NIFTY-pb-expiry-drive-2026-10-27', '2026-10-27'],
    ['NIFTY-pb-expiry-theta-2026-10-27', '2026-10-27'],
    ['NIFTY-pb-expiry-gamma-2026-10-27', '2026-10-27'],
    ['SENSEX-pb-trend-drive-2026-10-27', '2026-10-29'],
    ['SENSEX-pb-wing-straddle-2026-10-27', '2026-11-05'],
    ['SENSEX-pb-reversal-2026-10-27', '2026-10-29'],
  ])
})

test('the walk asks the master for the day after each contract it passes over, and never before today', () => {
  const spy = masterSpy(PB_LISTED)
  planPlaybookBooks(spy, '2026-10-16')
  for (const a of spy.asked) assert.ok(a.onOrAfter >= '2026-10-16', `asked about ${a.onOrAfter}, before today`)
  // Wing Straddle passes over NIFTY 10-19 and SENSEX 10-22 and asks again
  // from the next calendar day — Dussehra and all, the master decides.
  assert.ok(spy.asked.some((a) => a.underlying === 'NIFTY' && a.onOrAfter === '2026-10-20'))
  assert.ok(spy.asked.some((a) => a.underlying === 'SENSEX' && a.onOrAfter === '2026-10-23'))
})

test('every playbook payload: paper, its own preset resolved (dl_open_lots 0, its pb_playbook), its series, exactly the wire keys', () => {
  for (const day of ['2026-10-16', '2026-10-19', '2026-10-21', '2026-10-22', '2026-10-27']) {
    for (const b of planPlaybookBooks(masterSpy(PB_LISTED), day)) {
      assert.equal(b.mode, 'paper', `${b.tag} is not paper`)
      assert.equal(b.tag, `${b.symbol}-${b.variant}-${day}`, 'the tag names the DAY, never the contract')
      assert.equal(b.series, `${b.symbol}-${b.variant}`)
      assert.deepEqual(Object.keys(b).sort(), ['dials', 'expiry', 'mode', 'series', 'symbol', 'tag', 'variant'])
      // The preset folded onto the engine defaults, exactly as the daily four
      // are — the row is a complete statement of the book.
      const preset = PRESETS.find((p) => p.key === b.variant)
      assert.ok(preset !== undefined)
      const { dials, unknown } = resolveDials(preset.dials as Record<string, number | boolean>)
      assert.deepEqual(unknown, [])
      assert.deepEqual(b.dials, { ...dials }, `${b.tag}: the payload is not its preset, resolved`)
      assert.equal(Object.keys(b.dials).length, Object.keys(DEFAULT_DIALS).length)
      // D9, the old-build fail-safe, rides in the row itself.
      assert.equal(b.dials['dl_open_lots'], 0)
      assert.equal(b.dials['delta_lean_enabled'], true)
      assert.equal(b.dials['dl_hold_to_expiry'], false)
      assert.equal(isPlaybook(b), true, `${b.tag} is not a playbook book by its own test`)
      const parsed = validateBookCreate(b)
      assert.equal(parsed.ok, true, parsed.ok ? '' : `${b.tag}: ${parsed.error}`)
    }
  }
})

test('an intraday preset never lands inside its pb_min_dte; an expiry preset only ever on a contract dying today', () => {
  // The invariant behind the dates above, over every session of the fortnight
  // — with the dump listing two contracts further out, so the last mornings
  // have a Wing Straddle contract too (Tue 11-10 is a holiday, so that week's
  // NIFTY weekly is Monday the 9th).
  const longer = {
    NIFTY: [...(PB_LISTED['NIFTY'] ?? []), '2026-11-09'],
    SENSEX: [...(PB_LISTED['SENSEX'] ?? []), '2026-11-12'],
  }
  let sessions = 0
  for (let day = '2026-10-16'; day <= '2026-10-30'; day = dayAfterIst(day)) {
    if (!isTradingDay(day)) continue
    sessions += 1
    for (const b of planPlaybookBooks(masterSpy(longer), day)) {
      if (b.dials['pb_expiry_day_only'] === true) {
        assert.equal(b.expiry, day, `${b.tag} is an expiry preset on ${b.expiry}`)
        assert.ok(day >= script.PLAYBOOK_EXPIRY_FROM, `${b.tag} is before the expiry-from date`)
      } else {
        const left = tradingDaysToExpiry(day, b.expiry)
        assert.ok(left >= Number(b.dials['pb_min_dte']), `${b.tag}: ${left} session(s) to ${b.expiry}`)
        assert.ok(left >= 1, `${b.tag} is an intraday book on a 0-DTE contract`)
      }
    }
  }
  assert.equal(sessions, 10, 'the fortnight is ten sessions — Dussehra is out')
})

test('no listed contract far enough out is a throw naming the symbol, the preset and the sync that fixes it', () => {
  // A dump that lists only NIFTY's front weekly: Trend Drive could trade it,
  // Wing Straddle (five sessions) has nothing — and a book against `null`, or
  // a guessed weekday, is exactly what this script refuses to register.
  assert.throws(
    () => planPlaybookBooks(masterSpy({ NIFTY: ['2026-10-19'], SENSEX: PB_LISTED['SENSEX'] ?? [] }), '2026-10-16'),
    (e: unknown) => {
      assert.ok(e instanceof Error)
      assert.match(e.message, /NIFTY/)
      assert.match(e.message, /pb-wing-straddle/)
      assert.match(e.message, /5 trading day/)
      assert.match(e.message, /make sync/)
      return true
    },
  )
  // A symbol the dump does not list at all.
  assert.throws(() => planPlaybookBooks(masterSpy({ NIFTY: PB_LISTED['NIFTY'] ?? [] }), '2026-10-16'), /SENSEX.*make sync/s)
})

test('a master that answers something that is not a date, or a contract before the day asked, is refused', () => {
  const answering = (expiry: string): MasterLike => ({ nearestExpiry: () => expiry })
  assert.throws(() => planPlaybookBooks(answering('Tuesday'), '2026-10-16'), /the master returned "Tuesday"/)
  // The walk would otherwise stand still on a master that ignores its argument.
  assert.throws(() => planPlaybookBooks(answering('2026-10-19'), '2026-10-19'), /before|on or after/)
  assert.throws(() => planPlaybookBooks(masterSpy(PB_LISTED), '16-10-2026'), /trading day/)
})

test('isPlaybook: the variant, delta_lean_enabled true AND pb_playbook a number of at least 1 — all three, read off the row', () => {
  const [b] = planPlaybookBooks(masterSpy(PB_LISTED), '2026-10-16')
  assert.ok(b !== undefined)
  assert.equal(isPlaybook(b), true)
  assert.equal(isPlaybook({ ...b, dials: { ...b.dials, pb_playbook: 0 } }), false, 'pb_playbook 0 is no playbook')
  assert.equal(isPlaybook({ ...b, dials: { ...b.dials, pb_playbook: '1' } }), false, 'a string is not a number')
  assert.equal(isPlaybook({ ...b, dials: { ...b.dials, pb_playbook: Number.NaN } }), false)
  assert.equal(
    isPlaybook({ ...b, dials: Object.fromEntries(Object.entries(b.dials).filter(([k]) => k !== 'pb_playbook')) }),
    false,
    'an absent dial is never read as a value',
  )
  assert.equal(isPlaybook({ ...b, dials: { ...b.dials, delta_lean_enabled: false } }), false)
  assert.equal(isPlaybook({ ...b, variant: 'delta-lean-aggressive' }), false, 'a playbook dial under another variant')
  assert.equal(isPlaybook({ ...b, dials: null }), false)
  assert.equal(isPlaybook({}), false)
  // The daily four and the hold pairs are not playbooks.
  for (const d of [...planBooks(EXPIRIES, TRADING_DAY), ...planHoldBooks(HOLD_TUE_EXPIRIES, HOLD_TUE)]) {
    assert.equal(isPlaybook(d), false, d.tag)
  }
})

test('engineKnowsPlaybookDial follows the engine on disk — and this tree ships the dial', () => {
  assert.equal(script.engineKnowsPlaybookDial(), Object.hasOwn(DEFAULT_DIALS, 'pb_playbook'))
  assert.equal(script.engineKnowsPlaybookDial(), true)
})

test('dayAfterIst crosses a month and a year end, and refuses a malformed day', () => {
  assert.equal(dayAfterIst('2026-10-19'), '2026-10-20')
  assert.equal(dayAfterIst('2026-10-31'), '2026-11-01')
  assert.equal(dayAfterIst('2026-12-31'), '2027-01-01')
  assert.equal(dayAfterIst('2026-02-28'), '2026-03-01')
  assert.throws(() => dayAfterIst('2026-9-22'), /IST date/)
})

// --------------------------------------------------- series switched off

/**
 * `SERIES_OFF` (2026-10-30 review): per-symbol series the roll and `--apply`
 * plan and then do not create. The planners and the preset lists stay whole —
 * the tests above pin them — and `withoutSeriesOff` is the filter after them.
 */
const OFF_30_OCT = [
  'SENSEX-delta-lean-conservative',
  'SENSEX-delta-lean-zero',
  'NIFTY-pb-trend-drive',
  'SENSEX-pb-trend-drive',
  'NIFTY-pb-wing-straddle',
  'SENSEX-pb-wing-straddle',
  'SENSEX-pb-reversal',
  'NIFTY-pb-expiry-drive',
  'SENSEX-pb-expiry-drive',
  'NIFTY-pb-expiry-theta',
  'SENSEX-pb-expiry-theta',
  'NIFTY-pb-expiry-gamma',
  'SENSEX-pb-expiry-gamma',
]
/** Every series that stays on: the review kept these. */
const KEPT_30_OCT = [
  'NIFTY-delta-lean-aggressive',
  'NIFTY-delta-lean-conservative',
  'NIFTY-delta-lean-zero',
  'NIFTY-delta-lean-zero-0dte',
  'SENSEX-delta-lean-aggressive',
  'SENSEX-delta-lean-zero-0dte',
  'NIFTY-delta-lean-hold-aggressive',
  'NIFTY-delta-lean-hold-conservative',
  'SENSEX-delta-lean-hold-aggressive',
  'SENSEX-delta-lean-hold-conservative',
  'NIFTY-pb-reversal',
]

/** One plan of every series any planner makes: all three families, both symbols, both expiry mornings. */
function everySeriesPlanned(): readonly BookPlan[] {
  return [
    // A morning both symbols expire, so both 0-DTE books are planned.
    ...planBooks({ nifty: TRADING_DAY, sensex: TRADING_DAY }, TRADING_DAY),
    ...planHoldBooks(HOLD_WED_EXPIRIES, HOLD_WED),
    // SENSEX's expiry Thursday, then NIFTY's three expiry presets (on its own
    // contract) from its expiry Tuesday: every playbook preset on both symbols.
    ...planPlaybookBooks(masterSpy(PB_LISTED), '2026-10-22'),
    ...planPlaybookBooks(masterSpy(PB_LISTED), '2026-10-27').filter((b) => b.symbol === 'NIFTY' && b.expiry === '2026-10-27'),
  ]
}

test('SERIES_OFF is the 30 Oct 2026 list — thirteen series, frozen', () => {
  assert.deepEqual([...script.SERIES_OFF].sort(), [...OFF_30_OCT].sort())
  assert.equal(new Set(script.SERIES_OFF).size, script.SERIES_OFF.length, 'a series listed twice')
  assert.ok(Object.isFrozen(script.SERIES_OFF))
})

test('withoutSeriesOff drops exactly the listed series from every family — NIFTY Reversal, NIFTY conservative, both 0-DTE books and the hold books stay', () => {
  const all = everySeriesPlanned()
  const series = (plans: readonly BookPlan[]): string[] => [...new Set(plans.map((b) => b.series))].sort()
  // Every series of the three families is in the fixture, once.
  assert.equal(series(all).length, all.length)
  assert.equal(all.length, 8 + 4 + 12)

  const kept = script.withoutSeriesOff(all)
  assert.deepEqual(series(kept), [...KEPT_30_OCT].sort())
  // What was dropped is exactly the list: every name in it is a series some
  // planner really makes — a typo would switch nothing off, silently.
  const dropped = all.filter((b) => !kept.includes(b))
  assert.deepEqual(series(dropped), [...OFF_30_OCT].sort())
  assert.deepEqual(script.seriesSwitchedOff(all), dropped.map((b) => b.series), 'the names, in plan order')
  // The order of what is kept is the plan's, and the plans are the same objects.
  assert.deepEqual(kept, all.filter((b) => KEPT_30_OCT.includes(b.series)))
  for (const b of kept) assert.equal(b.mode, 'paper')

  // The list is a parameter: an empty one keeps everything.
  assert.deepEqual(script.withoutSeriesOff(all, []), all)
  assert.deepEqual(script.seriesSwitchedOff(all, []), [])
  // The planners themselves are untouched — they still plan the switched-off presets.
  assert.ok(planBooks(EXPIRIES, TRADING_DAY).some((b) => b.series === 'SENSEX-delta-lean-conservative'))
})

test('with SERIES_OFF applied every symbol still has a daily book every morning — SENSEX keeps aggressive, and its 0-DTE book on its expiry', () => {
  // A symbol with no daily target is never "covered", and the roll would
  // withhold its retire (ALARM) instead of erasing yesterday's rows.
  const mornings: ReadonlyArray<[string, Expiries]> = [
    ['2026-10-26', { nifty: '2026-10-27', sensex: '2026-10-29' }],
    ['2026-10-27', { nifty: '2026-10-27', sensex: '2026-10-29' }],
    ['2026-10-29', { nifty: '2026-11-03', sensex: '2026-10-29' }],
  ]
  for (const [day, expiries] of mornings) {
    const kept = script.withoutSeriesOff(planBooks(expiries, day))
    assert.deepEqual(
      kept.filter((b) => b.symbol === 'SENSEX').map((b) => b.variant),
      expiries.sensex === day ? ['delta-lean-aggressive', 'delta-lean-zero-0dte'] : ['delta-lean-aggressive'],
      day,
    )
    assert.deepEqual(
      kept.filter((b) => b.symbol === 'NIFTY').map((b) => b.variant),
      expiries.nifty === day
        ? ['delta-lean-aggressive', 'delta-lean-conservative', 'delta-lean-zero', 'delta-lean-zero-0dte']
        : ['delta-lean-aggressive', 'delta-lean-conservative', 'delta-lean-zero'],
      day,
    )
  }
})

test("Tue 2026-10-27, NIFTY's expiry: filtered, the playbook plan is NIFTY's Reversal alone — SENSEX has none", () => {
  const planned = planPlaybookBooks(masterSpy(PB_LISTED), '2026-10-27')
  assert.equal(planned.length, 9)
  assert.deepEqual(script.withoutSeriesOff(planned).map((b) => [b.tag, b.expiry]), [
    ['NIFTY-pb-reversal-2026-10-27', '2026-11-03'],
  ])
  assert.deepEqual(script.seriesSwitchedOff(planned), [
    'NIFTY-pb-trend-drive',
    'NIFTY-pb-wing-straddle',
    'NIFTY-pb-expiry-drive',
    'NIFTY-pb-expiry-theta',
    'NIFTY-pb-expiry-gamma',
    'SENSEX-pb-trend-drive',
    'SENSEX-pb-wing-straddle',
    'SENSEX-pb-reversal',
  ])
  // SENSEX's expiry Thursday, and an ordinary morning: the same one book.
  for (const day of ['2026-10-22', '2026-10-21']) {
    assert.deepEqual(
      script.withoutSeriesOff(planPlaybookBooks(masterSpy(PB_LISTED), day)).map((b) => b.tag),
      [`NIFTY-pb-reversal-${day}`],
      day,
    )
  }
})

// ------------------------------------------------------------ the two calls

const URL_MONGO =
  process.env['DESK_TEST_MONGO'] ?? 'mongodb://127.0.0.1:27017/algomaker_dx_delta_lean_registration_test'
const TOKEN = 'machine-token-do-not-use-in-prod'
/** A real date, never `Date.now()`: 2026-09-15 10:30 IST, mid-session. */
let NOW = Date.UTC(2026, 8, 15, 5, 0)

let handle: MongoHandle | null = null
let store: DeskStore
let server: Server | null = null
let base = ''
let available = false
/**
 * The registry start route this suite drives calls `notifySupervisor` on
 * success. Without pointing `DESK_SUPERVISOR_PORT` at a harmless loopback
 * server, that nudge reaches the live desk-supervisor with no bearer token —
 * see `./nudge-sink.ts`.
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

async function post(
  path: string,
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
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
    log: () => {},
    now: () => NOW,
    gate: bearerGate(TOKEN),
  } as unknown as Parameters<typeof booksRoutes>[0]
  server = createBridgeServer({ gate: bearerGate(TOKEN), routes: [booksRoutes(apiDeps)] })
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
  for (const c of Object.values(COLLECTIONS)) await handle!.db.collection(c).deleteMany({})
  await store.ensureIndexes()
  NOW = Date.UTC(2026, 8, 15, 5, 0)
  if (sink !== null) sink.nudges.length = 0
})

async function strategy(tag: string): Promise<StrategyRow> {
  const row = await store.loadStrategy(tag)
  assert.ok(row, `no strategy row for ${tag}`)
  return row
}

itMongo('every daily payload registers, and every row lands stopped and paper', async () => {
  for (const b of planBooks(EXPIRIES, TRADING_DAY)) {
    const res = await post('/v1/desk/books/registry', b)
    assert.equal(res.status, 201, `${b.tag}: ${JSON.stringify(res.body)}`)
    assert.equal(res.body['mode'], 'paper')
    // Registering is never itself a trading permission — the script's second
    // call is what starts a book, and it is a separate, deliberate act.
    assert.equal(res.body['desired'], 'stopped')
    assert.equal(res.body['actual'], 'stopped')
    // The stated series lands on the row the registry answers with.
    assert.equal(res.body['series'], b.series)
  }
  assert.equal((await store.listBooks('paper')).length, planBooks(EXPIRIES, TRADING_DAY).length)
  assert.equal((await store.listBooks('live')).length, 0, 'nothing reached the live registry')
})

itMongo('the resolved day budget is what arms the day guard, per preset', async () => {
  // Registering a delta-lean book arms the desk's day guard off the RESOLVED
  // `dl_day_max_loss`. Since R1 of the 2026-10-04 review (applied 2026-10-05)
  // it IS a per-preset number — 30,000 aggressive, 15,000 conservative — so
  // the two presets arm at different stops, and that is worth pinning: a
  // preset-name-only row could not have resolved either.
  for (const b of planBooks(EXPIRIES, TRADING_DAY)) await post('/v1/desk/books/registry', b)

  const agg = await strategy(AGGRESSIVE_TAG)
  assert.equal(isArmed(agg), true, 'the companion row must be one runGuards actually looks at')
  assert.equal(agg.dailyLimits?.stop, guardStopFor(DEFAULT_DIALS.dl_day_max_loss))
  assert.equal(agg.dailyLimits?.stop, 45_000, '1.5 x 30,000, restated so a drift shows here')

  const cons = await strategy(CONSERVATIVE_TAG)
  assert.equal(cons.dailyLimits?.stop, 23_000, '1.5 x 15,000 = 22,500, rounded UP to the next 1,000')
  // A stop, never a target: the guard is a backstop on the LOSS.
  assert.equal(cons.dailyLimits?.target, undefined)

  // The zero books' ₹20,000 backstop (zero spec §4): 1.5 x is 30,000 exactly.
  for (const tag of ['NIFTY-delta-lean-zero-2026-09-22', 'NIFTY-delta-lean-zero-0dte-2026-09-22']) {
    const zero = await strategy(tag)
    assert.equal(zero.dailyLimits?.stop, 30_000, tag)
  }
})

itMongo('create-then-start is what puts a book on the desk, and start names its mode', async () => {
  const [first] = planBooks(EXPIRIES, TRADING_DAY)
  assert.ok(first !== undefined)
  await post('/v1/desk/books/registry', first)

  // The mode is required IN THE BODY of the start. A start that omits it 400s,
  // so a script that forgot it would register four books and start none —
  // silently, if nobody checked the status.
  const noMode = await post(`/v1/desk/books/registry/${first.tag}/start`, {})
  assert.equal(noMode.status, 400)

  const started = await post(`/v1/desk/books/registry/${first.tag}/start`, { mode: 'paper' })
  assert.equal(started.status, 200)
  assert.equal(started.body['desired'], 'running')
  assert.equal(started.body['mode'], 'paper')

  // Starting a book nudges the supervisor with kind registry — load-bearing
  // for the sink above, not just a silencer (see ./nudge-sink.ts). The
  // refused no-mode 400 above must not have nudged anything.
  assert.ok(sink !== null)
  assert.equal(sink.nudges.length, 1, 'starting a book did not nudge the supervisor')
  assert.equal(sink.nudges[0]?.['kind'], 'registry')
  assert.equal(sink.nudges[0]?.['tag'], first.tag)
})

itMongo('re-running the script over books that already exist converges, it does not 409', async () => {
  // The script is meant to be re-runnable: same expiry, same presets, run
  // twice. An identical re-register returns 200 on the existing row rather
  // than refusing, so a half-finished run can simply be repeated.
  for (const b of planBooks(EXPIRIES, TRADING_DAY)) assert.equal((await post('/v1/desk/books/registry', b)).status, 201)
  for (const b of planBooks(EXPIRIES, TRADING_DAY)) {
    const again = await post('/v1/desk/books/registry', b)
    assert.equal(again.status, 200, `${b.tag}: ${JSON.stringify(again.body)}`)
  }
  assert.equal((await store.listBooks('paper')).length, 7, 'still seven rows, not fourteen')
})

itMongo('the hold pair registers, and the dial survives the registry round trip — so the roll can tell it apart', async () => {
  // The roll decides "hold book" from the dial ON THE ROW it reads back. A
  // registry that dropped the key, or a boolean it could not store, would turn
  // a week-long book into a daily one at the next morning's roll.
  for (const b of planHoldBooks(HOLD_TUE_EXPIRIES, HOLD_TUE)) {
    const res = await post('/v1/desk/books/registry', b)
    assert.equal(res.status, 201, `${b.tag}: ${JSON.stringify(res.body)}`)
    assert.equal(res.body['mode'], 'paper')
    assert.equal(res.body['desired'], 'stopped')
    assert.equal(res.body['series'], b.series)
    const row = await store.getBook(b.tag, 'paper')
    assert.ok(row !== null)
    assert.equal(row.variant, b.variant)
    assert.equal(row.expiry, '2026-10-08')
    assert.equal(row.dials['dl_hold_to_expiry'], true)
    assert.equal(isHold(row), true, `${b.tag} did not read back as a hold book`)
    // Armed like any delta-lean book, off its column's resolved number —
    // 30,000 / 15,000 since R1, a book-life line on a hold book.
    const s = await strategy(b.tag)
    assert.equal(isArmed(s), true)
    assert.equal(s.dailyLimits?.stop, b.variant === 'delta-lean-hold-aggressive' ? 45_000 : 23_000, b.tag)
  }
  // And a second create of the same pair converges rather than 409s.
  for (const b of planHoldBooks(HOLD_WED_EXPIRIES, HOLD_WED).filter((b) => b.symbol === 'SENSEX')) {
    assert.equal((await post('/v1/desk/books/registry', b)).status, 200, b.tag)
  }
  assert.equal((await store.listBooks('live')).length, 0, 'nothing reached the live registry')
})

itMongo("the nine playbook payloads of 10-22 register stopped and paper, read back as playbooks, and arm the day guard off each preset's budget", async () => {
  // The roll decides "playbook book" from the row it reads back: the variant,
  // `delta_lean_enabled` and `pb_playbook` all have to survive the registry.
  // The desk's stop sits at 1.5 x each preset's own `dl_day_max_loss`, rounded
  // up to the next 1,000 — spec §8.2's "desk guard" row, restated here.
  const guard: Readonly<Record<string, number>> = {
    'pb-trend-drive': 14_000,
    'pb-wing-straddle': 18_000,
    'pb-reversal': 14_000,
    'pb-expiry-drive': 9_000,
    'pb-expiry-theta': 12_000,
    'pb-expiry-gamma': 12_000,
  }
  const plans = planPlaybookBooks(masterSpy(PB_LISTED), '2026-10-22')
  assert.equal(plans.length, 9)
  for (const b of plans) {
    const res = await post('/v1/desk/books/registry', b)
    assert.equal(res.status, 201, `${b.tag}: ${JSON.stringify(res.body)}`)
    assert.equal(res.body['mode'], 'paper')
    assert.equal(res.body['desired'], 'stopped')
    assert.equal(res.body['series'], b.series)
    const row = await store.getBook(b.tag, 'paper')
    assert.ok(row !== null)
    assert.equal(row.expiry, b.expiry)
    assert.equal(row.dials['pb_playbook'], script.PLAYBOOK_PRESET_KEYS.indexOf(b.variant) + 1)
    assert.equal(row.dials['dl_open_lots'], 0)
    assert.equal(isPlaybook(row), true, `${b.tag} did not read back as a playbook book`)
    const s = await strategy(b.tag)
    assert.equal(isArmed(s), true, `${b.tag}'s day guard is not armed`)
    assert.equal(s.dailyLimits?.stop, guard[b.variant], b.tag)
    assert.equal(s.dailyLimits?.stop, guardStopFor(Number(b.dials['dl_day_max_loss'])))
  }
  assert.equal((await store.listBooks('live')).length, 0, 'nothing reached the live registry')
})
