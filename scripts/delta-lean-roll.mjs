/**
 * THE DAILY BOOK ROLL, AUTOMATED — today's books before yesterday's come off,
 * every stop before any erase, and never a stop that strands a position.
 *
 * `scripts/delta-lean-books.mjs` registers, starts and switches on the four
 * delta-lean paper books for ONE trading day (spec D1): the tag names the day
 * — `NIFTY-delta-lean-aggressive-2026-09-22` — so each morning's four are new
 * rows and a book's page is one clean day. That makes the morning a chore:
 * create today's, stop and erase yesterday's. A daily chore is a
 * daily chance to forget, and the failure is silent — a book that outlived
 * its day keeps deciding under an old tag with a `lastReason` that reads like
 * a quiet market. This script is that chore, written down and run by cron.
 *
 * "THE FOUR", wherever this file says it, is that daily family — four books
 * when it was written, six since the zero spec (2026-10-17: the zero book on
 * each symbol) and seven on a symbol's expiry morning (its 0-DTE zero book).
 * Nothing below counts them: every rule reads `planBooks`' targets and
 * `PRESET_KEYS`, so the family grew with no change to the roll itself.
 *
 *     node scripts/delta-lean-roll.mjs            # dry run — prints, changes nothing
 *     node scripts/delta-lean-roll.mjs --json     # the same plan as JSON
 *     node scripts/delta-lean-roll.mjs --apply    # create+start+switch on, THEN stop, THEN erase
 *     node scripts/delta-lean-roll.mjs --help
 *
 * ── THE ORDER IS THE POINT ──────────────────────────────────────────────────
 *
 * Separate loops, in this order, never interleaved:
 *
 *   1. CREATE, START and SWITCH ON today's four, then any new hold-to-expiry
 *      pair (THE HOLD PAIRS, below). If any of that fails the run throws
 *      here, before a single stop, so a bad morning leaves the desk with a
 *      book too many rather than none. THEN today's playbook books (THE
 *      PLAYBOOKS, below), still before any stop — the newest family last,
 *      and FENCED, so a failure in it costs the others nothing: a playbook
 *      create, start or switch-on that fails stops the playbook family at
 *      that book (the ones after it are not sent), is an ATTENTION line
 *      (exit 1), and skips one loop only — the playbook retire, 8–9, because
 *      the retire half never runs without the create half. Every other loop
 *      below still runs. A refusal at the wire (a mode that is not paper, a
 *      registry that echoes one) is not a failure: it aborts the run from any
 *      family, this one included.
 *   2. SETTLE every retiring book whose open legs are ALL on contracts that
 *      expired before today: `POST .../:tag/settle-expired?mode=paper` books
 *      them out at intrinsic (spec §WS1 1a). Only a book the server confirms
 *      flat (`remaining: 0`) goes on to 3 and 4; a refusal (409 — no close on
 *      file) leaves it exactly where it is, in ATTENTION.
 *   3. STOP every book being retired that is still `desired: running` — the
 *      ones about to be erased (a DELETE on a running row is a 409), and the
 *      few that are only stopped (see THE DAILY RULE).
 *   4. ERASE the flat books whose creation day is before TODAY — yesterday's
 *      and anything older: `DELETE /v1/desk/books/registry/:tag?mode=paper`.
 *   5–7. THE HOLD BOOKS whose contract expired before today: the same settle
 *      → stop → erase, by the rule the fourth loop uses.
 *   8–9. THE PLAYBOOK BOOKS from an earlier day: the same settle → stop →
 *      erase — a flat one is erased, one whose every open leg is on a dead
 *      contract is settled first, and one with a live-contract leg (or that
 *      cannot be read) is alarmed and left alone.
 *      Not sent at all when step 1's playbook half failed, and fenced like
 *      it: a stop or an erase that fails here ends this retire with an
 *      ATTENTION line, never the run, so the fourth loop still goes out.
 *   10–12. THE FOURTH LOOP, after all of the above: every OTHER paper book (any
 *      family — the monthly stock books) whose `expiry` is before today gets
 *      the same settle → stop → erase. A leg on a LIVE contract is alarmed
 *      and the book left alone, as everywhere else.
 *
 * `applyRoll` is separate loops over the plan rather than one loop doing
 * everything, so the ordering is structural and not a comment. The suite pins
 * it by recording the actual calls.
 *
 * `--prune-orphans` is a separate run, not part of the roll: it lists the
 * external `desk-strategies` rows that have no registry row on either rail
 * (never read off the tag) and, with `--apply`, removes their paper switch and
 * then the row.
 *
 * ── A STOP THAT STRANDS A POSITION IS THE ONE FAILURE THAT COSTS MONEY ──────
 *
 * A stop does NOT flatten (runbook §4). It takes the book off the desk and
 * whatever it holds, it keeps — and a book that is off the desk will not
 * flatten itself at 14:50 either, because nothing is steering it any more. So
 * a book is stopped or erased ONLY when `desk-books` shows it holding nothing
 * under its own `{tag, mode}`. If it holds so much as one leg, or if this
 * script cannot tell, it is LEFT RUNNING and reported loudly.
 *
 * A retired book should never be holding anything: it flattened at 15:00 on
 * its own day and has been flat since (D4, and the 08:50 slot). One that is
 * holding is therefore an operator's problem, not a scheduling one. Leaving
 * it running keeps it visible, on the Books page and in tomorrow's log, until
 * somebody deals with it. Being a day late costs nothing. Being wrong costs a
 * position nobody is watching.
 *
 * It erases a flat book whose creation day is before today, stopping it
 * first if it still runs. Erase = the registry row and the
 * `desk-books` document only (the route's `purge:false` semantics): fills,
 * order events, daily reports, engine decisions and the decisions journal
 * stay for the Reports page. What is lost is the row's own last-reason
 * snapshot (`lastReason`/`lastAction`/`lastReasonAt`), which the per-decision
 * journal already carries. Never `?flatten=1` (it places orders) and never
 * `?purge=1` (it erases the history the page is built on).
 *
 * The server keeps its own guard on the DELETE: it rebuilds the position from
 * the FILLS and refuses with a 409 when they disagree with `desk-books`. That
 * refusal is the server doing its job, so here it is an ALARM in the summary
 * and not an abort — the row stays stopped and registered, the other erases
 * still go out, and the operator reads it in ATTENTION.
 *
 * ── THE SWITCH IS FLIPPED ON AFTER EVERY START ──────────────────────────────
 *
 * Registration has landed a tag in `desk-strategies` with the paper switch
 * OFF (`addStrategyMode`); the API may come to land it ON for a fresh
 * delta-lean paper row, but the roll does not depend on which. A running
 * book that is switched off decides all day and has every order refused
 * INVALID (spec E3: 348 + 270 + 217 red rows in three days), and the cost of
 * a redundant PATCH is nothing. So every start THIS RUN issues is followed by
 * `PATCH /v1/desk/strategies/:tag {modes:{paper:{enabled:true}}}`,
 * unconditionally — belt and braces, idempotent, and not to be removed on
 * the day the create path starts doing it too — and a PATCH that will not
 * flip stops the run (a playbook book's, the playbook family — THE ORDER IS
 * THE POINT, above).
 *
 * That PATCH is the one thing that turns on a book whose create left it off,
 * so when it fails the run says "fix the cause and re-run" — and the re-run
 * must finish it, not count a running book "on target" and send nothing. So
 * the roll also reads every tag's switch (`readSwitches`, beside the
 * registry), and a TARGET that runs with its switch off gets the same three
 * calls again when, and only when, the switch has plainly been off since
 * this morning's start: the row was registered this morning, carries no
 * day-guard stamp, and has never marked (a switched-off flat book idles
 * before its mark). Those are the only books the roll PATCHes that it did
 * not start this run. A book the day guard switched off
 * (`disabledByGuard.paper`) is never one of them, so a guard trip is not
 * undone by a hand re-run; and a running target whose switch is off for any
 * other reason — it has marked, or it was registered on an earlier morning —
 * is somebody's decision, named in ATTENTION and left off.
 *
 * ── PAPER, AND THERE IS NO FLAG THAT SAYS OTHERWISE ─────────────────────────
 *
 * Same guarantee as the sibling, same five layers, and `PAPER` is IMPORTED
 * from it rather than restated so the two can never drift:
 *
 *   1. `mode` is a module constant. Not an argument, not an environment
 *      variable, not a field a caller may pass in.
 *   2. The registry read filters on `mode: PAPER`, and every row that comes
 *      back is re-checked — a live row in a paper query is a refusal, not a
 *      surprise to be handled later.
 *   3. `assertAllPaper` runs on the planned books (inside `planBooks`, and
 *      again here before anything is printed).
 *   4. Each payload is re-checked in the line before its POST, and each row
 *      in the line before its stop and again before its DELETE.
 *   5. Every start and every stop sends the literal `{"mode":"paper"}`, every
 *      DELETE the literal `?mode=paper`, and a create whose response echoes
 *      any other mode aborts the run.
 *
 * An unrecognised flag is a hard error for the same reason: `--mode live` must
 * fail, not be ignored on its way to a run that does something else.
 *
 * ── WHICH BOOKS ARE "OURS" ──────────────────────────────────────────────────
 *
 * Never a tag substring. A row is delta-lean when its `variant` is one of the
 * two presets AND its dials actually turn the delta-lean decide path on
 * (`delta_lean_enabled`, the only dial anything branches on). A row where those
 * two DISAGREE is not quietly picked one way: it is reported as an anomaly and
 * left alone, because a row whose variant says delta-lean while its dials run
 * the recenter engine is a misconfiguration an operator must see, not a book
 * this script should be stopping. The four LEGACY weekly-tag rows on the box
 * (`NIFTY-2026-09-22-…`, `SENSEX-2026-09-17-…`) are retired by this same rule
 * on the first run; their tags are never inspected.
 *
 * A PLAYBOOK row is sorted out FIRST, by its own test (`isPlaybook`): its
 * DIALS hand it to the playbook frame — `delta_lean_enabled` true and
 * `pb_playbook` at least 1 — under a variant that is not one of the four's
 * or the hold pairs' presets. Never `variant ∈ PLAYBOOK_PRESET_KEYS`: that
 * list is what the roll creates, and a preset switched off by removing its
 * key (runbook §8.4) still has rows to retire. A row that shows any playbook
 * sign — a variant in that list, or a `pb_playbook` other than 0 — and fails
 * the test is an anomaly, left alone by every loop. So a playbook row never
 * reaches the four's single-expiry check, their "not one of today's four"
 * retire, or the fourth loop; and the four's and the pairs' rows, which
 * state `pb_playbook: 0`, never reach the playbook family.
 *
 * ── THE DAILY RULE ──────────────────────────────────────────────────────────
 *
 *   CREATE: today's four, by tag — `planBooks(expiriesFrom(master, today),
 *           today)`. A row that exists and runs is on target (unless this
 *           morning's switch-on did not land — THE SWITCH, above); one that
 *           exists stopped is started only when something needs retiring
 *           (otherwise it is the operator's decision, left alone).
 *   RETIRE: every OTHER delta-lean row, by variant + dial. Its day is
 *           `istDate(createdAt)` — the registry stamps `createdAt` on create
 *           and nothing parses the tag. Its day before TODAY and flat → ERASE
 *           (stop first if running). Holding a leg on a live contract, or
 *           unreadable → alarm, untouched. Holding only legs on dead
 *           contracts → SETTLE, then the same rule.
 *
 * The erase cutoff is TODAY. A finished book leaves the Books page the
 * morning after its session (operator, 2026-10-05: "which is done and
 * closed, why still on tab"): Monday's book is stopped AND erased in
 * Tuesday's run, Friday's in Monday's, and a book from before a holiday in
 * the first run after it. There is no "visible as stopped for one session"
 * any more — the history it leaves (fills, decisions, reports) is what the
 * Reports page reads, and that is never erased. `stop` remains a terminal
 * action only for a book that must come off the desk but cannot be erased:
 * one born TODAY that is not one of today's four (a hand-registered extra),
 * or one whose `createdAt` cannot be read (stopped, reported, never erased).
 * (A book whose symbol would be left uncovered is not stopped either: it is
 * WITHHELD.) A `desired: stopped` row the morning after is therefore not the
 * norm but something to read in ATTENTION.
 *
 * For a delta-lean book `planRoll` never reads `row.expiry`
 * to classify anything — the contract a daily book traded says nothing about
 * whether its day is over. (The fourth loop, for every OTHER family, is the
 * one place the row's expiry decides: a monthly book is done when its
 * contract is.) A LEG's expiry is read only to ask whether the leg is on a
 * dead contract that can be settled.
 *
 * ── THE HOLD PAIRS ──────────────────────────────────────────────────────────
 *
 * The hold-to-expiry sibling (spec 2026-10-05): per symbol, the aggressive and
 * conservative columns with `dl_hold_to_expiry: true`, one pair per weekly
 * contract, tagged by the contract (`NIFTY-delta-lean-hold-aggressive-2026-10-13`).
 * Membership is that DIAL (`isHold`), cross-checked against the variant the
 * way `delta_lean_enabled` is — a row where the two disagree is an anomaly,
 * left alone by every loop.
 *
 *   CREATE: `planHoldBooks(<today's expiries>, today)` — the pair for every
 *           symbol whose front contract does NOT expire today, by the same
 *           three calls as the four, right after them. A missing pair is
 *           created; a running one is on target (THE SWITCH, above, for one
 *           whose switch is off). A STOPPED one registered
 *           this morning, flat, and never started — nothing has written to
 *           its row since its create (`neverStarted`) — is a run that died
 *           between create and start, and is started; any other stopped one,
 *           a pair stopped by hand minutes after its start included, is the
 *           operator's decision, left stopped and named in ATTENTION (an
 *           ALARM if it is not flat — so is a stopped, non-flat pair carrying
 *           to its expiry).
 *           On an expiry morning no pair is created for the dying contract:
 *           the pair on it carries to the close, and the next contract's
 *           pair comes the morning after.
 *   GATE:   none of this is planned unless the engine on disk knows
 *           `dl_hold_to_expiry` (`planHoldTargets`); if it does not, the run
 *           says so in ATTENTION and exits 1, and everything else still rolls.
 *   DAILY:  nothing. Hold rows never enter the creation-day retire.
 *   RETIRE: a hold row whose `expiry` is before today, by the fourth loop's
 *           rule — flat → erase (stop first if running); every open leg on a
 *           dead contract → settle, then erase; a live-contract leg or an
 *           unreadable book → alarm, untouched. One whose contract has not
 *           expired and is not today's target is carried, untouched.
 *
 * ── THE PLAYBOOKS ───────────────────────────────────────────────────────────
 *
 * The third family (spec 2026-10-16 §4.9): per symbol, the three intraday
 * playbooks every session and the three expiry playbooks on the symbol's own
 * expiry day (from `PLAYBOOK_EXPIRY_FROM`), one row per preset per DAY, each
 * on its own contract (`planPlaybookBooks`). Members by their dials
 * (`isPlaybook`); the roll creates only the presets in
 * `PLAYBOOK_PRESET_KEYS` and retires every member. Their own create and retire,
 * like the hold pairs — never the four's: one symbol's playbooks can sit on
 * three expiries, which the four's one-target check would refuse, and a
 * playbook row of today is not an "extra" for the four's retire to stop.
 *
 *   CREATE: today's plans, by tag, with the same three calls, after the hold
 *           pairs. Missing → create, start, switch on. Running → on target
 *           (THE SWITCH, above, for one whose switch is off).
 *           Stopped, flat, registered THIS morning and never started
 *           (`neverStarted`) → a run that died between its create and its
 *           start: started. Any other stopped one — the operator's 09:40
 *           stop included — → left stopped and named in ATTENTION (an ALARM
 *           if not flat).
 *   RETIRE: a playbook row whose DAY is before today — its creation day, or,
 *           when `createdAt` is unreadable, the date its own
 *           `${symbol}-${variant}-${day}` tag ends in. Flat → erase (stop
 *           first if running). Every open leg on a contract that expired
 *           before today — the 0-DTE wing nobody would buy at ₹0.05 — →
 *           settle, then erase, as for the four; a refused settle leaves it
 *           in ATTENTION. A leg on a live contract, or unreadable → ALARM,
 *           untouched. A row with no readable day is an anomaly, and a
 *           playbook row of TODAY is never touched.
 *   GATE:   nothing in this family is planned — no create, no retire — unless
 *           the engine on disk knows `pb_playbook` and today's plan could be
 *           made (`planPlaybookTargets`). Otherwise the run says why in
 *           ATTENTION and exits 1, and the four and the hold pairs still roll.
 *
 * ── SWITCHED-OFF SERIES ─────────────────────────────────────────────────────
 *
 * `SERIES_OFF` (the sibling) names series that `main` drops from each
 * family's targets before `planRoll` sees them (`withoutSeriesOff`); the plan
 * carries their names (`switchedOff`) for one line under the summaries, never
 * ATTENTION. The ROWS are never filtered: a switched-off series' row is simply
 * not a target, so its family's retire takes it like any other — of an
 * earlier day and flat → erased; holding → ALARM, untouched.
 *
 * ── NON-TRADING DAYS ────────────────────────────────────────────────────────
 *
 * `isTradingDay` (`@algomaker/desk-engine`, session.ts) gates the whole run: a
 * weekend or NSE holiday is a no-op with exit 0 — no book is created for a
 * session that will not happen, and nothing is retired either, because the
 * retire half must never run without the create half. The cron line is
 * weekdays only but a holiday weekday still fires it. The calendar fails OPEN
 * on a year it does not cover (runbook §5.3), so this gate never withholds a
 * real session; it must be replaced before 2027.
 *
 * ── IDEMPOTENT, AND SAFE AT ANY MOMENT ──────────────────────────────────────
 *
 * Re-runnable by construction: a create that describes the row on file
 * converges on 200 (and does NOT overwrite dials an operator patched), a start
 * on a running book is a no-op, the PATCH is idempotent, a stopped flat row
 * born today is reported and left stopped (unless it is a hold pair or a
 * playbook book that no start has ever reached — a dead run's, finished),
 * and an erased row is gone. A second run a second after the first issues no
 * calls at all; a re-run hours later never restarts a hold or playbook book
 * stopped by hand (one of today's four only when an old book on its symbol
 * must be retired — THE DAILY RULE).
 *
 * Exit code 1 on anything unexpected — an alarm, an anomaly, a refused settle
 * or erase, or a playbook loop that could not be finished — so a cron run that
 * found trouble is visible in `$?` and in the log rather than swallowed.
 *
 * Tested by `apps/api/test/delta-lean-roll.test.ts`. Everything above `main()`
 * is pure and holds no handles; everything that touches Mongo or a socket lives
 * below it and is imported lazily there.
 */

