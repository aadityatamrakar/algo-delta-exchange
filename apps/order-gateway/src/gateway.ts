/**
 * Order gateway: the only thing that talks to a live broker.
 *
 * Consumes desk orders from `desk-gateway-orders`, splits them under the
 * exchange freeze limit, places them through the XTS adapter, and writes every
 * status transition back so the bridge can report REAL fills instead of the
 * marks it invented at decision time.
 *
 * IT MUST NEVER SHARE A COLLECTION WITH `xtsOrder.js`. That daemon watches
 * `positional`; if this gateway watched it too, every desk order would be
 * placed twice — once by each. The two are kept apart by `LiveExecutor` in
 * apps/api/src/rail.ts, and this file only ever reads the gateway collection.
 *
 * The state machine is pure and lives here; the socket, the Mongo change stream
 * and the broker are all injected, so the ordering guarantees below are
 * testable without any of them.
 */

import { splitIntoTranches, type FreezeLimits } from '@algomaker/instruments'
import { roundToStep } from '@algomaker/venue'
// The desk's ONE definition of "this op only reduces exposure", shared rather
// than restated: a second spelling of it here is a second thing to get wrong,
// and the two would disagree about `roll` on the day one of them changed.
import { venueFromEnv } from '@algomaker/venue'
import { reducesExposure } from './queue.ts'
import type { OrderIntent } from '@algomaker/order-bus'
import type { PlacedOrder } from '@algomaker/brokers'

export interface GatewayOrderDoc {
  readonly _id?: unknown
  readonly tradingsymbol: string
  readonly instrument_token?: number
  readonly transaction_type: 'BUY' | 'SELL'
  readonly order_type?: 'MARKET' | 'LIMIT'
  readonly limitPrice?: number
  readonly quantity: number
  readonly tag: string
  readonly underlying?: string
  readonly desk_tag?: string
  /**
   * `open` | `close` | `roll` | `resize` — written by `apps/api/src/rail.ts`.
   *
   * The gateway's ONLY exposure signal, and therefore what decides whether the
   * kill switch may refuse the order: a halt stops new exposure and never blocks
   * an exit. Optional because a document may carry no desk provenance at all.
   */
  readonly desk_op?: string
  readonly exchange?: string
  /**
   * HOW HARD THE ORDER WORKS — `passive` | `urgent`, written by
   * `apps/api/src/rail.ts` from the engine wire. Read here for one decision
   * only: an urgent order is worked in FREEZE-sized tranches (the fewest legal
   * slices), a passive one in whatever the book's `work_tranche_lots` dial says.
   */
  readonly workMode?: string
  /**
   * The book's `work_tranche_lots`, in LOTS, threaded through the rail.
   *
   * ABSENT MEANS NO GATING, never a default. Every order this desk has routed
   * until now carries no dial, and gating them would turn one freeze-split
   * placement into a sequence spread over minutes — a change nobody asked for
   * on the exit path of a live book.
   */
  readonly trancheLots?: number
  /** Written by the gateway itself once the order is gated. See `planTranches`. */
  readonly tranchePlan?: readonly TranchePlanEntry[]
  readonly trancheCursor?: number
}

export interface ResolvedContract {
  readonly tradingsymbol: string
  readonly instrumentToken: number
  readonly lotSize: number
  readonly tickSize: number
  readonly exchange: string
  /**
   * The instrument master's own `name` column — the AUTHORITATIVE freeze key.
   *
   * The dump's `name` for an option row is the NSE underlying symbol, which is
   * exactly what `qtyfreeze.csv` is keyed by, so this and the freeze table agree
   * by construction. `deriveUnderlying` cannot: see its comment for the two
   * symbols it gets wrong and what that costs.
   *
   * Optional only because a caller may not have the dump row to hand; when it is
   * absent the order falls back to `doc.underlying` and then to the regex.
   */
  readonly underlying?: string
}

export interface PlanOrderInputs {
  readonly doc: GatewayOrderDoc
  readonly contract: ResolvedContract | null
  readonly freeze: FreezeLimits
  /** Correlation prefix; each tranche gets a distinct suffix. */
  readonly clientOrderId: string
  /**
   * Plan ONE TRANCHE of a gated order rather than the whole quantity.
   *
   * `quantity` is that tranche's contract quantity — the freeze split still
   * applies INSIDE it, because the exchange rejects anything over the freeze
   * however the desk chose to slice it.
   *
   * `idOffset` is how many broker orders this desk order has ALREADY produced,
   * and it is what keeps tranche ids unique across slices: without it slice 2
   * would re-issue `X.1` and its fills would aggregate onto the tranche that
   * filled twenty seconds earlier. It is taken from the document's own
   * `trancheIds`, which makes it deterministic for a retry of the SAME slice —
   * exactly what `recoverInterrupted` needs to name what the interrupted
   * attempt would have sent.
   */
  readonly slice?: { readonly quantity: number; readonly idOffset: number }
}

