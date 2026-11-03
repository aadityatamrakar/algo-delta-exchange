/**
 * A pure IST cron evaluator.
 *
 * WHY this exists rather than the `cron` package (already a dependency of this
 * repo, and what all four legacy engines use):
 *
 *  - `new CronJob(spec, fn, null, true, 'Asia/Kolkata')` schedules against REAL
 *    wall-clock timers. Nothing about it can be asked "would you have fired at
 *    10:15:20 last Friday?", so scheduled behaviour could never be replayed or
 *    golden-tested. Everything here is a pure function of (expression, instant),
 *    driven by the injected `Clock` — the same reasoning that put every other
 *    dependency behind a port.
 *  - The model it replaces, `PhaseSpec.atIstMinute`, is whole minutes only. The
 *    real schedules are 6-field with SECONDS and REPEATS — `10 *\/5 9-13 * * 1-5`,
 *    every 5 minutes at :10 past between 09:00 and 13:55 (the backslash is only
 *    there so this block comment does not end at the step operator) —
 *    and the deadline-after-poller ordering that all four engines rely on
 *    (13:30:10 poller, then 13:31:00 deadline, so the last scheduled check can
 *    still trade) is a sub-minute distinction that whole minutes cannot express
 *    at all. It is also why `cheetah-b1-snx`'s 3s-vs-10s bootstrap difference
 *    could not be ported (logged as M2 during Phase C).
 *
 * IST is UTC+05:30 with no DST, so every calendar computation here is exact
 * integer arithmetic on a shifted epoch — no timezone database, no ambiguous or
 * skipped local times to reason about.
 */

const IST_OFFSET_MS = 330 * 60_000

/** Broken-down IST calendar fields. Mutable: `nextAfter` walks them forward. */
export interface IstFields {
  year: number
  /** 1-12, NOT the 0-11 that `Date` uses — cron month fields are 1-based. */
  month: number
  day: number
  hour: number
  minute: number
  second: number
  /** 0 = Sunday … 6 = Saturday. */
  dow: number
}

export function istFields(epochMs: number): IstFields {
  const d = new Date(epochMs + IST_OFFSET_MS)
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds(),
    dow: d.getUTCDay(),
  }
}

function toEpochMs(f: IstFields): number {
  return Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute, f.second) - IST_OFFSET_MS
}

export interface CronSchedule {
  readonly expr: string
  readonly seconds: readonly number[]
  readonly minutes: readonly number[]
  readonly hours: readonly number[]
  readonly daysOfMonth: readonly number[]
  /** 1-12. */
  readonly months: readonly number[]
  /** 0-6, Sunday = 0. */
  readonly daysOfWeek: readonly number[]
  /**
   * Whether the field was something other than `*`. Vixie cron's rule is that
   * when BOTH day-of-month and day-of-week are restricted the day matches if
   * EITHER does; when only one is restricted, only that one is consulted.
   */
  readonly domRestricted: boolean
  readonly dowRestricted: boolean
}

/** Parsed expressions are cached: the same handful of strings is evaluated constantly. */
const parseCache = new Map<string, CronSchedule>()

function parseField(text: string, min: number, max: number, what: string, expr: string): number[] {
  const out = new Set<number>()
  for (const part of text.split(',')) {
    const [rangePart, stepPart] = part.split('/') as [string, string | undefined]
    let step = 1
    if (stepPart !== undefined) {
      step = Number(stepPart)
      if (!Number.isInteger(step) || step < 1) {
        throw new Error(`cron "${expr}": bad ${what} step '${part}'`)
      }
    }
    let lo: number
    let hi: number
    if (rangePart === '*') {
      lo = min
      hi = max
    } else if (rangePart.includes('-')) {
      const [a, b] = rangePart.split('-') as [string, string | undefined]
      lo = Number(a)
      hi = Number(b)
    } else {
      lo = Number(rangePart)
      // `a/n` (no upper bound) means "from a to the end of the range, every n" —
      // but a bare `a` is a single value, not a range.
      hi = stepPart === undefined ? lo : max
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > max || lo > hi) {
      throw new Error(`cron "${expr}": bad ${what} field '${part}' (allowed ${min}-${max})`)
    }
    for (let v = lo; v <= hi; v += step) out.add(v)
  }
  if (out.size === 0) throw new Error(`cron "${expr}": empty ${what} field '${text}'`)
  return [...out].sort((a, b) => a - b)
}

