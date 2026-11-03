/**
 * The Assistant drawer in the page: its shortcut and the help sheet, the status deciding Chat or Plan search only,
 * the Plan search request, a streamed chat turn with its cards, spend and feedback, Stop, errors and history.
 */
import { afterEach, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { TradersApp } from '../src/traders/app.tsx'
import { setAsTrader } from '../src/traders/api.ts'
import { WIDTH_KEY } from '../src/traders/assistant/drawer.tsx'
import { ASSISTANT_KEY, PAGE_KEYS, SHORTCUTS } from '../src/traders/shortcuts.tsx'
import { bookView, summaries } from './traders/fixtures.ts'
import { NEUTRALIZE, installStreamFetch, plansCard, sse, status, type Answer, type Sent } from './traders/assistant-fixtures.ts'

afterEach(() => { setAsTrader(null); window.localStorage.clear(); window.location.hash = '' })

const STATUS = '/v1/traders/assistant/status'
const CHAT = '/v1/traders/assistant/chat'
const PLAN_SEARCH = '/v1/traders/books/TCS/plan-search'

const TURN = [
  sse('meta', { conversationId: 'cv1', model: 'claude-opus-5-5', stock: 'TCS' }),
  sse('status', { label: 'thinking' }),
  sse('tool', { id: 't1', name: 'get_book', label: 'Book TCS', state: 'start' }),
  sse('tool', { id: 't1', name: 'get_book', label: 'Book TCS', state: 'done', summary: '9 legs' }),
  sse('text', { delta: '**Net Δ +7.1 lots.** Sell 7 lots ' }),
  sse('text', { delta: 'of the Oct future.' }),
  sse('card', NEUTRALIZE),
  sse('usage', { inputTokens: 1200, outputTokens: 300, cachedTokens: 900, costUsd: 0.08, traderUsdToday: 0.5 }),
  sse('done', { provenance: { checked: 6, unverified: ['3,140'] }, turn: 1 }),
]

function mount(route: (req: { path: string; method: string; body: Record<string, unknown> | null }) => Answer | null, role: 'trader' | 'admin' = 'trader'): Sent[] {
  const sent = installStreamFetch((req) => {
    const own = route(req)
    if (own !== null) return own
    const { path, method } = req
    if (path === '/v1/traders/auth/me') return { body: { username: 'ravi', role } }
    if (path === '/v1/traders/books') return { body: summaries('TCS', 'VEDL') }
    if (/^\/v1\/traders\/books\/[^/]+$/.test(path) && method === 'GET') return { body: bookView() }
    if (path === '/v1/traders/orders' || path === '/v1/traders/trades') return { body: [] }
    if (path === '/v1/traders/admin/traders') return { body: [] }
    return { status: 404, body: { error: 'not in this test' } }
  })
  render(<TradersApp themeMode="system" onThemeMode={() => {}} />)
  return sent
}

const key = (k: string): void => { fireEvent.keyDown(document.body, { key: k }) }
const drawer = (): HTMLElement => screen.getByRole('complementary', { name: 'Assistant' })
async function openDrawer(): Promise<HTMLElement> {
  await screen.findByRole('tablist', { name: 'Books' })
  fireEvent.click(screen.getByRole('button', { name: 'Assistant' }))
  return drawer()
}
const posts = (sent: readonly Sent[], path: string): Sent[] => sent.filter((r) => r.path === path && r.method === 'POST')

test(`"${ASSISTANT_KEY}" opens and closes the drawer, Esc closes it, it is in the help sheet and collides with no other key`, async () => {
  window.location.hash = '#/orders'
  mount(({ path }) => (path === STATUS ? { body: status() } : null))
  await screen.findByRole('tablist', { name: 'Books' })
  expect(screen.queryByRole('complementary', { name: 'Assistant' })).toBe(null)   // nothing mounted, nothing asked
  key(ASSISTANT_KEY)
  expect(drawer()).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Assistant' }).getAttribute('aria-expanded')).toBe('true')
  expect(window.localStorage.getItem('traders.assistant')).toBe('open')
  key('Escape')
  await waitFor(() => expect(screen.queryByRole('complementary', { name: 'Assistant' })).toBe(null))
  expect(window.localStorage.getItem('traders.assistant')).toBe('closed')
  key(ASSISTANT_KEY)
  expect(drawer()).toBeTruthy()

  // The help sheet lists it; no other shortcut uses the key, and `g i` is no page.
  key('?')
  const sheet = await screen.findByRole('table', { name: 'Keyboard shortcuts' })
  const row = within(sheet).getAllByRole('row').find((r) => r.querySelector('kbd')?.textContent === ASSISTANT_KEY)
  expect(row?.textContent).toMatch(/assistant/i)
  const singles = SHORTCUTS.map((s) => s.keys).filter((k) => k.length === 1)
  expect(singles.filter((k) => k === ASSISTANT_KEY)).toHaveLength(1)
  expect(Object.keys(PAGE_KEYS)).not.toContain(ASSISTANT_KEY)
  expect(['g', '[', ']', '/', '\\', 'n', '?', 'e', 'Esc']).not.toContain(ASSISTANT_KEY)
})

test('the drawer remembers it was open; a field keeps the key as text', async () => {
  window.localStorage.setItem('traders.assistant', 'open')
  window.location.hash = '#/orders'
  mount(({ path }) => (path === STATUS ? { body: status() } : null))
  await screen.findByRole('tablist', { name: 'Books' })
  const box = await within(drawer()).findByRole('textbox', { name: 'Message' })
  box.focus()
  fireEvent.keyDown(box, { key: ASSISTANT_KEY })
  expect(screen.getByRole('complementary', { name: 'Assistant' })).toBeTruthy()
})

test('assistant switched off: the reason and Plan search only — no chat box', async () => {
  window.location.hash = '#/orders'
  mount(({ path }) => (path === STATUS ? { body: status({ enabled: false, reason: 'No API key is configured.' }) } : null))
  const d = await openDrawer()
  expect(await within(d).findByText('No API key is configured.')).toBeTruthy()
  expect(within(d).getByRole('form', { name: 'Plan search' })).toBeTruthy()
  expect(within(d).queryByRole('textbox', { name: 'Message' })).toBe(null)
  expect(within(d).queryByRole('tab', { name: 'Chat' })).toBe(null)
  expect(within(d).queryByRole('group', { name: 'Suggested questions' })).toBe(null)   // nothing to send them to
})

test('a server without the assistant (404): the page stands, the drawer says so and offers Plan search with the built-in goals', async () => {
  window.location.hash = '#/orders'
  mount(() => null)
  const d = await openDrawer()
  expect(await within(d).findByText(/not on this server yet/)).toBeTruthy()
  expect(within(d).getByRole('form', { name: 'Plan search' })).toBeTruthy()
  expect(within(d).getByRole('button', { name: /Collect credit, safely/ })).toBeTruthy()
  expect(within(d).queryByRole('textbox', { name: 'Message' })).toBe(null)
  expect(screen.getByRole('navigation', { name: 'Pages' })).toBeTruthy()
})

test('Plan search on a book: the first goal is the goal, later ones are kept no worse; view and closing go as chosen', async () => {
  window.location.hash = '#/books/TCS'
  const sent = mount(({ path }) => (path === STATUS ? { body: status({ enabled: false, reason: 'Off.' }) }
    : path === PLAN_SEARCH ? { body: { card: plansCard() } } : null))
  const d = await openDrawer()
  const form = await within(d).findByRole('form', { name: 'Plan search' })
  expect(within(d).getByText('TCS')).toBeTruthy()                                   // the book's context chip
  const search = within(form).getByRole('button', { name: 'Search' })
  expect(search.hasAttribute('disabled') || search.getAttribute('aria-disabled') === 'true').toBe(true)   // no goal yet

  fireEvent.click(within(form).getByRole('button', { name: /Neutralize delta/ }))
  fireEvent.click(within(form).getByRole('button', { name: /Cut margin/ }))
  const goals = within(form).getByRole('group', { name: 'Goals' })
  expect(within(goals).getByRole('button', { name: /Neutralize delta/ }).getAttribute('data-role')).toBe('primary')
  expect(within(goals).getByRole('button', { name: /Cut margin/ }).getAttribute('data-role')).toBe('keep')
  expect(within(form).getByText('Goal: Neutralize delta · keep no worse: Cut margin')).toBeTruthy()

  // Implied (the default) is not sent; closing is off.
  fireEvent.click(within(form).getByRole('button', { name: 'Search' }))
  await within(d).findByRole('region', { name: 'Neutralize delta, keep margin' })
  expect(posts(sent, PLAN_SEARCH)[0]?.body).toEqual({ presets: ['neutralize-delta', 'cut-margin'] })

  fireEvent.click(within(form).getByRole('radio', { name: 'HV20' }))
  fireEvent.click(within(form).getByRole('checkbox', { name: 'Allow closing legs' }))
  fireEvent.click(within(form).getByRole('button', { name: 'Search' }))
  await waitFor(() => expect(posts(sent, PLAN_SEARCH)).toHaveLength(2))
  expect(posts(sent, PLAN_SEARCH)[1]?.body).toEqual({ presets: ['neutralize-delta', 'cut-margin'], view: { vol: 'hv20' }, allowClose: true })

  // Taking the goal out makes the next pick the goal.
  fireEvent.click(within(goals).getByRole('button', { name: /Neutralize delta/ }))
  expect(within(goals).getByRole('button', { name: /Cut margin/ }).getAttribute('data-role')).toBe('primary')
})

test('IV − x pts sends a negative shift; my vol % sends a decimal annual vol', async () => {
  window.location.hash = '#/books/TCS'
  const sent = mount(({ path }) => (path === STATUS ? { status: 404 } : path === PLAN_SEARCH ? { body: { card: plansCard() } } : null))
  const d = await openDrawer()
  const form = await within(d).findByRole('form', { name: 'Plan search' })
  fireEvent.click(within(form).getByRole('button', { name: /Raise POP/ }))
  fireEvent.click(within(form).getByRole('radio', { name: 'IV − x pts' }))
  fireEvent.click(within(form).getByRole('button', { name: 'Search' }))
  await waitFor(() => expect(posts(sent, PLAN_SEARCH)).toHaveLength(1))
  expect(posts(sent, PLAN_SEARCH)[0]?.body).toEqual({ presets: ['raise-pop'], view: { vol: { shiftPts: -2 } } })
  fireEvent.click(within(form).getByRole('radio', { name: 'My vol %' }))
  fireEvent.change(within(form).getByRole('spinbutton', { name: 'My annual vol %' }), { target: { value: '22' } })
  fireEvent.blur(within(form).getByRole('spinbutton', { name: 'My annual vol %' }))
  await waitFor(() => expect(within(form).getByRole('button', { name: 'Search' }).hasAttribute('disabled')).toBe(false))
  fireEvent.click(within(form).getByRole('button', { name: 'Search' }))
  await waitFor(() => expect(posts(sent, PLAN_SEARCH)).toHaveLength(2))
  expect(posts(sent, PLAN_SEARCH)[1]?.body).toEqual({ presets: ['raise-pop'], view: { vol: { annual: 0.22 } } })
})

test('a server without plan search says so in the form', async () => {
  window.location.hash = '#/books/TCS'
  mount(({ path }) => (path === STATUS ? { status: 404 } : null))
  const d = await openDrawer()
  const form = await within(d).findByRole('form', { name: 'Plan search' })
  fireEvent.click(within(form).getByRole('button', { name: /Cut margin/ }))
  fireEvent.click(within(form).getByRole('button', { name: 'Search' }))
  expect((await within(form).findByRole('alert')).textContent).toMatch(/^Plan search is not on this server yet/)
})

test('a chat turn streams in: text as markdown, its tools folded once done, the card, the spend line, an unverified badge; Enter sends', async () => {
  window.location.hash = '#/books/TCS'
  const sent = mount(({ path }) => (path === STATUS ? { body: status() } : path === CHAT ? { stream: TURN } : null))
  const d = await openDrawer()
  const box = await within(d).findByRole('textbox', { name: 'Message' })
  expect(within(d).getByText('Today $0.42 of $5.00')).toBeTruthy()
  fireEvent.change(box, { target: { value: 'what is my delta?' } })
  fireEvent.keyDown(box, { key: 'Enter', shiftKey: true })                       // a new line, not a send
  expect(posts(sent, CHAT)).toHaveLength(0)
  fireEvent.keyDown(box, { key: 'Enter' })
  await within(d).findByText('of the Oct future.', { exact: false })
  expect(posts(sent, CHAT)[0]?.body).toEqual({ message: 'what is my delta?', stock: 'TCS' })
  const log = within(d).getByRole('log', { name: 'Conversation' })
  expect(within(log).getByText('what is my delta?')).toBeTruthy()
  expect(log.querySelector('strong')?.textContent).toBe('Net Δ +7.1 lots.')
  const fold = log.querySelector('details.traders-ai-tools') as HTMLDetailsElement
  expect(fold.open).toBe(false)
  expect(fold.querySelector('summary')?.textContent).toBe('Used 1 tool')
  expect(within(fold).getByText(/Book TCS/).getAttribute('data-state')).toBe('done')
  expect(log.querySelector('.traders-ai-step')).toBe(null)                        // no step line once done
  expect(within(log).queryByText(/thinking/i)).toBe(null)
  expect(within(log).getByRole('region', { name: 'Neutralize delta — TCS' })).toBeTruthy()
  expect(within(log).getByText('1 unverified figure')).toBeTruthy()
  expect(within(d).getByText('Today $0.50 of $5.00')).toBeTruthy()
  expect((box as HTMLTextAreaElement).value).toBe('')
  expect(within(d).getByText('claude-opus-5-5')).toBeTruthy()

  // The next turn goes on the same conversation.
  fireEvent.change(box, { target: { value: 'and margin?' } })
  fireEvent.click(within(d).getByRole('button', { name: 'Send' }))
  await waitFor(() => expect(posts(sent, CHAT)).toHaveLength(2))
  expect(posts(sent, CHAT)[1]?.body).toEqual({ message: 'and margin?', conversationId: 'cv1', stock: 'TCS' })
})

test('feedback: a thumb sends { turn, rating }, a note goes with it, the saved state shows', async () => {
  window.location.hash = '#/orders'
  const FEEDBACK = '/v1/traders/assistant/conversations/cv1/feedback'
  const sent = mount(({ path }) => (path === STATUS ? { body: status() } : path === CHAT ? { stream: TURN } : path === FEEDBACK ? { body: { ok: true } } : null))
  const d = await openDrawer()
  const box = await within(d).findByRole('textbox', { name: 'Message' })
  fireEvent.change(box, { target: { value: 'delta?' } })
  fireEvent.keyDown(box, { key: 'Enter' })
  const rate = await within(d).findByRole('group', { name: 'Rate this answer' })
  fireEvent.click(within(rate).getByRole('button', { name: 'Poor answer' }))
  await within(rate).findByText('Saved')
  expect(posts(sent, FEEDBACK).map((r) => r.body)).toEqual([{ turn: 1, rating: 'down' }])
  expect(within(rate).getByRole('button', { name: 'Poor answer' }).getAttribute('aria-pressed')).toBe('true')

  fireEvent.click(within(rate).getByRole('button', { name: 'Add a note' }))
  const note = within(rate).getByRole('textbox', { name: 'Note on this answer' })
  expect(note.getAttribute('maxlength')).toBe('500')
  fireEvent.change(note, { target: { value: 'missed the expiry risk' } })
  fireEvent.click(within(rate).getByRole('button', { name: 'Save note' }))
  await within(rate).findByText('Saved, with note')
  expect(posts(sent, FEEDBACK).map((r) => r.body)[1]).toEqual({ turn: 1, rating: 'down', note: 'missed the expiry risk' })
})

test('feedback on a server without the route: one quiet line, the thumbs reset', async () => {
  window.location.hash = '#/orders'
  mount(({ path }) => (path === STATUS ? { body: status() } : path === CHAT ? { stream: TURN } : null))
  const d = await openDrawer()
  const box = await within(d).findByRole('textbox', { name: 'Message' })
  fireEvent.change(box, { target: { value: 'delta?' } })
  fireEvent.keyDown(box, { key: 'Enter' })
  const rate = await within(d).findByRole('group', { name: 'Rate this answer' })
  fireEvent.click(within(rate).getByRole('button', { name: 'Good answer' }))
  expect(await within(rate).findByText('Feedback is not on this server yet')).toBeTruthy()
  expect(within(rate).getByRole('button', { name: 'Good answer' }).getAttribute('aria-pressed')).toBe('false')
})

test('Stop aborts the running answer; the box is free again', async () => {
  window.location.hash = '#/orders'
  mount(({ path }) => (path === STATUS ? { body: status() }
    : path === CHAT ? { stream: [sse('meta', { conversationId: 'cv2', model: 'm', stock: null }), sse('text', { delta: 'Partial' })], hold: true } : null))
  const d = await openDrawer()
  const box = await within(d).findByRole('textbox', { name: 'Message' })
  fireEvent.change(box, { target: { value: 'long question' } })
  fireEvent.keyDown(box, { key: 'Enter' })
  await within(d).findByText('Partial')
  fireEvent.click(within(d).getByRole('button', { name: 'Stop' }))
  expect(await within(d).findByText('Stopped')).toBeTruthy()
  expect(within(d).getByRole('button', { name: 'Send' })).toBeTruthy()
  expect(within(d).queryByRole('group', { name: 'Rate this answer' })).toBe(null)   // no turn number came
})

test('a refused turn says why: busy, budget from the stream, the admin\'s ?as= rides along', async () => {
  window.location.hash = '#/orders'
  let n = 0
  const sent = mount(({ path }) => {
    if (path === STATUS) return { body: status() }
    if (path !== CHAT) return null
    n += 1
    return n === 1 ? { status: 429, body: { error: 'a turn is running', code: 'busy' } }
      : { stream: [sse('error', { message: 'trader cap $5.00 reached', code: 'budget' })] }
  }, 'admin')
  setAsTrader('ravi')
  const d = await openDrawer()
  const box = await within(d).findByRole('textbox', { name: 'Message' })
  fireEvent.change(box, { target: { value: 'one' } })
  fireEvent.keyDown(box, { key: 'Enter' })
  expect((await within(d).findByRole('alert')).textContent).toMatch(/already running/)
  fireEvent.change(box, { target: { value: 'two' } })
  fireEvent.keyDown(box, { key: 'Enter' })
  await waitFor(() => expect(within(d).getAllByRole('alert')).toHaveLength(2))
  expect(within(d).getAllByRole('alert')[1]?.textContent).toBe('trader cap $5.00 reached')
  expect(within(d).getAllByRole('alert')[1]?.getAttribute('data-code')).toBe('budget')
  expect(sent.filter((r) => r.path === CHAT).every((r) => r.query === '?as=ravi')).toBe(true)
})

test('history: list, open a conversation (its answers rated by turn), take one off the list; the context chip clears', async () => {
  window.location.hash = '#/books/TCS'
  const sent = mount(({ path, method }) => {
    if (path === STATUS) return { body: status() }
    if (path === '/v1/traders/assistant/conversations') {
      return { body: [{ id: 'cv7', title: 'TCS delta', stock: 'TCS', updatedAt: Date.UTC(2026, 9, 22, 5, 0), model: 'claude-opus-5-5' },
        { id: 'cv8', title: 'Margin', stock: null, updatedAt: Date.UTC(2026, 9, 21, 5, 0), model: 'claude-opus-5-5' }] }
    }
    if (path === '/v1/traders/assistant/conversations/cv7' && method === 'GET') {
      return { body: { id: 'cv7', stock: 'TCS', turns: [{ role: 'user', text: 'delta?', cards: [], at: 1 }, { role: 'assistant', text: 'Long 7 lots', cards: [], at: 2, feedback: 'up' }] } }
    }
    if (path === '/v1/traders/assistant/conversations/cv8' && method === 'DELETE') return { body: {} }
    if (path === CHAT) return { stream: TURN }
    return null
  })
  const d = await openDrawer()
  await within(d).findByRole('textbox', { name: 'Message' })
  fireEvent.click(within(d).getByRole('button', { name: 'Clear the TCS context' }))
  fireEvent.change(within(d).getByRole('textbox', { name: 'Message' }), { target: { value: 'portfolio?' } })
  fireEvent.keyDown(within(d).getByRole('textbox', { name: 'Message' }), { key: 'Enter' })
  await waitFor(() => expect(posts(sent, CHAT)).toHaveLength(1))
  expect(posts(sent, CHAT)[0]?.body).toEqual({ message: 'portfolio?' })            // no stock once the chip is cleared

  fireEvent.click(within(d).getByRole('tab', { name: 'History' }))
  const list = await within(d).findByRole('list', { name: 'Conversations' })
  fireEvent.click(within(list).getByRole('button', { name: /Remove “Margin”/ }))
  await waitFor(() => expect(within(list).queryByText('Margin')).toBe(null))
  expect(sent.some((r) => r.path === '/v1/traders/assistant/conversations/cv8' && r.method === 'DELETE')).toBe(true)
  fireEvent.click(within(list).getByRole('button', { name: /^TCS delta/ }))
  const log = await within(d).findByRole('log', { name: 'Conversation' })
  expect(within(log).getByText('Long 7 lots')).toBeTruthy()
  const rate = within(log).getByRole('group', { name: 'Rate this answer' })
  expect(within(rate).getByRole('button', { name: 'Good answer' }).getAttribute('aria-pressed')).toBe('true')
  expect(within(rate).getByText('Saved')).toBeTruthy()
})

test('the drawer offers nothing that reads as an order control', async () => {
  const FORBIDDEN = /place|apply|square ?off|kill|flatten|submit order|cancel order|modify order|exit position|buy now|sell now|send order|execute/i
  window.location.hash = '#/books/TCS'
  mount(({ path }) => (path === STATUS ? { body: status() } : path === CHAT ? { stream: TURN } : null))
  const d = await openDrawer()
  const box = await within(d).findByRole('textbox', { name: 'Message' })
  fireEvent.change(box, { target: { value: 'delta?' } })
  fireEvent.keyDown(box, { key: 'Enter' })
  await within(d).findByText('1 unverified figure')
  await act(async () => { fireEvent.click(within(d).getByRole('tab', { name: 'Plan search' })) })
  fireEvent.click(within(d).getByRole('tab', { name: 'Chat' }))
  const labels = [...d.querySelectorAll('button, a, [role="button"], [role="tab"], [role="radio"]')].map((n) => (n.getAttribute('aria-label') ?? n.textContent ?? '').trim())
  expect(labels.filter((t) => FORBIDDEN.test(t))).toEqual([])
})

test('a rating and a plan-search result survive switching tabs', async () => {
  window.location.hash = '#/books/TCS'
  const FEEDBACK = '/v1/traders/assistant/conversations/cv1/feedback'
  mount(({ path }) => (path === STATUS ? { body: status() } : path === CHAT ? { stream: TURN }
    : path === FEEDBACK ? { body: {} } : path === PLAN_SEARCH ? { body: { card: plansCard() } } : null))
  const d = await openDrawer()
  const box = await within(d).findByRole('textbox', { name: 'Message' })
  fireEvent.change(box, { target: { value: 'delta?' } })
  fireEvent.keyDown(box, { key: 'Enter' })
  const rate = await within(d).findByRole('group', { name: 'Rate this answer' })
  fireEvent.click(within(rate).getByRole('button', { name: 'Good answer' }))
  await within(rate).findByText('Saved')

  fireEvent.click(within(d).getByRole('tab', { name: 'Plan search' }))
  const form = within(d).getByRole('form', { name: 'Plan search' })
  fireEvent.click(within(form).getByRole('button', { name: /Neutralize delta/ }))
  fireEvent.click(within(form).getByRole('button', { name: 'Search' }))
  await within(form).findByRole('region', { name: 'Neutralize delta, keep margin' })

  fireEvent.click(within(d).getByRole('tab', { name: 'History' }))
  fireEvent.click(within(d).getByRole('tab', { name: 'Chat' }))
  const again = within(d).getByRole('group', { name: 'Rate this answer' })
  expect(within(again).getByRole('button', { name: 'Good answer' }).getAttribute('aria-pressed')).toBe('true')
  expect(within(again).getByText('Saved')).toBeTruthy()
  fireEvent.click(within(d).getByRole('tab', { name: 'Plan search' }))
  expect(within(d).getByRole('region', { name: 'Neutralize delta, keep margin' })).toBeTruthy()
})

test('the tabs follow the ARIA pattern: panels named by their tab, arrows move and select; closing returns focus to the button', async () => {
  window.location.hash = '#/orders'
  mount(({ path }) => (path === STATUS ? { body: status() } : null))
  const d = await openDrawer()
  await within(d).findByRole('textbox', { name: 'Message' })
  const chat = within(d).getByRole('tab', { name: 'Chat' })
  expect(chat.getAttribute('tabindex')).toBe('0')
  expect(within(d).getByRole('tab', { name: 'History' }).getAttribute('tabindex')).toBe('-1')
  const panel = document.getElementById(chat.getAttribute('aria-controls') ?? '')
  expect(panel?.getAttribute('role')).toBe('tabpanel')
  expect(panel?.getAttribute('aria-labelledby')).toBe(chat.id)
  chat.focus()
  fireEvent.keyDown(chat, { key: 'ArrowRight' })
  expect(within(d).getByRole('tab', { name: 'Plan search' }).getAttribute('aria-selected')).toBe('true')
  expect(document.activeElement).toBe(within(d).getByRole('tab', { name: 'Plan search' }))
  fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'End' })
  expect(within(d).getByRole('tab', { name: 'History' }).getAttribute('aria-selected')).toBe('true')

  // Esc from inside the drawer: it closes and the top-bar button has the keyboard.
  fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Escape' })
  await waitFor(() => expect(screen.queryByRole('complementary', { name: 'Assistant' })).toBe(null))
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Assistant' }))
})

