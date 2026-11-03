/**
 * THE FEED, FOLDED INTO A CHAIN THE ENGINE CAN DECIDE ON.
 *
 * One `md.tick` at a time in (`{token, price, ts, bid?, ask?}` — the payload
 * `apps/marketdata/src/main.ts:504` publishes), one `ChainSnap` out. Nothing
 * else in the supervisor touches the bus, and nothing in `@algomaker/desk-
 * engine` knows a token exists: this file is the whole of the seam between a
 * stream of prints and a market the rules can be replayed against.
 *
 * ── 1. BOTH-OR-NEITHER, AND THE BOOK SURVIVES AN LTP-ONLY TICK ─────────────
 * The load-bearing rule, ported from the deployed `QuoteCache`
 * (`apps/api/src/marks.ts:190-219`, and the retention itself at `:228`):
 *
 *   - a tick carrying a real, positive, un-crossed **bid AND ask** replaces
 *     the pair;
 *   - a tick carrying **only a price** updates the print and LEAVES THE PAIR
 *     ALONE. It never half-updates it, and it never clears it.
 *
 * Both halves matter and they fail in opposite directions. Half-updating
 * blends two moments into one book that never existed. Clearing on an
 * LTP-only tick unmarks every illiquid short between prints — TCS 2440 PE
 * (2026-08-17) last printed at 14:20 under a 115.50/117.15 book that moved
 * every second, and in live pricing a leg with no pair is not marked at all.
 * The feed pushes on depth change, so an un-updated pair means an UNCHANGED
 * book while the feed is healthy; that is why holding it is correct rather
 * than merely convenient (`desk-engine/src/marking.ts`, "valuation vs
 * candidacy split").
 *
 * ── 2. `asOf` IS THE AGE OF THE BASIS, NOT OF THE LAST PACKET ──────────────
 * `Quote` carries ONE timestamp and two possible bases, so it has to say which
 * one it is timing. It times the one that will actually be read: when the
 * quote holds a pair, `asOf` is that BOOK FRAME's own time — an LTP-only tick
 * does not advance it — and when it holds no pair, `asOf` is the print's.
 *
 * Advancing `asOf` on an LTP-only tick would make a frozen book look fresh,
 * which is exactly the tell the desk shipped on 2026-08-21 ("leg rows say when
 * the book is old"): the caller ages `LegView.exit` to decide whether to trust
 * a mark, and marking copies this quote into it verbatim. `QuoteCache.
 * exitQuote` reports `asOf: book.ts` for the same reason (`marks.ts:410`).
 *
 * ── 3. THE VIEW HOLDS THE DECLARED SET AND NOTHING ELSE ────────────────────
 * `apps/runner/src/market-data.ts:373-403` (audit F-53) is the cautionary
 * tale: `#quotes` kept the last tick for every token that ever arrived,
 * including tokens on the shared bus this process never asked for, and the
 * chain window MOVES — so on a trending day the map grew all session and what
 * it accumulated were prices that would never update again. A stale quote is
 * not inert; `selectOption` could still be sized off one frozen at 10:05.
 *
 * So a tick for a token no declared chain wants is DROPPED — not stored, not
 * counted as a touch — and a token that leaves the declared set takes its
 * price with it. Memory here is bounded by the chains the supervisor actually
 * steers times their listed strikes; it does not grow with the tick stream,
 * which is the property F-53 lacked. Stated honestly: a chain is never
 * UN-declared, so a book that rolls away leaves its last resolved token list —
 * and the last prices on it — held until the process restarts. That is a
 * per-expiry-roll leak, not a per-tick one, and it is the line to revisit if a
 * supervisor is ever expected to run for months.
 *
 * **`snap()` IS THE DECLARATION.** A `token` does not say which underlying it
 * belongs to, and `tokensFor` is keyed by (symbol, expiry) — so the only
 * moment this class learns which chains matter is when it is asked for one.
 * Asking re-resolves that chain against the master every time (a strike listed
 * intraday appears; one that delists is pruned), which is cheap and, more to
 * the point, self-healing. The cost is that a supervisor's very first ticks
 * land before its first snap and are dropped: one poll cycle, on a stream that
 * repeats every few hundred milliseconds. `warmStart` covers the boot itself.
 *
 * ── 4. THE SPOT CONTRACT IS OWNED HERE ─────────────────────────────────────
 * In live pricing `ChainSnap.spot` is `midOf(future)` — the forward every
 * Black-76 greek in `marking.ts` is taken at. Never the future's last print: a
 * future's LTP and its mid diverge by half a spread all session, and greeks
 * priced off the wrong forward are wrong in a way no P&L displays. `midOf`
 * itself falls back to the print only for a genuinely one-sided book, which is
 * the one case where there is no mid to have (`marking.ts:midOf`).
 *
 * No future quote and no index level to stand in for one: no snapshot. `spot`
 * is a plain `number` on `ChainSnap` because a chain without a forward cannot
 * be priced at all, and `null` here is a far better answer than a chain the
 * rules would happily decide on.
 *
 * ── 5. A PROXY FORWARD BEATS SILENCE, AND SAYS SO ──────────────────────────
 * A future with NO QUOTE AT ALL — never subscribed, or printing neither a book
 * nor a trade — used to end the book's day: a null snap makes the host's
 * `#evaluateOnce` bail without a word (`engine-host.ts:699-706`), so a book
 * whose whole job is to react within seconds stops deciding, and stops
 * SILENTLY. Where the deps carry an index level, the forward is
 * synthesised instead — `spot * carry`, published as a PRINT (`bid`/`ask`
 * `null`) because no such book was ever quoted, and flagged on
 * `syntheticForward` so the decisions it feeds can be read for what they are.
 * A few points of basis error is a far smaller error than not deciding.
 *
 * FOR ABSENCE ONLY. A genuinely one-sided future already snaps, off `midOf`'s
 * LTP fallback (§4), and must keep doing so: a traded forward and an index
 * proxy are different numbers, and the traded one is the right one. And where
 * the deps carry no index level — the default, and every caller's behaviour
 * before this existed — a missing forward is still `null`. There is no third
 * source, so there is no third answer.
 *
 * ── 6. A WEEKLY IS PRICED OFF ITS OWN FORWARD — WHEN ITS BOOK ASKS ──────────
 * The near-month future does not expire with a weekly. The weekly's own
 * forward sat a median 308 points below the future on SENSEX and 35-71 below
 * it on NIFTY (six-playbooks spec §1.3, F1), so a chain priced off the
 * future's mid picks every ATM, delta and band strike off the wrong number. A
 * snap asked for `forward: 'parity'` reads the chain's OWN forward instead,
 * around the index level `spotFor` answers:
 *
 *   1. put-call parity over the six strikes nearest the index
 *      (`parityForward`, which owns every gate) — `forwardSource` `'parity'`;
 *   2. the index carried over the contract's own tenor (`carryForward`) when
 *      the chain cannot give an honest parity read — `'index-carry'`;
 *   3. with no index level at all, today's snap exactly — `'future'`, or
 *      `'proxy'` (§5) — because there is nothing to read parity around and
 *      nothing to carry.
 *
 * ONLY `spot` MOVES. `future` stays the quoted future (or §5's print): nothing
 * in the engine reads it, and a future fabricated at the parity forward would
 * be a quote nobody made. `asOf` stays the newest quote in the snapshot.
 *
 * ASKED FOR, per snap, never assumed. A snap with no options — every recenter
 * book — is §4 and §5 to the byte, and the host decides who asks (`main.ts`:
 * `dl_parity_forward`, overridden by `DESK_CHAIN_FORWARD=future`). The clock
 * the wing ages are measured against comes in WITH the request, because this
 * class has none; a request without it is today's snap rather than a read
 * that cannot tell a live wing from a frozen one.
 *
 * PURE: no clock, no bus, no Mongo, no `process.env`. Every timestamp comes
 * off a tick — or, for §6's read, in the snap's own options — which is what
 * makes `touchedSince` a market question rather than a wall-clock one, and
 * what lets a fixture replay a session that is over.
 */

