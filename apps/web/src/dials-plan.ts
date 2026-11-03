/**
 * WHAT THE DIALS PANEL DECIDES BEFORE IT DRAWS ANYTHING.
 *
 * The panel this feeds replaced a `<textarea>` full of JSON. That box was
 * honest about being a box (`books.tsx`, before this ticket) but it could not
 * answer the two questions an operator actually has in front of a running
 * book: WHICH of these numbers did somebody change, and WHICH of them is the
 * engine even reading right now. A dial sitting at `trend_skew: 0.5` under
 * `trend_enabled: false` is not a lean of 0.5 — it is nothing at all — and
 * JSON cannot say so.
 *
 * THE SCHEMA IS NOT COPIED HERE. Sections, field order and the four master
 * toggles come from `DIAL_SECTIONS` in `@algomaker/desk-engine`, which is
 * checked against `DEFAULT_DIALS` in that package's own suite. A field list
 * maintained in the dashboard would go stale the first time the engine grew a
 * dial, and the operator would never know the knob existed — which is the
 * failure mode the old box had by construction.
 *
 * IMPORTED THROUGH THE LEAF PATHS (`/dials`, `/presets`) rather than the
 * package root: `dials.ts` imports nothing and `presets.ts` imports one type
 * from it, so the browser bundle gains a metadata table and twelve dial-sets
 * and NOT the engine, the greeks and the marking model behind them. See the
 * `_comment:exports` note in `packages/desk-engine/package.json`.
 *
 * ── THE THREE JUDGEMENTS, AND WHY EACH IS HERE AND NOT IN THE COMPONENT ─────
 *
 *   `overridden` — does this book differ from the preset it was built from?
 *   Measured on the VALUE, not on the key's presence: a stored `0.02` beside a
 *   preset that says `0.02` differs from nothing, and marking it as an
 *   operator's change would make the indicator noise within a week.
 *
 *   `inert` — is the engine reading this field at all? True exactly when the
 *   section's master toggle is off. The field keeps its stored value (that is
 *   what makes turning the section back on predictable) and the panel dims it.
 *
 *   `unknown` — the F-29 rule, and the only one that can cost money. Dials
 *   live in a free-form Mongo document that humans hand-edit, so a retired
 *   dial, a typo or a value of the wrong type can be sitting on a live book
 *   right now. `resolveDials` REFUSES those rather than coercing them, and
 *   this module carries every refusal out as a row for the panel to render in
 *   red. Dropping them silently is an operator who set a limit that never
 *   applied and found out from the P&L.
 *
 * Pure: no React, no network, no clock. `dials-plan.test.ts` runs it under
 * node:test.
 */

import {
  DEFAULT_DIALS,
  DIAL_SECTIONS,
  resolveDials,
  type DialSection,
  type Dials,
} from '@algomaker/desk-engine/dials'
import { PRESETS } from '@algomaker/desk-engine/presets'
import { VENUE } from './venue.ts'
import { currencySymbol } from './format.ts'

/** Mirrors `DialValue` in `api.ts`: a dial is a number or a boolean, never null. */
export type DialValue = number | boolean

export interface DialFieldView {
  readonly key: string
  /** What the engine would read for this dial, preset folded with overrides. */
  readonly value: DialValue
  /**
   * What the PRESET says for this dial — the value `overridden` is measured
   * against, and the one the panel prints beside a changed field. "Changed"
   * with nothing to compare to is half an indicator.
   */
  readonly presetValue: DialValue
  /** Differs from the preset's own value for this dial. */
  readonly overridden: boolean
  /** The section's master toggle is off, so nothing reads this field. */
  readonly inert: boolean
  /** A switch renders as a switch; everything else is a number box. */
  readonly kind: 'boolean' | 'number'
}

export interface DialSectionView {
  /** The engine's own metadata for the section — label, key, collapsed hint. */
  readonly section: DialSection
  /** The master switch, or null for a section whose off-state is a number. */
  readonly toggle: DialFieldView | null
  readonly fields: readonly DialFieldView[]
}

/** A stored entry the schema refused. Rendered as an error row, never dropped. */
export interface DialErrorRow {
  readonly key: string
  readonly value: DialValue
  readonly reason: string
}

export interface DialsView {
  /** The preset the book records as its label. */
  readonly preset: string
  /** False when no such preset exists — the baseline is the engine default. */
  readonly presetKnown: boolean
  readonly sections: readonly DialSectionView[]
  /** Every stored entry the schema refused, in the document's own order. */
  readonly unknown: readonly DialErrorRow[]
}

/**
 * A preset's dial-set as a plain document, or null when no preset has that key.
 *
 * A COPY, because the create flow edits what it gets before posting it and
 * `PRESETS` is module state shared by every screen in the tab.
 */
export function presetDials(preset: string): Record<string, DialValue> | null {
  const found = PRESETS.find((p) => p.key === preset)
  return found === undefined ? null : asRecord(found.dials)
}

/** `Partial<Dials>` as the free-form document shape the registry stores. */
function asRecord(dials: Partial<Dials>): Record<string, DialValue> {
  const out: Record<string, DialValue> = {}
  for (const [key, value] of Object.entries(dials)) {
    if (value !== undefined) out[key] = value
  }
  return out
}

const isDialName = (key: string): key is keyof Dials =>
  Object.prototype.hasOwnProperty.call(DEFAULT_DIALS, key)

/**
 * WHY the schema refused this entry, in the operator's terms.
 *
 * `resolveDials` returns names, not reasons — deliberately, it is the engine's
 * contract and not a message bus. The three refusals it can make are
 * distinguishable from the key and the value alone, and telling them apart is
 * what makes the row actionable: a typo is deleted, a wrong type is retyped,
 * and a NaN is a document somebody edited by hand.
 */
function refusalReason(key: string, value: DialValue): string {
  if (!isDialName(key)) {
    return 'not a dial this engine reads — it is stored and ignored, so delete it or fix the spelling'
  }
  const expected = typeof DEFAULT_DIALS[key]
  if (typeof value !== expected) {
    return `must be a ${expected}; this document holds a ${typeof value}`
  }
  return 'must be a finite number'
}

