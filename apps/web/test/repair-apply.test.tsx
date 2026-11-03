/**
 * THE APPLY MODAL — the last screen between a repair card and real orders.
 *
 * Everything asserted here is something an operator would otherwise have to
 * take on trust from a card that was searched minutes ago:
 *
 *  1. WHAT WOULD BE PLACED, order by order, in the order it goes out — closes
 *     before opens. The card says "Shift TCS 2440 PE → 2260"; the broker sees
 *     four orders, and this is the only screen that shows them.
 *  2. WHAT CANNOT BE PLACED. A dropped move, a hold on the tag, an open with no
 *     quote — each of them refuses at the bridge or halts mid-run, so each of
 *     them turns Confirm off HERE, with the sentence that says why.
 *  3. THE ID IS MINTED ONCE. `decisionId` is the idempotency, and a fresh one
 *     after a refused attempt is how a repair gets placed twice. The 409 test
 *     below asserts the retry carries the SAME id.
 *  4. THE RUN IS NOT THE ANSWER. Apply answers 202 and the waves take minutes,
 *     so the modal polls the ledger and renders what actually executed —
 *     including the halted case, which is the record the rest gets finished by
 *     hand from.
 *
 * IT STANDS IN FOR THE NETWORK, never for `./api.ts` (the rule `http.tsx`
 * states): the body this modal posts — the prints it carries, the style, the
 * password — IS the thing under test, and a suite that stubbed the wrapper
 * would assert nothing about it.
 */
import { expect, test, describe, vi } from 'vitest'
import { act, render, screen, waitFor, within, fireEvent } from '@testing-library/react'
import { RepairApplyDialog } from '../src/repair-apply.tsx'
import { AuthProvider, useReauth } from '../src/auth.tsx'
import { installFetch, type Reply, type SentRequest } from './http.tsx'
import type {
  BookMargin, BrokerMargin, DeskMode, PricedOrder, RepairMove, RepairPreflightResponse,
  RepairRunDoc, RepairRunOrder,
} from '../src/api.ts'

const TAG = 'TCS-2026-08-25-recenter-relief-r'
const BOOK_EXPIRY = '2026-08-25'
/** The card's own fingerprint of the legs its sentences address. */
const CARD_LEGS = 'legs:card'
/** The one the PREFLIGHT answers with — what the apply must carry. */
const FRESH_LEGS = 'legs:fresh'
const BOOK_PRINT = 'book:one'
const APPLY_ID = 'repair:apply:1'

/** Close one dead short, sell a new one, buy a longer-dated wing. */
const MOVES: readonly RepairMove[] = [
  { op: 'close', legId: 'TCS26AUG2660CE' },
  { op: 'add', strike: 2440, type: 'PE', qty: -350 },
  { op: 'hedge', strike: 2260, type: 'PE', qty: 175 },
]

const NFO = (tradingsymbol: string): PricedOrder['instrument'] => ({
  tradingsymbol,
  instrumentToken: 12_345,
  lotSize: 175,
  tickSize: 0.05,
  exchange: 'NFO',
})

const CLOSE: PricedOrder = {
  wave: 'close', moveIndex: 0, side: 'Buy', instrument: NFO('TCS26AUG2660CE'),
  strike: 2660, type: 'CE', expiry: BOOK_EXPIRY, lots: 1, reducesExposure: true,
  mark: 1.1,
  est: { price: 1.25, coveredQty: 3_500, exceedsDepth: false, quoteAgeMs: 1_200 },
}

const SELL: PricedOrder = {
  wave: 'open', moveIndex: 1, side: 'Sell', instrument: NFO('TCS26AUG2440PE'),
  strike: 2440, type: 'PE', expiry: BOOK_EXPIRY, lots: 2, reducesExposure: false,
  mark: 23.4,
  est: { price: 23.15, coveredQty: 1_400, exceedsDepth: false, quoteAgeMs: 900 },
}

/** The wing that is NOT in the book's own expiry — the row that must say so. */
const WING: PricedOrder = {
  wave: 'open', moveIndex: 2, side: 'Buy', instrument: NFO('TCS26SEP2260PE'),
  strike: 2260, type: 'PE', expiry: '2026-09-29', lots: 1, reducesExposure: false,
  mark: 18.05,
  est: { price: 18.4, coveredQty: 875, exceedsDepth: false, quoteAgeMs: 2_400 },
}

const BROKER: BrokerMargin = {
  total: 940_500, span: 700_000, exposure: 200_000, premiumPaid: 40_500, calibrated: true,
}

const MARGIN: RepairPreflightResponse['margin'] = {
  estimated: 812_000,
  broker: BROKER,
  warnings: [],
}

/** The same figures at the calculator's base rates — no calibration was applied. */
const UNCALIBRATED: RepairPreflightResponse['margin'] = {
  ...MARGIN,
  broker: { ...BROKER, calibrated: false },
}

/** The Books tile's own figure for the book AS IT STANDS — the Δ's other half. */
const MARGIN_NOW: BookMargin = {
  available: true, ok: true, stale: false, asOf: 1_755_000_000_000, ageMs: 40_000,
  brokerTotal: 812_500, brokerSpan: 620_000, brokerExposure: 180_000, premiumPaid: 12_500,
  calibrated: true,
}

