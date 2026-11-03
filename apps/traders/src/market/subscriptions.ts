// The traders app's demand on the live feed, declared the way the desk's hosted
// runner declares its own: one `desk-subscriptions` document {source:'traders'},
// rewritten whole every 15 s. desk-marketdata is unchanged; it unions what is
// declared. Per underlying over every trader's OPEN legs: spot, the nearest
// listed future (held or not), each held expiry's future (an index weekly has
// none), every held leg's token, and ATM +/- 15 listed strikes per held expiry.
// Expired legs are never declared; a stock whose legs have all expired keeps
// its spot and nearest future for 3 days after its last expiry, then drops out.
// Not the full chain.
//
// These tokens join the desk's Kite feed pool, so the declaration is capped
// (TRADERS_MAX_TOKENS, default 2000). Over the cap the ATM windows narrow to
// 10, then 5, then 0 strikes each side (the at-the-money strike only), far
// months before near at each step. Spots, futures and held strikes are never
// dropped: if they alone are over the cap they are declared anyway, loudly.
// Other token sources (Market Watch's on-screen chains) yield to the books
// (Ruling R3-18): they are declared only when they fit under the cap beside
// the books' full windows, so they never narrow a book's window nor push the
// declaration past the cap.
import type { TradersDb } from '../db.ts'
import { isOpenLeg } from '../types.ts'
import type { TraderLeg } from '../types.ts'
import type { Log } from '../routes/kit.ts'
import { matchLeg, nearestFuture, spotTokenOf } from './master.ts'
import type { TradersMaster } from './master.ts'

export const DECLARE_EVERY_MS = 15_000
export const ATM_WINDOW = 15
export const DEFAULT_MAX_TOKENS = 2000
/** The narrower windows tried in turn, strikes each side of the money, when the declaration is over the cap. */
export const TRIM_STEPS: readonly number[] = [10, 5, 0]
/** Calendar days a stock whose legs have all expired is still declared after its last expiry. */
export const EXPIRED_KEEP_DAYS = 3

const DAY_MS = 86_400_000

function windowTokens(m: TradersMaster, stock: string, expiry: string, ref: number | null, width: number): number[] {
  if (ref === null) return []
  const strikes = m.options.strikes(stock, expiry)
  const atm = m.options.atmStrike(stock, expiry, ref)
  if (atm === null) return []
  const i = strikes.indexOf(atm)
  const out: number[] = []
  for (const k of strikes.slice(Math.max(0, i - width), i + width + 1)) {
    for (const t of ['CE', 'PE'] as const) {
      const ref2 = m.options.resolve(stock, expiry, k, t)
      if (ref2?.instrumentToken !== undefined) out.push(ref2.instrumentToken)
    }
  }
  return out
}

/** One held month's ATM window, at any width. */
interface MonthWindow { readonly stock: string; readonly expiry: string; readonly at: (width: number) => number[] }

/** What the legs want: tokens never trimmed (spots, futures, held legs) and one ATM window per held month. */
function demandOf(
  legs: readonly TraderLeg[], m: TradersMaster, priceOf: (token: number) => number | null, today: string,
): { core: Set<number>; windows: MonthWindow[] } {
  const byStock = new Map<string, { open: TraderLeg[]; lastExpiry: string }>()
  for (const l of legs) {
    if (l.qty === 0) continue
    const b = byStock.get(l.stock) ?? { open: [], lastExpiry: '' }
    byStock.set(l.stock, b)
    if (isOpenLeg(l, today)) b.open.push(l)
    else if (l.expiry > b.lastExpiry) b.lastExpiry = l.expiry
  }
  const core = new Set<number>()
  const windows: MonthWindow[] = []
  for (const [stock, { open, lastExpiry }] of byStock) {
    // A book whose legs have all expired still wants its spot and nearest future, for a few days.
    if (open.length === 0 && Date.parse(today) - Date.parse(lastExpiry) >= EXPIRED_KEEP_DAYS * DAY_MS) continue
    const spot = spotTokenOf(m, stock)
    if (spot !== null) core.add(spot)
    const nearest = nearestFuture(m, stock, today)
    if (nearest?.instrumentToken !== undefined) core.add(nearest.instrumentToken)
    const spotPrice = spot === null ? null : priceOf(spot)
    const byExpiry = new Map<string, TraderLeg[]>()
    for (const l of open) {
      if (l.instrument === 'share') continue
      const list = byExpiry.get(l.expiry)
      if (list === undefined) byExpiry.set(l.expiry, [l])
      else list.push(l)
    }
    for (const [expiry, held] of byExpiry) {
      const fut = m.options.future(stock, expiry)
      if (fut?.instrumentToken !== undefined) core.add(fut.instrumentToken)
      for (const l of held) {
        const t = l.token ?? matchLeg(m, l)
        if (t !== null) core.add(t)
      }
      const strikes = held.flatMap((l) => (l.strike === null ? [] : [l.strike]))
      const futPrice = fut?.instrumentToken === undefined ? null : priceOf(fut.instrumentToken)
      const ref = spotPrice ?? futPrice ?? (strikes.length === 0 ? null : strikes.reduce((a, b) => a + b, 0) / strikes.length)
      windows.push({ stock, expiry, at: (width) => windowTokens(m, stock, expiry, ref, width) })
    }
  }
  return { core, windows }
}

