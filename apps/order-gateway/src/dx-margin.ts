/**
 * ACCOUNT MARGIN, per Delta account (operator, 3 Nov: "show margin utilized").
 *
 * Every 30 s each configured rail's own client — the demo rail's testnet REST,
 * the live rail's production REST, never one another's key or host — reads
 * `GET /v2/wallet/balances` and writes `desk-broker-margin`
 * `{_id: 'delta-demo' | 'delta', asOf, ok, error, rail, host, balance,
 * available, positionMargin, orderMargin, portfolioMargin, used, utilizedPct}`
 * off the USD row. USD, as Delta states it.
 *
 * A FAILED READ IS RECORDED AS FAILED: `ok: false`, the error, and every
 * figure null. Never zeros — a zero balance is a claim, a failed read is not.
 *
 * `used` is balance − available: whatever the account has blocked, which is
 * the same figure in isolated margin (position + order margin) and portfolio
 * margin. `utilizedPct` is used / balance × 100, null on a zero balance.
 */
export const BROKER_MARGIN_COLLECTION = 'desk-broker-margin'
export const DELTA_MARGIN_MS = 30_000

type Log = (msg: string, ctx?: Record<string, unknown>) => void
const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

export type AccountMargin =
  | {
      readonly ok: true
      readonly balance: number
      readonly available: number | null
      readonly positionMargin: number | null
      readonly orderMargin: number | null
      readonly portfolioMargin: number | null
      readonly used: number | null
      readonly utilizedPct: number | null
    }
  | { readonly ok: false; readonly error: string }

const r = (x: number, d = 8): number => Number(x.toFixed(d))

function numOf(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** The USD row of a wallet read, as figures. Pure. */
export function marginFromBalances(rows: readonly { readonly asset_symbol?: unknown; readonly [k: string]: unknown }[]): AccountMargin {
  const usd = rows.find((b) => b.asset_symbol === 'USD')
  if (usd === undefined) {
    const assets = rows.map((b) => String(b.asset_symbol ?? '?')).join(', ')
    return { ok: false, error: `Delta reported no USD wallet row (assets: ${assets === '' ? 'none' : assets})` }
  }
  const balance = numOf(usd['balance'])
  if (balance === null) return { ok: false, error: `Delta's USD wallet row has no readable balance (${String(usd['balance'])})` }
  const available = numOf(usd['available_balance'])
  const used = available === null ? null : r(balance - available)
  return {
    ok: true,
    balance,
    available,
    positionMargin: numOf(usd['position_margin']),
    orderMargin: numOf(usd['order_margin']),
    portfolioMargin: numOf(usd['portfolio_margin']),
    used,
    utilizedPct: used === null || !(balance > 0) ? null : r((used / balance) * 100, 4),
  }
}

const NO_FIGURES = {
  balance: null,
  available: null,
  positionMargin: null,
  orderMargin: null,
  portfolioMargin: null,
  used: null,
  utilizedPct: null,
}

export function createDeltaMarginSnapshot(deps: {
  readonly id: 'delta' | 'delta-demo'
  readonly walletBalances: () => Promise<readonly { readonly asset_symbol?: unknown; readonly [k: string]: unknown }[]>
  readonly collection: {
    updateOne(filter: Record<string, unknown>, update: Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown>
  }
  readonly now: () => number
  readonly host: string | null
  readonly log: Log
}): { take(): Promise<void> } {
  const rail = deps.id === 'delta-demo' ? 'demo' : 'live'
  const venue = deps.id === 'delta-demo' ? 'Delta testnet' : 'Delta'
  let running = false
  return {
    async take(): Promise<void> {
      if (running) return
      running = true
      try {
        let m: AccountMargin
        try {
          m = marginFromBalances(await deps.walletBalances())
        } catch (err) {
          m = { ok: false, error: `${venue} /v2/wallet/balances failed: ${errorText(err)}` }
        }
        const set = m.ok
          ? { asOf: deps.now(), rail, host: deps.host, error: '', ...m }
          : { asOf: deps.now(), rail, host: deps.host, ok: false, error: m.error, ...NO_FIGURES }
        await deps.collection.updateOne({ _id: deps.id }, { $set: set }, { upsert: true })
      } catch (err) {
        deps.log('Delta margin snapshot write failed', { id: deps.id, error: errorText(err) })
      } finally {
        running = false
      }
    },
  }
}
