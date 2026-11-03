/**
 * The assistant's chat: one POST a turn, its answer read off the event stream (sse.ts) as it comes — text, tool
 * chips, cards, warnings, the spend line — with Stop (aborts the fetch), the trader's past conversations, and a
 * thumbs up or down (with an optional note) under each answer.
 *
 * Kept plain on purpose (operator, 23 Oct): answers are short and analytical, so there are no avatars, no
 * "thinking…" prose and no chat-app chrome — a turn is the trader's line, then the answer and its cards. Built for
 * reading (operator, 1 Nov: "easy to read … don't put too much data in one place"): while an answer runs, one line
 * says the step it is on; once done, the tools fold into one quiet "Used N tools" line (a failed one stays in view)
 * and the thumbs sit beside it, dimmed until wanted. The answer's text is the model's; every figure in a card is the
 * engines' (spec R2), and a figure in the text that matched no tool result is badged "unverified".
 */

import { memo, useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactElement } from 'react'
import { Button } from '@astryxdesign/core/Button'
import { Tooltip } from '@astryxdesign/core/Tooltip'
import type {
  AssistantCard, AssistantErrorCode, AssistantEvent, ChatRequest, ConversationSummary, ConversationView,
} from '../../../../traders/src/agent/wire.ts'
import { AssistantHttpError, TradersApiError, assistantChat, tapi } from '../api.ts'
import { istDay, istHm } from '../wire.ts'
import { CardView } from './cards.tsx'
import { PRESET_LABELS, viewText, viewToSend, type Goals } from './goals.tsx'
import { Markdown } from './markdown.tsx'
import { failureText } from './plan-search.tsx'
import { readEventStream } from './sse.ts'

/** The server's limit on a message. */
export const MAX_MESSAGE = 4000
/** The server's limit on a feedback note. */
export const MAX_NOTE = 500

export interface ToolChip {
  readonly id: string
  readonly name: string
  readonly label: string
  readonly state: 'start' | 'done' | 'error'
  readonly summary?: string
}

export interface UserMsg { readonly role: 'user'; readonly text: string }

export interface AnswerMsg {
  readonly role: 'assistant'
  readonly text: string
  readonly cards: readonly AssistantCard[]
  readonly tools: readonly ToolChip[]
  readonly warnings: readonly string[]
  /** The server's latest step label while the turn runs ("searching TCS (3/3)"). */
  readonly status: string | null
  readonly running: boolean
  readonly stopped: boolean
  readonly error: { readonly message: string; readonly code: AssistantErrorCode | 'http' } | null
  /** Figures in the text that matched no tool result this turn (spec R2). */
  readonly unverified: readonly string[]
  /** This answer's index in the conversation's turns — what feedback names; null when the server did not say. */
  readonly turn: number | null
  readonly feedback: 'up' | 'down' | null
}

export type ChatMsg = UserMsg | AnswerMsg

export interface Usage { readonly inputTokens: number; readonly outputTokens: number; readonly cachedTokens: number; readonly costUsd: number; readonly traderUsdToday: number }

export interface ChatState {
  readonly conversationId: string | null
  readonly model: string | null
  readonly stock: string | null
  readonly messages: readonly ChatMsg[]
  readonly usage: Usage | null
}

export const EMPTY_CHAT: ChatState = { conversationId: null, model: null, stock: null, messages: [], usage: null }

export function newAnswer(over: Partial<AnswerMsg> = {}): AnswerMsg {
  return {
    role: 'assistant', text: '', cards: [], tools: [], warnings: [], status: null, running: true, stopped: false,
    error: null, unverified: [], turn: null, feedback: null, ...over,
  }
}

/** A step label that only says the model is working: not shown (no "thinking…" prose). */
const IDLE_STATUS = /^(thinking|working|writing|answering)\b/i

