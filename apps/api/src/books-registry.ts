/**
 * The desk-books REGISTRY: one row per managed positional book.
 *
 * Distinct from `desk-books` (phase 0's leg-level book, `store.ts`'s
 * `saveBook`/`bookDoc`), which holds what a book actually HOLDS — the legs, the
 * quantities, the entry prices. This registry holds what a book IS — its
 * variant, its dials, and the operator's intent for it — and it is the surface
 * the dashboard's "create a book" form and the Python supervisor's poll loop
 * both read.
 *
 * A book's tag is ALSO registered as a `desk-strategies` row, because
 * `applyDecision` throws `UnknownStrategy` for a tag with no registry row
 * (`service.ts`) — without that second row, the very first decision the new
 * book's supervisor tries to place would 403.
 *
 * `desired` is the operator's intent; `actual` is what the supervisor last
 * reported. They are separate fields because the gap between them is the
 * interesting state — "asked to run, not running" is precisely what an
 * operator needs to see on the page, and a single field cannot say it.
 *
 * A CREATED BOOK STARTS `desired: 'stopped'`, always — the same rule
 * `DEFAULT_STRATEGY` (`strategies.ts`) applies to a newly-added strategy row.
 * Creating a book is never itself a trading permission; the operator switches
 * it on afterwards, deliberately, with `POST .../:tag/start`.
 */

import { DEFAULT_DIALS, resolveDials } from '@algomaker/desk-engine'
import type { DeskMode } from './contract.ts'
import {
  fail,
  isFiniteNumber,
  isIsoDate,
  isNonEmptyString,
  isObject,
  ok,
  type Validated,
} from './validate.ts'

/** The operator's ask, or the supervisor's report — never both meanings in one field. */
export type BookState = 'stopped' | 'running'

export interface BookRow {
  /** The book's key, and the order-bus tag every decision on it arrives under. */
  readonly tag: string
  readonly symbol: string
  readonly expiry: string
  readonly mode: DeskMode
  /** Which entry in the variant catalogue (T6) the supervisor runs this book as. */
  readonly variant: string
  /**
   * The durable NAME a dated book reports under — `NIFTY-delta-lean-aggressive`
   * for every daily `NIFTY-delta-lean-aggressive-YYYY-MM-DD` book. A label, not
   * identity: the tag stays the key. See `book-series.ts`.
   */
  readonly series: string
  /** Tuning knobs handed to the supervisor verbatim. See `validateBookDialsPatch`. */
  readonly dials: Readonly<Record<string, DialValue>>
  /** The operator's intent. */
  readonly desired: BookState
  /** What the supervisor last reported of itself. May lag `desired`. */
  readonly actual: BookState
  /** Epoch ms of the supervisor's last mark, 0 when it has never reported. */
  readonly lastMarkAt: number
  /** Free text: the supervisor's last decision, for the operator's own reading. */
  readonly lastDecision: string
  readonly createdAt: number
  readonly updatedAt: number
}

/**
 * Every field but the book's identity. `desired`/`actual` are BOTH stopped —
 * see the module comment. A caller merges its identity fields on top.
 */
export const DEFAULT_BOOK: Omit<BookRow, 'tag' | 'symbol' | 'expiry' | 'mode' | 'variant' | 'series'> = {
  dials: {},
  desired: 'stopped',
  actual: 'stopped',
  lastMarkAt: 0,
  lastDecision: '',
  createdAt: 0,
  updatedAt: 0,
}

// ----------------------------------------------------------------- creation

export interface BookCreate {
  readonly tag: string
  readonly symbol: string
  readonly expiry: string
  readonly mode: DeskMode
  readonly variant: string
  /** Always present after validation: stated, or `deriveSeries(symbol, variant)`. */
  readonly series: string
  readonly dials: Readonly<Record<string, DialValue>>
}

/** The registry's key charset. A series is grouped over the way a tag is keyed by. */
const KEY_CHARSET = /^[A-Za-z0-9_-]+$/
/** A series is a label in a picker and a query parameter, not a sentence. */
export const SERIES_MAX = 64

