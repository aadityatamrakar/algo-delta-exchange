/** The band chip, the Advice sub-tab (relief-r's card, the band override, repairs) and the tab badge: Show on payoff only. */
import { expect, test, afterEach, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { AdviceCard, BandStatus, RepairCardPlan, RepairView } from '../../../traders/src/analytics/r3-wire.ts'
import { AdviceCardView, AdviceTab, BandChip, RepairList } from '../../src/traders/advice.tsx'
import { BookTab } from '../../src/traders/book.tsx'
import { BOOK_TAB_BADGES } from '../../src/traders/books.tsx'
import { openWhatIf } from '../../src/traders/what-if.ts'
import { installFetch, type SentRequest } from '../http.tsx'
import { ASOF, MANUAL_SHARES, bookView, leg, summaries, noteItems, openNotes } from './fixtures.ts'

vi.mock('../../src/traders/what-if.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/traders/what-if.ts')>()),
  openWhatIf: vi.fn(),
}))

afterEach(() => {
  cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); vi.mocked(openWhatIf).mockClear()
  Reflect.deleteProperty(document, 'hidden')
})

const ADVICE_PATH = '/v1/traders/books/TCS/advice'
const BAND_PATH = '/v1/traders/books/TCS/band'
const REPAIR_PATH = '/v1/traders/books/TCS/repair'
const OUT_SENTENCE = 'Out of band by 1 lot — To neutralize: Buy 5 lots TCS OCT FUT'
const HISTORY = 'Built from trades since 2026-08-25. Positions opened before then, and shares delivered at expiry, count only if added as manual legs.'
/** Spec item 6: nothing on this tab may read as an order control. */
const FORBIDDEN = /apply|place|submit|order|execute/i

function band(over: Partial<BandStatus> = {}): BandStatus {
  return {
    state: 'out', netDelta: 1050, bandShares: 700, bandLots: 4, outByLots: 1, lotSize: 175, source: 'engine',
    toNeutralize: { units: -1050, price: null, pct: null, lots: 5, side: 'Buy', contract: 'TCS OCT FUT', text: 'Buy 5 lots TCS OCT FUT' },
    marketOpen: true, sentence: OUT_SENTENCE,
    ...over,
  }
}

function card(over: Partial<AdviceCard> = {}): AdviceCard {
  return {
    stock: 'TCS', asOf: ASOF, computedAt: ASOF, status: 'advice',
    headline: 'Sell 2 lots TCS OCT 3500 CE',
    lines: ['Sell 2 lots TCS OCT 3500 CE', 'Buy back 1 lot TCS OCT 3300 PE'],
    reason: 'corridor: net delta +1050 is past the band of 700',
    trigger: 'corridor',
    whatIf: [
      { instrument: 'option', expiry: '2026-10-27', strike: 3500, optType: 'CE', qty: -350, price: 80 },
      { instrument: 'option', expiry: '2026-10-27', strike: 3300, optType: 'PE', qty: 175, price: 21.5 },
    ],
    notes: [
      HISTORY,
      'From where the book stands now: the engine starts clean each time and does not remember earlier suggestions.',
      'Advises on the 27 Oct expiry only.',
    ],
    band: band(), historyFrom: '2026-08-25',
    ...over,
  }
}

const UNAVAILABLE = card({
  status: 'unavailable', headline: 'No advice: the market data feed is dead', lines: [], reason: '', trigger: 'none', whatIf: [],
  band: band({ state: 'unknown', netDelta: null, bandShares: null, bandLots: null, outByLots: 0, toNeutralize: null, sentence: 'Band unknown: the market data feed is dead' }),
})

type Score = RepairCardPlan['score']
const score = (over: Partial<Score> = {}): Score => ({
  credit: 1200, maxLoss: -45000, maxLossAt: 2950, breakevens: [2980, 3120], worstShock: -30000, worstShockAt: 2745,
  marginBefore: 150000, marginAfter: 160000, marginDelta: 10000, profitableWidthPct: 55, pop: 0.6, ...over,
})

