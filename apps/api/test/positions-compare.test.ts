/**
 * Positions-level truth: broker vs `desk-books` vs the runner's ledgers.
 *
 * MONGO-FREE, and deliberately so. Every judgement this job makes is a
 * judgement about NUMBERS — is the broker's view readable at all, does the sum
 * of what the desk claims equal what the broker reports, is a broker row one
 * the desk can attribute — and each of them is one an operator would act on.
 * The Mongo edges (one upsert, one journal write) are the two thinnest parts
 * and are behind ports.
 *
 * THE PROPERTY MOST OF THESE TESTS ARE REALLY ABOUT: this job must never cry
 * wolf. The Python desk's books legitimately live at the broker, so a
 * books<->broker match is the EXPECTED state and a broker row nobody claims is
 * a fact to report, not an alarm to raise. And a broker view that could not be
 * read must produce NO verdict at all — an unreadable order book read as "the
 * broker holds nothing" would report every open position on the desk as
 * divergent, which is the exact failure `broker-snapshot.ts` carries scar
 * tissue for.
 *
 * EVERY BROKER FIXTURE BELOW IS IN THE REAL XTS SHAPE, and that is the point of
 * the fixtures rather than an incidental fidelity. The first build of this job
 * keyed the desk side by Kite's tradingsymbol (`BHEL26AUG415CE`) and the broker
 * side by XTS's (`BHEL 25AUG2026 CE 415`) and joined the two by string, so on
 * 2026-08-15 a desk whose positions MATCHED to the contract was reported as
 * `17 DIVERGENT ... 17 broker position(s) the desk cannot attribute` — every
 * agreeing leg counted twice, once on each side of a join that never met. Its
 * test fixtures spelled the broker's rows in Kite's format, so they agreed with
 * the defect and could never have caught it. Spaces, `DDMMMYYYY`, a STRING
 * `ExchangeInstrumentId` and per-`ProductType` rows are therefore all here on
 * purpose.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  brokerExchangeToken,
  brokerNetQty,
  brokerSymbolOf,
  compareCardSummary,
  comparePositions,
  createPositionsComparer,
  dxDemoNoSnapshotReason,
  dxNoSnapshotReason,
  positionsDemoComparePorts,
  readLiveLedgers,
  SIMULATOR_NO_COMPARE,
  type BookPositions,
  type LedgerPositions,
  type PositionsComparePorts,
  type PositionsCompareReport,
} from '../src/positions-compare.ts'
import { positionsRoutes } from '../src/routes/positions.ts'
import type { ApiDeps, Principal, RouteCtx } from '../src/routes/kit.ts'

/** 2026-08-14 12:00 IST, a Friday inside the session. */
const NOW = Date.parse('2026-08-14T06:30:00.000Z')
/** 2026-08-14 16:05 IST — past the nightly mark. */
const AFTER_CLOSE = Date.parse('2026-08-14T10:35:00.000Z')
/** 2026-08-14 17:10 IST — the same IST day, an hour after the first evening pass. */
const LATER_THAT_EVENING = Date.parse('2026-08-14T11:40:00.000Z')
const INTERVAL = 300_000

type Doc = Record<string, unknown>

const snapshot = (positions: Doc[], over: Doc = {}): Doc => ({
  _id: 'xts',
  asOf: NOW - 10_000,
  ok: true,
  error: '',
  orders: [],
  trades: [],
  positions,
  ...over,
})

/**
 * THE INSTRUMENT MASTER, as the only thing that relates the two spellings.
 *
 * `id` is XTS's `ExchangeInstrumentId` — Zerodha's packed
 * `instrument_token = exchange_token * 256 + segment` with the segment byte
 * divided off, which is exactly what the gateway sends when it places the order
 * (`apps/order-gateway/src/main.ts`). The Kite key and the `xts` spelling are
 * the SAME contract; nothing but this table knows that, which is the whole
 * lesson.
 *
 * The strikes and ids are the operator's 2026-08-15 evidence: the four BHEL
 * contracts the card called divergent and the three it said it could not
 * attribute were the same positions, seen twice.
 */
const CONTRACTS: Record<string, { xts: string; id: number }> = {
  BHEL26AUG375PE: { xts: 'BHEL 25AUG2026 PE 375', id: 149461 },
  BHEL26AUG400PE: { xts: 'BHEL 25AUG2026 PE 400', id: 149465 },
  BHEL26AUG410PE: { xts: 'BHEL 25AUG2026 PE 410', id: 149468 },
  BHEL26AUG415CE: { xts: 'BHEL 25AUG2026 CE 415', id: 149471 },
  BHEL26AUG440CE: { xts: 'BHEL 25AUG2026 CE 440', id: 149480 },
  BHEL26AUG240CE: { xts: 'BHEL 25AUG2026 CE 240', id: 149402 },
  NIFTY26AUG24000PE: { xts: 'NIFTY 26AUG2026 PE 24000', id: 43521 },
  BANKNIFTY26AUG52000CE: { xts: 'BANKNIFTY 26AUG2026 CE 52000', id: 47110 },
  TCS26AUG3200CE: { xts: 'TCS 25AUG2026 CE 3200', id: 153898 },
  SENSEX26AUG81000CE: { xts: 'SENSEX 28AUG2026 CE 81000', id: 862031 },
}

/**
 * The master's answer, keyed by the number both systems hold.
 *
 * `xts.ts` and the dump never talk to each other; this map is the join, and a
 * token it does not carry is an EXPIRED or not-yet-refreshed contract — which is
 * a real state and one the comparison has to survive rather than guess through.
 */
const MASTER = new Map<number, string>(
  Object.entries(CONTRACTS).map(([kite, c]) => [c.id, kite]),
)
const symbolForToken = (exchangeToken: number): string | null => MASTER.get(exchangeToken) ?? null

/** The XTS instrument id of a contract, as the number the master is keyed by. */
const idOf = (kiteSymbol: string): number => {
  const c = CONTRACTS[kiteSymbol]
  if (c === undefined) throw new Error(`fixture: no XTS identity for ${kiteSymbol}`)
  return c.id
}

/**
 * One XTS net-wise position row, in the shape the gateway stores VERBATIM.
 *
 * Taken by the DESK's tradingsymbol and emitted in the BROKER's — because that
 * is the direction every test here reads in, and because a fixture that let a
 * test name the broker's row in Kite's spelling is how the original defect
 * survived its own test suite.
 *
 * `ExchangeInstrumentId` is a STRING: that is what this account's replies carry
 * (`"ExchangeInstrumentId":"149471"` in the 2026-08-15 dump), and a fixture that
 * quietly made it a number would not exercise the coercion the real reply needs.
 */
