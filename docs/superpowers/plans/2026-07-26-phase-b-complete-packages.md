# Phase B: Complete the Packages — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the three capabilities the architecture depends on but that are designed and not built, then add the broker adapters — so the runtime topology can actually run.

**Architecture:** Spec §0.5 records three gaps found by agents auditing the existing packages: the cross-process `ws` Transport (interface + in-process impl only), the feed-staleness reaction (`StrategyBase` has zero staleness references), and broker-position reconciliation (WAL side only). This phase closes all three, then adds `packages/brokers` with one `BrokerAdapter` interface and three implementations. Nothing here places a real order — the XTS adapter is built and unit-tested against recorded payloads, with live credentials deferred to Phase D.

**Tech Stack:** Node 24, TypeScript (native type-stripping, `erasableSyntaxOnly`), `node:test`, `ws`.

## Global Constraints

- **No live broker calls in this phase.** The XTS adapter is exercised against recorded/synthetic payloads only.
- **Node floor 22**, target 24. `packages/*` are ESM with `.ts` extensions in imports (required by type-stripping).
- **`erasableSyntaxOnly` is on** — no enums, no namespaces, no parameter properties, no decorators. `tsc` rejects them.
- **Risk limits are opt-in (D9).** `maxLotsNet: null` means unlimited; `stopPolicy: 'none'` means no stop. Both are valid and must be tested, not treated as errors.
- Every task ends with `npm test` passing and `npm run typecheck` reporting 0 errors.
- Branch: `overhaul/foundation`.

## File Structure

| File | Responsibility |
|---|---|
| `packages/bus/src/ws-transport.ts` (create) | Cross-process `Transport` over `ws`; server + client |
| `packages/bus/test/ws-transport.test.ts` (create) | Real sockets on an ephemeral port |
| `packages/strategy-kit/src/ports.ts` (modify) | Add `FeedHealthPort` so a strategy can ask "is my data trustworthy?" |
| `packages/strategy-kit/src/base.ts` (modify) | `StrategyBase.canEnter()` gate; entries blocked on stale feed, exits never blocked |
| `packages/order-bus/src/reconcile.ts` (create) | Compare local WAL state to a broker snapshot; classify divergences |
| `packages/order-bus/test/reconcile.test.ts` (create) | Every divergence class |
| `packages/brokers/src/types.ts` (create) | `BrokerAdapter` + `capabilities` |
| `packages/brokers/src/simulator.ts` (create) | Paper adapter that FILLS resting orders |
| `packages/brokers/src/xts-live.ts` (create) | XTS order placement + fill feed |
| `packages/brokers/src/zerodha-data.ts` (create) | Market data only, `orders: false` |

---

### Task 1: Cross-process `ws` Transport

Without this the 7-process topology cannot run — `marketdata`, `runner` and `order-gateway` have no way to talk.

**Files:**
- Create: `packages/bus/src/ws-transport.ts`
- Create: `packages/bus/test/ws-transport.test.ts`
- Modify: `packages/bus/src/index.ts` (export it)
- Modify: `packages/bus/package.json` (add `ws` dependency)

**Interfaces:**
- Consumes: `Transport`, `BusMessage`, `Handler`, `topicMatches` from `packages/bus/src/index.ts`.
- Produces:
  - `class WsTransportServer implements Transport` — `constructor(opts: { port: number })`, `async ready(): Promise<number>` (resolves the bound port), `publish`, `subscribe`, `close`.
  - `class WsTransportClient implements Transport` — `constructor(opts: { url: string; reconnectMs?: number })`, `async ready(): Promise<void>`, `publish`, `subscribe`, `close`.
  - Wire format: `{ topic: string, payload: unknown, ts: number }` as JSON per message.

- [ ] **Step 1: Add the dependency**

```bash
npm install ws --workspace packages/bus
npm install --save-dev @types/ws --workspace packages/bus
```

- [ ] **Step 2: Write the failing test**

Create `packages/bus/test/ws-transport.test.ts`:

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { WsTransportServer, WsTransportClient } from '../src/index.ts'

/** Wait for a condition, or fail loudly rather than hanging the suite. */
async function until(fn: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting for condition')
    await new Promise((r) => setTimeout(r, 10))
  }
}

test('a client receives what the server publishes', async () => {
  const server = new WsTransportServer({ port: 0 })
  const port = await server.ready()
  const client = new WsTransportClient({ url: `ws://127.0.0.1:${port}` })
  await client.ready()

  const seen: unknown[] = []
  client.subscribe('md.index.NIFTY', (m) => seen.push(m.payload))

  await until(() => server.clientCount === 1)
  server.publish('md.index.NIFTY', { lastPrice: 24500 }, 1000)

  await until(() => seen.length === 1)
  assert.deepEqual(seen[0], { lastPrice: 24500 })

  await client.close()
  await server.close()
})

test('wildcard subscriptions work across the wire', async () => {
  const server = new WsTransportServer({ port: 0 })
  const port = await server.ready()
  const client = new WsTransportClient({ url: `ws://127.0.0.1:${port}` })
  await client.ready()

  const topics: string[] = []
  client.subscribe('md.#', (m) => topics.push(m.topic))
  await until(() => server.clientCount === 1)

  server.publish('md.index.NIFTY', {}, 1)
  server.publish('md.opt.NIFTY.2026-07-30', {}, 2)
  server.publish('sys.error.x', {}, 3)

  await until(() => topics.length === 2)
  assert.deepEqual(topics, ['md.index.NIFTY', 'md.opt.NIFTY.2026-07-30'])

  await client.close()
  await server.close()
})

test('a client that is not subscribed receives nothing', async () => {
  const server = new WsTransportServer({ port: 0 })
  const port = await server.ready()
  const client = new WsTransportClient({ url: `ws://127.0.0.1:${port}` })
  await client.ready()

  let count = 0
  client.subscribe('md.opt.#', () => count++)
  await until(() => server.clientCount === 1)
  server.publish('md.index.NIFTY', {}, 1)

  await new Promise((r) => setTimeout(r, 100))
  assert.equal(count, 0)

  await client.close()
  await server.close()
})

