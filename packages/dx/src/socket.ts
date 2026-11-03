/**
 * Delta WebSockets (delta-api-reference.md §8).
 *
 * Public market data: `wss://public-socket.india.delta.exchange`, channels
 * `ticker`, `ob_l1`, `ob_l2`, `trades`, `spot_price` — the NEW names; the
 * `v2/…` and `l1_orderbook`-style names were retired on 31 Oct 2026.
 * Private: `wss://socket.india.delta.exchange`, `key-auth` signed `GET<ts>/live`.
 *
 * Subscriptions do not survive a reconnect on Delta's side, so the socket keeps
 * its own list and replays it on every connect (after auth, on the private
 * one). Heartbeats are enabled on connect; silence past `heartbeatTimeoutMs`
 * (Delta sends one every 30 s) is treated as a dead link and reconnected.
 */
import { WebSocket } from 'ws'
import { parseFrames, type DxFrame } from './normalise.ts'
import { signWsAuth } from './sign.ts'

export type DxSocketState = 'connecting' | 'open' | 'authenticated' | 'auth_failed' | 'reconnecting' | 'closed'

export interface DxSocketOptions {
  readonly onFrame?: (f: DxFrame) => void
  readonly onState?: (s: DxSocketState) => void
  /** First reconnect delay; doubles to `maxReconnectMs`. Default 1000. */
  readonly reconnectMs?: number
  readonly maxReconnectMs?: number
  /** No message for this long → reconnect. Default 35 000. */
  readonly heartbeatTimeoutMs?: number
}

export type DxPublicChannel = 'ticker' | 'spot_price' | 'ob_l1' | 'ob_l2' | 'trades' | 'mark_price'
export type DxPrivateChannel = 'orders' | 'positions' | 'user_trades' | 'v2/user_trades' | 'margins'

abstract class DxSocketBase {
  readonly #url: string
  readonly #opts: DxSocketOptions
  readonly #subs = new Map<string, Set<string>>()
  #ws: WebSocket | null = null
  #closed = false
  #ready = false
  #delay: number
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null
  #watchdog: ReturnType<typeof setTimeout> | null = null

  constructor(url: string, opts: DxSocketOptions = {}) {
    this.#url = url
    this.#opts = opts
    this.#delay = opts.reconnectMs ?? 1000
    this.#connect()
  }

