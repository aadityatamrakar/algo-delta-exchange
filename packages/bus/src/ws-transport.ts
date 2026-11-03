/**
 * Cross-process Transport over `ws`.
 *
 * Pure JavaScript, no native addon — deliberate. A native addon (`tulind`) is
 * what blocked the last Node upgrade, so nothing on the tick path may need
 * per-ABI prebuilds.
 *
 * Topic filtering happens on the SUBSCRIBER, not the server: the server
 * broadcasts and each client matches locally. That keeps the server stateless
 * about who wants what, so a client reconnecting never has to re-register
 * anything. If broadcast volume becomes a bottleneck, move filtering
 * server-side behind this same interface.
 */
import { WebSocketServer, WebSocket } from 'ws'
import { topicMatches, type BusMessage, type Handler, type Transport, type TopicPattern } from './index.ts'

interface Wire {
  topic: string
  payload: unknown
  ts: number
}

export class WsTransportServer implements Transport {
  readonly #wss: WebSocketServer
  readonly #local: { pattern: string; handler: Handler<never> }[] = []
  #boundPort: number | null = null

  constructor(opts: { port: number }) {
    this.#wss = new WebSocketServer({ port: opts.port })
  }

  /**
   * The bound port — but AWAIT THIS IMMEDIATELY AFTER CONSTRUCTION.
   *
   * It waits on `once('listening')`, and the port it caches is only set here — so
   * a caller that constructs the server, does something slow (a Mongo connect, an
   * instrument load), and only then asks, waits FOREVER on an event that already
   * fired. There is no timeout and nothing logs; it presents as a process that
   * started and then did nothing at all.
   *
   * `apps/marketdata` never sees it because it awaits on the very next line. If a
   * caller cannot, it must capture the promise at construction and await it later
   * (`apps/supervisor/test/drills/harness.ts` does exactly that, and says so).
   */
  async ready(): Promise<number> {
    if (this.#boundPort !== null) return this.#boundPort
    await new Promise<void>((resolve) => this.#wss.once('listening', () => resolve()))
    const addr = this.#wss.address()
    this.#boundPort = typeof addr === 'object' && addr !== null ? addr.port : 0
    return this.#boundPort
  }

  get clientCount(): number {
    return this.#wss.clients.size
  }

  publish<T>(topic: string, payload: T, ts: number): void {
    const frame = JSON.stringify({ topic, payload, ts } satisfies Wire)
    for (const c of this.#wss.clients) {
      if (c.readyState === WebSocket.OPEN) c.send(frame)
    }
    // Same-process subscribers still work, so the server can host consumers too.
    for (const s of [...this.#local]) {
      if (topicMatches(s.pattern, topic)) {
        try {
          ;(s.handler as Handler<T>)({ topic, payload, ts })
        } catch (err) {
          console.error(`[ws-bus] local subscriber threw on '${topic}':`, err)
        }
      }
    }
  }

  /** Test hook: send a raw frame to prove a malformed one cannot kill a client. */
  sendRaw(text: string): void {
    for (const c of this.#wss.clients) {
      if (c.readyState === WebSocket.OPEN) c.send(text)
    }
  }

  /**
   * Test hook: forcibly drop every connected socket WITHOUT closing the
   * server, so a reconnecting client's behaviour across the drop can be
   * exercised (`WsTransportClient` reconnects on 'close').
   */
  disconnectClients(): void {
    for (const c of this.#wss.clients) c.terminate()
  }

  subscribe<T>(pattern: TopicPattern, handler: Handler<T>): () => void {
    const entry = { pattern, handler: handler as Handler<never> }
    this.#local.push(entry)
    return () => {
      const i = this.#local.indexOf(entry)
      if (i >= 0) this.#local.splice(i, 1)
    }
  }

  async close(): Promise<void> {
    this.#local.length = 0
    // WebSocketServer.close() does NOT terminate existing client sockets — it
    // only stops accepting new connections, and its 'close' event fires when
    // `clients.size` reaches zero on its own (node_modules/ws/lib/websocket-server.js).
    // Every test up to this point closed its clients before the server, so this
    // never surfaced — but any real shutdown path that closes the server while
    // marketdata/runner/order-gateway are still attached would hang forever.
    for (const c of this.#wss.clients) c.terminate()
    await new Promise<void>((resolve) => this.#wss.close(() => resolve()))
  }
}

export class WsTransportClient implements Transport {
  readonly #url: string
  readonly #reconnectMs: number
  #ws: WebSocket | null = null
  #subs: { pattern: string; handler: Handler<never> }[] = []
  #closed = false
  #openPromise: Promise<void> | null = null

  constructor(opts: { url: string; reconnectMs?: number }) {
    this.#url = opts.url
    this.#reconnectMs = opts.reconnectMs ?? 1000
  }

  async ready(): Promise<void> {
    if (this.#openPromise === null) this.#openPromise = this.#connect()
    return this.#openPromise
  }

  /**
   * Is the socket OPEN right now.
   *
   * `ready()` cannot answer this: it resolves once and stays resolved, and on a
   * drop it is replaced by a fresh pending promise — so awaiting it to find out
   * whether the bus is up would BLOCK until the reconnect lands, which is the
   * opposite of what a status page wants. This reads the same `readyState`
   * `publish()` gates on, so what this reports and what a publish would
   * actually do can never disagree.
   */
  get connected(): boolean {
    return this.#ws?.readyState === WebSocket.OPEN
  }

  /**
   * @param delayMs Wait this long before attempting the socket. Used for
   *   reconnects. The returned Promise is constructed — and therefore PENDING
   *   — synchronously, before the delay elapses, so a caller that assigns it
   *   to `#openPromise` right away gets a promise that genuinely reflects
   *   "not connected yet" rather than a stale resolved one.
   */
  #connect(delayMs = 0): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const attempt = () => {
        if (this.#closed) return
        const ws = new WebSocket(this.#url)
        this.#ws = ws
        ws.on('open', () => resolve())
        ws.on('error', (err) => {
          if (this.#ws === ws && !this.#closed) reject(err)
        })
        ws.on('message', (raw) => this.#onMessage(String(raw)))
        ws.on('close', () => {
          if (this.#closed) return
          // Replace #openPromise SYNCHRONOUSLY, the instant the drop happens —
          // not inside a setTimeout callback that fires `reconnectMs` later.
          // Otherwise `ready()` keeps returning the OLD fulfilled promise for
          // up to `reconnectMs` and falsely reports "connected", while
          // `publish()` silently no-ops (readyState is no longer OPEN) — so
          // messages vanish with nothing available to detect it.
          this.#openPromise = this.#connect(this.#reconnectMs)
        })
      }
      if (delayMs > 0) setTimeout(attempt, delayMs)
      else attempt()
    })
  }

  #onMessage(raw: string): void {
    let msg: Wire
    try {
      msg = JSON.parse(raw) as Wire
    } catch {
      // A malformed frame is dropped, never fatal: one bad publish must not
      // disconnect a consumer that is managing open positions.
      console.error('[ws-bus] dropped malformed frame')
      return
    }
    if (typeof msg?.topic !== 'string') return
    const out: BusMessage = { topic: msg.topic, payload: msg.payload, ts: msg.ts }
    for (const s of [...this.#subs]) {
      if (!topicMatches(s.pattern, msg.topic)) continue
      try {
        ;(s.handler as Handler<unknown>)(out)
      } catch (err) {
        console.error(`[ws-bus] subscriber threw on '${msg.topic}':`, err)
      }
    }
  }

  publish<T>(topic: string, payload: T, ts: number): void {
    if (this.#ws?.readyState === WebSocket.OPEN) {
      this.#ws.send(JSON.stringify({ topic, payload, ts } satisfies Wire))
    }
  }

  subscribe<T>(pattern: TopicPattern, handler: Handler<T>): () => void {
    const entry = { pattern, handler: handler as Handler<never> }
    this.#subs.push(entry)
    return () => {
      const i = this.#subs.indexOf(entry)
      if (i >= 0) this.#subs.splice(i, 1)
    }
  }

  async close(): Promise<void> {
    this.#closed = true
    this.#subs = []
    this.#ws?.close()
  }
}
