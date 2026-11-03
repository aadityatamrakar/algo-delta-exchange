/**
 * A repair worker thread (repair-pool.ts `workerRunner`), one job at a time:
 * a `RepairJob` in, `{ ok: true, plans }` out; a `PlanSearchJob` (kind
 * 'plan-search') in, `{ ok: true, result }` out — the objective search,
 * `searchPlans`, on the context rebuilt from the job; `{ ok: false, error }`
 * when either fails. It imports the searches and the thread API and nothing else.
 */

import { parentPort } from 'node:worker_threads'
import { searchPlans } from '@algomaker/payoff'
import { isPlanSearchJob, runPlanSearchJob, type PlanSearchJob } from './plan-search-job.ts'
import { runRepairJob, type RepairJob } from './repair.ts'

parentPort?.on('message', (job: RepairJob | PlanSearchJob) => {
  try {
    if (isPlanSearchJob(job)) parentPort?.postMessage({ ok: true, result: runPlanSearchJob(job, searchPlans) })
    else parentPort?.postMessage({ ok: true, plans: runRepairJob(job) })
  } catch (err) {
    parentPort?.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) })
  }
})