const PLAN_1: RepairCardPlan = {
  moves: [{ op: 'add', strike: 3300, type: 'PE', qty: -175 }], score: score(), flags: [],
  lines: ['Sell 1 lot (175) 3300 PE at 21.50'],
  whatIf: [{ instrument: 'option', expiry: '2026-10-27', strike: 3300, optType: 'PE', qty: -175, price: 21.5 }],
}
const PLAN_2: RepairCardPlan = {
  moves: [{ op: 'close', legId: 'C0001|option|TCS|2026-10-27|3500|CE' }], score: score({ credit: -14000, maxLoss: -20000, marginDelta: -60000 }), flags: ['degrades-floor'],
  lines: ['Close the short 3500 CE (-175): buy 1 lot (175) at 80.00'],
  whatIf: [{ instrument: 'option', expiry: '2026-10-27', strike: 3500, optType: 'CE', qty: 175, price: 80 }],
}
const BASELINE: RepairCardPlan = { moves: [], score: score({ credit: 0, marginDelta: 0 }), flags: ['baseline'], lines: [], whatIf: [] }
const TAIL_1: RepairCardPlan = {
  moves: [{ op: 'hedge', strike: 3200, type: 'PE', qty: 175 }], score: score({ credit: -900 }), flags: [],
  lines: ['Buy 1 lot (175) 3200 PE at 9.00'],
  whatIf: [{ instrument: 'option', expiry: '2026-10-27', strike: 3200, optType: 'PE', qty: 175, price: 9 }],
}

const REPAIRS: RepairView = {
  stock: 'TCS', expiry: '2026-10-27', asOf: ASOF, computedAt: ASOF, cached: false,
  goals: [
    { goal: 'REDUCE-LOSS', plans: [PLAN_1, PLAN_2, BASELINE] },
    { goal: 'CHEAP-TAIL-CAP', plans: [TAIL_1, BASELINE] },
  ],
  offset: null, warnings: ['P&L already booked is not counted in these figures'], error: null,
}

/** Every control's accessible text: the buttons, links and anything acting as one. */
/** Every control but the notes' own fold, Dismiss and "N hidden — show" (caveats.tsx): those show or hide a line, they act on nothing. */
function controls(root: HTMLElement = document.body): string[] {
  return [...root.querySelectorAll('button, a, [role="button"], [role="menuitem"], [role="link"], input[type="submit"]')]
    .map((e) => `${e.textContent ?? ''} ${e.getAttribute('aria-label') ?? ''}`.trim())
    .filter((name) => !/^(Dismiss|\d+ hidden — show|Notes \(\d+\))/.test(name))
}

const posts = (sent: readonly SentRequest[], path: string): SentRequest[] => sent.filter((r) => r.path === path && r.method !== 'GET')

// ------------------------------------------------------------------ the chip

test('the chip renders an out-of-band sentence in a danger tone', async () => {
  const sent = installFetch(({ path }) => (path === ADVICE_PATH ? { body: card() } : { status: 404, body: { error: 'no such route' } }))
  render(<BandChip stock="TCS" view={bookView()} />)
  const text = await screen.findByText(OUT_SENTENCE)
  expect(screen.getByRole('img', { name: 'Out of band' }).getAttribute('data-variant')).toBe('error')
  expect(text.getAttribute('style')).toContain('var(--color-text-red)')
  expect(sent.map((r) => r.path)).toEqual([ADVICE_PATH])
})

