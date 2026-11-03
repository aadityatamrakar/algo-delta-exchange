/**
 * THE TAPE — one scenario day's index path, seeded and deterministic, and the
 * ATM volatility beside it.
 *
 * TEST-ONLY. Nothing under `src/` imports this, and nothing ever should: a
 * synthetic market inside the engine package's exports is a fixture waiting to
 * be mistaken for a feed.
 *
 * WHY A SEEDED WALK AND NOT RECORDED TICKS. The playbook suites assert things
 * like "enters up before 10:15" and "the loss is inside the hard stop". A
 * recorded day answers that for one day; a scenario has to answer it for a
 * SHAPE of day — a trend in bursts, a range, a V, a gap — and be re-runnable
 * bit for bit, or a red test cannot be told from a flaky one. So a day is a
 * list of segments, each a linear drift plus Gaussian noise, drawn from a
 * seeded mulberry32 through Box-Muller.
 *
 * THREE RULES THE SUITES LEAN ON:
 *
 *   1. ONE DRAW PER SAMPLE, IN ORDER, whatever the segments say. Changing a
 *      segment's noise rescales its shocks but does not reshuffle them, and a
 *      spike or a hole (applied downstream of the walk) cannot move any sample
 *      but its own.
 *   2. THE DRIFT IS EXACT. A segment's drift is spread over the samples it
 *      actually owns on the 2 s grid, so a noise-free segment of +60 ends 60
 *      points up to the last float, and a burst sized in implied moves is the
 *      size the test says it is.
 *   3. ALL MINUTES ARE IST MINUTES OF DAY (09:15 = 555), fractional allowed —
 *      `startMin`, `endMin`, holes, freezes and spikes alike — the same clock
 *      as `EngineInputs.minuteOfDay`. Segments alone are durations, laid end
 *      to end from 09:15:00.
 *
 * Holes and quote freezes are not the path's business — the market goes on
 * through both — so they live here only as data, and the driver (`sim.ts`)
 * applies them: a hole stops the index FEED, a freeze stops the OPTION quotes.
 */

import type { ForwardSource } from '../../src/forward.ts'
import { DECISIONS_END_MIN, isTradingDay, SESSION_OPEN_MIN } from '../../src/session.ts'
import type { EngineAction } from '../../src/types.ts'

/**
 * What the desk does with ONE routed action (`ScenarioSpec.fills`):
 *
 *   'fill'           fills at once at the touch — the default, and the only
 *                    outcome before the hook existed;
 *   'skip'           never fills and no leg is made: desk-api skipped it. A
 *                    package whose every action is a skipped OPEN is folded as
 *                    the host folds one, a refusal: rolled back to
 *                    `markState`, keeping the adjust stamp;
 *   'fail'           never fills either, and the decision is FAILED:
 *                    `stateAfter` stands, as the host lets it;
 *   { delayPasses }  fills that many passes later, at that pass's touch. Until
 *                    then the book is IN FLIGHT: its inputs carry `inFlight`
 *                    and `pendingLots`, and no decision is routed — the host
 *                    never posts while one is in flight — except that an exit
 *                    pre-empts it, cancelling what is still pending;
 *   { fillLots }     a PARTIAL fill, at once: that many lots of an open, or of
 *                    the position a close takes off, and the rest never fills
 *                    (spec §9's "partial") — how a package ends up with a wing
 *                    at one lot and its short planned at two.
 */
export type FillOutcome =
  | 'fill'
  | 'skip'
  | 'fail'
  | { readonly delayPasses: number }
  | { readonly fillLots: number }

export interface Segment {
  readonly minutes: number // length of the segment
  readonly drift: number // index points added over the segment (linear)
  readonly noise: number // Gaussian noise, points per sqrt(minute)
  readonly ivTo?: number // ATM IV at the END of the segment (linear ramp); default: unchanged
}

