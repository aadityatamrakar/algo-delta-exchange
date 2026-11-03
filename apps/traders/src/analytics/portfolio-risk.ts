/**
 * The Risk page's view (`RiskView`, spec 2026-10-24-traders-risk-design.md R2–R8): every held book's beta and
 * correlation to NIFTY, the stress grid of NIFTY moves × vol shifts, the historical replay of today's books through
 * the past year's daily returns, each book's share of the 2σ day loss, the correlated clusters, and the one-line
 * headline. Pure over its inputs: the route (routes/risk.ts) reads the snapshots, deltas, vols and bars.
 *
 * Every rupee figure is a full reprice through `shockBook` (one call per book, every shock in it) and a CHANGE from
 * the book's value now (R1). The one linear figure is `betaDeltaRupees` (R2). A stock moves by beta × the NIFTY move
 * in the grid (R4), by its own return in the replay (R5), by ±2σ of a day on its own in the concentration (R6), and
 * all members at once in a cluster (R7). A figure that cannot be computed is null with a warning saying why.
 */

import { FEED_NOT_TICKING } from '../market/quotes.ts'
import { MAX_DAYS, MIN_DAYS, alignedReturns, betaOf, clustersOf, pairOf, percentile, type Close, type PairStats } from './returns.ts'
import type { CorrelatedCluster, HistoricalReplay, RiskBook, RiskView, StressGrid } from './risk-wire.ts'
import { shockBook, type Shock } from './shock.ts'
import { MARKET_CLOSED, type BookSnapshot } from './snapshot.ts'

/** NIFTY moves, percent (R4). */
export const GRID_MOVES: readonly number[] = [-10, -5, -3, -1, 0, 1, 3, 5, 10]
/** Vol points added to every option's IV (R4). */
export const GRID_VOLS: readonly number[] = [-5, 0, 5, 10]
/** The replay's fixed sentences (R5). */
export const REPLAY_NOTES: readonly string[] = [
  'Vol unchanged: each past day moves the prices only.',
  "Today's legs: the books as they stand now, not as they were held that day.",
  'One day: each figure is one close-to-close move.',
]
export const NIFTY = 'NIFTY'
const TRADING_DAYS = 252

export interface RiskBookInput {
  /** The book's minute snapshot (an admin's aggregate: every trader's legs of the stock priced as one book). */
  readonly snapshot: BookSnapshot
  /** The book view's net delta, shares (summed over the traders for the aggregate); null when no view. */
  readonly deltaShares: number | null
  /** The market context's HV20 and near-tenor ATM IV, decimals. */
  readonly hv20: number | null
  readonly nearIv: number | null
  /** The stock's daily bars, oldest → newest (HistoryStore.bars(stock, 260)); NIFTY's own for the NIFTY book. */
  readonly bars: readonly Close[]
}

export interface RiskInput {
  readonly asOf: number
  readonly trader: string | null
  readonly books: readonly RiskBookInput[]
  readonly nifty: { readonly bars: readonly Close[]; readonly spot: number | null; readonly lotSize: number | null }
  readonly warnings?: readonly string[]
}

const num = (x: number | null | undefined): x is number => typeof x === 'number' && Number.isFinite(x)
const pos = (x: number | null | undefined): x is number => num(x) && x > 0
/** Σ of the known values; null when none is known. */
const sumKnown = (xs: readonly (number | null)[]): number | null => {
  const k = xs.filter(num)
  return k.length === 0 ? null : k.reduce((a, b) => a + b, 0)
}

const RUPEES = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 })
/** "−₹4,12,000" / "+₹12,000" / "₹0": whole rupees, Indian grouping, a real minus sign. */
export function rupees(x: number): string {
  const r = Math.round(x)
  return `${r < 0 ? '−' : r > 0 ? '+' : ''}₹${RUPEES.format(Math.abs(r))}`
}
const signed = (x: number): string => (x < 0 ? `−${Math.abs(x)}` : x > 0 ? `+${x}` : '0')

/** The worst grid cell as one sentence (R8): "NIFTY −5% with vol +5: −₹4,12,000, most from BHEL". */
function headlineOf(g: StressGrid): string | null {
  let at: { i: number; j: number; v: number } | null = null
  g.cells.forEach((row, i) => row.forEach((v, j) => { if (v !== null && (at === null || v < at.v)) at = { i, j, v } }))
  if (at === null) return null
  const { i, j, v } = at as { i: number; j: number; v: number }
  const move = g.moves[i] as number
  const vol = g.vols[j] as number
  const book = g.worst[i]?.[j] ?? null
  const what = `NIFTY ${move === 0 ? 'unchanged' : `${signed(move)}%`} with vol ${vol === 0 ? 'unchanged' : signed(vol)}`
  return `${what}: ${rupees(v)}${book === null ? ', no book loses' : `, most from ${book}`}`
}