/** Cron allows 7 for Sunday; collapse it onto 0 so lookups are a single check. */
function normaliseDow(values: readonly number[]): number[] {
  return [...new Set(values.map((v) => (v === 7 ? 0 : v)))].sort((a, b) => a - b)
}

/**
 * Parse a 6-field `s m h dom mon dow` expression (a 5-field one is accepted and
 * treated as second 0, matching the `cron` package). Numeric fields only —
 * `MON`/`JAN` names are not used by any engine and are rejected loudly rather
 * than silently mis-parsed.
 */
export function parseCron(expr: string): CronSchedule {
  const cached = parseCache.get(expr)
  if (cached !== undefined) return cached

  const parts = expr.trim().split(/\s+/)
  if (parts.length === 5) parts.unshift('0')
  if (parts.length !== 6) {
    throw new Error(`cron "${expr}": expected 6 fields 's m h dom mon dow', got ${parts.length}`)
  }
  const [s, mi, h, dom, mon, dow] = parts as [string, string, string, string, string, string]
  const sched: CronSchedule = {
    expr,
    seconds: parseField(s, 0, 59, 'seconds', expr),
    minutes: parseField(mi, 0, 59, 'minutes', expr),
    hours: parseField(h, 0, 23, 'hours', expr),
    daysOfMonth: parseField(dom, 1, 31, 'day-of-month', expr),
    months: parseField(mon, 1, 12, 'month', expr),
    daysOfWeek: normaliseDow(parseField(dow, 0, 7, 'day-of-week', expr)),
    domRestricted: dom !== '*',
    dowRestricted: dow !== '*',
  }
  parseCache.set(expr, sched)
  return sched
}

function toMs(when: number | Date): number {
  return typeof when === 'number' ? when : when.getTime()
}

function dayMatches(sched: CronSchedule, f: IstFields): boolean {
  if (!sched.months.includes(f.month)) return false
  const dom = sched.daysOfMonth.includes(f.day)
  const dow = sched.daysOfWeek.includes(f.dow)
  if (sched.domRestricted && sched.dowRestricted) return dom || dow
  if (sched.domRestricted) return dom
  if (sched.dowRestricted) return dow
  return true
}

/** Does this expression fire at exactly this instant (second granularity)? */
export function matches(expr: string, when: number | Date): boolean {
  const sched = parseCron(expr)
  const f = istFields(toMs(when))
  return (
    dayMatches(sched, f) &&
    sched.hours.includes(f.hour) &&
    sched.minutes.includes(f.minute) &&
    sched.seconds.includes(f.second)
  )
}

function nextAllowed(values: readonly number[], from: number): number | null {
  for (const v of values) if (v >= from) return v
  return null
}

function startOfNextDay(f: IstFields): IstFields {
  // Date.UTC normalises day overflow across month and year boundaries.
  return istFields(Date.UTC(f.year, f.month - 1, f.day + 1) - IST_OFFSET_MS)
}

function startOfNextHour(f: IstFields): IstFields {
  return istFields(toEpochMs({ ...f, minute: 0, second: 0 }) + 3_600_000)
}

function startOfNextMinute(f: IstFields): IstFields {
  return istFields(toEpochMs({ ...f, second: 0 }) + 60_000)
}

/** Four years is past any real cron; `29 2 *` (leap day) is the reason it is not one. */
const SEARCH_LIMIT_MS = 4 * 366 * 24 * 3_600_000

/**
 * The first instant STRICTLY after `when` at which the expression fires, as
 * epoch ms. Strictly-after is what makes it usable as an occurrence identity:
 * every instant inside one gap between fires yields the same answer.
 */