/**
 * The series a book reports under when none was stated: `${symbol}-${variant}`.
 *
 * Built from the two FIELDS, never read off the tag. Tags on this desk come in
 * more than one shape (`NIFTY-delta-lean-aggressive-2026-10-01`, and the older
 * `NIFTY-2026-09-22-delta-lean-aggressive`), and the fields are the only
 * statement of what a book is that does not depend on which shape it was born in.
 *
 * The CHARSET CHECK applies to a STATED series only. A derived one carries the
 * symbol as the registry stores it (which is not charset-checked — `M&M` is a
 * real underlying), so it may contain characters a stated series could not.
 * That is harmless: a series is only ever a value in a query string (the web
 * client URL-encodes it) and a Mongo field, never a key embedded in an order
 * id. Refusing the create over it would block registering such a book at all.
 */
export function deriveSeries(symbol: string, variant: string): string {
  return `${symbol}-${variant}`
}

function validateSeries(raw: unknown): Validated<string | undefined> {
  if (raw === undefined) return ok(undefined)
  if (typeof raw !== 'string' || raw === '' || !KEY_CHARSET.test(raw)) {
    return fail('series may contain only letters, digits, underscore and hyphen, and may not be empty')
  }
  if (raw.length > SERIES_MAX) return fail(`series may be at most ${SERIES_MAX} characters`)
  return ok(raw)
}

/**
 * What makes a re-register a CONFLICT rather than a repeat, or null if the
 * incoming create describes the book already on file.
 *
 * Identity is symbol, expiry and variant — the three that decide what the book
 * IS and how it is managed. `dials` are deliberately excluded: they are tuning
 * knobs with their own PATCH, and refusing a re-register because a target
 * changed would put the operator back in the corner this whole path exists to
 * open up. They are also not applied here; the existing row keeps its own.
 *
 * The comparison is what allows the duplicate case to converge instead of
 * refusing. Converging is not overwriting: an identical create is a no-op on
 * the row, and a DIFFERENT one is still refused, because silently re-pointing a
 * book that may already hold a position at another variant is the failure the
 * 409 was right to prevent.
 */
export function bookIdentityConflict(existing: BookRow, create: BookCreate): string | null {
  const differs: string[] = []
  if (existing.symbol !== create.symbol) differs.push(`symbol ${existing.symbol} != ${create.symbol}`)
  if (existing.expiry !== create.expiry) differs.push(`expiry ${existing.expiry} != ${create.expiry}`)
  if (existing.variant !== create.variant) differs.push(`variant ${existing.variant} != ${create.variant}`)
  return differs.length === 0 ? null : differs.join(', ')
}

/**
 * A dial's value. NUMBERS AND BOOLEANS, not numbers alone.
 *
 * Numbers were the whole vocabulary while dials meant `margin_cap` and
 * `target_pnl`. They are not: the playbooks these are handed to carry as many
 * boolean switches as numeric thresholds — `hedge_after_shift`, `no_buy`,
 * `no_close`, `gamma_shorts_only`, `delta_shorts_only` — and a number-only
 * validator rejects every one of them with "must be a finite number", which
 * reads as a bug in the operator's JSON rather than a gap in this type.
 *
 * Still deliberately NOT `unknown`: these are forwarded verbatim to the Python
 * supervisor, so the set stays small enough that both sides agree on it without
 * a schema. Strings and nested objects are refused.
 */
export type DialValue = number | boolean

function validateDials(raw: unknown, label: string): Validated<Record<string, DialValue>> {
  if (raw === undefined) return ok({})
  if (!isObject(raw)) return fail(`${label} must be an object of tuning knobs`)
  const dials: Record<string, DialValue> = {}
  for (const [k, v] of Object.entries(raw)) {
    /*
      A KEY MONGO WOULD READ AS STRUCTURE IS NOT A DIAL.

      `store.patchBookDials` writes one `$set: {'dials.<key>': value}` per knob,
      so a key containing a DOT is stored NESTED — `dials: {shift: {margin: v}}`
      — and `bookFromDoc` keeps only numbers and booleans, which drops the whole
      subtree on the way back out. The dial then vanishes between the write that
      answered 200 and the very next read, which is the "a control that lies
      about having worked" failure the live-dials seam exists to end (F-29).
      A leading `$` is refused for the older reason: it reaches the driver as an
      update operator rather than as a field name.
    */
    if (k.includes('.') || k.includes('$')) {
      return fail(
        `${label}.${k} is not a usable dial name — a key containing '.' or '$' is stored as ` +
          `structure by Mongo and is dropped again on the next read`,
      )
    }
    if (typeof v === 'boolean') {
      dials[k] = v
      continue
    }
    if (!isFiniteNumber(v)) {
      return fail(`${label}.${k} must be a finite number or a boolean`)
    }
    dials[k] = v
  }
  return ok(dials)
}

