/**
 * Per-test isolation, and the two browser facts these tests depend on.
 *
 * The mode switch lives in `localStorage` and the router lives in
 * `location.hash`; both are shared, mutable, per-tab state. A test that leaves
 * `desk.mode: live` behind makes the NEXT test's "a default browser lands on
 * paper" pass or fail depending on the order it ran in, which is worse than no
 * test at all — so both are reset before every test rather than at the end of
 * the ones that touch them.
 */
import { afterEach, beforeEach } from 'vitest'
import { cleanup } from '@testing-library/react'

/**
 * `CSS.escape` — a real browser API that jsdom does not implement at all
 * (`window.CSS` is `undefined`).
 *
 * astryx's Dialog calls it to build a `querySelector` for its own title id, so
 * without this EVERY test that opens a dialog dies with "Cannot read properties
 * of undefined (reading 'escape')" — a failure that says nothing about the
 * component and everything about the environment.
 *
 * The identifier-escaping rules are from CSSOM §2.1. The ids being escaped here
 * are component-generated, so the exotic branches are unreachable in practice;
 * they are implemented anyway because a polyfill that is subtly wrong is worse
 * than an obvious absence.
 */
if (typeof globalThis.CSS === 'undefined') {
  ;(globalThis as { CSS?: unknown }).CSS = {}
}
if (typeof (globalThis.CSS as { escape?: unknown }).escape !== 'function') {
  ;(globalThis.CSS as { escape: (v: string) => string }).escape = (value: string): string => {
    const s = String(value)
    let out = ''
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i)
      const ch = s[i] as string
      if (c === 0x0000) {
        out += '\uFFFD'
      } else if (
        (c >= 0x0001 && c <= 0x001f) ||
        c === 0x007f ||
        (i === 0 && c >= 0x0030 && c <= 0x0039) ||
        (i === 1 && c >= 0x0030 && c <= 0x0039 && s.charCodeAt(0) === 0x002d)
      ) {
        out += `\\${c.toString(16)} `
      } else if (i === 0 && c === 0x002d && s.length === 1) {
        out += `\\${ch}`
      } else if (
        c >= 0x0080 ||
        c === 0x002d ||
        c === 0x005f ||
        (c >= 0x0030 && c <= 0x0039) ||
        (c >= 0x0041 && c <= 0x005a) ||
        (c >= 0x0061 && c <= 0x007a)
      ) {
        out += ch
      } else {
        out += `\\${ch}`
      }
    }
    return out
  }
}

/**
 * `matchMedia`, which jsdom does not implement.
 *
 * Astryx reads it for `prefers-color-scheme` and `prefers-reduced-motion`, so
 * without it every component that resolves a theme throws on render and the
 * failure looks nothing like its cause. Answering `false` puts the tests in
 * light mode with motion enabled, which is the same default a browser with no
 * OS preference gives.
 */
if (typeof window.matchMedia !== 'function') {
  window.matchMedia = (query: string): MediaQueryList => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }) as MediaQueryList
}

/**
 * `<dialog>.showModal()`, which jsdom does not implement either.
 *
 * Every confirmation on this dashboard is a dialog — the re-auth prompt, the
 * flatten, the bulk switch, remove — so without this the tests that matter most
 * are the ones that cannot run. The polyfill is deliberately the minimum: open
 * it, close it, fire `close`. Focus trapping and the top layer are the
 * browser's job and nothing here asserts on them.
 */
if (typeof HTMLDialogElement === 'function'
  && typeof HTMLDialogElement.prototype.showModal !== 'function') {
  const open = function (this: HTMLDialogElement): void { this.open = true }
  HTMLDialogElement.prototype.showModal = open
  HTMLDialogElement.prototype.show = open
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement): void {
    this.open = false
    this.dispatchEvent(new Event('close'))
  }
}

beforeEach(() => {
  window.localStorage.clear()
  window.location.hash = ''
})

afterEach(() => {
  cleanup()
})
