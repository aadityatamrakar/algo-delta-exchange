/**
 * Wire-shaped fixtures for the assistant's page tests. Typed against `agent/wire.ts` and `context-wire.ts`, so a
 * drift in the server's contract fails the typecheck. Not a test file.
 */
import { vi } from 'vitest'
import type { AssistantCard, AssistantStatus, CardMetrics, PlanCard } from '../../../traders/src/agent/wire.ts'
import type { MarketContext } from '../../../traders/src/analytics/context-wire.ts'
import { ASOF } from './fixtures.ts'

export const NOW: CardMetrics = {
  margin: 250000, pop: 58.2, ev: null, maxLoss: -218000, worstShock: -95000, deltaShares: 1250, deltaLots: 7.14,
  delta0Gap: 42.5, gamma: -12.3, vega: -3100, theta: 1405, credit: 0, charges: null,
}

export const AFTER: CardMetrics = {
  margin: 262000, pop: 61, ev: null, maxLoss: -150000, worstShock: -90000, deltaShares: -175, deltaLots: -1,
  delta0Gap: 10.2, gamma: -13.1, vega: -2900, theta: 1500, credit: 7350, charges: 120,
}

export function changeOf(now: CardMetrics, after: CardMetrics): Partial<CardMetrics> {
  const out: Record<string, number> = {}
  for (const k of Object.keys(now) as (keyof CardMetrics)[]) {
    const a = after[k], b = now[k]
    // the figures only: a margin's provenance (`marginSource`, `marginPartial`) has no change
    if (typeof a === 'number' && typeof b === 'number') out[k] = a - b
  }
  if (after.charges !== null && now.charges === null) out['charges'] = after.charges
  return out as Partial<CardMetrics>
}

export function plan(over: Partial<PlanCard> = {}): PlanCard {
  return {
    planId: 'P1', rank: 1, lines: ['Sell 1 lot TCS 27 Oct 3600 CE @ 42.50'], after: AFTER, change: changeOf(NOW, AFTER),
    flags: ['margin-up', 'indicative-price'], binding: ['margin ≤ +10 % of now'],
    whatIf: [{ instrument: 'option', expiry: '2026-10-27', strike: 3600, optType: 'CE', qty: -175, price: 42.5 }],
    ...over,
  }
}

export const P2: PlanCard = plan({
  planId: 'P2', rank: 2, lines: ['Buy 2 lots TCS 27 Oct 2900 PE @ 11.00'], flags: [], binding: [],
  after: { ...AFTER, margin: 240000, deltaShares: 900 }, change: changeOf(NOW, { ...AFTER, margin: 240000, deltaShares: 900 }),
  whatIf: [{ instrument: 'option', expiry: '2026-10-27', strike: 2900, optType: 'PE', qty: 350, price: 11 }],
})

export function plansCard(over: Partial<Extract<AssistantCard, { kind: 'plans' }>> = {}): Extract<AssistantCard, { kind: 'plans' }> {
  return {
    kind: 'plans', id: 'c1', stock: 'TCS', title: 'Neutralize delta, keep margin', indicative: false,
    objective: 'Minimise |Δ|; keep margin no worse than now; floor guard on.', view: null,
    baseline: NOW, plans: [plan(), P2], rejected: [{ reason: 'illiquid', count: 12 }, { reason: 'margin', count: 0 }],
    ...over,
  }
}

export const EVALUATION: AssistantCard = {
  kind: 'evaluation', id: 'c2', stock: 'TCS', title: 'Close L3', indicative: true, baseline: NOW,
  plan: plan({ planId: 'P3', flags: ['degrades-floor'], lines: ['Buy 1 lot TCS 27 Oct 3500 CE @ 80.00'] }),
}

export const NEUTRALIZE: AssistantCard = {
  kind: 'neutralize', id: 'c3', stock: 'TCS', deltaShares: 1250, deltaLots: 7.14,
  futures: { lots: 7, side: 'SELL', expiry: '2026-10-27', price: 3055 },
  delta0: 3012.5, spot: 3050, plans: [plan()], baseline: NOW, indicative: false,
}

export function context(over: Partial<MarketContext> = {}): MarketContext {
  return {
    stock: 'TCS', asOf: ASOF, closed: false, feedAlive: true, stale: false, spot: 3050, future: 3055, prevClose: 3037.2, changePct: 0.42,
    day: { open: 3040, high: 3061, low: 3031, vwap: 3047.5, orHigh: 3052, orLow: 3035 },
    trend: { label: 'up', sma20: 3011.4, sma50: 2980.1, sma200: 2890, ret5d: 0.012, ret20d: 0.034, basis: 'close > SMA20 > SMA50, 20-day return > 0' },
    vol: { atr14: 48.2, hv10: 0.181, hv20: 0.198, atmIv: 0.241, ivRank: 62, ivPercentile: 70, ivMinusHv20: 0.043, ivDays: 240 },
    expectedMove: { expiry: '2026-10-27', days: 5, oneSigma: 85, twoSigma: 170 },
    oi: { expiry: '2026-10-27', pcr: 0.92, maxPain: 3000, callWall: 3200, putWall: 2900, day: '2026-10-21' },
    levels: [
      { price: 2900, kind: 'oi-put-wall', strength: 3, distancePct: -4.92, basis: 'put OI 1.2 M' },
      { price: 3000, kind: 'max-pain', strength: 2, distancePct: -1.64, basis: 'max pain, 27 Oct' },
      { price: 3011.4, kind: 'sma20', strength: 1, distancePct: -1.27, basis: '20-day average' },
      { price: 3061, kind: 'day-high', strength: 1, distancePct: 0.36, basis: 'today' },
      { price: 3100, kind: 'r1', strength: 2, distancePct: 1.64, basis: 'floor pivot R1' },
      { price: 3200, kind: 'oi-call-wall', strength: 3, distancePct: 4.92, basis: 'call OI 1.5 M' },
    ],
    nearestSupport: { price: 3011.4, kind: 'sma20', strength: 1, distancePct: -1.27, basis: '20-day average' },
    nearestResistance: { price: 3061, kind: 'day-high', strength: 1, distancePct: 0.36, basis: 'today' },
    bars: { daily: 240, intraday: 60 },
    warnings: ['intraday bars start at the last restart'],
    ...over,
  }
}

