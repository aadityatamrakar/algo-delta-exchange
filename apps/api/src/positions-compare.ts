/**
 * ONE POSITION TRUTH: the broker, `desk-books` and the runner's ledgers, put
 * side by side and compared (audit roadmap 16).
 *
 * WHY THIS EXISTS. Three separate records of what this account holds are
 * written by three separate processes, and until now nothing ever compared
 * them. `reconcile-live.ts` joins the GATEWAY's terminal order state back onto
 * the desk's decisions — order by order, within a seven-day window — which is a
 * different question entirely: it never once asks whether the POSITIONS the
 * desk believes it holds are the positions the broker is actually holding. A
 * fill that was never journalled, a leg dropped by a hand-edit, a mirror ledger
 * that outlived its contracts, a manual trade placed in Kite on the same
 * account: none of them produce a gateway order to reconcile, and all of them
 * end with the desk's screens and the broker's book disagreeing about real
 * money. That is the gap this closes.
 *
 * IT REPORTS. IT NEVER REPAIRS. There is no port here that can place an order,
 * write a book or touch a ledger — see the port interface below, which is the
 * guarantee rather than a promise in a comment. A wrong automatic "repair" on
 * the money path is worse than a visible divergence, and a divergence this job
 * finds may equally be the broker view being stale, a lot size we could not
 * resolve, or a leg that is genuinely someone else's.
 *
 * WHAT IT MUST NOT DO, AND THE REASON THE HONESTY RULES ARE WRITTEN DOWN:
 *
 *  1. THE PYTHON DESK'S BOOKS LEGITIMATELY LIVE AT THE BROKER. A `desk-books`
 *     leg matching a broker position is the EXPECTED state, not a finding.
 *     Divergence means the numbers differ for a contract the desk CLAIMS, or a
 *     ledger leg the broker has never heard of.
 *  2. A BROKER ROW NOBODY CLAIMS IS NOT AN ALARM. It goes in `unattributable`
 *     and is reported in plain words. It is routinely a manual trade, a legacy
 *     leg or another system on the same account, and painting it red would put
 *     a permanent fault on a desk behaving exactly as intended — which is how a
 *     warning stops being read.
 *  3. AN UNREADABLE BROKER VIEW PRODUCES NO VERDICT AT ALL. `broker-snapshot.ts`
 *     carries the scar tissue: XTS answers an empty book with "Data Not
 *     Available", a dealer account calling the investor route reconciles
 *     "against an empty order book" and concludes nothing happened while the
 *     order is live. Reading an unreadable reply as "the broker holds nothing"
 *     would report EVERY open position on the desk as divergent in one pass.
 *     So `comparable: false` with the reason, and an empty divergence list.
 *
 * LIVE ONLY. Paper legs never reach a broker; comparing them to one would
 * manufacture a divergence for every paper book on the desk.
 *
 * THE JOIN IS THE TOKEN, NEVER THE NAME. The desk writes `BHEL26AUG415CE`
 * everywhere — books, ledgers, the instrument master, the order feed. XTS writes
 * the SAME contract as `BHEL 25AUG2026 CE 415`. Keying the two sides by their
 * own spellings and comparing the keys is not a comparison at all: every
 * matching leg lands twice, once as a desk contract the broker "does not hold"
 * and once as a broker row "nobody claims", which is exactly the report an
 * operator was shown on 2026-08-15 — `17 DIVERGENT ... 17 broker position(s)
 * the desk cannot attribute` on a desk whose positions matched to the contract.
 *
 * So a broker row is read through its `ExchangeInstrumentId`, which is the ONE
 * identifier both systems hold: the gateway sends that number when it places the
 * order (`apps/order-gateway/src/main.ts` — Zerodha's packed
 * `instrument_token = exchange_token * 256 + segment`, divided by 256, because
 * sending the packed value ACKs an instrument that does not exist and then voids
 * it: the 2026-08-04 phantom books). The instrument master answers it with the
 * tradingsymbol the desk already speaks, and THAT is the key both sides are
 * summed under.
 *
 * AND WHEN THE TOKEN ANSWERS NOTHING, NOTHING IS GUESSED. An expired contract is
 * gone from the master and a mid-refresh master has not got it yet; the row then
 * stays unattributable carrying BOTH spellings, so the operator can find it in
 * either system. The XTS name is never parsed back into a desk symbol —
 * `reconcile-live.ts` states the rule and the reason ("never by parsing the
 * symbol, which is the string fabrication that produced the C4 phantom PE"), and
 * a positions comparison that fabricates a contract would report a divergence
 * against a leg that does not exist.
 */

import type { InstrumentRef } from '@algomaker/order-bus'
import type { ApiDeps } from './routes/kit.ts'
import { istDate } from './routes/kit.ts'
import { istMinutesOfDay } from './rollup.ts'
import { COLLECTIONS } from './store.ts'
/**
 * THE RUNNER'S OWN NAMES FOR ITS OWN STATE, imported rather than restated —
 * exactly as `routes/runner.ts` does, and for the reason the changeset that
 * exported them wrote down: two copies of `'desk-strategy-state'` in this tree
 * is two things to change and one of them will be missed, and the miss is
 * SILENT. A reader pointed at a collection nobody writes finds no ledgers and
 * reports the desk holding nothing — which, here, is a comparison that says
 * every runner leg has vanished.
 */
import { POSITIONS_KEY } from '../../runner/src/order-gateway.ts'
import { STATE_COLLECTION } from '../../runner/src/state-store.ts'

/** This job's own report document. One row, overwritten each pass. */
export const POSITIONS_COMPARE_COLLECTION = 'desk-positions-compare'
/** `_id` of that row. Named for the rail, because only one rail is compared. */
export const POSITIONS_COMPARE_ID = 'live'