export interface PlannedOrder {
  readonly intents: readonly OrderIntent[]
  readonly rejected: string | null
  /** Populated when the order was split; length > 1 means multiple broker orders. */
  readonly tranches: readonly number[]
  /** The freeze key actually used for the split. '' when the order was refused. */
  readonly underlying: string
  /** Where that key came from. `derived` is the guess, and it can be wrong. */
  readonly underlyingSource: UnderlyingSource
  /**
   * No freeze limit was found for `underlying`, so the order goes out UNSPLIT.
   *
   * The caller MUST surface this. A 100-lot order sent as one is rejected by the
   * exchange outright — the `xtsOrder.js:104` failure this whole module exists to
   * design out — and the only thing worse than that rejection is not knowing why
   * it happened. Silently producing one oversized order is not an option.
   */
  readonly freezeUnknown: boolean
  /**
   * Contract quantity across the WHOLE desk order — never just this tranche.
   * The denominator for completion.
   */
  readonly expectedQty: number
  /**
   * The freeze limit this split used, in lots, or null when unknown.
   *
   * Returned rather than re-derived by the caller because the lookup key is
   * `resolveUnderlying`'s decision (master, then order, then a regex that can be
   * wrong), and a caller that repeated that reasoning to size its own tranches
   * would eventually reach a different answer than the split it is slicing.
   */
  readonly maxLotsPerOrder: number | null
}

export type UnderlyingSource = 'order' | 'master' | 'derived'

/** Derivative exchanges whose underlyings NSE's `qtyfreeze.csv` cannot contain. */
const NON_NSE_DERIVATIVE_EXCHANGES = new Set(['BFO', 'BSE'])

/**
 * The operator-facing reason an order is going out UNSPLIT.
 *
 * IT MUST NAME THE RIGHT GAP, and which gap it is depends on the exchange.
 * `desk-freeze-limits` is built from NSE's `qtyfreeze.csv`
 * (`apps/marketdata/src/sync-runner.ts`), so:
 *
 *   NFO — the table is the right place to look. Either the sync has not run,
 *         or the master's `name` does not match the key the table is under.
 *         That advice is correct and stays.
 *
 *   BFO — SENSEX and BANKEX are BSE contracts. They are NOT in an NSE file and
 *         no amount of re-syncing THAT file will put them there. Their rows
 *         come from a SEPARATE source — BSE's abridged contract master
 *         (`Abridged_CO.ZIP`, column `MaxTradQty`), synced daily by
 *         desk-marketdata since 2026-09-21 and stamped on
 *         `md.health.bseFreezeSyncDay` — so a missing BSE row means THAT sync
 *         has not landed (first boot before its fetch, a bot wall at
 *         bseindia.com, a reshuffled file), and the advice points there.
 *
 * WHY THIS IS A FUNCTION AND NOT A STRING AT THE CALL SITE (2026-09-16). It
 * was the latter, and it told an operator chasing a SENSEX order to "check the
 * desk-freeze-limits sync and the instrument master's name column". Both were
 * correct. The sync had run and the name column was right; SENSEX was absent
 * because the file is NSE-only — so the message cost a diagnosis rather than
 * giving one. A reason that can be wrong about its own cause is worth a test.
 */
export function freezeUnknownReason(input: {
  readonly underlying: string
  readonly underlyingSource: UnderlyingSource
  readonly exchange: string
  readonly lots: number
}): string {
  const head =
    `no freeze limit for underlying '${input.underlying}' (source: ${input.underlyingSource}, ` +
    `exchange: ${input.exchange}) — sending ${input.lots} lots as ONE order; the exchange ` +
    `rejects anything over the volume freeze.`
  if (NON_NSE_DERIVATIVE_EXCHANGES.has(input.exchange.toUpperCase())) {
    return (
      `${head} desk-freeze-limits' NSE rows come from qtyfreeze.csv, which carries no BSE ` +
      `underlying; BSE index rows (SENSEX, BANKEX) come from BSE's abridged contract master ` +
      `(Abridged_CO.ZIP, MaxTradQty), synced daily by desk-marketdata. This underlying has no ` +
      `row: check md.health.bseFreezeSyncDay and the marketdata log for 'BSE freeze sync ` +
      `FAILED', or run make sync.`
    )
  }
  return `${head} Check the desk-freeze-limits sync and the instrument master's name column.`
}

/**
 * A quantity's whole lots, or null when it is not a positive whole number of
 * them. TO FLOAT PRECISION, not `%`: `0.15 % 0.001` is 0.0009999999999999913,
 * which refused every Delta order (lot 0.001 BTC). The tolerance is a
 * billionth of a lot, so an NSE share off a lot (13126 of 2625) still refuses.
 */
export function wholeLotsOf(quantity: number, lotSize: number): number | null {
  if (!Number.isFinite(quantity) || !(lotSize > 0)) return null
  const lots = Math.round(quantity / lotSize)
  if (!(lots > 0)) return null
  return Math.abs(quantity - lots * lotSize) <= lotSize * 1e-9 ? lots : null
}

/**
 * Turn one desk order document into the broker intents it becomes.
 *
 * Pure. Splitting happens HERE rather than inside the adapter so the caller can
 * see, log and journal that one desk order became three broker orders before
 * any of them is sent.
 */