/**
 * The panel's whole view: the preset folded with the book's own dials, section
 * by section, plus every entry the schema refused.
 *
 * TWO FOLDS, NOT ONE, and the difference matters on a refusal. `resolveDials`
 * always folds onto `DEFAULT_DIALS` — the relief-r live set — so folding
 * preset-and-overrides together in one call would show a REFUSED dial at the
 * ENGINE default rather than at the preset's own value: a `recenter-r` book
 * with a hand-broken `shift_enabled` would read "shift on" when what it will
 * actually run is the preset's "shift off". So the preset is resolved first to
 * make the baseline, and the overrides are folded onto that — with
 * `resolveDials` still the only judge of which of them are acceptable, so
 * there is no second copy of the type rules in this file.
 */
export function planDialsView(
  preset: string,
  overrides: Readonly<Record<string, DialValue>>,
): DialsView {
  const source = PRESETS.find((p) => p.key === preset)
  const baseline = resolveDials(source === undefined ? {} : asRecord(source.dials)).dials

  const refused = new Set(resolveDials(overrides).unknown)
  const accepted: Record<string, DialValue> = {}
  for (const [key, value] of Object.entries(overrides)) {
    if (!refused.has(key)) accepted[key] = value
  }
  // Every key in `accepted` passed `resolveDials`, so it names a dial and
  // carries that dial's own type — which is exactly what the spread cannot be
  // shown to the type system.
  const resolved = { ...baseline, ...accepted } as unknown as Dials

  const view = (key: keyof Dials, inert: boolean): DialFieldView => ({
    key,
    value: resolved[key],
    presetValue: baseline[key],
    overridden: resolved[key] !== baseline[key],
    inert,
    kind: typeof DEFAULT_DIALS[key] === 'boolean' ? 'boolean' : 'number',
  })

  const sections = DIAL_SECTIONS.map((section): DialSectionView => {
    const toggle = section.toggle
    // A toggle is never inert: it is the control that turns the rest back on.
    const toggleView = toggle === undefined ? null : view(toggle, false)
    const off = toggleView !== null && toggleView.value === false
    return { section, toggle: toggleView, fields: section.fields.map((f) => view(f, off)) }
  })

  // In the DOCUMENT's order, which is the order the operator wrote them in —
  // `resolveDials` preserves it, and a sorted list would point at rows that
  // are not where it says they are.
  const unknown: DialErrorRow[] = []
  for (const [key, value] of Object.entries(overrides)) {
    if (refused.has(key)) unknown.push({ key, value, reason: refusalReason(key, value) })
  }

  return { preset, presetKnown: source !== undefined, sections, unknown }
}

/** One field row by name, toggles included, or null. For tests and the panel. */
export function fieldOf(view: DialsView, key: string): DialFieldView | null {
  for (const section of view.sections) {
    if (section.toggle !== null && section.toggle.key === key) return section.toggle
    const hit = section.fields.find((f) => f.key === key)
    if (hit !== undefined) return hit
  }
  return null
}

/** One section by its metadata key, or null. */
export function sectionOf(view: DialsView, key: string): DialSectionView | null {
  return view.sections.find((s) => s.section.key === key) ?? null
}

/**
 * WHAT A SAVE SENDS: the keys whose value actually changed, and nothing else.
 *
 * The endpoint is a MERGE — `patchBookDials` `$set`s `dials.<key>` per key —
 * so sending the whole resolved set would write forty dials onto a row that
 * carried three, and every one of them would then be an "override" forever
 * after, pinned against a preset the book could no longer follow.
 *
 * A DELETED KEY IS NOT SENT AS A NULL. Nothing in that endpoint can unset a
 * dial (`null` included, deliberately), so inventing one here would produce a
 * refusal or, worse, a stored `null` the engine refuses on every tick. The
 * panel says so in words instead.
 */
export function dialsPatch(
  stored: Readonly<Record<string, DialValue>>,
  draft: Readonly<Record<string, DialValue>>,
): Record<string, DialValue> {
  const patch: Record<string, DialValue> = {}
  for (const [key, value] of Object.entries(draft)) {
    if (stored[key] !== value) patch[key] = value
  }
  return patch
}

/**
 * ── WHAT A DIAL MEANS, AND WHAT ITS NUMBER READS AS ─────────────────────────
 *
 * Everything below exists for two sections. `Delta lean` arrived as
 * thirty-nine fields plus its master switch in a single `fields` array of raw
 * names (it is forty-eight now), and `Playbook` followed it with fifty-three more
 * behind no switch at all. An operator cannot check a book against the spec
 * from that: `dl_flat_by_min: 900` is 15:00 and nothing on screen said so,
 * `dl_dead_band_lots: 0.5` is half a future's worth of delta,
 * `pb_gap_min_pct: 0.25` is a quarter of ONE PERCENT rather than a quarter of
 * the price, and `dl_day_max_loss` sits in the same undifferentiated row as
 * `dl_min_strike_gap` while being the only one of the two that can lose a lakh.
 *
 * FOUR JUDGEMENTS, and they are here rather than in the component for the
 * same reason the other three are: they are data about the schema, they are
 * wrong in silence when they are wrong, and a pure function can be pinned.
 *
 *   `kind`/`units` — the unit the number is in. The INPUT still shows the raw
 *   number (see `show` in the panel: a setting you cannot type back is not a
 *   setting), so the unit is carried beside it and the readable form — 09:30,
 *   ₹25,00,000, 5 min, 50% — goes in the description. `clock` is for a MINUTE
 *   OF THE DAY only: `pb_calm_min` and `pb_box_min` are minutes of a look-back
 *   and read as plain counts of minutes, never as 00:30.
 *
 *   `help` — one line on what the dial decides, transcribed from the doc
 *   comments in `packages/desk-engine/src/dials.ts`, §5-§9 of the delta-lean
 *   design spec and §8.1 of the six-playbooks spec (v2). The engine's comments
 *   and the spec are the source; this is not a second opinion about what a
 *   dial does.
 *
 *   `risk` — the dials that decide how much money the book can lose
 *   (`dl_day_max_loss`, `dl_stuck_loss`, and in Playbook `pb_lots`,
 *   `pb_trade_max_loss` and `pb_premium_budget`). Everything else in the
 *   section changes how the book trades; these change what it can cost, and
 *   they are marked so a hand does not land on one by accident.
 *
 *   `zeroOff` — the dial's typed off-state IS the number 0 (the playbook
 *   spec's "0 = off"). Its reading says "off" instead of 00:00, ₹0 or 0%: a
 *   `pb_time_exit_min` of 0 printed as 00:00 reads like a close at midnight,
 *   and five of the six playbook presets carry exactly that.
 *
 * A DIAL WITH NO ENTRY IS NOT AN ERROR — it reads as a plain number with no
 * unit and no help, exactly as every dial did before this table existed. The
 * recenter sections are deliberately not covered yet.
 */

