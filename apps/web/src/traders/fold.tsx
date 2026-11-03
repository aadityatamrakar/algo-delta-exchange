/**
 * Quiet layers, so a page's front shows what a trader acts on and everything else is one key or click away:
 *
 * - `Fold`: a titled section, closed until opened, its state remembered per browser. A one-key `shortcut` (the
 *   page's keyboard layer, shortcuts.tsx, presses it) and a short `badge` on its title ("2 not understood") say what
 *   is inside without showing it.
 * - `InfoTip`: an ⓘ beside a heading or a figure that shows its explanation — the same words that used to sit on
 *   the page — on demand; Esc or a click elsewhere closes it.
 *
 * Nothing here is deleted from the page: every line is still there behind its ⓘ or inside its fold.
 */

import { useEffect, useId, useRef, useState, type ReactNode } from 'react'

const KEY = 'traders.folds'

function readFolds(): Record<string, boolean> {
  try {
    const v: unknown = JSON.parse(window.localStorage.getItem(KEY) ?? '{}')
    return typeof v === 'object' && v !== null ? (v as Record<string, boolean>) : {}
  } catch {
    return {}
  }
}

function writeFold(id: string, open: boolean): void {
  try { window.localStorage.setItem(KEY, JSON.stringify({ ...readFolds(), [id]: open })) } catch { /* remembered for this visit only */ }
}

export function Fold(props: {
  id: string; title: string; shortcut?: string; badge?: string | null; defaultOpen?: boolean; children: ReactNode
}): React.ReactElement {
  const { id } = props
  const [open, setOpen] = useState<boolean>(() => readFolds()[id] ?? props.defaultOpen ?? false)
  const body = useId()
  const toggle = (): void => { setOpen(!open); writeFold(id, !open) }
  return (
    <section className="traders-fold" data-open={open ? 'true' : 'false'}>
      <button
        type="button"
        className="traders-fold-head"
        aria-expanded={open}
        aria-controls={body}
        {...(props.shortcut === undefined ? {} : { 'data-fold-key': props.shortcut })}
        onClick={toggle}
      >
        <span className="traders-fold-mark" aria-hidden="true">{open ? '▾' : '▸'}</span>
        <span>{props.title}</span>
        {props.badge === undefined || props.badge === null ? null : <span className="traders-fold-badge">{props.badge}</span>}
        {props.shortcut === undefined ? null : <kbd className="traders-fold-key" aria-hidden="true">{props.shortcut}</kbd>}
      </button>
      {open ? <div id={body} role="region" aria-label={props.title} className="traders-fold-body">{props.children}</div> : null}
    </section>
  )
}

export function InfoTip(props: { label: string; children: ReactNode }): React.ReactElement {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!open) return
    const key = (e: KeyboardEvent): void => { if (e.key === 'Escape') setOpen(false) }
    const away = (e: MouseEvent): void => { if (root.current !== null && !root.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('keydown', key)
    document.addEventListener('mousedown', away)
    return () => { document.removeEventListener('keydown', key); document.removeEventListener('mousedown', away) }
  }, [open])
  return (
    <span ref={root} className="traders-info">
      <button type="button" className="traders-info-button" aria-label={`About ${props.label}`} aria-expanded={open} onClick={() => setOpen(!open)}>
        ⓘ
      </button>
      {open ? <span role="note" aria-label={props.label} className="traders-info-panel">{props.children}</span> : null}
    </span>
  )
}