const DELTA: RepairPreflightResponse['delta'] = {
  current: {
    all: { netDelta: -1_240, netGamma: 3.2, neutral: { price: 2_440.5, pct: 1.2 } },
    shortsOnly: { netDelta: -2_100, netGamma: 4.1, neutral: { price: 2_501.25, pct: 3.7 } },
  },
  after: {
    all: { netDelta: -120, netGamma: 2.9, neutral: { price: 2_412, pct: 0.05 } },
    // Nothing here could be priced — a dash, never a zero.
    shortsOnly: { netDelta: null, netGamma: null, neutral: null },
  },
}

function preflight(over: Partial<RepairPreflightResponse> = {}): RepairPreflightResponse {
  return {
    tag: TAG, mode: 'paper', asOf: 1_755_000_000_000,
    bookPrint: BOOK_PRINT, legsPrint: FRESH_LEGS,
    orders: [CLOSE, SELL, WING],
    dropped: [],
    margin: MARGIN,
    delta: DELTA,
    holdActive: false,
    warnings: [],
    ...over,
  }
}

const runOrder = (
  planned: PricedOrder,
  status: RepairRunOrder['status'],
  detail?: string,
): RepairRunOrder => ({
  clientOrderId: `co-${planned.instrument.tradingsymbol}`,
  wave: planned.wave,
  planned,
  status,
  ...(detail === undefined ? {} : { detail }),
})

function runDoc(
  state: RepairRunDoc['state'],
  orders: readonly RepairRunOrder[],
  haltReason?: string,
): RepairRunDoc {
  return {
    _id: APPLY_ID, tag: TAG, mode: 'paper', style: 'fast', bookPrint: BOOK_PRINT,
    state, orders, createdAt: 1_755_000_000_000, updatedAt: 1_755_000_001_000,
    ...(haltReason === undefined ? {} : { haltReason }),
  }
}

const ALL_FILLED = [
  runOrder(CLOSE, 'FILLED'), runOrder(SELL, 'FILLED'), runOrder(WING, 'FILLED'),
]

// --------------------------------------------------------------- the harness

/**
 * The page's own re-auth prompt, mounted beside the modal exactly as
 * `payoff.tsx` will mount it — the modal takes a `Reauth`, it does not make
 * one, so the live path is only real if the prompt is on screen with it.
 */
function Harness(props: {
  mode: DeskMode
  open: boolean
  flags: readonly string[]
  moves: readonly RepairMove[]
  legsPrint: string
  onClose: () => void
}): React.ReactElement {
  const reauth = useReauth()
  return (
    <>
      <RepairApplyDialog
        open={props.open}
        tag={TAG}
        mode={props.mode}
        bookExpiry={BOOK_EXPIRY}
        planLabel="reduce loss"
        planFlags={props.flags}
        moves={props.moves}
        legsPrint={props.legsPrint}
        reauth={reauth}
        onClose={props.onClose}
      />
      {reauth.dialog}
    </>
  )
}

interface Options {
  mode?: DeskMode
  open?: boolean
  flags?: readonly string[]
  onClose?: () => void
  /** Answer the nth preflight (1-based) with something other than the default. */
  preflight?: (n: number) => Reply | null
  apply?: (n: number) => Reply | null
  status?: (n: number) => Reply | null
  margin?: Reply
}

/**
 * The same mount, with the handle a plan SWAP needs: the parent may point this
 * dialog at a different plan without closing it, and that is the case the
 * `decisionId` has to survive being re-minted for.
 */
function mountWith(opts: Options = {}): {
  sent: SentRequest[]
  swap: (moves: readonly RepairMove[], legsPrint: string) => void
} {
  let pre = 0
  let app = 0
  let st = 0
  const sent = installFetch(({ path, method }) => {
    if (path === '/v1/auth/me') {
      return { body: { username: 'operator', kind: 'user', expiresAt: 4_000_000_000_000 } }
    }
    if (path === '/v1/desk/repair/preflight') {
      pre += 1
      return opts.preflight?.(pre) ?? { body: preflight() }
    }
    if (path === '/v1/desk/repair/apply' && method === 'POST') {
      app += 1
      return opts.apply?.(app) ?? { body: { accepted: true, applyId: APPLY_ID } }
    }
    if (path.startsWith('/v1/desk/repair/apply/')) {
      st += 1
      return opts.status?.(st) ?? { body: runDoc('RUNNING', [runOrder(CLOSE, 'SUBMITTED')]) }
    }
    if (path === '/v1/desk/margin') return opts.margin ?? { body: MARGIN_NOW }
    return { body: {} }
  })
  const tree = (moves: readonly RepairMove[], legsPrint: string): React.ReactElement => (
    <AuthProvider>
      <Harness
        mode={opts.mode ?? 'paper'}
        open={opts.open ?? true}
        flags={opts.flags ?? []}
        moves={moves}
        legsPrint={legsPrint}
        onClose={opts.onClose ?? ((): void => {})}
      />
    </AuthProvider>
  )
  const view = render(tree(MOVES, CARD_LEGS))
  return {
    sent,
    swap: (moves, legsPrint) => {
      act(() => { view.rerender(tree(moves, legsPrint)) })
    },
  }
}