/** The unit a dial's number is in, which decides how it reads back. */
export type DialUnitKind =
  | 'clock'
  | 'rupee'
  | 'seconds'
  | 'ms'
  | 'fraction'
  | 'delta'
  | 'lots'
  | 'multiple'
  | 'strikes'
  | 'count'
  | 'plain'

export interface DialMeta {
  readonly kind: DialUnitKind
  /** Shown in the input's own trailing slot, or null for a bare number. */
  readonly units: string | null
  /** One line on what this dial decides, or null when nothing is known. */
  readonly help: string | null
  /** One of the dials that decides how much the book can lose. */
  readonly risk: boolean
  /** 0 is this dial's off-state, so a zero reads "off" (see `readDial`). */
  readonly zeroOff: boolean
}

const UNIT_TEXT: Readonly<Record<DialUnitKind, string | null>> = {
  clock: 'min of day',
  // The venue currency: ₹ on NSE, $ on DX (a "rupee" dial is a money dial).
  rupee: currencySymbol(),
  seconds: 's',
  ms: 'ms',
  // A fraction gets no trailing unit: "0.5 of 1" reads worse than the "= 50%"
  // the description carries.
  fraction: null,
  delta: 'Δ',
  lots: 'lots',
  multiple: '×',
  strikes: 'strikes',
  count: null,
  plain: null,
}

const PLAIN_META: DialMeta = { kind: 'plain', units: null, help: null, risk: false, zeroOff: false }

const meta = (kind: DialUnitKind, help: string, over: Partial<DialMeta> = {}): DialMeta => ({
  kind,
  units: UNIT_TEXT[kind],
  help,
  risk: false,
  zeroOff: false,
  ...over,
})

/**
 * A `Map` rather than an object literal so a stored key of `toString` or
 * `constructor` cannot resolve to `Object.prototype` and be rendered as a
 * dial's units — the same trap `resolveDials` avoids by testing membership
 * against the key list.
 */
