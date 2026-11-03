/** The assistant's cards: each kind renders from the wire, changes are toned by what is better for the metric, Show on payoff loads the plan. */
import { afterEach, expect, test, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { AssistantCard } from '../../traders/src/agent/wire.ts'
import { CardView } from '../src/traders/assistant/cards.tsx'
import { MarketContextBlock } from '../src/traders/assistant/context-block.tsx'
import { rungsOf } from '../src/traders/assistant/ladder.tsx'
import { METRICS, changeTone, metricLines, rupees } from '../src/traders/assistant/metrics.ts'
import { openWhatIf } from '../src/traders/what-if.ts'
import { installFetch } from './http.tsx'
import { AFTER, CONTEXT_CARD, EVALUATION, NEUTRALIZE, NOW, P2, changeOf, context, plan, plansCard } from './traders/assistant-fixtures.ts'

vi.mock('../src/traders/what-if.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/traders/what-if.ts')>()),
  openWhatIf: vi.fn(),
}))

afterEach(() => { vi.unstubAllGlobals(); vi.mocked(openWhatIf).mockClear() })

/** Nothing on a card may read as an order control (spec R1). */
const FORBIDDEN = /place|apply|square ?off|kill|flatten|submit order|cancel order|modify order|exit position|buy now|sell now|send order|execute/i
const controls = (root: HTMLElement): string[] =>
  [...root.querySelectorAll('button, a, [role="button"], [role="tab"]')].map((n) => (n.getAttribute('aria-label') ?? n.textContent ?? '').trim())

const toneOf = (table: HTMLElement, metric: string): string | null =>
  table.querySelector(`tr[data-metric="${metric}"] td:last-child`)?.getAttribute('data-tone') ?? null

test('a change is better or worse by what is better FOR THAT METRIC, not by its sign', () => {
  expect(changeTone('lower', 250000, 262000)).toBe('worse')             // margin up
  expect(changeTone('lower', 250000, 240000)).toBe('better')            // margin down
  expect(changeTone('higher', -218000, -150000)).toBe('better')         // max loss shallower: a positive change
  expect(changeTone('higher', -95000, -120000)).toBe('worse')           // shock deeper
  expect(changeTone('higher', 58.2, 61)).toBe('better')                 // POP up
  expect(changeTone('lowerAbs', 1250, -175)).toBe('better')             // Δ nearer zero, though the change is −1,425
  expect(changeTone('lowerAbs', 1250, -1500)).toBe('worse')             // Δ flipped past zero and grew: worse, though negative
  expect(changeTone('lowerAbs', -12.3, -13.1)).toBe('worse')            // more short gamma
  expect(changeTone('lower', null, 120, 120)).toBe('worse')             // charges where there were none
  expect(changeTone('higher', 100, 100)).toBe(null)                     // nothing moved
  expect(changeTone('higher', null, null)).toBe(null)                   // unknown
  const better = Object.fromEntries(METRICS.map((m) => [m.key, m.better]))
  expect(better).toEqual({
    margin: 'lower', pop: 'higher', ev: 'higher', maxLoss: 'higher', worstShock: 'higher', deltaShares: 'lowerAbs', deltaLots: 'lowerAbs',
    delta0Gap: 'lower', gamma: 'lowerAbs', vega: 'lowerAbs', theta: 'higher', credit: 'higher', charges: 'lower',
  })
})

