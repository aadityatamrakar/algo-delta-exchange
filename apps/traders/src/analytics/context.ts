/**
 * One underlying's market context (`MarketContext`, spec §5): live spot and
 * future, today's day block, trend, ATR/HV/IV and IV rank, the expected move
 * to the near expiry, the last end-of-day OI view, and the levels around the
 * price — what the assistant's `get_market_context` tool and the page's
 * context card read. Market data, not trader data: nothing here knows a
 * trader.
 *
 * Inputs: the quote cache (live prices), the daily history (`HistoryStore`),
 * today's sampled bars (`IntradayBars`), the instrument master, and the EOD
 * store for a previous close the history lacks. Every figure is computed from
 * those or is null with a warning saying why; nothing is filled in.
 *
 * The reference price is the spot, except for an underlying whose daily bars
 * are its near future's (an index: NSE's CM bhavcopy has no index rows), whose
 * levels, change and day block are all the future's, so that like is measured
 * against like. The live ATM IV is the mean of the ATM call's and put's IVs on
 * the first listed expiry at least IV_TENOR_DAYS calendar days out that has both
 * quoted (the fixed tenor the history ranks), solved the way every book month is
 * (`forwardFor` + `solveMonth`): the held months' windows and Market Watch's
 * chains are what puts those quotes in the cache. With the market closed it is
 * the last session's end-of-day IV when the history holds that session, else
 * the quotes solved at their own time (a Friday close read on Monday morning is
 * not three days shorter-dated). With none, the last history day's ATM IV is
 * used, and said. "Near expiry" (the expected move's) is the first listed expiry
 * after today, as in the history files.
 */

import { isTradingDay } from '@algomaker/desk-engine'
import { yearsToExpiry } from '@algomaker/greeks'
import type { ChainQuoteLite } from '@algomaker/payoff'
import type { HistoryBar, HistoryStore } from '../market/history.ts'
import { MAX_HISTORY_DAYS } from '../market/history.ts'
import type { IntradayBars, IntradayOf } from '../market/intraday.ts'
import type { EventsStore } from '../market/events-store.ts'
import type { VolStore } from '../market/vol-store.ts'
import { nearestFutureWithExpiry, spotTokenOf, type TradersMaster } from '../market/master.ts'
import { FEED_NOT_TICKING, type TraderQuote, type TradersQuotes } from '../market/quotes.ts'
import { istClock, istDate } from '../routes/kit.ts'
import { marketOpenAt, previousTradingDay, sessionDay } from './calendar.ts'
import type { Level, MarketContext } from './context-wire.ts'
import type { EodStore } from './eod.ts'
import {
  IV_RANK_MIN_DAYS, IV_TENOR_DAYS, TREND_MIN_BARS, WEEKS52_MIN_BARS, atr, dayStatsOf, daysTo, hv, ivStatsOf, levelsOf, nearestOf, round2,
  shortDate, trendOf, type LevelInput,
} from './levels.ts'
import { forwardFor, solveMonth } from './month-chain.ts'
import { volMetrics } from './vol-metrics.ts'
import { resultsCue } from './event-risk.ts'
import { MARKET_CLOSED } from './snapshot.ts'

export type { MarketContext } from './context-wire.ts'

export interface ContextDeps {
  readonly master: () => TradersMaster
  readonly quotes: TradersQuotes
  readonly history: Pick<HistoryStore, 'bars' | 'latest'> & Partial<Pick<HistoryStore, 'adjustments'>>
  readonly intraday: Pick<IntradayBars, 'bars' | 'coverage'>
  /** The previous trading day's cash close, when the history does not hold that day. */
  readonly eod: Pick<EodStore, 'close'>
  /** The held stocks' evening chain snapshots (vol addendum); without it the optional end-of-day vol fields are left out. */
  readonly vol?: Pick<VolStore, 'days'>
  /** NSE's results calendar (risk spec R13); without it `results` is left out. */
  readonly calendar?: Pick<EventsStore, 'upcoming'>
}

/** The vol view's warnings the context's own history note already says. */
const SAID = /^(IV rank needs|HV20 needs|no closes|no end-of-day history)/

/** Expiries tried, in order, for a live ATM IV. */
const IV_EXPIRIES = 3
const SMA200_BARS = 200

const positive = (x: number | null | undefined): x is number => typeof x === 'number' && Number.isFinite(x) && x > 0
const priceOf = (q: TraderQuote | null): number | null => (q !== null && positive(q.price) ? q.price : null)
const r2 = (x: number | null): number | null => (x === null ? null : round2(x))
const r4 = (x: number | null): number | null => (x === null ? null : Math.round(x * 10_000) / 10_000)

/**
 * The last session whose 15:30 close has passed at `nowMs`: today after 15:30 on a trading day, else the trading day
 * before (a weekend or a holiday reads the last trading day's).
 */