const brokerRow = (kiteSymbol: string, qty: number, over: Doc = {}): Doc => {
  const c = CONTRACTS[kiteSymbol]
  if (c === undefined) throw new Error(`fixture: no XTS identity for ${kiteSymbol}`)
  return {
    TradingSymbol: c.xts,
    ExchangeInstrumentId: String(c.id),
    ExchangeSegment: 'NSEFO',
    ProductType: 'NRML',
    Quantity: qty,
    ...over,
  }
}

const book = (tag: string, legs: readonly { symbol: string; qty: number }[]): BookPositions => ({
  tag,
  legs: legs.map((l) => ({ instrument: { tradingsymbol: l.symbol }, qty: l.qty })),
})

const ledger = (
  tag: string,
  legs: readonly { symbol: string; qty: number }[],
): LedgerPositions => ({
  tag,
  symbols: legs.map((l) => ({ tradingsymbol: l.symbol, qty: l.qty })),
  unmeasurable: [],
})

function compare(over: Partial<Parameters<typeof comparePositions>[0]> = {}): PositionsCompareReport {
  return comparePositions({
    now: NOW,
    snapshot: snapshot([]),
    books: [],
    ledgers: [],
    intervalMs: INTERVAL,
    symbolForToken,
    ...over,
  })
}

// ------------------------------------------------------- reading the broker

test('a broker row is read from the field XTS actually sends', () => {
  // `Quantity` is ALREADY SIGNED for a net-wise position — the same field and
  // the same reasoning as `packages/brokers/src/xts.ts:positions()`.
  assert.equal(brokerNetQty(brokerRow('BANKNIFTY26AUG52000CE', -75)), -75)
  // And the name XTS sends is the BROKER's spelling, with spaces and DDMMMYYYY.
  // It is a label for a human, never a key — see the join tests below.
  assert.equal(
    brokerSymbolOf(brokerRow('BANKNIFTY26AUG52000CE', -75)),
    'BANKNIFTY 26AUG2026 CE 52000',
  )
})

test('the exchange token is read off the row, string or number', () => {
  // This account's replies send it as a STRING. A build that sends a number, or
  // spells the key with a capital D, must not silently stop this job resolving.
  assert.equal(brokerExchangeToken({ ExchangeInstrumentId: '149471' }), 149471)
  assert.equal(brokerExchangeToken({ ExchangeInstrumentID: 149471 }), 149471)
  assert.equal(brokerExchangeToken({ exchangeInstrumentId: '149471' }), 149471)
})

test('a row carrying no readable exchange token says so, rather than guessing', () => {
  assert.equal(brokerExchangeToken({ TradingSymbol: 'BHEL 25AUG2026 CE 415' }), null)
  assert.equal(brokerExchangeToken({ ExchangeInstrumentId: '' }), null)
  assert.equal(brokerExchangeToken({ ExchangeInstrumentId: 'NSEFO|149471' }), null)
  assert.equal(brokerExchangeToken({ ExchangeInstrumentId: 0 }), null)
})

// ------------------------------------------------------------------ the join

/**
 * THE REGRESSION, in the operator's own numbers.
 *
 * Four BHEL contracts, held by the desk in Kite's spelling and reported by the
 * broker in XTS's, with the SAME quantities on both sides. Joined by name this
 * produces four divergences and four unattributable rows — the shape of the
 * 2026-08-15 card. Joined by the token, which is the only identifier both
 * systems hold, it produces silence, because there is nothing wrong.
 */
test('the same positions in two spellings are ONE set of positions, joined by token', () => {
  const r = compare({
    snapshot: snapshot([
      brokerRow('BHEL26AUG375PE', -5250),
      brokerRow('BHEL26AUG400PE', -5250),
      brokerRow('BHEL26AUG410PE', 5250),
      brokerRow('BHEL26AUG415CE', -5250),
    ]),
    books: [
      book('BHEL-R', [
        { symbol: 'BHEL26AUG375PE', qty: -5250 },
        { symbol: 'BHEL26AUG400PE', qty: -5250 },
        { symbol: 'BHEL26AUG410PE', qty: 5250 },
        { symbol: 'BHEL26AUG415CE', qty: -5250 },
      ]),
    ],
  })
  assert.equal(r.comparable, true)
  assert.deepEqual(r.divergent, [], 'matching positions are not a divergence')
  assert.deepEqual(r.unattributable, [], 'and they are not four orphan broker rows either')
  assert.equal(r.symbols.length, 4)
  // Every row is keyed by the DESK's spelling, which is what every other desk
  // screen, the order feed and the operator's next click all speak.
  assert.deepEqual(
    r.symbols.map((s) => s.symbol),
    ['BHEL26AUG375PE', 'BHEL26AUG400PE', 'BHEL26AUG410PE', 'BHEL26AUG415CE'],
  )
  for (const s of r.symbols) assert.equal(s.agree, true, `${s.symbol} should agree`)
})

test('a REAL divergence is still found through the token join', () => {
  // The fix must not buy silence by matching everything: one leg genuinely
  // differs, and it is named in the desk's spelling with both numbers.
  const r = compare({
    snapshot: snapshot([
      brokerRow('BHEL26AUG375PE', -5250),
      brokerRow('BHEL26AUG415CE', -5250),
    ]),
    books: [
      book('BHEL-R', [
        { symbol: 'BHEL26AUG375PE', qty: -5250 },
        { symbol: 'BHEL26AUG415CE', qty: -7000 },
      ]),
    ],
  })
  assert.deepEqual(r.divergent, ['BHEL26AUG415CE'])
  assert.equal(r.unattributable.length, 0)
  const row = r.symbols.find((s) => s.symbol === 'BHEL26AUG415CE')
  assert.equal(row?.agree, false)
  assert.match(String(row?.note), /-7000/)
  assert.match(String(row?.note), /-5250/)
})

/**
 * AN EXPIRED CONTRACT IS GONE FROM THE MASTER, and a master mid-refresh has not
 * got the new one yet. Either way the token answers nothing, and the honest
 * report is the row itself carrying BOTH names — the broker's, so it can be
 * found in the terminal, and the token, so it can be found in the dump. What it
 * must NEVER do is parse `BHEL 25AUG2026 CE 415` into `BHEL26AUG415CE`:
 * `reconcile-live.ts` states the rule and the reason, and a fabricated contract
 * on a positions comparison would report a divergence against a leg nobody
 * holds.
 */
