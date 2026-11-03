/**
 * Exchange quantity freeze, and the order splitting it forces.
 *
 * NSE refuses any single F&O order above the underlying's "volume freeze
 * quantity". An order over it is rejected outright, so a large position has to
 * be sliced into tranches that each sit under the limit.
 *
 * THE FORMULA, verified against NSE's own published files (2026-07-27):
 *
 *     maxLotsPerOrder = floor(VOL_FRZ_QTY / marketLot)
 *
 * `VOL_FRZ_QTY` (qtyfreeze.csv) is in CONTRACTS; `xtsOrder.js:104` compares
 * LOTS, hence the division. Checked against the legacy hardcoded table:
 *
 *     NIFTY      1800 / 65  = 27   (legacy 27  — agrees)
 *     BANKNIFTY   600 / 30  = 20   (legacy 20  — agrees)
 *     FINNIFTY   1800 / 60  = 30   (legacy 45  — STALE)
 *     MIDCPNIFTY 2800 / 120 = 23   (legacy 56  — STALE)
 *
 * The two disagreements are the point. FINNIFTY's legacy 45 was right when the
 * lot was 40, MIDCPNIFTY's 56 when it was 50; the exchange revised both, and a
 * hardcoded table cannot know. Those two values now EXCEED the freeze limit, so
 * an order sized against them is rejected by the exchange. Derived from data,
 * this cannot drift.
 *
 * SOURCE NOTE: NSE circular 29/2024 (15 Mar 2024, "Discontinuation of Quantity
 * Freeze and Permitted Lot Size Report") announced that `qtyfreeze.csv` and
 * `fo_mktlots.csv` would be withdrawn in favour of the MII contract file
 * (`NSE_FO_contract_<ddmmyyyy>.csv.gz`). Both legacy files still serve as of
 * 2026-07-27 and are used here, but the loader must fail soft and fall back to
 * stored values — the day they stop, an unguarded fetch would leave every
 * symbol with no limit.
 */

/** One row of NSE's qtyfreeze.csv. */
export interface FreezeRow {
  readonly symbol: string
  /** Volume freeze quantity, in CONTRACTS. */
  readonly freezeQty: number
}

/** Parse NSE's `qtyfreeze.csv`. Columns: `S.No., SYMBOL, VOL_FRZ_QTY`. */
export function parseFreezeCsv(text: string): FreezeRow[] {
  const out: FreezeRow[] = []
  const lines = text.split('\n')
  for (const line of lines.slice(1)) {
    const f = line.split(',')
    if (f.length < 3) continue
    const symbol = (f[1] ?? '').trim()
    const freezeQty = Number((f[2] ?? '').trim())
    if (symbol === '' || !Number.isFinite(freezeQty) || freezeQty <= 0) continue
    out.push({ symbol, freezeQty })
  }
  return out
}

export class FreezeLimits {
  readonly #bySymbol = new Map<string, number>()

  constructor(rows: Iterable<FreezeRow> = []) {
    for (const r of rows) this.#bySymbol.set(r.symbol, r.freezeQty)
  }

  get size(): number {
    return this.#bySymbol.size
  }

  /** Freeze quantity in contracts, or null when the symbol is unknown. */
  freezeQty(symbol: string): number | null {
    return this.#bySymbol.get(symbol) ?? null
  }

  /**
   * Largest number of lots permitted in ONE order.
   *
   * Null when either input is unknown. Null must mean "do not know", never a
   * fallback: `xtsOrder.js:104` compares against an absent entry with
   * `qty <= undefined`, which is false, and drops into `tranches(qty,
   * undefined)`. An unknown limit has to be visible, not silently infinite.
   */
  maxLotsPerOrder(symbol: string, lotSize: number): number | null {
    const frz = this.freezeQty(symbol)
    if (frz === null || !(lotSize > 0)) return null
    return Math.max(1, Math.floor(frz / lotSize))
  }

