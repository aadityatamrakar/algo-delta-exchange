/**
 * A loopback stand-in for the desk-supervisor's `/nudge` endpoint.
 *
 * WHY THIS EXISTS. `notifySupervisor` (`../src/engine-notify.ts`) is called
 * from the registry start/stop routes, the dials PATCH and the paper-fold
 * fill path, and it resolves the supervisor's port from
 * `DESK_SUPERVISOR_PORT` per call — defaulting to 8893, the REAL
 * desk-supervisor's port, when that env var is unset. Four api test files
 * (audit.test.ts, delta-lean-registration.test.ts, delta-lean-roll.test.ts,
 * paper-stamp.test.ts) drove those routes without ever pointing the env var
 * anywhere, so on this desk box every nudge they produced reached the LIVE
 * supervisor with no bearer token and was refused — 107 refusals per api
 * suite run (2 + 1 + 100 + 4), each logged once a minute as
 * `a nudge was REFUSED for a bad token`.
 *
 * Any test that exercises the registry routes, the dials PATCH, or
 * paper-fold's fill nudge MUST start one of these and let it point
 * `DESK_SUPERVISOR_PORT` at itself before driving those routes — otherwise
 * the test either racks up refusals on the live supervisor (if reachable) or
 * hangs a request on a closed port until the 1s timeout, once per call.
 */

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface NudgeSink {
  readonly port: number
  /** Every nudge body received so far, oldest first. Mutate in place (e.g. `nudges.length = 0`) to reset between tests — the reference never changes. */
  readonly nudges: Record<string, unknown>[]
  /** Stops the loopback server and restores `DESK_SUPERVISOR_PORT` to whatever it was before this sink started (deleted if it was unset). */
  close(): Promise<void>
}

/** Starts the sink and points `DESK_SUPERVISOR_PORT` at it. */
export async function startNudgeSink(): Promise<NudgeSink> {
  const nudges: Record<string, unknown>[] = []
  const server: Server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += String(c)))
    req.on('end', () => {
      nudges.push(JSON.parse(body === '' ? '{}' : body) as Record<string, unknown>)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{}')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port

  // Captured BEFORE we overwrite it, so `close()` can put back exactly what
  // was there — which, thanks to `require-mongo.ts`'s module-scope guard, is
  // ordinarily a throwaway unreachable port, not `undefined`.
  const prior = process.env['DESK_SUPERVISOR_PORT']
  process.env['DESK_SUPERVISOR_PORT'] = String(port)

  return {
    port,
    nudges,
    async close(): Promise<void> {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      if (prior === undefined) delete process.env['DESK_SUPERVISOR_PORT']
      else process.env['DESK_SUPERVISOR_PORT'] = prior
    },
  }
}
