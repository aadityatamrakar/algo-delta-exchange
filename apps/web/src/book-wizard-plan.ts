/**
 * THE NEW-BOOK WIZARD'S ARITHMETIC — pure, so every rule it applies can be
 * asserted without rendering a page. `book-wizard.tsx` draws it.
 *
 * BULL-S FIRST (operator, 5 Nov: "focus on bull-s for now, and similar
 * strategy setup like lion-s"). A strategy whose engine places every trade
 * itself, so a book starts EMPTY and is nothing but its dials. The preset is
 * the default for every dial ("can we setup default dials values and user can
 * change if needed"); the create writes the preset plus only what was
 * changed — the same shape every live BULL-S book already carries, with no
 * `target_pnl` / `margin_cap` from the structure builder's two boxes.
 */
import { PRESETS } from '@algomaker/desk-engine/presets'
import type { DeskMode } from './api.ts'
import { expiryClass, settlesAt, type ExpiryClass } from './chain-model.ts'
import {
  fieldOf, groupFields, planDialsView, presetDials, sectionOf,
  type DialFieldView, type DialValue, type DialsView,
} from './dials-plan.ts'

/** The engine section every dial on the wizard's dial step comes from. */
const SECTION = 'bull-s'

// ------------------------------------------------------------------ presets

export interface WizardPreset {
  readonly key: string
  readonly label: string
  /** Which expiries it is meant for — the default expiry is picked by it. */
  readonly expiryClass: ExpiryClass
  readonly jump: number
  /** Strike step x jump: the distance between two levels it sells at. */
  readonly grid: number
  readonly start: number
  readonly step: number
  readonly cap: number
  readonly lossCap: number
}

const num = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback

/** The preset's own key says its class: `bull-s-btc-weekly-2` is a weekly. */
function classOfKey(key: string): ExpiryClass {
  return key.includes('monthly') ? 'monthly' : key.includes('weekly') ? 'weekly' : 'daily'
}

/** Every BULL-S preset, in the engine's order, with the figures its card shows. */
export function bullSPresets(): WizardPreset[] {
  return PRESETS.filter((p) => p.dials.bs_enabled === true).map((p) => {
    const d = p.dials
    const jump = num(d.bs_strike_jump, 1)
    return {
      key: p.key,
      label: p.label,
      expiryClass: classOfKey(p.key),
      jump,
      grid: num(d.bs_strike_step, 0) * jump,
      start: num(d.bs_lots_start, 0),
      step: num(d.bs_lots_step, 0),
      cap: num(d.bs_lots_cap, 0),
      lossCap: num(d.bs_loss_cap, 0),
    }
  })
}

// ----------------------------------------------------------------- expiries

/**
 * The expiries a book can still be built on: settlement (12:00 UTC on Delta)
 * not yet passed. The instrument master keeps a settled expiry listed until
 * its next sync drops it — on 5 Nov the Build page offered 4 Nov, settled the
 * day before, as its default.
 */
export function liveExpiries(list: readonly string[], nowMs: number): string[] {
  return [...list].filter((e) => settlesAt(e) > nowMs).sort()
}

/**
 * The default expiry for a preset: the nearest of its own class. A daily
 * preset takes the nearest of any; a weekly one the nearest Friday (a monthly
 * expiry is a Friday too); a monthly one the nearest last Friday. Falls back
 * to the nearest of any when none of its class is listed, and to '' when
 * nothing is.
 */
export function pickExpiry(live: readonly string[], cls: ExpiryClass): string {
  const fits = (e: string): boolean => {
    const c = expiryClass(e)
    return cls === 'daily' ? true : cls === 'weekly' ? c !== 'daily' : c === 'monthly'
  }
  return live.find(fits) ?? live[0] ?? ''
}

/** The book's tag, as the structure builder has always made it: symbol-expiry-preset[-suffix]. */
export function wizardTag(symbol: string, expiry: string, preset: string, suffix: string): string {
  return [symbol, expiry, preset, suffix.trim()].filter((p) => p !== '').join('-')
}

// -------------------------------------------------------------------- dials