export function nextAfter(expr: string, when: number | Date): number {
  const sched = parseCron(expr)
  const startMs = toMs(when)
  // Cron resolution is one second, so start the search at the next whole second.
  let f = istFields(Math.floor(startMs / 1000) * 1000 + 1000)
  const limitMs = startMs + SEARCH_LIMIT_MS

  while (toEpochMs(f) <= limitMs) {
    if (!dayMatches(sched, f)) {
      f = startOfNextDay(f)
      continue
    }
    const h = nextAllowed(sched.hours, f.hour)
    if (h === null) {
      f = startOfNextDay(f)
      continue
    }
    if (h !== f.hour) {
      f.hour = h
      f.minute = 0
      f.second = 0
    }
    const mi = nextAllowed(sched.minutes, f.minute)
    if (mi === null) {
      f = startOfNextHour(f)
      continue
    }
    if (mi !== f.minute) {
      f.minute = mi
      f.second = 0
    }
    const sec = nextAllowed(sched.seconds, f.second)
    if (sec === null) {
      f = startOfNextMinute(f)
      continue
    }
    f.second = sec
    return toEpochMs(f)
  }
  throw new Error(`cron "${expr}": no occurrence within 4 years of ${new Date(startMs).toISOString()}`)
}

/**
 * Every occurrence in `(afterMs, throughMs]`, oldest first. Used by the replay
 * harness to interleave scheduled work with ticks exactly as it would live.
 *
 * `cap` bounds the walk: a repeating expression over a long gap (a replay whose
 * ticks jump a week) would otherwise produce tens of thousands of fires.
 */
export function occurrencesBetween(
  expr: string,
  afterMs: number,
  throughMs: number,
  cap = 2000,
): number[] {
  const out: number[] = []
  if (throughMs <= afterMs) return out
  let t = afterMs
  while (out.length < cap) {
    const next = nextAfter(expr, t)
    if (next > throughMs) break
    out.push(next)
    t = next
  }
  return out
}

/**
 * The earliest IST minute-of-day at which the expression can fire, ignoring
 * seconds. This is the default restart catch-up threshold: `0 21 9 * * 1-5`
 * gives 561, which is exactly `bn-breakout`'s hand-written `mins >= 561`
 * bootstrap check. Engines whose thresholds do NOT line up with their cron
 * (orb-fut fires 09:45:20 but bootstraps from 09:46) say so explicitly with
 * `catchUpFrom`.
 */
export function firstIstMinuteOfDay(expr: string): number {
  const sched = parseCron(expr)
  return (sched.hours[0] ?? 0) * 60 + (sched.minutes[0] ?? 0)
}

/**
 * Build a weekday cron that fires once a day at an IST minute-of-day.
 *
 * The bridge from the old `atIstMinute` model: a strategy that genuinely has a
 * whole-minute schedule says so without hand-assembling a cron string, and the
 * translation stays in one place.
 *
 * `second` exists because a job that reads BARS cannot fire on the minute boundary
 * the bars close on. A CandleStore bar closes when the first tick of the next
 * bucket arrives, so at 09:45:00.000 the 09:40-09:45 bar may not exist yet — and
 * on 2026-08-11 it did not, for NIFTY and SENSEX, which left both without an
 * opening range all session. Every legacy launcher that reads a just-closed bar
 * offsets itself for exactly this reason (`orb-scalp.js:292` sets the opening range
 * at 09:45:**20**), and `parseCron` has always had the seconds field to say it.
 * Defaults to `0`, so every existing caller is unchanged.
 */
export function cronAtIstMinute(minuteOfDay: number, dayOfWeek = '1-5', second = 0): string {
  if (!Number.isInteger(minuteOfDay) || minuteOfDay < 0 || minuteOfDay >= 24 * 60) {
    throw new Error(`cronAtIstMinute: minute-of-day out of range: ${minuteOfDay}`)
  }
  if (!Number.isInteger(second) || second < 0 || second > 59) {
    throw new Error(`cronAtIstMinute: second out of range: ${second}`)
  }
  const h = Math.floor(minuteOfDay / 60)
  const m = minuteOfDay % 60
  return `${second} ${m} ${h} * * ${dayOfWeek}`
}