import { fileURLToPath } from 'node:url'
import { resolve as resolvePath } from 'node:path'
import { isTradingDay, tradingDaysToExpiry } from '@algomaker/desk-engine'
import {
  PAPER,
  PRESET_KEYS,
  HOLD_PRESET_KEYS,
  HOLD_DIAL,
  LEAN_DIAL,
  PLAYBOOK_PRESET_KEYS,
  PLAYBOOK_DIAL,
  PLAYBOOK_EXPIRY_FROM,
  SYMBOLS,
  STRATEGIES,
  PAPER_ON,
  assertAllPaper,
  planBooks,
  planHoldBooks,
  planPlaybookBooks,
  withoutSeriesOff,
  seriesSwitchedOff,
  isHold,
  isPlaybook,
  engineKnowsHoldDial,
  engineKnowsPlaybookDial,
  expiriesFrom,
  istDate,
  requestJson,
} from './delta-lean-books.mjs'

// ─────────────────────────────────────────────────────────────── the constants

const REGISTRY = '/v1/desk/books/registry'
const DEFAULT_API = 'http://127.0.0.1:8890'
const DEFAULT_MONGO = 'mongodb://127.0.0.1:27017/algomaker_dx'

// `LEAN_DIAL` — `delta_lean_enabled`, the dial that SELECTS the delta-lean
// decide path, and with the variant the membership test of every delta-lean
// family — is imported from the sibling, like `PAPER`, so the two scripts
// cannot spell it differently.

/**
 * @typedef {Record<string, number | boolean>} DialRecord
 * @typedef {{ tag: string, symbol: string, expiry: string, mode: string, variant: string, series: string, dials: DialRecord }} BookPlan
 * @typedef {BookPlan & { desired: string, actual: string, createdAt: number, lastMarkAt?: number, updatedAt?: number }} RegistryRow
 *   `lastMarkAt` and `updatedAt` are always on a row `bookFromDoc` built;
 *   absent, they are a history this run cannot read (see `neverStarted`).
 * @typedef {'stop' | 'erase' | 'blocked' | 'holds-legs' | 'unknown' | 'stopped-flat' | 'stopped-holds-legs' | 'stopped-unknown' | 'settle-then-stop' | 'settle-then-erase'} RetireAction
 * @typedef {{ row: RegistryRow, held: number | null, day: string | null, action: RetireAction }} RetireEntry
 * @typedef {{ plan: BookPlan, why: 'missing' | 'stopped-but-needed' | 'created-not-started' | 'switched-off' }} EnsureEntry
 *   `switched-off`: a target that RUNS with its paper switch off, which this
 *   run finishes like any other (see THE SWITCH, above, and `planRoll`).
 * @typedef {{ paper: 'on' | 'off' | 'not-added', guard: { day: string, trigger: string } | null }} SwitchState
 *   One tag's paper switch as `desk-strategies` holds it (`readSwitches`):
 *   `on` — added to paper and enabled; `off` — added, not enabled;
 *   `not-added` — no paper membership, or no strategy row at all. `guard` is
 *   the day guard's own stamp on the paper rail (`disabledByGuard.paper`,
 *   written by `day-guard.ts` alone), or null.
 * @typedef {{ row: RegistryRow, held: number | null }} Holding
 * @typedef {{ symbol: string, targetExpiry: string, ensure: EnsureEntry[], onTarget: Holding[], leftStopped: Holding[], retire: RetireEntry[] }} SymbolPlan
 * @typedef {{ ensure: EnsureEntry[], onTarget: Holding[], leftStopped: Holding[], carrying: Holding[], retire: RetireEntry[] }} HoldPlan
 * @typedef {{ blocked: string | null, ensure: EnsureEntry[], onTarget: Holding[], leftStopped: Holding[], ofToday: Holding[], retire: RetireEntry[], gated: Holding[] }} PlaybookPlan
 *   `blocked` is why the family is not planned today (null when it is); while
 *   it is set, `gated` lists every playbook row on file — left exactly as it
 *   is — and every other list is empty. `ofToday` is the playbook rows of
 *   today that are not today's plans: never touched.
 * @typedef {{ todayIst: string, tradingDay: boolean, symbols: SymbolPlan[], hold: HoldPlan, playbook: PlaybookPlan, expiredBooks: RetireEntry[], switchedOff: string[], anomalies: string[], alarms: string[] }} RollPlan
 *   `switchedOff` is the series planned today and not created because
 *   `SERIES_OFF` names them — reported, never an anomaly.
 * @typedef {Map<string, number | null> | Record<string, number | null>} CountByTag
 * @typedef {{ status: number, body: unknown, text: string }} WireResult
 * @typedef {(method: 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown) => Promise<WireResult>} Request
 */

// ───────────────────────────────────────────────────────────────── pure logic

/**
 * Is this registry row one of ours?
 *
 * BOTH halves, never a tag substring: the `variant` names one of the four
 * presets (the two daily columns and their two hold-to-expiry siblings) AND
 * the dials actually select the delta-lean decide path. See `planRoll` for
 * the case where they do not agree. Which of the two families a row belongs
 * to is then `isHold` — the `dl_hold_to_expiry` dial. A playbook book is
 * ours too, by its own test (`isPlaybook`), and is rolled as a third family.
 *
 * @param {{ variant?: unknown, dials?: unknown }} row
 * @returns {boolean}
 */
export function isDeltaLean(row) {
  return (byVariant(row) && byDial(row)) || isPlaybook(row)
}

/** @param {{ variant?: unknown }} row */
function byPlaybookVariant(row) {
  return typeof row.variant === 'string' && PLAYBOOK_PRESET_KEYS.includes(row.variant)
}

/**
 * Does the row carry a playbook dial — `pb_playbook` stated as anything but
 * the inert 0? Not membership (that is `isPlaybook`), the opposite: any
 * sign of a playbook, so that a row showing one and failing the test is
 * reported rather than rolled as something else. Absent is no sign: a row
 * registered before the dial existed resolves it to 0.
 * @param {{ dials?: unknown }} row
 */
function carriesPlaybookDial(row) {
  const dials = row.dials
  if (typeof dials !== 'object' || dials === null) return false
  const which = /** @type {Record<string, unknown>} */ (dials)[PLAYBOOK_DIAL]
  return which !== undefined && which !== 0
}

/** @param {{ variant?: unknown }} row */
function byVariant(row) {
  return typeof row.variant === 'string' && (PRESET_KEYS.includes(row.variant) || HOLD_PRESET_KEYS.includes(row.variant))
}

/** @param {{ variant?: unknown }} row */
function byHoldVariant(row) {
  return typeof row.variant === 'string' && HOLD_PRESET_KEYS.includes(row.variant)
}

/** @param {{ dials?: unknown }} row */
function byDial(row) {
  const dials = row.dials
  return typeof dials === 'object' && dials !== null && /** @type {DialRecord} */ (dials)[LEAN_DIAL] === true
}

/**
 * How many legs this book is holding, or `null` when that cannot be answered.
 *
 * `null` is not zero and is never treated as zero: an unreadable book is a book
 * this script refuses to stop. A leg whose `qty` is missing or not finite makes
 * the whole answer unknown rather than being skipped, because the failure mode
 * being guarded against is "counted zero, stopped it, stranded it".
 *
 * Legs are counted individually, not netted across instruments. Two opposite
 * legs on one contract net to nothing on a P&L page but they are still two open
 * positions here, and counting them as holding errs toward NOT stopping.
 *
 * @param {unknown} legs the `legs` array of a `desk-books` document
 * @returns {number | null}
 */
export function openLegCount(legs) {
  if (!Array.isArray(legs)) return null
  let open = 0
  for (const leg of legs) {
    const qty = /** @type {{ qty?: unknown }} */ (leg ?? {}).qty
    if (typeof qty !== 'number' || !Number.isFinite(qty)) return null
    if (qty !== 0) open += 1
  }
  return open
}

/**
 * How many OPEN legs sit on a contract that expired before `todayIst`, or
 * `null` when that cannot be answered.
 *
 * A contract expiring TODAY is still trading and is not counted. A leg with no
 * readable `expiry` makes the answer unknown rather than "live", for the same
 * reason `openLegCount` refuses to guess: the answer decides whether the roll
 * books a settlement, and the safe direction is to alarm instead.
 *
 * @param {unknown} legs the `legs` array of a `desk-books` document
 * @param {string} todayIst `YYYY-MM-DD`
 * @returns {number | null}
 */
export function expiredLegCount(legs, todayIst) {
  if (!Array.isArray(legs)) return null
  let expired = 0
  for (const leg of legs) {
    const { qty, expiry } = /** @type {{ qty?: unknown, expiry?: unknown }} */ (leg ?? {})
    if (typeof qty !== 'number' || !Number.isFinite(qty)) return null
    if (qty === 0) continue
    if (typeof expiry !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(expiry)) return null
    if (expiry < todayIst) expired += 1
  }
  return expired
}

/**
 * The leg reads `main` makes for EVERY paper row — open legs, and how many of
 * them are on a dead contract — exported so the suite reads the desk exactly
 * the way the cron does. No document at all is a book that never traded: flat,
 * and nothing expired.
 *
 * @param {readonly { tag: string }[]} rows
 * @param {(tag: string) => Promise<{ legs: unknown } | null>} bookDoc
 * @param {string} todayIst
 */
export async function readHoldings(rows, bookDoc, todayIst) {
  /** @type {Map<string, number | null>} */
  const heldByTag = new Map()
  /** @type {Map<string, number | null>} */
  const expiredByTag = new Map()
  for (const row of rows) {
    const doc = await bookDoc(row.tag)
    heldByTag.set(row.tag, doc === null ? 0 : openLegCount(doc.legs))
    expiredByTag.set(row.tag, doc === null ? 0 : expiredLegCount(doc.legs, todayIst))
  }
  return { heldByTag, expiredByTag }
}

/**
 * THE PAPER SWITCH OF EVERY TAG, as `main` reads it out of `desk-strategies`
 * (`store.listStrategies()`) — exported, like `readHoldings`, so the suite
 * reads the desk exactly the way the cron does.
 *
 * The roll needs it for one question only: is one of TODAY'S TARGETS running
 * with its switch off? Such a book decides all day and has every order
 * refused (spec E3), and nothing in the registry row says so. `enabled` is
 * read as desk-api's own gate reads it (`isOn`: `=== true`, anything else is
 * off), and the guard's stamp is read on the PAPER rail only — a stamp on
 * the live rail says nothing about paper.
 *
 * @param {readonly { tag: string, modes?: unknown, disabledByGuard?: unknown }[]} strategies
 * @returns {Map<string, SwitchState>}
 */
export function readSwitches(strategies) {
  /** @type {Map<string, SwitchState>} */
  const out = new Map()
  /** @param {unknown} v */
  const obj = (v) => /** @type {Record<string, unknown>} */ (typeof v === 'object' && v !== null ? v : {})
  for (const s of strategies) {
    const modes = obj(s.modes)
    const paper = typeof modes['paper'] === 'object' && modes['paper'] !== null ? obj(modes['paper']) : null
    const stamp = obj(s.disabledByGuard)['paper']
    out.set(s.tag, {
      paper: paper === null ? 'not-added' : paper['enabled'] === true ? 'on' : 'off',
      guard:
        typeof stamp === 'object' && stamp !== null
          ? { day: String(obj(stamp)['day']), trigger: String(obj(stamp)['trigger']) }
          : null,
    })
  }
  return out
}

/**
 * @param {CountByTag | undefined} counts
 * @returns {(tag: string) => number | null} absent, non-numeric or non-finite all read as null
 */
function countReader(counts) {
  return (tag) => {
    const v = counts instanceof Map ? counts.get(tag) : /** @type {Record<string, number | null>} */ (counts ?? {})[tag]
    return typeof v === 'number' && Number.isFinite(v) ? v : null
  }
}

/**
 * The IST day a row was created, or null when `createdAt` is unreadable —
 * `bookFromDoc` answers 0 for a missing one, which is read as unknown, never
 * as 1970.
 * @param {{ createdAt?: unknown }} row
 * @returns {string | null}
 */
function dayOf(row) {
  return typeof row.createdAt === 'number' && Number.isFinite(row.createdAt) && row.createdAt > 0
    ? istDate(row.createdAt)
    : null
}

