/**
 * The STRATEGY panel on the run page.
 *
 * WHY THIS FILE EXISTS: on 2026-08-05 the desk showed delta-neutral at 2.4%,
 * outside the variant's 2% band, and added nothing. The book was right — net
 * gamma was near zero, so the gamma allowance (188) was under one lot (225)
 * and there was no convexity to centre — but answering that took an SSH
 * session, because the engine's own explanation never left the Python process.
 * This panel is that explanation, and these tests are about it staying
 * readable and, above all, staying harmless.
 *
 * The harmlessness is the part worth testing. This panel is the least
 * important thing on the page and it renders last; everything above it is
 * evidence about the book. A throw in here would unmount the positions table,
 * the order log and the P&L chart with it — taking down the surface an
 * operator needs precisely when something is wrong.
 */
import { expect, test, describe } from 'vitest'
import { render, screen } from '@testing-library/react'
import { StrategyReasonPanel, StrategyReasonLine } from '../src/strategies.tsx'
import type { BookDecisions } from '../src/api.ts'

const REASON =
  'recenter-otm: netΓ -3.8 — allowance 188 under one lot (225); no convexity to centre'

function decisions(over: Partial<BookDecisions> = {}): BookDecisions {
  return {
    tag: 'TCS-2026-08-25-recenter-relief-r',
    mode: 'live',
    lastReason: REASON,
    lastAction: 'hold',
    lastReasonAt: 1785908478807,
    actions: [],
    ...over,
  }
}

describe('the three states', () => {
  test('a quiet book shows its reason and says nothing traded — NOT an error', () => {
    render(<StrategyReasonPanel decisions={decisions()} />)
    // Verbatim, greek and all: the numbers in this sentence are the content.
    expect(screen.getByText(REASON)).toBeTruthy()
    expect(screen.getByText(/Nothing traded since this book opened/)).toBeTruthy()
  })

  test('a book with no reason yet is distinguishable from a broken one', () => {
    render(<StrategyReasonPanel decisions={decisions({ lastReason: null, lastAction: null })} />)
    expect(screen.getByText(/No reason recorded yet/)).toBeTruthy()
  })

  test('actions render oldest-first with their legs', () => {
    render(
      <StrategyReasonPanel
        decisions={decisions({
          actions: [
            {
              at: 1785823000000,
              decisionId: 'd1',
              action: 'adjust',
              reason: 'shed 2 lots',
              fills: [
                { deskTag: 'PE2440', tradingsymbol: 'TCS26AUG2440PE', side: 'Sell', qty: 225, price: 49.6 },
              ],
            },
          ],
        })}
      />,
    )
    expect(screen.getByText(/TCS26AUG2440PE/)).toBeTruthy()
    expect(screen.getByText('1 leg')).toBeTruthy()
  })
})

describe('the one-row line above the book', () => {
  test('prints the current reason next to the greek tiles', () => {
    render(<StrategyReasonLine decisions={decisions()} />)
    expect(screen.getByText(REASON)).toBeTruthy()
  })

  test('renders NOTHING when there is no reason — not an empty strip', () => {
    // A placeholder row here would be permanent furniture above the book on
    // every page that has never reported a reason.
    const { container } = render(<StrategyReasonLine decisions={decisions({ lastReason: null })} />)
    expect(container.textContent).toBe('')
  })

  test('a malformed payload renders nothing rather than throwing', () => {
    const { container } = render(
      <StrategyReasonLine decisions={{ tag: 't' } as unknown as BookDecisions} />,
    )
    expect(container.textContent).toBe('')
  })
})

describe('it cannot take the page down', () => {
  test('a payload missing `actions` entirely still renders', () => {
    // The exact shape that broke 15 tests during development: `actions`
    // undefined, then `.length` on it. A bridge mid-deploy can send this.
    const malformed = { tag: 't', mode: 'live' } as unknown as BookDecisions
    render(<StrategyReasonPanel decisions={malformed} />)
    expect(screen.getByText(/No reason recorded yet/)).toBeTruthy()
  })

  test('an action row with no fills and no timestamp still renders', () => {
    const malformed = decisions({
      actions: [{ decisionId: 'd1' }] as unknown as NonNullable<BookDecisions['actions']>,
    })
    render(<StrategyReasonPanel decisions={malformed} />)
    expect(screen.getByText('0 legs')).toBeTruthy()
  })

  test('null (not yet loaded) shows a loading note rather than throwing', () => {
    render(<StrategyReasonPanel decisions={null} />)
    expect(screen.getByText(/Loading/)).toBeTruthy()
  })
})