/** One event applied to the answer it belongs to. Pure. `meta` and `usage` are the conversation's, not the answer's. */
export function applyEvent(a: AnswerMsg, e: AssistantEvent): AnswerMsg {
  switch (e.event) {
    case 'text': return typeof e.data.delta === 'string' ? { ...a, text: a.text + e.data.delta } : a
    case 'status': {
      const status = typeof e.data.label === 'string' && !IDLE_STATUS.test(e.data.label) ? e.data.label : null
      return status === a.status ? a : { ...a, status }
    }
    case 'tool': {
      const t = e.data
      if (typeof t.id !== 'string') return a
      const chip: ToolChip = { id: t.id, name: t.name, label: t.label, state: t.state, ...(t.summary === undefined ? {} : { summary: t.summary }) }
      const at = a.tools.findIndex((x) => x.id === t.id)
      return { ...a, tools: at === -1 ? [...a.tools, chip] : a.tools.map((x, i) => (i === at ? chip : x)) }
    }
    case 'card': {
      const c = e.data
      if (typeof c !== 'object' || c === null) return a
      const at = a.cards.findIndex((x) => x.id === c.id)
      return { ...a, cards: at === -1 ? [...a.cards, c] : a.cards.map((x, i) => (i === at ? c : x)) }
    }
    case 'warning': return typeof e.data.text !== 'string' || a.warnings.includes(e.data.text) ? a : { ...a, warnings: [...a.warnings, e.data.text] }
    case 'done': {
      const p = e.data.provenance
      return {
        ...a, running: false, status: null,
        unverified: Array.isArray(p?.unverified) ? p.unverified.filter((u): u is string => typeof u === 'string') : [],
        turn: typeof e.data.turn === 'number' && Number.isInteger(e.data.turn) ? e.data.turn : a.turn,
      }
    }
    case 'error': return { ...a, running: false, status: null, error: { message: e.data.message, code: e.data.code } }
    default: return a
  }
}

/**
 * A stored conversation as the page shows it; an answer's turn is its index in `turns`. Tolerant: a turn that is
 * not an object is skipped (its index still counts), a missing text is empty, missing cards are none.
 */
export function fromConversation(v: ConversationView, model: string | null = null): ChatState {
  const turns: readonly unknown[] = Array.isArray(v.turns) ? v.turns : []
  const messages: ChatMsg[] = []
  turns.forEach((raw, i) => {
    if (typeof raw !== 'object' || raw === null) return
    const t = raw as Partial<ConversationView['turns'][number]>
    const text = typeof t.text === 'string' ? t.text : ''
    if (t.role === 'user') messages.push({ role: 'user', text })
    else {
      const feedback = t.feedback === 'up' || t.feedback === 'down' ? t.feedback : null
      messages.push(newAnswer({ text, cards: Array.isArray(t.cards) ? t.cards : [], running: false, turn: i, feedback }))
    }
  })
  return { conversationId: typeof v.id === 'string' ? v.id : null, model, stock: typeof v.stock === 'string' ? v.stock : null, usage: null, messages }
}

const ERROR_TEXT: Readonly<Record<AssistantErrorCode, string>> = {
  budget: "Today's AI budget is spent. Plan search still works.",
  busy: 'An answer is already running for you. Wait for it, or stop it.',
  provider: 'The model provider failed this turn.',
  timeout: 'The turn ran out of time (2 minutes).',
  internal: 'The assistant failed this turn.',
}

export function errorOf(err: unknown): { message: string; code: AssistantErrorCode | 'http' } {
  if (err instanceof AssistantHttpError) {
    if (err.code !== null) return { code: err.code, message: `${ERROR_TEXT[err.code]}${err.message === '' ? '' : ` (${err.message})`}` }
    if (err.status === 429) return { code: 'busy', message: `Busy or over today's budget: ${err.message}` }
    if (err.status === 503) return { code: 'http', message: `The assistant is off: ${err.message}` }
  }
  if (err instanceof TradersApiError && err.status === 404) return { code: 'http', message: 'The assistant is not on this server yet' }
  return { code: 'http', message: err instanceof Error ? err.message : String(err) }
}

