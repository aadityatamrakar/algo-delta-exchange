/**
 * The Build-book screen's master-backed fields.
 *
 * What is pinned here is that symbol, expiry and lot size come from the
 * instrument master — and the preset from the engine's own list — rather than
 * from an operator's memory, that the screen still works when the master
 * cannot be read, and that a registered row carries its preset's whole
 * dial-set. Nothing about the entry sequence is exercised: that is
 * `entry-plan.test.ts`.
 */
import { expect, test, describe } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { BookBuildPage } from '../src/book-build.tsx'
import { AuthProvider } from '../src/auth.tsx'
import type { DeskMode } from '../src/api.ts'
import { installFetch, type SentRequest } from './http.tsx'

const UNDERLYINGS = ['BAJFINANCE', 'BHEL', 'NIFTY']

/**
 * BAJFINANCE's lot size is deliberately NOT the 750 the field starts at, so
 * "the box reads 900" can only be true if the master was actually read.
 *
 * The two symbols SHARE 2026-08-25 and differ everywhere else, which is the
 * case that made the lot size worth keying on the symbol as well as the expiry:
 * switching symbol without changing the date must still re-read it.
 */
const CHAINS: Readonly<Record<string, { expiries: string[]; lotSize: number }>> = {
  BAJFINANCE: { expiries: ['2026-08-25', '2026-09-24'], lotSize: 900 },
  BHEL: { expiries: ['2026-08-25', '2026-10-29'], lotSize: 2625 },
}

/*
  NO VARIANT-CATALOGUE FIXTURE. The preset list is compiled in from
  `@algomaker/desk-engine`, so there is nothing for the double to serve and
  nothing for a test to disagree with the deployment about.
*/
function mount(
  extra?: (path: string, method: string) => { body?: unknown; status?: number } | null,
  mode: DeskMode = 'paper',
): SentRequest[] {
  const sent = installFetch(({ path, url, method }) => {
    const custom = extra?.(path, method)
    if (custom !== null && custom !== undefined) return custom
    if (path === '/v1/desk/instruments' && method === 'GET') {
      return { body: { underlyings: UNDERLYINGS } }
    }
    const named = /^\/v1\/desk\/instruments\/(.+)$/.exec(path)
    if (named !== null && method === 'GET') {
      const underlying = decodeURIComponent(named[1] as string)
      const chain = CHAINS[underlying]
      if (chain === undefined) {
        return { status: 404, body: { error: `no listed expiries for '${underlying}'` } }
      }
      const expiry = url.searchParams.get('expiry') ?? (chain.expiries[0] as string)
      if (!chain.expiries.includes(expiry)) {
        return { status: 404, body: { error: `no chain for ${underlying} ${expiry}` } }
      }
      return {
        body: {
          underlying, expiry, lotSize: chain.lotSize, tickSize: 0.05, exchange: 'NFO',
          strikeStep: 10, strikes: [1000, 1010, 1020], expiries: chain.expiries,
        },
      }
    }
    return { body: {} }
  })
  // AuthProvider because the page owns the re-auth prompt now: recording a
  // LIVE book's legs is password-gated by the server (F-30).
  render(
    <AuthProvider>
      <BookBuildPage mode={mode} />
    </AuthProvider>,
  )
  return sent
}

/**
 * The thing you click to open a picker.
 *
 * Queried under TWO roles because astryx gives a Selector two different ones:
 * a plain Selector's trigger IS the `combobox`, but a searchable one moves that
 * role onto the search input inside the popover and leaves the trigger a
 * `button`. Pinning either role alone would make this suite depend on whether
 * the Symbol field happens to have search turned on.
 */
async function trigger(field: string): Promise<HTMLElement> {
  return await waitFor(() => {
    const el =
      screen.queryByRole('combobox', { name: field }) ??
      screen.queryByRole('button', { name: field })
    if (el === null) throw new Error(`no picker labelled ${field}`)
    return el
  })
}

