/**
 * Where a hosted strategy's `runtime` state is published (API contract §6).
 *
 * IT GOES IN A SIBLING COLLECTION, NOT ON THE REGISTRY ROW. The row is the
 * OPERATOR's document — `enabled`, `mode`, `liveLots` — and the portal's PATCH
 * writes it with a read-modify-write (`store.patchStrategy`). A runner
 * heartbeating `state: 'running'` onto the same document every second would
 * eventually land between that read and that write and clobber a switch the
 * operator had just flipped. `touchStrategy` exists as a separate writer for
 * exactly this reason ("a heartbeat never touches a switch"); this is the same
 * rule applied to a much chattier writer.
 *
 * So: the runner owns `desk-strategy-runtime`, the API owns `desk-strategies`,
 * and `GET /v1/desk/strategies` joins them on `tag`. The join is one-sided —
 * `runtime` is attached only to `kind: 'hosted'` rows, because we do not
 * supervise Python processes and must not render a state we cannot observe.
 */

import type { RuntimeSnapshot } from './runner.ts'

export const RUNTIME_COLLECTION = 'desk-strategy-runtime'

export interface RuntimeCollection {
  updateOne(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options?: { upsert?: boolean },
  ): Promise<unknown>
  createIndex(
    spec: Record<string, 1 | -1>,
    options?: { unique?: boolean; name?: string },
  ): Promise<unknown>
  /** Optional so a test fake need not model it; production must have it. */
  deleteMany?(filter: Record<string, unknown>): Promise<unknown>
  /**
   * Optional so a test fake need not model it. Production must have it — see
   * `ensureRuntimeIndexes`, where dropping the old single-field unique index is
   * the difference between publishing two instances and silently publishing
   * only one of them.
   */
  dropIndex?(name: string): Promise<unknown>
}

/** The identity of one supervised INSTANCE: a tag on one rail. */
export function runtimeKey(tag: string, mode: 'paper' | 'live'): string {
  return `${tag}:${mode}`
}

/**
 * One document per TAG AND MODE, upserted.
 *
 * Keyed by both because a row switched on for paper and live is supervised
 * TWICE, with two independent states and two independent position counts.
 * Under the old `{ tag }` filter the two instances would upsert over each
 * other every second, so the portal would show whichever published last —
 * "squared-off, 0 open" borrowed from the paper instance while the live one is
 * `failed` holding a leg is precisely the report the square-off backstop exists
 * to make impossible.
 *
 * Upsert rather than insert-and-append: this is a CURRENT STATE, and keeping a
 * history of every second's snapshot would be a large collection nobody reads.
 * The order journal already holds the events worth keeping.
 */
/**
 * Which host owns a runtime document.
 *
 * Needed because BOTH hosts write to this one collection and each must clear
 * only its own leftovers. Without it, `Runner` publishing its set would delete
 * every mirror's row a second before `MirrorHost` rewrote it, and the portal
 * would flicker between "not supervised" and a state.
 */
export type RuntimeHost = 'runner' | 'mirror'

/**
 * Publish the CURRENT set, and remove anything this host no longer supervises.
 *
 * THE DELETE IS THE POINT. Upserting alone left a document at its last value
 * forever: switching a strategy off removes it from the supervised map, so it
 * simply stops being published — and the portal kept showing `running` for a
 * strategy whose switch was off, which is the most misleading thing this field
 * can say. It is the word an operator trusts before deciding whether to touch
 * something.
 *
 * Scoped by `host`, so one host's sweep cannot delete the other's rows. Legacy
 * documents from before the per-mode split carry neither `host` nor `mode` and
 * are swept by the same pass — the API already ignores them, but leaving them
 * there means the next person to read this collection sees eighteen rows that
 * describe nothing.
 */