/**
 * What `POST /v1/desk/books/registry` accepts: REGISTER THIS BOOK, STOPPED.
 *
 * `mode` is required and there is no default — the same rule
 * `validateStrategyCreate` and `validateSeedRequest` apply, for the same
 * reason: guessing paper silently fails to create the live row the operator
 * asked for, guessing live is catastrophic.
 *
 * `desired`/`actual` are NOT accepted. A create that could set either would
 * make "register a book" and "grant it permission to trade" the same act,
 * which is exactly the shortcut `DEFAULT_STRATEGY` closes for strategies.
 */
export function validateBookCreate(raw: unknown): Validated<BookCreate> {
  if (!isObject(raw)) return fail('body must be a JSON object')
  const tag = raw['tag']
  if (!isNonEmptyString(tag)) {
    return fail('tag is required — it is the book\'s key and the order-bus tag every decision arrives under')
  }
  // The tag becomes a strategy tag too (see module comment), so it has to
  // survive being embedded in an order id and a comma-separated allowlist.
  if (!KEY_CHARSET.test(tag)) {
    return fail('tag may contain only letters, digits, underscore and hyphen (it is a key, not a label)')
  }
  const symbol = raw['symbol']
  if (!isNonEmptyString(symbol)) return fail('symbol is required')
  if (!isIsoDate(raw['expiry'])) return fail("expiry is required as 'YYYY-MM-DD'")
  if (raw['mode'] !== 'paper' && raw['mode'] !== 'live') {
    return fail("mode must be stated explicitly as 'paper' or 'live' — it is never defaulted")
  }
  const variant = raw['variant']
  if (!isNonEmptyString(variant)) {
    return fail('variant is required — it names the entry in the variant catalogue the supervisor runs')
  }
  const dials = validateDials(raw['dials'], 'dials')
  if (!dials.ok) return dials
  const series = validateSeries(raw['series'])
  if (!series.ok) return series
  if (raw['desired'] !== undefined || raw['actual'] !== undefined) {
    return fail(
      'a book is always created stopped — start it with POST .../:tag/start once it exists ' +
        '(creating a book and granting it permission to trade are separate acts)',
    )
  }
  return ok({
    tag,
    symbol,
    expiry: raw['expiry'],
    mode: raw['mode'],
    variant,
    series: series.value ?? deriveSeries(symbol, variant),
    dials: dials.value,
  })
}

// --------------------------------------------------------------- dials patch

export interface BookDialsPatch {
  readonly dials: Readonly<Record<string, DialValue>>
}

/**
 * `PATCH .../:tag` accepts dials ONLY — not `desired`, not `variant`.
 *
 * Lifecycle moves through `/start` and `/stop` so it is always an explicit,
 * auditable act; folding it into a general PATCH would let a dials edit that
 * happened to include `desired` silently start a book the operator only meant
 * to retune. `variant` is immutable after creation: changing the playbook
 * underneath a running book is a new book, not an edit to this one.
 */
export function validateBookDialsPatch(raw: unknown): Validated<BookDialsPatch> {
  if (!isObject(raw)) return fail('body must be a JSON object')
  if (raw['dials'] === undefined) {
    return fail('dials is required — this patch changes tuning knobs only, nothing else')
  }
  const dials = validateDials(raw['dials'], 'dials')
  if (!dials.ok) return dials
  if (Object.keys(dials.value).length === 0) return fail('dials must contain at least one knob')
  // `mode` is NOT in this list. It carries no state of its own — it selects
  // WHICH row's dials are being patched, the same way it selects the row for
  // `/start`, `/stop` and `/actual`, so the route can read it out of the same
  // body it validates here.
  // `series` with the identity fields: it is the name a book's history is
  // aggregated under, so renaming it would re-file every day already reported.
  for (const key of ['desired', 'actual', 'variant', 'tag', 'symbol', 'expiry', 'series'] as const) {
    if (raw[key] !== undefined) {
      return fail(`${key} cannot be changed by this patch — it changes dials only`)
    }
  }
  return ok({ dials: dials.value })
}