test('a drawer that throws in render is caught at its edge: the page and its navigation stay', async () => {
  const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
  window.location.hash = '#/orders'
  mount(({ path }) => (path === STATUS ? { body: status({ presets: [{ id: 'cut-margin', label: { bad: 1 } as unknown as string }] }) } : null))
  const d = await openDrawer()
  expect(await within(d).findByText('This page could not be displayed')).toBeTruthy()
  expect(screen.getByRole('navigation', { name: 'Pages' })).toBeTruthy()
  expect(screen.getByRole('tablist', { name: 'Books' })).toBeTruthy()
  quiet.mockRestore()
})

test('an empty chat offers questions that send at once: about the book in context, or about all the books', async () => {
  window.location.hash = '#/books/TCS'
  const sent = mount(({ path }) => (path === STATUS ? { body: status() } : path === CHAT ? { stream: TURN } : null))
  const d = await openDrawer()
  const offered = await within(d).findByRole('group', { name: 'Suggested questions' })
  expect(within(offered).getAllByRole('button').map((b) => b.textContent))
    .toEqual(['Review this book', 'What can I adjust?', 'Show my breakevens', 'Is premium rich here?', 'My record on TCS'])
  fireEvent.click(within(offered).getByRole('button', { name: 'Review this book' }))
  await waitFor(() => expect(posts(sent, CHAT)).toHaveLength(1))
  expect(posts(sent, CHAT)[0]?.body).toEqual({ message: 'Review this book', stock: 'TCS' })   // the composer's own request
  const log = await within(d).findByRole('log', { name: 'Conversation' })
  expect(within(log).getByText('Review this book')).toBeTruthy()
  expect(within(d).queryByRole('group', { name: 'Suggested questions' })).toBe(null)

  // A new chat with the book's context cleared: the questions about all the books.
  fireEvent.click(within(d).getByRole('button', { name: 'New chat' }))
  fireEvent.click(await within(d).findByRole('button', { name: 'Clear the TCS context' }))
  const all = await within(d).findByRole('group', { name: 'Suggested questions' })
  expect(within(all).getAllByRole('button').map((b) => b.textContent))
    .toEqual(['Review my books', 'Which book is most at risk?', 'Explain VRP in two lines', 'My track record'])
  fireEvent.click(within(all).getByRole('button', { name: 'My track record' }))
  await waitFor(() => expect(posts(sent, CHAT)).toHaveLength(2))
  expect(posts(sent, CHAT)[1]?.body).toEqual({ message: 'My track record' })
})

