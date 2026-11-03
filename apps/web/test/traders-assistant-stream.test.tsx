/**
 * The assistant's stream and text: the SSE parser, each event applied to the answer, markdown that never runs HTML
 * and reads well — the headline lead, section labels, callouts, header-less tables as label → value — and an answer's
 * step line while it runs and its folded tools once done.
 */
import { expect, test } from 'vitest'
import { render, within } from '@testing-library/react'
import type { AssistantEvent } from '../../traders/src/agent/wire.ts'
import { EMPTY_CHAT, Messages, applyEvent, fromConversation, newAnswer, stepOf, type ChatState } from '../src/traders/assistant/chat.tsx'
import { Markdown, blocks } from '../src/traders/assistant/markdown.tsx'
import { readEventStream, sseParser } from '../src/traders/assistant/sse.ts'
import { NEUTRALIZE, OLD_ANSWER, SHAPED_ANSWER, plansCard, sse } from './traders/assistant-fixtures.ts'

function parse(chunks: readonly string[]): AssistantEvent[] {
  const out: AssistantEvent[] = []
  const p = sseParser((e) => out.push(e))
  for (const c of chunks) p.push(c)
  p.end()
  return out
}

const STREAM = [
  sse('meta', { conversationId: 'cv1', model: 'claude-opus-5-5', stock: 'TCS' }),
  sse('text', { delta: 'Net Δ +7.1 lots' }),
  ': a comment line the server may send\n\n',
  sse('ping', {}),
  sse('text', { delta: ' — sell 7 lots.' }),
  sse('done', { provenance: { checked: 4, unverified: [] }, turn: 1 }),
].join('')

test('the parser reads one event per blank line, whatever the chunking: split mid-line, mid-name, many per chunk', () => {
  const whole = parse([STREAM])
  expect(whole.map((e) => e.event)).toEqual(['meta', 'text', 'ping', 'text', 'done'])
  expect(whole[1]).toEqual({ event: 'text', data: { delta: 'Net Δ +7.1 lots' } })
  for (const size of [1, 2, 3, 7, 13, 64]) {
    const chunks: string[] = []
    for (let i = 0; i < STREAM.length; i += size) chunks.push(STREAM.slice(i, i + size))
    expect(parse(chunks)).toEqual(whole)
  }
})

test('CRLF line ends, a \\r\\n split across chunks, a ping without data, unknown events and bad JSON', () => {
  const crlf = STREAM.replace(/\n/g, '\r\n')
  const at = crlf.indexOf('\r\n') + 1
  expect(parse([crlf.slice(0, at), crlf.slice(at)]).map((e) => e.event)).toEqual(['meta', 'text', 'ping', 'text', 'done'])
  expect(parse(['event: ping\n\n'])).toEqual([{ event: 'ping', data: {} }])
  expect(parse(['event: novel\ndata: {"x":1}\n\n', 'event: text\ndata: {not json\n\n', 'event: text\ndata: [1]\n\n', sse('warning', { text: 'stale' })]))
    .toEqual([{ event: 'warning', data: { text: 'stale' } }])
  // A stream that ends without its last blank line still delivers the event.
  expect(parse(['event: text\ndata: {"delta":"x"}'])).toEqual([{ event: 'text', data: { delta: 'x' } }])
  // Multi-line data joins with \n (the JSON stays valid).
  expect(parse(['event: text\ndata: {"delta":\ndata: "y"}\n\n'])).toEqual([{ event: 'text', data: { delta: 'y' } }])
})

test('the stream reader decodes bytes cut inside a UTF-8 character', async () => {
  const bytes = new TextEncoder().encode(sse('text', { delta: 'Δ0 ₹3,012' }))
  const cut = bytes.indexOf(0xce) + 1                                    // inside the two bytes of Δ
  const body = new ReadableStream<Uint8Array>({
    start(c) { c.enqueue(bytes.slice(0, cut)); c.enqueue(bytes.slice(cut)); c.close() },
  })
  const got: AssistantEvent[] = []
  await readEventStream(body, (e) => got.push(e))
  expect(got).toEqual([{ event: 'text', data: { delta: 'Δ0 ₹3,012' } }])
})

