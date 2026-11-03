/**
 * In-memory port implementations + the golden-master replay harness.
 *
 * THE POINT: porting 15 strategies by hand is only safe if "did it change
 * behaviour?" is a test rather than a judgement. `replay()` drives a strategy
 * over a recorded tick sequence with a synthetic clock and records every order it
 * emits; `diffIntents()` compares that against the legacy file's recorded output.
 * If the sequences match, the port is faithful.
 *
 * Scope: port verification ONLY. This is deliberately not a backtester — a
 * research / P&L backtesting tool was declined by the owner on 2026-07-25. Do not
 * grow this into one (no equity curves, no P&L aggregation, no parameter sweeps).
 *
 * This is only possible because every port is injected — with ambient time and a
 * self-constructed websocket (the legacy shape) none of it could be driven.
 */

import { fixedClock, makeId } from '@algomaker/core'
import { OptionMaster, type InstrumentRow } from '@algomaker/instruments'
import { selectOption as selectFromChain } from '@algomaker/marketdata-core'
import type {
  Candle,
  Clock,
  Fill,
  Interval,
  InstrumentRef,
  Logger,
  MarketData,
  OrderGateway,
  Quote,
  SelectCriteria,
  Selection,
  StateStore,
  StrategyContext,
  SubmitRequest,
  SubmitResult,
  FillStream,
} from './ports.ts'
import type { StrategyBase } from './base.ts'
import { occurrencesBetween } from './schedule.ts'

/** An order as recorded for comparison. Deliberately excludes ids/timestamps. */
export interface RecordedOrder {
  readonly symbol: string
  readonly side: 'BUY' | 'SELL'
  readonly lots: number
  readonly orderType: string
  readonly limitPrice?: number
  readonly triggerPrice?: number
}

/**
 * The expiry `setOption()` files a contract under when none is given.
 *
 * Most tests do not care which expiry they are on — they care that a strike
 * resolves. A single documented constant keeps those tests unchanged while still
 * letting `selectOption` walk a REAL chain keyed by (underlying, expiry), which
 * is the only way the fake can reproduce the listed-grid behaviour it is
 * standing in for. Deliberately a Thursday in the week the fixtures use.
 */
export const DEFAULT_TEST_EXPIRY = '2026-07-30'

export class FakeMarketData implements MarketData {
  readonly #quotes = new Map<number, Quote>()
  readonly #candles = new Map<string, Candle[]>()
  readonly #options = new Map<string, InstrumentRef>()
  /** Every registered leg, in registration order — the source for `#master()`. */
  readonly #optionRows: InstrumentRow[] = []
  /** Rebuilt lazily; invalidated by `setOption` so a late leg is never missed. */
  #masterCache: OptionMaster | null = null
  readonly #futures = new Map<string, InstrumentRef>()
  readonly #spotTokens = new Map<string, number>()
  readonly #strikeSteps = new Map<string, number>()
  /**
   * Valuation time for delta selection. Injected, never `Date.now()` — a fake
   * that read the wall clock would make delta selection non-reproducible and the
   * golden tests would flap by the day.
   */
  #clock: Clock | null = null

  setQuote(q: Quote): void {
    this.#quotes.set(q.token, q)
  }

  /** Wired by `makeTestContext` so `selectOption` values against the test clock. */
  useClock(clock: Clock): void {
    this.#clock = clock
  }

  setCandles(token: number, interval: Interval, candles: Candle[]): void {
    this.#candles.set(`${token}:${interval}`, candles)
  }

  setUnderlying(symbol: string, spotToken: number, strikeStep: number): void {
    this.#spotTokens.set(symbol, spotToken)
    this.#strikeSteps.set(symbol, strikeStep)
  }

