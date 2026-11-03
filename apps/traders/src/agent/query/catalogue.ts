/**
 * The query language's catalogue (spec §6.3): every dataset the assistant can
 * read, its fields with type, unit and meaning. `describe_data` hands this to
 * the model as is, and the validator checks every field a query names against
 * it — an unknown field is an error naming the valid ones.
 *
 * Rows are built by `sources.ts` from the functions the pages already use;
 * the model never sees Mongo, never writes, and only ever reads the signed-in
 * trader's rows (or market data, which is nobody's). A dataset marked
 * unavailable is listed with the reason, so the model does not guess at it.
 */

export type FieldType = 'string' | 'number' | 'boolean' | 'date' | 'datetime'

export interface FieldDef {
  readonly name: string
  readonly type: FieldType
  /** e.g. 'rupees', 'shares', 'lots', 'decimal', 'percent', 'rupees/day'. Empty when it has none. */
  readonly unit: string
  readonly description: string
}

export type ScopeParam = 'stock' | 'expiry' | 'interval' | 'days' | 'of'

export interface DatasetDef {
  readonly name: DatasetName
  readonly description: string
  readonly params: Partial<Record<ScopeParam, string>>
  readonly fields: readonly FieldDef[]
  readonly available: boolean
  readonly unavailable?: string
}

export const DATASETS = [
  'books', 'legs', 'trades', 'orders', 'portfolio_months', 'daily_bars', 'intraday_bars', 'chain', 'levels', 'band_events', 'vol',
] as const
export type DatasetName = (typeof DATASETS)[number]

/** Trades and orders reach back at most this far (spec §6.3). */
export const RECORDS_MAX_DAYS = 30
export const BAND_EVENTS_MAX_DAYS = 90
export const DAILY_BARS_DEFAULT = 60
export const DAILY_BARS_MAX = 400

const f = (name: string, type: FieldType, unit: string, description: string): FieldDef => ({ name, type, unit, description })

const contract = [
  f('stock', 'string', '', 'NSE symbol, upper case'),
  f('instrument', 'string', '', "'option', 'future' or 'share'"),
  f('expiry', 'date', '', "contract expiry YYYY-MM-DD; '' for shares"),
  f('strike', 'number', 'rupees', 'option strike; null otherwise'),
  f('optType', 'string', '', "'CE' or 'PE'; null otherwise"),
]
const greeks = [
  f('delta', 'number', 'shares', 'position delta'),
  f('gamma', 'number', 'shares per rupee', 'position gamma'),
  f('vega', 'number', 'rupees per vol point', 'position vega'),
  f('theta', 'number', 'rupees/day', 'position theta'),
]

