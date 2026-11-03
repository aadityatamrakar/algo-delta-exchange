/**
 * Human-readable contract names for table cells.
 *
 * `DLF26AUG600PE` is the exchange's packing, not a name anyone reads under
 * pressure: the strike — the one number the operator is scanning for — is
 * glued between a year and an option type. The desk trades the CURRENT expiry
 * only (operator's call, 2026-08-04), so the expiry is dropped rather than
 * reformatted: `DLF 600 PE`.
 *
 * DISPLAY ONLY. Everything keyed, joined or submitted stays on the raw
 * tradingsymbol; this renders at the last moment, in the cell.
 */

const MONTHS = 'JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC'

/** SYMBOL + YY + MMM + STRIKE + CE/PE — the monthly option packing. */
const MONTHLY = new RegExp(`^([A-Z0-9&-]+?)(\\d{2})(?:${MONTHS})(\\d+(?:\\.\\d+)?)(CE|PE)$`)

/**
 * SYMBOL + YY + M + DD + STRIKE + CE/PE — the weekly packing, where the month
 * is one character: 1-9, then O, N, D for Oct-Dec. Tried AFTER the monthly
 * form: the two cannot both match, but the monthly is the common case here.
 */
const WEEKLY = new RegExp(`^([A-Z0-9&-]+?)(\\d{2})([1-9OND])(\\d{2})(\\d+(?:\\.\\d+)?)(CE|PE)$`)

/** SYMBOL + YY + MMM + FUT. */
const FUTURE = new RegExp(`^([A-Z0-9&-]+?)(\\d{2})(?:${MONTHS})FUT$`)

/**
 * DELTA EXCHANGE: `C-BTC-76600-041126` — C/P, underlying, strike, DDMMYY.
 *
 * Unlike the NSE packings the EXPIRY IS KEPT on screen: a DX book trades
 * dailies, weeklies and monthlies side by side, so "BTC 76600 CE" names three
 * different contracts.
 */
const DELTA = /^([CP])-([A-Z0-9]+)-(\d+(?:\.\d+)?)-(\d{2})(\d{2})(\d{2})$/

const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** What an exchange packing decomposes into. `strike` is null for a future. */
export interface ParsedContract {
  readonly underlying: string
  readonly strike: number | null
  readonly type: 'CE' | 'PE' | 'FUT'
  /** `YYYY-MM-DD`, present only for a packing that carries its full date (Delta). */
  readonly expiry?: string
}

/** The Delta symbol for a leg: `deltaSymbol('BTC', 76600, 'CE', '2026-11-04')` → `C-BTC-76600-041126`. */
export function deltaSymbol(underlying: string, strike: number, type: 'CE' | 'PE', expiry: string): string {
  const [y, m, d] = expiry.split('-')
  return `${type === 'CE' ? 'C' : 'P'}-${underlying}-${strike}-${d ?? ''}${m ?? ''}${(y ?? '').slice(2)}`
}

/**
 * Pull the underlying, strike and option type back out of a packing.
 *
 * `null` for anything this file does not recognise — an equity, an index, or a
 * packing the exchange has since changed. Callers must handle that rather than
 * defaulting, because the two consumers treat it differently: the formatter
 * shows the raw symbol, the ladder sort files it at the bottom.
 *
 * `formatContract` is DERIVED FROM THIS rather than parsing separately, so the
 * name on screen and the strike a row is sorted by can never disagree about
 * what the symbol means.
 */
export function parseContract(tradingsymbol: string): ParsedContract | null {
  const s = tradingsymbol.trim().toUpperCase()

  const delta = DELTA.exec(s)
  if (delta !== null) {
    return {
      underlying: delta[2] as string,
      strike: Number(delta[3]),
      type: delta[1] === 'C' ? 'CE' : 'PE',
      expiry: `20${delta[6] as string}-${delta[5] as string}-${delta[4] as string}`,
    }
  }

  const monthly = MONTHLY.exec(s)
  if (monthly !== null) {
    return {
      underlying: monthly[1] as string,
      strike: Number(monthly[3]),
      type: monthly[4] as 'CE' | 'PE',
    }
  }

  const future = FUTURE.exec(s)
  if (future !== null) return { underlying: future[1] as string, strike: null, type: 'FUT' }

  const weekly = WEEKLY.exec(s)
  if (weekly !== null) {
    return {
      underlying: weekly[1] as string,
      strike: Number(weekly[5]),
      type: weekly[6] as 'CE' | 'PE',
    }
  }

  return null
}

/** `DLF26AUG600PE` -> `DLF 600 PE`; anything unrecognised comes back as-is. */
export function formatContract(tradingsymbol: string): string {
  const parsed = parseContract(tradingsymbol)
  // An equity, an index, or a packing this file does not know: showing the
  // raw symbol is strictly better than guessing at one.
  if (parsed === null) return tradingsymbol
  if (parsed.type === 'FUT') return `${parsed.underlying} FUT`
  if (parsed.expiry !== undefined) {
    const [, m, d] = parsed.expiry.split('-')
    return `${parsed.underlying} ${d ?? ''} ${MONTH_SHORT[Number(m) - 1] ?? m ?? ''} ${parsed.strike} ${parsed.type}`
  }
  return `${parsed.underlying} ${parsed.strike} ${parsed.type}`
}