export interface TokenPlan {
  /** What to declare, ascending. */
  readonly tokens: number[]
  /** How many tokens the books' full windows would have taken (spots, futures, held strikes, ATM +/- 15); other sources not counted. */
  readonly wanted: number
  /** `wanted` was over the cap, so windows were narrowed. */
  readonly capHit: boolean
  /** Even at 0 strikes each side the never-dropped tokens are over the cap; they are declared anyway. */
  readonly overCap: boolean
  /** Underlyings with a window narrower than ATM +/- 15. */
  readonly trimmed: ReadonlySet<string>
  /** `extra` was left out: beside the books' full windows it would not fit under the cap. */
  readonly extraDropped: boolean
  /** How many of `extra`'s tokens the books do not already declare. */
  readonly extraFresh: number
}

/**
 * The declaration for these legs under `cap`. `extra` (other token sources)
 * yields to the books: it is declared whole when it fits under the cap beside
 * the books' full windows, else not at all, so it never narrows a window.
 */
export function planTokens(
  legs: readonly TraderLeg[], m: TradersMaster, priceOf: (token: number) => number | null, today: string,
  o: { cap: number; extra?: Iterable<number> },
): TokenPlan {
  const { core, windows } = demandOf(legs, m, priceOf, today)
  // How many reasons each token has to be declared: a window may share tokens with the core or another window.
  const refs = new Map<number, number>()
  const add = (ts: Iterable<number>) => { for (const t of ts) refs.set(t, (refs.get(t) ?? 0) + 1) }
  const remove = (ts: Iterable<number>) => {
    for (const t of ts) { const n = (refs.get(t) ?? 0) - 1; if (n > 0) refs.set(t, n); else refs.delete(t) }
  }
  add(core)
  const current = windows.map((w) => w.at(ATM_WINDOW))
  const full = current.map((ts) => ts.length)
  for (const ts of current) add(ts)
  const wanted = refs.size
  const fresh = new Set<number>()
  for (const t of o.extra ?? []) if (!refs.has(t)) fresh.add(t)
  const extraDropped = fresh.size > 0 && wanted + fresh.size > o.cap
  if (!extraDropped) add(fresh)
  const trimmed = new Set<string>()
  // Far months first; one month at a time, so the cap is met with as little narrowing as it needs.
  const order = windows.map((_, i) => i)
    .sort((a, b) => (windows[b]!.expiry).localeCompare(windows[a]!.expiry) || windows[a]!.stock.localeCompare(windows[b]!.stock))
  narrow: for (const width of TRIM_STEPS) {
    for (const i of order) {
      if (refs.size <= o.cap) break narrow
      const next = windows[i]!.at(width)
      add(next); remove(current[i]!); current[i] = next
      if (next.length < full[i]!) trimmed.add(windows[i]!.stock)
    }
  }
  return {
    tokens: [...refs.keys()].sort((a, b) => a - b), wanted, capHit: wanted > o.cap, overCap: refs.size > o.cap, trimmed,
    extraDropped, extraFresh: fresh.size,
  }
}

/** The uncapped declaration for these legs. */
export function wantedTokens(
  legs: readonly TraderLeg[], m: TradersMaster, priceOf: (token: number) => number | null, today: string,
): number[] {
  return planTokens(legs, m, priceOf, today, { cap: Infinity }).tokens
}