const DIAL_META: ReadonlyMap<string, DialMeta> = new Map(
  Object.entries({
    // ── The path selector ───────────────────────────────────────────────────
    // Not a tier's switch like the other four. This one picks which `decide()`
    // the host calls, which is why its off-state makes forty-eight dials inert
    // rather than a handful.
    delta_lean_enabled: meta(
      'plain',
      'Picks the ENGINE, not a tier: on, this book opens one hedged package a day and holds it, adjusting only by adding; off, it runs the recenter path and none of the dials below are read.',
    ),

    // `margin_cap` lives in the shared `risk` section (`target_pnl`,
    // `margin_cap`), not the delta-lean one — but D4 makes it the SPAN-lite
    // ceiling the whole delta-lean package is gated on, so it earns a reading
    // here same as any delta-lean budget dial.
    margin_cap: meta(
      'rupee',
      'The SPAN-lite ceiling on the whole package (open or adjustment). A blocked adjustment is what the stuck exit watches for.',
    ),

    // ── Budget and the four exits ───────────────────────────────────────────
    dl_day_max_loss: meta(
      'rupee',
      'The DISASTER backstop, not a working stop: the book flattens and stays stopped for the session. It is the one exit that fires on a book whose posture is met — the stuck exit cannot.',
      { risk: true },
    ),
    dl_day_target: meta(
      'rupee',
      'Realised plus unrealised. Reaching it closes the book and ends its day — the one exit that is good news. 0 = off.',
      { zeroOff: true },
    ),
    dl_open_lots: meta(
      'lots',
      'CONTRACT lots per leg at open, and the size a pyramid add starts from. Not delta-lots.',
    ),
    dl_stuck_loss: meta(
      'rupee',
      'With the margin cap or the adjustment limit blocking every move, a loss past this arms the stuck exit.',
      { risk: true },
    ),
    dl_stuck_confirm_s: meta(
      'seconds',
      'How long blocked-AND-losing must persist before the stuck exit fires. Either condition clearing resets the clock.',
    ),
    dl_rupee_hold_s: meta(
      'seconds',
      "HOLD BOOKS ONLY: the book backstop and target fire only on a reading that has stood this long — a carried book's first marks after a feed gap can be stale. A flat book acts at once. An intraday book acts on the first mark whatever this says; 0 makes a hold book do the same.",
    ),

    // ── The open ────────────────────────────────────────────────────────────
    // Gates on the day's ONE package and nothing else — no exit or adjustment
    // reads them. At their defaults the book opens on any confirmed trend or
    // quiet, at any time, on any day (delta-lean-zero spec D4).
    dl_open_by_min: meta(
      'clock',
      'The last minute the day\'s package may open, inclusive. Past it, a book that has not opened stands down for the day. 0 = no limit.',
      { zeroOff: true },
    ),
    dl_open_fallback: meta(
      'plain',
      "In dl_open_by_min's own minute, with no confirmed regime to open on, open the quiet package (the condor) anyway — on any reading but unknown. Needs dl_open_quiet; inert while dl_open_by_min is off.",
    ),
    dl_open_trend_up: meta('plain', 'A confirmed trend-up may open the call debit spread. Off, the book waits through it.'),
    dl_open_trend_down: meta('plain', 'A confirmed trend-down may open the put debit spread. Off, the book waits through it.'),
    dl_open_quiet: meta(
      'plain',
      'A confirmed quiet may open the strangle with wings — and so may the fallback. Off, the book sells no condor at all.',
    ),
    dl_expiry_day_only: meta(
      'plain',
      "Open only on the contract's expiry day. Every other day the book idles; the roll creates it only on that morning.",
    ),

    // ── Adjustment gating ───────────────────────────────────────────────────
    dl_adjust_confirm_s: meta(
      'seconds',
      "A regime must hold this long before it justifies the open or an adjustment. The book's patience, in one dial.",
    ),
    dl_adjust_cooldown_s: meta(
      'seconds',
      'Minimum gap between packages. The open counts as the first, so the earliest adjustment is this long after it.',
    ),
    dl_max_adjusts_day: meta(
      'count',
      'Adjustment packages allowed after the open. The open itself is not counted.',
      { units: 'per day' },
    ),
    dl_dead_band_lots: meta(
      'lots',
      'Net book delta inside this of the wanted posture is already met — there is nothing in it worth paying a spread for.',
    ),

    // ── Regime detector ─────────────────────────────────────────────────────
    dl_fast_window_s: meta('seconds', 'Fast window — gives direction.'),
    dl_slow_window_s: meta('seconds', 'Slow window — gives the regime the rules read.'),
    dl_context_window_s: meta(
      'seconds',
      'Context window — never classifies on its own; the detector uses it for confirmation.',
    ),
    dl_context_on: meta('plain', 'Off makes the context window inert and the two-window rules apply unchanged.'),
    dl_trend_mult: meta(
      'multiple',
      'Enter trend: realized displacement over this multiple of the straddle-implied move for the window.',
    ),
    dl_trend_exit_mult: meta(
      'multiple',
      'Leave trend: the ratio must fall back through this. The gap down from dl_trend_mult IS the hysteresis.',
    ),
    dl_clean_min: meta(
      'fraction',
      'Cleanliness floor, |displacement| / range. A big range with no displacement is chop, not trend.',
    ),
    dl_quiet_mult: meta(
      'multiple',
      'Quiet: range inside this multiple of implied for two consecutive windows.',
    ),
    dl_regime_dwell_s: meta('seconds', 'Minimum dwell before a trend may be left at all.'),

    // ── Sizing and strike selection ─────────────────────────────────────────
    dl_long_delta_lo: meta('delta', 'The directional leg: buy no lower than this delta. Also the band an adjustment buys in.'),
    dl_long_delta_hi: meta('delta', 'The directional leg: buy no higher than this delta.'),
    dl_short_delta_lo: meta('delta', 'The trend hedge: sell no lower than this delta.'),
    dl_short_delta_hi: meta('delta', 'The trend hedge: sell no higher than this delta.'),
    dl_credit_short_delta_max: meta('delta', "A quiet open's short sells no closer to spot than this delta."),
    dl_wing_delta: meta('delta', "Delta of the wing bought beyond a quiet open's short. Always bought — a naked sale is not an option."),
    dl_min_strike_gap: meta(
      'strikes',
      'How far from ATM, in strikes, a leg must sit — so a delta band cannot land on ATM by accident on expiry day, when every strike is a steep delta.',
    ),
    dl_neutral_short_delta_lo: meta(
      'delta',
      'The sideways neutralising SALE: sell no lower than this delta. At 0.45-0.60 it is ATM, which carries the same net-delta effect as an ITM sale with more time value and a better book.',
    ),
    dl_neutral_short_delta_hi: meta('delta', 'The sideways neutralising sale: sell no higher than this delta. Raise both to push the sale in the money.'),

    // ── Liquidity and staleness ─────────────────────────────────────────────
    dl_quote_fresh_s: meta('seconds', 'A quote older than this is not a candidate.'),
    dl_max_spread_pct: meta('fraction', 'Widest spread as a share of mid — or dl_max_spread_abs, whichever is larger.'),
    dl_max_spread_abs: meta(
      'rupee',
      'Widest spread in dollars — the floor under dl_max_spread_pct, because 2% of a $3 option is six cents.',
    ),
    dl_spot_stale_s: meta('seconds', 'Spot older than this refuses NEW RISK only; the four exits still run.'),

    // ── Clock and pacing ────────────────────────────────────────────────────
    dl_warmup_min: meta('clock', 'Warm-up ends. The detector runs from the day start but places no order before this.'),
    dl_flatten_passive_min: meta('clock', 'Start flattening passively.'),
    dl_flatten_urgent_min: meta('clock', 'Flatten urgently.'),
    dl_flat_by_min: meta('clock', 'Must be flat. Anything left over goes to the blind ladder.'),
    dl_eval_min_ms: meta('ms', 'The controller loop interval.'),
    dl_max_orders_min: meta('count', 'The per-book order rate the broker imposes.', { units: 'orders/min' }),
    dl_max_orders_s: meta(
      'count',
      'Per-second order budget — enforced by the supervisor host, not the engine.',
      { units: 'orders/s' },
    ),
    dl_max_orders_day: meta(
      'count',
      "The whole day's order budget — enforced by the host. Design ceiling is about twenty.",
      { units: 'orders/day' },
    ),
    dl_hold_to_expiry: meta(
      'plain',
      "Hold to the contract's expiry: the flatten windows above run on expiry day only (before it, the book freezes from the passive slot to the close and carries overnight), the package opens once for the book's life, and the target, backstop and stuck exit end the BOOK, not the day.",
    ),
    // Read by the HOST's chain view, not by the engine (six-playbooks spec F1).
    // A DIAL because it moves every strike a book picks, so it reaches a book
    // only with that book's own row.
    dl_parity_forward: meta(
      'plain',
      "Prices this book's chain off its own expiry's forward — put-call parity across the strikes nearest the index, else the index carried to expiry — instead of the near-month future's mid, so every ATM, delta and band strike is picked off the right number. A book registered before this dial existed keeps the future; the supervisor's DESK_CHAIN_FORWARD=future turns it off for every book at once.",
    ),

    // ══ PLAYBOOK (six-playbooks spec v2 §4-§5, §8.1) ═══════════════════════
    // Every dial below is unread while pb_playbook is 0, and every rupee
    // figure is per TRADE unless it says otherwise — the day's backstop and
    // target are the dl_day_* pair in the Delta lean section. "Dday" is the
    // day's implied move: the ATM straddle scaled to one 375-minute session
    // and fixed at the first reading after 09:16 (spec §4.2).

    // ── Selection and contract ──────────────────────────────────────────────
    pb_playbook: meta(
      'plain',
      'Which playbook this book runs: 0 = none (the engine reads none of the dials below), 1 Trend Drive, 2 Wing Straddle, 3 Reversal Spread, 4 Expiry Drive, 5 Expiry Theta Fly, 6 Expiry Gamma Breakout.',
    ),
    pb_min_dte: meta(
      'count',
      "The contract must have at least this many TRADING days to expiry — the sessions after today up to and including expiry day, holidays removed. 0 allows today's contract; 1 never trades 0-DTE.",
      { units: 'trading days' },
    ),
    pb_expiry_day_only: meta(
      'plain',
      'Trade only when the contract expires today — the three expiry-day books. Off for the intraday ones.',
    ),

    // ── Sizing and the entry window ─────────────────────────────────────────
    pb_lots: meta(
      'lots',
      'CONTRACT lots per leg at entry, and so how big the whole trade is. The frame trims it to what margin_cap allows. Expiry Gamma Breakout ignores it and sizes by pb_premium_budget.',
      { risk: true },
    ),
    pb_entry_start_min: meta(
      'clock',
      'The entry window opens: no new trade before this IST minute, or before the warm-up ends. It gates only a NEW trade — exits, the second stage of a trade already begun, and adds ignore it.',
    ),
    pb_entry_end_min: meta(
      'clock',
      'The entry window closes at this IST minute: a new trade needs the clock inside [start, end).',
    ),
    pb_max_entries: meta(
      'count',
      'Trades per day. The book is done for the day once it has made this many and closed the last.',
      { units: 'per day' },
    ),
    pb_reentry_cooldown_s: meta(
      'seconds',
      'Seconds after an exit before another trade may be considered. Only matters above one trade a day.',
    ),
    pb_confirm_s: meta(
      'seconds',
      'The regime this playbook wants (a trend, or quiet or chop) must have held this long before it justifies an entry.',
    ),
    // PERCENT, not a fraction: 0.25 is a quarter of one percent. `plain` with a
    // '%' unit, because the `fraction` reading would print it as 25%.
    pb_gap_min_pct: meta(
      'plain',
      'Gap gate for the trend books: the opening gap — the open against the previous close, in percent of that close — must be at least this, because a trend book wants a morning that has already moved. 0 = off.',
      { units: '%', zeroOff: true },
    ),
    pb_gap_max_pct: meta(
      'plain',
      'Gap gate for the straddle seller: the opening gap, in percent of the previous close, must be LESS than this, because a seller wants a morning that has not run away. 0 = off.',
      { units: '%', zeroOff: true },
    ),
    pb_retry_s: meta(
      'seconds',
      'No new entry within this long of the last order package the book sent: an open the desk refused or dropped is retried at this pace, not on every pass.',
    ),
    pb_max_gap_min: meta(
      'count',
      "A hole in the index tape longer than this — a feed outage, a restart — marks the day's high and low as incomplete, and any rule that reads them stands down for the day.",
      { units: 'min' },
    ),

    // ── The common exits ────────────────────────────────────────────────────
    pb_trade_max_loss: meta(
      'rupee',
      'The HARD STOP per trade: a trade at or below minus this, held for pb_rupee_hold_s, closes the whole book urgently. The day has its own backstop, dl_day_max_loss.',
      { risk: true },
    ),
    pb_trade_target: meta(
      'rupee',
      'Take profit per trade: a trade at or above this for pb_rupee_hold_s closes the book, worked passively. On a whole debit spread it is capped by pb_target_max_frac. 0 = off.',
      { zeroOff: true },
    ),
    pb_trail_start: meta(
      'rupee',
      'Trade profit that ARMS the trailing floor before pb_late_min; once armed, the trade exits if it falls back to pb_trail_keep of its peak. 0 = no trail in the morning.',
      { zeroOff: true },
    ),
    pb_late_trail_start: meta(
      'rupee',
      'Trade profit that arms the trailing floor from pb_late_min on — less than the morning figure, because winners run late. A floor armed this way trails the peak made since it armed, not the morning\'s best. 0 = off.',
      { zeroOff: true },
    ),
    pb_late_min: meta('clock', 'The IST minute the late trail start takes over.'),
    pb_trail_keep: meta(
      'fraction',
      "Once the trail is armed, exit when the trade's profit falls to this share of its peak: 0.6 keeps 60% of the best it has been.",
    ),
    pb_time_exit_min: meta(
      'clock',
      'Close the trade at this IST minute, passively, and stay out for the rest of the day. 0 = off.',
      { zeroOff: true },
    ),
    pb_stop_hold_s: meta(
      'seconds',
      'How long an INDEX-based stop must hold before it fires, so one bad print is never a stop.',
    ),
    pb_rupee_hold_s: meta(
      'seconds',
      'How long a RUPEE exit must hold before it fires — every stop, the trail, both take profits, and the day backstop and target (the backstop acts at once at 1.25 × its floor) — so one mark off a briefly wide quote is neither a loss nor a profit.',
    ),

    // ── Debit spreads (Trend Drive, Reversal Spread, Expiry Drive) ──────────
    pb_strike_mode: meta(
      'plain',
      'How a debit spread picks its strikes: 0 = delta bands (buy inside the dl_long_delta_lo/hi band, sell further out inside dl_short_delta_lo/hi); 1 = straddle units (buy ATM, sell pb_short_str_k straddles beyond it).',
    ),
    pb_short_str_k: meta(
      'multiple',
      'With pb_strike_mode 1: the sold strike sits at least this many ATM straddles beyond the bought one, and never less than one strike step.',
    ),
    pb_debit_stop_frac: meta(
      'fraction',
      'Exit once the trade has lost this share of the debit paid, held for pb_rupee_hold_s. 0 = off.',
      { zeroOff: true },
    ),
    pb_target_max_frac: meta(
      'fraction',
      "The take profit's ceiling on a whole debit spread: never more than this share of the most the held spread can make (its width × lots × lot size, less the debit), so a dollar target above a narrow spread's maximum still fires. Applies only while the book is exactly one spread with every short held; beside a pyramid's extra long the plain target applies. 0 = off.",
      { zeroOff: true },
    ),
    pb_flip_confirm_s: meta(
      'seconds',
      'The opposite trend, held this long, exits the trade — but only a LOSING one; a winner is left to its trail. 0 = off.',
      { zeroOff: true },
    ),
    pb_max_adds: meta(
      'count',
      'Pyramid adds per trade: one bought option each, and only on a trade already in profit. 0 = no pyramid; there is no uncapped one.',
      { units: 'per trade', zeroOff: true },
    ),
    pb_add_ext_k: meta(
      'multiple',
      "An add needs the index at least this many Dday — the day's implied move — beyond where the trade entered.",
    ),

    // ── Short premium (Wing Straddle, Expiry Theta Fly) ─────────────────────
    pb_wing_str_k: meta(
      'multiple',
      "How far out the fly's protective wings sit, in ATM straddles: this × the straddle ÷ the strike step, rounded, in strikes either side of the centre — or pb_wing_min_steps if that is more.",
    ),
    pb_wing_min_steps: meta(
      'strikes',
      'The least the wings may sit from the centre, in strike steps, so a cheap straddle cannot pull them onto it.',
    ),
    pb_combined_stop: meta(
      'fraction',
      "Exit once the shorts' ask-side value has risen by this share of what they were sold for (0.25 is a 25% stop), held for pb_rupee_hold_s. 0 = off.",
      { zeroOff: true },
    ),
    pb_stop_str_k: meta(
      'multiple',
      'Exit once the index is this many entry straddles away from where it was when the trade opened, held for pb_stop_hold_s. 0 = off.',
      { zeroOff: true },
    ),
    pb_calm_min: meta(
      'count',
      "The calm filter's look-back: the index's range over this many minutes must be within pb_calm_mult × the move they imply, or the fly does not open. 0 = off.",
      { units: 'min', zeroOff: true },
    ),
    pb_calm_mult: meta(
      'multiple',
      'How much range the calm filter tolerates, in multiples of the move implied over pb_calm_min minutes. A normal window runs about twice the implied move, so 1.5 asks for a calmer-than-priced one.',
    ),
    pb_max_move_k: meta(
      'multiple',
      "Skip an entry once the index has moved more than this many Dday — the day's implied move — from the open. 0 = off.",
      { zeroOff: true },
    ),
    pb_target_frac: meta(
      'fraction',
      'Take profit at this share of the credit received (0.5 is half of it), held for pb_rupee_hold_s, worked passively. 0 = off.',
      { zeroOff: true },
    ),
    pb_trend_exit_s: meta(
      'seconds',
      'A NEUTRAL trade exits once the slow regime has been a trend this long: a fly sold into a range is the wrong book in a trend. 0 = off.',
      { zeroOff: true },
    ),

    // ── Staging and the protective legs ─────────────────────────────────────
    pb_stage_abort_k: meta(
      'multiple',
      'Stage-2 abort distance, in ATM straddles: if the index moved further than this between the protective buys and the sale, the package is aborted and what was bought is closed, rather than sold into a different market.',
    ),
    pb_stage_gap_s: meta(
      'seconds',
      "The least time between staged packages: the shorts go out only this long after the protective buys, so the buys' fills are in the book first, and a short that failed to go is re-sent no faster than this.",
    ),
    pb_wing_fresh_s: meta(
      'seconds',
      "How old a PROTECTIVE (bought) leg's quote may be and still be traded — looser than dl_quote_fresh_s, because a far wing prints rarely and a buy cannot leave the book naked.",
    ),
    pb_wing_spread_abs: meta(
      'rupee',
      "The widest spread in dollars at which a PROTECTIVE (bought) leg is still bought — the larger of this, dl_max_spread_abs and dl_max_spread_pct of its mid. Looser than a sale's bar, because the far wing is the fly's protection and quotes wide; buying at the ask costs half the spread.",
    ),

    // ── Reversal Spread ─────────────────────────────────────────────────────
    pb_rev_min_ext: meta(
      'multiple',
      "The morning's excursion from the open — the high above it, or the low below it, whichever is bigger — must be at least this many Dday before a reversal is considered.",
    ),
    pb_rev_retrace: meta(
      'fraction',
      "The share of that excursion the index must have given back, while still on the excursion's side of the open, before the fade is entered: 0.35 is 35%.",
    ),
    pb_rev_stop_k: meta(
      'multiple',
      'The new-extreme stop: exit when the index goes this many Dday beyond the extreme the trade faded, held for pb_stop_hold_s.',
    ),

    // ── Expiry Gamma Breakout ───────────────────────────────────────────────
    pb_box_min: meta(
      'count',
      "The box's length: the index's range over this many minutes, ending five minutes ago, is the box a breakout must clear.",
      { units: 'min' },
    ),
    pb_box_max_k: meta(
      'multiple',
      'The widest the box may be, in multiples of the move implied over its length. A wider range is not a coil, so no breakout is taken from it.',
    ),
    pb_brk_buf_k: meta(
      'multiple',
      'The breakout buffer: the index must clear the box by this many 5-minute implied moves, and the same buffer is what lets the trade out if it falls back inside.',
    ),
    pb_premium_budget: meta(
      'rupee',
      'The premium paid per trade, which IS the most it can lose: lots = this ÷ (ask × lot size), rounded down and capped at pb_gamma_max_lots. Under one lot means no trade.',
      { risk: true },
    ),
    pb_gamma_max_lots: meta('lots', 'The most lots bought, however cheap the option is.'),
    pb_otm_steps: meta(
      'strikes',
      'How many listed strikes beyond the forward the option is bought: 1 is the first strike out of the money.',
    ),
    pb_prem_stop_frac: meta(
      'fraction',
      'The premium stop: exit after losing this share of the premium paid, held for pb_rupee_hold_s. 0 = off.',
      { zeroOff: true },
    ),
    pb_prem_trail_arm: meta(
      'fraction',
      'The premium trail arms once the trade is up this share of the premium paid (0.8 is up 80%); from then it exits if profit falls to pb_trail_keep of its peak.',
    ),

    // ── BULL-S ─────────────────────────────────────────────────────────────
    // USD: BULL-S books are Delta books, and a 'rupee' dial reads in the
    // venue currency ($ on the DX build).
    bs_margin_budget: meta(
      'rupee',
      'Margin budget in USD for the book: a new straddle whose estimated margin would take the book over it is refused. Stops and closes are never blocked. 0 = off.',
      { zeroOff: true },
    ),
  }),
)