export const CATALOGUE: readonly DatasetDef[] = [
  {
    name: 'books', available: true,
    description: "The trader's open books, one row each, as the Portfolio page shows them.",
    params: {},
    fields: [
      f('stock', 'string', '', 'NSE symbol'),
      f('spot', 'number', 'rupees', 'underlying price'),
      f('lotSize', 'number', 'shares', 'lot size of the nearest future'),
      ...greeks,
      f('deltaLots', 'number', 'lots', 'delta in lots of the nearest future'),
      f('pnl', 'number', 'rupees', "P&L: the series net, every live expiry since its first trade, after charges (booked + open legs at LTP − charges); null when an open leg has no LTP (the warnings count them) or the book holds shares only (nothing to count)"),
      f('dayMtm', 'number', 'rupees', "Day MTM: today's move (carried legs from yesterday's close, today's trades) less the charges on today's fills; null before 09:15, on a closed day, or with yesterday's close unknown; sum, avg, min and max skip nulls, so a sum is the whole only when no book is null (the warnings count them)"),
      f('openPnl', 'number', 'rupees', 'Open P&L: the open legs at the last price against their net price, before charges'),
      f('margin', 'number', 'rupees', 'NSE SPAN + exposure; null when not known'),
      f('band', 'string', '', "delta band: 'in', 'out', 'unknown' or null"),
      f('legCount', 'number', '', 'open legs'),
      f('nearExpiry', 'date', '', 'earliest expiry of an open option or future'),
      f('daysToExpiry', 'number', 'days', 'calendar days to nearExpiry'),
    ],
  },
  {
    name: 'legs', available: true,
    description: 'Open legs of every book (or params.stock). `leg` is the alias the conversation uses (L1, L2…).',
    params: { stock: 'optional: one book' },
    fields: [
      f('leg', 'string', '', 'alias of the leg in this conversation'),
      ...contract,
      f('qty', 'number', 'shares', 'signed quantity; negative = short'),
      f('lots', 'number', 'lots', 'signed lots; null when the lot size is unknown'),
      f('avgPrice', 'number', 'rupees', 'average entry price per share'),
      f('ltp', 'number', 'rupees', 'last price; null when not quoted'),
      f('iv', 'number', 'decimal', 'implied vol (0.25 = 25%); null when not solved'),
      ...greeks,
      f('openPnl', 'number', 'rupees', 'Open P&L of the leg: (last price − average price) × qty, before charges'),
      f('source', 'string', '', "'odin' (from trade files) or 'manual'"),
      f('matched', 'boolean', '', 'the contract was found in the instrument master'),
    ],
  },
  {
    name: 'trades', available: true,
    description: `Fills from the trader's ODIN trade files, newest first. params.days (default 7, at most ${RECORDS_MAX_DAYS}).`,
    params: { stock: 'optional', days: `1–${RECORDS_MAX_DAYS}, default 7` },
    fields: [
      f('day', 'date', '', 'trade day, IST'),
      f('time', 'datetime', '', 'fill time, IST YYYY-MM-DD HH:MM:SS'),
      ...contract,
      f('side', 'string', '', "'Buy' or 'Sell'"),
      f('qty', 'number', 'shares', 'quantity, positive'),
      f('price', 'number', 'rupees', 'fill price per share'),
      f('value', 'number', 'rupees', 'qty × price'),
    ],
  },
  {
    name: 'orders', available: true,
    description: `Orders from the trader's ODIN order files, newest first. params.days (default 7, at most ${RECORDS_MAX_DAYS}).`,
    params: { stock: 'optional', days: `1–${RECORDS_MAX_DAYS}, default 7` },
    fields: [
      f('day', 'date', '', 'order day, IST'),
      f('time', 'datetime', '', 'order time, IST'),
      ...contract,
      f('side', 'string', '', "'Buy' or 'Sell'"),
      f('qty', 'number', 'shares', 'ordered quantity'),
      f('price', 'number', 'rupees', 'limit price; 0 = market'),
      f('status', 'string', '', "'filled', 'open', 'cancelled', 'rejected' or 'other'"),
      f('filledQty', 'number', 'shares', 'filled quantity; null when the file has none'),
    ],
  },
  {
    name: 'portfolio_months', available: true,
    description: "Each open book split by expiry ('' = its shares): greeks, P&L and Open P&L.",
    params: { stock: 'optional' },
    fields: [
      f('stock', 'string', '', 'NSE symbol'), f('expiry', 'date', '', "expiry; '' for shares"), ...greeks,
      f('pnl', 'number', 'rupees', "P&L of the expiry's series, after charges; null for the shares, or when an open leg has no LTP"),
      f('openPnl', 'number', 'rupees', 'Open P&L: the legs against net price, before charges'),
    ],
  },
  {
    name: 'chain', available: true,
    description: 'One expiry of an option chain from quotes the app already holds (no new subscription). params.stock required; params.expiry default the book\'s near expiry, else the nearest listed.',
    params: { stock: 'required', expiry: 'optional' },
    fields: [
      f('strike', 'number', 'rupees', 'strike'),
      f('type', 'string', '', "'CE' or 'PE'"),
      f('bid', 'number', 'rupees', 'best bid; null when none'),
      f('ask', 'number', 'rupees', 'best ask; null when none'),
      f('ltp', 'number', 'rupees', 'last price'),
      f('iv', 'number', 'decimal', 'implied vol solved against the forward'),
      f('delta', 'number', 'per share', 'option delta at its own vol'),
      f('oi', 'number', 'contracts', 'open interest; null when not quoted'),
      f('spreadPct', 'number', 'percent', '(ask − bid) / mid × 100; null without both sides'),
      f('liquid', 'boolean', '', 'two-sided, not stale, spread ≤ max(10% of mid, ₹1)'),
      f('stale', 'boolean', '', 'the quote is older than the live threshold'),
    ],
  },
  {
    name: 'band_events', available: true,
    description: `The trader's own delta-band changes (in ↔ out), newest first. params.days default 30, at most ${BAND_EVENTS_MAX_DAYS}.`,
    params: { stock: 'optional', days: `1–${BAND_EVENTS_MAX_DAYS}, default 30` },
    fields: [
      f('at', 'datetime', '', 'when the band changed, IST'),
      f('stock', 'string', '', 'NSE symbol'),
      f('from', 'string', '', "'in' or 'out'"),
      f('to', 'string', '', "'in' or 'out'"),
      f('netDelta', 'number', 'shares', 'book delta at the change'),
      f('bandShares', 'number', 'shares', 'band half-width'),
      f('lotSize', 'number', 'shares', 'lot size'),
      f('outByLots', 'number', 'lots', 'how far past the band'),
      f('source', 'string', '', "'engine' or 'override'"),
    ],
  },
  {
    name: 'daily_bars', available: true,
    description: `Daily bars of an underlying from NSE's end-of-day files, oldest first: OHLC and volume (an index's are its near future's, src 'fut'), the near future's close and OI, total CE/PE OI, ATM IV and max pain. params.days default ${DAILY_BARS_DEFAULT}, at most ${DAILY_BARS_MAX}.`,
    params: { stock: 'required', days: `1–${DAILY_BARS_MAX}, default ${DAILY_BARS_DEFAULT}` },
    fields: [
      f('date', 'date', '', 'trading day'), f('open', 'number', 'rupees', ''), f('high', 'number', 'rupees', ''), f('low', 'number', 'rupees', ''),
      f('close', 'number', 'rupees', ''), f('volume', 'number', 'shares', ''), f('futClose', 'number', 'rupees', 'nearest future close'),
      f('futOi', 'number', 'contracts', ''), f('ceOi', 'number', 'contracts', ''), f('peOi', 'number', 'contracts', ''),
      f('atmIv', 'number', 'decimal', 'ATM implied vol'), f('maxPain', 'number', 'rupees', ''),
      f('src', 'string', '', "'cash' or 'fut': where the OHLC came from"),
    ],
  },
  {
    name: 'intraday_bars', available: true,
    description: "Today's 5- or 15-minute bars, oldest first, built in memory from the live quotes since the app began sampling today. params.of: 'spot' or 'future' (default the context's reference: the spot, an index's future).",
    params: { stock: 'required', interval: "'5m' or '15m', default '15m'", of: "'spot' or 'future'" },
    fields: [f('t', 'datetime', '', 'bar start, IST'), f('o', 'number', 'rupees', ''), f('h', 'number', 'rupees', ''), f('l', 'number', 'rupees', ''), f('c', 'number', 'rupees', ''), f('v', 'number', 'shares', '')],
  },
  {
    name: 'vol', available: true,
    description: "End-of-day volatility of each stock the trader holds (the /vol page's rows): IV, IV rank and percentile, HV, the volatility risk premium (VRP), realized VRP, term and skew. Ranks need 60 days of history.",
    params: {},
    fields: [
      f('stock', 'string', '', 'NSE symbol'),
      f('asOf', 'date', '', 'the trading day the figures are as of'),
      f('iv', 'number', 'decimal', 'near-month ATM IV'),
      f('ivSource', 'string', '', "where the IV came from: NSE's chain or solved from the bhavcopy"),
      f('ivRank', 'number', 'percent', '0–100 over 252 days; null under 60 days of IV'),
      f('ivPercentile', 'number', 'percent', '0–100 over 252 days; null under 60 days'),
      f('ivDays', 'number', 'days', 'days of IV history behind the rank'),
      f('hv10', 'number', 'decimal', '10-day close-to-close vol'),
      f('hv20', 'number', 'decimal', '20-day close-to-close vol'),
      f('nseHv', 'number', 'decimal', "NSE's CMVOLT vol, a cross-check"),
      f('vrp', 'number', 'decimal', 'iv − hv20 (0.05 = 5 vol points)'),
      f('vrpRatio', 'number', '', 'iv / hv20'),
      f('vrpPercentile', 'number', 'percent', '0–100 of the VRP over 252 days; null under 60 days'),
      f('vrpDays', 'number', 'days', 'days of VRP history'),
      f('realizedVrpMean', 'number', 'decimal', 'mean of IV minus the vol that followed (20 days), 252 days'),
      f('realizedVrpPositivePct', 'number', 'percent', '% of days IV exceeded the vol that followed: has short premium been paid'),
      f('realizedVrpDays', 'number', 'days', 'days behind realized VRP'),
      f('nearExpiry', 'date', '', 'the ranked tenor: first expiry ≥ 7 days out'),
      f('nearIv', 'number', 'decimal', 'ATM IV of nearExpiry'),
      f('nextExpiry', 'date', '', 'the month after'),
      f('nextIv', 'number', 'decimal', 'ATM IV of nextExpiry'),
      f('skew25', 'number', 'decimal', '25-delta put IV − 25-delta call IV'),
      f('resultsDate', 'date', '', "the next results board meeting in NSE's calendar; null = none known"),
      f('resultsExpiry', 'date', '', 'the first listed expiry on or after resultsDate'),
      f('resultsInNear', 'boolean', '', 'the ranked near IV includes the results: IV rank is event-inflated, not comparable'),
    ],
  },
  {
    name: 'levels', available: true,
    description: "Support and resistance levels around the price, from get_market_context's levels (sorted by price, at most 24).",
    params: { stock: 'required' },
    fields: [f('price', 'number', 'rupees', ''), f('kind', 'string', '', 'e.g. swing-high, pivot, oi-call-wall'), f('strength', 'number', '', '1–3'), f('distancePct', 'number', 'percent', 'from the reference price (the spot; an index\'s future)'), f('basis', 'string', '', 'what it rests on')],
  },
]
