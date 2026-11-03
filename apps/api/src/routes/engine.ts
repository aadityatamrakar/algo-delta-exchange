/**
 * THE ENGINE'S TWO SEAMS: the decision path the TS recenter supervisor reaches
 * the rails through (§9), and the operator's Protect control (§4).
 *
 * They share a file because they share a subject — the supervisor's own view of
 * a book — and nothing else. `POST .../decisions` is MACHINE ONLY and places
 * orders; `POST .../protect` is an OPERATOR control that places none and writes
 * one field of supervisor state. Each carries its own gate, spelled out at its
 * own handler.
 *
 * ── `POST /v1/desk/engine/decisions` (design spec §9, migration Task 11) ─────
 *
 * WHAT IS NEW HERE IS THE VOCABULARY, AND NOTHING ELSE. The supervisor speaks
 * INSTRUMENTS and share quantities; `applyDecision` speaks the book's own leg
 * tags, strikes and option types. This module translates one into the other
 * and then hands the result to `BridgeService.applyDecision` — the SAME method,
 * with the same strategy gate, the same kill switch, the same risk caps, the
 * same `desk-decisions` claim, the same rails and the same compare-and-set book
 * fold. There is no second order path in this file, deliberately: a copy of that
 * stack would agree with the original the day it was written and would be the
 * one that stopped refusing the day a gate changed.
 *
 * THE TRANSLATION IS THE WHOLE RISK, so it is written to fail loudly:
 *
 *   THE CONTRACT IS LOOKED UP, NEVER PARSED. `BHEL26AUG415CE` is turned into
 *   {strike, type, expiry} by walking the instrument master's own listed
 *   strikes until `resolve` hands back the identical symbol (`contractOf`,
 *   shared with `/v1/desk/submit`). A regex over the exchange's packing is a
 *   guess that an underlying ending in digits defeats, and a wrong strike here
 *   is not a display bug — it is a real order on a contract nobody chose.
 *
 *   AN EXPIRY THAT IS NOT THIS BOOK'S IS REFUSED, not re-resolved. The master
 *   lists the same strike on several expiries, so taking `415CE` off a
 *   September symbol and resolving it against an August book silently books a
 *   DIFFERENT contract than the one the supervisor asked for. Both exist, so
 *   nothing downstream would ever notice.
 *
 *   THE LEG TAG COMES FROM THE BOOK, never from a formula. Actions reference
 *   `deskTag`, and a carried book's legs are still tagged the way the Python
 *   desk tagged them (`CE415#0`). So a close or a resize finds the book's own
 *   tag for the named contract; only an OPEN, which by definition has no leg
 *   yet, is tagged with the tradingsymbol — stable, unique per book, and the
 *   same string the next decision will name it by.
 *
 * IDEMPOTENCY IS `applyDecision`'S, unchanged: the unique index on
 * `desk-decisions.decisionId` is the lock, and a replay answers with the
 * ORIGINAL fills rather than routing the package twice. `decisionId` is
 * required to carry its own mode (`${tag}:${mode}:${seq}`) because paper and
 * live are two ledgers on one tag, and an id that collided across them would
 * let a paper replay suppress a real live order.
 *
 * `WORKING` IS WHAT A PAPER PACKAGE ANSWERS (D14, plan Task 18). It means "the
 * orders are out and a maker quote is resting; fills arrive later" (§8). This
 * module changes nothing to produce it — `via: 'engine'` on the request below
 * is the whole of it, and `applyDecision` does the rest: on paper the orders go
 * into the gateway's own queue and the book folds when the fills land
 * (`paper-fold.ts`), so the rehearsal exercises the claim, the gates, the peg
 * and the tranche cursor rather than skipping straight to a booked position.
 *
 * LIVE STILL ANSWERS `DONE`/`FAILED`, and that asymmetry is stated rather than
 * apologised for: a live decision books optimistically and `reconcile-live.ts`
 * restates it from the broker's terminal record, a whole file of directives
 * built on that order of events. What is identical across the two rails is the
 * part this ticket is about — how the ORDER is worked.
 */

import type {
  DecisionRequest,
  DecisionResponse,
  Mode,
  Trigger,
  WireAction,
  WireFill,
  WorkDials,
  WorkMode,
} from '@algomaker/desk-engine'
import { ENGINE_DECISIONS_PATH, ENGINE_PROTECT_PATH, TRIGGERS } from '@algomaker/desk-engine'
import type { OptionMaster } from '@algomaker/instruments'
import type { ApiDeps, Route, RouteCtx } from './kit.ts'
/**
 * THE SUPERVISOR'S OWN STORE, IMPORTED ACROSS THE APP BOUNDARY.
 *
 * `protectedQty` lives in `desk-supervisor-state`, whose shape, hydration and
 * compare-and-set discipline are all `apps/supervisor/src/state-store.ts`'s.
 * Writing that document from here through a second, private copy of the CAS
 * rules is exactly how two writers come to disagree about one book — so the
 * route uses the store itself. `state-store.ts` reaches the other way for
 * `../../api/src/errors.ts`; this is the same seam, in the same house style.
 */
import {
  StateStore,
  SUPERVISOR_STATE_COLLECTION,
  nextVersion,
  type StateCollection,
} from '../../../supervisor/src/state-store.ts'
import type { AuthGate } from '../authgate.ts'
import { auditLog } from '../audit.ts'
import { createReplayLogGate } from '../replay-log.ts'
import type { BridgeLeg, DeskAction, DeskMode } from '../contract.ts'
import type { DecisionResponse as ServiceDecisionResponse } from '../service.ts'
import { NON_TERMINAL_STATES, splitOrderId } from '../reconcile-live.ts'
import { addsExposure } from '../safety.ts'
import { COLLECTIONS } from '../store.ts'
// The SAME lookup `/v1/desk/submit` turns a fill's tradingsymbol into a leg
// with. Imported rather than re-derived: a second spelling of "what does
// BHEL26AUG415CE mean" is a second thing to get wrong.
import { contractOf } from '../submit.ts'
import { fail, isFiniteNumber, isIsoDate, isNonEmptyString, isObject, ok, type Validated } from '../validate.ts'