/** The conversation, Send and Stop. A new chat or another conversation stops the running turn first. */
export function useChat(opts: { readonly stock: string | null; readonly goals: Goals }): {
  readonly state: ChatState; readonly running: boolean
  send(message: string): void; stop(): void; reset(): void; load(v: ConversationView, model?: string | null): void
  /** A rating saved on the server, kept on its answer so a tab switch or a re-render shows it. */
  rate(turn: number, rating: 'up' | 'down'): void
} {
  const [state, setState] = useState<ChatState>(EMPTY_CHAT)
  const ctrl = useRef<AbortController | null>(null)
  const gen = useRef(0)
  const latest = useRef({ state, opts })
  latest.current = { state, opts }
  const last = state.messages[state.messages.length - 1]
  const running = last?.role === 'assistant' && last.running

  const stop = useCallback(() => { ctrl.current?.abort() }, [])
  const reset = useCallback(() => { gen.current++; ctrl.current?.abort(); ctrl.current = null; setState(EMPTY_CHAT) }, [])
  const load = useCallback((v: ConversationView, model: string | null = null) => {
    gen.current++; ctrl.current?.abort(); ctrl.current = null; setState(fromConversation(v, model))
  }, [])
  useEffect(() => () => { ctrl.current?.abort() }, [])
  const rate = useCallback((turn: number, rating: 'up' | 'down') => {
    setState((st) => ({
      ...st,
      messages: st.messages.map((m) => (m.role === 'assistant' && m.turn === turn && m.feedback !== rating ? { ...m, feedback: rating } : m)),
    }))
  }, [])

  const send = useCallback((message: string) => {
    const text = message.trim().slice(0, MAX_MESSAGE)
    const { state: s, opts: o } = latest.current
    const tail = s.messages[s.messages.length - 1]
    if (text === '' || (tail?.role === 'assistant' && tail.running)) return
    const view = viewToSend(o.goals)
    const stock = s.conversationId !== null && s.stock !== null ? s.stock : o.stock
    const req: ChatRequest = {
      message: text,
      ...(s.conversationId === null ? {} : { conversationId: s.conversationId }),
      ...(stock === null ? {} : { stock }),
      ...(o.goals.allowClose ? { allowClose: true } : {}),
      ...(o.goals.presets.length === 0 ? {} : { presets: o.goals.presets }),
      ...(view === undefined || view === false ? {} : { view }),
    }
    const mine = ++gen.current
    const ac = new AbortController()
    ctrl.current = ac
    setState((st) => ({ ...st, stock: st.stock ?? stock, messages: [...st.messages, { role: 'user', text }, newAnswer()] }))
    const patch = (fn: (a: AnswerMsg) => AnswerMsg): void => {
      if (gen.current !== mine) return
      setState((st) => {
        const at = st.messages.length - 1
        const a = st.messages[at]
        if (a === undefined || a.role !== 'assistant') return st
        const next = fn(a)
        // A ping, an unknown event, a status that did not change: the same state, so nothing re-renders.
        if (next === a) return st
        return { ...st, messages: st.messages.map((m, i) => (i === at ? next : m)) }
      })
    }
    void (async () => {
      try {
        const res = await assistantChat(req, ac.signal)
        const type = res.headers?.get?.('content-type') ?? ''
        if (res.body === null || !type.includes('text/event-stream')) throw new Error('The assistant answered without a stream')
        await readEventStream(res.body, (e) => {
          if (gen.current !== mine) return
          if (e.event === 'meta') setState((st) => ({ ...st, conversationId: e.data.conversationId, model: e.data.model, stock: e.data.stock ?? st.stock }))
          else if (e.event === 'usage') setState((st) => ({ ...st, usage: e.data }))
          else patch((a) => applyEvent(a, e))
        })
        patch((a) => (a.running ? { ...a, running: false, status: null } : a))
      } catch (err) {
        if (ac.signal.aborted) patch((a) => ({ ...a, running: false, stopped: a.running, status: null }))
        else patch((a) => ({ ...a, running: false, status: null, error: errorOf(err) }))
      } finally {
        if (ctrl.current === ac) ctrl.current = null
      }
    })()
  }, [])

  return { state, running, send, stop, reset, load, rate }
}