/**
 * NEVER TAKEN UP — is this STOPPED row one that no start has ever reached?
 *
 * The one question behind "finish a run that died between its create and its
 * start" (the hold pairs and the playbooks), and it must not be answered by
 * the day alone: "stopped, flat, registered this morning" is just as true of
 * a book the operator stopped at 09:40, and a re-run that read it as a dead
 * run would start it again, switch on. So all three of what the registry row
 * records about its own history must say nothing has happened to it:
 *
 *   `updatedAt === createdAt` — THE ONE THAT DECIDES. A fresh create stamps
 *       both from one clock reading (`routes/books.ts`), and every later
 *       write to the row moves `updatedAt` on: the start and the stop
 *       (`setDesired`), every supervisor report (`setActual`, each 5 s pass
 *       while it runs), a dials PATCH. A create that converges on a row
 *       already on file never rewrites it. Equal therefore means nothing has
 *       touched the row since its create — in particular no start. It is
 *       also the only one of the three that still tells the two apart for a
 *       book stopped BEFORE its first mark, when `actual` reads stopped again
 *       and `lastMarkAt` is still 0.
 *   `actual === 'stopped'` — the supervisor is not reporting it running.
 *   `lastMarkAt === 0` — the supervisor never reported a mark for it.
 *
 * Absent or unreadable is never read as "never started": such a row is left
 * stopped and named in ATTENTION — the safe way round, a book too few for one
 * morning rather than an operator's stop reversed. Any write to a row that
 * never ran (a dials edit before its start) leaves it to the operator too.
 *
 * @param {RegistryRow} row
 * @returns {boolean}
 */
function neverStarted(row) {
  return (
    row.actual === 'stopped' &&
    row.lastMarkAt === 0 &&
    typeof row.createdAt === 'number' &&
    Number.isFinite(row.createdAt) &&
    row.createdAt > 0 &&
    row.updatedAt === row.createdAt
  )
}

/**
 * The day a PLAYBOOK row belongs to: its creation day (`dayOf`, with its
 * reading of 0 as unknown), or — only when `createdAt` cannot be read — the
 * date its own tag ends in, and only when the tag is EXACTLY
 * `${symbol}-${variant}-${YYYY-MM-DD}`, the shape `planPlaybookBooks` writes.
 * The tag never decides membership (`isPlaybook` does, off the dials); here
 * it only gives a member whose timestamp was lost a day. Null when neither
 * answers, and null is never read as "before today".
 *
 * @param {RegistryRow} row
 * @returns {string | null}
 */