/**
 * The supervisor's own record of what it asked for — THIS MODULE IS ITS OWNER.
 *
 * Separate from `desk-decisions` because the two answer different questions and
 * only one of them is reconstructable. `desk-decisions` is the P&L ledger and
 * holds the TRANSLATED desk actions; the request as the supervisor phrased it —
 * which instrument, which trigger, in its own words, with the work mode and the
 * price it chose — is discarded by the translation above and would be gone.
 * "Why did the book sell that strike at 14:35?" is answerable only from here.
 *
 * APPEND-ONLY AND UNPRUNED, like `desk-audit` beside it, and for the same
 * reason: one row per decision the supervisor ACTED on, which on this desk is a
 * handful per book per day. If that ever stops being true it wants a retention
 * job, not a silent cap — a journal that quietly forgot the afternoon is worse
 * than one that grew.
 */
export const ENGINE_DECISIONS_COLLECTION = COLLECTIONS.engineDecisions

/** How the stored row is shaped. One document per `decisionId`, ever. */
export interface EngineDecisionRecord {
  readonly decisionId: string
  readonly tag: string
  readonly mode: Mode
  readonly symbol: string
  readonly expiry: string
  readonly trigger: Trigger
  readonly reason: string
  readonly actions: readonly WireAction[]
  readonly response: DecisionResponse
  readonly receivedAt: number
  /** How many times the supervisor posted this id. >1 means it retried. */
  readonly posts: number
}

// -------------------------------------------------------------- validation

const WORK_MODES: readonly WorkMode[] = ['passive', 'urgent']

function isPositiveIntQty(v: unknown): v is number {
  return isFiniteNumber(v) && Number.isInteger(v) && v > 0
}

/**
 * A price a caller SUPPLIED, or absent. Never coerced.
 *
 * `exactOptionalPropertyTypes` is on repo-wide, so "no price to pass" has to be
 * an absent key rather than an explicit `undefined` — and a zero or negative
 * limit is refused rather than passed to a broker, because a limit of 0 on a
 * sell is an order to give the position away.
 */
function optionalPrice(raw: Record<string, unknown>, at: string): Validated<number | undefined> {
  const v = raw['limitPrice']
  if (v === undefined || v === null) return ok(undefined)
  if (!isFiniteNumber(v) || v <= 0) return fail(`${at}.limitPrice must be a positive number`)
  return ok(v)
}

/**
 * The package's execution dials, checked field by field.
 *
 * POSITIVE OR ABSENT — never coerced, and never zero. Each of these is a
 * number the gateway acts on directly, and a zero in any of them is a
 * behaviour, not an "unset": `trancheLots: 0` says slice into nothing (which
 * `splitIntoTranches` throws on, ON THE ORDER PATH), `chaseMaxMs: 0` says cross
 * at once, and `chaseCrossBufferPct: 0` says cross with no reach at all. A
 * caller that means "use the default" omits the key.
 *
 * `trancheLots` must additionally be a whole number: it is LOTS, and a
 * fractional lot is not a thing that can be traded.
 *
 * The cross buffer is bounded at 1 (100% through the touch) because it is a
 * FRACTION of the price and the value that would arrive from a caller confusing
 * percent with fraction — `0.5` for "0.5%" — is already ruinous, but `50` is
 * an order priced at fifty times the market. The lower bound catches the same
 * mistake made downwards.
 */
function optionalWork(raw: Record<string, unknown>): Validated<WorkDials | undefined> {
  const v = raw['work']
  if (v === undefined || v === null) return ok(undefined)
  if (!isObject(v)) return fail('work must be an object of execution dials')

  const positive = (key: string, opts: { int?: boolean; max?: number }): Validated<number | undefined> => {
    const x = v[key]
    if (x === undefined || x === null) return ok(undefined)
    if (!isFiniteNumber(x) || x <= 0) return fail(`work.${key} must be a positive number`)
    if (opts.int === true && !Number.isInteger(x)) return fail(`work.${key} must be a whole number of lots`)
    if (opts.max !== undefined && x >= opts.max) {
      return fail(`work.${key} must be below ${opts.max} — it is a fraction, not a percentage`)
    }
    return ok(x)
  }

  const trancheLots = positive('trancheLots', { int: true })
  if (!trancheLots.ok) return fail(trancheLots.error)
  const chaseMaxMs = positive('chaseMaxMs', {})
  if (!chaseMaxMs.ok) return fail(chaseMaxMs.error)
  const buffer = positive('chaseCrossBufferPct', { max: 1 })
  if (!buffer.ok) return fail(buffer.error)

  return ok({
    ...(trancheLots.value === undefined ? {} : { trancheLots: trancheLots.value }),
    ...(chaseMaxMs.value === undefined ? {} : { chaseMaxMs: chaseMaxMs.value }),
    ...(buffer.value === undefined ? {} : { chaseCrossBufferPct: buffer.value }),
  })
}

function optionalWorkMode(raw: Record<string, unknown>, at: string): Validated<WorkMode | undefined> {
  const v = raw['workMode']
  if (v === undefined || v === null) return ok(undefined)
  if (!WORK_MODES.includes(v as WorkMode)) {
    return fail(`${at}.workMode must be one of ${WORK_MODES.join('|')}, got ${JSON.stringify(v)}`)
  }
  return ok(v as WorkMode)
}

/**
 * The delta-lean stamp off the wire, or `undefined` when the caller has none.
 *
 * VALIDATED rather than trusted, like every other field here: it is written
 * verbatim onto a stored leg and read back by the supervisor as the identity of
 * a bet, so a non-string would either crash a mapper or, worse, become a lean
 * id nothing can ever match again. `''` is rejected as a VALUE — the engine
 * spells "no lean" by omitting the key, and an empty string stored on a leg
 * would be indistinguishable from an unstamped one anyway.
 *
 * Bounded because it is persisted: the engine's own ids are ~20 characters
 * (`dl-up-<epoch ms>`), and nothing legitimate is near this ceiling.
 */
function optionalLeanId(raw: Record<string, unknown>, at: string): Validated<string | undefined> {
  const v = raw['leanId']
  if (v === undefined || v === null) return ok(undefined)
  if (typeof v !== 'string' || v === '' || v.length > 128) {
    return fail(`${at}.leanId must be a non-empty string of at most 128 characters — omit it for no lean`)
  }
  return ok(v)
}

