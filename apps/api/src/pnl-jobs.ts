/**
 * Background P&L work inside the bridge: the ~15s M2M snapshot during market
 * hours, the day-end rollup, and the nightly retention prune — plus the shared
 * computation the HTTP routes call, so a number rendered on a card and the same
 * number written into a rollup can never come from two different code paths.
 *
 * It runs HERE rather than in its own process because `apps/api` already holds
 * the book and the marks for both paper and live (Phase B §4). A second process
 * would have to recompute both, and would drift.
 *
 * TWO THINGS THAT MUST NOT BE UNDONE:
 *
 *  1. Every timer is `unref()`ed. A referenced interval keeps the event loop
 *     alive, so `pm2 restart` waits for a SIGTERM handler that has already run
 *     and then kills the process on its timeout instead — a ten-second stall on
 *     every deploy, and a shutdown that looks hung.
 *
 *  2. BOOT IS NOT GATED ON MARKET HOURS. Only the snapshot tick is. Gating
 *     startup behind a time window is the 2026-07-06 defect
 *     (`strategy-kit/src/base.ts:105`): a restart at 09:15:30 came up asleep and
 *     stayed asleep for the session. `startPnlJobs` always starts, always
 *     schedules, and each tick decides for itself.
 */

import { buildPositions, type Costs, type Marks } from '@algomaker/pnl'
import { fixedClock, isMarketOpen } from '@algomaker/core'
import type { DeskMode } from './contract.ts'
import type { ExitQuote, ExitSide, MarkBasis, QuoteCache } from './marks.ts'
import { istDate, istDayRange, type ApiDeps } from './routes/kit.ts'
import { PnlStore, pnlKey, splitPnlKey, type FillLoad, type PnlSnapshot } from './pnlstore.ts'
import {
  buildDailyReport,
  computeWindowPnl,
  inTradingSession,
  istMinutesOfDay,
  planPrune,
  splitFills,
  symbolsIn,
  type DailyReport,
  type MarkedLeg,
  type PnlWindow,
  type PruneDecision,
  type StampedFill,
} from './rollup.ts'

const DAY_MS = 24 * 60 * 60 * 1000
const MODES: readonly DeskMode[] = ['paper', 'live']

/**
 * Everything the P&L path can be reconfigured with.
 *
 * `marks` and `costs` are injectable because both are policy, not mechanism:
 * costs are B3's explicit optional input (defaulting to zero, so we report
 * GROSS), and the mark resolver is what a test substitutes for a live feed.
 */
/**
 * Fills the `Marks` map for one row build.
 *
 * `exits` names, per open symbol, the ORDER side that would close its net
 * position — `Sell` for a long (value at bid), `Buy` for a short (value at
 * ask). A symbol absent from `exits` is flat and needs no mark. Injected
 * fakes that ignore `exits` remain valid resolvers.
 */
export type MarkResolver = (symbols: readonly string[], exits: ReadonlyMap<string, ExitSide>) => Marks

/**
 * The pair a leg's mark came from, for display: "6.75 / 6.85, valued at the
 * ask, frame from 14:22". `basis` names which side priced the mark; `asOf` is
 * the book frame's own time, so the client can say how old the book is.
 */
export interface LegQuote {
  readonly bid: number
  readonly ask: number
  readonly basis: MarkBasis
  readonly asOf: number
}

/** Fills the per-symbol quote block the same way `MarkResolver` fills marks. */
export type QuoteResolver = (
  symbols: readonly string[],
  exits: ReadonlyMap<string, ExitSide>,
) => Readonly<Record<string, LegQuote>>

