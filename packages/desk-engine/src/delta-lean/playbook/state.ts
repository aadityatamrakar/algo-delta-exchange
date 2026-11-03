/**
 * `hydratePlaybookState` — THE ONE DOOR `RuleState.pb` COMES BACK THROUGH
 * (six-playbooks spec §4.4).
 *
 * A stored state row is whatever wrote it: this build, a build from before
 * the playbooks existed (no `pb` at all), or an operator in the shell. A cast
 * would hand the frame `undefined` for every field the writer did not know —
 * and the frame branches on these. An `undefined` `exiting` stops re-sending
 * an exit that has not finished; an `undefined` `stage` sells a package's
 * shorts twice or never. So the row is read FIELD BY FIELD, exactly as the
 * state store reads the rest of `RuleState` (`apps/supervisor/src/state-
 * store.ts`, `hydrateRuleState`), which calls this for its `pb`:
 *
 *   - a number must be a FINITE number, a string a string, a boolean a
 *     boolean, or the field takes its `EMPTY_PLAYBOOK_STATE` zero. Nothing is
 *     coerced: `'1'` for a count and `1` for a flag are typos, and coercing
 *     them turns a typo into a latch nobody set;
 *   - the two enums are NARROWED, never cast: a side or an urgency the frame
 *     does not know reads as `''`, its "none";
 *   - a `planShorts` entry that is not `{ strike, optType, cover }` with a
 *     finite strike, `'CE'`/`'PE'` and a finite cover strike is DROPPED, not
 *     zero-filled: a stage-2 sale read as `strike: 0` would route an order
 *     for a strike that is not listed, and one read as `cover: 0` would be
 *     checked against a protective leg that cannot exist;
 *   - an unknown key is ignored, and the result's keys are in
 *     `EMPTY_PLAYBOOK_STATE` order whatever order the row stored them in —
 *     `sameRuleState` is `JSON.stringify` equality, so a hydrated row must
 *     stringify exactly as the state it was written from, or every pass after
 *     a restart reads as a state change.
 *
 * So a row from an old build reads as a playbook that has not traded today,
 * and a row written mid-trade reads as that trade (review focus 3).
 *
 * PURE: no clock, no IO.
 */
import { EMPTY_PLAYBOOK_STATE, type OptType, type PlaybookState } from '../../types.ts';

const E = EMPTY_PLAYBOOK_STATE;

const num = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback;
const str = (v: unknown, fallback: string): string => (typeof v === 'string' ? v : fallback);
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback);
const obj = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

function side(v: unknown): PlaybookState['side'] {
  return v === 'up' || v === 'down' || v === 'none' ? v : '';
}

function urgency(v: unknown): PlaybookState['exitUrgency'] {
  return v === 'passive' || v === 'urgent' || v === 'ladder' ? v : '';
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function planShorts(v: unknown): PlaybookState['planShorts'] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((entry): Array<{ strike: number; optType: OptType; cover: number }> => {
    const e = obj(entry);
    if (e === null) return [];
    const strike = e['strike'];
    const optType = e['optType'];
    const cover = e['cover'];
    if (!finite(strike) || !finite(cover)) return [];
    if (optType !== 'CE' && optType !== 'PE') return [];
    // The three fields and nothing else: an extra key would ride into every
    // later state and every journal row.
    return [{ strike, optType, cover }];
  });
}

export function hydratePlaybookState(raw: unknown): PlaybookState {
  const d = obj(raw) ?? {};
  return {
    dayOpen: num(d['dayOpen'], E.dayOpen),
    dayHigh: num(d['dayHigh'], E.dayHigh),
    dayLow: num(d['dayLow'], E.dayLow),
    statsFromMs: num(d['statsFromMs'], E.statsFromMs),
    statsLastMs: num(d['statsLastMs'], E.statsLastMs),
    maxGapMs: num(d['maxGapMs'], E.maxGapMs),
    dayImplied: num(d['dayImplied'], E.dayImplied),
    entries: num(d['entries'], E.entries),
    tradeOpenMs: num(d['tradeOpenMs'], E.tradeOpenMs),
    side: side(d['side']),
    stage: num(d['stage'], E.stage),
    planShorts: planShorts(d['planShorts']),
    planLots: num(d['planLots'], E.planLots),
    stageMs: num(d['stageMs'], E.stageMs),
    stageSpot: num(d['stageSpot'], E.stageSpot),
    stageReadyMs: num(d['stageReadyMs'], E.stageReadyMs),
    entrySpot: num(d['entrySpot'], E.entrySpot),
    entryStr: num(d['entryStr'], E.entryStr),
    entryExtreme: num(d['entryExtreme'], E.entryExtreme),
    boxHi: num(d['boxHi'], E.boxHi),
    boxLo: num(d['boxLo'], E.boxLo),
    basePnl: num(d['basePnl'], E.basePnl),
    peakPnl: num(d['peakPnl'], E.peakPnl),
    trailArmed: bool(d['trailArmed'], E.trailArmed),
    adds: num(d['adds'], E.adds),
    condSinceMs: num(d['condSinceMs'], E.condSinceMs),
    rupeeSinceMs: num(d['rupeeSinceMs'], E.rupeeSinceMs),
    exiting: bool(d['exiting'], E.exiting),
    exitReason: str(d['exitReason'], E.exitReason),
    exitUrgency: urgency(d['exitUrgency']),
    exitMs: num(d['exitMs'], E.exitMs),
    doneForDay: bool(d['doneForDay'], E.doneForDay),
    lastExitMs: num(d['lastExitMs'], E.lastExitMs),
    // Newer than the first playbook build: a row it wrote has no day-line
    // clock, and reads as neither line holding — the next pass restamps it.
    dayLineSinceMs: num(d['dayLineSinceMs'], E.dayLineSinceMs),
  };
}
