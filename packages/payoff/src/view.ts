/**
 * THE WHOLE ANSWER — three curves, one table, and the only place in this
 * package where money already BANKED is added back in.
 *
 * Everything underneath prices the OPEN legs against their own entries and
 * nothing else, deliberately (`surface.ts`, `expiry.ts` both say so at length):
 * a payoff grid shifted by realised P&L would claim the surviving legs are
 * worth more than they can ever earn. But the question a human asks with a
 * position on is not "what are these three legs worth", it is "where does this
 * RUN break even, and how bad can the day still get" — and that question is
 * book-level. So the offset is applied HERE, once, at the boundary between the
 * pricing engine and the thing a person reads.
 *
 * WHAT REALISED TOUCHES, and what it must not:
 *
 *   shifted    every curve point, every table cell, maxProfit / maxLoss /
 *              maxLossAt / floor, the breakevens, worstShock — all of them
 *              answer "how is the run doing".
 *   NOT        `netCredit` (premium the open legs actually collected — banked
 *              money never entered it), the greeks (a derivative of price;
 *              a constant offset has none), and `pop` (see below).
 *
 * POP IS THE ONE ASYMMETRY, and it is a deliberate, ledgered one: it comes
 * straight from `buildSurface`, which computes it on the unshifted expiry
 * column, so it answers "will the OPEN LEGS finish green" rather than "will the
 * run". On a book carrying a large realised profit the two differ, and the
 * second is arguably the better chip. It is left as the port's answer because
 * the Python desk's POP is the open-legs one and a probability that silently
 * changed meaning between the two sides of the bridge is worse than one that is
 * conservative and documented. Revisit with the display, not here.
 *
 * ONE TENOR FOR THE WHOLE BOOK. Every leg is priced at the tenor of the BOOK's
 * expiry, not its own (mixed expiries are a deferred feature). A leg carrying a
 * different date is not silently re-dated into a different answer — it is
 * re-dated AND named in `warnings`, because the resulting mark is wrong rather
 * than missing, and a wrong mark that says nothing is the dangerous kind.
 *
 * Pure and fail-soft: no clock (`today` arrives as an argument), no feed,
 * nothing thrown, nothing NaN out.
 */
import type { B76Greeks } from '@algomaker/greeks'
import { legPnl, DEFAULT_RATE, type PayoffLeg } from './legs.ts'
import { expiryBreakevens, expiryPnlAt, type ExpiryBreakevens } from './expiry.ts'
import { buildSurface } from './surface.ts'

export interface PayoffViewInputs {
  /** Open legs, IVs ALREADY STAMPED (`solveChainIvs` → `ivFor`). */
  readonly legs: readonly PayoffLeg[]
  /** The FUTURE price now — the Black-76 mark, not cash spot. */
  readonly future: number
  /** The book's expiry, ISO `YYYY-MM-DD`. Every leg is priced to it. */
  readonly expiry: string
  /** The valuation date, ISO `YYYY-MM-DD`. */
  readonly today: string
  /**
   * P&L already banked by closes, rupees. Pass 0 when it is genuinely zero;
   * a caller that does not KNOW should pass 0 and warn on its own side, because
   * this module cannot tell "flat" from "unknown".
   */
  readonly realised: number
  /** The book's profit target, echoed for the chart's line. `null` when unset. */
  readonly targetPnl: number | null
  readonly rate?: number
}

/** One price on the scan, valued on all three dates. All INCLUDE realised. */
export interface PayoffPoint {
  readonly price: number
  /** Exact intrinsic payoff at expiry (no model, no vol). */
  readonly expiry: number
  /** Mark-to-market today. */
  readonly t0: number
  /** Mark-to-market halfway to expiry. */
  readonly mid: number
}

/** A price worth naming: `strike 700`, `BE 683.2`, `spot`, `+2%`, `-5%`. */
export interface PayoffRow extends PayoffPoint {
  readonly label: string
}