export function lastClosedSession(nowMs: number): string {
  const today = istDate(nowMs)
  return isTradingDay(today) && nowMs >= Date.parse(`${today}T15:30:00+05:30`) ? today : previousTradingDay(today)
}

/**
 * The live ATM IV (decimal) and the expiry it is of; null when no expiry has both ATM sides quoted and solved.
 * With the market `closed` the time to expiry is measured from the quotes' own time, not from now.
 */
export function liveAtmIv(
  m: TradersMaster, q: TradersQuotes, stock: string, expiries: readonly string[], spot: number | null, nowMs: number, closed: boolean,
): { readonly iv: number; readonly expiry: string } | null {
  for (const expiry of expiries.slice(0, IV_EXPIRIES)) {
    const fwd = forwardFor(m, q, stock, expiry, spot, nowMs)
    if (fwd === null) continue
    const strike = m.options.atmStrike(stock, expiry, fwd.price)
    if (strike === null) continue
    const quotes: ChainQuoteLite[] = []
    let quotedAt = 0
    for (const type of ['CE', 'PE'] as const) {
      const token = m.options.resolve(stock, expiry, strike, type)?.instrumentToken
      const got = token === undefined ? null : q.quote(token)
      if (got !== null && positive(got.price)) {
        quotes.push({ strike, type, price: got.price, ageMs: got.ageMs })
        quotedAt = Math.max(quotedAt, positive(got.asOf) ? got.asOf : 0)
      }
    }
    if (quotes.length < 2) continue
    const at = closed && quotedAt > 0 ? Math.min(nowMs, quotedAt) : nowMs
    const solved = solveMonth(quotes, fwd.price, yearsToExpiry(expiry, at), closed)
    const ivOf = (type: 'CE' | 'PE'): number | null => {
      const r = solved.find((s) => s.type === type && s.source === 'quote')
      return r !== undefined && positive(r.iv) ? r.iv : null
    }
    const ce = ivOf('CE')
    const pe = ivOf('PE')
    if (ce !== null && pe !== null) return { iv: (ce + pe) / 2, expiry }
  }
  return null
}

function historyNote(stock: string, n: number): string | null {
  if (n === 0) {
    return `no daily history for ${stock} yet (no end-of-day summary lists it): trend, ATR, HV, IV rank, pivots, swings and OI levels are unknown`
  }
  if (n < TREND_MIN_BARS) return `${n} daily bars of ${stock}: the trend needs ${TREND_MIN_BARS}, SMA200 ${SMA200_BARS}, the 52-week high/low ${WEEKS52_MIN_BARS}`
  if (n < SMA200_BARS) return `${n} daily bars of ${stock}: SMA200 needs ${SMA200_BARS}, the 52-week high/low ${WEEKS52_MIN_BARS}`
  if (n < WEEKS52_MIN_BARS) return `${n} daily bars of ${stock}: the 52-week high/low need ${WEEKS52_MIN_BARS}`
  return null
}