test('each event lands on the answer: text appends, tools upsert by id, cards, warnings, done, error', () => {
  let a = newAnswer()
  const apply = (e: AssistantEvent): void => { a = applyEvent(a, e) }
  apply({ event: 'status', data: { label: 'thinking' } })
  expect(a.status).toBe(null)                                            // no "thinking…" prose
  apply({ event: 'status', data: { label: 'searching TCS (3/3)' } })
  expect(a.status).toBe('searching TCS (3/3)')
  apply({ event: 'tool', data: { id: 't1', name: 'get_book', label: 'Book TCS', state: 'start' } })
  apply({ event: 'tool', data: { id: 't1', name: 'get_book', label: 'Book TCS', state: 'done', summary: '9 legs' } })
  apply({ event: 'tool', data: { id: 't2', name: 'search_adjustments', label: 'Search', state: 'error' } })
  expect(a.tools.map((t) => [t.id, t.state])).toEqual([['t1', 'done'], ['t2', 'error']])
  apply({ event: 'text', data: { delta: 'Sell ' } })
  apply({ event: 'text', data: { delta: '7 lots.' } })
  expect(a.text).toBe('Sell 7 lots.')
  apply({ event: 'card', data: plansCard() })
  apply({ event: 'card', data: NEUTRALIZE })
  apply({ event: 'card', data: plansCard({ title: 'again' }) })        // same id: replaced, not repeated
  expect(a.cards.map((c) => c.id)).toEqual(['c1', 'c3'])
  apply({ event: 'warning', data: { text: 'market closed' } })
  apply({ event: 'warning', data: { text: 'market closed' } })
  expect(a.warnings).toEqual(['market closed'])
  apply({ event: 'ping', data: {} })
  apply({ event: 'done', data: { provenance: { checked: 5, unverified: ['3,140'] }, turn: 3 } })
  expect(a).toMatchObject({ running: false, status: null, unverified: ['3,140'], turn: 3 })
  expect(applyEvent(newAnswer(), { event: 'error', data: { message: 'cap', code: 'budget' } })).toMatchObject({ running: false, error: { code: 'budget', message: 'cap' } })
  // A done without a turn (an older server) leaves feedback off for the answer.
  expect(applyEvent(newAnswer(), { event: 'done', data: { provenance: { checked: 0, unverified: [] } } }).turn).toBe(null)
})

test('a stored conversation: each answer\'s turn is its index in the turns, with its saved feedback', () => {
  const s = fromConversation({
    id: 'cv9', stock: 'TCS', turns: [
      { role: 'user', text: 'delta?', cards: [], at: 1 },
      { role: 'assistant', text: '+7.1 lots', cards: [NEUTRALIZE], at: 2, feedback: 'up' },
      { role: 'user', text: 'and margin?', cards: [], at: 3 },
      { role: 'assistant', text: '2.5 L', cards: [], at: 4 },
    ],
  })
  expect(s.conversationId).toBe('cv9')
  expect(s.messages.map((m) => (m.role === 'assistant' ? [m.turn, m.feedback, m.running] : m.text))).toEqual(['delta?', [1, 'up', false], 'and margin?', [3, null, false]])
})

