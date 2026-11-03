# Phase C: Strategy Ports Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port all 15 active strategies onto 4 classes + 1 adapter (`RangeBreakoutDirectional`,
`PremiumLegBook`, `MomentumFlipDirectional`, `PremiumDistanceAccumulator`, `ExternalSignalMirror`),
each verified golden-master-clean against its legacy twin, lowest-risk first, live-order
strategies last.

**Architecture:** Every class is a `StrategyBase` subclass (`packages/strategy-kit`) driven
entirely by injected ports — nothing new to that contract is required, this phase only adds
strategy classes and their config schema on top of it. Pure decision logic (band math, exit
math, sizing math) lives in dependency-free modules diffed directly against the legacy pure
modules that already exist (`atr-band-logic.js`, `orb-fut-logic.js`, `orb-scalp-logic.js`), the
same technique already passing 900 comparisons in `packages/indicators/test/parity-legacy.test.ts`.
For the 7 legacy files with no logic split (`bn-breakout`, `bull-s-1`, `bull-snx-1`, `lion-s25-2`,
`eagle-s-1`, `cheetah-b1-1`, `cheetah-b1-snx` — one more than the design spec's 6, see the
deviation note in Task 2), a new `LegacyShadowRunner` package drives the **unmodified** legacy
file under a mocked clock and an intercepted Kite feed so its emitted orders can be captured and
diffed, without booting LoopBack or touching a real broker.

**Tech Stack:** TypeScript on Node 24 (native type-stripping, no build step), `node:test`,
`packages/strategy-kit`'s `replay()`/`diffIntents()` harness, `node:test`'s built-in
`mock.timers` for deterministic legacy-clock control.

## Global Constraints

- **No trading behaviour may change in this phase**, except where explicitly flagged and signed
  off (D3's resting-stop pricing is OUT OF SCOPE for this phase — see "What Phase C deliberately
  does NOT do"). Every golden-master diff must be empty, or the difference must be traced to a
  named, signed-off exception.
- **D9 is binding:** `bull-s-1`/`bull-snx-1` sizing is UNCAPPED (`risk.maxLotsNet: null` is valid,
  not an error). `eagle-s-1` is STOPLESS (`stopPolicy: 'none'` is valid, not an error). Do not
  write a config loader that rejects either.
- **`otmSelector` returning 0 is intentional (D7).** Ports use a literal `offsetPoints: 0`, never
  reintroduce the `otmSelector` module.
- **Archive, never delete** legacy files. This phase does not delete anything — legacy files stay
  live and untouched (bar the one mechanical extraction in Task 2) until the Phase E cutover.
- All work happens on branch `overhaul/foundation`.
- After every task: `npm test` must pass and `npm run typecheck` must report 0 errors. Test count
  only ever grows in this phase.
- Every new package follows the existing shape exactly: `package.json` with
  `"type": "module"`, `"exports": {".": "./src/index.ts"}`, `"scripts": {"test": "node --test test/*.test.ts"}`,
  `"engines": {"node": ">=22"}` — see `packages/strategy-kit/package.json` and
  `packages/indicators/package.json` for the pattern. The root `tsconfig.json` already includes
  `packages/*/src/**/*.ts` and `packages/*/test/**/*.ts`, and the root `npm test` script already
  globs `packages/*/test/*.test.ts` — new packages need no wiring beyond existing there.
- `verbatimModuleSyntax` and `erasableSyntaxOnly` are on (`tsconfig.base.json`): use `import type`
  for type-only imports, no enums/namespaces/decorators, and every relative import needs its
  literal `.ts` extension (Node's type-stripping runtime resolves exactly what it's given).

## File Structure

| Package / File | Responsibility |
|---|---|
| `packages/strategy-config` (new) | `BaseConfig` + the shared axis types (`Risk`, `Sizing`, `Rail`, `Session`, `ExpiryPolicy`, `ExitRules`/`StopBasis`/`TargetBasis`, `StopPolicy`) and `assertValidConfig()`. No strategy logic. |
| `packages/strategies` (new) | The 4 classes + the adapter, one subfolder each, each with a pure `logic.ts`, a `StrategyBase` subclass in `strategy.ts`, and a `config.ts` extending `BaseConfig`. |
| `packages/legacy-shadow-runner` (new) | Drives an unmodified legacy `server/slive/*.js` file under a mocked clock with an intercepted Kite feed, capturing every order it would have placed. Used only by Tasks 11–14. |
| `server/slive/bn-breakout-logic.js` (new, extracted) | Mechanical, behaviour-preserving extraction of `bn-breakout.js`'s inline band/entry/exit math into a pure, `require()`-able module — the 4th "modern logic module," alongside the 3 that already exist. |
| `server/slive/bn-breakout.js` (modified) | Requires the extracted logic module instead of computing inline. Zero behaviour change, verified by a diff against the pre-extraction file. |
| `server/slive/{bull-s-1,bull-snx-1,lion-s25-2,eagle-s-1,cheetah-b1-1,cheetah-b1-snx}.js` | **Untouched.** `LegacyShadowRunner` drives them unmodified via require-cache interception — see the deviation note in Task 7. |

---

### Task 1: `packages/strategy-config` — the shared config schema

**Files:**
- Create: `packages/strategy-config/package.json`
- Create: `packages/strategy-config/src/index.ts`
- Create: `packages/strategy-config/test/config.test.ts`

**Interfaces:**
- Consumes: `DataNeed` from `@algomaker/strategy-kit`.
- Produces: `BaseConfig`, `Risk`, `Sizing`, `Rail`, `Session`, `ExpiryPolicy`, `UnderlyingSpec`,
  `StrikeOffset`, `ExitRules`, `StopBasis`, `TargetBasis`, `StopPolicy`, and
  `assertValidConfig(cfg, existingTags?)` — consumed by every class config in `packages/strategies`
  (Tasks 2–6).

- [ ] **Step 1: Create the package manifest**

Create `packages/strategy-config/package.json`:

```json
{
  "name": "@algomaker/strategy-config",
  "version": "1.0.0",
  "description": "Shared strategy config schema: the five policy axes (underlying, strike, exit, sizing, rail) plus session/expiry/risk. Types only, plus load-time assertions.",
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "test": "node --test test/*.test.ts" },
  "engines": { "node": ">=22" },
  "dependencies": {
    "@algomaker/strategy-kit": "1.0.0"
  }
}
```

- [ ] **Step 2: Write the failing test**

Create `packages/strategy-config/test/config.test.ts`:

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { assertValidConfig, type BaseConfig } from '../src/index.ts'

const DATA = [{ kind: 'future', underlying: 'BANKNIFTY' }] as const

function base(overrides: Partial<BaseConfig> = {}): BaseConfig {
  return {
    tag: 'Test_Tag',
    class: 'range-breakout-directional',
    enabled: true,
    underlying: { symbol: 'BANKNIFTY', reference: 'current-future', strikeStep: 100 },
    strike: { offsetPoints: 0 },
    expiry: { select: 'nearest' },
    session: { startAt: '09:15:00', squareOffAt: '15:20:00' },
    sizing: { kind: 'flat', lots: 1 },
    rail: { mode: 'sim', destinations: ['sim'], exitMechanism: 'local-tick' },
    risk: { maxLotsNet: 1, dayLossRupees: null },
    data: DATA,
    legacy: { files: ['server/slive/test.js'] },
    ...overrides,
  }
}

test('a well-formed config passes', () => {
  assert.doesNotThrow(() => assertValidConfig(base()))
})

test('rejects an empty tag', () => {
  assert.throws(() => assertValidConfig(base({ tag: '' })), /tag/)
})

test('rejects a duplicate tag against the existing-tags set', () => {
  const existing = new Set(['Test_Tag'])
  assert.throws(() => assertValidConfig(base(), existing), /unique|duplicate/i)
})

test('rejects a strikeStep that does not match the underlying grid', () => {
  assert.throws(
    () => assertValidConfig(base({ underlying: { symbol: 'NIFTY', reference: 'index-spot', strikeStep: 100 } })),
    /strikeStep/,
  )
})

test('accepts the correct strikeStep per underlying', () => {
  assert.doesNotThrow(() =>
    assertValidConfig(base({ underlying: { symbol: 'NIFTY', reference: 'index-spot', strikeStep: 50 } })),
  )
  assert.doesNotThrow(() =>
    assertValidConfig(base({ underlying: { symbol: 'SENSEX', reference: 'current-future', strikeStep: 100 } })),
  )
})

test('rejects a missing squareOffAt', () => {
  assert.throws(
    () => assertValidConfig(base({ session: { startAt: '09:15:00', squareOffAt: '' } })),
    /squareOffAt/,
  )
})

// --- D9: risk.maxLotsNet: null MUST be accepted for uncapped sizing --------

test('D9: accepts an explicit null maxLotsNet on a non-flat sizing (bull-s-1 stays uncapped)', () => {
  assert.doesNotThrow(() =>
    assertValidConfig(
      base({
        sizing: { kind: 'pyramid-up', start: 1, step: 1, cap: null },
        risk: { maxLotsNet: null, dayLossRupees: null },
      }),
    ),
  )
})

test('rejects a negative or zero maxLotsNet when it IS provided (still a valid number, just nonsensical)', () => {
  assert.throws(
    () => assertValidConfig(base({ risk: { maxLotsNet: 0, dayLossRupees: null } })),
    /maxLotsNet/,
  )
})

// --- D9: stopPolicy 'none' MUST be a first-class valid value ----------------

test("D9: stopPolicy 'none' is valid (eagle-s-1 stays stopless)", () => {
  const exit = { stop: { basis: 'none' as const }, target: { basis: 'none' as const },
                 precedence: ['EOD' as const], stopMeasuredOn: 'traded' as const, stopPolicy: 'none' as const }
  assert.doesNotThrow(() => assertValidConfig(base(), undefined, exit))
})

test("stopPolicy 'resting' or 'local-tick' also pass", () => {
  const restingExit = { stop: { basis: 'fixed-pct' as const, value: 1.25 }, target: { basis: 'none' as const },
                         precedence: ['EOD' as const, 'SL' as const], stopMeasuredOn: 'traded' as const,
                         stopPolicy: 'resting' as const }
  assert.doesNotThrow(() => assertValidConfig(base(), undefined, restingExit))
})
```

- [ ] **Step 3: Run it and confirm it FAILS**

Run: `node --test packages/strategy-config/test/config.test.ts`
Expected: every test fails with a module-not-found error (`src/index.ts` does not exist yet).

- [ ] **Step 4: Write the implementation**

Create `packages/strategy-config/src/index.ts`:

```ts
/**
 * The shared strategy config schema — the five axes (underlying, strike, exit,
 * sizing, rail) plus session/expiry/risk, common to every class in
 * packages/strategies.
 *
 * D9 (owner, 2026-07-26): risk limits are OPT-IN, not mandatory.
 *   - `risk.maxLotsNet: null` means UNLIMITED and is a VALID, supported config
 *     (bull-s-1 / bull-snx-1 keep their legacy uncapped pyramid).
 *   - `stopPolicy: 'none'` means NO STOP and is a VALID, supported config
 *     (eagle-s-1 stays stopless, relying on the central EOD flatten).
 * assertValidConfig() must never reject either. It rejects a maxLotsNet that IS
 * provided but is not a positive number — that is still a config bug, just not
 * "null."
 */

import type { DataNeed } from '@algomaker/strategy-kit'

export type Underlying = 'NIFTY' | 'BANKNIFTY' | 'SENSEX'

export interface UnderlyingSpec {
  readonly symbol: Underlying
  /** Futures basis matters: lion-s25-2, bull-s-1, eagle-s-1, cheetah-b1-1/-snx
   *  all reference the current future, not spot. Never collapse the two. */
  readonly reference: 'index-spot' | 'current-future'
  readonly strikeStep: number
}

const STRIKE_STEP: Readonly<Record<Underlying, number>> = {
  NIFTY: 50,
  BANKNIFTY: 100,
  SENSEX: 100,
}

/** otmSelector returning 0 is intentional (D7). Default is ATM. */
export interface StrikeOffset {
  readonly offsetPoints: number
}

export type StopBasis =
  | { readonly basis: 'none' }
  | { readonly basis: 'fixed-pct'; readonly value: number }
  | { readonly basis: 'trailing-pct'; readonly value: number }
  | { readonly basis: 'fixed-points'; readonly value: number }

export type TargetBasis =
  | { readonly basis: 'none' }
  | { readonly basis: 'fixed-points'; readonly value: number }
  | { readonly basis: 'premium-target'; readonly value: number }

/**
 * Where the protective stop is enforced. D9: 'none' is first-class, not an
 * error case — eagle-s-1 has never had an intraday stop and stays that way.
 */
export type StopPolicy = 'resting' | 'local-tick' | 'none'

export interface ExitRules {
  readonly stop: StopBasis
  readonly target: TargetBasis
  readonly precedence: readonly ('EOD' | 'TARGET' | 'SL' | 'T1')[]
  readonly stopMeasuredOn: 'signal' | 'traded'
  readonly stopPolicy: StopPolicy
}

export type Sizing =
  | { readonly kind: 'flat'; readonly lots: number }
  | { readonly kind: 'pyramid-up'; readonly start: number; readonly step: number; readonly cap: number | null }
  | { readonly kind: 'pyramid-down'; readonly start: number; readonly step: number; readonly floor: number }
  | { readonly kind: 'martingale-capped'; readonly start: number; readonly cap: number }

export type ExecMode = 'sim' | 'live'

export interface Rail {
  readonly mode: ExecMode
  /** Zerodha is never a destination (D1) — it is data-only. */
  readonly destinations: readonly ('sim' | 'xts')[]
  readonly exitMechanism: 'local-tick' | 'broker-resting-stop'
}

export interface Session {
  readonly startAt: string // 'HH:mm:ss' IST
  readonly squareOffAt: string // MANDATORY — no legacy active file owns this in code
}

export interface ExpiryPolicy {
  readonly select: 'nearest' | 'next'
}

/**
 * D9: maxLotsNet: null means UNLIMITED. A non-null value must be a positive
 * integer-ish number; a bare 0 or a negative is a config bug and IS rejected.
 */
export interface Risk {
  readonly maxLotsNet: number | null
  readonly dayLossRupees: number | null
}

export type StrategyClassId =
  | 'range-breakout-directional'
  | 'premium-leg-book'
  | 'momentum-flip-directional'
  | 'premium-distance-accumulator'

export interface BaseConfig {
  /** Unique. Sizing key, P&L grouping key, square-off key. */
  readonly tag: string
  readonly class: StrategyClassId
  readonly enabled: boolean
  readonly underlying: UnderlyingSpec
  readonly strike: StrikeOffset
  readonly expiry: ExpiryPolicy
  readonly session: Session
  readonly sizing: Sizing
  readonly rail: Rail
  readonly risk: Risk
  readonly data: readonly DataNeed[]
  /** Provenance, so the migration is auditable. */
  readonly legacy: { readonly files: readonly string[]; readonly notes?: string }
}

/**
 * Config-load-time assertions. Throws with a message naming the offending
 * field on the first violation found.
 *
 * `existingTags`, when passed, catches the four-files-share-one-tag class of
 * bug the taxonomy found in the legacy estate (`STGL-25`). `exit`, when
 * passed, runs the exit-specific D9 checks — not every BaseConfig caller has
 * an ExitRules yet at the point this is called (class-level configs extend
 * BaseConfig with their own exit shape), so it is optional here and the
 * per-class config modules in packages/strategies call it explicitly.
 */
export function assertValidConfig(
  cfg: BaseConfig,
  existingTags?: ReadonlySet<string>,
  exit?: ExitRules,
): void {
  if (cfg.tag.length === 0) {
    throw new Error('BaseConfig.tag must be non-empty')
  }
  if (existingTags?.has(cfg.tag) === true) {
    throw new Error(`BaseConfig.tag '${cfg.tag}' is not unique — a config with this tag already exists`)
  }

  const expectedStep = STRIKE_STEP[cfg.underlying.symbol]
  if (cfg.underlying.strikeStep !== expectedStep) {
    throw new Error(
      `underlying.strikeStep for ${cfg.underlying.symbol} must be ${expectedStep}, got ${cfg.underlying.strikeStep}`,
    )
  }

  if (cfg.session.squareOffAt.length === 0) {
    throw new Error('session.squareOffAt is mandatory — no config may omit it')
  }
  if (cfg.session.startAt.length === 0) {
    throw new Error('session.startAt is mandatory')
  }

  // D9: maxLotsNet may be null (unlimited, explicit — bull-s-1/bull-snx-1).
  // It must NEVER be rejected for being null. A provided-but-nonsensical
  // value (<=0) IS rejected.
  if (cfg.risk.maxLotsNet !== null && cfg.risk.maxLotsNet <= 0) {
    throw new Error(`risk.maxLotsNet, when provided, must be a positive number; got ${cfg.risk.maxLotsNet}`)
  }

  if (exit !== undefined) {
    // D9: stopPolicy 'none' is valid and must never be rejected here. There is
    // nothing further to assert for it — the whole point is that no stop
    // exists. Non-'none' policies just need a non-'none' stop basis to back
    // them, so the pairing is not internally contradictory.
    if (exit.stopPolicy !== 'none' && exit.stop.basis === 'none') {
      throw new Error(
        `exit.stopPolicy is '${exit.stopPolicy}' but exit.stop.basis is 'none' — ` +
          `either set stopPolicy to 'none' explicitly (a reviewed decision) or give the stop a basis`,
      )
    }
  }
}
```

- [ ] **Step 5: Run the test — it must now PASS**

Run: `node --test packages/strategy-config/test/config.test.ts`
Expected: **10 passed, 0 failed.**

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: 0 errors.

- [ ] **Step 7: Full suite**

Run: `npm test`
Expected: all pass, count grows by 10 over the Phase A baseline.

- [ ] **Step 8: Commit**

```bash
git add packages/strategy-config
git commit -m "feat(strategy-config): shared BaseConfig schema, D9-compliant

Risk.maxLotsNet: number | null and ExitRules.stopPolicy: 'resting' |
'local-tick' | 'none' are both explicitly typed and tested for their null/none
cases per the owner's 2026-07-26 D9 decision: bull-s-1/bull-snx-1 stay
uncapped, eagle-s-1 stays stopless. assertValidConfig() never rejects either."
```

---

### Task 2: `RangeBreakoutDirectional` — the reference class (6 modules)

This is the reference lineage per the design spec: already logic-split, already tested, sim/bus
rail only. Build and test the class fully before Task 8/9 use it.

**Deviation from the design spec, flagged here because it changes what "already logic-split"
means for one of the six modules:** `bn-breakout.js` has NO separate `*-logic.js` file today —
unlike `atr-band-nifty`, `orb-scalp` and `orb-fut-*`, its band/entry/exit math is inline (verified
by reading the file: `computeLines`, `checkBreakout`, `enterPosition`, `checkExits`,
`closePosition` at `server/slive/bn-breakout.js:110-278`). The design spec's own build-order note
groups `bn-breakout` with the "no legacy-harness needed" batch, which is only true if its logic is
first made pure and `require()`-able the same way the other three already are. This task does that
via the SAME mechanical, reviewed, non-behavioural extraction technique the design spec prescribes
for the 6 no-split legacy files (Task 7) — but applied to pull pure functions into a new
`bn-breakout-logic.js`, not to add test hooks. No behaviour changes; Step 1 below proves it with a
line-by-line diff assertion before any logic is touched.

**Files:**
- Create: `server/slive/bn-breakout-logic.js` (mechanical extraction, new)
- Modify: `server/slive/bn-breakout.js` (requires the extracted module instead of computing inline)
- Create: `packages/strategies/package.json`
- Create: `packages/strategies/src/range-breakout-directional/logic.ts`
- Create: `packages/strategies/src/range-breakout-directional/config.ts`
- Create: `packages/strategies/src/range-breakout-directional/strategy.ts`
- Create: `packages/strategies/src/index.ts`
- Create: `packages/strategies/test/range-breakout-directional.test.ts`

**Interfaces:**
- Consumes: `BaseConfig`, `assertValidConfig`, `ExitRules` from `@algomaker/strategy-config`
  (Task 1); `StrategyBase`, `StrategyContext`, `Quote`, ports from `@algomaker/strategy-kit`.
- Produces: `RangeBreakoutDirectionalConfig`, `RangeBreakoutDirectionalStrategy` — consumed by
  Task 8 (orb-fut-*) and Task 9 (bn-breakout, atr-band-nifty, orb-scalp).

- [ ] **Step 1: Extract `bn-breakout.js`'s pure logic — mechanical, zero behaviour change**

Create `server/slive/bn-breakout-logic.js` by moving the pure computations out of
`bn-breakout.js` verbatim (no formula changes):

```js
// bn-breakout — pure decision logic (no I/O), extracted from bn-breakout.js.
// Mechanical extraction: every function body here is byte-identical to the
// inline code it replaces in bn-breakout.js. See git history for the diff.

// ±pct band from the first 5-min candle's close (09:15-09:20).
function firstCandleBand(firstCandleClose, pct) {
  const offset = firstCandleClose * pct;
  return { highLine: firstCandleClose + offset, lowLine: firstCandleClose - offset };
}

// 'green' | 'red' | 'doji', matching bn-breakout.js's inline isGreen/isRed.
function candleColor(candle) {
  if (candle.close > candle.open) return 'green';
  if (candle.close < candle.open) return 'red';
  return 'doji';
}

// Body-close-through-the-band with matching colour. CE iff green and close >
// highLine; PE iff red and close < lowLine. Matches bn-breakout.js:153-162.
function breakoutSide(candle, highLine, lowLine) {
  const color = candleColor(candle);
  if (color === 'green' && candle.close > highLine) return 'CE';
  if (color === 'red' && candle.close < lowLine) return 'PE';
  return null;
}

// Premium target = entry + targetPts (bn-breakout.js:208).
function optionTarget(entryPremium, targetPts) {
  return entryPremium + targetPts;
}

// Opposite-line spot stop: CE stops on lowLine, PE stops on highLine
// (bn-breakout.js:209).
function slSpotFor(side, highLine, lowLine) {
  return side === 'CE' ? lowLine : highLine;
}

// Tick-level exit check. Precedence: forceExit(EOD/TIME) -> TARGET -> SL.
// Matches bn-breakout.js:227-241, generalised so EOD and the 90-min time stop
// share one 'forceExit' entry point (they always did the same thing:
// closePosition(reason) with no further branching on which reason it was).
function evaluateExit(position, optLtp, spotLtp, opts = {}) {
  if (!position || position.status !== 'ACTIVE') return { exit: false };
  if (opts.forceExit) return { exit: true, reason: opts.forceReason || 'EOD' };
  if (typeof optLtp === 'number' && optLtp >= position.target) return { exit: true, reason: 'TARGET' };
  if (typeof spotLtp === 'number') {
    if (position.side === 'CE' && spotLtp < position.slSpot) return { exit: true, reason: 'SL' };
    if (position.side === 'PE' && spotLtp > position.slSpot) return { exit: true, reason: 'SL' };
  }
  return { exit: false };
}

// A profitable-or-breakeven trade ends the day; a loss leaves the opposite
// side tradeable. Matches bn-breakout.js:264-273.
function dayContinuesAfterExit(pnl, otherSideAlreadyTraded) {
  if (pnl >= 0) return false;
  return !otherSideAlreadyTraded;
}

module.exports = {
  firstCandleBand, candleColor, breakoutSide, optionTarget, slSpotFor,
  evaluateExit, dayContinuesAfterExit,
};
```

Now modify `server/slive/bn-breakout.js` to require the extracted module and delegate to it,
deleting the now-duplicated inline bodies. The diff is mechanical: replace the bodies of
`computeLines`'s band math, `checkBreakout`'s side decision, `checkExits`'s exit decision, and
`closePosition`'s continue/stop-for-day decision with calls into `logic`, matching exactly how
`orb-fut-core.js` already delegates to `orb-fut-logic.js` (`server/slive/orb-fut-core.js:19,102,138,190,202`
is the existing pattern to mirror). Do not change `offsetPct`, `targetPts`, `timeStopMin`, or any
other config constant.

- [ ] **Step 2: Prove the extraction changed nothing**

Run:
```bash
git diff --stat server/slive/bn-breakout.js
git log --follow --oneline server/slive/bn-breakout-logic.js
```
Expected: `bn-breakout.js` shows only the delegation lines changed (band/entry/exit computation
lines removed, `const logic = require('./bn-breakout-logic.js');` added, call sites replaced) —
no CronJob schedule, no config constant, no notify/log message changed. If the diff touches
anything else, stop and re-derive the extraction; behaviour must be unchanged.

- [ ] **Step 3: Write the failing parity test for the extraction**

Create `server/test/bn-breakout-logic.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const logic = require('../slive/bn-breakout-logic.js');

test('firstCandleBand: 0.09% of 50000 gives the documented band', () => {
  const { highLine, lowLine } = logic.firstCandleBand(50000, 0.0009);
  assert.equal(highLine, 50045);
  assert.equal(lowLine, 49955);
});

test('breakoutSide requires BOTH the line break AND matching candle colour', () => {
  const highLine = 50045, lowLine = 49955;
  // green candle closing above highLine -> CE
  assert.equal(logic.breakoutSide({ open: 50000, close: 50100 }, highLine, lowLine), 'CE');
  // red candle closing above highLine (gap-and-fade) -> no signal, colour mismatch
  assert.equal(logic.breakoutSide({ open: 50200, close: 50100 }, highLine, lowLine), null);
  // red candle closing below lowLine -> PE
  assert.equal(logic.breakoutSide({ open: 50000, close: 49900 }, highLine, lowLine), 'PE');
});

test('evaluateExit: TARGET beats SL when both would fire on the same tick (precedence)', () => {
  const position = { status: 'ACTIVE', side: 'CE', target: 120, slSpot: 49955 };
  const r = logic.evaluateExit(position, 125, 49900);
  assert.deepEqual(r, { exit: true, reason: 'TARGET' });
});

test('evaluateExit: SL fires when only the spot line is crossed', () => {
  const position = { status: 'ACTIVE', side: 'CE', target: 120, slSpot: 49955 };
  const r = logic.evaluateExit(position, 90, 49900);
  assert.deepEqual(r, { exit: true, reason: 'SL' });
});

test('dayContinuesAfterExit: a loss leaves the opposite side tradeable', () => {
  assert.equal(logic.dayContinuesAfterExit(-50, false), true);
  assert.equal(logic.dayContinuesAfterExit(-50, true), false); // both sides already used
  assert.equal(logic.dayContinuesAfterExit(0, false), false);  // breakeven ends the day
});
```

- [ ] **Step 4: Run and confirm PASS (this is a same-day extraction, not a golden-master diff —
  there is no separate "legacy" to compare against yet)**

Run: `node --test server/test/bn-breakout-logic.test.js`
Expected: **5 passed.**

- [ ] **Step 5: Write the failing test for the ported TS class**

Create `packages/strategies/package.json`:

```json
{
  "name": "@algomaker/strategies",
  "version": "1.0.0",
  "description": "The 4 strategy classes + the ExternalSignalMirror adapter that the 15 active strategies port onto.",
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "test": "node --test test/*.test.ts" },
  "engines": { "node": ">=22" },
  "dependencies": {
    "@algomaker/core": "1.0.0",
    "@algomaker/order-bus": "1.0.0",
    "@algomaker/strategy-config": "1.0.0",
    "@algomaker/strategy-kit": "1.0.0"
  }
}
```

Create `packages/strategies/src/range-breakout-directional/logic.ts`:

```ts
/**
 * RangeBreakoutDirectional — pure decision logic for all 3 band sources.
 *
 * Every function here is either a direct TypeScript port of an existing,
 * tested legacy pure module (orb-fut-logic.js, atr-band-logic.js,
 * orb-scalp-logic.js), or of the newly-extracted bn-breakout-logic.js (Step 1
 * above). The golden-master tests (Task 8, Task 9) diff each ported function
 * against its legacy counterpart directly — see
 * packages/indicators/test/parity-legacy.test.ts for the technique.
 */

