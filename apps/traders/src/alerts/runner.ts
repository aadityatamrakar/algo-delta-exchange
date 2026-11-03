/**
 * The alert runner: once a minute it reads what the rules need (alerts/rules.ts), stores each draft (the store keeps
 * the first of each dedupe key) and pushes the new ones to their phones. Two hooks make it prompt where a hook is
 * cheap: the band board's event store is wrapped, so an "out" event is alerted on as it is written; and an applied
 * orders file runs that trader's rejections at once. Every pass and hook is queued, so none overlap.
 *
 * Reads, a pass: the users (one query), the heartbeats (one, 09:00–15:45 on a trading day), each enabled trader's
 * rejected orders of today (one indexed query each), and every open leg (one, only from 14:30 on a trading day, or
 * when the results calendar has a stock due: then each holder's results-event view, the minute-cached one GET /events reads).
 * Nothing is read for an alert that cannot be raised at that hour. Rejections count from the IST day's start, not the
 * server's: the dedupe key keeps a restart from repeating one, and a file that lands after a restart is still read.
 *
 * Who gets what (G7): a trader their own alerts; the admins (trader null) every trader's rejections and watchers.
 * A failed rule is logged and leaves the others; a failed push is the Pusher's to log.
 */

import type { BandEvent, EventStore } from '../analytics/band.ts'
import { MINUTE_MS } from '../analytics/cache.ts'
import { RESULTS_RE } from '../analytics/event-risk.ts'
import type { EventRiskView } from '../analytics/risk-wire.ts'
import type { TraderStore } from '../auth/users.ts'
import type { LegStore } from '../books/legs.ts'
import type { TradersDb } from '../db.ts'
import type { EventsStore } from '../market/events-store.ts'
import { istDate, type Log } from '../routes/kit.ts'
import { isOpenLeg, type TraderOrder } from '../types.ts'
import type { WatcherStatusStore } from '../watcher-status.ts'
import type { Pusher } from './push.ts'
import {
  REJECTED, bandBreaches, expiringItm, istDayStart, itmWindow, rejectedOrders, resultsAhead, resultsWindow, watcherOffline, watcherWindow,
  type AlertDraft,
} from './rules.ts'
import type { AlertStore } from './store.ts'

export interface AlertRunnerDeps {
  readonly store: Pick<AlertStore, 'add' | 'sent' | 'lastAt'>
  readonly pusher: Pick<Pusher, 'send'>
  readonly users: Pick<TraderStore, 'list'>
  readonly status: Pick<WatcherStatusStore, 'all'>
  readonly legs: Pick<LegStore, 'allOpen'>
  /** traders-orders, read only. */
  readonly db: TradersDb
  readonly spotOf: (stock: string) => number | null
  readonly isIndex: (stock: string) => boolean
  readonly now: () => number
  readonly log: Log
  /** Results ahead (risk spec R14): the results calendar and a trader's results-event view; absent = never raised. */
  readonly results?: {
    readonly calendar: Pick<EventsStore, 'upcomingAll'>
    readonly view: (trader: string, nowMs: number) => Promise<EventRiskView>
  }
}

type BandEvents = Pick<EventStore, 'add' | 'lastBand'>
const NO_ID = { projection: { _id: 0 } } as const

export class AlertRunner {
  readonly #d: AlertRunnerDeps
  #chain: Promise<unknown> = Promise.resolve()
  #band: BandEvent[] = []
  #timer: ReturnType<typeof setInterval> | null = null

  constructor(d: AlertRunnerDeps) {
    this.#d = d
  }

  /** The band board's store, wrapped: an event to "out" is alerted on once it is written. */
  watchBand(events: BandEvents): BandEvents {
    return {
      add: async (e) => {
        await events.add(e)
        if (e.to !== 'out') return
        this.#band.push(e)
        void this.#queue(() => this.#bandPass())
      },
      lastBand: () => events.lastBand(),
    }
  }

  /** An orders file was applied for `trader`: its rejections are read now, not at the next minute. */
  ordersLanded(trader: string): void {
    void this.#queue(async () => await this.#deliver(await this.#rejected([trader], this.#d.now())))
  }

  /** One pass of every rule; resolves with how many alerts were raised. */
  tick(nowMs: number = this.#d.now()): Promise<number> {
    return this.#queue(() => this.#pass(nowMs))
  }