function validateWireAction(raw: unknown, i: number): Validated<WireAction> {
  const at = `actions[${i}]`
  if (!isObject(raw)) return fail(`${at} is not an object`)
  if (!isNonEmptyString(raw['instrument'])) {
    return fail(`${at}.instrument is required — the wire names CONTRACTS, never leg tags`)
  }
  const instrument = raw['instrument']
  const price = optionalPrice(raw, at)
  if (!price.ok) return fail(price.error)
  const work = optionalWorkMode(raw, at)
  if (!work.ok) return fail(work.error)
  const extras = {
    ...(price.value === undefined ? {} : { limitPrice: price.value }),
    ...(work.value === undefined ? {} : { workMode: work.value }),
  }

  switch (raw['op']) {
    case 'open': {
      if (raw['side'] !== 'Buy' && raw['side'] !== 'Sell') {
        return fail(`${at}.side must be 'Buy' or 'Sell', got ${JSON.stringify(raw['side'])}`)
      }
      if (!isPositiveIntQty(raw['qty'])) {
        return fail(`${at}.qty must be a positive integer CONTRACT quantity, not lots`)
      }
      const lean = optionalLeanId(raw, at)
      if (!lean.ok) return fail(lean.error)
      return ok({
        op: 'open',
        instrument,
        side: raw['side'],
        qty: raw['qty'],
        ...(lean.value === undefined ? {} : { leanId: lean.value }),
        // STRICTLY `true`, never a truthy string: this flag is the only thing
        // standing between an accumulating shed and the never-doubled rule, so
        // anything else on the wire reads as "not an add" rather than as one.
        ...(raw['add'] === true ? { add: true } : {}),
        ...extras,
      })
    }
    case 'close':
      return ok({ op: 'close', instrument, ...extras })
    case 'resize': {
      // Zero IS legal and means "take it to flat" — the same absolute-quantity
      // rule the desk's own resize carries. Negative is not: a target quantity
      // has no side, and a sign here would silently flip a short into a long.
      if (!isFiniteNumber(raw['targetQty']) || !Number.isInteger(raw['targetQty']) || raw['targetQty'] < 0) {
        return fail(
          `${at}.targetQty must be a non-negative integer — it is the ABSOLUTE new ` +
            `contract quantity, not a delta`,
        )
      }
      return ok({ op: 'resize', instrument, targetQty: raw['targetQty'], ...extras })
    }
    default:
      return fail(`${at}.op must be one of open|close|resize, got ${JSON.stringify(raw['op'])}`)
  }
}

/**
 * ── THE PROTECT REQUEST ─────────────────────────────────────────────────────
 *
 * One instrument, one quantity, one book. The operator says "leave 3 lots of
 * BHEL26AUG415CE alone" and the engine stops spending them (§4, D12).
 *
 * QUANTITY PER INSTRUMENT, NOT A FLAG PER LEG, and that is the design
 * decision the shape encodes: `desk-books` legally holds the same contract on
 * several legs (three tranches of one sell), and desk-api folds them, so a
 * per-leg boolean would attach protection to an identity that does not
 * survive the fold. A quantity does.
 *
 * LOTS, like every other quantity the engine reasons in (`shiftSpendableLots`
 * compares this against `leg.lots`). A share count here would protect a
 * fraction of a lot and read as almost nothing.
 *
 * ZERO IS THE UNPROTECT, and it is spelled as a number rather than a separate
 * endpoint so the control on the leg row is one input with one meaning.
 */
export interface ProtectRequest {
  readonly tag: string
  readonly mode: Mode
  readonly instrument: string
  /** Lots the engine may not spend. 0 removes the claim entirely. */
  readonly protectedQty: number
}

export function validateProtectRequest(raw: unknown): Validated<ProtectRequest> {
  if (!isObject(raw)) return fail('body must be a JSON object')
  if (!isNonEmptyString(raw['tag'])) return fail('tag is required')
  // Never defaulted, for the reason the decision request gives: paper and live
  // are two books under one tag, and protecting the wrong one leaves the other
  // one steerable while the operator believes it is pinned.
  if (raw['mode'] !== 'paper' && raw['mode'] !== 'live') {
    return fail("mode must be stated explicitly as 'paper' or 'live'")
  }
  if (!isNonEmptyString(raw['instrument'])) {
    return fail('instrument is required — the tradingsymbol the quantity is held on')
  }
  const qty = raw['protectedQty']
  if (!isFiniteNumber(qty) || !Number.isInteger(qty) || qty < 0) {
    return fail(
      'protectedQty must be a whole number of LOTS, zero or more (0 removes the protection)',
    )
  }
  return ok({
    tag: raw['tag'],
    mode: raw['mode'],
    instrument: raw['instrument'],
    protectedQty: qty,
  })
}

/**
 * The wire request, checked field by field.
 *
 * Hand-written for the reason `validate.ts` gives: this is an untrusted
 * boundary, and a malformed action does not fail loudly — it books a position
 * at the wrong size or against the wrong contract.
 */