function mount(opts: Options = {}): SentRequest[] {
  return mountWith(opts).sent
}

const preflights = (sent: readonly SentRequest[]): SentRequest[] =>
  sent.filter((r) => r.path === '/v1/desk/repair/preflight')
const applies = (sent: readonly SentRequest[]): SentRequest[] =>
  sent.filter((r) => r.path === '/v1/desk/repair/apply' && r.method === 'POST')
const statuses = (sent: readonly SentRequest[]): SentRequest[] =>
  sent.filter((r) => r.path.startsWith('/v1/desk/repair/apply/'))

/** One order's row, addressed by the sentence it renders. */
const row = (name: string): HTMLElement => screen.getByRole('group', { name })
const CLOSE_ROW = 'Buy 1 lot TCS 2660 CE'
const SELL_ROW = 'Sell 2 lots TCS 2440 PE'
const WING_ROW = 'Buy 1 lot TCS 2260 PE'

const placeButton = (): HTMLElement =>
  screen.getByRole('button', { name: /^Place \d+ order/ })

/**
 * The re-auth prompt, told apart from the modal it is stacked over — and from
 * ITSELF WHILE CLOSED. `useReauth` returns one permanently mounted dialog, so
 * its password box is in the document whether or not it is open; only the
 * `open` attribute says which. (Both dialogs answer to `role="dialog"`, which
 * is why this addresses the box rather than the role.)
 */
async function passwordPrompt(): Promise<HTMLElement> {
  return await waitFor(() => {
    const dlg = screen.getByLabelText('Password').closest('dialog')
    if (dlg === null || !dlg.hasAttribute('open')) throw new Error('the password prompt is not open')
    return dlg
  })
}

/** Whether the re-auth prompt is up at all. */
const promptIsOpen = (): boolean =>
  screen.getByLabelText('Password').closest('dialog')?.hasAttribute('open') === true

// ------------------------------------------------------------- the preview