export interface PnlOptions {
  /** Marks by tradingsymbol. A symbol left out is UNPRICED, never zero. */
  readonly marks?: MarkResolver
  /** Quote pairs by tradingsymbol, for display beside the marks. */
  readonly quotes?: QuoteResolver
  /**
   * Charges to subtract, per strategy. Absent means zero and the number is
   * GROSS (B3) — the Python desk owns its own net via its `CostModel`, and a
   * second cost model applied silently here would make our figure and theirs
   * disagree for reasons neither side could explain.
   */
  readonly costs?: (tag: string, mode: DeskMode) => Costs | undefined
  /**
   * How far back to read fills when rebuilding a position. Must comfortably
   * exceed how long a book is carried: a leg opened before this window is
   * invisible, so its buy-back would look like opening a fresh long.
   */
  readonly lookbackDays?: number
  /**
   * How many decisions one fill read may pull, i.e. how much memory a tick may
   * cost. Defaults to `PnlStore`'s own cap.
   *
   * Policy, like `lookbackDays` beside it: the right number depends on how busy
   * the desk is and on the box it runs on. Whatever it is set to, hitting it
   * comes back as `PnlSummary.truncated` rather than as a quietly smaller
   * answer.
   */
  readonly fillLimit?: number
  /** Snapshot retention (B5). Rollups are kept forever. */
  readonly keepDays?: number
  readonly snapshotIntervalMs?: number
  /** IST minute-of-day after which the day's rollup may be written. */
  readonly rollupAfterIstMinutes?: number
  /** IST minute-of-day after which the nightly prune may run. */
  readonly pruneAfterIstMinutes?: number
  /** Days of missed rollups to repair at boot. */
  readonly repairDays?: number
}

/** One strategy's live P&L, exactly as API contract §3 fixes the shape. */
export interface PnlRow {
  readonly tag: string
  readonly label: string
  readonly mode: DeskMode
  readonly realised: number
  readonly unrealised: number | null
  readonly total: number | null
  /**
   * The BOOK-STATE figure for a tag that has a desk book: open legs marked
   * against their stored entries plus the book's realised-to-date — the same
   * number the book page's tile and table foot show (operator's call
   * 2026-08-18: one P&L per stock book, everywhere). ABSENT for hosted tags
   * (their journal rollup IS their truth); null when any open leg is
   * unpriced. Enriched by `routes/pnl.ts`, not computed here: the rollup is a
   * pure journal fold and must stay one.
   */
  readonly sinceEntry?: number | null
  readonly openLegs: number
  /**
   * The legs `openLegs` counted, marked. THE positions source for a hosted
   * strategy — see `computeWindowPnl`'s note. Carried here rather than behind
   * its own endpoint so the count and the table can never disagree, and so the
   * dashboard makes no second request for something this tick already netted.
   */
  readonly legs: readonly MarkedLeg[]
  /**
   * The pair each marked leg was valued off, keyed by tradingsymbol. Absent
   * for a leg whose book could not answer — exactly the legs `unpriced` names.
   */
  readonly quotes?: Readonly<Record<string, LegQuote>>
  readonly unpriced: readonly string[]
  readonly complete: boolean
}

export interface PnlSummary {
  readonly asOf: number
  readonly mode: DeskMode
  readonly strategies: readonly PnlRow[]
  readonly totals: {
    readonly realised: number
    readonly unrealised: number | null
    readonly total: number | null
    readonly complete: boolean
  }
  /**
   * True when the fill read hit its cap, so these figures were computed from a
   * SUBSET of the window's decisions.
   *
   * Surfaced rather than absorbed for the same reason `unpriced` is: every
   * number below it is then understated by an unknown amount, and an
   * understated P&L that looks confident is worse than one that admits it.
   */
  readonly truncated: boolean
}

export function lookbackDaysOf(opts: PnlOptions): number {
  return opts.lookbackDays ?? numberFromEnv('DESK_PNL_LOOKBACK_DAYS', 30)
}

export function keepDaysOf(opts: PnlOptions): number {
  return opts.keepDays ?? numberFromEnv('DESK_PNL_KEEP_DAYS', 30)
}

/**
 * `exitQuote` while the session is open, `displayExitQuote` once it has
 * closed. One function so the mark and the pair shown beside it can never be
 * read off two different rules — the same reason `defaultQuoteResolver`
 * exists at all.
 */
function exitReadFor(deps: ApiDeps, cache: QuoteCache): (token: number, exit: ExitSide) => ExitQuote | null {
  const sessionOpen = isMarketOpen(fixedClock(deps.now()))
  return sessionOpen
    ? (token, exit) => cache.exitQuote(token, exit)
    : (token, exit) => cache.displayExitQuote(token, exit)
}

