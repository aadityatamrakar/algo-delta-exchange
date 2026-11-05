/**
 * The option chain page's rules: ITM shading, the spot line, PCR, max pain,
 * the settlement countdown, missing quotes, the expiry pill grouping, the
 * flash on a changed cell and the stale / empty / loading states.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { installFetch } from './http.tsx'
import type { ChainRowWire, ChainSide } from '../src/api.ts'
import { ChainPage, ChainTable, ExpiryPills, MISSING, callColumns, putColumns } from '../src/chain.tsx'
import { OiChart } from '../src/chain-oi-chart.tsx'
import {
  compactNumber, daysToExpiry, expiryPillLabel, formatCountdown, groupExpiries, indexChange, intrinsicValue, isFar,
  itmSides, maxPain,
  niceCeil, oiWalls, perContractText, unitsLine,
  putCallRatio, spotLineIndex,
} from '../src/chain-model.ts'

/** 3 Nov 2026, 10:00 IST. */
const NOW = Date.parse('2026-11-03T04:30:00Z')

const side = (over: Partial<ChainSide> = {}): ChainSide => ({
  price: 100, ageMs: 50, bid: 99, ask: 101, mark: 100, iv: 0.45, delta: 0.5, oi: 10, ...over,
})

const ROWS: ChainRowWire[] = [
  { strike: 76000, CE: side({ oi: 40 }), PE: side({ oi: 10 }) },
  { strike: 76200, CE: side({ oi: 20 }), PE: side({ oi: 30 }) },
  { strike: 76400, CE: side({ oi: 10 }), PE: side({ oi: 50 }) },
  { strike: 76600, CE: side({ oi: 5 }), PE: side({ oi: 60 }) },
]

function table(rows: readonly ChainRowWire[], spot: number | null, intrinsic = false): ReturnType<typeof render> {
  return render(
    <ChainTable
      rows={rows}
      spot={spot}
      underlying="BTC"
      expiry="2026-11-06"
      density="full"
      greeks={false}
      intrinsic={intrinsic}
      msToSettle={3 * 86_400_000}
    />,
  )
}

/** The data cells of the row whose strike reads `label`, split by side. */
function sides(label: string): { ce: HTMLElement[]; pe: HTMLElement[] } {
  const row = screen.getByRole('rowheader', { name: label }).closest('tr') as HTMLElement
  const cells = [...row.querySelectorAll('td')] as HTMLElement[]
  return {
    ce: cells.filter((c) => c.classList.contains('chain-ce')),
    pe: cells.filter((c) => c.classList.contains('chain-pe')),
  }
}

describe('in-the-money shading', () => {
  test('calls below the index, puts above it, neither at the index', () => {
    expect(itmSides(76000, 76290)).toEqual({ ce: true, pe: false })
    expect(itmSides(76400, 76290)).toEqual({ ce: false, pe: true })
    expect(itmSides(76290, 76290)).toEqual({ ce: false, pe: false })
    expect(itmSides(76000, null)).toEqual({ ce: false, pe: false })
  })

  test('the table shades the call side below the index and the put side above', () => {
    table(ROWS, 76290)
    const below = sides('76,200')
    expect(below.ce.every((c) => c.dataset.itm === 'true')).toBe(true)
    expect(below.pe.every((c) => c.dataset.itm === 'false')).toBe(true)
    const above = sides('76,400')
    expect(above.ce.every((c) => c.dataset.itm === 'false')).toBe(true)
    expect(above.pe.every((c) => c.dataset.itm === 'true')).toBe(true)
  })
})

/**
 * INTRINSIC VALUE PER STRIKE (operator, 2026-11-05). A call's index − strike,
 * a put's strike − index, never below 0 — measured against the INDEX, which
 * is what a Delta option settles on. It needs no quote, so a side the feed has
 * not priced still states it; `mark − intrinsic` is the time value, which the
 * hover carries.
 */