test('the rows: now → plan → change in short rupees and units, EV left out when neither side has it', () => {
  const rows = metricLines(NOW, AFTER, changeOf(NOW, AFTER))
  expect(rows.map((r) => r.key)).not.toContain('ev')
  const byKey = Object.fromEntries(rows.map((r) => [r.key, r]))
  expect(byKey['margin']).toMatchObject({ now: '2.50 L', plan: '2.62 L', change: '+12.0 k', tone: 'worse' })
  expect(byKey['maxLoss']).toMatchObject({ now: '−2.18 L', plan: '−1.50 L', change: '+68.0 k', tone: 'better' })
  expect(byKey['pop']).toMatchObject({ now: '58.2 %', plan: '61.0 %', change: '+2.8 pts', tone: 'better' })
  expect(byKey['deltaShares']).toMatchObject({ now: '1,250', plan: '−175', change: '−1,425', tone: 'better' })
  expect(byKey['charges']).toMatchObject({ now: '—', plan: '120', change: '+120', tone: 'worse' })
  expect([rupees(950), rupees(-62656), rupees(12_500_000), rupees(0)]).toEqual(['950', '−62.7 k', '1.25 Cr', '0'])
})

test('the margin row says where its figure comes from: NSE SPAN + exposure only when whole; else the estimate, or partial', () => {
  const marginOf = (f: Partial<typeof AFTER>) => metricLines(NOW, { ...AFTER, ...f }, null).find((r) => r.key === 'margin')
  expect(marginOf({ marginSource: 'span', marginPartial: false })).toMatchObject({ label: 'Margin', about: expect.stringMatching(/^NSE SPAN \+ exposure/) })
  expect(marginOf({ marginSource: 'span-lite', marginPartial: false })).toMatchObject({ label: 'Margin (estimate)', about: expect.stringMatching(/^Estimate \(SPAN-lite\)/) })
  expect(marginOf({ marginSource: 'span-lite', marginPartial: true })).toMatchObject({ label: 'Margin (partial)', about: expect.stringMatching(/^Partial/) })
  // a card from before the server said: never the exchange's figure
  expect(marginOf({})?.about).not.toMatch(/NSE SPAN \+ exposure/)
  expect(metricLines(NOW, AFTER, null).map((r) => r.key)).not.toContain('marginSource')
})

test('a plans card: title, objective, P1 and P2 as tabs, the table toned per metric, flags, binding, what was left out', () => {
  render(<CardView card={plansCard()} />)
  const card = screen.getByRole('region', { name: 'Neutralize delta, keep margin' })
  expect(within(card).getByText('Minimise |Δ|; keep margin no worse than now; floor guard on.')).toBeTruthy()
  expect(within(card).getByText('Sell 1 lot TCS 27 Oct 3600 CE @ 42.50')).toBeTruthy()
  const table = within(card).getByRole('table', { name: 'P1: now, plan and change' })
  expect(toneOf(table, 'margin')).toBe('worse')
  expect(toneOf(table, 'maxLoss')).toBe('better')
  expect(toneOf(table, 'deltaShares')).toBe('better')
  expect(toneOf(table, 'gamma')).toBe('worse')
  expect(toneOf(table, 'vega')).toBe('better')
  expect(toneOf(table, 'theta')).toBe('better')
  expect(within(card).getByText('Margin up')).toBeTruthy()
  expect(within(card).getByText('Indicative price')).toBeTruthy()
  expect(within(card).getByText('Binding: margin ≤ +10 % of now')).toBeTruthy()
  expect(within(card).getByText('Left out: 12 illiquid')).toBeTruthy()
  expect(within(card).queryByRole('note')).toBe(null)                             // not indicative

  fireEvent.click(within(card).getByRole('tab', { name: 'P2' }))
  const t2 = within(card).getByRole('table', { name: 'P2: now, plan and change' })
  expect(toneOf(t2, 'margin')).toBe('better')
  expect(within(card).getByText('Buy 2 lots TCS 27 Oct 2900 PE @ 11.00')).toBeTruthy()
  expect(controls(card).filter((t) => FORBIDDEN.test(t))).toEqual([])
})

test('Show on payoff loads the plan\'s own legs into the Scenario tab, labelled AI: <plan id>', () => {
  render(<CardView card={plansCard()} />)
  fireEvent.click(screen.getByRole('button', { name: 'Show on payoff — P1' }))
  expect(openWhatIf).toHaveBeenCalledWith('TCS', plan().whatIf, 'AI: P1')
  fireEvent.click(screen.getByRole('tab', { name: 'P2' }))
  fireEvent.click(screen.getByRole('button', { name: 'Show on payoff — P2' }))
  expect(openWhatIf).toHaveBeenLastCalledWith('TCS', P2.whatIf, 'AI: P2')
})