/** The step a running answer is on: the server's label, else the last tool still running; null when neither says. */
export function stepOf(a: AnswerMsg): string | null {
  if (a.status !== null) return a.status
  for (let i = a.tools.length - 1; i >= 0; i--) {
    const t = a.tools[i]
    if (t?.state === 'start') return t.label
  }
  return null
}

/** While the answer runs: a small spinner and the step it is on — one line, never a list of chips. */
function Step(props: { readonly label: string | null }): ReactElement {
  return (
    <div className="traders-ai-step">
      <span className="traders-ai-spinner" aria-hidden="true" />
      {props.label === null ? <span className="traders-ai-sr">Working</span> : <span>{props.label}</span>}
    </div>
  )
}

const MARK: Readonly<Record<ToolChip['state'], string>> = { start: '…', done: '✓', error: '✕' }

/** Once the answer is done: "Used N tools", folded; open, one line a tool with what it found. */
function ToolChips(props: { readonly tools: readonly ToolChip[] }): ReactElement | null {
  const { tools } = props
  if (tools.length === 0) return null
  return (
    <details className="traders-ai-tools">
      <summary>{tools.length === 1 ? 'Used 1 tool' : `Used ${tools.length} tools`}</summary>
      <ul className="traders-ai-toollist" aria-label="Tools used">
        {tools.map((t) => (
          <li key={t.id} className="traders-ai-tool" data-state={t.state} title={t.name}>
            <span className="traders-ai-tool-mark" aria-hidden="true">{MARK[t.state]}</span>
            {t.label}
            {t.summary === undefined || t.summary === '' ? null : <span className="traders-ai-muted">{` · ${t.summary}`}</span>}
          </li>
        ))}
      </ul>
    </details>
  )
}

/** A tool that failed stays in view, folded or not. */
function FailedTools(props: { readonly tools: readonly ToolChip[] }): ReactElement | null {
  const failed = props.tools.filter((t) => t.state === 'error')
  if (failed.length === 0) return null
  return (
    <>
      {failed.map((t) => (
        <span key={t.id} className="traders-ai-tool traders-ai-tool-failed" data-state="error" title={t.summary ?? t.name}>{`✕ ${t.label} failed`}</span>
      ))}
    </>
  )
}

const Thumb = (props: { readonly down?: boolean }): ReactElement => (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"
    strokeLinejoin="round" aria-hidden="true" {...(props.down === true ? { style: { transform: 'rotate(180deg)' } } : {})}>
    <path d="M7 10v11H4a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1h3zm0 0 4-8a3 3 0 0 1 3 3v4h5.5a2 2 0 0 1 2 2.3l-1.4 8a2 2 0 0 1-2 1.7H7" />
  </svg>
)

type Saved = 'idle' | 'saving' | 'saved' | 'missing' | 'failed'