test('a token the master cannot answer stays unattributable, carrying both spellings', () => {
  const r = compare({
    snapshot: snapshot([brokerRow('BHEL26AUG415CE', -5250)]),
    // The master has forgotten this contract — the expiry rolled.
    symbolForToken: () => null,
    books: [book('BHEL-R', [{ symbol: 'BHEL26AUG415CE', qty: -5250 }])],
  })
  assert.equal(r.comparable, true, 'one unresolvable row must not silence the pass')
  assert.equal(r.unattributable.length, 1)
  const label = String(r.unattributable[0]?.symbol)
  assert.match(label, /BHEL 25AUG2026 CE 415/, 'the broker’s own words, for the terminal')
  // 149471 * 256 — the packed form the desk's dump is keyed by.
  assert.match(label, /38264576/, 'and the token, for the dump')
  assert.match(label, /not in master/)
  assert.equal(r.unattributable[0]?.broker, -5250)
  // And nothing was invented on the desk side: the book's leg is still reported,
  // now as a divergence, because the broker view genuinely does not name it.
  assert.deepEqual(r.divergent, ['BHEL26AUG415CE'])
})

test('a row with no exchange token at all is unattributable WITH THE REASON', () => {
  const row = brokerRow('BHEL26AUG440CE', -3000)
  delete row['ExchangeInstrumentId']
  const r = compare({ snapshot: snapshot([row]) })
  // Not a withdrawn verdict: an unjoinable row is one fact about one row, and
  // letting it silence the whole comparison is the crying-wolf failure inverted.
  assert.equal(r.comparable, true)
  assert.equal(r.unattributable.length, 1)
  assert.match(String(r.unattributable[0]?.symbol), /BHEL 25AUG2026 CE 440/)
  assert.match(String(r.unattributable[0]?.symbol), /no ExchangeInstrumentId/i)
})

test('the two spellings of one contract are never matched by name, even by accident', () => {
  /**
   * The master answers a DIFFERENT contract for this token — a stand-in for a
   * dump that is mid-refresh or an id that moved. The comparison must follow the
   * token it was given rather than the name it can see, because the name is
   * precisely the thing that is not authoritative here.
   */
  const r = compare({
    snapshot: snapshot([brokerRow('BHEL26AUG415CE', -5250)]),
    symbolForToken: () => 'BHEL26AUG440CE',
    books: [book('BHEL-R', [{ symbol: 'BHEL26AUG440CE', qty: -5250 }])],
  })
  assert.deepEqual(r.divergent, [])
  assert.deepEqual(r.unattributable, [])
  assert.equal(r.symbols[0]?.symbol, 'BHEL26AUG440CE')
})

test('a broker row with no quantity field this code knows is UNREADABLE, never zero', () => {
  // Zero would say "the broker holds nothing on this contract", which is the
  // one answer that turns an unread field into a phantom divergence.
  assert.equal(brokerNetQty({ TradingSymbol: 'X', Somethingelse: 5 }), null)
})

test('the quantity falls back through the names other XTS builds use', () => {
  assert.equal(brokerNetQty({ NetQty: -50 }), -50)
  assert.equal(brokerNetQty({ netQty: 25 }), 25)
  assert.equal(brokerNetQty({ OpenBuyQuantity: 100, OpenSellQuantity: 175 }), -75)
})

// ------------------------------------------------------------ the agreement

test('books plus ledger equal to the broker is agreement, and says nothing else', () => {
  const r = compare({
    snapshot: snapshot([brokerRow('NIFTY26AUG24000PE', -75)]),
    books: [book('DLF-R', [{ symbol: 'NIFTY26AUG24000PE', qty: -75 }])],
  })
  assert.equal(r.comparable, true)
  assert.equal(r.divergent.length, 0)
  assert.equal(r.unattributable.length, 0)
  const row = r.symbols[0]
  assert.equal(row?.symbol, 'NIFTY26AUG24000PE')
  assert.equal(row?.broker, -75)
  assert.equal(row?.books, -75)
  assert.equal(row?.ledger, 0)
  assert.equal(row?.agree, true)
  assert.deepEqual(row?.claimedBy, ['DLF-R'])
})

test('the desk claiming more than the broker holds is a divergence, named', () => {
  const r = compare({
    snapshot: snapshot([brokerRow('NIFTY26AUG24000PE', -75)]),
    books: [book('DLF-R', [{ symbol: 'NIFTY26AUG24000PE', qty: -150 }])],
  })
  assert.deepEqual(r.divergent, ['NIFTY26AUG24000PE'])
  const row = r.symbols[0]
  assert.equal(row?.agree, false)
  assert.match(String(row?.note), /-150/)
  assert.match(String(row?.note), /-75/)
})

test('a ledger leg the broker does not have is a divergence', () => {
  // The 2026-08-10 mirror-leg shape: the runner believes it holds three SENSEX
  // legs and the broker has never heard of them.
  const r = compare({
    // `array(0)` is the broker genuinely saying "I hold nothing" — the gateway
    // records the shape of every empty list precisely so this can be told from
    // a reply that could not be read.
    snapshot: snapshot([], { emptyDiagnostic: { positions: 'array(0)' } }),
    ledgers: [ledger('MIRROR_A006', [{ symbol: 'SENSEX26AUG81000CE', qty: -20 }])],
  })
  assert.deepEqual(r.divergent, ['SENSEX26AUG81000CE'])
  assert.match(String(r.symbols[0]?.note), /broker (reports|holds) (nothing|0)/i)
})

test('a broker row the desk cannot attribute is UNATTRIBUTABLE, not a divergence', () => {
  /**
   * The honesty requirement in the plan, and the whole reason this job is not
   * simply `reconcile()`. A position at the broker that no desk book and no
   * runner ledger claims is a fact — a manual trade, a legacy leg, another
   * system on the same account — and reporting it as a fault would put a
   * permanent red on a desk behaving exactly as intended.
   */
  const r = compare({ snapshot: snapshot([brokerRow('TCS26AUG3200CE', -300)]) })
  assert.equal(r.divergent.length, 0)
  assert.deepEqual(r.unattributable, [{ symbol: 'TCS26AUG3200CE', broker: -300 }])
  assert.equal(r.symbols.length, 0)
})

test('a symbol claimed by BOTH a book and a ledger is summed, and says so', () => {
  const r = compare({
    snapshot: snapshot([brokerRow('BHEL26AUG240CE', -6000)]),
    books: [book('BHEL-R', [{ symbol: 'BHEL26AUG240CE', qty: -3000 }])],
    ledgers: [ledger('ORB_SCALP', [{ symbol: 'BHEL26AUG240CE', qty: -3000 }])],
  })
  assert.equal(r.symbols[0]?.agree, true)
  assert.equal(r.symbols[0]?.bothSources, true)
})

test('two broker rows for one contract are summed, not last-wins', () => {
  // XTS answers per product type; NRML and MIS on the same contract are two
  // rows and one position. They carry the SAME `ExchangeInstrumentId`, so the
  // token join must fold them exactly as the name join used to.
  const r = compare({
    snapshot: snapshot([
      brokerRow('NIFTY26AUG24000PE', -75),
      brokerRow('NIFTY26AUG24000PE', -75, { ProductType: 'MIS' }),
    ]),
    books: [book('DLF-R', [{ symbol: 'NIFTY26AUG24000PE', qty: -150 }])],
  })
  assert.equal(r.symbols[0]?.broker, -150)
  assert.equal(r.divergent.length, 0)
})

