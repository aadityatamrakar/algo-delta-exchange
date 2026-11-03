/**
 * SPAN-lite: what a broker would actually make you post to hold this book.
 *
 * A port of `portfolio_margin`/`_span_core` (`sensibull_tools/sim/margin.py`) —
 * the estimator behind the Python engine's margin-cap guard, so the number that
 * comes out of here is the one that decides whether a live book is allowed to
 * grow another leg.
 *
 * THE WHOLE MODEL IS ONE GRID. Price the book at `spot·(1 + f·priceScanPct)`
 * for `f ∈ {0, ±1/3, ±2/3, ±1}`, crossed with `iv·{1−volScan, 1, 1+volScan}` —
 * 21 scenarios — and take the WORST loss against the current mark. Everything a
 * real SPAN does with spread charges and inter-month tiers, this gets for free
 * from the grid: a long wing's gain lands in the SAME scenario as the short's
 * loss, so it nets, and no leg is ever matched against another by hand. Two
 * add-ons sit on top, both of them the exchange's rules and not the model's:
 * SPAN is FLOORED at `minShortPct` of short notional (deep-OTM shorts scan to
 * nothing and NSE still charges for them), and an EXPOSURE margin covers gap
 * and settlement risk on short options plus futures, both sides.
 *
 * A BOOK WITH NO SHORT AND NO FUTURE IS FREE. A fully-paid long option cannot
 * lose more than it cost, so no exchange margins it, and the grid is not even
 * consulted — the result is zeros. Charging SPAN on a long call would quietly
 * halve the capital the desk can deploy.
 *
 * SHORTNESS IS THE SIGN OF `qty`, where the Python reads a `side` string
 * (`_is_short_option`) and rebuilds `lots × lot_size` beside it. `legs.ts`
 * applies the sign once at the boundary, so "short" here is `qty < 0` and
 * notional is `spot·|qty|` — the same number, minus the two places the Python
 * gives you to drop a sign. `n_short_lots` is NOT returned: these legs carry no
 * lot size, so there is no honest lot count to report.
 *
 * FAIL-SOFT, AND SILENT. Unlike `surface.ts` this returns no warnings: it is
 * called on every mark of every book by the cap guard, and its answer is a
 * single rupee figure compared against a limit. Bad input degrades to a zeroed
 * result — which, for a margin estimate, is the READING that must never be
 * mistaken for a cheap book, so callers gate on `spot`/`legs` themselves before
 * trusting a zero. Nothing here throws, and nothing NaN leaves it.
 */
import { legPnl, DEFAULT_RATE, type PayoffLeg } from './legs.ts'

export interface SpanLiteOptions {
  /** Vol used for an option leg with no usable IV of its own. Default 0.35. */
  readonly defaultIv?: number
  /** Widest price shock, as a fraction of spot. Default 0.21 (±21%). */
  readonly priceScanPct?: number
  /** Vol shock, as a fraction of each leg's IV. Default 0.25 (×0.75 … ×1.25). */
  readonly volScan?: number
  /** Exposure add-on on short + futures notional. Default 0.05 (5%). */
  readonly exposurePct?: number
  /** SPAN floor, as a fraction of short notional. Default 0.05 (5%). */
  readonly minShortPct?: number
  /** Risk-free rate for the Black-76 repricing. Default `DEFAULT_RATE`. */
  readonly rate?: number
}

export interface SpanLiteMargin {
  /** Worst scenario loss, floored at `minShortPct · shortNotional`. Rupees. */
  readonly span: number
  /** `exposurePct · (shortNotional + futuresNotional)`. Rupees. */
  readonly exposure: number
  /** `span + exposure` — the figure the cap guard compares. Rupees. */
  readonly total: number
  /** WHERE the book hurt most: the grid cell `span` was read off. */
  readonly worstScenario: {
    /** The price shock, in PERCENT (`f · priceScanPct · 100`). */
    readonly priceMovePct: number
    /** The vol multiplier: `1−volScan`, `1`, or `1+volScan`. */
    readonly volMult: number
  }
  /** `spot · |qty|` over the SHORT OPTION legs. Futures are not in it. */
  readonly shortNotional: number
}

/**
 * The 7 price-shock fractions, IN THE PYTHON'S ORDER — which is part of the
 * answer, not a detail: the worst cell of a tie is the first one visited.
 */
const F_MULTS = [0, 1 / 3, -1 / 3, 2 / 3, -2 / 3, 1, -1] as const

/**
 * ~1 hour. Floors `t` so that an expiry-day book is still SCANNED: at `t = 0`
 * every option is worth its intrinsic at every scenario price and the vol
 * multipliers do nothing at all, which would report a 0-DTE short strangle —
 * the single most dangerous book on the desk — as carrying no vol risk.
 */
