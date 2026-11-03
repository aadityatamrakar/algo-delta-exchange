/**
 * The traders pages' warning and note lists, each line dismissible — the one place they are drawn.
 *
 * A dismissed line is hidden on this browser for the signed-in user, keyed by its EXACT text, until the IST day
 * ends: a constant line about live state (a dead feed) comes back the next day, and a line whose text changes (a
 * count, a date) is a new line and shows at once. "N hidden — show" brings a list's lines back. Only the server's
 * warning/note lists and the pages' standing caveats come through here: a failed request or a form's error is never
 * dismissible.
 *
 * localStorage may refuse (private mode, a full quota): every read and write is guarded, and a refused write still
 * hides the line for as long as the page stays open.
 */

import { useCallback, useState, useSyncExternalStore } from 'react'
import { HStack } from '@astryxdesign/core/Layout'
import { Banner } from '@astryxdesign/core/Banner'
import { Button } from '@astryxdesign/core/Button'
import { Icon } from '@astryxdesign/core/Icon'
import { ListItem } from '@astryxdesign/core/List'
import { Text } from '@astryxdesign/core/Text'
import { useBellReport } from './bell-store.tsx'
import { useSession } from './hooks.ts'
import { istDay } from './wire.ts'

const KEY = 'traders.dismissed'

/** One IST day's dismissals, per signed-in user. A new day starts empty. */
interface Stored { readonly day: string; readonly byUser: Readonly<Record<string, readonly string[]>> }

const EMPTY: Stored = { day: '', byUser: {} }
let memory: Stored = EMPTY
let version = 0
const listeners = new Set<() => void>()

function parse(raw: string | null): Stored {
  if (raw === null) return EMPTY
  try {
    const v = JSON.parse(raw) as { day?: unknown; byUser?: unknown }
    if (typeof v.day !== 'string' || typeof v.byUser !== 'object' || v.byUser === null) return EMPTY
    const byUser: Record<string, string[]> = {}
    for (const [u, texts] of Object.entries(v.byUser)) {
      if (Array.isArray(texts)) byUser[u] = texts.filter((t): t is string => typeof t === 'string')
    }
    return { day: v.day, byUser }
  } catch {
    return EMPTY
  }
}

function read(): Stored {
  try { return parse(window.localStorage.getItem(KEY)) } catch { return memory }
}

