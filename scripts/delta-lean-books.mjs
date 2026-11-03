/**
 * TODAY'S DAILY DELTA-LEAN PAPER BOOKS — NIFTY and SENSEX, aggressive,
 * conservative and zero, plus the 0-DTE zero book on a symbol's expiry
 * morning, and not one of them live.
 *
 * "THE FOUR", wherever this file and `delta-lean-roll.mjs` still say it, is
 * this daily family: four books from 2026-09-15, six since the zero spec
 * (2026-10-17, `docs/superpowers/specs/2026-10-17-delta-lean-zero-design.md`
 * D3) and seven on an expiry morning. The rules are the family's, not the
 * count's — every one of them is planned, created, switched on and retired
 * exactly as the first four were.
 *
 * This is the only artefact that says what those four registry rows ARE.
 * There is no CLI path for a registry row: creation is HTTP, three calls per
 * book — `POST /v1/desk/books/registry` with a `BookCreate` body, which
 * always lands `desired: 'stopped'`, then `POST /v1/desk/books/registry/:tag/start`,
 * then `PATCH /v1/desk/strategies/:tag` to flip the paper switch on. Doing
 * that by hand four times is four chances to fat-finger an expiry, a preset
 * or a mode; doing it from here is reproducible, reviewable before it happens,
 * and re-runnable after a half-finished attempt.
 *
 *     node scripts/delta-lean-books.mjs             # dry run — prints, creates nothing
 *     node scripts/delta-lean-books.mjs --json      # the exact four request bodies
 *     node scripts/delta-lean-books.mjs --apply     # create, start, switch on, each book
 *     node scripts/delta-lean-books.mjs --help
 *
 * `docs/runbooks/delta-lean-paper.md` is the procedure this script sits in the
 * middle of, including what to run first and what to watch afterwards. The
 * cron path is `scripts/delta-lean-roll.mjs`, which performs exactly this
 * every trading morning and then retires the previous days' books.
 *
 * ── ONE BOOK PER TRADING DAY ────────────────────────────────────────────────
 *
 * A delta-lean book lives ONE trading day (spec D1). The tag names the day and
 * the preset — `NIFTY-delta-lean-aggressive-2026-09-22` — so each morning's
 * four are NEW rows, yesterday's page is one clean day of orders and reasons,
 * and nothing accumulates on a row for a week. `symbol` and `expiry` are
 * fields on the row; the tag carries neither and nothing anywhere parses it.
 *
 * The expiry is the nearest weekly ON OR AFTER TODAY, today inclusive.
 * `nearestExpiry` uses `>=`, and it is asked for today: expiry day is traded
 * like any other (D6), and a book that lives one session has no tomorrow to
 * protect — a contract expiring today is exactly what a book born today
 * should hold. (The old weekly book asked for tomorrow so it would not spend
 * its first session rolling; that reason is gone with the weekly book.)
 *
 * The trading day is an ARGUMENT to `planBooks`, never defaulted from the
 * clock: a plan whose day moves with `Date.now()` cannot be tested, and a
 * script that guessed could register tomorrow's tag on a hand run after
 * 18:30 UTC. `main` resolves it once, from `istDate(Date.now())`.
 *
 * ── PAPER, AND THERE IS NO FLAG THAT SAYS OTHERWISE ─────────────────────────
 *
 * The one thing this script must never do is create a live row. Decision D10
 * ends the delivery in paper; live enablement is a separate decision after the
 * paper run. So `mode` is not a parameter anywhere — not an argument, not an
 * environment variable, not a field a caller may pass in. It is the constant
 * `PAPER` below, written into every payload by `planBooks`, re-checked by
 * `assertAllPaper` before anything is printed, and re-checked AGAIN on each
 * payload in the line before its POST. The refusal is a throw that exits 1: a
 * warning printed above four books being created is not a guard.
 *
 * An unrecognised flag is a hard error for the same reason — `--mode live`
 * must fail, not be ignored on its way to a run that does something else.
 *
 * ── THE SWITCH IS FLIPPED ON AFTER EVERY START ──────────────────────────────
 *
 * Registering a book has landed its tag in `desk-strategies` with
 * `modes.paper.enabled: false` (`addStrategyMode`); the API may come to land
 * it `true` for a fresh delta-lean paper row, but this script does not depend
 * on which. A book that is `desired: running` but switched off is the worst
 * of both: the supervisor decides all day and every order is refused INVALID
 * — 348 + 270 + 217 red rows across three books from 09-16 to 09-18 (spec
 * E3), and the memory note "purged book comes back switched off". So the
 * third call of every apply is `PATCH /v1/desk/strategies/:tag { modes: {
 * paper: { enabled: true } } }`, unconditionally — belt and braces, sent
 * after every start regardless of what the create landed, and not to be
 * removed on the day the create path starts doing it too — and a PATCH that
 * does not answer 200 aborts the run: a 400 "not added" or a 404 means the
 * create did not land its strategy row, which is a fault to see, not a book
 * to leave half-born. The PATCH is idempotent and paper is not
 * password-gated (`routes/desk.ts`).
 *
 * ── THE EXPIRIES COME FROM THE INSTRUMENT MASTER ────────────────────────────
 *
 * `INDEX_UNDERLYINGS` (`packages/instruments/src/index.ts`) says NIFTY expires
 * on a Thursday and its lot is 75. Both are stale — Tuesday, 65 — and that
 * table's own comment says so. Everything here reads `OptionMaster`, built from
 * the synced dump, which is why `make sync` is step one of the runbook and why
 * this script refuses rather than guesses when the dump does not list a symbol.
 *
 * ── AND THE WEEKLY PAIR, WHICH ONLY THE ROLL CREATES ────────────────────────
 *
 * `planHoldBooks` plans the hold-to-expiry sibling (spec 2026-10-05): per
 * symbol, the aggressive and conservative columns plus `dl_hold_to_expiry:
 * true`, tagged by the CONTRACT (`SENSEX-delta-lean-hold-aggressive-2026-10-08`)
 * and created the first morning that contract is the front one — never on
 * the morning it expires. `isHold` is the one membership test, by that dial.
 * This script's own `--apply` registers the daily four only; the hold pair is
 * created, and retired after its expiry, by `scripts/delta-lean-roll.mjs`.
 *
 * ── AND THE PLAYBOOKS, A THIRD FAMILY, WHICH ONLY THE ROLL CREATES ──────────
 *
 * `planPlaybookBooks` plans the six-playbooks family (spec 2026-10-16 §4.9):
 * per symbol, the six `pb-*` presets — delta-lean books whose `pb_playbook`
 * hands them to the playbook frame. Like the four, one row per preset per
 * TRADING DAY, tagged by the day (`NIFTY-pb-trend-drive-2026-10-19`) and
 * retired the morning after. Unlike the four, each preset picks its OWN
 * contract, so one symbol's playbooks can sit on three expiries at once —
 * which is why they are never folded into the four's plan, whose one target
 * expiry per symbol is a coherence check:
 *
 *   - THE THREE INTRADAY PRESETS, every day, each on the nearest listed
 *     contract with at least its `pb_min_dte` TRADING days to go
 *     (`tradingDaysToExpiry`: the sessions after today up to and including
 *     the expiry, holidays out). Their `pb_min_dte` is at least 1, so they
 *     never hold the contract dying today.
 *   - THE THREE EXPIRY PRESETS (`pb_expiry_day_only`), only on a morning
 *     whose front contract expires TODAY, and never before
 *     `PLAYBOOK_EXPIRY_FROM` — the date is the gate, and one line moves it.
 *
 * `isPlaybook` is the one membership test, and it reads the DIALS —
 * `delta_lean_enabled` and `pb_playbook` — never the list of presets:
 * removing a key from `PLAYBOOK_PRESET_KEYS` stops the roll creating that
 * preset, and the rows it left are still the family's to retire. As with the
 * hold pair, this script's own `--apply` registers the daily four only.
 *
 * ── AND ONE SERIES CAN BE SWITCHED OFF ──────────────────────────────────────
 *
 * `SERIES_OFF` names series (`SENSEX-pb-reversal`) that are planned with their
 * family and then not created — by the roll, and by this script's `--apply`
 * (`withoutSeriesOff`). It never decides what a row on file is, so the rows
 * such a series already left retire as usual.
 *
 * ── THE PRESET IS RESOLVED, NOT REFERENCED ──────────────────────────────────
 *
 * A preset is a one-time PREFILL copied into the book's own dials. It is never
 * a runtime indirection: nothing re-reads `PRESETS` for a running book, and the
 * `variant` field is a label for the supervisor, not a dial lookup.
 *
 * That matters most for the AGGRESSIVE preset, whose own dial-set is only its
 * base — `DEFAULT_DIALS` already IS spec §4's aggressive column, so the preset
 * deliberately does not restate it. A row carrying only that base would
 * therefore resolve nine-tenths of its behaviour against the engine default
 * every time it is read, and would MOVE the day that default moves, silently,
 * on a book that is running. So `resolveDials` folds the preset onto the
 * defaults here, once, and the payload carries every `DEFAULT_DIALS` key (85
 * today). The row is then a complete statement of what the book does, which
 * is the same argument `apps/web/src/book-build.tsx` makes for copying a
 * preset into a created book rather than pointing at it.
 *
 * `resolveDials` also REPORTS what it refused. A preset key the engine no
 * longer reads would otherwise be posted, stored, and quietly ignored, which is
 * an operator who believes they set a limit they did not set.
 *
 * ── WHAT THIS SCRIPT DOES NOT DO ────────────────────────────────────────────
 *
 * It does not arm the day guard: registering a book whose dials turn the
 * delta-lean path on does that already, off the resolved `dl_day_max_loss`
 * (`apps/api/src/routes/books.ts`). It does not write `lot_size` as a dial —
 * that was never an engine dial and the lot comes off the chain. It does not
 * sync instruments, subscribe a feed, or start the desk. It does not retire
 * yesterday's books — that is the roll's job, and the roll calls this first.
 *
 * Tested by `apps/api/test/delta-lean-registration.test.ts`, which imports
 * the pure functions directly — they hold no handles, so the suite exercises
 * them without Mongo and without HTTP. Everything that touches a database or a
 * socket lives below `main()` and is imported lazily there, so importing this
 * module costs nothing.
 */

