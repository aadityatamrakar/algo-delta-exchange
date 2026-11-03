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
import { DxAdapter, DxOrderError, DxRest, type DxProduct, type DxTradingClient } from '@algomaker/dx'
import { DX_USER_AGENT, type DxConfig } from './dx-config.ts'
import { chooseRail, stampedPaperRail, type OrderRail, type PaperRailChoice } from './dx-edge.ts'
import { orderMode } from './journal.ts'

/** What the demo rail needs of a REST client (a fake in tests). */
export type DemoRest = DxTradingClient & Pick<DxRest, 'products' | 'fills' | 'heartbeat' | 'product' | 'ticker'>

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
  /** tradingsymbol → testnet's product, from the same listing (its `product_specs` carry the OI cap). */
  #listed = new Map<string, DxProduct>()
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

  /**
   * Testnet's product for a symbol, from the cached listing (re-read on the
   * listing's own schedule, never per call) — for the OI-cap check. Null when
   * testnet does not list it or the rail cannot be built.
   */
  async testnetProduct(symbol: string): Promise<DxProduct | null> {
    let b: Built
    try {
      b = await this.#ensure()
    } catch {
      return null
    }
    const id = await this.#testnetId(b.rest, symbol, `oi-cap ${symbol}`)
    return id === null ? null : (this.#listed.get(symbol) ?? null)
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
      const listed = new Map<string, DxProduct>()
      for (const p of products) {
        if (typeof p.symbol === 'string' && p.symbol !== '' && Number.isInteger(p.id) && p.id > 0) {
          ids.set(p.symbol, p.id)
          listed.set(p.symbol, p)
        }
      }
      this.#ids = ids
      this.#listed = listed
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

/** One order's adapter, and the rail it is, and why — for the journal and the book row. */
export interface Routed<A> {
  readonly adapter: A | Pick<BrokerAdapter, 'placeOrder'>
  readonly rail: OrderRail
  readonly note: string
}

/** What the router needs to know of a paper book. */
export interface PaperBookState {
  /** The operator's setting: `demo` (default) or forced `sim`. */
  readonly setting: PaperRailChoice
  /** Does the book hold legs (or is that unreadable — then it is taken as held)? */
  readonly held: boolean
  /** The rail its last order went to, null before any. */
  readonly lastUsed: PaperRailChoice | null
}

export type DemoReadiness = { readonly ok: true } | { readonly ok: false; readonly why: string }

const RAIL_WORDS: Record<PaperRailChoice, string> = { demo: 'Delta testnet', sim: 'simulator' }

/**
 * WHICH ADAPTER ONE ORDER DOCUMENT GOES TO, asked per order (`adapterFor`) —
 * the operator's ruling of 3 Nov: PAPER → Delta demo, LIVE → Delta.
 *
 *   - LIVE is `chooseRail` exactly as before: production only with the live
 *     rail on, else the simulator. Never demo; nothing is read or stamped.
 *   - A PAPER document not yet placed:
 *       1. a book that HOLDS LEGS stays on the rail its last order went to
 *          (`lastUsed`; none recorded = the simulator, where every leg before
 *          the demo rail was opened) until it is flat — a close must reach the
 *          exchange its open went to. Held on testnet with no usable demo key
 *          → refused, never closed on the simulator.
 *       2. a book set to `sim` → the simulator.
 *       3. otherwise (`demo`, the default) → testnet when a `delta-demo` key is
 *          stored and its last Test passed; else the simulator, and the note
 *          says why.
 *     The document is STAMPED with the rail before anything is sent (every
 *     tranche, chaser, sweep and cancel then follows it) and the book row is
 *     told where its order went (`stamp`).
 *   - A stamped document keeps its rail; nothing is read again.
 *   - No demo rail (not the Delta venue): the simulator, nothing read.
 *   - Anything unreadable or unwritable: the order is REFUSED with the reason.
 */
export function createAdapterRouter<A extends Pick<BrokerAdapter, 'placeOrder'>>(deps: {
  readonly env: Readonly<Record<string, string | undefined>>
  readonly simulator: A
  readonly live: A | null
  readonly demo: A | null
  readonly bookState: (tag: string) => Promise<PaperBookState>
  readonly demoReady: () => Promise<DemoReadiness>
  readonly stamp: (doc: Record<string, unknown>, rail: PaperRailChoice, note: string) => Promise<void>
}): (doc: Record<string, unknown>) => Promise<Routed<A>> {
  return async (doc) => {
    const stamped = stampedPaperRail(doc)
    if (deps.demo === null || orderMode(doc) !== 'paper' || stamped !== null) {
      const rail = chooseRail(doc, deps.env, 'sim')
      if (rail === 'live') {
        return deps.live === null
          ? { adapter: deps.simulator, rail: 'sim', note: '' }
          : { adapter: deps.live, rail: 'live', note: '' }
      }
      if (rail === 'demo' && deps.demo !== null) return { adapter: deps.demo, rail: 'demo', note: 'placed on the Delta testnet' }
      return { adapter: deps.simulator, rail: 'sim', note: stamped === 'sim' ? 'placed on the simulator' : '' }
    }
    let rail: PaperRailChoice
    let note: string
    try {
      const book = await deps.bookState(String(doc['tag'] ?? ''))
      if (book.held) {
        rail = book.lastUsed ?? 'sim'
        note = `holds legs opened on the ${RAIL_WORDS[rail]} — stays there until flat`
        if (rail === 'demo') {
          const ready = await deps.demoReady()
          if (!ready.ok) {
            return {
              adapter: refusing(`the book holds legs on the Delta testnet but the demo key is not usable — ${ready.why}`),
              rail: 'demo',
              note: `refused — ${ready.why}`,
            }
          }
        }
      } else if (book.setting === 'sim') {
        rail = 'sim'
        note = 'simulator — the book is set to Sim'
      } else {
        const ready = await deps.demoReady()
        rail = ready.ok ? 'demo' : 'sim'
        note = ready.ok ? 'Delta testnet — demo key verified' : `simulator — ${ready.why}`
      }
      await deps.stamp(doc, rail, note)
    } catch (err) {
      const why = `the book's paper rail could not be settled — ${err instanceof Error ? err.message : String(err)}`
      return { adapter: refusing(why), rail: 'sim', note: `refused — ${why}` }
    }
    return { adapter: rail === 'demo' ? deps.demo : deps.simulator, rail, note }
  }
}

function refusing(why: string): Pick<BrokerAdapter, 'placeOrder'> {
  return {
    placeOrder: async (intent: OrderIntent): Promise<PlacedOrder> => {
      throw new BrokerOrderError(`order ${intent.clientOrderId} NOT placed: ${why}`, 'fatal')
    },
  }
}

/**
 * Is the stored `delta-demo` key usable? Stored AND its last Test passed —
 * the operator's rule. A new key resets `lastVerifiedAt` (`BrokerStore.save`),
 * so a key nobody has tested routes nothing to testnet.
 */
export function demoKeyReadiness(row: Record<string, unknown> | null): DemoReadiness {
  const sealed = row?.['secret']
  if (typeof sealed !== 'string' || sealed === '') return { ok: false, why: 'no Delta Demo key stored' }
  const err = typeof row?.['lastError'] === 'string' ? (row['lastError'] as string) : ''
  if (err !== '') return { ok: false, why: `the Delta Demo key's last Test failed (${err.slice(0, 160)})` }
  if (typeof row?.['lastVerifiedAt'] !== 'number') return { ok: false, why: 'the Delta Demo key has not passed Test yet' }
  return { ok: true }
}

/**
 * Does a `desk-books` document hold legs? No document is flat; a leg array
 * that cannot be read is HELD — unknown is never flat.
 */
export function holdsLegs(doc: Record<string, unknown> | null): boolean {
  if (doc === null) return false
  const legs = doc['legs']
  if (!Array.isArray(legs)) return true
  return legs.some((l) => {
    const q = (l as { qty?: unknown } | null)?.qty
    return typeof q !== 'number' || !Number.isFinite(q) || q !== 0
  })
}