/**
 * Not offered on the dial step: the master switch every BULL-S preset already
 * sets, and the two counters the Books page's buttons raise.
 */
export const WIZARD_HIDDEN: ReadonlySet<string> = new Set(['bs_enabled', 'bs_close_req', 'bs_rearm_req'])

/** Groups the dial step opens folded: their defaults are the tested ones. */
const ADVANCED: ReadonlySet<string> = new Set(['bs-safety'])

/** A plain-words name for every dial the wizard shows. The dial's key is printed under it. */
export const BS_TITLES: Readonly<Record<string, string>> = {
  bs_strike_step: 'Strike step',
  bs_strike_jump: 'Strikes per level',
  bs_grid_listed: 'Use the listed strikes as the grid',
  bs_lots_start: 'First straddle size',
  bs_lots_step: 'Size added per straddle',
  bs_lots_cap: 'Largest straddle',
  bs_max_open: 'Most straddles open at once',
  bs_margin_budget: 'Margin budget',
  bs_stop_mult: 'Stop multiple',
  bs_stop_basis: 'Stop prices off',
  bs_stop_confirm_s: 'Stop confirmation',
  bs_target: 'Book profit target',
  bs_loss_cap: 'Book loss cap',
  bs_after_halt: 'After a target or loss halt',
  bs_enter_on_start: 'Sell on start',
  bs_entry_from_min: 'New straddles from',
  bs_entry_to_min: 'New straddles until',
  bs_entry_weekdays: 'Days new straddles may open',
  bs_no_entry_before_expiry_min: 'No new straddle in the last',
  bs_flat_before_expiry_min: 'Close everything before expiry',
  bs_ref_max_age_s: 'Oldest index price traded on',
  bs_level_cooldown_s: 'Cooldown after a refused entry',
  bs_quote_max_age_s: 'Oldest leg quote trusted',
  bs_stale_exit_s: 'Close a straddle stale for',
}

export interface WizardGroup {
  readonly key: string
  readonly label: string
  readonly note: string
  /** Opens folded. */
  readonly advanced: boolean
  readonly fields: readonly DialFieldView[]
}

/** The dial step: the preset folded with the operator's changes, grouped, every field marked against the preset. */
export function wizardGroups(
  preset: string,
  overrides: Readonly<Record<string, DialValue>>,
): WizardGroup[] {
  const section = sectionOf(planDialsView(preset, overrides), SECTION)
  if (section === null) return []
  const fields = section.fields.filter((f) => !WIZARD_HIDDEN.has(f.key))
  return groupFields(SECTION, fields).map((g) => ({
    key: g.key,
    label: g.label ?? 'BULL-S',
    note: g.note ?? '',
    advanced: ADVANCED.has(g.key),
    fields: g.fields,
  }))
}

/** The fields that differ from the preset, in the order the dial step shows them. */
function changedFields(preset: string, overrides: Readonly<Record<string, DialValue>>): DialFieldView[] {
  return wizardGroups(preset, overrides).flatMap((g) => g.fields.filter((f) => f.overridden))
}

/**
 * WHAT THE CREATE WRITES: the preset's whole dial-set, then each changed dial.
 * A value typed back to the preset's own is not a change and is not written —
 * the Dials panel would otherwise mark it "changed" forever.
 */
export function wizardDials(
  preset: string,
  overrides: Readonly<Record<string, DialValue>>,
): Record<string, DialValue> {
  const out: Record<string, DialValue> = { ...(presetDials(preset) ?? {}) }
  for (const f of changedFields(preset, overrides)) out[f.key] = f.value
  return out
}

export interface WizardChange {
  readonly key: string
  readonly title: string | undefined
  readonly from: DialValue
  readonly to: DialValue
}

/** The review step's list of every dial moved off the preset. */
export function wizardChanges(
  preset: string,
  overrides: Readonly<Record<string, DialValue>>,
): WizardChange[] {
  return changedFields(preset, overrides).map((f) => ({
    key: f.key, title: BS_TITLES[f.key], from: f.presetValue, to: f.value,
  }))
}

// ---------------------------------------------------------------- refusals