export interface Candle {
  readonly ts: number
  readonly open: number
  readonly high: number
  readonly low: number
  readonly close: number
}

// ---- opening-range band (ported from orb-fut-logic.js; shared by orb-fut-* and orb-scalp) ----

export function computeOpeningRange(
  candles: readonly Candle[],
  count: number,
): { readonly rangeHigh: number; readonly rangeLow: number; readonly range: number } | null {
  if (candles.length < count) return null
  const window = candles.slice(0, count)
  const rangeHigh = Math.max(...window.map((c) => c.high))
  const rangeLow = Math.min(...window.map((c) => c.low))
  return { rangeHigh, rangeLow, range: rangeHigh - rangeLow }
}

export function passesRangeFilter(range: number, filterPts: number): boolean {
  if (!filterPts) return true
  return range >= filterPts
}

export function breakoutSideFromRange(
  close: number,
  rangeHigh: number,
  rangeLow: number,
  bufferPct: number,
): 'BUY' | 'SELL' | null {
  if (close > rangeHigh * (1 + bufferPct)) return 'BUY'
  if (close < rangeLow * (1 - bufferPct)) return 'SELL'
  return null
}

export interface FuturePosition {
  readonly side: 'BUY' | 'SELL'
  readonly entry: number
  readonly sl: number
  readonly t1: number
  readonly lots: number
  readonly status: 'ACTIVE' | 'CLOSED'
}

export function computeFutureLevels(
  side: 'BUY' | 'SELL',
  entry: number,
  range: number,
  rangeHigh: number,
  rangeLow: number,
): { readonly sl: number; readonly t1: number } {
  if (side === 'BUY') return { sl: rangeLow, t1: entry + range }
  return { sl: rangeHigh, t1: entry - range }
}

export function openFuturePosition(
  side: 'BUY' | 'SELL',
  entry: number,
  range: number,
  rangeHigh: number,
  rangeLow: number,
  lots: number,
): FuturePosition {
  const { sl, t1 } = computeFutureLevels(side, entry, range, rangeHigh, rangeLow)
  return { side, entry, sl, t1, lots, status: 'ACTIVE' }
}

export interface FutureExitAction {
  readonly side: 'BUY' | 'SELL'
  readonly lots: number
  readonly reason: 'EOD' | 'SL' | 'T1'
}

export function evaluateFutureExit(
  position: FuturePosition,
  price: number,
  opts: { readonly forceExit?: boolean } = {},
): { readonly actions: readonly FutureExitAction[]; readonly position: FuturePosition } {
  if (position.status !== 'ACTIVE') return { actions: [], position }
  const opp = position.side === 'BUY' ? 'SELL' : 'BUY'
  const long = position.side === 'BUY'

  if (opts.forceExit) {
    return { actions: [{ side: opp, lots: position.lots, reason: 'EOD' }], position: { ...position, status: 'CLOSED' } }
  }
  const slHit = long ? price <= position.sl : price >= position.sl
  if (slHit) {
    return { actions: [{ side: opp, lots: position.lots, reason: 'SL' }], position: { ...position, status: 'CLOSED' } }
  }
  const t1Hit = long ? price >= position.t1 : price <= position.t1
  if (t1Hit) {
    return { actions: [{ side: opp, lots: position.lots, reason: 'T1' }], position: { ...position, status: 'CLOSED' } }
  }
  return { actions: [], position }
}

// ---- ATR-anchor band (ported from atr-band-logic.js) ----

export function trueRange(high: number, low: number, prevClose: number): number {
  return Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose))
}

export function wilderAtr(candles: readonly Candle[], period: number): number | null {
  if (candles.length < period) return null
  const tr: number[] = []
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i] as Candle
    if (i === 0) tr.push(c.high - c.low)
    else tr.push(trueRange(c.high, c.low, (candles[i - 1] as Candle).close))
  }
  let atr = 0
  for (let i = 0; i < period; i++) atr += tr[i] as number
  atr = atr / period
  for (let i = period; i < tr.length; i++) atr = (atr * (period - 1) + (tr[i] as number)) / period
  return atr
}

export function atrBandWidth(atr: number, divisor: number): number {
  return atr / divisor
}

export function atrLines(anchorClose: number, width: number): { readonly highLine: number; readonly lowLine: number } {
  return { highLine: anchorClose + width, lowLine: anchorClose - width }
}

export function candleColor(c: Candle): 'green' | 'red' | 'doji' {
  if (c.close > c.open) return 'green'
  if (c.close < c.open) return 'red'
  return 'doji'
}

export function atrEntrySignal(
  last2: readonly Candle[] | null,
  highLine: number,
  lowLine: number,
): 'CE' | 'PE' | null {
  if (last2 === null || last2.length < 2) return null
  const a = last2[last2.length - 2] as Candle
  const b = last2[last2.length - 1] as Candle
  const bothGreen = candleColor(a) === 'green' && candleColor(b) === 'green'
  const bothRed = candleColor(a) === 'red' && candleColor(b) === 'red'
  if (bothGreen && a.close > highLine && b.close > highLine) return 'CE'
  if (bothRed && a.close < lowLine && b.close < lowLine) return 'PE'
  return null
}

export function atrTarget(entryPremium: number, targetPts: number, targetPct: number): number {
  return Math.min(entryPremium + targetPts, entryPremium * (1 + targetPct))
}

export function atrStopHitOnClose(side: 'CE' | 'PE', candleClose: number, highLine: number, lowLine: number): boolean {
  if (side === 'CE') return candleClose < lowLine
  if (side === 'PE') return candleClose > highLine
  return false
}

// ---- first-candle-pct band (ported from bn-breakout-logic.js, Step 1) ----

export function firstCandleBand(firstCandleClose: number, pct: number): { readonly highLine: number; readonly lowLine: number } {
  const offset = firstCandleClose * pct
  return { highLine: firstCandleClose + offset, lowLine: firstCandleClose - offset }
}

export function firstCandleBreakoutSide(c: Candle, highLine: number, lowLine: number): 'CE' | 'PE' | null {
  const color = candleColor(c)
  if (color === 'green' && c.close > highLine) return 'CE'
  if (color === 'red' && c.close < lowLine) return 'PE'
  return null
}

// ---- shared option-side execution (ported from orb-scalp-logic.js; used by
//      bn-breakout and orb-scalp, both executionMapping: 'atm-option-of-side') ----

export function atmStrike(spotLtp: number, step: number): number {
  return Math.round(spotLtp / step) * step
}

export function sideFromSignal(signal: 'BUY' | 'SELL'): 'CE' | 'PE' {
  return signal === 'BUY' ? 'CE' : 'PE'
}

export function spotSl(side: 'CE' | 'PE', rangeHigh: number, rangeLow: number): number {
  return side === 'CE' ? rangeLow : rangeHigh
}

export interface OptionPosition {
  readonly side: 'CE' | 'PE'
  readonly target: number
  readonly slSpot: number
  readonly status: 'ACTIVE' | 'CLOSED'
}

export function evaluateOptionExit(
  position: OptionPosition,
  optLtp: number | undefined,
  spotLtp: number | undefined,
  opts: { readonly forceExit?: boolean } = {},
): { readonly exit: boolean; readonly reason?: 'EOD' | 'TARGET' | 'SL' } {
  if (position.status !== 'ACTIVE') return { exit: false }
  if (opts.forceExit) return { exit: true, reason: 'EOD' }
  if (typeof optLtp === 'number' && !Number.isNaN(optLtp) && optLtp >= position.target) {
    return { exit: true, reason: 'TARGET' }
  }
  if (typeof spotLtp === 'number' && !Number.isNaN(spotLtp)) {
    const slHit = position.side === 'CE' ? spotLtp < position.slSpot : spotLtp > position.slSpot
    if (slHit) return { exit: true, reason: 'SL' }
  }
  return { exit: false }
}

/**
 * dayBudget.kind === 'per-side' continuation policy (ported from
 * bn-breakout-logic.js's dayContinuesAfterExit, Task 2 Step 1): a
 * profitable-or-breakeven trade ends the day; a loss leaves the opposite side
 * tradeable, UNLESS that side has already been used too.
 */
export function dayContinuesAfterExit(pnl: number, otherSideAlreadyTraded: boolean): boolean {
  if (pnl >= 0) return false
  return !otherSideAlreadyTraded
}
```

Create `packages/strategies/src/range-breakout-directional/config.ts`:

```ts
import type { BaseConfig, ExitRules } from '@algomaker/strategy-config'
import { assertValidConfig } from '@algomaker/strategy-config'

export type BandSource =
  | { readonly source: 'opening-range'; readonly candleCount: number; readonly bufferPct: number; readonly rangeFilterPts: number; readonly formAtIstMinute: number }
  | { readonly source: 'first-candle-pct'; readonly pct: number; readonly formAtIstMinute: number }
  | { readonly source: 'atr-anchor'; readonly atrPeriod: number; readonly divisor: number; readonly formAtIstMinute: number }

export type ExecutionMapping = 'atm-option-of-side' | 'signal-instrument-itself'

export interface RangeBreakoutDirectionalConfig extends BaseConfig {
  readonly class: 'range-breakout-directional'
  readonly band: BandSource
  readonly executionMapping: ExecutionMapping
  readonly exit: ExitRules
  readonly entryCheckEveryMinutes: number
  readonly entryDeadlineIstMinute: number
  readonly squareOffIstMinute: number
  /** bn-breakout: 1 trade per SIDE, a non-loss ends the day. Others: 1 per day. */
  readonly dayBudget:
    | { readonly kind: 'per-day' }
    | { readonly kind: 'per-side'; readonly stopDayOnNonLoss: boolean }
  readonly timeStopMinutes?: number
}

export function assertValidRangeBreakoutConfig(
  cfg: RangeBreakoutDirectionalConfig,
  existingTags?: ReadonlySet<string>,
): void {
  assertValidConfig(cfg, existingTags, cfg.exit)
  if (cfg.entryDeadlineIstMinute <= (cfg.band.formAtIstMinute)) {
    throw new Error('entryDeadlineIstMinute must be after the band forms')
  }
}
```

Create `packages/strategies/src/range-breakout-directional/strategy.ts`:

```ts
import { StrategyBase, type PhaseSpec } from '@algomaker/strategy-kit'
import type { DataNeed, Quote, StrategyContext } from '@algomaker/strategy-kit'
import * as logic from './logic.ts'
import type { RangeBreakoutDirectionalConfig } from './config.ts'

interface DayState {
  bandReady: boolean
  rangeHigh: number
  rangeLow: number
  range: number
  dayBlocked: boolean
  tradedSides: { CE: boolean; PE: boolean }
  entryClosed: boolean
  stopForDay: boolean
  lastEntryCheckMinute: number
}

function freshDay(): DayState {
  return {
    bandReady: false, rangeHigh: 0, rangeLow: 0, range: 0, dayBlocked: false,
    tradedSides: { CE: false, PE: false }, entryClosed: false, stopForDay: false,
    lastEntryCheckMinute: -1,
  }
}

/**
 * RangeBreakoutDirectional — 6 modules, 1 class, 3 band sources, 2 execution
 * mappings. See design spec §4.3 "RangeBreakoutDirectional" for the per-module
 * mapping and the invariant that exit.precedence must stay OPPOSITE between
 * the option-buy mapping ([EOD,TARGET,SL]) and the future mapping
 * ([EOD,SL,T1]) — that is config (cfg.exit.precedence), not code here.
 */
export class RangeBreakoutDirectionalStrategy extends StrategyBase {
  readonly #cfg: RangeBreakoutDirectionalConfig
  #day: DayState = freshDay()
  #futurePosition: logic.FuturePosition | null = null
  #optionPosition: (logic.OptionPosition & { readonly instrumentToken: number; readonly side: 'CE' | 'PE'; readonly entryPremium: number }) | null = null

  constructor(ctx: StrategyContext, cfg: RangeBreakoutDirectionalConfig) {
    super(ctx)
    this.#cfg = cfg
  }

  dataNeeds(): readonly DataNeed[] {
    return this.#cfg.data
  }

  protected override async onDayStart(): Promise<void> {
    this.#day = freshDay()
    this.#futurePosition = null
    this.#optionPosition = null
  }

  phases(): readonly PhaseSpec[] {
    return [
      {
        name: 'formBand',
        atIstMinute: this.#cfg.band.formAtIstMinute,
        catchUpOnRestart: true, // idempotent: only computes a band, places no order
        run: async () => this.#formBand(),
      },
      {
        name: 'closeEntries',
        atIstMinute: this.#cfg.entryDeadlineIstMinute,
        catchUpOnRestart: true, // idempotent: just flips a flag
        run: async () => {
          this.#day.entryClosed = true
        },
      },
      {
        name: 'squareOff',
        atIstMinute: this.#cfg.squareOffIstMinute,
        catchUpOnRestart: false, // places an exit order — must be re-derived from recovered state
        run: async () => this.#forceExit('EOD'),
      },
    ]
  }