function playbookDayOf(row) {
  const created = dayOf(row)
  if (created !== null) return created
  const prefix = `${row.symbol}-${row.variant}-`
  if (typeof row.tag !== 'string' || !row.tag.startsWith(prefix)) return null
  const day = row.tag.slice(prefix.length)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null
  // Round-tripped, so '2026-02-31' is not a day.
  const d = new Date(`${day}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === day ? day : null
}

/**
 * THE ENGINE GATE, then the hold pairs. Today's hold targets only when the
 * engine on disk knows `dl_hold_to_expiry` (`engineKnowsHoldDial`); otherwise
 * none, and the line that says why — which `planRoll` puts in ATTENTION so
 * the run exits 1. Never a throw: today's four still roll and hold rows on
 * file still retire by expiry. `knows` is a parameter only so both branches
 * can be tested; `main` never passes it.
 *
 * @param {{ nifty: string, sensex: string }} expiries
 * @param {string} todayIst
 * @param {() => boolean} [knows]
 * @returns {{ holdTargets: readonly BookPlan[], holdBlocked: string | null }}
 */
export function planHoldTargets(expiries, todayIst, knows = engineKnowsHoldDial) {
  if (!knows()) {
    return {
      holdTargets: [],
      holdBlocked:
        `hold pairs not created: this engine build does not know ${HOLD_DIAL} — restart desk-supervisor ` +
        'onto the build that does (with this checkout on it), then re-run the roll. A hold book on this ' +
        'build would be steered as an intraday book. Hold rows already on file still retire by expiry.',
    }
  }
  return { holdTargets: planHoldBooks(expiries, todayIst), holdBlocked: null }
}

/**
 * THE PLAYBOOK FAMILY'S GATE, then its plan. Today's playbook targets only
 * when the engine on disk knows `pb_playbook` (`engineKnowsPlaybookDial`)
 * AND `planPlaybookBooks` can make today's plan — a dump that lists no
 * contract far enough out for an intraday preset is its throw. Either way
 * the answer is no targets and the line that says why, which `planRoll` puts
 * in ATTENTION (so the run exits 1) while it leaves every playbook row on
 * file exactly as it is: the retire half never runs without the create
 * half. Never a throw: the four and the hold pairs still roll. `knows` is a
 * parameter only so both branches can be tested; `main` never passes it.
 *
 * @param {{ nearestExpiry(underlying: string, onOrAfter: string): string | null }} master
 * @param {string} todayIst
 * @param {() => boolean} [knows]
 * @returns {{ playbookTargets: readonly BookPlan[], playbookBlocked: string | null }}
 */
export function planPlaybookTargets(master, todayIst, knows = engineKnowsPlaybookDial) {
  if (!knows()) {
    return {
      playbookTargets: [],
      playbookBlocked:
        `playbook books not planned: this engine build does not know ${PLAYBOOK_DIAL} — restart desk-supervisor ` +
        'onto the build that does (with this checkout on it), then re-run the roll. A playbook row on this build ' +
        'runs as a plain delta-lean book (inert: dl_open_lots 0). No playbook book is created or retired until ' +
        'then; the four and the hold pairs still roll.',
    }
  }
  try {
    return { playbookTargets: planPlaybookBooks(master, todayIst), playbookBlocked: null }
  } catch (err) {
    return {
      playbookTargets: [],
      playbookBlocked:
        `playbook books not planned: ${err instanceof Error ? err.message : String(err)}. No playbook book is ` +
        'created or retired this run — the retire never runs without the create; the four and the hold pairs ' +
        'still roll.',
    }
  }
}

/**
 * WHAT THE ROLL WOULD DO, as data. No clock, no Mongo, no HTTP.
 *
 * @param {{
 *   targets: readonly BookPlan[],
 *   holdTargets?: readonly BookPlan[],
 *   holdBlocked?: string | null,
 *   playbookTargets?: readonly BookPlan[],
 *   playbookBlocked?: string | null,
 *   rows: readonly RegistryRow[],
 *   heldByTag: CountByTag,
 *   expiredByTag?: CountByTag,
 *   switchByTag?: Map<string, SwitchState> | Record<string, SwitchState>,
 *   switchedOff?: readonly string[],
 *   todayIst: string,
 * }} input
 *   `targets` is `planBooks(expiriesFrom(master, todayIst), todayIst)` — all
 *   four, both symbols — less any switched-off series (`withoutSeriesOff`, in
 *   `main`, as for the two families below); `switchedOff` names the series so
 *   dropped (`seriesSwitchedOff`), carried onto the plan for the log and never
 *   an anomaly. A symbol with fewer targets is not one either: every row not
 *   among them goes to its family's retire, by dials and day as always.
 *   `holdTargets` is `planHoldBooks(<the same expiries>,
 *   todayIst)` — the hold-to-expiry pair of every symbol whose front contract
 *   does not die today; absent means none is planned (the retire by expiry
 *   still runs). `holdBlocked` is why none was planned (`planHoldTargets`'
 *   engine gate) — an anomaly line when set, so the run exits 1.
 *   `playbookTargets` is `planPlaybookBooks(master, todayIst)`; absent means
 *   none is planned (older playbook rows still retire). `playbookBlocked` is
 *   why the family is not planned today (`planPlaybookTargets`) — an anomaly
 *   line when set, and then the family plans NOTHING: no create, no retire,
 *   its rows listed as gated. `rows` is EVERY paper registry row, unfiltered: the
 *   filter is this function's job so that "never touch a book that is not
 *   delta-lean" is pinned by a test rather than by the caller's query.
 *   `heldByTag` carries the open-leg count per tag; a tag that is absent reads
 *   as unknown. `expiredByTag` carries how many of those legs are on a
 *   contract that expired before today; absent reads as "none known", which
 *   means a holder is alarmed rather than settled. `switchByTag` is every
 *   tag's paper switch (`readSwitches`); a tag it does not list has no
 *   strategy row, which is `not-added`. Absent, the plan is made without the
 *   switches and no running target is ever read as switched off.
 * @returns {RollPlan}
 */
export function planRoll(input) {
  const { targets, rows, heldByTag, todayIst } = input
  const holdTargets = input.holdTargets ?? []
  // Layer 3. The books about to be printed, and possibly posted, are paper.
  assertAllPaper(targets)
  assertAllPaper(holdTargets)
  for (const t of holdTargets) {
    // A planned hold book that does not carry the dial would be created as an
    // intraday engine under a weekly tag — flat by 15:00 on its first day.
    if (!isHold(t)) throw new Error(`planned hold book ${t.tag} does not carry ${HOLD_DIAL}: true`)
    if (!SYMBOLS.some((s) => s.symbol === t.symbol)) {
      throw new Error(`planned a hold book on ${t.symbol}, which is not one of ${SYMBOLS.map((s) => s.symbol).join(', ')}`)
    }
  }
  // A gated family plans nothing, whatever was handed in beside the reason.
  const playbookBlocked = typeof input.playbookBlocked === 'string' ? input.playbookBlocked : null
  const playbookTargets = playbookBlocked === null ? (input.playbookTargets ?? []) : []
  assertAllPaper(playbookTargets)
  for (const t of playbookTargets) {
    // A planned playbook that fails its own test would be registered as a
    // half-member — exactly the row the classification below refuses to roll.
    // And the roll CREATES only the presets in the list, whatever it retires.
    if (!isPlaybook(t) || isHold(t) || !byPlaybookVariant(t)) {
      throw new Error(
        `planned playbook book ${t.tag} is not one of the playbook presets (${PLAYBOOK_PRESET_KEYS.join(', ')}) ` +
          `with playbook dials (${LEAN_DIAL}, ${PLAYBOOK_DIAL})`,
      )
    }
    if (!SYMBOLS.some((s) => s.symbol === t.symbol)) {
      throw new Error(`planned a playbook book on ${t.symbol}, which is not one of ${SYMBOLS.map((s) => s.symbol).join(', ')}`)
    }
    if (!(t.expiry >= todayIst)) {
      throw new Error(`planned playbook book ${t.tag} on the ${t.expiry} contract, before ${todayIst} — a dead contract`)
    }
  }
  // The log says these were not created; a plan that creates one of them
  // anyway was never filtered, and would make that line a lie.
  const switchedOff = [...(input.switchedOff ?? [])]
  for (const t of [...targets, ...holdTargets, ...playbookTargets]) {
    if (switchedOff.includes(t.series)) {
      throw new Error(`planned ${t.tag}, whose series ${t.series} is switched off (SERIES_OFF) — the targets were not filtered`)
    }
  }

  /** @type {HoldPlan} */
  const hold = { ensure: [], onTarget: [], leftStopped: [], carrying: [], retire: [] }
  /** @type {PlaybookPlan} */
  const playbook = { ...emptyPlaybook(), blocked: playbookBlocked }

  if (!isTradingDay(todayIst)) {
    // No session today, so no book for it — and nothing retired either. The
    // retire half never runs without the create half.
    return { todayIst, tradingDay: false, symbols: [], hold, playbook, expiredBooks: [], switchedOff: [], anomalies: [], alarms: [] }
  }

  /**
   * The erase cutoff is TODAY: a book created on any earlier session is done,
   * and leaves the Books page this morning (operator, 2026-10-05: "which is
   * done and closed, why still on tab"). Only a book born today survives it.
   */
  const cutoff = todayIst

  /** @type {string[]} */
  const anomalies = []
  /** @type {string[]} */
  const alarms = []
  if (typeof input.holdBlocked === 'string') anomalies.push(input.holdBlocked)
  if (playbookBlocked !== null) anomalies.push(playbookBlocked)

  /** Absent, non-numeric or non-finite all mean UNKNOWN, which means "do not stop". */
  const held = countReader(heldByTag)
  const expiredCount = countReader(input.expiredByTag)
  /**
   * Every open leg is on a contract that has already expired — the book can be
   * SETTLED (`settle-expired`) and is then flat. One live-contract leg, or a
   * count nobody could read, and the answer is no.
   */
  const allExpired = (/** @type {string} */ t, /** @type {number} */ h) => h > 0 && expiredCount(t) === h

  /**
   * The paper switch of a tag as `main` read it, or null when this plan was
   * made without reading the switches — then nothing below looks at one.
   * Read, a tag with no strategy row at all has no switch to be on.
   * @param {string} tag
   * @returns {SwitchState | null}
   */
  const switchOf = (tag) => {
    const switches = input.switchByTag
    if (switches === undefined) return null
    const got = switches instanceof Map ? switches.get(tag) : switches[tag]
    return got ?? { paper: 'not-added', guard: null }
  }

  /**
   * THE SWITCH-ON THAT DID NOT LAND (review #8). A running target whose
   * paper switch is not on decides all day and has every order refused
   * (spec E3), and the PATCH after the start is what turns on a book whose
   * create left it off — so when that PATCH fails, the run says "fix the
   * cause and re-run", and the re-run must not count the book "on target"
   * and send nothing. Is THIS one the roll's unfinished work? True — finish
   * it with the three calls every book the roll finishes gets: the create
   * converges (re-adding a paper membership that went missing), the start is
   * a no-op on a running row, the PATCH flips it — only when every sign says
   * the switch has been off since this morning's start:
   *
   *   - no day-guard stamp on its paper rail: a book the guard switched off
   *     is the guard's, put back by the guard's own morning re-arm and never
   *     by a hand re-run of the roll;
   *   - registered THIS morning: on a row from an earlier day, a switch that
   *     is off was switched off by somebody, some day;
   *   - never marked (`lastMarkAt` 0): a switched-off flat book idles BEFORE
   *     its mark (`engine-host.ts`), so a book whose switch has been off since
   *     its start never marks; one that has marked was deciding with its
   *     switch on, and the switch went off afterwards. (The residue is a book
   *     somebody switched off before its first mark — the documented way to
   *     take one off is its stop, which a re-run never reverses.)
   *
   * Any other running target whose switch is off — and not the guard's — is
   * one ATTENTION line, and is left exactly as it is.
   *
   * @param {RegistryRow} row a RUNNING row on one of today's target tags
   * @param {string} what which book it is, for the line
   * @returns {boolean}
   */
  const switchToFinish = (row, what) => {
    const sw = switchOf(row.tag)
    if (sw === null || sw.paper === 'on' || sw.guard !== null) return false
    const day = dayOf(row)
    if (day === todayIst && row.lastMarkAt === 0) return true
    anomalies.push(
      `${row.tag} is ${what} and RUNNING, but its paper switch is ` +
        (sw.paper === 'off' ? 'OFF' : 'missing (the tag is not added to paper)') +
        ' — and not by the day guard. It decides all day and every order it places is refused. LEFT AS IT IS: ' +
        (day !== todayIst
          ? `it was registered ${day ?? 'on an unreadable day'}, not this morning`
          : typeof row.lastMarkAt === 'number'
            ? 'it has marked since its start, so its switch went off while it was deciding'
            : 'this run cannot read whether it has ever marked') +
        " — somebody's decision, not a switch-on of this morning's run that did not land. If it is not meant, " +
        (sw.paper === 'off' ? 'switch paper on for it' : 'add it to paper and switch it on') +
        ' from the Strategies page.',
    )
    return false
  }

  /** @type {RegistryRow[]} The rows of OTHER families, for the fourth loop. */
  const otherRows = []
  /** @type {RegistryRow[]} The hold-to-expiry rows — never in the day retire. */
  const holdRows = []
  /** @type {RegistryRow[]} The playbook rows — their own family, set aside first. */
  const playbookRows = []

  /** @type {Map<string, { symbol: string, targetExpiry: string, targets: BookPlan[], rows: RegistryRow[] }>} */
  const bySymbol = new Map()
  for (const { symbol } of SYMBOLS) {
    bySymbol.set(symbol, { symbol, targetExpiry: '', targets: [], rows: [] })
  }

  for (const t of targets) {
    const entry = bySymbol.get(t.symbol)
    if (entry === undefined) {
      throw new Error(`planned a book on ${t.symbol}, which is not one of ${SYMBOLS.map((s) => s.symbol).join(', ')}`)
    }
    if (entry.targetExpiry === '') entry.targetExpiry = t.expiry
    else if (entry.targetExpiry !== t.expiry) {
      // Two target expiries for one symbol means the plan itself is incoherent;
      // rolling against it could retire a live book for a contract that is not
      // the one just created.
      throw new Error(`two target expiries planned for ${t.symbol}: ${entry.targetExpiry} and ${t.expiry}`)
    }
    entry.targets.push(t)
  }

  for (const row of rows) {
    if (row.mode !== PAPER) {
      // Layer 2. The read asked for paper; anything else is a refusal.
      throw new Error(
        `REFUSED: the registry returned ${row.tag} with mode ${JSON.stringify(row.mode)} from a ` +
          `${PAPER}-only read. This script never reads, starts, stops or erases a live book.`,
      )
    }
    // THE PLAYBOOK FAMILY FIRST, by its own test, so that none of its rows
    // ever reaches the four's single-expiry check, their day retire or the
    // fourth loop. Any playbook sign — a variant in the list, or
    // `pb_playbook` stated as anything but 0 — makes the row a member or an
    // anomaly, never something else: a half-member is a misconfiguration to
    // see, and either reading of it could roll a book whose engine this
    // script has mis-read. Membership itself is the DIALS (`isPlaybook`),
    // never the list: a row of a preset whose key has since been removed
    // from PLAYBOOK_PRESET_KEYS (runbook §8.4) shows its sign in
    // `pb_playbook` and is still this family's to retire.
    if (byPlaybookVariant(row) || carriesPlaybookDial(row)) {
      const dials = /** @type {Record<string, unknown>} */ (typeof row.dials === 'object' && row.dials !== null ? row.dials : {})
      const said = (/** @type {string} */ key) => (dials[key] === undefined ? 'absent' : JSON.stringify(dials[key]))
      if (!isPlaybook(row)) {
        anomalies.push(
          `${row.tag}: variant ${JSON.stringify(row.variant)}, ${LEAN_DIAL}=${said(LEAN_DIAL)} and ` +
            `${PLAYBOOK_DIAL}=${said(PLAYBOOK_DIAL)} disagree about whether this is a playbook book — LEFT ` +
            `UNTOUCHED by every loop. A playbook book is one whose dials hand it to the playbook frame — ` +
            `${LEAN_DIAL} true and ${PLAYBOOK_DIAL} at least 1 — under a variant that is not one of the four's ` +
            "or the hold pairs' presets. Fix the dials or the row by hand.",
        )
        continue
      }
      if (isHold(row)) {
        anomalies.push(
          `${row.tag}: a playbook book carrying ${HOLD_DIAL}: true — a weekly engine under a daily tag, which ` +
            'the playbook retire would take the morning after — LEFT UNTOUCHED by every loop. Fix the dial or ' +
            'the row by hand.',
        )
        continue
      }
      if (!SYMBOLS.some((s) => s.symbol === row.symbol)) {
        anomalies.push(
          `${row.tag}: a playbook row on ${row.symbol}, which this script does not manage ` +
            `(${SYMBOLS.map((s) => s.symbol).join(', ')}) — LEFT UNTOUCHED.`,
        )
        continue
      }
      playbookRows.push(row)
      continue
    }
    const variantSays = byVariant(row)
    const dialSays = byDial(row)
    if (!variantSays && !dialSays) {
      // Somebody else's book: never part of the daily roll, only of the
      // fourth loop's expiry rule.
      otherRows.push(row)
      continue
    }
    if (variantSays !== dialSays) {
      anomalies.push(
        `${row.tag}: variant ${JSON.stringify(row.variant)} and ${LEAN_DIAL}=${String(dialSays)} ` +
          'disagree about whether this is a delta-lean book — LEFT UNTOUCHED. A row whose variant ' +
          'says delta-lean while its dials run the recenter engine is a misconfiguration, not a ' +
          'book to roll.',
      )
      continue
    }
    // WHICH delta-lean family: the hold dial, cross-checked against the
    // variant exactly as the lean dial is above. A hold variant without the
    // dial is an intraday engine under a weekly tag; an intraday variant with
    // it is a weekly engine the day retire would stop after one session.
    // Neither is guessed at.
    const holdDial = isHold(row)
    if (byHoldVariant(row) !== holdDial) {
      anomalies.push(
        `${row.tag}: variant ${JSON.stringify(row.variant)} and ${HOLD_DIAL}=${String(holdDial)} ` +
          'disagree about whether this is a hold-to-expiry book — LEFT UNTOUCHED by both the day ' +
          'retire and the expiry retire. Fix the dial or the row by hand.',
      )
      continue
    }
    const entry = bySymbol.get(row.symbol)
    if (entry === undefined) {
      anomalies.push(
        `${row.tag}: a delta-lean row on ${row.symbol}, which this script does not manage ` +
          `(${SYMBOLS.map((s) => s.symbol).join(', ')}) — LEFT UNTOUCHED.`,
      )
      continue
    }
    if (holdDial) holdRows.push(row)
    else entry.rows.push(row)
  }

  /** @type {SymbolPlan[]} */
  const symbols = []
  for (const entry of bySymbol.values()) {
    const rowByTag = new Map(entry.rows.map((r) => [r.tag, r]))
    const targetTags = new Set(entry.targets.map((t) => t.tag))
    /**
     * Every DAILY delta-lean row of this symbol that is NOT one of today's
     * four is a candidate for retirement — by tag identity against the plan,
     * never by parsing the tag, and never by its expiry. Hold-to-expiry rows
     * never reach this list (they were set aside above, by the dial): a book
     * that lives a week is not done because the day it was born is over.
     */
    const others = entry.rows.filter((r) => !targetTags.has(r.tag))
    /**
     * The old books this run is actually going to take off the desk: still
     * asked to run, AND read as flat. Only those are a reason to start a
     * target book the operator stopped — a holder or an unreadable book is
     * left running whatever today's books do (see the retire loop below), so
     * it is no reason to reverse a hand-stop, nor, since every start is
     * followed by the switch PATCH, to flip that book's switch.
     */
    const needed = others.filter((r) => r.desired === 'running' && held(r.tag) === 0)

    /** @type {EnsureEntry[]} */
    const ensure = []
    /** @type {Holding[]} */
    const onTarget = []
    /** @type {Holding[]} */
    const leftStopped = []

    for (const target of entry.targets) {
      const row = rowByTag.get(target.tag)
      if (row === undefined) {
        // No book at all for today. Always closed, whatever else is going on
        // — that gap is the whole reason this script exists.
        ensure.push({ plan: target, why: 'missing' })
        continue
      }
      if (row.desired === 'running') {
        // Running — and switched on, or switched off by somebody (an
        // ATTENTION line), or this morning's switch-on that did not land,
        // which is finished like any half-done book.
        if (switchToFinish(row, `one of today's ${entry.symbol} books`)) ensure.push({ plan: target, why: 'switched-off' })
        else onTarget.push({ row, held: held(row.tag) })
        continue
      }
      if (needed.length > 0) {
        // It has to run before the old one can be retired, or the retire
        // would leave the symbol uncovered.
        ensure.push({ plan: target, why: 'stopped-but-needed' })
      } else {
        // Nothing to retire for this symbol, so a stopped book on today's tag
        // is the operator's decision and not this script's to reverse.
        leftStopped.push({ row, held: held(row.tag) })
      }
    }

    // After the ensure step, is every target book of this symbol running? A
    // symbol with NO target books is never covered: "all zero of them are
    // running" must not read as true, or a plan that dropped a symbol would
    // retire every book of that symbol with nothing replacing it.
    const covered = entry.targets.length > 0 && onTarget.length + ensure.length === entry.targets.length

    /** @type {RetireEntry[]} */
    const retire = []
    for (const row of others) {
      const h = held(row.tag)
      const running = row.desired === 'running'
      // `bookFromDoc` (books-registry.ts) answers `createdAt: 0` for a document
      // that has none or carries a non-number — never NaN, never undefined.
      // 0 is 1970-01-01 in IST, before every cutoff, so it is read here as
      // UNKNOWN, the same way `updatedAt: 0` is read elsewhere; a finite
      // check alone would erase such a row on the strength of a day it never
      // had.
      const day =
        typeof row.createdAt === 'number' && Number.isFinite(row.createdAt) && row.createdAt > 0
          ? istDate(row.createdAt)
          : null
      /** @type {RetireAction} */
      let action
      if (h === null) action = running ? 'unknown' : 'stopped-unknown'
      else if (allExpired(row.tag, h)) {
        // Every leg it holds is on a dead contract: no flatten can ever fill
        // it, and the exchange has already settled it. Book that settlement
        // (`settle-expired`), and the book is flat — then the usual day rule.
        action = !covered ? 'blocked' : day !== null && day < cutoff ? 'settle-then-erase' : 'settle-then-stop'
      } else if (h > 0) action = running ? 'holds-legs' : 'stopped-holds-legs'
      else if (day === null) {
        anomalies.push(
          `${row.tag}: createdAt is not a readable timestamp — will be stopped but never erased ` +
            'by this script. Set it by hand (epoch ms) or delete the row from the Books page.',
        )
        action = running ? (covered ? 'stop' : 'blocked') : 'stopped-flat'
      } else if (day < cutoff) {
        // ISO dates compare lexicographically, which is chronologically. Erase
        // applies whether the row runs or is already stopped; a running one is
        // stopped first by `applyRoll`.
        action = covered ? 'erase' : 'blocked'
      } else if (running) action = covered ? 'stop' : 'blocked'
      else action = 'stopped-flat'
      retire.push({ row, held: h, day, action })

      const was = `not one of today's books (created ${day ?? 'on an unreadable day'}; today is ${todayIst})`
      if (action === 'holds-legs') {
        alarms.push(
          `${row.tag} is ${was} and HOLDS ${String(h)} open leg(s) — NOT STOPPED. A stop does ` +
            'not flatten and a stopped book is not steered, so stopping it would strand the ' +
            'position with nothing watching it. It should have been flat at 15:00 on its own day ' +
            '(D4). Find out why it was not, deal with the legs by hand (flatten from the dashboard), ' +
            'and a later run retires the book once it reads flat.',
        )
      } else if (action === 'unknown') {
        alarms.push(
          `${row.tag} is ${was} and this script CANNOT TELL whether it is flat (its desk-books ` +
            'document is missing a leg array or carries a leg with no usable qty) — NOT STOPPED. ' +
            'Check it by hand before retiring it.',
        )
      } else if (action === 'stopped-holds-legs') {
        alarms.push(
          `${row.tag} is ${was}, is ALREADY STOPPED, and still HOLDS ${String(h)} open leg(s). A ` +
            'stopped book does not flatten itself — nothing is steering it. Flatten it from the ' +
            'dashboard; this script will not start it again to do so, and will not erase it.',
        )
      } else if (action === 'stopped-unknown') {
        alarms.push(
          `${row.tag} is ${was}, is already stopped, and this script cannot tell whether it is ` +
            'flat. Check it by hand; it is not erased until it reads flat.',
        )
      } else if (action === 'blocked') {
        alarms.push(
          `${row.tag} is ${was} and ${h !== null && h > 0 ? 'holds only legs on expired contracts' : 'flat'}, ` +
            `but today's ${entry.symbol} books would not all be ` +
            'running — RETIRE WITHHELD, so the roll never leaves a symbol uncovered.',
        )
      }
    }

    symbols.push({
      symbol: entry.symbol,
      targetExpiry: entry.targetExpiry,
      ensure,
      onTarget,
      leftStopped,
      retire,
    })
  }

  /**
   * THE FOURTH LOOP — every OTHER paper book, retired at its contract's end
   * (operator, 2026-10-04: "books tabs should get removed automatically after
   * expiry"). A row of another family (a monthly stock book, say) whose
   * `expiry` is before today has nothing left to trade: its
   * expired legs are settled, it is stopped if running, and it is erased. The
   * same refusals as the delta-lean half — a leg in a LIVE contract, or a book
   * this run cannot read, is alarmed and left exactly where it is. Rows whose
   * variant and dial disagree never get here; they are anomalies above.
   *
   * Its own day rule is the CONTRACT's, deliberately unlike the daily books':
   * a stock book lives a month and its creation day says nothing about whether
   * it is done. The cutoff is the same — today — so a book whose contract
   * expired on any earlier session, yesterday included, is retired this
   * morning; a contract expiring TODAY is still trading and is left alone.
   */
  /**
   * A STOPPED hold book that is not flat: a position nothing steers — and a
   * hold book's contract can be days away.
   * @param {RegistryRow} row
   * @param {number | null} h
   * @param {string} what
   */
  const stoppedHolderAlarm = (row, h, what) =>
    `${row.tag} ${what}, is STOPPED, and ` +
    (h === null ? 'this script CANNOT TELL whether it is flat' : `still HOLDS ${String(h)} open leg(s)`) +
    ' — a position nothing is steering, possibly for days. A stopped book does not flatten itself and ' +
    'the roll will not start one that holds. Flatten it from the dashboard, or start it from the Books ' +
    'page if it should be steered.'

  /**
   * RETIRE BY EXPIRY — the one rule the hold pairs and the fourth loop share.
   * Flat → erase (stopped first if running); every open leg on a dead
   * contract → settle, then erase; a leg on a live contract, or a book this
   * run cannot read → alarm, untouched.
   *
   * @param {RegistryRow} row
   * @param {string} was what the row is, for the alarm
   * @returns {RetireEntry}
   */
  const retireByExpiry = (row, was) => {
    const h = held(row.tag)
    const running = row.desired === 'running'
    const day = dayOf(row)
    /** @type {RetireAction} */
    let action
    if (h === null) action = running ? 'unknown' : 'stopped-unknown'
    else if (allExpired(row.tag, h)) action = 'settle-then-erase'
    else if (h > 0) action = running ? 'holds-legs' : 'stopped-holds-legs'
    else action = 'erase'

    if (action === 'holds-legs' || action === 'stopped-holds-legs') {
      alarms.push(
        `${row.tag} is ${was} and still HOLDS ${String(h)} open leg(s), at least one on a live contract — ` +
          `NOT ${running ? 'STOPPED' : 'ERASED'}. A live-contract leg is a position, not a settlement; ` +
          'close it by hand and a later run retires the book.',
      )
    } else if (action === 'unknown' || action === 'stopped-unknown') {
      alarms.push(
        `${row.tag} is ${was} and this script CANNOT TELL what it holds — LEFT ALONE. Check it by hand.`,
      )
    }
    return { row, held: h, day, action }
  }

  /**
   * THE HOLD-TO-EXPIRY PAIRS (spec 2026-10-05). Created like today's four —
   * the same three calls, right after them — when today's front contract for
   * a symbol is not today's (`planHoldBooks` says which). Never retired by
   * their creation day: they were kept out of the day retire above, by the
   * dial. Retired instead by the CONTRACT: the morning after it expires, by
   * the same rule as the fourth loop. A hold row whose contract has not yet
   * expired and that is not today's target — the pair carrying to this
   * afternoon's expiry, or one registered by hand for a later contract — is
   * carried, untouched.
   *
   * A stopped hold row on today's own tag is NOT started — a stop on a
   * week-long book is the operator's decision — unless it was registered THIS
   * morning, is flat, and no start has ever reached it (`neverStarted`),
   * which is a run that died between its create and its start. Left stopped,
   * it is an anomaly line (exit 1) when flat and an alarm when not: a cron
   * run must not pass a week-long book off the desk in silence.
   */
  const anyRowByTag = new Map(rows.map((r) => [r.tag, r]))
  const holdRowByTag = new Map(holdRows.map((r) => [r.tag, r]))
  const holdTargetTags = new Set(holdTargets.map((t) => t.tag))
  for (const target of holdTargets) {
    const row = holdRowByTag.get(target.tag)
    if (row === undefined) {
      if (anyRowByTag.has(target.tag)) {
        // Something holds the tag that is not a hold book: an anomaly above,
        // or another family. A create would converge on it and the start
        // would put it on the desk — so nothing is sent.
        anomalies.push(
          `${target.tag}: today's hold-to-expiry tag is registered, but not as a hold-to-expiry book — ` +
            'NOT created, started or switched on. Sort the row out by hand.',
        )
        continue
      }
      hold.ensure.push({ plan: target, why: 'missing' })
    } else if (row.desired === 'running') {
      if (switchToFinish(row, "this contract's hold-to-expiry book")) hold.ensure.push({ plan: target, why: 'switched-off' })
      else hold.onTarget.push({ row, held: held(row.tag) })
    } else {
      const h = held(row.tag)
      const day = dayOf(row)
      if (h === 0 && day === todayIst && neverStarted(row)) {
        // Registered THIS morning, flat, stopped, and no start has ever
        // reached it: a run that died between its create and its start.
        // Finish the job — the same three calls, the create converging on
        // the row on file. A row stopped after it ran is not this.
        hold.ensure.push({ plan: target, why: 'created-not-started' })
        continue
      }
      hold.leftStopped.push({ row, held: h })
      if (h !== 0) alarms.push(stoppedHolderAlarm(row, h, "is this contract's hold-to-expiry book"))
      else {
        anomalies.push(
          `${row.tag} is this contract's hold-to-expiry book and is STOPPED (flat, registered ` +
            `${day ?? 'on an unreadable day'}) — left stopped: a stop on a week-long book is the operator's ` +
            'call, never reversed by the roll. If it was not meant, start it from the Books page; until it ' +
            'runs or is erased, every run names it here and exits 1.',
        )
      }
    }
  }
  for (const row of holdRows) {
    if (holdTargetTags.has(row.tag)) continue
    if (typeof row.expiry !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(row.expiry)) {
      anomalies.push(
        `${row.tag}: a hold-to-expiry row with no readable expiry (${JSON.stringify(row.expiry)}) — ` +
          'LEFT UNTOUCHED; its expiry is the only clock a hold book is retired by.',
      )
      continue
    }
    // A contract expiring TODAY is still trading: the pair holds to the close.
    if (!(row.expiry < cutoff)) {
      const h = held(row.tag)
      hold.carrying.push({ row, held: h })
      if (row.desired !== 'running' && h !== 0) {
        alarms.push(stoppedHolderAlarm(row, h, `is a hold-to-expiry book on a contract expiring ${row.expiry}`))
      }
      continue
    }
    hold.retire.push(retireByExpiry(row, `a hold-to-expiry book whose contract expired ${row.expiry}`))
  }

  /**
   * THE PLAYBOOK FAMILY (spec 2026-10-16 §4.9) — its own create and its own
   * retire, over the rows the classification above set aside by
   * `isPlaybook`.
   *
   * CREATE by tag identity against today's plans, like the hold pairs: a
   * missing row is created, a running one is on target, and a stopped one
   * is started only when it is flat, was registered THIS morning and no
   * start has ever reached it (`neverStarted`) — a run that died between its
   * create and its start. Any other stopped target is the operator's call,
   * left stopped and named in ATTENTION.
   *
   * RETIRE every other playbook row whose day (`playbookDayOf`) is before
   * today — the morning after its one session. Flat → erase (stopped first
   * if running); every open leg on a dead contract → settle, then erase,
   * exactly as the four's retire does; a holder of a live-contract leg or an
   * unreadable book → alarm, untouched. There is no coverage rule: a playbook
   * book of yesterday covers nothing today, but left running it would trade
   * today under yesterday's tag. A playbook row of TODAY that is not a plan —
   * a hand-registered extra — is never touched.
   *
   * GATED, the family plans nothing and every row is listed as it stands.
   */
  /**
   * @param {RegistryRow} row
   * @param {number | null} h
   * @param {string} what
   */
  const stoppedPlaybookAlarm = (row, h, what) =>
    `${row.tag} ${what}, is STOPPED, and ` +
    (h === null ? 'this script CANNOT TELL whether it is flat' : `still HOLDS ${String(h)} open leg(s)`) +
    ' — a position nothing is steering. A stopped book does not flatten itself and the roll will not start ' +
    'one that is not flat. Flatten it from the dashboard, or start it from the Books page if it should be steered.'

  if (playbookBlocked !== null) {
    for (const row of playbookRows) playbook.gated.push({ row, held: held(row.tag) })
  } else {
    const playbookRowByTag = new Map(playbookRows.map((r) => [r.tag, r]))
    const playbookTargetTags = new Set(playbookTargets.map((t) => t.tag))
    for (const target of playbookTargets) {
      const row = playbookRowByTag.get(target.tag)
      if (row === undefined) {
        if (anyRowByTag.has(target.tag)) {
          // Somebody else holds the tag — an anomaly above, or another family.
          // A create would converge on it and the start would put it on the
          // desk, so nothing is sent.
          anomalies.push(
            `${target.tag}: today's playbook tag is registered, but not as a playbook book — NOT created, ` +
              'started or switched on. Sort the row out by hand.',
          )
          continue
        }
        playbook.ensure.push({ plan: target, why: 'missing' })
        continue
      }
      if (row.desired === 'running') {
        if (switchToFinish(row, "one of today's playbook books")) playbook.ensure.push({ plan: target, why: 'switched-off' })
        else playbook.onTarget.push({ row, held: held(row.tag) })
        continue
      }
      const h = held(row.tag)
      const day = dayOf(row)
      if (h === 0 && day === todayIst && neverStarted(row)) {
        // The hold pairs' rule, for the same reason: only a row no start has
        // ever reached is a run that died; one stopped after it ran is the
        // operator's, and starting it would switch it back on in its window.
        playbook.ensure.push({ plan: target, why: 'created-not-started' })
        continue
      }
      playbook.leftStopped.push({ row, held: h })
      if (h !== 0) alarms.push(stoppedPlaybookAlarm(row, h, "is one of today's playbook books"))
      else {
        anomalies.push(
          `${row.tag} is one of today's playbook books and is STOPPED (flat, registered ` +
            `${day ?? 'on an unreadable day'}) — left stopped: only a flat row registered this morning that no ` +
            'start has ever reached (nothing has written to it since its create) is a run that died before its ' +
            "start, and the roll finishes only that. Any other stop is the operator's call; start it from the " +
            'Books page if it was not meant. Every run today names it here and exits 1.',
        )
      }
    }

    for (const row of playbookRows) {
      if (playbookTargetTags.has(row.tag)) continue
      const day = playbookDayOf(row)
      const h = held(row.tag)
      if (day === null) {
        anomalies.push(
          `${row.tag}: a playbook row with no readable createdAt and no date in its tag — LEFT UNTOUCHED. A ` +
            'playbook book is retired the morning after its day, and this one has no day this script can read. ' +
            'Delete it from the Books page once it reads flat.',
        )
        continue
      }
      if (!(day < todayIst)) {
        // Today's — or later, by a clock or a hand: never touched. A stopped
        // one that is not flat is still a position nothing steers.
        playbook.ofToday.push({ row, held: h })
        if (row.desired !== 'running' && h !== 0) alarms.push(stoppedPlaybookAlarm(row, h, 'is a playbook book of today'))
        continue
      }
      const running = row.desired === 'running'
      /** @type {RetireAction} */
      let action
      if (h === null) action = running ? 'unknown' : 'stopped-unknown'
      else if (allExpired(row.tag, h)) {
        // Every leg it holds is on a dead contract — the 0-DTE wing at ₹0.05
        // with no bid that could not be sold and expired with the contract.
        // No flatten can ever fill it and the exchange has already settled
        // it, so this is the rule the four, the hold books and the fourth
        // loop use: book that settlement (`settle-expired`), and only a row
        // the server then confirms flat goes on to the stop and the erase —
        // a refusal leaves it where it is, in ATTENTION. Always the erase:
        // a row in this retire is from an earlier day.
        action = 'settle-then-erase'
      } else if (h > 0) action = running ? 'holds-legs' : 'stopped-holds-legs'
      else action = 'erase'
      playbook.retire.push({ row, held: h, day, action })

      const was = `a playbook book from ${day} (one session only; today is ${todayIst})`
      if (action === 'holds-legs') {
        alarms.push(
          `${row.tag} is ${was} and still HOLDS ${String(h)} open leg(s) — not all of them on a contract that ` +
            'has expired, so there is nothing the roll can settle — NOT STOPPED. A stop does not flatten and a ' +
            'stopped book is not steered, so stopping it would strand the position with nothing watching it. It ' +
            'should have been flat by 15:00 on its own day. Deal with the live legs by hand (flatten from the ' +
            'dashboard), and a later run settles whatever is left on a dead contract and retires the book.',
        )
      } else if (action === 'stopped-holds-legs') {
        alarms.push(
          `${row.tag} is ${was}, is ALREADY STOPPED, and still HOLDS ${String(h)} open leg(s). A stopped book ` +
            'does not flatten itself — nothing is steering it. Flatten it from the dashboard; this script will ' +
            'not start it again to do so, and will not erase it.',
        )
      } else if (action === 'unknown' || action === 'stopped-unknown') {
        alarms.push(
          `${row.tag} is ${was} and this script CANNOT TELL whether it is flat (its desk-books document is ` +
            'missing a leg array or carries a leg with no usable qty) — LEFT ALONE. Check it by hand.',
        )
      }
    }
  }

  /** @type {RetireEntry[]} */
  const expiredBooks = []
  for (const row of otherRows) {
    if (typeof row.expiry !== 'string' || !(row.expiry < cutoff)) continue
    expiredBooks.push(retireByExpiry(row, `a ${row.variant} book whose contract expired ${row.expiry}`))
  }

  return { todayIst, tradingDay: true, symbols, hold, playbook, expiredBooks, switchedOff, anomalies, alarms }
}