test('a plans card with no plan says so; an indicative one carries the banner', () => {
  render(<CardView card={plansCard({ plans: [], indicative: true, view: 'HV20 19.8 %' })} />)
  expect(screen.getByText(/^No plan meets the goal/)).toBeTruthy()
  expect(screen.getByRole('note').textContent).toMatch(/^Indicative/)
  expect(screen.getByText('View: HV20 19.8 %')).toBeTruthy()
  expect(screen.queryByRole('button', { name: /Show on payoff/ })).toBe(null)
})

test('an evaluation card says it is the trader\'s own adjustment, with its flags and Show on payoff', () => {
  render(<CardView card={EVALUATION} />)
  const card = screen.getByRole('region', { name: 'Close L3' })
  expect(within(card).getByText(/Your adjustment, evaluated as stated/)).toBeTruthy()
  expect(within(card).getByText('Worse worst case')).toBeTruthy()
  expect(within(card).getByRole('note')).toBeTruthy()
  fireEvent.click(within(card).getByRole('button', { name: 'Show on payoff — P3' }))
  expect(openWhatIf).toHaveBeenCalledWith('TCS', plan().whatIf, 'AI: P3')
})

test('a neutralize card: Δ now, the futures route (side, lots, expiry, price) beside the option plans, Δ0 against spot', () => {
  render(<CardView card={NEUTRALIZE} />)
  const card = screen.getByRole('region', { name: 'Neutralize delta — TCS' })
  const route = within(card).getByRole('group', { name: 'Futures route' })
  expect(route.textContent).toContain('SELL 7 lots 27 Oct 26 FUT @ 3,055.00')
  expect(within(route).getByText('SELL').getAttribute('data-side')).toBe('SELL')
  expect(card.textContent).toContain('+1,250 sh')
  expect(card.textContent).toContain('3,012.50')
  expect(card.textContent).toContain('−1.23 %')                                   // Δ0 below spot
  expect(within(card).getByRole('table', { name: 'P1: now, plan and change' })).toBeTruthy()
  fireEvent.click(within(card).getByRole('button', { name: 'Show on payoff — P1' }))
  expect(openWhatIf).toHaveBeenCalledWith('TCS', plan().whatIf, 'AI: P1')
})

test('a context card: trend, IV/HV/IV rank, expected move, OI, and a ladder with resistance above spot and support below', () => {
  render(<CardView card={CONTEXT_CARD} />)
  const card = screen.getByRole('region', { name: 'Market context — TCS' })
  expect(within(card).getByRole('group', { name: 'Trend' }).textContent).toContain('Up')
  const vol = within(card).getByRole('group', { name: 'Volatility' }).textContent ?? ''
  expect(vol).toContain('24.1 %')
  expect(vol).toContain('19.8 %')
  expect(vol).toContain('+4.3 pts')
  expect(vol).toContain('62 · pctl 70')
  expect(within(card).getByRole('group', { name: 'Expected move' }).textContent).toContain('±85 (1σ) · ±170 (2σ)')
  const oi = within(card).getByRole('group', { name: 'Open interest' }).textContent ?? ''
  expect(oi).toContain('0.92')
  expect(oi).toContain('3,200')
  const ladder = within(card).getByRole('img', { name: /^Levels around 3,050.00: 3 above, 3 below/ })
  const rungs = [...ladder.querySelectorAll('g')].map((g) => [g.getAttribute('class'), g.querySelector('text')?.textContent])
  expect(rungs).toEqual([
    ['traders-ai-rung traders-ai-rung-res', '3,200.00'], ['traders-ai-rung traders-ai-rung-res', '3,100.00'], ['traders-ai-rung traders-ai-rung-res', '3,061.00'],
    ['traders-ai-rung traders-ai-rung-ref', '3,050.00'],
    ['traders-ai-rung traders-ai-rung-sup', '3,011.40'], ['traders-ai-rung traders-ai-rung-sup', '3,000.00'], ['traders-ai-rung traders-ai-rung-sup', '2,900.00'],
  ])
  expect(ladder.querySelector('[data-nearest="true"] text')?.textContent).toBe('3,061.00')
  expect(within(card).getByText('intraday bars start at the last restart')).toBeTruthy()
})