export function planOrder(input: PlanOrderInputs): PlannedOrder {
  const { doc, contract, freeze } = input
  const refuse = (rejected: string): PlannedOrder => ({
    intents: [],
    rejected,
    tranches: [],
    underlying: '',
    underlyingSource: 'derived',
    freezeUnknown: false,
    expectedQty: 0,
    maxLotsPerOrder: null,
  })

  if (contract === null) {
    return refuse(`cannot resolve ${doc.tradingsymbol} — is it in the instrument master?`)
  }
  if (!(doc.quantity > 0) || !Number.isFinite(doc.quantity)) {
    return refuse(`bad quantity ${doc.quantity}`)
  }
  if (contract.lotSize <= 0) {
    return refuse(`${doc.tradingsymbol} has no lot size`)
  }
  if (wholeLotsOf(doc.quantity, contract.lotSize) === null) {
    // Not a whole number of lots cannot have been traded, and rounding it here
    // would silently size the position differently from the desk's intent.
    return refuse(`quantity ${doc.quantity} is not a multiple of lot size ${contract.lotSize}`)
  }
  /**
   * WHAT GOES OUT NOW, which for a gated order is one tranche of the order.
   * `expectedQty` below stays the WHOLE quantity regardless: it is the
   * denominator the fill watcher decides completion against, and slicing it
   * would mark the desk order FILLED on its first tranche — G1, arriving by a
   * new road.
   */
  const nowQuantity = input.slice?.quantity ?? doc.quantity
  const totalLots = wholeLotsOf(nowQuantity, contract.lotSize)
  if (totalLots === null) {
    return refuse(`tranche quantity ${nowQuantity} is not a whole number of lots`)
  }

  const { underlying, underlyingSource } = resolveUnderlying(doc, contract)
  const maxLots = freeze.maxLotsPerOrder(underlying, contract.lotSize)
  const tranches = splitIntoTranches(totalLots, maxLots)

  const intents: OrderIntent[] = tranches.map((lots, i) => ({
    // Each tranche is a distinct broker order and needs a distinct correlation
    // id, or the fill for tranche 2 would be attributed to tranche 1.
    //
    // A GATED order is ALWAYS suffixed, even when this slice is a single order:
    // the unsuffixed id is the DESK order's, and reusing it for one slice of
    // several would file that slice's fills under the parent — where
    // `baseClientOrderId` can no longer tell them apart from the aggregate.
    clientOrderId:
      input.slice === undefined
        ? tranches.length === 1
          ? input.clientOrderId
          : `${input.clientOrderId}.${i + 1}`
        : `${input.clientOrderId}.${input.slice.idOffset + i + 1}`,
    ts: 0,
    strategyTag: doc.tag,
    mode: 'live',
    destinations: ['xts'],
    instrument: {
      tradingsymbol: contract.tradingsymbol,
      instrumentToken: contract.instrumentToken,
      lotSize: contract.lotSize,
      tickSize: contract.tickSize,
      exchange: contract.exchange,
    },
    side: doc.transaction_type,
    orderType: doc.order_type === 'LIMIT' ? 'LIMIT' : 'MARKET',
    quantity: roundToStep(lots * contract.lotSize, contract.lotSize),
    lots,
    ...(doc.order_type === 'LIMIT' && doc.limitPrice !== undefined
      ? { limitPrice: doc.limitPrice }
      : {}),
    // The desk op rides the intent so the Delta adapter can send a close
    // `reduce_only` (spec §8) — an exit that can never open the other way.
    ...(doc.desk_op === undefined || doc.desk_op === '' ? {} : { meta: { desk_op: doc.desk_op } }),
  }))

  return {
    intents,
    rejected: null,
    tranches,
    underlying,
    underlyingSource,
    // maxLots === null means the freeze table has no row for this key, so
    // `splitIntoTranches` sent the whole thing as ONE order. Report it.
    freezeUnknown: maxLots === null,
    // On the lot grid, so a float-noisy 0.15000000000000002 is not a total
    // that fills summing to 0.15 can never reach. Identity on NSE.
    expectedQty: roundToStep(doc.quantity, contract.lotSize),
    maxLotsPerOrder: maxLots,
  }
}

// ------------------------------------------------------------ tranche plan

/** One slice of a gated order, in CONTRACT quantity. */
export interface TranchePlanEntry {
  readonly qty: number
}

/**
 * How a large order is worked: the slices, or null when it is not gated.
 *
 * THE POINT IS WHAT THE MARKET SEES. A 30-lot passive sell placed as one order
 * (or as four freeze tranches at once) shows the whole size at the touch, and
 * the book walks away from it — which is the entire reason the desk has a
 * `work_tranche_lots` dial at all. One slice is live at the broker at a time;
 * `decideTrancheStep` below is what releases the next.
 *
 * `urgent` TAKES THE FREEZE LIMIT, deliberately. It still slices — one live
 * tranche at a time is the invariant, and an urgent order that is refused on
 * its first slice must not have three more already at the exchange — but it
 * takes the biggest slice the exchange permits, so it gets there in the fewest
 * rounds. Below the freeze limit `urgent` is not gated at all, which is exactly
 * today's behaviour.
 *
 * NULL FOR EVERYTHING ELSE, and that is the compatibility guarantee: an order
 * with no dial and no work mode plans, splits and places precisely as it did
 * before this existed.
 */
