import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { open, type FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Wal, unresolvedIntents, type OrderIntent, type WalRecord } from '../src/index.ts'

const tmp = () => mkdtempSync(join(tmpdir(), 'wal-'))

const intent = (id: string): OrderIntent => ({
  clientOrderId: id,
  ts: 1_700_000_000_000,
  strategyTag: 'T',
  mode: 'sim',
  destinations: ['sim'],
  instrument: { tradingsymbol: 'X', lotSize: 35, tickSize: 0.05, exchange: 'NFO' },
  side: 'BUY',
  orderType: 'MARKET',
  quantity: 35,
  lots: 1,
})

test('append then replay round-trips records in order', async () => {
  const p = join(tmp(), 'orders.wal')
  const w = new Wal(p)
  await w.append({ kind: 'INTENT', ts: 1, intent: intent('a') })
  await w.append({ kind: 'SUBMITTED', ts: 2, clientOrderId: 'a', destination: 'sim', brokerOrderId: 'b1' })
  await w.close()

  const { records, truncatedTail, corrupt } = Wal.replay(p)
  assert.equal(records.length, 2)
  assert.equal(records[0]?.kind, 'INTENT')
  assert.equal(records[1]?.kind, 'SUBMITTED')
  assert.equal(truncatedTail, false)
  assert.deepEqual(corrupt, [])
})

test('replay of a missing or empty file is empty, not an error', () => {
  const d = tmp()
  assert.deepEqual(Wal.replay(join(d, 'nope.wal')).records, [])
  const p = join(d, 'empty.wal')
  writeFileSync(p, '')
  assert.deepEqual(Wal.replay(p).records, [])
})

test('concurrent appends do not interleave partial lines', async () => {
  const p = join(tmp(), 'concurrent.wal')
  const w = new Wal(p, { fsync: false })
  // Fire many appends without awaiting individually.
  await Promise.all(
    Array.from({ length: 50 }, (_, i) =>
      w.append({ kind: 'INTENT', ts: i, intent: intent(`id-${i}`) }),
    ),
  )
  await w.close()

  const { records, corrupt, truncatedTail } = Wal.replay(p)
  assert.equal(records.length, 50, 'every append must survive')
  assert.deepEqual(corrupt, [], 'no line may be corrupted by interleaving')
  assert.equal(truncatedTail, false)
  // Serialisation must also preserve submission order.
  const ids = records.map((r) => (r.kind === 'INTENT' ? r.intent.clientOrderId : ''))
  assert.deepEqual(ids, Array.from({ length: 50 }, (_, i) => `id-${i}`))
})

test('a torn trailing line is treated as a crash tail and discarded', () => {
  const p = join(tmp(), 'torn.wal')
  // Two good records, then a half-written third with no newline.
  const good =
    JSON.stringify({ kind: 'INTENT', ts: 1, intent: intent('a') }) +
    '\n' +
    JSON.stringify({ kind: 'INTENT', ts: 2, intent: intent('b') }) +
    '\n'
  writeFileSync(p, good + '{"kind":"INTENT","ts":3,"inte')

  const { records, truncatedTail, corrupt } = Wal.replay(p)
  assert.equal(records.length, 2, 'the two complete records survive')
  assert.equal(truncatedTail, true, 'the torn tail must be reported')
  assert.deepEqual(corrupt, [], 'a torn TAIL is expected, not corruption')
})

test('a malformed line in the MIDDLE is reported as corruption, not silently skipped', () => {
  const p = join(tmp(), 'corrupt.wal')
  writeFileSync(
    p,
    JSON.stringify({ kind: 'INTENT', ts: 1, intent: intent('a') }) +
      '\n' +
      'this is not json\n' +
      JSON.stringify({ kind: 'INTENT', ts: 3, intent: intent('c') }) +
      '\n',
  )
  const { records, truncatedTail, corrupt } = Wal.replay(p)
  assert.equal(records.length, 2)
  assert.equal(truncatedTail, false)
  assert.deepEqual(corrupt, [2], 'mid-file corruption must surface for a human')
})

test('appending to an existing journal preserves prior records', async () => {
  const p = join(tmp(), 'resume.wal')
  const w1 = new Wal(p, { fsync: false })
  await w1.append({ kind: 'INTENT', ts: 1, intent: intent('first') })
  await w1.close()

  const w2 = new Wal(p, { fsync: false })
  await w2.append({ kind: 'INTENT', ts: 2, intent: intent('second') })
  await w2.close()

  const { records } = Wal.replay(p)
  assert.equal(records.length, 2, 'reopening must append, never truncate')
})

