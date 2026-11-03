/**
 * Bus transport abstraction.
 *
 * Deliberately NOT zeromq. A native addon (`tulind`) is exactly what blocked the
 * last Node upgrade, and putting another one on the tick path repeats that
 * mistake. `ws` is pure JavaScript and Node 24 ships a native WebSocket client,
 * so there is no build step and nothing to rebuild per ABI. If a measured need
 * for 0mq/NATS appears, it implements this same interface.
 *
 * Topics are hierarchical, dot-separated, with `*` matching one segment and `#`
 * matching the remaining segments:
 *   md.index.NIFTY          one index
 *   md.opt.NIFTY.*          every NIFTY option topic, one level down
 *   md.#                    all market data
 *   sys.error.#             all error events
 */

export type TopicPattern = string

export interface BusMessage<T = unknown> {
  readonly topic: string
  readonly payload: T
  /** Publish timestamp (epoch ms), set by the publisher. */
  readonly ts: number
}

export type Handler<T = unknown> = (msg: BusMessage<T>) => void

export interface Transport {
  publish<T>(topic: string, payload: T, ts: number): void
  subscribe<T>(pattern: TopicPattern, handler: Handler<T>): () => void
  close(): Promise<void>
}

/**
 * Does `topic` match `pattern`?
 *   '*' matches exactly one segment
 *   '#' matches one or more remaining segments (must be last)
 */
export function topicMatches(pattern: TopicPattern, topic: string): boolean {
  if (pattern === topic) return true
  const p = pattern.split('.')
  const t = topic.split('.')

  for (let i = 0; i < p.length; i++) {
    const seg = p[i] as string
    if (seg === '#') {
      // '#' must consume at least one remaining segment.
      return i < t.length
    }
    if (i >= t.length) return false
    if (seg === '*') continue
    if (seg !== t[i]) return false
  }
  // Pattern exhausted: only a match if the topic is exhausted too.
  return p.length === t.length
}

/**
 * In-process transport. Used by the runner (strategies and the feed in one
 * process), and by tests where no network is wanted.
 *
 * Handler exceptions are isolated: one misbehaving subscriber must never prevent
 * the others from receiving a tick, and must never propagate into the publisher.
 */
export class InProcessTransport implements Transport {
  #subs: { pattern: string; handler: Handler<never> }[] = []
  #closed = false
  readonly #onHandlerError: (err: unknown, topic: string) => void

  constructor(onHandlerError?: (err: unknown, topic: string) => void) {
    this.#onHandlerError =
      onHandlerError ??
      ((err, topic) => {
        console.error(`[bus] subscriber threw on '${topic}':`, err)
      })
  }

  publish<T>(topic: string, payload: T, ts: number): void {
    if (this.#closed) return
    // Snapshot: a handler may subscribe/unsubscribe during dispatch.
    for (const s of [...this.#subs]) {
      if (!topicMatches(s.pattern, topic)) continue
      try {
        ;(s.handler as Handler<T>)({ topic, payload, ts })
      } catch (err) {
        this.#onHandlerError(err, topic)
      }
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

  get subscriberCount(): number {
    return this.#subs.length
  }

  async close(): Promise<void> {
    this.#closed = true
    this.#subs = []
  }
}

export * from './ws-transport.ts'