export function runtimePublisher(
  collection: RuntimeCollection,
  host: RuntimeHost,
): (snapshots: readonly RuntimeSnapshot[]) => Promise<void> {
  return async (snapshots) => {
    const live: string[] = []
    for (const s of snapshots) {
      live.push(runtimeKey(s.tag, s.mode))
      await collection.updateOne(
        { tag: s.tag, mode: s.mode },
        { $set: { ...s, host, key: runtimeKey(s.tag, s.mode) } },
        { upsert: true },
      )
    }
    // Everything this host wrote that is no longer supervised, plus the
    // host-less legacy rows. `key` is written above purely so this filter can
    // be a single round trip rather than one delete per departed instance.
    await collection.deleteMany?.({
      $or: [{ host, key: { $nin: live } }, { host: { $exists: false } }],
    })
  }
}

/**
 * The unique index moves from `{tag}` to `{tag, mode}`.
 *
 * THE OLD ONE MUST BE DROPPED, not merely superseded. A collection that still
 * carries `tag_1 unique` accepts the paper instance's document and then rejects
 * the live one on every publish — the runner would log a warning per second and
 * the live instance would never appear in the portal at all, which is the one
 * state an operator most needs to see. The drop is swallowed because it is
 * absent on a fresh database, where there is nothing to drop.
 */
export async function ensureRuntimeIndexes(collection: RuntimeCollection): Promise<void> {
  try {
    await collection.dropIndex?.('tag_1')
  } catch {
    // Fresh database, or already dropped. Deliberately not fatal: failing boot
    // over a missing legacy index would stop the runner from running at all.
  }
  await collection.createIndex({ tag: 1, mode: 1 }, { unique: true })
}

/**
 * How old a runtime document may be before what it says is no longer evidence.
 *
 * `runtimePublisher` rewrites every supervised instance about once a second, so
 * 90s is roughly ninety missed writes — the runner is gone, wedged, or its
 * publish has been failing for a minute and a half. Deliberately the same number
 * as `BROKER_SNAPSHOT_STALE_MS` in the desk route: two different "is the thing
 * that writes this still alive?" questions answered on two different clocks is a
 * distinction no operator would be able to hold.
 */
export const RUNTIME_STALE_MS = 90_000

/**
 * The shape `GET /v1/desk/strategies` should attach.
 *
 * Declared here so the desk route and the runner cannot drift: contract §6 says
 * `runtime` is absent for `external` rows, and `updatedAt` is deliberately NOT
 * part of it — the contract's four fields are what the page renders, and a
 * timestamp that changes every second would make every poll look like a change.
 *
 * `stale` IS THE ONE THING THE TIMESTAMP WAS NEEDED FOR, kept without the churn.
 * Dropping `updatedAt` outright also dropped every means of telling a runner
 * that is publishing `running` right now from one that died in March and left
 * the word behind — and `running` is the badge an operator reads before deciding
 * a strategy needs no attention. A boolean derived server-side answers that and
 * changes at most twice in a document's life, so the poll stays quiet.
 */
export interface RuntimeView {
  readonly state: RuntimeSnapshot['state']
  readonly startedAt: number | null
  readonly lastError: string | null
  readonly openPositions: number
  /** Nothing has rewritten this document for `RUNTIME_STALE_MS`. */
  readonly stale: boolean
}

/**
 * `nowMs` is passed in rather than read from `Date.now()` so the freshness call
 * is testable and so a caller converting a whole collection judges every
 * document against ONE instant — a per-document clock read can put two rows of
 * the same listing either side of the threshold.
 */
export function toRuntimeView(doc: Record<string, unknown> | null, nowMs: number): RuntimeView | null {
  if (doc === null) return null
  const state = doc['state']
  if (typeof state !== 'string') return null
  const updatedAt = doc['updatedAt']
  return {
    state: state as RuntimeSnapshot['state'],
    startedAt: typeof doc['startedAt'] === 'number' ? doc['startedAt'] : null,
    lastError: typeof doc['lastError'] === 'string' && doc['lastError'] !== '' ? doc['lastError'] : null,
    openPositions: typeof doc['openPositions'] === 'number' ? doc['openPositions'] : 0,
    // NO READABLE TIMESTAMP IS STALE. "We cannot show this is current" has to
    // land in the same place as "it is not current": the flag exists so that
    // `running` is believed only while something is actively saying it, and a
    // document that predates the field would otherwise be believed forever.
    stale: typeof updatedAt !== 'number' || nowMs - updatedAt > RUNTIME_STALE_MS,
  }
}