export function validateDecisionRequest(raw: unknown): Validated<DecisionRequest> {
  if (!isObject(raw)) return fail('body must be a JSON object')
  if (!isNonEmptyString(raw['tag'])) return fail('tag is required')
  if (!isNonEmptyString(raw['symbol'])) return fail('symbol is required')
  if (!isIsoDate(raw['expiry'])) return fail("expiry is required as 'YYYY-MM-DD'")
  // No default. Guessing paper stops a live desk silently; guessing live is
  // catastrophic. The caller states it every time.
  if (raw['mode'] !== 'paper' && raw['mode'] !== 'live') {
    return fail("mode must be stated explicitly as 'paper' or 'live'")
  }
  const mode = raw['mode']
  const tag = raw['tag']
  if (!isNonEmptyString(raw['decisionId'])) {
    return fail('decisionId is required — it is the idempotency key for this decision')
  }
  /**
   * THE MODE MUST BE IN THE ID, and this is not pedantry about a format.
   *
   * Paper and live are two ledgers on one tag. An id that collided across them
   * would let a paper replay answer a live decision with the paper decision's
   * fills — the live package would never route, and the supervisor would be
   * told it had. The contract puts the mode in the id precisely so the unique
   * index cannot be shared, and an id that omits it is a client bug worth
   * refusing at the door rather than discovering during a live session.
   */
  const prefix = `${tag}:${mode}:`
  if (!raw['decisionId'].startsWith(prefix) || raw['decisionId'].length <= prefix.length) {
    return fail(
      `decisionId must be '\${tag}:\${mode}:\${seq}' — got ${JSON.stringify(raw['decisionId'])}, ` +
        `expected it to start with '${prefix}'. The mode is in the id because paper and live ` +
        `are two ledgers on one tag.`,
    )
  }
  if (!TRIGGERS.includes(raw['trigger'] as Trigger)) {
    return fail(`trigger must be one of ${TRIGGERS.join('|')}, got ${JSON.stringify(raw['trigger'])}`)
  }
  // Stored VERBATIM and never parsed — it is generated prose whose wording
  // changes whenever a rule does. An empty reason is allowed; a missing one is
  // not, because "no reason recorded" has to be a choice somebody made.
  if (typeof raw['reason'] !== 'string') return fail('reason is required (it may be empty)')
  if (!Array.isArray(raw['actions'])) return fail('actions must be an array')

  const actions: WireAction[] = []
  for (let i = 0; i < raw['actions'].length; i++) {
    const v = validateWireAction(raw['actions'][i], i)
    if (!v.ok) return fail(v.error)
    actions.push(v.value)
  }

  /**
   * ONE ACTION PER CONTRACT, AND THE WHOLE PACKAGE IS REFUSED OTHERWISE.
   *
   * This is not tidiness. The wire addresses CONTRACTS while `applyDecision`
   * addresses LEG TAGS, so two actions naming one instrument collapse onto one
   * tag downstream, and both halves of that collapse are wrong:
   *
   *   THE PRICES SWAP. Per-leg pricing is keyed by desk tag, so the second
   *   action's `limitPrice`/`workMode` overwrite the first's — a close priced
   *   at the far touch would go out at the limit the OPEN chose, on a real
   *   order, silently.
   *
   *   AND THE REFUSAL DISAPPEARS. `applyActions` mutates its book as it walks
   *   the list, so `[close X, open X]` no longer sees the leg it just removed:
   *   the duplicate-tag check that would have refused the open passes, and the
   *   contract is re-derived from the strike and type of the leg that was
   *   deleted a step earlier. A package that reads as "flatten and re-enter"
   *   quietly becomes an un-refused open on a book the desk has stopped
   *   describing correctly.
   *
   * Refused at the DOOR — 400, nothing written, no decisionId claimed — rather
   * than skipped per action, because the package is the unit the supervisor
   * reasons in. Half of an ambiguous package is not a safer outcome than none
   * of it. The engine forms one move per contract by construction, so this can
   * only ever fire on a client bug, and it should fire loudly.
   */
  const seen = new Set<string>()
  for (const a of actions) {
    if (seen.has(a.instrument)) {
      return fail(
        `actions name '${a.instrument}' more than once. One action per contract per package: ` +
          `the wire addresses contracts and the desk addresses leg tags, so two actions on one ` +
          `instrument collapse onto one tag — swapping their prices and losing the refusal that ` +
          `should have stopped the second. Split them into two decisions with two decisionIds.`,
      )
    }
    seen.add(a.instrument)
  }

  const work = optionalWork(raw)
  if (!work.ok) return fail(work.error)

  return ok({
    tag,
    mode,
    decisionId: raw['decisionId'],
    symbol: raw['symbol'],
    expiry: raw['expiry'],
    trigger: raw['trigger'] as Trigger,
    reason: raw['reason'],
    actions,
    ...(work.value === undefined ? {} : { work: work.value }),
  })
}

// ------------------------------------------------------------- translation

/** Per-leg order pricing, in the shape `applyDecision` already accepts. */
type PricingEntry = {
  orderType: 'MARKET' | 'LIMIT'
  limitPrice?: number
  workMode?: WorkMode
  /**
   * The PACKAGE's execution dials, repeated onto every leg because the map
   * `applyDecision` takes is keyed by leg tag. They are the book's dials, so
   * every leg of one decision carries the same three values by construction —
   * this is a shape, not a per-leg choice.
   */
  trancheLots?: number
  chaseMaxMs?: number
  chaseCrossBufferPct?: number
}

export interface Translation {
  readonly actions: readonly DeskAction[]
  readonly pricing: ReadonlyMap<string, PricingEntry>
  /** Leg tag -> the contract it names, so a skip can be read back onto the wire. */
  readonly instrumentByTag: ReadonlyMap<string, string>
  /** Refused before the gate stack — an unlistable contract, a wrong expiry. */
  readonly skips: readonly { readonly instrument: string; readonly reason: string }[]
}

/**
 * Turn the supervisor's instrument-shaped package into desk actions.
 *
 * Deliberately FAIL-SOFT, per action: one contract the master cannot name must
 * not discard the other seven, exactly as `applyActions` refuses one action
 * rather than throwing. Everything it cannot translate comes back as a skip
 * naming the instrument, which is the only identifier the supervisor holds.
 */