/**
 * The valuation read, chosen by whether the SESSION is open — not by whether
 * the feed happens to be alive.
 *
 * DELIBERATELY NOT `displayMark()`, ever. LTP never substitutes for a book
 * side: that is the BHEL +25k rule (2026-08-21) and nothing here relaxes it.
 *
 * INSIDE THE SESSION, `exitQuote` — feed-gated. A dead feed during market
 * hours means the price is genuinely unknown, and marking a position at a
 * stale frame while calling the result "today's P&L" is exactly the
 * frozen-price failure `marks.ts` was rewritten to prevent. The legs come back
 * UNPRICED and the row says so.
 *
 * AFTER THE CLOSE, `displayExitQuote` — the same book-side rule, down to the
 * persisted pair. The feed is SUPPOSED to be dead at 16:00; treating that as
 * "unknown" made every open leg on the desk unpriced every single evening. On
 * prod 2026-09-07 at 18:52 IST all three MIRROR_* tags and all four relief-r
 * stock books reported `total: null` with every leg badged `no mark` — while
 * the close pairs for those exact tokens sat in `desk-marks` (BANKNIFTY 57900
 * CE 400/408.65, NIFTY 24050 CE 8.80/8.85, …) and the Positions page rendered
 * them fine off this very method. Two pages disagreeing about one book.
 *
 * At the close the last two-sided frame IS the valuation — that is what EOD
 * MTM means. It is not passed off as live: the fallback stamps
 * `basis: 'snapshot'` and `stale: true`, which `defaultQuoteResolver` carries
 * to the wire beside the number.
 */
export function defaultMarkResolver(deps: ApiDeps): MarkResolver {
  return (symbols, exits) => {
    const out: Record<string, number> = {}
    const cache = deps.marks
    if (cache === undefined) return out
    const read = exitReadFor(deps, cache)
    const master = deps.master.current()
    for (const symbol of symbols) {
      const token = master.resolveSymbol(symbol)?.instrumentToken
      if (token === undefined) continue
      /**
       * The EXIT side of the net open position — long values at bid, short at
       * ask, and LTP never substitutes (`exitQuote`). A symbol with no open
       * qty needs no mark: `markOpenLegs` only values qty != 0, so it is
       * simply not resolved rather than priced at a side it does not have.
       */
      const exit = exits.get(symbol)
      if (exit === undefined) continue
      const q = read(token, exit)
      if (q !== null && Number.isFinite(q.price) && q.price >= 0) out[symbol] = q.price
    }
    return out
  }
}

/**
 * The quote pairs behind `defaultMarkResolver`'s prices — one read, one
 * moment: both come off the same `exitQuote` frame, so the mark and the pair
 * shown beside it can never describe two different books.
 */
export function defaultQuoteResolver(deps: ApiDeps): QuoteResolver {
  return (symbols, exits) => {
    const out: Record<string, LegQuote> = {}
    const cache = deps.marks
    if (cache === undefined) return out
    const read = exitReadFor(deps, cache)
    const master = deps.master.current()
    for (const symbol of symbols) {
      const token = master.resolveSymbol(symbol)?.instrumentToken
      const exit = exits.get(symbol)
      if (token === undefined || exit === undefined) continue
      const q = read(token, exit)
      if (q !== null) out[symbol] = { bid: q.bid, ask: q.ask, basis: q.basis, asOf: q.asOf }
    }
    return out
  }
}

export function quoteResolverFor(deps: ApiDeps, opts: PnlOptions): QuoteResolver {
  return opts.quotes ?? defaultQuoteResolver(deps)
}

/**
 * Per open symbol, the ORDER side that would close its net position over this
 * window — the exact position `markOpenLegs` is about to value.
 */
export function exitSidesOf(w: PnlWindow): ReadonlyMap<string, ExitSide> {
  const out = new Map<string, ExitSide>()
  for (const p of buildPositions([...w.carried, ...w.during])) {
    if (p.qty !== 0) out.set(p.tradingsymbol, p.qty > 0 ? 'Sell' : 'Buy')
  }
  return out
}

/**
 * The mark resolver in force: the injected one, or the live quote cache.
 *
 * Exported for `LiveBook`, whose tick path prices one strategy without going
 * anywhere near this module's Mongo reads. It must be the SAME resolver the REST
 * path uses, or a pushed figure and a polled one would disagree about whether a
 * leg is priced.
 */
export function markResolverFor(deps: ApiDeps, opts: PnlOptions): MarkResolver {
  return opts.marks ?? defaultMarkResolver(deps)
}

function resolverOf(deps: ApiDeps, opts: PnlOptions): MarkResolver {
  return markResolverFor(deps, opts)
}

// ------------------------------------------------------------------ live P&L