test('in band is the success tone; unknown says its sentence in the neutral tone', async () => {
  installFetch(() => ({ body: card({ band: band({ state: 'in', outByLots: 0, sentence: 'In band (±4 lots)' }) }) }))
  render(<BandChip stock="TCS" view={bookView()} />)
  expect((await screen.findByText('In band (±4 lots)')).getAttribute('style')).toContain('var(--color-text-green)')
  expect(screen.getByRole('img', { name: 'In band' }).getAttribute('data-variant')).toBe('success')
  cleanup()

  installFetch(() => ({ body: UNAVAILABLE }))
  render(<BandChip stock="TCS" view={bookView()} />)
  const text = await screen.findByText('Band unknown: the market data feed is dead')
  expect(text.getAttribute('style') ?? '').not.toMatch(/--color-text-(red|green)/)
  expect(screen.getByRole('img', { name: 'Band unknown' }).getAttribute('data-variant')).toBe('neutral')
})

test('the chip polls the advice every 60 s', async () => {
  vi.useFakeTimers()
  const sent = installFetch(() => ({ body: card() }))
  render(<BandChip stock="TCS" view={bookView()} />)
  await act(async () => { await vi.advanceTimersByTimeAsync(0) })
  expect(sent.filter((r) => r.path === ADVICE_PATH)).toHaveLength(1)
  await act(async () => { await vi.advanceTimersByTimeAsync(59_000) })
  expect(sent.filter((r) => r.path === ADVICE_PATH)).toHaveLength(1)
  await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })
  expect(sent.filter((r) => r.path === ADVICE_PATH)).toHaveLength(2)
})

test('a refresh that fails turns the chip neutral and says how old its reading is', async () => {
  vi.useFakeTimers()
  let calls = 0
  installFetch(() => (calls++ === 0 ? { body: card() } : { status: 500, body: { error: 'boom' } }))
  render(<BandChip stock="TCS" view={bookView()} />)
  await act(async () => { await vi.advanceTimersByTimeAsync(0) })
  expect(screen.getByText(OUT_SENTENCE).getAttribute('style')).toContain('var(--color-text-red)')
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
  const text = screen.getByText(`${OUT_SENTENCE} — as of 10:27 IST, refresh failed`)
  expect(text.getAttribute('style') ?? '').not.toMatch(/--color-text-(red|green)/)
  expect(screen.getByRole('img', { name: 'Band unknown' }).getAttribute('data-variant')).toBe('neutral')
  expect(screen.queryByRole('img', { name: 'Out of band' })).toBeNull()
})

test('a chip with no reading at all says "Band unknown" and why', async () => {
  installFetch(() => ({ status: 500, body: { error: 'boom' } }))
  render(<BandChip stock="TCS" view={bookView()} />)
  expect(await screen.findByText('Band unknown: boom')).toBeTruthy()
  expect(screen.getByRole('img', { name: 'Band unknown' }).getAttribute('data-variant')).toBe('neutral')
})

test('the card is read again at once when the book\'s legs change, not a minute later', async () => {
  const sent = installFetch(() => ({ body: card() }))
  const { rerender } = render(<BandChip stock="TCS" view={bookView()} />)
  await screen.findByText(OUT_SENTENCE)
  expect(sent.filter((r) => r.path === ADVICE_PATH)).toHaveLength(1)
  // The same legs in a fresh poll of the book ask for nothing.
  rerender(<BandChip stock="TCS" view={bookView()} />)
  rerender(<BandChip stock="TCS" view={bookView({ legs: [leg(), MANUAL_SHARES, leg({ key: 'C0001|option|TCS|2026-10-27|3300|PE', strike: 3300, optType: 'PE' })] })} />)
  await waitFor(() => expect(sent.filter((r) => r.path === ADVICE_PATH)).toHaveLength(2))
})

test('a hidden tab asks for no advice; showing it asks at once', async () => {
  vi.useFakeTimers()
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
  const sent = installFetch(() => ({ body: card() }))
  render(<AdviceTab stock="TCS" view={bookView()} />)
  await act(async () => { await vi.advanceTimersByTimeAsync(120_000) })
  expect(sent).toEqual([])
  Reflect.deleteProperty(document, 'hidden')
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
  expect(sent.map((r) => r.path)).toEqual([ADVICE_PATH])
})

// ------------------------------------------------------------------ the card