/**
 * Wrap a real handle and record the order of the calls that matter.
 *
 * The previous version of the fsync test read the file back and asserted the
 * record was there. That passes with `await fh.sync()` deleted — `readFileSync`
 * is served by the PAGE CACHE, which holds the bytes whether or not they ever
 * reached the disk. It could not fail, so it was not testing the durability
 * contract; it was testing that `write` had been called. The syscall is the only
 * observable that distinguishes them.
 */
async function spyOpen(path: string): Promise<{ handle: FileHandle; calls: string[] }> {
  const real = await open(path, 'a')
  const calls: string[] = []
  const handle = {
    write: async (...args: Parameters<FileHandle['write']>) => {
      calls.push('write')
      return await (real.write as (...a: unknown[]) => Promise<unknown>)(...args)
    },
    sync: async () => {
      calls.push('sync')
      return await real.sync()
    },
    close: async () => {
      calls.push('close')
      return await real.close()
    },
  } as unknown as FileHandle
  return { handle, calls }
}

test('append FSYNCS before it resolves — the durability contract', async () => {
  // "append(record) resolves only after the bytes are fsync'd to disk. Callers
  // MUST await it before submitting to a broker." An append that has not been
  // fsync'd is weaker than the remote write this journal replaced, on the one
  // axis it was replaced for.
  const p = join(tmp(), 'sync.wal')
  const spy = await spyOpen(p)
  const w = new Wal(p, { openFile: async () => spy.handle })

  await w.append({ kind: 'INTENT', ts: 1, intent: intent('durable') })
  assert.deepEqual(spy.calls, ['write', 'sync'], 'the fsync must have happened by the time it resolves')

  await w.append({ kind: 'INTENT', ts: 2, intent: intent('durable-2') })
  assert.deepEqual(spy.calls, ['write', 'sync', 'write', 'sync'], 'EVERY append, not just the first')

  await w.close()
  assert.match(readFileSync(p, 'utf8'), /durable/)
})

test('fsync:false skips the syscall — and it must be a deliberate choice', async () => {
  // The counterpart: if the spy recorded a sync here the option would be a lie,
  // and the assertion above would pass for the wrong reason.
  const p = join(tmp(), 'nosync.wal')
  const spy = await spyOpen(p)
  const w = new Wal(p, { fsync: false, openFile: async () => spy.handle })
  await w.append({ kind: 'INTENT', ts: 1, intent: intent('fast') })
  assert.deepEqual(spy.calls, ['write'])
  await w.close()
})

// --- recovery ---------------------------------------------------------------

test('unresolvedIntents finds journalled orders with no terminal status', () => {
  const recs: WalRecord[] = [
    { kind: 'INTENT', ts: 1, intent: intent('filled') },
    { kind: 'INTENT', ts: 2, intent: intent('working') },
    { kind: 'INTENT', ts: 3, intent: intent('rejected-risk') },
    { kind: 'INTENT', ts: 4, intent: intent('cancelled') },
    { kind: 'STATUS', ts: 5, clientOrderId: 'filled', destination: 'sim', status: 'FILLED', filledQty: 35, avgFillPrice: 10 },
    { kind: 'STATUS', ts: 6, clientOrderId: 'working', destination: 'sim', status: 'WORKING', filledQty: 0, avgFillPrice: null },
    { kind: 'REJECTED_BY_RISK', ts: 7, intent: intent('rejected-risk'), code: 'KILL_SWITCH' },
    { kind: 'STATUS', ts: 8, clientOrderId: 'cancelled', destination: 'sim', status: 'CANCELLED', filledQty: 0, avgFillPrice: null },
  ]
  assert.deepEqual(
    unresolvedIntents(recs),
    ['working'],
    'only the order still in flight needs reconciliation',
  )
})

test('a PARTIALLY_FILLED order counts as unresolved', () => {
  const recs: WalRecord[] = [
    { kind: 'INTENT', ts: 1, intent: intent('partial') },
    { kind: 'STATUS', ts: 2, clientOrderId: 'partial', destination: 'xts', status: 'PARTIALLY_FILLED', filledQty: 10, avgFillPrice: 9 },
  ]
  assert.deepEqual(unresolvedIntents(recs), ['partial'])
})

test('an intent journalled with no status at all is unresolved (crash before submit)', () => {
  const recs: WalRecord[] = [{ kind: 'INTENT', ts: 1, intent: intent('orphan') }]
  assert.deepEqual(
    unresolvedIntents(recs),
    ['orphan'],
    'this is exactly the case the legacy system could not recover',
  )
})
