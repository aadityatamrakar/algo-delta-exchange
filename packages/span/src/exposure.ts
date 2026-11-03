import { SpanParseError } from './xml.ts'
import { parseCsv } from './csv.ts'

/**
 * NSE's exposure-margin (ELM) file, `ael_DDMMYYYY.csv`: symbol -> fraction of
 * contract value (3.5 % -> 0.035). Header-driven: the `Symbol` column, then the
 * total-applicable ELM column, else the last column whose first row is numeric.
 */
export function parseExposureFile(csv: string): ReadonlyMap<string, number> {
  const rows = parseCsv(csv)
  const head = rows[0] ?? []
  const sym = head.findIndex((h) => /symbol/i.test(h))
  if (sym < 0) throw new SpanParseError('exposure file: no Symbol column')
  let val = head.findIndex((h) => /total.*elm|applicable.*elm/i.test(h))
  if (val < 0) {
    const first = rows[1] ?? []
    for (let i = head.length - 1; i >= 0; i--) if (i !== sym && first[i] !== undefined && first[i] !== '' && Number.isFinite(Number(first[i]))) { val = i; break }
  }
  if (val < 0) throw new SpanParseError('exposure file: no exposure-margin column')
  const out = new Map<string, number>()
  let bad = ''
  for (const r of rows.slice(1)) {
    const symbol = r[sym], raw = (r[val] ?? '').replace(/%$/, '').trim(), pct = Number(raw)
    if (!symbol) continue
    if (raw === '' || !Number.isFinite(pct)) { bad ||= `${symbol} '${r[val] ?? ''}'`; continue }
    out.set(symbol, Number((pct / 100).toPrecision(12)))
  }
  if (out.size === 0 && bad) throw new SpanParseError(`exposure file: no row could be read — first bad row: ${bad}`)
  return out
}