import { carryForward, midOf, parityForward } from '@algomaker/desk-engine'
import type { ChainSnap, ForwardSource, OptType, Quote, StrikeQuote } from '@algomaker/desk-engine'

/** One listed option contract, as the instrument master names it. */
export interface ChainToken {
  readonly token: number
  readonly strike: number
  readonly optType: OptType
  /**
   * The exchange tradingsymbol. Unused by the snapshot — a wing is identified
   * there by strike and type — but carried because this is the same row the
   * caller's leg-building path resolves, and splitting the shape in two would
   * invite the two halves to disagree about which token is which contract.
   */
  readonly instrument: string
}

/**
 * The instrument master, reduced to the two questions this class asks.
 *
 * INJECTED, not imported. `packages/instruments` is a heavyweight dump index
 * whose refresh is the host's business (Task 15 wires it), and a fake here is
 * four lines rather than a CSV.
 */
export interface ChainViewDeps {
  /** Every listed contract in one chain. Re-asked on every `snap`. */
  tokensFor(symbol: string, expiry: string): ReadonlyArray<ChainToken>
  /**
   * The traded future this chain prices against. `0` (or anything not a real
   * token) means the master lists none, and the chain can never snap.
   */
  futureToken(symbol: string): number
  /**
   * The cash index level for this underlying, and the carry that takes it to a
   * near-month forward — the §5 proxy, used ONLY when the future has no quote.
   * The same level is what a §6 parity snap reads its strikes around and, when
   * the chain cannot price parity, carries over the contract's tenor; `carryFor`
   * is the proxy's alone.
   *
   * OPTIONAL, and absent is not zero: it means this deployment has no index
   * spot feed, in which case a chain with no future quote still does not snap,
   * exactly as it did before the proxy existed, and a parity snap is priced off
   * the future. That is what keeps a fallback one book asked for from quietly
   * re-pricing every other book in the process. `spotFor` answers `null` for a
   * symbol it has no level for — or none fresh enough to stand on — and an
   * absent `carryFor` reads as a flat `1` — the honest answer when no basis is
   * known, rather than a guess at one.
   */
  spotFor?(symbol: string): number | null
  carryFor?(symbol: string): number
}

