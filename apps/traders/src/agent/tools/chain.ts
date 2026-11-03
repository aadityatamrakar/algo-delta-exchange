/**
 * `get_chain`: strikes around the forward of one expiry, with bid/ask/LTP,
 * the vol solved against that month's own forward (`monthQuotes`, as the book
 * view solves it), delta at that vol, OI and a liquidity flag (spec R8: a live
 * two-sided quote, not stale, spread ≤ max(10% of mid, ₹1)).
 *
 * Only quotes the app already holds: nothing is subscribed, so an expiry no
 * book holds and no Market Watch shows may come back thin — the result says
 * how many strikes had a quote.
 */

import { z } from 'zod'
import { b76Greeks, type OptionType } from '@algomaker/greeks'
import { DEFAULT_RATE, ivFor } from '@algomaker/payoff'
import { marketOpenAt } from '../../analytics/calendar.ts'
import { monthQuotes } from '../../analytics/month-chain.ts'
import { liveExpiryFrom } from '../../analytics/near-expiry.ts'
import { spotTokenOf } from '../../market/master.ts'
import { isOpenLeg } from '../../types.ts'
import { istDate } from '../../routes/kit.ts'
import type { Row } from '../query/execute.ts'
import { daysTo, stockOf } from './book.ts'
import { envelope, r2, r4, ToolRefusal, type AgentTool, type ToolCtx } from './ctx.ts'

export const CHAIN_AROUND_DEFAULT = 8
export const CHAIN_AROUND_MAX = 20

/** R8's liquidity rule. */
export function liquid(bid: number | null, ask: number | null, stale: boolean): boolean {
  if (bid === null || ask === null || !(bid > 0) || !(ask >= bid) || stale) return false
  const mid = (bid + ask) / 2
  return ask - bid <= Math.max(0.1 * mid, 1)
}

export interface ChainRead {
  readonly stock: string
  readonly expiry: string
  readonly lotSize: number | null
  readonly forward: number | null
  readonly forwardSource: string | null
  readonly spot: number | null
  readonly closed: boolean
  readonly quoted: number
  readonly rows: readonly Row[]
}

/** The book's nearest live option expiry, else the nearest listed one. */
async function defaultExpiry(ctx: ToolCtx, stock: string, nowMs: number): Promise<string | null> {
  const from = liveExpiryFrom(nowMs)
  const today = istDate(nowMs)
  const held = (await ctx.deps.legs.open(ctx.trader, stock))
    .filter((l) => isOpenLeg(l, today) && l.instrument === 'option' && l.expiry >= from)
    .map((l) => l.expiry).sort()
  return held[0] ?? ctx.deps.master().options.nearestExpiry(stock, from)
}

