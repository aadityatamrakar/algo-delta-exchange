/**
 * THE PYTHON CTX, TRANSLATED — one place, so every parity suite disagrees with
 * Python about the RULES and never about the INPUTS.
 *
 * `scripts/gen-decision-fixtures.py` froze twelve `recenter*` playbooks over a
 * deterministic grid: 16 sequences per preset, 6 consecutive 5-minute marks per
 * sequence, `{ctx, decision, state_after}` per mark with `ctx.state` threaded
 * from the previous mark's `state_after`. This file turns one of those `ctx`
 * dicts into an `EngineInputs`, and the sequence's `seed.params` into `Dials`.
 *
 * Read `.superpowers/sdd/2026-08-21-recenter-supervisor-migration/
 * ticket-02-report.md` before changing anything here. Four facts from it are
 * load-bearing, and each is a silent wrong answer if it is forgotten:
 *
 *   1. THE GENERATOR PATCHED THE BUILDERS' CTX. `_ctx` hard-codes net gamma to
 *      0.0 and `_chain_rows` emits price and delta only, which makes every
 *      recenter variant answer "no convexity to centre" to every mark. The
 *      script therefore supplies gamma on the chain rows, per leg and on `net`;
 *      `gross_mtm` per leg (the only basis `_rc_recycle_loss` reads); and
 *      `ctx["playbook"]`, which the live engine stamps and without which
 *      `recenter_shift` guesses its own label. So a fixture leg carries greeks
 *      the chain quote alone cannot reproduce — see §2.
 *   2. `seed.params` IS THE PLAYBOOK'S WHOLE DIAL DICT. The TS side keeps no
 *      copy of the Python defaults, so a dial changing in Python surfaces as a
 *      parity DIFF rather than as a silent disagreement. `adaptDials` maps that
 *      dict and nothing else.
 *   3. THE REGISTRY IS `P.REGISTRY`, and it maps twelve keys onto TWO
 *      functions. `seed.fn` is `recenter` or `recenter_shift`, and it — not any
 *      dial — is what decides whether phase S exists for a preset. That is what
 *      `shift_enabled` encodes here.
 *   4. THE MARKET IS FROZEN INSIDE A SEQUENCE. Spot, chain and book are
 *      identical at all six marks; only `time` and `state` move. Any difference
 *      between mark 1 and mark 6 is the rule's own state, which is the point of
 *      recording sequences at all.
 *
 * ── §1. GREEKS: THE LEGS ARE EXACT, AND THE CHAIN IS HANDED OVER WHOLE ──────
 * A fixture leg's `delta`/`gamma` are already `sign x shares`-scaled (Python's
 * `leg_greeks` folds both in, `optimizer/legs.py:75-102`). `LegView` carries
 * UNSIGNED per-share magnitudes with the signs re-applied by the consumer
 * (`corridor.ts` §1), so the adapter divides out the shares and takes the
 * magnitude — and `corridor()` then reproduces `K.net_delta` / `K.net_gamma`
 * to the bit.
 *
 * The CHAIN cannot be reproduced that way. `ChainSnap` carries QUOTES and the
 * engine re-derives every strike greek from the mid through a Black-76 IV solve
 * (`marking.ts`), while the fixture rows carry the generator's own
 * `Γ = φ((K−S)/W)/W` kernel beside a price. Measured on the 330 CE of
 * `rally-itm-margin-armed` (spot 330, dte 20): delta 0.5066 solved against the
 * row's 0.5000 (+1.3%), gamma 0.026254 against 0.028692 (−8.5%).
 *
 * That was harmless for phase S — the rolled greeks are never compared — and is
 * NOT harmless for phase R, which sizes real packages off the number:
 * `lots = round(remaining / (dps x lotSize))`. A 1.3% error on `dps` lands on a
 * rounding boundary sooner or later, and the resulting parity failure would be
 * pricing-model noise wearing the costume of a logic defect.
 *
 * So `adaptInputs` hands the RECORDED rows over as
 * `EngineInputs.strikeGreeksOverride` and the engine consults them first
 * (`marking.ts`'s `greekReader`, `pricing: 'parity'` only). `_chain_greek`
 * reads delta and gamma from a row INDEPENDENTLY and this reader is
 * both-or-null, which narrows in the conservative direction: a half-greek row
 * would drop the strike from the candidate set rather than size off half a
 * measurement. No recorded row is half-greek, so the two agree over the set.
 *
 * ── §1b. THE DECLARED NET — RESOLVED BY REGENERATION ────────────────────────
 * `K.net_delta` / `K.net_gamma` read `marked_book["net"][...]`, a DECLARED
 * figure on the ctx rather than a sum over the legs (`conditions.py:159-171`).
 * `corridor()` has no declared net to read: it sums the legs, by design,
 * because a declared total that contradicts its own legs is exactly the
 * absent-vs-declared ambiguity §5 of the spec retires.
 *
 * The first generator run took `net.delta` from the grid row as an independent
 * input and the two disagreed on 1,080 of 1,152 marks, which BLOCKED a phase-R
 * parity suite. The regeneration (`c113d288`) makes the legs the source of
 * truth and asserts the identity as a fourth generator invariant, so the
 * declared aggregate now equals the leg sum on every mark of every file — see
 * the follow-up section of `ticket-02-report.md`, including the grid targets
 * that had to change because they were physically unbuildable.
 *
 * ── §2. MARGIN: THE FIXTURES HAVE NO PROVENANCE ─────────────────────────────
 * `ctx["margin"]` and `ctx["margin_cap"]` are plain floats. Python had no
 * freshness concept, so the adapter stamps `{source: 'broker', fresh: true}` —
 * the reading under which a recorded decision is reproducible. `pricing:
 * 'parity'` makes `shift.ts` skip the freshness test anyway, so the stamp is
 * belt to that braces rather than the thing the parity depends on.
 *
 * `margin_cap` rides on the CTX in Python and is a DIAL here, so `adaptDials`
 * takes the ctx as well as the seed. Reading it from `seed.params` would find
 * nothing and default to ₹10cr, which silently arms every gate.
 *
 * ── §3. WHAT IS DELIBERATELY DROPPED ────────────────────────────────────────
 * `no_buy` / `no_close` are `RuleEngine` gates, not playbook dials — the
 * generator records the playbook's RAW decision before any of them run, so they
 * have no counterpart in `Dials` and none is invented.
 *
 * `unwind_added_first` / `unwind_entry_book` / `unwind_share` collapse onto the
 * single `unwind_enabled` toggle the TS schema carries, and ONLY THE FIRST OF
 * THE THREE DECIDES IT: Python's gate is `bool(p.get("unwind_added_first"))`
 * (`playbooks.py:3554`) and the other two select arms within a tier that has
 * already armed. `recenter-eod` and `-eod3` ship all three keys with
 * `unwind_added_first: False`, so reading "any of the three is present" — as
 * this file did while only phase S was being replayed — turns the unwind ON for
 * two presets whose whole point is that it is off. Every shipped preset carries
 * `unwind_share: 1.0` and `unwind_entry_book: True`, so the arms they select
 * are the only arms that ever ran (`tiers.ts` §6).
 *
 * PURE: reads the fixture files off disk and nothing else. No clock — `nowMs`
 * is synthesised from `ctx.date` + `ctx.time` so a replay is byte-stable.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  DEFAULT_DIALS,
  EMPTY_RULE_STATE,
  type ChainSnap,
  type Dials,
  type EngineInputs,
  type LegView,
  type OptType,
  type Quote,
  type RuleState,
  type Side,
  type StrikeGreekReader,
  type StrikeQuote,
} from '@algomaker/desk-engine'

// ── the recorded shapes ─────────────────────────────────────────────────────

export interface PyWing {
  readonly price?: number | null
  readonly delta?: number | null
  readonly gamma?: number | null
}

export interface PyChainRow {
  readonly strike: number
  readonly CE?: PyWing | null
  readonly PE?: PyWing | null
}

export interface PyLeg {
  readonly id: string
  readonly instrument: string
  readonly strike: number
  readonly opt_type: OptType
  readonly side: string
  readonly lots: number
  readonly lot_size: number
  readonly entry: number
  readonly ltp?: number | null
  readonly delta?: number | null
  readonly gamma?: number | null
  readonly gross_mtm?: number | null
  readonly expiry?: string | null
  readonly protected?: boolean | number | null
}

export interface PyCtx {
  readonly chain?: { readonly rows?: ReadonlyArray<PyChainRow> | null } | null
  readonly date: string
  readonly dte: number
  readonly margin?: number | null
  readonly margin_cap?: number | null
  readonly marked_book: { readonly legs?: ReadonlyArray<PyLeg> | null }
  readonly playbook: string
  readonly realized_so_far?: number | null
  readonly spot: number
  readonly state: Readonly<Record<string, unknown>>
  readonly time: string
}

export interface PyOpenLeg {
  readonly instrument: string
  readonly side: string
  readonly lots: number
  readonly lot_size: number
  readonly strike: number
  readonly opt_type: OptType
}

export interface PyDecision {
  readonly action: string
  readonly open_legs: ReadonlyArray<PyOpenLeg>
  readonly close_ids: ReadonlyArray<string>
  readonly reason: string
  readonly close_parts?: ReadonlyArray<{ readonly id: string; readonly lots: number }>
  readonly state_commit?: Readonly<Record<string, unknown>>
}

export interface PyMark {
  readonly ctx: PyCtx
  readonly decision: PyDecision
  readonly state_after: Readonly<Record<string, unknown>>
}

export interface PySeed {
  readonly case: string
  readonly fn: string
  readonly playbook: string
  readonly dte: number
  readonly iv: number
  readonly lots: number
  readonly spot: number
  readonly margin_cap: number
  readonly margin_frac: number
  readonly params: Readonly<Record<string, number | boolean | null>>
}

export interface PySequence {
  readonly seed: PySeed
  readonly marks: ReadonlyArray<PyMark>
}

const FIXTURE_DIR = join(import.meta.dirname, 'fixtures', 'decisions')

/**
 * One preset's fixture file, checked only as far as its SHAPE.
 *
 * A deeper validator would restate the generator, which is the copy that drifts
 * (`dials.ts`'s argument, applied to fixtures). The cheap checks below are the
 * ones that turn "the generator was re-run with a renamed key" from an
 * `undefined` deep inside an assertion into one sentence naming the file.
 */
