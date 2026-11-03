/**
 * What the viewer has ticked on a book, kept in memory per stock.
 *
 * The Analysis and Scenario sub-tabs are separate `BOOK_SUBTABS` entries, so each
 * unmounts when the other is shown; a module-level store lets both read one set
 * of exclusions, illiquid marks and IV overrides, and lets each tab find its own
 * inputs — the Scenario tab's hypothetical rows among them — where it left them.
 * Never persisted — a reload starts clean — and never sent anywhere but the
 * tab's own request.
 */

import { useCallback, useSyncExternalStore } from 'react'
import type { GapInput, VolBasis } from '../../../traders/src/analytics/wire.ts'
import type { Units } from './units.tsx'

export interface ViewerState {
  readonly exclude: readonly string[]
  readonly illiquid: readonly string[]
  readonly ivOverrides: Readonly<Record<string, number>>
}

const EMPTY: ViewerState = { exclude: [], illiquid: [], ivOverrides: {} }

/**
 * The Analysis tab's own inputs on a book. Kept here, not in the tab, so a
 * sub-tab switch keeps them: a future frozen by Stop holds until Start.
 */
export interface AnalysisInputs {
  readonly expiry: string | null                    // the month tab; null = All
  readonly callVol: number; readonly putVol: number  // vol points
  readonly future: number | null                    // the override; null = the live future
  readonly gap: readonly GapInput[]; readonly gapUseLtp: boolean; readonly gapUseVol: boolean; readonly volBasis: VolBasis
  readonly online: boolean                          // Online Update
}

export const ANALYSIS_START: AnalysisInputs = {
  expiry: null, callVol: 0, putVol: 0, future: null,
  gap: [{ movePct: 10, volPts: -10 }, { movePct: -10, volPts: -10 }], gapUseLtp: true, gapUseVol: true, volBasis: 'future',
  online: true,
}

/** The server's limit on hypothetical legs in one scenario. */
export const MAX_HYPOTHETICAL = 20

/** VolHedge's C/P/F column, plus a share: the row's instrument and option type in one pick. */
export type RowKind = 'C' | 'P' | 'F' | 'EQ'

/**
 * One hypothetical row of the Scenario tab, as the viewer typed it. It joins
 * the scenario request (`toHypothetical` in `hypothetical-rows.tsx`) once
 * complete; it never joins the book.
 */
export interface HypoRow {
  readonly id: string                // [A-Za-z0-9_-]{1,32}: `h<n>` typed here, `w<n>` from `openWhatIf`
  readonly kind: RowKind | null      // null until picked
  readonly expiry: string            // '' for a share or until picked
  readonly strike: number | null     // options only
  readonly size: number | null       // as typed: lots of `lot` shares, or shares when `lot` is null
  readonly lot: number | null        // the lot size `size` counts in; null = `size` is shares
  readonly price: number | null      // Rate; null = the server's (LTP, or the model price)
  readonly volPts: number | null     // Vol(%) in vol points; null = the market IV
}

/**
 * The Scenario tab's inputs on a book. A null field is one the viewer has not
 * set (or cleared): it is left out of the request, the server computes its
 * default and echoes it in `resolved`, and the input shows that.
 */
export interface ScenarioInputs {
  readonly spot: number | null                                    // CMP
  readonly callVolShift: number | null; readonly putVolShift: number | null; readonly volShift: number | null   // vol points
  readonly start: string | null; readonly end: string | null      // Start, Exp
  readonly everyNth: number | null                                // Every Nth day
  readonly middle: number | null; readonly stepPct: number | null; readonly count: number | null   // M.Strike, Interval, Strike +/-
  readonly targetDate: string | null                              // the payoff chart's date slider (Task 17)
  readonly rows: readonly HypoRow[]
  readonly seq: number                                            // the next typed row is `h<seq>`
  readonly from: string | null                                    // `openWhatIf`'s label
  // What is shown, never sent:
  readonly metric: string                                         // the grid's metric tab
  readonly hidden: readonly string[]                              // grid columns unticked, by label
  // From the last answer, so a remounted tab's first request counts lots in it:
  readonly lotSize: number | null                                 // the book's; null until one answer has come
}