/**
 * Every strategy's P&L for the current IST trading day, in one mode.
 *
 * The window is TODAY, but the positions are built from the whole lookback:
 * see the header of `rollup.ts` for why a carried book cannot be priced from
 * today's fills alone.
 *
 * A tag with fills but no registry row is still reported, labelled with its own
 * tag. Dropping it would hide a book that is trading; the registry is how a
 * strategy is CONTROLLED, not how its P&L is discovered.
 */
export async function livePnl(
  deps: ApiDeps,
  store: PnlStore,
  opts: PnlOptions,
  mode: DeskMode,
  nowMs: number,
): Promise<PnlSummary> {
  const { from } = istDayRange(istDate(nowMs))
  const load = await store.loadFills({
    from: from - lookbackDaysOf(opts) * DAY_MS,
    // Exclusive upper bound, so a fill stamped exactly now is still included.
    to: nowMs + 1,
    mode,
    ...(opts.fillLimit === undefined ? {} : { limit: opts.fillLimit }),
  })
  return await pnlFromFills(deps, opts, mode, nowMs, from, load)
}

/**
 * Everything `livePnl` does AFTER the fills are in hand.
 *
 * Split out so `LiveBook` can serve the same answer from memory by calling this
 * with fills it already holds. THE POINT IS THAT THERE IS ONE IMPLEMENTATION:
 * the carried-realised subtraction per leg, the qty-0-only-if-it-traded-in-the-
 * window rule, `openLegs` counting only qty != 0, and null-never-zero for an
 * unmarked leg are arithmetic that cost a live bug to get right (`439fa6f5`).
 * A pushed figure and a polled one disagreeing about one tag is the failure this
 * seam exists to make impossible.
 *
 * `boundary` is passed rather than recomputed so the caller's window and this
 * one cannot drift across an IST midnight.
 */
export async function pnlFromFills(
  deps: ApiDeps,
  opts: PnlOptions,
  mode: DeskMode,
  nowMs: number,
  boundary: number,
  load: FillLoad,
): Promise<PnlSummary> {
  const from = boundary
  const bad = malformedByTag(load.malformed)
  const marksOf = resolverOf(deps, opts)
  const quotesOf = quoteResolverFor(deps, opts)

  const registry = await deps.store.listStrategies()
  const labels = new Map(registry.map((r) => [r.tag, r.label === '' ? r.tag : r.label]))
  const tags = new Set<string>(registry.map((r) => r.tag))
  /**
   * ONLY THIS MODE'S KEYS. `livePnl`'s own read is already scoped by mode, but
   * `LiveBook` holds both rails in one map — and a tag that has only ever traded
   * LIVE must not appear as a confident flat ₹0 row under the PAPER badge. The
   * filter is what keeps the two callers producing the same list.
   */
  for (const key of load.byKey.keys()) {
    const split = splitPnlKey(key)
    if (split.mode === mode) tags.add(split.tag)
  }

  const strategies: PnlRow[] = []
  for (const tag of [...tags].sort()) {
    const fills = load.byKey.get(pnlKey(tag, mode)) ?? []
    strategies.push(
      pnlRowFor({
        tag,
        label: labels.get(tag) ?? tag,
        mode,
        fills,
        boundary: from,
        marksOf,
        quotesOf,
        malformed: bad.get(tag) ?? [],
        ...withCosts(opts.costs?.(tag, mode)),
      }),
    )
  }

  // A book total is only as good as its worst leg: one unmarked strategy makes
  // the desk total unknown, not "the sum of the ones that happened to price".
  // A truncated READ has the same standing — the missing fills are missing
  // money, so the total is unknown rather than optimistic.
  let realised = 0
  let unrealisedSum = 0
  let complete = !load.truncated
  for (const s of strategies) {
    realised += s.realised
    if (s.unrealised === null) complete = false
    else unrealisedSum += s.unrealised
  }

  return {
    asOf: nowMs,
    mode,
    strategies,
    totals: {
      realised,
      unrealised: complete ? unrealisedSum : null,
      total: complete ? realised + unrealisedSum : null,
      complete,
    },
    truncated: load.truncated,
  }
}

/**
 * One strategy's row. Exported for `LiveBook`, which prices a SINGLE tag on a
 * tick and must not rebuild the whole desk — and must not use a second copy of
 * this arithmetic to do it.
 */