test('markdown: bold, italics, code, lists and tables as elements; <script> and other HTML only ever as text', () => {
  const text = [
    '**Net Δ** is *long* 7.1 lots — `sell 7 FUT`.',
    '<script>window.__pwned = 1</script>',
    '<img src=x onerror="window.__pwned = 2">',
    '',
    '- one **<b>bold?</b>**',
    '- two',
    '1. first',
    '2. second',
    '',
    '| Plan | Margin | POP |',
    '|---|---:|---:|',
    '| P1 | 2.62 L | 61.0 % |',
    '| <i>x</i> | — | 58 % |',
    '',
    '```',
    '<script>alert(1)</script>',
    '```',
    'snake_case_word stays',
  ].join('\n')
  const { container } = render(<Markdown text={text} />)
  expect(container.querySelector('script')).toBe(null)
  expect(container.querySelector('img')).toBe(null)
  expect(container.querySelector('b')).toBe(null)
  expect(container.querySelector('i')).toBe(null)
  expect((window as { __pwned?: number }).__pwned).toBe(undefined)
  expect(container.textContent).toContain('<script>window.__pwned = 1</script>')
  expect(container.textContent).toContain('<img src=x onerror="window.__pwned = 2">')
  expect(container.querySelector('strong')?.textContent).toBe('Net Δ')
  expect(container.querySelector('em')?.textContent).toBe('long')
  expect(container.querySelector('p code')?.textContent).toBe('sell 7 FUT')
  expect([...container.querySelectorAll('ul li')].map((l) => l.textContent)).toEqual(['one <b>bold?</b>', 'two'])
  expect([...container.querySelectorAll('ol li')].map((l) => l.textContent)).toEqual(['first', 'second'])
  const cells = [...container.querySelectorAll('tbody tr')].map((r) => [...r.querySelectorAll('td')].map((c) => c.textContent))
  expect(cells).toEqual([['P1', '2.62 L', '61.0 %'], ['<i>x</i>', '—', '58 %']])
  expect(container.querySelector('tbody td:nth-child(2)')?.getAttribute('data-align')).toBe('end')
  expect(container.querySelector('pre code')?.textContent).toBe('<script>alert(1)</script>')
  expect(container.textContent).toContain('snake_case_word stays')
  expect(blocks('a\nb\n\nc').map((b) => b.kind)).toEqual(['p', 'p'])
})

test('blocks: `> ` lines are one callout, it interrupts a paragraph, an "Indicative" one is a warning; HTML in it stays text', () => {
  expect(blocks('Spot 2% under the call.\n> Indicative: market closed,\n>quotes are the last seen.\n\nAfter.')).toEqual([
    { kind: 'p', lines: ['Spot 2% under the call.'] },
    { kind: 'quote', lines: ['Indicative: market closed,', 'quotes are the last seen.'], warn: true },
    { kind: 'p', lines: ['After.'] },
  ])
  expect(blocks('> **Indicative** only')).toEqual([{ kind: 'quote', lines: ['**Indicative** only'], warn: true }])
  expect(blocks('> Two legs expired today.\n>\n> Hidden from this view.')).toEqual([
    { kind: 'quote', lines: ['Two legs expired today.', 'Hidden from this view.'], warn: false },
  ])
  expect(blocks('>\n>')).toEqual([])                                     // an empty callout is nothing
  const { container } = render(<Markdown text={'> <img src=x onerror="window.__pwned = 3"> stale'} />)
  expect(container.querySelector('img')).toBe(null)
  expect(container.querySelector('blockquote')?.textContent).toBe('<img src=x onerror="window.__pwned = 3"> stale')
  expect(container.querySelector('blockquote')?.hasAttribute('data-tone')).toBe(false)
})

test('blocks: a wholly bold first paragraph is the lead; a bold run mixed with text, or later in the answer, is not', () => {
  expect(blocks(SHAPED_ANSWER)[0]).toEqual({ kind: 'p', lines: ['**Holding, call side tested: spot 2% under the 2600 CE, 9 days left.**'], lead: true })
  expect(blocks('**Hold.** The market is closed.')[0]).toEqual({ kind: 'p', lines: ['**Hold.** The market is closed.'] })
  expect(blocks('**Hold** and **watch**')[0]).not.toHaveProperty('lead')
  expect(blocks('**Hold the strangle**.')[0]).toHaveProperty('lead', true)   // a closing stop outside the bold
  expect(blocks('Intro.\n\n**Hold.**')[1]).not.toHaveProperty('lead')
  expect(blocks(OLD_ANSWER)[0]).not.toHaveProperty('lead')
  // Mid-stream, the headline's closer not come yet: already the lead, already bold, no asterisks on screen.
  expect(blocks('**Holding, call side')[0]).toHaveProperty('lead', true)
  expect(blocks('**Holding, call side\n\n### Position')[0]).not.toHaveProperty('lead')
  const { container } = render(<Markdown text="**Holding, call side" />)
  expect(container.querySelector('.traders-md-lead strong')?.textContent).toBe('Holding, call side')
  expect(container.textContent).toBe('Holding, call side')
  expect(render(<Markdown text="2 ** 3 and a * b" />).container.textContent).toBe('2 ** 3 and a * b')   // no opener: text as it is
})