/** null = the master lists no such underlying (no F&O expiry and no spot). */
export async function marketContextOf(d: ContextDeps, stock: string, nowMs: number): Promise<MarketContext | null> {
  const m = d.master()
  const spotToken = spotTokenOf(m, stock)
  const listed = m.options.expiries(stock)
  if (listed.length === 0 && spotToken === null) return null

  const today = istDate(nowMs)
  const session = sessionDay(today)
  const closed = !marketOpenAt(nowMs)
  const feedAlive = d.quotes.feedAlive()
  const warnings: string[] = []
  if (closed) warnings.push(MARKET_CLOSED)
  else if (!feedAlive) warnings.push(FEED_NOT_TICKING)

  const spotQ = spotToken === null ? null : d.quotes.quote(spotToken)
  const nf = nearestFutureWithExpiry(m, stock, today)
  const futQ = nf?.ref.instrumentToken === undefined ? null : d.quotes.quote(nf.ref.instrumentToken)
  const spot = priceOf(spotQ)
  const future = priceOf(futQ)

  // the history: completed days, oldest → newest
  const daily: readonly HistoryBar[] = d.history.bars(stock, MAX_HISTORY_DAYS)
  const latest = d.history.latest(stock)
  const futureBased = (daily.at(-1)?.src ?? latest?.src) === 'fut'
  const reference: 'spot' | 'future' = futureBased ? 'future' : 'spot'
  if (futureBased) {
    warnings.push(`NSE's end-of-day files carry no OHLC for ${stock}: its daily bars, levels, change and day figures are its near future's, measured from the future`)
  }
  const note = historyNote(stock, daily.length)
  if (note !== null) warnings.push(note)

  // the reference price: live, else the last close (said), else none
  const refQ = futureBased ? futQ : spotQ
  let ref = futureBased ? future : spot
  if (ref === null) {
    const last = daily.at(-1)
    if (last !== undefined) {
      ref = last.close
      warnings.push(`no live ${reference} price for ${stock}: levels are measured from the ${shortDate(last.date)} close`)
    } else warnings.push(`no live ${reference} price and no history for ${stock}: no levels`)
  }
  const stale = refQ === null || refQ.stale === true

  // the previous session's close: the history's last day before today's session, else the EOD store's cash close
  let prevClose: number | null = [...daily].reverse().find((b) => b.date < session)?.close ?? null
  if (prevClose === null && !futureBased && m.cash.has(stock)) {
    prevClose = d.eod.close({ stock, instrument: 'share', expiry: '', strike: null, optType: null })
  }
  const live = futureBased ? future : spot
  const changePct = live !== null && prevClose !== null ? ((live - prevClose) / prevClose) * 100 : null

  // today's bars
  const of: IntradayOf = futureBased ? 'future' : 'spot'
  const cov = d.intraday.coverage()
  const todays = cov.day === today ? d.intraday.bars(stock, '5m', of) : []
  const openMs = Date.parse(`${today}T09:15:00+05:30`)
  const dayStats = dayStatsOf(todays, { openMs, coveredFrom: cov.day === today ? cov.since : null, nowMs })
  if (todays.length === 0) {
    if (isTradingDay(today) && nowMs >= openMs) {
      warnings.push(`no ticks of ${stock}'s ${of} sampled today: today's open, high, low, VWAP and opening range are unknown`)
    }
  } else {
    if (dayStats.partial && cov.since !== null) {
      warnings.push(`today's bars are built in memory from ${istClock(cov.since)} IST, when the app began sampling: the open and opening range are unknown; high, low and VWAP are since then`)
    }
    if (dayStats.vwap === null) warnings.push(`${stock}'s ${of} ticks carry no volume: no VWAP`)
  }

  // trend and volatility
  const trend = trendOf(daily)
  const closes = daily.map((b) => b.close)
  const atr14 = atr(daily)
  const hv10 = hv(closes, 10)
  const hv20 = hv(closes, 20)
  const after = listed.filter((e) => e > today)
  const nearExpiry = after[0] ?? null
  // the ranked tenor: the first expiry a week or more out, as the history's IV is
  const tenor = listed.filter((e) => daysTo(today, e) >= IV_TENOR_DAYS)
  const last = daily.at(-1)
  const closedSession = closed ? lastClosedSession(nowMs) : null
  let atmIv: number | null = null
  if (closedSession !== null && last !== undefined && last.date === closedSession && last.atmIv !== null) {
    // closed: the session's own end-of-day IV, not its last quotes solved against a clock that has moved on
    atmIv = last.atmIv
    warnings.push(`market closed: ATM IV is the ${shortDate(last.date)} close's, from the end-of-day summary`)
  } else {
    const liveIv = liveAtmIv(m, d.quotes, stock, tenor, spot, nowMs, closed)
    atmIv = liveIv?.iv ?? null
    if (liveIv === null) {
      if (last !== undefined && last.atmIv !== null) {
        atmIv = last.atmIv
        warnings.push(`no live ATM IV for ${stock} (no two-sided quote at the money): ATM IV is the ${shortDate(last.date)} close's, from the end-of-day summary`)
      } else warnings.push(`no ATM IV for ${stock}: no live two-sided quote at the money and none in the last end-of-day summary`)
    } else if (liveIv.expiry !== tenor[0]) {
      warnings.push(`ATM IV is the ${shortDate(liveIv.expiry)} expiry's: the first expiry ${IV_TENOR_DAYS} or more days out is not quoted at the money`)
    }
  }
  for (const a of d.history.adjustments?.(stock, MAX_HISTORY_DAYS) ?? []) {
    if (a.kind === 'corporate') {
      warnings.push(`${stock}'s daily prices before ${shortDate(a.date)} are scaled ×${a.ratio.toFixed(4)}: NSE's previous close that day is not the close before (a corporate action)`)
    }
  }
  const ivs = ivStatsOf(daily.map((b) => b.atmIv), atmIv)
  if (ivs.ivDays < IV_RANK_MIN_DAYS) {
    warnings.push(`IV rank and percentile need ${IV_RANK_MIN_DAYS} days of IV history; ${ivs.ivDays} exist`)
  }

  // the end-of-day vol view: near/next month IV, VRP and its history, skew, NSE's HV
  const eodVol = d.vol === undefined ? null : volMetrics(daily, d.vol.days(stock), today)
  if (eodVol !== null) for (const w of eodVol.warnings) if (!SAID.test(w)) warnings.push(`end-of-day vol: ${w}`)
  const rv = eodVol?.realizedVrp ?? null
  // the near expiry IV rank is read on, as the vol row says it (its own, else the ranked tenor): what `results.inNear` is against
  const eodNear = eodVol?.nearExpiry ?? null
  const rankedOn = eodNear !== null && eodNear >= today ? eodNear : tenor[0] ?? null

  // the expected move to the near expiry, off the future (else the spot, said)
  const days = nearExpiry === null ? null : yearsToExpiry(nearExpiry, nowMs) * 365
  const base = future ?? spot
  if (future === null && spot !== null && atmIv !== null) warnings.push(`no live future for ${stock}: the expected move is off the spot`)
  const oneSigma = base !== null && atmIv !== null && days !== null && days > 0 ? base * atmIv * Math.sqrt(days / 365) : null

  // the last end-of-day OI view; an expiry already past describes nothing
  const opt = latest?.opt ?? null
  let oiInput: LevelInput['oi'] = null
  let oi: MarketContext['oi'] = null
  if (latest !== null && opt !== null) {
    if (opt.expiry < today) {
      warnings.push(`the last end-of-day OI of ${stock} (${shortDate(latest.date)}) is of the ${shortDate(opt.expiry)} expiry, which has passed: no OI levels`)
    } else {
      oi = {
        expiry: opt.expiry,
        pcr: opt.ceOi !== null && opt.ceOi > 0 && opt.peOi !== null ? r2(opt.peOi / opt.ceOi) : null,
        maxPain: opt.maxPain, callWall: opt.walls.ce[0]?.[0] ?? null, putWall: opt.walls.pe[0]?.[0] ?? null, day: latest.date,
      }
      oiInput = { expiry: opt.expiry, day: latest.date, callWalls: opt.walls.ce, putWalls: opt.walls.pe, maxPain: opt.maxPain }
    }
  }
  const expected = previousTradingDay(session)
  if (latest !== null && latest.date < expected) {
    warnings.push(`the newest end-of-day summary of ${stock} is of ${shortDate(latest.date)}; ${shortDate(expected)}'s is missing`)
  }

  // levels: today's figures only while the history does not already hold today
  const dayForLevels = todays.length > 0 && daily.at(-1)?.date !== today ? dayStats : null
  const levels: readonly Level[] = ref === null ? [] : levelsOf({ ref, daily, day: dayForLevels, oi: oiInput })
  const near = ref === null ? { support: null, resistance: null } : nearestOf(levels, ref)

  return {
    stock, asOf: nowMs, closed, feedAlive, stale, reference,
    spot, future, prevClose, changePct: r2(changePct),
    day: {
      open: r2(dayStats.open), high: r2(dayStats.high), low: r2(dayStats.low), vwap: r2(dayStats.vwap),
      orHigh: r2(dayStats.orHigh), orLow: r2(dayStats.orLow),
    },
    trend: {
      label: trend.label, sma20: r2(trend.sma20), sma50: r2(trend.sma50), sma200: r2(trend.sma200),
      ret5d: r4(trend.ret5d), ret20d: r4(trend.ret20d), basis: trend.basis,
    },
    vol: {
      atr14: r2(atr14), hv10: r4(hv10), hv20: r4(hv20), atmIv: r4(atmIv),
      ivRank: r2(ivs.ivRank), ivPercentile: r2(ivs.ivPercentile),
      ivMinusHv20: atmIv !== null && hv20 !== null ? r4(atmIv - hv20) : null, ivDays: ivs.ivDays,
      ...(eodVol === null ? {} : {
        volAsOf: eodVol.asOf, ivSource: eodVol.ivSource, vrp: r4(eodVol.vrp), vrpRatio: r2(eodVol.vrpRatio),
        vrpPercentile: r2(eodVol.vrpPercentile),
        realizedVrp: rv === null ? null : { mean: r4(rv.mean) as number, median: r4(rv.median) as number, positivePct: r2(rv.positivePct) as number, days: rv.days },
        nearExpiry: eodVol.nearExpiry, nearIv: r4(eodVol.nearIv), nextExpiry: eodVol.nextExpiry, nextIv: r4(eodVol.nextIv),
        skew25: r4(eodVol.skew25), nseHv: r4(eodVol.nseHv),
      }),
    },
    ...(d.calendar === undefined ? {} : { results: resultsCue(d.calendar.upcoming(stock), today, listed, rankedOn) }),
    expectedMove: {
      expiry: nearExpiry, days: r2(days), oneSigma: r2(oneSigma), twoSigma: oneSigma === null ? null : r2(2 * oneSigma),
    },
    oi, levels, nearestSupport: near.support, nearestResistance: near.resistance,
    bars: { daily: daily.length, intraday: todays.length },
    warnings,
  }
}
