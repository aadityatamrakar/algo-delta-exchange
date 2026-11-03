/**
 * The in-memory Mongo stand-ins the gateway's suites share.
 *
 * NOT a `.test.ts`, so `node --test test/*.test.ts` skips it — the same trick
 * `chaser-harness.ts` uses.
 *
 * `FakeCollection` was written for `queue.test.ts` and is lifted here VERBATIM,
 * comments included, because the tranche-gating suite needs the one property it
 * models that a naive fake does not:
 *
 *   `findOneAndUpdate` is a single atomic server-side operation, while `find`
 *   and `updateOne` are two round trips with everything else in the world
 *   happening in between.
 *
 * That is what makes the claim race real, and it is what makes the tranche
 * CURSOR race real too (F-10): two fill watchers observing one terminal tranche
 * must not both advance it, and a fake that applied the update non-atomically
 * would report a green double-advance as a pass.
 *
 * Two operators were added for the tranche work and are used by nothing else
 * yet: `$unset` (the advance clears the interrupted-placement marker and the
 * chaser's per-slice state) and `$push`/`$each` (a later tranche APPENDS its
 * broker ids rather than replacing the ones already filled).
 */

import type { QueueCollection } from '../src/queue.ts'
import type { FillsCollection } from '../src/fills.ts'
import type { JournalCollection } from '../src/journal.ts'

/** One turn of the event loop — where a real driver would be on the wire. */
export const tick = (): Promise<void> => new Promise((r) => setImmediate(r))

export class FakeCollection implements QueueCollection {
  docs: Record<string, unknown>[] = []
  /** Every op, so a test can assert HOW the claim was performed, not just that it was. */
  readonly ops: string[] = []

  find(filter: Record<string, unknown>) {
    this.ops.push('find')
    const self = this
    let sortSpec: Record<string, 1 | -1> = {}
    const collect = async (n: number): Promise<Record<string, unknown>[]> => {
      // The network round trip a real find pays, and the window in which
      // another gateway can claim the document this one just read.
      await tick()
      const match = self.docs.filter((d) => matchesQuery(d, filter))
      return sortDocs(match, sortSpec).slice(0, n)
    }
    return {
      sort: (spec: Record<string, 1 | -1>) => {
        sortSpec = spec
        return { limit: (n: number) => ({ toArray: () => collect(n) }) }
      },
    }
  }

  async findOne(filter: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    this.ops.push('findOne')
    await tick()
    return this.docs.find((d) => matchesQuery(d, filter)) ?? null
  }

  /**
   * ATOMIC, as Mongo's is: the document is selected and updated with no
   * suspension point between the two. The `await tick()` is BEFORE the read, so
   * concurrent callers interleave around the operation but never inside it.
   */
  async findOneAndUpdate(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): Promise<{ value: Record<string, unknown> | null }> {
    this.ops.push('findOneAndUpdate')
    await tick()
    const sortSpec = (options?.['sort'] as Record<string, 1 | -1> | undefined) ?? {}
    const candidates = sortDocs(
      this.docs.filter((d) => matchesQuery(d, filter)),
      sortSpec,
    )
    const doc = candidates[0]
    if (doc === undefined) return { value: null }
    applyUpdate(doc, update)
    return { value: doc }
  }

  /**
   * Honours the OWNERSHIP FENCE and reports `matchedCount`, both as Mongo does.
   *
   * A fake that ignored `claimedBy` in the filter would let a zombie worker's
   * write land on the reclaimer's document and the suite would never notice —
   * which is exactly the production defect the fence exists to stop.
   */
  async updateOne(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
  ): Promise<{ matchedCount: number }> {
    this.ops.push('updateOne')
    await tick()
    const doc = this.docs.find((d) => matchesQuery(d, filter))
    if (doc === undefined) return { matchedCount: 0 }
    applyUpdate(doc, update)
    return { matchedCount: 1 }
  }

  async createIndex(): Promise<void> {}
}

/**
 * Every operator the gateway's writes actually use, applied as Mongo applies
 * them — in particular on ABSENT fields, which is where the real driver's
 * behaviour is least obvious and most depended on.
 */