export function loadDecisionFixture(preset: string): ReadonlyArray<PySequence> {
  const path = join(FIXTURE_DIR, `${preset}.json`)
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(`${path}: expected a non-empty array of sequences`)
  }
  for (const seq of parsed as ReadonlyArray<Partial<PySequence>>) {
    if (seq.seed === undefined || !Array.isArray(seq.marks) || seq.marks.length === 0) {
      throw new Error(`${path}: a sequence is missing its seed or its marks`)
    }
  }
  return parsed as ReadonlyArray<PySequence>
}

// ── numbers off a JSON rail ─────────────────────────────────────────────────

const num = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback

/** Python truthiness, which is what every `p.get(...)` and `leg.get(...)` in
 * `playbooks.py` applies: 0, '', null and absent are all false. */
const truthy = (v: unknown): boolean => Boolean(v)

/**
 * IST minutes since midnight from an `HH:MM` mark stamp.
 *
 * Throws rather than defaulting: a mark time the generator never writes means
 * the fixture shape changed, and a silent 0 would price the whole session as
 * pre-open on expiry day.
 */
export function minuteOf(time: string): number {
  const m = /^(\d{2}):(\d{2})$/.exec(time)
  if (m === null) throw new Error(`unparseable mark time ${JSON.stringify(time)}`)
  return Number(m[1]) * 60 + Number(m[2])
}