test('a flat leg is not a position on either side', () => {
  const r = compare({
    snapshot: snapshot([brokerRow('NIFTY26AUG24000PE', 0)]),
    books: [book('DLF-R', [{ symbol: 'NIFTY26AUG24000PE', qty: 0 }])],
  })
  assert.equal(r.symbols.length, 0)
  assert.equal(r.unattributable.length, 0)
})

// -------------------------------------------- when there is nothing to compare

test('no broker snapshot means NO VERDICT — the desk side is still reported', () => {
  const r = compare({
    snapshot: null,
    books: [book('DLF-R', [{ symbol: 'NIFTY26AUG24000PE', qty: -75 }])],
  })
  assert.equal(r.comparable, false)
  assert.match(r.reason, /snapshot/)
  assert.equal(r.divergent.length, 0)
  // The union of what the desk believes is still the answer to roadmap 16's
  // other half, so it is served rather than withheld.
  assert.equal(r.symbols[0]?.books, -75)
  assert.equal(r.symbols[0]?.broker, null)
  assert.equal(r.symbols[0]?.agree, true)
})

test('an INCOMPLETE snapshot is not evidence of anything', () => {
  const r = compare({
    snapshot: snapshot([], { ok: false, error: 'positions: Token not found' }),
    books: [book('DLF-R', [{ symbol: 'NIFTY26AUG24000PE', qty: -75 }])],
  })
  assert.equal(r.comparable, false)
  assert.match(r.reason, /Token not found/)
  assert.equal(r.divergent.length, 0)
})

test('a snapshot too old to trust produces no verdict', () => {
  const r = compare({
    snapshot: snapshot([], { asOf: NOW - 3_600_000 }),
    books: [book('DLF-R', [{ symbol: 'NIFTY26AUG24000PE', qty: -75 }])],
  })
  assert.equal(r.comparable, false)
  assert.match(r.reason, /old/i)
  assert.equal(r.divergent.length, 0)
})

test('an UNREADABLE empty position list is not "the broker holds nothing"', () => {
  /**
   * The crying-wolf guard, inverted. `emptyDiagnostic.positions` says whether
   * the broker answered with a real empty list or with something this code
   * could not read. Reading the second as an empty book would report EVERY
   * open position on the desk as divergent at once.
   */
  const r = compare({
    snapshot: snapshot([], { emptyDiagnostic: { positions: 'object{description}' } }),
    books: [book('DLF-R', [{ symbol: 'NIFTY26AUG24000PE', qty: -75 }])],
  })
  assert.equal(r.comparable, false)
  assert.match(r.reason, /object\{description\}/)
  assert.equal(r.divergent.length, 0)
})

test('a genuinely empty broker book IS comparable, and the desk claiming legs diverges', () => {
  const r = compare({
    snapshot: snapshot([], { emptyDiagnostic: { positions: 'array(0)' } }),
    books: [book('DLF-R', [{ symbol: 'NIFTY26AUG24000PE', qty: -75 }])],
  })
  assert.equal(r.comparable, true)
  assert.deepEqual(r.divergent, ['NIFTY26AUG24000PE'])
})

test('a row whose quantity could not be read withdraws the verdict', () => {
  const r = compare({
    snapshot: snapshot([
      { TradingSymbol: 'NIFTY 26AUG2026 PE 24000', ExchangeInstrumentId: '43521', Whatever: 1 },
    ]),
    books: [book('DLF-R', [{ symbol: 'NIFTY26AUG24000PE', qty: -75 }])],
  })
  assert.equal(r.comparable, false)
  assert.match(r.reason, /could not be read/i)
  assert.equal(r.divergent.length, 0)
})

test('a leg whose lot size is unknown is reported as unmeasurable, not as divergent', () => {
  const r = compare({
    snapshot: snapshot([]),
    ledgers: [{ tag: 'MIRROR_A006', symbols: [], unmeasurable: ['SENSEX26AUG81000CE'] }],
  })
  assert.deepEqual(r.unmeasurable, ['SENSEX26AUG81000CE'])
  assert.equal(r.divergent.length, 0)
})

// ------------------------------------------------------------- the ledgers

test('only the LIVE rail is read out of the runner ledgers', () => {
  const docs: Doc[] = [
    {
      tag: 'ORB_SCALP:live',
      key: 'runner:positions',
      value: [
        { tradingsymbol: 'BN26AUG52000CE', lots: -2, instrument: { tradingsymbol: 'BN26AUG52000CE', lotSize: 35 } },
      ],
    },
    {
      tag: 'ORB_SCALP:paper',
      key: 'runner:positions',
      value: [
        { tradingsymbol: 'BN26AUG52000PE', lots: -2, instrument: { tradingsymbol: 'BN26AUG52000PE', lotSize: 35 } },
      ],
    },
  ]
  const out = readLiveLedgers(docs, () => null)
  assert.equal(out.length, 1)
  assert.equal(out[0]?.tag, 'ORB_SCALP')
  // Signed LOTS x lot size — the ledger counts lots, the broker counts
  // contracts, and comparing the two numbers directly is the whole point.
  assert.deepEqual(out[0]?.symbols, [{ tradingsymbol: 'BN26AUG52000CE', qty: -70 }])
})

test('an entry with no lot size of its own is sized from the instrument master', () => {
  const docs: Doc[] = [
    { tag: 'ORB_SCALP:live', key: 'runner:positions', value: [{ tradingsymbol: 'BN26AUG52000CE', lots: 1 }] },
  ]
  const out = readLiveLedgers(docs, (s) => (s === 'BN26AUG52000CE' ? 35 : null))
  assert.deepEqual(out[0]?.symbols, [{ tradingsymbol: 'BN26AUG52000CE', qty: 35 }])
})

test('an entry NOTHING can size is named rather than counted as zero', () => {
  // An expired contract is gone from the master and its stored lot size may be
  // missing too. Counting it as 0 lots would quietly retire a leg that the
  // ledger still believes in.
  const docs: Doc[] = [
    { tag: 'MIRROR_A006:live', key: 'runner:positions', value: [{ tradingsymbol: 'SENSEX26AUG81000CE', lots: -1 }] },
  ]
  const out = readLiveLedgers(docs, () => null)
  assert.deepEqual(out[0]?.symbols, [])
  assert.deepEqual(out[0]?.unmeasurable, ['SENSEX26AUG81000CE'])
})

// ------------------------------------------------------------- the card line