/** What is known about one dial's units and intent. Never null: see the header. */
export function dialMeta(key: string): DialMeta {
  return DIAL_META.get(key) ?? PLAIN_META
}

/** `0.30000000000000004` is not a number anybody wrote down. */
const trim = (n: number): string => String(Number(n.toFixed(4)))

const pad = (n: number): string => (n < 10 ? `0${n}` : String(n))

/**
 * MINUTES SINCE MIDNIGHT AS A CLOCK TIME, and a refusal rather than a guess.
 *
 * `dl_flat_by_min: 900` is 15:00 and `dl_warmup_min: 570` is 09:30 — the one
 * fact about this section an operator cannot check by reading the number. A
 * value that is not a minute of a day says so instead of rendering as 25:00,
 * because the reason it is there is almost always a typo.
 */
function clockOf(v: number): string {
  if (!Number.isInteger(v) || v < 0 || v > 1439) {
    return 'NOT a time of day — this dial is minutes since midnight, 0 to 1439'
  }
  return `${pad(Math.floor(v / 60))}:${pad(v % 60)}`
}

const rupeesOf = (v: number): string =>
  `${v < 0 ? '−' : ''}${currencySymbol()}${Math.abs(v).toLocaleString(VENUE.currency === 'USD' ? 'en-US' : 'en-IN')}`