/**
 * A synthetic, monotone, IST-naive epoch stamp for a mark.
 *
 * `EngineInputs.nowMs` exists for cooldowns and quote ages, and the frozen
 * fixture market has neither. It is derived from the recorded date and time so
 * a replay is byte-stable, and it is deliberately NOT an IST-correct instant —
 * nothing in the engine converts it back to a wall clock (`dateIst` and
 * `minuteOfDay` are separate arguments precisely so nothing has to).
 */
export function markMs(dateIso: string, minute: number): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateIso)
  if (m === null) throw new Error(`unparseable mark date ${JSON.stringify(dateIso)}`)
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) + minute * 60_000
}

/** `actions.py:24-29` exactly: the smallest positive gap between listed
 * strikes, rounded to 4dp, falling back to 5.0 on a chain that cannot say. */
export function chainStep(rows: ReadonlyArray<PyChainRow>): number {
  const ks = rows.map((r) => r.strike).filter((k) => Number.isFinite(k)).sort((a, b) => a - b)
  let best = Infinity
  for (let i = 1; i < ks.length; i += 1) {
    const a = ks[i - 1]
    const b = ks[i]
    if (a === undefined || b === undefined || !(b > a)) continue
    const gap = Math.round((b - a) * 10_000) / 10_000
    if (gap < best) best = gap
  }
  return Number.isFinite(best) ? best : 5
}