/**
 * Every book this plan would create (or start), for a caller that wants one
 * last look — today's four first, then the hold-to-expiry pairs, then the
 * playbook books: the order `applyRoll` sends them in.
 * @param {RollPlan} plan
 * @returns {readonly BookPlan[]}
 */
export function createdBooks(plan) {
  return [
    ...plan.symbols.flatMap((s) => s.ensure.map((e) => e.plan)),
    ...holdOf(plan).ensure.map((e) => e.plan),
    ...playbookOf(plan).ensure.map((e) => e.plan),
  ]
}

/**
 * The plan's hold half, or an empty one for a plan built without it.
 * @param {RollPlan} plan
 * @returns {HoldPlan}
 */
function holdOf(plan) {
  return plan.hold ?? { ensure: [], onTarget: [], leftStopped: [], carrying: [], retire: [] }
}

/** @returns {PlaybookPlan} an empty playbook half, planned and ungated */
function emptyPlaybook() {
  return { blocked: null, ensure: [], onTarget: [], leftStopped: [], ofToday: [], retire: [], gated: [] }
}

/**
 * The plan's playbook half, or an empty one for a plan built without it.
 * @param {RollPlan} plan
 * @returns {PlaybookPlan}
 */
function playbookOf(plan) {
  return plan.playbook ?? emptyPlaybook()
}

/**
 * Every book this plan would STOP: the running ones about to be erased (a
 * DELETE on a running row is a 409), and the few that are only stopped.
 * @param {RollPlan} plan
 * @returns {readonly string[]}
 */
export function stoppedTags(plan) {
  return allRetires(plan).filter(needsStop).map((e) => e.row.tag)
}

/**
 * Every book this plan would ERASE.
 * @param {RollPlan} plan
 * @returns {readonly string[]}
 */
export function erasedTags(plan) {
  return allRetires(plan).filter(needsErase).map((e) => e.row.tag)
}

/**
 * Every book this plan would SETTLE before retiring it.
 * @param {RollPlan} plan
 * @returns {readonly string[]}
 */
export function settledTags(plan) {
  return allRetires(plan).filter(needsSettle).map((e) => e.row.tag)
}

/** @param {RollPlan} plan — the daily retires, the hold retires, the playbook retires, then the fourth loop's */
function allRetires(plan) {
  return [
    ...plan.symbols.flatMap((s) => s.retire),
    ...holdOf(plan).retire,
    ...playbookOf(plan).retire,
    ...(plan.expiredBooks ?? []),
  ]
}

/** @param {RetireEntry} e */
function needsSettle(e) {
  return e.action === 'settle-then-stop' || e.action === 'settle-then-erase'
}

/** @param {RetireEntry} e */
function needsErase(e) {
  return e.action === 'erase' || e.action === 'settle-then-erase'
}

/** @param {RetireEntry} e */
function needsStop(e) {
  if (e.action === 'stop') return true
  return (needsErase(e) || e.action === 'settle-then-stop') && e.row.desired === 'running'
}

// ───────────────────────────────────────────────────────────────── the wire

/**
 * A REFUSAL AT THE WIRE — a paper check, or a flat check, on the line that
 * sends. Never fenced (see `applyRoll`): it aborts the run wherever it fires,
 * the playbook family's loops included, because it says the plan or the
 * registry holds something this script must never act on — not that one
 * request had a bad moment.
 *
 * @param {string} message
 * @returns {Error}
 */
function wireRefusal(message) {
  const err = new Error(message)
  err.name = 'WireRefusal'
  return err
}

/** @param {unknown} err */
function isWireRefusal(err) {
  return err instanceof Error && err.name === 'WireRefusal'
}

/** @param {unknown} err */
function messageOf(err) {
  return err instanceof Error ? err.message : String(err)
}