export function planTranches(input: {
  readonly quantity: number
  readonly lotSize: number
  readonly trancheLots?: number | undefined
  readonly workMode?: string | undefined
  /** The freeze limit in lots, or null when the table has no row for it. */
  readonly freezeMaxLots: number | null
}): readonly TranchePlanEntry[] | null {
  const { quantity, lotSize } = input
  if (!Number.isFinite(quantity) || quantity <= 0 || !(lotSize > 0)) return null
  const totalLots = wholeLotsOf(quantity, lotSize)
  if (totalLots === null) return null

  const sliceLots = input.workMode === 'urgent' ? input.freezeMaxLots : dialLots(input.trancheLots)
  // No dial, or a freeze limit nobody knows: send it the way it has always been
  // sent. An unknown freeze is already reported LOUDLY by `planOrder`
  // (`freezeUnknown`), and inventing a slice size on top of that guess would
  // hide the thing that actually needs fixing.
  if (sliceLots === null || sliceLots === undefined) return null
  if (totalLots <= sliceLots) return null
  return splitIntoTranches(totalLots, sliceLots).map((lots) => ({ qty: roundToStep(lots * lotSize, lotSize) }))
}

/**
 * A dial value that can be acted on, or undefined.
 *
 * A fractional or zero `work_tranche_lots` is refused rather than rounded: 0
 * would mean "slice into nothing", and `splitIntoTranches` throws on both — out
 * of `planOrder`, on the order path, where a throw costs the whole placement.
 */
function dialLots(v: number | undefined): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : undefined
}

/** Contract quantity across slices 0..cursor inclusive — what should be filled by now. */
export function trancheQtyThrough(plan: readonly TranchePlanEntry[], cursor: number): number {
  let qty = 0
  for (let i = 0; i <= cursor && i < plan.length; i++) qty += plan[i]?.qty ?? 0
  return qty
}

/** What a gated order does next, once its current slice is accounted for. */
export type TrancheStep =
  /** Not gated, or on the last slice: the ordinary terminal decision applies. */
  | { readonly kind: 'settle' }
  /** Something is still at the broker (or on its way there). */
  | { readonly kind: 'working' }
  /**
   * Slice `from` is done; release `from + 1`.
   *
   * `shortfall` is how much of everything due by now did NOT fill — zero on the
   * ordinary path. It is non-zero only for an EXIT that came back short, which
   * continues anyway (see below) and says so loudly rather than quietly.
   */
  | { readonly kind: 'advance'; readonly from: number; readonly shortfall: number }
  /** Stop. Nothing further is placed, and a human is told. */
  | { readonly kind: 'halt'; readonly reason: string }

/**
 * Should the next tranche go out?
 *
 * Pure, so the one decision that can double a live position is provable without
 * a broker. Four rules, in the order they must be asked:
 *
 *  1. AN ORDER MID-PLACEMENT DECIDES NOTHING. Between the claim and
 *     `markPlaced` the slice in flight is not on the document, so every
 *     conclusion drawn from `trancheIds` is a conclusion about a slice that has
 *     not been recorded — and both available conclusions are wrong: advancing
 *     double-places, halting raises a false alarm over an order that is live and
 *     working. The state check is what makes the whole thing safe to run from a
 *     socket callback that can land at any moment.
 *  2. A COMPLETE ORDER SETTLES, wherever the cursor is. Over-filling is not a
 *     reason to place more.
 *  3. A SLICE THAT WENT TERMINAL SHORT OF ITS SIZE HALTS — IF IT ADDS EXPOSURE
 *     (D11). A rejection is the loud case, but a cancel or a partial that
 *     stopped is the same situation: the desk holds less than it decided to
 *     hold, and stacking the next slice on top of that difference is the one
 *     thing that must never happen by itself. The remainder is left for a human
 *     — or for the supervisor's next decision, which reads the book, not this
 *     order.
 *
 *     AN EXIT IS THE OPPOSITE TRADE, and halting one is the worse error — the
 *     SAME asymmetry every other gate on this path already makes (`queue.ts`:
 *     `refusesStaleOrder`, `haltsQueuedOrder`, and the placer's own comment
 *     that a refused close leaves the desk reading flat against a live
 *     position). Stopping a close after one short tranche abandons the rest of
 *     an exit the desk decided on, with NOTHING retrying it: the position stays
 *     open, unworked, and the next decision is taken against a book that says
 *     it is going away. Continuing cannot over-close, because the plan sums to
 *     the order's own quantity — so an exit ADVANCES on a shortfall, and the
 *     shortfall is reported rather than swallowed.
 *
 *     `resize` counts as reducing here, exactly as it does in `reducesExposure`,
 *     and carries the same accepted residual: this process cannot see the book,
 *     so it cannot tell a grow from a shrink, and trapping a shrink is the worse
 *     of the two errors.
 *  4. OTHERWISE ADVANCE, from the cursor the caller read. The caller turns that
 *     into a compare-and-set (`OrderQueue.advanceTranche`), which is what stops
 *     two watchers — or a re-claimed stale document — releasing one tranche
 *     twice (F-10).
 */