/** One book's shocks laid out in one list: the grid (moves × vols), ±1% NIFTY, ±2σ, then the replay days. */
interface Plan {
  readonly shocks: Shock[]
  readonly grid: number | null
  readonly one: number | null
  readonly two: number | null
  readonly replay: number | null
}

function planOf(beta: number | null, sigma: number | null, replay: readonly number[] | null): Plan {
  const shocks: Shock[] = []
  const at = (): number => shocks.length
  const add = (spotFactor: number, volPts = 0): void => { shocks.push({ spotFactor, volPts, at: null }) }
  let grid: number | null = null
  let one: number | null = null
  let two: number | null = null
  let rp: number | null = null
  if (beta !== null) {
    grid = at()
    for (const m of GRID_MOVES) for (const v of GRID_VOLS) add(1 + (beta * m) / 100, v)
    one = at()
    add(1 + beta / 100)
    add(1 - beta / 100)
  }
  if (sigma !== null) {
    two = at()
    add(1 + 2 * sigma)
    add(1 - 2 * sigma)
  }
  if (replay !== null) {
    rp = at()
    for (const r of replay) add(Math.exp(r))
  }
  return { shocks, grid, one, two, replay: rp }
}

export function buildRiskView(input: RiskInput): RiskView {
  const top: string[] = [...(input.warnings ?? [])]
  const books = [...input.books].sort((a, b) => (a.snapshot.stock < b.snapshot.stock ? -1 : a.snapshot.stock > b.snapshot.stock ? 1 : 0))
  const stocks = books.map((b) => b.snapshot.stock)
  const niftyBars = input.nifty.bars
  if (books.some((b) => b.snapshot.closed)) top.push(MARKET_CLOSED)
  else if (books.some((b) => b.snapshot.warnings.includes(FEED_NOT_TICKING))) top.push(FEED_NOT_TICKING)
  if (books.length > 0 && niftyBars.length === 0) top.push('No NIFTY history: no beta, so no stress grid and no ±1% figures.')

  // beta and correlation to NIFTY (R3); NIFTY's own beta is 1
  const ownDays = books.map((b) => alignedReturns([b.bars]).dates.length)
  const stats: PairStats[] = books.map((b, k) =>
    b.snapshot.stock === NIFTY ? { beta: 1, corr: 1, days: Math.min(ownDays[k] as number, MAX_DAYS) } : betaOf(b.bars, niftyBars))

  // the replay's days: every held stock with ≥ 60 returns and a spot, aligned (R5)
  const inReplay = books.flatMap((b, k) => ((ownDays[k] as number) >= MIN_DAYS && b.snapshot.spot !== null ? [k] : []))
  const joint = alignedReturns(inReplay.map((k) => (books[k] as RiskBookInput).bars))
  const replayOn = inReplay.length > 0 && joint.dates.length >= MIN_DAYS
  const replayRow = new Map(inReplay.map((k, n) => [k, n]))

  const rows: RiskBook[] = []
  const results: { plan: Plan; changes: readonly (number | null)[] }[] = []
  books.forEach((b, k) => {
    const s = b.snapshot
    const st = stats[k] as PairStats
    const w: string[] = []
    if (st.beta === null) w.push(`${s.stock}: beta needs ${MIN_DAYS} days of returns aligned with NIFTY; ${st.days} held`)
    let sigma: number | null = null
    if (pos(b.hv20)) sigma = b.hv20 / Math.sqrt(TRADING_DAYS)
    else if (pos(b.nearIv)) {
      sigma = b.nearIv / Math.sqrt(TRADING_DAYS)
      w.push(`${s.stock}: no HV20 — the day's σ is the near ATM IV's`)
    } else w.push(`${s.stock}: no HV20 and no near ATM IV — no 2σ loss`)
    const replayIdx = replayRow.get(k)
    const replay = replayOn && replayIdx !== undefined ? (joint.returns[replayIdx] as readonly number[]) : null
    if ((ownDays[k] as number) < MIN_DAYS) w.push(`${s.stock}: under ${MIN_DAYS} days of history — left out of the replay`)

    const plan = planOf(st.beta, sigma, replay)
    const shocked = shockBook(s, plan.shocks)
    results.push({ plan, changes: shocked.changes })
    const at = (base: number | null, n: number): number | null => (base === null ? null : shocked.changes[base + n] ?? null)
    const up2 = at(plan.two, 0)
    const down2 = at(plan.two, 1)
    if (b.deltaShares === null) w.push(`${s.stock}: no book view — no delta`)
    const deltaRupees = num(b.deltaShares) && s.spot !== null ? b.deltaShares * s.spot : null
    w.push(...shocked.warnings, ...s.warnings.filter((x) => x !== MARKET_CLOSED && x !== FEED_NOT_TICKING))
    rows.push({
      stock: s.stock, beta: st.beta, betaDays: st.days, niftyCorr: st.corr,
      deltaShares: b.deltaShares, deltaRupees, betaDeltaRupees: deltaRupees !== null && st.beta !== null ? deltaRupees * st.beta : null,
      niftyUp1: at(plan.one, 0), niftyDown1: at(plan.one, 1), daySigma: sigma,
      twoSigmaLoss: up2 !== null && down2 !== null ? Math.min(up2, down2, 0) : null,
      sharePct: null, warnings: [...new Set(w)],
    })
  })

  // concentration (R6): each book's share of the summed 2σ loss
  const lossSum = sumKnown(rows.map((r) => r.twoSigmaLoss))
  const withShare = rows.map((r): RiskBook => ({
    ...r, sharePct: r.twoSigmaLoss !== null && lossSum !== null && lossSum < 0 ? (r.twoSigmaLoss / lossSum) * 100 : null,
  }))

  // the stress grid (R4)
  const excluded: { stock: string; why: string }[] = []
  books.forEach((b, k) => {
    const s = b.snapshot
    const r = results[k] as (typeof results)[number]
    if (s.spot === null) excluded.push({ stock: s.stock, why: 'no spot price' })
    else if ((stats[k] as PairStats).beta === null) excluded.push({ stock: s.stock, why: `no beta (under ${MIN_DAYS} days aligned with NIFTY)` })
    else if (r.plan.grid === null || r.changes.slice(r.plan.grid, r.plan.grid + GRID_MOVES.length * GRID_VOLS.length).every((c) => c === null)) {
      excluded.push({ stock: s.stock, why: 'cannot be repriced' })
    }
  })
  const out = new Set(excluded.map((e) => e.stock))
  const cells: (number | null)[][] = []
  const worst: (string | null)[][] = []
  const partial = new Set<string>()
  GRID_MOVES.forEach((_, i) => {
    const crow: (number | null)[] = []
    const wrow: (string | null)[] = []
    GRID_VOLS.forEach((_, j) => {
      let sum: number | null = null
      let lose: { stock: string; v: number } | null = null
      books.forEach((b, k) => {
        const r = results[k] as (typeof results)[number]
        if (out.has(b.snapshot.stock) || r.plan.grid === null) return
        const c = r.changes[r.plan.grid + i * GRID_VOLS.length + j] ?? null
        if (c === null) { partial.add(b.snapshot.stock); return }
        sum = (sum ?? 0) + c
        if (c < 0 && (lose === null || c < lose.v)) lose = { stock: b.snapshot.stock, v: c }
      })
      crow.push(sum)
      wrow.push((lose as { stock: string } | null)?.stock ?? null)
    })
    cells.push(crow)
    worst.push(wrow)
  })
  for (const s of partial) top.push(`${s}: left out of the grid cells it could not be valued in`)
  const grid: StressGrid = { moves: GRID_MOVES, vols: GRID_VOLS, cells, worst, excluded }

  // the historical replay (R5)
  const jointDays = inReplay.length === 0 ? 0 : joint.dates.length
  let replay: HistoricalReplay = { days: jointDays, var95: null, var99: null, es99: null, worstDays: [], notes: REPLAY_NOTES }
  if (books.length > 0 && !replayOn) {
    top.push(`Historical replay needs ${MIN_DAYS} days on which every held stock has a return; ${jointDays} held`)
  }
  if (replayOn) {
    const niftyClose = new Map(niftyBars.filter((x) => pos(x.close)).map((x) => [x.date, x.close]))
    const parts = joint.dates.map((_, t) => inReplay.flatMap((k, n) => {
      const r = results[k] as (typeof results)[number]
      const c = r.plan.replay === null ? null : r.changes[r.plan.replay + t] ?? null
      return c === null ? [] : [{ stock: (books[k] as RiskBookInput).snapshot.stock, change: c, movePct: (Math.exp((joint.returns[n] as number[])[t] as number) - 1) * 100 }]
    }))
    const sums = parts.map((p) => p.reduce((a, x) => a + x.change, 0))
    const var95 = percentile(sums, 5)
    const var99 = percentile(sums, 1)
    const tail = var99 === null ? [] : sums.filter((x) => x <= var99)
    const order = sums.map((v, t) => ({ v, t })).sort((a, b) => a.v - b.v).slice(0, 3)
    replay = {
      days: joint.dates.length, var95, var99, es99: tail.length === 0 ? null : tail.reduce((a, b) => a + b, 0) / tail.length,
      worstDays: order.map(({ v, t }) => {
        const date = joint.dates[t] as string
        const from = niftyClose.get(joint.starts[t] as string)
        const to = niftyClose.get(date)
        return {
          date, change: v, niftyPct: from !== undefined && to !== undefined ? (to / from - 1) * 100 : null,
          books: [...(parts[t] ?? [])].sort((a, b) => a.change - b.change),
        }
      }),
      notes: REPLAY_NOTES,
    }
    const unpriced = inReplay.filter((k) => {
      const r = results[k] as (typeof results)[number]
      return r.plan.replay === null || r.changes.slice(r.plan.replay, r.plan.replay + joint.dates.length).every((c) => c === null)
    })
    for (const k of unpriced) top.push(`${(books[k] as RiskBookInput).snapshot.stock}: cannot be repriced — left out of the replay`)
  }

  // pairwise correlation and the clusters (R7)
  const matrix = books.map((a, i) => books.map((b, j): number | null => {
    if (i === j) return (ownDays[i] as number) >= MIN_DAYS ? 1 : null
    const { returns } = alignedReturns([a.bars, b.bars])
    return pairOf(returns[0] ?? [], returns[1] ?? []).corr
  }))
  const clusters: CorrelatedCluster[] = clustersOf(matrix).map((members) => {
    const pairs: number[] = []
    for (let x = 0; x < members.length; x++) for (let y = x + 1; y < members.length; y++) {
      const c = matrix[members[x] as number]?.[members[y] as number] ?? null
      if (c !== null) pairs.push(c)
    }
    const up = sumKnown(members.map((k) => { const r = results[k] as (typeof results)[number]; return r.plan.two === null ? null : r.changes[r.plan.two] ?? null }))
    const down = sumKnown(members.map((k) => { const r = results[k] as (typeof results)[number]; return r.plan.two === null ? null : r.changes[r.plan.two + 1] ?? null }))
    return {
      stocks: members.map((k) => stocks[k] as string),
      meanCorr: pairs.reduce((a, b) => a + b, 0) / Math.max(1, pairs.length),
      togetherLoss: Math.min(up ?? 0, down ?? 0, 0),
      standaloneLoss: sumKnown(members.map((k) => (withShare[k] as RiskBook).twoSigmaLoss)) ?? 0,
    }
  })

  // totals: the β-weighted delta in rupees and NIFTY lots, and NIFTY ±1%
  const betaDelta = sumKnown(withShare.map((r) => r.betaDeltaRupees))
  const missing = withShare.filter((r) => r.betaDeltaRupees === null).map((r) => r.stock)
  if (books.length > 0 && missing.length > 0) top.push(`β-weighted Δ and NIFTY ±1% leave out ${missing.join(', ')}`)
  const lotValue = pos(input.nifty.spot) && pos(input.nifty.lotSize) ? input.nifty.spot * input.nifty.lotSize : null
  return {
    asOf: input.asOf, trader: input.trader,
    nifty: { spot: pos(input.nifty.spot) ? input.nifty.spot : null, lotSize: pos(input.nifty.lotSize) ? input.nifty.lotSize : null },
    books: withShare,
    totals: {
      betaDeltaRupees: betaDelta, niftyLots: betaDelta !== null && lotValue !== null ? betaDelta / lotValue : null,
      niftyUp1: sumKnown(withShare.map((r) => r.niftyUp1)), niftyDown1: sumKnown(withShare.map((r) => r.niftyDown1)),
    },
    grid, replay, correlation: { stocks, matrix }, clusters, headline: headlineOf(grid), warnings: [...new Set(top)],
  }
}