test('the ladder keeps the nearest levels either side of spot', () => {
  const many = Array.from({ length: 20 }, (_, i) => ({ price: 3000 + (i - 10) * 10, kind: 'round' as const, strength: 1 as const, distancePct: 0, basis: '' }))
  const r = rungsOf(many, { price: 3005, future: false }, [], 3)
  expect(r.map((x) => `${x.kind}:${x.price}`)).toEqual(['res:3030', 'res:3020', 'res:3010', 'ref:3005', 'sup:3000', 'sup:2990', 'sup:2980'])
})

test('a stale or closed context is indicative; no levels says why', () => {
  render(<CardView card={{ kind: 'context', id: 'x', stock: 'TCS', context: context({ closed: true, levels: [], nearestSupport: null, nearestResistance: null }) }} />)
  expect(screen.getByRole('note').textContent).toMatch(/^Indicative/)
  expect(screen.getByText(/^No levels/)).toBeTruthy()
})

test('the Market context block reads GET /market/:stock/context, and a server without it gets one quiet line', async () => {
  installFetch(({ path }) => (path === '/v1/traders/market/TCS/context' ? { body: context() } : { status: 404, body: { error: 'not found' } }))
  const { unmount } = render(<MarketContextBlock stock="TCS" />)
  expect(await screen.findByRole('region', { name: 'Market context — TCS' })).toBeTruthy()
  unmount()
  installFetch(() => ({ status: 404, body: { error: 'not found' } }))
  render(<MarketContextBlock stock="VEDL" />)
  await waitFor(() => expect(screen.getByText('Market context is not on this server yet')).toBeTruthy())
})

test('a context that throws in render is caught at the block\'s edge, not the book\'s', async () => {
  const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
  const bad = Object.defineProperty(context(), 'warnings', { get: () => { throw new Error('warnings unreadable') } })
  installFetch(() => ({ body: bad }))
  render(<><MarketContextBlock stock="TCS" /><p>the rest of the book</p></>)
  expect(await screen.findByText('This page could not be displayed')).toBeTruthy()
  expect(screen.getByText('the rest of the book')).toBeTruthy()
  quiet.mockRestore()
})

test('better or worse is said without colour: a ✓ or ✗ beside the change and the word for a screen reader', () => {
  render(<CardView card={plansCard()} />)
  const table = screen.getByRole('table', { name: 'P1: now, plan and change' })
  const cell = (metric: string): HTMLElement => table.querySelector(`tr[data-metric="${metric}"] td:last-child`) as HTMLElement
  expect(cell('maxLoss').textContent).toBe('+68.0 k✓ (better)')
  expect(cell('margin').textContent).toBe('+12.0 k✗ (worse)')
  expect(cell('margin').getAttribute('title')).toBe('Worse for this metric')
  expect(cell('margin').querySelector('[aria-hidden="true"]')?.textContent).toBe('✗')
  expect(cell('margin').querySelector('.traders-ai-sr')?.textContent).toBe(' (worse)')
  const flat = metricLines({ ...NOW, theta: 100 }, { ...AFTER, theta: 100 }, {}).find((r) => r.key === 'theta')
  expect(flat?.tone).toBe(null)
})

