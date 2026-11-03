// A stand-in repair worker for the deadline test (repair-pool.test.ts): it answers every
// job at once with no plans, except a job marked `hang`, which it never answers.
import { parentPort } from 'node:worker_threads'

parentPort?.on('message', (job: { hang?: boolean }) => {
  if (job.hang !== true) parentPort?.postMessage({ ok: true, plans: [] })
})