/**
 * A recorded price becomes a ONE-SIDED quote: `ltp` set, `bid`/`ask` null.
 *
 * That is the faithful encoding of what Python had — a single float per
 * instrument, the defect `types.ts` §1 exists to retire — and under
 * `pricing: 'parity'` `midOf` reads exactly that float back. Manufacturing a
 * bid/ask pair around it would invent a spread the fixture never recorded and
 * make `pricing: 'live'` silently replayable, which it must not be.
 */
const quoteOf = (price: number | null | undefined, asOf: number): Quote => ({
  bid: null,
  ask: null,
  ltp: typeof price === 'number' && Number.isFinite(price) ? price : null,
  asOf,
})

// ── ctx -> EngineInputs ─────────────────────────────────────────────────────

/** `conditions.py:32-33` — a short is an OPTION whose side is 'sell', case and
 * whitespace insensitive. Every other leg is read as long. */
const sideOf = (raw: string): Side => (raw.trim().toLowerCase() === 'sell' ? 'Sell' : 'Buy')

export function adaptLeg(leg: PyLeg, asOf: number, bookLot: number, iv: number | null): LegView {
  const lots = Math.trunc(num(leg.lots, 0))
  const lotSize = num(leg.lot_size, bookLot)
  const shares = lots * lotSize
  // The recorded greeks are `sign x shares`-scaled; `LegView` wants unsigned
  // per-share magnitudes (§1). A zero-share leg cannot yield one, and neither
  // can an absent greek — both are honestly `hasGreeks: false` rather than 0.
  const hasGreeks =
    shares !== 0 && typeof leg.delta === 'number' && typeof leg.gamma === 'number'
  return {
    instrument: leg.id,
    strike: num(leg.strike, 0),
    optType: leg.opt_type,
    side: sideOf(String(leg.side ?? '')),
    lots,
    lotSize,
    entry: num(leg.entry, 0),
    openedByEngine: !truthy(leg.protected),
    // NO PARITY FIXTURE CARRIES A LEAN. The Python desk had no delta-lean book,
    // so every recorded leg is unstamped by construction — and '' matches no
    // lean, which is exactly what a recenter replay needs it to do.
    leanId: '',
    // `seed.iv` — the ONE vol the generator priced the whole sequence at, and
    // the σ its gamma kernel uses. The fixtures record greeks and never the vol
    // each came from, so this is the sequence's vol rather than the leg's; it
    // is carried only so `hasGreeks: true` beside `iv: null` — a combination
    // `types.ts` reads as "the solve failed" — never occurs. No rule reads it.
    iv: hasGreeks ? iv : null,
    delta: hasGreeks ? Math.abs(num(leg.delta, 0) / shares) : 0,
    gamma: hasGreeks ? Math.abs(num(leg.gamma, 0) / shares) : 0,
    // THE FIXTURES NEVER RECORDED A PER-LEG THETA OR VEGA. The generator wrote
    // `delta` and `gamma` per leg and a book-level `marked_book.net.theta` /
    // `.vega` that is 0.0 on every mark of every board, so there is nothing
    // here to scale down to a per-share number. Zero is therefore what this
    // adapter can honestly produce, and it is safe ONLY because the recenter
    // path this suite replays reads neither greek anywhere — see
    // `marking-greeks.test.ts` for the contract. A future rule on this path
    // that reads theta must regenerate the fixtures rather than trust this 0.
    theta: 0,
    vega: 0,
    hasGreeks,
    // `gross_mtm` is the generator's `(entry - ltp) * shares`, and it is the
    // only P&L basis the Python recycle arm reads.
    mtm: num(leg.gross_mtm, 0),
    exit: quoteOf(leg.ltp, asOf),
  }
}