  setOption(
    underlying: string,
    strike: number,
    type: 'CE' | 'PE',
    inst: InstrumentRef,
    expiry: string = DEFAULT_TEST_EXPIRY,
  ): void {
    this.#options.set(`${underlying}:${strike}:${type}`, inst)
    this.#optionRows.push({
      instrument_token: inst.instrumentToken ?? 0,
      tradingsymbol: inst.tradingsymbol,
      name: underlying,
      expiry,
      strike,
      tick_size: inst.tickSize,
      lot_size: inst.lotSize,
      instrument_type: type,
      segment: 'NFO-OPT',
      exchange: inst.exchange,
    })
    this.#masterCache = null
  }

  setFuture(underlying: string, inst: InstrumentRef): void {
    this.#futures.set(underlying, inst)
  }

  quote(token: number): Quote | null {
    return this.#quotes.get(token) ?? null
  }

  async candles(token: number, interval: Interval, count: number): Promise<readonly Candle[]> {
    const all = this.#candles.get(`${token}:${interval}`) ?? []
    return all.slice(-count)
  }

  option(underlying: string, strike: number, type: 'CE' | 'PE'): InstrumentRef | null {
    return this.#options.get(`${underlying}:${strike}:${type}`) ?? null
  }

  /**
   * Selection over the registered legs, run through the REAL
   * `marketdata-core/selector.ts` on a REAL `OptionMaster`.
   *
   * Reimplementing the selection rules here would make the fake a second
   * authority that can agree with the port while disagreeing with production —
   * i.e. a test that passes for the wrong reason. Marks come from whatever
   * quotes the test has set, so a delta or premium request with no quotes
   * correctly answers `null` rather than inventing one.
   */
  selectOption(underlying: string, expiry: string, criteria: SelectCriteria): Selection | null {
    const spotToken = this.#spotTokens.get(underlying)
    const spot = spotToken === undefined ? undefined : this.#quotes.get(spotToken)?.lastPrice
    if (spot === undefined) return null
    const marks = new Map<number, number>()
    for (const [token, q] of this.#quotes) marks.set(token, q.lastPrice)
    return selectFromChain(
      {
        master: this.#master(),
        underlying,
        expiry,
        spot,
        marks,
        nowMs: this.#clock?.now() ?? 0,
      },
      criteria,
    )
  }

  #master(): OptionMaster {
    this.#masterCache ??= new OptionMaster(this.#optionRows)
    return this.#masterCache
  }

  future(underlying: string): InstrumentRef | null {
    return this.#futures.get(underlying) ?? null
  }

  atmStrike(underlying: string, spotPrice: number): number {
    const step = this.#strikeSteps.get(underlying) ?? 50
    return Math.round(spotPrice / step) * step
  }

  spotToken(underlying: string): number {
    const t = this.#spotTokens.get(underlying)
    if (t === undefined) throw new Error(`FakeMarketData: no spot token for '${underlying}'`)
    return t
  }
}

/** Records every submitted order and can auto-fill them. */
export class RecordingGateway implements OrderGateway {
  readonly orders: RecordedOrder[] = []
  readonly submitted: { clientOrderId: string; req: SubmitRequest }[] = []
  readonly cancelled: string[] = []
  readonly flattens: string[] = []
  /** Set false to simulate a broker rejecting everything. */
  accept = true
  /** When set, submit() immediately emits a fill at this price. */
  autoFillPrice: number | null = null
  #fillHandlers: ((f: Fill) => void)[] = []
  #seq = 0