/** The gateway's broker snapshot — see `routes/system.ts` for why it is a literal. */
const BROKER_SNAPSHOT_COLLECTION = 'desk-broker-snapshot'
const BROKER_SNAPSHOT_ID = 'xts'

export const DEFAULT_COMPARE_MS = 300_000

/**
 * How old the broker's snapshot may be and still be worth comparing against.
 *
 * The gateway rewrites it every 30 seconds, so five minutes is ten missed
 * writes — well past "the poll was slow" and squarely in "the gateway is not
 * writing". Comparing against an hour-old book would report this morning's
 * closed positions as divergences all afternoon.
 */
export const DEFAULT_MAX_BROKER_AGE_MS = 300_000

/**
 * The IST minute the once-a-day summary is due after.
 *
 * 16:00: half an hour after the close, so the day's last fills have long since
 * been journalled and any 15:30 backstop has run. Before that, a divergence is
 * as likely to be a position mid-flight as a real one.
 */
export const NIGHTLY_AFTER_IST_MINUTES = 16 * 60

// ------------------------------------------------------------- the contract

/** One contract, as each of the three records sees it. */
export interface SymbolCompare {
  readonly symbol: string
  /**
   * Signed contract quantity at the BROKER — or null when there was no verdict
   * to give (see `PositionsCompareReport.comparable`). NULL IS NOT ZERO.
   */
  readonly broker: number | null
  /** Signed contract quantity summed across every LIVE `desk-books` leg. */
  readonly books: number
  /** Signed contract quantity from the runner's ledgers: lots x lot size. */
  readonly ledger: number
  /**
   * "Nothing here disagrees."
   *
   * True when the desk's total equalled the broker's — AND true when no
   * comparison was performed at all, because an unread broker view disagrees
   * with nothing. The report's `comparable`/`reason` is what says which of the
   * two this is; reading `agree` alone as "verified" is a mistake this comment
   * exists to prevent.
   */
  readonly agree: boolean
  /** The tags claiming this contract, so the operator's next click is obvious. */
  readonly claimedBy: readonly string[]
  /**
   * Claimed by a desk book AND a runner ledger at once.
   *
   * The two are summed, which is correct only if they are different positions
   * on the same contract. They are written by different processes for different
   * tags, so they should be — but a book and a ledger that are two records of
   * ONE position would show as double the broker's quantity, and the operator
   * needs to be told to look before believing the divergence.
   */
  readonly bothSources?: boolean
  /** Present only on a divergence. Plain numbers, no adjectives. */
  readonly note?: string
}

/**
 * A broker position no desk record claims. A fact, not a fault.
 *
 * `symbol` is the DESK's tradingsymbol when the token resolved, and the broker's
 * own spelling plus the token that did not resolve when it did not — see
 * `unresolvedLabel`. One field, because the operator's question is the same
 * either way: which contract is this, and where do I go and look at it.
 */
export interface UnattributableRow {
  readonly symbol: string
  readonly broker: number
}

export interface PositionsCompareReport {
  readonly asOf: number
  /** The IST day this pass ran on — what the once-a-day summary is keyed by. */
  readonly day: string
  /** Always `live`. Stated in the document so a reader never has to assume it. */
  readonly mode: 'live'
  /**
   * Whether a comparison was actually performed. FALSE MEANS NO VERDICT — every
   * `broker` is null, `divergent` is empty, and `reason` says why.
   */
  readonly comparable: boolean
  /** Empty when comparable; otherwise the reason there is no verdict. */
  readonly reason: string
  /** When the broker snapshot this was compared against was taken. */
  readonly brokerAsOf: number | null
  /** Every contract any desk record claims, whether or not it agrees. */
  readonly symbols: readonly SymbolCompare[]
  /** Symbols where the desk's total and the broker's differ. */
  readonly divergent: readonly string[]
  /** Broker rows the desk cannot attribute — reported, never alarmed on. */
  readonly unattributable: readonly UnattributableRow[]
  /**
   * Ledger legs whose LOT SIZE nothing could resolve, so their contract
   * quantity is unknown and they are excluded from every comparison above.
   * Named rather than counted as zero: an expired contract is gone from the
   * instrument master, and zero would quietly retire a leg the ledger believes
   * in — the exact 2026-08-10 mirror-leg shape.
   */
  readonly unmeasurable: readonly string[]
  /** The cadence this was produced on, so a reader can age it correctly. */
  readonly intervalMs: number
}

/** A `desk-books` document, narrowed to what this compares. `StoredBook` fits. */
export interface BookPositions {
  readonly tag: string
  readonly legs: readonly { readonly instrument: { readonly tradingsymbol: string }; readonly qty: number }[]
}

/** One runner ledger, already converted from lots to contract quantity. */
export interface LedgerPositions {
  readonly tag: string
  readonly symbols: readonly { readonly tradingsymbol: string; readonly qty: number }[]
  /** Legs whose lot size nothing could answer for. */
  readonly unmeasurable: readonly string[]
}

/**
 * Everything this job may do. THE ABSENCE OF A WRITE PORT IS THE GUARANTEE:
 * there is no way from here to place an order, edit a book or clear a ledger.
 * `save` writes this job's own report; `journal` writes one order-feed line.
 */