export function adaptChain(ctx: PyCtx, asOf: number): ChainSnap {
  const rows = ctx.chain?.rows ?? []
  const legs = ctx.marked_book.legs ?? []
  const strikes: StrikeQuote[] = rows.map((r) => ({
    strike: r.strike,
    ce: r.CE === undefined || r.CE === null ? null : quoteOf(r.CE.price, asOf),
    pe: r.PE === undefined || r.PE === null ? null : quoteOf(r.PE.price, asOf),
  }))
  return {
    symbol: ctx.playbook,
    // `actions.py:36-37` — the book's own expiry, first leg that carries one.
    expiry: legs.find((l) => typeof l.expiry === 'string' && l.expiry !== '')?.expiry ?? '',
    step: chainStep(rows),
    lotSize: num(legs.find((l) => num(l.lot_size, 0) > 0)?.lot_size, 1),
    future: quoteOf(ctx.spot, asOf),
    spot: num(ctx.spot, 0),
    strikes,
    asOf,
  }
}

/**
 * `_chain_greek` (`playbooks.py:1790-1802`) as an `EngineInputs` reader: the
 * SIGNED per-share greek recorded on the row, or null when the strike is not on
 * the chain, that wing is absent, or either greek is missing.
 *
 * BOTH-OR-NULL where Python reads the two independently — see §1. Strikes are
 * matched with the same tolerance `marking.ts` uses, though it cannot bite
 * here: every strike a rule names came out of a chain row.
 */
export function adaptGreeks(ctx: PyCtx): StrikeGreekReader {
  const rows = ctx.chain?.rows ?? []
  return (strike, optType) => {
    const row = rows.find((r) => Math.abs(r.strike - strike) <= 1e-6)
    const wing = row === undefined ? null : optType === 'CE' ? row.CE : row.PE
    if (wing === undefined || wing === null) return null
    const { delta, gamma } = wing
    if (typeof delta !== 'number' || typeof gamma !== 'number') return null
    if (!Number.isFinite(delta) || !Number.isFinite(gamma)) return null
    return { delta, gamma }
  }
}

export function adaptInputs(seq: PySequence, mark: PyMark): EngineInputs {
  const { ctx } = mark
  const minuteOfDay = minuteOf(ctx.time)
  const nowMs = markMs(ctx.date, minuteOfDay)
  const chain = adaptChain(ctx, nowMs)
  const rawLegs = (ctx.marked_book.legs ?? []).filter((l) => l.instrument === 'option')
  const iv = typeof seq.seed.iv === 'number' && Number.isFinite(seq.seed.iv) ? seq.seed.iv : null
  const legs = rawLegs.map((l) => adaptLeg(l, nowMs, chain.lotSize, iv))

  const protectedQty: Record<string, number> = {}
  for (const l of rawLegs) {
    if (truthy(l.protected)) protectedQty[l.id] = Math.trunc(num(l.lots, 0))
  }

  return {
    tag: `${seq.seed.playbook}/${seq.seed.case}`,
    mode: 'paper',
    nowMs,
    dateIst: ctx.date,
    minuteOfDay,
    dte: Math.trunc(num(ctx.dte, 0)),
    chain,
    legs,
    protectedQty,
    cumRealized: num(ctx.realized_so_far, 0),
    // §2: no provenance in the fixtures, so the reading under which a recorded
    // decision is reproducible.
    margin: { value: num(ctx.margin, 0), source: 'broker', asOf: nowMs, fresh: true },
    pendingLots: 0,
    repairHold: false,
    pricing: 'parity',
    // §1: the recorded rows, so a replay disagrees with Python about the RULES
    // and never about a Black-76 round trip.
    strikeGreeksOverride: adaptGreeks(ctx),
  }
}

