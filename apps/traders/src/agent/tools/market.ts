/**
 * `get_market_context`: one underlying's market context (spec §5, Lane 2's
 * `deps.marketContext`, cached 2 s) — trend, levels, ATR/HV/IV rank, the
 * expected move, the OI view and today's figures — with the R9 envelope, and a
 * `context` card for the page. Market data, not trader data: any stock with
 * F&O contracts, held or not.
 *
 * `reference` says what the levels, change and day block are measured from:
 * the spot, or for an index (no cash OHLC in NSE's files) the near future. The
 * levels are the only levels the assistant may quote (§6.6).
 */

import type { MarketContext } from '../../analytics/context-wire.ts'
import { stockInput, stockOf, type StockInput } from './book.ts'
import { envelope, ToolRefusal, type AgentTool, type ToolCtx } from './ctx.ts'

/** The context, or a refusal naming the stock: null from the deps means the master does not know it. */
export async function contextOf(ctx: ToolCtx, stock: string): Promise<MarketContext> {
  const c = await ctx.deps.marketContext(stock, ctx.deps.now())
  if (c === null) throw new ToolRefusal(`no such underlying in the instrument master: ${stock}`)
  return c
}

export const getMarketContext: AgentTool<StockInput> = {
  name: 'get_market_context',
  description: 'Market context of one underlying: spot, future, change, today\'s open/high/low/VWAP/opening range; trend (SMA20/50/200, 5- and 20-day returns); '
    + 'ATR14, HV10/HV20, ATM IV, IV rank and percentile; the end-of-day vol view (VRP = IV − HV20, its ratio and percentile, realized VRP and how often it was positive, '
    + 'near and next expiry IVs, 25-delta skew, NSE\'s HV, where the IV came from); the expected move to the near expiry; the last end-of-day OI view (PCR, max pain, call and put walls); '
    + 'support and resistance levels around the price with kind, strength and basis, and the nearest of each. The only source of levels.',
  input: stockInput,
  label: (i) => `market context ${i.stock.toUpperCase()}`,
  async run(ctx, input) {
    const stock = stockOf(input.stock)
    const c = await contextOf(ctx, stock)
    const { asOf, closed, stale, warnings, feedAlive: _feedAlive, ...rest } = c
    return {
      result: { ...envelope(ctx, { asOf, closed, stale, warnings }), ...rest, reference: c.reference ?? 'spot' },
      cards: [{ kind: 'context', id: ctx.nextCardId(), stock, context: c }],
      summary: `${stock}: trend ${c.trend.label}, ${c.levels.length} levels`,
    }
  },
}
