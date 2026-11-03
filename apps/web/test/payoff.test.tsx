/**
 * THE PAYOFF PANEL — what the book is worth, and what the bot is about to do.
 *
 * The bridge answers this endpoint with TWO independently nullable halves
 * (`view` and `machine`) and TWO warning channels, and every assertion here is
 * about one of those seams:
 *
 *   · the summary figure an operator sizes against (`floor`) reaches the screen
 *   · the machine card's sentences, VERBATIM, because `machine.ts` writes them
 *     to be rendered as they are
 *   · BOTH warning lists, merged and deduped — `payoffOf` in `routes/payoff.ts`
 *     deliberately does NOT fold `view.warnings` into the envelope's, so a panel
 *     that reads one of them silently drops the per-leg "no IV" sentences
 *   · a `view: null` answer renders the reason instead of a chart, and does not
 *     throw — a book whose future is not printing is a NORMAL state to draw
 *
 * ── AND THE FOLD, WHICH IS A LOAD DECISION AS MUCH AS A LAYOUT ONE ──────────
 *
 * The panel ships CLOSED and its body is unmounted while it is, so the 60s poll
 * — a chain solve, a 121-point scan on three dates and a realised-journal read
 * per tick — does not run for a curve nobody has opened. Nearly every test here
 * opens it first (`mount` does it for them); the ones that assert the fold
 * itself are at the bottom of the file, and they are the ones that would notice
 * a body which merely hides.
 *
 * IT STANDS IN FOR THE NETWORK, not for `api.payoff` — the same rule `http.tsx`
 * states. The URL the client builds (tag encoded, mode carried) is part of what
 * is under test here, and a suite that stubbed the wrapper would assert nothing
 * about it.
 *
 * ── AND THE WRITE-SHAPED ENDPOINTS UNDER IT ─────────────────────────────────
 *
 * The second half of this file covers the what-if overlay and the repair menu.
 * The menu's Apply button DOES reach real orders now, and every gate in front
 * of it lives one layer down in `RepairApplyDialog` (asserted in
 * `repair-apply.test.tsx`). What this file asserts about it is the CARD's half:
 * that the button is there, that it is held shut for the four states no
 * preflight could rescue, and that only one plan at a time may open it.
 *
 * The rest is the arithmetic that would mislead if it were wrong: the SIDE a
 * proposed leg is sent with, the LOTS-to-shares multiplication, and the moves a
 * plan carries that the what-if editor cannot express.
 */
import { beforeAll, expect, test, describe, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { PayoffPanel } from '../src/payoff.tsx'
import { AuthProvider } from '../src/auth.tsx'
import { installFetch, type SentRequest } from './http.tsx'

/**
 * A CHART THAT IS NEVER MEASURED IS NEVER DRAWN.
 *
 * `ResponsiveContainer` sizes itself from a `ResizeObserver`, which jsdom does
 * not implement at all — so without this the plot renders as an empty box and
 * every assertion about the curves would pass by describing nothing. The stub
 * answers with one fixed size, immediately, which is all the container needs to
 * lay the axes out and put the series into the legend.
 *
 * Local to this suite rather than in `setup.tsx`: it is not a browser fact the
 * other suites depend on, and a global stub that reports a viewport to every
 * test is the kind of environment lie that makes an unrelated failure baffling.
 */
beforeAll(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(private readonly cb: ResizeObserverCallback) {}
      observe(target: Element): void {
        this.cb(
          [{ target, contentRect: { width: 900, height: 300 } } as unknown as ResizeObserverEntry],
          this as unknown as ResizeObserver,
        )
      }
      unobserve(): void {}
      disconnect(): void {}
    },
  )
})

/** A per-leg sentence, which only ever arrives on `view.warnings`. */
const VIEW_WARNING = 'leg "BHEL26AUG445CE": no IV; it marks flat until expiry'
/** A book-level sentence, which only ever arrives on the envelope's. */
const RESPONSE_WARNING = 'the feed is not ticking: every price below is the last one seen, not a live one'
const NOTE_ARMED =
  'delta rebalance armed: the zero-delta point is 4.6% of spot out, past the 2% tolerance — ' +
  'the bot sheds by selling CE'

const VIEW = {
  curve: [
    { price: 400.5, expiry: -73250, t0: -41200, mid: -56000 },
    { price: 445, expiry: 18400, t0: 9100, mid: 13600 },
    { price: 489.5, expiry: -52100, t0: -30400, mid: -41000 },
  ],
  table: [
    { price: 400.5, label: '-10%', expiry: -73250, t0: -41200, mid: -56000 },
    { price: 421.4, label: 'BE 421.4', expiry: 0, t0: 5200, mid: 2600 },
    { price: 445, label: 'spot', expiry: 18400, t0: 9100, mid: 13600 },
    { price: 470, label: 'strike 470', expiry: -1500, t0: -900, mid: -1200 },
  ],
  midDate: '2026-08-25',
  summary: {
    maxProfit: 18400,
    maxLoss: -73250,
    maxLossAt: 400.5,
    breakevens: { down: 421.4, up: 452.75 },
    pop: 0.6412,
    netCredit: 21500,
    worstShock: -31200,
    worstShockAt: 436.7,
    floor: -73250,
    booked: 4200,
    targetPnl: 150000,
  },
  greeks: { delta: -412.5, gamma: -3.8, theta: 1240, vega: -880 },
  warnings: [VIEW_WARNING],
}

const MACHINE = {
  deltaTolPct: 0.02,
  deltaImbalance: 0.0458,
  wouldRebalance: true,
  // Unknown, NOT shut — the pair this panel must never render as a `0`/`no`.
  shiftEnabled: null,
  marginFrac: null,
  targetPnl: 150000,
  notes: [NOTE_ARMED, 'margin unknown — cannot say whether the 60% shift gate is open'],
}

const PAYOFF = {
  tag: 'BHEL_RELIEF',
  mode: 'paper',
  symbol: 'BHEL',
  expiry: '2026-08-27',
  future: 445,
  spot: 444.2,
  asOf: 1_755_600_000_000,
  view: VIEW,
  machine: MACHINE,
  ivs: [],
  warnings: [RESPONSE_WARNING],
}

/**
 * OPEN THE FOLD. The panel is one collapsed row until somebody asks for it, and
 * everything this file is about lives inside. One helper rather than a line in
 * fifty tests: what is being tested is what the panel SAYS, and the press that
 * gets there is scaffolding.
 *
 * The trigger's accessible name grows a teaser once a payoff has landed, so it
 * is matched loosely rather than pinned to the bare title.
 */
function openPanel(): void {
  fireEvent.click(screen.getByRole('button', { name: /Payoff & repair/ }))
}

/**
 * Mount the panel and unfold it — what every test below starts from.
 *
 * INSIDE AN `AuthProvider`, because the panel owns the re-auth prompt the Apply
 * modal asks a live book's password through (`useReauth`, the same source the
 * Manual Order dialog on this page uses). Without it the hook throws on mount
 * and every test in this file fails for a reason that is nothing to do with the
 * curve it was written about.
 */
function renderPanel(): void {
  render(
    <AuthProvider>
      <PayoffPanel tag="BHEL_RELIEF" mode="paper" />
    </AuthProvider>,
  )
  openPanel()
}

/**
 * The machine card has a fold of its own, closed by default, and its body is
 * not in the document until it is opened — so a `getByText` for one of its
 * sentences really is asking whether it was revealed.
 */
async function openMachine(): Promise<void> {
  fireEvent.click(await screen.findByRole('button', { name: 'Machine mind' }))
}

function mount(body: unknown): SentRequest[] {
  const sent = installFetch(({ path }) =>
    path === '/v1/desk/payoff' ? { body } : { body: {} },
  )
  renderPanel()
  return sent
}