/**
 * The dial's value in the terms the spec states it in, or null when the raw
 * number already reads as itself (a delta of 0.55, 8 flips an hour).
 *
 * Deliberately NOT what the input shows — the input keeps the number the
 * operator has to be able to type back. This is the line under it.
 */
export function readDial(key: string, value: DialValue): string | null {
  if (typeof value !== 'number') return null
  const meta = dialMeta(key)
  // A dial whose off-state is the number 0 says so, rather than "00:00" for a
  // time exit that is not set, "₹0" for a target that is not wanted or "0%"
  // for a stop that is not armed. Checked first, before the unit's own reading.
  if (value === 0 && meta.zeroOff) return 'off'
  switch (meta.kind) {
    case 'clock':
      return clockOf(value)
    case 'rupee':
      return rupeesOf(value)
    case 'seconds':
      // Under a minute the number and its `s` say everything already.
      return value >= 60 ? `${trim(value / 60)} min` : null
    case 'ms':
      return value >= 1000 ? `${trim(value / 1000)} s` : null
    case 'fraction':
      return `${trim(value * 100)}%`
    default:
      return null
  }
}

/**
 * ── THE DELTA-LEAN AND PLAYBOOK SECTIONS, GROUPED THE WAY THE DIAL FILE GROUPS THEM
 *
 * `DIAL_SECTIONS` lists all forty-eight delta-lean fields, and all fifty-three
 * playbook ones, each in a single `fields` array, and the engine file's own
 * comments are what break them up: for delta lean, budget and the exits,
 * adjustment gating, the regime detector, strike selection, liquidity and
 * staleness, clock and pacing; for the playbooks, selection, sizing and the
 * entry window, the common exits, the three kinds of structure, staging, and
 * the two strategy-specific groups. Those comments are load-bearing for a
 * reader and invisible to the panel, so the grouping is restated here — IN THE
 * UI LAYER, so `DIAL_SECTIONS` keeps its shape and the engine's "every dial in
 * exactly one section" test keeps its meaning.
 *
 * THE GROUPING IS TOTAL BY CONSTRUCTION. A dial this table forgot lands in a
 * trailing "Not grouped" group rather than disappearing: a grouping that
 * silently drops a dial is strictly worse than the wall it replaced, because
 * the wall at least showed the knob.
 *
 * GROUPS BELONG TO THEIR SECTION. A delta-lean dial handed to the playbook
 * grouping (or the reverse) is "Not grouped" there, not found in the other
 * section's table — a dial is grouped by the section the engine put it in.
 */