import { fileURLToPath } from 'node:url'
import { resolve as resolvePath } from 'node:path'
import { resolveDials } from '@algomaker/desk-engine/dials'
import { isTradingDay, tradingDaysToExpiry } from '@algomaker/desk-engine'
import { presetDials } from '../apps/web/src/dials-plan.ts'

// ─────────────────────────────────────────────────────────────── the constants

/**
 * The only mode this script can produce. Not a parameter, not a default —
 * a constant, so that "create a live book" is not a state this program has.
 */
const PAPER = 'paper'

/**
 * The two underlyings, and the key each one answers to in an `Expiries` record.
 *
 * BANKNIFTY is deliberately absent: it is monthly only, so it has no weekly
 * expiry for this book to trade (spec §12).
 */
const SYMBOLS = [
  { symbol: 'NIFTY', key: 'nifty' },
  { symbol: 'SENSEX', key: 'sensex' },
]

/**
 * THE DAILY FAMILY, by preset key in `packages/desk-engine/src/presets.ts`:
 * spec §9's two columns, then the zero spec's two (2026-10-17) — the tuned
 * conservative book and its 0-DTE trend-down sibling. Every one is a book a
 * DAY per symbol, created and retired by exactly the same rules; the 0-DTE
 * one is planned only on its symbol's expiry morning (`EXPIRY_DAY_DIAL`).
 */
const PRESET_KEYS = ['delta-lean-aggressive', 'delta-lean-conservative', 'delta-lean-zero', 'delta-lean-zero-0dte']

/**
 * The dial that makes a daily book an EXPIRY-DAY book (zero spec D4): the
 * engine opens it only when today is its contract's expiry, so `planBooks`
 * plans it only for a symbol whose expiry IS the trading day. Membership by
 * the dial, never by the key — as `HOLD_DIAL` and `PLAYBOOK_DIAL` are.
 */
const EXPIRY_DAY_DIAL = 'dl_expiry_day_only'

/**
 * The hold-to-expiry family (spec 2026-10-05): the same two columns, held from
 * the first trading day whose front contract is new until that contract's
 * expiry (or an earlier book target). These are the `variant` keys; the
 * engine branch declares presets under the same names.
 */
const HOLD_PRESET_KEYS = ['delta-lean-hold-aggressive', 'delta-lean-hold-conservative']

/**
 * The ONE dial that makes a delta-lean book a hold book, and the only thing
 * anything here reads to decide membership of that family — never the tag,
 * and never the variant on its own.
 */
const HOLD_DIAL = 'dl_hold_to_expiry'

/**
 * Each hold column and the intraday column whose numbers it carries. A hold
 * book's dials are that intraday preset, resolved exactly as `planBooks`
 * resolves it, plus `dl_hold_to_expiry: true` — see `holdDialsFor`.
 * @type {Readonly<Record<string, string>>}
 */
const HOLD_COLUMN = Object.freeze({
  'delta-lean-hold-aggressive': 'delta-lean-aggressive',
  'delta-lean-hold-conservative': 'delta-lean-conservative',
})

/**
 * The dial that SELECTS the delta-lean decide path. Nothing else branches on
 * anything else (runbook, the table at the top), which is why membership of
 * every delta-lean family turns on it — the four and the hold pairs by this
 * dial and the variant together, the playbooks by this dial and
 * `pb_playbook` (`isPlaybook`). The roll imports it from here, so the two
 * scripts cannot spell it differently.
 */
const LEAN_DIAL = 'delta_lean_enabled'

/**
 * The six playbooks (spec 2026-10-16 §5), by their preset key in
 * `packages/desk-engine/src/presets.ts`, in spec order — which is
 * `pb_playbook` 1 to 6: three intraday, then three expiry-day.
 *
 * What the roll CREATES each morning — never what makes a row a playbook
 * book (`isPlaybook` reads the dials). Removing a key here is how runbook
 * §8.4 switches a preset off: from the next 08:50 run it is not created,
 * and the rows it already has are retired the morning after their day like
 * any other playbook row.
 */