function write(s: Stored): void {
  memory = s
  try { window.localStorage.setItem(KEY, JSON.stringify(s)) } catch { /* refused: the hide lasts while the page is open */ }
  version += 1
  for (const fn of listeners) fn()
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

export interface Dismissed {
  /** The lines still shown, in order. */
  readonly shown: readonly string[]
  /** How many of this list's lines are hidden today. */
  readonly hidden: number
  dismiss(text: string): void
  /** Shows this list's hidden lines again. */
  restore(): void
}

/** The lines `user` dismissed today. */
function goneToday(user: string): ReadonlySet<string> {
  const s = read()
  return new Set(s.day === istDay(Date.now()) ? (s.byUser[user] ?? []) : [])
}

/** For a count across many lists (the bell's): the lines of `items` still shown, re-read when a dismissal changes. */
export function useShownFilter(): (items: readonly string[]) => readonly string[] {
  const user = useSession()?.username ?? ''
  useSyncExternalStore(subscribe, () => version)
  const gone = goneToday(user)
  return (items) => items.filter((t) => !gone.has(t))
}

export function useDismissed(items: readonly string[]): Dismissed {
  const user = useSession()?.username ?? ''
  useSyncExternalStore(subscribe, () => version)
  const gone = goneToday(user)
  const shown = items.filter((t) => !gone.has(t))
  const hidden = new Set(items.filter((t) => gone.has(t))).size

  const change = useCallback((f: (texts: readonly string[]) => readonly string[]) => {
    const now = istDay(Date.now())
    const cur = read()
    const base = cur.day === now ? cur.byUser : {}
    write({ day: now, byUser: { ...base, [user]: f(base[user] ?? []) } })
  }, [user])
  const dismiss = useCallback((t: string) => { change((ts) => (ts.includes(t) ? ts : [...ts, t])) }, [change])
  const key = JSON.stringify(items)
  const restore = useCallback(() => {
    const mine = new Set(JSON.parse(key) as string[])
    change((ts) => ts.filter((t) => !mine.has(t)))
  }, [change, key])
  return { shown, hidden, dismiss, restore }
}

/** The small close control, the same one a Banner draws. */
export function DismissButton(props: { onClick: () => void }): React.ReactElement {
  return (
    <Button variant="ghost" size="sm" label="Dismiss" tooltip="Dismiss" isIconOnly
      icon={<Icon icon="close" size="sm" color="inherit" />} onClick={props.onClick} />
  )
}

export function ShowHidden(props: { hidden: number; onClick: () => void }): React.ReactElement | null {
  if (props.hidden === 0) return null
  return <Button variant="ghost" size="sm" label={`${props.hidden} hidden — show`} onClick={props.onClick} />
}

/**
 * A list of warnings, notes (small secondary text) or list items (inside the caller's `List`).
 * Warnings go to the shell's bell (bell.tsx) and draw nothing here; with no bell above (a page on its own) they draw
 * as banners. Notes and items stay beside the figure they explain, folded: one ⓘ toggle, "Notes (N)", opens them
 * (N counts the lines not dismissed; with none left only the restore shows). An item list's toggle is its one item.
 * `limit` shows the first n lines still shown, then `more(rest)` (inline only; the bell lists every line).
 */
export function Caveats(props: {
  items: readonly string[]
  kind: 'warning' | 'note' | 'item'
  limit?: number
  more?: (rest: number) => string
  /** The fold's name (notes and items): "Notes" unless the list is something else. */
  label?: string
}): React.ReactElement | null {
  const toBell = useBellReport(props.kind === 'warning' && props.items.length > 0 ? { items: props.items } : null)
  const d = useDismissed(props.items)
  const [open, setOpen] = useState(false)
  if (props.items.length === 0 || (props.kind === 'warning' && toBell)) return null
  const lines = props.limit === undefined ? d.shown : d.shown.slice(0, props.limit)
  const rest = d.shown.length - lines.length
  const restore = <ShowHidden hidden={d.hidden} onClick={d.restore} />
  if (props.kind !== 'warning') {
    const n = d.shown.length
    const row = (key: string, node: React.ReactNode): React.ReactElement =>
      props.kind === 'item' ? <ListItem key={key} label={node} /> : <HStack key={key} gap={1} align="center">{node}</HStack>
    return (
      <>
        {n === 0 ? null : row('fold', (
          <span className="traders-notes-toggle">
            <Button variant="ghost" size="sm" label={`${props.label ?? 'Notes'} (${n})`} aria-expanded={open}
              icon={<Icon icon="info" size="sm" color="inherit" />} onClick={() => setOpen((o) => !o)} />
          </span>
        ))}
        {!open ? null : lines.map((t, i) => {
          const key = `${i}:${t}`
          const text = <Text size="sm" color="secondary">{t}</Text>
          const close = <DismissButton onClick={() => d.dismiss(t)} />
          return props.kind === 'item'
            ? <ListItem key={key} label={text} endContent={close} />
            : <HStack key={key} gap={1} align="center">{text}{close}</HStack>
        })}
        {open && rest > 0 && props.more !== undefined ? <Text size="sm" color="secondary">{props.more(rest)}</Text> : null}
        {(open || n === 0) && d.hidden > 0 ? row('restore', restore) : null}
      </>
    )
  }
  return (
    <>
      {lines.map((t, i) => <Banner key={`${i}:${t}`} status="warning" title={t} isDismissable onDismiss={() => d.dismiss(t)} />)}
      {rest > 0 && props.more !== undefined ? <Text size="sm" color="secondary">{props.more(rest)}</Text> : null}
      {d.hidden === 0 ? null : <HStack>{restore}</HStack>}
    </>
  )
}