const MIN_T = 1 / 365 / 24

const DEFAULT_IV = 0.35
const DEFAULT_PRICE_SCAN_PCT = 0.21
const DEFAULT_VOL_SCAN = 0.25
const DEFAULT_EXPOSURE_PCT = 0.05
const DEFAULT_MIN_SHORT_PCT = 0.05

const MS_PER_DAY = 24 * 60 * 60 * 1000

/**
 * A zeroed book. `volMult: 1` and not 0 because the unshocked vol IS the
 * neutral cell: a caller rendering "worst case: −0% at ×0 vol" would be reading
 * a scenario that does not exist on the grid.
 */
function zeroed(): SpanLiteMargin {
  return {
    span: 0,
    exposure: 0,
    total: 0,
    worstScenario: { priceMovePct: 0, volMult: 1 },
    shortNotional: 0,
  }
}

/** The caller's number when it is usable, the desk default when it is not. */
function usable(v: number | undefined, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

/**
 * UTC midnight of the DATE PART of an ISO string, or null.
 *
 * The same parser as `surface.ts`, deliberately duplicated rather than shared:
 * both files are ports of Python modules that each carry their own clock, and
 * the two clocks are only equal by coincidence of both being `year_frac`. (An
 * extraction is a rename away if a third file ever needs it.) Anchored, so a
 * truncated feed date fails rather than matching as a prefix; rolled-over dates
 * ("2026-02-31") are rejected because `Date.UTC` would silently read them as
 * March 3rd where `date.fromisoformat` raises.
 */
function isoDayMs(value: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/.exec(String(value ?? '').trim())
  if (m === null) return null
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  const ms = Date.UTC(y, mo - 1, d)
  const back = new Date(ms)
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) {
    return null
  }
  return ms
}

/** Calendar days over 365, floored at zero — `pricing.year_frac`. */
function yearFrac(from: string, to: string): number | null {
  const a = isoDayMs(from)
  const b = isoDayMs(to)
  if (a === null || b === null) return null
  return Math.max(0, (b - a) / MS_PER_DAY / 365)
}

/**
 * Time-to-expiry for one leg, floored at `MIN_T`.
 *
 * AN UNREADABLE DATE IS PRICED, NOT DROPPED — `MIN_T`, i.e. as if it expired
 * within the hour. That is `_leg_t`'s behaviour (it swallows the parse error)
 * and it is the conservative side of the trade for a MARGIN number: an
 * expiring short is scanned at its full intrinsic move, where dropping the leg
 * would report the book as needing nothing at all.
 */
function legT(leg: PayoffLeg, date: string): number {
  const expiry = typeof leg.expiry === 'string' ? leg.expiry : ''
  if (expiry === '') return MIN_T
  const yf = yearFrac(date, expiry)
  return yf === null ? MIN_T : Math.max(yf, MIN_T)
}

/** A leg's own vol when it has a positive one, the book default otherwise. */
function legIv(leg: PayoffLeg, defaultIv: number): number {
  const iv = leg.iv
  return typeof iv === 'number' && Number.isFinite(iv) && iv > 0 ? iv : defaultIv
}

interface Scenario {
  /** Price-shock fraction, one of `F_MULTS`. */
  readonly f: number
  /** Vol multiplier. */
  readonly vm: number
  /** `spot · (1 + f · priceScanPct)`, hoisted out of the per-leg loop. */
  readonly F: number
}

/**
 * SPAN-lite for `legs` marked at `spot` on `date`.
 *
 * NOTHING IS ROUNDED, where the Python rounds every field to 2dp. The parity
 * tolerances absorb it, and the cap guard compares against a limit in rupees —
 * rounding here would only throw precision away before the comparison.
 */