function applyUpdate(doc: Record<string, unknown>, update: Record<string, unknown>): void {
  Object.assign(doc, (update['$set'] as Record<string, unknown>) ?? {})
  // `$inc` on an ABSENT field starts from 0, as Mongo's does — the attempt
  // counter is only ever read off a document that has never carried it.
  for (const [k, v] of Object.entries((update['$inc'] as Record<string, number>) ?? {})) {
    doc[k] = Number(doc[k] ?? 0) + v
  }
  // `$pull`/`$addToSet` on an ABSENT array, again as Mongo does: pulling from
  // nothing is a no-op and adding creates the array. `resolveAmbiguous` moves
  // one id between two arrays with exactly these, and a fake that only knew
  // `$set` would report a green move that never happened.
  for (const [k, v] of Object.entries((update['$pull'] as Record<string, unknown>) ?? {})) {
    doc[k] = (Array.isArray(doc[k]) ? (doc[k] as unknown[]) : []).filter((x) => x !== v)
  }
  for (const [k, v] of Object.entries((update['$addToSet'] as Record<string, unknown>) ?? {})) {
    const arr = Array.isArray(doc[k]) ? (doc[k] as unknown[]) : []
    doc[k] = arr.includes(v) ? arr : [...arr, v]
  }
  // `$push` with `$each`, which is how a later tranche appends its ids. Mongo
  // creates the array when it is absent; so does this.
  for (const [k, v] of Object.entries((update['$push'] as Record<string, unknown>) ?? {})) {
    const arr = Array.isArray(doc[k]) ? (doc[k] as unknown[]) : []
    const each =
      v !== null && typeof v === 'object' && '$each' in (v as object)
        ? ((v as { $each: unknown[] }).$each ?? [])
        : [v]
    doc[k] = [...arr, ...each]
  }
  // `$unset` REMOVES the key. Writing `undefined` instead would leave
  // `'placementStartedAt' in doc` true, and the placer routes on exactly that.
  for (const k of Object.keys((update['$unset'] as Record<string, unknown>) ?? {})) {
    delete doc[k]
  }
}

export function matchesQuery(doc: Record<string, unknown>, filter: Record<string, unknown>): boolean {
  const or = filter['$or'] as Record<string, unknown>[] | undefined
  if (or !== undefined) return or.some((f) => matches(doc, f))
  return matches(doc, filter)
}

function matches(doc: Record<string, unknown>, filter: Record<string, unknown>): boolean {
  return Object.entries(filter).every(([k, v]) => {
    if (k === '$or') {
      return (v as Record<string, unknown>[]).some((f) => matches(doc, f))
    }
    if (v !== null && typeof v === 'object' && '$lt' in (v as object)) {
      return Number(doc[k] ?? Number.POSITIVE_INFINITY) < Number((v as { $lt: number }).$lt)
    }
    if (v !== null && typeof v === 'object' && '$in' in (v as object)) {
      return ((v as { $in: unknown[] }).$in ?? []).includes(doc[k])
    }
    // Equality against an ARRAY field is containment, as Mongo reads a
    // multikey index: `{ brokerOrderIds: '987' }` matches a document whose
    // array holds '987'. `getByBrokerOrderId` is that query.
    if (Array.isArray(doc[k])) return (doc[k] as unknown[]).includes(v)
    return doc[k] === v
  })
}

export function sortDocs(
  docs: Record<string, unknown>[],
  spec: Record<string, 1 | -1>,
): Record<string, unknown>[] {
  const entries = Object.entries(spec)
  if (entries.length === 0) return docs
  return [...docs].sort((a, b) => {
    for (const [key, dir] of entries) {
      const av = Number(a[key] ?? 0)
      const bv = Number(b[key] ?? 0)
      if (av !== bv) return (av - bv) * dir
    }
    return 0
  })
}

/** `desk-fills`, with the `$or`/`$in` the watcher's own query uses. */
export class FakeFills implements FillsCollection {
  rows: Record<string, unknown>[] = []
  async insertOne(doc: Record<string, unknown>): Promise<void> {
    await tick()
    this.rows.push(doc)
  }
  find(filter: Record<string, unknown>) {
    const self = this
    return {
      toArray: async (): Promise<Record<string, unknown>[]> => {
        await tick()
        return self.rows.filter((d) => matchesQuery(d, filter))
      },
    }
  }
  async createIndex(): Promise<void> {}
}

/** `desk-order-events`. `history()` is what the recovery path reads. */
export class FakeJournal implements JournalCollection {
  rows: Record<string, unknown>[] = []
  async insertOne(doc: Record<string, unknown>): Promise<void> {
    this.rows.push(doc)
  }
  find(filter: Record<string, unknown>) {
    const self = this
    let sortSpec: Record<string, 1 | -1> = {}
    return {
      sort: (spec: Record<string, 1 | -1>) => {
        sortSpec = spec
        return {
          limit: (n: number) => ({
            toArray: async (): Promise<Record<string, unknown>[]> => {
              await tick()
              return sortDocs(
                self.rows.filter((d) => matchesQuery(d, filter)),
                sortSpec,
              ).slice(0, n)
            },
          }),
        }
      },
    }
  }
  async createIndex(): Promise<void> {}
}