/**
 * The SECOND half of a dials patch: is each knob one this book actually has?
 *
 * `validateBookDialsPatch` can only judge shape. It cannot tell `target_pnl`
 * from `targetPnl`, and that was F-29's quietest defect: a typo answered 200,
 * sat in Mongo, was pushed to the supervisor, and was silently ignored by the
 * playbook that never heard of it. The operator saw a saved dial and a book
 * that went on doing what it was already doing.
 *
 * WHAT COUNTS AS KNOWN is the union of THE ENGINE'S OWN SCHEMA
 * (`DEFAULT_DIALS`), the variant catalogue's `defaults`, and the dials ALREADY
 * ON THE ROW. Each of the three is there for its own reason:
 *
 *   THE SCHEMA, because it is what actually reads a dial now. The recenter
 *   supervisor is native TypeScript and `packages/desk-engine` states every
 *   field it has; a book built from a PRESET carries only that preset's dials,
 *   so without this the panel could not set `confirm_ms` on a fresh book at
 *   all — the catalogue is a Python publication that is being retired (spec
 *   §5, "the `desk-variants` collection and its publication die"), and gating
 *   the engine's own knobs on it would make the new dials panel unusable the
 *   day that publication stops.
 *
 *   THE CATALOGUE, while it still publishes: a Python variant may carry a knob
 *   the TS schema does not, and that book is still running.
 *
 *   THE ROW, because a key already on it is by definition one this book
 *   carries, whatever the other two currently say. The catalogue is republished
 *   by a process we do not control, so a rename or a missed publish would
 *   otherwise strand the value a live book is running on with no way to change
 *   it.
 *
 * A typo is still refused by all three, which is the point: `targetPnl` is in
 * no schema, no catalogue and on no row.
 *
 * TYPES MUST MATCH what the dial already is. `gamma_shorts_only: 1` and
 * `target_pnl: true` both survive `DialValue` and both mean nothing to the
 * playbook reading them; the current value (or the catalogue's default) is the
 * only statement of which kind a knob is that either side has.
 */
export function validateDialsAgainstCatalogue(input: {
  readonly dials: Readonly<Record<string, DialValue>>
  /** The dials on the row today. */
  readonly current: Readonly<Record<string, DialValue>>
  readonly variant: string
  /** The catalogue row's defaults, or null when it publishes no such variant. */
  readonly defaults: Readonly<Record<string, DialValue>> | null
}): Validated<Record<string, DialValue>> {
  // Schema first, so the two SOURCES OF TRUTH THAT KNOW THIS BOOK — the
  // catalogue and the row — win the type check when they disagree with it. A
  // live book running a knob as a number is running it as a number whatever
  // the schema says it should be, and refusing the operator's edit to it would
  // strand the value rather than correct it.
  const known = new Map<string, DialValue>(Object.entries(DEFAULT_DIALS))
  for (const [k, v] of Object.entries(input.defaults ?? {})) known.set(k, v)
  for (const [k, v] of Object.entries(input.current)) known.set(k, v)

  for (const [key, value] of Object.entries(input.dials)) {
    const existing = known.get(key)
    if (existing === undefined) {
      // The unpublished-catalogue case gets its own sentence: the operator has
      // not mistyped anything, the desk simply cannot say what this variant's
      // knobs are, and the fix is on the supervisor's side, not theirs.
      const why =
        input.defaults === null
          ? `it is not in the engine's dial schema, and the variant catalogue has no entry for ` +
            `'${input.variant}' (the supervisor has not published one) — so only engine dials and ` +
            `dials already set on this book can be edited`
          : `'${input.variant}' has no such dial — it would be stored and then silently ignored ` +
            `by the playbook. Known: ${[...known.keys()].sort().join(', ')}`
      return fail(`dials.${key}: ${why}`)
    }
    if (typeof value !== typeof existing) {
      return fail(
        `dials.${key} is a ${typeof existing} on this book (${JSON.stringify(existing)}), ` +
          `and ${JSON.stringify(value)} is a ${typeof value}`,
      )
    }
  }
  return ok({ ...input.dials })
}