/**
 * CREATE, START AND SWITCH ON FIRST. THEN EVERY STOP. THEN EVERY ERASE.
 *
 * Separate loops, not one — the ordering is the safety property and it is
 * expressed as structure so no future edit can interleave them by accident.
 * Anything that goes wrong creating today's four or the hold pairs throws
 * before a single stop, which leaves the desk with a book too many rather
 * than none; anything wrong in a stop throws before that family's DELETEs —
 * and, outside the playbook fence below, ends the run there.
 *
 * The first loop creates today's four, then the hold-to-expiry pairs, then
 * today's playbook books. The retires then go family by family — the daily
 * books, the hold books past their contract, the playbook books from an
 * earlier day, every other family past its contract — each as settle, then
 * every stop, then every erase.
 *
 * THE PLAYBOOK FAMILY IS FENCED. It is the newest family and goes last so
 * that a failure in it costs the others nothing — and that is made true here
 * rather than left to the order: a create, start or switch-on of a playbook
 * book that fails stops the playbook family at that book (the ones after it
 * are not sent), becomes one line in `refused` — ATTENTION, exit 1 — and
 * skips exactly one loop, the playbook retire, because the retire half never
 * runs without the create half. The four's and the pairs' retires and the
 * fourth loop still run. The playbook retire is fenced the same way: a stop
 * or erase there that fails ends that retire with one `refused` line, and
 * the fourth loop after it still runs. A wire refusal (`wireRefusal`) is not
 * a failure and is never fenced: it aborts the run as it does everywhere.
 *
 * `refused` is therefore everything this run could not do and carried on
 * past: a settle or a DELETE the server refused, and a playbook loop that
 * could not be finished. Each line names its book.
 *
 * `request` is injected so the suite can record the ORDER of the calls against
 * a real registry server. It answers `{ status, body, text }`.
 *
 * @param {RollPlan} plan
 * @param {{ request: Request, log?: (line: string) => void }} io
 */
export async function applyRoll(plan, io) {
  const request = io.request
  const log = io.log ?? (() => {})
  let created = 0
  let started = 0
  let switchedOn = 0
  let stopped = 0
  let erased = 0
  let settled = 0
  /** @type {string[]} */
  const refused = []

  if (plan.tradingDay === false) return { created, started, switchedOn, stopped, erased, settled, refused }

  /**
   * One book's three calls — create, start, switch on — or a throw naming the
   * call that failed. `after` is the sentence that says what that failure
   * does to the rest of THIS run, which is not the same for every family.
   *
   * @param {EnsureEntry} entry
   * @param {string} after
   */
  const ensureOne = async ({ plan: book, why }, after) => {
    // Layer 4. THE LAST CHECK BEFORE THE WIRE, on the object that is sent.
    if (book.mode !== PAPER) {
      throw wireRefusal(`REFUSED at the wire: ${book.tag} is mode ${JSON.stringify(book.mode)}`)
    }
    const create = await request('POST', REGISTRY, book)
    if (create.status !== 201 && create.status !== 200) {
      throw new Error(
        `create ${book.tag} failed: HTTP ${create.status} ${create.text}` +
          (create.status === 409
            ? '\n  A DIFFERENT book already holds this tag. That 409 is deliberate — the ' +
              'registry never re-points an existing tag at another book, because silently ' +
              'moving a book that may hold a position is worse than refusing. Sort the tag ' +
              'out by hand.'
            : '') +
          `\n  ${after}`,
      )
    }
    const row = /** @type {Record<string, unknown> | null} */ (create.body)
    if (row !== null && typeof row === 'object' && row['mode'] !== PAPER) {
      throw wireRefusal(`REFUSED: the registry echoed mode ${JSON.stringify(row['mode'])} for ${book.tag}`)
    }
    created += 1
    log(
      `  created  ${book.tag}  (HTTP ${create.status}${create.status === 200 ? ', already registered' : ''}` +
        `${why === 'stopped-but-needed' ? ', row existed and was stopped' : ''}` +
        `${why === 'created-not-started' ? ', registered earlier this morning and never started' : ''}` +
        `${why === 'switched-off' ? ', running with its paper switch off since its start' : ''})`,
    )

    // Layer 5. The mode is required IN THE BODY of a start; omitting it 400s.
    const start = await request('POST', `${REGISTRY}/${book.tag}/start`, { mode: PAPER })
    if (start.status !== 200) {
      throw new Error(`start ${book.tag} failed: HTTP ${start.status} ${start.text}\n  ${after}`)
    }
    started += 1
    log(`  started  ${book.tag}  (${book.symbol} ${book.expiry}, ${book.variant})`)

    // The switch, after EVERY start this run issues. A running book that is
    // switched off decides all day and has every order refused (spec E3).
    // 400 "not added" means the create did not land its strategy row; 404
    // means there is no row at all. Either is a fault to stop on.
    const on = await request('PATCH', `${STRATEGIES}/${book.tag}`, PAPER_ON)
    if (on.status !== 200) {
      throw new Error(
        `switch on ${book.tag} failed: HTTP ${on.status} ${on.text}` +
          '\n  The book is registered and started but its paper switch is OFF, so every order it ' +
          `places will be refused. ${after} Flip it from the Strategies page, or fix the cause ` +
          'and re-run: a re-run switches on a book of this morning that runs with its switch off ' +
          'and has never marked — which a switched-off book never does.',
      )
    }
    switchedOn += 1
    log(`  switched on  ${book.tag}  (modes.paper.enabled: true)`)
  }

  // ─── loop 1: today's four, THEN the hold-to-expiry pairs — the same three
  // calls each, every one of them before a single stop, and a failure throws
  // HERE: a bad morning leaves a book too many, never none ───
  for (const entry of [...plan.symbols.flatMap((s) => s.ensure), ...holdOf(plan).ensure]) {
    await ensureOne(entry, 'Nothing has been retired.')
  }

  // ─── and THEN today's playbook books, still before a single stop — the
  // newest family, behind a fence of its own ───
  /** Why the playbook family could not be finished this run, or null. While set, its retire is not sent. */
  let playbookFailed = null
  try {
    for (const entry of playbookOf(plan).ensure) {
      await ensureOne(
        entry,
        'The playbook family stops at this book — the playbook books after it were not sent — and the ' +
          'playbook retire is SKIPPED this run (the retire never runs without the create): every playbook ' +
          'row of an earlier day is left exactly as it is. The four, the hold pairs and every other ' +
          'retire still roll.',
      )
    }
  } catch (err) {
    if (isWireRefusal(err)) throw err
    playbookFailed = messageOf(err)
    const line = `PLAYBOOK FAMILY NOT FINISHED — ${playbookFailed}`
    refused.push(line)
    log(`  REFUSED  ${line}`)
  }

  /**
   * Books whose settlement the server CONFIRMED left them flat. Only those of
   * the settle entries may go on to a stop or an erase; one whose settle was
   * refused (no close on file — 409) or left legs behind stays exactly where it
   * is, and is named in `refused`.
   * @type {Set<string>}
   */
  const settledFlat = new Set()

  /**
   * SETTLE, STOP, ERASE over one set of retire entries — three loops, never
   * interleaved, for the same reason the whole roll is.
   * @param {readonly RetireEntry[]} entries
   */
  const retire = async (entries) => {
    // ─── settle: book the dead contracts out at intrinsic, and confirm flat ───
    for (const entry of entries) {
      if (!needsSettle(entry)) continue
      if (entry.row.mode !== PAPER) {
        throw wireRefusal(`REFUSED at the wire: ${entry.row.tag} is mode ${JSON.stringify(entry.row.mode)}`)
      }
      const res = await request('POST', `${REGISTRY}/${entry.row.tag}/settle-expired?mode=${PAPER}`)
      const body = /** @type {{ remaining?: unknown, settled?: unknown } | null} */ (res.body)
      if (res.status === 200 && body !== null && body.remaining === 0) {
        settledFlat.add(entry.row.tag)
        settled += 1
        const legs = Array.isArray(body.settled) ? body.settled.length : 0
        log(`  settled  ${entry.row.tag}  (${legs} expired leg(s) booked out at intrinsic; flat)`)
        continue
      }
      // ANYTHING ELSE IS A PER-BOOK REFUSAL, NEVER AN ABORT. A 409 is the
      // server declining to price it (or an order still out on the contract);
      // a 200 with legs left is a live leg; a 404 is a desk-api not yet
      // restarted onto a build with this route; a 5xx is a bad moment. In
      // every case this book stays exactly as it is, it is named in
      // ATTENTION, the run exits 1 — and the other books' stops and erases
      // still go out. Aborting here would skip every one of them.
      const line =
        res.status === 200
          ? `${entry.row.tag}: settle-expired left remaining=${String(body?.remaining)} leg(s) — NOT RETIRED`
          : `${entry.row.tag}: settle-expired refused (HTTP ${res.status}) — ${res.text}`
      refused.push(line)
      log(`  REFUSED  ${line}`)
    }

    // ─── stop: and ONLY now, with today covered, the old books come off ───
    for (const entry of entries) {
      if (!needsStop(entry)) continue
      if (needsSettle(entry) && !settledFlat.has(entry.row.tag)) continue
      refuseUnlessFlat(entry, 'stop', settledFlat)
      const stop = await request('POST', `${REGISTRY}/${entry.row.tag}/stop`, { mode: PAPER })
      if (stop.status !== 200) {
        throw new Error(`stop ${entry.row.tag} failed: HTTP ${stop.status} ${stop.text}`)
      }
      stopped += 1
      log(`  stopped  ${entry.row.tag}  (created ${entry.day ?? 'unknown day'}, flat)`)
    }

    // ─── erase: and only after every stop ───
    for (const entry of entries) {
      if (!needsErase(entry)) continue
      if (needsSettle(entry) && !settledFlat.has(entry.row.tag)) continue
      refuseUnlessFlat(entry, 'erase', settledFlat)
      // THE ONE DELETE THIS SCRIPT SENDS. `?mode=paper` and nothing else: no
      // `flatten=1` (it places orders), no `purge=1` (it erases the fills and
      // decisions the Reports page is built on), no body.
      const del = await request('DELETE', `${REGISTRY}/${entry.row.tag}?mode=${PAPER}`)
      if (del.status === 200) {
        erased += 1
        log(
          `  erased   ${entry.row.tag}  (created ${entry.day}; registry row and book doc removed — ` +
            'fills, order events, daily reports and engine decisions are kept)',
        )
        continue
      }
      if (del.status === 409) {
        // The server's own fills guard said no. That is its job; the row stays
        // stopped and registered, and the other erases still go out.
        const line = `${entry.row.tag}: DELETE refused (HTTP 409) — ${del.text}`
        refused.push(line)
        log(`  REFUSED  ${line}`)
        continue
      }
      throw new Error(`erase ${entry.row.tag} failed: HTTP ${del.status} ${del.text}`)
    }
  }

  // ─── loops 2–4: with today covered, the old daily delta-lean books come off ───
  await retire(plan.symbols.flatMap((s) => s.retire))

  // ─── then the hold-to-expiry books whose contract is past — same three loops ───
  await retire(holdOf(plan).retire)

  // ─── then the playbook books whose day is over — behind the same fence as
  // their create, and not at all when that create could not be finished ───
  const playbookRetire = playbookOf(plan).retire
  if (playbookFailed !== null) {
    if (playbookRetire.length > 0) {
      log(
        `  SKIPPED  the playbook retire — ${playbookRetire.length} row(s) of an earlier day left as they are, ` +
          "because today's playbook books did not all go out (see ATTENTION)",
      )
    }
  } else {
    try {
      await retire(playbookRetire)
    } catch (err) {
      if (isWireRefusal(err)) throw err
      const line =
        `PLAYBOOK RETIRE NOT FINISHED — ${messageOf(err)}\n  The rest of the playbook retire was not sent; ` +
        'every other family still rolled. Each playbook row it did not reach is left as it was, and the ' +
        'next run retires it by the same rule (a flat row already stopped is simply erased).'
      refused.push(line)
      log(`  REFUSED  ${line}`)
    }
  }

  // ─── and only then, every OTHER paper book past its expiry ───
  await retire(plan.expiredBooks ?? [])

  return { created, started, switchedOn, stopped, erased, settled, refused }
}

/**
 * Belt and braces over `planRoll`, on the line that actually sends: the only
 * book that may be stopped or erased is one this run READ as holding nothing
 * — or whose settlement the server just confirmed left it flat — and it is
 * paper.
 *
 * @param {RetireEntry} entry
 * @param {'stop' | 'erase'} act
 * @param {ReadonlySet<string>} settledFlat
 */
function refuseUnlessFlat(entry, act, settledFlat) {
  if (entry.row.mode !== PAPER) {
    throw wireRefusal(`REFUSED at the wire: ${entry.row.tag} is mode ${JSON.stringify(entry.row.mode)}`)
  }
  if (entry.held !== 0 && !(needsSettle(entry) && settledFlat.has(entry.row.tag))) {
    throw wireRefusal(
      `REFUSED at the wire: ${entry.row.tag} was planned for ${act} with held=${String(entry.held)}`,
    )
  }
}

// ─────────────────────────────────────────────────── orphan strategy rows

/**
 * `--prune-orphans`: the `desk-strategies` rows a book left behind.
 *
 * An EXTERNAL strategy row is the switch a registration made for its book
 * (`routes/books.ts` adds it, label = tag). The erase takes it away with the
 * book now, but erases before that did not, and a book purged or deleted by
 * hand can still strand one — eleven on the box on 2026-10-04, two of them
 * still switched ON.
 *
 * WHICH ROWS: `kind: 'external'` AND no registry row for the tag on EITHER
 * rail. The tag is never read — not its shape, not a date in it. A hosted row
 * (a runner strategy, a mirror) never has a book and is never touched. A row
 * with a LIVE membership is listed under `skipped` and left alone: removing a
 * live switch is not this script's call. Dry run by default; the list is the
 * thing to read before `--apply`.
 *
 * @typedef {{ tag: string, kind: string, modes: { paper?: unknown, live?: unknown } }} StrategyRowLike
 * @typedef {{ prune: { tag: string, modes: string[] }[], skipped: string[] }} OrphanPlan
 *
 * @param {{ strategies: readonly StrategyRowLike[], registered: ReadonlySet<string> }} input
 *   `registered` is every tag with a registry row in paper OR live.
 * @returns {OrphanPlan}
 */
export function planOrphans(input) {
  /** @type {OrphanPlan['prune']} */
  const prune = []
  /** @type {string[]} */
  const skipped = []
  for (const s of input.strategies) {
    if (s.kind !== 'external') continue
    if (input.registered.has(s.tag)) continue
    const modes = Object.keys(s.modes ?? {})
    if (modes.some((m) => m !== PAPER)) {
      skipped.push(s.tag)
      continue
    }
    prune.push({ tag: s.tag, modes })
  }
  return { prune, skipped }
}

/**
 * Remove each orphan's paper membership (`DELETE .../modes/paper`), then the
 * emptied row (`DELETE /v1/desk/strategies/:tag`, which the server allows only
 * for an external row added to nothing and registered nowhere). A refusal is
 * reported and the rest still go.
 *
 * @param {OrphanPlan} plan
 * @param {{ request: Request, log?: (line: string) => void }} io
 */
export async function applyOrphans(plan, io) {
  const log = io.log ?? (() => {})
  let removedModes = 0
  let deletedRows = 0
  /** @type {string[]} */
  const refused = []
  for (const { tag, modes } of plan.prune) {
    let ok = true
    for (const mode of modes) {
      if (mode !== PAPER) throw new Error(`REFUSED at the wire: ${tag} would lose its ${mode} membership`)
      const res = await io.request('DELETE', `${STRATEGIES}/${tag}/modes/${PAPER}`)
      // 404: already gone, which is the state being asked for.
      if (res.status === 200) removedModes += 1
      else if (res.status !== 404) {
        ok = false
        refused.push(`${tag}: DELETE modes/${PAPER} refused (HTTP ${res.status}) — ${res.text}`)
      }
    }
    if (!ok) continue
    const del = await io.request('DELETE', `${STRATEGIES}/${tag}`)
    if (del.status === 200) {
      deletedRows += 1
      log(`  pruned   ${tag}`)
    } else if (del.status !== 404) {
      refused.push(`${tag}: row DELETE refused (HTTP ${del.status}) — ${del.text}`)
    }
  }
  return { removedModes, deletedRows, refused }
}

// ───────────────────────────────────────────────────────────────── the output