/** Thumbs up or down on one answer, and an optional note: `POST …/conversations/:id/feedback`. */
export function Feedback(props: {
  readonly conversationId: string; readonly turn: number; readonly initial: 'up' | 'down' | null
  /** Told of a rating the server kept, so the answer remembers it beyond this component. */
  readonly onRated?: (turn: number, rating: 'up' | 'down') => void
}): ReactElement {
  const [rating, setRating] = useState(props.initial)
  const [saved, setSaved] = useState<Saved>(props.initial === null ? 'idle' : 'saved')
  const [error, setError] = useState<string | null>(null)
  const [noteOpen, setNoteOpen] = useState(false)
  const [note, setNote] = useState('')
  const [noteSaved, setNoteSaved] = useState(false)

  const save = (r: 'up' | 'down', withNote: string | null): void => {
    const before = rating
    setRating(r); setSaved('saving'); setError(null)
    const n = withNote?.trim().slice(0, MAX_NOTE) ?? ''
    tapi.feedback(props.conversationId, { turn: props.turn, rating: r, ...(n === '' ? {} : { note: n }) }).then(
      () => { setSaved('saved'); props.onRated?.(props.turn, r); if (n !== '') { setNoteSaved(true); setNoteOpen(false) } },
      (err: unknown) => {
        setRating(before)
        if (err instanceof TradersApiError && err.status === 404) { setSaved('missing'); return }
        setSaved('failed'); setError(err instanceof Error ? err.message : String(err))
      },
    )
  }

  return (
    <div className="traders-ai-feedback" role="group" aria-label="Rate this answer" data-note={noteOpen && rating !== null ? 'open' : undefined}>
      <button type="button" className="traders-ai-thumb" aria-pressed={rating === 'up'} aria-label="Good answer" title="Good answer"
        disabled={saved === 'saving' || saved === 'missing'} onClick={() => save('up', null)}><Thumb /></button>
      <button type="button" className="traders-ai-thumb" aria-pressed={rating === 'down'} aria-label="Poor answer" title="Poor answer"
        disabled={saved === 'saving' || saved === 'missing'} onClick={() => save('down', null)}><Thumb down /></button>
      {saved === 'saved' ? <span className="traders-ai-muted">{noteSaved ? 'Saved, with note' : 'Saved'}</span> : null}
      {saved === 'missing' ? <span className="traders-ai-muted">Feedback is not on this server yet</span> : null}
      {saved === 'failed' ? <span className="traders-ai-error">{`Not saved: ${error ?? ''}`}</span> : null}
      {rating !== null && saved === 'saved' && !noteOpen && !noteSaved ? (
        <button type="button" className="traders-ai-link" onClick={() => setNoteOpen(true)}>Add a note</button>
      ) : null}
      {noteOpen && rating !== null ? (
        <div className="traders-ai-note">
          <textarea className="traders-ai-textarea" rows={2} maxLength={MAX_NOTE} aria-label="Note on this answer" placeholder="What was wrong or useful (optional)"
            value={note} onChange={(e) => setNote(e.target.value)} />
          <div className="traders-ai-row">
            <span className="traders-ai-muted">{`${note.length} / ${MAX_NOTE}`}</span>
            <span className="traders-ai-grow" />
            <Button size="sm" variant="ghost" label="Cancel" onClick={() => setNoteOpen(false)} />
            <Button size="sm" variant="secondary" label="Save note" isDisabled={note.trim() === '' || saved === 'saving'} onClick={() => save(rating, note)} />
          </div>
        </div>
      ) : null}
    </div>
  )
}

type Rated = (turn: number, rating: 'up' | 'down') => void

/**
 * Memoised: an answer that is done does not re-render while the next one streams in. The text comes first; what the
 * answer was built from (tools, the unverified badge) and the thumbs share one quiet line at its foot.
 */