test('the status card says what was compared, and leads with divergence', () => {
  const divergent = compare({
    snapshot: snapshot([brokerRow('NIFTY26AUG24000PE', -75)]),
    books: [book('DLF-R', [{ symbol: 'NIFTY26AUG24000PE', qty: -150 }])],
  })
  const card = compareCardSummary({ ...divergent }, NOW)
  assert.match(card.detail, /^1 DIVERGENT/)
  assert.equal(card.lastSeenMs, divergent.asOf)
  assert.equal(card.expectedEveryMs, INTERVAL)
})

/**
 * AGREEMENT MUST READ AS AGREEMENT. This is the line the operator actually saw
 * on 2026-08-15 — `17 DIVERGENT (BHEL26AUG375PE, ...) · 17 desk contracts ·
 * 17 broker position(s) the desk cannot attribute (BHEL 25AUG2026 CE 415, ...)`
 * — and the two spellings sitting in one sentence were the defect written out
 * in full. On the same evidence, joined correctly, it says nothing at all.
 */
test('a desk that matches the broker renders as agreement, in the desk’s spelling', () => {
  const agreeing = compare({
    snapshot: snapshot([
      brokerRow('BHEL26AUG375PE', -5250),
      brokerRow('BHEL26AUG415CE', -5250),
    ]),
    books: [
      book('BHEL-R', [
        { symbol: 'BHEL26AUG375PE', qty: -5250 },
        { symbol: 'BHEL26AUG415CE', qty: -5250 },
      ]),
    ],
  })
  const card = compareCardSummary({ ...agreeing }, NOW)
  assert.doesNotMatch(card.detail, /DIVERGENT/)
  assert.doesNotMatch(card.detail, /cannot attribute/)
  assert.doesNotMatch(card.detail, /25AUG2026/, 'the broker’s spelling never reaches the card')
  assert.match(card.detail, /2 desk contracts compared to the broker/)
  assert.equal(card.extra['divergent'], 0)
  assert.equal(card.extra['unattributable'], 0)
})

test('the card reports unattributable rows in plain words, never as a fault', () => {
  const r = compare({ snapshot: snapshot([brokerRow('TCS26AUG3200CE', -300)]) })
  const card = compareCardSummary({ ...r }, NOW)
  assert.doesNotMatch(card.detail, /DIVERGENT/)
  assert.match(card.detail, /cannot attribute|unattributed|not claimed/i)
})

test('no report at all is stated as absence, with the reason', () => {
  const card = compareCardSummary(null, NOW)
  assert.equal(card.lastSeenMs, null)
  assert.match(card.detail, /has not run|no comparison/i)
})

// ------------------------------------------------------------- the loop

function ports(over: Partial<PositionsComparePorts> = {}): {
  ports: PositionsComparePorts
  saved: PositionsCompareReport[]
  journalled: Doc[]
  notified: Doc[]
  logs: string[]
} {
  const saved: PositionsCompareReport[] = []
  const journalled: Doc[] = []
  const notified: Doc[] = []
  const logs: string[] = []
  return {
    saved,
    journalled,
    notified,
    logs,
    ports: {
      now: () => NOW,
      log: (msg) => logs.push(msg),
      snapshot: async () => snapshot([]),
      books: async () => [],
      ledgers: async () => [],
      symbolForToken,
      save: async (report) => {
        saved.push(report)
      },
      load: async () => saved[saved.length - 1] ?? null,
      journal: async (events) => {
        journalled.push(...events)
      },
      // The default: nothing in the feed yet, i.e. this day has not been
      // summarised by any process.
      summarised: async () => false,
      notify: (_mode, event) => notified.push(event),
      ...over,
    },
  }
}

test('a pass computes, stores and serves the report', async () => {
  const h = ports({
    snapshot: async () => snapshot([brokerRow('NIFTY26AUG24000PE', -75)]),
    books: async () => [book('DLF-R', [{ symbol: 'NIFTY26AUG24000PE', qty: -75 }])],
  })
  const comparer = createPositionsComparer(h.ports, { intervalMs: INTERVAL })
  const report = await comparer.run(NOW)
  assert.notEqual(report, null)
  assert.equal(h.saved.length, 1)
  assert.equal((await comparer.last())?.symbols.length, 1)
})

test('every stored report is handed to the reconciliation guard; a guard that throws never fails the pass', async () => {
  const seen: PositionsCompareReport[] = []
  const h = ports({
    snapshot: async () => snapshot([brokerRow('NIFTY26AUG24000PE', -50)]),
    books: async () => [book('DLF-R', [{ symbol: 'NIFTY26AUG24000PE', qty: -75 }])],
    reconciled: async (r) => {
      seen.push(r)
    },
  })
  const comparer = createPositionsComparer(h.ports, { intervalMs: INTERVAL })
  const report = await comparer.run(NOW)
  assert.equal(seen.length, 1)
  assert.equal(seen[0], report)
  assert.deepEqual(seen[0]?.divergent, ['NIFTY26AUG24000PE'])

  const bad = ports({ reconciled: async () => Promise.reject(new Error('alert store down')) })
  const r2 = await createPositionsComparer(bad.ports, { intervalMs: INTERVAL }).run(NOW)
  assert.notEqual(r2, null)
  assert.equal(bad.saved.length, 1)
  assert.ok(bad.logs.some((l) => /reconciliation guard failed/.test(l)))
})

test('a pass already in flight is dropped, not queued', async () => {
  const held: { release: () => void } = { release: () => {} }
  const gate = new Promise<void>((res) => {
    held.release = res
  })
  const h = ports({
    snapshot: async () => {
      await gate
      return snapshot([])
    },
  })
  const comparer = createPositionsComparer(h.ports, { intervalMs: INTERVAL })
  const first = comparer.run(NOW)
  const second = await comparer.run(NOW)
  assert.equal(second, null, 'the overlapping pass must do nothing')
  held.release()
  await first
  assert.equal(h.saved.length, 1)
})

test('NOTHING is journalled or pushed while the desk and the broker agree', async () => {
  const h = ports({
    snapshot: async () => snapshot([brokerRow('NIFTY26AUG24000PE', -75)]),
    books: async () => [book('DLF-R', [{ symbol: 'NIFTY26AUG24000PE', qty: -75 }])],
  })
  const comparer = createPositionsComparer(h.ports, { intervalMs: INTERVAL })
  await comparer.run(AFTER_CLOSE)
  assert.equal(h.journalled.length, 0)
  assert.equal(h.notified.length, 0)
})