const RULE = '─'.repeat(78)

export const HELP = `
  The daily book roll for the delta-lean PAPER books. A book lives one trading
  day; each morning this creates today's four and retires the old ones. It
  also keeps the hold-to-expiry pairs (dl_hold_to_expiry: true — one
  aggressive and one conservative book per symbol per weekly contract) and
  the playbook books (pb_playbook 1-6 — up to six per symbol per day), and
  retires every OTHER paper book whose contract has expired.

    node scripts/delta-lean-roll.mjs [--dry-run | --apply] [--json]
    node scripts/delta-lean-roll.mjs --prune-orphans [--dry-run | --apply] [--json]

    --dry-run   THE DEFAULT. Reads the registry and the books, resolves today's
                expiries from the instrument master, and prints exactly what it
                would create, settle, stop and erase. Changes nothing.
    --json      Print the plan as JSON, and nothing else. Implies a dry run
                unless --apply is also given.
    --apply     Create, start and switch on today's four, any new
                hold-to-expiry pair and today's playbook books, THEN settle
                old books whose legs are all on expired contracts, THEN stop
                the old flat books still running, THEN erase every flat one
                created before today — yesterday's included. Never the other
                way round. After that, the same settle -> stop -> erase for
                the hold-to-expiry books whose contract expired before today,
                for the playbook books of an earlier day, and then for every
                OTHER paper book whose expiry is before today.
    --prune-orphans
                Instead of the roll: list the desk-strategies rows a book left
                behind — kind external, and no registry row for the tag on
                either rail (the tag text is never read). With --apply, remove
                each one's paper switch, then the emptied row. A row with a
                live membership is listed and left alone. Runs on any day.
    --help      This.

  Hold-to-expiry books: the pair for a symbol's front contract is created
  (create, start, switch on — right after today's four) on the first morning
  that contract is the front one, never on the morning it expires; on NIFTY's
  expiry Tuesday no NIFTY pair is created and the dying pair carries to the
  close. They are never retired by the day they were created, only the
  morning after their contract expires, by the rule below. A stopped hold
  book on the current contract is started only if it was registered this
  morning, is flat, and was never started (a run that died mid-way: nothing
  has written to its row since the create); otherwise — stopped by hand,
  however soon after its start — it is left stopped and named in ATTENTION.
  The same rule holds for a stopped playbook book of today. No pair is
  created at all while the engine on disk does not know dl_hold_to_expiry —
  that, too, is an ATTENTION line.

  Playbook books: every morning, per symbol, the three intraday presets
  (pb-trend-drive, pb-wing-straddle, pb-reversal), each on the nearest listed
  contract with at least its pb_min_dte TRADING days to go — never the one
  expiring today — and, on the symbol's own expiry day and from
  ${PLAYBOOK_EXPIRY_FROM}, the three expiry presets (pb-expiry-drive,
  pb-expiry-theta, pb-expiry-gamma) on today's contract. Tagged by the day;
  each lives one session. The morning after, a flat one is stopped and erased,
  and one whose every leg is on an expired contract is settled first; one
  that holds a live-contract leg or cannot be read is alarmed and left alone,
  and a playbook row of today is never touched. Nothing in this family is created
  or retired while the engine on disk does not know pb_playbook, or when
  today's plan cannot be made — an ATTENTION line; the rest still rolls. The
  family is fenced: a playbook create, start or switch-on that fails stops it
  at that book and skips its retire, and a playbook stop or erase that fails
  ends that retire — an ATTENTION line either way, while the four, the
  hold-to-expiry books and every other retire still go out.

  Switched-off series: SERIES_OFF in scripts/delta-lean-books.mjs names
  series (<SYMBOL>-<preset>) that are planned and then not created; the plan
  names the ones skipped today on a "switched off" line (not ATTENTION).
  Their rows already on file are retired as usual.

  The paper switch is PATCHed on after every start. A book of this morning
  that is running with its switch off and has never marked — that morning's
  switch-on did not land — gets the same three calls again from the next
  run; one the day guard switched off never does, and any other running book
  of today whose switch is off is named in ATTENTION and left off.

  A book holding a leg on an EXPIRED contract is settled first:
  POST /v1/desk/books/registry/:tag/settle-expired?mode=paper books each such
  leg out at intrinsic value against the underlying's close on its expiry day.
  If no close is on file the server refuses (409) and the book is left as it is.
  A leg on a LIVE contract is never settled: that book is alarmed and left.

  Environment:

    DESK_MONGO_URL   the registry and the books  (default ${DEFAULT_MONGO})
    DESK_API_URL     desk-api                    (default ${DEFAULT_API})
    DESK_API_TOKEN   the machine bearer, required for --apply

  .env.local is loaded first; an already-set variable wins over the file.

  Every book this script can create, start, stop or erase is mode: paper —
  there is no flag, variable or argument that changes that. A book that still
  HOLDS anything is never stopped or erased: a stop does not flatten, so it is
  left running to flatten itself and a later run retires it. An erase is
  DELETE ?mode=paper only — never flatten, never purge — so fills, order
  events, daily reports and decisions stay for the Reports page. A weekend or
  NSE holiday is a no-op. Exit code 1 means the run found something
  unexpected; read the ATTENTION block.

  docs/runbooks/delta-lean-paper.md §7 is the procedure this sits inside,
  including the cron line that runs it at 08:50 IST.
`

/** @param {number | null} held */
function heldWord(held) {
  if (held === null) return 'HOLDINGS UNKNOWN'
  return held === 0 ? 'flat' : `${held} OPEN LEG${held === 1 ? '' : 'S'}`
}

/**
 * One retire line and the calls it will make.
 * @param {RetireEntry} e
 * @param {string} what
 */
function printRetire(e, what) {
  const running = e.row.desired === 'running'
  // One column, whatever the label: padded to the longest one plus a space.
  const label = {
    stop: 'STOP',
    erase: running ? 'STOP + ERASE' : 'ERASE',
    'settle-then-stop': running ? 'SETTLE + STOP' : 'SETTLE',
    'settle-then-erase': running ? 'SETTLE + STOP + ERASE' : 'SETTLE + ERASE',
    'holds-legs': 'LEFT RUNNING',
    unknown: 'LEFT RUNNING',
    blocked: 'WITHHELD',
    'stopped-flat': 'already stopped',
    'stopped-holds-legs': 'STOPPED, HOLDING',
    'stopped-unknown': 'STOPPED, UNKNOWN',
  }[e.action].padEnd(22)
  console.log(`      ${label}${e.row.tag}   (${what}, ${e.row.desired}, ${heldWord(e.held)})`)
  if (needsSettle(e)) {
    console.log(`                      POST ${REGISTRY}/${e.row.tag}/settle-expired?mode=${PAPER}`)
  }
  if (needsStop(e)) console.log(`                      POST ${REGISTRY}/${e.row.tag}/stop   {"mode":"paper"}`)
  if (needsErase(e)) console.log(`                      DELETE ${REGISTRY}/${e.row.tag}?mode=${PAPER}`)
  if (e.action === 'holds-legs' || e.action === 'unknown') {
    console.log('                      not stopped — a stop does not flatten. See ATTENTION below.')
  }
}

/**
 * One create/start line and the calls it will make — today's four, the
 * hold pairs and the playbook books alike. `note`, when given, is one more
 * line under the contract (the playbooks say how far theirs is).
 * @param {EnsureEntry} e
 * @param {string} [note]
 */
function printEnsure(e, note) {
  const what = (
    e.why === 'missing' ? 'CREATE + START + SWITCH ON' : e.why === 'switched-off' ? 'SWITCH ON' : 'START + SWITCH ON'
  ).padEnd(26)
  console.log(`      ${what}  ${e.plan.tag}`)
  console.log(
    `                      ${e.plan.mode}, expiry ${e.plan.expiry}, ${Object.keys(e.plan.dials).length} resolved dials, ` +
      `preset ${e.plan.variant}` +
      (e.why === 'missing'
        ? ''
        : e.why === 'created-not-started'
          ? '   (registered this morning but never started — a run died between its create and its start)'
          : e.why === 'switched-off'
            ? '   (RUNNING with its paper switch off and never marked — the switch-on of this morning did not land; ' +
              'not the day guard\'s)'
            : '   (the row exists and is stopped; the roll needs it running)'),
  )
  if (note !== undefined) console.log(`                      ${note}`)
  // Every ensure sends the create; on a row already on file it converges (200).
  console.log(`                      POST ${REGISTRY}${e.why === 'missing' ? '' : '   (converges on the row on file)'}`)
  console.log(
    `                      POST ${REGISTRY}/${e.plan.tag}/start   {"mode":"paper"}` +
      (e.why === 'switched-off' ? '   (a no-op: it runs)' : ''),
  )
  console.log(`                      PATCH ${STRATEGIES}/${e.plan.tag}   ${JSON.stringify(PAPER_ON)}`)
}

/**
 * The hold books in one line, by name: what this plan creates and what it
 * retires. Printed under the totals by the dry run and after an apply.
 * @param {RollPlan} plan
 * @returns {string}
 */
export function holdSummary(plan) {
  const hold = holdOf(plan)
  const created = hold.ensure.map((e) => e.plan.tag)
  const retired = hold.retire.filter((e) => needsErase(e)).map((e) => e.row.tag)
  const alarmed = hold.retire.filter((e) => !needsErase(e)).map((e) => e.row.tag)
  const list = (/** @type {string[]} */ tags) => (tags.length === 0 ? '' : ` (${tags.join(', ')})`)
  return (
    `hold-to-expiry: ${created.length} to create/start/switch on${list(created)}, ` +
    `${retired.length} to retire by expiry${list(retired)}` +
    (alarmed.length > 0 ? `, ${alarmed.length} past expiry LEFT ALONE${list(alarmed)}` : '') +
    `, ${hold.onTarget.length} on target, ${hold.carrying.length} carrying` +
    (hold.leftStopped.length > 0 ? `, ${hold.leftStopped.length} left stopped${list(hold.leftStopped.map((h) => h.row.tag))}` : '') +
    '.'
  )
}

/**
 * The playbook books in one line, by name — `holdSummary`'s sibling, printed
 * under it by the dry run and after an apply.
 * @param {RollPlan} plan
 * @returns {string}
 */
export function playbookSummary(plan) {
  const pb = playbookOf(plan)
  const list = (/** @type {string[]} */ tags) => (tags.length === 0 ? '' : ` (${tags.join(', ')})`)
  if (pb.blocked !== null) {
    return (
      'playbook: GATED — nothing created or retired' +
      (pb.gated.length > 0 ? `; ${pb.gated.length} row(s) left as they are${list(pb.gated.map((h) => h.row.tag))}` : '') +
      ' — see ATTENTION.'
    )
  }
  const created = pb.ensure.map((e) => e.plan.tag)
  const retired = pb.retire.filter((e) => needsErase(e)).map((e) => e.row.tag)
  const alarmed = pb.retire.filter((e) => !needsErase(e)).map((e) => e.row.tag)
  return (
    `playbook: ${created.length} to create/start/switch on${list(created)}, ` +
    `${retired.length} to retire${list(retired)}` +
    (alarmed.length > 0 ? `, ${alarmed.length} from an earlier day LEFT ALONE${list(alarmed)}` : '') +
    `, ${pb.onTarget.length} on target` +
    (pb.ofToday.length > 0 ? `, ${pb.ofToday.length} of today untouched${list(pb.ofToday.map((h) => h.row.tag))}` : '') +
    (pb.leftStopped.length > 0 ? `, ${pb.leftStopped.length} left stopped${list(pb.leftStopped.map((h) => h.row.tag))}` : '') +
    '.'
  )
}

/**
 * The series this plan did not create because `SERIES_OFF` names them, in
 * one line — or null when none was planned today. Printed under the other
 * summaries, never in ATTENTION: a switch-off is a decision, not a fault.
 * @param {RollPlan} plan
 * @returns {string | null}
 */
export function switchedOffSummary(plan) {
  const off = plan.switchedOff ?? []
  if (off.length === 0) return null
  return `switched off (SERIES_OFF): ${off.join(', ')} — not created; their rows on file retire as usual.`
}

/**
 * How far one planned playbook book's contract is, for the operator.
 * @param {BookPlan} b
 * @param {string} todayIst
 */
function sessionsNote(b, todayIst) {
  if (b.dials['pb_expiry_day_only'] === true) return "today's contract — an expiry preset"
  const left = tradingDaysToExpiry(todayIst, b.expiry)
  return `${left} trading day(s) to go; pb_min_dte ${String(b.dials['pb_min_dte'])}`
}

/**
 * The dry run's own output.
 *
 * Exported so that anything holding a `RollPlan` can render it — a one-off
 * preview of what a future morning would decide, say. That is deliberately the
 * only way to see a plan for another date: this file grows no `--today` flag,
 * because a flag that moves which day is planned is a flag that can register a
 * book under the wrong tag.
 *
 * @param {RollPlan} plan
 */