const Answer = memo(function Answer(props: {
  readonly msg: AnswerMsg; readonly conversationId: string | null; readonly onRated?: Rated | undefined
  /** The conversation's latest answer: its thumbs are always at full strength. */
  readonly last: boolean
}): ReactElement {
  const a = props.msg
  const rateable = !a.running && a.error === null && a.turn !== null && props.conversationId !== null
  const foot = (!a.running && a.tools.length > 0) || a.tools.some((t) => t.state === 'error') || a.unverified.length > 0 || rateable
  return (
    <div className="traders-ai-answer" aria-busy={a.running} data-last={props.last ? 'true' : undefined}>
      {a.text === '' ? null : <Markdown text={a.text} />}
      {a.cards.map((c, i) => <CardView key={typeof c?.id === 'string' ? c.id : `#${i}`} card={c} />)}
      {a.warnings.length === 0 ? null : <ul className="traders-ai-warnings traders-ai-callout">{a.warnings.map((w) => <li key={w}>{w}</li>)}</ul>}
      {a.error === null ? null : <div className="traders-ai-error" role="alert" data-code={a.error.code}>{a.error.message}</div>}
      {a.stopped ? <div className="traders-ai-muted">Stopped</div> : null}
      {a.running ? <Step label={stepOf(a)} /> : null}
      {foot ? (
        <div className="traders-ai-foot">
          {a.running ? null : <ToolChips tools={a.tools} />}
          <FailedTools tools={a.tools} />
          {a.unverified.length === 0 ? null : (
            <Tooltip content={`Not found in any tool result this turn: ${a.unverified.join(', ')}`}>
              <span className="traders-ai-unverified">{a.unverified.length === 1 ? '1 unverified figure' : `${a.unverified.length} unverified figures`}</span>
            </Tooltip>
          )}
          {rateable && props.conversationId !== null && a.turn !== null
            ? <Feedback key={`${props.conversationId}:${a.turn}`} conversationId={props.conversationId} turn={a.turn} initial={a.feedback} {...(props.onRated === undefined ? {} : { onRated: props.onRated })} />
            : null}
        </div>
      ) : null}
    </div>
  )
})

export function Messages(props: { readonly state: ChatState; readonly onRated?: Rated }): ReactElement {
  const { state } = props
  const end = useRef<HTMLDivElement>(null)
  // Follow the answer as it streams while the trader is at the bottom; reading further up, stay put. A new turn
  // always brings the bottom back.
  const stick = useRef(true)
  const size = state.messages.length
  const tail = state.messages[size - 1]
  const grow = tail?.role === 'assistant' ? tail.text.length + tail.cards.length + tail.tools.length : 0
  useEffect(() => {
    const box = end.current?.closest<HTMLElement>('.traders-ai-body') ?? null
    if (box === null) return
    const on = (): void => { stick.current = box.scrollHeight - box.scrollTop - box.clientHeight < 48 }
    box.addEventListener('scroll', on)
    return () => box.removeEventListener('scroll', on)
  }, [])
  useEffect(() => { stick.current = true }, [size])
  useEffect(() => {
    const box = end.current?.closest<HTMLElement>('.traders-ai-body') ?? null
    if (box !== null && stick.current) box.scrollTop = box.scrollHeight
  }, [size, grow])
  return (
    <div className="traders-ai-messages" role="log" aria-label="Conversation" aria-live="polite">
      {state.messages.map((m, i) => (m.role === 'user'
        // Keyed on the conversation too: another conversation's answer at the same place is another answer.
        ? <div key={`${state.conversationId ?? ''}:${i}`} className="traders-ai-user">{m.text}</div>
        : <Answer key={`${state.conversationId ?? ''}:${i}`} msg={m} conversationId={state.conversationId} onRated={props.onRated} last={i === size - 1} />))}
      <div ref={end} />
    </div>
  )
}

/**
 * The message box: Enter sends, Shift+Enter is a new line; Stop while an answer runs. It grows with the text from
 * two rows to about eight (the stylesheet's max-height), then scrolls.
 */