export interface PositionsComparePorts {
  now(): number
  log(msg: string, ctx?: Record<string, unknown>): void
  /** The gateway's broker snapshot document, or null when it writes none. */
  snapshot(): Promise<Record<string, unknown> | null>
  /** Every LIVE `desk-books` document. */
  books(): Promise<readonly BookPositions[]>
  /** Every `runner:positions` ledger on the LIVE rail. */
  ledgers(): Promise<readonly LedgerPositions[]>
  /**
   * THE JOIN, as a port: an XTS exchange token -> the desk's tradingsymbol.
   *
   * A READ of the instrument master and nothing else — it cannot write, and it
   * answers `null` rather than guessing, which is the whole of its contract.
   * It is a port at all because the master is refreshed out of band and this
   * job must ask the CURRENT one on every pass; a resolver captured once would
   * keep answering out of yesterday's dump, which for an expiry-day roll is the
   * difference between a resolved contract and a phantom.
   */
  symbolForToken(exchangeToken: number): string | null
  save(report: PositionsCompareReport): Promise<void>
  /** The last stored report, for a process that has not run a pass yet. */
  load(): Promise<PositionsCompareReport | null>
  /** `DeskStore.journalBlocked` — the order feed. Never throws. */
  journal(events: readonly Record<string, unknown>[]): Promise<void>
  /**
   * Does the order feed ALREADY carry this IST day's summary?
   *
   * A READ, and the only reason it is a port at all: "once a day" has to
   * survive a restart, and the flag that enforced it lived in memory — the one
   * place a restart is guaranteed to erase. The feed is where the row actually
   * is, so the feed is what is asked.
   */
  summarised(day: string): Promise<boolean>
  /** The dashboard push. Absent when nothing is attached. */
  notify?(mode: 'live', event: Record<string, unknown>): void
}

// -------------------------------------------------------- reading the broker

/**
 * THE BROKER'S OWN SPELLING of the contract — `BHEL 25AUG2026 CE 415`.
 *
 * `TradingSymbol` is what XTS sends and what `packages/brokers/src/xts.ts` maps
 * — the alternatives are here only so a different XTS build cannot make this
 * job silently compare nothing.
 *
 * IT IS A LABEL, NOT A KEY. Nothing joins on this string and nothing parses it:
 * the desk's records are written in Kite's spelling, and the two are related by
 * a token lookup (`brokerExchangeToken`), never by string surgery. It is carried
 * so that a row which could not be resolved can still be named in the words the
 * operator will see in the broker's own terminal.
 */
export function brokerSymbolOf(row: Record<string, unknown>): string {
  for (const key of ['TradingSymbol', 'tradingSymbol', 'tradingsymbol']) {
    const v = row[key]
    if (typeof v === 'string' && v.trim() !== '') return v
  }
  return ''
}

/**
 * The EXCHANGE TOKEN on a broker row — the identifier both systems hold.
 *
 * XTS calls it `ExchangeInstrumentId` and sends it as a STRING in this account's
 * replies (`"ExchangeInstrumentId":"149471"`), which is why it is coerced rather
 * than type-checked; the casing alternatives are here for the same reason the
 * quantity's are, so a different XTS build cannot silently stop this job
 * resolving anything.
 *
 * NULL, NEVER ZERO OR A GUESS. A row without a readable id cannot be joined to
 * any desk record, and the honest report of that is an unattributable row
 * carrying the reason — not a match found by comparing names.
 */
export function brokerExchangeToken(row: Record<string, unknown>): number | null {
  for (const key of [
    'ExchangeInstrumentId',
    'ExchangeInstrumentID',
    'exchangeInstrumentId',
    'exchangeInstrumentID',
  ]) {
    const v = row[key]
    if (v === undefined || v === null || v === '') continue
    const n = Number(v)
    if (Number.isFinite(n) && Number.isInteger(n) && n > 0) return n
  }
  return null
}

/**
 * How a broker row is named when the token resolved to nothing.
 *
 * BOTH SPELLINGS, deliberately. The operator has to be able to find this row in
 * the broker's terminal (where it is `BHEL 25AUG2026 CE 415`) AND in the desk's
 * own records and the instrument dump (where contracts are numbers), and a row
 * that failed to resolve is precisely the one where neither of us can supply the
 * other's name for it. The token printed is the exchange token multiplied back
 * up by 256 — the packed form the desk's dump is keyed by; its bottom byte (the
 * exchange segment) is the one thing XTS did not send, so the number locates the
 * contract in the dump to within that byte and no further. Nothing is inferred
 * from it, it is printed so a human can go and look.
 */
export function unresolvedLabel(brokerSymbol: string, exchangeToken: number | null): string {
  const named = brokerSymbol === '' ? 'unnamed broker row' : brokerSymbol
  return exchangeToken === null
    ? `${named} [no ExchangeInstrumentId on the broker row]`
    : `${named} [token ${exchangeToken * 256} not in master]`
}

/**
 * The SIGNED net quantity, or null when this row carries none we recognise.
 *
 * `Quantity` first, because that is the field XTS fills for a net-wise position
 * and the one `xts.ts:positions()` reads — already signed, which is exactly why
 * it must not be re-signed here.
 *
 * NULL, NEVER ZERO. Zero is a claim: "the broker holds nothing on this
 * contract". An unrecognised row read as zero would turn a field we failed to
 * parse into a phantom divergence against a real position — so an unreadable
 * row withdraws the whole verdict instead (see `comparePositions`).
 */
export function brokerNetQty(row: Record<string, unknown>): number | null {
  for (const key of ['Quantity', 'NetQty', 'netQty', 'Netqty', 'NetQuantity']) {
    const v = row[key]
    const n = Number(v)
    if (v !== undefined && v !== null && v !== '' && Number.isFinite(n)) return n
  }
  // Some builds publish only the two open sides. Both must be present: one
  // alone is half a position and would read as a long or a short that is not
  // there.
  const buy = Number(row['OpenBuyQuantity'])
  const sell = Number(row['OpenSellQuantity'])
  if (Number.isFinite(buy) && Number.isFinite(sell)) return buy - sell
  return null
}