describe('intrinsic value', () => {
  test('arithmetic: in the money by the distance, out of it by nothing, no index no figure', () => {
    expect(intrinsicValue(76200, 76290)).toEqual({ ce: 90, pe: 0 })
    expect(intrinsicValue(76400, 76290)).toEqual({ ce: 0, pe: 110 })
    expect(intrinsicValue(76290, 76290)).toEqual({ ce: 0, pe: 0 })
    expect(intrinsicValue(76200, null)).toEqual({ ce: null, pe: null })
  })

  test('the column sits on the inside of IV, next to the prices, mirrored on the put side', () => {
    expect(callColumns('full', false, true)).toEqual(['oi', 'delta', 'iv', 'intr', 'bid', 'mark', 'ask'])
    expect(putColumns('full', false, true)).toEqual(['bid', 'mark', 'ask', 'intr', 'iv', 'delta', 'oi'])
    expect(callColumns('compact', false, true)).toEqual(['oi', 'iv', 'intr', 'mark'])
    expect(putColumns('compact', false, true)).toEqual(['mark', 'intr', 'iv', 'oi'])
    // Off: exactly the columns the chain always had.
    expect(callColumns('full', false, false)).toEqual(['oi', 'delta', 'iv', 'bid', 'mark', 'ask'])
  })

  test('each side states its own: the ITM side its distance, the OTM side a quiet zero', () => {
    table(ROWS, 76290, true)
    const cell = (label: string, s: 'ce' | 'pe'): HTMLElement =>
      sides(label)[s].find((c) => c.classList.contains('chain-c-intr')) as HTMLElement
    expect(cell('76,200', 'ce').textContent).toBe('90.00')
    expect(cell('76,200', 'pe').textContent).toBe('0.00')
    expect(cell('76,200', 'pe').querySelector('.chain-zero')).not.toBe(null)
    expect(cell('76,400', 'ce').textContent).toBe('0.00')
    expect(cell('76,400', 'pe').textContent).toBe('110.00')
    // The hover splits the mark: 100 = 90 intrinsic + 10 time value.
    expect(cell('76,200', 'ce').title).toContain('intrinsic 90.00   time value 10.00')
  })

  test('needs no quote — an unpriced side still has its intrinsic', () => {
    table([{ strike: 76400, CE: side(), PE: null }], 76290, true)
    const pe = sides('76,400').pe
    expect(pe.find((c) => c.classList.contains('chain-c-intr'))?.textContent).toBe('110.00')
    // Every QUOTED figure on that side is still the missing dot.
    for (const c of pe.filter((x) => !x.classList.contains('chain-c-intr'))) expect(c.textContent).toBe(MISSING)
  })

  test('no index, no intrinsic — the missing dot, never a zero', () => {
    table(ROWS, null, true)
    const ce = sides('76,200').ce.find((c) => c.classList.contains('chain-c-intr')) as HTMLElement
    expect(ce.textContent).toBe(MISSING)
  })

  test('the page shows it by default, and the toggle takes it off', async () => {
    installFetch(({ path }) => {
      if (path === '/v1/desk/chain/BTC/expiries') return { body: { expiries: ['2026-11-06'] } }
      if (path === '/v1/desk/chain/BTC') return { body: { expiry: '2026-11-06', spot: 76290, future: null, rows: ROWS } }
      return { body: {} }
    })
    render(<ChainPage />)
    await screen.findByRole('rowheader', { name: '76,200' })
    const toggle = screen.getByRole('button', { name: 'Intrinsic' })
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
    expect(document.querySelectorAll('th.chain-c-intr')).toHaveLength(2)
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-pressed')).toBe('false')
    expect(document.querySelectorAll('th.chain-c-intr')).toHaveLength(0)
  })
})

