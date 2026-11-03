/**
 * THE MANUAL FLATTEN — the core of `scripts/dx-flatten.mts`, operator-run.
 *
 * Dry run (the default): prints the account's positions and open orders and
 * writes nothing. `--yes`: cancels EVERY open order (`DELETE /v2/orders/all`
 * with an empty body — stops, backstops and reduce-only exits included), then
 * `POST /v2/positions/close_all`, waits, and prints what remains. close_all
 * skips halted or auction products, so "what remains" is the part to read.
 */
import type { DxOrder, DxPosition, DxRest } from '@algomaker/dx'

export type FlattenRest = Pick<DxRest, 'positions' | 'openOrders' | 'cancelAllOrders' | 'closeAllPositions'>

export function parseFlattenArgs(argv: readonly string[]): { rail: 'live' | 'demo'; yes: boolean } {
  let rail: string | undefined
  let yes = false
  let dry = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? ''
    if (a === '--yes') yes = true
    else if (a === '--dry-run') dry = true
    else if (a === '--rail') rail = argv[++i]
    else if (a.startsWith('--rail=')) rail = a.slice('--rail='.length)
    else throw new Error(`unknown argument '${a}' — usage: --rail live|demo [--dry-run | --yes]`)
  }
  if (rail !== 'live' && rail !== 'demo') throw new Error('--rail live|demo is required')
  if (yes && dry) throw new Error('--yes and --dry-run both given — pick one')
  return { rail, yes }
}

function table(positions: readonly DxPosition[], open: readonly DxOrder[]): string[] {
  const out: string[] = []
  const held = positions.filter((p) => p.size !== 0)
  out.push(`positions (${held.length}):`)
  for (const p of held) out.push(`  ${p.product_symbol.padEnd(22)} ${String(p.size).padStart(6)}  entry ${p.entry_price ?? '?'}`)
  out.push(`open orders (${open.length}):`)
  for (const o of open) {
    const stop = o.stop_order_type ? ` ${o.stop_order_type} @ ${o.stop_price ?? '?'}` : ''
    out.push(
      `  #${o.id} ${(o.product_symbol ?? String(o.product_id)).padEnd(22)} ${o.side} ${o.unfilled_size}/${o.size} ` +
        `limit ${o.limit_price ?? '-'} ${o.state}${stop}${o.reduce_only ? ' reduce-only' : ''} ${o.client_order_id ?? ''}`,
    )
  }
  return out
}

export async function runFlatten(deps: {
  readonly rest: FlattenRest
  readonly yes: boolean
  readonly print: (line: string) => void
  readonly sleep?: (ms: number) => Promise<void>
}): Promise<{ flattened: boolean; after: { positions: DxPosition[]; open: DxOrder[] } | null }> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const [positions, open] = await Promise.all([deps.rest.positions(), deps.rest.openOrders()])
  for (const l of table(positions, open)) deps.print(l)
  if (!deps.yes) {
    deps.print('DRY RUN — nothing sent. Re-run with --yes to cancel every order and close every position.')
    return { flattened: false, after: null }
  }
  deps.print('cancelling ALL open orders (stops and backstops included)…')
  await deps.rest.cancelAllOrders({})
  deps.print('close_all…')
  await deps.rest.closeAllPositions()
  await sleep(3_000)
  const [p2, o2] = await Promise.all([deps.rest.positions(), deps.rest.openOrders()])
  deps.print('after:')
  for (const l of table(p2, o2)) deps.print(l)
  const left = p2.filter((p) => p.size !== 0)
  deps.print(left.length === 0 ? 'FLAT — no open positions.' : `STILL OPEN: ${left.length} position(s) — close them on Delta by hand.`)
  return { flattened: true, after: { positions: p2, open: o2 } }
}