/**
 * Did the broker really answer with an empty list, or with something we could
 * not read?
 *
 * The gateway records the shape whenever a list came back empty
 * (`emptyDiagnostic`), precisely so the two can be told apart. `array(0)` and
 * the "Data Not Available" reply are genuine emptiness; anything else means the
 * reply was not a list at all, and treating it as an empty book is the failure
 * mode `broker-snapshot.ts` was built to stop.
 *
 * An ABSENT diagnostic on an empty list means the gateway predates the field —
 * treated as unreadable for the same reason: we do not know, and not knowing
 * must not become a verdict.
 */
function emptinessIsReal(snapshot: Record<string, unknown>): { ok: boolean; shape: string } {
  const diag = snapshot['emptyDiagnostic']
  const shape =
    typeof diag === 'object' && diag !== null
      ? String((diag as Record<string, unknown>)['positions'] ?? '')
      : ''
  if (shape === '') return { ok: false, shape: 'no shape was recorded' }
  return { ok: shape.startsWith('array(') || /data not available/i.test(shape), shape }
}

// ------------------------------------------------------- reading the ledgers

/**
 * Every `runner:positions` document on the LIVE rail, in contract quantity.
 *
 * The scope is one string, `TAG:mode` (`MongoStateStore` namespaces by whatever
 * it is handed), so the split happens here — and a document whose scope has no
 * recognisable mode is DROPPED rather than assumed live, the same rule
 * `routes/runner.ts` applies for the same reason.
 *
 * LOTS x LOT SIZE, from the entry's OWN `instrument.lotSize` first and the
 * instrument master second. That order is deliberate: the entry records the lot
 * size the position was actually booked at, and the master cannot answer for an
 * EXPIRED contract at all — which is the one kind of stuck leg this comparison
 * most needs to be able to see.
 */
export function readLiveLedgers(
  docs: readonly Record<string, unknown>[],
  lotSizeOf: (tradingsymbol: string) => number | null,
): LedgerPositions[] {
  const out: LedgerPositions[] = []
  for (const doc of docs) {
    const scope = doc['tag']
    if (typeof scope !== 'string') continue
    const at = scope.lastIndexOf(':')
    if (at <= 0 || scope.slice(at + 1) !== 'live') continue
    const tag = scope.slice(0, at)
    const value = doc['value']
    if (!Array.isArray(value)) continue

    const symbols: { tradingsymbol: string; qty: number }[] = []
    const unmeasurable: string[] = []
    for (const raw of value) {
      if (typeof raw !== 'object' || raw === null) continue
      const entry = raw as Record<string, unknown>
      const symbol = typeof entry['tradingsymbol'] === 'string' ? entry['tradingsymbol'] : ''
      if (symbol === '') continue
      const lots = Number(entry['lots'])
      if (!Number.isFinite(lots) || lots === 0) continue
      const instrument = entry['instrument']
      const stored =
        typeof instrument === 'object' && instrument !== null
          ? Number((instrument as Record<string, unknown>)['lotSize'])
          : NaN
      const lotSize = Number.isFinite(stored) && stored > 0 ? stored : lotSizeOf(symbol)
      if (lotSize === null || !(lotSize > 0)) {
        unmeasurable.push(symbol)
        continue
      }
      symbols.push({ tradingsymbol: symbol, qty: lots * lotSize })
    }
    out.push({ tag, symbols, unmeasurable })
  }
  return out
}

// ------------------------------------------------------------ the comparison

export interface CompareInput {
  readonly now: number
  readonly snapshot: Record<string, unknown> | null
  readonly books: readonly BookPositions[]
  readonly ledgers: readonly LedgerPositions[]
  readonly intervalMs: number
  readonly maxBrokerAgeMs?: number
  /**
   * The JOIN: an XTS exchange token -> the tradingsymbol every desk record uses.
   *
   * REQUIRED, not optional with a fallback. The fallback that suggests itself —
   * "compare the names when the token cannot be resolved" — is the defect this
   * function was rewritten to remove, and leaving it available as a default
   * would let one forgetful call site reintroduce it silently.
   */
  readonly symbolForToken: (exchangeToken: number) => string | null
}

/**
 * The whole judgement, as one pure function.
 *
 * The desk side is ALWAYS reported, even when there is no verdict to give:
 * roadmap 16 asks for a union over `desk-books` and the runner ledger as well
 * as the comparison, and "the broker could not be reached" is no reason to stop
 * answering what the desk itself believes.
 */
