/**
 * THE OPERATOR'S INTENT, CONVERGED — `desired` in the registry becomes a book
 * this process is steering, or one it has let go.
 *
 * `desk-books-registry` holds two fields that look alike and are not:
 * `desired` is what the operator asked for and `actual` is what a supervisor
 * last reported of itself (`books-registry.ts`). The gap between them is the
 * interesting state — "asked to run, not running" is exactly what an operator
 * needs to see on the page — and this file is the thing that closes it: it reads
 * `desired` every 5 s, builds or drops a book's runtime to match, and reports
 * `actual` back so the page can say the ask landed.
 *
 * ── STOPPING A BOOK CLOSES NOTHING ──────────────────────────────────────────
 * A row switched off stops being STEERED. Its legs stay exactly where they are,
 * its supervisor state stays in Mongo, and switching it back on resumes. That is
 * the same property `main.ts`'s SIGTERM has and it is the same reason: this desk
 * has been bitten by an unattended process flattening a real book (the runner's
 * `max_memory_restart` square-off, 2026-08-17), and "stop" must never be a way
 * to place an order nobody asked for. Closing a book is `POST .../close-all`,
 * which is a different button with a different confirmation.
 *
 * ── THE POLL IS THE GUARANTEE; THE NUDGE IS ONLY THE LATENCY ────────────────
 * desk-api best-effort POSTs `:8893/nudge` on every dial write and desired-state
 * change (`engine-notify.ts`), and that call is allowed to fail — a supervisor
 * that is down must not be able to fail an operator's dial change. So this poll
 * is what makes a change land at all, and the nudge only decides whether it
 * lands in a second or in five (spec §7).
 *
 * ── UNKNOWN DIAL KEYS ARE LOUD, AND THE BOOK STILL RUNS ─────────────────────
 * `resolveDials` starts from `DEFAULT_DIALS` and reports every key it did not
 * recognise (a typo, a Python dial that died in the port, a boolean written where
 * a number belongs). Refusing to run the book would turn one bad key into a
 * silent stand-down; running it while saying nothing is F-29 — a knob the
 * operator believes is in force and is not. So the book runs on the dials that
 * resolved and the refusal is logged at ERROR, once per distinct set, because
 * this is read every five seconds forever.
 */

import { resolveDials, type Dials, type Mode } from '@algomaker/desk-engine'
import { bookFromDoc, marksVenueOf, type MarksVenue } from '../../api/src/books-registry.ts'
import { isOn, strategyFromDoc } from '../../api/src/strategies.ts'
import type { HostLog } from './engine-host.ts'
import { Throttle } from './throttle.ts'

/** `${tag}:${mode}` — one tag in paper and in live is two books (§4). */
export function bookKey(tag: string, mode: Mode): string {
  return `${tag}:${mode}`
}

/** One registry row, resolved into what the supervisor needs to steer it. */
export interface ManagedBook {
  readonly key: string
  readonly tag: string
  readonly mode: Mode
  readonly symbol: string
  readonly expiry: string
  readonly dials: Dials
  /** Keys `resolveDials` refused. The book still runs; see the header. */
  readonly unknownDials: ReadonlyArray<string>
  /**
   * THE STRATEGY SWITCH — `desk-strategies.modes[mode].enabled` for this tag,
   * read through desk-api's own `strategyFromDoc`/`isOn` so the host can never
   * disagree with the gate about a row. `null` = UNKNOWN: no row, or the
   * collection could not be read this pass. Unknown is NOT off (see
   * `EngineHostDeps.switchedOn`): the host decides and the api's refusal stays
   * the guard, because a blip on one collection must not stand every book down.
   */
  readonly enabled: boolean | null
  /**
   * WHOSE PRICES MARK THIS BOOK (`marksVenueOf`): `demo` for a paper book on
   * Delta's testnet rail — the rail the gateway last used, else the setting —
   * and `prod` for everything else. Re-read every pass, so a book's venue
   * follows its row. `main.ts` reads it only on a non-NSE venue.
   */
  readonly marks: MarksVenue
}

/** The narrow Mongo surface: one query shape. */
export interface RegistryCollection {
  find(filter: Record<string, unknown>): { toArray(): Promise<Record<string, unknown>[]> }
}

