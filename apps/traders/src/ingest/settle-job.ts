/**
 * The settlement backfill as a recompute (spec 2026-10-23-traders-gaps G1). Settlement fills are derived from the NSE
 * history, never stored, so a trader's stored legs are only as settled as the history was at their last ledger run.
 * A trader who sends no file after an expiry would keep the expired contract open. So on boot, and whenever the
 * history store picks up a day, every trader's ODIN legs are made again, as an apply makes them:
 * `legs.replaceOdin(trader, ledger.odinLegs(trader))`.
 *
 * WHY through the ingest chain: an apply reads the ledger and then writes the legs, and so does this. If the two
 * interleaved for one trader, the older read could land last. Each trader's run waits its turn in the same
 * per-trader chain uploads use (pipeline.ts `serialised`, keyed by the one `IngestDeps`).
 *
 * Idempotent: `replaceOdin` writes only a leg whose qty, price or token changed, so a second run with the same
 * history writes nothing and bumps no leg version. Runs queue behind each other. A trader whose run fails is logged
 * and skipped, and the next run tries again. One log line per run: counts only, never a client code.
 */

import type { LegStore } from '../books/legs.ts'
import { matchLeg, type TradersMaster } from '../market/master.ts'
import type { Log } from '../routes/kit.ts'
import type { LedgerStore } from './ledger-store.ts'
import { serialised, type IngestDeps } from './pipeline.ts'

export interface SettleJobDeps {
  readonly ledger: Pick<LedgerStore, 'traders' | 'odinLedger'>
  readonly legs: Pick<LegStore, 'replaceOdin'>
  readonly master: () => TradersMaster
  /** The app's one IngestDeps: its per-trader chains are what serialise this against uploads. */
  readonly ingest: IngestDeps
  readonly log: Log
  readonly now: () => number
}

export interface SettleSummary {
  readonly traders: number
  /** Settlement fills made, delivered-share fills included. */
  readonly fills: number
  /** Expired contracts left open for want of a settlement price. */
  readonly unsettled: number
  /** Traders whose run failed (logged one by one). */
  readonly failed: number
  readonly ms: number
}

/** Every trader's ODIN legs made again with today's settlement; never throws. */
export async function recomputeSettlement(d: SettleJobDeps): Promise<SettleSummary> {
  const started = d.now()
  let traders: string[]
  try {
    traders = await d.ledger.traders()
  } catch (err) {
    d.log('settlement recompute: listing the traders failed', { error: String(err) })
    return { traders: 0, fills: 0, unsettled: 0, failed: 0, ms: d.now() - started }
  }
  let fills = 0
  let unsettled = 0
  let failed = 0
  for (const trader of traders) {
    try {
      await serialised(d.ingest, trader, async () => {
        const run = await d.ledger.odinLedger(trader)
        const master = d.master()
        await d.legs.replaceOdin(trader, run.legs, (c) => matchLeg(master, c))
        fills += run.settlement.fills.length
        unsettled += run.settlement.unsettled.length
      })
    } catch (err) {
      failed++
      d.log('settlement recompute failed for a trader', { trader, error: String(err) })
    }
  }
  const summary = { traders: traders.length, fills, unsettled, failed, ms: d.now() - started }
  d.log('settlement recomputed', summary)
  return summary
}

/** `recomputeSettlement`, one run at a time: a call made while one runs starts after it. */
export function settlementJob(d: SettleJobDeps): () => Promise<SettleSummary> {
  let tail: Promise<unknown> = Promise.resolve()
  return () => {
    const run = tail.then(() => recomputeSettlement(d))
    tail = run.catch(() => {})
    return run
  }
}