describe('the preview', () => {
  test('opening asks the bridge what it would place — once — and lists every order', async () => {
    const sent = mount()
    await screen.findByText('TCS 2440 PE')

    // ONE preflight. It reprices the whole book and asks the broker for a
    // margin; a modal that asked twice on open would spend that twice.
    expect(preflights(sent)).toHaveLength(1)
    const asked = preflights(sent)[0]
    expect(asked?.body?.['tag']).toBe(TAG)
    expect(asked?.body?.['mode']).toBe('paper')
    expect(asked?.body?.['moves']).toEqual(MOVES)
    // The CARD's print, so a menu that has outlived its book is refused rather
    // than aimed at whatever now sits under its leg ids.
    expect(asked?.body?.['legsPrint']).toBe(CARD_LEGS)

    // THE WAVES ARE THE PLAN'S ORDER OF OPERATIONS, and each order is asserted
    // to be IN its own wave — a grouping that swapped the two would still
    // render every row, every chip and every estimate, and only this fails.
    const first = screen.getByRole('group', { name: 'Closes first' })
    const then = screen.getByRole('group', { name: 'Then opens' })
    expect(within(first).getByRole('group', { name: CLOSE_ROW })).toBeTruthy()
    expect(within(first).queryByRole('group', { name: SELL_ROW })).toBe(null)
    expect(within(then).getByRole('group', { name: SELL_ROW })).toBeTruthy()
    expect(within(then).getByRole('group', { name: WING_ROW })).toBeTruthy()
    expect(within(then).queryByRole('group', { name: CLOSE_ROW })).toBe(null)

    // The side is a chip, the contract is readable, the size is in LOTS (the
    // unit the desk's order path counts in), and the estimate is what THIS
    // size would pay rather than the last print.
    const close = row(CLOSE_ROW)
    expect(within(close).getByText('Buy')).toBeTruthy()
    expect(within(close).getByText('TCS 2660 CE')).toBeTruthy()
    expect(within(close).getByText('1 lot')).toBeTruthy()
    expect(within(close).getByText(/est 1\.25/)).toBeTruthy()

    const sell = row(SELL_ROW)
    expect(within(sell).getByText('Sell')).toBeTruthy()
    expect(within(sell).getByText('2 lots')).toBeTruthy()
    expect(within(sell).getByText(/est 23\.15/)).toBeTruthy()
  })

  test('a leg in ANOTHER expiry says which; the book’s own expiry is left unsaid', async () => {
    mount()
    await screen.findByText('TCS 2260 PE')
    // The one an operator cannot recover from reading the strike: a September
    // wing on an August book looks identical in every other column.
    expect(within(row(WING_ROW)).getByText('2026-09-29')).toBeTruthy()
    expect(within(row(CLOSE_ROW)).queryByText(BOOK_EXPIRY)).toBe(null)
  })

  test('the margin is the broker’s own figure, qualified, against what the book holds now', async () => {
    mount()
    await screen.findByText('TCS 2440 PE')
    const panel = screen.getByRole('group', { name: /margin/i })
    // The broker's figure for the book this plan would LEAVE...
    expect(within(panel).getByText('9,40,500')).toBeTruthy()
    // ...this desk's own SPAN-lite beside it, never reconciled into one number...
    expect(within(panel).getByText('8,12,000')).toBeTruthy()
    // ...the DERIVATION, which is what makes it the same figure the Books tile
    // shows rather than a second definition of margin...
    expect(within(panel).getByText(/span 7,00,000 \+ exposure 2,00,000 \+ premium paid 40,500/)).toBeTruthy()
    // ...the rates it is at, switched on `calibrated` rather than claimed...
    expect(within(panel).getByText(/calibrated rates/)).toBeTruthy()
    // ...and the difference against what the broker holds for the book NOW,
    // with the age of that figure, which is the number the operator decides on.
    expect(within(panel).getByText(/\+1,28,000/)).toBeTruthy()
    expect(within(panel).getByText(/priced 40s ago/)).toBeTruthy()
  })

  test('an UNCALIBRATED broker figure says so — a calibration is never claimed', async () => {
    mount({
      preflight: () => ({
        body: preflight({
          margin: UNCALIBRATED,
        }),
      }),
    })
    await screen.findByText('TCS 2440 PE')
    const panel = screen.getByRole('group', { name: /margin/i })
    expect(within(panel).getByText(/at the calculator’s base rates \(no calibration available\)/)).toBeTruthy()
  })

  /**
   * TWO FIGURES AT DIFFERENT RATES ARE NOT SUBTRACTABLE. A calibrated figure
   * against an uncalibrated one differs by the multiplier alone, so the
   * "difference" would be a change that never happened.
   */
  test('mismatched calibrations show BOTH figures and no difference', async () => {
    mount({
      preflight: () => ({
        body: preflight({
          margin: UNCALIBRATED,
        }),
      }),
      // ...against a tile figure that IS calibrated.
      margin: { body: MARGIN_NOW },
    })
    await screen.findByText('TCS 2440 PE')
    const panel = screen.getByRole('group', { name: /margin/i })
    expect(within(panel).getByText('8,12,500')).toBeTruthy()
    expect(within(panel).getByText(/No difference is shown/)).toBeTruthy()
    expect(within(panel).queryByText(/\+1,28,000/)).toBe(null)
  })

  test('two UNCALIBRATED figures still subtract — the guard is on the mismatch', async () => {
    mount({
      preflight: () => ({
        body: preflight({
          margin: UNCALIBRATED,
        }),
      }),
      margin: { body: { ...MARGIN_NOW, calibrated: false } },
    })
    await screen.findByText('TCS 2440 PE')
    expect(within(screen.getByRole('group', { name: /margin/i })).getByText(/\+1,28,000/)).toBeTruthy()
  })

  test('a STALE tile figure, and a FAILED refresh, are the same fact and both say so', async () => {
    mount({ margin: { body: { ...MARGIN_NOW, stale: true, ageMs: 3_600_000 } } })
    await screen.findByText('TCS 2440 PE')
    const panel = screen.getByRole('group', { name: /margin/i })
    expect(within(panel).getByText(/priced 60m ago, and that refresh is stale or failed/)).toBeTruthy()
  })

  test('a tile whose LAST REFRESH FAILED is flagged exactly like a stale one', async () => {
    // `ok: false` means the figures are the last good ones — the margin tile
    // (`pages.tsx`) treats it and `stale` alike, and so does this.
    mount({ margin: { body: { ...MARGIN_NOW, ok: false } } })
    await screen.findByText('TCS 2440 PE')
    expect(within(screen.getByRole('group', { name: /margin/i }))
      .getByText(/stale or failed/)).toBeTruthy()
  })

  test('a book with no priced figure yet shows no difference at all', async () => {
    mount({ margin: { body: { available: false, reason: 'no margin figure for this book yet' } } })
    await screen.findByText('TCS 2440 PE')
    const panel = screen.getByRole('group', { name: /margin/i })
    expect(within(panel).getByText(/has not been priced yet/)).toBeTruthy()
    expect(within(panel).queryByText(/\+1,28,000/)).toBe(null)
  })

  test('no broker figure falls back to the estimate, and says the check was not made', async () => {
    mount({
      preflight: () => ({
        body: preflight({
          margin: {
            estimated: 812_000,
            broker: null,
            warnings: ['TCS26SEP2260PE: the instrument master lists no contract for it'],
          },
        }),
      }),
    })
    await screen.findByText('TCS 2440 PE')
    const panel = screen.getByRole('group', { name: /margin/i })
    expect(within(panel).getByText('8,12,000')).toBeTruthy()
    expect(within(panel).getByText(/not verified/i)).toBeTruthy()
    // The bridge's own sentence, verbatim — it names the contract to go and look at.
    expect(within(panel).getByText(/lists no contract for it/)).toBeTruthy()
  })

  test('the delta panel is 2×2, and a figure nothing could be priced from is a dash', async () => {
    mount()
    await screen.findByText('TCS 2440 PE')

    // Δ0 as the price it happens at AND how far that is — a price with no
    // distance is a number nobody can size against.
    expect(within(screen.getByRole('group', { name: 'all legs now' }))
      .getByText('2,440.50 (+1.20%)')).toBeTruthy()
    expect(within(screen.getByRole('group', { name: 'all legs after' }))
      .getByText('2,412.00 (+0.05%)')).toBeTruthy()
    expect(within(screen.getByRole('group', { name: 'shorts only now' }))
      .getByText('2,501.25 (+3.70%)')).toBeTruthy()
    // NOTHING PRICED IS A DASH, NEVER A ZERO: a 0 on a delta panel reads as
    // "flat, no action needed" at the moment the risk is least known.
    const blank = screen.getByRole('group', { name: 'shorts only after' })
    expect(within(blank).getByText('—')).toBeTruthy()
  })

  test('`bot-may-reshift` is restated as the warning it is', async () => {
    mount({ flags: ['bot-may-reshift'] })
    await screen.findByText('TCS 2440 PE')
    expect(screen.getByText(/the bot may re-shift these legs once the hold lifts/)).toBeTruthy()
  })

  /**
   * `degrades-floor` IS THE FLAG THAT CONTRADICTS THE CARD BEHIND IT — the plan
   * leaves the book worse at the bottom than doing nothing does. A chip reading
   * `degrades-floor` on the last screen before real orders is a word, not a
   * warning, so it is spelled out here.
   */
  test('`degrades-floor` is spelled out, not left as a chip', async () => {
    mount({ flags: ['degrades-floor'] })
    await screen.findByText('TCS 2440 PE')
    expect(screen.getByText(/leaves the book WORSE at its floor than doing nothing/)).toBeTruthy()
  })

  test('the style starts at fast, and the chosen one is sent', async () => {
    const sent = mount()
    await screen.findByText('TCS 2440 PE')
    const picker = screen.getByRole('combobox', { name: 'Order style' })
    expect(picker.textContent).toMatch(/Fast/)

    act(() => { picker.click() })
    act(() => { screen.getByRole('option', { name: /Limit/ }).click() })
    act(() => { placeButton().click() })

    await waitFor(() => expect(applies(sent)).toHaveLength(1))
    expect(applies(sent)[0]?.body?.['style']).toBe('limit')
  })
})

