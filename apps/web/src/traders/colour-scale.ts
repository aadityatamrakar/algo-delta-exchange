/**
 * Market Watch's colour scale: a value's strength against the biggest
 * magnitude among the rows on screen, in seven steps from -3 to +3.
 */

export type ColourStep = -3 | -2 | -1 | 0 | 1 | 2 | 3

/**
 * round(3 × value / max(|min|, |max|)), clamped to ±3 and rounded away from
 * zero at a half. null for an unknown value (never painted); 0 when the column
 * has nothing to compare against (one value, or a scale of zeros).
 */
export function colourStep(value: number | null, min: number, max: number): ColourStep | null {
  if (value === null || !Number.isFinite(value)) return null
  const scale = Math.max(Math.abs(min), Math.abs(max))
  if (min === max || !(scale > 0)) return 0
  const n = Math.min(3, Math.round((3 * Math.abs(value)) / scale))
  return (value < 0 ? -n : n) as ColourStep
}

/** The step's fill: the theme's success token for a positive step, error for a negative, deeper with the step. */
export function stepFill(step: ColourStep | null): string | undefined {
  if (step === null || step === 0) return undefined
  const token = step > 0 ? '--color-success' : '--color-error'
  return `color-mix(in srgb, var(${token}) ${Math.abs(step) * 12}%, transparent)`
}