test('an index\'s context is of the near future: the ladder\'s reference rung is "Fut" at the future, with the day\'s change', () => {
  const idx = context({
    stock: 'NIFTY', reference: 'future', spot: 24980, future: 25040, changePct: -0.35,
    levels: [
      { price: 25200, kind: 'oi-call-wall', strength: 3, distancePct: 0.64, basis: 'call OI' },
      { price: 25000, kind: 'round', strength: 2, distancePct: -0.16, basis: 'round number' },
    ],
    nearestSupport: null, nearestResistance: null,
  })
  render(<CardView card={{ kind: 'context', id: 'n', stock: 'NIFTY', context: idx }} />)
  const ladder = screen.getByRole('img', { name: /^Levels around the future 25,040.00: 1 above, 1 below/ })
  const ref = ladder.querySelector('.traders-ai-rung-ref') as SVGGElement
  expect([...ref.querySelectorAll('text')].map((t) => t.textContent)).toEqual(['25,040.00', 'Fut', '−0.35 % today'])
  // The change sits beside the future, not the spot.
  const price = screen.getByRole('group', { name: 'Price' })
  expect(price.querySelector('[data-reference="true"]')?.textContent).toBe('Fut 25,040.00 −0.35 %')
  expect(screen.getByText(/of the near future/)).toBeTruthy()
  // A stock: the spot, and the change beside it.
  const { container } = render(<CardView card={CONTEXT_CARD} />)
  expect(container.querySelector('[data-reference="true"]')?.textContent).toBe('Spot 3,050.00 +0.42 %')
  expect([...container.querySelectorAll('.traders-ai-rung-ref text')].map((t) => t.textContent)).toEqual(['3,050.00', 'Spot', '+0.42 % today'])
})

test('malformed cards render what they can: missing arrays are empty, missing figures are dashes', () => {
  const broken = [
    { kind: 'plans', id: 'b1', stock: 'TCS', title: 'Thin', objective: 'x', view: null, indicative: false, baseline: undefined },
    { kind: 'plans', id: 'b2', stock: 'TCS', title: 'Thin plans', plans: [{ planId: 'P9' }, null], rejected: [null, { reason: 'x' }] },
    { kind: 'evaluation', id: 'b3', stock: 'TCS', title: 'No plan' },
    { kind: 'neutralize', id: 'b4', stock: 'TCS', futures: { side: 'SELL' } },
    { kind: 'context', id: 'b5', stock: 'TCS', context: { stock: 'TCS', levels: [{ price: 'x' }, { price: 3100, kind: 'r9' }], oi: { pcr: 'n/a' }, warnings: 'no' } },
    { kind: 'context', id: 'b6', stock: 'TCS' },
    { kind: 'novel', id: 'b7' },
  ] as unknown as AssistantCard[]
  const { container } = render(<>{broken.map((c, i) => <CardView key={i} card={c} />)}</>)
  expect(container.querySelector('.traders-ai-card-failed')).toBe(null)
  expect(screen.getByRole('region', { name: 'Thin' }).textContent).toMatch(/No plan meets the goal/)
  expect(screen.getByRole('table', { name: 'P9: now, plan and change' })).toBeTruthy()
  expect(screen.getByText('No figures came with this evaluation')).toBeTruthy()
  expect(screen.getByRole('group', { name: 'Futures route' }).textContent).toContain('—')
  expect(screen.getByRole('img', { name: /^Levels around the price: 1 above/ }).textContent).toContain('r9')   // no price to centre on
  expect(screen.getByText('No market context came with this card')).toBeTruthy()
})

test('a card that still throws is one line of text; the cards beside it render', () => {
  const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
  // Whatever the reason a render throws (here: reading the card's plans does), only that card is lost.
  const bad = Object.defineProperty({ ...plansCard(), id: 'bad' }, 'plans', { get: () => { throw new Error('plans unreadable') } }) as AssistantCard
  render(<><CardView card={bad} /><CardView card={NEUTRALIZE} /></>)
  expect(screen.getByText('This card could not be shown (plans unreadable)')).toBeTruthy()
  expect(screen.getByRole('region', { name: 'Neutralize delta — TCS' })).toBeTruthy()
  quiet.mockRestore()
})