// -------------------------------------------------------- what holds it shut

describe('what holds Confirm shut', () => {
  test('a dropped move disables it and names the move', async () => {
    mount({
      preflight: () => ({
        body: preflight({
          dropped: ['Close TCS26AUG2660CE: the book holds no size on it — dropped'],
        }),
      }),
    })
    await screen.findByText('TCS 2440 PE')
    expect(screen.getByText(/the book holds no size on it/)).toBeTruthy()
    expect(placeButton().hasAttribute('disabled')).toBe(true)
  })

  test('a drop that names a CHANGED BOOK says to search again', async () => {
    mount({
      preflight: () => ({
        body: preflight({
          dropped: [
            'Close TCS26AUG2660CE: the book has changed since this menu was drawn — search ' +
            'again rather than aiming this sentence at whatever now sits under its leg id',
          ],
        }),
      }),
    })
    await screen.findByText('TCS 2440 PE')
    // Not a paraphrase of the bridge's sentence — the NEXT STEP, said in the
    // modal's own voice, because "search again" is a button on the panel behind it.
    expect(screen.getByText(/Close this and run the repair search again/)).toBeTruthy()
    expect(placeButton().hasAttribute('disabled')).toBe(true)
  })

  test('a hold on the tag disables it and says another run owns the book', async () => {
    mount({ preflight: () => ({ body: preflight({ holdActive: true }) }) })
    await screen.findByText('TCS 2440 PE')
    expect(screen.getByText(/another repair still owns this tag/)).toBeTruthy()
    expect(placeButton().hasAttribute('disabled')).toBe(true)
  })

  test('an OPEN with no quote at all disables it — the run would only halt there', async () => {
    mount({
      preflight: () => ({ body: preflight({ orders: [CLOSE, { ...SELL, mark: null, est: null }] }) }),
    })
    await screen.findByText('TCS 2440 PE')
    expect(within(row(SELL_ROW)).getByText(/no quote/)).toBeTruthy()
    expect(screen.getByText(/TCS26AUG2440PE/)).toBeTruthy()
    expect(placeButton().hasAttribute('disabled')).toBe(true)
  })

  test('a CLOSE with no quote does not — an exit is still worth attempting', async () => {
    mount({
      preflight: () => ({ body: preflight({ orders: [{ ...CLOSE, mark: null, est: null }, SELL] }) }),
    })
    await screen.findByText('TCS 2440 PE')
    expect(placeButton().hasAttribute('disabled')).toBe(false)
  })

  test('nothing is placeable while the preflight is still in flight', async () => {
    // A fetch that never answers: the state between opening the modal and
    // learning what it would place is a state Confirm must be OFF in.
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      const url = new URL(String(input))
      if (url.pathname === '/v1/auth/me') {
        return {
          ok: true, status: 200, statusText: '200',
          json: async () => ({ username: 'operator', kind: 'user', expiresAt: 4_000_000_000_000 }),
        } as unknown as Response
      }
      return await new Promise<Response>(() => {})
    }))
    render(
      <AuthProvider>
        <Harness
          mode="paper"
          open
          flags={[]}
          moves={MOVES}
          legsPrint={CARD_LEGS}
          onClose={(): void => {}}
        />
      </AuthProvider>,
    )
    await act(async () => { await Promise.resolve() })
    expect(placeButton().hasAttribute('disabled')).toBe(true)
    expect(screen.getByText(/Reading the book/)).toBeTruthy()
  })

  test('a closed dialog asks nothing at all', async () => {
    const sent = mount({ open: false })
    await act(async () => { await Promise.resolve() })
    expect(preflights(sent)).toHaveLength(0)
  })
})