/**
 * THE DIALS THAT CHOOSE THE ENGINE, AND ITS FORWARD (six-playbooks spec §3, F9).
 *
 * Every other dial tunes the engine a book already has. The first two choose
 * WHICH one steers it: `delta_lean_enabled` hands the book between the
 * recenter engine and the delta-lean path, and `pb_playbook` between
 * `decideDeltaLean` and the six playbooks — and between the playbooks. The
 * third, `dl_parity_forward` (spec F1), chooses the forward the book's chain
 * is priced on: flipped under held legs, every delta the book was steered on
 * moves at once — a weekly's parity forward and the near-month future sit
 * 300-odd points apart on SENSEX — and the next pass trades to neutralise a
 * move the market never made. The fourth, `bs_enabled` (Delta spec §6.3),
 * hands the book to the BULL-S path, whose straddles no other engine can
 * manage. The route refuses a change to any of the four while the book holds
 * legs.
 */
export const ENGINE_SWITCH_DIALS = ['delta_lean_enabled', 'pb_playbook', 'dl_parity_forward', 'bs_enabled'] as const

/**
 * The engine switches a dials patch would actually CHANGE — each with the
 * value the engine reads now and the one it would read after the merge.
 *
 * Compared RESOLVED (`resolveDials`, the fold the supervisor applies to every
 * row), never raw: a stored `dials` is an override document, so a recenter
 * row that never stated `delta_lean_enabled` already runs it as `false`, and
 * stating that — as the dials panel does when a copied preset spells the
 * default out (`dialsPatch` diffs raw values) — or restating any value a row
 * already runs on is no switch at all. Pure: the route reads the position,
 * this reads only the two documents.
 */
export function engineSwitchChanges(
  current: Readonly<Record<string, DialValue>>,
  patch: Readonly<Record<string, DialValue>>,
): { readonly key: (typeof ENGINE_SWITCH_DIALS)[number]; readonly before: DialValue; readonly after: DialValue }[] {
  const touched = ENGINE_SWITCH_DIALS.filter((key) => patch[key] !== undefined)
  if (touched.length === 0) return []
  const before = resolveDials(current).dials
  const after = resolveDials({ ...current, ...patch }).dials
  return touched
    .filter((key) => before[key] !== after[key])
    .map((key) => ({ key, before: before[key], after: after[key] }))
}

// -------------------------------------------------------- supervisor report

export interface ActualReport {
  readonly actual: BookState
  readonly lastMarkAt: number
  readonly lastDecision: string
}

/**
 * `POST .../:tag/actual`: the supervisor reporting what it is actually doing.
 *
 * This is the ONLY write path for `actual` — never the dials patch, never
 * `/start`/`/stop`, which only ever move `desired`. Keeping the two writers
 * apart is what makes "asked to run, not running" a fact the registry can
 * actually hold, rather than one writer's guess overwriting the other's.
 */
export function validateActualReport(raw: unknown): Validated<ActualReport> {
  if (!isObject(raw)) return fail('body must be a JSON object')
  if (raw['actual'] !== 'running' && raw['actual'] !== 'stopped') {
    return fail("actual must be 'running' or 'stopped'")
  }
  const lastMarkAt = raw['lastMarkAt']
  if (lastMarkAt !== undefined && !isFiniteNumber(lastMarkAt)) {
    return fail('lastMarkAt must be a finite number (epoch ms) when present')
  }
  const lastDecision = raw['lastDecision']
  if (lastDecision !== undefined && typeof lastDecision !== 'string') {
    return fail('lastDecision must be a string when present')
  }
  return ok({
    actual: raw['actual'],
    lastMarkAt: lastMarkAt ?? 0,
    lastDecision: lastDecision ?? '',
  })
}