test('the new answer shape: a lead, section labels, a comparison table with row labels and figures right, a warning callout', () => {
  const { container } = render(<Markdown text={SHAPED_ANSWER} />)
  const lead = container.querySelector('.traders-md-lead')
  expect(lead?.textContent).toBe('Holding, call side tested: spot 2% under the 2600 CE, 9 days left.')
  expect(lead?.querySelector('strong')).not.toBe(null)
  expect([...container.querySelectorAll('h4.traders-md-h')].map((h) => h.textContent)).toEqual(['Position', 'Risk'])
  expect([...container.querySelectorAll('ul li')].map((l) => l.textContent)).toEqual(['P&L +₹1.2 L; Today −₹18k', 'Delta +1.4 lots, inside the ±2 band'])
  const table = container.querySelector('table') as HTMLTableElement
  expect([...table.querySelectorAll('thead th')].map((h) => [h.textContent, h.getAttribute('data-align')])).toEqual([['', 'start'], ['Now', 'end'], ['P3', 'end']])
  expect(table.querySelector('tbody th[scope="row"]')?.textContent).toBe('Max loss')
  expect([...table.querySelectorAll('tbody td')].map((c) => [c.textContent, c.getAttribute('data-align')])).toEqual([['−₹4.1 L', 'end'], ['−₹2.6 L', 'end']])
  const note = container.querySelector('blockquote.traders-md-quote')
  expect(note?.textContent).toBe('Indicative: market closed, quotes are the last seen.')
  expect(note?.getAttribute('data-tone')).toBe('warn')
  expect(container.querySelector('.traders-md')?.lastElementChild).toBe(note)   // the caveat goes last
})

test('an old answer: its header-less `| | |` table is a label → value list with no empty header row; bold and bullets kept', () => {
  const { container } = render(<Markdown text={OLD_ANSWER} />)
  expect(container.querySelector('table')).toBe(null)
  expect(container.querySelector('thead')).toBe(null)
  const kv = container.querySelector('dl.traders-md-kv') as HTMLElement
  expect([...kv.querySelectorAll('dt')].map((d) => d.textContent)).toEqual(['Net delta', 'Spot / Δ0', 'Max loss (±10% expiry scan)', 'POP'])
  const values = [...kv.querySelectorAll('dd')]
  expect(values[0]?.textContent).toBe('+0.48 lots (+1,257 shares). Inside the ±1.8-lot band, so no futures hedge needed')
  expect(values[0]?.querySelector('strong')?.textContent).toBe('+0.48 lots')
  expect(values[2]?.querySelector('strong')?.textContent).toBe('−₹7.56 L at 438.79')
  expect(kv.hasAttribute('data-numeric')).toBe(false)                    // sentences, so values read left to right
  // The first paragraph's bold run is not a lead (it is mixed with text); the bullets stay bullets.
  expect(container.querySelector('.traders-md-lead')).toBe(null)
  expect(container.querySelector('p strong')?.textContent).toBe('BHEL: indicative only.')
  expect([...container.querySelectorAll('ul li strong')].map((s) => s.textContent)).toEqual(['Volatility:', 'Data:'])
  // A header-less list of figures only sets them right; a header-less table of three columns keeps its rows, no header.
  const figs = render(<Markdown text={'| | |\n|---|---|\n| Margin | **2.50 L** |\n| POP | 58 % |'} />).container
  expect(figs.querySelector('dl')?.getAttribute('data-numeric')).toBe('true')
  const wide = render(<Markdown text={'| | | |\n|---|---|---|\n| Max loss | −4.1 L | −2.6 L |'} />).container
  expect(wide.querySelector('thead')).toBe(null)
  expect([...wide.querySelectorAll('tbody td')].map((c) => c.textContent)).toEqual(['Max loss', '−4.1 L', '−2.6 L'])
})