describe('the spot line', () => {
  test('index arithmetic: between the strikes, at the ends, after an exact strike', () => {
    const k = [76000, 76200, 76400, 76600]
    expect(spotLineIndex(k, 76290)).toBe(2)
    expect(spotLineIndex(k, 75000)).toBe(0)
    expect(spotLineIndex(k, 77000)).toBe(4)
    expect(spotLineIndex(k, 76200)).toBe(2)
    expect(spotLineIndex(k, null)).toBe(null)
  })

  test('is drawn between 76,200 and 76,400 with the index price in it', () => {
    table(ROWS, 76290.5)
    const line = screen.getByTestId('spot-line')
    expect(line.textContent).toContain('76,290.50')
    expect(within(line.previousElementSibling as HTMLElement).getByRole('rowheader').textContent).toBe('76,200')
    expect(within(line.nextElementSibling as HTMLElement).getByRole('rowheader').textContent).toBe('76,400')
    // The ATM strike is the one nearest the index.
    expect(screen.getByRole('rowheader', { name: '76,200' }).closest('tr')?.dataset.atm).toBe('true')
  })

  test('goes below every row when the index is above the last strike, and is absent without one', () => {
    const { unmount } = table(ROWS, 80000)
    const line = screen.getByTestId('spot-line')
    expect(line.nextElementSibling).toBe(null)
    unmount()
    table(ROWS, null)
    expect(screen.queryByTestId('spot-line')).toBe(null)
  })
})

describe('PCR and max pain', () => {
  test('PCR is total put OI over total call OI', () => {
    // puts 10+30+50+60 = 150, calls 40+20+10+5 = 75
    expect(putCallRatio(ROWS)).toBe(2)
  })

  test('PCR is null without call OI, or when one side reports none', () => {
    expect(putCallRatio([{ strike: 1, CE: side({ oi: 0 }), PE: side({ oi: 5 }) }])).toBe(null)
    expect(putCallRatio([{ strike: 1, CE: side({ oi: 5 }), PE: side({ oi: null }) }])).toBe(null)
    expect(putCallRatio([{ strike: 1, CE: null, PE: null }])).toBe(null)
  })

  test('max pain is the strike that pays holders least', () => {
    // Heavy put OI above, heavy call OI below: settle near the middle-high.
    expect(maxPain(ROWS)).toBe(76400)
    expect(maxPain([{ strike: 1, CE: null, PE: null }])).toBe(null)
  })
})

describe('the settlement countdown', () => {
  test('formats days, hours, minutes and seconds', () => {
    expect(formatCountdown((2 * 86_400 + 4 * 3600 + 12 * 60 + 33) * 1000)).toBe('2d 04:12:33')
    expect(formatCountdown((3 * 3600 + 5) * 1000 + 900)).toBe('03:00:05')
    expect(formatCountdown(59_000)).toBe('00:00:59')
    expect(formatCountdown(0)).toBe('Settled')
    expect(formatCountdown(-5)).toBe('Settled')
  })

  test('DTE counts IST calendar days', () => {
    expect(daysToExpiry('2026-11-06', NOW)).toBe(3)
    expect(daysToExpiry('2026-11-03', NOW)).toBe(0)
    // 01:00 IST on the 4th is still the 3rd in UTC; the desk's clock says the 4th.
    expect(daysToExpiry('2026-11-06', Date.parse('2026-11-03T19:30:00Z'))).toBe(2)
  })
})

describe('missing quotes', () => {
  test('a side with no quote renders muted dots, never a dash or a zero', () => {
    table([{ strike: 76200, CE: side(), PE: null }, { strike: 76400, CE: side({ iv: null, delta: null }), PE: side() }], 76300)
    const { pe } = sides('76,200')
    expect(pe.length).toBeGreaterThan(0)
    for (const c of pe) {
      expect(c.textContent).toBe(MISSING)
      expect(c.querySelector('.chain-missing')).not.toBe(null)
    }
    // A single absent field on a quoted side is a dot too.
    const { ce } = sides('76,400')
    const iv = ce.find((c) => c.classList.contains('chain-c-iv')) as HTMLElement
    expect(iv.textContent).toBe(MISSING)
    expect(screen.queryByText('—')).toBe(null)
  })
})