// ------------------------------------------------------------- persistence

const isBookState = (v: unknown): v is BookState => v === 'running' || v === 'stopped'

/**
 * Read a stored document defensively, exactly like `strategyFromDoc`.
 *
 * EVERY unreadable field falls back to the SAFE value: `desired` and `actual`
 * both fall back to `'stopped'`, because a row half-written by a failed
 * migration or a hand edit is not a permission to trade.
 */
export function bookFromDoc(doc: Record<string, unknown> | null): BookRow | null {
  if (doc === null) return null
  const tag = doc['tag']
  const symbol = doc['symbol']
  const expiry = doc['expiry']
  const mode = doc['mode']
  const variant = doc['variant']
  if (typeof tag !== 'string' || tag === '') return null
  if (typeof symbol !== 'string' || symbol === '') return null
  if (typeof expiry !== 'string' || expiry === '') return null
  if (mode !== 'paper' && mode !== 'live') return null
  if (typeof variant !== 'string' || variant === '') return null

  /*
    NUMBERS AND BOOLEANS — the same set `validateDials` accepts on the way in.

    This read kept the old number-only filter after the writer was widened, and
    the two together are worse than either alone: a boolean dial was accepted,
    stored in Mongo, and then dropped every time the row was read back. So
    `gamma_shorts_only: true` saved cleanly, showed up in the database, never
    appeared in any API response, never reached the supervisor, and the running
    book went on ignoring it — with the desk's own "dials applied" log reporting
    an empty diff, because only the numeric keys ever arrived and those already
    matched. A silently-dropped dial is exactly the failure the live-dials seam
    exists to end, reintroduced one layer down.
  */
  const rawDials = doc['dials']
  const dials: Record<string, DialValue> = {}
  if (isObject(rawDials)) {
    for (const [k, v] of Object.entries(rawDials)) {
      if (typeof v === 'boolean') dials[k] = v
      else if (typeof v === 'number' && Number.isFinite(v)) dials[k] = v
    }
  }

  // A row written before `series` existed has none; it is derived from the
  // row's own fields exactly as a create without one is.
  const storedSeries = doc['series']
  const series =
    typeof storedSeries === 'string' && storedSeries !== '' ? storedSeries : deriveSeries(symbol, variant)

  return {
    tag,
    symbol,
    expiry,
    mode,
    variant,
    series,
    dials,
    desired: isBookState(doc['desired']) ? doc['desired'] : 'stopped',
    actual: isBookState(doc['actual']) ? doc['actual'] : 'stopped',
    lastMarkAt: typeof doc['lastMarkAt'] === 'number' && Number.isFinite(doc['lastMarkAt']) ? doc['lastMarkAt'] : 0,
    lastDecision: typeof doc['lastDecision'] === 'string' ? doc['lastDecision'] : '',
    createdAt: typeof doc['createdAt'] === 'number' ? doc['createdAt'] : 0,
    updatedAt: typeof doc['updatedAt'] === 'number' ? doc['updatedAt'] : 0,
  }
}

// ------------------------------------------------------------ T6: variants

/**
 * One entry in the variant catalogue, as the retired Python supervisor left it.
 *
 * A READ SHAPE ONLY, as of the D9 cutover. `POST /v1/desk/variants` and the
 * validator that guarded it are gone with the process that published them; the
 * engine ships its presets in code (`@algomaker/desk-engine/presets`) and the
 * Build screen reads those. The stored rows stay because they are the only
 * statement of what dials a book registered under a published variant had —
 * `routes/payoff.ts` resolves that book's defaults against them, and the dials
 * PATCH checks an unknown key against them. Both already degrade to
 * "unpublished" for a variant the catalogue does not carry, so a catalogue that
 * stops growing costs nothing.
 *
 * `decider` distinguished the rule-engine variants an unattended book could run
 * from `llm`/`hybrid` ones that shelled out to the `claude` CLI. Kept on the
 * read shape because the stored documents carry it.
 */
export interface VariantRow {
  readonly key: string
  readonly decider: string
  readonly playbook: string
  readonly defaults: Readonly<Record<string, DialValue>>
}