const DELTA_LEAN_SECTION = 'delta-lean'
const PLAYBOOK_SECTION = 'playbook'

interface DialGroupSpec {
  readonly key: string
  readonly label: string
  readonly note: string
  readonly keys: readonly string[]
}

const DELTA_LEAN_GROUPS: ReadonlyArray<DialGroupSpec> = [
  {
    key: 'budget',
    label: 'Budget and the four exits',
    note: 'Nothing closes a leg before the close except these: the flatten windows, the day backstop, the day target, and the stuck rule.',
    keys: ['dl_day_max_loss', 'dl_day_target', 'dl_open_lots', 'dl_stuck_loss', 'dl_stuck_confirm_s', 'dl_rupee_hold_s'],
  },
  {
    key: 'open',
    label: 'The open',
    note: "When, on what and on which day the day's one package may go on. At their defaults the book opens on any confirmed trend or quiet, at any time before the flatten — exits and adjustments never read these.",
    keys: [
      'dl_open_by_min',
      'dl_open_fallback',
      'dl_open_trend_up',
      'dl_open_trend_down',
      'dl_open_quiet',
      'dl_expiry_day_only',
    ],
  },
  {
    key: 'adjust',
    label: 'Adjustment gating',
    note: 'How rarely the book may change its mind: a regime must hold, a cooldown must pass, the day has a ceiling, and the SAME regime never justifies two packages in a row.',
    keys: ['dl_adjust_confirm_s', 'dl_adjust_cooldown_s', 'dl_max_adjusts_day', 'dl_dead_band_lots'],
  },
  {
    key: 'regime',
    label: 'Regime detector',
    note: 'Three windows priced against the ATM straddle: fast gives direction, slow gives the regime the rules read, context confirms.',
    keys: [
      'dl_fast_window_s',
      'dl_slow_window_s',
      'dl_context_window_s',
      'dl_context_on',
      'dl_trend_mult',
      'dl_trend_exit_mult',
      'dl_clean_min',
      'dl_quiet_mult',
      'dl_regime_dwell_s',
    ],
  },
  {
    key: 'strikes',
    label: 'Sizing and strike selection',
    note: 'Delta bands rather than strike offsets, because the same strike is a different delta on Monday and on expiry eve.',
    keys: [
      'dl_long_delta_lo',
      'dl_long_delta_hi',
      'dl_short_delta_lo',
      'dl_short_delta_hi',
      'dl_credit_short_delta_max',
      'dl_wing_delta',
      'dl_min_strike_gap',
      'dl_neutral_short_delta_lo',
      'dl_neutral_short_delta_hi',
    ],
  },
  {
    key: 'liquidity',
    label: 'Liquidity and staleness',
    note: 'What counts as a quote worth trading against, and when a price is too old to take new risk on.',
    keys: ['dl_quote_fresh_s', 'dl_max_spread_pct', 'dl_max_spread_abs', 'dl_spot_stale_s'],
  },
  {
    key: 'clock',
    label: 'Clock and pacing',
    note: "The day timeline in minutes since midnight, the rate the book may act at, whether the book holds to expiry instead of flattening every day, and whether its chain is priced off its own expiry's forward.",
    keys: [
      'dl_warmup_min',
      'dl_flatten_passive_min',
      'dl_flatten_urgent_min',
      'dl_flat_by_min',
      'dl_eval_min_ms',
      'dl_max_orders_min',
      'dl_max_orders_s',
      'dl_max_orders_day',
      'dl_hold_to_expiry',
      // Lifecycle, in the engine file's own grouping.
      'dl_parity_forward',
    ],
  },
]

/**
 * The playbook section, in the order `DIAL_SECTIONS` lists it — which is
 * spec §8.1's order, with the eight dials the spec review added placed in the
 * group each belongs to. The suite pins that the groups, read top to bottom,
 * give the engine's own field order back, so a reordering over there fails
 * here rather than quietly drawing the panel in a second order.
 *
 * `pb_playbook` is the section's off-state AND its first field: there is no
 * switch above it (a boolean beside a 0 would be a second spelling of off), so
 * the first group's note is where the panel says what 0 does.
 */