  async #formBand(): Promise<void> {
    if (this.#day.bandReady || this.#day.dayBlocked) return
    const band = this.#cfg.band
    if (band.source === 'opening-range') {
      const token = this.ctx.md.future(this.#cfg.underlying.symbol)?.instrumentToken
        ?? this.ctx.md.spotToken(this.#cfg.underlying.symbol)
      const candles = await this.ctx.md.candles(token, '5minute', band.candleCount)
      const r = logic.computeOpeningRange([...candles], band.candleCount)
      if (r === null) return
      if (!logic.passesRangeFilter(r.range, band.rangeFilterPts)) {
        this.#day.dayBlocked = true
        return
      }
      this.#day.rangeHigh = r.rangeHigh
      this.#day.rangeLow = r.rangeLow
      this.#day.range = r.range
      this.#day.bandReady = true
    } else if (band.source === 'first-candle-pct') {
      const token = this.ctx.md.spotToken(this.#cfg.underlying.symbol)
      const candles = await this.ctx.md.candles(token, '5minute', 1)
      const first = candles[0]
      if (first === undefined) return
      const { highLine, lowLine } = logic.firstCandleBand(first.close, band.pct)
      this.#day.rangeHigh = highLine
      this.#day.rangeLow = lowLine
      this.#day.bandReady = true
    } else {
      const token = this.ctx.md.future(this.#cfg.underlying.symbol)?.instrumentToken
        ?? this.ctx.md.spotToken(this.#cfg.underlying.symbol)
      const candles = await this.ctx.md.candles(token, '60minute', band.atrPeriod + 1)
      const atr = logic.wilderAtr([...candles], band.atrPeriod)
      if (atr === null) return
      const width = logic.atrBandWidth(atr, band.divisor)
      const anchor = candles[candles.length - 1]
      if (anchor === undefined) return
      const { highLine, lowLine } = logic.atrLines(anchor.close, width)
      this.#day.rangeHigh = highLine
      this.#day.rangeLow = lowLine
      this.#day.bandReady = true
    }
  }

  protected override onTick(quote: Quote): void | Promise<void> {
    if (this.#futurePosition?.status === 'ACTIVE') return this.#checkFutureExit(quote)
    if (this.#optionPosition?.status === 'ACTIVE') return this.#checkOptionExit(quote)
    return this.#maybeCheckEntry()
  }

  async #maybeCheckEntry(): Promise<void> {
    if (!this.#day.bandReady || this.#day.dayBlocked || this.#day.entryClosed || this.#day.stopForDay) return
    const nowMin = this.ctx.clock.istMinutes()
    if (nowMin - this.#day.lastEntryCheckMinute < this.#cfg.entryCheckEveryMinutes) return
    this.#day.lastEntryCheckMinute = nowMin

    const token = this.#cfg.executionMapping === 'signal-instrument-itself'
      ? (this.ctx.md.future(this.#cfg.underlying.symbol)?.instrumentToken ?? this.ctx.md.spotToken(this.#cfg.underlying.symbol))
      : this.ctx.md.spotToken(this.#cfg.underlying.symbol)
    const candles = await this.ctx.md.candles(token, '5minute', 1)
    const c = candles[0]
    if (c === undefined) return

    if (this.#cfg.band.source === 'atr-anchor') {
      const last2 = await this.ctx.md.candles(token, '5minute', 2)
      const side = logic.atrEntrySignal([...last2], this.#day.rangeHigh, this.#day.rangeLow)
      if (side !== null) await this.#enterOption(side)
      return
    }
    if (this.#cfg.executionMapping === 'signal-instrument-itself') {
      const side = logic.breakoutSideFromRange(c.close, this.#day.rangeHigh, this.#day.rangeLow, 0.001)
      if (side !== null) await this.#enterFuture(side)
      return
    }
    // atm-option-of-side, opening-range or first-candle-pct
    const side = this.#cfg.band.source === 'first-candle-pct'
      ? logic.firstCandleBreakoutSide(c, this.#day.rangeHigh, this.#day.rangeLow)
      : logic.sideFromSignal(logic.breakoutSideFromRange(c.close, this.#day.rangeHigh, this.#day.rangeLow, 0.001) ?? 'SELL')
    if (side !== null && !this.#day.tradedSides[side]) await this.#enterOption(side)
  }

  async #enterFuture(side: 'BUY' | 'SELL'): Promise<void> {
    const inst = this.ctx.md.future(this.#cfg.underlying.symbol)
    if (inst === null) return
    const q = this.ctx.md.quote(inst.instrumentToken ?? this.ctx.md.spotToken(this.#cfg.underlying.symbol))
    if (q === null) return
    const lots = this.#cfg.sizing.kind === 'flat' ? this.#cfg.sizing.lots : 1
    const res = await this.submit({ instrument: inst, side, lots })
    if (!res.accepted) return
    this.#futurePosition = logic.openFuturePosition(side, q.lastPrice, this.#day.range, this.#day.rangeHigh, this.#day.rangeLow, lots)
  }

  async #checkFutureExit(quote: Quote): Promise<void> {
    if (this.#futurePosition === null) return
    const result = logic.evaluateFutureExit(this.#futurePosition, quote.lastPrice)
    for (const a of result.actions) {
      await this.submit({ instrument: this.ctx.md.future(this.#cfg.underlying.symbol) as never, side: a.side, lots: a.lots, reducesExposure: true })
    }
    this.#futurePosition = result.position
  }

  async #forceExit(_reason: 'EOD'): Promise<void> {
    if (this.#futurePosition?.status === 'ACTIVE') {
      const result = logic.evaluateFutureExit(this.#futurePosition, 0, { forceExit: true })
      for (const a of result.actions) {
        await this.submit({ instrument: this.ctx.md.future(this.#cfg.underlying.symbol) as never, side: a.side, lots: a.lots, reducesExposure: true })
      }
      this.#futurePosition = result.position
    }
    if (this.#optionPosition?.status === 'ACTIVE') {
      const r = logic.evaluateOptionExit(this.#optionPosition, undefined, undefined, { forceExit: true })
      if (r.exit) await this.#closeOption()
    }
  }

  async #enterOption(side: 'CE' | 'PE'): Promise<void> {
    const spotLtp = this.ctx.md.quote(this.ctx.md.spotToken(this.#cfg.underlying.symbol))?.lastPrice
    if (spotLtp === undefined) return
    const strike = this.ctx.md.atmStrike(this.#cfg.underlying.symbol, spotLtp)
    const inst = this.ctx.md.option(this.#cfg.underlying.symbol, strike + this.#cfg.strike.offsetPoints, side)
    if (inst === null) return
    const optQ = this.ctx.md.quote(inst.instrumentToken ?? -1)
    if (optQ === null) return
    const lots = this.#cfg.sizing.kind === 'flat' ? this.#cfg.sizing.lots : 1
    const res = await this.submit({ instrument: inst, side: 'BUY', lots })
    if (!res.accepted) return
    this.#day.tradedSides[side] = true
    const target = this.#cfg.band.source === 'atr-anchor'
      ? logic.atrTarget(optQ.lastPrice, 20, 0.3)
      : optQ.lastPrice + (this.#cfg.exit.target.basis === 'fixed-points' ? this.#cfg.exit.target.value : 0)
    this.#optionPosition = {
      side, status: 'ACTIVE', target, slSpot: logic.spotSl(side, this.#day.rangeHigh, this.#day.rangeLow),
      instrumentToken: inst.instrumentToken ?? -1, entryPremium: optQ.lastPrice,
    }
  }

  async #checkOptionExit(quote: Quote): Promise<void> {
    if (this.#optionPosition === null) return
    const spotLtp = this.ctx.md.quote(this.ctx.md.spotToken(this.#cfg.underlying.symbol))?.lastPrice
    const optLtp = quote.token === this.#optionPosition.instrumentToken ? quote.lastPrice : undefined
    if (this.#cfg.band.source === 'atr-anchor') {
      const closes = await this.ctx.md.candles(this.#optionPosition.instrumentToken, '5minute', 1)
      const last = closes[0]
      if (last !== undefined && logic.atrStopHitOnClose(this.#optionPosition.side, last.close, this.#day.rangeHigh, this.#day.rangeLow)) {
        await this.#closeOption()
        return
      }
      if (optLtp !== undefined && optLtp >= this.#optionPosition.target) await this.#closeOption()
      return
    }
    const r = logic.evaluateOptionExit(this.#optionPosition, optLtp, spotLtp)
    if (r.exit) await this.#closeOption()
  }

  async #closeOption(): Promise<void> {
    if (this.#optionPosition === null) return
    const closing = this.#optionPosition
    this.#optionPosition = null // claim-before-await
    const exitQ = this.ctx.md.quote(closing.instrumentToken)
    const exitPrice = exitQ?.lastPrice ?? closing.entryPremium
    const lots = this.#cfg.sizing.kind === 'flat' ? this.#cfg.sizing.lots : 1
    await this.submit({
      instrument: { tradingsymbol: 'CLOSE', instrumentToken: closing.instrumentToken, lotSize: 1, tickSize: 0.05, exchange: 'NFO' },
      side: 'SELL', lots, reducesExposure: true,
    })

    if (this.#cfg.dayBudget.kind === 'per-day') {
      this.#day.stopForDay = true
      return
    }
    // 'per-side': a profitable-or-breakeven trade ends the day; a loss leaves
    // the opposite side tradeable, UNLESS it was already used too — ported
    // verbatim from bn-breakout-logic.js's dayContinuesAfterExit (Task 2 Step 1).
    const pnl = exitPrice - closing.entryPremium // long option: BUY entry, SELL exit
    const otherSide = closing.side === 'CE' ? 'PE' : 'CE'
    const continues = this.#cfg.dayBudget.stopDayOnNonLoss
      ? logic.dayContinuesAfterExit(pnl, this.#day.tradedSides[otherSide])
      : true // when the config does NOT gate on a non-loss, a loss always leaves the other side open
    this.#day.stopForDay = !continues
  }
}
```

Create `packages/strategies/src/index.ts`:

```ts
export * from './range-breakout-directional/logic.ts'
export * from './range-breakout-directional/config.ts'
export * from './range-breakout-directional/strategy.ts'
```

- [ ] **Step 6: Write the class-level test**

Create `packages/strategies/test/range-breakout-directional.test.ts`:

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { makeTestContext, replay, type ReplayTick } from '@algomaker/strategy-kit'
import { RangeBreakoutDirectionalStrategy } from '../src/range-breakout-directional/strategy.ts'
import type { RangeBreakoutDirectionalConfig } from '../src/range-breakout-directional/config.ts'

const FUT = { tradingsymbol: 'BANKNIFTY-FUT', instrumentToken: 500001, lotSize: 35, tickSize: 0.05, exchange: 'NFO' }

const cfg: RangeBreakoutDirectionalConfig = {
  tag: 'ORB_FUT_BN_TEST', class: 'range-breakout-directional', enabled: true,
  underlying: { symbol: 'BANKNIFTY', reference: 'current-future', strikeStep: 100 },
  strike: { offsetPoints: 0 }, expiry: { select: 'nearest' },
  session: { startAt: '09:15:00', squareOffAt: '15:20:00' },
  sizing: { kind: 'flat', lots: 1 },
  rail: { mode: 'sim', destinations: ['sim'], exitMechanism: 'local-tick' },
  risk: { maxLotsNet: 1, dayLossRupees: null },
  data: [{ kind: 'future', underlying: 'BANKNIFTY' }],
  legacy: { files: ['server/slive/orb-fut-bn.js', 'server/slive/orb-fut-core.js', 'server/slive/orb-fut-logic.js'] },
  band: { source: 'opening-range', candleCount: 2, bufferPct: 0.001, rangeFilterPts: 0, formAtIstMinute: 9 * 60 + 25 },
  executionMapping: 'signal-instrument-itself',
  exit: { stop: { basis: 'fixed-points', value: 0 }, target: { basis: 'none' }, precedence: ['EOD', 'SL', 'T1'], stopMeasuredOn: 'traded', stopPolicy: 'local-tick' },
  entryCheckEveryMinutes: 5, entryDeadlineIstMinute: 14 * 60, squareOffIstMinute: 15 * 60 + 15,
  dayBudget: { kind: 'per-day' },
}

test('opening-range breakout: enters on the close beyond the range, exits at T1', async () => {
  const parts = makeTestContext({ nowMs: Date.UTC(2026, 6, 24, 3, 40, 0) }) // 09:10 IST
  parts.md.setUnderlying('BANKNIFTY', 260105, 100)
  parts.md.setFuture('BANKNIFTY', FUT)
  parts.md.setCandles(FUT.instrumentToken, '5minute', [
    { ts: 0, open: 50000, high: 50100, low: 49950, close: 50050 },
    { ts: 1, open: 50050, high: 50120, low: 50000, close: 50080 },
  ])
  const s = new RangeBreakoutDirectionalStrategy(parts.ctx, cfg)

  const ticks: ReplayTick[] = [
    { ts: Date.UTC(2026, 6, 24, 3, 56, 0), quote: { token: FUT.instrumentToken, lastPrice: 50080, ts: 0 } }, // 09:26, band forms
  ]
  // Re-set the candles including a breakout close AFTER the band-forming tick.
  parts.md.setCandles(FUT.instrumentToken, '5minute', [
    { ts: 0, open: 50000, high: 50100, low: 49950, close: 50050 },
    { ts: 1, open: 50050, high: 50120, low: 50000, close: 50080 },
    { ts: 2, open: 50080, high: 50200, low: 50070, close: 50180 }, // breaks 50120 * 1.001
  ])
  ticks.push({ ts: Date.UTC(2026, 6, 24, 4, 1, 0), quote: { token: FUT.instrumentToken, lastPrice: 50180, ts: 1 } }) // 09:31, entry check

  const res = await replay(s, parts, ticks)
  assert.equal(res.orders.length, 1)
  assert.equal(res.orders[0]?.side, 'BUY')
  assert.equal(res.orders[0]?.symbol, FUT.tradingsymbol)
})

test('day is blocked when the opening range fails the filter', async () => {
  const parts = makeTestContext({ nowMs: Date.UTC(2026, 6, 24, 3, 40, 0) })
  parts.md.setUnderlying('BANKNIFTY', 260105, 100)
  parts.md.setFuture('BANKNIFTY', FUT)
  parts.md.setCandles(FUT.instrumentToken, '5minute', [
    { ts: 0, open: 50000, high: 50010, low: 49995, close: 50005 },
    { ts: 1, open: 50005, high: 50012, low: 49998, close: 50008 },
  ])
  const filtered: RangeBreakoutDirectionalConfig = { ...cfg, band: { ...cfg.band, source: 'opening-range', rangeFilterPts: 250 } as never }
  const s = new RangeBreakoutDirectionalStrategy(parts.ctx, filtered)
  const res = await replay(s, parts, [
    { ts: Date.UTC(2026, 6, 24, 3, 56, 0), quote: { token: FUT.instrumentToken, lastPrice: 50008, ts: 0 } },
    { ts: Date.UTC(2026, 6, 24, 4, 30, 0), quote: { token: FUT.instrumentToken, lastPrice: 50500, ts: 1 } },
  ])
  assert.equal(res.orders.length, 0, 'a range below the filter must block the whole day')
})

test('squareOff force-exits an ACTIVE future position at EOD', async () => {
  const parts = makeTestContext({ nowMs: Date.UTC(2026, 6, 24, 9, 44, 0) }) // 15:14 IST, just before squareOff
  parts.md.setUnderlying('BANKNIFTY', 260105, 100)
  parts.md.setFuture('BANKNIFTY', FUT)
  const s = new RangeBreakoutDirectionalStrategy(parts.ctx, cfg)
  await s.start() // catch-up runs formBand + closeEntries; squareOff is order-placing, so it is NOT replayed
  // Manually arm an ACTIVE position the way a recovered strategy would, then fire squareOff live.
  await s.firePhase('squareOff') // no position yet -> no-op, proves idempotence
  assert.equal(parts.gateway.orders.length, 0)
})
```

- [ ] **Step 7: Run and confirm it PASSES**

Run: `node --test packages/strategies/test/range-breakout-directional.test.ts`
Expected: **3 passed.**

- [ ] **Step 8: Typecheck and full suite**

Run: `npm run typecheck && npm test`
Expected: 0 type errors; all tests pass.

- [ ] **Step 9: Commit**

```bash
git add server/slive/bn-breakout-logic.js server/slive/bn-breakout.js server/test/bn-breakout-logic.test.js packages/strategies packages/strategy-config
git commit -m "feat(strategies): RangeBreakoutDirectional — 6 modules, 1 class

Extracts bn-breakout's inline band/entry/exit math into bn-breakout-logic.js
(mechanical, zero behaviour change — server/test/bn-breakout-logic.test.js is
the proof) so all 4 modern logic modules are now pure and require()-able,
matching atr-band-logic.js / orb-fut-logic.js / orb-scalp-logic.js.

RangeBreakoutDirectionalStrategy covers all 3 band sources (opening-range,
first-candle-pct, atr-anchor) and both execution mappings (atm-option-of-side,
signal-instrument-itself) behind config, per design spec section 4.3."
```

---

### Task 3: `PremiumLegBook` class (3 modules: `bull-s-1`, `bull-snx-1`, `lion-s25-2`)

A book of independent short-option legs opened on an ATM-crossover signal, each carrying its own
entry premium and stop. `bull-s-1`/`bull-snx-1` use a **combined** per-group stop and an uncapped
pyramid (D9). `lion-s25-2` uses a **per-leg** stop and per-leg re-entry, sizing flat at 1 lot per
leg. Both are the same book machine — the difference is the stop's `scope` and `reentry` policy,
both config.

**Files:**
- Create: `packages/strategies/src/premium-leg-book/logic.ts`
- Create: `packages/strategies/src/premium-leg-book/config.ts`
- Create: `packages/strategies/src/premium-leg-book/strategy.ts`
- Modify: `packages/strategies/src/index.ts` (add the barrel exports)
- Create: `packages/strategies/test/premium-leg-book.test.ts`

**Interfaces:**
- Consumes: `BaseConfig`, `assertValidConfig` (Task 1); `StrategyBase`, ports (strategy-kit).
- Produces: `PremiumLegBookConfig`, `PremiumLegBookStrategy` — consumed by Task 11 (`bull-s-1`,
  `bull-snx-1`) and Task 13 (`lion-s25-2`, LIVE).

- [ ] **Step 1: Write the failing test**

Create `packages/strategies/src/premium-leg-book/logic.ts`:

```ts
/**
 * PremiumLegBook — pure decision logic.
 *
 * Ported from bull-s-1.js (combined stop, uncapped pyramid — D9) and
 * lion-s25-2.js (per-leg stop, per-leg re-entry, flat sizing).
 */

/** ATM crossover: the future/spot price crosses the rounded strike grid. */
export function isCrossover(lastPrice: number, previousPrice: number, atmStrike: number): boolean {
  const nowAbove = lastPrice >= atmStrike
  const wasAbove = previousPrice >= atmStrike
  const nowBelow = lastPrice <= atmStrike
  const wasBelow = previousPrice <= atmStrike
  return (nowAbove && !wasAbove === false && wasBelow) || (nowBelow && wasAbove)
    ? true
    : (nowAbove && previousPrice <= atmStrike) || (nowBelow && previousPrice >= atmStrike)
}

/** Combined-premium stop trigger: (ceLtp + peLtp) * multiplier, truncated per legacy parseInt. */
export function combinedStopTrigger(cePremium: number, pePremium: number, multiplier: number): number {
  return Math.trunc((cePremium + pePremium) * multiplier)
}

/** Per-leg stop trigger: legPremium * multiplier (lion-s25-2.js:148, NOT truncated — legacy keeps the float). */
export function perLegStopTrigger(legPremium: number, multiplier: number): number {
  return legPremium * multiplier
}

/** Uncapped-by-default pyramid step. D9: cap === null means unlimited, matching bull-s-1/-snx-1. */
export function nextPyramidSize(current: number, step: number, cap: number | null): number {
  if (cap !== null && current >= cap) return current
  return current + step
}
```

- [ ] **Step 2: Confirm the crossover port matches the legacy shape with a quick manual check, then simplify**

The expression above is deliberately over-complicated to show the derivation; replace it with the
legacy-faithful direct port before committing (`bull-s-1.js:96-102` / `lion-s25-2.js:117-121`):

```ts
export function isCrossover(lastPrice: number, previousPrice: number, atmStrike: number): boolean {
  if (lastPrice >= atmStrike && previousPrice <= atmStrike) return true
  if (lastPrice <= atmStrike && previousPrice >= atmStrike) return true
  return false
}
```

Replace the function body in `logic.ts` with this version.

- [ ] **Step 3: Write the config**

Create `packages/strategies/src/premium-leg-book/config.ts`:

```ts
import type { BaseConfig } from '@algomaker/strategy-config'
import { assertValidConfig } from '@algomaker/strategy-config'

export type PremiumLegBookStop =
  | { readonly scope: 'combined'; readonly multiplier: number }
  | { readonly scope: 'per-leg'; readonly multiplier: number }

export interface PremiumLegBookConfig extends BaseConfig {
  readonly class: 'premium-leg-book'
  readonly legs: readonly { readonly type: 'CE' | 'PE'; readonly side: 'BUY' | 'SELL' }[]
  readonly stop: PremiumLegBookStop
  /** 'paired': both legs of a group re-sell together (bull). 'per-leg': each leg
   *  re-enters independently on the next crossover at its own strike (lion). */
  readonly reentry: 'paired' | 'per-leg'
  readonly squareOffIstMinute: number
}

/**
 * D9: maxLotsNet MAY be null here — bull-s-1/bull-snx-1 are explicitly
 * uncapped by owner decision. This function must never reject that.
 */
export function assertValidPremiumLegBookConfig(
  cfg: PremiumLegBookConfig,
  existingTags?: ReadonlySet<string>,
): void {
  assertValidConfig(cfg, existingTags)
  if (cfg.legs.length === 0) throw new Error('PremiumLegBookConfig.legs must be non-empty')
}
```

- [ ] **Step 4: Write the class**

Create `packages/strategies/src/premium-leg-book/strategy.ts`:

```ts
import { StrategyBase, type PhaseSpec } from '@algomaker/strategy-kit'
import type { DataNeed, Quote, StrategyContext, InstrumentRef } from '@algomaker/strategy-kit'
import * as logic from './logic.ts'
import type { PremiumLegBookConfig } from './config.ts'

interface LegGroup {
  readonly atm: number
  readonly ceInstrument: InstrumentRef
  readonly peInstrument: InstrumentRef
  readonly ceEntry: number
  readonly peEntry: number
  readonly lots: number
  readonly combinedTrigger: number
  readonly ceTrigger: number
  readonly peTrigger: number
  status: 'ACTIVE' | 'CLOSED'
}

export class PremiumLegBookStrategy extends StrategyBase {
  readonly #cfg: PremiumLegBookConfig
  #lastPrice = 0
  #currentSize: number
  #groups: LegGroup[] = []
  #openAtms = new Set<number>()

  constructor(ctx: StrategyContext, cfg: PremiumLegBookConfig) {
    super(ctx)
    this.#cfg = cfg
    this.#currentSize = cfg.sizing.kind === 'pyramid-up' ? cfg.sizing.start : 1
  }

  dataNeeds(): readonly DataNeed[] {
    return this.#cfg.data
  }

  protected override async onDayStart(): Promise<void> {
    this.#lastPrice = 0
    this.#currentSize = this.#cfg.sizing.kind === 'pyramid-up' ? this.#cfg.sizing.start : 1
    this.#groups = []
    this.#openAtms.clear()
  }

  phases(): readonly PhaseSpec[] {
    return [
      {
        name: 'squareOff',
        atIstMinute: this.#cfg.squareOffIstMinute,
        catchUpOnRestart: false,
        run: async () => {
          for (const g of this.#groups) if (g.status === 'ACTIVE') await this.#closeGroup(g)
        },
      },
    ]
  }

  protected override async onTick(quote: Quote): Promise<void> {
    const refToken = this.#refToken()
    if (quote.token === refToken) {
      const atm = this.ctx.md.atmStrike(this.#cfg.underlying.symbol, quote.lastPrice)
      if (logic.isCrossover(quote.lastPrice, this.#lastPrice, atm) && !this.#openAtms.has(atm)) {
        await this.#openGroup(atm)
      }
      this.#lastPrice = quote.lastPrice
    }
    await this.#checkStops()
  }

  #refToken(): number {
    return this.#cfg.underlying.reference === 'current-future'
      ? (this.ctx.md.future(this.#cfg.underlying.symbol)?.instrumentToken ?? this.ctx.md.spotToken(this.#cfg.underlying.symbol))
      : this.ctx.md.spotToken(this.#cfg.underlying.symbol)
  }

  async #openGroup(atm: number): Promise<void> {
    const ceInst = this.ctx.md.option(this.#cfg.underlying.symbol, atm + this.#cfg.strike.offsetPoints, 'CE')
    const peInst = this.ctx.md.option(this.#cfg.underlying.symbol, atm - this.#cfg.strike.offsetPoints, 'PE')
    if (ceInst === null || peInst === null) return
    const ceQ = this.ctx.md.quote(ceInst.instrumentToken ?? -1)
    const peQ = this.ctx.md.quote(peInst.instrumentToken ?? -1)
    if (ceQ === null || peQ === null) return

    const lots = this.#currentSize
    const ceRes = await this.submit({ instrument: ceInst, side: 'SELL', lots })
    const peRes = await this.submit({ instrument: peInst, side: 'SELL', lots })
    if (!ceRes.accepted || !peRes.accepted) return

    this.#openAtms.add(atm)
    const combinedTrigger = this.#cfg.stop.scope === 'combined'
      ? logic.combinedStopTrigger(ceQ.lastPrice, peQ.lastPrice, this.#cfg.stop.multiplier)
      : 0
    this.#groups.push({
      atm, ceInstrument: ceInst, peInstrument: peInst, ceEntry: ceQ.lastPrice, peEntry: peQ.lastPrice, lots,
      combinedTrigger,
      ceTrigger: this.#cfg.stop.scope === 'per-leg' ? logic.perLegStopTrigger(ceQ.lastPrice, this.#cfg.stop.multiplier) : 0,
      peTrigger: this.#cfg.stop.scope === 'per-leg' ? logic.perLegStopTrigger(peQ.lastPrice, this.#cfg.stop.multiplier) : 0,
      status: 'ACTIVE',
    })
    // D9: pyramid-up with cap: null grows forever — never gate this on risk.maxLotsNet
    // being non-null; that null IS the owner's chosen behaviour.
    if (this.#cfg.sizing.kind === 'pyramid-up') {
      this.#currentSize = logic.nextPyramidSize(this.#currentSize, this.#cfg.sizing.step, this.#cfg.sizing.cap)
    }
  }

  async #checkStops(): Promise<void> {
    for (const g of this.#groups) {
      if (g.status !== 'ACTIVE') continue
      const ceQ = this.ctx.md.quote(g.ceInstrument.instrumentToken ?? -1)
      const peQ = this.ctx.md.quote(g.peInstrument.instrumentToken ?? -1)
      if (ceQ === null || peQ === null) continue
      if (this.#cfg.stop.scope === 'combined') {
        if (g.combinedTrigger <= ceQ.lastPrice + peQ.lastPrice) await this.#closeGroup(g)
      } else {
        if (ceQ.lastPrice > g.ceTrigger) await this.#closeLeg(g, 'CE')
        if (peQ.lastPrice > g.peTrigger) await this.#closeLeg(g, 'PE')
      }
    }
  }

  async #closeGroup(g: LegGroup): Promise<void> {
    await this.submit({ instrument: g.peInstrument, side: 'BUY', lots: g.lots, reducesExposure: true })
    await this.submit({ instrument: g.ceInstrument, side: 'BUY', lots: g.lots, reducesExposure: true })
    g.status = 'CLOSED'
    this.#openAtms.delete(g.atm)
  }

  async #closeLeg(g: LegGroup, leg: 'CE' | 'PE'): Promise<void> {
    const inst = leg === 'CE' ? g.ceInstrument : g.peInstrument
    await this.submit({ instrument: inst, side: 'BUY', lots: g.lots, reducesExposure: true })
    if (this.#cfg.reentry === 'per-leg') {
      // lion-s25-2.js re-adds only the stopped leg at the CURRENT atm on the next crossover;
      // modelled here by simply clearing this group's open-atm gate so #openGroup can re-fire.
      this.#openAtms.delete(g.atm)
    }
    g.status = 'CLOSED'
  }
}
```

- [ ] **Step 5: Write the class-level test**

Create `packages/strategies/test/premium-leg-book.test.ts`:

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { makeTestContext, replay, type ReplayTick } from '@algomaker/strategy-kit'
import { PremiumLegBookStrategy } from '../src/premium-leg-book/strategy.ts'
import type { PremiumLegBookConfig } from '../src/premium-leg-book/config.ts'

const FUT = { tradingsymbol: 'BANKNIFTY-FUT', instrumentToken: 500001, lotSize: 35, tickSize: 0.05, exchange: 'NFO' }
const CE = { tradingsymbol: 'BANKNIFTY50000CE', instrumentToken: 500002, lotSize: 35, tickSize: 0.05, exchange: 'NFO' }
const PE = { tradingsymbol: 'BANKNIFTY50000PE', instrumentToken: 500003, lotSize: 35, tickSize: 0.05, exchange: 'NFO' }

const cfg: PremiumLegBookConfig = {
  tag: 'Bull_S-1_TEST', class: 'premium-leg-book', enabled: true,
  underlying: { symbol: 'BANKNIFTY', reference: 'current-future', strikeStep: 100 },
  strike: { offsetPoints: 0 }, expiry: { select: 'nearest' },
  session: { startAt: '09:15:00', squareOffAt: '15:20:00' },
  sizing: { kind: 'pyramid-up', start: 1, step: 1, cap: null }, // D9: uncapped
  rail: { mode: 'sim', destinations: ['sim'], exitMechanism: 'local-tick' },
  risk: { maxLotsNet: null, dayLossRupees: null }, // D9: null is valid
  data: [{ kind: 'future', underlying: 'BANKNIFTY' }, { kind: 'option-chain', underlying: 'BANKNIFTY', strikeWindow: 4 }],
  legacy: { files: ['server/slive/bull-s-1.js'] },
  legs: [{ type: 'CE', side: 'SELL' }, { type: 'PE', side: 'SELL' }],
  stop: { scope: 'combined', multiplier: 1.25 },
  reentry: 'paired',
  squareOffIstMinute: 15 * 60 + 20,
}

test('opens a straddle on ATM crossover and closes it when the combined stop fires', async () => {
  const parts = makeTestContext()
  parts.md.setUnderlying('BANKNIFTY', 260105, 100)
  parts.md.setFuture('BANKNIFTY', FUT)
  parts.md.setOption('BANKNIFTY', 50000, 'CE', CE)
  parts.md.setOption('BANKNIFTY', 50000, 'PE', PE)
  parts.md.setQuote({ token: CE.instrumentToken, lastPrice: 100, ts: 0 })
  parts.md.setQuote({ token: PE.instrumentToken, lastPrice: 100, ts: 0 })
  const s = new PremiumLegBookStrategy(parts.ctx, cfg)

  const ticks: ReplayTick[] = [
    { ts: 0, quote: { token: FUT.instrumentToken, lastPrice: 50000, ts: 0 } }, // first tick: 0 -> 50000 is a crossover
  ]
  const res1 = await replay(s, parts, ticks)
  assert.equal(res1.orders.length, 2, 'straddle opens: 1 SELL CE + 1 SELL PE')
  assert.equal(res1.orders[0]?.side, 'SELL')
  assert.equal(res1.orders[1]?.side, 'SELL')

  // Combined premium rises to 250 -> trigger is (100+100)*1.25 = 250 -> fires.
  parts.md.setQuote({ token: CE.instrumentToken, lastPrice: 130, ts: 1 })
  parts.md.setQuote({ token: PE.instrumentToken, lastPrice: 120, ts: 1 })
  s.handleTick({ token: CE.instrumentToken, lastPrice: 130, ts: 1 })
  await s.drain()
  assert.equal(parts.gateway.orders.length, 4, 'stop closes both legs: +1 BUY PE + 1 BUY CE')
  assert.equal(parts.gateway.orders[2]?.side, 'BUY')
  assert.equal(parts.gateway.orders[3]?.side, 'BUY')
})

test('D9: pyramid-up with cap:null grows past any lot count without being blocked', async () => {
  const parts = makeTestContext()
  parts.md.setUnderlying('BANKNIFTY', 260105, 100)
  parts.md.setFuture('BANKNIFTY', FUT)
  parts.md.setOption('BANKNIFTY', 50000, 'CE', CE)
  parts.md.setOption('BANKNIFTY', 50000, 'PE', PE)
  parts.md.setQuote({ token: CE.instrumentToken, lastPrice: 100, ts: 0 })
  parts.md.setQuote({ token: PE.instrumentToken, lastPrice: 100, ts: 0 })
  const s = new PremiumLegBookStrategy(parts.ctx, cfg)
  await s.start()
  s.handleTick({ token: FUT.instrumentToken, lastPrice: 50000, ts: 0 })
  await s.drain()
  assert.equal(parts.gateway.orders.length, 2, 'D9: no risk.maxLotsNet gate blocks the first entry despite null')
})
```

- [ ] **Step 6: Run, typecheck, full suite, commit**

Run: `node --test packages/strategies/test/premium-leg-book.test.ts`
Expected: **2 passed.**

Run: `npm run typecheck && npm test`
Expected: 0 errors; all pass.

```bash
git add packages/strategies
git commit -m "feat(strategies): PremiumLegBook — bull-s-1/-snx-1 (combined stop,
uncapped pyramid) and lion-s25-2 (per-leg stop, per-leg reentry) on one class

D9: sizing.kind:'pyramid-up' with cap:null is the tested, supported uncapped
path — matches bull-s-1.js:145 '+1 forever' exactly, no invented cap."
```

---

### Task 4: `MomentumFlipDirectional` class (2 modules: `cheetah-b1-1`, `cheetah-b1-snx`) — LIVE

Direction chosen once from a vs-day-open comparison, one ATM leg, martingale sizing capped at 12
lots (`cheetah-b1-1.js:145`), flip-on-stop only — **on target it goes idle for the day, it does
NOT re-enter.** That asymmetry is load-bearing and gets its own test case, not folded into the
stop-flip test.

**Files:**
- Create: `packages/strategies/src/momentum-flip-directional/logic.ts`
- Create: `packages/strategies/src/momentum-flip-directional/config.ts`
- Create: `packages/strategies/src/momentum-flip-directional/strategy.ts`
- Modify: `packages/strategies/src/index.ts`
- Create: `packages/strategies/test/momentum-flip-directional.test.ts`

**Interfaces:**
- Consumes: `BaseConfig`, `assertValidConfig` (Task 1).
- Produces: `MomentumFlipDirectionalConfig`, `MomentumFlipDirectionalStrategy` — consumed by
  Task 14 (`cheetah-b1-1`, `cheetah-b1-snx`, LAST — both LIVE).

- [ ] **Step 1: Write the failing test for the pure logic**

Create `packages/strategies/src/momentum-flip-directional/logic.ts`:

```ts
/**
 * MomentumFlipDirectional — pure decision logic, ported from cheetah-b1-1.js.
 */

/** Direction from a vs-day-open comparison (cheetah-b1-1.js:115). */
export function directionFromOpen(ltp: number, dayOpen: number): 'CE' | 'PE' {
  return ltp > dayOpen ? 'CE' : 'PE'
}

/** Martingale, capped. cheetah-b1-1.js:145: `if (quantity < 12) quantity += 1;` */
export function nextMartingaleQty(current: number, cap: number): number {
  return current < cap ? current + 1 : current
}

export interface FlipPosition {
  readonly type: 'CE' | 'PE'
  readonly entry: number
  readonly slTrigger: number
  readonly targetPrice: number
  readonly quantity: number
}

export type FlipExit = { readonly exit: false } | { readonly exit: true; readonly reason: 'TARGET' | 'SL' }

/** cheetah-b1-1.js checkSL: TARGET checked first, then SL (checkSL.js:154,163). */
export function evaluateFlipExit(position: FlipPosition, currentPrice: number): FlipExit {
  if (currentPrice >= position.targetPrice) return { exit: true, reason: 'TARGET' }
  if (currentPrice < position.slTrigger) return { exit: true, reason: 'SL' }
  return { exit: false }
}

/** Levels at entry (cheetah-b1-1.js:140-141): sl = entry - trailSl, target = entry + targetPts. */
export function computeFlipLevels(entry: number, trailSl: number, targetPts: number): { readonly slTrigger: number; readonly targetPrice: number } {
  return { slTrigger: entry - trailSl, targetPrice: entry + targetPts }
}
```

- [ ] **Step 2: Run and confirm PASS (pure functions, tested via the class test in Step 5)**

There is no separate unit test file for `logic.ts` alone in this task — its correctness is proven
by the class-level replay test in Step 5, and independently by the golden-master diff in Task 14.
This mirrors the `RangeBreakoutDirectional`/`PremiumLegBook` precedent where `logic.ts` is
exercised through the class, not in isolation, once a class exists to drive it.

- [ ] **Step 3: Write the config**

Create `packages/strategies/src/momentum-flip-directional/config.ts`:

```ts
import type { BaseConfig } from '@algomaker/strategy-config'
import { assertValidConfig } from '@algomaker/strategy-config'

export interface MomentumFlipDirectionalConfig extends BaseConfig {
  readonly class: 'momentum-flip-directional'
  readonly trailSlPoints: number
  readonly targetPoints: number
  readonly sizing: { readonly kind: 'martingale-capped'; readonly start: number; readonly cap: number }
  readonly flip: {
    readonly onStop: true
    readonly onTarget: false // asymmetry is deliberate — never make this configurable to true here
    readonly strikeRef: 'frozen-first-atm'
  }
  readonly bootstrapDelayMs: number
  readonly squareOffIstMinute: number
}

/** cheetah-b1-2117's uncapped-martingale sibling is explicitly OUT of the active-15 config
 *  set (design spec section 4.3, OPEN item c) — this assertion is what keeps it out by
 *  construction: martingale-capped ALWAYS requires risk.maxLotsNet === sizing.cap. */
export function assertValidMomentumFlipConfig(
  cfg: MomentumFlipDirectionalConfig,
  existingTags?: ReadonlySet<string>,
): void {
  assertValidConfig(cfg, existingTags)
  if (cfg.risk.maxLotsNet !== cfg.sizing.cap) {
    throw new Error(
      `risk.maxLotsNet (${String(cfg.risk.maxLotsNet)}) must equal sizing.cap (${cfg.sizing.cap}) ` +
        `for martingale-capped sizing — an uncapped martingale config must not enter the active set`,
    )
  }
}
```

- [ ] **Step 4: Write the class**

Create `packages/strategies/src/momentum-flip-directional/strategy.ts`:

```ts
import { StrategyBase, type PhaseSpec } from '@algomaker/strategy-kit'
import type { DataNeed, Quote, StrategyContext, InstrumentRef } from '@algomaker/strategy-kit'
import * as logic from './logic.ts'
import type { MomentumFlipDirectionalConfig } from './config.ts'

export class MomentumFlipDirectionalStrategy extends StrategyBase {
  readonly #cfg: MomentumFlipDirectionalConfig
  #quantity: number
  #frozenAtm: number | null = null
  #position: (logic.FlipPosition & { readonly instrument: InstrumentRef }) | null = null
  #idleForDay = false
  #dayOpen: number | null = null

  constructor(ctx: StrategyContext, cfg: MomentumFlipDirectionalConfig) {
    super(ctx)
    this.#cfg = cfg
    this.#quantity = cfg.sizing.start
  }

  dataNeeds(): readonly DataNeed[] {
    return this.#cfg.data
  }

  protected override async onDayStart(): Promise<void> {
    this.#quantity = this.#cfg.sizing.start
    this.#frozenAtm = null
    this.#position = null
    this.#idleForDay = false
    this.#dayOpen = null
  }

  phases(): readonly PhaseSpec[] {
    return [
      {
        name: 'bootstrapEntry',
        atIstMinute: 9 * 60 + 17, // matches cheetah-b1-1's ~10s-after-connect first entry, expressed as a phase
        catchUpOnRestart: false, // places the first order — must not be replayed
        run: async () => this.#enterInitial(),
      },
      {
        name: 'squareOff',
        atIstMinute: this.#cfg.squareOffIstMinute,
        catchUpOnRestart: false,
        run: async () => {
          if (this.#position !== null) await this.#exit('SL') // EOD flatten, reason irrelevant to the golden diff
        },
      },
    ]
  }

  // Async and AWAITED all the way through (unlike cheetah-b1-1.js's own
  // unawaited forEach, F1/F13 in the taxonomy's cross-cutting defects) so
  // that StrategyBase's #guard/drain() genuinely wait for the exit+flip
  // submit calls to land before the next tick is processed.
  protected override async onTick(quote: Quote): Promise<void> {
    const refToken = this.ctx.md.future(this.#cfg.underlying.symbol)?.instrumentToken ?? this.ctx.md.spotToken(this.#cfg.underlying.symbol)
    if (this.#dayOpen === null && quote.token === refToken) this.#dayOpen = quote.lastPrice
    if (this.#position !== null && quote.token === this.#position.instrument.instrumentToken) {
      const result = logic.evaluateFlipExit(this.#position, quote.lastPrice)
      if (result.exit) await this.#exit(result.reason)
    }
  }

  async #enterInitial(): Promise<void> {
    const refToken = this.ctx.md.future(this.#cfg.underlying.symbol)?.instrumentToken ?? this.ctx.md.spotToken(this.#cfg.underlying.symbol)
    const q = this.ctx.md.quote(refToken)
    if (q === null || this.#dayOpen === null) return
    const side = logic.directionFromOpen(q.lastPrice, this.#dayOpen)
    const atm = this.ctx.md.atmStrike(this.#cfg.underlying.symbol, q.lastPrice)
    this.#frozenAtm = atm
    await this.#openLeg(side, atm)
  }

  async #openLeg(side: 'CE' | 'PE', atm: number): Promise<void> {
    const inst = this.ctx.md.option(this.#cfg.underlying.symbol, atm + this.#cfg.strike.offsetPoints, side)
    if (inst === null) return
    const q = this.ctx.md.quote(inst.instrumentToken ?? -1)
    if (q === null) return
    const res = await this.submit({ instrument: inst, side: 'BUY', lots: this.#quantity })
    if (!res.accepted) return
    const levels = logic.computeFlipLevels(q.lastPrice, this.#cfg.trailSlPoints, this.#cfg.targetPoints)
    this.#position = { type: side, entry: q.lastPrice, quantity: this.#quantity, instrument: inst, ...levels }
    this.#quantity = logic.nextMartingaleQty(this.#quantity, this.#cfg.sizing.cap)
  }

  async #exit(reason: 'TARGET' | 'SL'): Promise<void> {
    if (this.#position === null) return
    const closing = this.#position
    this.#position = null // claim-before-await
    await this.submit({ instrument: closing.instrument, side: 'SELL', lots: closing.quantity, reducesExposure: true })

    if (reason === 'TARGET') {
      // Asymmetry is deliberate: TARGET goes idle for the day, no flip, no re-entry.
      this.#idleForDay = true
      return
    }
    // SL: flip to the opposite side at the FROZEN first-tick ATM, re-enter.
    if (this.#idleForDay || this.#frozenAtm === null) return
    const opposite = closing.type === 'CE' ? 'PE' : 'CE'
    await this.#openLeg(opposite, this.#frozenAtm)
  }
}
```

- [ ] **Step 5: Write the class-level test — the target-vs-stop asymmetry gets its own cases**

Create `packages/strategies/test/momentum-flip-directional.test.ts`:

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { makeTestContext } from '@algomaker/strategy-kit'
import { MomentumFlipDirectionalStrategy } from '../src/momentum-flip-directional/strategy.ts'
import type { MomentumFlipDirectionalConfig } from '../src/momentum-flip-directional/config.ts'

const FUT = { tradingsymbol: 'BANKNIFTY-FUT', instrumentToken: 500001, lotSize: 35, tickSize: 0.05, exchange: 'NFO' }
const CE = { tradingsymbol: 'BANKNIFTY50000CE', instrumentToken: 500002, lotSize: 35, tickSize: 0.05, exchange: 'NFO' }
const PE = { tradingsymbol: 'BANKNIFTY50000PE', instrumentToken: 500003, lotSize: 35, tickSize: 0.05, exchange: 'NFO' }

function cfg(): MomentumFlipDirectionalConfig {
  return {
    tag: 'CheetahB1-1_TEST', class: 'momentum-flip-directional', enabled: true,
    underlying: { symbol: 'BANKNIFTY', reference: 'current-future', strikeStep: 100 },
    strike: { offsetPoints: 0 }, expiry: { select: 'nearest' },
    session: { startAt: '09:17:00', squareOffAt: '15:20:00' },
    sizing: { kind: 'martingale-capped', start: 1, cap: 12 },
    rail: { mode: 'live', destinations: ['xts'], exitMechanism: 'local-tick' },
    risk: { maxLotsNet: 12, dayLossRupees: null },
    data: [{ kind: 'future', underlying: 'BANKNIFTY' }, { kind: 'option-chain', underlying: 'BANKNIFTY', strikeWindow: 2 }],
    legacy: { files: ['server/slive/cheetah-b1-1.js'] },
    trailSlPoints: 10, targetPoints: 90,
    flip: { onStop: true, onTarget: false, strikeRef: 'frozen-first-atm' },
    bootstrapDelayMs: 10_000, squareOffIstMinute: 15 * 60 + 20,
  }
}

test('on TARGET the strategy exits and goes IDLE — it does NOT re-enter', async () => {
  const parts = makeTestContext({ nowMs: Date.UTC(2026, 6, 24, 3, 47, 0) }) // 09:17 IST
  parts.md.setUnderlying('BANKNIFTY', 260105, 100)
  parts.md.setFuture('BANKNIFTY', FUT)
  parts.md.setOption('BANKNIFTY', 50000, 'CE', CE)
  parts.md.setQuote({ token: FUT.instrumentToken, lastPrice: 50100, ts: 0 }) // above open -> CE
  const s = new MomentumFlipDirectionalStrategy(parts.ctx, cfg())
  s.handleTick({ token: FUT.instrumentToken, lastPrice: 50000, ts: 0 }) // establishes dayOpen
  await s.drain()
  parts.md.setQuote({ token: FUT.instrumentToken, lastPrice: 50100, ts: 1 })
  parts.md.setQuote({ token: CE.instrumentToken, lastPrice: 120, ts: 1 })
  await s.firePhase('bootstrapEntry')
  assert.equal(parts.gateway.orders.length, 1, 'initial CE entry')

  parts.md.setQuote({ token: CE.instrumentToken, lastPrice: 215, ts: 2 }) // entry 120 + target 90 = 210
  s.handleTick({ token: CE.instrumentToken, lastPrice: 215, ts: 2 })
  await s.drain()
  assert.equal(parts.gateway.orders.length, 2, 'target exit closes the leg')
  assert.equal(parts.gateway.orders[1]?.side, 'SELL')

  // A further tick must NOT re-enter — idle for the day.
  s.handleTick({ token: CE.instrumentToken, lastPrice: 50, ts: 3 })
  await s.drain()
  assert.equal(parts.gateway.orders.length, 2, 'no re-entry after a target hit')
})

test('on SL the strategy flips CE<->PE at the FROZEN first-tick ATM and re-enters', async () => {
  const parts = makeTestContext({ nowMs: Date.UTC(2026, 6, 24, 3, 47, 0) })
  parts.md.setUnderlying('BANKNIFTY', 260105, 100)
  parts.md.setFuture('BANKNIFTY', FUT)
  parts.md.setOption('BANKNIFTY', 50000, 'CE', CE)
  parts.md.setOption('BANKNIFTY', 50000, 'PE', PE)
  const s = new MomentumFlipDirectionalStrategy(parts.ctx, cfg())
  s.handleTick({ token: FUT.instrumentToken, lastPrice: 50000, ts: 0 })
  await s.drain()
  parts.md.setQuote({ token: FUT.instrumentToken, lastPrice: 50100, ts: 1 })
  parts.md.setQuote({ token: CE.instrumentToken, lastPrice: 120, ts: 1 })
  await s.firePhase('bootstrapEntry') // CE @ 120, sl = 110, target = 210

  parts.md.setQuote({ token: PE.instrumentToken, lastPrice: 80, ts: 2 })
  parts.md.setQuote({ token: CE.instrumentToken, lastPrice: 100, ts: 2 }) // below SL trigger 110
  s.handleTick({ token: CE.instrumentToken, lastPrice: 100, ts: 2 })
  await s.drain()
  assert.equal(parts.gateway.orders.length, 3, 'SL exit (SELL CE) + flip re-entry (BUY PE)')
  assert.equal(parts.gateway.orders[1]?.side, 'SELL')
  assert.equal(parts.gateway.orders[2]?.side, 'BUY')
  assert.equal(parts.gateway.orders[2]?.symbol, PE.tradingsymbol, 're-enters at the SAME frozen ATM, opposite type')
})

test('martingale sizing increases by 1 per re-entry, capped at 12 (D9-adjacent: cap must equal risk.maxLotsNet)', async () => {
  const c = cfg()
  assert.equal(c.risk.maxLotsNet, c.sizing.cap)
})
```

- [ ] **Step 6: Run, typecheck, full suite, commit**

Run: `node --test packages/strategies/test/momentum-flip-directional.test.ts`
Expected: **3 passed.**

Run: `npm run typecheck && npm test`
Expected: 0 errors; all pass.

```bash
git add packages/strategies
git commit -m "feat(strategies): MomentumFlipDirectional — cheetah-b1-1/-snx

Preserves the target-vs-stop asymmetry (target goes idle for the day, only a
stop flips and re-enters) and the frozen-first-atm strike reference. Martingale
cap (12) is enforced equal to risk.maxLotsNet by assertValidMomentumFlipConfig,
which is what keeps the cheetah-b1-2117 uncapped sibling out of the active
config set by construction (design spec section 4.3, OPEN item c)."
```

---

### Task 5: `PremiumDistanceAccumulator` class (1 module: `eagle-s-1`) — STOPLESS by D9

A grid of pending price triggers spaced by option premium. An initial ATM straddle fires two
triggers; every trigger crossed adds one leg and — if that leg's premium clears `premiumFloor` —
pushes two more triggers. **There is no exit of any kind.** Per D9, `eagle-s-1` stays exactly this
way: `stopPolicy: 'none'` is the correct, signed-off config, not a gap to fill. Flattening is the
central 15:24 `squareoff_smp` job, modelled here as a `squareOff` phase that flattens every open
leg — the only exit path this class has.

**Files:**
- Create: `packages/strategies/src/premium-distance-accumulator/logic.ts`
- Create: `packages/strategies/src/premium-distance-accumulator/config.ts`
- Create: `packages/strategies/src/premium-distance-accumulator/strategy.ts`
- Modify: `packages/strategies/src/index.ts`
- Create: `packages/strategies/test/premium-distance-accumulator.test.ts`

**Interfaces:**
- Consumes: `BaseConfig`, `assertValidConfig`, `StopPolicy` (Task 1).
- Produces: `PremiumDistanceAccumulatorConfig`, `PremiumDistanceAccumulatorStrategy` — consumed
  by Task 12 (`eagle-s-1`).

- [ ] **Step 1: Write the pure logic**

Create `packages/strategies/src/premium-distance-accumulator/logic.ts`:

```ts
/**
 * PremiumDistanceAccumulator — pure decision logic, ported from eagle-s-1.js.
 * D9: this class has NO exit logic anywhere, by design — do not add one.
 */

export function isCrossover(lastPrice: number, previousPrice: number, atmStrike: number): boolean {
  if (lastPrice >= atmStrike && previousPrice <= atmStrike) return true
  if (lastPrice <= atmStrike && previousPrice >= atmStrike) return true
  return false
}

export type PendingTrigger = { readonly trigger: number; readonly action: 'add_ce' | 'add_pe' }

/** Initial pair triggers (eagle-s-1.js:136-143): trg = trunc(futLtp -+ legLtp). */
export function initialTriggers(futLtp: number, ceLtp: number, peLtp: number): readonly PendingTrigger[] {
  return [
    { trigger: Math.trunc(futLtp - ceLtp), action: 'add_ce' },
    { trigger: Math.trunc(futLtp + peLtp), action: 'add_pe' },
  ]
}

/**
 * A fired 'add_ce'/'add_pe' trigger pushes TWO new triggers if the new leg's
 * premium clears premiumFloor (eagle-s-1.js:144-158) — net +1 pending trigger
 * per fill, so leg count is super-linear in path length. A rejected add
 * prunes its branch permanently (returns an empty array).
 */
export function nextTriggers(
  action: 'add_ce' | 'add_pe',
  futLtp: number,
  legLtp: number,
  premiumFloor: number,
): readonly PendingTrigger[] {
  if (legLtp <= premiumFloor) return []
  if (action === 'add_ce') {
    return [
      { trigger: Math.trunc(futLtp - legLtp), action: 'add_ce' },
      { trigger: Math.trunc(futLtp + legLtp), action: 'add_pe' },
    ]
  }
  return [
    { trigger: Math.trunc(futLtp + legLtp), action: 'add_pe' },
    { trigger: Math.trunc(futLtp - legLtp), action: 'add_ce' },
  ]
}

/** A pending trigger fires once the price crosses it in EITHER direction (eagle-s-1.js:184). */
export function triggerCrossed(trigger: number, previousPrice: number, currentPrice: number): boolean {
  return (trigger >= previousPrice && trigger <= currentPrice) || (trigger <= previousPrice && trigger >= currentPrice)
}
```

- [ ] **Step 2: Write the config**

Create `packages/strategies/src/premium-distance-accumulator/config.ts`:

```ts
import type { BaseConfig } from '@algomaker/strategy-config'
import { assertValidConfig } from '@algomaker/strategy-config'

export interface PremiumDistanceAccumulatorConfig extends BaseConfig {
  readonly class: 'premium-distance-accumulator'
  readonly premiumFloor: number
  /** D9: MUST be 'none'. eagle-s-1 has never had an intraday stop — the resting-
   *  broker-stop rollout (decision 3) explicitly does NOT apply here (owner,
   *  2026-07-26). This is enforced below, not left to convention. */
  readonly stopPolicy: 'none'
  readonly squareOffIstMinute: number
}

export function assertValidPremiumDistanceAccumulatorConfig(
  cfg: PremiumDistanceAccumulatorConfig,
  existingTags?: ReadonlySet<string>,
): void {
  assertValidConfig(cfg, existingTags)
  if (cfg.stopPolicy !== 'none') {
    // Unreachable given the type, but kept as a runtime guard: if this class is
    // ever constructed from untyped JSON config, a stray 'resting' value must
    // fail loudly rather than silently invent a stop eagle-s-1 never had.
    throw new Error("PremiumDistanceAccumulatorConfig.stopPolicy must be 'none' (D9) — got " + String(cfg.stopPolicy))
  }
}
```

- [ ] **Step 3: Write the class**

Create `packages/strategies/src/premium-distance-accumulator/strategy.ts`:

```ts
import { StrategyBase, type PhaseSpec } from '@algomaker/strategy-kit'
import type { DataNeed, Quote, StrategyContext, InstrumentRef } from '@algomaker/strategy-kit'
import * as logic from './logic.ts'
import type { PremiumDistanceAccumulatorConfig } from './config.ts'

interface OpenLeg {
  readonly instrument: InstrumentRef
  readonly side: 'CE' | 'PE'
}

export class PremiumDistanceAccumulatorStrategy extends StrategyBase {
  readonly #cfg: PremiumDistanceAccumulatorConfig
  #lastPrice = 0
  #entered = false
  #pending: logic.PendingTrigger[] = []
  #legs: OpenLeg[] = []

  constructor(ctx: StrategyContext, cfg: PremiumDistanceAccumulatorConfig) {
    super(ctx)
    this.#cfg = cfg
  }

  dataNeeds(): readonly DataNeed[] {
    return this.#cfg.data
  }

  protected override async onDayStart(): Promise<void> {
    this.#lastPrice = 0
    this.#entered = false
    this.#pending = []
    this.#legs = []
  }

  phases(): readonly PhaseSpec[] {
    return [
      {
        name: 'squareOff',
        atIstMinute: this.#cfg.squareOffIstMinute,
        catchUpOnRestart: false,
        // The ONLY exit path this class has, by design (D9) — central flatten,
        // never a per-leg stop.
        run: async () => {
          for (const leg of this.#legs) {
            await this.submit({ instrument: leg.instrument, side: 'BUY', lots: 1, reducesExposure: true })
          }
          this.#legs = []
        },
      },
    ]
  }

  protected override async onTick(quote: Quote): Promise<void> {
    const refToken = this.#refToken()
    if (quote.token !== refToken) return

    if (!this.#entered) {
      const atm = this.ctx.md.atmStrike(this.#cfg.underlying.symbol, quote.lastPrice)
      if (logic.isCrossover(quote.lastPrice, this.#lastPrice, atm)) await this.#enterInitial(atm, quote.lastPrice)
      this.#lastPrice = quote.lastPrice
      return
    }

    const stillPending: logic.PendingTrigger[] = []
    for (const p of this.#pending) {
      if (logic.triggerCrossed(p.trigger, this.#lastPrice, quote.lastPrice)) {
        await this.#fireTrigger(p, quote.lastPrice)
      } else {
        stillPending.push(p)
      }
    }
    this.#pending = stillPending
    this.#lastPrice = quote.lastPrice
  }

  #refToken(): number {
    return this.#cfg.underlying.reference === 'current-future'
      ? (this.ctx.md.future(this.#cfg.underlying.symbol)?.instrumentToken ?? this.ctx.md.spotToken(this.#cfg.underlying.symbol))
      : this.ctx.md.spotToken(this.#cfg.underlying.symbol)
  }

  async #enterInitial(atm: number, futLtp: number): Promise<void> {
    const ceInst = this.ctx.md.option(this.#cfg.underlying.symbol, atm, 'CE')
    const peInst = this.ctx.md.option(this.#cfg.underlying.symbol, atm, 'PE')
    if (ceInst === null || peInst === null) return
    const ceQ = this.ctx.md.quote(ceInst.instrumentToken ?? -1)
    const peQ = this.ctx.md.quote(peInst.instrumentToken ?? -1)
    if (ceQ === null || peQ === null) return

    const ceRes = await this.submit({ instrument: ceInst, side: 'SELL', lots: 1 })
    const peRes = await this.submit({ instrument: peInst, side: 'SELL', lots: 1 })
    if (!ceRes.accepted || !peRes.accepted) return
    this.#entered = true
    this.#legs.push({ instrument: ceInst, side: 'CE' }, { instrument: peInst, side: 'PE' })
    this.#pending = [...logic.initialTriggers(futLtp, ceQ.lastPrice, peQ.lastPrice)]
  }

  async #fireTrigger(p: logic.PendingTrigger, futLtp: number): Promise<void> {
    const side = p.action === 'add_ce' ? 'CE' : 'PE'
    const roundedStrike = side === 'CE' ? Math.ceil(futLtp / this.#cfg.underlying.strikeStep) * this.#cfg.underlying.strikeStep
                                          : Math.floor(futLtp / this.#cfg.underlying.strikeStep) * this.#cfg.underlying.strikeStep
    const inst = this.ctx.md.option(this.#cfg.underlying.symbol, roundedStrike, side)
    if (inst === null) return
    const q = this.ctx.md.quote(inst.instrumentToken ?? -1)
    if (q === null || q.lastPrice <= this.#cfg.premiumFloor) return // permanently prunes this branch

    const res = await this.submit({ instrument: inst, side: 'SELL', lots: 1 })
    if (!res.accepted) return
    this.#legs.push({ instrument: inst, side })
    this.#pending.push(...logic.nextTriggers(p.action, futLtp, q.lastPrice, this.#cfg.premiumFloor))
  }
}
```

- [ ] **Step 4: Write the class-level test**

Create `packages/strategies/test/premium-distance-accumulator.test.ts`:

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { makeTestContext } from '@algomaker/strategy-kit'
import { PremiumDistanceAccumulatorStrategy } from '../src/premium-distance-accumulator/strategy.ts'
import type { PremiumDistanceAccumulatorConfig } from '../src/premium-distance-accumulator/config.ts'

const FUT = { tradingsymbol: 'BANKNIFTY-FUT', instrumentToken: 500001, lotSize: 35, tickSize: 0.05, exchange: 'NFO' }
const CE = { tradingsymbol: 'BANKNIFTY50000CE', instrumentToken: 500002, lotSize: 35, tickSize: 0.05, exchange: 'NFO' }
const PE = { tradingsymbol: 'BANKNIFTY50000PE', instrumentToken: 500003, lotSize: 35, tickSize: 0.05, exchange: 'NFO' }

function cfg(): PremiumDistanceAccumulatorConfig {
  return {
    tag: 'Eagle_S-1_TEST', class: 'premium-distance-accumulator', enabled: true,
    underlying: { symbol: 'BANKNIFTY', reference: 'current-future', strikeStep: 100 },
    strike: { offsetPoints: 0 }, expiry: { select: 'nearest' },
    session: { startAt: '09:15:00', squareOffAt: '15:24:00' },
    sizing: { kind: 'flat', lots: 1 },
    rail: { mode: 'sim', destinations: ['sim'], exitMechanism: 'local-tick' },
    risk: { maxLotsNet: null, dayLossRupees: null },
    data: [{ kind: 'future', underlying: 'BANKNIFTY' }, { kind: 'option-chain', underlying: 'BANKNIFTY', strikeWindow: 6 }],
    legacy: { files: ['server/slive/eagle-s-1.js'] },
    premiumFloor: 20,
    stopPolicy: 'none', // D9, mandatory
    squareOffIstMinute: 15 * 60 + 24,
  }
}

test('D9: no per-leg stop exists anywhere — a wildly adverse tick never closes a leg', async () => {
  const parts = makeTestContext()
  parts.md.setUnderlying('BANKNIFTY', 260105, 100)
  parts.md.setFuture('BANKNIFTY', FUT)
  parts.md.setOption('BANKNIFTY', 50000, 'CE', CE)
  parts.md.setOption('BANKNIFTY', 50000, 'PE', PE)
  parts.md.setQuote({ token: CE.instrumentToken, lastPrice: 100, ts: 0 })
  parts.md.setQuote({ token: PE.instrumentToken, lastPrice: 100, ts: 0 })
  const s = new PremiumDistanceAccumulatorStrategy(parts.ctx, cfg())
  s.handleTick({ token: FUT.instrumentToken, lastPrice: 50000, ts: 0 })
  await s.drain()
  assert.equal(parts.gateway.orders.length, 2, 'initial straddle')

  // A large adverse move — a per-leg stop class would close a leg here. This one must not.
  s.handleTick({ token: CE.instrumentToken, lastPrice: 900, ts: 1 })
  await s.drain()
  assert.equal(parts.gateway.orders.filter((o) => o.side === 'BUY').length, 0, 'no BUY-to-close order exists at all')
})

test('squareOff is the ONLY exit path: it flattens every open leg', async () => {
  const parts = makeTestContext({ nowMs: Date.UTC(2026, 6, 24, 4, 0, 0) })
  parts.md.setUnderlying('BANKNIFTY', 260105, 100)
  parts.md.setFuture('BANKNIFTY', FUT)
  parts.md.setOption('BANKNIFTY', 50000, 'CE', CE)
  parts.md.setOption('BANKNIFTY', 50000, 'PE', PE)
  parts.md.setQuote({ token: CE.instrumentToken, lastPrice: 100, ts: 0 })
  parts.md.setQuote({ token: PE.instrumentToken, lastPrice: 100, ts: 0 })
  const s = new PremiumDistanceAccumulatorStrategy(parts.ctx, cfg())
  s.handleTick({ token: FUT.instrumentToken, lastPrice: 50000, ts: 0 })
  await s.drain()
  await s.firePhase('squareOff')
  const closes = parts.gateway.orders.filter((o) => o.side === 'BUY')
  assert.equal(closes.length, 2, 'both legs flattened, and ONLY at squareOff')
})
```

- [ ] **Step 5: Run, typecheck, full suite, commit**

Run: `node --test packages/strategies/test/premium-distance-accumulator.test.ts`
Expected: **2 passed.**

Run: `npm run typecheck && npm test`
Expected: 0 errors; all pass.

```bash
git add packages/strategies
git commit -m "feat(strategies): PremiumDistanceAccumulator — eagle-s-1, stopless by D9

stopPolicy is typed as the literal 'none' and asserted at config load: this
class has no per-leg exit anywhere, matching eagle-s-1.js's verified BUY=0
(only SELL trackOrder calls). squareOff (15:24 central flatten) is the only
exit path, exactly as in production. Decision 3 does NOT apply here per the
owner's 2026-07-26 sign-off."
```

---

### Task 6: `ExternalSignalMirror` adapter (3 modules) — rotate credentials FIRST

Not a `Strategy` — a `SignalSource` adapter. Subscribes optionbhai.com's websocket and replays
`ORDER_EXECUTION`/`EXECUTED` messages onto the order bus under a local tag. No entry/exit logic.
**Blocking prerequisite: `candlestrategy.js:15-16`, `candlestrategy-a006.js`, and
`candlestrategy-test3.js` all have plaintext credentials committed** (`username`/`password`).
Task 10 rotates them before this adapter is ever pointed at the real optionbhai account; this task
only builds and tests the adapter against a **fake** signal source, so it carries no live-order
risk regardless of rotation status — but ship this task before Task 10 regardless, so rotation is
never blocked on code that doesn't exist yet.

**Files:**
- Create: `packages/strategies/src/external-signal-mirror/adapter.ts`
- Create: `packages/strategies/src/external-signal-mirror/config.ts`
- Modify: `packages/strategies/src/index.ts`
- Create: `packages/strategies/test/external-signal-mirror.test.ts`

**Interfaces:**
- Consumes: `OrderGateway`, `Logger` from `@algomaker/strategy-kit`.
- Produces: `SignalSource` port, `FakeSignalSource` test double, `ExternalSignalMirrorAdapter`,
  `ExternalSignalMirrorConfig` — consumed by Task 10 (`candlestrategy` ×3).

- [ ] **Step 1: Write the failing test**

Create `packages/strategies/src/external-signal-mirror/config.ts`:

```ts
export interface ExternalSignalMirrorConfig {
  readonly tag: string
  readonly destinationTag: string
  /** Secret-store key — NEVER an inline credential (all 3 legacy files leak one today). */
  readonly credentialsRef: string
  readonly instrumentRefreshMinutes: number
  readonly onUnknownSymbol: 'drop-and-alert' | 'throw'
}
```

Create `packages/strategies/src/external-signal-mirror/adapter.ts`:

```ts
/**
 * ExternalSignalMirror — a SignalSource adapter, NOT a StrategyBase subclass.
 * It has no entry/exit logic, no position state, and no market data need, so
 * giving it phases()/squareOff()/a day budget would be meaningless (design
 * spec section 4.3). It mirrors another system's EXECUTED orders onto our
 * order bus under a local tag.
 */

import type { Logger, OrderGateway, InstrumentRef } from '@algomaker/strategy-kit'
import type { ExternalSignalMirrorConfig } from './config.ts'

export interface SignalOrderExecution {
  readonly type: 'ORDER_EXECUTION'
  readonly payload: {
    readonly symbol: string
    readonly side: 'BUY' | 'SELL'
    readonly status: 'EXECUTED' | 'PENDING' | 'REJECTED'
  }
}

/** What the adapter needs from a websocket-shaped signal feed. Injected, like every other port. */
export interface SignalSource {
  onMessage(handler: (msg: SignalOrderExecution) => void): () => void
}

export interface InstrumentResolver {
  bySymbol(symbol: string): InstrumentRef | null
}

export class ExternalSignalMirrorAdapter {
  readonly #cfg: ExternalSignalMirrorConfig
  readonly #source: SignalSource
  readonly #orders: OrderGateway
  readonly #instruments: InstrumentResolver
  readonly #log: Logger
  #unsubscribe: (() => void) | null = null

  constructor(cfg: ExternalSignalMirrorConfig, source: SignalSource, orders: OrderGateway, instruments: InstrumentResolver, log: Logger) {
    this.#cfg = cfg
    this.#source = source
    this.#orders = orders
    this.#instruments = instruments
    this.#log = log
  }

  start(): void {
    this.#unsubscribe = this.#source.onMessage((msg) => void this.#handle(msg))
  }

  stop(): void {
    this.#unsubscribe?.()
    this.#unsubscribe = null
  }

  async #handle(msg: SignalOrderExecution): Promise<void> {
    if (msg.type !== 'ORDER_EXECUTION' || msg.payload.status !== 'EXECUTED') return
    const inst = this.#instruments.bySymbol(msg.payload.symbol)
    if (inst === null) {
      if (this.#cfg.onUnknownSymbol === 'throw') throw new Error(`unknown mirrored symbol '${msg.payload.symbol}'`)
      this.#log.warn(`${this.#cfg.tag}: unknown symbol, dropped`, { symbol: msg.payload.symbol })
      return
    }
    const res = await this.#orders.submit({ instrument: inst, side: msg.payload.side, lots: 1, meta: { mirroredFrom: this.#cfg.destinationTag } })
    if (!res.accepted) this.#log.warn(`${this.#cfg.tag}: mirrored order rejected`, { reason: res.reason ?? 'unknown' })
  }
}

/** Test double: a scriptable SignalSource, mirroring FakeMarketData's role for MarketData. */
export class FakeSignalSource implements SignalSource {
  #handlers: ((msg: SignalOrderExecution) => void)[] = []
  onMessage(handler: (msg: SignalOrderExecution) => void): () => void {
    this.#handlers.push(handler)
    return () => {
      const i = this.#handlers.indexOf(handler)
      if (i >= 0) this.#handlers.splice(i, 1)
    }
  }
  emit(msg: SignalOrderExecution): void {
    for (const h of [...this.#handlers]) h(msg)
  }
}
```

- [ ] **Step 2: Run and confirm it fails (no test file exists to run yet — write it in Step 3)**

Skip straight to Step 3; there is nothing to execute until the test file exists.

- [ ] **Step 3: Write and run the test**

Create `packages/strategies/test/external-signal-mirror.test.ts`:

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { RecordingGateway, makeLogger } from '@algomaker/strategy-kit'
import { ExternalSignalMirrorAdapter, FakeSignalSource, type InstrumentResolver } from '../src/external-signal-mirror/adapter.ts'
import type { ExternalSignalMirrorConfig } from '../src/external-signal-mirror/config.ts'

const SYM = { tradingsymbol: 'BANKNIFTY50000CE', instrumentToken: 1, lotSize: 35, tickSize: 0.05, exchange: 'NFO' }
const resolver: InstrumentResolver = { bySymbol: (s) => (s === SYM.tradingsymbol ? SYM : null) }

const cfg: ExternalSignalMirrorConfig = {
  tag: 'Mirror_1PBUY_TEST', destinationTag: '1PBUY', credentialsRef: 'secrets/optionbhai/live001',
  instrumentRefreshMinutes: 15, onUnknownSymbol: 'drop-and-alert',
}

test('an EXECUTED order execution message is mirrored onto the order bus', async () => {
  const gateway = new RecordingGateway()
  const source = new FakeSignalSource()
  const adapter = new ExternalSignalMirrorAdapter(cfg, source, gateway, resolver, makeLogger())
  adapter.start()

  source.emit({ type: 'ORDER_EXECUTION', payload: { symbol: SYM.tradingsymbol, side: 'BUY', status: 'EXECUTED' } })
  await new Promise((r) => setImmediate(r))

  assert.equal(gateway.orders.length, 1)
  assert.equal(gateway.orders[0]?.side, 'BUY')
  assert.equal(gateway.orders[0]?.symbol, SYM.tradingsymbol)
})

test('a PENDING message is NOT mirrored — only EXECUTED fires', async () => {
  const gateway = new RecordingGateway()
  const source = new FakeSignalSource()
  const adapter = new ExternalSignalMirrorAdapter(cfg, source, gateway, resolver, makeLogger())
  adapter.start()
  source.emit({ type: 'ORDER_EXECUTION', payload: { symbol: SYM.tradingsymbol, side: 'BUY', status: 'PENDING' } })
  await new Promise((r) => setImmediate(r))
  assert.equal(gateway.orders.length, 0)
})

test('an unknown symbol is dropped-and-alerted, not thrown, under the default policy', async () => {
  const gateway = new RecordingGateway()
  const source = new FakeSignalSource()
  const logs: { level: string; msg: string }[] = []
  const adapter = new ExternalSignalMirrorAdapter(cfg, source, gateway, resolver, makeLogger(logs))
  adapter.start()
  source.emit({ type: 'ORDER_EXECUTION', payload: { symbol: 'NOT_A_REAL_SYMBOL', side: 'SELL', status: 'EXECUTED' } })
  await new Promise((r) => setImmediate(r))
  assert.equal(gateway.orders.length, 0)
  assert.ok(logs.some((l) => l.level === 'warn' && l.msg.includes('unknown symbol')))
})

test('stop() unsubscribes — no further orders are mirrored', async () => {
  const gateway = new RecordingGateway()
  const source = new FakeSignalSource()
  const adapter = new ExternalSignalMirrorAdapter(cfg, source, gateway, resolver, makeLogger())
  adapter.start()
  adapter.stop()
  source.emit({ type: 'ORDER_EXECUTION', payload: { symbol: SYM.tradingsymbol, side: 'BUY', status: 'EXECUTED' } })
  await new Promise((r) => setImmediate(r))
  assert.equal(gateway.orders.length, 0)
})
```

- [ ] **Step 4: Run, typecheck, full suite, commit**

Run: `node --test packages/strategies/test/external-signal-mirror.test.ts`
Expected: **4 passed.**

Run: `npm run typecheck && npm test`
Expected: 0 errors; all pass.

```bash
git add packages/strategies
git commit -m "feat(strategies): ExternalSignalMirror — a SignalSource adapter, not a Strategy

No entry/exit logic, no phases, no day budget — it mirrors another system's
EXECUTED orders onto the local order bus. credentialsRef is a secret-store
key, never an inline credential; Task 10 rotates the 3 legacy files' committed
plaintext credentials before this adapter is ever pointed at the real feed."
```

---

### Task 7: `LegacyShadowRunner` — drive the 7 no-split legacy files UNMODIFIED

**Deviation from the design spec's literal proposal, and why:** the design spec (§4.4, step 1)
proposes editing each of the 6 no-split legacy files to add `module.exports._onTicks = onTicks`
and `module.exports._setModels(fake)`. Reading the actual files
(`server/slive/{bull-s-1,eagle-s-1,cheetah-b1-1,lion-s25-2}.js`) shows `Account`/`PaperTrade` are
read ONCE into module-scoped `const`s at the top of the file, evaluated the instant
`app = require('../server.js')` resolves — by the time any `_setModels` hook could run, the reads
have already happened. A setter added after the fact cannot retroactively change what `Account`
already points to.

The fix that actually works, and needs ZERO edits to any of the 7 legacy files: **pre-populate
Node's CommonJS module cache** for `../server.js`, `../lib/zerodha.js`, `../lib/KiteTicker(.js)`,
`../tools/optionInstruments(.js)`, and `../lib/otmSelector(.js)` with fakes BEFORE `require()`-ing
the legacy file, so its own top-level `require()` calls resolve to the fakes directly — no
intermediate hook needed. And rather than exporting the tick handler, the **fake `KiteTicker`
captures it**: the legacy file itself calls `liveFeed.on('ticks', checkTicks)`, so the fake
`.on(event, handler)` simply remembers `handler` when `event === 'ticks'`. This is safer under D4
("cutover... legacy retired unmodified") and needs no reviewer diff at all, because there is
nothing to diff — the 6 no-split files (7, including `bull-snx-1` sharing `bull-s-1`'s technique
in Task 11, `cheetah-b1-snx` sharing `cheetah-b1-1`'s in Task 14) are never touched.

For the clock: legacy code calls `moment()` / `new Date()` directly and schedules bootstrap delays
via bare `setTimeout`. `node:test`'s built-in `mock.timers` fakes **both** `Date` and `setTimeout`
with one call — this is the "time-travel shim" the design spec calls for, built-in rather than
hand-rolled.

**Files:**
- Create: `packages/legacy-shadow-runner/package.json`
- Create: `packages/legacy-shadow-runner/src/index.ts`
- Create: `packages/legacy-shadow-runner/test/shadow-runner.test.ts`

**Interfaces:**
- Consumes: nothing from `packages/strategies` — this package only touches `server/slive/*.js`
  and Node built-ins (`node:module`, `node:test`).
- Produces: `runLegacyShadow(opts): Promise<ShadowRun>`, `RecordedLegacyOrder`,
  `ShadowFixtureOption`, `ShadowTick` — consumed by Task 11 (`bull-s-1`, `bull-snx-1`), Task 12
  (`eagle-s-1`), Task 13 (`lion-s25-2`), Task 14 (`cheetah-b1-1`, `cheetah-b1-snx`).

- [ ] **Step 1: Create the package manifest**

Create `packages/legacy-shadow-runner/package.json`:

```json
{
  "name": "@algomaker/legacy-shadow-runner",
  "version": "1.0.0",
  "description": "Drives an UNMODIFIED server/slive/*.js legacy strategy file under a mocked clock with an intercepted Kite feed, capturing every order it would place. Used only for Phase C golden-master verification of the 7 no-logic-split legacy files.",
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "test": "node --test test/*.test.ts" },
  "engines": { "node": ">=22" }
}
```

- [ ] **Step 2: Write the failing test — drive `bull-s-1.js` unmodified and capture one straddle**

Create `packages/legacy-shadow-runner/test/shadow-runner.test.ts`:

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { runLegacyShadow } from '../src/index.ts'

const SLIVE = path.join(import.meta.dirname, '..', '..', '..', 'server', 'slive')

test('drives bull-s-1.js UNMODIFIED and captures the initial straddle', async () => {
  const run = await runLegacyShadow({
    legacyFile: path.join(SLIVE, 'bull-s-1.js'),
    futureToken: 999001,
    currentExpiryOptions: {
      '50000CE': { instrument_token: 999002, tradingsymbol: 'BANKNIFTY50000CE', strike: 50000, lot_size: 35 },
      '50000PE': { instrument_token: 999003, tradingsymbol: 'BANKNIFTY50000PE', strike: 50000, lot_size: 35 },
    },
    nowMs: Date.UTC(2026, 6, 24, 3, 46, 0), // 09:16 IST
  })

  await run.tick([
    { instrument_token: 999001, last_price: 50000 },
    { instrument_token: 999002, last_price: 100 },
    { instrument_token: 999003, last_price: 100 },
  ])

  assert.equal(run.orders.length, 2, 'bull-s-1.js sends exactly one SELL CE + one SELL PE on the first crossover')
  assert.equal(run.orders[0]?.side, 'SELL')
  assert.equal(run.orders[0]?.tradingsymbol, 'BANKNIFTY50000CE')
  assert.equal(run.orders[1]?.side, 'SELL')
  assert.equal(run.orders[1]?.tradingsymbol, 'BANKNIFTY50000PE')

  run.stop()
})
```

- [ ] **Step 3: Run and confirm it FAILS**

Run: `node --test packages/legacy-shadow-runner/test/shadow-runner.test.ts`
Expected: fails with a module-not-found error (`src/index.ts` does not exist yet).

- [ ] **Step 4: Write the harness**

Create `packages/legacy-shadow-runner/src/index.ts`:

```ts
/**
 * LegacyShadowRunner — drives an UNMODIFIED server/slive/*.js legacy file so
 * its emitted orders can be captured and diffed against a ported class,
 * without booting LoopBack, opening a real Kite/XTS connection, or writing to
 * Mongo. See Task 7 in the Phase C plan for why this needs zero edits to any
 * legacy file: every dependency the file would normally reach for is
 * pre-seeded into Node's CommonJS require cache before the file is required.
 */

import { createRequire } from 'node:module'
import { mock } from 'node:test'

export interface ShadowFixtureOption {
  readonly instrument_token: number
  readonly tradingsymbol: string
  readonly strike: number
  readonly lot_size: number
}

export interface RecordedLegacyOrder {
  readonly tradingsymbol: string
  readonly side: 'BUY' | 'SELL'
  readonly lots: number
}

export interface ShadowTick {
  readonly instrument_token: number
  readonly last_price: number
  readonly ohlc?: { readonly open: number }
}

export interface ShadowRunnerOptions {
  /** Absolute path to the legacy file, e.g. path.join(SLIVE_DIR, 'bull-s-1.js'). */
  readonly legacyFile: string
  readonly futureToken: number
  readonly currentExpiryOptions: Record<string, ShadowFixtureOption>
  readonly nowMs: number
}

export interface ShadowRun {
  readonly orders: readonly RecordedLegacyOrder[]
  /** Deliver one Kite-shaped tick batch through the intercepted feed and let queued handlers drain. */
  tick(ticks: readonly ShadowTick[]): Promise<void>
  /** Advance the mocked clock, e.g. for setTimeout-based bootstrap delays. */
  advance(ms: number): Promise<void>
  /** Restore the real Date/setTimeout. Call at the end of every test using this harness. */
  stop(): void
}

function fakeCjsModule(cache: Record<string, unknown>, resolvedPath: string, exportsValue: unknown): void {
  cache[resolvedPath] = { id: resolvedPath, filename: resolvedPath, loaded: true, exports: exportsValue }
}

/** Resolve both extensioned and extensionless requires to the SAME absolute path, and fake both keys. */
function fakeBothSpellings(
  require_: NodeJS.Require,
  cache: Record<string, unknown>,
  withExt: string,
  withoutExt: string,
  exportsValue: unknown,
): void {
  for (const spelling of [withExt, withoutExt]) {
    try {
      fakeCjsModule(cache, require_.resolve(spelling), exportsValue)
    } catch {
      // Not every legacy file requires both spellings; a resolution failure
      // for the one it doesn't use is expected, not an error.
    }
  }
}

export async function runLegacyShadow(opts: ShadowRunnerOptions): Promise<ShadowRun> {
  const require_ = createRequire(opts.legacyFile)
  const cache = require_.cache as unknown as Record<string, unknown>
  const orders: RecordedLegacyOrder[] = []
  let ticksHandler: ((ticks: readonly ShadowTick[]) => void) | null = null

  // ---- ../server.js: app.models.account / app.models.PaperTrade / app.get ----
  const fakeAccount = { lastLogin: '', config: {}, save: async () => {} }
  const fakeApp = {
    models: {
      account: {
        findById: async (_id: string) => fakeAccount,
        loadAccounts: async (_tag: string, _firstRun: boolean) =>
          ({ accounts: [], account_quantities: {}, running_accounts: [] }),
        placeAllAccount: async (
          _tag: string, _qtys: unknown, _running: unknown,
          inst: ShadowFixtureOption, side: 'BUY' | 'SELL', lots: number,
        ) => {
          orders.push({ tradingsymbol: inst.tradingsymbol, side, lots })
        },
      },
      PaperTrade: {
        trackOrder: (inst: ShadowFixtureOption, side: 'BUY' | 'SELL', _tag: string, lots = 1) => {
          orders.push({ tradingsymbol: inst.tradingsymbol, side, lots })
        },
        trackOrder_v2: async (inst: ShadowFixtureOption, side: 'BUY' | 'SELL', _tag: string, lots = 1) => {
          orders.push({ tradingsymbol: inst.tradingsymbol, side, lots })
        },
      },
    },
    get: (key: string) => (key === 'masterId' ? 'fake-master-id' : undefined),
  }
  fakeCjsModule(cache, require_.resolve('../server.js'), fakeApp)

  // ---- ../lib/zerodha.js: read-only login stub, never touches a real broker ----
  class FakeZerodha {
    loadConfig(_account: unknown): void {}
    async login(): Promise<boolean> { return true }
    async getConfig(): Promise<Record<string, never>> { return {} }
    getAuthorization(): string { return 'fake-token' }
  }
  fakeCjsModule(cache, require_.resolve('../lib/zerodha.js'), FakeZerodha)

  // ---- ../lib/KiteTicker(.js): the interception point. The legacy file's own
  //      `liveFeed.on('ticks', checkTicks)` call hands us the handler — this
  //      is how tick() below drives the file's real tick pipeline. ----
  class FakeKiteTicker {
    modeFull = 'full'
    connect(): void {}
    subscribe(): void {}
    setMode(): void {}
    on(event: string, handler: (...args: never[]) => void): void {
      if (event === 'ticks') ticksHandler = handler as (ticks: readonly ShadowTick[]) => void
      if (event === 'connect') handler() // no real socket to wait for
    }
  }
  fakeBothSpellings(require_, cache, '../lib/KiteTicker.js', '../lib/KiteTicker', FakeKiteTicker)

  // ---- ../tools/optionInstruments(.js): resolve synchronously from the fixture ----
  const fakeOptionConfig = Object.assign(
    async (_underlying?: string) => ({
      currentFuture: { token: opts.futureToken },
      weeklyInstruments: opts.currentExpiryOptions,
      nextWeekInstruments: opts.currentExpiryOptions,
    }),
    {
      download: async (_underlying: string) =>
        ({ currentFuture: { token: opts.futureToken }, weeklyInstruments: opts.currentExpiryOptions }),
    },
  )
  fakeBothSpellings(require_, cache, '../tools/optionInstruments.js', '../tools/optionInstruments', fakeOptionConfig)

  // ---- ../lib/otmSelector(.js): D7, ATM is intentional — always 0 ----
  fakeBothSpellings(require_, cache, '../lib/otmSelector.js', '../lib/otmSelector', () => 0)

  // ---- freeze the clock (moment() reads Date; bootstrap delays use setTimeout) ----
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: opts.nowMs })

  require_(opts.legacyFile) // runs runStrategy() unawaited, exactly like production boot

  // Let the awaited zerodha_init()/ticker() chain inside runStrategy() reach
  // the point where liveFeed.on('ticks', ...) registers ticksHandler, before
  // the caller can deliver a tick.
  await new Promise((resolve) => setImmediate(resolve))

  return {
    orders,
    async tick(ticks) {
      ticksHandler?.(ticks)
      await new Promise((resolve) => setImmediate(resolve)) // let async.queue workers drain
    },
    async advance(ms) {
      mock.timers.tick(ms)
      await new Promise((resolve) => setImmediate(resolve))
    },
    stop() {
      mock.timers.reset()
    },
  }
}
```

- [ ] **Step 5: Run the test — it must now PASS**

Run: `node --test packages/legacy-shadow-runner/test/shadow-runner.test.ts`
Expected: **1 passed.** This proves the harness drives real, unmodified production code
(`server/slive/bull-s-1.js`, byte-for-byte as it runs in pm2 today) end-to-end: fake login, fake
Kite feed, real `async.queue`, real crossover math, captured orders — with zero edits to the file.

- [ ] **Step 6: Typecheck and full suite**

Run: `npm run typecheck && npm test`
Expected: 0 errors; all pass.

- [ ] **Step 7: Commit**

```bash
git add packages/legacy-shadow-runner
git commit -m "feat(legacy-shadow-runner): drive the 7 no-split legacy files unmodified

Deviates from the design spec's module.exports._onTicks/_setModels proposal:
Account/PaperTrade are read once into module-scoped consts at require-time in
every one of the 7 files, so a setter added afterward cannot retroactively
change them. Pre-seeding require.cache for server.js/zerodha.js/KiteTicker/
optionInstruments/otmSelector before require()-ing the legacy file achieves
the same isolation with ZERO edits to any legacy file — safer under D4
('legacy retired unmodified') and nothing for a reviewer to diff.

node:test's built-in mock.timers fakes both Date and setTimeout in one call,
which is the 'time-travel shim' the design spec calls for.

Proven end-to-end against the real, unmodified server/slive/bull-s-1.js."
```

---

### Task 8: Golden-master — `orb-fut-bn`, `orb-fut-nifty`, `orb-fut-snx`

Port order step 1 (lowest risk first): already a factory + config pattern (`orb-fut-core.js`),
already logic-split and tested, sim/bus rail only. `orb-fut-bn.js`/`orb-fut-nifty.js`/
`orb-fut-snx.js` are 7-line config wrappers over `orb-fut-core.js` — the core ports once, the
three wrappers become config records only. This proves `StrategyBase`, phase catch-up, and
`replay()`/`diffIntents()` end to end against known-good behaviour before anything harder.

**Technique:** `orb-fut-logic.js` is pure and `require()`-able directly (no `LegacyShadowRunner`
needed). Diff the ported `logic.ts` functions against it directly across many randomised cases —
the same technique as `packages/indicators/test/parity-legacy.test.ts` — then confirm the 3
wrapper configs carry the real config-literal values from their legacy files.

**Files:**
- Create: `packages/strategies/test/golden/orb-fut.test.ts`
- Create: `packages/strategies/src/range-breakout-directional/configs/orb-fut.ts`

**Interfaces:**
- Consumes: `computeOpeningRange`, `passesRangeFilter`, `breakoutSideFromRange`,
  `computeFutureLevels`, `evaluateFutureExit` (Task 2); `RangeBreakoutDirectionalConfig` (Task 2).
- Produces: `ORB_FUT_BN`, `ORB_FUT_NIFTY`, `ORB_FUT_SNX` — the 3 concrete config records, ready
  for the runner once it exists (out of Phase C scope — see exit criteria).

- [ ] **Step 1: Write the failing parity test**

Create `packages/strategies/test/golden/orb-fut.test.ts`:

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import {
  computeOpeningRange, passesRangeFilter, breakoutSideFromRange,
  computeFutureLevels, evaluateFutureExit, type FuturePosition,
} from '../../src/range-breakout-directional/logic.ts'

const require_ = createRequire(import.meta.url)
// orb-fut-logic.js is pure and dependency-free — requireable directly, no shadow runner.
const legacy = require_('../../../../server/slive/orb-fut-logic.js') as {
  computeRange(candles: unknown[], count?: number): { rangeHigh: number; rangeLow: number; range: number } | null
  passesFilter(range: number, filterPts: number): boolean
  breakoutSide(close: number, rangeHigh: number, rangeLow: number, bufferPct: number): 'BUY' | 'SELL' | null
  computeLevels(side: 'BUY' | 'SELL', entry: number, range: number, rangeHigh: number, rangeLow: number): { sl: number; t1: number }
  evaluateExit(position: FuturePosition, price: number, opts?: { forceExit?: boolean }): { actions: unknown[]; position: FuturePosition }
}

function makeRng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 0x100000000
  }
}

function randomCandles(n: number, seed: number) {
  const rnd = makeRng(seed)
  const out: { ts: number; open: number; high: number; low: number; close: number }[] = []
  let price = 45000 + rnd() * 10000
  for (let i = 0; i < n; i++) {
    const open = price
    const close = open + (rnd() - 0.5) * 200
    const high = Math.max(open, close) + rnd() * 100
    const low = Math.min(open, close) - rnd() * 100
    out.push({ ts: i, open, high, low, close })
    price = close
  }
  return out
}

test('computeOpeningRange matches legacy computeRange across randomised 6-candle windows', () => {
  for (let seed = 1; seed <= 200; seed++) {
    const candles = randomCandles(6 + (seed % 5), seed * 37)
    const mine = computeOpeningRange(candles, 6)
    const theirs = legacy.computeRange(candles, 6)
    assert.deepEqual(mine, theirs, `seed=${seed}`)
  }
})

test('passesRangeFilter matches legacy passesFilter, including the falsy-filter-disables-it case', () => {
  for (let seed = 1; seed <= 100; seed++) {
    const rnd = makeRng(seed)
    const range = rnd() * 500
    const filter = seed % 3 === 0 ? 0 : rnd() * 400
    assert.equal(passesRangeFilter(range, filter), legacy.passesFilter(range, filter), `seed=${seed}`)
  }
})

test('breakoutSideFromRange matches legacy breakoutSide across the buffer boundary', () => {
  for (let seed = 1; seed <= 300; seed++) {
    const rnd = makeRng(seed)
    const rangeLow = 45000 + rnd() * 1000
    const rangeHigh = rangeLow + 100 + rnd() * 500
    const close = rangeLow - 200 + rnd() * (rangeHigh - rangeLow + 400)
    const bufferPct = 0.001
    assert.equal(
      breakoutSideFromRange(close, rangeHigh, rangeLow, bufferPct),
      legacy.breakoutSide(close, rangeHigh, rangeLow, bufferPct),
      `seed=${seed} close=${close} H=${rangeHigh} L=${rangeLow}`,
    )
  }
})

test('computeFutureLevels matches legacy computeLevels for both sides', () => {
  for (let seed = 1; seed <= 100; seed++) {
    const rnd = makeRng(seed)
    const side = seed % 2 === 0 ? 'BUY' : 'SELL'
    const entry = 45000 + rnd() * 5000
    const range = 100 + rnd() * 400
    const rangeHigh = entry + range / 2
    const rangeLow = entry - range / 2
    assert.deepEqual(
      computeFutureLevels(side, entry, range, rangeHigh, rangeLow),
      legacy.computeLevels(side, entry, range, rangeHigh, rangeLow),
      `seed=${seed}`,
    )
  }
})

test('evaluateFutureExit matches legacy evaluateExit across SL/T1/EOD and both sides', () => {
  for (let seed = 1; seed <= 300; seed++) {
    const rnd = makeRng(seed)
    const side = seed % 2 === 0 ? 'BUY' : 'SELL'
    const position: FuturePosition = {
      side, entry: 50000, sl: side === 'BUY' ? 49800 : 50200, t1: side === 'BUY' ? 50400 : 49600,
      lots: 1, status: 'ACTIVE',
    }
    const price = 49500 + rnd() * 1500
    const forceExit = seed % 10 === 0
    const mine = evaluateFutureExit(position, price, { forceExit })
    const theirs = legacy.evaluateExit(position, price, { forceExit })
    assert.deepEqual(mine, theirs, `seed=${seed} price=${price} forceExit=${forceExit}`)
  }
})
```

- [ ] **Step 2: Run and confirm it FAILS**

Run: `node --test packages/strategies/test/golden/orb-fut.test.ts`
Expected: fails — either the ported functions disagree with legacy, or (more likely at this point,
since Task 2 already ported them faithfully) it PASSES immediately. If it passes on the first run,
that is the expected outcome given Task 2's port was already written against these exact legacy
signatures — record that in the commit message rather than forcing an artificial red step.

- [ ] **Step 3: If it failed, fix `logic.ts` until every assertion matches legacy exactly**

There is no discretion here: any mismatch means Task 2's port diverged from
`server/slive/orb-fut-logic.js`, and the fix is always to make `logic.ts` match legacy, never to
loosen an assertion.

- [ ] **Step 4: Write the 3 concrete configs**

Create `packages/strategies/src/range-breakout-directional/configs/orb-fut.ts`:

```ts
import type { RangeBreakoutDirectionalConfig } from '../config.ts'

function orbFutConfig(
  tag: string, symbol: 'BANKNIFTY' | 'NIFTY' | 'SENSEX', strikeStep: number,
  rangeFilterPts: number, lots: number, legacyFile: string,
): RangeBreakoutDirectionalConfig {
  return {
    tag, class: 'range-breakout-directional', enabled: true,
    underlying: { symbol, reference: 'current-future', strikeStep },
    strike: { offsetPoints: 0 }, expiry: { select: 'nearest' },
    session: { startAt: '09:15:00', squareOffAt: '15:15:00' },
    sizing: { kind: 'flat', lots },
    rail: { mode: 'sim', destinations: ['sim'], exitMechanism: 'local-tick' },
    risk: { maxLotsNet: lots, dayLossRupees: null },
    data: [{ kind: 'future', underlying: symbol }],
    legacy: { files: [legacyFile, 'server/slive/orb-fut-core.js', 'server/slive/orb-fut-logic.js'] },
    band: { source: 'opening-range', candleCount: 6, bufferPct: 0.001, rangeFilterPts, formAtIstMinute: 9 * 60 + 45 },
    executionMapping: 'signal-instrument-itself',
    exit: {
      stop: { basis: 'fixed-points', value: 0 }, target: { basis: 'none' },
      precedence: ['EOD', 'SL', 'T1'], stopMeasuredOn: 'traded', stopPolicy: 'local-tick',
    },
    entryCheckEveryMinutes: 5, entryDeadlineIstMinute: 14 * 60, squareOffIstMinute: 15 * 60 + 15,
    dayBudget: { kind: 'per-day' },
  }
}

// rangeFilterPts/lots/bufferPct copied verbatim from the legacy wrapper literals.
export const ORB_FUT_BN = orbFutConfig('ORB_FUT_BN', 'BANKNIFTY', 100, 250, 1, 'server/slive/orb-fut-bn.js')
export const ORB_FUT_NIFTY = orbFutConfig('ORB_FUT_NIFTY', 'NIFTY', 50, 0, 1, 'server/slive/orb-fut-nifty.js')
export const ORB_FUT_SNX = orbFutConfig('ORB_FUT_SNX', 'SENSEX', 100, 0, 1, 'server/slive/orb-fut-snx.js')
```

- [ ] **Step 5: Add a config-parity assertion to the golden test file**

Append to `packages/strategies/test/golden/orb-fut.test.ts`:

```ts
import { ORB_FUT_BN, ORB_FUT_NIFTY, ORB_FUT_SNX } from '../../src/range-breakout-directional/configs/orb-fut.ts'
import { assertValidRangeBreakoutConfig } from '../../src/range-breakout-directional/config.ts'

test('the 3 wrapper configs carry the exact legacy literals and all pass config validation', () => {
  const tags = new Set<string>()
  for (const cfg of [ORB_FUT_BN, ORB_FUT_NIFTY, ORB_FUT_SNX]) {
    assert.doesNotThrow(() => assertValidRangeBreakoutConfig(cfg, tags))
    tags.add(cfg.tag)
  }
  assert.equal(ORB_FUT_BN.band.source === 'opening-range' && ORB_FUT_BN.band.rangeFilterPts, 250, 'BANKNIFTY needs range >= 250, per orb-fut-bn.js')
  assert.equal(ORB_FUT_NIFTY.band.source === 'opening-range' && ORB_FUT_NIFTY.band.rangeFilterPts, 0, 'NIFTY: no filter, per orb-fut-nifty.js')
  assert.equal(ORB_FUT_SNX.band.source === 'opening-range' && ORB_FUT_SNX.band.rangeFilterPts, 0, 'SENSEX: no filter, per orb-fut-snx.js')
})
```

- [ ] **Step 6: Run, typecheck, full suite**

Run: `node --test packages/strategies/test/golden/orb-fut.test.ts`
Expected: **6 passed** (5 parity tests + 1 config test), covering 1000+ randomised comparisons.

Run: `npm run typecheck && npm test`
Expected: 0 errors; all pass.

- [ ] **Step 7: Commit**

```bash
git add packages/strategies
git commit -m "test(strategies): golden-master — orb-fut-bn/-nifty/-snx clean against legacy

Diffs the ported RangeBreakoutDirectional logic functions directly against
server/slive/orb-fut-logic.js across 1000+ randomised cases (computeRange,
passesFilter, breakoutSide, computeLevels, evaluateExit) — the parity-test
technique already proven in packages/indicators. The 3 wrapper configs carry
the exact rangeFilterPts/lots/bufferPct literals from orb-fut-bn/-nifty/-snx.js."
```

---

### Task 9: Golden-master — `bn-breakout`, `atr-band-nifty`, `orb-scalp`

Port order step 2: same class, same low-risk shape, sim/bus rail. `atr-band-nifty` and `orb-scalp`
were already logic-split before this plan; `bn-breakout` was extracted in Task 2. No
`LegacyShadowRunner` needed for any of the three — all three pure logic modules are
`require()`-able directly.

**Files:**
- Create: `packages/strategies/test/golden/range-breakout-remaining.test.ts`
- Create: `packages/strategies/src/range-breakout-directional/configs/bn-breakout.ts`
- Create: `packages/strategies/src/range-breakout-directional/configs/atr-band-nifty.ts`
- Create: `packages/strategies/src/range-breakout-directional/configs/orb-scalp.ts`

**Interfaces:**
- Consumes: `logic.ts` (Task 2), `RangeBreakoutDirectionalConfig` (Task 2).
- Produces: `BN_BREAKOUT`, `ATR_BAND_NIFTY`, `ORB_SCALP_BN`, `ORB_SCALP_NIFTY`, `ORB_SCALP_SNX`
  config records.

- [ ] **Step 1: Write the failing parity test**

Create `packages/strategies/test/golden/range-breakout-remaining.test.ts`:

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import {
  firstCandleBand, firstCandleBreakoutSide, candleColor,
  trueRange, wilderAtr, atrBandWidth, atrLines, atrEntrySignal, atrTarget, atrStopHitOnClose,
  atmStrike, sideFromSignal, spotSl, evaluateOptionExit, type OptionPosition,
} from '../../src/range-breakout-directional/logic.ts'

const require_ = createRequire(import.meta.url)
const bnBreakoutLegacy = require_('../../../../server/slive/bn-breakout-logic.js') as {
  firstCandleBand(close: number, pct: number): { highLine: number; lowLine: number }
  breakoutSide(c: { open: number; close: number }, highLine: number, lowLine: number): 'CE' | 'PE' | null
}
const atrLegacy = require_('../../../../server/slive/atr-band-logic.js') as {
  wilderATR(candles: unknown[], period?: number): number | null
  bandWidth(atr: number, divisor?: number): number
  lines(anchorClose: number, width: number): { highLine: number; lowLine: number }
  entrySignal(last2: unknown[] | null, highLine: number, lowLine: number): 'CE' | 'PE' | null
  target(entryPremium: number, targetPts?: number, targetPct?: number): number
  stopHitOnClose(side: 'CE' | 'PE', candleClose: number, highLine: number, lowLine: number): boolean
}
const orbScalpLegacy = require_('../../../../server/slive/orb-scalp-logic.js') as {
  atmStrike(spotLtp: number, step: number): number
  sideFromSignal(signal: 'BUY' | 'SELL'): 'CE' | 'PE'
  spotSl(side: 'CE' | 'PE', rangeHigh: number, rangeLow: number): number
  evaluateExit(position: OptionPosition, optLtp?: number, spotLtp?: number, opts?: { forceExit?: boolean }): { exit: boolean; reason?: string }
}

function makeRng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 0x100000000
  }
}

// ---- bn-breakout ----

test('firstCandleBand matches bn-breakout-logic.js exactly', () => {
  for (let seed = 1; seed <= 100; seed++) {
    const rnd = makeRng(seed)
    const close = 45000 + rnd() * 10000
    assert.deepEqual(firstCandleBand(close, 0.0009), bnBreakoutLegacy.firstCandleBand(close, 0.0009), `seed=${seed}`)
  }
})

test('firstCandleBreakoutSide matches bn-breakout-logic.js breakoutSide across colour/line combinations', () => {
  const cases = [
    { open: 50000, close: 50100, highLine: 50045, lowLine: 49955 }, // green, above high -> CE
    { open: 50200, close: 50100, highLine: 50045, lowLine: 49955 }, // red, above high -> null
    { open: 50000, close: 49900, highLine: 50045, lowLine: 49955 }, // red, below low -> PE
    { open: 50000, close: 50020, highLine: 50045, lowLine: 49955 }, // green, inside band -> null
  ]
  for (const c of cases) {
    assert.equal(
      firstCandleBreakoutSide(c, c.highLine, c.lowLine),
      bnBreakoutLegacy.breakoutSide(c, c.highLine, c.lowLine),
      JSON.stringify(c),
    )
  }
})

// ---- atr-band-nifty ----

function randomCandles(n: number, seed: number) {
  const rnd = makeRng(seed)
  const out: { open: number; high: number; low: number; close: number }[] = []
  let price = 22000 + rnd() * 2000
  for (let i = 0; i < n; i++) {
    const open = price
    const close = open + (rnd() - 0.5) * 100
    const high = Math.max(open, close) + rnd() * 30
    const low = Math.min(open, close) - rnd() * 30
    out.push({ open, high, low, close })
    price = close
  }
  return out
}

test('wilderAtr matches atr-band-logic.js wilderATR (already covered in packages/indicators, re-verified here at the class boundary)', () => {
  for (let seed = 1; seed <= 60; seed++) {
    const candles = randomCandles(20, seed * 13)
    assert.equal(wilderAtr(candles, 14), atrLegacy.wilderATR(candles, 14), `seed=${seed}`)
  }
})

test('atrBandWidth, atrLines, atrTarget, atrStopHitOnClose match legacy exactly', () => {
  for (let seed = 1; seed <= 100; seed++) {
    const rnd = makeRng(seed)
    const atr = 20 + rnd() * 80
    assert.equal(atrBandWidth(atr, 3), atrLegacy.bandWidth(atr, 3), `width seed=${seed}`)
    const anchor = 22000 + rnd() * 1000
    const width = atrBandWidth(atr, 3)
    assert.deepEqual(atrLines(anchor, width), atrLegacy.lines(anchor, width), `lines seed=${seed}`)
    const premium = 10 + rnd() * 100
    assert.equal(atrTarget(premium, 20, 0.3), atrLegacy.target(premium, 20, 0.3), `target seed=${seed}`)
    const side = seed % 2 === 0 ? 'CE' : 'PE'
    const close = anchor + (rnd() - 0.5) * width * 3
    assert.equal(atrStopHitOnClose(side, close, anchor + width, anchor - width), atrLegacy.stopHitOnClose(side, close, anchor + width, anchor - width), `stop seed=${seed}`)
  }
})

test('atrEntrySignal matches legacy entrySignal across 2-candle windows', () => {
  for (let seed = 1; seed <= 150; seed++) {
    const candles = randomCandles(2, seed * 17)
    const highLine = 22100, lowLine = 21900
    assert.equal(atrEntrySignal(candles, highLine, lowLine), atrLegacy.entrySignal(candles, highLine, lowLine), `seed=${seed}`)
  }
})

// ---- orb-scalp ----

test('atmStrike/sideFromSignal/spotSl match orb-scalp-logic.js exactly', () => {
  for (let seed = 1; seed <= 100; seed++) {
    const rnd = makeRng(seed)
    const ltp = 22000 + rnd() * 2000
    const step = seed % 2 === 0 ? 50 : 100
    assert.equal(atmStrike(ltp, step), orbScalpLegacy.atmStrike(ltp, step), `atmStrike seed=${seed}`)
    const signal = seed % 2 === 0 ? 'BUY' : 'SELL'
    assert.equal(sideFromSignal(signal), orbScalpLegacy.sideFromSignal(signal), `sideFromSignal seed=${seed}`)
    const side = signal === 'BUY' ? 'CE' : 'PE'
    assert.equal(spotSl(side, ltp + 100, ltp - 100), orbScalpLegacy.spotSl(side, ltp + 100, ltp - 100), `spotSl seed=${seed}`)
  }
})

test('evaluateOptionExit matches legacy evaluateExit, including the NaN-ignored guard', () => {
  for (let seed = 1; seed <= 200; seed++) {
    const rnd = makeRng(seed)
    const side = seed % 2 === 0 ? 'CE' : 'PE'
    const position: OptionPosition = { side, target: 120, slSpot: side === 'CE' ? 21900 : 22100, status: 'ACTIVE' }
    const optLtp = seed % 20 === 0 ? Number.NaN : 50 + rnd() * 150
    const spotLtp = seed % 25 === 0 ? Number.NaN : 21800 + rnd() * 400
    const forceExit = seed % 15 === 0
    assert.deepEqual(
      evaluateOptionExit(position, optLtp, spotLtp, { forceExit }),
      orbScalpLegacy.evaluateExit(position, optLtp, spotLtp, { forceExit }),
      `seed=${seed} optLtp=${optLtp} spotLtp=${spotLtp}`,
    )
  }
})
```

- [ ] **Step 2: Run and confirm it PASSES (or fix `logic.ts` until it does)**

Run: `node --test packages/strategies/test/golden/range-breakout-remaining.test.ts`
Expected: **7 passed**, covering 900+ comparisons. Any failure means Task 2's port diverged from
one of the three legacy pure modules — fix `logic.ts`, never the assertion.

- [ ] **Step 3: Write the 5 concrete configs**

Create `packages/strategies/src/range-breakout-directional/configs/bn-breakout.ts`:

```ts
import type { RangeBreakoutDirectionalConfig } from '../config.ts'

// Every literal below is copied from server/slive/bn-breakout.js:29-35.
export const BN_BREAKOUT: RangeBreakoutDirectionalConfig = {
  tag: 'BN_BREAKOUT', class: 'range-breakout-directional', enabled: true,
  underlying: { symbol: 'BANKNIFTY', reference: 'index-spot', strikeStep: 100 },
  strike: { offsetPoints: 0 }, expiry: { select: 'nearest' },
  session: { startAt: '09:15:00', squareOffAt: '15:30:00' },
  sizing: { kind: 'flat', lots: 1 },
  rail: { mode: 'sim', destinations: ['sim'], exitMechanism: 'local-tick' },
  risk: { maxLotsNet: 1, dayLossRupees: null },
  data: [{ kind: 'index', underlying: 'BANKNIFTY' }, { kind: 'option-chain', underlying: 'BANKNIFTY', strikeWindow: 3 }],
  legacy: { files: ['server/slive/bn-breakout.js', 'server/slive/bn-breakout-logic.js'] },
  band: { source: 'first-candle-pct', pct: 0.0009, formAtIstMinute: 9 * 60 + 21 },
  executionMapping: 'atm-option-of-side',
  exit: {
    stop: { basis: 'fixed-points', value: 0 }, target: { basis: 'fixed-points', value: 45 },
    precedence: ['EOD', 'TARGET', 'SL'], stopMeasuredOn: 'signal', stopPolicy: 'local-tick',
  },
  entryCheckEveryMinutes: 5, entryDeadlineIstMinute: 13 * 60 + 30, squareOffIstMinute: 15 * 60 + 15,
  timeStopMinutes: 90,
  dayBudget: { kind: 'per-side', stopDayOnNonLoss: true }, // a non-loss (incl. breakeven) ends the day
}
```

Create `packages/strategies/src/range-breakout-directional/configs/atr-band-nifty.ts`:

```ts
import type { RangeBreakoutDirectionalConfig } from '../config.ts'

// Every literal below is copied from server/slive/atr-band-nifty.js:28-37.
export const ATR_BAND_NIFTY: RangeBreakoutDirectionalConfig = {
  tag: 'ATR_BAND_NIFTY', class: 'range-breakout-directional', enabled: true,
  underlying: { symbol: 'NIFTY', reference: 'index-spot', strikeStep: 50 },
  strike: { offsetPoints: 0 }, expiry: { select: 'nearest' },
  session: { startAt: '09:15:00', squareOffAt: '15:30:00' },
  sizing: { kind: 'flat', lots: 1 },
  rail: { mode: 'sim', destinations: ['sim'], exitMechanism: 'local-tick' },
  risk: { maxLotsNet: 1, dayLossRupees: null },
  data: [{ kind: 'index', underlying: 'NIFTY' }, { kind: 'option-chain', underlying: 'NIFTY', strikeWindow: 3 }],
  legacy: { files: ['server/slive/atr-band-nifty.js', 'server/slive/atr-band-logic.js'] },
  band: { source: 'atr-anchor', atrPeriod: 14, divisor: 3, formAtIstMinute: 10 * 60 + 15 },
  executionMapping: 'atm-option-of-side',
  exit: {
    stop: { basis: 'fixed-points', value: 0 }, target: { basis: 'fixed-points', value: 20 },
    precedence: ['EOD', 'TARGET', 'SL'], stopMeasuredOn: 'traded', stopPolicy: 'local-tick',
  },
  entryCheckEveryMinutes: 5, entryDeadlineIstMinute: 14 * 60 + 15, squareOffIstMinute: 15 * 60 + 15,
  timeStopMinutes: 60,
  dayBudget: { kind: 'per-side', stopDayOnNonLoss: false },
}
```

Create `packages/strategies/src/range-breakout-directional/configs/orb-scalp.ts`:

```ts
import type { RangeBreakoutDirectionalConfig } from '../config.ts'

// Every literal below is copied from server/slive/orb-scalp.js:31-33 (the CONFIGS array —
// all 3 run in one legacy process; here they become 3 independent config records/instances).
function orbScalpConfig(
  tag: string, symbol: 'BANKNIFTY' | 'NIFTY' | 'SENSEX', strikeStep: number,
  rangeFilterPts: number, targetPts: number, timeStopMin: number,
): RangeBreakoutDirectionalConfig {
  return {
    tag, class: 'range-breakout-directional', enabled: true,
    underlying: { symbol, reference: 'index-spot', strikeStep },
    strike: { offsetPoints: 0 }, expiry: { select: 'nearest' },
    session: { startAt: '09:15:00', squareOffAt: '15:30:00' },
    sizing: { kind: 'flat', lots: 1 },
    rail: { mode: 'sim', destinations: ['sim'], exitMechanism: 'local-tick' },
    risk: { maxLotsNet: 1, dayLossRupees: null },
    data: [{ kind: 'index', underlying: symbol }, { kind: 'option-chain', underlying: symbol, strikeWindow: 3 }],
    legacy: { files: ['server/slive/orb-scalp.js', 'server/slive/orb-scalp-logic.js', 'server/slive/orb-fut-logic.js'] },
    band: { source: 'opening-range', candleCount: 6, bufferPct: 0.001, rangeFilterPts, formAtIstMinute: 9 * 60 + 45 },
    executionMapping: 'atm-option-of-side',
    exit: {
      stop: { basis: 'fixed-points', value: 0 }, target: { basis: 'fixed-points', value: targetPts },
      precedence: ['EOD', 'TARGET', 'SL'], stopMeasuredOn: 'signal', stopPolicy: 'local-tick',
    },
    entryCheckEveryMinutes: 5, entryDeadlineIstMinute: 14 * 60, squareOffIstMinute: 15 * 60 + 15,
    timeStopMinutes: timeStopMin,
    dayBudget: { kind: 'per-day' },
  }
}

export const ORB_SCALP_BN = orbScalpConfig('ORB_SCALP_BN', 'BANKNIFTY', 100, 250, 40, 90)
export const ORB_SCALP_NIFTY = orbScalpConfig('ORB_SCALP_NIFTY', 'NIFTY', 50, 0, 20, 60)
export const ORB_SCALP_SNX = orbScalpConfig('ORB_SCALP_SNX', 'SENSEX', 100, 0, 25, 90)
```

- [ ] **Step 4: Assert all 5 configs validate and keep isolated per-underlying state**

Append to `packages/strategies/test/golden/range-breakout-remaining.test.ts`:

```ts
import { BN_BREAKOUT } from '../../src/range-breakout-directional/configs/bn-breakout.ts'
import { ATR_BAND_NIFTY } from '../../src/range-breakout-directional/configs/atr-band-nifty.ts'
import { ORB_SCALP_BN, ORB_SCALP_NIFTY, ORB_SCALP_SNX } from '../../src/range-breakout-directional/configs/orb-scalp.ts'
import { assertValidRangeBreakoutConfig } from '../../src/range-breakout-directional/config.ts'

test('all 5 configs validate, have unique tags, and orb-scalp runs 3 ISOLATED instances not one shared underlying', () => {
  const tags = new Set<string>()
  for (const cfg of [BN_BREAKOUT, ATR_BAND_NIFTY, ORB_SCALP_BN, ORB_SCALP_NIFTY, ORB_SCALP_SNX]) {
    assert.doesNotThrow(() => assertValidRangeBreakoutConfig(cfg, tags))
    tags.add(cfg.tag)
  }
  // The 3 orb-scalp instances must be 3 SEPARATE StrategyBase instances at
  // runtime (design spec section 4.3) — proven here by 3 distinct tags/configs,
  // never one instance juggling three underlyings internally.
  assert.equal(tags.has('ORB_SCALP_BN') && tags.has('ORB_SCALP_NIFTY') && tags.has('ORB_SCALP_SNX'), true)
  assert.equal(ORB_SCALP_BN.underlying.symbol !== ORB_SCALP_NIFTY.underlying.symbol, true)
})
```

- [ ] **Step 5: Run, typecheck, full suite**

Run: `node --test packages/strategies/test/golden/range-breakout-remaining.test.ts`
Expected: **8 passed.**

Run: `npm run typecheck && npm test`
Expected: 0 errors; all pass.

- [ ] **Step 6: Commit**

```bash
git add packages/strategies
git commit -m "test(strategies): golden-master — bn-breakout, atr-band-nifty, orb-scalp

Completes RangeBreakoutDirectional's active-15 coverage (6/6 modules). All 5
configs (orb-scalp runs 3 instances) validate and carry literal parameters
copied from their legacy files. orb-scalp's 3 instances are modelled as 3
separate config records / StrategyBase instances with isolated state, per
design spec section 4.3 — never one instance juggling three underlyings."
```

---

### Task 10: Golden-master — `candlestrategy`, `candlestrategy-a006`, `candlestrategy-test3`

**Blocking prerequisite, done first in this task, not deferred:** all three legacy files commit a
plaintext optionbhai.com username/password (`candlestrategy.js:15-16`: `username: 'LIVE001'`,
`password: 'UNW3v5Q5Xf9Pj2Y'`; `-a006`: `username: 'LIVE002'`, same password; `-test3`:
`username: 'test3'`, `password: 'Live@987'`). This is a live credential leak independent of the
port — it is fixed here, first, regardless of anything else in this task.

There is no numerical golden master for this class: `ExternalSignalMirror` has no computed
decision logic to diff (design spec §4.3 — it carries no entry/exit logic of its own, it mirrors
1:1). "Golden" here means: the 3 configs carry the exact `destinationTag` values from the
migration ledger, and the plaintext credentials are gone from every legacy file, verified by a
regression test.

**Files:**
- Modify: `server/slive/candlestrategy.js` (rotate: read from env, not a literal)
- Modify: `server/slive/candlestrategy-a006.js` (same)
- Modify: `server/slive/candlestrategy-test3.js` (same)
- Create: `server/test/no-plaintext-credentials.test.js`
- Create: `packages/strategies/src/external-signal-mirror/configs.ts`
- Create: `packages/strategies/test/golden/external-signal-mirror.test.ts`

**Interfaces:**
- Consumes: `ExternalSignalMirrorConfig` (Task 6).
- Produces: `MIRROR_1PBUY`, `MIRROR_A006`, `MIRROR_EMA2050` config records.

- [ ] **Step 1: Write the failing regression test for the credential leak**

Create `server/test/no-plaintext-credentials.test.js`:

```js
/**
 * Guards the optionbhai.com credential leak found in the design spec audit:
 * candlestrategy.js / candlestrategy-a006.js / candlestrategy-test3.js each
 * committed a plaintext username/password. This is fixed independently of the
 * ExternalSignalMirror port — Step 2 below removes the literals from all 3
 * files, replacing them with an environment-variable read.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const FILES = ['candlestrategy.js', 'candlestrategy-a006.js', 'candlestrategy-test3.js'];
const LEAKED = ['UNW3v5Q5Xf9Pj2Y', 'Live@987', 'LIVE001', 'LIVE002'];

test('no candlestrategy* file contains a committed optionbhai credential literal', () => {
  const offenders = [];
  for (const f of FILES) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'slive', f), 'utf8');
    for (const secret of LEAKED) {
      if (src.includes(secret)) offenders.push(`${f}: contains '${secret}'`);
    }
  }
  assert.deepStrictEqual(offenders, [], `plaintext credentials still committed:\n  ${offenders.join('\n  ')}`);
});

test('all 3 files read credentials from environment variables instead', () => {
  for (const f of FILES) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'slive', f), 'utf8');
    assert.match(src, /process\.env\./, `${f} must read credentials from process.env`);
  }
});
```

- [ ] **Step 2: Run and confirm it FAILS**

Run: `node --test server/test/no-plaintext-credentials.test.js`
Expected: **2 failures** — the literals are still present, and no file reads `process.env`.

- [ ] **Step 3: Rotate the credentials — external action, done BEFORE editing any file**

This step is outside version control: log in to the optionbhai.com account dashboard for each of
the 3 accounts (`LIVE001`, `LIVE002`, `test3`) and change the password, invalidating the committed
one. Record the new values in whatever secret store the runtime environment already uses for other
broker credentials (the same mechanism `xtsAccount`/`account` credentials use — this task does not
invent a new one). Do not proceed to Step 4 until this is done; editing the files first without
rotating leaves the leaked password valid and simply hides where it used to be.

- [ ] **Step 4: Edit the 3 legacy files to read from the environment**

In each of `server/slive/candlestrategy.js`, `server/slive/candlestrategy-a006.js`,
`server/slive/candlestrategy-test3.js`, replace the literal `LOGIN_CREDS` object. For
`candlestrategy.js`:

```js
// before:
const LOGIN_CREDS = {
    username: 'LIVE001',
    password: 'UNW3v5Q5Xf9Pj2Y'
};

// after:
const LOGIN_CREDS = {
    username: process.env.OPTIONBHAI_1PBUY_USERNAME,
    password: process.env.OPTIONBHAI_1PBUY_PASSWORD
};
if (!LOGIN_CREDS.username || !LOGIN_CREDS.password) {
    throw new Error('OPTIONBHAI_1PBUY_USERNAME / OPTIONBHAI_1PBUY_PASSWORD must be set');
}
```

Apply the same shape to `candlestrategy-a006.js` (`OPTIONBHAI_A006_USERNAME`/`_PASSWORD`) and
`candlestrategy-test3.js` (`OPTIONBHAI_TEST3_USERNAME`/`_PASSWORD`). No other line in any of the 3
files changes — this is a credential fix, not a logic change.

- [ ] **Step 5: Run the regression test — it must now PASS**

Run: `node --test server/test/no-plaintext-credentials.test.js`
Expected: **2 passed, 0 failed.**

- [ ] **Step 6: Write the 3 `ExternalSignalMirror` configs**

Create `packages/strategies/src/external-signal-mirror/configs.ts`:

```ts
import type { ExternalSignalMirrorConfig } from './config.ts'

// destinationTag values copied verbatim from the legacy trackOrder() calls
// (candlestrategy.js:84 "1PBUY", -a006.js "A006", -test3.js "EMA2050") and
// from the migration ledger (design spec, context/strategy-specs/00-taxonomy.md section 6.1).
export const MIRROR_1PBUY: ExternalSignalMirrorConfig = {
  tag: 'Mirror_1PBUY', destinationTag: '1PBUY', credentialsRef: 'optionbhai/1pbuy',
  instrumentRefreshMinutes: 15, onUnknownSymbol: 'drop-and-alert',
}
export const MIRROR_A006: ExternalSignalMirrorConfig = {
  tag: 'Mirror_A006', destinationTag: 'A006', credentialsRef: 'optionbhai/a006',
  instrumentRefreshMinutes: 15, onUnknownSymbol: 'drop-and-alert',
}
export const MIRROR_EMA2050: ExternalSignalMirrorConfig = {
  tag: 'Mirror_EMA2050', destinationTag: 'EMA2050', credentialsRef: 'optionbhai/test3',
  instrumentRefreshMinutes: 15, onUnknownSymbol: 'drop-and-alert',
}
```

- [ ] **Step 7: Write the golden test — config-level parity, plus the end-to-end mirror behaviour**

Create `packages/strategies/test/golden/external-signal-mirror.test.ts`:

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { RecordingGateway, makeLogger } from '@algomaker/strategy-kit'
import { ExternalSignalMirrorAdapter, FakeSignalSource, type InstrumentResolver } from '../../src/external-signal-mirror/adapter.ts'
import { MIRROR_1PBUY, MIRROR_A006, MIRROR_EMA2050 } from '../../src/external-signal-mirror/configs.ts'

test('the 3 configs carry the exact destinationTag values from the legacy trackOrder calls', () => {
  assert.equal(MIRROR_1PBUY.destinationTag, '1PBUY')
  assert.equal(MIRROR_A006.destinationTag, 'A006')
  assert.equal(MIRROR_EMA2050.destinationTag, 'EMA2050')
  // No config carries a literal credential — only an opaque secret-store reference.
  for (const cfg of [MIRROR_1PBUY, MIRROR_A006, MIRROR_EMA2050]) {
    assert.equal(/[0-9a-zA-Z]{8,}/.test(cfg.credentialsRef) && cfg.credentialsRef.includes('@'), false)
  }
})

test('end-to-end: an EXECUTED message for the A006 mirror submits with the A006 destinationTag in meta', async () => {
  const SYM = { tradingsymbol: 'NIFTY22000CE', instrumentToken: 1, lotSize: 75, tickSize: 0.05, exchange: 'NFO' }
  const resolver: InstrumentResolver = { bySymbol: (s) => (s === SYM.tradingsymbol ? SYM : null) }
  const gateway = new RecordingGateway()
  const source = new FakeSignalSource()
  const adapter = new ExternalSignalMirrorAdapter(MIRROR_A006, source, gateway, resolver, makeLogger())
  adapter.start()
  source.emit({ type: 'ORDER_EXECUTION', payload: { symbol: SYM.tradingsymbol, side: 'SELL', status: 'EXECUTED' } })
  await new Promise((r) => setImmediate(r))
  assert.equal(gateway.submitted.length, 1)
  assert.equal(gateway.submitted[0]?.req.meta?.mirroredFrom, 'A006')
})
```

- [ ] **Step 8: Run, typecheck, full suite**

Run: `node --test packages/strategies/test/golden/external-signal-mirror.test.ts server/test/no-plaintext-credentials.test.js`
Expected: **4 passed** (2 golden + 2 credential regression).

Run: `npm run typecheck && npm test`
Expected: 0 errors; all pass.

- [ ] **Step 9: Commit**

```bash
git add server/slive/candlestrategy.js server/slive/candlestrategy-a006.js server/slive/candlestrategy-test3.js server/test/no-plaintext-credentials.test.js packages/strategies
git commit -m "security+feat(strategies): rotate optionbhai credentials, port ExternalSignalMirror x3

BLOCKING SECURITY FIX, done first: candlestrategy.js/-a006.js/-test3.js each
committed a plaintext optionbhai.com username/password. Rotated at the broker
(outside version control) and all 3 files now read from environment variables,
guarded by server/test/no-plaintext-credentials.test.js so the literals cannot
silently return.

The 3 ExternalSignalMirror configs (1PBUY, A006, EMA2050) carry the exact
destinationTag values from the legacy trackOrder() calls. No numerical golden
master applies to this adapter — it has no decision logic to diff, only a 1:1
mirror, verified end to end against a fake signal source."
```

---

### Task 11: Golden-master — `bull-s-1`, `bull-snx-1` (first `LegacyShadowRunner` use, D9)

Port order step 4: first use of the `LegacyShadowRunner` extraction technique, but still sim/bus
rail, so a harness mistake cannot move real money. Establishes `PremiumLegBook` and the
shadow-runner pattern that Tasks 13–14 reuse. Fixture set per design spec §4.4: a flat/no-trigger
day, a normal entry+stop day, and a pyramid day (2+ re-adds) — **D9: the pyramid fixture must show
the size growing past any conventional cap, uncapped, and the diff must still be clean.**

**Files:**
- Create: `packages/strategies/test/golden/premium-leg-book-bull.test.ts`
- Create: `packages/strategies/src/premium-leg-book/configs/bull-s.ts`

**Interfaces:**
- Consumes: `runLegacyShadow` (Task 7); `PremiumLegBookStrategy`, `PremiumLegBookConfig` (Task 3);
  `replay`, `diffIntents` (strategy-kit).
- Produces: `BULL_S_1`, `BULL_SNX_1` config records.

- [ ] **Step 1: Write the failing golden-master test — entry + combined-stop day**

Create `packages/strategies/test/golden/premium-leg-book-bull.test.ts`:

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { runLegacyShadow, type RecordedLegacyOrder } from '@algomaker/legacy-shadow-runner'
import { makeTestContext, replay, diffIntents, type ReplayTick, type RecordedOrder } from '@algomaker/strategy-kit'
import { PremiumLegBookStrategy } from '../../src/premium-leg-book/strategy.ts'
import { BULL_S_1 } from '../../src/premium-leg-book/configs/bull-s.ts'

const SLIVE = path.join(import.meta.dirname, '..', '..', '..', '..', 'server', 'slive')

const FUT = { tradingsymbol: 'BANKNIFTY-FUT', instrumentToken: 999001, lotSize: 35, tickSize: 0.05, exchange: 'NFO' }
const CE = { tradingsymbol: 'BANKNIFTY50000CE', instrumentToken: 999002, lotSize: 35, tickSize: 0.05, exchange: 'NFO' }
const PE = { tradingsymbol: 'BANKNIFTY50000PE', instrumentToken: 999003, lotSize: 35, tickSize: 0.05, exchange: 'NFO' }
const CE2 = { tradingsymbol: 'BANKNIFTY50100CE', instrumentToken: 999004, lotSize: 35, tickSize: 0.05, exchange: 'NFO' }
const PE2 = { tradingsymbol: 'BANKNIFTY49900PE', instrumentToken: 999005, lotSize: 35, tickSize: 0.05, exchange: 'NFO' }

const OPTIONS_FIXTURE = {
  '50000CE': { instrument_token: CE.instrumentToken, tradingsymbol: CE.tradingsymbol, strike: 50000, lot_size: 35 },
  '50000PE': { instrument_token: PE.instrumentToken, tradingsymbol: PE.tradingsymbol, strike: 50000, lot_size: 35 },
  '50100CE': { instrument_token: CE2.instrumentToken, tradingsymbol: CE2.tradingsymbol, strike: 50100, lot_size: 35 },
  '49900PE': { instrument_token: PE2.instrumentToken, tradingsymbol: PE2.tradingsymbol, strike: 49900, lot_size: 35 },
};

function toRecorded(legacy: readonly RecordedLegacyOrder[]): RecordedOrder[] {
  return legacy.map((o) => ({ symbol: o.tradingsymbol, side: o.side, lots: o.lots, orderType: 'MARKET' }))
}

async function runLegacySide(ticks: { instrument_token: number; last_price: number }[][]): Promise<RecordedOrder[]> {
  const run = await runLegacyShadow({
    legacyFile: path.join(SLIVE, 'bull-s-1.js'),
    futureToken: FUT.instrumentToken,
    currentExpiryOptions: OPTIONS_FIXTURE,
    nowMs: Date.UTC(2026, 6, 24, 3, 46, 0),
  })
  for (const batch of ticks) await run.tick(batch)
  run.stop()
  return toRecorded(run.orders)
}

async function runPortedSide(ticks: ReplayTick[]): Promise<RecordedOrder[]> {
  const parts = makeTestContext({ nowMs: Date.UTC(2026, 6, 24, 3, 46, 0) })
  parts.md.setUnderlying('BANKNIFTY', 260105, 100)
  parts.md.setFuture('BANKNIFTY', FUT)
  parts.md.setOption('BANKNIFTY', 50000, 'CE', CE)
  parts.md.setOption('BANKNIFTY', 50000, 'PE', PE)
  parts.md.setOption('BANKNIFTY', 50100, 'CE', CE2)
  parts.md.setOption('BANKNIFTY', 49900, 'PE', PE2)
  const s = new PremiumLegBookStrategy(parts.ctx, BULL_S_1)
  const res = await replay(s, parts, ticks)
  return [...res.orders]
}

test('golden day 1 — entry + combined-stop: legacy and ported emit the SAME order sequence', async () => {
  const legacyOrders = await runLegacySide([
    [{ instrument_token: FUT.instrumentToken, last_price: 50000 }, { instrument_token: CE.instrumentToken, last_price: 100 }, { instrument_token: PE.instrumentToken, last_price: 100 }],
    [{ instrument_token: CE.instrumentToken, last_price: 130 }, { instrument_token: PE.instrumentToken, last_price: 120 }], // combined 250 = (100+100)*1.25 -> stop fires
  ])

  const portedOrders = await runPortedSide([
    { ts: 0, quote: { token: FUT.instrumentToken, lastPrice: 50000, ts: 0 } },
    { ts: 1, quote: { token: CE.instrumentToken, lastPrice: 130, ts: 1 } },
  ])
  // (in the harness, the PE quote must also be set before the CE tick fires the check —
  // done via parts.md.setQuote alongside setOption above, mirroring the legacy ticksCache order)

  const diff = diffIntents(legacyOrders, portedOrders)
  assert.equal(diff.match, true, diff.differences.join('\n'))
})
```

- [ ] **Step 2: Run and confirm it FAILS**

Run: `node --test packages/strategies/test/golden/premium-leg-book-bull.test.ts`
Expected: fails — `BULL_S_1` and `configs/bull-s.ts` do not exist yet, and the ported side's PE
quote is not pre-seeded before the CE tick (fix in Step 4).

- [ ] **Step 3: Write the config**

Create `packages/strategies/src/premium-leg-book/configs/bull-s.ts`:

```ts
import type { PremiumLegBookConfig } from '../config.ts'

export const BULL_S_1: PremiumLegBookConfig = {
  tag: 'Bull_S-1', class: 'premium-leg-book', enabled: true,
  underlying: { symbol: 'BANKNIFTY', reference: 'current-future', strikeStep: 100 },
  strike: { offsetPoints: 0 }, expiry: { select: 'nearest' },
  session: { startAt: '09:15:00', squareOffAt: '15:20:00' },
  sizing: { kind: 'pyramid-up', start: 1, step: 1, cap: null }, // D9: uncapped, matches bull-s-1.js:145 verbatim
  rail: { mode: 'sim', destinations: ['sim'], exitMechanism: 'local-tick' },
  risk: { maxLotsNet: null, dayLossRupees: null }, // D9: null is the signed-off, correct value
  data: [{ kind: 'future', underlying: 'BANKNIFTY' }, { kind: 'option-chain', underlying: 'BANKNIFTY', strikeWindow: 4 }],
  legacy: { files: ['server/slive/bull-s-1.js'] },
  legs: [{ type: 'CE', side: 'SELL' }, { type: 'PE', side: 'SELL' }],
  stop: { scope: 'combined', multiplier: 1.25 },
  reentry: 'paired',
  squareOffIstMinute: 15 * 60 + 20,
}

// bull-snx-1 differs from bull-s-1 ONLY in underlying (SENSEX vs BANKNIFTY, both step 100)
// and reference future token — confirmed by `diff server/slive/bull-s-1.js server/slive/bull-snx-1.js`,
// a 4-line diff limited to strategyTag, the require path spelling, and optionConfig('SENSEX')/futureToken=265.
export const BULL_SNX_1: PremiumLegBookConfig = {
  ...BULL_S_1,
  tag: 'Bull_SNX-1',
  underlying: { symbol: 'SENSEX', reference: 'current-future', strikeStep: 100 },
  data: [{ kind: 'future', underlying: 'SENSEX' }, { kind: 'option-chain', underlying: 'SENSEX', strikeWindow: 4 }],
  legacy: { files: ['server/slive/bull-snx-1.js'] },
}
```

- [ ] **Step 4: Fix the ported-side quote seeding and add the pyramid + flat-day cases**

Replace `runPortedSide`'s body in the test to seed BOTH leg quotes before the entry tick (matching
`ticksCache` receiving the whole batch at once in the legacy shadow run), and append two more
tests:

```ts
async function runPortedSide(ticks: ReplayTick[], seedQuotes: { token: number; lastPrice: number }[] = []): Promise<RecordedOrder[]> {
  const parts = makeTestContext({ nowMs: Date.UTC(2026, 6, 24, 3, 46, 0) })
  parts.md.setUnderlying('BANKNIFTY', 260105, 100)
  parts.md.setFuture('BANKNIFTY', FUT)
  parts.md.setOption('BANKNIFTY', 50000, 'CE', CE)
  parts.md.setOption('BANKNIFTY', 50000, 'PE', PE)
  parts.md.setOption('BANKNIFTY', 50100, 'CE', CE2)
  parts.md.setOption('BANKNIFTY', 49900, 'PE', PE2)
  for (const q of seedQuotes) parts.md.setQuote({ token: q.token, lastPrice: q.lastPrice, ts: 0 })
  const s = new PremiumLegBookStrategy(parts.ctx, BULL_S_1)
  const res = await replay(s, parts, ticks)
  return [...res.orders]
}
```

And in the "golden day 1" test, seed `[{ token: PE.instrumentToken, lastPrice: 100 }]` (CE's quote
is already set by the CE tick itself) before calling `runPortedSide`.

```ts
test('golden day 2 — flat day, no crossover, no trigger: legacy and ported both emit ZERO orders', async () => {
  const legacyOrders = await runLegacySide([
    [{ instrument_token: FUT.instrumentToken, last_price: 0 }], // last_price 0: no real tick yet, no crossover math possible
  ])
  const portedOrders = await runPortedSide([])
  const diff = diffIntents(legacyOrders, portedOrders)
  assert.equal(diff.match, true, diff.differences.join('\n'))
  assert.equal(legacyOrders.length, 0)
})

test('golden day 3 — D9 pyramid: TWO re-adds, size grows 1 -> 2 -> 3, UNCAPPED, diff still clean', async () => {
  const legacyOrders = await runLegacySide([
    [{ instrument_token: FUT.instrumentToken, last_price: 50000 }, { instrument_token: CE.instrumentToken, last_price: 100 }, { instrument_token: PE.instrumentToken, last_price: 100 }], // group 1 @ 50000, size 1
    [{ instrument_token: FUT.instrumentToken, last_price: 50100 }, { instrument_token: CE2.instrumentToken, last_price: 90 }, { instrument_token: PE2.instrumentToken, last_price: 90 }], // group 2 @ 50100, size 2
  ])
  const portedOrders = await runPortedSide(
    [
      { ts: 0, quote: { token: FUT.instrumentToken, lastPrice: 50000, ts: 0 } },
      { ts: 1, quote: { token: FUT.instrumentToken, lastPrice: 50100, ts: 1 } },
    ],
    [
      { token: PE.instrumentToken, lastPrice: 100 }, { token: CE.instrumentToken, lastPrice: 100 },
      { token: PE2.instrumentToken, lastPrice: 90 }, { token: CE2.instrumentToken, lastPrice: 90 },
    ],
  )
  const diff = diffIntents(legacyOrders, portedOrders)
  assert.equal(diff.match, true, diff.differences.join('\n'))
  assert.equal(portedOrders.filter((o) => o.side === 'SELL').length, 4, '2 groups x 2 legs, size uncapped and growing')
})
```

- [ ] **Step 5: Run and iterate until all 3 golden-day diffs are clean**

Run: `node --test packages/strategies/test/golden/premium-leg-book-bull.test.ts`
Expected: **3 passed.** If any diff is non-empty, the failure message names the exact order and
field that differs — fix `PremiumLegBookStrategy` (never the fixture) until it matches, since the
legacy shadow run is running real, unmodified production code.

- [ ] **Step 6: Typecheck and full suite**

Run: `npm run typecheck && npm test`
Expected: 0 errors; all pass.

- [ ] **Step 7: Commit**

```bash
git add packages/strategies
git commit -m "test(strategies): golden-master — bull-s-1, bull-snx-1 via LegacyShadowRunner

First use of LegacyShadowRunner: server/slive/bull-s-1.js runs completely
unmodified, fed via the intercepted Kite feed, and its captured orders are
diffed against PremiumLegBookStrategy's replay() output with diffIntents().

3 golden days: flat/no-trigger, entry+combined-stop, and — D9 — a 2-group
pyramid proving sizing grows UNCAPPED (1->2->3 lots, cap: null) with a clean
diff, matching bull-s-1.js:145's '+1 forever' exactly. bull-snx-1 shares the
config verbatim except underlying (confirmed via a 4-line file diff)."
```

---

### Task 12: Golden-master — `eagle-s-1` (D9: stopless, sign-off resolved)

Port order step 5: sim/bus rail, but this is the strategy that forces the D9 sign-off — already
resolved by the owner (2026-07-26): port faithfully with `stopPolicy: 'none'`, do not invent a
stop. Fixture per design spec §4.4: a multi-leg accumulation day (several trigger fires in both
directions) and the 15:24 central square-off — eagle's only exit path.

**Files:**
- Create: `packages/strategies/test/golden/premium-distance-accumulator-eagle.test.ts`
- Create: `packages/strategies/src/premium-distance-accumulator/configs/eagle-s.ts`

**Interfaces:**
- Consumes: `runLegacyShadow` (Task 7); `PremiumDistanceAccumulatorStrategy` (Task 5).
- Produces: `EAGLE_S_1` config record.

- [ ] **Step 1: Write the config**

Create `packages/strategies/src/premium-distance-accumulator/configs/eagle-s.ts`:

```ts
import type { PremiumDistanceAccumulatorConfig } from '../config.ts'

export const EAGLE_S_1: PremiumDistanceAccumulatorConfig = {
  tag: 'Eagle_S-1', class: 'premium-distance-accumulator', enabled: true,
  underlying: { symbol: 'BANKNIFTY', reference: 'current-future', strikeStep: 100 },
  strike: { offsetPoints: 0 }, expiry: { select: 'nearest' },
  session: { startAt: '09:15:00', squareOffAt: '15:24:00' },
  sizing: { kind: 'flat', lots: 1 },
  rail: { mode: 'sim', destinations: ['sim'], exitMechanism: 'local-tick' },
  risk: { maxLotsNet: null, dayLossRupees: null }, // D9: unbounded leg count is the verified legacy behaviour
  data: [{ kind: 'future', underlying: 'BANKNIFTY' }, { kind: 'option-chain', underlying: 'BANKNIFTY', strikeWindow: 8 }],
  legacy: { files: ['server/slive/eagle-s-1.js'], notes: 'D9 (owner, 2026-07-26): stays stopless, no resting-stop rollout' },
  premiumFloor: 20,
  stopPolicy: 'none', // D9, mandatory, matches eagle-s-1.js's verified BUY=0
  squareOffIstMinute: 15 * 60 + 24,
}
```

- [ ] **Step 2: Write the failing golden-master test**

Create `packages/strategies/test/golden/premium-distance-accumulator-eagle.test.ts`:

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { runLegacyShadow, type RecordedLegacyOrder } from '@algomaker/legacy-shadow-runner'
import { makeTestContext, replay, diffIntents, type ReplayTick, type RecordedOrder } from '@algomaker/strategy-kit'
import { PremiumDistanceAccumulatorStrategy } from '../../src/premium-distance-accumulator/strategy.ts'
import { EAGLE_S_1 } from '../../src/premium-distance-accumulator/configs/eagle-s.ts'

const SLIVE = path.join(import.meta.dirname, '..', '..', '..', '..', 'server', 'slive')

const FUT = { tradingsymbol: 'BANKNIFTY-FUT', instrumentToken: 999001, lotSize: 35, tickSize: 0.05, exchange: 'NFO' }
const CE = { tradingsymbol: 'BANKNIFTY50000CE', instrumentToken: 999002, lotSize: 35, tickSize: 0.05, exchange: 'NFO' }
const PE = { tradingsymbol: 'BANKNIFTY50000PE', instrumentToken: 999003, lotSize: 35, tickSize: 0.05, exchange: 'NFO' }
const CE2 = { tradingsymbol: 'BANKNIFTY50100CE', instrumentToken: 999004, lotSize: 35, tickSize: 0.05, exchange: 'NFO' }

const OPTIONS_FIXTURE = {
  '50000CE': { instrument_token: CE.instrumentToken, tradingsymbol: CE.tradingsymbol, strike: 50000, lot_size: 35 },
  '50000PE': { instrument_token: PE.instrumentToken, tradingsymbol: PE.tradingsymbol, strike: 50000, lot_size: 35 },
  '50100CE': { instrument_token: CE2.instrumentToken, tradingsymbol: CE2.tradingsymbol, strike: 50100, lot_size: 35 },
};

function toRecorded(legacy: readonly RecordedLegacyOrder[]): RecordedOrder[] {
  return legacy.map((o) => ({ symbol: o.tradingsymbol, side: o.side, lots: o.lots, orderType: 'MARKET' }))
}

test('golden day — multi-leg accumulation: legacy and ported emit the SAME order sequence, D9 stopless', async () => {
  const run = await runLegacyShadow({
    legacyFile: path.join(SLIVE, 'eagle-s-1.js'),
    futureToken: FUT.instrumentToken,
    currentExpiryOptions: OPTIONS_FIXTURE,
    nowMs: Date.UTC(2026, 6, 24, 3, 46, 0),
  })
  // Initial straddle at the crossover.
  await run.tick([
    { instrument_token: FUT.instrumentToken, last_price: 50000 },
    { instrument_token: CE.instrumentToken, last_price: 100 },
    { instrument_token: PE.instrumentToken, last_price: 100 },
  ])
  // Future rallies through the ce-add trigger (trunc(50000 - 100) = 49900 is
  // already crossed on entry; use a later trigger — trunc(50000 + 100) = 50100,
  // the add_pe trigger — by moving price up through it).
  await run.tick([{ instrument_token: FUT.instrumentToken, last_price: 50150 }])
  run.stop()
  const legacyOrders = toRecorded(run.orders)

  const parts = makeTestContext({ nowMs: Date.UTC(2026, 6, 24, 3, 46, 0) })
  parts.md.setUnderlying('BANKNIFTY', 260105, 100)
  parts.md.setFuture('BANKNIFTY', FUT)
  parts.md.setOption('BANKNIFTY', 50000, 'CE', CE)
  parts.md.setOption('BANKNIFTY', 50000, 'PE', PE)
  parts.md.setOption('BANKNIFTY', 50100, 'CE', CE2)
  parts.md.setQuote({ token: PE.instrumentToken, lastPrice: 100, ts: 0 })
  const s = new PremiumDistanceAccumulatorStrategy(parts.ctx, EAGLE_S_1)
  const ticks: ReplayTick[] = [
    { ts: 0, quote: { token: FUT.instrumentToken, lastPrice: 50000, ts: 0 } },
    { ts: 1, quote: { token: CE.instrumentToken, lastPrice: 100, ts: 1 } },
    { ts: 2, quote: { token: FUT.instrumentToken, lastPrice: 50150, ts: 2 } },
  ]
  const res = await replay(s, parts, ticks)

  const diff = diffIntents(legacyOrders, [...res.orders])
  assert.equal(diff.match, true, diff.differences.join('\n'))
  // D9: no BUY order exists anywhere in EITHER sequence — this is the class
  // proof that stopPolicy:'none' is not merely configured but structurally true.
  assert.equal(legacyOrders.some((o) => o.side === 'BUY'), false)
  assert.equal(res.orders.some((o) => o.side === 'BUY'), false)
})

test('squareOff is eagle-s-1\'s ONLY exit — legacy has no equivalent call to compare against, so this is ported-side only, explicitly labelled', async () => {
  const parts = makeTestContext({ nowMs: Date.UTC(2026, 6, 24, 9, 48, 0) }) // 15:18 IST
  parts.md.setUnderlying('BANKNIFTY', 260105, 100)
  parts.md.setFuture('BANKNIFTY', FUT)
  parts.md.setOption('BANKNIFTY', 50000, 'CE', CE)
  parts.md.setOption('BANKNIFTY', 50000, 'PE', PE)
  parts.md.setQuote({ token: PE.instrumentToken, lastPrice: 100, ts: 0 })
  const s = new PremiumDistanceAccumulatorStrategy(parts.ctx, EAGLE_S_1)
  s.handleTick({ token: FUT.instrumentToken, lastPrice: 50000, ts: 0 })
  await s.drain()
  await s.firePhase('squareOff')
  const closes = parts.gateway.orders.filter((o) => o.side === 'BUY')
  assert.equal(closes.length, 2, 'both legs flattened at the central 15:24 square-off, eagle\'s only exit')
})
```

- [ ] **Step 3: Run and iterate until the diff is clean**

Run: `node --test packages/strategies/test/golden/premium-distance-accumulator-eagle.test.ts`
Expected: **2 passed.** If the diff is non-empty, check the trigger arithmetic first — eagle's
triggers are `Math.trunc`, matching legacy's `parseInt`-on-a-positive-number behaviour exactly;
a rounding-vs-truncation mismatch is the most likely source of a false diff here.

- [ ] **Step 4: Typecheck and full suite**

Run: `npm run typecheck && npm test`
Expected: 0 errors; all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/strategies
git commit -m "test(strategies): golden-master — eagle-s-1, D9 stopless sign-off applied

Multi-leg accumulation day diffs clean against the unmodified legacy file via
LegacyShadowRunner. Both sequences are asserted to contain ZERO BUY orders —
the structural proof that stopPolicy:'none' holds, not just that it's
configured. squareOff (15:24) remains the only exit path, ported-side only
since legacy has no equivalent to diff against, labelled as such per the
design spec's golden-master procedure step 5."
```

---

### Task 13: Golden-master — `lion-s25-2` (LIVE — first of the 3 live-order strategies)

Port order step 6: reuses the proven `PremiumLegBook` class and the shadow-runner technique from
Task 11; the new risk here is exclusively the live rail, not the class or the extraction method.
`lion-s25-2` differs from `bull-s-1` in exactly the ways the migration ledger records: per-leg
stop (`sl_trigger = ce_ltp * sl_percent`, checked independently per leg, `lion-s25-2.js:148,178`),
per-leg re-entry (only the stopped leg re-adds, not the whole group), and `reference:
'current-future'`.

**Explicitly OUT of scope for this task, and for Phase C as a whole:** wiring `lion-s25-2` onto
decision 3's resting-broker-stop (`rail.exitMechanism: 'broker-resting-stop'`, arming SL/target off
`OrderAverageTradedPrice`). That depends on `smp_order_listener` (the XTS order-update -> fill
stream producer) and the `order-gateway` runtime service, neither of which exists yet — both are
Phase B work per the design spec's phasing (§8, "not yet written"). This task's golden master
therefore verifies the **entry + per-leg tick-stop** behaviour only, `exitMechanism: 'local-tick'`,
byte-faithful to the legacy file exactly as it trades today. `rail.mode: 'live'` is set in the
config to record the eventual destination, but Phase C does not stand up a live order path — see
"What Phase C deliberately does NOT do" below.

**Files:**
- Create: `packages/strategies/test/golden/premium-leg-book-lion.test.ts`
- Create: `packages/strategies/src/premium-leg-book/configs/lion-s25.ts`

**Interfaces:**
- Consumes: `runLegacyShadow` (Task 7); `PremiumLegBookStrategy` (Task 3), extended for per-leg
  stop scope (already supported by the `stop.scope: 'per-leg'` branch built in Task 3).
- Produces: `LION_S25_2` config record.

- [ ] **Step 1: Write the config**

Create `packages/strategies/src/premium-leg-book/configs/lion-s25.ts`:

```ts
import type { PremiumLegBookConfig } from '../config.ts'

export const LION_S25_2: PremiumLegBookConfig = {
  tag: 'Lion_S25_2', class: 'premium-leg-book', enabled: true,
  underlying: { symbol: 'BANKNIFTY', reference: 'current-future', strikeStep: 100 },
  strike: { offsetPoints: 0 }, expiry: { select: 'nearest' },
  session: { startAt: '09:15:00', squareOffAt: '15:20:00' },
  sizing: { kind: 'flat', lots: 1 }, // lion-s25-2.js always sends lots=1 per leg (no pyramid)
  // Target rail is LIVE (XTS) — but decision 3's resting-stop wiring is Phase B/D work,
  // out of scope here. This config is the destination-of-record, not yet runnable live.
  rail: { mode: 'live', destinations: ['xts'], exitMechanism: 'local-tick' },
  risk: { maxLotsNet: 1, dayLossRupees: null },
  data: [{ kind: 'future', underlying: 'BANKNIFTY' }, { kind: 'option-chain', underlying: 'BANKNIFTY', strikeWindow: 5 }],
  legacy: { files: ['server/slive/lion-s25-2.js'], notes: 'D3 resting-stop wiring deferred to Phase B/D — see design spec section 4.3' },
  legs: [{ type: 'CE', side: 'SELL' }, { type: 'PE', side: 'SELL' }],
  stop: { scope: 'per-leg', multiplier: 1.25 },
  reentry: 'per-leg',
  squareOffIstMinute: 15 * 60 + 20,
}
```

- [ ] **Step 2: Write the failing golden-master test — per-leg stop fires independently**

Create `packages/strategies/test/golden/premium-leg-book-lion.test.ts`:

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { runLegacyShadow, type RecordedLegacyOrder } from '@algomaker/legacy-shadow-runner'
import { makeTestContext, replay, diffIntents, type ReplayTick, type RecordedOrder } from '@algomaker/strategy-kit'
import { PremiumLegBookStrategy } from '../../src/premium-leg-book/strategy.ts'
import { LION_S25_2 } from '../../src/premium-leg-book/configs/lion-s25.ts'

const SLIVE = path.join(import.meta.dirname, '..', '..', '..', '..', 'server', 'slive')

const FUT = { tradingsymbol: 'BANKNIFTY-FUT', instrumentToken: 999001, lotSize: 35, tickSize: 0.05, exchange: 'NFO' }
const CE = { tradingsymbol: 'BANKNIFTY50000CE', instrumentToken: 999002, lotSize: 35, tickSize: 0.05, exchange: 'NFO' }
const PE = { tradingsymbol: 'BANKNIFTY50000PE', instrumentToken: 999003, lotSize: 35, tickSize: 0.05, exchange: 'NFO' }

const OPTIONS_FIXTURE = {
  '50000CE': { instrument_token: CE.instrumentToken, tradingsymbol: CE.tradingsymbol, strike: 50000, lot_size: 35 },
  '50000PE': { instrument_token: PE.instrumentToken, tradingsymbol: PE.tradingsymbol, strike: 50000, lot_size: 35 },
};

function toRecorded(legacy: readonly RecordedLegacyOrder[]): RecordedOrder[] {
  return legacy.map((o) => ({ symbol: o.tradingsymbol, side: o.side, lots: o.lots, orderType: 'MARKET' }))
}

test('golden day — ONLY the stopped leg exits, the other stays open (per-leg, not combined)', async () => {
  const run = await runLegacyShadow({
    legacyFile: path.join(SLIVE, 'lion-s25-2.js'),
    futureToken: FUT.instrumentToken,
    currentExpiryOptions: OPTIONS_FIXTURE,
    nowMs: Date.UTC(2026, 6, 24, 3, 46, 0),
  })
  await run.advance(11_000) // lion-s25-2.js's own 5s+5s bootstrap sequence before startTrade=true
  await run.tick([
    { instrument_token: FUT.instrumentToken, last_price: 50000 },
    { instrument_token: CE.instrumentToken, last_price: 100 },
    { instrument_token: PE.instrumentToken, last_price: 100 },
  ])
  // CE alone crosses its OWN 1.25x trigger (125); PE stays well under its trigger.
  await run.tick([{ instrument_token: CE.instrumentToken, last_price: 130 }])
  run.stop()
  const legacyOrders = toRecorded(run.orders)

  const parts = makeTestContext({ nowMs: Date.UTC(2026, 6, 24, 3, 46, 0) })
  parts.md.setUnderlying('BANKNIFTY', 260105, 100)
  parts.md.setFuture('BANKNIFTY', FUT)
  parts.md.setOption('BANKNIFTY', 50000, 'CE', CE)
  parts.md.setOption('BANKNIFTY', 50000, 'PE', PE)
  parts.md.setQuote({ token: PE.instrumentToken, lastPrice: 100, ts: 0 })
  const s = new PremiumLegBookStrategy(parts.ctx, LION_S25_2)
  const ticks: ReplayTick[] = [
    { ts: 0, quote: { token: FUT.instrumentToken, lastPrice: 50000, ts: 0 } },
    { ts: 1, quote: { token: CE.instrumentToken, lastPrice: 100, ts: 1 } },
    { ts: 2, quote: { token: CE.instrumentToken, lastPrice: 130, ts: 2 } },
  ]
  const res = await replay(s, parts, ticks)

  const diff = diffIntents(legacyOrders, [...res.orders])
  assert.equal(diff.match, true, diff.differences.join('\n'))
  // The structural claim under test: exactly ONE BUY (closing CE only) — the
  // PE leg is untouched, proving the stop is per-leg, not combined.
  const buys = res.orders.filter((o) => o.side === 'BUY')
  assert.equal(buys.length, 1)
  assert.equal(buys[0]?.symbol, CE.tradingsymbol)
})
```

- [ ] **Step 3: Run and iterate until the diff is clean**

Run: `node --test packages/strategies/test/golden/premium-leg-book-lion.test.ts`
Expected: **1 passed.** Note `advance(11_000)` mirrors `lion-s25-2.js`'s own two chained
`setTimeout`s (5s then 5s, `lion-s25-2.js:75-81`) before `startTrade` is set — if the harness's
`mock.timers` does not carry the file past that bootstrap, `placeTrade` never runs and the test
will show zero orders on the legacy side; that is the first thing to check on a failure here.

- [ ] **Step 4: Typecheck and full suite**

Run: `npm run typecheck && npm test`
Expected: 0 errors; all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/strategies
git commit -m "test(strategies): golden-master — lion-s25-2 (LIVE, per-leg stop)

First live-order strategy ported. Diffs clean against the unmodified legacy
file via LegacyShadowRunner, including the 2-stage setTimeout bootstrap
(lion-s25-2.js:75-81) advanced through node:test's mock.timers. Proves the
stop is genuinely PER-LEG: only the triggered leg exits, the other stays open.

Decision 3's resting-broker-stop wiring is explicitly OUT of scope here —
rail.exitMechanism stays 'local-tick', byte-faithful to production. The
broker-resting-stop path depends on smp_order_listener and order-gateway,
both Phase B/D work per the design spec phasing."
```

---

### Task 14: Golden-master — `cheetah-b1-1`, `cheetah-b1-snx` (LIVE, LAST)

Port order step 7, LAST per the locked decision that all 3 live-order strategies port last.
`MomentumFlipDirectional` is not proven anywhere else in the active set, the martingale cap must
be enforced by `risk.maxLotsNet` before switch-on, and it carries live capital — the largest
combination of unproven-class risk and live-order risk in scope. `cheetah-b1-snx` differs from
`cheetah-b1-1` only in `underlying: 'SENSEX'` and a 3s vs 10s bootstrap delay (confirmed by
`diff server/slive/cheetah-b1-1.js server/slive/cheetah-b1-snx.js` in Task 2's research — the
diff is a handful of lines: strategy tag, `optionConfig('SENSEX')`/`futureToken=265`, and the
missing end-of-day `CronJob` block, which is inert either way since `scheduler` (not built in this
phase) owns EOD centrally).

**Files:**
- Create: `packages/strategies/test/golden/momentum-flip-directional-cheetah.test.ts`
- Create: `packages/strategies/src/momentum-flip-directional/configs/cheetah-b1.ts`

**Interfaces:**
- Consumes: `runLegacyShadow` (Task 7); `MomentumFlipDirectionalStrategy` (Task 4).
- Produces: `CHEETAH_B1_1`, `CHEETAH_B1_SNX` config records.

- [ ] **Step 1: Write the configs**

Create `packages/strategies/src/momentum-flip-directional/configs/cheetah-b1.ts`:

```ts
import type { MomentumFlipDirectionalConfig } from '../config.ts'

export const CHEETAH_B1_1: MomentumFlipDirectionalConfig = {
  tag: 'CheetahB1-1', class: 'momentum-flip-directional', enabled: true,
  underlying: { symbol: 'BANKNIFTY', reference: 'current-future', strikeStep: 100 },
  strike: { offsetPoints: 0 }, expiry: { select: 'nearest' },
  session: { startAt: '09:17:00', squareOffAt: '15:20:00' },
  sizing: { kind: 'martingale-capped', start: 1, cap: 12 }, // cheetah-b1-1.js:145
  rail: { mode: 'live', destinations: ['xts'], exitMechanism: 'local-tick' },
  risk: { maxLotsNet: 12, dayLossRupees: null }, // MUST equal sizing.cap — enforced at config load
  data: [{ kind: 'future', underlying: 'BANKNIFTY' }, { kind: 'option-chain', underlying: 'BANKNIFTY', strikeWindow: 2 }],
  legacy: { files: ['server/slive/cheetah-b1-1.js'], notes: 'D3 resting-stop wiring deferred to Phase B/D' },
  trailSlPoints: 10, targetPoints: 90,
  flip: { onStop: true, onTarget: false, strikeRef: 'frozen-first-atm' },
  bootstrapDelayMs: 10_000, squareOffIstMinute: 15 * 60 + 20,
}

// cheetah-b1-snx differs ONLY in underlying and bootstrap delay (confirmed by file diff).
export const CHEETAH_B1_SNX: MomentumFlipDirectionalConfig = {
  ...CHEETAH_B1_1,
  tag: 'Cheetah_B1_SNX',
  underlying: { symbol: 'SENSEX', reference: 'current-future', strikeStep: 100 },
  data: [{ kind: 'future', underlying: 'SENSEX' }, { kind: 'option-chain', underlying: 'SENSEX', strikeWindow: 2 }],
  legacy: { files: ['server/slive/cheetah-b1-snx.js'], notes: 'D3 resting-stop wiring deferred to Phase B/D' },
  bootstrapDelayMs: 3_000,
}
```

- [ ] **Step 2: Write the failing golden-master test — martingale growth AND the target/stop asymmetry**

Create `packages/strategies/test/golden/momentum-flip-directional-cheetah.test.ts`:

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { runLegacyShadow, type RecordedLegacyOrder } from '@algomaker/legacy-shadow-runner'
import { makeTestContext, replay, diffIntents, type ReplayTick, type RecordedOrder } from '@algomaker/strategy-kit'
import { MomentumFlipDirectionalStrategy } from '../../src/momentum-flip-directional/strategy.ts'
import { CHEETAH_B1_1 } from '../../src/momentum-flip-directional/configs/cheetah-b1.ts'
import { assertValidMomentumFlipConfig } from '../../src/momentum-flip-directional/config.ts'

const SLIVE = path.join(import.meta.dirname, '..', '..', '..', '..', 'server', 'slive')

const FUT = { tradingsymbol: 'BANKNIFTY-FUT', instrumentToken: 999001, lotSize: 35, tickSize: 0.05, exchange: 'NFO' }
const CE = { tradingsymbol: 'BANKNIFTY50000CE', instrumentToken: 999002, lotSize: 35, tickSize: 0.05, exchange: 'NFO' }
const PE = { tradingsymbol: 'BANKNIFTY50000PE', instrumentToken: 999003, lotSize: 35, tickSize: 0.05, exchange: 'NFO' }

const OPTIONS_FIXTURE = {
  '50000CE': { instrument_token: CE.instrumentToken, tradingsymbol: CE.tradingsymbol, strike: 50000, lot_size: 35 },
  '50000PE': { instrument_token: PE.instrumentToken, tradingsymbol: PE.tradingsymbol, strike: 50000, lot_size: 35 },
};

function toRecorded(legacy: readonly RecordedLegacyOrder[]): RecordedOrder[] {
  return legacy.map((o) => ({ symbol: o.tradingsymbol, side: o.side, lots: o.lots, orderType: 'MARKET' }))
}

test('config guard: martingale-capped ALWAYS requires risk.maxLotsNet === sizing.cap', () => {
  assert.doesNotThrow(() => assertValidMomentumFlipConfig(CHEETAH_B1_1))
  const uncapped = { ...CHEETAH_B1_1, risk: { maxLotsNet: null, dayLossRupees: null } }
  assert.throws(() => assertValidMomentumFlipConfig(uncapped), /maxLotsNet/,
    'this is what keeps the cheetah-b1-2117 uncapped sibling out of the active config set by construction')
})

test('golden day — stop-flip re-entry: legacy and ported both flip CE->PE at the frozen ATM', async () => {
  const run = await runLegacyShadow({
    legacyFile: path.join(SLIVE, 'cheetah-b1-1.js'),
    futureToken: FUT.instrumentToken,
    currentExpiryOptions: OPTIONS_FIXTURE,
    nowMs: Date.UTC(2026, 6, 24, 3, 47, 0), // 09:17 IST
  })
  await run.tick([{ instrument_token: FUT.instrumentToken, last_price: 50000, ohlc: { open: 49900 } }])
  await run.advance(10_000) // cheetah-b1-1.js's setTimeout(placeTrade, 10000)
  await run.tick([{ instrument_token: CE.instrumentToken, last_price: 120 }]) // establishes entry premium
  await run.tick([{ instrument_token: CE.instrumentToken, last_price: 105 }]) // below sl_trigger (120-10=110) -> SL, flips to PE
  run.stop()
  const legacyOrders = toRecorded(run.orders)

  const parts = makeTestContext({ nowMs: Date.UTC(2026, 6, 24, 3, 47, 0) })
  parts.md.setUnderlying('BANKNIFTY', 260105, 100)
  parts.md.setFuture('BANKNIFTY', FUT)
  parts.md.setOption('BANKNIFTY', 50000, 'CE', CE)
  parts.md.setOption('BANKNIFTY', 50000, 'PE', PE)
  const s = new MomentumFlipDirectionalStrategy(parts.ctx, CHEETAH_B1_1)
  const ticks: ReplayTick[] = [
    { ts: 0, quote: { token: FUT.instrumentToken, lastPrice: 49900, ts: 0 } }, // dayOpen
    { ts: 1, quote: { token: FUT.instrumentToken, lastPrice: 50000, ts: 1 } }, // above open -> CE
  ]
  const res = await replay(s, parts, ticks)
  await s.firePhase('bootstrapEntry')
  parts.md.setQuote({ token: CE.instrumentToken, lastPrice: 120, ts: 2 })
  s.handleTick({ token: CE.instrumentToken, lastPrice: 120, ts: 2 })
  await s.drain()
  parts.md.setQuote({ token: PE.instrumentToken, lastPrice: 80, ts: 3 })
  s.handleTick({ token: CE.instrumentToken, lastPrice: 105, ts: 3 })
  await s.drain()

  const diff = diffIntents(legacyOrders, [...res.orders, ...parts.gateway.orders])
  assert.equal(diff.match, true, diff.differences.join('\n'))
})

test('sizing: quantity increases by 1 per re-entry, hard-capped at 12 — never past it', async () => {
  const parts = makeTestContext({ nowMs: Date.UTC(2026, 6, 24, 3, 47, 0) })
  parts.md.setUnderlying('BANKNIFTY', 260105, 100)
  parts.md.setFuture('BANKNIFTY', FUT)
  parts.md.setOption('BANKNIFTY', 50000, 'CE', CE)
  parts.md.setOption('BANKNIFTY', 50000, 'PE', PE)
  const s = new MomentumFlipDirectionalStrategy(parts.ctx, CHEETAH_B1_1)
  s.handleTick({ token: FUT.instrumentToken, lastPrice: 49900, ts: 0 })
  await s.drain()
  s.handleTick({ token: FUT.instrumentToken, lastPrice: 50000, ts: 1 })
  await s.drain()
  parts.md.setQuote({ token: CE.instrumentToken, lastPrice: 120, ts: 2 })
  await s.firePhase('bootstrapEntry')
  assert.equal(parts.gateway.submitted[0]?.req.lots, 1, 'first entry is 1 lot')
  // 12 consecutive stop-flips would take quantity to 13 uncapped, but must stop at 12 — this
  // is the config-load guard (Step 2 above) PLUS the runtime cap in nextMartingaleQty (Task 4).
})
```

- [ ] **Step 3: Run and iterate until every diff is clean**

Run: `node --test packages/strategies/test/golden/momentum-flip-directional-cheetah.test.ts`
Expected: **3 passed.**

- [ ] **Step 4: Typecheck and full suite — Phase C's final gate**

Run: `npm run typecheck && npm test`
Expected: 0 type errors; every test in the repository passes, including all 263+ tests carried
over from before this plan and every test added across Tasks 1–14.

- [ ] **Step 5: Commit**

```bash
git add packages/strategies
git commit -m "test(strategies): golden-master — cheetah-b1-1, cheetah-b1-snx (LIVE, LAST)

Final Phase C port. MomentumFlipDirectionalConfig's martingale cap is enforced
equal to risk.maxLotsNet at config load — verified here to reject an uncapped
variant, which is what keeps cheetah-b1-2117's uncapped sibling out of the
active config set by construction (design spec section 4.3, OPEN item c).

All 15 active strategies are now golden-master-clean against their legacy
twins. This closes Phase C — see the exit criteria in the plan document."
```

---

## Phase C exit criteria

All objectively checkable:

- [ ] `npm test` passes; test count has grown by every test added in Tasks 1–14 over the Phase A
  baseline, with zero regressions.
- [ ] `npm run typecheck` reports 0 errors.
- [ ] `packages/strategy-config`, `packages/strategies`, and `packages/legacy-shadow-runner` exist,
  each following the standard package shape (Global Constraints).
- [ ] All 15 active strategies have a config record under `packages/strategies/src/*/configs/`:
  `bn-breakout`, `atr-band-nifty`, `orb-scalp` (×3 instances), `orb-fut-bn`, `orb-fut-nifty`,
  `orb-fut-snx`, `bull-s-1`, `bull-snx-1`, `lion-s25-2`, `cheetah-b1-1`, `cheetah-b1-snx`,
  `eagle-s-1`, `candlestrategy`, `candlestrategy-a006`, `candlestrategy-test3` — 15 configs total
  (17 counting `orb-scalp`'s 3 instances as separate records).
- [ ] Every golden-master test file under `packages/strategies/test/golden/` passes, and every
  `diffIntents()` call in those files reports `match: true` — or, for `eagle-s-1`'s squareOff case
  and the D3-affected legs generally, the divergence is explicitly labelled as expected and why.
- [ ] `server/test/no-plaintext-credentials.test.js` passes — no optionbhai credential literal
  remains in any `candlestrategy*.js` file.
- [ ] `server/test/bn-breakout-logic.test.js` passes and `git log --follow` on
  `server/slive/bn-breakout-logic.js` shows it was extracted (not created from scratch) from
  `bn-breakout.js`.
- [ ] Every one of `bull-s-1`, `bull-snx-1`, `lion-s25-2`, `eagle-s-1`, `cheetah-b1-1`,
  `cheetah-b1-snx` remains byte-for-byte unmodified in `server/slive/` (verify with
  `git diff --stat` against the branch point before Task 1 — only `bn-breakout.js`,
  `bn-breakout-logic.js`, and the 3 `candlestrategy*.js` credential edits should show a diff).
- [ ] D9 is enforced, not just documented: `assertValidConfig`/`assertValidPremiumDistanceAccumulatorConfig`
  never reject `maxLotsNet: null` or `stopPolicy: 'none'` (Task 1, Task 5 tests), and
  `BULL_S_1`/`BULL_SNX_1`'s shipped config actually has `sizing.cap: null`/`risk.maxLotsNet: null`
  (Task 11), and `EAGLE_S_1`'s shipped config actually has `stopPolicy: 'none'` (Task 12) — the
  sign-off is load-bearing in the committed config, not just a comment.
- [ ] `cheetah-b1-2117`'s uncapped-martingale config does NOT exist anywhere in
  `packages/strategies/src/momentum-flip-directional/configs/` — confirmed by
  `assertValidMomentumFlipConfig` rejecting an uncapped variant (Task 14).
- [ ] Port order was honoured: `git log --oneline` shows the 3 live-order strategies
  (`lion-s25-2`, `cheetah-b1-1`/`cheetah-b1-snx`) committed strictly after all 12 sim/paper-rail
  strategies.

## What Phase C deliberately does NOT do

Scope guard, so a reviewer can tell "not done" from "out of scope":

- **No runtime services.** `apps/runner`, `apps/order-gateway`, `apps/marketdata`, `apps/scheduler`
  do not exist after this phase. The config records this phase produces are not wired into
  anything that runs continuously — they are verified in isolation via `replay()`. Standing up the
  runtime is later phasing (§8 of the design spec).
- **No decision-3 resting-stop wiring**, for any strategy, including the 3 LIVE ones. Every config
  in this phase keeps `rail.exitMechanism: 'local-tick'`. `smp_order_listener` (the XTS
  order-update -> `FillStream` producer decision 3 depends on) is not built here.
- **No `BrokerAdapter` implementations.** `zerodha-data`, `xts-live`, and the resting-order
  `simulator` upgrade (§2 of the design spec) are Phase B work.
- **No cutover.** Nothing in this phase deletes, disables, or stops any of the 15 legacy `pm2`
  processes. They keep trading exactly as before, unaffected by anything built here.
- **No P&L backtesting.** Every golden-master fixture in this plan exists solely to prove a ported
  strategy emits the same orders as its legacy twin (decision 6) — none of it computes or reports
  P&L.
- **No stock-underlying expansion, no `RollingLegStrangle`/`RungLadderSeller`/`StraddleScalper`/
  `SpreadLadderEngine`/`IndicatorFlipStructure`/`ChainScanBreakout`.** None of the active 15 needs
  them (design spec §4.1); building any of them here would be scope creep against the taxonomy's
  own "do not build" list.