/** Opens a Selector and picks one of its options. */
async function pick(field: string, option: string): Promise<void> {
  const el = await trigger(field)
  act(() => { el.click() })
  const choice = await screen.findByRole('option', { name: option })
  act(() => { choice.click() })
}

const lotSizeBox = (): HTMLInputElement =>
  screen.getByRole('textbox', { name: 'Lot size' }) as HTMLInputElement

describe('symbol and expiry are picked, not typed', () => {
  test('the symbol field offers what the master lists, and is not a text box', async () => {
    mount()
    const el = await trigger('Symbol')
    expect(screen.queryByRole('textbox', { name: 'Symbol' })).toBe(null)
    act(() => { el.click() })
    for (const u of UNDERLYINGS) await screen.findByRole('option', { name: u })
  })

  test('the expiry list is the chosen symbol\'s, refreshed when the symbol changes', async () => {
    mount()
    // BAJFINANCE's own expiries first.
    await pick('Expiry', '2026-09-24')
    await pick('Symbol', 'BHEL')

    const expiryTrigger = await trigger('Expiry')
    act(() => { expiryTrigger.click() })
    await screen.findByRole('option', { name: '2026-10-29' })
    // The previous symbol's date is GONE — a list that did not refresh would
    // still offer it, and it does not list for BHEL.
    expect(screen.queryByRole('option', { name: '2026-09-24' })).toBe(null)
  })

  test('an expiry the operator already chose survives a symbol that also lists it', async () => {
    mount()
    await pick('Expiry', '2026-08-25')
    await pick('Symbol', 'BHEL')
    const expiryTrigger = await trigger('Expiry')
    await waitFor(() => expect(expiryTrigger.textContent).toContain('2026-08-25'))
  })
})

describe('the lot size is filled from the master, before Resolve', () => {
  test('it arrives without pressing anything, and is not the hardcoded default', async () => {
    const sent = mount()
    await waitFor(() => expect(lotSizeBox().value).toBe('900'))
    // Nothing was resolved: `Resolve legs` is what used to be the first moment
    // this number was correct, and it has not been pressed.
    expect(sent.some((r) => r.path.startsWith('/v1/desk/chain/'))).toBe(false)
  })

  test('it re-reads on a symbol change even when the expiry date is unchanged', async () => {
    mount()
    await waitFor(() => expect(lotSizeBox().value).toBe('900'))
    await pick('Symbol', 'BHEL')
    // Same date, different contract: keyed on the expiry alone this would still
    // read 900, and every Place would size against the wrong divisor.
    await waitFor(() => expect(lotSizeBox().value).toBe('2625'))
  })
})

describe('the screen stays usable when the master cannot be read', () => {
  test('an unreadable underlyings list falls back to typing the symbol', async () => {
    mount((path, method) =>
      path === '/v1/desk/instruments' && method === 'GET'
        ? { status: 503, body: { error: 'instrument master unavailable' } }
        : null,
    )
    const box = await screen.findByRole('textbox', { name: 'Symbol' })
    expect((box as HTMLInputElement).value).toBe('BAJFINANCE')
    expect(screen.queryByRole('button', { name: 'Symbol' })).toBe(null)
  })

  test('a symbol with no listed expiries falls back to typing the expiry', async () => {
    mount((path) =>
      path.startsWith('/v1/desk/instruments/')
        ? { status: 404, body: { error: 'no listed expiries' } }
        : null,
    )
    await screen.findByRole('textbox', { name: 'Expiry' })
    // The symbol picker is unaffected — only the list that failed degrades.
    await trigger('Symbol')
  })

  /**
   * THE PRESET PICKER HAS NOTHING TO FAIL. It used to read the published
   * variant catalogue and degrade to a text box when that read failed; the
   * twelve dial-sets are compiled in now, so a dead bridge cannot take the
   * field with it — and the screen never asks for the catalogue at all.
   */
  test('the preset picker survives a bridge that answers nothing', async () => {
    const sent = mount(() => ({ status: 503, body: { error: 'the bridge is down' } }))
    await trigger('Preset')
    expect(screen.queryByRole('textbox', { name: 'Preset' })).toBe(null)
    expect(sent.some((r) => r.path === '/v1/desk/variants')).toBe(false)
  })
})

