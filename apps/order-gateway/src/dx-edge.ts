/**
 * THE DELTA EDGE OF THE GATEWAY (spec §5.4a fees, §8 live gates).
 *
 * Three questions, each asked of one order and answered without IO:
 *
 *   1. WHICH BROKER. Delta only when the document says `mode: 'live'` EXACTLY,
 *      the process was started with `DESK_DX_LIVE=1`, and the broker mode is
 *      `delta`. Anything else is the simulator. Paper can never reach Delta.
 *   2. WHAT A SIMULATED FILL COSTS. Delta's option fee at the price the fill
 *      took (the touch for a marketable limit): min(0.01 % × notional, 3.5 % ×
 *      premium) + 18 % GST, in USD — so paper measures the real edge.
 *   3. WHETHER AN ORDER IS TOO BIG. A per-order contract cap and a per-order
 *      notional cap, refused before routing, on both rails.
 */
import type { SimulatorOptions } from '@algomaker/brokers'
import { DX_OPTION_FEE_RATES, optionFee } from '@algomaker/dx'
import { orderMode } from './journal.ts'

export type GatewayBrokerMode = 'simulate' | 'delta'

type Env = Readonly<Record<string, string | undefined>>

/** `DESK_BROKER`: unset or `simulate` → simulate; `delta` → delta; anything else stops the boot. */
export function brokerModeFromEnv(env: Env): GatewayBrokerMode {
  const raw = env['DESK_BROKER']
  if (raw === undefined || raw === '' || raw === 'simulate') return 'simulate'
  if (raw === 'delta') return 'delta'
  throw new Error(`DESK_BROKER='${raw}' is not a broker mode — use 'simulate' (default) or 'delta'`)
}

/** Is a Delta adapter to be built at all? Both switches, exactly. */
export function liveRailEnabled(env: Env): boolean {
  return env['DESK_DX_LIVE'] === '1' && env['DESK_BROKER'] === 'delta'
}

/** Does THIS document go to Delta? Exact `'live'` plus `DESK_DX_LIVE=1` and a delta broker. */
export function routesToDelta(doc: Record<string, unknown>, env: Env): boolean {
  return doc['mode'] === 'live' && liveRailEnabled(env)
}

/**
 * The adapter for one document. `delta` is null when none was built (simulate
 * mode, or delta mode without `DESK_DX_LIVE=1`), and then everything simulates.
 */
export function chooseAdapter<A>(
  doc: Record<string, unknown>,
  env: Env,
  adapters: { readonly simulator: A; readonly delta: A | null },
): A {
  return adapters.delta !== null && routesToDelta(doc, env) ? adapters.delta : adapters.simulator
}

/** Where one order is worked: Delta production, Delta's testnet, or the simulator. */
export type OrderRail = 'live' | 'demo' | 'sim'

/** A paper book's choice, from `desk-books-registry.dx_paper_rail`. */
export type PaperRailChoice = 'sim' | 'demo'

/** The rail a document was first placed on, if it carries one. */
export function stampedPaperRail(doc: Record<string, unknown>): PaperRailChoice | null {
  const v = doc['dx_paper_rail']
  return v === 'demo' || v === 'sim' ? v : null
}

/**
 * THE RAIL FOR THIS DOCUMENT.
 *
 *   live — `routesToDelta` exactly as before: exact `'live'`, `DESK_DX_LIVE=1`,
 *          a delta broker. Nothing here can send a live order anywhere else.
 *   demo — a PAPER document (`orderMode`, fail-closed) whose book chose the
 *          demo rail, or which was already placed on it (the stamp wins, so
 *          every tranche of one order goes to one exchange).
 *   sim  — everything else, a live document with the live rail off included.
 */
export function chooseRail(doc: Record<string, unknown>, env: Env, bookRail: PaperRailChoice): OrderRail {
  if (routesToDelta(doc, env)) return 'live'
  if (orderMode(doc) !== 'paper') return 'sim'
  return (stampedPaperRail(doc) ?? bookRail) === 'demo' ? 'demo' : 'sim'
}

const r8 = (x: number): number => Number(x.toFixed(8))

/**
 * The simulator's fee model for Delta options, total USD (fee + GST).
 *
 * `index` is the latest `.DEXBTUSD` the feed published. With none yet, the fee
 * is the premium cap alone — the larger of the two terms `min` chooses between,
 * so paper is charged at most what Delta could charge, never nothing. Said once.
 */
export function dxSimFee(
  index: () => number | null,
  log: (msg: string, ctx?: Record<string, unknown>) => void = () => {},
): NonNullable<SimulatorOptions['feeModel']> {
  let warned = false
  return ({ intent, qty, price }) => {
    const step = intent.instrument.lotSize > 0 ? intent.instrument.lotSize : DX_OPTION_FEE_RATES.contractValue
    const contracts = Math.round(qty / step)
    const idx = index()
    if (idx !== null && Number.isFinite(idx) && idx > 0) {
      return optionFee({ contracts, index: idx, premium: price }).total
    }
    if (!warned) {
      warned = true
      log('DX FEE: no BTC index price yet — simulated fills are charged the 3.5 % premium cap (the upper bound)', {
        tradingsymbol: intent.instrument.tradingsymbol,
      })
    }
    const fee = r8(DX_OPTION_FEE_RATES.premiumCap * contracts * DX_OPTION_FEE_RATES.contractValue * price)
    return r8(fee + r8(DX_OPTION_FEE_RATES.gstRate * fee))
  }
}

// --------------------------------------------------------------------- caps

/** Null is the explicit off-state (`'off'` in the environment). */
export interface DxCaps {
  readonly maxContractsPerOrder: number | null
  readonly maxNotionalUsd: number | null
}