/**
 * Every row the operator has asked to run, defensively read.
 *
 * A row that cannot be read at all is DROPPED (`bookFromDoc` answers null), and
 * dropped means not steered — the same direction `strategyFromDoc` takes, and the
 * only safe one: a half-written row is not a permission to trade.
 *
 * `strategyDocs` are the matching `desk-strategies` rows, when the caller could
 * read them; `undefined` (not wired, or unreadable this pass) leaves every
 * book's switch UNKNOWN rather than off. A row that is present but unreadable
 * (`strategyFromDoc` → null) is unknown too, for the same reason a half-written
 * registry row is dropped: nothing is inferred from a document nobody finished.
 */
export function desiredBooks(
  docs: ReadonlyArray<Record<string, unknown>>,
  strategyDocs?: ReadonlyArray<Record<string, unknown>>,
): ManagedBook[] {
  const switches = new Map<string, NonNullable<ReturnType<typeof strategyFromDoc>>>()
  for (const doc of strategyDocs ?? []) {
    const row = strategyFromDoc(doc)
    if (row !== null) switches.set(row.tag, row)
  }
  const out: ManagedBook[] = []
  for (const doc of docs) {
    const row = bookFromDoc(doc)
    if (row === null) continue
    if (row.desired !== 'running') continue
    const { dials, unknown } = resolveDials(row.dials)
    const strategy = switches.get(row.tag)
    out.push({
      key: bookKey(row.tag, row.mode),
      tag: row.tag,
      mode: row.mode,
      symbol: row.symbol,
      expiry: row.expiry,
      dials,
      unknownDials: unknown,
      enabled: strategy === undefined ? null : isOn(strategy.modes, row.mode),
      marks: marksVenueOf(row),
    })
  }
  return out
}

export interface RegistryPollDeps {
  readonly collection: RegistryCollection
  /**
   * `desk-strategies`, for the switch each book's host reads (`ManagedBook.
   * enabled`). Optional: absent, every switch is unknown and the host decides
   * as it always did — the shape every pre-existing construction has.
   */
  readonly strategies?: RegistryCollection
  readonly log: HostLog
  /** The clock the once-a-minute lines are throttled on. Default `Date.now`. */
  now?(): number
  /** Keys this process is currently steering. */
  running(): ReadonlySet<string>
  /** Take up a book. Throwing leaves it unstarted; the next pass retries. */
  start(book: ManagedBook): Promise<void>
  /** Let a book go. NO ORDERS — see the header. */
  stop(key: string): Promise<void>
  /** Every pass, for a book that stays: this is where a retune lands. */
  retune(book: ManagedBook): void
  /** Report `actual` back to desk-api. Best effort; it logs its own failures. */
  report(book: ManagedBook): Promise<void>
}

export class RegistryPoll {
  readonly #d: RegistryPollDeps
  /** The unknown-key sets already complained about, by book key. */
  readonly #complained = new Map<string, string>()
  /**
   * "The strategy rows could not be read" once a minute. A collection that
   * stays unreadable is one condition, not one per 5 s pass — and it is a WARN,
   * not an ERROR, because nothing changes for the books: their switch reads
   * unknown and they keep deciding.
   */
  readonly #strategiesWarn = new Throttle()
  /**
   * "Could NOT be started" once a minute PER KEY, with the count. A row whose
   * chain the master no longer lists (the 09-18 sync pruned the SENSEX 09-17
   * chain under two `desired: running` rows) fails `start` on every 5 s pass
   * for as long as it stays in the registry — one condition, not 700 alarms
   * an hour. Forgotten on a successful start and when the row is dropped from
   * the registry (the prune at the end of `#pass`, NOT the stop loop — a key
   * that never started is never in `running()`), so a NEW failure later is
   * reported at once rather than folded into a window that belonged to the old
   * one.
   */
  readonly #startFailed = new Map<string, Throttle>()
  /** The pass in flight, if any. See `run`. */
  #inFlight: Promise<void> | null = null

  constructor(deps: RegistryPollDeps) {
    this.#d = deps
  }