export function comparePositions(input: CompareInput): PositionsCompareReport {
  const { now, snapshot, books, ledgers, intervalMs, symbolForToken } = input
  const maxAge = input.maxBrokerAgeMs ?? DEFAULT_MAX_BROKER_AGE_MS

  // ---- the desk's two records, summed per contract
  const deskBooks = new Map<string, number>()
  const deskLedger = new Map<string, number>()
  const claimedBy = new Map<string, Set<string>>()
  const claim = (symbol: string, tag: string): void => {
    const set = claimedBy.get(symbol) ?? new Set<string>()
    set.add(tag)
    claimedBy.set(symbol, set)
  }
  for (const b of books) {
    for (const leg of b.legs) {
      const symbol = leg.instrument.tradingsymbol
      if (symbol === '' || !Number.isFinite(leg.qty) || leg.qty === 0) continue
      deskBooks.set(symbol, (deskBooks.get(symbol) ?? 0) + leg.qty)
      claim(symbol, b.tag)
    }
  }
  const unmeasurable: string[] = []
  for (const l of ledgers) {
    for (const s of l.symbols) {
      if (s.tradingsymbol === '' || !Number.isFinite(s.qty) || s.qty === 0) continue
      deskLedger.set(s.tradingsymbol, (deskLedger.get(s.tradingsymbol) ?? 0) + s.qty)
      claim(s.tradingsymbol, l.tag)
    }
    for (const u of l.unmeasurable) if (!unmeasurable.includes(u)) unmeasurable.push(u)
  }

  // ---- the broker's, and whether it may be believed
  /** Keyed by the DESK's tradingsymbol, reached through the token. */
  const broker = new Map<string, number>()
  /**
   * Broker rows whose token named no contract in the master, keyed by the label
   * that carries both spellings. Kept SEPARATE from `broker` so that a row we
   * could not name can never be compared against a desk record — there is no
   * desk record it could honestly be compared against.
   */
  const unresolved = new Map<string, number>()
  const brokerAsOf = typeof snapshot?.['asOf'] === 'number' ? (snapshot['asOf'] as number) : null
  let reason = ''
  if (snapshot === null) {
    reason =
      'no broker snapshot — this desk\'s gateway publishes none (simulate or delta; the XTS ' +
      'writer is gone), so there is nothing to compare against'
  } else if (snapshot['ok'] !== true) {
    const err = typeof snapshot['error'] === 'string' && snapshot['error'] !== ''
      ? snapshot['error']
      : 'no reason recorded'
    reason = `the broker snapshot is INCOMPLETE (${err}) — its positions are not evidence of anything`
  } else if (brokerAsOf === null || now - brokerAsOf > maxAge) {
    reason =
      `the broker snapshot is too old to compare against (` +
      `${brokerAsOf === null ? 'it carries no timestamp' : `${Math.round((now - brokerAsOf) / 1000)}s`}) — ` +
      'the gateway rewrites it every 30s, so this one is not current'
  } else {
    const rows = Array.isArray(snapshot['positions'])
      ? (snapshot['positions'] as Record<string, unknown>[])
      : null
    if (rows === null) {
      reason = 'the broker snapshot carries no positions list'
    } else if (rows.length === 0) {
      const empty = emptinessIsReal(snapshot)
      if (!empty.ok) {
        reason =
          `the broker's position list came back empty and unreadable (${empty.shape}) — ` +
          '"the broker holds nothing" and "the reply was not a shape we could read" are the same ' +
          'empty array, and only the first is a comparison'
      }
    } else {
      for (const row of rows) {
        const brokerSymbol = brokerSymbolOf(row)
        const qty = brokerNetQty(row)
        if (qty === null) {
          /**
           * STILL WITHDRAWS THE VERDICT, and only this does. A quantity we
           * could not read is a NUMBER we cannot compare, and comparing the
           * rest of the book while one row's size is unknown would report the
           * desk as diverging by exactly the amount we failed to parse.
           */
          reason =
            `a broker position row could not be read (${brokerSymbol === '' ? 'no trading symbol' : brokerSymbol}) — ` +
            'a position we cannot parse is a position we cannot compare, so no verdict is given'
          break
        }
        /**
         * A row that cannot be RESOLVED does not withdraw the verdict; it is
         * reported as unattributable with the reason. The distinction is the
         * one the header argues: an expired contract or a master mid-refresh is
         * a routine fact about ONE row, and letting it silence the comparison
         * of the other sixteen would be the crying-wolf failure inverted —
         * every genuine divergence on the desk hidden behind one stuck leg.
         */
        const exchangeToken = brokerExchangeToken(row)
        const symbol = exchangeToken === null ? null : symbolForToken(exchangeToken)
        // Summed: XTS answers per product type, and NRML + MIS on one contract
        // is two rows and one position. That holds for a row we could not name
        // as much as for one we could, so both maps sum.
        if (symbol === null || symbol === '') {
          const label = unresolvedLabel(brokerSymbol, exchangeToken)
          unresolved.set(label, (unresolved.get(label) ?? 0) + qty)
          continue
        }
        broker.set(symbol, (broker.get(symbol) ?? 0) + qty)
      }
    }
  }
  const comparable = reason === ''

  // ---- the rows
  const symbols: SymbolCompare[] = []
  const divergent: string[] = []
  const claimed = new Set([...deskBooks.keys(), ...deskLedger.keys()])
  for (const symbol of [...claimed].sort()) {
    const bookQty = deskBooks.get(symbol) ?? 0
    const ledgerQty = deskLedger.get(symbol) ?? 0
    const desk = bookQty + ledgerQty
    const brokerQty = comparable ? broker.get(symbol) ?? 0 : null
    const agree = brokerQty === null || brokerQty === desk
    if (!agree) divergent.push(symbol)
    const both = bookQty !== 0 && ledgerQty !== 0
    symbols.push({
      symbol,
      broker: brokerQty,
      books: bookQty,
      ledger: ledgerQty,
      agree,
      claimedBy: [...(claimedBy.get(symbol) ?? [])].sort(),
      ...(both ? { bothSources: true } : {}),
      ...(agree ? {} : { note: divergenceNote(desk, bookQty, ledgerQty, brokerQty ?? 0) }),
    })
  }

  // ---- broker rows nobody claims. NEUTRAL. See rule 2 in the header.
  const unattributable: UnattributableRow[] = []
  if (comparable) {
    const rows: UnattributableRow[] = []
    for (const [symbol, qty] of broker) {
      if (qty === 0 || claimed.has(symbol)) continue
      rows.push({ symbol, broker: qty })
    }
    // The rows the master could not name for us. Unclaimable BY CONSTRUCTION:
    // there is no desk symbol to have claimed them under.
    for (const [label, qty] of unresolved) {
      if (qty === 0) continue
      rows.push({ symbol: label, broker: qty })
    }
    unattributable.push(...rows.sort((a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0)))
  }

  return {
    asOf: now,
    day: istDate(now),
    mode: 'live',
    comparable,
    reason,
    brokerAsOf,
    symbols,
    divergent,
    unattributable,
    unmeasurable,
    intervalMs,
  }
}