export function pnlRowFor(input: {
  tag: string
  label: string
  mode: DeskMode
  fills: readonly StampedFill[]
  boundary: number
  marksOf: MarkResolver
  quotesOf?: QuoteResolver
  malformed: readonly string[]
  costs?: Costs
}): PnlRow {
  const window = splitFills(input.fills, input.boundary)
  const symbols = symbolsIn(window)
  const exits = exitSidesOf(window)
  const marks = input.marksOf(symbols, exits)
  const quotes = input.quotesOf?.(symbols, exits)
  const pnl = computeWindowPnl(window, marks, input.costs)
  /**
   * A fill we could not read counts as UNPRICED, not as absent.
   *
   * It is the same failure in a different place: a contract whose contribution
   * is missing from the figure. Routing it through `unpriced` means one rule
   * nulls the number — a book with a corrupt fill can never render as a
   * confident ₹0.
   */
  const unpriced = [...pnl.unpriced, ...input.malformed]
  const complete = unpriced.length === 0
  return {
    tag: input.tag,
    label: input.label,
    mode: input.mode,
    realised: pnl.realised,
    unrealised: complete ? pnl.unrealised : null,
    total: complete ? pnl.total : null,
    openLegs: pnl.openLegs,
    legs: pnl.legs,
    ...(quotes === undefined ? {} : { quotes }),
    unpriced,
    complete,
  }
}

/**
 * The P&L for one mode, from the in-memory book when there is a loaded one and
 * from Mongo when there is not.
 *
 * THE FALLBACK IS NOT A FORMALITY. `LiveBook.ready` is false until its first
 * journal read succeeds, and an empty in-memory book served as "no positions"
 * would be the same class of defect as a confident ₹0 for an unmarked leg. Every
 * REST endpoint therefore keeps working exactly as it did with no book attached
 * at all — which is also the state every existing test runs in.
 *
 * `opts` is used only on the Mongo path: the book owns the options it was
 * constructed with, so that the answer cannot depend on which caller asked.
 */
export async function pnlFor(
  deps: ApiDeps,
  store: PnlStore,
  opts: PnlOptions,
  mode: DeskMode,
  nowMs: number,
): Promise<PnlSummary> {
  const book = deps.book
  if (book !== undefined && book.ready) return await book.summary(mode, nowMs)
  return await livePnl(deps, store, opts, mode, nowMs)
}

function malformedByTag(entries: readonly string[]): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const e of entries) {
    const at = e.indexOf(':')
    const tag = at === -1 ? e : e.slice(0, at)
    const symbol = at === -1 ? '<unreadable fill>' : e.slice(at + 1)
    const list = out.get(tag)
    if (list === undefined) out.set(tag, [symbol])
    else list.push(symbol)
  }
  return out
}

// ----------------------------------------------------------------- snapshots

/**
 * One M2M tick: a persisted point per strategy that has traded inside the
 * lookback window.
 *
 * Idle registry rows are skipped deliberately. A strategy that has never traded
 * would otherwise contribute ~1,500 identical zero rows a day to a collection
 * whose whole retention design (Phase B §6) is about volume.
 */
export async function snapshotOnce(
  deps: ApiDeps,
  store: PnlStore,
  opts: PnlOptions,
  nowMs: number,
): Promise<PnlSnapshot[]> {
  const rows: PnlSnapshot[] = []
  for (const mode of MODES) {
    // Through the same seam the card reads, so the 15s series and the figure on
    // screen can never come from two different books — the property the header
    // of this file exists to protect. It also takes the two 30-day scans this
    // tick used to make off the database entirely once the book is loaded.
    const summary = await pnlFor(deps, store, opts, mode, nowMs)
    for (const s of summary.strategies) {
      // Nothing booked and nothing open: there is no series to draw.
      if (s.realised === 0 && s.openLegs === 0 && s.unpriced.length === 0) continue
      rows.push({
        tag: s.tag,
        mode,
        ts: nowMs,
        realised: s.realised,
        unrealised: s.unrealised,
        total: s.total,
      })
    }
  }
  await store.writeSnapshots(rows)
  return rows
}

// ------------------------------------------------------------- daily rollup

/**
 * Rebuild every strategy's rollup for one IST day.
 *
 * MARKS ARE ONLY USED FOR TODAY. Recomputing last Tuesday's report must not
 * mark last Tuesday's closing book at this afternoon's prices — that would
 * invent a number that was never true and, worse, one that changes every time
 * the report is opened. For a past day the mark component can only come from
 * that day's own snapshots, which is what `buildDailyReport` falls back to.
 */