describe('the preset is picked from the engine, and it is a PREFILL', () => {
  test('it offers the engine presets, and is not a text box', async () => {
    mount()
    const el = await trigger('Preset')
    expect(screen.queryByRole('textbox', { name: 'Preset' })).toBe(null)
    act(() => { el.click() })
    await screen.findByRole('option', { name: 'recenter-r (Recenter)' })
    await screen.findByRole('option', { name: 'recenter-relief-r (Relief (live))' })
  })

  test('the chosen preset is what the tag is built from', async () => {
    mount()
    await screen.findByText('tag: BAJFINANCE-2026-08-25-recenter-r')
    await pick('Preset', 'recenter-relief-r (Relief (live))')
    await screen.findByText('tag: BAJFINANCE-2026-08-25-recenter-relief-r')
  })

  /**
   * THE ROW IS CREATED WITH THE PRESET'S WHOLE DIAL-SET.
   *
   * The single most expensive thing this screen can get wrong. A row carrying
   * only the three boxes on screen resolves every other dial against the
   * ENGINE DEFAULT — the relief-r live set — so a book created as `recenter-r`
   * would run relief's margin-gated shift and nothing would ever say so.
   */
  test('registering copies the preset dials onto the row, with the boxes winning', async () => {
    const sent = mount((path, method) =>
      path.startsWith('/v1/desk/chain/') && method === 'GET'
        ? {
            body: {
              spot: 1005,
              future: 1006,
              rows: [{
                strike: 1000,
                CE: { price: 12, ageMs: 200 },
                PE: { price: 9, ageMs: 200 },
                ceContract: { tradingsymbol: 'BAJFIN26AUG1000CE', instrumentToken: 111 },
                peContract: { tradingsymbol: 'BAJFIN26AUG1000PE', instrumentToken: 112 },
              }],
            },
          }
        : null,
    )
    await screen.findByText('tag: BAJFINANCE-2026-08-25-recenter-r')
    const legs = document.querySelector('textarea')
    if (legs === null) throw new Error('no legs box')
    fireEvent.change(legs, { target: { value: '1000CE -900' } })
    act(() => { screen.getByRole('button', { name: 'Resolve legs' }).click() })
    await screen.findByText('2 · Register the book')
    act(() => { screen.getByRole('button', { name: 'Register' }).click() })

    await waitFor(() => {
      const post = sent.find((r) => r.path === '/v1/desk/books/registry' && r.method === 'POST')
      expect(post).toBeTruthy()
      const dials = post?.body?.['dials'] as Record<string, unknown>
      // recenter never shifted — inheriting relief's `shift_enabled: true` is
      // exactly the failure this assertion exists for.
      expect(dials['shift_enabled']).toBe(false)
      expect(dials['unwind_enabled']).toBe(true)
      // The box wins over the preset's own 250000.
      expect(dials['target_pnl']).toBe(60000)
      expect(post?.body?.['variant']).toBe('recenter-r')
      /**
       * AND `lot_size` IS NOT AMONG THEM (D9). It was never an engine dial —
       * only the retired Python supervisor read it — and writing it put a
       * permanent F-29 warning on every book this screen created: "Stored on
       * this book, and not read by the engine". A banner that is always on is
       * one nobody reads, and the next thing it says will be a real retired
       * dial or a real typo.
       */
      expect(dials['lot_size']).toBeUndefined()
    })
  })
})

/**
 * THE RECORD STEP ASKS FOR THE PASSWORD ON THE LIVE RAIL (F-30).
 *
 * `POST /v1/desk/seed` writes what the desk believes the account holds, and the
 * server now re-authenticates it in live. This screen is where that matters
 * most: by the time Record is reachable the entry orders have ALREADY gone to
 * the broker, so a 403 the operator cannot answer would leave a real position
 * with no book behind it.
 */