describe('expiry pills', () => {
  const list = ['2026-11-04', '2026-11-05', '2026-11-06', '2026-11-13', '2026-11-27', '2026-12-25']

  test('daily is any non-Friday, weekly a Friday, monthly the last Friday of its month', () => {
    const groups = groupExpiries(list)
    expect(groups.map((g) => [g.cls, g.expiries])).toEqual([
      ['daily', ['2026-11-04', '2026-11-05']],
      ['weekly', ['2026-11-06', '2026-11-13']],
      ['monthly', ['2026-11-27', '2026-12-25']],
    ])
    expect(groupExpiries(['2026-11-04']).map((g) => g.cls)).toEqual(['daily'])
  })

  test('each pill shows the date and the DTE, inside its group', () => {
    expect(expiryPillLabel('2026-11-06', NOW)).toBe('06 Nov · 3d')
    render(<ExpiryPills expiries={list} selected="2026-11-06" onPick={() => {}} now={NOW} />)
    const weekly = screen.getByRole('group', { name: 'Weekly expiries' })
    expect(within(weekly).getByRole('button', { name: '06 Nov · 3d' }).getAttribute('aria-pressed')).toBe('true')
    expect(within(weekly).getByRole('button', { name: '13 Nov · 10d' })).toBeTruthy()
    const monthly = screen.getByRole('group', { name: 'Monthly expiries' })
    expect(within(monthly).getAllByRole('button').map((b) => b.textContent)).toEqual(['27 Nov · 24d', '25 Dec · 52d'])
  })
})

describe('live cells and far strikes', () => {
  test('a changed figure flashes up green or down red', () => {
    const r = (bid: number): ChainRowWire[] => [{ strike: 76200, CE: side({ bid }), PE: side() }]
    const { rerender } = table(r(99), 76290)
    const bid = (): HTMLElement =>
      sides('76,200').ce.find((c) => c.classList.contains('chain-c-bid'))?.querySelector('.chain-v') as HTMLElement
    const props = { spot: 76290, underlying: 'BTC', expiry: '2026-11-06', density: 'full' as const, greeks: false, intrinsic: false, msToSettle: 86_400_000 }
    rerender(<ChainTable rows={r(105)} {...props} />)
    expect(bid().classList.contains('chain-up')).toBe(true)
    rerender(<ChainTable rows={r(90)} {...props} />)
    expect(bid().classList.contains('chain-down')).toBe(true)
    expect(bid().classList.contains('chain-up')).toBe(false)
  })

  test('strikes beyond two expected moves are dimmed', () => {
    // 45% IV, 3 days: one sd ≈ 4.1%, so ±8% is far and ±2% is not.
    const t = 3 * 86_400_000
    expect(isFar(76290 * 1.02, 76290, 0.45, t)).toBe(false)
    expect(isFar(76290 * 1.09, 76290, 0.45, t)).toBe(true)
    expect(isFar(76290 * 0.91, 76290, 0.45, t)).toBe(true)
    expect(isFar(76290 * 1.06, 76290, null, t)).toBe(true)
  })
})