test('the nightly pass journals and pushes ONE summary when it diverges', async () => {
  const h = ports({
    snapshot: async () => snapshot([brokerRow('NIFTY26AUG24000PE', -75)], { asOf: AFTER_CLOSE - 10_000 }),
    books: async () => [book('DLF-R', [{ symbol: 'NIFTY26AUG24000PE', qty: -150 }])],
  })
  const comparer = createPositionsComparer(h.ports, { intervalMs: INTERVAL })
  // Mid-session: computed and stored, but the nightly summary is not due.
  await comparer.run(NOW)
  assert.equal(h.journalled.length, 0)
  await comparer.run(AFTER_CLOSE)
  assert.equal(h.journalled.length, 1)
  assert.equal(h.notified.length, 1)
  assert.match(String(h.journalled[0]?.['error']), /NIFTY26AUG24000PE/)
  // Once per IST day, whatever the interval does afterwards.
  await comparer.run(AFTER_CLOSE + 300_000)
  assert.equal(h.journalled.length, 1)
})

/**
 * THE ONE EVENT A DAY IS FOR THE DAY, NOT FOR THE FIRST PASS OF IT.
 *
 * The 16:00 pass runs while the desk is flat and agreeing; the 17:10 pass finds
 * a leg the broker has never heard of. Stamping the day BEFORE the divergence
 * check spent the day's single journal line on the pass that had nothing to
 * report, and the real divergence then went into the log and nowhere else —
 * silently, on the one record an operator reads to answer "what happened
 * today". The stamp belongs to the event, so it is taken when the event is.
 */
test('an agreeing evening pass does NOT spend the day’s one summary', async () => {
  const legs = { qty: -75 }
  const h = ports({
    snapshot: async () =>
      snapshot([brokerRow('NIFTY26AUG24000PE', -75)], { asOf: LATER_THAT_EVENING - 10_000 }),
    books: async () => [book('DLF-R', [{ symbol: 'NIFTY26AUG24000PE', qty: legs.qty }])],
  })
  const comparer = createPositionsComparer(h.ports, { intervalMs: INTERVAL })

  await comparer.run(AFTER_CLOSE)
  assert.equal(h.journalled.length, 0, 'agreement is never journalled')

  // An hour later, the same IST day, a real divergence appears.
  legs.qty = -150
  await comparer.run(LATER_THAT_EVENING)
  assert.equal(h.journalled.length, 1, 'the divergence gets the day’s summary')
  assert.match(String(h.journalled[0]?.['error']), /NIFTY26AUG24000PE/)

  // And still only one, however many passes follow.
  await comparer.run(LATER_THAT_EVENING + INTERVAL)
  assert.equal(h.journalled.length, 1)
})

/**
 * A RESTART MUST NOT WRITE THE DAY'S ROW A SECOND TIME.
 *
 * `#summarisedFor` is memory, and memory is exactly what a restart discards —
 * so a bridge bounced at 18:00 published the same DIVERGENT line again, and an
 * operator counting rows in the feed would read two evenings of divergence out
 * of one. The feed itself is the record that survives the process, so it is the
 * one asked.
 */
test('a restarted process does not republish a day already in the feed', async () => {
  const asked: string[] = []
  const h = ports({
    snapshot: async () => snapshot([brokerRow('NIFTY26AUG24000PE', -75)], { asOf: AFTER_CLOSE - 10_000 }),
    books: async () => [book('DLF-R', [{ symbol: 'NIFTY26AUG24000PE', qty: -150 }])],
    summarised: async (day: string) => {
      asked.push(day)
      return true
    },
  })
  const comparer = createPositionsComparer(h.ports, { intervalMs: INTERVAL })
  await comparer.run(AFTER_CLOSE)
  assert.equal(h.journalled.length, 0, 'the feed already carries this day’s row')
  assert.equal(h.notified.length, 0)
  assert.deepEqual(asked, ['2026-08-14'], 'asked for the report’s own IST day')

  // ONE QUERY PER DAY: the answer is remembered, not re-asked every interval.
  await comparer.run(AFTER_CLOSE + INTERVAL)
  await comparer.run(LATER_THAT_EVENING)
  assert.deepEqual(asked, ['2026-08-14'])
  assert.equal(h.journalled.length, 0)
})

test('the feed is asked ONCE, and a clean answer still publishes exactly one row', async () => {
  const asked: string[] = []
  const h = ports({
    snapshot: async () => snapshot([brokerRow('NIFTY26AUG24000PE', -75)], { asOf: AFTER_CLOSE - 10_000 }),
    books: async () => [book('DLF-R', [{ symbol: 'NIFTY26AUG24000PE', qty: -150 }])],
    summarised: async (day: string) => {
      asked.push(day)
      return false
    },
  })
  const comparer = createPositionsComparer(h.ports, { intervalMs: INTERVAL })
  await comparer.run(AFTER_CLOSE)
  await comparer.run(LATER_THAT_EVENING)
  assert.equal(h.journalled.length, 1)
  assert.deepEqual(asked, ['2026-08-14'], 'one query per day, not one per pass')
})

test('a feed that cannot be read does not repeat the day’s row either', async () => {
  const h = ports({
    snapshot: async () => snapshot([brokerRow('NIFTY26AUG24000PE', -75)], { asOf: AFTER_CLOSE - 10_000 }),
    books: async () => [book('DLF-R', [{ symbol: 'NIFTY26AUG24000PE', qty: -150 }])],
    summarised: async () => {
      throw new Error('mongo is down')
    },
  })
  const comparer = createPositionsComparer(h.ports, { intervalMs: INTERVAL })
  // The pass itself must survive — the report is computed and stored either way.
  const report = await comparer.run(AFTER_CLOSE)
  assert.notEqual(report, null)
  assert.equal(h.saved.length, 1)
  // Unknown is treated as "not published": a missing warning is worse than a
  // repeated one. But it is still only said once by THIS process.
  assert.equal(h.journalled.length, 1)
  await comparer.run(LATER_THAT_EVENING)
  assert.equal(h.journalled.length, 1)
  assert.ok(h.logs.some((l) => /feed/i.test(l)), 'and the unreadable feed is said out loud')
})

test('a pass NEVER repairs anything — there is no write port for it to use', () => {
  const h = ports()
  // The port surface is the guarantee: nothing here can place an order, edit a
  // book or touch a ledger. `save` writes this job's own report; `journal`
  // writes an order-feed line; `summarised` READS the feed back;
  // `symbolForToken` READS the instrument master. Report only, exactly as
  // roadmap 16 asks.
  assert.deepEqual(
    Object.keys(h.ports).sort(),
    [
      'books',
      'journal',
      'ledgers',
      'load',
      'log',
      'notify',
      'now',
      'save',
      'snapshot',
      'summarised',
      'symbolForToken',
    ],
  )
})

// ------------------------------------------------------------- the endpoint