  symbols(): readonly string[] {
    return [...this.#bySymbol.keys()].sort()
  }
}

/**
 * Split a quantity into tranches that each clear the freeze limit.
 *
 * Every tranche is a whole number of lots, and they sum EXACTLY to the
 * requested quantity — a split that loses or invents a lot is worse than not
 * splitting, because the resulting position silently differs from the intent.
 *
 * Returns a single tranche when the order is already under the limit, and
 * throws only on inputs that cannot be honoured at all.
 */
export function splitIntoTranches(
  totalLots: number,
  maxLotsPerOrder: number | null,
): number[] {
  if (!Number.isInteger(totalLots) || totalLots <= 0) {
    throw new Error(`totalLots must be a positive integer, got ${totalLots}`)
  }
  // Unknown limit: send as one order rather than inventing a split. The caller
  // is expected to have surfaced the unknown separately.
  if (maxLotsPerOrder === null) return [totalLots]
  if (!Number.isInteger(maxLotsPerOrder) || maxLotsPerOrder <= 0) {
    throw new Error(`maxLotsPerOrder must be a positive integer, got ${maxLotsPerOrder}`)
  }
  if (totalLots <= maxLotsPerOrder) return [totalLots]

  const out: number[] = []
  let left = totalLots
  while (left > 0) {
    const take = Math.min(left, maxLotsPerOrder)
    out.push(take)
    left -= take
  }
  return out
}

/**
 * Is this order over the freeze limit?
 *
 * Separate from the split so a caller can report the condition (and how many
 * orders it will become) before sending anything.
 */
export function exceedsFreeze(totalLots: number, maxLotsPerOrder: number | null): boolean {
  if (maxLotsPerOrder === null) return false
  return totalLots > maxLotsPerOrder
}

// ------------------------------------------------------ BSE contract master

/**
 * One index symbol's freeze row derived from BSE's contract master. Carries
 * the lot as well, because the file states the limit in CONTRACTS and the
 * sync wants to sanity-check that it divides by the lot before storing it.
 */
export interface BseFreezeRow extends FreezeRow {
  readonly lotSize: number
}

/**
 * Parse BSE's ABRIDGED contract master into one freeze row per INDEX symbol.
 *
 * SOURCE: `https://www.bseindia.com/downloads1/Abridged_CO.ZIP`, whose entry
 * `BSE_EQD_CONTRACT_abr_DDMMYYYY.csv` lists every live derivative contract
 * (150 columns, header row, no quoted fields, LF endings as of 2026-09-21).
 * The column that matters is `MaxTradQty` — the single-order quantity cap.
 * BSE notice 20230621-48 ("single order quantity limit … Existing 500,
 * Revised 1000" for SENSEX options) matches `MaxTradQty = 1000` on today's
 * SENSEX option rows, which fixes the UNIT: contracts, exactly as NSE's
 * `VOL_FRZ_QTY`, so `FreezeLimits.maxLotsPerOrder` divides it by the lot the
 * same way.
 *
 * WHICH ROWS ARE INDEX ROWS. Not the ones you would guess. `AsstCd` is the
 * underlying's own code (`BSX`, `BKX`, `BIT`, `RELI` …) and
 * `UndrlygInstrmAsstClss` reads `EDX` on EVERY row, stocks included — neither
 * separates SENSEX from RELIANCE. The discriminator is `FinInstrmNm`: `IO`
 * (index option) and `IF` (index future) versus `SO`/`SF` for stocks. Stock
 * rows are DELIBERATELY dropped: BSE's stock limits differ from NSE's under
 * the same symbol key (RELIANCE 10000 here vs 20000 on NSE) and
 * `desk-freeze-limits` is keyed by symbol alone, so a BSE stock row would
 * silently re-split every NFO order on that stock.
 *
 * ONE NUMBER PER SYMBOL: the MIN of `MaxTradQty` across the symbol's IO and IF
 * rows (SENSEX: futures 500, options 1000 → 500). `FreezeLimits` knows only
 * the symbol and the gateway's `resolveUnderlying` yields `SENSEX` for both a
 * future and an option, so the stored value has to be safe for whichever
 * contract turns up. Over-splitting an option order into 25-lot slices is
 * harmless; under-splitting a futures order is an exchange rejection. The
 * lot is likewise the MIN seen, though BSE lists one lot per index.
 *
 * Columns are found by HEADER NAME. A missing header name throws, naming the
 * column — that is what lets the sync fail soft with a message instead of
 * storing an empty table when BSE reshuffles or renames the file.
 */
export function parseBseContractCsv(text: string): BseFreezeRow[] {
  const lines = text.split(/\r?\n/)
  const header = (lines[0] ?? '').split(',').map((h) => h.trim())
  const col = (name: string): number => {
    const i = header.indexOf(name)
    if (i < 0) throw new Error(`BSE contract master: header lacks ${name}`)
    return i
  }
  const iKind = col('FinInstrmNm')
  const iSymbol = col('TckrSymb')
  const iLot = col('MinLot')
  const iQty = col('MaxTradQty')

  const bySymbol = new Map<string, { freezeQty: number; lotSize: number }>()
  for (const line of lines.slice(1)) {
    const f = line.split(',')
    const kind = (f[iKind] ?? '').trim()
    if (kind !== 'IO' && kind !== 'IF') continue
    const symbol = (f[iSymbol] ?? '').trim()
    const freezeQty = Number((f[iQty] ?? '').trim())
    const lotSize = Number((f[iLot] ?? '').trim())
    if (symbol === '' || !Number.isFinite(freezeQty) || freezeQty <= 0) continue
    if (!Number.isFinite(lotSize) || lotSize <= 0) continue
    const prev = bySymbol.get(symbol)
    if (prev === undefined) bySymbol.set(symbol, { freezeQty, lotSize })
    else bySymbol.set(symbol, { freezeQty: Math.min(prev.freezeQty, freezeQty), lotSize: Math.min(prev.lotSize, lotSize) })
  }
  return [...bySymbol.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([symbol, v]) => ({ symbol, freezeQty: v.freezeQty, lotSize: v.lotSize }))
}