export const SCENARIO_START: ScenarioInputs = {
  spot: null, callVolShift: null, putVolShift: null, volShift: null, start: null, end: null, everyNth: null,
  middle: null, stepPct: null, count: null, targetDate: null,
  rows: [], seq: 1, from: null, metric: 'Profit & Loss', hidden: [], lotSize: null,
}

const books = new Map<string, ViewerState>()
const analysisInputs = new Map<string, AnalysisInputs>()
const scenarioInputs = new Map<string, ScenarioInputs>()
let units: Units = 'position'
const listeners = new Set<() => void>()

function emit(): void { for (const l of listeners) l() }
function subscribe(l: () => void): () => void {
  listeners.add(l)
  return () => { listeners.delete(l) }
}

function update(stock: string, f: (s: ViewerState) => ViewerState): void {
  books.set(stock, f(books.get(stock) ?? EMPTY))
  emit()
}

const toggled = (list: readonly string[], key: string): readonly string[] =>
  list.includes(key) ? list.filter((k) => k !== key) : [...list, key]

export function useUnits(): { units: Units; setUnits(u: Units): void } {
  const u = useSyncExternalStore(subscribe, () => units)
  const setUnits = useCallback((next: Units) => { units = next; emit() }, [])
  return { units: u, setUnits }
}

export function useViewer(stock: string): {
  state: ViewerState; toggleExclude(key: string): void; toggleIlliquid(key: string): void
  setIv(key: string, iv: number | null): void; units: Units; setUnits(u: Units): void
} {
  const state = useSyncExternalStore(subscribe, () => books.get(stock) ?? EMPTY)
  const { units: u, setUnits } = useUnits()
  const toggleExclude = useCallback((key: string) => update(stock, (s) => ({ ...s, exclude: toggled(s.exclude, key) })), [stock])
  const toggleIlliquid = useCallback((key: string) => update(stock, (s) => ({ ...s, illiquid: toggled(s.illiquid, key) })), [stock])
  const setIv = useCallback((key: string, iv: number | null) => update(stock, (s) => {
    const { [key]: _drop, ...rest } = s.ivOverrides
    return { ...s, ivOverrides: iv === null ? rest : { ...rest, [key]: iv } }
  }), [stock])
  return { state, toggleExclude, toggleIlliquid, setIv, units: u, setUnits }
}

export function useAnalysisInputs(stock: string): { inputs: AnalysisInputs; patch(p: Partial<AnalysisInputs>): void } {
  const inputs = useSyncExternalStore(subscribe, () => analysisInputs.get(stock) ?? ANALYSIS_START)
  const patch = useCallback((p: Partial<AnalysisInputs>) => {
    const now = analysisInputs.get(stock) ?? ANALYSIS_START
    // a control re-reporting the value it already has (an input losing focus in the Adjust panel) changes nothing:
    // no new inputs object, so no new request
    if (Object.entries(p).every(([k, v]) => Object.is(now[k as keyof AnalysisInputs], v))) return
    analysisInputs.set(stock, { ...now, ...p })
    emit()
  }, [stock])
  return { inputs, patch }
}

/** A change to the Scenario inputs: the fields to set, or a function of the current inputs that returns them. */
export type ScenarioPatch = Partial<ScenarioInputs> | ((now: ScenarioInputs) => Partial<ScenarioInputs>)

/** Change a book's Scenario inputs; also callable from outside a component (`openWhatIf`). */
export function patchScenario(stock: string, p: ScenarioPatch): void {
  const now = scenarioInputs.get(stock) ?? SCENARIO_START
  scenarioInputs.set(stock, { ...now, ...(typeof p === 'function' ? p(now) : p) })
  emit()
}

export function useScenarioInputs(stock: string): { inputs: ScenarioInputs; patch(p: ScenarioPatch): void } {
  const inputs = useSyncExternalStore(subscribe, () => scenarioInputs.get(stock) ?? SCENARIO_START)
  const patch = useCallback((p: ScenarioPatch) => patchScenario(stock, p), [stock])
  return { inputs, patch }
}