async function call(
  route: ReturnType<typeof positionsRoutes>,
  target: string,
  principal: Principal = { kind: 'user', name: 'aaditya' },
): Promise<{ status: number; body: Doc; handled: boolean }> {
  const url = new URL(`http://desk${target}`)
  const sent: { status: number; body: Doc } = { status: 0, body: {} }
  const ctx: RouteCtx = {
    req: null as unknown as IncomingMessage,
    res: null as unknown as ServerResponse,
    url,
    path: url.pathname,
    method: 'GET',
    principal,
    log: () => {},
    readJson: async () => null,
    send: (status, payload) => {
      sent.status = status
      sent.body = payload as Doc
    },
  }
  const handled = await route(ctx)
  return { ...sent, handled }
}

function routeHarness(over: Partial<PositionsComparePorts> = {}): {
  route: ReturnType<typeof positionsRoutes>
  runs: () => number
  clock: { ms: number }
} {
  let runs = 0
  const clock = { ms: NOW }
  const h = ports({
    snapshot: async () => {
      runs++
      return snapshot([brokerRow('NIFTY26AUG24000PE', -75)], { asOf: clock.ms - 10_000 })
    },
    books: async () => [book('DLF-R', [{ symbol: 'NIFTY26AUG24000PE', qty: -75 }])],
    ...over,
  })
  const comparer = createPositionsComparer(h.ports, { intervalMs: INTERVAL })
  const deps = {
    db: null as unknown as ApiDeps['db'],
    store: null as unknown as ApiDeps['store'],
    service: null as unknown as ApiDeps['service'],
    master: null as unknown as ApiDeps['master'],
    log: () => {},
    now: () => clock.ms,
  } satisfies ApiDeps
  return { route: positionsRoutes({ ...deps, compare: comparer }), runs: () => runs, clock }
}

test('the endpoint serves the LAST report without recomputing', async () => {
  const h = routeHarness()
  const first = await call(h.route, '/v1/desk/positions/compare')
  assert.equal(first.status, 200)
  // Nothing has run yet, and no number is invented while that is true.
  assert.equal(first.body['available'], false)
  assert.match(String(first.body['reason']), /no positions comparison has run yet/i)
  assert.equal(h.runs(), 0)
})

test('?recompute=1 runs a pass and answers with it', async () => {
  const h = routeHarness()
  const res = await call(h.route, '/v1/desk/positions/compare?recompute=1')
  assert.equal(res.status, 200)
  assert.equal(res.body['available'], true)
  assert.equal(h.runs(), 1)
  const report = res.body['report'] as PositionsCompareReport
  assert.equal(report.symbols.length, 1)
  // Then the plain GET serves that same result without a second pass.
  const again = await call(h.route, '/v1/desk/positions/compare')
  assert.equal(again.body['available'], true)
  assert.equal(h.runs(), 1)
})

/**
 * `?recompute=1` IS A REQUEST, NOT A PROMISE — this file's header says so, and
 * an unguarded `await` made it a 500 instead. Three collection reads against a
 * database that is most likely to be struggling exactly when an operator is
 * asking this question, and the failure took the LAST REPORT down with it: the
 * answer the route already had, and the one thing worth serving.
 */
test('a recompute that fails still serves the last report, and says it failed', async () => {
  let broken = false
  const h = routeHarness({
    snapshot: async () => {
      if (broken) throw new Error('mongo is down')
      return snapshot([brokerRow('NIFTY26AUG24000PE', -75)], { asOf: NOW - 10_000 })
    },
  })
  await call(h.route, '/v1/desk/positions/compare?recompute=1')
  broken = true
  // Past the freshness floor, so this one really does attempt a pass.
  h.clock.ms = NOW + 60_000
  const res = await call(h.route, '/v1/desk/positions/compare?recompute=1')
  assert.equal(res.status, 200, 'the last report is still an answer')
  assert.equal(res.body['available'], true)
  assert.equal(res.body['recomputed'], false)
  assert.match(String(res.body['recomputeError']), /mongo is down/)
  const report = res.body['report'] as PositionsCompareReport
  assert.equal(report.asOf, NOW, 'served the report from before the failure')
  assert.equal(res.body['ageMs'], 60_000, 'and dated honestly')
})

test('a recompute that fails with nothing stored yet is still not a 500', async () => {
  const h = routeHarness({
    snapshot: async () => {
      throw new Error('mongo is down')
    },
  })
  const res = await call(h.route, '/v1/desk/positions/compare?recompute=1')
  assert.equal(res.status, 200)
  assert.equal(res.body['available'], false)
  assert.equal(res.body['recomputed'], false)
  assert.match(String(res.body['recomputeError']), /mongo is down/)
})

/**
 * THE FLOOR. `?recompute=1` is three collection scans, and it is reachable by
 * anything that can hold a session — a dashboard tab left on the page, a
 * monitor with a short interval, an operator clicking twice. A report that is
 * seconds old is the same report the pass would produce, so it is served
 * instead of paid for again.
 */
test('a recompute inside the freshness floor serves the fresh report untouched', async () => {
  const h = routeHarness()
  await call(h.route, '/v1/desk/positions/compare?recompute=1')
  assert.equal(h.runs(), 1)
  h.clock.ms = NOW + 4_000
  const res = await call(h.route, '/v1/desk/positions/compare?recompute=1')
  assert.equal(h.runs(), 1, 'four seconds later is the same answer')
  assert.equal(res.body['available'], true)
  assert.equal(res.body['recomputed'], false)
  assert.match(String(res.body['recomputeNote']), /4s old|floor/i)
})

test('past the floor, a recompute really does recompute', async () => {
  const h = routeHarness()
  await call(h.route, '/v1/desk/positions/compare?recompute=1')
  h.clock.ms = NOW + 6_000
  const res = await call(h.route, '/v1/desk/positions/compare?recompute=1')
  assert.equal(h.runs(), 2)
  assert.equal(res.body['recomputed'], true)
  assert.equal((res.body['report'] as PositionsCompareReport).asOf, NOW + 6_000)
})

test('a machine principal may read it — this is a monitor’s question too', async () => {
  const h = routeHarness()
  const res = await call(h.route, '/v1/desk/positions/compare', { kind: 'machine', name: 'desk-monitor' })
  assert.equal(res.status, 200)
})

test('another path is not this module’s', async () => {
  const h = routeHarness()
  const res = await call(h.route, '/v1/desk/pnl')
  assert.equal(res.handled, false)
})

// ------------------------------------------------------------ Delta (DX)

