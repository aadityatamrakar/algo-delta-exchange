/**
 * THE DEMO RAIL — paper books worked on Delta's India TESTNET.
 *
 * A `BrokerAdapter` around a `DxAdapter` built from the `delta-demo`
 * credentials (`loadDxDemoConfig`: testnet hosts only, never production's key).
 * It exists so a paper book can rehearse against a real matching engine with
 * no real money, instead of the simulator. Orders that reach it are PAPER
 * orders: the fill watcher books them by the document's own `mode`.
 *
 * WHAT IT ADDS TO `DxAdapter`, and why each is needed:
 *
 *   1. LAZY, RETRYING BUILD. The rail is built on the first demo order (or
 *      at boot by `ensure()`), and a failure — no credentials, a non-testnet
 *      host — refuses the order `fatal` with the reason, then is retried at
 *      most every `retryAfterMs`. Saving the credentials needs no restart. It
 *      NEVER falls through to the simulator or to production.
 *
 *   2. PRODUCT IDS BY SYMBOL. Testnet ids differ from production's, and the
 *      desk's instrument token IS the production id. Each order is re-pointed
 *      at testnet's id for its `tradingsymbol`, from testnet's own
 *      `/v2/products` (cached; a miss re-reads at most once a minute). A symbol
 *      testnet does not list is refused `fatal`, and the placer journals why.
 *
 *   3. TOKENS TRANSLATED BACK. Every update and book row leaving this rail
 *      names the PRODUCTION token again (or none, for an id it never placed):
 *      the fill watcher refuses a row whose token differs from the document's.
 */
import {
  BrokerOrderError,
  type BrokerAdapter,
  type BrokerCapabilities,
  type BrokerOrder,
  type BrokerPosition,
  type PlacedOrder,
} from '@algomaker/brokers'
import type { OrderIntent } from '@algomaker/order-bus'
import { DxAdapter, DxOrderError, DxRest, type DxTradingClient } from '@algomaker/dx'
import { DX_USER_AGENT, type DxConfig } from './dx-config.ts'
import { chooseRail, stampedPaperRail, type PaperRailChoice } from './dx-edge.ts'
import { orderMode } from './journal.ts'

/** What the demo rail needs of a REST client (a fake in tests). */
export type DemoRest = DxTradingClient & Pick<DxRest, 'products' | 'fills' | 'heartbeat'>

export interface DemoRailDeps {
  /** The demo settings; throws when demo is not configured (`loadDxDemoConfig`). */
  readonly loadConfig: () => Promise<DxConfig>
  /** Default: a `DxRest` on the config, with its own heartbeat id. */
  readonly makeRest?: (cfg: DxConfig) => DemoRest
  /** Once, after the build — main starts the private socket, heartbeat and sweep here. */
  readonly onBuilt?: (built: { readonly rest: DemoRest; readonly adapter: DxAdapter; readonly cfg: DxConfig }) => void
  readonly now: () => number
  readonly log: (msg: string, ctx?: Record<string, unknown>) => void
  /** How long a failed build is remembered before it is tried again. Default 30 s. */
  readonly retryAfterMs?: number
  /** Full re-read of the testnet listing. Default 15 min. */
  readonly productsTtlMs?: number
  /** Earliest re-read after a symbol was not found. Default 60 s. */
  readonly missRefreshMs?: number
}

interface Built {
  readonly rest: DemoRest
  readonly adapter: DxAdapter
}

export const DEMO_HEARTBEAT_ID = 'algomaker-dx-demo'

export class DemoRail implements BrokerAdapter {
  readonly name = 'delta-demo'
  readonly capabilities: BrokerCapabilities = { orders: true, marketData: false, modify: true }

  readonly #d: DemoRailDeps
  #built: Built | null = null
  #building: Promise<Built> | null = null
  #failed: { at: number; why: string } | null = null
  readonly #handlers: ((o: PlacedOrder) => void)[] = []
  /** tradingsymbol → testnet product id. */
  #ids = new Map<string, number>()
  #idsAt = 0
  #idsLoaded = false
  /** testnet product id → the production token the desk knows it by. */
  readonly #prodToken = new Map<number, number>()

  constructor(deps: DemoRailDeps) {
    this.#d = deps
  }

  /** Has the rail been built (credentials loaded, adapter up)? */
  get ready(): boolean {
    return this.#built !== null
  }

  /** The testnet REST client, once built — for Delta's reported commission. */
  get rest(): DemoRest | null {
    return this.#built?.rest ?? null
  }

