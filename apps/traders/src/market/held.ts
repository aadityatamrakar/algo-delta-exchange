/**
 * `<nseDir>/held.json` — the stocks of every trader's open books, for scripts/nse_vol_job.py, which snapshots their
 * option chains each evening: `{ "asOf": "<ISO time>", "stocks": ["TCS", …] }`, written atomically. The app writes it
 * from the open legs its SPAN pass reads each minute. Stock symbols only: no trader, client code, leg or quantity
 * leaves the app this way.
 *
 * The NSE folder is the span job's; when it does not exist nothing is written (and it is not made here).
 */

import { rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { istDate } from '../routes/kit.ts'
import { isOpenLeg, type TraderLeg } from '../types.ts'

export const HELD_FILE = 'held.json'

type Held = Pick<TraderLeg, 'stock' | 'qty' | 'instrument' | 'expiry'>

export function heldStocks(legs: readonly Held[], today: string): string[] {
  return [...new Set(legs.filter((l) => isOpenLeg(l, today)).map((l) => l.stock))].sort()
}

/** False when `dir` is not there (nothing written). A failed write throws; the last file stays. */
export async function writeHeld(dir: string, legs: readonly Held[], nowMs: number): Promise<boolean> {
  try {
    if (!(await stat(dir)).isDirectory()) return false
  } catch {
    return false
  }
  const path = join(dir, HELD_FILE)
  const tmp = `${path}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify({ asOf: new Date(nowMs).toISOString(), stocks: heldStocks(legs, istDate(nowMs)) }))
  await rename(tmp, path)
  return true
}