export async function rollupDate(
  deps: ApiDeps,
  store: PnlStore,
  opts: PnlOptions,
  date: string,
  nowMs: number,
): Promise<DailyReport[]> {
  const { from, to } = istDayRange(date)
  const load = await store.loadFills({
    from: from - lookbackDaysOf(opts) * DAY_MS,
    to,
    ...(opts.fillLimit === undefined ? {} : { limit: opts.fillLimit }),
  })
  const series = await store.seriesByKey(date)
  const marksOf = date === istDate(nowMs) ? resolverOf(deps, opts) : () => ({})

  const keys = new Set<string>(series.keys())
  for (const [key, fills] of load.byKey) {
    // Fills entirely before the day are carry, not activity. A key with only
    // carry and no snapshots had no day to report.
    if (fills.some((f) => f.ts >= from)) keys.add(key)
  }

  const out: DailyReport[] = []
  for (const key of [...keys].sort()) {
    const { tag, mode } = splitPnlKey(key)
    const window = splitFills(load.byKey.get(key) ?? [], from)
    out.push(
      buildDailyReport({
        date,
        tag,
        mode,
        window,
        marks: marksOf(symbolsIn(window), exitSidesOf(window)),
        series: series.get(key) ?? [],
        writtenAt: nowMs,
        ...withCosts(opts.costs?.(tag, mode)),
      }),
    )
  }
  return out
}

/** `exactOptionalPropertyTypes`: an explicit `undefined` is not the same as absent. */
function withCosts(costs: Costs | undefined): { costs?: Costs } {
  return costs === undefined ? {} : { costs }
}

export async function writeRollups(
  deps: ApiDeps,
  store: PnlStore,
  opts: PnlOptions,
  date: string,
  nowMs: number,
): Promise<DailyReport[]> {
  const reports = await rollupDate(deps, store, opts, date, nowMs)
  for (const r of reports) await store.writeReport(r)
  return reports
}

/**
 * Fill in rollups for recent days that have none.
 *
 * Runs at BOOT, which is the point: a rollup missed because the process was
 * down between 15:30 and midnight is repairable, not a permanent hole (Phase B
 * §5). Without this the prune would correctly refuse to ever clean that day —
 * safe, but the snapshots would accumulate forever and nobody would know why.
 *
 * Only writes what is missing. Rewriting a day that was already summarised
 * would restamp `writtenAt` on every restart and destroy the one clue about
 * when a figure was actually produced.
 */
export async function repairRollups(
  deps: ApiDeps,
  store: PnlStore,
  opts: PnlOptions,
  nowMs: number,
): Promise<string[]> {
  const days = opts.repairDays ?? numberFromEnv('DESK_PNL_REPAIR_DAYS', 7)
  const repaired: string[] = []
  for (let back = 1; back <= days; back++) {
    const date = istDate(nowMs - back * DAY_MS)
    const have = await store.rolledUpKeys(date)
    const reports = await rollupDate(deps, store, opts, date, nowMs)
    let wrote = 0
    for (const r of reports) {
      if (have.has(pnlKey(r.tag, r.mode))) continue
      await store.writeReport(r)
      wrote++
    }
    if (wrote > 0) repaired.push(`${date} (${wrote})`)
  }
  return repaired
}

// ------------------------------------------------------------------- prune

export interface PruneResult {
  readonly deleted: number
  readonly days: readonly PruneDecision[]
}

/**
 * Delete snapshots older than the retention window — but only for days that
 * have already been summarised.
 *
 * `dryRun` MUTATES NOTHING. It is the portal's "preview what would go" (Phase B
 * §6), and a preview that deleted anything would be the worst possible bug in
 * this file.
 */
export async function runPrune(
  store: PnlStore,
  input: { nowMs: number; keepDays: number; dryRun: boolean },
): Promise<PruneResult> {
  const candidates = await store.pruneCandidates(input.nowMs, input.keepDays)
  const activity = []
  for (const date of candidates) {
    const { from, to } = istDayRange(date)
    const [snapshots, snapKeys, rolled, traded] = await Promise.all([
      store.countSnapshots(date),
      store.snapshotKeys(date),
      store.rolledUpKeys(date),
      store.loadFills({ from, to }),
    ])
    const active = new Set(snapKeys)
    for (const key of traded.byKey.keys()) active.add(key)
    activity.push({
      date,
      snapshots,
      active: [...active].sort(),
      rolledUp: [...rolled].sort(),
    })
  }

  const days = planPrune(activity)
  if (input.dryRun) {
    return { deleted: days.reduce((n, d) => n + (d.action === 'delete' ? d.snapshots : 0), 0), days }
  }
  let deleted = 0
  for (const d of days) {
    if (d.action !== 'delete') continue
    await store.deleteSnapshots(d.date)
    deleted += d.snapshots
  }
  return { deleted, days }
}