test('the card renders its lines, its reason, and the history line first among the notes; Show on payoff opens the what-if', () => {
  const c = card()
  render(<AdviceCardView card={c} />)
  expect(screen.getByRole('heading', { name: 'Sell 2 lots TCS OCT 3500 CE' })).toBeTruthy()
  expect(screen.getByText('Buy back 1 lot TCS OCT 3300 PE')).toBeTruthy()
  expect(screen.getByText('corridor: net delta +1050 is past the band of 700')).toBeTruthy()
  openNotes()
  const notes = noteItems(screen.getByRole('list', { name: 'Notes' }))
  expect(notes).toHaveLength(c.notes.length)
  c.notes.forEach((note, i) => { expect(within(notes[i] as HTMLElement).getByText(note)).toBeTruthy() })
  expect(within(notes[0] as HTMLElement).getByText(HISTORY)).toBeTruthy()
  expect(controls()).toEqual(['Show on payoff'])
  fireEvent.click(screen.getByRole('button', { name: 'Show on payoff' }))
  expect(vi.mocked(openWhatIf)).toHaveBeenCalledTimes(1)
  expect(vi.mocked(openWhatIf)).toHaveBeenCalledWith('TCS', c.whatIf, 'relief-r suggestion')
})

test('an unavailable card shows its headline and no action at all', () => {
  render(<AdviceCardView card={UNAVAILABLE} />)
  expect(screen.getByRole('heading', { name: 'No advice: the market data feed is dead' })).toBeTruthy()
  expect(controls()).toEqual([])
  openNotes()
  expect(within(noteItems(screen.getByRole('list', { name: 'Notes' }))[0] as HTMLElement).getByText(HISTORY)).toBeTruthy()
})

// ------------------------------------------------------------- the whole tab

function serveBook(repair: () => { status?: number; body?: unknown } = () => ({ body: REPAIRS })): SentRequest[] {
  return installFetch(({ path, method, body }) => {
    if (path === '/v1/traders/books/TCS') return { body: bookView() }
    if (path === ADVICE_PATH) return { body: card() }
    if (path === BAND_PATH && method === 'PUT') return { body: band({ source: 'override', bandLots: body?.['lots'] as number }) }
    if (path === REPAIR_PATH && method === 'POST') return repair()
    return { status: 404, body: { error: 'no such route' } }
  })
}

test('no button anywhere in the Advice sub-tab reads as an order control (spec item 6)', async () => {
  serveBook()
  window.location.hash = '#/books/TCS/advice'
  render(<BookTab stock="TCS" />)
  await screen.findByRole('heading', { name: 'Sell 2 lots TCS OCT 3500 CE' })
  fireEvent.click(screen.getByRole('button', { name: 'Find repairs' }))
  await screen.findByRole('heading', { name: 'Reduce loss' })
  // The folded plans too: every plan's control is swept, not only each goal's first.
  fireEvent.click(screen.getByRole('button', { name: '1 more plan' }))
  const all = controls()
  // Not vacuous: the card's, the band's and every plan's controls are on screen.
  expect(all).toEqual(expect.arrayContaining(['Show on payoff', 'Set band', 'Find repairs']))
  expect(all.filter((t) => t.startsWith('Show on payoff'))).toHaveLength(4)
  expect(all.filter((t) => FORBIDDEN.test(t))).toEqual([])
  // The band chip sits in the book's header beside the tab.
  expect(screen.getByRole('img', { name: 'Out of band' })).toBeTruthy()
})

