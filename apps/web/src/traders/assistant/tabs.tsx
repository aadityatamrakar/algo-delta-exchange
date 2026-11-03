/**
 * A small tab strip with the whole ARIA tabs pattern: each tab names the panel it controls, only the selected tab
 * is in the Tab order, and the arrow keys (Home, End) move between tabs and select them.
 */

import { useRef, type KeyboardEvent, type ReactElement } from 'react'

export const tabId = (base: string, id: string): string => `${base}-tab-${id}`
export const panelId = (base: string, id: string): string => `${base}-panel-${id}`

/** The props of the panel `id` controls. */
export function panelProps(base: string, id: string, shown: boolean): { id: string; role: 'tabpanel'; 'aria-labelledby': string; hidden: boolean } {
  return { id: panelId(base, id), role: 'tabpanel', 'aria-labelledby': tabId(base, id), hidden: !shown }
}

export function TabStrip<T extends string>(props: {
  readonly label: string
  /** Unique on the page (useId): the tabs' and panels' ids derive from it. */
  readonly base: string
  readonly tabs: readonly { readonly id: T; readonly label: string }[]
  readonly value: T
  readonly onChange: (id: T) => void
  readonly className: string
  readonly tabClassName: string
  /** One panel for every tab (a card shows one plan at a time): its id, instead of one panel per tab. */
  readonly sharedPanel?: string
}): ReactElement {
  const strip = useRef<HTMLDivElement>(null)
  const { tabs } = props
  const onKey = (e: KeyboardEvent<HTMLButtonElement>, at: number): void => {
    const to = e.key === 'ArrowRight' ? (at + 1) % tabs.length
      : e.key === 'ArrowLeft' ? (at - 1 + tabs.length) % tabs.length
        : e.key === 'Home' ? 0
          : e.key === 'End' ? tabs.length - 1
            : null
    if (to === null) return
    e.preventDefault()
    const t = tabs[to]
    if (t === undefined) return
    props.onChange(t.id)
    strip.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[to]?.focus()
  }
  return (
    <div ref={strip} role="tablist" aria-label={props.label} className={props.className}>
      {tabs.map((t, i) => {
        const on = t.id === props.value
        return (
          <button key={t.id} type="button" role="tab" id={tabId(props.base, t.id)} aria-selected={on} tabIndex={on ? 0 : -1}
            aria-controls={props.sharedPanel ?? panelId(props.base, t.id)} className={props.tabClassName}
            onClick={() => props.onChange(t.id)} onKeyDown={(e) => onKey(e, i)}>
            {t.label}
          </button>
        )
      })}
    </div>
  )
}