  /** Add symbols to a channel; sent now when ready, and replayed on every reconnect. */
  protected subscribeChannel(channel: string, symbols: readonly string[]): void {
    let set = this.#subs.get(channel)
    if (set === undefined) {
      set = new Set()
      this.#subs.set(channel, set)
    }
    const fresh = symbols.filter((s) => !set.has(s))
    for (const s of fresh) set.add(s)
    if (this.#ready && fresh.length > 0) this.#sendSubscribe([[channel, fresh]])
  }

  close(): void {
    this.#closed = true
    this.#ready = false
    if (this.#reconnectTimer !== null) clearTimeout(this.#reconnectTimer)
    if (this.#watchdog !== null) clearTimeout(this.#watchdog)
    this.#reconnectTimer = null
    this.#watchdog = null
    const ws = this.#ws
    this.#ws = null
    if (ws !== null) {
      ws.removeAllListeners()
      ws.on('error', () => {})
      ws.terminate()
    }
    this.state('closed')
  }

  protected state(s: DxSocketState): void {
    this.#opts.onState?.(s)
  }

  protected send(msg: unknown): void {
    const ws = this.#ws
    if (ws !== null && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
  }

  /** Called once the connection may carry subscriptions: enable heartbeat, replay. */
  protected becomeReady(): void {
    this.#ready = true
    this.#delay = this.#opts.reconnectMs ?? 1000
    this.send({ type: 'enable_heartbeat' })
    const all = [...this.#subs].filter(([, s]) => s.size > 0).map(([c, s]) => [c, [...s]] as [string, string[]])
    if (all.length > 0) this.#sendSubscribe(all)
  }

  /** Drop the link and let the reconnect loop bring it back. */
  protected drop(): void {
    this.#ws?.terminate()
  }

  protected abstract onOpen(): void
  /** Return true to swallow the frame (e.g. an auth reply the subclass handled). */
  protected abstract intercept(f: DxFrame): boolean

  #sendSubscribe(chs: readonly (readonly [string, readonly string[]])[]): void {
    this.send({ type: 'subscribe', payload: { channels: chs.map(([name, symbols]) => ({ name, symbols })) } })
  }

  #arm(): void {
    if (this.#watchdog !== null) clearTimeout(this.#watchdog)
    this.#watchdog = setTimeout(() => this.drop(), this.#opts.heartbeatTimeoutMs ?? 35_000)
    this.#watchdog.unref?.()
  }

  #connect(): void {
    if (this.#closed) return
    this.state('connecting')
    const ws = new WebSocket(this.#url)
    this.#ws = ws
    ws.on('open', () => {
      this.state('open')
      this.#arm()
      this.onOpen()
    })
    ws.on('message', (data) => {
      this.#arm()
      let raw: unknown
      try {
        raw = JSON.parse(String(data))
      } catch {
        return
      }
      for (const f of parseFrames(raw)) {
        if (this.intercept(f)) continue
        this.#opts.onFrame?.(f)
      }
    })
    ws.on('error', () => {
      // 'close' follows; the reconnect is scheduled there.
    })
    ws.on('close', () => {
      if (this.#ws !== ws) return
      this.#ws = null
      this.#ready = false
      if (this.#watchdog !== null) clearTimeout(this.#watchdog)
      if (this.#closed) return
      this.state('reconnecting')
      const wait = this.#delay
      this.#delay = Math.min(this.#delay * 2, this.#opts.maxReconnectMs ?? 30_000)
      this.#reconnectTimer = setTimeout(() => {
        this.#reconnectTimer = null
        this.#connect()
      }, wait)
      this.#reconnectTimer.unref?.()
    })
  }
}

/** Public market data. Frames arrive parsed (`ticker`, `spot`, `ob_l1`, …). */
export class DxPublicSocket extends DxSocketBase {
  subscribe(channel: DxPublicChannel, symbols: string[]): void {
    this.subscribeChannel(channel, symbols)
  }

  protected onOpen(): void {
    this.becomeReady()
  }

  protected intercept(): boolean {
    return false
  }
}

export interface DxPrivateSocketOptions extends DxSocketOptions {
  readonly apiKey: string
  readonly apiSecret: string
  readonly nowMs?: () => number
}

/**
 * Authenticated socket: `key-auth` on every connect, subscriptions only after
 * Delta says authenticated. Private frames (`orders`, `positions`, …) are
 * delivered as `{kind:'other', raw}` — feed them to `DxAdapter.onPrivateFrame`.
 */
export class DxPrivateSocket extends DxSocketBase {
  readonly #key: string
  readonly #secret: string
  readonly #now: () => number

  constructor(url: string, opts: DxPrivateSocketOptions) {
    // super() starts connecting, but `onOpen` only runs on the async 'open'
    // event — after these are set.
    super(url, opts)
    this.#key = opts.apiKey
    this.#secret = opts.apiSecret
    this.#now = opts.nowMs ?? Date.now
  }

  subscribe(channel: DxPrivateChannel, symbols: string[]): void {
    this.subscribeChannel(channel, symbols)
  }

  protected onOpen(): void {
    const ts = Math.floor(this.#now() / 1000)
    this.send({
      type: 'key-auth',
      payload: { 'api-key': this.#key, signature: signWsAuth(this.#secret, ts), timestamp: String(ts) },
    })
  }

  protected intercept(f: DxFrame): boolean {
    if (f.kind !== 'auth') return false
    if (f.ok) {
      this.state('authenticated')
      this.becomeReady()
    } else {
      this.state('auth_failed')
      this.drop()
    }
    return true
  }
}