test('the widen toggle switches the drawer\'s width and is remembered across a reload', async () => {
  window.location.hash = '#/orders'
  const route = ({ path }: { path: string }): Answer | null => (path === STATUS ? { body: status() } : null)
  mount(route)
  const d = await openDrawer()
  expect(d.hasAttribute('data-wide')).toBe(false)
  fireEvent.click(within(d).getByRole('button', { name: 'Widen the assistant' }))
  expect(d.getAttribute('data-wide')).toBe('true')
  expect(window.localStorage.getItem(WIDTH_KEY)).toBe('wide')

  // A reload: the drawer comes back open (the shell remembers that) and wide.
  cleanup()
  mount(route)
  await screen.findByRole('tablist', { name: 'Books' })
  const again = drawer()
  expect(again.getAttribute('data-wide')).toBe('true')
  fireEvent.click(within(again).getByRole('button', { name: 'Narrow the assistant' }))
  expect(again.hasAttribute('data-wide')).toBe(false)
  expect(window.localStorage.getItem(WIDTH_KEY)).toBe('narrow')
})

test('a browser that refuses storage: the drawer still renders, chats, and the widen toggle still works', async () => {
  const refuse = (): never => { throw new DOMException('The operation is insecure.', 'SecurityError') }
  const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(refuse)
  const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(refuse)
  try {
    window.location.hash = '#/orders'
    mount(({ path }) => (path === STATUS ? { body: status() } : null))
    const d = await openDrawer()
    expect(await within(d).findByRole('textbox', { name: 'Message' })).toBeTruthy()
    expect(within(d).getByRole('group', { name: 'Suggested questions' })).toBeTruthy()
    fireEvent.click(within(d).getByRole('button', { name: 'Widen the assistant' }))
    expect(d.getAttribute('data-wide')).toBe('true')
    expect(set).toHaveBeenCalledWith(WIDTH_KEY, 'wide')
    expect(get).toHaveBeenCalledWith(WIDTH_KEY)
  } finally {
    get.mockRestore()
    set.mockRestore()
  }
})