export function translate(
  req: DecisionRequest,
  book: readonly BridgeLeg[],
  master: OptionMaster,
): Translation {
  const actions: DeskAction[] = []
  const pricing = new Map<string, PricingEntry>()
  const instrumentByTag = new Map<string, string>()
  const skips: { instrument: string; reason: string }[] = []

  /**
   * ABSENT `workMode` MEANS PASSIVE-FIRST, and the default is applied HERE.
   *
   * The wire contract says so in as many words ("`workMode` absent =
   * passive-first"), and dropping it instead — which this did at first — quietly
   * inverted that: a fill with no work mode reaches the gateway looking like
   * every order this desk has ever placed, gets the marketable-limit fallback,
   * and is chased across the spread. The supervisor asked for the opposite by
   * saying nothing.
   *
   * THE DEFAULT BELONGS AT THIS BOUNDARY AND NOWHERE ELSE. `Fill.workMode` stays
   * genuinely absent for `/v1/desk/submit`, `closeAll` and the Python decision
   * path, because none of those has a passive-first contract and stamping one on
   * them would tell the chaser a decision was made where none was. It is the
   * ENGINE WIRE that carries the default, so the engine wire is where it is read.
   *
   * The price is unaffected: with no `limitPrice` this is still a MARKET entry,
   * which `priceFillsForRoute` hands to `marketableFallback` exactly as before —
   * the order is still priced to fill, it is simply now labelled with how it was
   * meant to be worked.
   */
  /**
   * The book's execution dials ride on every entry — see `PricingEntry`. They
   * are stamped even on an unpriced MARKET action, because that is precisely
   * the shape most supervisor actions have and the one that most needs them:
   * how much of the size to show at a time is not a statement about price.
   */
  const work = {
    ...(req.work?.trancheLots === undefined ? {} : { trancheLots: req.work.trancheLots }),
    ...(req.work?.chaseMaxMs === undefined ? {} : { chaseMaxMs: req.work.chaseMaxMs }),
    ...(req.work?.chaseCrossBufferPct === undefined
      ? {}
      : { chaseCrossBufferPct: req.work.chaseCrossBufferPct }),
  }
  const price = (deskTag: string, a: WireAction): void => {
    pricing.set(deskTag, {
      orderType: a.limitPrice === undefined ? 'MARKET' : 'LIMIT',
      ...(a.limitPrice === undefined ? {} : { limitPrice: a.limitPrice }),
      workMode: a.workMode ?? 'passive',
      ...work,
    })
  }
  const emit = (deskTag: string, instrument: string, action: DeskAction, a: WireAction): void => {
    instrumentByTag.set(deskTag, instrument)
    actions.push(action)
    price(deskTag, a)
  }

  for (const a of req.actions) {
    const legs = book.filter((l) => l.instrument.tradingsymbol === a.instrument)

    if (a.op === 'open') {
      /**
       * AN OPEN ON A CONTRACT THE BOOK ALREADY HOLDS IS EMITTED ONLY TO BE
       * REFUSED, under the book's own tag.
       *
       * Tagging it afresh would put a SECOND leg on the same contract, and the
       * engine wire addresses contracts — it could then never name either of
       * them again. So it carries the existing tag, `applyActions` answers
       * "tag is already open", and the supervisor is told in the one wording
       * every duplicate open on this desk gets. Nothing here re-resolves the
       * contract, which is why the leg's own strike and type are safe to reuse:
       * they are only ever carried into a refusal.
       */
      const held = legs[0]
      if (held !== undefined) {
        emit(
          held.deskTag,
          a.instrument,
          {
            op: 'open',
            ts: held.deskTag,
            strike: held.strike,
            type: held.type,
            side: a.side,
            qty: a.qty,
            // Carried even here, where the action exists only to be refused:
            // one spelling of an open, so a field cannot survive on one branch
            // and vanish on the other.
            ...(a.leanId === undefined ? {} : { leanId: a.leanId }),
            ...(a.add === true ? { add: true } : {}),
          },
          a,
        )
        continue
      }
      const contract = contractOf(master, a.instrument, [req.symbol])
      if (contract === null) {
        skips.push({
          instrument: a.instrument,
          reason:
            `open: the instrument master does not list '${a.instrument}' under ${req.symbol} — ` +
            `it is not a contract this desk can route`,
        })
        continue
      }
      if (contract.expiry !== req.expiry) {
        skips.push({
          instrument: a.instrument,
          reason:
            `open: '${a.instrument}' expires ${contract.expiry}, but this book is ${req.expiry}. ` +
            `Refused rather than re-resolved: the same strike lists on both, so booking it ` +
            `against this expiry would open a DIFFERENT contract than the one named.`,
        })
        continue
      }
      /**
       * THE TAG IS THE TRADINGSYMBOL, for a leg the engine is opening now.
       *
       * Stable, unique within a book (a second open on it is refused above),
       * and the same string the next decision will name the leg by — which is
       * the property the Python tag scheme (`CE530#3`, suffixed with the book's
       * length) could not offer across a process boundary.
       */
      emit(
        a.instrument,
        a.instrument,
        {
          op: 'open',
          ts: a.instrument,
          strike: contract.strike,
          type: contract.type,
          side: a.side,
          qty: a.qty,
          // THE DELTA-LEAN STAMP, carried onto the leg `applyActions` creates.
          // Omitted — never `undefined` — when the caller named no lean, so an
          // unstamped leg carries no key rather than a stored null.
          ...(a.leanId === undefined ? {} : { leanId: a.leanId }),
          /**
           * THE ADD FLAG, onto the DeskAction `applyActions` actually reads.
           *
           * Parsing it off the wire is not enough — the parsed action and the
           * DeskAction are two different shapes, and a field carried onto the
           * first but not the second is dropped exactly here. That is how the
           * first cut of this fix shipped and changed nothing: the shed set the
           * flag, the wire carried it, and the book never saw it.
           */
          ...(a.add === true ? { add: true } : {}),
        },
        a,
      )
      continue
    }

    if (a.op === 'close') {
      if (legs.length === 0) {
        // Translated anyway, under the contract's own name, so the refusal
        // comes from `applyActions` in the same words every other unknown leg
        // gets — one place decides what "not in the book" reads like.
        emit(a.instrument, a.instrument, { op: 'close', ts: a.instrument }, a)
        continue
      }
      // EVERY leg on the contract, not the first. A carried book can hold the
      // same strike twice, and the wire addresses the CONTRACT — closing one of
      // two while answering "closed" is the worst available outcome.
      for (const leg of legs) emit(leg.deskTag, a.instrument, { op: 'close', ts: leg.deskTag }, a)
      continue
    }

    // resize
    if (legs.length > 1) {
      skips.push({
        instrument: a.instrument,
        reason:
          `resize: this book holds ${legs.length} legs on '${a.instrument}' ` +
          `(${legs.map((l) => l.deskTag).join(', ')}), and a target quantity does not say ` +
          `which one to move. Close them and re-open at the size you want.`,
      })
      continue
    }
    const tag = legs[0]?.deskTag ?? a.instrument
    emit(tag, a.instrument, { op: 'resize', ts: tag, qty: a.targetQty }, a)
  }

  return { actions, pricing, instrumentByTag, skips }
}

// ---------------------------------------------------------------- response

/**
 * The service's fills, re-read as contracts.
 *
 * NOT CAST. `DeskSide` and the engine's `Side` are the same two words today,
 * and if either side ever renames one this line must fail to compile rather
 * than quietly hand the supervisor a direction it does not understand.
 */
function wireFills(result: ServiceDecisionResponse): WireFill[] {
  return result.fills.map((f) => ({
    instrument: f.tradingsymbol,
    side: f.side,
    qty: f.qty,
    price: f.price,
    ...(f.resting === true ? { resting: true } : {}),
  }))
}

function wireSkips(
  result: ServiceDecisionResponse,
  instrumentByTag: ReadonlyMap<string, string>,
): { readonly instrument: string; readonly reason: string }[] {
  return result.skips.map((s) => ({
    // Every action this module emits carries a `ts`, so the lookup always hits.
    // The fallback is the tag itself rather than an empty string: a skip the
    // supervisor cannot attribute is a skip it cannot act on.
    instrument: instrumentByTag.get(s.action.ts) ?? s.action.ts,
    reason: s.reason,
  }))
}

