/**
 * The light/dark switch's state, shared by the desk page and the traders page.
 *
 * A leaf on purpose: it imports only React, so the traders page can use it
 * without reaching the desk's client (test/traders-imports.test.ts). One storage
 * key for both pages is harmless: it is a display preference, and the two pages
 * are served from different origins, so each keeps its own anyway.
 */

import { useCallback, useState } from 'react'

export type ThemeMode = 'system' | 'light' | 'dark'

const THEME_KEY = 'desk.theme'

/** Persisted theme mode. Defaults to `system` so the OS setting wins first. */
export function useThemeMode(): [ThemeMode, (m: ThemeMode) => void] {
  const [mode, setMode] = useState<ThemeMode>(() => {
    const stored = window.localStorage.getItem(THEME_KEY)
    return stored === 'light' || stored === 'dark' || stored === 'system' ? stored : 'system'
  })
  const set = useCallback((m: ThemeMode) => {
    window.localStorage.setItem(THEME_KEY, m)
    setMode(m)
  }, [])
  return [mode, set]
}

/** Cycles system -> light -> dark, so one control covers all three. */
export function nextMode(m: ThemeMode): ThemeMode {
  return m === 'system' ? 'light' : m === 'light' ? 'dark' : 'system'
}

export function modeLabel(m: ThemeMode): string {
  return m === 'system' ? 'Auto' : m === 'light' ? 'Light' : 'Dark'
}