export function decideTrancheStep(input: {
  readonly plan: readonly TranchePlanEntry[]
  readonly cursor: number
  /** The desk order's own state. Only a PLACED order may advance or halt. */
  readonly state: string
  /**
   * `open` | `close` | `roll` | `resize` — the document's own exposure signal,
   * the only one this process has. It decides which way a short tranche fails.
   */
  readonly deskOp: string | undefined
  readonly agg: TrancheAggregate
}): TrancheStep {
  const { plan, cursor, agg } = input
  if (plan.length === 0) return { kind: 'settle' }
  if (input.state !== 'PLACED') return { kind: 'working' }
  if (agg.complete) return { kind: 'settle' }
  if (!agg.allTerminal) return { kind: 'working' }
  // A cursor past the plan is a corrupt document, not a licence to place more.
  if (cursor >= plan.length - 1) return { kind: 'settle' }

  const due = trancheQtyThrough(plan, cursor)
  const shortfall = Math.max(0, due - agg.filledQty)
  if (shortfall === 0 && agg.rejected.length === 0) return { kind: 'advance', from: cursor, shortfall: 0 }

  // The exit exemption. See rule 3: the remaining tranches of a close are the
  // rest of an exit nothing else will send.
  if (reducesExposure(input.deskOp)) return { kind: 'advance', from: cursor, shortfall }

  if (agg.rejected.length > 0) {
    return {
      kind: 'halt',
      reason:
        `tranche ${cursor + 1} of ${plan.length} was REJECTED (${agg.rejected.join('; ')}) — ` +
        `HALTED with ${agg.filledQty} of ${due} filled so far; the remaining ` +
        `${plan.length - cursor - 1} tranche(s) are NOT placed`,
    }
  }
  return {
    kind: 'halt',
    reason:
      `tranche ${cursor + 1} of ${plan.length} is terminal with only ${agg.filledQty} of ` +
      `${due} filled — HALTED rather than adding the next tranche on top of a size the ` +
      `desk does not hold`,
  }
}

/**
 * Which underlying to look the freeze limit up under, and where it came from.
 *
 * PRECEDENCE: instrument master, then the order, then the regex.
 *
 * The master wins over the order's own `underlying` because it IS the exchange's
 * `name` column for that contract, which is the same string `qtyfreeze.csv` is
 * keyed by — the two agree by construction. The order's value is whatever the
 * caller chose to send: `apps/runner`'s mirror path sets it to null deliberately,
 * and a book name is not required to be an NSE symbol.
 */
function resolveUnderlying(
  doc: GatewayOrderDoc,
  contract: ResolvedContract,
): { underlying: string; underlyingSource: UnderlyingSource } {
  const fromMaster = (contract.underlying ?? '').trim()
  if (fromMaster !== '') return { underlying: fromMaster, underlyingSource: 'master' }
  // `?? ''` is not enough: a document round-tripped through Mongo can hold an
  // explicit null, which is not `undefined` and so survives `??`.
  const fromDoc = typeof doc.underlying === 'string' ? doc.underlying.trim() : ''
  if (fromDoc !== '') return { underlying: fromDoc, underlyingSource: 'order' }
  return { underlying: deriveUnderlying(doc.tradingsymbol), underlyingSource: 'derived' }
}

/**
 * Monthly F&O and futures symbols: `<UNDERLYING><YY><MON><STRIKE><CE|PE>` and
 * `<UNDERLYING><YY><MON>FUT`. The prefix is lazy, so the FIRST position at which
 * a real `26AUG` expiry parses wins — which is what makes `NIFTYNXT5026AUG…`
 * resolve to `NIFTYNXT50` rather than stopping at the first digit.
 */
const MONTHLY_CONTRACT = /^(.+?)\d{2}[A-Z]{3}(?:\d+(?:\.\d+)?(?:CE|PE)|FUT)$/
/**
 * Weekly index symbols: `<UNDERLYING><YY><M><DD><STRIKE><CE|PE>`, where the month
 * is one character (`1`-`9`, then `O`/`N`/`D`).
 */
const WEEKLY_CONTRACT = /^(.+?)\d{2}(?:[1-9]|O|N|D)\d{2}\d+(?:\.\d+)?(?:CE|PE)$/

/**
 * Underlying from an exchange trading symbol. A GUESS — prefer the master.
 *
 * `BHEL26AUG420CE` -> `BHEL`. The previous rule was the leading non-digit run
 * (`/^\D+/`, copied from `xtsOrder.js:101`) and it was wrong twice over:
 *
 *     NIFTYNXT5026AUG30000CE -> 'NIFTYNXT'            (true key NIFTYNXT50)
 *     3MINDIA26AUG28000CE    -> '3MINDIA26AUG28000CE' (no leading letter run)
 *
 * Both miss the freeze table, and a missed lookup means the order is sent
 * UNSPLIT and the exchange rejects it. Stripping the expiry suffix instead gets
 * both right.
 *
 * STILL AMBIGUOUS IN ONE CASE, and it cannot be fixed here: a WEEKLY
 * `NIFTYNXT502580725000CE` parses equally well as `NIFTYNXT` + `50 8 07 25000`,
 * because an underlying is allowed to end in digits and so is an expiry. That is
 * why `ResolvedContract.underlying` exists and why it takes precedence — the
 * instrument master knows the answer and no regex over the symbol can.
 *
 * Returns the symbol unchanged when nothing parses, which yields a freeze miss
 * and therefore a LOUD `freezeUnknown`, rather than a plausible wrong answer.
 */