// ------------------------------------------------------------- the placing

describe('placing', () => {
  test('paper: Confirm posts the plan, the PREFLIGHT’s prints, and no password', async () => {
    const sent = mount()
    await screen.findByText('TCS 2440 PE')
    expect(applies(sent)).toHaveLength(0)

    act(() => { placeButton().click() })
    await waitFor(() => expect(applies(sent)).toHaveLength(1))

    const body = applies(sent)[0]?.body ?? {}
    expect(body['tag']).toBe(TAG)
    expect(body['mode']).toBe('paper')
    expect(body['moves']).toEqual(MOVES)
    expect(body['style']).toBe('fast')
    // THE PRINT COMES OFF THE PREFLIGHT, never off the card: the card's copy is
    // what the preview was asked WITH, and the answer is what it was computed
    // AGAINST.
    expect(body['legsPrint']).toBe(FRESH_LEGS)
    // And `bookPrint` is NOT sent. It hashes every live quote, so a staleness
    // guard keyed on it would refuse the Confirm of anyone who paused to read
    // this modal.
    expect(body).not.toHaveProperty('bookPrint')
    expect(String(body['decisionId'] ?? '')).toMatch(new RegExp(`^repair:${TAG}:paper:\\d+$`))
    // Paper cannot move money, so nothing is asked for and nothing is sent.
    expect(body).not.toHaveProperty('password')
    expect(promptIsOpen()).toBe(false)
  })

  test('live: it prompts FIRST, names what it is about to do, and carries the password', async () => {
    const sent = mount({ mode: 'live' })
    await screen.findByText('TCS 2440 PE')
    act(() => { placeButton().click() })

    const prompt = await passwordPrompt()
    // NOTHING IS SENT BEFORE THE PASSWORD. This is the assertion the live rail
    // rests on.
    expect(applies(sent)).toHaveLength(0)
    // The statement names the book, how many real orders, and what the book it
    // leaves would cost to hold — not "are you sure?".
    expect(within(prompt).getByText(new RegExp(TAG))).toBeTruthy()
    expect(within(prompt).getByText(/3 repair orders/)).toBeTruthy()
    expect(within(prompt).getByText(/9,40,500/)).toBeTruthy()

    fireEvent.change(within(prompt).getByLabelText('Password'), { target: { value: 'hunter2' } })
    act(() => { within(prompt).getByRole('button', { name: 'Confirm' }).click() })

    await waitFor(() => expect(applies(sent)).toHaveLength(1))
    expect(applies(sent)[0]?.body?.['password']).toBe('hunter2')
    expect(applies(sent)[0]?.body?.['mode']).toBe('live')
  })

  test('cancelling the live prompt places nothing', async () => {
    const sent = mount({ mode: 'live' })
    await screen.findByText('TCS 2440 PE')
    act(() => { placeButton().click() })
    const prompt = await passwordPrompt()
    act(() => { within(prompt).getByRole('button', { name: 'Cancel' }).click() })
    await act(async () => { await Promise.resolve() })
    expect(applies(sent)).toHaveLength(0)
  })

  test('a REFUSED plan keeps the preview and shows the bridge’s reason verbatim', async () => {
    const reason =
      'Close TCS26AUG2660CE: the book holds no size on it — dropped'
    const sent = mount({ apply: () => ({ body: { accepted: false, reason } }) })
    await screen.findByText('TCS 2440 PE')
    act(() => { placeButton().click() })

    await screen.findByText(new RegExp('the book holds no size on it'))
    // Still the preview: nothing was placed, so there is no run to watch.
    expect(statuses(sent)).toHaveLength(0)
    expect(screen.getByText(/Closes first/)).toBeTruthy()
  })

  /**
   * "NOT PLACED" IS A CLAIM ONLY AN ANSWER CAN SUPPORT.
   *
   * A 5xx (or a timeout, or a dropped socket) is the desk NOT having said what
   * happened — the run may be executing. Reporting that as a failure is what
   * talks an operator into pressing again on a fresh id, which is two repairs.
   */
  test('a transport failure says the outcome is UNKNOWN, and the retry re-claims the same run', async () => {
    const sent = mount({ apply: (n) => (n === 1 ? { status: 500, body: { error: 'bridge exploded' } } : null) })
    await screen.findByText('TCS 2440 PE')
    act(() => { placeButton().click() })

    await screen.findByText('Not confirmed')
    expect(screen.getByText(/re-claims the SAME run/)).toBeTruthy()
    // No run is being watched: nothing has answered with an id to watch.
    expect(statuses(sent)).toHaveLength(0)

    act(() => { placeButton().click() })
    await waitFor(() => expect(applies(sent)).toHaveLength(2))
    expect(applies(sent)[1]?.body?.['decisionId']).toBe(applies(sent)[0]?.body?.['decisionId'])
  })

  /**
   * LEGS THAT MOVED ARE NOT AN ERROR TO SHOW, they are a preview to redraw —
   * the 409 placed nothing, and the sentences on screen no longer address what
   * the operator thinks they do.
   *
   * AND THE SAME `decisionId`. A refused apply spent nothing, so re-minting one
   * is the single mistake this endpoint cannot protect anyone from: two ids for
   * one intent is two repairs.
   */
  test('a 409 re-previews silently, and the retry carries the SAME decisionId', async () => {
    const sent = mount({
      preflight: (n) => (n === 1 ? null : { body: preflight({ legsPrint: 'legs:two' }) }),
      // The route's own 409 body, verbatim: the CODE is still `book-changed`
      // even though what it compares is the legs.
      apply: (n) => (n === 1 ? { status: 409, body: { error: 'book-changed', detail: 'a leg has been resized' } } : null),
    })
    await screen.findByText('TCS 2440 PE')
    act(() => { placeButton().click() })

    // The book moved: the modal asks again rather than reporting a code.
    await waitFor(() => expect(preflights(sent)).toHaveLength(2))
    expect(statuses(sent)).toHaveLength(0)
    // ...and says so, because a press whose only effect is invisible reads as a
    // dead button.
    await screen.findByText(/the preview below was re-read/)

    act(() => { placeButton().click() })
    await waitFor(() => expect(applies(sent)).toHaveLength(2))
    const first = applies(sent)[0]?.body ?? {}
    const second = applies(sent)[1]?.body ?? {}
    expect(second['decisionId']).toBe(first['decisionId'])
    // The FRESH print, from the preflight that answered second.
    expect(first['legsPrint']).toBe(FRESH_LEGS)
    expect(second['legsPrint']).toBe('legs:two')
  })
})