export function printPlan(plan) {
  console.log(`\n${RULE}`)
  console.log(`  delta-lean DAILY BOOK ROLL — ${PAPER} books only, on ${plan.todayIst} (IST)`)
  console.log(RULE)

  if (plan.tradingDay === false) {
    console.log(`\n  ${plan.todayIst} is not a trading day — no plan. Nothing is created, stopped or erased.`)
    return
  }

  for (const s of plan.symbols) {
    console.log(`\n  ${s.symbol}   today's expiry ${s.targetExpiry}`)
    console.log('        (the nearest weekly with at least TODAY to go, from OptionMaster —')
    console.log('         an old book is stopped and erased the first morning after its day —')
    console.log('         its creation day is before today; its expiry is never consulted)')
    for (const e of s.ensure) printEnsure(e)
    for (const t of s.onTarget) {
      console.log(`      on target       ${t.row.tag}   (running, ${heldWord(t.held)}) — untouched`)
    }
    for (const t of s.leftStopped) {
      console.log(
        `      left stopped    ${t.row.tag}   (${heldWord(t.held)}) — today's tag but stopped, ` +
          "and nothing needs retiring, so this is the operator's call",
      )
    }
    for (const e of s.retire) printRetire(e, `created ${e.day ?? 'UNREADABLE'}`)
    if (s.ensure.length === 0 && s.retire.length === 0 && s.leftStopped.length === 0) {
      console.log(`      nothing to create, nothing to retire — ${s.onTarget.length} book(s) on today's tag`)
    }
  }

  const hold = holdOf(plan)
  console.log(`\n  HOLD-TO-EXPIRY BOOKS   (${HOLD_DIAL}: true — one pair per symbol per weekly contract)`)
  console.log('        (created the first morning a contract is the front one, carried overnight, and')
  console.log("         retired the morning after it expires — the row's expiry decides; its creation day")
  console.log('         is never consulted, and the daily retire above never sees these rows)')
  for (const s of plan.symbols) {
    console.log(
      s.targetExpiry === plan.todayIst
        ? `    ${s.symbol}   front contract ${s.targetExpiry} is TODAY — no hold pair is created for a contract ` +
            'that dies this afternoon; the next one comes tomorrow'
        : `    ${s.symbol}   front contract ${s.targetExpiry}`,
    )
    for (const e of hold.ensure.filter((x) => x.plan.symbol === s.symbol)) printEnsure(e)
    for (const t of hold.onTarget.filter((x) => x.row.symbol === s.symbol)) {
      console.log(`      on target       ${t.row.tag}   (running, ${heldWord(t.held)}) — untouched`)
    }
    for (const t of hold.leftStopped.filter((x) => x.row.symbol === s.symbol)) {
      console.log(
        `      left stopped    ${t.row.tag}   (${heldWord(t.held)}) — this contract's hold book, but stopped: ` +
          "the operator's call, not started by the roll — see ATTENTION",
      )
    }
    for (const t of hold.carrying.filter((x) => x.row.symbol === s.symbol)) {
      console.log(
        `      carrying        ${t.row.tag}   (${t.row.desired}, ${heldWord(t.held)}, expiry ${t.row.expiry}) — ` +
          'its contract has not expired; retired the morning after it does',
      )
    }
    for (const e of hold.retire.filter((x) => x.row.symbol === s.symbol)) {
      printRetire(e, `expired ${e.row.expiry}`)
    }
  }

  const pb = playbookOf(plan)
  console.log(`\n  PLAYBOOK BOOKS   (${PLAYBOOK_DIAL} 1-6 — one book per preset per symbol per trading day)`)
  console.log('        (the three intraday presets every session, each on the nearest contract with its')
  console.log("         pb_min_dte trading days to go; the three expiry presets on the symbol's own expiry")
  console.log(`         day, from ${PLAYBOOK_EXPIRY_FROM}; each retired the morning after its day — its creation`)
  console.log("         day decides — and never by the four's rules above)")
  if (pb.blocked !== null) {
    console.log('    GATED — nothing in this family is created or retired this run; the reason is in ATTENTION')
    for (const h of pb.gated) {
      console.log(`      left as it is   ${h.row.tag}   (${h.row.desired}, ${heldWord(h.held)})`)
    }
  } else {
    for (const { symbol } of SYMBOLS) {
      console.log(`    ${symbol}`)
      for (const e of pb.ensure.filter((x) => x.plan.symbol === symbol)) {
        printEnsure(e, `contract ${e.plan.expiry}: ${sessionsNote(e.plan, plan.todayIst)}`)
      }
      for (const t of pb.onTarget.filter((x) => x.row.symbol === symbol)) {
        console.log(`      on target       ${t.row.tag}   (running, ${heldWord(t.held)}, expiry ${t.row.expiry}) — untouched`)
      }
      for (const t of pb.leftStopped.filter((x) => x.row.symbol === symbol)) {
        console.log(
          `      left stopped    ${t.row.tag}   (${heldWord(t.held)}) — today's playbook tag, but stopped: ` +
            "the operator's call, not started by the roll — see ATTENTION",
        )
      }
      for (const t of pb.ofToday.filter((x) => x.row.symbol === symbol)) {
        console.log(
          `      of today        ${t.row.tag}   (${t.row.desired}, ${heldWord(t.held)}) — not one of today's ` +
            'plans; a playbook row of today is never touched',
        )
      }
      for (const e of pb.retire.filter((x) => x.row.symbol === symbol)) printRetire(e, `created ${e.day ?? 'UNREADABLE'}`)
      const mine = (/** @type {{ row: RegistryRow }} */ h) => h.row.symbol === symbol
      if (
        !pb.ensure.some((e) => e.plan.symbol === symbol) &&
        ![...pb.onTarget, ...pb.leftStopped, ...pb.ofToday, ...pb.retire].some(mine)
      ) {
        console.log('      nothing to create, nothing to retire')
      }
    }
  }

  const others = plan.expiredBooks ?? []
  if (others.length > 0) {
    console.log('\n  OTHER PAPER BOOKS PAST EXPIRY   (any family; contract expired before today)')
    console.log('        (settled at intrinsic if every leg is on a dead contract, stopped if running, erased)')
    for (const e of others) printRetire(e, `${e.row.variant}, expired ${e.row.expiry}`)
  }

  const creates = createdBooks(plan)
  const stops = stoppedTags(plan)
  const erases = erasedTags(plan)
  console.log(`\n${RULE}`)
  console.log(
    `  ${creates.length} to create/start/switch on, ${settledTags(plan).length} to settle, ` +
      `${stops.length} to stop, ${erases.length} to erase. ` +
      `paper: ${creates.length}. live: ${creates.filter((b) => b.mode !== PAPER).length}.`,
  )
  console.log(`  ${holdSummary(plan)}`)
  console.log(`  ${playbookSummary(plan)}`)
  const off = switchedOffSummary(plan)
  if (off !== null) console.log(`  ${off}`)

  if (plan.alarms.length > 0 || plan.anomalies.length > 0) {
    console.log(`\n${RULE}`)
    console.log('  ATTENTION — this run exits 1')
    console.log(RULE)
    for (const line of [...plan.alarms, ...plan.anomalies]) console.log(`\n  * ${line}`)
    console.log('')
  }
}

// ────────────────────────────────────────────────────────────────────── main

/** @param {readonly string[]} argv */
export function parseArgs(argv) {
  const opts = { apply: false, json: false, help: false, pruneOrphans: false }
  for (const a of argv) {
    if (a === '--help' || a === '-h') opts.help = true
    else if (a === '--dry-run') opts.apply = false
    else if (a === '--json') opts.json = true
    else if (a === '--apply') opts.apply = true
    else if (a === '--prune-orphans') opts.pruneOrphans = true
    else {
      // Layer 1's other half: `--mode live` must FAIL, not be ignored on its
      // way to a run that does something else.
      throw new Error(
        `unrecognised argument ${JSON.stringify(a)} — this script takes --dry-run, --json, ` +
          '--apply, --prune-orphans and --help, and nothing else (there is no flag that changes the mode)',
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
    // `--env-file` rule). Loaded BY PATH, so cron needs no working directory.
    process.loadEnvFile(fileURLToPath(new URL('../.env.local', import.meta.url)))
  } catch {
    // Nothing to load. The environment stands as it is.
  }

  const opts = parseArgs(process.argv.slice(2))
  if (opts.help) {
    console.log(HELP)
    return 0
  }
  if (opts.pruneOrphans) return await pruneOrphansMain(opts)

  // Resolved ONCE and handed down: the tag, the expiry and the cutoff all ask
  // about the same IST day.
  const todayIst = istDate(Date.now())
  if (!isTradingDay(todayIst)) {
    // Before the Mongo imports: a holiday run should not need a database to
    // find out it has nothing to do.
    console.log(`  ${todayIst} is not a trading day (weekend or NSE holiday) — nothing to do.`)
    return 0
  }

  // Imported HERE, not at the top: the suite imports this module for its pure
  // functions and must not pay for a mongodb driver to do it.
  const { connectMongo } = await import('../apps/api/src/mongo.ts')
  const { loadStoredInstruments } = await import('../apps/marketdata/src/sync-runner.ts')
  const { OptionMaster } = await import('@algomaker/instruments')
  const { DeskStore } = await import('../apps/api/src/store.ts')

  const mongoUrl = process.env['DESK_MONGO_URL'] ?? DEFAULT_MONGO
  const mongo = await connectMongo(mongoUrl, { serverSelectionTimeoutMS: 5000 })
  /** @type {RollPlan} */
  let plan
  try {
    const store = new DeskStore(mongo.db)
    const master = new OptionMaster(await loadStoredInstruments(mongo.db.collection('instrument')))
    // ONE read of the master for both families, so the day's four and the
    // hold pairs can never disagree about which contract is the front one.
    const expiries = expiriesFrom(master, todayIst)
    const daily = planBooks(expiries, todayIst)
    // The engine gate: no hold pair is planned on a build that would steer
    // it as an intraday book. Reported in ATTENTION, never thrown.
    const { holdTargets: hold, holdBlocked } = planHoldTargets(expiries, todayIst)
    // The third family, off the same master: each playbook preset finds its
    // own contract. Its gate (the engine, or a plan that cannot be made) is
    // ATTENTION, never a throw — the four and the pairs above still roll.
    const { playbookTargets: playbooks, playbookBlocked } = planPlaybookTargets(master, todayIst)
    // SERIES_OFF: every family planned in full, then the switched-off series
    // dropped before they can become a create. Their rows on file are not
    // filtered — `planRoll` retires them by dials and day, as always.
    const targets = withoutSeriesOff(daily)
    const holdTargets = withoutSeriesOff(hold)
    const playbookTargets = withoutSeriesOff(playbooks)
    const switchedOff = seriesSwitchedOff([...daily, ...hold, ...playbooks])

    // Layer 2. PAPER ONLY, at the read. `BookRow` carries `createdAt`
    // (`bookFromDoc`), which is the day every retire decision is made on.
    // `bookFromDoc` answers 0 for a document without one; `planRoll` reads 0
    // as unknown, so such a row is stopped but never erased.
    const rows = /** @type {RegistryRow[]} */ (await store.listBooks(PAPER))

    // EVERY paper row, not just ours: the fourth loop retires other families'
    // books past their expiry, by the same flat-or-settle rule. No document at
    // all is a book that has never traded — flat, and not the same thing as a
    // document whose legs cannot be read (see openLegCount).
    const { heldByTag, expiredByTag } = await readHoldings(rows, (tag) => store.bookDoc(tag, PAPER), todayIst)

    // THE PAPER SWITCHES, read beside the registry: a target that runs with
    // its switch off decides all day and fills nothing (spec E3), and nothing
    // on its registry row says so. `planRoll` finishes the one kind that is
    // this script's own (a switch-on of this morning that did not land) and
    // names every other in ATTENTION.
    const switchByTag = readSwitches(await store.listStrategies())

    plan = planRoll({
      targets,
      holdTargets,
      holdBlocked,
      playbookTargets,
      playbookBlocked,
      rows,
      heldByTag,
      expiredByTag,
      switchByTag,
      switchedOff,
      todayIst,
    })
  } finally {
    await mongo.close()
  }

  // Layer 3, again, on the objects that are about to be printed or posted.
  assertAllPaper(createdBooks(plan))

  let trouble = plan.alarms.length + plan.anomalies.length

  if (opts.json) {
    console.log(JSON.stringify(plan, null, 2))
    if (!opts.apply) return trouble === 0 ? 0 : 1
  } else {
    printPlan(plan)
  }

  if (!opts.apply) {
    console.log('\n  DRY RUN. Nothing was created, started, stopped or erased.')
    console.log(
      "  --apply  perform it: create, start and switch on today's four, any new hold-to-expiry pair and " +
        "today's playbook books; then settle, stop and erase.",
    )
    console.log('  docs/runbooks/delta-lean-paper.md §7 is the procedure around this step.\n')
    return trouble === 0 ? 0 : 1
  }

  if (
    createdBooks(plan).length === 0 &&
    settledTags(plan).length === 0 &&
    stoppedTags(plan).length === 0 &&
    erasedTags(plan).length === 0
  ) {
    console.log(
      "\n  NOTHING TO DO. Today's books, the hold-to-expiry pairs and the playbook books are on the desk " +
        'and nothing is left to retire; no calls were made.\n',
    )
    return trouble === 0 ? 0 : 1
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
  const done = await applyRoll(plan, {
    request: (method, path, body) => requestJson(base, method, path, body, token),
    log: (line) => console.log(line),
  })
  trouble += done.refused.length
  console.log(
    `\n  ${done.created} registered, ${done.started} started, ${done.switchedOn} switched on, ` +
      `${done.settled} settled, ${done.stopped} stopped, ${done.erased} erased` +
      `${done.refused.length > 0 ? `, ${done.refused.length} REFUSED — see ATTENTION` : ''}. All paper.`,
  )
  // The hold and playbook books by name — as planned; a retire the server
  // refused, or a playbook loop that could not be finished, is in ATTENTION
  // below, and a failed create of the four or of a hold pair would have
  // thrown before this line.
  console.log(`  ${holdSummary(plan)}`)
  console.log(`  ${playbookSummary(plan)}`)
  const off = switchedOffSummary(plan)
  if (off !== null) console.log(`  ${off}`)
  if (done.refused.length > 0) {
    console.log(`\n${RULE}`)
    console.log('  ATTENTION — what this run could not do, and carried on past (each row named stays as it was)')
    console.log(RULE)
    for (const line of done.refused) console.log(`\n  * ${line}`)
    console.log(
      '\n  A refused ERASE: the server rebuilds the position from the fills and disagrees with ' +
        'desk-books. Check GET /v1/desk/positions?tag=<tag>&mode=paper, flatten or reconcile by hand, ' +
        'and delete the row from the Books page once it reads clean.' +
        '\n  A refused SETTLE: no close for the underlying on the expiry date is on file, or a live ' +
        'leg remains. The book is left exactly as it was; see runbook §7.' +
        '\n  PLAYBOOK FAMILY / RETIRE NOT FINISHED: one call for a playbook book failed. The playbook ' +
        'family stopped at that book and every other family rolled; fix the cause and re-run — it ' +
        'converges (runbook §8.1).\n',
    )
  }
  if (trouble > 0) console.log('  The ATTENTION block(s) above are why this run exits 1.\n')
  else console.log('')
  return trouble === 0 ? 0 : 1
}

/**
 * `--prune-orphans`: read the strategy rows and BOTH registries, print the
 * plan, and with `--apply` remove them. Not gated on a trading day — it has
 * nothing to do with a session.
 *
 * @param {{ apply: boolean, json: boolean }} opts
 */
async function pruneOrphansMain(opts) {
  const { connectMongo } = await import('../apps/api/src/mongo.ts')
  const { DeskStore } = await import('../apps/api/src/store.ts')
  const mongo = await connectMongo(process.env['DESK_MONGO_URL'] ?? DEFAULT_MONGO, { serverSelectionTimeoutMS: 5000 })
  /** @type {OrphanPlan} */
  let plan
  try {
    const store = new DeskStore(mongo.db)
    // BOTH rails, read only: a tag registered in live is not an orphan in paper.
    const registered = new Set([
      ...(await store.listBooks(PAPER)).map((r) => r.tag),
      ...(await store.listBooks('live')).map((r) => r.tag),
    ])
    plan = planOrphans({ strategies: await store.listStrategies(), registered })
  } finally {
    await mongo.close()
  }

  if (opts.json) console.log(JSON.stringify(plan, null, 2))
  else {
    console.log(`\n${RULE}\n  ORPHAN STRATEGY ROWS — external, with no registry row on either rail\n${RULE}`)
    for (const p of plan.prune) {
      console.log(`      PRUNE   ${p.tag}   (added to: ${p.modes.length === 0 ? 'nothing' : p.modes.join(', ')})`)
      for (const m of p.modes) console.log(`                DELETE ${STRATEGIES}/${p.tag}/modes/${m}`)
      console.log(`                DELETE ${STRATEGIES}/${p.tag}`)
    }
    for (const t of plan.skipped) console.log(`      SKIPPED ${t}   (has a live membership — left alone)`)
    if (plan.prune.length === 0) console.log('      none.')
  }
  if (!opts.apply) {
    if (!opts.json) console.log('\n  DRY RUN. Nothing was removed. --apply to remove the rows listed above.\n')
    return 0
  }
  if (plan.prune.length === 0) return 0

  const base = process.env['DESK_API_URL'] ?? DEFAULT_API
  const token = process.env['DESK_API_TOKEN'] ?? ''
  if (token.trim() === '') throw new Error('DESK_API_TOKEN is not set — --apply authenticates to desk-api')
  const done = await applyOrphans(plan, {
    request: (method, path, body) => requestJson(base, method, path, body, token),
    log: (line) => console.log(line),
  })
  console.log(`\n  ${done.removedModes} paper switch(es) removed, ${done.deletedRows} row(s) deleted.`)
  for (const line of done.refused) console.log(`  * REFUSED ${line}`)
  return done.refused.length === 0 ? 0 : 1
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

export { PAPER, LEAN_DIAL, REGISTRY }