export function deriveUnderlying(tradingsymbol: string): string {
  const monthly = MONTHLY_CONTRACT.exec(tradingsymbol)
  if (monthly?.[1] !== undefined) return monthly[1]
  const weekly = WEEKLY_CONTRACT.exec(tradingsymbol)
  if (weekly?.[1] !== undefined) return weekly[1]
  return tradingsymbol
}

// ------------------------------------------------------------------ fills

export interface FillRecord {
  readonly clientOrderId: string
  /**
   * The DESK order this tranche belongs to — `clientOrderId` with the `.N`
   * tranche suffix removed, equal to `clientOrderId` for an unsplit order.
   *
   * Stored rather than derived at read time so the aggregation is one indexed
   * equality query. It is also the join key back to `desk-gateway-orders`.
   */
  readonly baseClientOrderId: string
  readonly brokerOrderId: string
  readonly tradingsymbol: string
  readonly status: string
  readonly filledQty: number
  readonly avgPrice: number | null
  readonly rejectReason?: string
  readonly ts: number
  /**
   * The desk order's tag, stamped at write time so `/v1/desk/trades?tag=`
   * can filter per book without a join — a symbol can carry more than one
   * strategy variant, and an untagged row is unattributable between them.
   */
  readonly tag: string
  /**
   * WHICH RAIL THIS FILL IS ON — `'live'` for everything this process placed at
   * a broker, `'paper'` for an engine paper order it worked on the simulator
   * (D14). Read off the order document, never assumed from the process's own
   * broker mode: one gateway can run a paper rehearsal beside a live session.
   */
  readonly mode: 'live' | 'paper'
  /**
   * The DESK LEG this fill belongs to (the Python driver's own leg id), and
   * whether it opened, closed or resized that leg.
   *
   * Both ABSENT rather than empty when the order carries no desk provenance.
   * `translate.reconcile` on the Python side keys on `desk_tag` and skips a
   * row without one — see `toFillRecord` for why that mattered so much.
   */
  readonly desk_tag?: string
  readonly desk_op?: string
  /**
   * The exchange's integer for the contract, as the broker named it on the
   * update. ABSENT when the update carried none — never 0, which a reader
   * would take for a token. `FillWatcher.#fillsFor` judges a row adopted by
   * broker id against the order document's unpacked `instrument_token` with
   * this, because the two spellings of `tradingsymbol` (the master's on the
   * doc, XTS's on the row) can never be compared.
   */
  readonly exchangeToken?: number
  /**
   * WHAT THE FILLS SO FAR COST, cumulative like `filledQty`, venue currency
   * (USD on Delta, fee + GST). From the simulator's fee model on paper, Delta's
   * reported commission on live. OMITTED when nothing says — a missing fee is
   * unknown, never 0.
   */
  readonly fee?: number
}

/**
 * The desk order id a tranche belongs to.
 *
 * `planOrder` suffixes split tranches `.1`, `.2`, … . Note the submit API's own
 * id already contains a `#` (`<coid>#<i>`), which this must not touch — only the
 * LAST `.`-suffix is ours, and only when it is numeric.
 */
export function baseClientOrderId(clientOrderId: string): string {
  const m = /^(.*)\.\d+$/.exec(clientOrderId)
  return m?.[1] ?? clientOrderId
}

/**
 * The exchange's own token off the instrument master's PACKED one.
 *
 * The master is Zerodha-sourced, and Zerodha PACKS its token:
 * `instrument_token = exchange_token * 256 + segment` (TCS26AUG2460CE is
 * 39397890 = 153898*256 + 2). XTS wants the raw exchange token — the legacy
 * system sent the dump's exchange_token column for years — and reports it back
 * as `ExchangeInstrumentID` on every order-book row. Sending the packed value
 * names an instrument that does not exist, which XTS ACKs with an AppOrderID
 * and then voids without an order-history trace: the 2026-08-04 phantom books.
 *
 * ONE RULE, ONE PLACE: the order path (`main.ts` `exchangeInstrumentId`) sends
 * this and the fill path (`fills.ts` `#fillsFor`) compares against it. Two
 * spellings of the division would eventually disagree, and the way they would
 * disagree is that every fill stops matching its own order.
 *
 * 0 for anything that is not a positive number: "unknown", which every reader
 * treats as no evidence rather than as a token.
 */
export function packedToExchangeToken(packed: unknown, tokensPacked: boolean = TOKENS_PACKED): number {
  const n = Number(packed)
  if (!Number.isFinite(n) || n <= 0) return 0
  return tokensPacked ? Math.floor(n / 256) : n
}

/**
 * IS THE INSTRUMENT MASTER'S TOKEN PACKED? Only on NSE, where it is Zerodha's
 * `exchange_token * 256 + segment`. On Delta (`DESK_VENUE=dx`) the token IS
 * the Delta product id — what `DxAdapter` echoes and what the simulator is
 * built to echo (`packedTokens: false`) — so unpacking it would compare 9001
 * against 35 and refuse every fill's attribution. Read once, at import.
 */
const TOKENS_PACKED = venueFromEnv(process.env).id !== 'dx'