export const CONTEXT_CARD: AssistantCard = { kind: 'context', id: 'c4', stock: 'TCS', context: context() }

export function status(over: Partial<AssistantStatus> = {}): AssistantStatus {
  return {
    enabled: true, provider: 'anthropic', model: 'claude-opus-5-5',
    budget: { traderUsdToday: 0.42, traderCapUsd: 5, globalUsdToday: 3.1, globalCapUsd: 25 },
    presets: [
      { id: 'neutralize-delta', label: 'Neutralize delta' }, { id: 'cut-margin', label: 'Cut margin' },
      { id: 'raise-pop', label: 'Raise POP' }, { id: 'max-ev', label: 'Max EV' },
    ],
    ...over,
  }
}

/** One SSE event as the server writes it. */
export const sse = (event: string, data: unknown): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`

export interface Sent { readonly path: string; readonly method: string; readonly query: string; readonly body: Record<string, unknown> | null }

export type Answer =
  | { readonly status?: number; readonly body?: unknown }
  | { readonly stream: readonly string[]; readonly hold?: boolean }

/**
 * A fetch double that can also answer with an event stream: `{ stream: chunks }` is sent chunk by chunk as
 * `text/event-stream`; `hold: true` keeps the stream open until the request is aborted (the Stop button).
 */
export function installStreamFetch(handler: (req: { path: string; method: string; body: Record<string, unknown> | null }) => Answer): Sent[] {
  const sent: Sent[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = init?.method ?? 'GET'
    const raw = typeof init?.body === 'string' ? init.body : null
    const body = raw === null ? null : (JSON.parse(raw) as Record<string, unknown>)
    sent.push({ path: url.pathname, method, query: url.search, body })
    const a = handler({ path: url.pathname, method, body })
    if ('stream' in a) {
      const enc = new TextEncoder()
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          for (const chunk of a.stream) c.enqueue(enc.encode(chunk))
          if (a.hold === true) {
            init?.signal?.addEventListener('abort', () => c.error(new DOMException('The operation was aborted.', 'AbortError')))
          } else {
            c.close()
          }
        },
      })
      return { ok: true, status: 200, statusText: 'OK', headers: new Headers({ 'content-type': 'text/event-stream' }), body: stream, json: async () => ({}) } as unknown as Response
    }
    const st = a.status ?? 200
    return {
      ok: st >= 200 && st < 300, status: st, statusText: String(st), headers: new Headers({ 'content-type': 'application/json' }), body: null,
      json: async () => a.body ?? {},
    } as unknown as Response
  }))
  return sent
}

/**
 * A real stored answer (BHEL, before the 1 Nov answer format): a bold lead mixed into the first paragraph, a
 * header-less `| | |` key–value table, a wholly bold line mid-answer and long bullets.
 */
export const OLD_ANSWER = [
  '**BHEL: indicative only.** The market is closed, the feed stopped at 16:19, and positions may be out of date.',
  '',
  '| | |',
  '|---|---|',
  '| Net delta | **+0.48 lots** (+1,257 shares). Inside the ±1.8-lot band, so no futures hedge needed |',
  '| Spot / Δ0 | 398.9 / **233.37**, 41.5% below spot |',
  '| Max loss (±10% expiry scan) | **−₹7.56 L at 438.79**. The best point on the scan is still −₹2.19 L |',
  '| POP | **0%**, with no breakevens either side |',
  '',
  '**Biggest risk: L3, short 435 PE × 7 lots, is deep in the money (₹37, delta +16,977 shares) with 4 days left.**',
  '',
  'Other things to watch:',
  '- **Volatility:** realised vol is above implied (HV20 45.3% vs ATM IV 34.0%, VRP −11.3 points, 6th percentile).',
  '- **Data:** 16 expired legs are hidden from this view.',
].join('\n')

/** The answer shape the 1 Nov prompt asks for: a bold headline, `### ` sections, one comparison table, one caveat. */
export const SHAPED_ANSWER = [
  '**Holding, call side tested: spot 2% under the 2600 CE, 9 days left.**',
  '',
  '### Position',
  '- P&L +₹1.2 L; Today −₹18k',
  '- Delta +1.4 lots, inside the ±2 band',
  '',
  '### Risk',
  '| | Now | P3 |',
  '|---|---:|---:|',
  '| Max loss | −₹4.1 L | −₹2.6 L |',
  '',
  '> Indicative: market closed, quotes are the last seen.',
].join('\n')