describe('page states', () => {
  afterEach(() => { vi.useRealTimers() })

  test('the feed-stale banner shows when the index price is older than 10 s', async () => {
    installFetch(({ path }) => {
      if (path === '/v1/desk/chain/BTC/expiries') return { body: { expiries: ['2026-11-06'] } }
      if (path === '/v1/desk/chain/BTC') {
        return { body: { expiry: '2026-11-06', spot: 76290, spotAsOf: Date.now() - 25_000, future: null, feedAlive: true, rows: ROWS } }
      }
      return { body: {} }
    })
    render(<ChainPage />)
    expect(await screen.findByText('Feed stale')).toBeTruthy()
  })

  test('no stale banner for a fresh index price', async () => {
    installFetch(({ path }) => {
      if (path === '/v1/desk/chain/BTC/expiries') return { body: { expiries: ['2026-11-06'] } }
      if (path === '/v1/desk/chain/BTC') {
        return { body: { expiry: '2026-11-06', spot: 76290, spotAsOf: Date.now(), future: null, feedAlive: true, rows: ROWS } }
      }
      return { body: {} }
    })
    render(<ChainPage />)
    await screen.findByRole('rowheader', { name: '76,200' })
    expect(screen.queryByText('Feed stale')).toBe(null)
    // The header carries the expiry's stats.
    expect(screen.getByText('PCR', { selector: 'dt' }).nextElementSibling?.textContent).toBe('2.00')
    expect(screen.getByText('Max pain', { selector: 'dt' }).nextElementSibling?.textContent).toBe('76,400')
  })

  test('an expiry with no strikes says so, and a first load shows the skeleton', async () => {
    installFetch(({ path }) => {
      if (path === '/v1/desk/chain/BTC/expiries') return { body: { expiries: ['2026-11-06'] } }
      if (path === '/v1/desk/chain/BTC') return { body: { expiry: '2026-11-06', spot: 76290, future: null, rows: [] } }
      return { body: {} }
    })
    render(<ChainPage />)
    expect(screen.getByLabelText('Loading the option chain')).toBeTruthy()
    expect(await screen.findByText('No strikes are listed for BTC 06 Nov.')).toBeTruthy()
    expect(screen.queryByLabelText('Loading the option chain')).toBe(null)
  })
})

describe('the row hover, the ATM row and the OI bars (operator, 3 Nov light-theme screenshot)', () => {
  /** chain.css with its comments removed, so a rule is judged by what it declares. */
  const css = readFileSync(resolve(process.cwd(), 'src', 'chain.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

  /** The declaration bodies of every rule whose selector mentions `needle`. */
  function rulesFor(needle: string): string[] {
    return [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)]
      .filter((m) => (m[1] ?? '').includes(needle))
      .map((m) => m[2] ?? '')
  }

  test('the ATM row is marked by the theme class, with no inline colour on it or its cells', () => {
    table(ROWS, 76290)
    const row = screen.getByRole('rowheader', { name: '76,200' }).closest('tr') as HTMLElement
    expect(row.classList.contains('chain-atm')).toBe(true)
    expect(row.getAttribute('style')).toBe(null)
    for (const cell of row.querySelectorAll<HTMLElement>('td, th')) {
      expect(cell.style.background).toBe('')
      expect(cell.style.backgroundColor).toBe('')
    }
  })

  test('the hover and ATM rules use theme tokens only, never --color-tint-hover', () => {
    const hover = rulesFor('.chain-row:hover')
    expect(hover.length).toBeGreaterThan(0)
    // The hover tints over the cell (inset shadow), never replaces its background or text colour.
    for (const body of hover) {
      expect(body).toContain('box-shadow')
      expect(body).not.toMatch(/(^|[^-])background|(^|[^-])color\s*:/)
    }
    for (const body of [...rulesFor('.chain-atm'), ...rulesFor(':hover')]) {
      expect(body).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|\bblack\b/i)
      expect(body).toContain('var(--')
    }
    // `light-dark(black, white)` in the neutral theme: as a background it painted the row black.
    expect(css).not.toContain('--color-tint-hover')
  })

  test('the OI bar has its own track beside the number and never contains it', () => {
    table(ROWS, 76290)
    for (const cell of document.querySelectorAll<HTMLElement>('td.chain-c-oi')) {
      const track = cell.querySelector('.chain-oi-track') as HTMLElement
      const figure = cell.querySelector('.chain-v') as HTMLElement
      expect(track).not.toBe(null)
      expect(track.contains(figure)).toBe(false)
      expect(track.parentElement).toBe(figure.parentElement)
      const bar = cell.querySelector('.chain-oi-bar')
      if (bar !== null) expect(track.contains(bar)).toBe(true)
    }
  })
})