describe('the payoff panel', () => {
  test('asks the bridge for this book, on this rail', async () => {
    const sent = mount(PAYOFF)
    await screen.findByText('Floor')
    const asked = sent.find((r) => r.path === '/v1/desk/payoff')
    expect(asked?.url).toContain('tag=BHEL_RELIEF')
    expect(asked?.url).toContain('mode=paper')
  })

  test('one read a minute — never the five-second cadence of the page above', async () => {
    /*
      THE CADENCE IS A LOAD DECISION, not a taste one. Every successful GET here
      solves the whole chain's implied vols, prices 121 points on three dates and
      files a snapshot; at the positions page's 5s that is twelve times the work
      per minute, per open tab, for a curve that moves with the future.
    */
    vi.useFakeTimers()
    try {
      const sent = mount(PAYOFF)
      const reads = (): number => sent.filter((r) => r.path === '/v1/desk/payoff').length
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      expect(reads()).toBe(1)
      // Half a minute in, a 5s poll would have asked six times.
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
      expect(reads()).toBe(1)
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
      expect(reads()).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })

  test('before the first answer it claims nothing about the book', () => {
    // A hung bridge, which is the state this panel spends an outage in.
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
    renderPanel()
    expect(screen.getByText(/Reading this book/)).toBeTruthy()
    // "The machine card could not be read" under a loading panel is a failure
    // asserted about a book nothing has been said about yet.
    expect(screen.queryByText(/machine card could not be read/)).toBe(null)
    expect(screen.queryByText('Machine mind')).toBe(null)
  })

  test('the floor an operator sizes against is on the screen, over the scan it came from', async () => {
    mount(PAYOFF)
    /*
      SCOPED TO ITS OWN CELL. The floor is the minimum of the expiry curve, so
      the same figure can legitimately appear again elsewhere on the panel — an
      unscoped lookup would match two elements and fail for a reason that says
      nothing about the tile. `money`'s Indian grouping, signed: a floor is a
      loss and reads as one.
    */
    const cell = await theCell('Floor')
    expect(cell.textContent).toContain('-73,250')
    // THE CAVEAT TRAVELS WITH THE FIGURE. `view.ts` is emphatic that this is the
    // worst point ON THE ±10% SCAN and not a bound on the position.
    expect(screen.getByText(/Floor and max loss are the worst point over the\s+±10% scan/)).toBeTruthy()
  })

  test('POP is labelled as the OPEN LEGS\' probability', async () => {
    mount(PAYOFF)
    // Not the run's: `view.ts` computes it on the unshifted expiry column, so a
    // book carrying a realised profit has a POP that ignores it.
    expect(await screen.findByText('POP (open legs)')).toBeTruthy()
    expect(screen.getByText('64.12%')).toBeTruthy()
  })

  test('all three dated curves are drawn, each named by the date it answers for', async () => {
    mount(PAYOFF)
    // The legend is the only place the reader learns which line is which — and
    // the two marked curves carry their DATES, because "T+0" and "mid" mean
    // nothing beside a chart drawn on a Tuesday for an August expiry.
    expect(await screen.findByText('Expiry 2026-08-27')).toBeTruthy()
    expect(screen.getByText('T+0 (today)')).toBeTruthy()
    expect(screen.getByText('Midway 2026-08-25')).toBeTruthy()
    // The price the whole scan is built around — the FUTURE, not cash spot:
    // every option here is marked Black-76 off it.
    expect(screen.getByText('future')).toBeTruthy()
  })

  test('a legend entry is a real toggle: click hides its line, click again restores', async () => {
    /*
      THE LEGEND IS THE SWITCHBOARD. Four curves share one plot and the question
      an operator brings is usually about one of them; each legend entry is a
      real BUTTON (keyboard, `aria-pressed`) whose pressed state asserts the
      line — pressed = drawn. The name strikes through while hidden so a hidden
      line reads as "hidden by you", never as "not served".
    */
    mount(PAYOFF)
    /*
      Re-queried after every click, never held: the legend re-renders with the
      chart and the first node may be replaced. T+0 and Midway SHIP hidden —
      the chart answers the expiry question first — so the toggle test doubles
      as the default's pin: T+0 starts un-pressed, expiry starts drawn.
    */
    const pressedOf = (name: string): string | null =>
      screen.getByRole('button', { name }).getAttribute('aria-pressed')
    expect(await screen.findByRole('button', { name: 'T+0 (today)' })).toBeTruthy()
    expect(pressedOf('T+0 (today)')).toBe('false')
    expect(pressedOf('Midway 2026-08-25')).toBe('false')
    expect(pressedOf('Expiry 2026-08-27')).toBe('true')
    act(() => { screen.getByRole('button', { name: 'T+0 (today)' }).click() })
    expect(pressedOf('T+0 (today)')).toBe('true')
    // The others are untouched — one switch per line.
    expect(pressedOf('Expiry 2026-08-27')).toBe('true')
    expect(pressedOf('Midway 2026-08-25')).toBe('false')
    act(() => { screen.getByRole('button', { name: 'T+0 (today)' }).click() })
    expect(pressedOf('T+0 (today)')).toBe('false')
  })

  test('the worst shock says WHERE it lands, beside the figure', async () => {
    mount(PAYOFF)
    // "−31,200 on a shock" is only actionable once you know which side of the
    // book it is: the label carries the shocked price the reading came from.
    expect(await screen.findByText('±5 / ±10% today · at 436.70')).toBeTruthy()
  })

  test('a target no price on the scan reaches is stated in words, not drawn', async () => {
    /*
      THE ORDINARY CASE, not an odd one: this book's flatten target is ₹1.5L
      against a scan whose best point is ₹18.4k, because the target is reached
      by DECAY rather than by the underlying moving 10%. Forcing the y-axis out
      to it would squash the payoff into a band to make room for empty space.
    */
    mount(PAYOFF)
    expect(await screen.findByText(/flatten target is off this chart/)).toBeTruthy()
    // The figure is not lost — the summary tile carries it either way.
    const cell = await theCell('Target')
    expect(cell.textContent).toContain('+1,50,000')
  })

  test('a target the scan does reach is drawn on the chart', async () => {
    mount({ ...PAYOFF, view: { ...VIEW, summary: { ...VIEW.summary, targetPnl: 15000 } } })
    expect(await screen.findByText('target 15,000')).toBeTruthy()
    expect(screen.queryByText(/flatten target is off this chart/)).toBe(null)
  })

  test("the machine card prints the bot's own sentences, verbatim", async () => {
    mount(PAYOFF)
    await openMachine()
    expect(await screen.findByText(NOTE_ARMED)).toBeTruthy()
  })

  test('an unknown margin gate is an em dash, never a shut one', async () => {
    mount(PAYOFF)
    await openMachine()
    await screen.findByText(NOTE_ARMED)
    // "the gate is shut" and "I could not read the margin" are different
    // sentences to whoever is deciding whether to intervene.
    const cell = await theCell('Margin gate')
    expect(cell.textContent).toContain('—')
    expect(cell.textContent).not.toContain('shut')
    /*
      AND THE FRACTION KEEPS ITS OWN DASHED CELL. It used to ride on the gate's
      label line and vanish when null, so "the gate is open and the fraction
      could not be read" and "the gate is open" rendered identically — an
      unknown erased rather than stated.
    */
    expect((await theCell('Margin used')).textContent).toContain('—')
  })

  test('a margin fraction that IS known is printed as one', async () => {
    mount({ ...PAYOFF, machine: { ...MACHINE, marginFrac: 0.6234, shiftEnabled: true } })
    await openMachine()
    expect((await theCell('Margin used')).textContent).toContain('62.3%')
    expect((await theCell('Margin gate')).textContent).toContain('open')
  })

  test('a note the playbook happens to say twice is listed once', async () => {
    // `machine.ts` composes its notes from independent branches and two of them
    // can phrase a hold identically. Rendered as keyed list items, a repeat
    // collides React's keys — an item silently disappears or re-orders.
    mount({ ...PAYOFF, machine: { ...MACHINE, notes: [NOTE_ARMED, NOTE_ARMED] } })
    await openMachine()
    expect(await screen.findAllByText(NOTE_ARMED)).toHaveLength(1)
  })

  test('BOTH warning channels are rendered', async () => {
    mount(PAYOFF)
    // The envelope's own, and the view's — see the file header.
    expect(await screen.findByText(RESPONSE_WARNING)).toBeTruthy()
    expect(screen.getByText(VIEW_WARNING)).toBeTruthy()
  })

  test('a duplicated warning is said once', async () => {
    mount({ ...PAYOFF, warnings: [VIEW_WARNING, RESPONSE_WARNING] })
    await screen.findByText(RESPONSE_WARNING)
    expect(screen.getAllByText(VIEW_WARNING)).toHaveLength(1)
  })

  test('a book that could not be priced renders the reason, not a blank chart', async () => {
    const noFuture =
      'no future mark for BHEL — options are marked Black-76 off the future, so nothing on this ' +
      'book can be priced until it prints'
    mount({ ...PAYOFF, view: null, warnings: [noFuture] })
    expect(await screen.findByText(noFuture)).toBeTruthy()
    expect(screen.getByText(/No payoff could be built/)).toBeTruthy()
    // The machine card needs no chain at all, so it survives a dead future.
    await openMachine()
    expect(screen.getByText(NOTE_ARMED)).toBeTruthy()
  })

  test('a book with nothing to price is never drawn as a flat one', async () => {
    /*
      THE DANGEROUS SHAPE. `buildPayoffView` answers a book it could not price
      with a complete summary in which every figure is a literal 0 — so the
      tiles would read "Floor ₹0 · POP 0.00%", which is "this book cannot lose
      money" printed over a book nothing was computed for. The empty scan is
      the tell.
    */
    mount({
      ...PAYOFF,
      view: {
        curve: [],
        table: [],
        midDate: '',
        summary: {
          maxProfit: 0, maxLoss: 0, maxLossAt: 0, breakevens: { down: null, up: null },
          pop: 0, netCredit: 0, worstShock: 0, floor: 0, booked: 0, targetPnl: null,
        },
        greeks: { delta: 0, gamma: 0, theta: 0, vega: 0 },
        warnings: ['no legs: nothing to price'],
      },
      warnings: ['this book holds no open legs'],
    })
    expect(await screen.findByText(/No payoff could be built/)).toBeTruthy()
    expect(screen.queryByText('Floor')).toBe(null)
    expect(screen.queryByText('POP (open legs)')).toBe(null)
    expect(screen.getByText('no legs: nothing to price')).toBeTruthy()
  })

  test('a machine card that could not be read says so, and shows no figures', async () => {
    mount({ ...PAYOFF, machine: null })
    await screen.findByText('Floor')
    await openMachine()
    expect(screen.getByText(/machine card could not be read/)).toBeTruthy()
    // Not a card of dashes: the labels themselves are gone, so nothing invites
    // the reader to interpret an absent trigger as a quiet one.
    expect(screen.queryByText('Would rebalance')).toBe(null)
  })

  test('a tag with no book renders the bridge\'s sentence', async () => {
    const gone = "'BHEL_RELIEF' has no book in paper — neither open legs nor a registry row"
    mount({ ...PAYOFF, view: null, machine: null, error: gone })
    expect(await screen.findByText(gone)).toBeTruthy()
  })

  test('an answer carrying NOTHING renders a sentence, and never white-screens the page', async () => {
    /*
      THE BRIDGE A DEPLOY BEHIND — a 200 whose body is `{}`, with no `view`, no
      `machine`, no `warnings`, no `symbol`. Every one of those is a field the
      types say is always there.

      THIS IS NOT HYPOTHETICAL AND IT IS NOT CHEAP. When this panel was first
      mounted into `PositionsPage`, `res.machine` came back `undefined`, a
      `=== null` guard let it through, and `undefined.deltaImbalance` threw
      during render — which unmounts the WHOLE BOOK PAGE, not the panel: the
      tiles, the positions table and the bridge diff all go with it, mid-session,
      because a payoff card had nothing to say. Four unrelated suites went red
      and caught it, purely because their fetch stubs happen to fall through to
      `{}`. That is an accident of someone else's test file, not a guard: the day
      a stub changes, or a new unguarded field is read, this regresses with
      `payoff.test.tsx` fully green. Hence a test that OWNS the case.
    */
    mount({})
    expect(await screen.findByText(/No payoff could be built/)).toBeTruthy()
    // It is still a payoff panel, not a stack trace.
    expect(screen.getByText('Payoff & repair')).toBeTruthy()
    await openMachine()
    expect(screen.getByText(/machine card could not be read/)).toBeTruthy()
    // And it never prints the word for a field it does not have: the subtitle
    // joined `symbol` and `expiry` unchecked, and `undefined !== ''` is true.
    expect(document.body.textContent).not.toContain('undefined')
  })

  test('a failed read keeps nothing it never had, and does not throw', async () => {
    installFetch(() => ({ status: 500, body: { error: 'bridge down' } }))
    renderPanel()
    await waitFor(() => {
      expect(screen.getByText('The payoff could not be read')).toBeTruthy()
    })
  })

  test('a closed market is one label in the header, and an older bridge earns none', async () => {
    // The bridge prunes the clock-noise warnings when it sets `marketClosed`;
    // this label is the sentence that replaced them, so it must actually render.
    mount({ ...PAYOFF, marketClosed: true, warnings: [] })
    expect(await screen.findByText(/market closed — last session’s prices/)).toBeTruthy()
  })

  test('a bridge that omits marketClosed never claims the market is closed', async () => {
    mount(PAYOFF)
    await screen.findByText('Floor')
    expect(screen.queryByText(/market closed/)).toBeNull()
  })
})

/**
 * The divided-cell tile a label names — label row, then figure, inside one
 * cell. Scoped rather than searched for by text: several of these figures
 * legitimately appear again in the ladder below them, and an assertion that
 * matched there would pass while the tile itself said something else.
 */
async function theCell(label: string): Promise<HTMLElement> {
  const el = await screen.findByText(label)
  return el.parentElement?.parentElement as HTMLElement
}

// ==========================================================================
//  THE WHAT-IF OVERLAY, THE REPAIR MENU, AND THE BROKER CHECK
// ==========================================================================

/** The chain's own lot size, which is what turns the editor's `lots` into qty. */
const LOT = 1000

/**
 * A menu-level sentence, which arrives only on the REPAIR envelope. It is here
 * to prove the repair answer's warnings reach the one list this panel keeps —
 * the plans are scored on a book, and a book that could not be fully marked
 * scores a floor that belongs to a different one (`repairOf`'s carry-over).
 */
const REPAIR_WARNING =
  'this menu was scored on a book whose 445CE could not be marked — read every floor below with that in mind'

/** The ten figures a plan is ranked on. Overridden per plan below. */
const SCORE = {
  credit: 6100,
  maxLoss: -61000,
  maxLossAt: 400.5,
  breakevens: [412.2, 466.8],
  worstShock: -28400,
  worstShockAt: 436.7,
  marginBefore: 210_000,
  marginAfter: 244_000,
  marginDelta: 34_000,
  profitableWidthPct: 62.5,
  pop: 0.71,
}

/** One long wing — a BUY, and the sign is the only thing that says so. */
const PLAN_WING = {
  goal: 'REDUCE-LOSS',
  moves: [{ op: 'hedge', strike: 400, type: 'PE', qty: LOT }],
  score: { ...SCORE, credit: -4200, maxLoss: -38_000, marginDelta: -12_000 },
  flags: ['bot-may-reshift'],
}

/**
 * A ROLL: one leg off, one leg on. The `close` half is the move the what-if
 * editor cannot express — it proposes contracts, it cannot un-hold one.
 */
const PLAN_ROLL = {
  goal: 'REDUCE-LOSS',
  moves: [
    { op: 'close', legId: 'BHEL26AUG445CE' },
    { op: 'add', strike: 470, type: 'CE', qty: -2 * LOT },
  ],
  score: { ...SCORE, credit: 2400, maxLoss: -44_000 },
  flags: [],
}

/** A fresh short, flagged for the one thing that is not about the bot. */
const PLAN_SELL = {
  goal: 'PROFITABLE-BY-EXPIRY',
  moves: [{ op: 'add', strike: 720, type: 'CE', qty: -LOT }],
  score: SCORE,
  flags: ['degrades-floor'],
}

/**
 * A RE-STRIKE — the one move shape that names a leg AND a destination strike,
 * and therefore the only one where both halves of a line go through
 * `formatContract`: an exchange packing on the left (which it names) and a bare
 * number on the right (which it must hand back untouched).
 */
const PLAN_SHIFT = {
  goal: 'REDUCE-LOSS',
  moves: [{ op: 'shift', legId: 'TCS26AUG2440PE', toStrike: 2260 }],
  score: { ...SCORE, credit: 1800, maxLoss: -33_000 },
  flags: [],
}

/** Do nothing — the row every other row is scored against. */
const BASELINE = {
  goal: 'MAX-CREDIT-SAFE',
  moves: [],
  score: { ...SCORE, credit: 0, marginDelta: 0 },
  flags: ['baseline', 'no-feasible-plan'],
}

/**
 * THE MENU'S FINGERPRINT OF THE LEGS ITS PLANS ADDRESS. Every `shift` and
 * `close` names its leg by a POSITIONAL id, so this is what an apply is checked
 * against — carried from the card into the preflight, and asserted there.
 */
const CARD_LEGS = 'legs:card'

const REPAIR = {
  tag: 'BHEL_RELIEF',
  mode: 'paper',
  asOf: 1_755_600_000_000,
  dials: { lotSize: LOT },
  legsPrint: CARD_LEGS,
  goals: [
    { goal: 'REDUCE-LOSS', plans: [PLAN_WING, PLAN_ROLL] },
    { goal: 'PROFITABLE-BY-EXPIRY', plans: [PLAN_SELL] },
    // A goal the search served nothing for still appears — empty, never absent.
    { goal: 'CHEAP-TAIL-CAP', plans: [] },
    { goal: 'MAX-CREDIT-SAFE', plans: [BASELINE] },
  ],
  universe: { atomic: 46, evaluated: 82 },
  warnings: [REPAIR_WARNING],
}

/** A sentence only the COMBINED envelope carries — see the merge assertions. */
const OVERLAY_WARNING =
  '720CE has no price on this chain, so the proposed leg was NOT included in the curves below'

/** The same ±10% grid as `VIEW.curve`, valued on the book plus the proposal. */
const COMBINED_CURVE = [
  { price: 400.5, expiry: -41_000, t0: -25_000, mid: -33_000 },
  { price: 445, expiry: 24_500, t0: 12_000, mid: 17_000 },
  { price: 489.5, expiry: -30_100, t0: -18_000, mid: -24_000 },
]

const WHATIF = {
  current: VIEW.summary,
  /*
    THE BRIDGE'S OWN LIST of what THIS request could not read or apply — the
    panel's only source for "the proposal's own sentences" (the pair's note,
    the plan banner, and the loaded-echo's full/partial/none). The envelope
    below folds the same sentence into the book-level list for the ledger.
  */
  dropped: [OVERLAY_WARNING],
  combined: {
    ...PAYOFF,
    view: {
      ...VIEW,
      curve: COMBINED_CURVE,
      summary: { ...VIEW.summary, floor: -41_000, maxLoss: -41_000, maxLossAt: 400.5 },
    },
    warnings: [RESPONSE_WARNING, OVERLAY_WARNING],
  },
}

/** What the book would cost to hold after a plan — the preflight's own block. */
const MARGIN_AFTER = {
  estimated: 244_000,
  broker: {
    total: 268_400,
    span: 210_000,
    exposure: 42_000,
    premiumPaid: 16_400,
    // The desk's normal case: the gateway published funds, so `brokerFigures`
    // applied the account's measured multipliers.
    calibrated: true,
  },
  warnings: [],
}

/** Nothing here could be priced — a dash, never a zero. */
const NO_DELTA = { netDelta: null, netGamma: null, neutral: null }

/**
 * THE APPLY MODAL'S OWN ANSWER, minimal but WELL FORMED — every field it
 * dereferences without a guard is present. This file asserts the CARD, not the
 * modal (that is `repair-apply.test.tsx`), so this exists only so that opening
 * one does not throw.
 */
const PREFLIGHT = {
  tag: 'BHEL_RELIEF',
  mode: 'paper',
  asOf: 1_755_600_000_000,
  bookPrint: 'book:one',
  legsPrint: 'legs:fresh',
  orders: [],
  dropped: [],
  margin: MARGIN_AFTER,
  delta: {
    current: { all: NO_DELTA, shortsOnly: NO_DELTA },
    after: { all: NO_DELTA, shortsOnly: NO_DELTA },
  },
  holdActive: false,
  warnings: [],
}

interface Bodies {
  payoff?: unknown
  repair?: unknown
  /** One menu per search, in order — the last one repeats. See `Search again`. */
  repairs?: readonly unknown[]
  whatif?: unknown
  preflight?: unknown
}

/** The whole cockpit's network, each endpoint overridable per test. */
function mountDesk(bodies: Bodies = {}): SentRequest[] {
  let searches = 0
  const sent = installFetch(({ path }) => {
    // The session probe `AuthProvider` makes on mount. An operator, because a
    // machine principal cannot re-authenticate and the panel's Apply path is
    // gated on one.
    if (path === '/v1/auth/me') {
      return { body: { username: 'operator', kind: 'user', expiresAt: 4_000_000_000_000 } }
    }
    if (path === '/v1/desk/payoff') return { body: bodies.payoff ?? PAYOFF }
    if (path === '/v1/desk/repair') {
      const menus = bodies.repairs
      if (menus === undefined) return { body: bodies.repair ?? REPAIR }
      const at = Math.min(searches, menus.length - 1)
      searches += 1
      return { body: menus[at] }
    }
    if (path === '/v1/desk/payoff/whatif') return { body: bodies.whatif ?? WHATIF }
    if (path === '/v1/desk/repair/preflight') return { body: bodies.preflight ?? PREFLIGHT }
    return { body: {} }
  })
  renderPanel()
  return sent
}

/** Press a button by its accessible name and let whatever it started settle. */
async function press(name: string | RegExp): Promise<void> {
  const button = await screen.findByRole('button', { name })
  await act(async () => {
    button.click()
    await Promise.resolve()
  })
}

/** Mount, wait for the first payoff, then ask for the repair menu. */
async function suggest(bodies: Bodies = {}): Promise<SentRequest[]> {
  const sent = mountDesk(bodies)
  await screen.findByText('Floor')
  await press('Suggest repairs')
  return sent
}

/** Every request made to one path, in order. */
function to(sent: readonly SentRequest[], path: string): SentRequest[] {
  return sent.filter((r) => r.path === path)
}

/**
 * The card a plan's first move line sits in, so an assertion about "the 720CE
 * plan" cannot pass by matching a different plan's badge. Walked up by role
 * rather than by a fixed number of parents: the panel gives every plan card a
 * `group` role named after its lead move, precisely so a suite (and a screen
 * reader) can tell twelve of them apart.
 */
function planCard(name: string | RegExp): HTMLElement {
  return screen.getByRole('group', { name })
}

/**
 * OFF, BY EITHER OF THE TWO MECHANISMS. A `Button` carrying a `tooltip` — which
 * is how a disabled control on this desk says WHY — goes `aria-disabled` rather
 * than natively disabled, deliberately: a natively disabled button is not
 * focusable, so a keyboard user could never reach the sentence explaining it.
 */
function isOff(button: HTMLElement): boolean {
  return button.hasAttribute('disabled') || button.getAttribute('aria-disabled') === 'true'
}

describe('the what-if overlay', () => {
  test('a proposed SELL is sent as a negative quantity, in shares', async () => {
    /*
      THE ONE PIECE OF ARITHMETIC IN THIS EDITOR, and both halves of it are the
      kind that is silently wrong: the SIGN is the side (a sell is negative
      shares, and `add`/`hedge` are labels the server ignores), and the size is
      LOTS x the chain's lot size. A 1-lot sell that goes over as `qty: 1` is a
      long, and as `qty: -1` it is a single share.
    */
    const sent = await suggest()
    await addSellLeg(720)
    const posted = to(sent, '/v1/desk/payoff/whatif')
    expect(posted).toHaveLength(1)
    expect(posted[0]?.method).toBe('POST')
    expect(posted[0]?.body?.['proposed']).toEqual([{ strike: 720, type: 'CE', qty: -LOT }])
    // MODE RIDES IN THE BODY, never the query string: `routes/payoff.ts` reads
    // it from `body['mode']` alone and defaults to paper, so a live book asked
    // for through the URL would be priced as the wrong rail's book.
    expect(posted[0]?.body?.['mode']).toBe('paper')
    expect(posted[0]?.body?.['tag']).toBe('BHEL_RELIEF')
  })

  test('the combined curve joins the chart, and the floor is stated before and after', async () => {
    await suggest()
    await addSellLeg(720)
    // A FOURTH LINE, named for what it is: the same expiry column, on the book
    // this proposal would leave behind.
    expect(await screen.findByText('Expiry, if placed')).toBeTruthy()
    expect((await theCell('Floor now')).textContent).toContain('-73,250')
    expect((await theCell('Floor if placed')).textContent).toContain('-41,000')
    expect((await theCell('Max loss if placed')).textContent).toContain('-41,000')
  })

  test("a book that could not be priced as it stands is a dash, never a zero", async () => {
    /*
      `WhatIfResponse.current` IS NULLABLE (task 9 widened it) and null means
      "the book as it stands could not be priced" — which rendered as ₹0 would
      claim a book that cannot lose money, beside an "if placed" figure that is
      real. The whole before/after pair is worthless if the before can lie.
    */
    await suggest({ whatif: { ...WHATIF, current: null } })
    await addSellLeg(720)
    await screen.findByText('Expiry, if placed')
    expect((await theCell('Floor now')).textContent).toContain('—')
    expect((await theCell('Floor now')).textContent).not.toContain('0')
    expect(screen.getByText(/could not be priced as it stands/)).toBeTruthy()
  })

  test("the overlay's own warnings join the one list this panel keeps", async () => {
    await suggest()
    await addSellLeg(720)
    /*
      TWO HOMES, ON PURPOSE, and only for the sentences the PROPOSAL produced:
      beside the figures they qualify (where a dropped leg contradicts what the
      row above claims), and in the panel's one complete ledger at the bottom.
    */
    expect(await screen.findAllByText(OVERLAY_WARNING)).toHaveLength(2)
    expect(within(thePair()).getByText(OVERLAY_WARNING)).toBeTruthy()
    // Deduped against the payoff's own channel, like every other sentence here:
    // the combined envelope legitimately repeats the book-level ones, and those
    // stay in the one place they belong.
    expect(screen.getAllByText(RESPONSE_WARNING)).toHaveLength(1)
  })

  test('Clear takes the proposal, the fourth line and the pair back off', async () => {
    await suggest()
    await addSellLeg(720)
    await screen.findByText('Expiry, if placed')
    await press('Clear')
    expect(screen.queryByText('Expiry, if placed')).toBe(null)
    expect(screen.queryByText('Floor if placed')).toBe(null)
    // …and the three curves the panel is actually for are still drawn.
    expect(screen.getByText('Expiry 2026-08-27')).toBeTruthy()
  })
})

describe('the repair menu', () => {
  test('it is asked for when the operator asks, and never on a timer', async () => {
    /*
      EACH GET IS A WHOLE SEARCH — hundreds of candidate books priced through
      the same surface engine the chart draws. The payoff beside it already
      polls at 60s and that is the cheap one; a repair menu on any cadence at
      all would spend the box's CPU on an answer nobody asked to refresh.
    */
    vi.useFakeTimers()
    try {
      const sent = mountDesk()
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      expect(to(sent, '/v1/desk/repair')).toHaveLength(0)
      /*
        `getByRole`, NOT the `press` helper: `findBy*` polls on a `setInterval`
        that these fake timers own, and testing-library only advances them for
        Jest's own fakes — under vitest's it would wait for a tick that never
        comes and take the whole file's timers down with it when the test
        times out mid-`finally`.
      */
      const button = screen.getByRole('button', { name: 'Suggest repairs' })
      await act(async () => {
        button.click()
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(to(sent, '/v1/desk/repair')).toHaveLength(1)
      // Three minutes on, the payoff has polled again and the menu has not.
      await act(async () => { await vi.advanceTimersByTimeAsync(180_000) })
      expect(to(sent, '/v1/desk/repair')).toHaveLength(1)
      expect(to(sent, '/v1/desk/payoff').length).toBeGreaterThan(1)
    } finally {
      vi.useRealTimers()
    }
  })

  test('it asks for this book, on this rail', async () => {
    const sent = await suggest()
    const asked = to(sent, '/v1/desk/repair')[0]
    expect(asked?.url).toContain('tag=BHEL_RELIEF')
    expect(asked?.url).toContain('mode=paper')
  })

  test('all four goals are named, including the one nothing was found for', async () => {
    await suggest()
    for (const goal of ['REDUCE-LOSS', 'PROFITABLE-BY-EXPIRY', 'CHEAP-TAIL-CAP', 'MAX-CREDIT-SAFE']) {
      expect(await screen.findByText(goal)).toBeTruthy()
    }
    // A goal with no plan says so. Silently missing reads as "not searched".
    expect(screen.getByText(/no plan found/)).toBeTruthy()
  })

  test('a plan reads as a sentence an operator could say down the phone', async () => {
    await suggest()
    // The SIGN is the side, and the size is in lots of the chain's own size.
    expect(await screen.findByText('Sell 1 lot 720CE')).toBeTruthy()
    expect(screen.getByText('Buy 1 lot 400PE')).toBeTruthy()
    /*
      AND A LEG ID IS A CONTRACT NAME, not the exchange's packing. `Close
      BHEL26AUG445CE` glues the strike — the one number being scanned for —
      between a year and an option type, in the middle of a line somebody reads
      down the phone. Same rule as every other cell on this desk
      (`formatContract`), applied at the last moment: the plan KEYS and the
      bodies that go over the wire are still the raw ids.
    */
    expect(screen.getByText('Close BHEL 445 CE')).toBeTruthy()
    expect(screen.getByText('Sell 2 lots 470CE')).toBeTruthy()
    // NO PRICE IS INVENTED: `Move` carries none, and a fill nobody quoted is
    // the number an operator would take to the broker.
    expect(document.body.textContent).not.toContain('@ ')
  })

  test('a re-strike names the leg it moves and leaves the strike it moves to alone', async () => {
    /*
      THE ONLY LINE WITH A CONTRACT ON BOTH SIDES OF IT, and the two sides need
      opposite treatment. `TCS26AUG2440PE` is an exchange packing and is NAMED;
      `2260` is a bare destination strike and must come back untouched — a
      strike is an IDENTIFIER, not a sum of money, so it carries no grouping and
      nothing else may be done to it either. `formatContract` hands back
      anything it does not recognise, which is what makes running it over both
      halves safe rather than merely convenient.

      AND DISPLAY IS THE LAST THING THAT HAPPENS. Both wires out of this card —
      the what-if POST and the preflight — carry the move EXACTLY as the bridge
      wrote it, raw packing and all: a leg id is how the server finds the leg,
      and a formatter that reached the wire would aim a repair at nothing.
    */
    const sent = await suggest({
      repair: { ...REPAIR, goals: [{ goal: 'REDUCE-LOSS', plans: [PLAN_SHIFT] }] },
      whatif: WHATIF_CLEAN,
    })
    expect(await screen.findByText('Shift TCS 2440 PE → 2260')).toBeTruthy()
    // Not merely formatted somewhere — the packing is nowhere on the screen.
    expect(screen.queryByText(/TCS26AUG2440PE/)).toBe(null)
    // …and 2260 is not printed as `2,260`, which would read as a price.
    expect(document.body.textContent).not.toContain('2,260')

    await press('Load into overlay: shift TCS 2440 PE → 2260')
    expect(to(sent, '/v1/desk/payoff/whatif')[0]?.body?.['moves']).toEqual(PLAN_SHIFT.moves)

    await press('Apply: shift TCS 2440 PE → 2260')
    await waitFor(() => expect(to(sent, '/v1/desk/repair/preflight')).toHaveLength(1))
    expect(to(sent, '/v1/desk/repair/preflight')[0]?.body?.['moves']).toEqual(PLAN_SHIFT.moves)
  })

  test('the do-nothing row says what it is', async () => {
    await suggest()
    expect(await screen.findByText(/do nothing/)).toBeTruthy()
  })

  test('the five ranking figures ride with every plan, width included', async () => {
    /*
      WIDTH IS THE RANKING NUMBER FOR PROFITABLE-BY-EXPIRY and for nothing else
      (`goals.ts` ranks it on `[profitableWidthPct, pop]`), so a menu that omits
      it renders one whole section as if it were mis-sorted.
    */
    await suggest()
    const card = planCard(/720CE/)
    expect(within(card).getByText('+6,100')).toBeTruthy()
    expect(within(card).getByText('-61,000')).toBeTruthy()
    expect(within(card).getByText('-28,400')).toBeTruthy()
    expect(within(card).getByText('+34,000')).toBeTruthy()
    expect(within(card).getByText('62.5%')).toBeTruthy()
  })

  /**
   * THE TWO COLUMNS THE SPEC'S DECISION TABLE PROMISES AND THE ROW ABOVE DID
   * NOT CARRY: where the floor happens, and between what prices the plan is
   * defended.
   *
   * A −₹61,000 at 400.50 on a book marked at 445 is a shock away; the same
   * number at 443 is the next tick, and nothing else on the card tells them
   * apart. The breakevens are the pair a desk watches the tape against — `width`
   * says how MUCH of the ladder finishes green, never BETWEEN WHAT.
   */
  test('the floor says WHERE, and every card carries its breakevens', async () => {
    await suggest()
    const card = planCard(/720CE/)
    expect(within(card).getByText('at 400.50')).toBeTruthy()
    // A LABELLED CELL now, in the card's own stat block, rather than a run-on
    // line of 11px text under the figures — see `.plan-stat-grid`.
    expect(within(card).getByText('breakevens')).toBeTruthy()
    expect(within(card).getByText('412.20 / 466.80')).toBeTruthy()
    // And the worst shock says where too: "−28,400" is only actionable once
    // you know which side of the book it lands on.
    expect(within(card).getByText('at 436.70')).toBeTruthy()
  })

  /**
   * NO CROSSING EITHER SIDE IS UNBOUNDED SAFETY, NOT MISSING DATA — the null
   * sides are already dropped by `runBreakevens`, so an empty pair is a run that
   * never reaches zero. One dash, never a blank line and never an `undefined`.
   */
  test('a plan whose run never breaks even prints a dash, not a gap', async () => {
    const safe = { ...PLAN_SELL, score: { ...SCORE, breakevens: [] } }
    await suggest({ repair: { ...REPAIR, goals: [{ goal: 'REDUCE-LOSS', plans: [safe] }] } })
    expect(within(planCard(/720CE/)).getByText('—')).toBeTruthy()
  })

  test('the flags are badges, and the one that is not about the bot is a warning', async () => {
    await suggest()
    const card = planCard(/720CE/)
    // `degrades-floor` says the plan leaves the book WORSE at the bottom than
    // doing nothing — the one flag that contradicts the headline figure above.
    const badge = within(card).getByText('degrades-floor')
    expect(badge).toBeTruthy()
    expect(badge.closest('[data-variant="warning"]')).toBeTruthy()
    expect(within(planCard(/400PE/)).getByText('bot-may-reshift')).toBeTruthy()
    expect(within(planCard(/do nothing/)).getByText('baseline')).toBeTruthy()
  })

  test("the menu's own warnings join the one list this panel keeps", async () => {
    await suggest()
    expect(await screen.findByText(REPAIR_WARNING)).toBeTruthy()
  })

  test('the panel no longer denies that it places orders — it says where the gates are', async () => {
    /*
      THE SENTENCE USED TO BE "Nothing here places an order", and it was true
      until Apply existed. A standing denial beside a button that DOES place
      orders is worse than no sentence at all: it is the line an operator reads
      to decide how carefully to read the rest of the screen. What replaces it
      names the rail (the Manual Order dialog's), and the order of the gates.
    */
    await suggest()
    expect(screen.queryByText(/Nothing here places an order/)).toBe(null)
    expect(screen.getByText(/Apply places a plan/)).toBeTruthy()
    expect(screen.getByText(/a preview first, the operator password on a live book/)).toBeTruthy()
    expect(screen.getByText(/closes before opens/)).toBeTruthy()
    // The search itself is still the one press, one search it always was.
    expect(screen.getByText(/never on a timer/)).toBeTruthy()
  })
})

/** A what-if answer that qualifies NOTHING — the clean load. */
const WHATIF_CLEAN = {
  ...WHATIF,
  dropped: [],
  combined: { ...WHATIF.combined, warnings: [RESPONSE_WARNING] },
}

describe('loading a plan into the overlay', () => {
  /**
   * THE PLAN GOES OVER AS ITSELF.
   *
   * It used to be translated into what the leg editor can say — `{strike, type,
   * qty}` — which has no way to take a leg OFF. A plan of pure closes therefore
   * proposed NOTHING, and the panel drew the unchanged book under the label "if
   * placed": a flatten previewing as "this repair changes nothing" (TCS,
   * 2026-08-20). `moves` is the repairer's own language and the server applies
   * it through the same `applyMoves` that scored the plan.
   */
  test("a plan is posted as its own moves, verbatim", async () => {
    const sent = await suggest({ whatif: WHATIF_CLEAN })
    await press('Load into overlay: sell 1 lot 720CE')
    const posted = to(sent, '/v1/desk/payoff/whatif')
    expect(posted).toHaveLength(1)
    expect(posted[0]?.body?.['moves']).toEqual(PLAN_SELL.moves)
    // NOT the editor's vocabulary: sending both would let the server apply one
    // plan twice, and the panel never gives one overlay two authors.
    expect(posted[0]?.body?.['proposed']).toBe(undefined)
    expect(await screen.findByText('Expiry, if placed')).toBeTruthy()
  })

  test('a close-only plan draws a curve, and never says it could not be loaded', async () => {
    /*
      THE WHOLE POINT OF THE MOVES VOCABULARY. Every move here is a `close`, so
      the old translation produced an empty proposal, posted nothing, and told
      the operator the plan "holds nothing this editor can propose" — about a
      flatten, which is the most consequential plan the menu ever offers.
    */
    const flatten = {
      goal: 'REDUCE-LOSS',
      moves: [{ op: 'close', legId: 'BHEL26AUG445CE' }, { op: 'close', legId: 'BHEL26AUG415PE' }],
      score: { ...SCORE, credit: -1200, maxLoss: 4200 },
      flags: [],
    }
    const sent = await suggest({
      repair: { ...REPAIR, goals: [{ goal: 'REDUCE-LOSS', plans: [flatten] }] },
      whatif: WHATIF_CLEAN,
    })
    await press('Load into overlay: close BHEL 445 CE')
    const posted = to(sent, '/v1/desk/payoff/whatif')
    expect(posted).toHaveLength(1)
    expect(posted[0]?.body?.['moves']).toEqual(flatten.moves)
    expect(await screen.findByText('Expiry, if placed')).toBeTruthy()
    expect(screen.queryByText(/could not be loaded/)).toBe(null)
    expect(screen.queryByText(/cannot un-hold/)).toBe(null)
    // …and the before/after pair is drawn for it like any other proposal.
    expect((await theCell('Floor if placed')).textContent).toContain('-41,000')
  })

  test('a roll carries BOTH halves — the close as well as the open', async () => {
    const sent = await suggest({ whatif: WHATIF_CLEAN })
    await press('Load into overlay: close BHEL 445 CE')
    expect(to(sent, '/v1/desk/payoff/whatif')[0]?.body?.['moves']).toEqual(PLAN_ROLL.moves)
  })

  test("the plan's own card says what happened, where the press happened", async () => {
    /*
      THE CHART IS A LONG WAY UP THE PAGE on a book carrying twelve plan cards,
      so a press whose only visible effect is off-screen reads as a dead button.
    */
    await suggest({ whatif: WHATIF_CLEAN })
    await press('Load into overlay: sell 1 lot 720CE')
    expect(within(planCard(/720CE/)).getByText(/Loaded into the what-if overlay/)).toBeTruthy()
    await press('Load into overlay: close BHEL 445 CE')
    expect(within(planCard(/BHEL 445 CE/)).getByText(/Loaded into the what-if overlay/)).toBeTruthy()
    // …and the plan it replaced no longer claims to be the one on the chart.
    expect(within(planCard(/720CE/)).queryByText(/Loaded into/)).toBe(null)
  })

  test('a plan the BRIDGE partly dropped still banners, in the bridge\'s words', async () => {
    /*
      NOTHING IS GUESSED CLIENT-SIDE ANY MORE. The panel posts the plan whole,
      so the only thing that can make the fourth line something other than the
      plan is a move the SERVER refused — an off-chain strike, a leg that is no
      longer in the book — and the sentence rendered is the server's own, under
      the curve it qualifies.
    */
    const dropped = 'close "BHEL26AUG445CE": no such leg in the book — dropped'
    await suggest({
      whatif: {
        ...WHATIF,
        // One of the roll's TWO moves — the other applied, so this is 'partial'.
        dropped: [dropped],
        combined: { ...WHATIF.combined, warnings: [RESPONSE_WARNING, dropped] },
      },
    })
    await press('Load into overlay: close BHEL 445 CE')
    const banner = await screen.findByText(/Part of this plan is not in the curve above/)
    /*
      TWO HOMES, as every proposal-own sentence has: under the curve it
      qualifies, and in the panel's one complete ledger at the bottom. The
      before/after pair carries it too — it is why the two columns can look
      alike — so this counts rather than insisting on exactly one.
    */
    expect(screen.getAllByText(dropped).length).toBeGreaterThanOrEqual(2)
    // Between the chart it qualifies and the editor below it — a caveat nobody
    // finds is a caveat that is not there.
    const legend = screen.getByText('Expiry 2026-08-27')
    const editor = screen.getByText('What if')
    expect(legend.compareDocumentPosition(banner) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(editor.compareDocumentPosition(banner) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy()
    // And the card points where the banner actually is.
    expect(within(planCard(/BHEL 445 CE/)).getByText(/under the chart/)).toBeTruthy()
  })

  test('the do-nothing baseline draws no curve at all', async () => {
    /*
      Its move list is empty by construction, so there is nothing to post — and
      posting an empty plan would draw the UNCHANGED book under the label "if
      placed", which is the reading this whole change exists to remove.
    */
    const sent = await suggest()
    await press('Load into overlay: do nothing — the baseline every plan is scored against')
    expect(to(sent, '/v1/desk/payoff/whatif')).toHaveLength(0)
    expect(screen.queryByText('Expiry, if placed')).toBe(null)
    /*
      AND IT CLAIMS NOTHING EITHER WAY. Latching the baseline's key with no POST
      behind it printed "Nothing here could be loaded — the note under the chart
      says why" over a chart with no note anywhere; pressing Load on an empty
      plan just clears the overlay, which is all it can honestly mean.
    */
    expect(screen.queryByText(/could not be loaded/)).toBe(null)
    expect(screen.queryByText(/Nothing here could be loaded/)).toBe(null)
  })

  test('a plan the bridge dropped WHOLE draws no line, and says so as itself', async () => {
    /*
      A STALE MENU'S CLOSES NAME LEGS THE BOOK NO LONGER HOLDS. `applyMoves`
      drops every one with a named sentence and hands back the ORIGINAL legs, so
      the combined curve is the unchanged book — non-empty, and identical to the
      one already drawn. Under "Expiry, if placed" that reads as "this plan
      changes nothing", the flatten-previews-as-no-change misreading this rework
      exists to remove. Every move dropped is NO plan: no fourth line, the
      banner says whole-not-part, and the card sends the reader to the note.
    */
    const gone = [
      'close "BHEL26AUG445CE": no such leg in the book — dropped',
      'close "BHEL26AUG415PE": no such leg in the book — dropped',
    ]
    const flatten = {
      goal: 'REDUCE-LOSS',
      moves: [{ op: 'close', legId: 'BHEL26AUG445CE' }, { op: 'close', legId: 'BHEL26AUG415PE' }],
      score: { ...SCORE, credit: -1200, maxLoss: 4200 },
      flags: [],
    }
    await suggest({
      repair: { ...REPAIR, goals: [{ goal: 'REDUCE-LOSS', plans: [flatten] }] },
      whatif: {
        ...WHATIF,
        dropped: gone,
        combined: { ...WHATIF.combined, warnings: [RESPONSE_WARNING, ...gone] },
      },
    })
    await press('Load into overlay: close BHEL 445 CE')
    expect(screen.queryByText('Expiry, if placed')).toBe(null)
    expect(await screen.findByText(/This plan could not be loaded — the curve above is unchanged/)).toBeTruthy()
    expect(
      within(planCard(/BHEL 445 CE/)).getByText(/Nothing here could be loaded/),
    ).toBeTruthy()
  })

  test('a bridge that fails the load blames the wire, never the plan', async () => {
    /*
      A 500 IS NOT A FACT ABOUT THE PLAN. `loaded` left standing over a null
      overlay printed the card's "nothing here could be loaded" sentence for a
      bridge that was down; the error banner owns that story, and the card must
      make no claim at all.
    */
    const sent = installFetch(({ path }) => {
      if (path === '/v1/desk/payoff') return { body: PAYOFF }
      if (path === '/v1/desk/repair') return { body: REPAIR }
      if (path === '/v1/desk/payoff/whatif') return { status: 503, body: { error: 'the bridge is down' } }
      return { body: {} }
    })
    renderPanel()
    await screen.findByText('Floor')
    await press('Suggest repairs')
    await press('Load into overlay: sell 1 lot 720CE')
    expect(to(sent, '/v1/desk/payoff/whatif')).toHaveLength(1)
    expect(await screen.findByText(/could not be priced/)).toBeTruthy()
    expect(screen.queryByText(/Nothing here could be loaded/)).toBe(null)
    expect(screen.queryByText('Expiry, if placed')).toBe(null)
  })

  test('no plan can be loaded over a pricing already in flight', async () => {
    /*
      `ask` refuses a call made over one still running — half-applying it would
      list a leg the curve beside it does not include. Refusing behind a button
      that still looks live is the dead-button reading this panel avoids
      everywhere else, so the buttons go off for the moment it takes.
    */
    await suggest({ whatif: WHATIF_CLEAN })
    // A SYNCHRONOUS act: React's state lands, the fetch's promise has not.
    act(() => { screen.getByRole('button', { name: 'Load into overlay: sell 1 lot 720CE' }).click() })
    const other = screen.getByRole('button', { name: 'Load into overlay: buy 1 lot 400PE' })
    expect(other.hasAttribute('disabled')).toBe(true)
    await act(async () => { await Promise.resolve() })
    await screen.findByText('Expiry, if placed')
    expect(
      screen.getByRole('button', { name: 'Load into overlay: buy 1 lot 400PE' }).hasAttribute('disabled'),
    ).toBe(false)
  })
})

describe('applying a plan', () => {
  test('every plan carries an Apply button, and the broker check is no longer one', async () => {
    /*
      THE MENU GREW A BUTTON. `Verify margin` was the card's other control and
      it is gone — not because the endpoint went (it is still served) but
      because the apply modal runs that check itself, against the book as it
      stands, beside the orders it would place. Two broker figures on one
      screen, one of them earned minutes ago, is the defect this desk keeps
      re-finding.
    */
    await suggest()
    expect(await screen.findByRole('button', { name: 'Apply: sell 1 lot 720CE' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Apply: buy 1 lot 400PE' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Verify margin/ })).toBe(null)
  })

  test('the do-nothing row has nothing to place, and the button says which', async () => {
    const sent = await suggest()
    const card = planCard(/do nothing/)
    const button = within(card).getByRole('button', { name: /^Apply/ })
    expect(isOff(button)).toBe(true)
    expect(within(card).getByText(/places nothing/)).toBeTruthy()
    /*
      AND OFF MEANS OFF. A disabled button that carries a tooltip goes
      `aria-disabled` rather than natively disabled — so that a keyboard user
      can still reach the sentence — which means the handler is what has to
      refuse the press, and this is the assertion that it does.
    */
    await act(async () => {
      button.click()
      await Promise.resolve()
    })
    expect(to(sent, '/v1/desk/repair/preflight')).toHaveLength(0)
    expect(screen.queryByRole('button', { name: /^Place \d+ order/ })).toBe(null)
  })

  test('a plan the search met with nothing is a row to read, not one to place', async () => {
    /*
      `no-feasible-plan` says the goal was met with NOTHING — the row is the
      least-bad book the search could find rather than a repair — so it is
      offered to read and never to place.
    */
    const hopeless = { ...PLAN_SELL, flags: ['no-feasible-plan'] }
    await suggest({ repair: { ...REPAIR, goals: [{ goal: 'REDUCE-LOSS', plans: [hopeless] }] } })
    const card = planCard(/720CE/)
    expect(isOff(within(card).getByRole('button', { name: /^Apply/ }))).toBe(true)
    expect(within(card).getByText(/least-bad row/)).toBeTruthy()
  })

  test('an unknown lot size holds Apply shut — the sizes on the card are not orders', async () => {
    /*
      `lotSize` IS 0 WHEN THE INSTRUMENT MASTER DOES NOT KNOW THE CONTRACT — the
      repairer's own refusal to guess — and the card then prints its sizes in
      SHARES, because "0.4 lots" is not an order anybody can place. Neither is
      whatever would go out under it.
    */
    await suggest({ repair: { ...REPAIR, dials: { lotSize: 0 } } })
    const card = planCard(/720CE/)
    expect(isOff(within(card).getByRole('button', { name: /^Apply/ }))).toBe(true)
    expect(within(card).getByText(/lot size/)).toBeTruthy()
  })

  test('one plan at a time: every other Apply goes off while a modal is open', async () => {
    /*
      The modal mints ONE `decisionId` per open and the bridge allows one repair
      run per tag, so a second modal is a second claim on the same book — two
      screens both reading correct over one position.
    */
    await suggest()
    await press('Apply: sell 1 lot 720CE')
    // The modal is up: its own Place button is the tell.
    expect(await screen.findByRole('button', { name: /^Place \d+ order/ })).toBeTruthy()
    const other = within(planCard(/400PE/)).getByRole('button', { name: /^Apply/ })
    expect(isOff(other)).toBe(true)
    expect(within(planCard(/400PE/)).getByText(/already open/)).toBeTruthy()
  })

  test('the modal opens on the plan that was pressed, and preflights that plan', async () => {
    const sent = await suggest()
    // The ROLL, because it is the plan carrying a leg id: what goes over the
    // wire is the RAW `BHEL26AUG445CE` the bridge named, never the `BHEL 445
    // CE` the card renders. Display is the last thing that happens to an id.
    await press('Apply: close BHEL 445 CE')
    await waitFor(() => expect(to(sent, '/v1/desk/repair/preflight')).toHaveLength(1))
    const asked = to(sent, '/v1/desk/repair/preflight')[0]
    expect(asked?.body?.['moves']).toEqual(PLAN_ROLL.moves)
    expect(asked?.body?.['tag']).toBe('BHEL_RELIEF')
    expect(asked?.body?.['mode']).toBe('paper')
    /*
      AND THE CARD'S OWN FINGERPRINT GOES WITH IT — the menu's `legsPrint`, which
      is what lets the bridge refuse a card that has outlived its book instead of
      aiming it at whatever now sits under its leg ids.
    */
    expect(asked?.body?.['legsPrint']).toBe(CARD_LEGS)
  })

  /** The same menu, re-searched: new legs, so a new fingerprint over them. */
  const SECOND_MENU = {
    ...REPAIR,
    legsPrint: 'legs:second',
    goals: [{ goal: 'REDUCE-LOSS', plans: [PLAN_LATER] }],
  }

  test('a press after Search again carries the NEW menu’s print, not the first one’s', async () => {
    /*
      THE PRINT BELONGS TO THE MENU THE CARD WAS DRAWN FROM. A second search is
      a fresh reading of the legs, so it answers with a fresh fingerprint — and
      sending the FIRST menu's over a card from the second is how a preflight
      gets refused for a staleness that is the dashboard's own invention.
    */
    const sent = await suggest({ repairs: [REPAIR, SECOND_MENU] })
    await press('Search again')
    await press('Apply: sell 1 lot 390PE')
    await waitFor(() => expect(to(sent, '/v1/desk/repair/preflight')).toHaveLength(1))
    expect(to(sent, '/v1/desk/repair/preflight')[0]?.body?.['legsPrint']).toBe('legs:second')
  })

  test('a menu that lands UNDER an open modal does not re-arm it', async () => {
    /*
      THE OTHER HALF OF THE SAME RULE, and the one that matters more: the print
      is captured at PRESS time, so a search that finishes behind an open modal
      cannot swap the fingerprint the operator's preview was asked under. Were
      it read live, the modal would silently re-preflight against a menu nobody
      on this screen has seen — new sizes under a Place button somebody is
      already reading.
    */
    const sent = await suggest({ repairs: [REPAIR, SECOND_MENU] })
    await press('Apply: close BHEL 445 CE')
    await waitFor(() => expect(to(sent, '/v1/desk/repair/preflight')).toHaveLength(1))

    // `hidden`: the open dialog takes the rest of the page out of the
    // accessibility tree, which is exactly what it should do — the press below
    // is standing in for a search that was already in flight when it opened.
    const again = screen.getByRole('button', { name: 'Search again', hidden: true })
    await act(async () => {
      again.click()
      await Promise.resolve()
    })
    await waitFor(() => expect(to(sent, '/v1/desk/repair').length).toBeGreaterThan(1))

    // The modal asked ONCE, and it asked with the print its card carried.
    expect(to(sent, '/v1/desk/repair/preflight')).toHaveLength(1)
    expect(to(sent, '/v1/desk/repair/preflight')[0]?.body?.['legsPrint']).toBe(CARD_LEGS)
  })
})

/** Type a strike into the editor's own box. */
async function fireStrike(strike: number): Promise<void> {
  /*
    Awaited: the dialog shows the strike PICKER while the chain read is in
    flight, and only falls back to this free number box once the chain has
    answered with no rows (which is what the suite's default network serves).
  */
  const input = await screen.findByRole('spinbutton', { name: /Strike/ })
  fireEvent.change(input, { target: { value: String(strike) } })
}

/**
 * The Selector's two faces, borrowed from the book-build suite: a plain
 * Selector's trigger IS the `combobox`; a searchable one moves that role onto
 * the popover's search box and leaves the trigger a `button`.
 */
async function pickerTrigger(field: string): Promise<HTMLElement> {
  return await waitFor(() => {
    const el =
      screen.queryByRole('combobox', { name: field }) ??
      screen.queryByRole('button', { name: field })
    if (el === null) throw new Error(`no picker labelled ${field}`)
    return el
  })
}

/** Opens a Selector and picks one of its options. */
async function pick(field: string, option: string | RegExp): Promise<void> {
  const el = await pickerTrigger(field)
  act(() => { el.click() })
  const choice = await screen.findByRole('option', { name: option })
  act(() => { choice.click() })
}

/**
 * The whole add-a-leg round trip, now that the form lives in a dialog: open it
 * ("Add leg"), type the strike, flip to Sell, submit ("Add to proposal") and
 * close ("Done"). Hoisted like `fireStrike`, so the overlay tests above the
 * definition read as the gestures they make.
 */
async function addSellLeg(strike: number): Promise<void> {
  await press('Add leg')
  await fireStrike(strike)
  await press('Sell')
  await press('Add to proposal')
  await press('Done')
}

/** The before/after block, addressed as the landmark it is. */
function thePair(): HTMLElement {
  return screen.getByRole('group', { name: /before and after/i })
}

// ==========================================================================
//  FIX ROUND 1 — what a second search, an off-chain strike and a partial
//  load do to figures that are read as if they were about the plan in front
//  of you.
// ==========================================================================

/** A different first plan for REDUCE-LOSS on the SECOND search. */
const PLAN_LATER = {
  goal: 'REDUCE-LOSS',
  moves: [{ op: 'add', strike: 390, type: 'PE', qty: -LOT }],
  score: { ...SCORE, credit: 3100, maxLoss: -52_000 },
  flags: [],
}

describe('a second search', () => {
  test('never leaves one plan\'s load echo under another', async () => {
    /*
      THE CARDS USED TO BE KEYED `goal#index`, WHICH IS A POSITION AND NOT AN
      IDENTITY. Search again on a book that has moved and the engine's first
      REDUCE-LOSS plan is a different trade — under which the previous plan's
      "loaded into the overlay" claim simply stayed, telling an operator that
      the fourth line on the chart is a plan it has nothing to do with.
    */
    await suggest({
      repairs: [REPAIR, { ...REPAIR, goals: [{ goal: 'REDUCE-LOSS', plans: [PLAN_LATER] }] }],
    })
    await press('Load into overlay: buy 1 lot 400PE')
    expect(within(planCard(/400PE/)).getByText(/loaded/i)).toBeTruthy()

    await press('Search again')
    const fresh = planCard(/390PE/)
    expect(within(fresh).queryByText(/loaded/i)).toBe(null)
    // …and it is not merely hidden: the plan it belonged to is gone.
    expect(screen.queryByRole('group', { name: /400PE/ })).toBe(null)
  })
})

describe('a leg the chain could not price', () => {
  test('is listed, and the sentence saying it is NOT in the figures sits with them', async () => {
    /*
      AN OFF-CHAIN STRIKE IS ACCEPTED BY THE EDITOR ON PURPOSE — a repair plan
      can name one, and a picker built from the book's own strikes could not
      express one. The failure is what happens next: `applyMoves` DROPS a leg
      it cannot price, so the proposal row says "Sell 1 lot 721CE" while the
      pair beside it is the unchanged book, identical to "now". The bridge says
      so — several screens down, under a heading about the payoff. It has to be
      where the contradiction is.
    */
    const dropped =
      '721CE: the chain carries no price for it, so this leg was NOT included in the curves below'
    await suggest({
      whatif: {
        current: VIEW.summary,
        dropped: [dropped],
        combined: { ...PAYOFF, view: VIEW, warnings: [RESPONSE_WARNING, dropped] },
      },
    })
    await addSellLeg(721)
    expect(await screen.findByText('Sell 1 lot 721CE')).toBeTruthy()
    // The two columns are the same book, which is exactly what needs a caption.
    expect((await theCell('Floor now')).textContent).toContain('-73,250')
    expect((await theCell('Floor if placed')).textContent).toContain('-73,250')
    expect(within(thePair()).getByText(dropped)).toBeTruthy()
    /*
      AND ONLY THE PROPOSAL'S OWN SENTENCES. The combined envelope repeats every
      book-level warning the payoff already carries; echoing those here would
      bury the one sentence this block exists to show.
    */
    expect(within(thePair()).queryByText(RESPONSE_WARNING)).toBe(null)
    expect(screen.getByText(RESPONSE_WARNING)).toBeTruthy()
  })
})

// ==========================================================================
//  THE FOLD, THE TEASER, AND WHAT A FOLDED PANEL COSTS
// ==========================================================================

/** The panel under the provider its re-auth prompt needs. See `renderPanel`. */
function panelFor(tag: string): React.ReactElement {
  return (
    <AuthProvider>
      <PayoffPanel tag={tag} mode="paper" />
    </AuthProvider>
  )
}

/** The whole cockpit's network, without the unfolding `mountDesk` does. */
function mountFolded(): SentRequest[] {
  const sent = installFetch(({ path }) =>
    path === '/v1/desk/payoff' ? { body: PAYOFF } : { body: {} },
  )
  render(panelFor('BHEL_RELIEF'))
  return sent
}

describe('the fold', () => {
  test('it ships closed, and says nothing about a book it has not read', async () => {
    const sent = mountFolded()
    const row = screen.getByRole('button', { name: /Payoff & repair/ })
    // Before any answer the row is the title and nothing else: a teaser of
    // dashes would claim the panel had been read and found empty.
    expect(row.textContent).toBe('Payoff & repair')
    expect(screen.queryByText('Floor')).toBe(null)
    expect(screen.queryByText(/Reading this book/)).toBe(null)
    expect(screen.queryByText('Machine mind')).toBe(null)
    await act(async () => { await Promise.resolve() })
    // AND IT ASKED FOR NOTHING. Every payoff GET solves the chain, prices 121
    // points on three dates and scans the realised journal; a book page nobody
    // has opened the curve on must not spend that once a minute.
    expect(to(sent, '/v1/desk/payoff')).toHaveLength(0)
  })

  test('it polls while open, stops dead when folded, and resumes when opened again', async () => {
    /*
      THE LOAD PROPERTY, ASSERTED RATHER THAN ASSUMED. A body that merely hid
      would keep its interval and keep paying for it, and nothing on the screen
      would say so — the whole reason the panel unmounts its body instead.
    */
    vi.useFakeTimers()
    try {
      const sent = mountFolded()
      const reads = (): number => to(sent, '/v1/desk/payoff').length
      await act(async () => { await vi.advanceTimersByTimeAsync(120_000) })
      expect(reads()).toBe(0)

      openPanel()
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      expect(reads()).toBe(1)
      // Two more minutes, at the panel's own 60s cadence.
      await act(async () => { await vi.advanceTimersByTimeAsync(120_000) })
      expect(reads()).toBe(3)

      const atFold = reads()
      openPanel()
      await act(async () => { await vi.advanceTimersByTimeAsync(600_000) })
      expect(reads()).toBe(atFold)

      openPanel()
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      expect(reads()).toBe(atFold + 1)
    } finally {
      vi.useRealTimers()
    }
  })

  test('folded after a read, the row still carries the floor and the breakeven band', async () => {
    /*
      THE TWO FIGURES SOMEBODY WOULD UNFOLD IT FOR. Keeping the last summary is
      free — it is already in hand — and it is the difference between a fold
      that saves a screen and one that hides the answer.
    */
    mount(PAYOFF)
    await screen.findByText('Floor')
    openPanel()
    expect(screen.queryByText('Floor')).toBe(null)
    const row = screen.getByRole('button', { name: /Payoff & repair/ })
    expect(row.textContent).toContain('-73,250')
    expect(row.textContent).toContain('421.40 \u2013 452.75')
  })

  test('the choice is remembered, and it is ONE choice for every book', async () => {
    /*
      A PREFERENCE ABOUT THE SCREEN, not about a tag. Per-book state would open
      the panel on the book you last used it on and close it on the next tab
      along, which reads as a toggle that does not stick — and would grow an
      entry per book forever on a desk that opens a new tag every expiry.
    */
    installFetch(({ path }) => (path === '/v1/desk/payoff' ? { body: PAYOFF } : { body: {} }))
    const first = render(panelFor('BHEL_RELIEF'))
    openPanel()
    expect(await screen.findByText('Floor')).toBeTruthy()
    expect(window.localStorage.getItem('desk.payoff.open')).toBe('1')

    first.unmount()
    render(panelFor('A_DIFFERENT_BOOK'))
    // Open on arrival, on a book this panel has never been opened on before.
    expect(await screen.findByText('Floor')).toBeTruthy()
  })

  test('the machine card is folded too, and folded means not in the document', async () => {
    /*
      NOT `display: none`. A hidden card is still found by "search this page"
      and still read out by a screen reader walking the DOM, which is not what
      "folded away" promises.
    */
    mount(PAYOFF)
    await screen.findByText('Floor')
    expect(screen.getByRole('button', { name: 'Machine mind' })).toBeTruthy()
    expect(screen.queryByText(NOTE_ARMED)).toBe(null)
    expect(screen.queryByText('Delta tolerance')).toBe(null)
    await openMachine()
    expect(screen.getByText(NOTE_ARMED)).toBeTruthy()
    expect(screen.getByText('Delta tolerance')).toBeTruthy()
  })
})

// ==========================================================================
//  HOW THE MENU AND THE EDITOR ARE LAID OUT
// ==========================================================================

describe('the shape of the repair menu', () => {
  test("a goal's plans are grid items, so three sit abreast rather than stacked", async () => {
    /*
      A goal serves at most three plans and they used to stack full-width, two
      thirds of every row empty — one goal filling a screen, four of them
      filling four. The count in `.plan-grid` is exact rather than fitted.
    */
    await suggest()
    expect(planCard(/720CE/).parentElement?.className).toContain('plan-grid')
    expect(planCard(/400PE/).parentElement?.className).toContain('plan-grid')
    // And the score figures are the card's own divided stat block, not an
    // inline row of footnote-sized text under the moves.
    expect(within(planCard(/720CE/)).getByText('credit').parentElement?.parentElement?.parentElement?.className)
      .toContain('plan-stat-grid')
  })

  test("a leg id's disambiguator is set beside the sentence, never welded into it", async () => {
    /*
      `applyMoves` suffixes a generated leg `#2` when the book already holds
      that id, and the suffix leaked into the human line: "Close
      TCS26AUG2380CE#2", a uniqueness counter in the middle of a contract an
      operator reads down the phone. It is which of two legs, so it is kept —
      muted, beside the sentence. The ARIA name keeps the whole id, because a
      control that addresses one of two identical legs may not be ambiguous.
    */
    const twin = {
      goal: 'REDUCE-LOSS',
      moves: [{ op: 'close', legId: 'BHEL26AUG445CE#2' }],
      score: SCORE,
      flags: [],
    }
    await suggest({ repair: { ...REPAIR, goals: [{ goal: 'REDUCE-LOSS', plans: [twin] }] } })
    // The CONTRACT is formatted and the counter is not part of it — but the
    // counter still rides with the id everywhere the id is an address.
    const card = planCard(/Close BHEL 445 CE#2/)
    expect(within(card).getByText('Close BHEL 445 CE')).toBeTruthy()
    expect(within(card).getByText('#2')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Apply: close BHEL 445 CE#2' })).toBeTruthy()
  })
})

describe('the shape of the what-if editor', () => {
  test('two identical adds are ONE row at the summed size — and both still go over', async () => {
    /*
      Pressing "Add leg" four times is how a proposal is sized up, and it
      produced four near-identical rows down the left of an empty half-screen.
      What is proposed is one contract at four lots, which is also what the
      curve beside it was drawn from. The WIRE is untouched: every leg the panel
      was given is still posted, which is what keeps the summed row honest.
    */
    const sent = await suggest()
    await press('Add leg')
    await fireStrike(720)
    await press('Sell')
    await press('Add to proposal')
    await screen.findByText('Expiry, if placed')
    await press('Add to proposal')
    await press('Done')

    expect(await screen.findByText('Sell 2 lots 720CE')).toBeTruthy()
    expect(screen.getByText('\u00d72')).toBeTruthy()
    const posted = to(sent, '/v1/desk/payoff/whatif')
    expect(posted).toHaveLength(2)
    expect(posted[1]?.body?.['proposed']).toEqual([
      { strike: 720, type: 'CE', qty: -LOT },
      { strike: 720, type: 'CE', qty: -LOT },
    ])
  })

  test('Remove takes the whole aggregated row, which is what the row shows', async () => {
    /*
      Popping ONE increment off a row that only ever prints its total would
      change the figure on screen to a number nobody typed. The accessible name
      carries the summed size for the same reason.
    */
    await suggest()
    await press('Add leg')
    await fireStrike(720)
    await press('Sell')
    await press('Add to proposal')
    await screen.findByText('Expiry, if placed')
    await press('Add to proposal')
    await press('Done')
    await screen.findByText('Sell 2 lots 720CE')
    await press('Remove Sell 2 lots 720CE')
    expect(screen.queryByText('Sell 2 lots 720CE')).toBe(null)
    expect(screen.queryByText('Expiry, if placed')).toBe(null)
  })

  test('the leg dialog pre-fills the fill price from the chain, like the order form', async () => {
    /*
      THE MANUAL-ORDER DIALOG'S ONE GENUINELY BETTER IDEA, borrowed whole: while
      the dialog is open the book's own chain is read (`api.chain`, the same
      request the place-order form makes) and the fill box arrives holding the
      picked contract's quote via the same `prefillPrice`. The chain's marks sit
      beside the strike too, so the operator sees what the box was filled FROM.
    */
    installFetch(({ path }) => {
      if (path === '/v1/desk/payoff') return { body: PAYOFF }
      if (path === '/v1/desk/repair') return { body: REPAIR }
      if (path === '/v1/desk/payoff/whatif') return { body: WHATIF }
      if (path.startsWith('/v1/desk/chain/')) {
        return {
          body: {
            spot: 415.2,
            future: 419,
            rows: [{
              strike: 720,
              CE: { price: 12.35, ageMs: 1200, bid: 12.3, ask: 12.4 },
              PE: { price: 8.1, ageMs: 1200 },
            }],
          },
        }
      }
      return { body: {} }
    })
    renderPanel()
    await screen.findByText('Floor')
    await press('Suggest repairs')
    await press('Add leg')
    // PICKED, NOT TYPED — the chain answered, so the strike is a Selector row
    // carrying the marks it would fill from. No free number box in sight.
    await pick('Strike', '720 · CE 12.35 · PE 8.10')
    expect(screen.queryByRole('spinbutton', { name: /Strike/ })).toBe(null)
    // The mid lands in the box — and the note prints the pair it came from.
    expect(await screen.findByDisplayValue('12.35')).toBeTruthy()
    expect(screen.getByText('mid of 12.30 / 12.40')).toBeTruthy()
  })

  test('a live book beats a stale print: the mid still pre-fills, aged honestly', async () => {
    /*
      TCS 1820PE, the report that built this: last trade 409s old — the old
      rule left the box empty — while the 0.20/0.24 book was the market. A
      two-sided quote pre-fills its MID whatever the tick's age, and the note
      says both what it came from and how old the book is. An LTP-ONLY quote
      keeps the 60s refusal: a lone stale print is too little to price from.
    */
    installFetch(({ path }) => {
      if (path === '/v1/desk/payoff') return { body: PAYOFF }
      if (path === '/v1/desk/repair') return { body: REPAIR }
      if (path.startsWith('/v1/desk/chain/')) {
        return {
          body: {
            spot: 415.2,
            future: 419,
            rows: [{
              strike: 1820,
              CE: { price: 3.15, ageMs: 409_000 },
              PE: { price: 0.22, ageMs: 409_000, bid: 0.2, ask: 0.24 },
            }],
          },
        }
      }
      return { body: {} }
    })
    renderPanel()
    await screen.findByText('Floor')
    await press('Suggest repairs')
    await press('Add leg')
    await pick('Strike', /1820/)
    await press('PE')
    expect(await screen.findByDisplayValue('0.22')).toBeTruthy()
    expect(screen.getByText('mid of 0.20 / 0.24 — book 409s old')).toBeTruthy()
    // The CE side has no book — its stale print still refuses, in words.
    await press('CE')
    expect(await screen.findByText(/last trade 409s ago — too stale/)).toBeTruthy()
  })

  test('the lot size comes off the chain — no repair search required', async () => {
    /*
      The dials only learn the lot size from a repair search, but the
      instrument master has always known it and the chain serves it. First
      dialog open teaches the editor, and it KEEPS it: the Lots box and the
      proposal chips speak lots even after the dialog closes.
    */
    installFetch(({ path }) => {
      if (path === '/v1/desk/payoff') return { body: PAYOFF }
      if (path === '/v1/desk/repair') return { body: { ...REPAIR, dials: {} } }
      if (path === '/v1/desk/payoff/whatif') return { body: WHATIF_CLEAN }
      if (path.startsWith('/v1/desk/chain/')) {
        return {
          body: {
            spot: 415.2,
            future: 419,
            lotSize: 225,
            rows: [{ strike: 720, CE: { price: 12.35, ageMs: 1200 }, PE: { price: 8.1, ageMs: 1200 } }],
          },
        }
      }
      return { body: {} }
    })
    renderPanel()
    await screen.findByText('Floor')
    await press('Suggest repairs')
    await press('Add leg')
    expect(await screen.findByText('1 lot = 225 shares')).toBeTruthy()
    await pick('Strike', /720/)
    await press('Sell')
    await press('Add to proposal')
    await press('Done')
    // The chip speaks LOTS — and carries the mark the box pre-filled.
    expect(await screen.findByText('Sell 1 lot 720CE at 12.35')).toBeTruthy()
  })

  test('the leg dialog says what the whole position nets to, per side', async () => {
    /*
      A WING IS STEERED BY THE NET, and the net lived nowhere near this dialog:
      book legs (the positions read the manual-order dialog already makes) plus
      the proposal on the list, per option type, in lots. "Unread" renders as
      NOTHING — a net line computed from the proposal alone would print
      "CE flat" over a book that is short four lots of them.
    */
    const sent = installFetch(({ path }) => {
      if (path === '/v1/desk/payoff') return { body: PAYOFF }
      if (path === '/v1/desk/repair') return { body: REPAIR }
      if (path === '/v1/desk/payoff/whatif') return { body: WHATIF_CLEAN }
      if (path === '/v1/desk/positions') {
        return {
          body: {
            legs: [
              { instrument: { tradingsymbol: 'BHEL26AUG445CE' }, qty: -2 * LOT },
              { instrument: { tradingsymbol: 'BHEL26AUG415PE' }, qty: -LOT },
            ],
          },
        }
      }
      return { body: {} }
    })
    renderPanel()
    await screen.findByText('Floor')
    await press('Suggest repairs')
    await press('Add leg')
    // Book alone: short two lots of calls, one of puts.
    expect(await screen.findByText('Net with proposal — CE sell 2 lots · PE sell 1 lot')).toBeTruthy()
    // A proposed buy of one call lot folds in: the CE side nets down to one.
    await fireStrike(720)
    await press('Add to proposal')
    expect(await screen.findByText('Net with proposal — CE sell 1 lot · PE sell 1 lot')).toBeTruthy()
    expect(to(sent, '/v1/desk/payoff/whatif')).toHaveLength(1)
  })
})