// ── seed.params -> Dials ────────────────────────────────────────────────────

/**
 * The playbook's dial dict, mapped onto the TS schema.
 *
 * Every default below is the one Python's own `p.get(name, default)` supplies
 * at the call site, NOT `DEFAULT_DIALS`' — the relief-r live set is a different
 * book from the boards these fixtures were generated against, and folding the
 * two together is how a parity suite comes to test the defaults instead of the
 * port. `delta_shorts_only`/`gamma_shorts_only` are absent from every recorded
 * preset and so are false here, which is `K.net_delta`/`K.net_gamma` over the
 * whole book (`playbooks.py:2969-2971`, `:3001-3003`).
 */
export function adaptDials(seed: PySeed, ctx: PyCtx): Dials {
  const p = seed.params
  // `playbooks.py:3554` — `bool(p.get("unwind_added_first"))` and nothing else.
  // See §3: the other two keys select arms inside an already-armed tier, and
  // `recenter-eod` ships all three with this one FALSE.
  const unwind = truthy(p['unwind_added_first'])
  const balanceDte = num(p['balance_min_dte'], 0)
  // `p.get("trend_skew")` reads an explicit None as OFF, which is exactly what
  // recenter-reshift ships (`dials.ts` header).
  const skew = p['trend_skew']

  return {
    ...DEFAULT_DIALS,
    delta_tol_pct: num(p['delta_tol_pct'], 0.02),
    delta_shorts_only: truthy(p['delta_shorts_only']),
    gamma_shorts_only: truthy(p['gamma_shorts_only']),
    tol_ref_dte: num(p['tol_ref_dte'], 0),

    // §3 of the file header: the REGISTRY decides whether phase S exists, and
    // `seed.fn` is what it resolved to.
    shift_enabled: seed.fn === 'recenter_shift',
    shift_itm_steps: num(p['shift_itm_steps'], 1),
    shift_land_steps: num(p['shift_land_steps'], 0),
    shift_margin_frac: num(p['shift_margin_frac'], 0),
    // `p.get("hedge_after_shift", True)` — ABSENT means hedge, which is what
    // recenter-atm and recenter-otm do (`playbooks.py:4025`).
    hedge_after_shift: p['hedge_after_shift'] === undefined ? true : truthy(p['hedge_after_shift']),

    min_band_lots: num(p['min_band_lots'], 0),
    no_band_floor: truthy(p['no_band_floor']),

    shed_scan_strikes: num(p['shed_scan_strikes'], 0),
    strikes_out: num(p['strikes_out'], 2),
    min_sell_dte: num(p['min_sell_dte'], 1),
    min_sell_delta: num(p['min_sell_delta'], 0),
    scrap_close_delta: num(p['scrap_close_delta'], 0),

    unwind_enabled: unwind,
    recycle_frac: num(p['recycle_frac'], 0),
    recycle_bank: truthy(p['recycle_bank']),
    recycle_opposite: truthy(p['recycle_opposite']),
    eod_flat_min: num(p['eod_flat_min'], 0),
    trend_enabled: typeof skew === 'number' && Number.isFinite(skew),
    trend_skew: num(skew, 0.5),
    anchor_ema_marks: num(p['anchor_ema_marks'], 0),
    confirm_marks: num(p['confirm_marks'], 0),

    target_pnl: num(p['target_pnl'], 250_000),
    // §2: the cap rides on the CTX in Python, never on the dial dict.
    margin_cap: num(ctx.margin_cap, 0),

    cooldown_s: num(p['cooldown_min'], 0) * 60,
    balance_min_dte: balanceDte,
    balance_enabled: balanceDte > 0,
  }
}