export interface ScenarioSpec {
  readonly name: string
  readonly symbol: 'NIFTY' | 'SENSEX'
  readonly dateIst: string // must be an NSE trading day
  readonly expiry: string // >= dateIst; === dateIst for 0-DTE
  readonly open: number // index at 09:15:00
  readonly baseIv: number // ATM IV at 09:15 (e.g. 0.12)
  readonly segments: readonly Segment[] // consecutive from 09:15; the path holds flat after the last
  readonly seed: number
  readonly holes?: ReadonlyArray<{ readonly fromMin: number; readonly toMin: number }> // no index ticks
  readonly quoteFreezes?: ReadonlyArray<{ readonly fromMin: number; readonly toMin: number }> // option quotes stop updating
  readonly spikes?: ReadonlyArray<{ readonly atMin: number; readonly pts: number }> // one bad print
  readonly startMin?: number // first pass, IST minute (default 555)
  readonly endMin?: number // last pass (default 905 = 15:05)
  /** Each routed action's outcome, asked once, with the 0-based index of the
   * pass that routed it. Absent: everything fills at once. */
  readonly fills?: (passIndex: number, action: EngineAction) => FillOutcome
  /** The chain's forward source on every pass. Absent: 'index-carry', which
   * is what this board's forward IS (`chain-model.ts`). */
  readonly forwardSource?: ForwardSource
  /** The index's previous close, for the opening gap. Absent: unknown. */
  readonly prevClose?: number
}

/** The index feed's cadence in the simulator: one print every 2 s. */
export const SAMPLE_MS = 2_000

/** The default last pass: 15:05, past the 15:00 flat-by, so the clock's
 * whole ladder — 14:50 passive, 14:55 urgent, 15:00 blind — gets to run. */
export const DEFAULT_END_MIN = 905

const MINUTE_MS = 60_000
const SAMPLES_PER_MIN = MINUTE_MS / SAMPLE_MS
const IST_OFFSET_MS = 330 * MINUTE_MS
/** The last grid index: 09:15:00 is sample 0, 15:30:00 is this one. */
const LAST_SAMPLE = (DECISIONS_END_MIN - SESSION_OPEN_MIN) * SAMPLES_PER_MIN

/** Epoch ms of an IST minute of day on an IST date — date arithmetic plus the
 * fixed +05:30, the same convention as `session.ts`. Fractional minutes are
 * seconds, so `istMs(d, 600.5)` is 10:00:30. */
export function istMs(dateIst: string, minuteOfDay: number): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateIst)
  if (m === null) throw new RangeError(`not a YYYY-MM-DD date: '${dateIst}'`)
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) - IST_OFFSET_MS + minuteOfDay * MINUTE_MS
}

/**
 * Refuse a spec that would simulate something no session could be.
 *
 * A typo here is otherwise a silent wrong answer three suites deep: a
 * non-trading date makes every decide path hold, a zero-length segment drops
 * its drift, an expiry before the date prices every option at intrinsic.
 * Throwing names the mistake at the line that made it.
 */
export function checkSpec(spec: ScenarioSpec): void {
  const bad = (why: string): never => {
    throw new RangeError(`scenario '${spec.name}': ${why}`)
  }
  if (!isTradingDay(spec.dateIst)) bad(`${spec.dateIst} is not an NSE trading day`)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(spec.expiry) || spec.expiry < spec.dateIst) {
    bad(`expiry ${spec.expiry} is not a date on or after ${spec.dateIst}`)
  }
  if (!(spec.open > 0) || !Number.isFinite(spec.open)) bad(`open ${spec.open} is not a positive level`)
  if (!(spec.baseIv > 0) || !Number.isFinite(spec.baseIv)) bad(`baseIv ${spec.baseIv} is not a positive vol`)
  if (!Number.isInteger(spec.seed)) bad(`seed ${spec.seed} is not an integer`)
  if (spec.prevClose !== undefined && !(spec.prevClose > 0 && Number.isFinite(spec.prevClose))) {
    bad(`prevClose ${spec.prevClose} is not a positive level`)
  }
  spec.segments.forEach((g, i) => {
    if (!(g.minutes * SAMPLES_PER_MIN >= 1) || !Number.isFinite(g.minutes)) {
      bad(`segment ${i} lasts ${g.minutes} min, shorter than one ${SAMPLE_MS / 1000} s sample`)
    }
    if (!Number.isFinite(g.drift) || !(g.noise >= 0) || !Number.isFinite(g.noise)) {
      bad(`segment ${i} has drift ${g.drift} and noise ${g.noise}`)
    }
    if (g.ivTo !== undefined && !(g.ivTo > 0 && Number.isFinite(g.ivTo))) bad(`segment ${i} ramps to iv ${g.ivTo}`)
  })
  for (const w of [...(spec.holes ?? []), ...(spec.quoteFreezes ?? [])]) {
    if (!(w.fromMin < w.toMin)) bad(`window ${w.fromMin}-${w.toMin} is empty`)
  }
  for (const s of spec.spikes ?? []) {
    if (!(s.atMin >= SESSION_OPEN_MIN && s.atMin <= DECISIONS_END_MIN) || !Number.isFinite(s.pts)) {
      bad(`spike at ${s.atMin} of ${s.pts} is outside the session`)
    }
  }
  if ((spec.startMin ?? SESSION_OPEN_MIN) > (spec.endMin ?? DEFAULT_END_MIN)) bad('startMin is after endMin')
}