  /**
   * Build the rail now, if it is not built. Rejects with the reason it cannot
   * be (remembered for `retryAfterMs`). Concurrent callers share one build.
   */
  async ensure(): Promise<void> {
    await this.#ensure()
  }

  async placeOrder(intent: OrderIntent): Promise<PlacedOrder> {
    const b = await this.#ensureForOrder(intent.clientOrderId)
    const symbol = intent.instrument.tradingsymbol
    const id = await this.#testnetId(b.rest, symbol, intent.clientOrderId)
    if (id === null) {
      throw new DxOrderError(
        `order ${intent.clientOrderId} refused: ${symbol} is not listed on the Delta testnet — ` +
          'the demo rail cannot place it; not placed',
        'fatal',
      )
    }
    const prod = intent.instrument.instrumentToken
    if (prod !== undefined && prod > 0) this.#prodToken.set(id, prod)
    const placed = await b.adapter.placeOrder({ ...intent, instrument: { ...intent.instrument, instrumentToken: id } })
    return this.#back(placed)
  }

  async modifyOrder(brokerOrderId: string, price: number): Promise<boolean> {
    const b = await this.#ensure()
    return await b.adapter.modifyOrder(brokerOrderId, price)
  }

  async cancelOrder(brokerOrderId: string): Promise<boolean> {
    const b = await this.#ensure()
    return await b.adapter.cancelOrder(brokerOrderId)
  }

  async positions(): Promise<readonly BrokerPosition[]> {
    const b = await this.#ensure()
    return await b.adapter.positions()
  }

  /**
   * Testnet's book, tokens translated. With no rail this THROWS: the broker
   * sweep reads an empty book as "never placed", which would un-book an
   * ambiguous demo order that may be resting on testnet.
   */
  async orderBook(): Promise<readonly BrokerOrder[]> {
    const b = await this.#ensure()
    return (await b.adapter.orderBook()).map((o) => this.#back(o))
  }

  onOrderUpdate(handler: (order: PlacedOrder) => void): () => void {
    this.#handlers.push(handler)
    return () => {
      const i = this.#handlers.indexOf(handler)
      if (i >= 0) this.#handlers.splice(i, 1)
    }
  }

  /** @deprecated Alias for {@link onOrderUpdate}. */
  onFill(handler: (order: PlacedOrder) => void): () => void {
    return this.onOrderUpdate(handler)
  }

  /** One frame off the demo private socket. Ignored until the rail is built. */
  onPrivateFrame(raw: unknown): void {
    this.#built?.adapter.onPrivateFrame(raw)
  }

  // ---------------------------------------------------------------- internals

  /** Testnet's product id → the production token, or absent for an id this rail never placed. */
  #back<T extends { readonly exchangeToken?: number | null }>(o: T): T {
    const t = o.exchangeToken
    if (t === undefined || t === null) return o
    const prod = this.#prodToken.get(t)
    const { exchangeToken: _testnet, ...rest } = o
    return (prod === undefined ? rest : { ...rest, exchangeToken: prod }) as unknown as T
  }