test('a malformed frame does not kill the connection', async () => {
  // A publisher bug must not take down every consumer.
  const server = new WsTransportServer({ port: 0 })
  const port = await server.ready()
  const client = new WsTransportClient({ url: `ws://127.0.0.1:${port}` })
  await client.ready()

  const seen: string[] = []
  client.subscribe('t.#', (m) => seen.push(m.topic))
  await until(() => server.clientCount === 1)

  server.sendRaw('this is not json')
  server.publish('t.a', {}, 1)

  await until(() => seen.length === 1)
  assert.deepEqual(seen, ['t.a'], 'the good message still arrives')

  await client.close()
  await server.close()
})

test('two clients both receive a published message', async () => {
  const server = new WsTransportServer({ port: 0 })
  const port = await server.ready()
  const a = new WsTransportClient({ url: `ws://127.0.0.1:${port}` })
  const b = new WsTransportClient({ url: `ws://127.0.0.1:${port}` })
  await a.ready()
  await b.ready()

  let ca = 0
  let cb = 0
  a.subscribe('t.a', () => ca++)
  b.subscribe('t.a', () => cb++)
  await until(() => server.clientCount === 2)

  server.publish('t.a', {}, 1)
  await until(() => ca === 1 && cb === 1)
  assert.equal(ca, 1)
  assert.equal(cb, 1)

  await a.close()
  await b.close()
  await server.close()
})
```

- [ ] **Step 3: Run it and confirm it FAILS**

Run: `node --test packages/bus/test/ws-transport.test.ts`
Expected: FAIL — `WsTransportServer` is not exported from `../src/index.ts`.

- [ ] **Step 4: Implement**

Create `packages/bus/src/ws-transport.ts`:

```ts
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

  #connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.#url)
      this.#ws = ws
      ws.on('open', () => resolve())
      ws.on('error', (err) => {
        if (this.#ws === ws && !this.#closed) reject(err)
      })
      ws.on('message', (raw) => this.#onMessage(String(raw)))
      ws.on('close', () => {
        if (this.#closed) return
        // Reconnect and keep existing subscriptions — they live client-side, so
        // there is nothing to re-register on the server.
        setTimeout(() => {
          if (!this.#closed) this.#openPromise = this.#connect()
        }, this.#reconnectMs)
      })
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
```

- [ ] **Step 5: Export it**

Append to `packages/bus/src/index.ts`:

```ts
export * from './ws-transport.ts'
```

- [ ] **Step 6: Run the test — it must PASS**

Run: `node --test packages/bus/test/ws-transport.test.ts`
Expected: **5 passed, 0 failed.**

- [ ] **Step 7: Full suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: all pass; 0 type errors.

- [ ] **Step 8: Commit**

```bash
git add packages/bus package.json package-lock.json
git commit -m "feat(bus): cross-process ws Transport

The 7-process topology (marketdata <-> runner <-> order-gateway) had no way to
communicate: packages/bus shipped the Transport interface and an in-process
implementation only.

Pure-JS ws, no native addon — a native addon (tulind) is what blocked the last
Node upgrade, so nothing on the tick path may need per-ABI prebuilds.

Topic filtering is client-side, so a reconnecting client re-registers nothing.
A malformed frame is dropped rather than closing the connection: one bad publish
must not disconnect a consumer managing open positions."
```

---

### Task 2: Wire feed staleness to entry blocking

`StalenessWatchdog` computes health and `FEED_STALE` exists as an event code, but **`StrategyBase` has zero staleness references** — nothing blocks entries. A socket that stays open while ticks stop is the dangerous failure, because it looks healthy while every strategy decides on frozen prices.

**Files:**
- Modify: `packages/strategy-kit/src/ports.ts`
- Modify: `packages/strategy-kit/src/base.ts`
- Modify: `packages/strategy-kit/src/testing.ts`
- Create: `packages/strategy-kit/test/staleness.test.ts`

**Interfaces:**
- Consumes: `StrategyContext` from `ports.ts`.
- Produces:
  - `interface FeedHealthPort { isTrustworthy(): boolean; reason(): string | null }`
  - `StrategyContext.feed: FeedHealthPort`
  - `protected canEnter(): boolean` on `StrategyBase` — false when the feed is untrustworthy
  - `makeTestContext()` gains `setFeedHealth(ok: boolean, reason?: string)`

- [ ] **Step 1: Write the failing test**

Create `packages/strategy-kit/test/staleness.test.ts`:

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { StrategyBase, makeTestContext, type DataNeed, type PhaseSpec, type Quote, type StrategyContext } from '../src/index.ts'

const INST = { tradingsymbol: 'X', instrumentToken: 1, lotSize: 25, tickSize: 0.05, exchange: 'NFO' }

class Simple extends StrategyBase {
  entries = 0
  exits = 0
  constructor(ctx: StrategyContext) { super(ctx) }
  dataNeeds(): readonly DataNeed[] { return [{ kind: 'index', underlying: 'NIFTY' }] }
  phases(): readonly PhaseSpec[] { return [] }
  protected override async onTick(_q: Quote): Promise<void> {
    if (this.canEnter()) {
      const r = await this.submit({ instrument: INST, side: 'BUY', lots: 1 })
      if (r.accepted) this.entries++
    }
  }
  /** Exits must never be gated on feed health. */
  async forceExit(): Promise<void> {
    const r = await this.submit({ instrument: INST, side: 'SELL', lots: 1, reducesExposure: true })
    if (r.accepted) this.exits++
  }
}

const q = (p: number): Quote => ({ token: 1, lastPrice: p, ts: 0 })

test('entries are allowed while the feed is healthy', async () => {
  const parts = makeTestContext({ nowMs: Date.UTC(2026, 6, 24, 4, 0, 0) })
  const s = new Simple(parts.ctx)
  await s.start()
  s.handleTick(q(100))
  await s.drain()
  assert.equal(s.entries, 1)
})

test('entries are BLOCKED while the feed is stale', async () => {
  const parts = makeTestContext({ nowMs: Date.UTC(2026, 6, 24, 4, 0, 0) })
  const s = new Simple(parts.ctx)
  await s.start()
  parts.setFeedHealth(false, 'no ticks for 42s')
  s.handleTick(q(100))
  await s.drain()
  assert.equal(s.entries, 0, 'a frozen feed must not produce new entries')
})

test('EXITS are still permitted while the feed is stale', async () => {
  // Blocking exits would trap an open position — worse than the stale feed.
  const parts = makeTestContext({ nowMs: Date.UTC(2026, 6, 24, 4, 0, 0) })
  const s = new Simple(parts.ctx)
  await s.start()
  parts.setFeedHealth(false, 'no ticks for 42s')
  await s.forceExit()
  assert.equal(s.exits, 1)
})

test('entries resume once the feed recovers', async () => {
  const parts = makeTestContext({ nowMs: Date.UTC(2026, 6, 24, 4, 0, 0) })
  const s = new Simple(parts.ctx)
  await s.start()
  parts.setFeedHealth(false, 'stale')
  s.handleTick(q(100))
  await s.drain()
  assert.equal(s.entries, 0)

  parts.setFeedHealth(true)
  s.handleTick(q(101))
  await s.drain()
  assert.equal(s.entries, 1)
})

test('the block reason is logged so it is diagnosable', async () => {
  const parts = makeTestContext({ nowMs: Date.UTC(2026, 6, 24, 4, 0, 0) })
  const s = new Simple(parts.ctx)
  await s.start()
  parts.setFeedHealth(false, 'no ticks for 42s')
  s.handleTick(q(100))
  await s.drain()
  assert.ok(
    parts.logs.some((l) => l.msg.includes('no ticks for 42s')),
    'the reason must reach the log, not just silently suppress'
  )
})
```

- [ ] **Step 2: Run it and confirm it FAILS**

Run: `node --test packages/strategy-kit/test/staleness.test.ts`
Expected: FAIL — `setFeedHealth` is not a function on the test context, and `canEnter` does not exist.

- [ ] **Step 3: Add the port**

In `packages/strategy-kit/src/ports.ts`, add before `StrategyContext`:

```ts
/**
 * Whether market data is currently trustworthy.
 *
 * The dangerous failure is not a disconnect — that is loud. It is a socket that
 * stays OPEN while ticks stop, which looks healthy while every strategy decides
 * on frozen prices. `marketdata` owns the detection; strategies only ask.
 */
export interface FeedHealthPort {
  isTrustworthy(): boolean
  /** Human-readable reason when untrustworthy, else null. */
  reason(): string | null
}
```

and add to `StrategyContext`:

```ts
  readonly feed: FeedHealthPort
```

- [ ] **Step 4: Add the gate**

In `packages/strategy-kit/src/base.ts`, add to the helpers section:

```ts
  /**
   * Whether this strategy may open NEW exposure right now.
   *
   * Deliberately does NOT gate exits: blocking an exit on a stale feed would
   * trap an open position, which is worse than the stale feed itself. Strategies
   * must call this before entering; `submit()` with `reducesExposure: true`
   * remains available unconditionally.
   */
  protected canEnter(): boolean {
    if (this.#stopped) return false
    if (!this.ctx.feed.isTrustworthy()) {
      this.ctx.log.warn(`${this.tag}: entry blocked — feed not trustworthy`, {
        reason: this.ctx.feed.reason() ?? 'unknown',
      })
      return false
    }
    return true
  }
```

- [ ] **Step 5: Add the test hook**

In `packages/strategy-kit/src/testing.ts`, inside `makeTestContext`, before building `ctx`:

```ts
  let feedOk = true
  let feedReason: string | null = null
  const feed = {
    isTrustworthy: () => feedOk,
    reason: () => feedReason,
  }
```

add `feed,` to the `ctx` object literal, and add to the returned object:

```ts
    setFeedHealth: (ok: boolean, reason?: string) => {
      feedOk = ok
      feedReason = ok ? null : (reason ?? 'stale')
    },
```

Extend `TestContextParts` with:

```ts
  setFeedHealth: (ok: boolean, reason?: string) => void
```

- [ ] **Step 6: Run the test — it must PASS**

Run: `node --test packages/strategy-kit/test/staleness.test.ts`
Expected: **5 passed, 0 failed.**

- [ ] **Step 7: Full suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: all pass; 0 type errors. Existing `base.test.ts` tests must still pass — `canEnter()` defaults to true when the feed is healthy.

- [ ] **Step 8: Commit**

```bash
git add packages/strategy-kit
git commit -m "feat(strategy-kit): block entries on an untrustworthy feed

StalenessWatchdog computed health and FEED_STALE existed as an event code, but
StrategyBase had ZERO staleness references — nothing actually blocked entries.
The mitigation was described in the design and not built.

Adds FeedHealthPort and StrategyBase.canEnter(). Exits are deliberately NOT
gated: blocking an exit on a stale feed would trap an open position, which is
worse than the stale feed. The block reason is logged so it is diagnosable
rather than a silent no-op."
```

---

### Task 3: Broker-position reconciliation

`unresolvedIntents()` covers the WAL side only — nothing compares local state to a real broker position. This is needed for restart recovery, and it is the specific gap that makes cutover rollback risky (spec §8.5): the legacy stack would resume knowing nothing about resting orders the new stack placed.

**Files:**
- Create: `packages/order-bus/src/reconcile.ts`
- Create: `packages/order-bus/test/reconcile.test.ts`
- Modify: `packages/order-bus/src/index.ts`

**Interfaces:**
- Consumes: `WalRecord`, `unresolvedIntents` from `packages/order-bus/src/index.ts`.
- Produces:
  - `interface BrokerPosition { tradingsymbol: string; netQty: number; avgPrice: number }`
  - `interface BrokerOrder { brokerOrderId: string; clientOrderId: string | null; tradingsymbol: string; status: string; filledQty: number }`
  - `type Divergence` — a discriminated union, `kind` one of `'UNKNOWN_BROKER_POSITION' | 'MISSING_BROKER_POSITION' | 'QTY_MISMATCH' | 'ORPHAN_BROKER_ORDER' | 'UNRESOLVED_INTENT'`
  - `function reconcile(records: readonly WalRecord[], positions: readonly BrokerPosition[], orders: readonly BrokerOrder[]): Divergence[]`

- [ ] **Step 1: Write the failing test**

Create `packages/order-bus/test/reconcile.test.ts`:

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { reconcile, type BrokerOrder, type BrokerPosition, type OrderIntent, type WalRecord } from '../src/index.ts'

const intent = (id: string, symbol: string, side: 'BUY' | 'SELL', qty: number): OrderIntent => ({
  clientOrderId: id,
  ts: 1,
  strategyTag: 'T',
  mode: 'live',
  destinations: ['xts'],
  instrument: { tradingsymbol: symbol, lotSize: 25, tickSize: 0.05, exchange: 'NFO' },
  side,
  orderType: 'MARKET',
  quantity: qty,
  lots: qty / 25,
})

const filled = (id: string, qty: number): WalRecord => ({
  kind: 'STATUS', ts: 2, clientOrderId: id, destination: 'xts',
  status: 'FILLED', filledQty: qty, avgFillPrice: 100,
})

const pos = (tradingsymbol: string, netQty: number): BrokerPosition => ({ tradingsymbol, netQty, avgPrice: 100 })

test('a matching position produces no divergence', () => {
  const recs: WalRecord[] = [
    { kind: 'INTENT', ts: 1, intent: intent('a', 'NIFTY_CE', 'BUY', 50) },
    filled('a', 50),
  ]
  assert.deepEqual(reconcile(recs, [pos('NIFTY_CE', 50)], []), [])
})

test('a broker position we have no record of is reported', () => {
  // The dangerous one: something is open that we are not managing.
  const d = reconcile([], [pos('BANKNIFTY_PE', 35)], [])
  assert.equal(d.length, 1)
  assert.equal(d[0]?.kind, 'UNKNOWN_BROKER_POSITION')
})

test('a position we believe in but the broker does not have is reported', () => {
  const recs: WalRecord[] = [
    { kind: 'INTENT', ts: 1, intent: intent('a', 'NIFTY_CE', 'BUY', 50) },
    filled('a', 50),
  ]
  const d = reconcile(recs, [], [])
  assert.equal(d.length, 1)
  assert.equal(d[0]?.kind, 'MISSING_BROKER_POSITION')
})

test('a quantity mismatch is reported with both numbers', () => {
  const recs: WalRecord[] = [
    { kind: 'INTENT', ts: 1, intent: intent('a', 'NIFTY_CE', 'BUY', 50) },
    filled('a', 50),
  ]
  const d = reconcile(recs, [pos('NIFTY_CE', 25)], [])
  assert.equal(d.length, 1)
  assert.equal(d[0]?.kind, 'QTY_MISMATCH')
  assert.match(JSON.stringify(d[0]), /50/)
  assert.match(JSON.stringify(d[0]), /25/)
})

test('SELL fills reduce the expected net quantity', () => {
  const recs: WalRecord[] = [
    { kind: 'INTENT', ts: 1, intent: intent('a', 'NIFTY_CE', 'BUY', 50) },
    filled('a', 50),
    { kind: 'INTENT', ts: 3, intent: intent('b', 'NIFTY_CE', 'SELL', 50) },
    filled('b', 50),
  ]
  assert.deepEqual(reconcile(recs, [], []), [], 'net zero means no position expected')
})

test('a resting broker order we did not place is an ORPHAN — the rollback case', () => {
  // Exactly the cutover-rollback hazard: the legacy stack resumes with no
  // knowledge of resting SL/target orders the new stack placed.
  const orphan: BrokerOrder = {
    brokerOrderId: 'B1', clientOrderId: null,
    tradingsymbol: 'NIFTY_CE', status: 'OPEN', filledQty: 0,
  }
  const d = reconcile([], [], [orphan])
  assert.equal(d.length, 1)
  assert.equal(d[0]?.kind, 'ORPHAN_BROKER_ORDER')
})

test('an intent journalled but never resolved is reported', () => {
  const recs: WalRecord[] = [{ kind: 'INTENT', ts: 1, intent: intent('x', 'NIFTY_CE', 'BUY', 25) }]
  const kinds = reconcile(recs, [], []).map((x) => x.kind)
  assert.ok(kinds.includes('UNRESOLVED_INTENT'))
})

test('risk-rejected intents are not treated as unresolved', () => {
  const recs: WalRecord[] = [
    { kind: 'INTENT', ts: 1, intent: intent('x', 'NIFTY_CE', 'BUY', 25) },
    { kind: 'REJECTED_BY_RISK', ts: 2, intent: intent('x', 'NIFTY_CE', 'BUY', 25), code: 'KILL_SWITCH' },
  ]
  assert.deepEqual(reconcile(recs, [], []), [])
})
```

- [ ] **Step 2: Run it and confirm it FAILS**

Run: `node --test packages/order-bus/test/reconcile.test.ts`
Expected: FAIL — `reconcile` is not exported.

- [ ] **Step 3: Implement**

Create `packages/order-bus/src/reconcile.ts`:

```ts
/**
 * Compare local WAL-derived state to a broker snapshot.
 *
 * Needed twice:
 *   1. restart recovery — the legacy system could not do this at all, because
 *      positions lived only in process memory;
 *   2. cutover rollback — the legacy stack resumes knowing nothing about resting
 *      SL/target orders the new stack placed at the broker (spec 8.5).
 *
 * Pure: takes snapshots, returns divergences. Fetching them is the caller's job,
 * which keeps every divergence class testable without a broker.
 */
import type { WalRecord } from './types.ts'
import { unresolvedIntents } from './wal.ts'

export interface BrokerPosition {
  readonly tradingsymbol: string
  /** Signed: positive long, negative short. */
  readonly netQty: number
  readonly avgPrice: number
}

export interface BrokerOrder {
  readonly brokerOrderId: string
  /** Null when the broker has no record of our idempotency key. */
  readonly clientOrderId: string | null
  readonly tradingsymbol: string
  readonly status: string
  readonly filledQty: number
}

export type Divergence =
  | { readonly kind: 'UNKNOWN_BROKER_POSITION'; readonly tradingsymbol: string; readonly brokerQty: number }
  | { readonly kind: 'MISSING_BROKER_POSITION'; readonly tradingsymbol: string; readonly expectedQty: number }
  | { readonly kind: 'QTY_MISMATCH'; readonly tradingsymbol: string; readonly expectedQty: number; readonly brokerQty: number }
  | { readonly kind: 'ORPHAN_BROKER_ORDER'; readonly brokerOrderId: string; readonly tradingsymbol: string }
  | { readonly kind: 'UNRESOLVED_INTENT'; readonly clientOrderId: string }

/** Net quantity per symbol implied by FILLED records in the journal. */
function expectedPositions(records: readonly WalRecord[]): Map<string, number> {
  const bySymbol = new Map<string, number>()
  const intents = new Map<string, { symbol: string; side: 'BUY' | 'SELL' }>()

  for (const r of records) {
    if (r.kind === 'INTENT') {
      intents.set(r.intent.clientOrderId, {
        symbol: r.intent.instrument.tradingsymbol,
        side: r.intent.side,
      })
    }
  }
  for (const r of records) {
    if (r.kind !== 'STATUS') continue
    if (r.status !== 'FILLED' && r.status !== 'PARTIALLY_FILLED') continue
    const meta = intents.get(r.clientOrderId)
    if (meta === undefined) continue
    const signed = meta.side === 'BUY' ? r.filledQty : -r.filledQty
    bySymbol.set(meta.symbol, (bySymbol.get(meta.symbol) ?? 0) + signed)
  }
  // Drop flat symbols — a net-zero symbol is not an expected position.
  for (const [k, v] of [...bySymbol]) if (v === 0) bySymbol.delete(k)
  return bySymbol
}

export function reconcile(
  records: readonly WalRecord[],
  positions: readonly BrokerPosition[],
  orders: readonly BrokerOrder[],
): Divergence[] {
  const out: Divergence[] = []
  const expected = expectedPositions(records)
  const broker = new Map(positions.map((p) => [p.tradingsymbol, p.netQty]))

  for (const [symbol, expectedQty] of expected) {
    const brokerQty = broker.get(symbol)
    if (brokerQty === undefined) {
      out.push({ kind: 'MISSING_BROKER_POSITION', tradingsymbol: symbol, expectedQty })
    } else if (brokerQty !== expectedQty) {
      out.push({ kind: 'QTY_MISMATCH', tradingsymbol: symbol, expectedQty, brokerQty })
    }
  }

  for (const [symbol, brokerQty] of broker) {
    if (brokerQty === 0) continue
    if (!expected.has(symbol)) {
      out.push({ kind: 'UNKNOWN_BROKER_POSITION', tradingsymbol: symbol, brokerQty })
    }
  }

  const known = new Set<string>()
  for (const r of records) if (r.kind === 'INTENT') known.add(r.intent.clientOrderId)
  for (const o of orders) {
    const isOurs = o.clientOrderId !== null && known.has(o.clientOrderId)
    if (!isOurs) {
      out.push({ kind: 'ORPHAN_BROKER_ORDER', brokerOrderId: o.brokerOrderId, tradingsymbol: o.tradingsymbol })
    }
  }

  for (const id of unresolvedIntents(records)) {
    out.push({ kind: 'UNRESOLVED_INTENT', clientOrderId: id })
  }
  return out
}
```

- [ ] **Step 4: Export it**

Append to `packages/order-bus/src/index.ts`:

```ts
export * from './reconcile.ts'
```

- [ ] **Step 5: Run the test — it must PASS**

Run: `node --test packages/order-bus/test/reconcile.test.ts`
Expected: **8 passed, 0 failed.**

- [ ] **Step 6: Full suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: all pass; 0 type errors.

- [ ] **Step 7: Commit**

```bash
git add packages/order-bus
git commit -m "feat(order-bus): broker-position reconciliation

unresolvedIntents() covered the WAL side only — nothing compared local state to
a real broker position. Needed for restart recovery (the legacy system could not
do this at all, since positions lived in process memory) and for cutover
rollback, where the legacy stack resumes knowing nothing about resting SL/target
orders the new stack placed.

Pure function over snapshots, so every divergence class is testable without a
broker. ORPHAN_BROKER_ORDER is the rollback hazard made detectable."
```

---

### Task 4: `BrokerAdapter` interface and the simulator

The simulator must fill RESTING orders. Today `paperstream.js:353` returns early unless `status === 'COMPLETE'`, while `trackOrder_slm` inserts `'Pending'` — so resting SL/target **cannot be paper-tested at all**, which makes D3 unverifiable in paper.

**Files:**
- Create: `packages/brokers/package.json`, `packages/brokers/src/types.ts`, `packages/brokers/src/simulator.ts`, `packages/brokers/src/index.ts`
- Create: `packages/brokers/test/simulator.test.ts`

**Interfaces:**
- Consumes: `OrderIntent`, `OrderStatus`, `Side` from `@algomaker/order-bus`.
- Produces:
  - `interface BrokerCapabilities { readonly orders: boolean; readonly marketData: boolean; readonly modify: boolean }`
  - `interface PlacedOrder { brokerOrderId: string; clientOrderId: string; status: OrderStatus; filledQty: number; avgPrice: number | null }`
  - `interface BrokerAdapter { readonly name: string; readonly capabilities: BrokerCapabilities; placeOrder(intent: OrderIntent): Promise<PlacedOrder>; modifyOrder(brokerOrderId: string, price: number): Promise<boolean>; cancelOrder(brokerOrderId: string): Promise<boolean>; onFill(h: (o: PlacedOrder) => void): () => void }`
  - `class SimulatorAdapter implements BrokerAdapter` with `feedTick(token: number, price: number): void`

- [ ] **Step 1: Create the package**

Create `packages/brokers/package.json`:

```json
{
  "name": "@algomaker/brokers",
  "version": "1.0.0",
  "description": "One BrokerAdapter interface, three implementations: zerodha-data (market data only), xts-live (orders + fills), simulator (paper).",
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "test": "node --test test/*.test.ts" },
  "engines": { "node": ">=22" },
  "dependencies": {
    "@algomaker/core": "1.0.0",
    "@algomaker/order-bus": "1.0.0"
  }
}
```

Run: `npm install`
Expected: `@algomaker/brokers` symlinked into `node_modules/@algomaker/`.

- [ ] **Step 2: Write the failing test**

Create `packages/brokers/test/simulator.test.ts`:

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { SimulatorAdapter } from '../src/index.ts'
import type { OrderIntent } from '@algomaker/order-bus'

const INST = { tradingsymbol: 'NIFTY_CE', instrumentToken: 42, lotSize: 25, tickSize: 0.05, exchange: 'NFO' }

function intent(over: Partial<OrderIntent> = {}): OrderIntent {
  return {
    clientOrderId: 'c1', ts: 1, strategyTag: 'T', mode: 'sim', destinations: ['sim'],
    instrument: INST, side: 'BUY', orderType: 'MARKET', quantity: 25, lots: 1,
    ...over,
  }
}

test('a MARKET order fills immediately at the last tick', async () => {
  const sim = new SimulatorAdapter()
  sim.feedTick(42, 120)
  const o = await sim.placeOrder(intent())
  assert.equal(o.status, 'FILLED')
  assert.equal(o.avgPrice, 120)
  assert.equal(o.filledQty, 25)
})

test('capabilities declare orders and modify but not market data', () => {
  const sim = new SimulatorAdapter()
  assert.equal(sim.capabilities.orders, true)
  assert.equal(sim.capabilities.modify, true)
  assert.equal(sim.capabilities.marketData, false)
})

test('an SL_MARKET order RESTS and does not fill immediately', async () => {
  // This is what the legacy simulator could not do: paperstream.js:353 drops
  // every 'Pending' order, so resting SL/target were untestable in paper.
  const sim = new SimulatorAdapter()
  sim.feedTick(42, 120)
  const o = await sim.placeOrder(intent({ clientOrderId: 'sl', side: 'SELL', orderType: 'SL_MARKET', triggerPrice: 100 }))
  assert.equal(o.status, 'WORKING')
  assert.equal(o.filledQty, 0)
})

test('a resting SELL SL_MARKET fills when a tick crosses DOWN through the trigger', async () => {
  const sim = new SimulatorAdapter()
  sim.feedTick(42, 120)
  const fills: string[] = []
  sim.onFill((o) => { if (o.status === 'FILLED') fills.push(o.clientOrderId) })

  await sim.placeOrder(intent({ clientOrderId: 'sl', side: 'SELL', orderType: 'SL_MARKET', triggerPrice: 100 }))
  sim.feedTick(42, 105)
  assert.deepEqual(fills, [], 'above the trigger, must not fill')

  sim.feedTick(42, 99)
  assert.deepEqual(fills, ['sl'], 'crossing down through the trigger fills it')
})

test('a resting BUY SL_MARKET fills when a tick crosses UP through the trigger', async () => {
  const sim = new SimulatorAdapter()
  sim.feedTick(42, 100)
  const fills: string[] = []
  sim.onFill((o) => { if (o.status === 'FILLED') fills.push(o.clientOrderId) })

  await sim.placeOrder(intent({ clientOrderId: 'buysl', side: 'BUY', orderType: 'SL_MARKET', triggerPrice: 120 }))
  sim.feedTick(42, 119)
  assert.deepEqual(fills, [])
  sim.feedTick(42, 121)
  assert.deepEqual(fills, ['buysl'])
})

test('a LIMIT SELL fills only when the tick trades THROUGH the limit', async () => {
  const sim = new SimulatorAdapter()
  sim.feedTick(42, 100)
  const fills: string[] = []
  sim.onFill((o) => { if (o.status === 'FILLED') fills.push(o.clientOrderId) })

  await sim.placeOrder(intent({ clientOrderId: 'tgt', side: 'SELL', orderType: 'LIMIT', limitPrice: 150 }))
  sim.feedTick(42, 149)
  assert.deepEqual(fills, [], 'below the limit, a sell must not fill')
  sim.feedTick(42, 151)
  assert.deepEqual(fills, ['tgt'])
})

test('SL_MARKET fills at the crossing tick, with configurable slippage', async () => {
  const sim = new SimulatorAdapter({ slippage: 0.5 })
  sim.feedTick(42, 120)
  let price: number | null = null
  sim.onFill((o) => { if (o.status === 'FILLED') price = o.avgPrice })
  await sim.placeOrder(intent({ clientOrderId: 'sl', side: 'SELL', orderType: 'SL_MARKET', triggerPrice: 100 }))
  sim.feedTick(42, 98)
  // A SELL stop slips DOWN — against the seller.
  assert.equal(price, 97.5)
})

test('cancelling a resting order stops it filling', async () => {
  const sim = new SimulatorAdapter()
  sim.feedTick(42, 120)
  const fills: string[] = []
  sim.onFill((o) => { if (o.status === 'FILLED') fills.push(o.clientOrderId) })
  const o = await sim.placeOrder(intent({ clientOrderId: 'sl', side: 'SELL', orderType: 'SL_MARKET', triggerPrice: 100 }))
  assert.equal(await sim.cancelOrder(o.brokerOrderId), true)
  sim.feedTick(42, 90)
  assert.deepEqual(fills, [])
})

test('modifyOrder reprices a resting order atomically', async () => {
  const sim = new SimulatorAdapter()
  sim.feedTick(42, 120)
  const fills: string[] = []
  sim.onFill((o) => { if (o.status === 'FILLED') fills.push(o.clientOrderId) })
  const o = await sim.placeOrder(intent({ clientOrderId: 'sl', side: 'SELL', orderType: 'SL_MARKET', triggerPrice: 100 }))

  assert.equal(await sim.modifyOrder(o.brokerOrderId, 110), true)
  sim.feedTick(42, 109)
  assert.deepEqual(fills, ['sl'], 'the NEW trigger applies')
})
```

- [ ] **Step 3: Run it and confirm it FAILS**

Run: `node --test packages/brokers/test/simulator.test.ts`
Expected: FAIL — cannot resolve `../src/index.ts`.

- [ ] **Step 4: Write the types**

Create `packages/brokers/src/types.ts`:

```ts
/**
 * One interface, three implementations. Paper and live run IDENTICAL strategy
 * code — only the injected adapter differs (spec D2).
 *
 * `capabilities` is enforced at construction rather than by convention. That is
 * what makes the dual-rail bug structurally impossible: `zerodha-data` declares
 * `orders: false`, so it CANNOT place an order. The legacy
 * `Account.placeAllAccount` inserted on the order bus AND placed Zerodha orders
 * in one call (common/models/account.js:148-152), and nothing prevented it.
 */
import type { OrderIntent, OrderStatus } from '@algomaker/order-bus'

export interface BrokerCapabilities {
  readonly orders: boolean
  readonly marketData: boolean
  /** Atomic reprice. Preferred over cancel+replace, which races a fill. */
  readonly modify: boolean
}

export interface PlacedOrder {
  readonly brokerOrderId: string
  readonly clientOrderId: string
  readonly status: OrderStatus
  readonly filledQty: number
  /** Broker-reported average fill. NEVER inferred locally — D3 depends on it. */
  readonly avgPrice: number | null
}

export interface BrokerAdapter {
  readonly name: string
  readonly capabilities: BrokerCapabilities
  placeOrder(intent: OrderIntent): Promise<PlacedOrder>
  modifyOrder(brokerOrderId: string, price: number): Promise<boolean>
  cancelOrder(brokerOrderId: string): Promise<boolean>
  onFill(handler: (order: PlacedOrder) => void): () => void
}

export class CapabilityError extends Error {}

/** Guard for call sites: throws rather than silently doing nothing. */
export function assertCanPlaceOrders(a: BrokerAdapter): void {
  if (!a.capabilities.orders) {
    throw new CapabilityError(`adapter '${a.name}' is market-data only and cannot place orders`)
  }
}
```

- [ ] **Step 5: Write the simulator**

Create `packages/brokers/src/simulator.ts`:

```ts
/**
 * Paper adapter that actually FILLS resting orders.
 *
 * The legacy simulator could not: server/boot/paperstream.js:353 returns unless
 * `status === 'COMPLETE'`, while trackOrder_slm/trackOrder_limit insert
 * 'Pending'. So stop and limit orders rested forever and D3 (resting SL/target)
 * was impossible to rehearse in paper. Under a cutover that is unacceptable —
 * paper is the only rehearsal there is.
 *
 * Fill model:
 *   MARKET     fills immediately at the last tick
 *   SL_MARKET  fills when a tick crosses the trigger, then slips AGAINST us
 *   LIMIT      fills only when a tick trades through the limit (no slippage)
 */
import type { OrderIntent } from '@algomaker/order-bus'
import type { BrokerAdapter, BrokerCapabilities, PlacedOrder } from './types.ts'

interface Resting {
  brokerOrderId: string
  intent: OrderIntent
  trigger: number
  token: number
}

export interface SimulatorOptions {
  /** Price given up when a stop triggers. Applied against the order's side. */
  readonly slippage?: number
}

export class SimulatorAdapter implements BrokerAdapter {
  readonly name = 'simulator'
  readonly capabilities: BrokerCapabilities = { orders: true, marketData: false, modify: true }

  readonly #last = new Map<number, number>()
  readonly #resting = new Map<string, Resting>()
  readonly #handlers: ((o: PlacedOrder) => void)[] = []
  readonly #slippage: number
  #seq = 0

  constructor(opts: SimulatorOptions = {}) {
    this.#slippage = opts.slippage ?? 0
  }

  feedTick(token: number, price: number): void {
    this.#last.set(token, price)
    for (const r of [...this.#resting.values()]) {
      if (r.token !== token) continue
      if (this.#crosses(r, price)) {
        this.#resting.delete(r.brokerOrderId)
        this.#emit(this.#fillFor(r, price))
      }
    }
  }

  #crosses(r: Resting, price: number): boolean {
    const t = r.intent.orderType
    const side = r.intent.side
    if (t === 'SL_MARKET' || t === 'SL_LIMIT') {
      // A stop triggers when price moves THROUGH it, in the losing direction.
      return side === 'SELL' ? price < r.trigger : price > r.trigger
    }
    // A limit fills only when the market trades through it, in our favour.
    return side === 'SELL' ? price > r.trigger : price < r.trigger
  }

  #fillFor(r: Resting, price: number): PlacedOrder {
    const isStop = r.intent.orderType === 'SL_MARKET' || r.intent.orderType === 'SL_LIMIT'
    // Slippage always hurts: a SELL stop fills lower, a BUY stop fills higher.
    const slip = isStop ? (r.intent.side === 'SELL' ? -this.#slippage : this.#slippage) : 0
    return {
      brokerOrderId: r.brokerOrderId,
      clientOrderId: r.intent.clientOrderId,
      status: 'FILLED',
      filledQty: r.intent.quantity,
      avgPrice: Number((price + slip).toFixed(4)),
    }
  }

  #emit(o: PlacedOrder): void {
    for (const h of [...this.#handlers]) {
      try {
        h(o)
      } catch (err) {
        console.error('[simulator] fill handler threw:', err)
      }
    }
  }

  async placeOrder(intent: OrderIntent): Promise<PlacedOrder> {
    this.#seq++
    const brokerOrderId = `sim-${this.#seq}`
    const token = intent.instrument.instrumentToken ?? -1
    const last = this.#last.get(token)

    if (intent.orderType === 'MARKET') {
      const o: PlacedOrder = {
        brokerOrderId,
        clientOrderId: intent.clientOrderId,
        status: 'FILLED',
        filledQty: intent.quantity,
        avgPrice: last ?? null,
      }
      this.#emit(o)
      return o
    }

    const trigger = intent.orderType === 'LIMIT' ? intent.limitPrice : intent.triggerPrice
    if (trigger === undefined) {
      return {
        brokerOrderId, clientOrderId: intent.clientOrderId,
        status: 'REJECTED', filledQty: 0, avgPrice: null,
      }
    }
    this.#resting.set(brokerOrderId, { brokerOrderId, intent, trigger, token })
    return {
      brokerOrderId, clientOrderId: intent.clientOrderId,
      status: 'WORKING', filledQty: 0, avgPrice: null,
    }
  }

  async modifyOrder(brokerOrderId: string, price: number): Promise<boolean> {
    const r = this.#resting.get(brokerOrderId)
    if (r === undefined) return false
    this.#resting.set(brokerOrderId, { ...r, trigger: price })
    return true
  }

  async cancelOrder(brokerOrderId: string): Promise<boolean> {
    return this.#resting.delete(brokerOrderId)
  }

  onFill(handler: (order: PlacedOrder) => void): () => void {
    this.#handlers.push(handler)
    return () => {
      const i = this.#handlers.indexOf(handler)
      if (i >= 0) this.#handlers.splice(i, 1)
    }
  }

  get restingCount(): number {
    return this.#resting.size
  }
}
```

- [ ] **Step 6: Create the barrel export**

Create `packages/brokers/src/index.ts`:

```ts
export * from './types.ts'
export * from './simulator.ts'
```

- [ ] **Step 7: Run the test — it must PASS**

Run: `node --test packages/brokers/test/simulator.test.ts`
Expected: **9 passed, 0 failed.**

- [ ] **Step 8: Full suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: all pass; 0 type errors.

- [ ] **Step 9: Commit**

```bash
git add packages/brokers package.json package-lock.json
git commit -m "feat(brokers): BrokerAdapter interface + simulator that fills resting orders

Capabilities are enforced at construction, not by convention — zerodha-data will
declare orders:false and be structurally incapable of placing an order. The
legacy Account.placeAllAccount inserted on the bus AND placed Zerodha orders in
one call (common/models/account.js:148-152) with nothing to prevent it.

The simulator fills RESTING orders, which the legacy one could not:
paperstream.js:353 drops every 'Pending' order, so resting SL/target could not be
rehearsed in paper at all. Under a cutover, paper is the only rehearsal there is.

Slippage always hurts: a SELL stop fills lower, a BUY stop higher."
```

---

### Task 5: Zerodha data adapter (`orders: false`)

**Files:**
- Create: `packages/brokers/src/zerodha-data.ts`
- Create: `packages/brokers/test/zerodha-data.test.ts`
- Modify: `packages/brokers/src/index.ts`

**Interfaces:**
- Consumes: `BrokerAdapter`, `CapabilityError`, `assertCanPlaceOrders` from `./types.ts`.
- Produces: `class ZerodhaDataAdapter implements BrokerAdapter` with `capabilities = { orders: false, marketData: true, modify: false }`.

- [ ] **Step 1: Write the failing test**

Create `packages/brokers/test/zerodha-data.test.ts`:

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { ZerodhaDataAdapter, CapabilityError, assertCanPlaceOrders } from '../src/index.ts'
import type { OrderIntent } from '@algomaker/order-bus'

const intent: OrderIntent = {
  clientOrderId: 'c1', ts: 1, strategyTag: 'T', mode: 'live', destinations: ['zerodha'],
  instrument: { tradingsymbol: 'X', instrumentToken: 1, lotSize: 25, tickSize: 0.05, exchange: 'NFO' },
  side: 'BUY', orderType: 'MARKET', quantity: 25, lots: 1,
}

test('zerodha-data declares market data only', () => {
  const z = new ZerodhaDataAdapter()
  assert.equal(z.capabilities.marketData, true)
  assert.equal(z.capabilities.orders, false)
  assert.equal(z.capabilities.modify, false)
})

test('placeOrder REJECTS structurally — this is the dual-rail fix', async () => {
  // The legacy Account.placeAllAccount could place Zerodha orders AND insert on
  // the bus. Making Zerodha incapable of ordering removes that by construction.
  const z = new ZerodhaDataAdapter()
  await assert.rejects(() => z.placeOrder(intent), CapabilityError)
})

test('modify and cancel also reject', async () => {
  const z = new ZerodhaDataAdapter()
  await assert.rejects(() => z.modifyOrder('x', 1), CapabilityError)
  await assert.rejects(() => z.cancelOrder('x'), CapabilityError)
})

test('assertCanPlaceOrders throws for it and passes for an order-capable adapter', () => {
  const z = new ZerodhaDataAdapter()
  assert.throws(() => assertCanPlaceOrders(z), CapabilityError)
})

test('onFill returns an unsubscribe and never fires', () => {
  const z = new ZerodhaDataAdapter()
  let n = 0
  const off = z.onFill(() => n++)
  off()
  assert.equal(n, 0, 'a data-only adapter has no fills')
})
```

- [ ] **Step 2: Run it and confirm it FAILS**

Run: `node --test packages/brokers/test/zerodha-data.test.ts`
Expected: FAIL — `ZerodhaDataAdapter` is not exported.

- [ ] **Step 3: Implement**

Create `packages/brokers/src/zerodha-data.ts`:

```ts
/**
 * Zerodha, market data ONLY (spec D1).
 *
 * Every order method throws. That is the point: the legacy
 * `Account.placeAllAccount` (common/models/account.js:148-152) inserted on the
 * order bus AND placed Zerodha orders in the same call, so one strategy decision
 * could fill on two brokers. Making this adapter incapable of placing an order
 * removes that failure mode by construction rather than by discipline.
 *
 * Tick and candle plumbing lives in apps/marketdata, which owns the single
 * websocket. This adapter exists so Zerodha has a typed place in the
 * BrokerAdapter model and its incapability is explicit and tested.
 */
import type { OrderIntent } from '@algomaker/order-bus'
import { CapabilityError, type BrokerAdapter, type BrokerCapabilities, type PlacedOrder } from './types.ts'

export class ZerodhaDataAdapter implements BrokerAdapter {
  readonly name = 'zerodha-data'
  readonly capabilities: BrokerCapabilities = { orders: false, marketData: true, modify: false }

  async placeOrder(_intent: OrderIntent): Promise<PlacedOrder> {
    throw new CapabilityError('zerodha-data is market-data only: order placement goes through XTS (spec D1)')
  }

  async modifyOrder(_brokerOrderId: string, _price: number): Promise<boolean> {
    throw new CapabilityError('zerodha-data cannot modify orders')
  }

  async cancelOrder(_brokerOrderId: string): Promise<boolean> {
    throw new CapabilityError('zerodha-data cannot cancel orders')
  }

  onFill(_handler: (order: PlacedOrder) => void): () => void {
    return () => {}
  }
}
```

- [ ] **Step 4: Export and run**

Append `export * from './zerodha-data.ts'` to `packages/brokers/src/index.ts`.

Run: `node --test packages/brokers/test/zerodha-data.test.ts`
Expected: **5 passed, 0 failed.**

- [ ] **Step 5: Full suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: all pass; 0 type errors.

- [ ] **Step 6: Commit**

```bash
git add packages/brokers
git commit -m "feat(brokers): zerodha-data adapter, orders structurally impossible

capabilities.orders = false and every order method throws CapabilityError.
This is the dual-rail fix expressed in types: the legacy
Account.placeAllAccount inserted on the bus AND placed Zerodha orders in one
call, so a single decision could fill on two brokers."
```

---

## Phase B exit criteria

- [ ] `npm test` passes; count **≥ 294** (267 after Phase A, plus 5 + 5 + 8 + 9 + 5 here)
- [ ] `npm run typecheck` reports **0** errors
- [ ] Two processes exchange a message over `ws` on an ephemeral port (Task 1 tests)
- [ ] A stale feed blocks entries while exits still succeed (Task 2 tests)
- [ ] `reconcile()` detects an orphan broker order — the cutover-rollback hazard (Task 3 tests)
- [ ] The simulator fills a resting SL_MARKET on a crossing tick — **a test the current system cannot pass** (Task 4 tests)
- [ ] `ZerodhaDataAdapter.placeOrder()` throws (Task 5 tests)

## Deliberately NOT in Phase B

- **The XTS live adapter.** It needs credentials and recorded payloads to test honestly, and spec §0.6 item 7 (whether XTS `modify` atomically covers `SL_LIMIT`) is unresolved. Building it against guessed semantics would produce a confidently wrong adapter. It is the first task of Phase D, alongside credentials.
- The `order-gateway` process that composes these pieces — it needs the XTS adapter.
- Strategy ports (Phase C), the model trim, the dashboard.