test('the band override sends lots, and an empty field clears it', async () => {
  const sent = serveBook()
  window.location.hash = '#/books/TCS/advice'
  render(<BookTab stock="TCS" />)
  const field = await screen.findByRole('textbox', { name: /Band override/ })
  fireEvent.change(field, { target: { value: '2.5' } })
  fireEvent.click(screen.getByRole('button', { name: 'Set band' }))
  await waitFor(() => expect(posts(sent, BAND_PATH)).toHaveLength(1))
  expect(posts(sent, BAND_PATH)[0]?.body).toEqual({ lots: 2.5 })
  // A write re-reads the card at once, chip included, rather than waiting out the minute.
  await waitFor(() => expect(sent.filter((r) => r.path === ADVICE_PATH).length).toBeGreaterThanOrEqual(4))
  fireEvent.change(screen.getByRole('textbox', { name: /Band override/ }), { target: { value: '' } })
  fireEvent.click(screen.getByRole('button', { name: 'Set band' }))
  await waitFor(() => expect(posts(sent, BAND_PATH)).toHaveLength(2))
  expect(posts(sent, BAND_PATH)[1]?.body).toEqual({ lots: null })
})

test('a band the server refuses shows its reason and keeps the field; a field that is not a number is not sent', async () => {
  const REFUSED = 'lots must be a number above 0 and at most 1000, or null to clear the override'
  const sent = installFetch(({ path, method }) => {
    if (path === ADVICE_PATH) return { body: card() }
    if (path === BAND_PATH && method === 'PUT') return { status: 400, body: { error: REFUSED } }
    return { status: 404, body: { error: 'no such route' } }
  })
  render(<AdviceTab stock="TCS" view={bookView()} />)
  const field = await screen.findByRole('textbox', { name: /Band override/ })
  fireEvent.change(field, { target: { value: 'two' } })
  fireEvent.click(screen.getByRole('button', { name: 'Set band' }))
  expect(await screen.findByText('Enter the band in lots, or leave the field empty to clear it')).toBeTruthy()
  expect(posts(sent, BAND_PATH)).toEqual([])
  fireEvent.change(field, { target: { value: '5000' } })
  fireEvent.click(screen.getByRole('button', { name: 'Set band' }))
  expect(await screen.findByText(REFUSED)).toBeTruthy()
  expect(posts(sent, BAND_PATH)[0]?.body).toEqual({ lots: 5000 })
  expect((screen.getByRole('textbox', { name: /Band override/ }) as HTMLInputElement).value).toBe('5000')
})

// --------------------------------------------------------------- the repairs

test('a busy repair search offers Retry, and Retry posts again; a plan shows on payoff with its own legs', async () => {
  let calls = 0
  const sent = installFetch(({ path, method }) => {
    if (path === REPAIR_PATH && method === 'POST') {
      return calls++ === 0 ? { status: 429, body: { error: 'busy', retryAfterMs: 4000 } } : { body: REPAIRS }
    }
    return { status: 404, body: { error: 'no such route' } }
  })
  render(<RepairList stock="TCS" view={bookView()} />)
  fireEvent.click(screen.getByRole('button', { name: 'Find repairs' }))
  expect(await screen.findByText('Two repair searches are already running; try again in a few seconds')).toBeTruthy()
  expect(posts(sent, REPAIR_PATH)).toHaveLength(1)
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  await screen.findByRole('heading', { name: 'Reduce loss' })
  expect(posts(sent, REPAIR_PATH)).toHaveLength(2)
  expect(posts(sent, REPAIR_PATH)[1]?.body).toEqual({})
  expect(screen.queryByText(/already running/)).toBe(null)

  // The baseline is one line at the top, with no Show on payoff; a goal's later plans are folded.
  expect(screen.getAllByText(/^Now \(do nothing\)/)).toHaveLength(1)
  expect(screen.getByText('P&L already booked is not counted in these figures')).toBeTruthy()
  expect(screen.getAllByRole('button', { name: /^Show on payoff/ })).toHaveLength(2)
  fireEvent.click(screen.getByRole('button', { name: '1 more plan' }))
  expect(screen.getAllByRole('button', { name: /^Show on payoff/ })).toHaveLength(3)
  expect(screen.getByText('Worse worst case')).toBeTruthy()

  fireEvent.click(screen.getByRole('button', { name: 'Show on payoff — Reduce loss plan 2' }))
  expect(vi.mocked(openWhatIf)).toHaveBeenLastCalledWith('TCS', PLAN_2.whatIf, 'Repair: Reduce loss 2')
  fireEvent.click(screen.getByRole('button', { name: 'Show on payoff — Cheap tail cap plan 1' }))
  expect(vi.mocked(openWhatIf)).toHaveBeenLastCalledWith('TCS', TAIL_1.whatIf, 'Repair: Cheap tail cap 1')
})

