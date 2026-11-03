/**
 * The Assistant drawer on the right of every page (spec 2026-10-23 §8): Chat, Plan search and the trader's past
 * conversations. On a book page its context is that stock — a chip the trader can clear.
 *
 * `GET /assistant/status` decides what it shows. Off (no key, switched off) or missing (a server not yet restarted
 * onto this release, 404) — the reason, and Plan search alone, which needs no model. Nothing here can break the
 * page behind it: every call fails into a line of text, and a render that throws is caught at the drawer's edge
 * (PageBoundary) — the page and its navigation stay.
 *
 * Chat and Plan search stay mounted while another tab is shown, so a conversation, a rating just given and a search
 * result are all still there on coming back. History is read afresh each time it is opened.
 *
 * Advisory only (spec R1): nothing here places, changes or cancels an order; a card's one action is "Show on payoff".
 *
 * An empty chat offers a few questions that send at once (spec 2026-11-01 W7); the head's widen toggle switches the
 * drawer between 440 px and about 720 px for a long answer or a wide table, remembered per browser (W9). A phone
 * shows it full width either way.
 */

import { useCallback, useEffect, useId, useState, type ReactElement } from 'react'
import { Button } from '@astryxdesign/core/Button'
import { Icon } from '@astryxdesign/core/Icon'
import type { AssistantStatus } from '../../../../traders/src/agent/wire.ts'
import { PageBoundary } from '../../boundary.tsx'
import { tapi, TradersApiError } from '../api.ts'
import { Composer, Conversations, Messages, useChat } from './chat.tsx'
import { DEFAULT_PRESETS, NO_GOALS, type Goals } from './goals.tsx'
import { PlanSearch } from './plan-search.tsx'
import { TabStrip, panelProps } from './tabs.tsx'
import './assistant.css'

export type StatusState =
  | { readonly state: 'loading' }
  | { readonly state: 'on'; readonly status: AssistantStatus }
  | { readonly state: 'off'; readonly reason: string; readonly status: AssistantStatus | null }

const MISSING = 'The AI assistant is not on this server yet. Plan search works without it.'

/** What the status answer means for the drawer. A missing route, a failure or a malformed answer is "off". */
export function statusOf(r: { ok: true; value: unknown } | { ok: false; error: unknown }): StatusState {
  if (!r.ok) {
    const e = r.error
    if (e instanceof TradersApiError && e.status === 404) return { state: 'off', reason: MISSING, status: null }
    return { state: 'off', reason: `The AI assistant could not be reached (${e instanceof Error ? e.message : String(e)}). Plan search works without it.`, status: null }
  }
  const s = r.value as Partial<AssistantStatus> | null
  if (s === null || typeof s !== 'object' || typeof s.enabled !== 'boolean') return { state: 'off', reason: MISSING, status: null }
  const status = s as AssistantStatus
  if (!status.enabled) return { state: 'off', reason: typeof status.reason === 'string' ? status.reason : 'The AI assistant is switched off on this server.', status }
  return { state: 'on', status }
}

const usd = (n: number): string => `$${n.toFixed(2)}`

type Tab = 'chat' | 'plans' | 'history'
const TABS: readonly { readonly id: Tab; readonly label: string }[] = [{ id: 'chat', label: 'Chat' }, { id: 'plans', label: 'Plan search' }, { id: 'history', label: 'History' }]

export interface DrawerProps {
  readonly open: boolean
  readonly stock: string | null
  readonly stocks: readonly string[]
  onClose(): void
}

/** Where the drawer's width is remembered: 'wide' or 'narrow'. */
export const WIDTH_KEY = 'traders.assistant.width'

function storedWide(): boolean {
  try { return window.localStorage.getItem(WIDTH_KEY) === 'wide' } catch { return false }
}

function storeWide(wide: boolean): void {
  try { window.localStorage.setItem(WIDTH_KEY, wide ? 'wide' : 'narrow') } catch { /* forgotten: the toggle still works */ }
}

/** The questions an empty chat offers: about the book in context, or about all of them. */
export function suggestionsFor(stock: string | null): readonly string[] {
  return stock === null
    ? ['Review my books', 'Which book is most at risk?', 'Explain VRP in two lines', 'My track record']
    : ['Review this book', 'What can I adjust?', 'Show my breakevens', 'Is premium rich here?', `My record on ${stock}`]
}

/** The drawer's frame; what is inside it is caught at its edge, so a throw there leaves the page standing. */
export function AssistantDrawer(props: DrawerProps): ReactElement {
  const [wide, setWide] = useState(storedWide)
  const toggleWide = (): void => { const next = !wide; setWide(next); storeWide(next) }
  return (
    <aside id="traders-assistant" className="traders-assistant" aria-label="Assistant" hidden={!props.open} data-wide={wide ? 'true' : undefined}>
      <PageBoundary resetKey={props.stock ?? ''}>
        <DrawerContent {...props} wide={wide} onWide={toggleWide} />
      </PageBoundary>
    </aside>
  )
}

/** An empty chat: one line, then questions that send at once through the composer's `send`. */
function EmptyChat(props: { readonly stock: string | null; send(text: string): void }): ReactElement {
  return (
    <div className="traders-ai-empty">
      <p className="traders-ai-intro">{`${props.stock === null ? 'Ask about your books' : `Ask about ${props.stock}`} — advisory only, nothing is traded.`}</p>
      <div className="traders-ai-suggestions" role="group" aria-label="Suggested questions">
        {suggestionsFor(props.stock).map((q) => (
          <button key={q} type="button" className="traders-ai-suggestion" onClick={() => props.send(q)}>{q}</button>
        ))}
      </div>
    </div>
  )
}