describe('recording a LIVE book asks for the password', () => {
  /** The re-auth dialog's own heading — see `useReauth`. */
  const PROMPT = 'Confirm with your password'
  const TS = 'BAJFIN26AUG1000CE'

  /** A chain with one priced strike, so Resolve fills a limit in by itself. */
  const chainReply = {
    body: {
      spot: 1005,
      future: 1006,
      rows: [{
        strike: 1000,
        CE: { price: 12, ageMs: 200 },
        PE: { price: 9, ageMs: 200 },
        ceContract: { tradingsymbol: TS, instrumentToken: 111 },
        peContract: { tradingsymbol: 'BAJFIN26AUG1000PE', instrumentToken: 112 },
      }],
    },
  }

  /** Resolve → Register → Place, leaving the Record button live. */
  async function toRecordStep(sent: SentRequest[]): Promise<void> {
    const legs = document.querySelector('textarea')
    if (legs === null) throw new Error('no legs box')
    // ONE short leg, a whole lot of BAJFINANCE's 900.
    fireEvent.change(legs, { target: { value: '1000CE -900' } })
    act(() => { screen.getByRole('button', { name: 'Resolve legs' }).click() })
    await screen.findByText('2 · Register the book')

    act(() => { screen.getByRole('button', { name: 'Register' }).click() })
    await waitFor(() =>
      expect(sent.some((r) => r.path === '/v1/desk/books/registry' && r.method === 'POST')).toBe(true))

    await waitFor(() => expect(screen.getByRole('button', { name: 'Place' })).toBeTruthy())
    act(() => { screen.getByRole('button', { name: 'Place' }).click() })
    await waitFor(() => expect(sent.some((r) => r.path === '/v1/desk/submit')).toBe(true))
    await screen.findByText('All legs filled. The book will be seeded at the prices that actually filled.')
  }

  function mountLive(): SentRequest[] {
    return mount((path, method) => {
      if (path.startsWith('/v1/desk/chain/') && method === 'GET') return chainReply
      if (path === '/v1/desk/submit' && method === 'POST') {
        return { body: { accepted: true, status: 'ROUTED', clientOrderId: 'c-1', routedLots: 1, intendedLots: 1 } }
      }
      if (path === '/v1/desk/seed' && method === 'POST') return { body: { booked: [], unresolved: [] } }
      return null
    }, 'live')
  }

  test('the prompt opens before the seed, and the password goes with it', async () => {
    const sent = mountLive()
    await toRecordStep(sent)

    act(() => { screen.getByRole('button', { name: 'Record the book' }).click() })
    const dialog = await screen.findByRole('dialog', { name: PROMPT })
    expect(within(dialog).getByText(/LIVE book/)).toBeTruthy()
    // NOTHING was seeded while the prompt is open.
    expect(sent.some((r) => r.path === '/v1/desk/seed')).toBe(false)

    fireEvent.change(within(dialog).getByLabelText('Password'), { target: { value: 'hunter2' } })
    act(() => { within(dialog).getByRole('button', { name: 'Confirm' }).click() })

    await waitFor(() => expect(sent.some((r) => r.path === '/v1/desk/seed')).toBe(true))
    const seed = sent.find((r) => r.path === '/v1/desk/seed')
    expect(seed?.body).toMatchObject({ mode: 'live', replace: false, password: 'hunter2' })
    expect((seed?.body?.['legs'] as unknown[]).length).toBe(1)
  })

  test('cancelling records nothing — and the button is still there to try again', async () => {
    const sent = mountLive()
    await toRecordStep(sent)

    act(() => { screen.getByRole('button', { name: 'Record the book' }).click() })
    const dialog = await screen.findByRole('dialog', { name: PROMPT })
    act(() => { within(dialog).getByRole('button', { name: 'Cancel' }).click() })

    await waitFor(() => expect(screen.queryByRole('dialog', { name: PROMPT })).toBe(null))
    expect(sent.some((r) => r.path === '/v1/desk/seed')).toBe(false)
    // The orders ARE placed and the book is not recorded — the operator must be
    // able to come straight back to it.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Record the book' })).toBeTruthy())
  })
})