export interface PayoffView {
  /**
   * The dense scan: `2·60 + 1` points across ±10% of the future, LESS any
   * duplicates. Read `curve.length`; it is 121 for every real book.
   */
  readonly curve: readonly PayoffPoint[]
  /** The prices worth naming, ascending, deduped to the paisa. */
  readonly table: readonly PayoffRow[]
  /** ISO date halfway from `today` to `expiry`, in calendar days. */
  readonly midDate: string
  readonly summary: {
    /**
     * Best and worst outcome ON THE ±10% SCAN — NOT a bound on the position.
     * A short strangle's real downside is unbounded, and its worst scan point
     * is simply the scan's own edge; read these as "how bad is a 10% move",
     * never as "how bad can it get". `maxLossAt` sitting on `curve[0].price` or
     * `curve[last].price` is the tell, and it is the normal case for short
     * premium.
     */
    readonly maxProfit: number
    readonly maxLoss: number
    /** The price at which `maxLoss` happens. Ties go to the LOWER price. */
    readonly maxLossAt: number
    /** Exact (kinks method), realised-shifted, endpoint artefact removed. */
    readonly breakevens: ExpiryBreakevens
    /** Probability the OPEN LEGS finish green — see the header. */
    readonly pop: number
    /** Premium the open legs collected at entry. Realised never touches it. */
    readonly netCredit: number
    /** Worst of ±5%/±10% TODAY, plus realised. */
    readonly worstShock: number
    /** The shocked price it happens at — one of the four spot multiples. */
    readonly worstShockAt: number
    /**
     * Min of the dense expiry curve — the same number as `maxLoss`, under the
     * name the chart draws it by, and carrying the same caveat.
     */
    readonly floor: number
    /** Echo of `realised`, labelled — so a reader can see what was added. */
    readonly booked: number
    readonly targetPnl: number | null
  }
  /** Book greeks now, at the future. A constant offset has no derivative. */
  readonly greeks: B76Greeks
  readonly warnings: readonly string[]
}

/** ±10%, in 121 points — dense enough that the floor is READ, not interpolated. */
const CURVE_BAND = 0.1
const CURVE_STEPS = 60
/** The moves a desk quotes, both ways. */
const TABLE_PCTS = [1, 2, 3, 5, 8] as const
/** Two prices closer than a paisa are one row. */
const DEDUPE_TICK = 0.01
const MS_PER_DAY = 24 * 60 * 60 * 1000

const ZERO_GREEKS: B76Greeks = { delta: 0, gamma: 0, theta: 0, vega: 0 }

/**
 * UTC midnight of the DATE PART of an ISO string, or null. The THIRD copy of
 * this function in the package (`surface.ts`, `margin.ts`) and byte-identical
 * to both, deliberately: extracting a shared `clock.ts` is a follow-up that
 * touches three shipped files, and a view that parsed dates even slightly
 * differently from the surface it summarises would be the worse outcome. See
 * `surface.ts` for why the regex is anchored and why rollovers are rejected.
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

/** Calendar days over 365, floored at zero — the same clock the surface runs. */
function yearFrac(fromMs: number, toMs: number): number {
  return Math.max(0, (toMs - fromMs) / MS_PER_DAY / 365)
}