/**
 * How one `snap()` is to be priced (§6) — and the clock the parity read needs,
 * because this class has none.
 *
 * ABSENT, or `forward: 'future'`, IS TODAY'S SNAP to the byte: the quoted
 * future's mid, the §5 proxy when there is none. `'parity'` asks for the
 * chain's own forward, and only with all three clock fields does it get one:
 * `nowMs` is what every wing's age is measured against, `dateIst` and
 * `minuteOfDay` the tenor the carry is priced over. The host passes its own
 * clock at snap time.
 */
export interface SnapOptions {
  readonly forward?: 'future' | 'parity'
  readonly nowMs?: number
  readonly dateIst?: string
  readonly minuteOfDay?: number
}

/** One `md.tick` frame off the bus. */
export interface MdTick {
  readonly token: number
  readonly price: number
  readonly ts: number
  readonly bid?: number | undefined
  readonly ask?: number | undefined
}

/**
 * One persisted `desk-marks` row, for the boot warm start.
 *
 * `bookTs` is the PAIR's own time and is optional only because a row written
 * before the two-sided snapshot existed does not carry one; when it is absent
 * the row's `ts` stands in, exactly as `QuoteCache.loadSnapshot` decides it
 * (`apps/api/src/marks.ts:313`). Without it a seeded book ages from the last
 * print and reads fresher than it is — §2 above, at boot.
 */
export interface WarmMark {
  readonly token: number
  readonly price: number
  readonly ts: number
  readonly bid: number | null
  readonly ask: number | null
  readonly bookTs?: number | null | undefined
}

/** A chain, as last resolved against the master. */
interface ChainDef {
  readonly futureToken: number
  readonly rows: ReadonlyArray<ChainToken>
}

const chainKey = (symbol: string, expiry: string): string => `${symbol}|${expiry}`