  start(): void {
    if (this.#timer !== null) return
    this.#timer = setInterval(() => { void this.tick() }, MINUTE_MS)
    this.#timer.unref()
  }

  stop(): void {
    if (this.#timer === null) return
    clearInterval(this.#timer)
    this.#timer = null
  }

  #queue(fn: () => Promise<number>): Promise<number> {
    const run = this.#chain.then(fn, fn)
    this.#chain = run.catch(() => undefined)
    return run
  }

  async #pass(nowMs: number): Promise<number> {
    const traders = await this.#rule('traders', async () => (await this.#d.users.list('trader')).filter((u) => !u.disabled).map((u) => u.username))
    const drafts: AlertDraft[] = []
    if (itmWindow(nowMs)) {
      drafts.push(...await this.#rule('expiring ITM', async () =>
        expiringItm({ nowMs, legs: await this.#d.legs.allOpen(), spotOf: this.#d.spotOf, isIndex: this.#d.isIndex })))
    }
    if (watcherWindow(nowMs) && traders.length > 0) {
      drafts.push(...await this.#rule('watchers', async () => {
        const all = await this.#d.status.all()
        return watcherOffline({ nowMs, watchers: traders.map((trader) => ({ trader, status: all.get(trader) ?? null })) })
      }))
    }
    drafts.push(...await this.#rejected(traders, nowMs))
    drafts.push(...await this.#rule('results ahead', () => this.#resultsAhead(traders, nowMs)))
    return (await this.#deliver(drafts)) + (await this.#bandPass())
  }

  /** The stocks whose results are in the alert window, then their holders' rows; nothing is read when none is due. */
  async #resultsAhead(traders: readonly string[], nowMs: number): Promise<AlertDraft[]> {
    const r = this.#d.results
    if (r === undefined || traders.length === 0) return []
    const due = new Set<string>()
    for (const [stock, dates] of r.calendar.upcomingAll()) {
      if (dates.some((e) => RESULTS_RE.test(e.purpose) && resultsWindow(nowMs, e.date))) due.add(stock)
    }
    if (due.size === 0) return []
    const today = istDate(nowMs)
    const enabled = new Set(traders)
    const holders = new Map<string, Set<string>>()
    for (const l of await this.#d.legs.allOpen()) {
      if (!enabled.has(l.trader) || !due.has(l.stock) || !isOpenLeg(l, today)) continue
      const s = holders.get(l.trader) ?? new Set<string>()
      s.add(l.stock)
      holders.set(l.trader, s)
    }
    const rows: { trader: string; row: EventRiskView['rows'][number] }[] = []
    for (const [trader, stocks] of holders) {
      for (const row of (await r.view(trader, nowMs)).rows) if (stocks.has(row.stock)) rows.push({ trader, row })
    }
    return resultsAhead({ nowMs, rows })
  }

  /** Today's rejected orders of `traders` (IST): one query each on (trader, day). */
  async #rejected(traders: readonly string[], nowMs: number): Promise<AlertDraft[]> {
    if (traders.length === 0) return []
    return await this.#rule('rejected orders', async () => {
      const day = istDate(nowMs)
      const since = istDayStart(nowMs)
      const orders: TraderOrder[] = []
      for (const trader of traders) {
        orders.push(...await this.#d.db.collection<TraderOrder>('traders-orders')
          .find({ trader, day, status: REJECTED, updateTime: { $gte: since } }, NO_ID).toArray())
      }
      return rejectedOrders({ nowMs, orders, since })
    })
  }

  async #bandPass(): Promise<number> {
    if (this.#band.length === 0) return 0
    const events = this.#band.splice(0)
    try {
      const last = new Map<string, number | null>()
      for (const e of events) {
        const k = `${e.trader}|${e.stock}`
        if (!last.has(k)) last.set(k, await this.#d.store.lastAt('band-breach', e.trader, e.stock))
      }
      return await this.#deliver(bandBreaches({ events, lastAlertAt: (t, s) => last.get(`${t}|${s}`) ?? null }))
    } catch (err) {
      this.#band.unshift(...events)   // read again on the next pass
      this.#d.log('alerts: band events could not be read', { error: String(err) })
      return 0
    }
  }

  /** Stores each draft; a new one is pushed to its trader's phones, or every admin's. The number stored. */
  async #deliver(drafts: readonly AlertDraft[]): Promise<number> {
    let admins: Promise<string[]> | null = null
    let raised = 0
    for (const d of drafts) {
      try {
        if (!(await this.#d.store.add(d))) continue   // raised before
        raised++
        const to = d.trader !== null ? [d.trader]
          : await (admins ??= this.#d.users.list('admin').then((us) => us.filter((u) => !u.disabled).map((u) => u.username)))
        // a trader's tag names no one; an admin's is unique, so two traders' alerts do not fold into one
        const reached = await this.#d.pusher.send(to, { title: d.title, body: d.body, url: d.url, tag: d.trader === null ? d.dedupeKey : `${d.kind}:${d.stock ?? ''}` })
        if (reached > 0) await this.#d.store.sent(d.dedupeKey, this.#d.now())
      } catch (err) {
        this.#d.log('alerts: an alert could not be stored or sent', { kind: d.kind, error: String(err) })
      }
    }
    return raised
  }

  async #rule<T>(name: string, fn: () => Promise<T[]>): Promise<T[]> {
    try {
      return await fn()
    } catch (err) {
      this.#d.log(`alerts: ${name} could not be read`, { error: String(err) })
      return []
    }
  }
}
