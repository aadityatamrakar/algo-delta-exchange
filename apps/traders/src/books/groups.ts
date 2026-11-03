/**
 * Named groups inside one book (spec item 27): a trader tags some of a stock's
 * open legs as "Oct straddle", "hedge", ... and reads each group's own totals
 * and payoff. A group is a set of leg keys; a leg is in at most one group, and
 * untagged legs are the book's "ungrouped" remainder. Groups only label legs:
 * they never change what a leg is.
 *
 * `traders-groups { trader, stock, groups, updatedAt }`, unique on
 * `{ trader: 1, stock: 1 }`. A stored key that is no longer open is dropped on
 * read (the stored list keeps it until the next save).
 */

import type { TradersDb } from '../db.ts'
import type { GroupsView, GroupView, LegGroup } from '../analytics/r3-wire.ts'
import { isObject } from '../routes/kit.ts'
import type { BookView, LegView } from '../types.ts'

export type { GroupsView, GroupView, LegGroup }

export const MAX_GROUPS = 20
export const MAX_GROUP_NAME = 40

export function validateGroups(
  raw: unknown,
  legKeys: ReadonlySet<string>,
): { ok: true; groups: LegGroup[] } | { ok: false; error: string } {
  if (!Array.isArray(raw)) return { ok: false, error: 'groups must be an array' }
  if (raw.length > MAX_GROUPS) return { ok: false, error: `at most ${MAX_GROUPS} groups` }
  const groups: LegGroup[] = []
  const names = new Set<string>()
  const owner = new Map<string, string>()
  const unknown: string[] = []
  for (const g of raw as unknown[]) {
    if (!isObject(g) || typeof g['name'] !== 'string' || g['name'].trim() === '') return { ok: false, error: 'a group needs a name' }
    const name = g['name'].trim()
    if (name.length > MAX_GROUP_NAME) return { ok: false, error: `a group name is at most ${MAX_GROUP_NAME} characters` }
    if (name.toLowerCase() === 'ungrouped') return { ok: false, error: '"ungrouped" is reserved' }
    if (names.has(name.toLowerCase())) return { ok: false, error: `two groups are named "${name}"` }
    names.add(name.toLowerCase())
    const keys = g['keys']
    if (!Array.isArray(keys) || keys.some((k) => typeof k !== 'string')) return { ok: false, error: `the keys of "${name}" must be an array of leg keys` }
    const own = new Set<string>()
    for (const k of keys as string[]) {
      if (!legKeys.has(k)) { if (!unknown.includes(k)) unknown.push(k); continue }
      if (owner.has(k) && owner.get(k) !== name) return { ok: false, error: `leg ${k} is in two groups` }
      owner.set(k, name)
      own.add(k)
    }
    groups.push({ name, keys: [...own] })
  }
  if (unknown.length > 0) return { ok: false, error: `unknown leg keys: ${unknown.join(', ')}` }
  return { ok: true, groups }
}

/** Position greeks and MTM summed; an unpriced leg adds nothing to MTM. */
export function groupTotals(legs: readonly LegView[]): BookView['totals'] {
  let delta = 0, gamma = 0, vega = 0, theta = 0, mtm = 0
  for (const l of legs) {
    delta += l.delta; gamma += l.gamma; vega += l.vega; theta += l.theta
    mtm += l.mtm ?? 0
  }
  return { delta, gamma, vega, theta, mtm }
}

interface GroupDoc { trader: string; stock: string; groups: LegGroup[]; updatedAt: number }

export class GroupStore {
  readonly #db: TradersDb
  readonly #now: () => number

  constructor(db: TradersDb, now: () => number) {
    this.#db = db
    this.#now = now
  }

  async ensureIndexes(): Promise<void> {
    await this.#col().createIndex({ trader: 1, stock: 1 }, { unique: true })
  }

  async get(trader: string, stock: string): Promise<LegGroup[]> {
    const doc = await this.#col().findOne({ trader, stock }, { projection: { _id: 0 } })
    return doc === null ? [] : doc.groups
  }

  async set(trader: string, stock: string, groups: readonly LegGroup[]): Promise<void> {
    await this.#col().updateOne(
      { trader, stock },
      { $set: { trader, stock, groups: groups.map((g) => ({ name: g.name, keys: [...g.keys] })), updatedAt: this.#now() } },
      { upsert: true },
    )
  }

  #col() {
    return this.#db.collection<GroupDoc>('traders-groups')
  }
}