/**
 * Fold a broker update into a fill record.
 *
 * `avgPrice` is the BROKER's average, never one we computed. The whole reason
 * the watcher exists is that the bridge's paper marks are an estimate; replacing
 * one estimate with another would make the round trip pointless.
 *
 * `tradingsymbol` is a parameter because `PlacedOrder` does not have to carry
 * one — it is the CONTRACT, and passing the correlation id here (which is what
 * this call site used to do) puts an order id in the symbol column of every row
 * the portal renders, and makes broker fills unjoinable to contracts.
 */
export function toFillRecord(
  update: PlacedOrder,
  tradingsymbol: string,
  nowMs: number,
  ctx: { tag: string; mode: 'live' | 'paper'; deskTag?: string; deskOp?: string },
): FillRecord {
  return {
    clientOrderId: update.clientOrderId,
    baseClientOrderId: baseClientOrderId(update.clientOrderId),
    brokerOrderId: update.brokerOrderId,
    tradingsymbol,
    status: update.status,
    filledQty: update.filledQty,
    avgPrice: update.avgPrice,
    ...(update.rejectReason === undefined ? {} : { rejectReason: update.rejectReason }),
    ts: nowMs,
    tag: ctx.tag,
    mode: ctx.mode,
    /**
     * WHICH DESK LEG THIS FILL BELONGS TO, carried through from the order
     * document — and NOT cosmetic provenance.
     *
     * The Python desk's `translate.reconcile` is the pass that corrects an
     * optimistically-booked entry price, un-books a REJECTED open and resizes
     * a PARTIAL one. It keys every row on `desk_tag` and skips outright when
     * the field is absent (`if tag is None: continue`). It reads these rows
     * through `/v1/desk/trades`, which serves `desk-paper-trade` on paper —
     * written by `rail.ts orderDocument`, which has always carried the field —
     * and `desk-fills` on live.
     *
     * So while this was missing, reconcile was a COMPLETE NO-OP on the live
     * rail: no price correction, no rejected-open un-booking, no partial
     * resize, silently, on the only rail with real money on it. Paper was
     * correct the whole time, which is exactly why it went unnoticed.
     *
     * OMITTED RATHER THAN BLANKED when the order has no desk tag (a manual
     * order on the same account, or one from before this field existed). `''`
     * is a tag that matches no leg; an absent field says "no desk provenance",
     * which is the truth and is what reconcile's `is None` check reads.
     */
    ...(ctx.deskTag === undefined || ctx.deskTag === '' ? {} : { desk_tag: ctx.deskTag }),
    ...(ctx.deskOp === undefined || ctx.deskOp === '' ? {} : { desk_op: ctx.deskOp }),
    // The broker's token, on the same absent-not-zero rule as the fields above.
    ...(update.exchangeToken !== undefined && update.exchangeToken > 0
      ? { exchangeToken: update.exchangeToken }
      : {}),
    ...(update.fee === undefined ? {} : { fee: update.fee }),
  }
}

/**
 * Should this status transition be persisted?
 *
 * Everything except a repeat of what we already hold. Partial fills MUST pass:
 * `smp_order_listener.js:74` filters to FILLED/REJECTED only, so a partially
 * filled 15-lot wing on a thin chain looks like nothing happened until it
 * completes — and on an illiquid stock option it may never complete.
 */
export function isMeaningfulUpdate(
  prev: { status: string; filledQty: number } | undefined,
  next: { status: string; filledQty: number },
): boolean {
  if (prev === undefined) return true
  if (prev.status !== next.status) return true
  return next.filledQty !== prev.filledQty
}

/** Terminal states, after which no further update is expected. */
const TERMINAL = new Set(['FILLED', 'CANCELLED', 'REJECTED', 'EXPIRED'])

export function isTerminalStatus(status: string): boolean {
  return TERMINAL.has(status)
}

export interface TrancheAggregate {
  readonly filledQty: number
  /**
   * Quantity-WEIGHTED average across tranches, or null when nothing filled.
   *
   * 1800 @ 100 and 450 @ 130 is 106, not 130. Taking the last tranche's price —
   * which is what marking the order terminal on each update did — is out by
   * Rs.54,000 on that single 30-lot NIFTY order.
   */
  readonly avgPrice: number | null
  /** Every expected contract has filled. */
  readonly complete: boolean
  readonly rejected: readonly string[]
  /**
   * No further update is coming for ANY tranche: each has a terminal status or
   * never reached the broker at all. Until this is true the desk order is still
   * working, however many tranches have already filled.
   */
  readonly allTerminal: boolean
  /** Tranches with no terminal status yet — the reason `allTerminal` is false. */
  readonly working: readonly string[]
}

/** The tranches one desk order was planned into, and how they ended. */
export interface TrancheSet {
  /** Every tranche `planOrder` produced, placed or not. */
  readonly ids: readonly string[]
  /**
   * Tranches that never reached the broker (placement threw). They are terminal
   * with zero fill: no order update will ever arrive for them, so an order
   * waiting on one would never resolve.
   */
  readonly failed?: readonly string[]
}

/**
 * Reconcile what the desk asked for against what the broker actually did.
 *
 * A tranche split means one desk order maps to N broker orders, so completion
 * is the SUM of their fills — not the state of any one. Reporting the first
 * tranche's FILLED as the order being done understates the position by however
 * many tranches are still working, and if a later tranche is REJECTED it marks
 * the whole order rejected while 24 lots sit live at the broker.
 *
 * `tranches` is what makes `allTerminal` answerable. Without it the best that
 * can be said is "every tranche we have HEARD from is terminal", which is also
 * true when we have heard from one of three.
 */