export async function readChain(ctx: ToolCtx, stock: string, expiryIn: string | null, around: number): Promise<ChainRead> {
  const nowMs = ctx.deps.now()
  const m = ctx.deps.master()
  const expiry = expiryIn ?? await defaultExpiry(ctx, stock, nowMs)
  if (expiry === null) throw new ToolRefusal(`${stock} lists no option chain`)
  const strikes = [...m.options.strikes(stock, expiry)].sort((a, b) => a - b)
  if (strikes.length === 0) {
    const listed = m.options.expiries(stock).filter((e) => e >= istDate(nowMs)).slice(0, 6)
    throw new ToolRefusal(`${stock} lists no ${expiry} options; listed expiries: ${listed.length === 0 ? 'none' : listed.join(', ')}`)
  }
  const closed = !marketOpenAt(nowMs)
  const spotToken = spotTokenOf(m, stock)
  const spot = spotToken === null ? null : ctx.deps.quotes.quote(spotToken)?.price ?? null
  const month = monthQuotes(m, ctx.deps.quotes, stock, expiry, spot, nowMs, closed)
  const centre = month.forward ?? spot ?? strikes[Math.floor(strikes.length / 2)] as number
  let at = 0
  for (let i = 1; i < strikes.length; i++) if (Math.abs((strikes[i] as number) - centre) < Math.abs((strikes[at] as number) - centre)) at = i
  const picked = strikes.slice(Math.max(0, at - around), at + around + 1)
  const rows: Row[] = []
  let quoted = 0
  for (const strike of picked) {
    for (const type of ['CE', 'PE'] as const satisfies readonly OptionType[]) {
      const token = m.options.resolve(stock, expiry, strike, type)?.instrumentToken
      const q = token === undefined ? null : ctx.deps.quotes.quote(token)
      if (q !== null) quoted++
      const iv = ivFor(month.ivs, strike, type)
      const delta = iv === null || month.forward === null ? null
        : b76Greeks({ future: month.forward, strike, t: month.tYears, vol: iv, rate: DEFAULT_RATE, type }).delta
      const bid = q?.bid ?? null
      const ask = q?.ask ?? null
      const stale = q === null ? true : q.stale === true
      const mid = bid !== null && ask !== null && bid > 0 && ask > 0 ? (bid + ask) / 2 : null
      rows.push({
        strike, type, bid: r2(bid), ask: r2(ask), ltp: r2(q?.price ?? null), iv: r4(iv), delta: r4(delta), oi: q?.oi ?? null,
        spreadPct: mid === null || ask === null || bid === null ? null : r2(((ask - bid) / mid) * 100),
        liquid: liquid(bid, ask, stale), stale,
      })
    }
  }
  return {
    stock, expiry, lotSize: m.options.chain(stock, expiry)?.lotSize ?? null,
    forward: r2(month.forward), forwardSource: month.source, spot: r2(spot), closed, quoted, rows,
  }
}

const chainInput = z.object({
  stock: z.string().min(1).max(20).describe('NSE symbol'),
  expiry: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("YYYY-MM-DD; default the book's near expiry"),
  around: z.number().int().min(1).max(CHAIN_AROUND_MAX).optional().describe(`strikes each side of the forward, default ${CHAIN_AROUND_DEFAULT}`),
}).strict()

export const getChain: AgentTool<z.infer<typeof chainInput>> = {
  name: 'get_chain',
  description: 'Option chain strikes around the forward for one expiry: bid, ask, LTP, IV, delta, OI, spread and a liquidity flag (two-sided, fresh, spread ≤ max(10% of mid, ₹1)). Quotes the app already holds only.',
  input: chainInput,
  label: (i) => `chain ${i.stock.toUpperCase()}${i.expiry === undefined ? '' : ` ${i.expiry}`}`,
  async run(ctx, input) {
    const c = await readChain(ctx, stockOf(input.stock), input.expiry ?? null, input.around ?? CHAIN_AROUND_DEFAULT)
    const warnings: string[] = []
    if (c.quoted === 0) warnings.push(`no quote held for any of these ${c.expiry} strikes: the chain is not on the feed (no book holds it and no Market Watch shows it)`)
    if (c.forwardSource === 'carry') warnings.push('the forward is spot carried to expiry: no future and no two-sided quote at the money')
    const cols = ['strike', 'type', 'bid', 'ask', 'ltp', 'iv', 'delta', 'oi', 'spreadPct', 'liquid', 'stale']
    return {
      result: {
        ...envelope(ctx, { closed: c.closed, warnings }),
        stock: c.stock, expiry: c.expiry, daysToExpiry: daysTo(c.expiry, ctx.deps.now()), lotSize: c.lotSize,
        spot: c.spot, forward: c.forward, forwardSource: c.forwardSource,
        units: { iv: 'decimal', delta: 'per share', spreadPct: 'percent' },
        columns: cols, rows: c.rows.map((r) => cols.map((k) => r[k] ?? null)),
      },
      summary: `${c.stock} ${c.expiry}: ${c.rows.filter((r) => r['liquid'] === true).length} liquid of ${c.rows.length}`,
    }
  },
}