test('a repair the server cannot run says why in words', async () => {
  installFetch(() => ({ body: { ...REPAIRS, expiry: null, goals: [], warnings: [], error: 'no option legs to repair' } satisfies RepairView }))
  render(<RepairList stock="TCS" view={bookView()} />)
  fireEvent.click(screen.getByRole('button', { name: 'Find repairs' }))
  expect(await screen.findByText('no option legs to repair')).toBeTruthy()
  expect(screen.queryAllByRole('button', { name: /Show on payoff/ })).toEqual([])
})

const NEW_LEGS = bookView({ legs: [leg(), MANUAL_SHARES, leg({ key: 'C0001|option|TCS|2026-10-27|3300|PE', strike: 3300, optType: 'PE' })] })

test('plans found on the old legs are cleared when the book\'s legs change', async () => {
  installFetch(() => ({ body: REPAIRS }))
  const { rerender } = render(<RepairList stock="TCS" view={bookView()} />)
  fireEvent.click(screen.getByRole('button', { name: 'Find repairs' }))
  await screen.findByRole('heading', { name: 'Reduce loss' })
  // A fresh poll of the same legs keeps them.
  rerender(<RepairList stock="TCS" view={bookView()} />)
  expect(screen.getAllByRole('button', { name: /^Show on payoff/ })).toHaveLength(2)
  rerender(<RepairList stock="TCS" view={NEW_LEGS} />)
  expect(screen.queryByRole('heading', { name: 'Reduce loss' })).toBeNull()
  expect(screen.queryAllByRole('button', { name: /Show on payoff/ })).toEqual([])
  expect((screen.getByRole('button', { name: 'Find repairs' }) as HTMLButtonElement).disabled).toBe(false)
})

test('a search still out when the legs change is dropped when it answers', async () => {
  const sent = installFetch(() => ({ body: REPAIRS }))
  const inner = globalThis.fetch
  let release: () => void = () => {}
  const gate = new Promise<void>((r) => { release = r })
  vi.stubGlobal('fetch', async (...a: Parameters<typeof fetch>) => { await gate; return inner(...a) })
  const { rerender } = render(<RepairList stock="TCS" view={bookView()} />)
  fireEvent.click(screen.getByRole('button', { name: 'Find repairs' }))
  expect(screen.getByText('Searching…')).toBeTruthy()
  rerender(<RepairList stock="TCS" view={NEW_LEGS} />)
  release()
  await waitFor(() => expect(posts(sent, REPAIR_PATH)).toHaveLength(1))
  await new Promise((r) => setTimeout(r, 50))
  expect(screen.queryByRole('heading', { name: 'Reduce loss' })).toBeNull()
  expect(screen.queryByText('Searching…')).toBeNull()
})

// ------------------------------------------------------------- the tab badge

test('the tab badge is a danger dot for a book out of band, and nothing for no band', () => {
  const [out] = summaries('TCS').map((s) => ({ ...s, band: 'out' as const }))
  const [none] = summaries('TCS')
  expect(BOOK_TAB_BADGES.length).toBeGreaterThan(0)
  render(<>{BOOK_TAB_BADGES.map((b, i) => <span key={i}>{b(out!)}</span>)}</>)
  expect(screen.getByRole('img', { name: 'Out of band' }).getAttribute('data-variant')).toBe('error')
  expect(BOOK_TAB_BADGES.map((b) => b(none!))).toEqual(BOOK_TAB_BADGES.map(() => null))
})