// -------------------------------------------------------------- the runner

/**
 * Start the background jobs. Returns a stop function.
 *
 * Nothing here awaits anything at call time: `main.ts` calls this on the boot
 * path, and a P&L job that made startup depend on a Mongo round trip would stop
 * the API serving positions during exactly the outage someone opened it to look
 * at.
 */
export function startPnlJobs(deps: ApiDeps, opts: PnlOptions = {}): () => void {
  const store = new PnlStore(deps.db)
  const intervalMs = opts.snapshotIntervalMs ?? numberFromEnv('DESK_PNL_SNAPSHOT_MS', 15_000)
  const rollupAfter = opts.rollupAfterIstMinutes ?? 15 * 60 + 40
  const pruneAfter = opts.pruneAfterIstMinutes ?? 60 + 30
  const keepDays = keepDaysOf(opts)

  let stopped = false
  let snapshotting = false
  let housekeeping = false
  let rolledUpFor = ''
  let prunedFor = ''

  const fail = (what: string, err: unknown): void => {
    // Swallowed on purpose: an unhandled rejection inside a timer takes the
    // whole bridge down, and losing one 15-second P&L point must never cost the
    // order path its process.
    deps.log(`pnl job failed: ${what}`, { error: err instanceof Error ? err.message : String(err) })
  }

  const snapshot = setInterval(() => {
    if (stopped || snapshotting) return
    const now = deps.now()
    // The TICK is gated on market hours, never the job's existence. See header.
    if (!inTradingSession(now)) return
    snapshotting = true
    void snapshotOnce(deps, store, opts, now)
      .catch((err: unknown) => fail('snapshot', err))
      .finally(() => {
        snapshotting = false
      })
  }, intervalMs)
  snapshot.unref()

  const daily = setInterval(() => {
    if (stopped || housekeeping) return
    const now = deps.now()
    const today = istDate(now)
    const minutes = istMinutesOfDay(now)
    const needsRollup = minutes >= rollupAfter && rolledUpFor !== today
    // The prune's own day: it runs after midnight, so it is "yesterday's"
    // housekeeping and is tracked against the calendar day it runs on.
    const needsPrune = minutes >= pruneAfter && prunedFor !== today
    if (!needsRollup && !needsPrune) return
    housekeeping = true
    void (async () => {
      if (needsRollup) {
        const reports = await writeRollups(deps, store, opts, today, now)
        rolledUpFor = today
        deps.log('daily P&L rollup written', { date: today, strategies: reports.length })
      }
      if (needsPrune) {
        const result = await runPrune(store, { nowMs: now, keepDays, dryRun: false })
        prunedFor = today
        const skipped = result.days.filter((d) => d.action === 'skip')
        deps.log('snapshot prune complete', {
          deleted: result.deleted,
          skipped: skipped.length,
          // Named, not counted: a day skipped forever is a day whose rollup
          // never ran, and silence about it is how it stays that way.
          reasons: skipped.map((d) => `${d.date}: ${d.reason}`),
        })
      }
    })()
      .catch((err: unknown) => fail('daily housekeeping', err))
      .finally(() => {
        housekeeping = false
      })
  }, 60_000)
  daily.unref()

  // Indexes and the boot repair are deferred rather than awaited, so neither
  // can delay the port opening.
  const boot = setTimeout(() => {
    void (async () => {
      await store.ensureIndexes()
      const repaired = await repairRollups(deps, store, opts, deps.now())
      if (repaired.length > 0) deps.log('repaired missing P&L rollups', { days: repaired })
    })().catch((err: unknown) => fail('boot repair', err))
  }, 5_000)
  boot.unref()

  return (): void => {
    stopped = true
    clearInterval(snapshot)
    clearInterval(daily)
    clearTimeout(boot)
  }
}

function numberFromEnv(name: string, fallback: number): number {
  const raw = Number(process.env[name] ?? fallback)
  return Number.isFinite(raw) && raw > 0 ? raw : fallback
}