export function spanLiteMargin(
  legs: readonly PayoffLeg[],
  spot: number,
  date: string,
  opts?: SpanLiteOptions,
): SpanLiteMargin {
  try {
    const defaultIv = usable(opts?.defaultIv, DEFAULT_IV)
    const priceScanPct = usable(opts?.priceScanPct, DEFAULT_PRICE_SCAN_PCT)
    const volScan = usable(opts?.volScan, DEFAULT_VOL_SCAN)
    const exposurePct = usable(opts?.exposurePct, DEFAULT_EXPOSURE_PCT)
    const minShortPct = usable(opts?.minShortPct, DEFAULT_MIN_SHORT_PCT)
    const rate = usable(opts?.rate, DEFAULT_RATE)

    // `Array.isArray` and not `legs.length`: the bridge hands these straight
    // out of Mongo, where "no legs" arrives as often as `null` does.
    if (!Array.isArray(legs) || legs.length === 0) return zeroed()
    if (!Number.isFinite(spot) || spot <= 0) return zeroed()

    // The grid, built ONCE. Price fraction outer, vol inner — the Python's own
    // iteration order, and it is load-bearing: `min()` there keeps the FIRST
    // cell of a tie, so two scenarios that lose exactly the same amount must be
    // visited in the same order to report the same `worstScenario`.
    //
    // ONE DELIBERATE DIVERGENCE, at `volScan === 0`: the Python keys its
    // accumulator by the `(f, vm)` TUPLE, so three identical vol multipliers
    // collapse to one dict key and every scenario change is added to it three
    // times — tripling the span of a book margined with the vol scan switched
    // off. This indexes by scenario position, so each of the 21 cells is
    // accumulated exactly once and a zero vol scan simply means "price shocks
    // only", which is what asking for it means.
    const scenarios: Scenario[] = []
    for (const f of F_MULTS) {
      const F = spot * (1 + f * priceScanPct)
      for (const vm of [1 - volScan, 1, 1 + volScan]) scenarios.push({ f, vm, F })
    }
    const changes = new Array<number>(scenarios.length).fill(0)

    let shortNotional = 0
    let futuresNotional = 0
    let anyShortOrFuture = false

    for (const leg of legs) {
      if (leg === null || typeof leg !== 'object') continue
      const instrument = leg.instrument
      if (instrument !== 'option' && instrument !== 'future') continue

      const t = legT(leg, date)
      const isOption = instrument === 'option'
      // Futures are linear and carry no vol at all, so the override is only
      // ever meaningful for an option — `legPnl` ignores it on a future.
      const iv = isOption ? legIv(leg, defaultIv) : undefined
      const current = legPnl(leg, spot, t, rate, iv)

      for (const [k, s] of scenarios.entries()) {
        const shocked = legPnl(leg, s.F, t, rate, iv === undefined ? undefined : iv * s.vm)
        const d = shocked - current
        // A leg that cannot be priced contributes 0 at every cell (`legPnl` is
        // itself fail-soft); this only catches an infinite qty or entry, which
        // would otherwise NaN the whole grid from one bad row in Mongo.
        if (Number.isFinite(d)) changes[k] = (changes[k] ?? 0) + d
      }

      const qty = Number.isFinite(leg.qty) ? leg.qty : 0
      if (isOption) {
        // SHORT is the sign, and only a short option carries notional: the long
        // wing above has already done its work inside the grid.
        if (qty < 0) {
          shortNotional += spot * -qty
          anyShortOrFuture = true
        }
      } else {
        // A future is unbounded in BOTH directions — long or short, it is
        // exposure, and its `side` never gated this in the Python either.
        futuresNotional += spot * Math.abs(qty)
        anyShortOrFuture = true
      }
    }

    // No short, no future: nothing here can lose more than it cost. See header.
    if (!anyShortOrFuture) return zeroed()

    let worstChange = Number.POSITIVE_INFINITY
    let worstF = 0
    let worstVm = 1
    for (const [k, s] of scenarios.entries()) {
      const v = changes[k] ?? 0
      // STRICT `<` keeps the first cell of a tie, as Python's `min` does.
      if (v < worstChange) {
        worstChange = v
        worstF = s.f
        worstVm = s.vm
      }
    }

    // A scenario GAIN is not negative margin: the book still posts the floor.
    const span = Math.max(Math.max(0, -worstChange), minShortPct * shortNotional)
    const exposure = exposurePct * (shortNotional + futuresNotional)
    const total = span + exposure
    if (!Number.isFinite(span) || !Number.isFinite(exposure) || !Number.isFinite(total)) {
      return zeroed()
    }

    // `-0` folded away for the same reason `legs.ts` folds it on `qty`: it is a
    // STORED value here, and it survives into `Object.is`, `deepStrictEqual`
    // and any consumer that keys on the scenario. Reachable whenever the price
    // scan is zero (or negative) and the worst cell sits on a down shock.
    const priceMovePct = worstF * priceScanPct * 100

    return {
      span,
      exposure,
      total,
      worstScenario: { priceMovePct: priceMovePct === 0 ? 0 : priceMovePct, volMult: worstVm },
      shortNotional,
    }
  } catch {
    // Unreachable by design — every branch above is guarded — and kept because
    // this runs on every mark of every book: one malformed leg must cost the
    // guard a zeroed reading, not the mark loop.
    return zeroed()
  }
}