describe('the index change chip', () => {
  test('shows two decimals of percent from 0.01%, and "flat" below it', () => {
    expect(indexChange(76289.1, 76290)).toEqual({ dir: 'flat', text: 'flat' })
    expect(indexChange(76290, 76290)).toEqual({ dir: 'flat', text: 'flat' })
    expect(indexChange(76410.4, 76290)).toEqual({ dir: 'up', text: '▲ +120.40 (+0.16%)' })
    expect(indexChange(76250, 76290)).toEqual({ dir: 'down', text: '▼ -40.00 (-0.05%)' })
    expect(indexChange(76290, null)).toBe(null)
  })
})

describe('OI walls: the top two strikes per side', () => {
  test('call walls are the two highest call OI, put walls the two highest put OI', () => {
    // ROWS: calls 40, 20, 10, 5; puts 10, 30, 50, 60.
    expect(oiWalls(ROWS, 76290)).toEqual({ ce: [76000, 76200], pe: [76600, 76400] })
  })

  test('missing and zero OI are never walls; one quoted strike gives one wall', () => {
    const rows: ChainRowWire[] = [
      { strike: 76000, CE: side({ oi: null }), PE: null },
      { strike: 76200, CE: side({ oi: 0 }), PE: side({ oi: 7 }) },
      { strike: 76400, CE: null, PE: side({ oi: null }) },
    ]
    expect(oiWalls(rows, 76290)).toEqual({ ce: [], pe: [76200] })
  })

  test('ties go to the strike nearer the index, then the lower strike', () => {
    const rows: ChainRowWire[] = [
      { strike: 75000, CE: side({ oi: 90 }), PE: side({ oi: 40 }) },
      { strike: 76000, CE: side({ oi: 90 }), PE: side({ oi: 40 }) },
      { strike: 77000, CE: side({ oi: 90 }), PE: side({ oi: 40 }) },
      { strike: 78000, CE: side({ oi: 10 }), PE: side({ oi: 40 }) },
    ]
    // Index 76,400: 76,000 is 400 away, 77,000 is 600, 75,000 is 1,400.
    expect(oiWalls(rows, 76400).ce).toEqual([76000, 77000])
    // Index exactly between 76,000 and 77,000 for the puts: the lower strike wins the tie.
    expect(oiWalls(rows, 76500).pe).toEqual([76000, 77000])
    // No index: by strike.
    expect(oiWalls(rows, null).ce).toEqual([75000, 76000])
  })

  test('the table badges, bolds and edges the wall strikes on their own side only', () => {
    table(ROWS, 76290)
    const oiCell = (label: string, s: 'ce' | 'pe'): HTMLElement =>
      sides(label)[s].find((c) => c.classList.contains('chain-c-oi')) as HTMLElement
    expect(oiCell('76,000', 'ce').querySelector('.chain-oi-rank')?.textContent).toBe('1')
    expect(oiCell('76,200', 'ce').querySelector('.chain-oi-rank')?.textContent).toBe('2')
    expect(oiCell('76,600', 'pe').querySelector('.chain-oi-rank')?.textContent).toBe('1')
    expect(oiCell('76,400', 'pe').querySelector('.chain-oi-rank')?.textContent).toBe('2')
    expect(oiCell('76,000', 'ce').classList.contains('chain-wall-1')).toBe(true)
    // Not a wall on the other side, and the badge slot is still there, empty.
    expect(oiCell('76,000', 'pe').classList.contains('chain-wall')).toBe(false)
    expect(oiCell('76,000', 'pe').querySelector('.chain-oi-rank')?.textContent).toBe('')
  })

  test('axis helpers', () => {
    expect(niceCeil(182151)).toBe(200000)
    expect(niceCeil(230000)).toBe(250000)
    expect(niceCeil(0)).toBe(1)
    expect(compactNumber(182151)).toBe('182K')
    expect(compactNumber(1250)).toBe('1.3K')
    expect(compactNumber(950)).toBe('950')
  })
})