// ----------------------------------------------------------------- the run

describe('the run', () => {
  test('an accepted apply watches the ledger and shows a chip per order', async () => {
    const sent = mount({
      status: () => ({
        body: runDoc('RUNNING', [
          runOrder(CLOSE, 'FILLED'),
          runOrder(SELL, 'SUBMITTED'),
          runOrder(WING, 'QUEUED'),
        ]),
      }),
    })
    await screen.findByText('TCS 2440 PE')
    act(() => { placeButton().click() })

    await waitFor(() => expect(statuses(sent)).toHaveLength(1))
    expect(statuses(sent)[0]?.path).toBe(`/v1/desk/repair/apply/${encodeURIComponent(APPLY_ID)}`)

    await screen.findByText('FILLED')
    expect(within(row(SELL_ROW)).getByText('SUBMITTED')).toBeTruthy()
    expect(within(row(WING_ROW)).getByText('QUEUED')).toBeTruthy()
    // A run outlives this dialog, and the button says so rather than implying
    // that closing stops it...
    expect(screen.getByRole('button', { name: /run continues/ })).toBeTruthy()
    // ...WITH THE HALF THAT COSTS SOMETHING: there is no re-attach, so closing
    // this view really does lose it, and the operator is told where the fills
    // show up instead. An affordance that says only the reassuring half is how
    // somebody closes a window they wanted to keep.
    expect(screen.getByText(/cannot be reopened for this run/)).toBeTruthy()
    expect(screen.getByText(/order log/)).toBeTruthy()
  })

  test('HALTED says why, and what DID execute', async () => {
    const halt =
      'no quote for TCS26SEP2260PE — the open wave is halted before Buy 1 lot was placed'
    mount({
      status: () => ({
        body: runDoc(
          'HALTED',
          [
            runOrder(CLOSE, 'FILLED'),
            runOrder(SELL, 'FILLED'),
            runOrder(WING, 'FAILED', 'no quote to price it off'),
          ],
          halt,
        ),
      }),
    })
    await screen.findByText('TCS 2440 PE')
    act(() => { placeButton().click() })

    await screen.findByText(new RegExp('the open wave is halted'))
    // The record the rest gets finished by hand from: how much of the plan is
    // actually in the book.
    expect(screen.getByText(/2 of 3 orders filled/)).toBeTruthy()
    // The rail's own sentence on the order that did not go.
    expect(within(row(WING_ROW)).getByText(/no quote to price it off/)).toBeTruthy()
  })

  test('DONE says every order filled', async () => {
    mount({ status: () => ({ body: runDoc('DONE', ALL_FILLED) }) })
    await screen.findByText('TCS 2440 PE')
    act(() => { placeButton().click() })
    await screen.findByText('All filled')
  })

  test('the ledger is polled while the run is live, and the poll stops when it is not', async () => {
    vi.useFakeTimers()
    try {
      const sent = mount({
        status: (n) => ({
          body: n < 3
            ? runDoc('RUNNING', [runOrder(CLOSE, 'FILLED'), runOrder(SELL, 'SUBMITTED')])
            : runDoc('DONE', ALL_FILLED),
        }),
      })
      // No findBy* under fake timers: RTL's waitFor cannot drive vitest's
      // clock, so every wait here is an explicit advance (the payoff suite's
      // own rule).
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      act(() => { placeButton().click() })
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      expect(statuses(sent)).toHaveLength(1)

      await act(async () => { await vi.advanceTimersByTimeAsync(2_000) })
      expect(statuses(sent)).toHaveLength(2)
      await act(async () => { await vi.advanceTimersByTimeAsync(2_000) })
      expect(statuses(sent)).toHaveLength(3)

      // The third answered DONE. A finished run is not polled for ten minutes
      // because a modal was left open on it.
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
      expect(statuses(sent)).toHaveLength(3)
      expect(screen.getByText('All filled')).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })

  /**
   * A HALT SETTLES THE RUN TOO. It is the state a modal is most likely to be
   * left open on — the operator is reading it to work out what to finish by
   * hand — and it is the one where a poll that kept running would keep running
   * for as long as they read.
   */
  test('a HALTED run stops the poll, and its record stays on screen', async () => {
    vi.useFakeTimers()
    try {
      const sent = mount({
        status: (n) => ({
          body: n < 2
            ? runDoc('RUNNING', [runOrder(CLOSE, 'FILLED'), runOrder(SELL, 'SUBMITTED')])
            : runDoc(
                'HALTED',
                [runOrder(CLOSE, 'FILLED'), runOrder(SELL, 'FAILED', 'no quote to price it off')],
                'no quote for TCS26AUG2440PE — the open wave is halted',
              ),
        }),
      })
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      act(() => { placeButton().click() })
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      expect(statuses(sent)).toHaveLength(1)

      await act(async () => { await vi.advanceTimersByTimeAsync(2_000) })
      expect(statuses(sent)).toHaveLength(2)

      await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
      expect(statuses(sent)).toHaveLength(2)
      // The record survives the poll standing down — it is what the rest gets
      // finished by hand from.
      expect(screen.getByText(/the open wave is halted/)).toBeTruthy()
      expect(screen.getByText(/1 of 2 orders filled/)).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })
})

// ------------------------------------------------------- one plan at a time

/**
 * THE `decisionId` BELONGS TO THE PLAN, NOT TO THE DIALOG.
 *
 * The parent may point this modal at a different plan without closing it. Keyed
 * only on [open, tag, mode] the id survived that swap — and with an unconfirmed
 * attempt behind it, plan B's Place re-claimed plan A's RUN: the server answers
 * 202 with A's `applyId` (same tag, same mode — its owner check cannot see the
 * difference), and the modal reports B as placed while watching A execute.
 */
describe('a plan swap re-arms everything', () => {
  const OTHER: readonly RepairMove[] = [{ op: 'close', legId: 'TCS26AUG2440PE' }]

  test('swapping the plan re-mints the decisionId and clears the attempt behind it', async () => {
    const { sent, swap } = mountWith({
      apply: (n) => (n === 1 ? { status: 500, body: { error: 'no answer' } } : null),
    })
    await screen.findByText('TCS 2440 PE')
    act(() => { placeButton().click() })
    // An attempt whose outcome nobody knows — the state that made this dangerous.
    await screen.findByText('Not confirmed')
    const firstId = applies(sent)[0]?.body?.['decisionId']

    swap(OTHER, 'legs:other')
    // The plan is re-previewed, and the previous attempt's banner is gone with it.
    await waitFor(() => expect(preflights(sent)).toHaveLength(2))
    expect(preflights(sent)[1]?.body?.['moves']).toEqual(OTHER)
    expect(preflights(sent)[1]?.body?.['legsPrint']).toBe('legs:other')
    await waitFor(() => expect(screen.queryByText('Not confirmed')).toBe(null))

    act(() => { placeButton().click() })
    await waitFor(() => expect(applies(sent)).toHaveLength(2))
    // A DIFFERENT ID. Same tag, same mode — nothing the server can tell apart,
    // which is exactly why this is the client's job. And different EVEN IF both
    // mints land in the same millisecond, which is why the stamp is monotonic
    // rather than a bare `Date.now()`.
    expect(applies(sent)[1]?.body?.['decisionId']).not.toBe(firstId)
    expect(String(applies(sent)[1]?.body?.['decisionId'] ?? ''))
      .toMatch(new RegExp(`^repair:${TAG}:paper:\\d+$`))
    expect(applies(sent)[1]?.body?.['moves']).toEqual(OTHER)
  })

  /**
   * ...BUT THE BOOK'S OWN MARGIN FIGURE IS NOT THE PLAN'S TO CLEAR.
   *
   * `/v1/desk/margin` describes the BOOK — one document for every card on one
   * tag — and it is read per tag. Clearing it on a plan swap (which the first
   * fix did) left it null with nothing to refill it, and the difference
   * sentence then read "not priced yet" for the rest of the session: a figure
   * silently withdrawn on the last screen before real orders.
   */
  test('a same-tag plan swap keeps the book’s own margin figure', async () => {
    const { sent, swap } = mountWith()
    await screen.findByText('TCS 2440 PE')
    expect(within(screen.getByRole('group', { name: /margin/i })).getByText(/\+1,28,000/)).toBeTruthy()

    swap(OTHER, 'legs:other')
    await waitFor(() => expect(preflights(sent)).toHaveLength(2))

    // The difference is still there once the new preview lands — not
    // "has not been priced yet".
    const panel = await waitFor(() => screen.getByRole('group', { name: /margin/i }))
    await waitFor(() => expect(within(panel).queryByText(/has not been priced yet/)).toBe(null))
    expect(within(panel).getByText(/\+1,28,000/)).toBeTruthy()
    // And it was not re-read: one read per BOOK, not one per plan.
    expect(sent.filter((r) => r.path === '/v1/desk/margin')).toHaveLength(1)
  })
})