test('a Delta snapshot joins on the product symbol, which is the desk\'s own spelling', () => {
  const r = compare({
    snapshot: {
      asOf: NOW - 5_000,
      ok: true,
      symbolSpace: 'desk',
      positions: [
        { tradingsymbol: 'C-BTC-80000-041126', netQty: -0.05, avgPrice: 120 },
        { tradingsymbol: 'P-BTC-70000-041126', netQty: 0.02, avgPrice: 40 },
      ],
      emptyDiagnostic: { positions: 'array(2)' },
    },
    books: [book('BTC-ZERO', [{ symbol: 'C-BTC-80000-041126', qty: -0.05 }])],
    // No token lookup is consulted for a desk-spelled snapshot.
    symbolForToken: () => {
      throw new Error('a desk-spelled snapshot must not join by token')
    },
  })
  assert.equal(r.comparable, true, r.reason)
  assert.deepEqual(r.divergent, [])
  assert.equal(r.symbols[0]?.broker, -0.05)
  assert.deepEqual(r.unattributable, [{ symbol: 'P-BTC-70000-041126', broker: 0.02 }])
})

test('a failed Delta read is incomplete, never an empty book', () => {
  const r = compare({
    snapshot: { asOf: NOW - 5_000, ok: false, error: 'Delta /v2/positions failed: 401', symbolSpace: 'desk', positions: null },
    books: [book('BTC-ZERO', [{ symbol: 'C-BTC-80000-041126', qty: -0.05 }])],
  })
  assert.equal(r.comparable, false)
  assert.match(r.reason, /INCOMPLETE \(Delta \/v2\/positions failed: 401\)/)
})

test('with no snapshot, the reason says why in plain words', () => {
  assert.equal(dxNoSnapshotReason({ broker: 'simulate' }), SIMULATOR_NO_COMPARE)
  assert.equal(SIMULATOR_NO_COMPARE, 'paper on the simulator: no exchange to compare against')
  assert.match(dxNoSnapshotReason({ broker: 'delta' }), /no Delta positions snapshot yet/)
  assert.match(dxNoSnapshotReason(null), /no gateway heartbeat/)
  const r = compare({ snapshot: null, noSnapshotReason: SIMULATOR_NO_COMPARE })
  assert.equal(r.comparable, false)
  assert.equal(r.reason, SIMULATOR_NO_COMPARE)
  assert.doesNotMatch(compare({ snapshot: null }).reason, /XTS/)
})

// ------------------------------------------------------------ the demo rail

/** A DX deps stub for the demo ports: two paper books, one on the demo rail. */
function demoDeps(snap: Record<string, unknown> | null, heartbeat: Record<string, unknown> | null = null): {
  deps: ApiDeps
  saved: Record<string, unknown>[]
} {
  const saved: Record<string, unknown>[] = []
  const deps = {
    now: () => NOW,
    log: () => {},
    db: {
      collection: (name: string) => ({
        findOne: async (f: Record<string, unknown>) => {
          if (name === 'desk-broker-snapshot') return f['_id'] === 'delta-demo' ? snap : null
          if (name === 'desk-gateway-heartbeat') return heartbeat
          return null
        },
        updateOne: async (f: Record<string, unknown>, u: Record<string, unknown>) => {
          saved.push({ _id: f['_id'], ...(u['$set'] as Record<string, unknown>) })
          return { matchedCount: 1 }
        },
      }),
    },
    store: {
      listBooks: async (mode: string) =>
        mode === 'paper'
          ? [
              { tag: 'BTC-DEMO', dx_paper_rail: 'demo' },
              { tag: 'BTC-SIM', dx_paper_rail: 'sim' },
            ]
          : [],
      allBooks: async (mode: string) =>
        mode === 'paper'
          ? [
              book('BTC-DEMO', [{ symbol: 'C-BTC-80000-041126', qty: -0.05 }, { symbol: 'P-BTC-70000-041126', qty: -0.05 }]),
              book('BTC-SIM', [{ symbol: 'C-BTC-90000-041126', qty: -1 }]),
            ]
          : [],
    },
  } as unknown as ApiDeps
  return { deps, saved }
}

test('demo: paper books on the demo rail are compared with the testnet account, contract by contract', async () => {
  const { deps, saved } = demoDeps({
    asOf: NOW - 5_000,
    ok: true,
    broker: 'delta-demo',
    symbolSpace: 'desk',
    positions: [
      { tradingsymbol: 'C-BTC-80000-041126', netQty: -0.05, avgPrice: 100 },
      { tradingsymbol: 'P-BTC-70000-041126', netQty: -0.02, avgPrice: 30 },
    ],
    emptyDiagnostic: { positions: 'array(2)' },
  })
  const report = await createPositionsComparer(positionsDemoComparePorts(deps), { intervalMs: INTERVAL, rail: 'demo' }).run(NOW)
  assert.ok(report !== null)
  assert.equal(report.comparable, true, report.reason)
  assert.equal(report.mode, 'paper')
  assert.equal(report.rail, 'demo')
  // The sim-rail book is not the testnet's business.
  assert.deepEqual(report.symbols.map((r) => r.symbol), ['C-BTC-80000-041126', 'P-BTC-70000-041126'])
  assert.deepEqual(report.divergent, ['P-BTC-70000-041126'])
  assert.equal(saved[0]?.['_id'], 'demo', 'stored beside, never over, the live report')
  // The live report's id is not touched.
  assert.equal(saved.some((d) => d['_id'] === 'live'), false)
})

test('demo: no testnet snapshot says why, from the gateway heartbeat', async () => {
  assert.match(dxDemoNoSnapshotReason({ demoReady: false }), /no delta-demo key configured/)
  assert.match(dxDemoNoSnapshotReason({ demoReady: true }), /no Delta testnet positions snapshot yet/)
  assert.match(dxDemoNoSnapshotReason(null), /no gateway heartbeat/)
  const { deps } = demoDeps(null, { broker: 'simulate', demoReady: false })
  const report = await createPositionsComparer(positionsDemoComparePorts(deps), { intervalMs: INTERVAL, rail: 'demo' }).run(NOW)
  assert.equal(report?.comparable, false)
  assert.match(String(report?.reason), /no delta-demo key configured/)
})

test('demo: a divergence is never journalled into the order feed', async () => {
  const h = ports({
    snapshot: async () => snapshot([brokerRow('NIFTY26AUG24000PE', -75)], { asOf: AFTER_CLOSE - 10_000 }),
    books: async () => [book('DLF-R', [{ symbol: 'NIFTY26AUG24000PE', qty: -150 }])],
  })
  const comparer = createPositionsComparer(h.ports, { intervalMs: INTERVAL, rail: 'demo' })
  const report = await comparer.run(AFTER_CLOSE)
  assert.equal(report?.divergent.length, 1)
  assert.equal(h.journalled.length, 0)
  assert.equal(h.notified.length, 0)
})

test('the demo card names the testnet account', () => {
  const card = compareCardSummary({ asOf: NOW, comparable: true, symbols: [{ symbol: 'x' }], divergent: [], unattributable: [], unmeasurable: [], intervalMs: INTERVAL }, NOW, 'the Delta testnet account')
  assert.match(card.detail, /1 desk contracts compared to the Delta testnet account/)
})