describe('the OI chart', () => {
  const rows: ChainRowWire[] = [
    ...ROWS,
    { strike: 76800, CE: side({ oi: null }), PE: null },
  ]
  const chart = (hot: number | null, onHot = vi.fn()): ReturnType<typeof render> =>
    render(<OiChart rows={rows} spot={76290} maxPain={76400} walls={oiWalls(rows, 76290)} hot={hot} onHot={onHot} locale="en-US" />)

  test('draws a column for every strike with OI, per side, and none where OI is missing', () => {
    const { container } = chart(null)
    const ce = [...container.querySelectorAll('.chain-bar-ce')].map((b) => Number(b.getAttribute('data-strike')))
    const pe = [...container.querySelectorAll('.chain-bar-pe')].map((b) => Number(b.getAttribute('data-strike')))
    expect(ce).toEqual([76000, 76200, 76400, 76600])
    expect(pe).toEqual([76000, 76200, 76400, 76600])
    // The walls are drawn at full strength.
    const walls = [...container.querySelectorAll('.chain-bar-wall')].map((b) => `${b.classList.contains('chain-bar-ce') ? 'ce' : 'pe'}${b.getAttribute('data-strike')}`)
    expect(walls.sort()).toEqual(['ce76000', 'ce76200', 'pe76400', 'pe76600'])
    // The index line carries its value; max pain is labelled.
    expect(screen.getByTestId('chart-spot').textContent).toContain('76,290')
    expect(container.textContent).toContain('Max pain 76,400')
  })

  test('pointing at a strike reports it, and a hot strike shows its tooltip', () => {
    const onHot = vi.fn()
    const { unmount } = chart(null, onHot)
    fireEvent.pointerEnter(screen.getByTestId('chart-slot-76400'))
    expect(onHot).toHaveBeenCalledWith(76400)
    unmount()
    chart(76400)
    const tip = screen.getByRole('status')
    expect(tip.textContent).toContain('76,400')
    expect(tip.textContent).toContain('put OI, wall 2')
  })

  test('chart and table share the hot strike, both ways', async () => {
    installFetch(({ path }) => {
      if (path === '/v1/desk/chain/BTC/expiries') return { body: { expiries: ['2026-11-06'] } }
      if (path === '/v1/desk/chain/BTC') {
        return { body: { expiry: '2026-11-06', spot: 76290, spotAsOf: Date.now(), future: null, feedAlive: true, rows: ROWS } }
      }
      return { body: {} }
    })
    render(<ChainPage />)
    const rowOf = async (label: string): Promise<HTMLElement> =>
      (await screen.findByRole('rowheader', { name: label })).closest('tr') as HTMLElement
    // Chart -> table.
    fireEvent.pointerEnter(await screen.findByTestId('chart-slot-76400'))
    expect((await rowOf('76,400')).dataset.hot).toBe('true')
    expect((await rowOf('76,200')).dataset.hot).toBe('false')
    // Table -> chart.
    fireEvent.mouseEnter(await rowOf('76,000'))
    expect((await rowOf('76,000')).dataset.hot).toBe('true')
    expect((await rowOf('76,400')).dataset.hot).toBe('false')
    expect(document.querySelector('.chain-chart-hot')).not.toBe(null)
    expect(screen.getByRole('status').textContent).toContain('76,000')
    fireEvent.mouseLeave(await rowOf('76,000'))
    expect(document.querySelector('.chain-chart-hot')).toBe(null)
  })

  test('"Hide chart" hides it and the choice is remembered', async () => {
    installFetch(({ path }) => {
      if (path === '/v1/desk/chain/BTC/expiries') return { body: { expiries: ['2026-11-06'] } }
      if (path === '/v1/desk/chain/BTC') return { body: { expiry: '2026-11-06', spot: 76290, future: null, rows: ROWS } }
      return { body: {} }
    })
    const { unmount } = render(<ChainPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Hide chart' }))
    expect(screen.queryByTestId('chart-slot-76400')).toBe(null)
    expect(window.localStorage.getItem('desk.chain.chart')).toBe('hidden')
    unmount()
    render(<ChainPage />)
    expect(await screen.findByRole('button', { name: 'Show chart' })).toBeTruthy()
    expect(screen.queryByTestId('chart-slot-76400')).toBe(null)
  })

  test('the header names the call and put OI walls', async () => {
    installFetch(({ path }) => {
      if (path === '/v1/desk/chain/BTC/expiries') return { body: { expiries: ['2026-11-06'] } }
      if (path === '/v1/desk/chain/BTC') return { body: { expiry: '2026-11-06', spot: 76290, future: null, rows: ROWS } }
      return { body: {} }
    })
    render(<ChainPage />)
    const ce = await screen.findByText('Call OI wall', { selector: 'dt' })
    expect(ce.nextElementSibling?.textContent).toBe('76,000 · 76,200')
    expect(screen.getByText('Put OI wall', { selector: 'dt' }).nextElementSibling?.textContent).toBe('76,600 · 76,400')
  })
})

describe('units and per-contract cost', () => {
  test('the per-contract cost of a quote, in USD and INR', () => {
    expect(perContractText(102.81, 0.001, 85)).toBe('$0.10 per contract · ₹8.74')
    expect(perContractText(2180.23, 0.001, 85)).toBe('$2.18 per contract · ₹185.32')
    // Sub-cent: four decimals, never "$0.00".
    expect(perContractText(0.5, 0.001, 85)).toBe('$0.0005 per contract · ₹0.04')
    expect(perContractText(null, 0.001, 85)).toBe(null)
  })

  test('the units line', () => {
    expect(unitsLine(0.001, 85)).toBe('Prices in USD per 1 BTC · 1 contract = 0.001 BTC · OI in contracts · ₹ at 85/USD')
  })

  test('the page shows the units line under the header, from Delta\'s venue spec', async () => {
    installFetch(({ path }) => {
      if (path === '/v1/desk/chain/BTC/expiries') return { body: { expiries: ['2026-11-06'] } }
      if (path === '/v1/desk/chain/BTC') return { body: { expiry: '2026-11-06', spot: 76290, future: null, lotSize: 0.001, rows: ROWS } }
      return { body: {} }
    })
    render(<ChainPage />)
    expect(await screen.findByText('Prices in USD per 1 BTC · 1 contract = 0.001 BTC · OI in contracts · ₹ at 85/USD')).toBeTruthy()
  })

  test('hovering bid, ask or mark gives the per-contract cost; other cells do not', () => {
    table([{ strike: 77200, CE: side({ bid: 100, ask: 105.5, mark: 102.81 }), PE: null }], 77180)
    const cell = (k: string): HTMLElement =>
      sides('77,200').ce.find((c) => c.classList.contains(`chain-c-${k}`)) as HTMLElement
    expect(cell('mark').title.split('\n')[0]).toBe('$0.10 per contract · ₹8.74')
    expect(cell('bid').title.split('\n')[0]).toBe('$0.10 per contract · ₹8.50')
    expect(cell('ask').title.split('\n')[0]).toBe('$0.11 per contract · ₹8.97')
    expect(cell('iv').title).not.toContain('per contract')
    // A side with no quote has no cost to show.
    const pe = sides('77,200').pe.find((c) => c.classList.contains('chain-c-mark')) as HTMLElement
    expect(pe.title).not.toContain('per contract')
  })
})