export const DEFAULT_DX_MAX_CONTRACTS_ORDER = 200
export const DEFAULT_DX_MAX_NOTIONAL_USD = 20_000

function capOf(env: Env, name: string, dflt: number): number | null {
  const raw = env[name]
  if (raw === undefined || raw.trim() === '') return dflt
  if (raw.trim().toLowerCase() === 'off') return null
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${name}='${raw}' is not a positive number (or 'off') — the gateway will not guess a cap`)
  }
  return n
}

/** Read once at boot. A typo stops the boot: a cap that silently fell back is a cap nobody set. */
export function dxCapsFromEnv(env: Env): DxCaps {
  return {
    maxContractsPerOrder: capOf(env, 'DESK_DX_MAX_CONTRACTS_ORDER', DEFAULT_DX_MAX_CONTRACTS_ORDER),
    maxNotionalUsd: capOf(env, 'DESK_DX_MAX_NOTIONAL_USD', DEFAULT_DX_MAX_NOTIONAL_USD),
  }
}

/**
 * Why this order is refused by a cap, or null.
 *
 * A `close` is NEVER capped: it goes to Delta `reduce_only` (`DxAdapter`), so
 * however large it is it cannot add exposure — and refusing it would trap a
 * position behind a safety control, which is worse than what the cap guards.
 * Everything else (open, roll, resize, unknown) is capped.
 *
 * Notional = contracts × contract value × the BTC index. With no index price
 * the notional cannot be bounded, so the order is refused rather than guessed.
 */
export function dxCapRefusal(input: {
  readonly caps: DxCaps
  readonly quantity: number
  readonly lotSize: number
  readonly deskOp: string | undefined
  readonly index: number | null
}): string | null {
  const { caps } = input
  if (input.deskOp === 'close') return null
  const step = input.lotSize > 0 ? input.lotSize : DX_OPTION_FEE_RATES.contractValue
  const contracts = Math.round(input.quantity / step)
  if (caps.maxContractsPerOrder !== null && contracts > caps.maxContractsPerOrder) {
    return (
      `${contracts} contracts is over the per-order cap of ${caps.maxContractsPerOrder} ` +
      `(DESK_DX_MAX_CONTRACTS_ORDER); not placed`
    )
  }
  if (caps.maxNotionalUsd !== null) {
    if (input.index === null || !Number.isFinite(input.index) || input.index <= 0) {
      return 'no BTC index price yet, so the order notional cannot be checked against DESK_DX_MAX_NOTIONAL_USD; not placed'
    }
    const notional = r8(contracts * step * input.index)
    if (notional > caps.maxNotionalUsd) {
      return (
        `notional ${notional} USD (${contracts} contracts at index ${input.index}) is over the per-order cap of ` +
        `${caps.maxNotionalUsd} (DESK_DX_MAX_NOTIONAL_USD); not placed`
      )
    }
  }
  return null
}

// ------------------------------------------------------------- live fees

/**
 * Delta's REPORTED commission for one order, summed over its fills on the
 * latest page of `/v2/fills`; null when Delta reports none for it yet (or the
 * read failed) — then the fill row carries no fee rather than an invented one.
 */
export async function deltaCommission(
  rest: {
    fills(q?: { after?: string }): Promise<{
      fills: readonly { order_id?: string; commission?: string; size?: string | number }[]
    }>
  },
  brokerOrderId: string,
  /**
   * The contracts the update says filled. Given, the commission counts only
   * once Delta's listed fills for the order COVER that many — a partial
   * listing is part of the fee, not the fee (13 Nov: one leg booked feeless).
   */
  wantContracts?: number,
): Promise<number | null> {
  try {
    const { fills } = await rest.fills()
    const mine = fills.filter((f) => String(f.order_id ?? '') === brokerOrderId)
    if (mine.length === 0) return null
    let total = 0
    let size = 0
    for (const f of mine) {
      const c = Number(f.commission)
      if (!Number.isFinite(c)) return null
      total += c
      const n = Number(f.size)
      if (Number.isFinite(n)) size += n
    }
    if (wantContracts !== undefined && size < wantContracts) return null
    return r8(total)
  } catch {
    return null
  }
}

/** How long a filled update waits for Delta to list its fills: 0.5+1+2+4 s after a first look. */
export const DX_FEE_WAIT_DELAYS_MS: readonly number[] = [0, 500, 1_000, 2_000, 4_000]

/**
 * A Delta update that traded, with Delta's commission on it — waiting, bounded,
 * until `/v2/fills` lists fills covering the update's quantity. The FILLED
 * frame routinely beats the fill record (13/20 Nov): asked once, one leg of a
 * straddle came back with nothing and went in feeless for good. Still not
 * listed after the last delay: returned WITHOUT a fee (never a guess), and the
 * backfill (`dx-fee-backfill.ts`) puts it on later.
 */
export async function awaitDeltaFee<U extends { readonly brokerOrderId: string; readonly filledQty: number; readonly fee?: number }>(
  deps: {
    readonly rest: Parameters<typeof deltaCommission>[0]
    /** BTC per contract. */
    readonly step: number
    readonly sleep?: (ms: number) => Promise<void>
    readonly delaysMs?: readonly number[]
  },
  update: U,
): Promise<U> {
  if (update.fee !== undefined || !(update.filledQty > 0)) return update
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const want = Math.round(update.filledQty / deps.step)
  for (const ms of deps.delaysMs ?? DX_FEE_WAIT_DELAYS_MS) {
    await sleep(ms)
    const fee = await deltaCommission(deps.rest, update.brokerOrderId, want)
    if (fee !== null) return { ...update, fee }
  }
  return update
}