const isToken = (n: number): boolean => Number.isFinite(n) && n > 0

/**
 * The two-sided book on a tick, or `null` when there is not one.
 *
 * The same four tests as `marks.ts:217-219`: both sides present, both finite,
 * both positive, and not crossed. A crossed or one-sided book prices nothing —
 * and a `0` bid is the shape the legacy `0.05` fill artefact took, not a
 * market that will buy at nothing.
 */
function pairOf(
  bid: number | null | undefined,
  ask: number | null | undefined,
): { readonly bid: number; readonly ask: number } | null {
  if (typeof bid !== 'number' || !Number.isFinite(bid) || bid <= 0) return null
  if (typeof ask !== 'number' || !Number.isFinite(ask) || ask <= 0) return null
  if (ask < bid) return null
  return { bid, ask }
}

/**
 * The tick folded onto what was already held — §1 and §2 of the header in one
 * expression.
 */
function fold(prev: Quote | undefined, tick: MdTick): Quote {
  const pair = pairOf(tick.bid, tick.ask)
  if (pair !== null) return { bid: pair.bid, ask: pair.ask, ltp: tick.price, asOf: tick.ts }
  // No book on this tick: keep the last one, and keep ITS time with it.
  if (prev !== undefined && prev.bid !== null && prev.ask !== null) {
    return { bid: prev.bid, ask: prev.ask, ltp: tick.price, asOf: prev.asOf }
  }
  return { bid: null, ask: null, ltp: tick.price, asOf: tick.ts }
}

export class ChainView {
  readonly #deps: ChainViewDeps
  /** Chains this view has been asked for, by `chainKey`. */
  readonly #chains = new Map<string, ChainDef>()
  /** Quotes for DECLARED tokens only — see §3. */
  readonly #quotes = new Map<number, Quote>()
  /**
   * Warm-start rows for tokens no declared chain wants YET.
   *
   * Bounded by the ONE boot-time `warmStart` call and never added to
   * afterwards, so it cannot grow with the session the way F-53's map did. It
   * is kept rather than discarded so that a book leased at 13:00 still boots
   * with a book behind it; each row is consumed the moment its chain declares.
   */
  readonly #seed = new Map<number, Quote>()
  /** The declared union, for an O(1) admission test on the hot path. */
  #admitted: ReadonlySet<number> = new Set<number>()
  /** Newest tick timestamp admitted. 0 = the feed has said nothing yet. */
  #lastTickMs = 0
  /** Which source priced the LAST `snap()`'s `spot`; `null` = no snapshot. */
  #forwardSource: ForwardSource | null = null

  constructor(deps: ChainViewDeps) {
    this.#deps = deps
  }