/** Numbers, and which record said what. No adjectives — the operator judges. */
function divergenceNote(desk: number, books: number, ledger: number, broker: number): string {
  const source = `books ${books}, ledger ${ledger}`
  if (broker === 0) {
    return `the desk claims ${desk} (${source}); the broker reports nothing on this contract`
  }
  if (desk === 0) {
    return `no desk record claims this contract; the broker reports ${broker}`
  }
  return `the desk claims ${desk} (${source}); the broker reports ${broker}`
}

// ------------------------------------------------------------- the card line

export interface CompareCard {
  readonly detail: string
  readonly lastSeenMs: number | null
  readonly expectedEveryMs: number
  readonly extra: Record<string, unknown>
}

/**
 * The Status page's one line, built from the stored document.
 *
 * DIVERGENCE LEADS, in capitals, and everything else reads as the statement of
 * fact it is. The card's COLOUR is left to the age of the report — that is what
 * `routes/system.ts`'s three states mean, and painting a divergence "stale"
 * would put the wrong word in the banner at the top of the page.
 */
export function compareCardSummary(
  doc: Record<string, unknown> | null,
  nowMs: number,
): CompareCard {
  if (doc === null) {
    return {
      detail:
        'no comparison has run yet — the broker/books/ledger comparison publishes its first ' +
        'report one interval after the bridge starts',
      lastSeenMs: null,
      expectedEveryMs: DEFAULT_COMPARE_MS,
      extra: { available: false },
    }
  }
  const report = doc as unknown as PositionsCompareReport
  const asOf = typeof report.asOf === 'number' ? report.asOf : null
  const intervalMs =
    typeof report.intervalMs === 'number' && report.intervalMs > 0
      ? report.intervalMs
      : DEFAULT_COMPARE_MS
  const symbols = Array.isArray(report.symbols) ? report.symbols : []
  const divergent = Array.isArray(report.divergent) ? report.divergent : []
  const unattributable = Array.isArray(report.unattributable) ? report.unattributable : []
  const unmeasurable = Array.isArray(report.unmeasurable) ? report.unmeasurable : []

  const parts: string[] = []
  if (divergent.length > 0) {
    parts.push(`${divergent.length} DIVERGENT (${divergent.slice(0, 4).join(', ')})`)
  }
  parts.push(
    report.comparable === true
      ? `${symbols.length} desk contracts compared to the broker`
      : `${symbols.length} desk contracts — NOT compared: ${String(report.reason ?? '')}`,
  )
  if (unattributable.length > 0) {
    // Plain words. These are routinely legitimate — see rule 2 in the header.
    parts.push(
      `${unattributable.length} broker position(s) the desk cannot attribute ` +
        `(${unattributable.slice(0, 3).map((u) => u.symbol).join(', ')})`,
    )
  }
  if (unmeasurable.length > 0) {
    parts.push(`${unmeasurable.length} ledger leg(s) with no known lot size, excluded`)
  }
  return {
    detail: parts.join(' · '),
    lastSeenMs: asOf,
    expectedEveryMs: intervalMs,
    extra: {
      available: true,
      comparable: report.comparable === true,
      divergent: divergent.length,
      compared: symbols.length,
      unattributable: unattributable.length,
      unmeasurable: unmeasurable.length,
      brokerAsOf: report.brokerAsOf ?? null,
      ageMs: asOf === null ? null : nowMs - asOf,
    },
  }
}

// ------------------------------------------------------------------ the loop

export interface PositionsCompareOptions {
  readonly intervalMs?: number
  readonly maxBrokerAgeMs?: number
}

export interface PositionsComparer {
  /** One pass. Null when a pass was already in flight and this one did nothing. */
  run(nowMs: number): Promise<PositionsCompareReport | null>
  /** The last report — this process's, or the stored one after a restart. */
  last(): Promise<PositionsCompareReport | null>
}

/**
 * The comparer. A CLASS because three things must survive between passes: the
 * single-flight flag, the IST day the once-a-day summary last went out, and the
 * divergence last named in the log.
 */
class Comparer implements PositionsComparer {
  readonly #d: PositionsComparePorts
  readonly #intervalMs: number
  readonly #maxBrokerAgeMs: number
  #running = false
  #last: PositionsCompareReport | null = null
  /** IST day the once-a-day summary has already been published for. */
  #summarisedFor = ''
  /** IST day the FEED has already been asked about. One query per day, not per pass. */
  #askedFeedFor = ''
  /** The divergence last written to the log, so a steady state is said once. */
  #loggedSignature = ''

  constructor(ports: PositionsComparePorts, opts: PositionsCompareOptions) {
    this.#d = ports
    this.#intervalMs = opts.intervalMs ?? DEFAULT_COMPARE_MS
    this.#maxBrokerAgeMs = opts.maxBrokerAgeMs ?? DEFAULT_MAX_BROKER_AGE_MS
  }

