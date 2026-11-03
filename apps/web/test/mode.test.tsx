/**
 * The one paper/live switch: its default, its persistence, and its colour.
 *
 * These are the design spec's own testing bullets (§8). They are worth pinning
 * mechanically because every one of them is a property nobody can see by
 * looking at the running app in the state they happen to have left it in — the
 * default only shows on a browser that has never set it, and persistence only
 * shows on the second tab.
 */
import { expect, test, describe } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { ModeBadge, ModeProvider, ModeRule, ModeSwitch, useMode } from '../src/mode.tsx'

/** `useMode` has to be read INSIDE the provider, so the readout is its own node. */
function Readout(): React.ReactElement {
  return <span data-testid="mode">{useMode()}</span>
}

function Desk(): React.ReactElement {
  return (
    <ModeProvider>
      <ModeSwitch />
      <ModeRule />
      <ModeBadge />
      <Readout />
    </ModeProvider>
  )
}

const ruleColour = (container: HTMLElement): string | undefined =>
  (container.querySelector('[style*="background-color"]') as HTMLElement | null)?.style
    .backgroundColor

describe('the mode switch', () => {
  test('a browser that has never set it lands on paper', () => {
    render(<Desk />)
    expect(screen.getByTestId('mode').textContent).toBe('paper')
    // The word, not only the colour: a screenshot and a red-green-deficient
    // reader both need it.
    expect(screen.getAllByText('PAPER').length).toBeGreaterThan(0)
  })

  test('anything in storage that is not exactly `live` reads as paper', () => {
    window.localStorage.setItem('desk.mode', 'LIVE ')
    render(<Desk />)
    expect(screen.getByTestId('mode').textContent).toBe('paper')
  })

  test('the choice persists: a reload, and a second tab, both come up live', () => {
    const first = render(<Desk />)
    act(() => { screen.getByRole('button', { name: 'LIVE' }).click() })
    expect(screen.getByTestId('mode').textContent).toBe('live')
    expect(window.localStorage.getItem('desk.mode')).toBe('live')

    // A reload is a fresh mount against the same storage.
    first.unmount()
    render(<Desk />)
    expect(screen.getByTestId('mode').textContent).toBe('live')
  })

  test('a second tab moving the switch moves this one', () => {
    render(<Desk />)
    expect(screen.getByTestId('mode').textContent).toBe('paper')
    act(() => {
      window.localStorage.setItem('desk.mode', 'live')
      window.dispatchEvent(new StorageEvent('storage', { key: 'desk.mode', newValue: 'live' }))
    })
    // Destructive actions follow this switch, so two tabs disagreeing about
    // which book they act on is how the wrong one gets flattened.
    expect(screen.getByTestId('mode').textContent).toBe('live')
  })

  test('each mode paints the rule in its own colour', () => {
    // Rendered on its own: the switch's selected side is also a filled element,
    // and asserting on "the first coloured thing" would pin that instead.
    const paper = render(<ModeProvider><ModeRule /></ModeProvider>)
    expect(ruleColour(paper.container)).toContain('--color-icon-blue')
    paper.unmount()

    window.localStorage.setItem('desk.mode', 'live')
    const live = render(<ModeProvider><ModeRule /></ModeProvider>)
    // The `icon-*` step, not `border-*`: measured in the running app, the
    // border ramp is a pale pink that reads as decoration at 3px.
    expect(ruleColour(live.container)).toContain('--color-icon-red')
  })

  test('the badge can be pinned to a mode the switch is not on', () => {
    // The feed's books are the paper rail whatever the switch says; a badge
    // that followed the switch there would state the wrong book.
    render(
      <ModeProvider>
        <ModeBadge mode="paper" />
      </ModeProvider>,
    )
    expect(screen.getByText('PAPER')).toBeTruthy()
  })
})