/**
 * A routing failure, as one line naming the contract.
 *
 * `skips` and `routeErrors` stay two arrays because they are different news: a
 * skip is a desk-api gate deciding an action must not go, a route error is the
 * rail refusing one that should have. Collapsing them is how a rejected order
 * comes to read as a deliberate hold.
 */
function wireRouteErrors(result: ServiceDecisionResponse): string[] {
  return result.routeErrors.map((e) => `${e.fill.tradingsymbol}: ${e.error}`)
}

// ------------------------------------------------------------------- route

/**
 * The unique index on the engine journal, created once at construction.
 *
 * Fire-and-forget for the reason `ensureAuditIndex` gives: a route module whose
 * CONSTRUCTION can fail on a database detail takes the whole server down, and
 * this collection is telemetry.
 */
function ensureEngineIndex(deps: Pick<ApiDeps, 'db' | 'log'>): void {
  const failed = (err: unknown): void => {
    deps.log('engine decision journal index creation failed — a retry may duplicate a row', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
  try {
    void deps.db
      .collection(ENGINE_DECISIONS_COLLECTION)
      .createIndex({ decisionId: 1 }, { unique: true })
      .catch(failed)
  } catch (err) {
    failed(err)
  }
}

/**
 * The shared bag plus the password gate, exactly as `booksRoutes` takes it.
 *
 * The gate is here for ONE endpoint — `POST .../protect` on a live book.
 * Pinning quantity the engine may not spend is a risk control of the same
 * class as a dials retune: it decides what the desk is allowed to do with a
 * real position, and on the live rail that has cost the password since spec §5.
 */
type EngineDeps = ApiDeps & { readonly gate: AuthGate }

/**
 * `POST /v1/desk/engine/protect` — the operator pinning lots the engine may
 * not spend, and `GET` the same path to read what is pinned (spec §4, D12).
 *
 * ── SINGLE WRITER, THROUGH THE STORE ────────────────────────────────────────
 * The supervisor is the other writer of this document and it is writing on
 * every tick. So this is a LOAD → MERGE → COMPARE-AND-SET, using the store's
 * own CAS rather than a `$set` on the one field: a blind `$set` would be
 * invisible to a supervisor that had already read the state and was about to
 * write its own version back over the top, and the protection would vanish
 * silently between one mark and the next.
 *
 * RETRIED EXACTLY ONCE, and never with the same `next`. A `false` from `save`
 * means somebody else's write landed; the state that won may carry a working
 * package this caller never saw, so the retry RE-READS and merges again. Two
 * losses in a row is a book being written to hard enough that a third attempt
 * is not the answer — 409, and the operator presses the button again knowing
 * it did not apply.
 *
 * ZERO DELETES THE KEY rather than storing a 0. The engine treats `<= 0` as
 * unprotected either way (`shiftSpendableLots`), so the two are identical to
 * every reader — but a document full of zeroed claims is a list of things the
 * operator has to read and dismiss, and this map is what the leg rows render.
 */
async function handleProtect(
  ctx: RouteCtx,
  deps: EngineDeps,
  state: StateStore,
  audit: ReturnType<typeof auditLog>,
): Promise<boolean> {
  if (ctx.method === 'GET') {
    const tag = ctx.url.searchParams.get('tag') ?? ''
    const mode = ctx.url.searchParams.get('mode')
    if (tag === '') {
      ctx.send(400, { error: 'tag is required' })
      return true
    }
    if (mode !== 'paper' && mode !== 'live') {
      ctx.send(400, { error: "mode must be stated explicitly as 'paper' or 'live'" })
      return true
    }
    const current = await state.load(tag, mode)
    ctx.send(200, { tag, mode, protectedQty: current.protectedQty })
    return true
  }
  if (ctx.method !== 'POST') return false

  // ONE read of the body: `readJson` is the request stream, and the password
  // has to come out of the same object the request was validated from.
  const body = await ctx.readJson()
  const parsed = validateProtectRequest(body)
  if (!parsed.ok) {
    ctx.send(400, { error: parsed.error })
    return true
  }
  const req = parsed.value
  const mode = req.mode as DeskMode

  /**
   * THE BOOK HAS TO EXIST. Protection on a tag with no registry row is a claim
   * nothing will ever read — and, worse, it would still be sitting in Mongo
   * when a book of that name was next built, silently pinning quantity nobody
   * asked to pin.
   */
  const book = await deps.store.getBook(req.tag, mode)
  if (book === null) {
    ctx.send(404, { error: `'${req.tag}' has no book registered in ${mode}` })
    return true
  }

  /**
   * LIVE COSTS THE PASSWORD, on the same condition and in the same order as
   * the dials patch (`routes/books.ts`): the request is checked FIRST, so a
   * typo is answered before the prompt rather than after it. A machine
   * principal cannot satisfy re-auth at all, by design.
   */
  if (mode === 'live') {
    const denied = await deps.gate.reauth(
      ctx.principal,
      isObject(body) ? body['password'] : undefined,
    )
    if (denied !== null) {
      ctx.send(403, { error: denied, reauthRequired: true })
      return true
    }
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    const prev = await state.load(req.tag, mode)
    const protectedQty = { ...prev.protectedQty }
    if (req.protectedQty === 0) delete protectedQty[req.instrument]
    else protectedQty[req.instrument] = req.protectedQty
    const saved = await state.save(prev, {
      ...prev,
      protectedQty,
      updatedAt: nextVersion(prev, deps.now()),
    })
    if (!saved) continue

    ctx.log('engine protection set', {
      tag: req.tag,
      mode,
      instrument: req.instrument,
      lots: req.protectedQty,
      setBy: ctx.principal.name,
    })
    // The password is in the body and is NOT passed here — `redactDetail`
    // would strip it anyway; not handing it over is the first line.
    await audit.record({
      principal: ctx.principal,
      source: ENGINE_PROTECT_PATH,
      action: req.protectedQty === 0 ? 'unprotected a leg' : 'protected a leg by quantity',
      tag: req.tag,
      mode,
      detail: {
        instrument: req.instrument,
        before: prev.protectedQty[req.instrument] ?? 0,
        after: req.protectedQty,
      },
    })
    ctx.send(200, { tag: req.tag, mode, protectedQty })
    return true
  }

  ctx.send(409, {
    error:
      `${req.tag}'s supervisor state was written by somebody else twice while this was being ` +
      `applied — NOTHING was changed. Try again; if it keeps happening, the supervisor is ` +
      `mid-decision on this book.`,
  })
  return true
}

/**
 * Which of these contracts already have a PAPER order out for this tag.
 *
 * One indexed-ish query over the small non-terminal slice of the queue, narrowed
 * to the contracts the package actually names — so a book with a hundred filled
 * orders behind it costs the same as one with none.
 *
 * FAILS OPEN, and that is the right direction here. This is a duplicate guard
 * on the PAPER rail: an unreadable queue that refused the package would stop a
 * rehearsal over a Mongo blip, while one that lets it through leaves the same
 * two-legs-on-one-contract state the desk has always been able to reach by hand
 * — visible on the positions page and fixable. It is logged either way.
 */
async function workingContracts(
  db: ApiDeps['db'],
  tag: string,
  decisionId: string,
  instruments: ReadonlySet<string>,
  log: (msg: string, ctx?: Record<string, unknown>) => void,
): Promise<ReadonlySet<string>> {
  try {
    const docs = await db
      .collection(COLLECTIONS.gatewayOrders)
      .find({
        tag,
        mode: 'paper',
        state: { $in: NON_TERMINAL_STATES },
        tradingsymbol: { $in: [...instruments] },
      })
      .toArray()
    return new Set(
      docs
        /**
         * THIS DECISION'S OWN ORDERS DO NOT COUNT AGAINST IT.
         *
         * A replay posts the identical package under the identical id, and
         * `applyDecision` answers it with the ORIGINAL result and routes
         * nothing — that idempotency is the entire point of `decisionId`, and a
         * supervisor restart, a retried POST or a socket that died after the
         * order went out all depend on it. A guard that counted the package's
         * own working orders would refuse every one of those with a 400, and
         * the supervisor would be told its decision failed while its orders
         * were live.
         *
         * Split the way `splitOrderId` splits — the shared reader — rather than
         * by a prefix test, so this cannot disagree with the writer about where
         * an id ends.
         */
        .filter((d) => splitOrderId(String(d['clientOrderId'] ?? '')).decisionId !== decisionId)
        .map((d) => String(d['tradingsymbol'] ?? '')),
    )
  } catch (err) {
    log('engine decision: the order queue could not be read — the duplicate-open guard is OFF', {
      tag,
      error: String(err),
    })
    return new Set()
  }
}

export function engineRoutes(deps: EngineDeps): Route {
  const { service, master, store, db, now } = deps
  ensureEngineIndex(deps)
  const audit = auditLog(deps)
  /** One `engine decision applied` line per replay storm per 10 minutes. */
  const replayLog = createReplayLogGate({ intervalMs: 10 * 60_000 })
  /**
   * The supervisor's collection through desk-api's narrow `Database` port.
   *
   * The cast is the one `apps/supervisor/test/state-store.test.ts` makes for
   * the same object: the port this file's `db` hands back does not DECLARE
   * `findOneAndUpdate`, and the driver underneath has always had it. Widening
   * `Collection` instead would add a required method to an interface seven
   * test doubles implement, to reach one caller.
   */
  const state = new StateStore(
    db.collection(SUPERVISOR_STATE_COLLECTION) as unknown as StateCollection,
  )

  return async (ctx: RouteCtx): Promise<boolean> => {
    if (ctx.path === ENGINE_PROTECT_PATH) return await handleProtect(ctx, deps, state, audit)
    if (ctx.path !== ENGINE_DECISIONS_PATH) return false
    if (ctx.method !== 'POST') return false

    /**
     * MACHINE ONLY, like `POST /v1/desk/stream/notify`.
     *
     * This endpoint places live orders from a body, and the supervisor is its
     * only client — it holds `DESK_API_TOKEN` and authenticates as a machine. A
     * browser session must not be able to reach it at all, so a stolen cookie
     * cannot post a decision package.
     */
    if (ctx.principal.kind !== 'machine') {
      ctx.send(403, { error: 'only a machine principal may post an engine decision' })
      return true
    }

    const parsed = validateDecisionRequest(await ctx.readJson())
    if (!parsed.ok) {
      // 400 and NOTHING WRITTEN — not a `DecisionResponse` with a status,
      // because a refusal at the door is not a decision outcome and must not
      // wear the shape of one. The supervisor checks the HTTP status first.
      ctx.send(400, { error: parsed.error })
      return true
    }
    const req = parsed.value
    const mode = req.mode as DeskMode
    const receivedAt = now()

    /**
     * The book as it is BEFORE the decision, and it is read for the translation
     * only. `applyDecision` takes its own read a moment later and pins its
     * write to that version — this one cannot be the version the fold is
     * compare-and-set against, or two reads would race each other.
     *
     * What it is used for is naming: which leg tag the book already holds for
     * each contract the supervisor named. A leg that appears between these two
     * reads simply is not found here, and the action falls through to
     * `applyActions`' own refusal, which is the same answer.
     */
    const book = await store.loadBook(req.tag, mode)
    const t = translate(req, book, master.current())

    /**
     * IS THIS PACKAGE PURELY AN EXIT? Computed from the book, not claimed by
     * the caller.
     *
     * `gateStrategy` exempts reduce-only orders from a switched-off row — "off"
     * stops new exposure and must never trap what it holds (the 2026-08-04
     * incident its header describes). `/v1/desk/submit` lets its caller claim
     * that exemption on the request body; here there is no need to trust
     * anyone, because the book says which actions reduce and `addsExposure` is
     * the same predicate the kill switch is split on.
     *
     * ALL OR NOTHING, because the gate is: a package with one open in it is not
     * an exit, and the whole of it is refused.
     */
    const reducesExposure =
      t.actions.length > 0 && t.actions.every((a) => !addsExposure(a, book))

    /**
     * AN OPEN ON A CONTRACT THAT ALREADY HAS AN ORDER OUT IS REFUSED (D14).
     *
     * On every other path the BOOK is the guard: `applyActions` refuses an open
     * whose contract the book already holds ("tag is already open"), and the
     * book holds it because the decision that opened it folded at route time.
     * An engine PAPER decision does not fold until its fills land, so between
     * the decision and the fill the book says nothing — and a second decision
     * on the same contract would route a SECOND order, land two legs on one
     * instrument, and leave the wire (which addresses contracts) unable to name
     * either of them again. That is the exact state the duplicate-tag refusal
     * exists to prevent, reached through the window the deferred fold opens.
     *
     * SO THE OUTSTANDING ORDER STANDS IN FOR THE LEG. Anything non-terminal in
     * the gateway queue for this tag on this rail is a position on its way, and
     * an open naming it is refused.
     *
     * PAPER ONLY, and not for tidiness: on live the book IS folded at route
     * time, so `applyActions` already refuses in its own words, and adding a
     * second refusal there would mean two places deciding what "already open"
     * means. A live package must not start depending on this query.
     *
     * REFUSED AT THE DOOR — 400, nothing written, no decisionId claimed — and
     * the WHOLE package, exactly as the duplicate-instrument rule above is. The
     * supervisor's own working-package hold means this can only fire on a
     * client bug, and half of a package formed against a book the caller has
     * misread is not a safer outcome than none of it.
     */
    if (mode === 'paper') {
      const opening = new Set(
        req.actions.filter((a) => a.op === 'open').map((a) => a.instrument),
      )
      if (opening.size > 0) {
        const working = await workingContracts(db, req.tag, req.decisionId, opening, ctx.log)
        const clash = [...opening].find((i) => working.has(i))
        if (clash !== undefined) {
          ctx.send(400, {
            error:
              `'${clash}' already has an order working for ${req.tag} on paper. An engine paper ` +
              `decision books its leg when the fill lands, not when it routes, so the book cannot ` +
              `refuse this open yet — and a second order would put TWO legs on one contract, which ` +
              `the wire could never name again. Wait for the working package, or close it first.`,
          })
          return true
        }
      }
    }

    /**
     * Telemetry, BEFORE `applyDecision`, and swallowed on failure — the same
     * placement and the same reasoning the retired wire had: `applyDecision`
     * returns early for an id it has already seen, so a reason written inside
     * it would pin the run page to a stale thought. The trigger stands in for
     * the old wire's `action` word; both are read by the Books page's decision
     * panel, which would otherwise be blank for every engine-driven book.
     */
    try {
      await store.recordDecisionReason(req.tag, mode, req.trigger, req.reason, receivedAt)
    } catch (err) {
      ctx.log('engine decision reason write failed', { tag: req.tag, error: String(err) })
    }

    const result = await service.applyDecision(
      {
        symbol: req.symbol,
        expiry: req.expiry,
        mode,
        tag: req.tag,
        decisionId: req.decisionId,
        actions: t.actions,
        action: req.trigger,
        reason: req.reason,
        /**
         * THIS PACKAGE GETS THE SUPERVISOR'S LIFECYCLE (D14) — set here, in
         * code, and never read off the body.
         *
         * On PAPER it is what routes the orders into the gateway's own queue
         * and answers `WORKING`: the fills arrive on their own event and
         * `paper-fold.ts` books them. On LIVE it changes nothing today, and it
         * is still stamped because the record should say which endpoint formed
         * the decision whichever rail it went down.
         */
        via: 'engine',
      },
      t.pricing,
      // NOT the operator exemption. The supervisor is a strategy, and a
      // strategy that could exempt itself from its own switch is a switch.
      false,
      reducesExposure,
    )

    const response: DecisionResponse = {
      decisionId: result.decisionId,
      replayed: result.replayed,
      // Straight through, `WORKING` included. It is decided where the orders
      // are actually routed, never invented here: a status this module composed
      // could tell the supervisor to wait for fills nothing is going to send.
      status: result.status,
      fills: wireFills(result),
      // The translation's own refusals FIRST: they never reached a gate, and a
      // supervisor reading the list top-down should see what this process
      // refused to even attempt before what it attempted and was refused.
      skips: [...t.skips, ...wireSkips(result, t.instrumentByTag)],
      routeErrors: wireRouteErrors(result),
    }

    /**
     * Only decisions that DID something, and only once each — `replayed`
     * matters as much as the fill count, or a retry would show the operator two
     * adjustments where the book made one.
     */
    if (!result.replayed && result.fills.length > 0) {
      try {
        await store.appendDecisionAction(req.tag, mode, {
          at: receivedAt,
          decisionId: result.decisionId,
          action: req.trigger,
          reason: req.reason,
          fills: result.fills.map((f) => ({
            deskTag: f.deskTag,
            tradingsymbol: f.tradingsymbol,
            side: f.side,
            qty: f.qty,
            price: f.price,
          })),
        })
      } catch (err) {
        ctx.log('engine decision action-log write failed', { tag: req.tag, error: String(err) })
      }
    }

    /**
     * The engine journal. `$setOnInsert` so the FIRST post wins and a replay
     * leaves the original outcome alone — the stored response must describe
     * what actually happened, not a later echo of it. `$inc` counts the retries
     * beside it, which is the operational question this collection answers that
     * `desk-decisions` cannot: how many times did the supervisor have to ask?
     *
     * Best effort, and last: the orders are already placed and the book is
     * already folded by this line. A journal write that could 500 the response
     * would have the supervisor retry a package that has fully routed.
     */
    try {
      const record: Omit<EngineDecisionRecord, 'posts'> = {
        decisionId: req.decisionId,
        tag: req.tag,
        mode: req.mode,
        symbol: req.symbol,
        expiry: req.expiry,
        trigger: req.trigger,
        reason: req.reason,
        actions: req.actions,
        response,
        receivedAt,
      }
      await db
        .collection(ENGINE_DECISIONS_COLLECTION)
        .updateOne({ decisionId: req.decisionId }, { $setOnInsert: record, $inc: { posts: 1 } }, { upsert: true })
    } catch (err) {
      ctx.log('engine decision journal write failed', { tag: req.tag, error: String(err) })
    }

    // A fresh decision always; a replay once, then once per interval with the
    // count it stood for — see `replay-log.ts` for the 10 MB weekends.
    const verdict = replayLog(
      response.decisionId,
      response.replayed,
      now(),
      `${response.status}|${response.fills.length}|${response.routeErrors.length}`,
    )
    if (verdict.log) {
      ctx.log('engine decision applied', {
        decisionId: response.decisionId,
        tag: req.tag,
        mode: req.mode,
        trigger: req.trigger,
        replayed: response.replayed,
        status: response.status,
        fills: response.fills.length,
        skips: response.skips.length,
        routeErrors: response.routeErrors.length,
        ...(verdict.suppressed > 0 ? { replaysSinceLastLine: verdict.suppressed } : {}),
      })
    }
    // 200 even with skips or route errors: the decision WAS processed and the
    // body says what happened to each action. A 4xx here would invite a retry
    // of a package that partially routed.
    ctx.send(200, response)
    return true
  }
}