  async submit(req: SubmitRequest): Promise<SubmitResult> {
    if (!this.accept) return { accepted: false, clientOrderId: null, reason: 'rejected by test' }
    this.#seq++
    const clientOrderId = `test-coid-${this.#seq}`
    this.orders.push({
      symbol: req.instrument.tradingsymbol,
      side: req.side,
      lots: req.lots,
      orderType: req.orderType ?? 'MARKET',
      ...(req.limitPrice === undefined ? {} : { limitPrice: req.limitPrice }),
      ...(req.triggerPrice === undefined ? {} : { triggerPrice: req.triggerPrice }),
    })
    this.submitted.push({ clientOrderId, req })

    if (this.autoFillPrice !== null) {
      const fill: Fill = {
        clientOrderId,
        instrument: req.instrument,
        side: req.side,
        filledQty: req.instrument.lotSize * req.lots,
        avgPrice: this.autoFillPrice,
        ts: 0,
      }
      for (const h of [...this.#fillHandlers]) h(fill)
    }
    return { accepted: true, clientOrderId }
  }

  async cancel(clientOrderId: string): Promise<boolean> {
    this.cancelled.push(clientOrderId)
    return true
  }

  async flattenAll(reason: string): Promise<void> {
    this.flattens.push(reason)
  }

  asFillStream(): FillStream {
    return {
      onFill: (h) => {
        this.#fillHandlers.push(h)
        return () => {
          const i = this.#fillHandlers.indexOf(h)
          if (i >= 0) this.#fillHandlers.splice(i, 1)
        }
      },
    }
  }

  emitFill(fill: Fill): void {
    for (const h of [...this.#fillHandlers]) h(fill)
  }
}

export class MemoryStateStore implements StateStore {
  readonly #data = new Map<string, unknown>()

  async get<T>(key: string): Promise<T | null> {
    return (this.#data.get(key) as T | undefined) ?? null
  }

  async set<T>(key: string, value: T): Promise<void> {
    this.#data.set(key, value)
  }

  async delete(key: string): Promise<void> {
    this.#data.delete(key)
  }

  /** Seed state to simulate a restart with an open position. */
  seed(key: string, value: unknown): void {
    this.#data.set(key, value)
  }
}

export interface CapturedLog {
  readonly level: string
  readonly msg: string
  /** The structured context, so a test can assert on the DETAIL, not just the headline. */
  readonly ctx?: Record<string, unknown>
}

export function makeLogger(sink: CapturedLog[] = []): Logger & { entries: CapturedLog[] } {
  const push = (level: string) => (msg: string, ctx?: Record<string, unknown>) => {
    sink.push({ level, msg, ...(ctx === undefined ? {} : { ctx }) })
  }
  return {
    entries: sink,
    debug: push('debug'),
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
  }
}

export interface TestContextParts {
  ctx: StrategyContext
  md: FakeMarketData
  gateway: RecordingGateway
  state: MemoryStateStore
  clock: ReturnType<typeof fixedClock>
  logs: CapturedLog[]
  setFeedHealth: (ok: boolean, reason?: string) => void
}

/** Build a fully-injected StrategyContext for tests and replay verification. */
export function makeTestContext(opts: { tag?: string; nowMs?: number } = {}): TestContextParts {
  const clock = fixedClock(opts.nowMs ?? Date.UTC(2026, 6, 24, 4, 0, 0)) // Fri 09:30 IST
  const md = new FakeMarketData()
  md.useClock(clock)
  const gateway = new RecordingGateway()
  const state = new MemoryStateStore()
  const logs: CapturedLog[] = []
  const log = makeLogger(logs)

  let feedOk = true
  let feedReason: string | null = null
  const feed = {
    isTrustworthy: () => feedOk,
    reason: () => feedReason,
  }

  const ctx: StrategyContext = {
    tag: opts.tag ?? 'TEST',
    clock,
    md,
    orders: gateway,
    fills: gateway.asFillStream(),
    state,
    log,
    mode: 'sim',
    destinations: ['sim'],
    feed,
  }
  return {
    ctx,
    md,
    gateway,
    state,
    clock,
    logs,
    setFeedHealth: (ok: boolean, reason?: string) => {
      feedOk = ok
      feedReason = ok ? null : (reason ?? 'stale')
    },
  }
}

// ---------------------------------------------------------------- replay

export interface ReplayTick {
  /** Epoch ms. Drives the synthetic clock. */
  readonly ts: number
  readonly quote: Quote
}

export interface ReplayResult {
  readonly orders: readonly RecordedOrder[]
  readonly ticksProcessed: number
  readonly jobsFired: readonly string[]
  /** @deprecated Jobs replaced phases; same value as `jobsFired`. */
  readonly phasesFired: readonly string[]
}

/**
 * Drive a strategy over a recorded tick sequence.
 *
 * Every cron occurrence falling inside the gap between two ticks fires — with
 * the clock set to the OCCURRENCE's instant, not the tick's — before the later
 * tick is delivered. So scheduled behaviour and tick behaviour interleave
 * exactly as they would live, including a repeating poller firing several times
 * between two ticks and the deliberate deadline-after-poller ordering.
 */
export async function replay(
  strategy: StrategyBase,
  parts: TestContextParts,
  ticks: readonly ReplayTick[],
): Promise<ReplayResult> {
  const { clock, md, gateway } = parts
  await strategy.start()

  const jobs = strategy.jobs()
  let cursorMs = clock.now()

  for (const t of ticks) {
    // Collect every job occurrence in (cursor, tick], oldest first, so two jobs
    // due in the same gap run in real chronological order.
    const due: { ts: number; name: string }[] = []
    for (const j of jobs) {
      for (const ts of occurrencesBetween(j.cron, cursorMs, t.ts)) due.push({ ts, name: j.name })
    }
    due.sort((a, b) => a.ts - b.ts)
    for (const d of due) {
      clock.set(d.ts)
      await strategy.fireJob(d.name)
    }

    clock.set(t.ts)
    md.setQuote(t.quote)
    strategy.handleTick(t.quote)
    await strategy.drain()
    cursorMs = t.ts
  }

  const fired = strategy.firedJobs()
  return {
    orders: gateway.orders,
    ticksProcessed: ticks.length,
    jobsFired: fired,
    phasesFired: fired,
  }
}

export interface IntentDiff {
  readonly match: boolean
  readonly differences: readonly string[]
}

/**
 * Compare two order sequences for golden-master verification.
 *
 * Order MATTERS: two strategies that place the same orders in a different
 * sequence are not equivalent, because sequencing changes exposure over time.
 * Ids and timestamps are excluded — they legitimately differ between runs.
 */
export function diffIntents(
  legacy: readonly RecordedOrder[],
  ported: readonly RecordedOrder[],
): IntentDiff {
  const differences: string[] = []

  if (legacy.length !== ported.length) {
    differences.push(`order COUNT differs: legacy=${legacy.length} ported=${ported.length}`)
  }

  const n = Math.max(legacy.length, ported.length)
  for (let i = 0; i < n; i++) {
    const a = legacy[i]
    const b = ported[i]
    if (a === undefined) {
      differences.push(`[${i}] ported has an EXTRA order: ${describe(b as RecordedOrder)}`)
      continue
    }
    if (b === undefined) {
      differences.push(`[${i}] ported is MISSING an order: ${describe(a)}`)
      continue
    }
    for (const key of ['symbol', 'side', 'lots', 'orderType', 'limitPrice', 'triggerPrice'] as const) {
      const av = a[key]
      const bv = b[key]
      if (av !== bv) differences.push(`[${i}] ${key}: legacy=${String(av)} ported=${String(bv)}`)
    }
  }
  return { match: differences.length === 0, differences }
}

function describe(o: RecordedOrder): string {
  return `${o.side} ${o.lots} ${o.symbol} (${o.orderType})`
}

/** Stable id helper so recorded fixtures are reproducible. */
export const testId = (prefix: string): string => makeId(prefix, 0)