const PLAYBOOK_GROUPS: ReadonlyArray<DialGroupSpec> = [
  {
    key: 'selection',
    label: 'Selection',
    note: 'Which playbook this book runs, and which contract it may trade. pb_playbook 0 is the off-state: while it is 0 the engine reads none of the other playbook dials.',
    keys: ['pb_playbook', 'pb_min_dte', 'pb_expiry_day_only'],
  },
  {
    key: 'sizing',
    label: 'Sizing and window',
    note: 'How big a trade is, when a new one may open and how often, and the gap and tape checks that must pass first. Exits never wait on the window.',
    keys: [
      'pb_lots',
      'pb_entry_start_min',
      'pb_entry_end_min',
      'pb_max_entries',
      'pb_reentry_cooldown_s',
      'pb_confirm_s',
      'pb_gap_min_pct',
      'pb_gap_max_pct',
      'pb_retry_s',
      'pb_max_gap_min',
    ],
  },
  {
    key: 'exits',
    label: 'Common exits',
    note: "The exits every playbook shares, tried in this order: the hard stop, the trailing floor, the take profit, the time exit. Rupee figures are per trade; the day's own backstop and target are dl_day_max_loss and dl_day_target in Delta lean.",
    keys: [
      'pb_trade_max_loss',
      'pb_trade_target',
      'pb_trail_start',
      'pb_late_trail_start',
      'pb_late_min',
      'pb_trail_keep',
      'pb_time_exit_min',
      'pb_stop_hold_s',
      'pb_rupee_hold_s',
    ],
  },
  {
    key: 'debit',
    label: 'Debit spreads',
    note: 'Trend Drive, Reversal Spread and Expiry Drive: how the spread is struck, the debit stop and the flip exit, and the one capped pyramid add.',
    keys: [
      'pb_strike_mode',
      'pb_short_str_k',
      'pb_debit_stop_frac',
      'pb_target_max_frac',
      'pb_flip_confirm_s',
      'pb_max_adds',
      'pb_add_ext_k',
    ],
  },
  {
    key: 'short',
    label: 'Short premium',
    note: "Wing Straddle and Expiry Theta Fly: where the fly's wings sit, its own stops and take profit, and the calm and move filters that keep it out of a market that is already running.",
    keys: [
      'pb_wing_str_k',
      'pb_wing_min_steps',
      'pb_combined_stop',
      'pb_stop_str_k',
      'pb_calm_min',
      'pb_calm_mult',
      'pb_max_move_k',
      'pb_target_frac',
      'pb_trend_exit_s',
    ],
  },
  {
    key: 'staging',
    label: 'Staging',
    note: 'A package with a short is sent in two stages: the protective buys first, the shorts only once those are held. These set how long it waits, when it gives up, and how stale or wide a protective quote may be.',
    keys: ['pb_stage_abort_k', 'pb_stage_gap_s', 'pb_wing_fresh_s', 'pb_wing_spread_abs'],
  },
  {
    key: 'reversal',
    label: 'Reversal',
    note: 'Reversal Spread: the morning excursion that must have happened, how much of it must be given back, and the new-extreme stop.',
    keys: ['pb_rev_min_ext', 'pb_rev_retrace', 'pb_rev_stop_k'],
  },
  {
    key: 'gamma',
    label: 'Gamma',
    note: 'Expiry Gamma Breakout: the quiet box, the buffer that counts as a break, and the premium budget that caps what one trade can lose.',
    keys: [
      'pb_box_min',
      'pb_box_max_k',
      'pb_brk_buf_k',
      'pb_premium_budget',
      'pb_gamma_max_lots',
      'pb_otm_steps',
      'pb_prem_stop_frac',
      'pb_prem_trail_arm',
    ],
  },
]

/** Where a dial the table forgot goes. Shown, never dropped. */
const UNGROUPED: DialGroupSpec = {
  key: 'ungrouped',
  label: 'Not grouped',
  note: 'These dials are newer than this panel’s grouping. They are shown here so no dial is ever hidden by it.',
  keys: [],
}

/** One grouped section: its groups in order, and which group each dial is in. */
interface SectionGrouping {
  readonly specs: ReadonlyArray<DialGroupSpec>
  readonly groupOf: ReadonlyMap<string, string>
}

const groupingOf = (specs: ReadonlyArray<DialGroupSpec>): SectionGrouping => ({
  specs,
  groupOf: new Map(specs.flatMap((g) => g.keys.map((k): [string, string] => [k, g.key]))),
})

/** Keyed by the engine's section key. A section with no entry is one flat list. */
const GROUPINGS: ReadonlyMap<string, SectionGrouping> = new Map([
  [DELTA_LEAN_SECTION, groupingOf(DELTA_LEAN_GROUPS)],
  [PLAYBOOK_SECTION, groupingOf(PLAYBOOK_GROUPS)],
])

export interface DialGroupView {
  readonly key: string
  /** null for a section the panel draws as one flat list, as it always has. */
  readonly label: string | null
  readonly note: string | null
  readonly fields: readonly DialFieldView[]
}

/**
 * One section's fields, split into the groups the panel draws.
 *
 * Every section but `delta-lean` and `playbook` comes back as a single
 * unlabelled group, which is exactly what it rendered as before — four dials
 * under a heading do not need subheadings, and inventing them would push the
 * corridor an operator came for further down the page.
 *
 * The groups come out in the table's order and each group's dials in the order
 * the fields were handed in (the engine's own), so a section grouped in the
 * engine's order reads in the engine's order from top to bottom.
 */
export function groupFields(
  sectionKey: string,
  fields: readonly DialFieldView[],
): readonly DialGroupView[] {
  const grouping = GROUPINGS.get(sectionKey)
  if (grouping === undefined) {
    return [{ key: sectionKey, label: null, note: null, fields }]
  }
  const bucket = new Map<string, DialFieldView[]>()
  for (const field of fields) {
    const key = grouping.groupOf.get(field.key) ?? UNGROUPED.key
    const held = bucket.get(key)
    if (held === undefined) bucket.set(key, [field])
    else held.push(field)
  }
  const out: DialGroupView[] = []
  for (const spec of [...grouping.specs, UNGROUPED]) {
    const held = bucket.get(spec.key)
    if (held !== undefined && held.length > 0) {
      out.push({ key: spec.key, label: spec.label, note: spec.note, fields: held })
    }
  }
  return out
}