/**
 * WHAT EACH DIAL ACCEPTS, in words — the engine's own `BS_RANGES`
 * (`dials.ts`) said back. The engine REFUSES a value outside its range and
 * runs the preset's instead, so a box that silently fell back to 50 when 2.5
 * was typed would be the wizard lying; each refusal is named on its own field
 * and stops the create.
 */
function rangeText(key: string): string {
  const t = BS_TITLES[key] ?? key
  switch (key) {
    case 'bs_stop_mult':
      return 'The stop multiple must be above 1, or each straddle stops out as soon as it opens.'
    case 'bs_lots_start':
      return `${t} must be a whole number of contracts, 1 or more.`
    case 'bs_lots_step':
    case 'bs_lots_cap':
      return `${t} must be a whole number of contracts (0 or more).`
    case 'bs_max_open':
      return `${t} must be a whole number (0 = no limit).`
    case 'bs_strike_jump':
      return `${t} must be 1 or 2.`
    case 'bs_strike_step':
      return 'The strike step must be above 0.'
    case 'bs_stop_basis':
      return `${t} must be 1 (the ask) or 0 (the last price).`
    case 'bs_after_halt':
      return `${t} must be 0 (stay flat) or 1 (re-arm by itself).`
    case 'bs_entry_from_min':
    case 'bs_entry_to_min':
      return `${t} must be a whole minute of the day, 0 to 1440.`
    case 'bs_entry_weekdays':
      return `${t} must be a whole number from 0 to 127.`
    case 'bs_ref_max_age_s':
    case 'bs_quote_max_age_s':
      return `${t} must be above 0 seconds.`
    default:
      return `${t} cannot be negative.`
  }
}

/** Each changed dial the engine would refuse, keyed by dial, with what it accepts. */
export function wizardRefusals(
  preset: string,
  overrides: Readonly<Record<string, DialValue>>,
): ReadonlyMap<string, string> {
  return new Map(planDialsView(preset, overrides).unknown.map((u) => [u.key, rangeText(u.key)]))
}

// ---------------------------------------------------------------- problems

export interface WizardInput {
  readonly preset: string
  readonly overrides: Readonly<Record<string, DialValue>>
  readonly mode: DeskMode
  readonly expiry: string
  readonly tag: string
  /** Every tag already registered in this mode. */
  readonly taken: readonly string[]
}

/**
 * EVERYTHING THAT STOPS A CREATE, in words — empty means it may go.
 *
 * Only the mistakes a book cannot run with: a tag another book holds, a size
 * that is not whole contracts or is past its own cap, an uncapped pyramid (no
 * BTC preset ships one), a stop that fires as soon as it opens, and a LIVE
 * book with no margin budget — which the desk refuses to start
 * (`bull-s-live.ts`), so it is said here rather than at the Start button.
 */
export function wizardProblems(input: WizardInput): string[] {
  const view: DialsView = planDialsView(input.preset, input.overrides)
  const val = (key: string): DialValue | undefined => fieldOf(view, key)?.value
  const n = (key: string): number => num(val(key), 0)
  const title = (key: string): string => BS_TITLES[key] ?? key
  const out: string[] = []

  if (input.expiry === '') out.push('Choose an expiry.')
  if (input.taken.includes(input.tag)) {
    out.push(`A book called ${input.tag} already exists in ${input.mode}. Add a tag suffix to make a new one.`)
  }

  // A value the engine refuses (it would run the preset's instead), named.
  const refused = wizardRefusals(input.preset, input.overrides)
  out.push(...refused.values())

  // Then the rules across dials, on what the engine WOULD run.
  const start = n('bs_lots_start')
  const cap = n('bs_lots_cap')
  if (cap === 0) {
    out.push(`Set a size cap (${title('bs_lots_cap')}): no BTC book runs an uncapped pyramid.`)
  } else if (start > cap) {
    out.push(`The first straddle (${start}) is bigger than the size cap (${cap}).`)
  }
  if (input.mode === 'live' && !(n('bs_margin_budget') > 0)) {
    out.push(
      'A live BULL-S book needs a margin budget above 0 (Margin budget, under Size): the desk refuses to start one without.',
    )
  }
  return out
}