export function Composer(props: {
  readonly running: boolean; readonly goals: Goals; readonly stock: string | null
  readonly spend: string | null
  send(text: string): void; stop(): void
}): ReactElement {
  const [text, setText] = useState('')
  const hintId = useId()
  const box = useRef<HTMLTextAreaElement>(null)
  useLayoutEffect(() => {
    const el = box.current
    if (el === null) return
    el.style.height = ''
    // The content's height plus the borders (the box is border-box); a layout-less DOM (tests) reports 0 — leave it.
    if (el.scrollHeight > 0) el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`
  }, [text])
  const submit = (): void => {
    if (props.running || text.trim() === '') return
    props.send(text)
    setText('')
  }
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit() }
  }
  const g = props.goals
  const view = viewToSend(g)
  const sentWith = [
    g.presets.length === 0 ? null : `goal ${g.presets.map((p) => PRESET_LABELS[p] ?? p).join(', keep ')}`,
    view === undefined ? null : view === false ? 'view not filled in (not sent)' : `view ${viewText(g.view)}`,
    g.allowClose ? 'closing allowed' : null,
  ].filter((x): x is string => x !== null)
  return (
    <div className="traders-ai-composer">
      {sentWith.length === 0 ? null : <div className="traders-ai-muted">{`Sent with: ${sentWith.join(' · ')}`}</div>}
      <textarea ref={box} className="traders-ai-textarea traders-ai-input" rows={2} maxLength={MAX_MESSAGE} aria-label="Message"
        aria-describedby={hintId} placeholder={props.stock === null ? 'Ask about your books' : `Ask about ${props.stock}`}
        value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKey} />
      <div className="traders-ai-row">
        <span className="traders-ai-muted">{props.spend ?? ''}</span>
        {text.length > MAX_MESSAGE - 500 ? <span className="traders-ai-muted">{`${text.length} / ${MAX_MESSAGE}`}</span> : null}
        <span className="traders-ai-grow" />
        <span id={hintId} className="traders-ai-muted traders-ai-hint">Enter sends · Shift+Enter new line</span>
        {props.running
          ? <Button size="sm" variant="secondary" label="Stop" onClick={props.stop} />
          : <Button size="sm" variant="primary" label="Send" isDisabled={text.trim() === ''} onClick={submit} />}
      </div>
    </div>
  )
}

/** The trader's last conversations: open one, or take it off the list (the record stays on the server). */
export function Conversations(props: { readonly current: string | null; open(v: ConversationView, model: string): void; onEmpty?(): void }): ReactElement {
  const [list, setList] = useState<readonly ConversationSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    tapi.conversations().then(
      (r) => { if (alive) setList(Array.isArray(r) ? r : Array.isArray((r as { conversations?: unknown }).conversations) ? (r as { conversations: ConversationSummary[] }).conversations : []) },
      (err: unknown) => { if (alive) setError(failureText(err, 'The conversation list')) },
    )
    return () => { alive = false }
  }, [])
  const open = (c: ConversationSummary): void => {
    setBusy(c.id)
    tapi.conversation(c.id).then(
      (v) => { setBusy(null); props.open(v, c.model) },
      (err: unknown) => { setBusy(null); setError(failureText(err, 'Opening the conversation')) },
    )
  }
  const remove = (c: ConversationSummary): void => {
    tapi.deleteConversation(c.id).then(
      () => setList((l) => (l ?? []).filter((x) => x.id !== c.id)),
      (err: unknown) => setError(failureText(err, 'Removing the conversation')),
    )
  }
  if (error !== null) return <div className="traders-ai-error" role="alert">{error}</div>
  if (list === null) return <div className="traders-ai-muted">Loading your conversations…</div>
  if (list.length === 0) return <div className="traders-ai-muted">No conversations yet</div>
  return (
    <ul className="traders-ai-history" aria-label="Conversations">
      {list.map((c) => (
        <li key={c.id} data-current={c.id === props.current ? 'true' : undefined}>
          <button type="button" className="traders-ai-history-open" disabled={busy !== null} onClick={() => open(c)}>
            <span className="traders-ai-history-title">{c.title === '' ? 'Untitled' : c.title}</span>
            <span className="traders-ai-muted">{`${c.stock ?? 'All books'} · ${istDay(c.updatedAt)} ${istHm(c.updatedAt)}`}</span>
          </button>
          <button type="button" className="traders-ai-x" aria-label={`Remove “${c.title}” from the list`} title="Remove from the list" onClick={() => remove(c)}>×</button>
        </li>
      ))}
    </ul>
  )
}