  /**
   * One tick off the bus.
   *
   * Silently ignores a token no declared chain wants (§3), a price that is not
   * a price, and a timestamp that is not one — a `NaN` `asOf` ages to `NaN`
   * and every staleness comparison against it reads false, silently, which is
   * the same class of defect the state store refuses non-finite numbers for.
   */
  onTick(t: MdTick): void {
    if (!this.#admitted.has(t.token)) return
    if (!Number.isFinite(t.price) || t.price <= 0) return
    if (!Number.isFinite(t.ts)) return
    this.#quotes.set(t.token, fold(this.#quotes.get(t.token), t))
    // Out-of-order arrivals must not wind the market clock backwards.
    if (t.ts > this.#lastTickMs) this.#lastTickMs = t.ts
  }

  /**
   * Seed the last-known books from `desk-marks` so a supervisor that boots
   * mid-session — or before the first tick of the day — has a market to
   * decide against instead of a blank chain.
   *
   * NEVER OVERWRITES WHAT THE FEED HAS SAID. A persisted row is by definition
   * older than any live quote for the same token, and a warm start that landed
   * on top of one would replace a real book with yesterday's. Rows for chains
   * that have not been declared yet wait in `#seed`.
   *
   * This is not a touch: `touchedSince` answers about the FEED, and nothing
   * has come off it yet.
   */
  warmStart(rows: ReadonlyArray<WarmMark>): void {
    for (const r of rows) {
      if (!Number.isFinite(r.price) || r.price <= 0) continue
      if (!Number.isFinite(r.ts)) continue
      const pair = pairOf(r.bid, r.ask)
      const bookTs =
        pair !== null && typeof r.bookTs === 'number' && Number.isFinite(r.bookTs) ? r.bookTs : r.ts
      const q: Quote = {
        bid: pair === null ? null : pair.bid,
        ask: pair === null ? null : pair.ask,
        ltp: r.price,
        asOf: bookTs,
      }
      if (!this.#admitted.has(r.token)) {
        this.#seed.set(r.token, q)
        continue
      }
      if (!this.#quotes.has(r.token)) this.#quotes.set(r.token, q)
    }
  }

  /**
   * The chain as the engine decides on it — AND the declaration that makes
   * this chain's ticks worth keeping (§3).
   *
   * `null` when the future has no usable quote AND no index level stands in
   * for it: `spot` is the forward, and a chain without one cannot be priced at
   * all (§4, §5). Read `forwardSource` after a snapshot to know which forward
   * it was priced off — and pass `opts` to ask for the chain's own (§6).
   *
   * Every LISTED strike is returned, with an unquoted wing as `null` rather
   * than a zero — a strike the exchange does not list and a strike that simply
   * has not traded are different facts, and only the second can be opened once
   * it prints (`apps/api/src/chain.ts` header). `asOf` is the NEWEST quote in
   * the snapshot; a per-contract age is on each `Quote`, and the forward's own
   * age is `future.asOf`.
   */
  snap(
    symbol: string,
    expiry: string,
    lotSize: number,
    step: number,
    opts: SnapOptions = {},
  ): ChainSnap | null {
    const def = this.#declare(symbol, expiry)
    // Cleared on the way IN. A snapshot that never happens priced off nothing,
    // and must not leave the previous call's source over the next decision — a
    // flag nobody can trust is a flag nobody reads.
    this.#forwardSource = null

    const quoted = isToken(def.futureToken) ? this.#quotes.get(def.futureToken) : undefined
    const quotedSpot = quoted === undefined ? null : midOf(quoted)
    let future: Quote
    let spot: number
    let source: ForwardSource
    if (quoted !== undefined && quotedSpot !== null) {
      future = quoted
      spot = quotedSpot
      source = 'future'
    } else {
      const proxy = this.#proxyForward(symbol)
      if (proxy === null) return null
      spot = proxy
      // A print, never a book: nobody quoted a bid or an ask for this. `asOf`
      // is the market clock this view last saw, which is the only time it has
      // — `spotFor` carries no stamp of its own — and 0 before the first tick,
      // so a proxy built at boot reads as old rather than as fresh (§2).
      future = { bid: null, ask: null, ltp: spot, asOf: this.#lastTickMs }
      source = 'proxy'
    }

    const byStrike = new Map<number, { ce: Quote | null; pe: Quote | null }>()
    for (const r of def.rows) {
      let row = byStrike.get(r.strike)
      if (row === undefined) {
        row = { ce: null, pe: null }
        byStrike.set(r.strike, row)
      }
      const q = this.#quotes.get(r.token) ?? null
      // `?? q` rather than `= q`: two rows naming one wing is a malformed dump
      // rather than a real chain, and the QUOTED one is the less wrong answer.
      if (r.optType === 'CE') row.ce = row.ce ?? q
      else row.pe = row.pe ?? q
    }

    let asOf = future.asOf
    const strikes: StrikeQuote[] = []
    for (const strike of [...byStrike.keys()].sort((a, b) => a - b)) {
      const row = byStrike.get(strike)
      if (row === undefined) continue
      if (row.ce !== null && row.ce.asOf > asOf) asOf = row.ce.asOf
      if (row.pe !== null && row.pe.asOf > asOf) asOf = row.pe.asOf
      strikes.push({ strike, ce: row.ce, pe: row.pe })
    }

    // §6, and only when this snap asked: the chain's OWN forward replaces
    // `spot`, and nothing else in the snapshot moves.
    if (opts.forward === 'parity') {
      const own = this.#ownForward(symbol, expiry, step, strikes, opts)
      if (own !== null) {
        spot = own.forward
        source = own.source
      }
    }
    this.#forwardSource = source
    return { symbol, expiry, step, lotSize, future, spot, strikes, asOf }
  }

  /**
   * This chain's held quotes BY TOKEN — and, like `snap()`, the declaration
   * that makes its ticks worth keeping (§3).
   *
   * For a view that cannot `snap()`: the Delta-testnet view (`md.tick.demo`)
   * carries only the contracts demo-rail books hold, never a forward, so a snap
   * of it would be `null` and declare nothing anyone could read. The host lays
   * these over the production snap (`demo-marks.ts`).
   */
  quotes(symbol: string, expiry: string): ReadonlyMap<number, Quote> {
    const def = this.#declare(symbol, expiry)
    const out = new Map<number, Quote>()
    for (const r of def.rows) {
      const q = this.#quotes.get(r.token)
      if (q !== undefined) out.set(r.token, q)
    }
    return out
  }

  /**
   * The newest tick this view ADMITTED, or 0. The caller's coalescing stamp.
   *
   * Exposed beside `touchedSince` because a caller that asks "is there anything
   * new" has to be able to record the answer's own instant: stamping its own
   * clock instead compares a wall clock against a feed clock, and on any
   * deployment where the feed's stamps lag it, the next pass skips itself until
   * a tick arrives stamped later than the moment we looked. Same number
   * `touchedSince` compares against, so the two cannot disagree.
   */
  get lastTickMs(): number {
    return this.#lastTickMs
  }

  /**
   * Was the LAST `snap()` priced off the §5 proxy instead of a real future?
   *
   * `false` until the first snapshot, `false` after any call that returned
   * `null`, and it describes the most recent snapshot only — it is read right
   * after a snap to stamp the decision that came out of it, not consulted
   * later as a property of the view. Derived from `forwardSource`, so the two
   * cannot disagree: a §6 read that priced a chain with no quoted future is
   * not a proxy, even though its `future` is §5's print.
   */
  get syntheticForward(): boolean {
    return this.#forwardSource === 'proxy'
  }

  /**
   * WHICH SOURCE PRICED THE LAST `snap()`'s `spot` (six-playbooks spec F1):
   * `'parity'` or `'index-carry'` — the chain's own forward (§6) — `'future'`
   * (§4), or `'proxy'` (§5).
   *
   * `null` until the first snapshot and after any call that returned `null`.
   * Like `syntheticForward` it describes the most recent snapshot only, and the
   * view is SHARED by every book: a caller reads it right after its own snap
   * (`main.ts` keeps it per book) rather than later, when another book's snap
   * may have replaced it.
   */
  get forwardSource(): ForwardSource | null {
    return this.#forwardSource
  }

  /**
   * Has the feed touched this view since `ms` (epoch)?
   *
   * The supervisor's change detector: "is there anything new to decide on",
   * asked with the instant it last looked. A tick stamped exactly at that
   * instant is one it saw, so the comparison is strict; `touchedSince(0)` on a
   * view nothing has ever ticked is `false`.
   *
   * NOT A LIVENESS PROOF, and it cannot be one: this class has no clock, so it
   * answers off the timestamps the ticks carry. A broker replaying old stamps
   * would look quiet here rather than falsely alive, and "is the feed dead"
   * stays with `QuoteCache.feedAlive`, which measures ARRIVAL (`marks.ts:261`).
   * An LTP-only tick counts — the market moved even though no book changed —
   * and a tick this view dropped does not.
   */
  touchedSince(ms: number): boolean {
    return this.#lastTickMs > ms
  }

  // ------------------------------------------------------------- internals

  /**
   * The index level times carry, or `null` when this deployment has no spot
   * feed for the symbol — or when what it answered is not a price.
   *
   * The finiteness check is the same refusal `onTick` makes at ingest: a `NaN`
   * forward does not throw anywhere, it silently turns every Black-76 greek on
   * the chain into `NaN`, and a book sized off those is a book sized off
   * nothing.
   */
  #proxyForward(symbol: string): number | null {
    const cash = this.#indexLevel(symbol)
    if (cash === null) return null
    const carry = this.#deps.carryFor?.(symbol) ?? 1
    if (!Number.isFinite(carry) || carry <= 0) return null
    return cash * carry
  }

  /** The cash index level `spotFor` answers, or `null` — refused as above. */
  #indexLevel(symbol: string): number | null {
    const cash = this.#deps.spotFor?.(symbol) ?? null
    if (cash === null || !Number.isFinite(cash) || cash <= 0) return null
    return cash
  }

  /**
   * The chain's own forward (§6), or `null` when it cannot be read and the
   * snap keeps the forward §4/§5 chose.
   *
   * Two absences end it before any arithmetic. No CLOCK: a wing counts only
   * while its quote is fresh, and this class has no clock of its own to age
   * one against. No INDEX: parity is read over the strikes nearest the index
   * and sanity-banded against it, and the fallback carries it — with no level
   * there is neither. Otherwise `parityForward` owns every gate (six strikes,
   * a median over at least three, the age and spread bars, the sanity band),
   * and `null` from it is a real answer: the index carried over the tenor.
   */
  #ownForward(
    symbol: string,
    expiry: string,
    step: number,
    strikes: ReadonlyArray<StrikeQuote>,
    opts: SnapOptions,
  ): { readonly forward: number; readonly source: 'parity' | 'index-carry' } | null {
    const { nowMs, dateIst, minuteOfDay } = opts
    if (nowMs === undefined || dateIst === undefined || minuteOfDay === undefined) return null
    const index = this.#indexLevel(symbol)
    if (index === null) return null
    const read = parityForward({ strikes, index, step, nowMs, dateIst, expiry, minuteOfDay })
    if (read !== null) return { forward: read.forward, source: 'parity' }
    const carried = carryForward(index, dateIst, expiry, minuteOfDay)
    // The refusal the proxy makes, for the same reason: a forward that is not
    // a price turns every greek on the chain into NaN and throws nowhere.
    if (!Number.isFinite(carried) || carried <= 0) return null
    return { forward: carried, source: 'index-carry' }
  }

  /**
   * Re-resolve one chain against the master, then rebuild the declared union.
   *
   * Re-resolved on EVERY snap rather than memoised: the listed chain changes
   * under a running process (a strike lists intraday, an expiry passes), and a
   * frozen token list would leave the view subscribed in spirit to contracts
   * that no longer exist while missing the ones that do.
   */
  #declare(symbol: string, expiry: string): ChainDef {
    const def: ChainDef = {
      futureToken: this.#deps.futureToken(symbol),
      rows: [...this.#deps.tokensFor(symbol, expiry)],
    }
    this.#chains.set(chainKey(symbol, expiry), def)
    this.#reindex()
    return def
  }

  /**
   * The admission set, the prune and the seed promotion — the three jobs
   * behind "hold the declared set and nothing else" (§3).
   *
   * The union spans EVERY declared chain, not just the one resolved: snapping
   * book A must not forget book B. Same reason the runner prunes against
   * `fullSubscriptionSet()` rather than the declaring tag's own slice
   * (`market-data.ts:393-396`).
   */
  #reindex(): void {
    const admitted = new Set<number>()
    for (const def of this.#chains.values()) {
      if (isToken(def.futureToken)) admitted.add(def.futureToken)
      for (const r of def.rows) if (isToken(r.token)) admitted.add(r.token)
    }
    this.#admitted = admitted

    // A price for a contract nobody is subscribed to any more will never be
    // updated again, and holding it is worse than holding nothing (F-53).
    for (const token of this.#quotes.keys()) if (!admitted.has(token)) this.#quotes.delete(token)

    for (const token of admitted) {
      if (this.#quotes.has(token)) continue
      const seeded = this.#seed.get(token)
      if (seeded === undefined) continue
      this.#quotes.set(token, seeded)
      this.#seed.delete(token)
    }
  }
}