export function aggregateTranches(
  fills: readonly FillRecord[],
  expectedQty: number,
  tranches?: TrancheSet,
): TrancheAggregate {
  let filledQty = 0
  let notional = 0
  let pricedQty = 0

  /**
   * The FURTHEST-PROGRESSED record per tranche — NOT the last one in the array.
   *
   * One record per tranche is right, and always was: statuses arrive repeatedly
   * as an order progresses and `filledQty` is CUMULATIVE, so summing every
   * message multiply-counts the fill.
   *
   * TAKING THE LAST ONE IS WHAT WAS WRONG. `FillWatcher.#fillsFor` reads with no
   * sort, so "last in the array" is whatever order the storage engine yields —
   * not insertion order, and certainly not chronological. On top of that the
   * broker replays statuses out of sequence, and `isMeaningfulUpdate` only
   * suppresses an exact repeat of the IMMEDIATELY PREVIOUS state, so a 5250
   * arriving after a 7875 is written again quite legitimately.
   *
   * Prod 2026-08-14: one unsplit BHEL order, one AppOrderID, seven rows ending
   * PARTIAL 2625. The aggregate read 2625 of an expected 7875, never reached a
   * terminal state, and the order sat PLACED while the broker held it filled.
   * Two orders were stranded that way, one for three days.
   *
   * Progress is monotonic per tranche, so the greatest `filledQty` IS the
   * furthest along, whatever order the rows arrive in — and a terminal status
   * breaks a tie, so a FILLED beats a PARTIALLY_FILLED reporting the same
   * quantity. Nothing here depends on array order any more.
   */
  const best = new Map<string, FillRecord>()
  for (const f of fills) {
    const cur = best.get(f.clientOrderId)
    if (cur === undefined || f.filledQty > cur.filledQty) {
      best.set(f.clientOrderId, f)
      continue
    }
    if (f.filledQty === cur.filledQty && isTerminalStatus(f.status) && !isTerminalStatus(cur.status)) {
      best.set(f.clientOrderId, f)
    }
  }

  /**
   * REJECTIONS ARE COLLECTED OVER EVERY ROW, not just the chosen one.
   *
   * A REJECTED record carries `filledQty: 0`, so it loses the pick above to any
   * partial fill on the same tranche — correctly, because those contracts ARE
   * on. But the refusal must not be lost with it: without this the tranche
   * would look non-terminal and the order would work forever, and the operator
   * would never be told why the remainder never came.
   */
  const rejectedBy = new Map<string, string>()
  for (const f of fills) {
    if (f.status === 'REJECTED') rejectedBy.set(f.clientOrderId, f.rejectReason ?? f.clientOrderId)
  }
  const rejected = [...rejectedBy.values()]

  for (const f of best.values()) {
    filledQty += f.filledQty
    if (f.avgPrice !== null && f.filledQty > 0) {
      notional += f.avgPrice * f.filledQty
      pricedQty += f.filledQty
    }
  }

  const failed = new Set(tranches?.failed ?? [])
  const expectedIds = tranches?.ids ?? [...best.keys()]
  const working = expectedIds.filter((id) => {
    if (failed.has(id)) return false
    // A rejected tranche is DONE, whatever its best fill row says — see above.
    if (rejectedBy.has(id)) return false
    const f = best.get(id)
    return f === undefined || !isTerminalStatus(f.status)
  })

  return {
    filledQty,
    avgPrice: pricedQty === 0 ? null : notional / pricedQty,
    complete: filledQty >= expectedQty,
    rejected,
    allTerminal: working.length === 0,
    working,
  }
}

/** What the desk order's state should become, or null while it is still working. */
export interface OrderOutcome {
  readonly state: 'FILLED' | 'PARTIAL' | 'REJECTED'
  readonly filledQty: number
  readonly avgPrice: number | null
  readonly reason?: string
}

/**
 * Decide a SPLIT order's terminal state from its tranches.
 *
 * Null means "not terminal yet", and that is the answer that matters: the whole
 * G1 defect is a first tranche's FILLED being taken for the order's. An order is
 * done when every contract asked for has filled, or when nothing more can
 * arrive.
 */
export function decideOrderOutcome(agg: TrancheAggregate, expectedQty: number): OrderOutcome | null {
  if (agg.complete) {
    return { state: 'FILLED', filledQty: agg.filledQty, avgPrice: agg.avgPrice }
  }
  if (!agg.allTerminal) return null
  const reason =
    agg.rejected.length > 0
      ? agg.rejected.join('; ')
      : `only ${agg.filledQty} of ${expectedQty} filled and no tranche is still working`
  // A PARTIAL is NOT a rejection. Calling it one tells the desk it has no
  // position when it has most of one, and flattening against that difference
  // opens a fresh position in the opposite direction.
  return agg.filledQty > 0
    ? { state: 'PARTIAL', filledQty: agg.filledQty, avgPrice: agg.avgPrice, reason }
    : { state: 'REJECTED', filledQty: 0, avgPrice: null, reason }
}
