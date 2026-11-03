/**
 * The narrow slice of `@algomaker/dx` the Delta feed uses.
 *
 * Structural ports over the package's own types: `DxRest`, `DxPublicSocket`
 * and `toInstrumentRows` satisfy them as they are (`dx-main.ts` passes the real
 * ones), and every test runs against a fake with no socket and no network.
 */

import type { InstrumentRow } from '@algomaker/instruments'
import type { DxFrame, DxProduct } from '@algomaker/dx'

/** The REST call the feed makes. `DxRest` satisfies this. */
export interface DxRestPort {
  products(q: {
    contractTypes?: string[]
    states?: string[]
    underlying?: string[]
    /**
     * `YYYY-MM-DD`, sent as Delta's `expiry`: narrows the expired listing to
     * one settlement date. It matches every underlying and settlement time on
     * that date, so callers keep `underlying` set and still filter on the
     * product's own expiry.
     */
    expiryDate?: string
  }): Promise<readonly DxProduct[]>
}

export interface DxPublicSocketOptions {
  onFrame?: (f: DxFrame) => void
  /** Connection state changes; see `isConnectedState`. */
  onState?: (s: string) => void
}

/** The public socket. `DxPublicSocket` satisfies this. */
export interface DxPublicSocketPort {
  subscribe(channel: 'ticker' | 'spot_price', symbols: string[]): void
  close(): void
}

/** Builds and connects a socket. `(url, opts) => new DxPublicSocket(url, opts)`. */
export type DxPublicSocketFactory = (url: string, opts: DxPublicSocketOptions) => DxPublicSocketPort

/** Products → instrument rows (BTC options plus the spot row). `toInstrumentRows` satisfies this. */
export type DxNormaliser = (products: readonly DxProduct[]) => InstrumentRow[]

/**
 * Is this socket state an open one?
 *
 * `DxSocketState` names `open` and `authenticated` as up and `connecting`,
 * `reconnecting`, `auth_failed`, `closed` as down. Anything unknown reads as
 * DOWN, so a new name can cost a health card showing a socket down, never a
 * dead socket shown up.
 */
export function isConnectedState(s: string): boolean {
  return s === 'open' || s === 'authenticated'
}
