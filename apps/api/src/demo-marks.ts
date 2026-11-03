/**
 * Which feed marks a book, answered synchronously.
 *
 * Demo-rail paper books are filled on Delta's TESTNET, and the demo account
 * is marked at testnet prices — so the desk marks them off `md.tick.demo`
 * (`demoMarks`, a second `QuoteCache`), and everything else off `md.tick`.
 * The rule is `marksVenueOf` (books-registry.ts).
 *
 * The tick path (`LiveBook.onTick`) cannot read Mongo, so the registry's
 * answer is held here and refreshed on a timer and after a rail change. A tag
 * this index has never seen is marked at production: that is every book's
 * marking before this feature, and a sim or live book can never be priced
 * off the testnet by a missing row.
 */

import { marksVenueOf, type MarksVenue, type PaperRail } from './books-registry.ts'

export interface RailRow {
  readonly tag: string
  readonly mode: string
  readonly dx_paper_rail: PaperRail
  readonly dx_rail_used: PaperRail | null
}

export class RailIndex {
  #venue = new Map<string, MarksVenue>()

  set(rows: readonly RailRow[]): void {
    const next = new Map<string, MarksVenue>()
    for (const r of rows) next.set(`${r.tag}|${r.mode}`, marksVenueOf(r))
    this.#venue = next
  }

  venueOf(tag: string, mode: string): MarksVenue {
    return this.#venue.get(`${tag}|${mode}`) ?? 'prod'
  }

  /** Demo-marked tags, for logging. */
  get demoCount(): number {
    let n = 0
    for (const v of this.#venue.values()) if (v === 'demo') n++
    return n
  }
}

/** What the wire calls each source. */
export type MarksSource = 'delta' | 'delta-demo'

export function marksSourceOf(v: MarksVenue): MarksSource {
  return v === 'demo' ? 'delta-demo' : 'delta'
}