function isoOfMs(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

/** Rupees/prices as a human writes them: two decimals, no trailing zeros. */
function fmt(x: number): string {
  return String(Math.round(x * 100) / 100)
}

function emptyView(warnings: readonly string[], booked: number, target: number | null): PayoffView {
  return {
    curve: [],
    table: [],
    midDate: '',
    summary: {
      maxProfit: 0,
      maxLoss: 0,
      maxLossAt: 0,
      breakevens: { down: null, up: null },
      pop: 0,
      netCredit: 0,
      worstShock: 0,
      worstShockAt: 0,
      floor: 0,
      booked,
      targetPnl: target,
    },
    greeks: { ...ZERO_GREEKS },
    warnings,
  }
}

/** A named candidate price for the table, in the order priority is resolved. */
interface Candidate {
  readonly price: number
  readonly label: string
}

export function buildPayoffView(i: PayoffViewInputs): PayoffView {
  const warnings: string[] = []
  // Sanitised up front so the empty-view exits can still echo them: a book that
  // failed to price has not un-banked its realised P&L or lost its target.
  // `=== 0 ? 0` folds NEGATIVE zero away: it is a stored value here (it reaches
  // JSON, `Object.is` and every consumer keyed on the summary), and `legs.ts`
  // folds it for the same reason.
  const raw = Number.isFinite(i?.realised) ? (i.realised as number) : 0
  const booked = raw === 0 ? 0 : raw
  const target = Number.isFinite(i?.targetPnl) ? (i.targetPnl as number) : null

  try {
    if (i === null || typeof i !== 'object') {
      return emptyView(['no inputs'], 0, null)
    }
    if (!Number.isFinite(i.realised)) {
      warnings.push(`realised P&L "${i.realised}" is unreadable: treated as nothing banked`)
    }

    const rawLegs = i.legs ?? []
    const legs = rawLegs.filter((l): l is PayoffLeg => l !== null && typeof l === 'object')
    if (legs.length !== rawLegs.length) {
      warnings.push(`${rawLegs.length - legs.length} leg(s) were not objects and were dropped`)
    }

    let rate = i.rate ?? DEFAULT_RATE
    if (!Number.isFinite(rate)) {
      warnings.push(`unusable rate ${rate}: priced at ${DEFAULT_RATE}`)
      rate = DEFAULT_RATE
    }

    const future = i.future
    const today = i.today
    const expiry = i.expiry
    if (legs.length === 0) return emptyView([...warnings, 'no legs: nothing to price'], booked, target)
    if (!Number.isFinite(future) || future <= 0) {
      return emptyView([...warnings, `unusable future: ${future}`], booked, target)
    }
    const todayMs = isoDayMs(today)
    const expiryMs = isoDayMs(expiry)
    if (todayMs === null) {
      return emptyView([...warnings, `valuation date "${today}" is not an ISO date`], booked, target)
    }
    if (expiryMs === null) {
      return emptyView([...warnings, `expiry "${expiry}" is not an ISO date`], booked, target)
    }

    // An expiry already behind the valuation date prices EVERY leg at
    // intrinsic, on all three curves at once — a mark that is wrong rather than
    // missing, and identical in shape to a live book that happens to be pinned.
    // Named, because nothing else about the answer would give it away.
    if (expiryMs < todayMs) {
      warnings.push(`expiry ${expiry} is before the valuation date ${today}: everything marks at intrinsic`)
    }

    // Halfway, in whole calendar days, floored toward TODAY on an odd span —
    // the near side is where the desk actually sits, and a half-day is not a
    // date anyone can name.
    const spanDays = Math.max(0, Math.round((expiryMs - todayMs) / MS_PER_DAY))
    const midMs = todayMs + Math.floor(spanDays / 2) * MS_PER_DAY
    const midDate = isoOfMs(midMs)

    const tNow = yearFrac(todayMs, expiryMs)
    const tMid = yearFrac(midMs, expiryMs)

    // ONE TENOR FOR THE BOOK (see the header). Re-dating is silent in the
    // arithmetic and loud in the warnings.
    const priced: PayoffLeg[] = []
    for (const leg of legs) {
      if (isoDayMs(leg.expiry) !== expiryMs) {
        warnings.push(
          `leg "${leg.id}": expiry "${leg.expiry}" is not the book's ${expiry}; priced at the book tenor`,
        )
        priced.push({ ...leg, expiry })
        continue
      }
      if (leg.instrument === 'option' && (leg.iv === null || !Number.isFinite(leg.iv))) {
        warnings.push(`leg "${leg.id}": no IV; it marks flat until expiry`)
      }
      priced.push(leg)
    }

    const markAt = (price: number, t: number): number => {
      let total = 0
      for (const leg of priced) {
        const p = legPnl(leg, price, t, rate)
        if (Number.isFinite(p)) total += p
      }
      return total
    }
    const pointAt = (price: number): PayoffPoint => ({
      price,
      expiry: expiryPnlAt(priced, price) + booked,
      t0: markAt(price, tNow) + booked,
      mid: markAt(price, tMid) + booked,
    })

    // De-duplicated for the same reason the surface's ladder is: with a real
    // future and a fixed band all 121 are distinct, but a denormal future would
    // collapse them and a chart with repeated x-values draws a vertical line.
    const scan = [
      ...new Set(
        Array.from(
          { length: 2 * CURVE_STEPS + 1 },
          (_, k) => future * (1 + CURVE_BAND * ((k - CURVE_STEPS) / CURVE_STEPS)),
        ),
      ),
    ].sort((a, b) => a - b)
    const curve = scan.map(pointAt)

    let maxProfit = -Infinity
    let maxLoss = Infinity
    let maxLossAt = future
    for (const p of curve) {
      if (p.expiry > maxProfit) maxProfit = p.expiry
      // Strict `<` keeps the FIRST (lowest) price on a tie — a symmetric book
      // has two equal floors and the answer must not depend on scan direction.
      if (p.expiry < maxLoss) {
        maxLoss = p.expiry
        maxLossAt = p.price
      }
    }
    if (!Number.isFinite(maxProfit)) maxProfit = 0
    if (!Number.isFinite(maxLoss)) maxLoss = 0

    // Exact, from the kinks — not the surface's grid-bracketed crossings, which
    // can only ever be as accurate as one ladder step.
    let breakevens = expiryBreakevens(priced, future, booked)

    // THE 3x ENDPOINT GUARD (ledgered from the expiry port).
    //
    // `expiryBreakevens` walks the kinks plus two synthetic endpoints, the
    // upper one at `3 × max(maxStrike, spot)`. When the payoff is flat at
    // EXACTLY zero out there — a leg sold for nothing, or a realised figure that
    // happens to cancel it — the Python reports that endpoint as an upside
    // breakeven, and the port copies it faithfully for parity (expiry.ts:129).
    // It is an artefact of where the scan stopped, not a level any desk
    // defends, and this is the display boundary, so it stops here: an up-side
    // crossing at or beyond the scan's own far edge is reported as UNBOUNDED
    // (null) with the discarded number named, never silently dropped.
    //
    // The threshold is the far edge itself and not, say, the ±10% chart edge:
    // a genuine upside breakeven above +10% is completely ordinary (any short
    // call whose credit exceeds a tenth of spot has one) and nulling it would
    // erase a real defence line. Only the 3× endpoint can reach 3×.
    const strikes = priced
      .map((l) => l.strike)
      .filter((s): s is number => s !== null && Number.isFinite(s))
    if (strikes.length > 0 && breakevens.up !== null) {
      const farEdge = Math.max(Math.max(...strikes), future) * 3
      if (breakevens.up >= farEdge) {
        warnings.push(
          `upside breakeven ${fmt(breakevens.up)} is the payoff scan's far edge, not a crossing: reported as unbounded`,
        )
        breakevens = { down: breakevens.down, up: null }
      }
    }

    // The table, in PRIORITY order — first label to claim a price keeps it.
    // Spot outranks everything because it is the one row a reader looks for by
    // name; a breakeven outranks a strike because it is the level being
    // defended; a strike outranks a round percentage because it is a real
    // contract. Only then the ±% ladder.
    //
    // A collision costs the LOWER-priority label, not the row: a breakeven
    // landing on a strike (a leg sold for nothing) leaves one row at that price
    // labelled `BE …`. The price is still in the table and still carries all
    // three values, which is what the table is for.
    const candidates: Candidate[] = [{ price: future, label: 'spot' }]
    if (breakevens.down !== null) {
      candidates.push({ price: breakevens.down, label: `BE ${fmt(breakevens.down)}` })
    }
    if (breakevens.up !== null) {
      candidates.push({ price: breakevens.up, label: `BE ${fmt(breakevens.up)}` })
    }
    for (const k of [...new Set(strikes)].sort((a, b) => a - b)) {
      candidates.push({ price: k, label: `strike ${fmt(k)}` })
    }
    for (const pct of [...TABLE_PCTS].sort((a, b) => b - a)) {
      candidates.push({ price: future * (1 - pct / 100), label: `-${pct}%` })
    }
    for (const pct of TABLE_PCTS) {
      candidates.push({ price: future * (1 + pct / 100), label: `+${pct}%` })
    }

    const taken: Candidate[] = []
    for (const c of candidates) {
      if (!Number.isFinite(c.price) || c.price <= 0) continue
      if (taken.some((t) => Math.abs(t.price - c.price) < DEDUPE_TICK)) continue
      taken.push(c)
    }
    const table: PayoffRow[] = taken
      .sort((a, b) => a.price - b.price)
      .map((c) => ({ ...pointAt(c.price), label: c.label }))

    // The summary fields that are not a reduction of the dense curve come from
    // the surface, re-priced on the SAME three dates the curve uses so the two
    // cannot describe different books. Its grid is coarser (21 points) but
    // every field taken from it is a point value or a probability, not a floor.
    const surface = buildSurface({
      legs: priced,
      spot: future,
      dates: [today, midDate, expiry],
      rate,
    })
    warnings.push(...surface.warnings)

    return {
      curve,
      table,
      midDate,
      summary: {
        maxProfit,
        maxLoss,
        maxLossAt,
        breakevens,
        pop: surface.pop,
        netCredit: surface.netCredit,
        worstShock: surface.worstShock + booked,
        // Realised is a constant shift: it moves the figure, never the argmin.
        worstShockAt: surface.worstShockAt,
        floor: maxLoss,
        booked,
        targetPnl: target,
      },
      greeks: surface.greeks,
      warnings,
    }
  } catch (err) {
    // Unreachable by design; kept because this is what a live dashboard polls
    // every few seconds, and one unpriceable book must cost that poll a warning
    // rather than the whole page.
    return emptyView(
      [...warnings, `payoff view failed: ${err instanceof Error ? err.message : err}`],
      booked,
      target,
    )
  }
}