function DrawerContent(props: DrawerProps & { readonly wide: boolean; onWide(): void }): ReactElement {
  const base = useId()
  const [status, setStatus] = useState<StatusState>({ state: 'loading' })
  const [tab, setTab] = useState<Tab>('chat')
  const [cleared, setCleared] = useState<string | null>(null)
  const [goals, setGoals] = useState<Goals>(NO_GOALS)
  const context = props.stock !== null && props.stock !== cleared ? props.stock : null
  const chat = useChat({ stock: context, goals })

  // Asked each time the drawer opens: the spend line and a server restarted since are then current.
  const { open } = props
  useEffect(() => {
    if (!open) return
    let alive = true
    tapi.assistantStatus().then(
      (value) => { if (alive) setStatus(statusOf({ ok: true, value })) },
      (error: unknown) => { if (alive) setStatus(statusOf({ ok: false, error })) },
    )
    return () => { alive = false }
  }, [open])

  const presets = status.state !== 'loading' && status.status !== null && Array.isArray(status.status.presets) && status.status.presets.length > 0
    ? status.status.presets
    : DEFAULT_PRESETS
  const on = status.state === 'on'
  const shownTab: Tab = on ? tab : 'plans'
  const budget = status.state === 'on' && typeof status.status.budget === 'object' && status.status.budget !== null ? status.status.budget : null
  const spentToday = chat.state.usage?.traderUsdToday ?? budget?.traderUsdToday ?? null
  const spend = budget === null || typeof spentToday !== 'number' || typeof budget.traderCapUsd !== 'number'
    ? null : `Today ${usd(spentToday)} of ${usd(budget.traderCapUsd)}`
  const { reset } = chat
  const newChat = useCallback(() => { reset(); setTab('chat') }, [reset])
  // A conversation opened from the list carries its own stock; the chip shows the conversation's while it is open.
  const chipStock = shownTab === 'chat' && chat.state.conversationId !== null ? chat.state.stock : context
  // With the assistant off there is one panel and no tabs.
  const panel = (id: Tab): Record<string, unknown> => (on ? panelProps(base, id, shownTab === id) : { hidden: shownTab !== id })

  return (
    <>
      <div className="traders-ai-head">
        <span className="traders-ai-title">Assistant</span>
        {chipStock === null ? null : (
          <span className="traders-ai-chip traders-ai-context-chip" title="The book the assistant is asked about">
            {chipStock}
            {chipStock === context && chat.state.conversationId === null ? (
              <button type="button" className="traders-ai-x" aria-label={`Clear the ${chipStock} context`} onClick={() => setCleared(chipStock)}>×</button>
            ) : null}
          </span>
        )}
        <span className="traders-ai-grow" />
        {on && chat.state.model !== null ? <span className="traders-ai-muted" title="The model answering">{chat.state.model}</span> : null}
        <Button variant="ghost" isIconOnly size="sm" className="traders-ai-widen"
          icon={<Icon icon={props.wide ? 'chevronRight' : 'chevronLeft'} size="sm" color="inherit" />}
          label={props.wide ? 'Narrow the assistant' : 'Widen the assistant'} tooltip={props.wide ? 'Narrow' : 'Widen'} onClick={props.onWide} />
        <Button variant="ghost" isIconOnly size="sm" icon={<Icon icon="close" size="sm" color="inherit" />} label="Close the assistant"
          tooltip="Close (Esc)" onClick={props.onClose} />
      </div>
      {on ? (
        <div className="traders-ai-tabs">
          <TabStrip label="Assistant" base={base} tabs={TABS} value={shownTab} onChange={setTab} className="traders-ai-tablist" tabClassName="traders-ai-tab" />
          <span className="traders-ai-grow" />
          <button type="button" className="traders-ai-link" onClick={newChat}>New chat</button>
        </div>
      ) : null}
      {status.state === 'loading' ? <div className="traders-ai-body"><div className="traders-ai-muted">Asking the server…</div></div> : null}
      {status.state === 'off' ? <div className="traders-ai-off" role="status">{status.reason}</div> : null}
      {status.state === 'loading' ? null : (
        <div className="traders-ai-panel" {...panel('plans')}>
          <div className="traders-ai-body">
            <PlanSearch stock={context} stocks={props.stocks} presets={presets} goals={goals} onGoals={setGoals} />
          </div>
        </div>
      )}
      {on ? (
        <div className="traders-ai-panel" {...panel('chat')}>
          <div className="traders-ai-body">
            {chat.state.messages.length === 0
              ? <EmptyChat stock={context} send={chat.send} />
              : <Messages state={chat.state} onRated={chat.rate} />}
          </div>
          <Composer running={chat.running} goals={goals} stock={chipStock} spend={spend} send={chat.send} stop={chat.stop} />
        </div>
      ) : null}
      {on ? (
        <div className="traders-ai-panel" {...panel('history')}>
          {shownTab === 'history' ? (
            <div className="traders-ai-body">
              <Conversations current={chat.state.conversationId} open={(v, model) => { chat.load(v, model); setTab('chat') }} />
            </div>
          ) : null}
        </div>
      ) : null}
    </>
  )
}