/** mulberry32: a 32-bit seeded PRNG, uniform on [0, 1). Small, fast, and the
 * same sequence on every machine — which is all a test tape needs. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

/** One standard normal by Box-Muller. `1 - u` keeps the log's argument in
 * (0, 1], so a zero draw cannot become an infinite shock. */
function gauss(rand: () => number): number {
  const u = 1 - rand()
  const v = rand()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

/**
 * The clean walk on the 2 s grid, 09:15:00 to 15:30:00: sample `k` is the
 * level at `09:15 + 2k s`. Segment `i` owns the steps that START inside it,
 * and its drift is divided over exactly those, so rounding a boundary onto
 * the grid can never lose or double a point.
 */
function walk(spec: ScenarioSpec): Float64Array {
  const rand = mulberry32(spec.seed)
  const out = new Float64Array(LAST_SAMPLE + 1)
  let level = spec.open
  out[0] = level
  let k = 0 // samples written after the first
  let startMin = 0
  for (const g of spec.segments) {
    const from = Math.round(startMin * SAMPLES_PER_MIN)
    startMin += g.minutes
    const to = Math.round(startMin * SAMPLES_PER_MIN)
    // Per sample of the WHOLE segment, so one running past 15:30 keeps its
    // slope rather than squeezing its drift into the grid that is left.
    const drift = to > from ? g.drift / (to - from) : 0
    const noise = g.noise / Math.sqrt(SAMPLES_PER_MIN)
    for (; k < Math.min(to, LAST_SAMPLE); k += 1) {
      level += drift + noise * gauss(rand)
      out[k + 1] = level
    }
  }
  // Flat after the last segment: no drift, no noise, the level it ended on.
  for (; k < LAST_SAMPLE; k += 1) out[k + 1] = level
  return out
}

function sampleIndex(minuteOfDay: number): number {
  return Math.round((minuteOfDay - SESSION_OPEN_MIN) * SAMPLES_PER_MIN)
}

/**
 * The index the FEED prints at `ms` — spikes included — as the last 2 s sample
 * at or before it. Before 09:15 it is the open; after 15:30, the close.
 *
 * The driver prices the option chain off the same spec with `spikes: []`: a
 * bad print is a feed error, and the options never traded on it.
 */
export function indexPath(spec: ScenarioSpec): (ms: number) => number {
  checkSpec(spec)
  const levels = walk(spec)
  const spikes = new Map<number, number>()
  for (const s of spec.spikes ?? []) {
    const k = sampleIndex(s.atMin)
    spikes.set(k, (spikes.get(k) ?? 0) + s.pts)
  }
  const openMs = istMs(spec.dateIst, SESSION_OPEN_MIN)
  return (ms) => {
    const k = Math.min(LAST_SAMPLE, Math.max(0, Math.floor((ms - openMs) / SAMPLE_MS)))
    return (levels[k] ?? spec.open) + (spikes.get(k) ?? 0)
  }
}

/**
 * The ATM implied vol at `ms`: `baseIv` at 09:15, ramping linearly across any
 * segment that names an `ivTo` and flat across one that does not, then held
 * after the last. Continuous in time, so a 5-minute IV spike is a 5-minute
 * ramp rather than a step the chain jumps on.
 */
export function ivPath(spec: ScenarioSpec): (ms: number) => number {
  checkSpec(spec)
  const knots: Array<{ readonly at: number; readonly iv: number }> = [{ at: 0, iv: spec.baseIv }]
  let at = 0
  let iv = spec.baseIv
  for (const g of spec.segments) {
    at += g.minutes
    iv = g.ivTo ?? iv
    knots.push({ at, iv })
  }
  const openMs = istMs(spec.dateIst, SESSION_OPEN_MIN)
  return (ms) => {
    const x = (ms - openMs) / MINUTE_MS
    let prev = knots[0]
    for (const next of knots) {
      if (prev !== undefined && x <= next.at) {
        return next.at > prev.at ? prev.iv + ((next.iv - prev.iv) * (x - prev.at)) / (next.at - prev.at) : next.iv
      }
      prev = next
    }
    return iv
  }
}
