/**
 * ExternalSignalMirror — a SignalSource adapter, NOT a StrategyBase subclass.
 * It has no entry/exit logic, no position state, and no market data need, so
 * giving it phases()/squareOff()/a day budget would be meaningless (design
 * spec section 4.3). It mirrors another system's EXECUTED orders onto our
 * order bus under a local tag.
 */

import type { Logger, OrderGateway, InstrumentRef } from '@algomaker/strategy-kit'
import type { ExternalSignalMirrorConfig } from './config.ts'

export interface SignalOrderExecution {
  readonly type: 'ORDER_EXECUTION'
  readonly payload: {
    readonly symbol: string
    readonly side: 'BUY' | 'SELL'
    readonly status: 'EXECUTED' | 'PENDING' | 'REJECTED'
  }
}

/** What the adapter needs from a websocket-shaped signal feed. Injected, like every other port. */
export interface SignalSource {
  onMessage(handler: (msg: SignalOrderExecution) => void): () => void
}

export interface InstrumentResolver {
  bySymbol(symbol: string): InstrumentRef | null
}

/**
 * What this adapter currently holds in a symbol — the runner's `PositionLedger`.
 *
 * INJECTED, because the adapter has no position state of its own and should not
 * grow one: the ledger is the durable, single-writer record the whole runner
 * already reads, and a second count kept here would be the one that disagrees
 * with the flatten. Two questions need it, both from audit F-6:
 *
 *  - IS THIS AN EXIT? An order that reduces the net must be marked
 *    `reducesExposure`, or the kill switch and the stale-feed block refuse it
 *    and nothing retries — the upstream account goes flat and our leg does not.
 *  - WOULD THIS CROSS FLAT? See `#handle`.
 */
export interface MirrorPositions {
  /** Signed lots held in this symbol; 0 for one never traded. */
  netLots(tradingsymbol: string): number
}

export interface MirrorAdapterOptions {
  readonly positions?: MirrorPositions
  /**
   * Lots per mirrored order. ONE, matching the legacy trio.
   *
   * IT IS A FABRICATION AND THAT IS AUDIT F-6 MECHANISM 3: the upstream
   * `ORDER_EXECUTION` frame carries no quantity, so there is nothing honest to
   * mirror and 1 is what the legacy processes sent. It is an option only so the
   * crossing guard below can be exercised at a size that can actually cross;
   * production leaves it at 1.
   */
  readonly lots?: number
}

/** Default mirrored size. See `MirrorAdapterOptions.lots`. */
const MIRROR_LOTS = 1

export class ExternalSignalMirrorAdapter {
  readonly #cfg: ExternalSignalMirrorConfig
  readonly #source: SignalSource
  readonly #orders: OrderGateway
  readonly #instruments: InstrumentResolver
  readonly #log: Logger
  readonly #positions: MirrorPositions | null
  readonly #lots: number
  #unsubscribe: (() => void) | null = null

  constructor(
    cfg: ExternalSignalMirrorConfig,
    source: SignalSource,
    orders: OrderGateway,
    instruments: InstrumentResolver,
    log: Logger,
    opts: MirrorAdapterOptions = {},
  ) {
    this.#cfg = cfg
    this.#source = source
    this.#orders = orders
    this.#instruments = instruments
    this.#log = log
    // ABSENT IS ALLOWED AND MEANS "NO POSITION VIEW": the order goes out exactly
    // as it did before this port existed, unmarked and unguarded. A mirror that
    // stopped placing orders because its host forgot to wire a ledger in would
    // be a far worse failure than the one this closes.
    this.#positions = opts.positions ?? null
    this.#lots = opts.lots ?? MIRROR_LOTS
  }

  start(): void {
    this.#unsubscribe = this.#source.onMessage((msg) => void this.#handle(msg))
  }

  stop(): void {
    this.#unsubscribe?.()
    this.#unsubscribe = null
  }

  async #handle(msg: SignalOrderExecution): Promise<void> {
    if (msg.type !== 'ORDER_EXECUTION' || msg.payload.status !== 'EXECUTED') return
    const inst = this.#instruments.bySymbol(msg.payload.symbol)
    if (inst === null) {
      if (this.#cfg.onUnknownSymbol === 'throw') throw new Error(`unknown mirrored symbol '${msg.payload.symbol}'`)
      this.#log.warn(`${this.#cfg.tag}: unknown symbol, dropped`, { symbol: msg.payload.symbol })
      return
    }
    const lots = this.#lots
    const net = this.#positions?.netLots(inst.tradingsymbol) ?? 0
    const signed = msg.payload.side === 'BUY' ? lots : -lots
    /**
     * AN EXIT IS AN ORDER THAT REDUCES WHAT WE HOLD — nothing more.
     *
     * Not "the upstream called it an exit" (it does not say) and not "the side
     * is opposite to the last one" (a restart forgets that). The ledger's net
     * is the only durable answer, and marking it is what carries the order past
     * the kill switch and the stale-feed block. From FLAT there is nothing to
     * reduce, so a mirrored order into a symbol we hold none of is an entry.
     */
    const reduces = net !== 0 && Math.sign(signed) !== Math.sign(net)

    /**
     * AND IT MUST NOT GO PAST FLAT.
     *
     * The quantity is fabricated (see `MirrorAdapterOptions.lots`), so a
     * reversing order can be larger than the position it is reversing. The lots
     * beyond flat are not an exit at all — they OPEN a position the other way,
     * under a tag whose host squares nothing off, which is the shape of every
     * permanently stuck mirror leg in the 2026-08-10 incident.
     *
     * EXACT flat is allowed, and deliberately: `>` not `>=`. A guard that
     * refused the order which closes a position to precisely zero would trap
     * the leg it exists to protect — the same mistake as putting the kill
     * switch in front of an exit.
     */
    if (reduces && Math.abs(signed) > Math.abs(net)) {
      this.#log.error(
        `${this.#cfg.tag}: REFUSED a mirrored order that would take ${inst.tradingsymbol} past flat`,
        {
          symbol: inst.tradingsymbol,
          side: msg.payload.side,
          lots,
          net,
          // Named because the operator's next question is always "so what is
          // still open?" — the position is unchanged, not partially closed.
          held: `${net} lot(s) remain open`,
        },
      )
      return
    }

    const res = await this.#orders.submit({
      instrument: inst,
      side: msg.payload.side,
      lots,
      ...(reduces ? { reducesExposure: true } : {}),
      meta: { mirroredFrom: this.#cfg.destinationTag },
    })
    if (!res.accepted) this.#log.warn(`${this.#cfg.tag}: mirrored order rejected`, { reason: res.reason ?? 'unknown' })
  }
}

/** Test double: a scriptable SignalSource, mirroring FakeMarketData's role for MarketData. */
export class FakeSignalSource implements SignalSource {
  #handlers: ((msg: SignalOrderExecution) => void)[] = []
  onMessage(handler: (msg: SignalOrderExecution) => void): () => void {
    this.#handlers.push(handler)
    return () => {
      const i = this.#handlers.indexOf(handler)
      if (i >= 0) this.#handlers.splice(i, 1)
    }
  }
  emit(msg: SignalOrderExecution): void {
    for (const h of [...this.#handlers]) h(msg)
  }
}