  #now(): number {
    return this.#d.now?.() ?? Date.now()
  }

  /**
   * One pass at a time, and a caller that arrives mid-pass JOINS it.
   *
   * Two drivers reach this: the 5-second timer and desk-api's nudge, and they
   * overlap the moment an operator hits Start while a slow pass is reading. Both
   * would read `running()` before either had built anything and both would call
   * `start` for the same book — two `EngineHost`s for one (tag, mode), each with
   * its own damping clock and its own idea of what is in flight. Joining is
   * better than dropping: the nudge's whole purpose is that the change lands
   * NOW, and the pass it joins is reading the same document it would have.
   */
  async run(): Promise<void> {
    this.#inFlight ??= this.#pass().finally(() => {
      this.#inFlight = null
    })
    await this.#inFlight
  }

  /**
   * One convergence pass. Never throws: a Mongo blip must not take the poll
   * timer down with it, and the next pass is five seconds away.
   *
   * ORDER MATTERS. Drops happen FIRST, so a book switched off stops being
   * evaluated before anything else in the pass can spend time; then the starts,
   * then the retunes, then the heartbeat. A start that throws is logged and the
   * book is simply not running when `running()` is asked again.
   */
  async #pass(): Promise<void> {
    let docs: Record<string, unknown>[]
    try {
      docs = await this.#d.collection.find({}).toArray()
    } catch (err) {
      this.#d.log.error('the book registry could not be read — the desired state is UNKNOWN', {
        error: err instanceof Error ? err.message : String(err),
      })
      return
    }

    const wanted = desiredBooks(docs, await this.#strategiesFor(desiredBooks(docs)))
    const wantedKeys = new Set(wanted.map((b) => b.key))

    for (const key of this.#d.running()) {
      if (wantedKeys.has(key)) continue
      try {
        await this.#d.stop(key)
        this.#d.log.info('book stopped — it is no longer steered; its legs are untouched', { key })
      } catch (err) {
        this.#d.log.error('a book could not be stopped — it is STILL BEING STEERED', {
          key,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    for (const book of wanted) {
      this.#complain(book)
      const held = this.#d.running().has(book.key)
      if (!held) {
        try {
          await this.#d.start(book)
          this.#startFailed.delete(book.key)
          this.#d.log.info('book started', {
            key: book.key,
            symbol: book.symbol,
            expiry: book.expiry,
          })
        } catch (err) {
          let throttle = this.#startFailed.get(book.key)
          if (throttle === undefined) {
            throttle = new Throttle()
            this.#startFailed.set(book.key, throttle)
          }
          const suppressed = throttle.claim(this.#now())
          if (suppressed !== null) {
            this.#d.log.error('a book the operator asked for could NOT be started', {
              key: book.key,
              error: err instanceof Error ? err.message : String(err),
              suppressed,
            })
          }
          continue
        }
      } else {
        this.#d.retune(book)
      }
      await this.#d.report(book)
    }

    // A key the registry no longer lists is done with, and its per-key memory
    // goes with it — whether or not it ever ran. The stop loop above cannot be
    // the place for this: the row that matters most here, one whose start
    // FAILS on every pass, is never in `running()`, so its retire is invisible
    // there and its throttle would outlive it, to be inherited by a re-add of
    // the same key inside the old window (its first ERROR swallowed, two
    // incidents folded into one count).
    for (const key of this.#startFailed.keys()) {
      if (!wantedKeys.has(key)) this.#startFailed.delete(key)
    }
    for (const key of this.#complained.keys()) {
      if (!wantedKeys.has(key)) this.#complained.delete(key)
    }
  }

  /**
   * The `desk-strategies` rows for the wanted tags, read AFTER the registry so
   * one pass sees both. `undefined` when the collection is not wired or could
   * not be read: unknown, never off — a blip on this collection must not stand
   * every book on the desk down, which is the same principle the registry read
   * above applies to itself ("the desired state is UNKNOWN", and every book is
   * left as it was).
   */
  async #strategiesFor(
    wanted: ReadonlyArray<ManagedBook>,
  ): Promise<Record<string, unknown>[] | undefined> {
    const strategies = this.#d.strategies
    if (strategies === undefined || wanted.length === 0) return undefined
    const tags = [...new Set(wanted.map((b) => b.tag))]
    try {
      return await strategies.find({ tag: { $in: tags } }).toArray()
    } catch (err) {
      const suppressed = this.#strategiesWarn.claim(this.#now())
      if (suppressed !== null) {
        this.#d.log.warn(
          'the strategy rows could not be read — switch state UNKNOWN, books keep deciding',
          { error: err instanceof Error ? err.message : String(err), suppressed },
        )
      }
      return undefined
    }
  }

  /** One ERROR per distinct set of unknown keys per book. See the header. */
  #complain(book: ManagedBook): void {
    const set = [...book.unknownDials].sort().join(',')
    if (this.#complained.get(book.key) === set) return
    this.#complained.set(book.key, set)
    if (set === '') return
    this.#d.log.error(
      `${book.key}: ${String(book.unknownDials.length)} dial(s) on this book are NOT read by ` +
        'the engine — the book runs on the ones that resolved, and these do nothing',
      { key: book.key, unknown: book.unknownDials },
    )
  }
}
