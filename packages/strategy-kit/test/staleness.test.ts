import test from 'node:test'
import assert from 'node:assert/strict'
import { StrategyBase, makeTestContext, type DataNeed, type JobSpec, type Quote, type StrategyContext } from '../src/index.ts'

const INST = { tradingsymbol: 'X', instrumentToken: 1, lotSize: 25, tickSize: 0.05, exchange: 'NFO' }

class Simple extends StrategyBase {
  entries = 0
  exits = 0
  constructor(ctx: StrategyContext) { super(ctx) }
  dataNeeds(): readonly DataNeed[] { return [{ kind: 'index', underlying: 'NIFTY' }] }
  jobs(): readonly JobSpec[] { return [] }
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