const PLAYBOOK_PRESET_KEYS = [
  'pb-trend-drive',
  'pb-wing-straddle',
  'pb-reversal',
  'pb-expiry-drive',
  'pb-expiry-theta',
  'pb-expiry-gamma',
]

/**
 * The dial that hands a delta-lean book to the playbook frame: 0 is none,
 * 1-6 select spec §5.1-§5.6. Read by `isPlaybook` together with `LEAN_DIAL`
 * — never on its own, and never off the tag.
 */
const PLAYBOOK_DIAL = 'pb_playbook'

/**
 * THE FIRST DAY THE THREE EXPIRY PRESETS MAY BE CREATED (spec §4.9, §10).
 *
 * The first playbook session, Monday 2026-10-19 (NIFTY's expiry, moved up by
 * Dussehra), runs the intraday presets alone, so the first expiry books are
 * SENSEX's on Thursday the 22nd. A date, not a flag: the operator moves it
 * here, in one line, and the roll's plan says what it did either way.
 */
const PLAYBOOK_EXPIRY_FROM = '2026-10-21'

/**
 * SERIES SWITCHED OFF — per symbol, by the `series` every plan carries
 * (`${symbol}-${variant}`). The families above are planned in full; these are
 * then dropped before anything is created (`withoutSeriesOff`), by the roll
 * and by `--apply` below alike.
 *
 * The 30 Oct 2026 review of the paper record since 19 Oct (the last fill-model
 * change) found each of these losing: SENSEX conservative −9,153, SENSEX zero
 * −6,060, Trend Drive −4,914 / −9,448 (0 of 9 days), Wing Straddle −5,457 /
 * −3,584, SENSEX Reversal −6,712 (NIFTY's, +3,562, stays), and every recorded
 * day of the three expiry playbooks a loss.
 *
 * It stops CREATION only. A row already on file is retired the morning after
 * its day by the usual membership rules (the variant and `delta_lean_enabled`,
 * `isPlaybook`), which read the dials and never this list: flat → erased,
 * holding → ALARM, like any other row. Deleting a line turns that series back
 * on from the next 08:50 roll. Never switch off every daily series of one
 * symbol: the roll withholds a symbol's daily retire while it has no book of
 * today (`planRoll`'s coverage rule), so its old rows would ALARM instead.
 */
const SERIES_OFF = Object.freeze([
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
])

/**
 * The dials an operator checks before letting four books loose — the SPAN
 * cap, the two day numbers, the size, and how rarely the book may act.
 * Printed in full on a dry run; the rest are in the payload either way and
 * `--json` prints them.
 */
const HEADLINE_DIALS = [
  'delta_lean_enabled',
  'margin_cap',
  'dl_day_max_loss',
  'dl_day_target',
  'dl_open_lots',
  'dl_max_adjusts_day',
  'dl_adjust_cooldown_s',
  'dl_stuck_loss',
  'dl_warmup_min',
  // When, and on which day, the zero books may open (zero spec D4) — 0 / false
  // on the other daily books, which open as they always did.
  'dl_open_by_min',
  'dl_expiry_day_only',
  'dl_flat_by_min',
  'confirm_ms',
  'cooldown_s',
  'chase_max_ms',
]

const REGISTRY = '/v1/desk/books/registry'
/** The strategy switches — where the paper on/off flag of a tag lives. */
const STRATEGIES = '/v1/desk/strategies'
/**
 * The one patch this script sends: the paper switch, on. Frozen, so no caller
 * can turn it into a live switch by mutation; `routes/desk.ts` would demand a
 * password for that anyway, and the machine token has none.
 */
const PAPER_ON = Object.freeze({ modes: Object.freeze({ paper: Object.freeze({ enabled: true }) }) })
const DEFAULT_API = 'http://127.0.0.1:8890'
const DEFAULT_MONGO = 'mongodb://127.0.0.1:27017/algomaker_dx'

/**
 * @typedef {{ nifty: string, sensex: string }} Expiries
 * @typedef {Record<string, number | boolean>} DialRecord
 * @typedef {{ tag: string, symbol: string, expiry: string, mode: string, variant: string, series: string, dials: DialRecord }} BookPlan
 * @typedef {{ nearestExpiry(underlying: string, onOrAfter: string): string | null }} MasterLike
 */

// ───────────────────────────────────────────────────────────────── pure logic

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/**
 * `dateIst` as a UTC-midnight `Date`, or a throw when it is not a date.
 *
 * Every calendar step below goes through here, so that '2026-9-22' and
 * '2026-13-45' are refused in one place rather than each becoming a `NaN`
 * that compares false against everything and quietly retires nothing.
 *
 * @param {string} dateIst `YYYY-MM-DD`
 * @returns {Date}
 */
