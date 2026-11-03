/**
 * The book's "Market context" block (hidden by default; Edit layout shows it): trend, vol and IV rank, expected
 * move, OI walls and the level ladder from `GET /market/:stock/context`, refreshed every minute. No AI involved.
 *
 * A server without the route (404) gets one muted line, never an error on the book; a context that fails to render
 * is caught at the block's edge (PageBoundary) and the rest of the book stands.
 */

import type { ReactElement } from 'react'
import type { MarketContext } from '../../../../traders/src/analytics/context-wire.ts'
import { PageBoundary } from '../../boundary.tsx'
import { tapi } from '../api.ts'
import { usePoll } from '../hooks.ts'
import { ContextView } from './cards.tsx'

export const CONTEXT_POLL_MS = 60_000

function isContext(x: unknown): x is MarketContext {
  if (typeof x !== 'object' || x === null) return false
  const c = x as Partial<MarketContext>
  return typeof c.stock === 'string' && Array.isArray(c.levels) && typeof c.trend === 'object' && c.trend !== null
    && typeof c.vol === 'object' && c.vol !== null && typeof c.expectedMove === 'object' && c.expectedMove !== null
}

export function MarketContextBlock(props: { readonly stock: string }): ReactElement {
  return <PageBoundary resetKey={props.stock}><ContextBlockBody stock={props.stock} /></PageBoundary>
}

function ContextBlockBody(props: { readonly stock: string }): ReactElement {
  const ctx = usePoll(() => tapi.marketContext(props.stock), CONTEXT_POLL_MS, [props.stock])
  const c = isContext(ctx.data) ? ctx.data : null
  if (c === null) {
    if (ctx.status === 404) return <div className="traders-ai-muted">Market context is not on this server yet</div>
    if (ctx.error !== null) return <div className="traders-ai-error">{`Market context failed: ${ctx.error}`}</div>
    return <div className="traders-ai-muted">{ctx.data === null ? `Loading the market context of ${props.stock}…` : 'Market context is not on this server yet'}</div>
  }
  return (
    <section className="traders-ai-card traders-ai-block" aria-label={`Market context — ${props.stock}`}>
      <ContextView context={c} />
      {ctx.error === null ? null : <div className="traders-ai-error">{`Refresh failed: ${ctx.error}`}</div>}
    </section>
  )
}
