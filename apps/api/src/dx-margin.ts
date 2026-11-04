/**
 * MARGIN UTILIZED (operator, 3 Nov: "show margin utilized").
 *
 *   GET /v1/desk/margin          the Delta accounts — demo and live, each as
 *                                the gateway last read it into
 *                                `desk-broker-margin` (`dx-margin.ts` there).
 *                                (`?tag=` keeps the per-book NSE figure.)
 *   GET /v1/desk/margin/books    each BULL-S book's ESTIMATED margin: now, and
 *                                the worst case at its cap.
 *
 * NOTHING HERE IS A GUESS. A row the gateway never wrote is `absent`, a failed
 * read is `failed` with its error, and every unknown figure is null — never 0.
 * The book estimate names what it is missing (a mark, a leverage, the index)
 * and is then null.
 *
 * The estimate is `@algomaker/desk-engine`'s `shortOptionMargin` — the same
 * formula `decideBullS` holds a book's `bs_margin_budget` to:
 * mark × qty + qty × index ÷ leverage per SHORT option (a long leg's premium
 * is already paid). The mark is Delta's own mark price where the feed carries
 * it, else the quote's mid / last; leverage is the product's `dx_leverage`.
 */
import {
  bullSWorstAtCap,
  resolveDials,
  shortOptionMargin,
  type Dials,
} from '@algomaker/desk-engine'
import type { BridgeLeg, DeskMode } from './contract.ts'
import type { ApiDeps, RouteCtx } from './routes/kit.ts'

export const BROKER_MARGIN_COLLECTION = 'desk-broker-margin'
/** The gateway reads every 30 s; four missed reads is stale. */
export const ACCOUNT_MARGIN_STALE_MS = 120_000
const INR_PER_USD = 85

export type AccountMarginState = 'ok' | 'stale' | 'failed' | 'absent'

export interface AccountMarginRow {
  readonly id: 'delta-demo' | 'delta'
  readonly rail: 'demo' | 'live'
  readonly label: 'Demo' | 'Live'
  readonly state: AccountMarginState
  readonly asOf: number | null
  readonly ageMs: number | null
  readonly balance: number | null
  readonly available: number | null
  readonly positionMargin: number | null
  readonly orderMargin: number | null
  readonly portfolioMargin: number | null
  readonly used: number | null
  readonly utilizedPct: number | null
  readonly error: string
  readonly reason: string
}

export interface AccountMarginView {
  readonly inrPerUsd: number
  readonly staleAfterMs: number
  readonly accounts: readonly AccountMarginRow[]
}

const ACCOUNTS = [
  { id: 'delta-demo', rail: 'demo', label: 'Demo' },
  { id: 'delta', rail: 'live', label: 'Live' },
] as const