  async #ensureForOrder(clientOrderId: string): Promise<Built> {
    try {
      return await this.#ensure()
    } catch (err) {
      throw new DxOrderError(
        `order ${clientOrderId} NOT placed: the Delta demo rail is not available — ` +
          `${err instanceof Error ? err.message : String(err)}`,
        'fatal',
      )
    }
  }

  async #ensure(): Promise<Built> {
    if (this.#built !== null) return this.#built
    if (this.#building !== null) return await this.#building
    const retry = this.#d.retryAfterMs ?? 30_000
    if (this.#failed !== null && this.#d.now() - this.#failed.at < retry) {
      throw new Error(`the Delta demo rail is not available — ${this.#failed.why}`)
    }
    this.#building = this.#build()
    try {
      return await this.#building
    } finally {
      this.#building = null
    }
  }

  async #build(): Promise<Built> {
    let cfg: DxConfig
    try {
      cfg = await this.#d.loadConfig()
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err)
      this.#failed = { at: this.#d.now(), why }
      this.#d.log('DEMO RAIL not available', { error: why })
      throw new Error(`the Delta demo rail is not available — ${why}`)
    }
    const rest =
      this.#d.makeRest?.(cfg) ??
      new DxRest({
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
        apiSecret: cfg.apiSecret,
        userAgent: DX_USER_AGENT,
        heartbeatId: DEMO_HEARTBEAT_ID,
      })
    const adapter = new DxAdapter({ rest, log: this.#d.log })
    adapter.onOrderUpdate((u) => {
      const out = this.#back(u)
      for (const h of [...this.#handlers]) h(out)
    })
    const built: Built = { rest, adapter }
    this.#built = built
    this.#failed = null
    this.#d.log('DEMO RAIL up — paper books set to demo trade on the Delta testnet', { baseUrl: cfg.baseUrl })
    this.#d.onBuilt?.({ rest, adapter, cfg })
    return built
  }

  /** Testnet's id for `symbol`, or null when testnet does not list it. */
  async #testnetId(rest: DemoRest, symbol: string, clientOrderId: string): Promise<number | null> {
    const now = this.#d.now()
    const stale = !this.#idsLoaded || now - this.#idsAt >= (this.#d.productsTtlMs ?? 15 * 60_000)
    const hit = this.#ids.get(symbol)
    if (hit !== undefined && !stale) return hit
    const missAge = now - this.#idsAt
    if (hit === undefined && this.#idsLoaded && !stale && missAge < (this.#d.missRefreshMs ?? 60_000)) return null
    try {
      const products = await rest.products({ states: ['live'] })
      const ids = new Map<string, number>()
      for (const p of products) {
        if (typeof p.symbol === 'string' && p.symbol !== '' && Number.isInteger(p.id) && p.id > 0) ids.set(p.symbol, p.id)
      }
      this.#ids = ids
      this.#idsAt = now
      this.#idsLoaded = true
    } catch (err) {
      // A stale listing that names the symbol is still testnet's id for it.
      if (hit !== undefined) return hit
      // Nothing was sent: the order is provably not placed.
      throw new BrokerOrderError(
        `order ${clientOrderId} NOT placed: the Delta testnet product list could not be read — ` +
          `${err instanceof Error ? err.message : String(err)}`,
        'transient',
      )
    }
    return this.#ids.get(symbol) ?? null
  }
}

// ------------------------------------------------------------ the router

/**
 * WHICH ADAPTER ONE ORDER DOCUMENT GOES TO, asked per order (`adapterFor`).
 *
 *   - `chooseRail` decides: live → production (only with the live rail on),
 *     demo → the demo rail, everything else → the simulator.
 *   - A PAPER document not yet placed reads its book's `dx_paper_rail` and is
 *     STAMPED with the answer before anything is sent, so every later tranche,
 *     the chasers, the sweeps and the cancel drains all see one rail for it.
 *     A stamped document never reads the book again: a switch applies from the
 *     book's next order, never mid-order.
 *   - No demo rail (not the Delta venue): nothing is read or stamped.
 *   - The book's rail cannot be read, or the stamp cannot be written: the
 *     order is REFUSED with the reason. It is never guessed onto a rail.
 */
export function createAdapterRouter<A extends Pick<BrokerAdapter, 'placeOrder'>>(deps: {
  readonly env: Readonly<Record<string, string | undefined>>
  readonly simulator: A
  readonly live: A | null
  readonly demo: A | null
  readonly bookRail: (tag: string) => Promise<PaperRailChoice>
  readonly stamp: (doc: Record<string, unknown>, rail: PaperRailChoice) => Promise<void>
}): (doc: Record<string, unknown>) => Promise<A | Pick<BrokerAdapter, 'placeOrder'>> {
  return async (doc) => {
    if (deps.demo === null || orderMode(doc) !== 'paper' || stampedPaperRail(doc) !== null) {
      const rail = chooseRail(doc, deps.env, 'sim')
      if (rail === 'live') return deps.live ?? deps.simulator
      if (rail === 'demo' && deps.demo !== null) return deps.demo
      return deps.simulator
    }
    let book: PaperRailChoice
    try {
      book = await deps.bookRail(String(doc['tag'] ?? ''))
      await deps.stamp(doc, book)
    } catch (err) {
      return refusing(`the book's paper rail could not be settled — ${err instanceof Error ? err.message : String(err)}`)
    }
    return chooseRail({ ...doc, dx_paper_rail: book }, deps.env, book) === 'demo' ? deps.demo : deps.simulator
  }
}

function refusing(why: string): Pick<BrokerAdapter, 'placeOrder'> {
  return {
    placeOrder: async (intent: OrderIntent): Promise<PlacedOrder> => {
      throw new BrokerOrderError(`order ${intent.clientOrderId} NOT placed: ${why}`, 'fatal')
    },
  }
}