function utcMidnight(dateIst) {
  if (!ISO_DATE.test(dateIst)) throw new Error(`not an IST date: ${JSON.stringify(dateIst)}`)
  const d = new Date(`${dateIst}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) throw new Error(`not an IST date: ${dateIst}`)
  return d
}

/**
 * The IST calendar date one day before `dateIst`.
 *
 * Done in UTC on a date-only string rather than with local-time arithmetic:
 * `setUTCDate` rolls the month and the year for us, and there is no hour in
 * play for a DST-free zone to move. A naive `-1` on the day field produces
 * '2026-10-00'.
 *
 * @param {string} dateIst `YYYY-MM-DD`
 * @returns {string}
 */
export function yesterdayIst(dateIst) {
  const d = utcMidnight(dateIst)
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10)
}

/**
 * The IST calendar date one day after `dateIst` — `yesterdayIst`'s mirror,
 * by the same UTC arithmetic. The playbook contract walk asks the master for
 * the first contract on or after the day after the one it passed over.
 *
 * @param {string} dateIst `YYYY-MM-DD`
 * @returns {string}
 */
export function dayAfterIst(dateIst) {
  const d = utcMidnight(dateIst)
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}

/**
 * The most recent NSE trading day STRICTLY BEFORE `dateIst`.
 *
 * Walks back one calendar day at a time until the engine's own calendar says
 * yes — the same `isTradingDay` the supervisor gates on, so the roll and the
 * desk agree about which day was a session. The session before a Monday is
 * Friday; the one before Tuesday 2026-09-15 is Friday the 11th, because the
 * 14th was Ganesh Chaturthi.
 *
 * It WAS the roll's erase cutoff (one session visible as "stopped" before a
 * book vanished). Since 2026-10-05 the roll's cutoff is today itself — a
 * finished book is stopped and erased the morning after its session — so
 * the roll no longer calls this; it stays as the calendar walk, tested.
 *
 * CAPPED at ten days. The NSE has never closed for ten consecutive days, and
 * the engine's calendar fails OPEN on a year it does not cover, so a walk
 * that gets that far is a bug (or an `isTrading` stub that always says no),
 * not a long holiday — and the answer must be a throw, not an ever-older
 * cutoff that quietly erases nothing. `isTrading` is a parameter only so that
 * cap can be tested; production never passes it.
 *
 * @param {string} dateIst `YYYY-MM-DD`
 * @param {(dateIst: string) => boolean} [isTrading]
 * @returns {string}
 */
export function previousTradingDay(dateIst, isTrading = isTradingDay) {
  utcMidnight(dateIst) // validate the shape before walking anywhere
  let day = dateIst
  for (let steps = 0; steps < 10; steps += 1) {
    day = yesterdayIst(day)
    if (isTrading(day)) return day
  }
  throw new Error(
    `no trading day found in the 10 days before ${dateIst} — the calendar in ` +
      '@algomaker/desk-engine (session.ts) is not answering; refusing to guess a cutoff',
  )
}

/**
 * `YYYY-MM-DD` in IST — the shape every expiry on this desk is written in.
 *
 * It matters that this is IST and not UTC. The box's clock is UTC and the
 * roll's cron fires at 03:20 UTC, which is 08:50 the SAME IST day — but a run
 * by hand after 18:30 UTC has already crossed into the next IST day, and the
 * tag, the expiry and the erase cutoff all ask about the IST date.
 *
 * @param {number} ms epoch ms
 * @returns {string}
 */
export function istDate(ms) {
  return new Date(ms + (5 * 60 + 30) * 60_000).toISOString().slice(0, 10)
}

/**
 * The nearest weekly expiry for each symbol ON OR AFTER `tradingDay`, today
 * inclusive.
 *
 * Reads the instrument master and nothing else — no weekday table, no
 * hardcoded Tuesday or Thursday. `nearestExpiry` matches `>=`, and it is asked
 * for today: expiry day is traded (D6) and a daily book has no tomorrow to
 * protect, so a contract expiring today is the one a book born today holds.
 *
 * Throws, naming `make sync`, when the dump lists no expiry on or after that
 * day for a symbol: the alternative is a book registered against `null`, or
 * against whatever a fallback table happened to say.
 *
 * @param {MasterLike} master
 * @param {string} tradingDay `YYYY-MM-DD`
 * @returns {Expiries}
 */
export function expiriesFrom(master, tradingDay) {
  if (typeof tradingDay !== 'string' || !ISO_DATE.test(tradingDay)) {
    throw new Error(`the trading day must be a 'YYYY-MM-DD' date, got ${JSON.stringify(tradingDay)}`)
  }
  const onOrAfter = tradingDay
  /** @type {Record<string, string>} */
  const out = {}
  for (const { symbol, key } of SYMBOLS) {
    const expiry = master.nearestExpiry(symbol, onOrAfter)
    if (expiry === null || expiry === undefined) {
      throw new Error(
        `the instrument dump lists no ${symbol} expiry on or after ${onOrAfter} — ` +
          'run `make sync` and try again (this script never falls back to a weekday rule: ' +
          "INDEX_UNDERLYINGS' NIFTY weekday and lot size are both stale)",
      )
    }
    if (!ISO_DATE.test(expiry)) {
      throw new Error(`the master returned ${JSON.stringify(expiry)} as the ${symbol} expiry`)
    }
    out[key] = expiry
  }
  return /** @type {Expiries} */ ({ nifty: out['nifty'], sensex: out['sensex'] })
}

/**
 * Every book that is not paper, as a hard failure.
 *
 * Returns the books so a caller can write `assertAllPaper(planBooks(...))` and
 * have the guard be on the path rather than beside it.
 *
 * @param {readonly BookPlan[]} books
 * @returns {readonly BookPlan[]}
 */
export function assertAllPaper(books) {
  const bad = books.filter((b) => b.mode !== PAPER)
  if (bad.length > 0) {
    throw new Error(
      `REFUSED: ${bad.length} of ${books.length} planned books are not paper — ` +
        bad.map((b) => `${b.tag} (mode ${JSON.stringify(b.mode)})`).join(', ') +
        '. This script registers PAPER books only (decision D10); going live is a separate ' +
        'decision made after the paper run, through the Books page.',
    )
  }
  return books
}

/**
 * The four `BookCreate` payloads for one trading day: two symbols times two
 * presets.
 *
 * Pure. No clock, no network, no master — the expiries are handed in already
 * resolved (see `expiriesFrom`) and the trading day is an argument, so the
 * plan can be tested, printed and diffed without a database and without
 * depending on when the test runs.
 *
 * Each payload is EXACTLY what goes on the wire: no extra fields, and in
 * particular no `desired` or `actual`, which `validateBookCreate` refuses
 * outright. A book is always created stopped and started by a second call.
 *
 * A preset whose dials carry `EXPIRY_DAY_DIAL` is planned only for a symbol
 * whose expiry IS `tradingDay` — the 0-DTE book on NIFTY's Tuesday and
 * SENSEX's Thursday, and on no other morning. The engine refuses to open it on
 * any other day anyway; this keeps a book that could never trade off the desk.
 * So the plan is six books on most mornings and seven on an expiry morning
 * (eight on one both symbols share).
 *
 * @param {Expiries} expiries
 * @param {string} tradingDay `YYYY-MM-DD` — the day these books live
 * @returns {readonly BookPlan[]}
 */
export function planBooks(expiries, tradingDay) {
  if (typeof tradingDay !== 'string' || !ISO_DATE.test(tradingDay)) {
    // Never defaulted: a plan whose day came from the clock cannot be tested,
    // and a hand run after 18:30 UTC would register tomorrow's tag.
    throw new Error(`the trading day must be a 'YYYY-MM-DD' date, got ${JSON.stringify(tradingDay)}`)
  }
  /** @type {BookPlan[]} */
  const books = []
  for (const { symbol, key } of SYMBOLS) {
    const expiry = /** @type {Record<string, unknown>} */ (expiries)[key]
    if (typeof expiry !== 'string' || !ISO_DATE.test(expiry)) {
      throw new Error(`expiries.${key} must be a 'YYYY-MM-DD' date, got ${JSON.stringify(expiry)}`)
    }
    for (const variant of PRESET_KEYS) {
      const dials = dialsFor(variant)
      if (dials[EXPIRY_DAY_DIAL] === true && expiry !== tradingDay) continue
      books.push({
        // The tag is the book's key AND the order-bus tag every decision
        // arrives under. It names the book's DAY and its preset — one row per
        // trading day (D1) — and nothing parses it: `symbol` and `expiry`
        // are fields on the row, which is why the SENSEX books can carry
        // Thursday's expiry under a tag ending in Tuesday's date. Letters,
        // digits, hyphen only — the registry's own charset.
        tag: `${symbol}-${variant}-${tradingDay}`,
        symbol,
        expiry,
        mode: PAPER,
        variant,
        // The name every day's book of this symbol and preset reports under
        // (WS2): the tag changes daily, the series does not. Sent explicitly
        // rather than left to the API's identical default, so the registry
        // row says what this script meant. An API that predates `series`
        // ignores the field.
        series: `${symbol}-${variant}`,
        dials,
      })
    }
  }
  return assertAllPaper(books)
}

/**
 * The HOLD-TO-EXPIRY pair per symbol for the front contract, when that
 * contract does not die today.
 *
 * For each symbol, `E` is the expiry `expiriesFrom` answered for today — the
 * nearest listed contract on or after today. When `E` IS today there is no
 * hold book to create: a book born on a contract that expires this afternoon
 * would live one session, which is what the intraday book already does. So
 * the pair for a new contract is created the first trading day whose front
 * expiry is that contract — the morning after the previous one expired — and
 * on every later morning the same tags come out again, which the roll reads
 * as "already on the desk". A missed morning is not lost: the next one
 * creates the pair with fewer days left.
 *
 * The tag names the CONTRACT, not the day — `NIFTY-delta-lean-hold-aggressive-2026-10-13`
 * — because one row lives the whole week. The series is the usual
 * `${symbol}-${variant}`, so the Reports page groups the weeks. As with the
 * daily books, nothing ever parses the tag.
 *
 * Pure, like `planBooks`: the expiries and the day are arguments.
 *
 * @param {Expiries} expiries
 * @param {string} today `YYYY-MM-DD` — the morning the roll runs
 * @returns {readonly BookPlan[]}
 */
export function planHoldBooks(expiries, today) {
  if (typeof today !== 'string' || !ISO_DATE.test(today)) {
    throw new Error(`the trading day must be a 'YYYY-MM-DD' date, got ${JSON.stringify(today)}`)
  }
  /** @type {BookPlan[]} */
  const books = []
  for (const { symbol, key } of SYMBOLS) {
    const expiry = /** @type {Record<string, unknown>} */ (expiries)[key]
    if (typeof expiry !== 'string' || !ISO_DATE.test(expiry)) {
      throw new Error(`expiries.${key} must be a 'YYYY-MM-DD' date, got ${JSON.stringify(expiry)}`)
    }
    if (expiry < today) {
      // `expiriesFrom` never answers one; a plan that carries one is
      // incoherent, and a hold book on a dead contract is not a book.
      throw new Error(`expiries.${key} is ${expiry}, before ${today} — refusing to plan a hold book on a dead contract`)
    }
    // The contract dies today: its hold pair (if any) carries to the close,
    // and the next contract's pair is created tomorrow morning.
    if (expiry === today) continue
    for (const variant of HOLD_PRESET_KEYS) {
      books.push({
        tag: `${symbol}-${variant}-${expiry}`,
        symbol,
        expiry,
        mode: PAPER,
        variant,
        series: `${symbol}-${variant}`,
        dials: holdDialsFor(variant),
      })
    }
  }
  return assertAllPaper(books)
}

/**
 * TODAY'S PLAYBOOK BOOKS — the third family (spec 2026-10-16 §4.9).
 *
 * For each symbol, and each of the six presets in spec order:
 *
 *   - an EXPIRY preset (`pb_expiry_day_only`) is planned only when the
 *     symbol's front contract — `nearestExpiry(symbol, today)` — IS today,
 *     and today is not before `PLAYBOOK_EXPIRY_FROM`. Its contract is
 *     today's. On any other morning it is simply not planned: an expiry
 *     preset on another contract is spec Review Focus 4's wrong contract;
 *   - an INTRADAY preset walks the listed contracts from the front one,
 *     each next one being `nearestExpiry(symbol, dayAfterIst(e))`, and takes
 *     the first with `tradingDaysToExpiry(today, e) >= pb_min_dte`.
 *
 * The dials are `dialsFor(variant)`, resolved exactly as the four's are, so
 * every row states `dl_open_lots: 0` (D9) and its own `pb_playbook`. The tag
 * names the DAY — one row per preset per trading day — and the series is the
 * usual `${symbol}-${variant}`.
 *
 * Pure like `planBooks`, with one difference: the master is handed in rather
 * than one resolved `Expiries` record, because each preset asks it its own
 * question (how far out). Every answer is checked — a date, and not before
 * the day asked — before it is walked, so a master that ignores its argument
 * is a throw, not a walk that stands still.
 *
 * Throws, naming `make sync` in `expiriesFrom`'s words, when no listed
 * contract is far enough out for an intraday preset: the alternative is a
 * book against `null` or a guessed weekday. The roll reads that throw as the
 * family's gate (`planPlaybookTargets`), never as a reason to leave the four
 * uncreated.
 *
 * @param {MasterLike} master
 * @param {string} today `YYYY-MM-DD` — the day these books live
 * @returns {readonly BookPlan[]}
 */
export function planPlaybookBooks(master, today) {
  if (typeof today !== 'string' || !ISO_DATE.test(today)) {
    throw new Error(`the trading day must be a 'YYYY-MM-DD' date, got ${JSON.stringify(today)}`)
  }
  /** @type {BookPlan[]} */
  const books = []
  for (const { symbol } of SYMBOLS) {
    const front = askExpiry(master, symbol, today)
    for (const variant of PLAYBOOK_PRESET_KEYS) {
      const dials = dialsFor(variant)
      let expiry
      if (dials['pb_expiry_day_only'] === true) {
        if (front !== today || today < PLAYBOOK_EXPIRY_FROM) continue
        expiry = today
      } else {
        expiry = contractWithSessions(master, symbol, today, front, variant, dials['pb_min_dte'])
      }
      books.push({
        tag: `${symbol}-${variant}-${today}`,
        symbol,
        expiry,
        mode: PAPER,
        variant,
        series: `${symbol}-${variant}`,
        dials,
      })
    }
  }
  return assertAllPaper(books)
}

/**
 * The plans whose series is NOT switched off (`SERIES_OFF`), in their order.
 * Pure. The one filter between a family's plan and a create: the roll passes
 * its daily, hold and playbook targets through it, and `--apply` below its
 * books. The planners stay whole — they define the families.
 *
 * @param {readonly BookPlan[]} plans
 * @param {readonly string[]} [off]
 * @returns {readonly BookPlan[]}
 */
export function withoutSeriesOff(plans, off = SERIES_OFF) {
  return plans.filter((p) => !off.includes(p.series))
}

/**
 * The series of `plans` that ARE switched off — exactly what
 * `withoutSeriesOff` drops, by name and in plan order — for the line that
 * says why fewer books were created.
 *
 * @param {readonly BookPlan[]} plans
 * @param {readonly string[]} [off]
 * @returns {string[]}
 */
export function seriesSwitchedOff(plans, off = SERIES_OFF) {
  return plans.filter((p) => off.includes(p.series)).map((p) => p.series)
}

/**
 * The master's nearest `symbol` contract on or after `onOrAfter`, or null
 * when it lists none. Refuses what is not a date, and a contract before the
 * day asked — the real `nearestExpiry` is `>=`, and the walk depends on it.
 *
 * @param {MasterLike} master
 * @param {string} symbol
 * @param {string} onOrAfter `YYYY-MM-DD`
 * @returns {string | null}
 */
function askExpiry(master, symbol, onOrAfter) {
  const expiry = master.nearestExpiry(symbol, onOrAfter)
  if (expiry === null || expiry === undefined) return null
  if (typeof expiry !== 'string' || !ISO_DATE.test(expiry)) {
    throw new Error(`the master returned ${JSON.stringify(expiry)} as the ${symbol} expiry`)
  }
  if (expiry < onOrAfter) {
    throw new Error(
      `the master returned ${expiry} as the ${symbol} expiry on or after ${onOrAfter} — a contract before the ` +
        'day asked; refusing to walk a master that does not answer the question it was asked',
    )
  }
  return expiry
}

/**
 * The first listed contract, from `front` on, with at least `minDte`
 * TRADING days to go — or a throw in `expiriesFrom`'s words.
 *
 * A contract that is not live (`tradingDaysToExpiry` -1) never qualifies,
 * whatever `minDte` says.
 *
 * @param {MasterLike} master
 * @param {string} symbol
 * @param {string} today
 * @param {string | null} front `askExpiry(master, symbol, today)`
 * @param {string} variant for the message
 * @param {number | boolean | undefined} minDte the preset's resolved `pb_min_dte`
 * @returns {string}
 */
function contractWithSessions(master, symbol, today, front, variant, minDte) {
  if (typeof minDte !== 'number' || !Number.isFinite(minDte) || minDte < 0) {
    // `resolveDials` hands every preset a number; anything else is the
    // preset and the schema drifting apart, not a contract to guess.
    throw new Error(`preset '${variant}' resolves pb_min_dte to ${JSON.stringify(minDte)} — not a count of trading days`)
  }
  for (let e = front; e !== null; e = askExpiry(master, symbol, dayAfterIst(e))) {
    const left = tradingDaysToExpiry(today, e)
    if (left >= 0 && left >= minDte) return e
  }
  throw new Error(
    `the instrument dump lists no ${symbol} expiry on or after ${today} with at least ${minDte} trading day(s) ` +
      `to go (${variant}'s pb_min_dte) — run \`make sync\` and try again (this script never falls back to a ` +
      "weekday rule: INDEX_UNDERLYINGS' NIFTY weekday and lot size are both stale)",
  )
}

/**
 * Is this registry row (or plan) a playbook book? BY ITS DIALS, read off the
 * row and never off its tag: `delta_lean_enabled` is `true` and `pb_playbook`
 * is a finite number of at least 1 — the two dials that hand a book to the
 * playbook frame (`engine-host.ts`: the delta-lean path, then
 * `pb_playbook > 0`). Absent is never a value: a row whose dials do not state
 * `pb_playbook` is not a playbook, whatever its variant says (the roll
 * reports such a half-member rather than guessing). Both are read the way
 * `resolveDials` folds them — a boolean `true`, a finite number; anything
 * else resolves to the engine's off-state — but without calling it, so a row
 * is still recognised on a checkout whose engine does not know `pb_playbook`,
 * where the roll gates the family and lists its rows instead of misreading
 * them.
 *
 * NOT `variant ∈ PLAYBOOK_PRESET_KEYS`. That list is what the roll CREATES
 * from, and runbook §8.4 switches a preset off by removing its key: the rows
 * that preset left must still be retired the morning after, not become
 * orphans no loop touches — trading on under an old tag if left running, an
 * exit 1 every morning if stopped. The variant is read for one thing only:
 * playbook dials under one of the four's or the hold pairs' presets
 * (`PRESET_KEYS`, `HOLD_PRESET_KEYS`) are a contradiction, not a playbook
 * book, and the roll reports that row too. Those rows themselves state
 * `pb_playbook: 0`, so this test never captures them.
 *
 * @param {{ variant?: unknown, dials?: unknown }} row
 * @returns {boolean}
 */
export function isPlaybook(row) {
  const dials = row.dials
  if (typeof dials !== 'object' || dials === null) return false
  const d = /** @type {Record<string, unknown>} */ (dials)
  const which = d[PLAYBOOK_DIAL]
  return (
    typeof row.variant === 'string' &&
    row.variant !== '' &&
    !PRESET_KEYS.includes(row.variant) &&
    !HOLD_PRESET_KEYS.includes(row.variant) &&
    d[LEAN_DIAL] === true &&
    typeof which === 'number' &&
    Number.isFinite(which) &&
    which >= 1
  )
}

/**
 * Does the engine ON DISK know `pb_playbook`? `engineKnowsHoldDial`'s test,
 * asked of the playbook dial. On a build without it every playbook row would
 * run as a plain delta-lean book — inert, since each preset states
 * `dl_open_lots: 0` (D9) — and `dialsFor` would refuse the presets anyway.
 * The roll asks this before it plans a single playbook row, and plans none
 * (loudly) when the answer is no; planning itself stays pure and does not ask.
 *
 * @returns {boolean}
 */
export function engineKnowsPlaybookDial() {
  return resolveDials({ [PLAYBOOK_DIAL]: 1 }).unknown.length === 0
}

/**
 * Is this registry row (or plan) a hold-to-expiry book? By the dial and
 * nothing else: `dials.dl_hold_to_expiry === true`. Absent, `false`, `1` or
 * `'true'` all read as no.
 *
 * @param {{ dials?: unknown }} row
 * @returns {boolean}
 */
export function isHold(row) {
  const dials = row.dials
  return typeof dials === 'object' && dials !== null && /** @type {Record<string, unknown>} */ (dials)[HOLD_DIAL] === true
}

/**
 * Does the engine ON DISK know `dl_hold_to_expiry`?
 *
 * The same test `dialsFor` applies to every preset dial — `resolveDials`
 * refuses a key the engine does not read — asked of the one dial
 * `holdDialsFor` adds by hand, which therefore never meets that refusal. A
 * supervisor on a build without the dial resolves it away and steers a hold
 * book as an intraday one: flat at 15:00 on day one, re-opened the next
 * morning under the weekly tag. The roll asks this before it plans a single
 * hold pair, and plans none (loudly) when the answer is no. Planning itself
 * stays pure and does not ask, so the payload can be built and pinned before
 * the engine ships the dial.
 *
 * @returns {boolean}
 */
export function engineKnowsHoldDial() {
  return resolveDials({ [HOLD_DIAL]: true }).unknown.length === 0
}

/**
 * A hold column's dials: its INTRADAY column, resolved exactly as `planBooks`
 * resolves it, plus `dl_hold_to_expiry: true`.
 *
 * Built from the intraday preset rather than looked up under the hold key, so
 * the roll does not depend on the engine having shipped the hold presets yet.
 * The engine declares each hold preset as that same column plus that same
 * dial, so once it has, `resolveDials(<hold preset>)` is this exact document —
 * `delta-lean-registration.test.ts` compares the two and fails on any drift.
 *
 * @param {string} holdVariant
 * @returns {DialRecord}
 */
function holdDialsFor(holdVariant) {
  const column = HOLD_COLUMN[holdVariant]
  if (column === undefined) {
    throw new Error(`no hold column named '${holdVariant}' — the hold presets are ${HOLD_PRESET_KEYS.join(' and ')}`)
  }
  return { ...dialsFor(column), [HOLD_DIAL]: true }
}

/**
 * One preset, folded onto the engine defaults, as a plain dial document.
 *
 * @param {string} variant
 * @returns {DialRecord}
 */
function dialsFor(variant) {
  const stated = presetDials(variant)
  if (stated === null) {
    throw new Error(
      `no preset named '${variant}' — this script registers three families: the daily ` +
        `${PRESET_KEYS.join(' and ')}, the hold-to-expiry ${HOLD_PRESET_KEYS.join(' and ')} ` +
        `(built from the daily columns), and the playbooks ${PLAYBOOK_PRESET_KEYS.join(', ')}`,
    )
  }
  const { dials, unknown } = resolveDials(stated)
  if (unknown.length > 0) {
    // A preset key the engine does not read would be posted, stored, and
    // ignored. That is an operator who set a limit that never applied.
    throw new Error(
      `preset '${variant}' states dials this engine refuses: ${unknown.join(', ')} — ` +
        'the preset and the dial schema have drifted apart; fix presets.ts before registering',
    )
  }
  return { ...dials }
}

/**
 * The lot size, strike step and exchange the master lists for one chain, for
 * the operator to read. NOT part of the payload: `lot_size` is not an engine
 * dial (see `book-build.tsx`), the lot comes off the chain at decide time.
 *
 * @param {{ chain(u: string, e: string): { exchange: string, lotSize: number, strikeStep: number | null } | null }} master
 * @param {string} symbol
 * @param {string} expiry
 */
export function chainFactsFrom(master, symbol, expiry) {
  const chain = master.chain(symbol, expiry)
  if (chain === null) return null
  return { exchange: chain.exchange, lotSize: chain.lotSize, strikeStep: chain.strikeStep }
}

// ───────────────────────────────────────────────────────────────── the output

const HELP = `
  Register TODAY's four delta-lean PAPER books — NIFTY and SENSEX, each with
  the aggressive and the conservative preset. A delta-lean book lives one
  trading day; the tag names the day (NIFTY-delta-lean-aggressive-2026-09-22).

    node scripts/delta-lean-books.mjs [--dry-run | --apply] [--json]

    --dry-run   THE DEFAULT. Resolves the expiries from the instrument master,
                builds the four payloads and prints them. Creates nothing.
    --json      Print the exact four request bodies as JSON, and nothing else.
                Implies a dry run unless --apply is also given.
    --apply     Perform the three calls for each book: create (which lands the
                row desired: stopped), start, then PATCH the paper switch on
                (modes.paper.enabled: true) so the book is never born refused.
    --help      This.

  Environment:

    DESK_MONGO_URL   the instrument dump  (default ${DEFAULT_MONGO})
    DESK_API_URL     desk-api             (default ${DEFAULT_API})
    DESK_API_TOKEN   the machine bearer, required for --apply

  .env.local is loaded first; an already-set variable wins over the file.

  Every book this script can produce is mode: paper. There is no flag, variable
  or argument that changes that — see the module comment. Run \`make sync\`
  before a first apply so the lot size, strike step and freeze limits behind
  these books are the exchange's current ones. The cron path that does this
  every morning and retires the old books is scripts/delta-lean-roll.mjs.
  The procedure this sits in: docs/runbooks/delta-lean-paper.md
`

const RULE = '─'.repeat(78)

/**
 * @param {readonly BookPlan[]} books
 * @param {(b: BookPlan) => { exchange: string, lotSize: number, strikeStep: number | null } | null} facts
 * @param {string} todayIst
 * @param {readonly string[]} switchedOff the series planned and dropped (`seriesSwitchedOff`)
 */
function printPlan(books, facts, todayIst, switchedOff) {
  console.log(`\n${RULE}`)
  console.log(`  ${books.length} delta-lean PAPER books for the trading day ${todayIst} (IST)`)
  if (switchedOff.length > 0) {
    console.log(`  switched off (SERIES_OFF): ${switchedOff.join(', ')} — not registered`)
  }
  console.log(RULE)
  let n = 0
  for (const b of books) {
    n += 1
    const f = facts(b)
    console.log(`\n  [${n}/${books.length}] ${b.tag}`)
    console.log(`      symbol   ${b.symbol}`)
    console.log(`      expiry   ${b.expiry}   (nearest weekly with at least TODAY to go, from OptionMaster)`)
    console.log(`      mode     ${b.mode}`)
    console.log(`      variant  ${b.variant}`)
    console.log(
      f === null
        ? '      contract the master lists no chain for this expiry'
        : `      contract ${f.exchange}, lot ${f.lotSize}, strike step ${f.strikeStep ?? 'unknown'}` +
            '   (from the dump, not INDEX_UNDERLYINGS)',
    )
    console.log(
      `      dials    ${Object.keys(b.dials).length} resolved values ` +
        `(preset '${b.variant}' folded onto the engine defaults). The ones that set the risk:`,
    )
    for (const key of HEADLINE_DIALS) {
      console.log(`                 ${key.padEnd(22)} ${String(b.dials[key])}`)
    }
    console.log(`      call 1   POST ${REGISTRY}                  -> desired: stopped`)
    console.log(`      call 2   POST ${REGISTRY}/${b.tag}/start   {"mode":"paper"}`)
    console.log(`      call 3   PATCH ${STRATEGIES}/${b.tag}   ${JSON.stringify(PAPER_ON)}`)
  }
  const live = books.filter((b) => b.mode !== PAPER).length
  console.log(`\n${RULE}`)
  console.log(`  ${books.length} books planned. paper: ${books.length - live}. live: ${live}.`)
}

// ─────────────────────────────────────────────────────────────────── the wire

/**
 * One request to desk-api, with the answer parsed when it is JSON.
 *
 * `content-type: application/json` and a body go on the wire ONLY when a body
 * was given. `server.ts` answers 415 to any write method that declares a
 * content type other than JSON and lets a request with none through — so a
 * DELETE with no body must send no content type at all, not an empty JSON one.
 *
 * `opts.timeoutMs`, when given, is a hard deadline on the whole exchange
 * (`AbortSignal.timeout`): a desk that accepts the connection and never
 * answers is then an error, not a run that hangs. Absent, nothing changes.
 *
 * @param {string} base
 * @param {'GET' | 'POST' | 'PATCH' | 'DELETE'} method
 * @param {string} path
 * @param {unknown} body `undefined` for no body
 * @param {string} token
 * @param {{ timeoutMs?: number }} [opts]
 */
export async function requestJson(base, method, path, body, token, opts = {}) {
  /** @type {Record<string, string>} */
  const headers = { authorization: `Bearer ${token}` }
  /** @type {RequestInit} */
  const init = { method, headers }
  if (opts.timeoutMs !== undefined) init.signal = AbortSignal.timeout(opts.timeoutMs)
  if (body !== undefined) {
    headers['content-type'] = 'application/json'
    init.body = JSON.stringify(body)
  }
  const res = await fetch(`${base}${path}`, init)
  const text = await res.text()
  let parsed = null
  try {
    parsed = JSON.parse(text)
  } catch {
    // Not JSON. `text` is what gets reported.
  }
  return { status: res.status, body: parsed, text }
}

/**
 * Create, start, then switch on, each book.
 *
 * Stops at the first failure rather than pressing on: four half-created books
 * with no report of which is which is worse than three and a clear message, and
 * the script is re-runnable — an identical re-register converges on 200 instead
 * of refusing, a start on a running book is a no-op, and the PATCH is
 * idempotent.
 *
 * @param {readonly BookPlan[]} books
 * @param {string} base
 * @param {string} token
 */
async function applyBooks(books, base, token) {
  let created = 0
  let started = 0
  let switchedOn = 0
  for (const book of books) {
    // THE LAST CHECK BEFORE THE WIRE. `planBooks` already refused, but this is
    // the line that actually sends, and it is the one that has to be right.
    if (book.mode !== PAPER) {
      throw new Error(`REFUSED at the wire: ${book.tag} is mode ${JSON.stringify(book.mode)}`)
    }

    const create = await requestJson(base, 'POST', REGISTRY, book, token)
    if (create.status !== 201 && create.status !== 200) {
      throw new Error(
        `create ${book.tag} failed: HTTP ${create.status} ${create.text}` +
          (create.status === 409
            ? '\n  A DIFFERENT book already holds this tag. Deregister it from the Books page, ' +
              'or let the roll retire it.'
            : ''),
      )
    }
    const row = /** @type {Record<string, unknown> | null} */ (create.body)
    if (row !== null && row['mode'] !== PAPER) {
      throw new Error(`REFUSED: the registry echoed mode ${JSON.stringify(row['mode'])} for ${book.tag}`)
    }
    created += 1
    console.log(
      `  created  ${book.tag}  (HTTP ${create.status}${create.status === 200 ? ', already registered' : ''}, desired: ${String(row?.['desired'])})`,
    )

    // The mode is required IN THE BODY of a start; omitting it is a 400.
    const start = await requestJson(base, 'POST', `${REGISTRY}/${book.tag}/start`, { mode: PAPER }, token)
    if (start.status !== 200) {
      throw new Error(`start ${book.tag} failed: HTTP ${start.status} ${start.text}`)
    }
    started += 1
    const startedRow = /** @type {Record<string, unknown> | null} */ (start.body)
    console.log(`  started  ${book.tag}  (desired: ${String(startedRow?.['desired'])})`)

    // The switch. A running book that is switched off decides all day and has
    // every order refused INVALID (spec E3) — so this is not optional, and a
    // switch that will not flip is a fault to stop on: 400 "not added" means
    // the create did not land its strategy row, 404 means there is no row.
    const on = await requestJson(base, 'PATCH', `${STRATEGIES}/${book.tag}`, PAPER_ON, token)
    if (on.status !== 200) {
      throw new Error(
        `switch on ${book.tag} failed: HTTP ${on.status} ${on.text}` +
          '\n  The book is registered and started but its paper switch is OFF, so every order ' +
          'it places will be refused. Flip it from the Strategies page, or fix the cause and re-run.',
      )
    }
    switchedOn += 1
    console.log(`  switched on  ${book.tag}  (modes.paper.enabled: true)`)
  }
  return { created, started, switchedOn }
}

// ────────────────────────────────────────────────────────────────────── main

/** @param {readonly string[]} argv */
function parseArgs(argv) {
  const opts = { apply: false, json: false, help: false }
  for (const a of argv) {
    if (a === '--help' || a === '-h') opts.help = true
    else if (a === '--dry-run') opts.apply = false
    else if (a === '--json') opts.json = true
    else if (a === '--apply') opts.apply = true
    else {
      // An unrecognised flag is a HARD ERROR, never an ignored one: `--mode
      // live` has to fail rather than quietly run something else.
      throw new Error(
        `unrecognised argument ${JSON.stringify(a)} — this script takes --dry-run, --json, ` +
          '--apply and --help, and nothing else (there is no flag that changes the mode)',
      )
    }
  }
  if (opts.apply && argv.includes('--dry-run')) {
    throw new Error('--apply and --dry-run are opposites; pass one')
  }
  return opts
}

async function main() {
  try {
    // An environment variable already set WINS over the file (Node's own
    // `--env-file` rule), so `DESK_API_URL=... node ...` still means what it says.
    process.loadEnvFile(fileURLToPath(new URL('../.env.local', import.meta.url)))
  } catch {
    // Nothing to load. The environment stands as it is.
  }

  const opts = parseArgs(process.argv.slice(2))
  if (opts.help) {
    console.log(HELP)
    return 0
  }

  // Imported HERE, not at the top: the test suite imports this module for its
  // pure functions and must not pay for a mongodb driver to do it.
  const { connectMongo } = await import('../apps/api/src/mongo.ts')
  const { loadStoredInstruments } = await import('../apps/marketdata/src/sync-runner.ts')
  const { OptionMaster } = await import('@algomaker/instruments')

  const mongoUrl = process.env['DESK_MONGO_URL'] ?? DEFAULT_MONGO
  const mongo = await connectMongo(mongoUrl, { serverSelectionTimeoutMS: 5000 })
  let books
  let switchedOff
  let facts
  let todayIst
  try {
    const master = new OptionMaster(await loadStoredInstruments(mongo.db.collection('instrument')))
    // Resolved ONCE, here, and handed down: the tag, the expiry and the plan
    // all ask about the same IST day.
    todayIst = istDate(Date.now())
    const planned = planBooks(expiriesFrom(master, todayIst), todayIst)
    // A switched-off series is never registered, here as in the roll.
    books = withoutSeriesOff(planned)
    switchedOff = seriesSwitchedOff(planned)
    // Read the chain facts while the master is open; the printer runs after.
    const cached = new Map(
      books.map((b) => [b.tag, chainFactsFrom(master, b.symbol, b.expiry)]),
    )
    facts = (/** @type {BookPlan} */ b) => cached.get(b.tag) ?? null
  } finally {
    await mongo.close()
  }

  // Belt and braces, on the objects that are about to be printed or posted.
  assertAllPaper(books)

  if (opts.json) {
    console.log(JSON.stringify(books, null, 2))
    if (!opts.apply) return 0
  } else {
    printPlan(books, facts, todayIst, switchedOff)
  }

  if (!opts.apply) {
    console.log('\n  DRY RUN. Nothing was created.')
    console.log('  --json   the exact request bodies')
    console.log('  --apply  create, start and switch on these four books')
    console.log('  docs/runbooks/delta-lean-paper.md is the procedure around this step.\n')
    return 0
  }

  const base = process.env['DESK_API_URL'] ?? DEFAULT_API
  const token = process.env['DESK_API_TOKEN'] ?? ''
  if (token.trim() === '') {
    throw new Error(
      'DESK_API_TOKEN is not set — --apply authenticates to desk-api as the machine principal ' +
        '(it is in .env.local on a configured box)',
    )
  }

  console.log(`\n  applying against ${base}\n`)
  const { created, started, switchedOn } = await applyBooks(books, base, token)
  console.log(`\n  ${created} registered, ${started} started, ${switchedOn} switched on, all paper.`)
  console.log('  Watch the first session with docs/runbooks/delta-lean-paper.md.\n')
  return 0
}

// Run only when executed directly — the test suite imports this file.
if (process.argv[1] !== undefined && resolvePath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
    .then((code) => {
      process.exitCode = code
    })
    .catch((err) => {
      console.error(`\n${err instanceof Error ? err.message : String(err)}\n`)
      process.exitCode = 1
    })
}

// The constants a reader (or a second script) needs to say what these books are.
export {
  PAPER,
  PRESET_KEYS,
  EXPIRY_DAY_DIAL,
  HOLD_PRESET_KEYS,
  HOLD_DIAL,
  LEAN_DIAL,
  PLAYBOOK_PRESET_KEYS,
  PLAYBOOK_DIAL,
  PLAYBOOK_EXPIRY_FROM,
  SERIES_OFF,
  SYMBOLS,
  STRATEGIES,
  PAPER_ON,
}