  /**
   * SINGLE-FLIGHT. A pass that overruns its interval must not have a second one
   * land on top of it: they read the same three sources and both would write
   * the report, and the nightly summary could go out twice for one day. Dropping
   * the overlapping pass rather than queueing it is safe for the reason it is
   * safe in the day guard and the runner — this is an idempotent read, and the
   * next pass does everything the dropped one would have.
   */
  async run(nowMs: number): Promise<PositionsCompareReport | null> {
    if (this.#running) return null
    this.#running = true
    try {
      /**
       * SEQUENTIAL, not `Promise.all`. Three reads against a database that is
       * most likely to be struggling exactly when someone wants this answer —
       * the same trade `routes/system.ts` makes and for the same reason.
       */
      const snapshot = await this.#d.snapshot()
      const books = await this.#d.books()
      const ledgers = await this.#d.ledgers()
      const report = comparePositions({
        now: nowMs,
        snapshot,
        books,
        ledgers,
        intervalMs: this.#intervalMs,
        maxBrokerAgeMs: this.#maxBrokerAgeMs,
        symbolForToken: (token) => this.#d.symbolForToken(token),
      })
      this.#last = report
      await this.#d.save(report)
      this.#noteInLog(report)
      await this.#summarise(report, nowMs)
      return report
    } finally {
      this.#running = false
    }
  }

  async last(): Promise<PositionsCompareReport | null> {
    if (this.#last !== null) return this.#last
    // A bridge that has just restarted has no pass of its own yet, and the
    // stored report is a real answer — dated, and it says so.
    return await this.#d.load()
  }

  /**
   * The log line, ONCE PER DISTINCT STATE.
   *
   * A divergence that persists for a week is one fact, not two thousand. The
   * signature changes when the set of divergent symbols does, and a desk that
   * comes back into agreement says so once too — silence would otherwise be
   * indistinguishable from the job having died.
   */
  #noteInLog(report: PositionsCompareReport): void {
    const signature = report.comparable
      ? `ok:${report.divergent.join(',')}`
      : `nc:${report.reason}`
    if (signature === this.#loggedSignature) return
    this.#loggedSignature = signature
    if (!report.comparable) {
      this.#d.log('positions compare: no verdict this pass', { reason: report.reason })
      return
    }
    if (report.divergent.length === 0) {
      this.#d.log('positions compare: the desk and the broker agree', {
        compared: report.symbols.length,
        unattributable: report.unattributable.length,
      })
      return
    }
    this.#d.log(
      'positions compare: the desk and the broker DISAGREE — reported only, nothing has been changed',
      {
        divergent: report.divergent,
        unattributable: report.unattributable.length,
        unmeasurable: report.unmeasurable,
      },
    )
  }

  /**
   * The once-a-day summary: journalled into the ORDER FEED and pushed.
   *
   * ONLY WHEN IT DIVERGES, and only once per IST day. The journal is where an
   * operator looks to answer "what happened today" without a shell, and a daily
   * line saying "everything agreed" would bury the one that does not. Agreement
   * is in the log and on the Status card instead.
   *
   * AFTER THE CLOSE, because a divergence at 11:00 is as likely to be a position
   * mid-flight as a real one.
   *
   * "ONCE A DAY" IS TWO SEPARATE FACTS, and each is enforced where it lives:
   *
   *  1. THE DAY IS STAMPED WHEN THE EVENT IS SENT, NOT WHEN A PASS RUNS. The
   *     16:00 pass on an agreeing desk has nothing to report, and stamping the
   *     day there spent the day's single line on it — so the 17:10 pass that
   *     found a real divergence journalled NOTHING, and the one record an
   *     operator reads to answer "what happened today" simply did not mention
   *     it. The stamp still precedes the write, so a journal that throws cannot
   *     produce the same line on every pass for the rest of the evening.
   *  2. THE FEED, NOT MEMORY, IS ASKED WHETHER TODAY IS DONE. `#summarisedFor`
   *     is erased by exactly the event most likely to happen on a bad evening —
   *     a restart — and the day's DIVERGENT row then went in twice, which reads
   *     as two evenings of divergence in the feed. Asked ONCE per day, before
   *     the first summary of it, and the answer is remembered.
   */
  async #summarise(report: PositionsCompareReport, nowMs: number): Promise<void> {
    if (istMinutesOfDay(nowMs) < NIGHTLY_AFTER_IST_MINUTES) return
    if (this.#summarisedFor === report.day) return
    if (this.#askedFeedFor !== report.day) {
      // Stamped BEFORE the await, so a read that throws is not retried on every
      // pass — and so an overlapping day rollover cannot ask twice.
      this.#askedFeedFor = report.day
      let already = false
      try {
        already = await this.#d.summarised(report.day)
      } catch (err) {
        /**
         * UNKNOWN IS NOT "ALREADY DONE". A feed we cannot read is no evidence
         * that the day's row is in it, and the failure that costs more is the
         * silent one: a duplicate line is an operator noticing twice, a missing
         * line is a divergence nobody was told about. Said out loud so the
         * duplicate, if it comes, is explainable.
         */
        this.#d.log('positions compare: could not read the feed for today’s summary — assuming it is not there', {
          day: report.day,
          error: err instanceof Error ? err.message : String(err),
        })
      }
      if (already) {
        this.#summarisedFor = report.day
        return
      }
    }
    if (!report.comparable || report.divergent.length === 0) return

    this.#summarisedFor = report.day
    const event = summaryEvent(report)
    await this.#d.journal([event])
    if (this.#d.notify === undefined) return
    try {
      this.#d.notify('live', event)
    } catch {
      /* a dashboard that missed an update is an inconvenience */
    }
  }
}

/**
 * The daily divergence, as a row of the order feed.
 *
 * Shaped like `reconcile-live.ts`'s own journal events so the existing feed
 * renders it with no changes, and `detail.mode` is stamped because an unstamped
 * event is read as LIVE — which this one is.
 *
 * `clientOrderId` is deterministic per day: the feed's row for "today's
 * positions comparison" is one row, not one per restart — and because it is
 * deterministic, it is also the QUESTION a restarted process asks the feed
 * (`summarised`). One name, built in one place, for both.
 */
export function summaryClientOrderId(day: string): string {
  return `positions-compare-${day}`
}

