/**
 * Shared tolerance helper for the GOLDEN PARITY suites.
 *
 * Every parity test in this repo compares a TS answer against a number the
 * Python desk produced (the NSE repo's `scripts/gen-parity-fixtures.py`), and every one of
 * them needs the same two-sided tolerance, for the same reason: the quantities
 * being compared span ten orders of magnitude in one fixture file. A book P&L is
 * ±10^6 rupees, a gamma is 10^-3, and an out-of-the-money option can be worth
 * 10^-7. A pure absolute tolerance either passes everything at the small end or
 * fails everything at the large end; a pure relative one explodes on the values
 * that are legitimately near zero.
 *
 * So: `close` passes if EITHER bound is satisfied. Absolute covers "this number
 * is small enough that the difference is float noise"; relative covers "this
 * number is large, judge the difference against its own scale".
 *
 * NOT a test-runner assertion on purpose — it returns a boolean. The parity
 * suites walk hundreds of cases and collect every failure before reporting, so
 * one bad grid point tells you about all the others rather than hiding them
 * behind the first throw.
 *
 * Two things about the FILENAME, both deliberate:
 *
 * `.ts` — plain, since `packages/payoff/package.json` now exists and declares
 * `"type": "module"`. It was born `.mts` because it did not: under
 * `moduleResolution: nodenext` the module kind of a `.ts` file comes from the
 * nearest `package.json`, and before this package had one the nearest was the
 * ROOT, which declares no `"type"` — so a `.ts` here was inferred CommonJS and
 * `verbatimModuleSyntax` rejected its `export` outright (TS1287). `.mts` was
 * unambiguously ESM whatever the enclosing package said. That workaround retired
 * with the package manifest; nothing depends on the extension either way, and
 * the only importer outside this directory is the greeks parity suite.
 *
 * Not `*.test.ts`, because the root test glob (`packages/*​/test/**​/*.test.ts`)
 * would otherwise pick it up and run a file containing no tests.
 */

export interface Tolerance {
  /** Passes when `|a-b|` is within this, regardless of scale. */
  readonly abs: number
  /** Passes when `|a-b|` is within this fraction of `max(|a|, |b|)`. */
  readonly rel: number
}

export function close(a: number, b: number, tol: Tolerance): boolean {
  const d = Math.abs(a - b)
  return d <= tol.abs || d <= tol.rel * Math.max(Math.abs(a), Math.abs(b))
}