export interface Declarer {
  /**
   * Another part of the app's on-screen set (Market Watch). A source that throws is logged and its
   * last good output is used for that cycle (a source that never succeeded contributes nothing), so
   * an error never shrinks the published declaration.
   */
  addTokenSource(name: string, fn: (nowMs: number) => readonly number[]): void
  /** Build and publish now; failures are logged, never thrown. */
  refreshNow(): Promise<readonly number[]>
  last(): DeclaredState
  stop(): void
}

/** The last published declaration: how many tokens, when, and whether the cap narrowed it (and for which underlyings). */
export interface DeclaredState {
  readonly count: number
  readonly at: number | null
  readonly capHit: boolean
  readonly trimmed: ReadonlySet<string>
  /** The books' own full-window demand (`TokenPlan.wanted`): TRADERS_MAX_TOKENS less this is the room other sources have. */
  readonly bookDemand: number
}

export const NOTHING_DECLARED: DeclaredState = { count: 0, at: null, capHit: false, trimmed: new Set(), bookDemand: 0 }

const istDay = (ms: number): string => new Date(ms + 330 * 60_000).toISOString().slice(0, 10)

export function startDeclaring(d: {
  db: TradersDb
  legs: () => Promise<readonly TraderLeg[]>
  master: () => TradersMaster
  priceOf: (token: number) => number | null
  now: () => number
  log: Log
  everyMs?: number
  /** TRADERS_MAX_TOKENS. */
  maxTokens?: number
}): Declarer {
  const cap = d.maxTokens ?? DEFAULT_MAX_TOKENS
  const sources = new Map<string, (nowMs: number) => readonly number[]>()
  const lastGood = new Map<string, readonly number[]>()
  let state: DeclaredState = NOTHING_DECLARED
  let logged = ''   // the trim outcome last logged: logged when it starts, changes or ends, not every 15 s
  let extraLeftOut = false   // likewise whether other sources were left out

  function logTrim(p: TokenPlan): void {
    const trimmed = [...p.trimmed].sort()
    const outcome = p.overCap ? 'over' : p.capHit ? `trim:${trimmed.join(',')}` : ''
    if (outcome !== logged) {
      if (p.overCap) {
        d.log('TRADERS FEED CAP EXCEEDED: spots, futures and held strikes alone are over TRADERS_MAX_TOKENS; declared anyway',
          { cap, wanted: p.wanted, declared: p.tokens.length, trimmed })
      } else if (p.capHit) {
        d.log('traders feed cap reached: ATM windows narrowed', { cap, wanted: p.wanted, declared: p.tokens.length, trimmed })
      } else {
        d.log('traders feed cap no longer reached: full ATM windows declared', { cap, declared: p.tokens.length })
      }
      logged = outcome
    }
    if (p.extraDropped !== extraLeftOut) {
      if (p.extraDropped) {
        d.log("traders feed cap: other screens' tokens left out — the books' full windows need the room",
          { cap, wanted: p.wanted, left: p.extraFresh, sources: [...sources.keys()] })
      } else d.log("traders feed cap: other screens' tokens no longer left out", { cap, declared: p.tokens.length })
      extraLeftOut = p.extraDropped
    }
  }

  async function refreshNow(): Promise<readonly number[]> {
    try {
      const now = d.now()
      const legs = await d.legs()
      const extra = new Set<number>()
      for (const [name, fn] of sources) {
        try {
          const got = fn(now)
          lastGood.set(name, got)
          for (const t of got) extra.add(t)
        } catch (err) {
          d.log('token source failed, using its last good output', { source: name, error: String(err) })
          for (const t of lastGood.get(name) ?? []) extra.add(t)
        }
      }
      const plan = planTokens(legs, d.master(), d.priceOf, istDay(now), { cap, extra })
      await d.db.publishSubscription(plan.tokens, now)
      state = { count: plan.tokens.length, at: now, capHit: plan.capHit, trimmed: plan.trimmed, bookDemand: plan.wanted }
      logTrim(plan)
      return plan.tokens
    } catch (err) {
      d.log('subscription declaration failed', { error: String(err) })
      return []
    }
  }

  void refreshNow()
  const timer = setInterval(() => void refreshNow(), d.everyMs ?? DECLARE_EVERY_MS)
  timer.unref()
  return {
    addTokenSource: (name, fn) => void sources.set(name, fn),
    refreshNow,
    last: () => state,
    stop: () => clearInterval(timer),
  }
}