export function summaryEvent(report: PositionsCompareReport): Record<string, unknown> {
  const named = report.symbols.filter((s) => !s.agree)
  const detail = named
    .slice(0, 5)
    .map((s) => `${s.symbol}: desk ${s.books + s.ledger} vs broker ${s.broker ?? 0}`)
    .join('; ')
  return {
    clientOrderId: summaryClientOrderId(report.day),
    phase: 'STATUS',
    ok: false,
    tag: 'positions-compare',
    // There is no one contract this is about, so the job's name is the only
    // honest identifier — the same choice `day-guard.ts` makes.
    tradingsymbol: 'positions-compare',
    ts: report.asOf,
    status: 'DIVERGENT',
    error:
      `positions comparison: ${report.divergent.length} contract(s) where the desk and the broker ` +
      `disagree — ${detail}${named.length > 5 ? ` (+${named.length - 5} more)` : ''}. ` +
      'Nothing has been changed; this is a report.',
    detail: {
      mode: 'live',
      op: 'positions-compare',
      day: report.day,
      divergent: report.divergent,
      unattributable: report.unattributable.length,
      unmeasurable: report.unmeasurable,
      brokerAsOf: report.brokerAsOf,
    },
  }
}

export function createPositionsComparer(
  ports: PositionsComparePorts,
  opts: PositionsCompareOptions = {},
): PositionsComparer {
  return new Comparer(ports, opts)
}

// ------------------------------------------------------------------ the wiring

/** The real collections behind `PositionsComparePorts`. */
export function positionsComparePorts(deps: ApiDeps): PositionsComparePorts {
  return {
    now: () => deps.now(),
    log: deps.log,
    snapshot: async () =>
      (await deps.db
        .collection(BROKER_SNAPSHOT_COLLECTION)
        .findOne({ _id: BROKER_SNAPSHOT_ID })) as Record<string, unknown> | null,
    books: async () => {
      // LIVE ONLY. Paper legs never reach a broker.
      const docs = await deps.store.allBooks('live')
      return docs.map((d) => ({ tag: d.tag, legs: d.legs }))
    },
    ledgers: async () => {
      const docs = (await deps.db
        .collection(STATE_COLLECTION)
        .find({ key: POSITIONS_KEY })
        .toArray()) as Record<string, unknown>[]
      const master = deps.master.current()
      return readLiveLedgers(docs, (symbol) => lotSizeFromMaster(master, symbol))
    },
    /**
     * `deps.master.current()` on EVERY call, never hoisted: see the port's own
     * comment. The try/catch is the same bargain `lotSizeFromMaster` makes —
     * a master that throws answers "I do not know", which this job already has
     * an honest report for, rather than taking the pass down with it.
     */
    symbolForToken: (exchangeToken) => {
      try {
        return deps.master.current().resolveExchangeToken(exchangeToken)?.tradingsymbol ?? null
      } catch {
        return null
      }
    },
    save: async (report) => {
      await deps.db
        .collection(POSITIONS_COMPARE_COLLECTION)
        .updateOne({ _id: POSITIONS_COMPARE_ID }, { $set: { ...report } }, { upsert: true })
    },
    load: async () => {
      const doc = (await deps.db
        .collection(POSITIONS_COMPARE_COLLECTION)
        .findOne({ _id: POSITIONS_COMPARE_ID })) as Record<string, unknown> | null
      return doc === null ? null : (doc as unknown as PositionsCompareReport)
    },
    journal: async (events) => {
      await deps.store.journalBlocked(events)
    },
    /**
     * ONE `findOne` ON THE DAY'S DETERMINISTIC ID. Not a range scan of the
     * feed and not a count: the row this asks about has exactly one name, and
     * it is asked at most once per IST day per process.
     *
     * It is deliberately NOT scoped to a time window. The row carries the day
     * in its own id, so a restart at 23:55 and one at 16:05 ask the same
     * question and get the same answer.
     */
    summarised: async (day) => {
      const doc = await deps.db
        .collection(COLLECTIONS.orderEvents)
        .findOne({ clientOrderId: summaryClientOrderId(day) })
      return doc !== null && doc !== undefined
    },
    ...(deps.stream === undefined
      ? {}
      : { notify: (mode: 'live', event: Record<string, unknown>): void => deps.stream?.publish(mode, event) }),
  }
}

/**
 * The master's lot size for a contract, or null.
 *
 * Null is a real answer and is treated as one: an EXPIRED contract is gone from
 * the master entirely, and that is exactly the leg this comparison most wants
 * to be able to name.
 */
function lotSizeFromMaster(
  master: { resolveSymbol(tradingsymbol: string): InstrumentRef | null },
  tradingsymbol: string,
): number | null {
  try {
    const ref = master.resolveSymbol(tradingsymbol)
    return ref === null || !(ref.lotSize > 0) ? null : ref.lotSize
  } catch {
    return null
  }
}

/**
 * Start the loop. Returns the comparer (the route serves its last result) and a
 * stop function.
 *
 * `.catch` on every tick and `unref()` on the timer, for the reason every other
 * interval in this tree carries both: an unhandled rejection inside a timer is
 * fatal on Node >= 15, and losing the process that routes orders because a
 * housekeeping read failed would be the worst possible trade.
 */
export function startPositionsCompare(
  deps: ApiDeps,
  opts: PositionsCompareOptions = {},
): { comparer: PositionsComparer; stop: () => void } {
  const comparer = createPositionsComparer(positionsComparePorts(deps), opts)
  const intervalMs = opts.intervalMs ?? DEFAULT_COMPARE_MS
  let stopped = false
  const timer = setInterval(() => {
    if (stopped) return
    void comparer.run(deps.now()).catch((err: unknown) => {
      deps.log('positions compare pass failed', {
        error: err instanceof Error ? err.message : String(err),
      })
    })
  }, intervalMs)
  timer.unref()
  return {
    comparer,
    stop: (): void => {
      stopped = true
      clearInterval(timer)
    },
  }
}