// ── st[...] -> RuleState ────────────────────────────────────────────────────

/**
 * Python's `st` dict onto `RuleState`, absent reading as the explicit
 * zero-value (`types.ts` §2 — that conflation is the trap the type retires).
 *
 * `rc_seen` has NO counterpart: it is a provenance ledger keyed by leg id, and
 * `RuleState.rcStack` is an ordered LIFO of rule-ADDED legs. They are different
 * structures answering different questions, and the port of the recycle arm
 * owns the mapping. The parity suites therefore compare the RAW dicts as well
 * as the adapted state, so a key this function drops cannot hide a divergence.
 */
export function adaptState(raw: Readonly<Record<string, unknown>> | undefined): RuleState {
  const st = raw ?? {}
  const banned = st['scrap_banned']
  return {
    ...EMPTY_RULE_STATE,
    rcCredit: num(st['rc_credit'], 0),
    rcEodDay: typeof st['rc_eod_day'] === 'string' ? st['rc_eod_day'] : '',
    gkAnchor: num(st['gk_anchor'], 0),
    gkStreak: num(st['gk_streak'], 0),
    scrapBanned: Array.isArray(banned) ? banned.map(String) : [],
    targetStreak: num(st['target_streak'], 0),
    targetLocked: truthy(st['target_locked']),
  }
}

// ── the phase-1 record, read back out of Python's own reason ────────────────

export interface ShiftNote {
  readonly lots: number
  readonly optType: OptType
  readonly from: number
  readonly to: number
}

/**
 * `playbooks.py:4019` writes one `shift {lots} {ot} {from}->{to}` note per
 * shifted leg, and `:4165` prefixes those notes to EVERY exit of the function —
 * the `hedge_after_shift` early return and both phase-2 endings alike. So the
 * notes are a complete, ordered record of what phase 1 did, and reading them
 * back is what lets a phase-S-only suite compare against a recorded decision
 * that may also carry a phase-2 open.
 *
 * The pattern is anchored on the digits so a LABEL containing the word — as
 * `recenter-reshift` does — cannot match.
 */
export function shiftNotes(reason: string): ShiftNote[] {
  const out: ShiftNote[] = []
  const re = /shift (\d+) (CE|PE) (-?\d+(?:\.\d+)?)->(-?\d+(?:\.\d+)?)/g
  for (const m of reason.matchAll(re)) {
    out.push({
      lots: Number(m[1]),
      optType: m[2] as OptType,
      from: Number(m[3]),
      to: Number(m[4]),
    })
  }
  return out
}

/**
 * The notes as the merged open package phase S must produce: one entry per
 * (landing strike, wing), in FIRST-NOTE order, lots summed.
 *
 * This is `shift_slot` (`:4011-4018`) restated on the recorded side. Order
 * matters and is asserted, because it is the order the merge itself produces
 * and a set comparison would let a reordered merge through.
 */
export function mergedShiftOpens(
  notes: ReadonlyArray<ShiftNote>,
): Array<{ op: 'open'; strike: number; optType: OptType; side: Side; lots: number }> {
  const out: Array<{ op: 'open'; strike: number; optType: OptType; side: Side; lots: number }> = []
  const slot = new Map<string, number>()
  for (const n of notes) {
    const key = `${n.to}:${n.optType}`
    const at = slot.get(key)
    const found = at === undefined ? undefined : out[at]
    if (at === undefined || found === undefined) {
      slot.set(key, out.length)
      out.push({ op: 'open', strike: n.to, optType: n.optType, side: 'Sell', lots: n.lots })
    } else {
      out[at] = { ...found, lots: found.lots + n.lots }
    }
  }
  return out
}
