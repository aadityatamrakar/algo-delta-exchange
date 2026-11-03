/**
 * The traders page's keyboard layer, one listener for the whole page. It only moves between screens and panels:
 * nothing here places, changes or applies anything.
 *
 * It never fires while focus is in a field (input, select, textarea, a combobox, anything editable), while a modal
 * dialog has the keyboard (Esc aside, which the dialog itself handles), or with Ctrl or Cmd held — those are the
 * browser's. Alt+arrows are the browser's Back/Forward, so the stock tabs move on [ and ].
 */

import { useEffect, useRef } from 'react'
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog'
import { Layout, LayoutContent } from '@astryxdesign/core/Layout'

/** The `e` key on a page with an editable layout: start or finish editing it. */
export const EDIT_LAYOUT_EVENT = 'traders:edit-layout'

/** Opens or closes the Assistant drawer. Free of every other key here and of `PAGE_KEYS` (`g i` is no page). */
export const ASSISTANT_KEY = 'i'

/** `g` then one of these: the page it opens. */
export const PAGE_KEYS: Readonly<Record<string, string>> = { b: 'books', o: 'orders', m: 'market', r: 'range', p: 'portfolio', a: 'admin' }

export const SHORTCUTS: readonly { readonly keys: string; readonly what: string }[] = [
  { keys: 'g b', what: 'Books' },
  { keys: 'g o', what: 'Orders' },
  { keys: 'g m', what: 'Market Watch' },
  { keys: 'g r', what: 'Range' },
  { keys: 'g p', what: 'Portfolio' },
  { keys: 'g a', what: 'Admin (admins only)' },
  { keys: '[ and ]', what: 'Previous / next stock tab' },
  { keys: 'Alt+1 … Alt+9', what: 'Stock tab 1 to 9' },
  { keys: '1 … 9', what: "On a book: its sub-tabs, in order" },
  { keys: 'e', what: 'On a book: edit its layout (move, resize, show or hide blocks), or finish' },
  { keys: '/', what: "Focus the page's first search or input field" },
  { keys: '\\', what: 'Show or hide the menu' },
  { keys: 'n', what: 'Open or close the alerts' },
  { keys: ASSISTANT_KEY, what: 'Open or close the assistant (chat and plan search)' },
  { keys: 'Esc', what: 'Close the alerts, the assistant, or this list' },
  { keys: '?', what: 'This list' },
]

export interface ShortcutActions {
  page(id: string): void
  stockTab(step: -1 | 1): void
  stockTabAt(n: number): void
  subTab(n: number): void
  search(): void
  sidebar(): void
  bell(): void
  assistant(): void
  /** Closes the topmost panel; true when it closed one. */
  escape(): boolean
  help(): void
}

const NOT_TEXT = new Set(['button', 'checkbox', 'radio', 'submit', 'reset', 'range', 'color', 'file', 'image'])

/** Is `t` somewhere the keys are text, not commands. */
export function isTyping(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false
  if (t.isContentEditable || t.closest('[contenteditable="true"]') !== null) return true
  const tag = t.tagName
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (tag === 'INPUT') return !NOT_TEXT.has((t as HTMLInputElement).type)
  const role = t.getAttribute('role')
  return role === 'combobox' || role === 'textbox' || role === 'searchbox' || role === 'spinbutton'
}

const G_WAIT_MS = 1500

export function useShortcuts(actions: ShortcutActions): void {
  const latest = useRef(actions)
  latest.current = actions
  useEffect(() => {
    let gAt = 0
    const on = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey) return
      const a = latest.current
      if (e.key === 'Escape') {
        if (a.escape()) e.preventDefault()
        return
      }
      if (isTyping(e.target)) return
      // An open <dialog> (a form, this help) has the keyboard. Not [aria-modal]: closed pickers keep theirs in the page.
      if (document.querySelector('dialog[open]') !== null) return
      // Alt+digit by its key position: on a Mac, Alt changes the character the key types.
      if (e.altKey) {
        const m = /^Digit([1-9])$/.exec(e.code)
        if (m !== null) { e.preventDefault(); a.stockTabAt(Number(m[1])) }
        return
      }
      const now = Date.now()
      if (gAt > 0 && now - gAt <= G_WAIT_MS) {
        gAt = 0
        const id = PAGE_KEYS[e.key]
        if (id !== undefined) { e.preventDefault(); a.page(id) }
        return
      }
      gAt = 0
      switch (e.key) {
        case 'g': gAt = now; return
        case '[': e.preventDefault(); a.stockTab(-1); return
        case ']': e.preventDefault(); a.stockTab(1); return
        case '/': e.preventDefault(); a.search(); return
        case '\\': e.preventDefault(); a.sidebar(); return
        case 'n': e.preventDefault(); a.bell(); return
        case ASSISTANT_KEY: e.preventDefault(); a.assistant(); return
        case '?': e.preventDefault(); a.help(); return
        case 'e': {
          // A page with an editable layout answers (analysis-tab.tsx); elsewhere 'e' is a fold key like any other letter.
          if (document.querySelector('[data-layout-editable="true"]') !== null) {
            e.preventDefault(); window.dispatchEvent(new CustomEvent(EDIT_LAYOUT_EVENT)); return
          }
          const fold = document.querySelector<HTMLElement>('[data-fold-key="e"]')
          if (fold !== null) { e.preventDefault(); fold.click() }
          return
        }
        default: {
          if (/^[1-9]$/.test(e.key)) { e.preventDefault(); a.subTab(Number(e.key)); return }
          // A fold on the page that answers to this letter (fold.tsx): open or close it.
          const fold = /^[a-z]$/.test(e.key) ? document.querySelector<HTMLElement>(`[data-fold-key="${e.key}"]`) : null
          if (fold !== null) { e.preventDefault(); fold.click() }
        }
      }
    }
    document.addEventListener('keydown', on)
    return () => document.removeEventListener('keydown', on)
  }, [])
}

/** Focuses the page's first search or input field (a page may mark one with `data-shortcut="search"`). */
export function focusPageSearch(root: ParentNode = document): boolean {
  const main = root.querySelector('.traders-main') ?? root
  const marked = main.querySelector<HTMLElement>('[data-shortcut="search"]')
  const field = marked ?? [...main.querySelectorAll<HTMLElement>('input, [role="combobox"], textarea')].find((el) => isTyping(el))
  if (field === undefined) return false
  field.focus()
  return true
}

export function ShortcutHelp(props: { onClose: () => void }): React.ReactElement {
  return (
    <Dialog isOpen onOpenChange={props.onClose} purpose="info" width={460}>
      <Layout
        header={<DialogHeader title="Keyboard shortcuts" onOpenChange={props.onClose} />}
        content={
          <LayoutContent>
            <table className="traders-shortcuts" aria-label="Keyboard shortcuts">
              <tbody>
                {SHORTCUTS.map((s) => (
                  <tr key={s.keys}><td><kbd>{s.keys}</kbd></td><td>{s.what}</td></tr>
                ))}
              </tbody>
            </table>
          </LayoutContent>
        }
      />
    </Dialog>
  )
}