function fin(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** The two accounts as the page shows them. Pure. */
export function accountMarginView(
  docs: readonly Record<string, unknown>[],
  nowMs: number,
  inrPerUsd: number = INR_PER_USD,
): AccountMarginView {
  const accounts = ACCOUNTS.map((a): AccountMarginRow => {
    const doc = docs.find((d) => d['_id'] === a.id)
    const base = { id: a.id, rail: a.rail, label: a.label }
    if (doc === undefined) {
      return {
        ...base,
        state: 'absent',
        asOf: null,
        ageMs: null,
        balance: null,
        available: null,
        positionMargin: null,
        orderMargin: null,
        portfolioMargin: null,
        used: null,
        utilizedPct: null,
        error: '',
        reason:
          a.rail === 'demo'
            ? 'the gateway has not read the demo account — no delta-demo key, or the demo rail is not up yet'
            : 'the gateway has not read the live account — the live rail is off (DESK_DX_LIVE) or no delta key',
      }
    }
    const asOf = fin(doc['asOf'])
    const ageMs = asOf === null ? null : nowMs - asOf
    if (doc['ok'] !== true) {
      return {
        ...base,
        state: 'failed',
        asOf,
        ageMs,
        balance: null,
        available: null,
        positionMargin: null,
        orderMargin: null,
        portfolioMargin: null,
        used: null,
        utilizedPct: null,
        error: typeof doc['error'] === 'string' && doc['error'] !== '' ? doc['error'] : 'the last read failed',
        reason: '',
      }
    }
    const stale = ageMs === null || ageMs > ACCOUNT_MARGIN_STALE_MS
    return {
      ...base,
      state: stale ? 'stale' : 'ok',
      asOf,
      ageMs,
      balance: fin(doc['balance']),
      available: fin(doc['available']),
      positionMargin: fin(doc['positionMargin']),
      orderMargin: fin(doc['orderMargin']),
      portfolioMargin: fin(doc['portfolioMargin']),
      used: fin(doc['used']),
      utilizedPct: fin(doc['utilizedPct']),
      error: '',
      reason: stale
        ? `the last read is ${ageMs === null ? 'undated' : `${Math.round(ageMs / 1000)}s old`} — is the gateway running?`
        : '',
    }
  })
  return { inrPerUsd, staleAfterMs: ACCOUNT_MARGIN_STALE_MS, accounts }
}

// ------------------------------------------------------------ book estimate

export interface BookMarginEstimate {
  readonly tag: string
  readonly mode: DeskMode
  /** `bs_margin_budget`, USD; 0 = off. */
  readonly budget: number
  readonly current: { readonly usd: number | null; readonly shortLegs: number; readonly missing: string[] }
  readonly worstAtCap: {
    readonly usd: number | null
    readonly atmStrike: number | null
    readonly sizes: number[]
    readonly unbounded: boolean
    readonly missing: string[]
  }
}

const r2 = (x: number): number => Number(x.toFixed(2))

/** One book's estimate. Pure: every price and leverage is asked through a port. */
export function bookMarginEstimate(input: {
  readonly tag: string
  readonly mode: DeskMode
  readonly dials: Dials
  readonly legs: readonly BridgeLeg[]
  readonly index: number | null
  readonly markOf: (token: number) => number | null
  readonly leverageOf: (token: number) => number | null
  /** The listed strike nearest the index, with its two tokens; null when none. */
  readonly atm: { readonly strike: number; readonly ceToken: number; readonly peToken: number } | null
  readonly lotSize: number
  /** The book's account margin mode; null = unknown, priced as isolated. */
  readonly marginMode?: 'isolated' | 'portfolio' | null
}): BookMarginEstimate {
  const { dials, index } = input
  const shorts = input.legs.filter((l) => Number.isFinite(l.qty) && l.qty < 0)
  const missingNow: string[] = []
  let now = 0
  if (index === null) missingNow.push('no BTC index price')
  for (const l of shorts) {
    const sym = l.instrument.tradingsymbol
    const token = l.instrument.instrumentToken
    const mark = token === undefined ? null : input.markOf(token)
    const lev = token === undefined ? null : input.leverageOf(token)
    if (lev === null) missingNow.push(`${sym}: no leverage`)
    if (mark === null) missingNow.push(`${sym}: no mark`)
    if (index === null || mark === null || lev === null) continue
    now += shortOptionMargin({ mark, qty: Math.abs(l.qty), index, leverage: lev, mode: input.marginMode ?? null })
  }
  const current = {
    usd: missingNow.length === 0 ? r2(now) : null,
    shortLegs: shorts.length,
    missing: missingNow,
  }

  const missingCap: string[] = []
  if (dials.bs_max_open <= 0) {
    return {
      tag: input.tag,
      mode: input.mode,
      budget: dials.bs_margin_budget,
      current,
      worstAtCap: { usd: null, atmStrike: input.atm?.strike ?? null, sizes: [], unbounded: true, missing: [] },
    }
  }
  if (index === null) missingCap.push('no BTC index price')
  if (input.atm === null) missingCap.push('no listed ATM strike for this expiry')
  const atm = input.atm
  const ceMark = atm === null ? null : input.markOf(atm.ceToken)
  const peMark = atm === null ? null : input.markOf(atm.peToken)
  const ceLev = atm === null ? null : input.leverageOf(atm.ceToken)
  const peLev = atm === null ? null : input.leverageOf(atm.peToken)
  if (atm !== null) {
    if (ceMark === null) missingCap.push(`the ${atm.strike} CE: no mark`)
    if (peMark === null) missingCap.push(`the ${atm.strike} PE: no mark`)
    if (ceLev === null) missingCap.push(`the ${atm.strike} CE: no leverage`)
    if (peLev === null) missingCap.push(`the ${atm.strike} PE: no leverage`)
  }
  const worst =
    missingCap.length === 0
      ? bullSWorstAtCap({
          dials,
          lotSize: input.lotSize,
          index: index as number,
          ceMark: ceMark as number,
          peMark: peMark as number,
          ceLeverage: ceLev as number,
          peLeverage: peLev as number,
          mode: input.marginMode ?? null,
        })
      : null
  return {
    tag: input.tag,
    mode: input.mode,
    budget: dials.bs_margin_budget,
    current,
    worstAtCap: {
      usd: worst?.usd ?? null,
      atmStrike: atm?.strike ?? null,
      sizes: worst?.sizes ?? [],
      unbounded: false,
      missing: missingCap,
    },
  }
}

// ------------------------------------------------------------------ routes

export async function handleAccountMargin(deps: ApiDeps, ctx: RouteCtx): Promise<boolean> {
  const docs = (await deps.db.collection(BROKER_MARGIN_COLLECTION).find({}).toArray()) as Record<string, unknown>[]
  ctx.send(200, accountMarginView(docs, deps.now(), deps.venue?.inrPerUnit ?? INR_PER_USD))
  return true
}

/** The quote's mark: Delta's own mark price when the tick carried it, else mid / last. */
function markOf(deps: ApiDeps, token: number): number | null {
  const q = deps.marks?.quote(token) ?? null
  if (q === null) return null
  const m = q.option?.mark
  if (typeof m === 'number' && Number.isFinite(m) && m > 0) return m
  return Number.isFinite(q.price) && q.price > 0 ? q.price : null
}

export async function handleBookMarginEstimates(deps: ApiDeps, ctx: RouteCtx): Promise<boolean> {
  const rows = [...(await deps.store.listBooks('paper')), ...(await deps.store.listBooks('live'))]
  const books = rows
    .map((r) => ({ row: r, dials: resolveDials(r.dials as Record<string, number | boolean>).dials }))
    .filter((b) => b.dials.bs_enabled)
  const index = deps.marks?.spot('BTC') ?? null
  const master = deps.master.current()

  const planned = await Promise.all(
    books.map(async (b) => {
      const doc = await deps.store.bookDoc(b.row.tag, b.row.mode)
      const legs = (doc?.legs ?? []).filter((l) => l.qty !== 0)
      let atm: { strike: number; ceToken: number; peToken: number } | null = null
      if (index !== null) {
        const strikes = master.strikes(b.row.symbol, b.row.expiry)
        let best: number | null = null
        for (const k of strikes) if (best === null || Math.abs(k - index) < Math.abs(best - index)) best = k
        if (best !== null) {
          const ce = master.resolve(b.row.symbol, b.row.expiry, best, 'CE')?.instrumentToken
          const pe = master.resolve(b.row.symbol, b.row.expiry, best, 'PE')?.instrumentToken
          if (ce !== undefined && pe !== undefined) atm = { strike: best, ceToken: ce, peToken: pe }
        }
      }
      const lotSize = master.chain(b.row.symbol, b.row.expiry)?.lotSize ?? deps.venue?.qtyStep ?? 0.001
      return { ...b, legs, atm, lotSize }
    }),
  )

  const tokens = new Set<number>()
  for (const p of planned) {
    for (const l of p.legs) if (l.instrument.instrumentToken !== undefined) tokens.add(l.instrument.instrumentToken)
    if (p.atm !== null) {
      tokens.add(p.atm.ceToken)
      tokens.add(p.atm.peToken)
    }
  }
  const levDocs = (await deps.db
    .collection('instrument')
    .find({ instrument_token: { $in: [...tokens] } })
    .toArray()) as Record<string, unknown>[]
  const leverage = new Map<number, number>()
  for (const d of levDocs) {
    const lev = Number(d['dx_leverage'])
    if (Number.isFinite(lev) && lev > 0) leverage.set(Number(d['instrument_token']), lev)
  }

  // Each account's margin mode, as the gateway read it off `/v2/profile`.
  const modes = new Map<string, 'isolated' | 'portfolio'>()
  for (const d of (await deps.db.collection(BROKER_MARGIN_COLLECTION).find({}).toArray()) as Record<string, unknown>[]) {
    const mm = d['marginMode']
    if (mm === 'portfolio' || mm === 'isolated') modes.set(String(d['_id']), mm)
  }

  ctx.send(200, {
    asOf: deps.now(),
    index,
    books: planned.map((p) =>
      bookMarginEstimate({
        tag: p.row.tag,
        mode: p.row.mode,
        dials: p.dials,
        legs: p.legs,
        index,
        markOf: (t) => markOf(deps, t),
        leverageOf: (t) => leverage.get(t) ?? null,
        atm: p.atm,
        lotSize: p.lotSize,
        marginMode: modes.get(p.row.mode === 'live' ? 'delta' : 'delta-demo') ?? null,
      }),
    ),
  })
  return true
}