const chatOf = (...answers: ReturnType<typeof newAnswer>[]): ChatState => ({
  ...EMPTY_CHAT, conversationId: 'cv1', messages: answers.flatMap((a, i) => [{ role: 'user' as const, text: `q${i}` }, a]),
})

test('a running answer shows one step line with a spinner — the server\'s label, else the running tool — and no tool list', () => {
  const running = newAnswer({
    text: 'Checking the call side',
    tools: [{ id: 't1', name: 'get_book', label: 'Book TCS', state: 'done', summary: '9 legs' }, { id: 't2', name: 'get_chain', label: 'Chain TCS', state: 'start' }],
  })
  expect(stepOf(running)).toBe('Chain TCS')
  expect(stepOf({ ...running, status: 'searching TCS (3/3)' })).toBe('searching TCS (3/3)')
  expect(stepOf(newAnswer())).toBe(null)
  const { container } = render(<Messages state={chatOf({ ...running, status: 'searching TCS (3/3)' })} />)
  const step = container.querySelector('.traders-ai-step') as HTMLElement
  expect(step.textContent).toBe('searching TCS (3/3)')
  expect(step.querySelector('.traders-ai-spinner')).not.toBe(null)
  expect(container.querySelector('details')).toBe(null)
  expect(within(container).queryByText(/Used \d/)).toBe(null)
  expect(within(container).queryByText('Book TCS', { exact: false })).toBe(null)
})

test('a done answer folds its tools into "Used N tools" (closed); a failed tool stays in view; the latest answer is marked', () => {
  const done = newAnswer({
    text: '**Hold.**', running: false, turn: 1,
    tools: [{ id: 't1', name: 'get_book', label: 'Book TCS', state: 'done', summary: '9 legs' }, { id: 't2', name: 'search_adjustments', label: 'Search', state: 'error' }],
  })
  const one = newAnswer({ text: 'Long 7 lots', running: false, turn: 3, tools: [{ id: 't3', name: 'get_book', label: 'Book TCS', state: 'done' }] })
  const { container } = render(<Messages state={chatOf(done, one)} />)
  const answers = [...container.querySelectorAll('.traders-ai-answer')]
  expect(answers.map((a) => a.getAttribute('data-last'))).toEqual([null, 'true'])
  expect(container.querySelector('.traders-ai-step')).toBe(null)
  const first = answers[0] as HTMLElement
  const fold = first.querySelector('details.traders-ai-tools') as HTMLDetailsElement
  expect(fold.open).toBe(false)
  expect(fold.querySelector('summary')?.textContent).toBe('Used 2 tools')
  const chips = within(fold).getByRole('list', { name: 'Tools used' })
  expect([...chips.querySelectorAll('li')].map((l) => [l.textContent, l.getAttribute('data-state')])).toEqual([['✓Book TCS · 9 legs', 'done'], ['✕Search', 'error']])
  const failed = first.querySelector('.traders-ai-tool-failed')
  expect(failed?.textContent).toBe('✕ Search failed')
  expect(fold.contains(failed)).toBe(false)
  expect((answers[1] as HTMLElement).querySelector('summary')?.textContent).toBe('Used 1 tool')
  // The thumbs share the foot with the fold.
  expect(within(first.querySelector('.traders-ai-foot') as HTMLElement).getByRole('group', { name: 'Rate this answer' })).toBeTruthy()
})
