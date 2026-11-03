/**
 * THE PLAYBOOK REGISTRY — `pb_playbook` to strategy (six-playbooks spec §4.1).
 *
 * One table, keyed by each playbook's OWN `id`, so the number a preset writes
 * and the number a strategy answers to cannot disagree: a strategy registered
 * under a key that is not its id would trade under another preset's dials.
 *
 * The frame (`decide.ts`) reads it through `makeDecidePlaybook`, which takes
 * the registry as an argument — so a test registers a scripted playbook under
 * an id of its own, and the production `decidePlaybook` is this table and
 * nothing else. An id with no entry trades nothing (the frame closes whatever
 * such a book holds), which is the answer a build that does not know a
 * playbook must give.
 */
import { EXPIRY_GAMMA } from './gamma-breakout.ts';
import { REVERSAL } from './reversal-spread.ts';
import { EXPIRY_THETA, WING_STRADDLE } from './theta-fly.ts';
import { EXPIRY_DRIVE, TREND_DRIVE } from './trend-spread.ts';
import type { Playbook } from './types.ts';

const ALL: readonly Playbook[] = [TREND_DRIVE, WING_STRADDLE, REVERSAL, EXPIRY_DRIVE, EXPIRY_THETA, EXPIRY_GAMMA];

export const PLAYBOOKS: ReadonlyMap<number, Playbook> = new Map(ALL.map((p) => [p.id, p]));
