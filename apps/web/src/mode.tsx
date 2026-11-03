/**
 * THE ONE PAPER/LIVE SWITCH — its state, its persistence, and the three places
 * its colour appears.
 *
 * Paper/live used to be decided six different ways: two page pairs, a toggle on
 * Controls, another on the strategy page, two totals cards on Reports, and
 * whichever page a P&L card happened to sit on. The duality is real — the desk
 * runs both — but re-deciding it on every screen is not. One switch in the
 * navbar, read by every page, and no page carries a mode control of its own.
 *
 * DEFAULT IS PAPER on a browser that has never set it, and on any stored value
 * that is not exactly `live`. The first thing a new machine does must not be to
 * point at real money.
 *
 * THE SWITCH CHANGES WHAT YOU SEE; IT NEVER GRANTS A PERMISSION. Moving it to
 * live asks nothing — looking is free. Enabling a strategy to trade live still
 * costs the password, exactly as before.
 *
 * THE COLOUR IS APPLIED IN THE SAME THREE PLACES EVERY TIME so it is learned
 * once: the switch itself (the selected side is filled), a 3px rule across the
 * whole page under the navbar, and the badge on anything mode-scoped.
 *
 * Green is deliberately not one of the two. Green already means profit here, and
 * a green chrome beside a red P&L figure is two meanings of colour fighting on
 * one screen.
 */

import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import { HStack, VStack } from '@astryxdesign/core/Layout'
import { Badge } from '@astryxdesign/core/Badge'
import { Button } from '@astryxdesign/core/Button'
import { Text } from '@astryxdesign/core/Text'
import type { DeskMode } from './api.ts'

const MODE_KEY = 'desk.mode'

/** Anything but the exact string `live` reads as paper — the safe direction. */
function stored(): DeskMode {
  return window.localStorage.getItem(MODE_KEY) === 'live' ? 'live' : 'paper'
}

interface ModeControl {
  mode: DeskMode
  setMode: (m: DeskMode) => void
}

const ModeContext = createContext<ModeControl | null>(null)

export function ModeProvider(props: { children: React.ReactNode }): React.ReactElement {
  const [mode, set] = useState<DeskMode>(stored)

  const setMode = useCallback((m: DeskMode) => {
    window.localStorage.setItem(MODE_KEY, m)
    set(m)
  }, [])

  /**
   * A second tab that moved the switch moves this one too.
   *
   * Destructive actions — close-all, flatten, the kill switch — follow the
   * switch. Two tabs disagreeing about which book they are acting on is exactly
   * how the wrong one gets flattened, and `localStorage` is already the single
   * source of truth; this just stops a tab rendering a stale copy of it.
   */
  useEffect(() => {
    const onStorage = (e: StorageEvent): void => {
      if (e.key === MODE_KEY) set(stored())
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  return <ModeContext.Provider value={{ mode, setMode }}>{props.children}</ModeContext.Provider>
}

export function useModeControl(): ModeControl {
  const v = useContext(ModeContext)
  if (v === null) throw new Error('useMode outside ModeProvider')
  return v
}

/** What every page reads. Nothing outside the navbar should need the setter. */
export function useMode(): DeskMode {
  return useModeControl().mode
}

/**
 * The palette, in one object, so the switch, the rule and the badge cannot
 * drift apart.
 *
 * THE BLUE AND RED RAMPS, NOT `--color-accent` OR THE `primary`/`destructive`
 * BUTTON VARIANTS. This theme's accent and primary are near-black, so a rule
 * painted with them came out as a black bar — present, but saying nothing about
 * which book you are on, which is the entire job.
 *
 * Within the ramps it is the `icon-*` step and not `border-*`. Measured in the
 * running app: `--color-border-red` is `#e6bab8` in light, a pale pink that a
 * 3px line renders as barely-there decoration; `--color-icon-red` is `#89001a`
 * light and `#ff9e97` dark, both of which carry at 3px against their own
 * background. The rule only works if it is seen without being looked for.
 *
 * `fill` is the 20% tint and `ink` the readable text on it — the same pairing
 * `Badge variant="blue"` uses, so the switch and the badge beside it are one
 * colour rather than two blues.
 */
const PAINT: Record<DeskMode, {
  word: string
  rule: string
  fill: string
  ink: string
  badge: 'blue' | 'red'
}> = {
  paper: {
    word: 'PAPER',
    rule: 'var(--color-icon-blue)',
    fill: 'var(--color-background-blue)',
    ink: 'var(--color-text-blue)',
    badge: 'blue',
  },
  live: {
    word: 'LIVE',
    rule: 'var(--color-icon-red)',
    fill: 'var(--color-background-red)',
    ink: 'var(--color-text-red)',
    badge: 'red',
  },
}

/**
 * The persistent frame. A rule, not a banner: a banner is something somebody
 * learns to dismiss, and the property being replaced — "which page am I on" —
 * survived a reload and could not be turned off.
 */
export function ModeRule(): React.ReactElement {
  const mode = useMode()
  return <VStack width="100%" height={3} style={{ backgroundColor: PAINT[mode].rule }} />
}

/**
 * The badge beside anything mode-scoped.
 *
 * IT CARRIES THE WORD, not only the colour. Colour alone fails for the ~8% of
 * men with red-green deficiency, and it fails entirely on a screenshot pasted
 * into a chat — which is how most of this dashboard gets discussed.
 */
export function ModeBadge(props: { mode?: DeskMode }): React.ReactElement {
  const current = useMode()
  const m = props.mode ?? current
  return <Badge variant={PAINT[m].badge} label={PAINT[m].word} />
}

/**
 * The switch itself. The selected side is filled in its mode's colour; the
 * other is a plain ghost button, so which one is active is legible from the
 * fill alone at a glance and from the word on inspection.
 */
export function ModeSwitch(): React.ReactElement {
  const { mode, setMode } = useModeControl()
  return (
    <HStack gap={1} align="center">
      {/*
        The word goes below 480px; the switch never does. It is what every page
        below reads, so it stays in the navbar at every width rather than moving
        into the drawer with the links — see NavDrawer in App.tsx. What is lost
        on a narrow phone is a label for a control whose two options are already
        the words PAPER and LIVE. See responsive.css.
      */}
      <Text size="sm" color="secondary" className="desk-mode-label">Showing</Text>
      {(['paper', 'live'] as const).map((m) => (
        <Button
          key={m}
          size="sm"
          variant="ghost"
          label={PAINT[m].word}
          // Inline rather than a variant: no button variant in this theme is
          // blue or red, and the switch has to be the same colour as the rule
          // and the badge or the operator learns three colours instead of one.
          style={m === mode ? {
            backgroundColor: PAINT[m].fill,
            color: PAINT[m].ink,
            boxShadow: `inset 0 0 0 1px ${PAINT[m].rule}`,
          } : undefined}
          onClick={() => setMode(m)}
        />
      ))}
    </HStack>
  )
}
