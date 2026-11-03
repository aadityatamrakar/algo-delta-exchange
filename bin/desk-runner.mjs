/**
 * pm2 launcher for apps/runner — the hosted intraday strategies.
 *
 * Calls `main()` EXPLICITLY rather than relying on an "am I the entry point?"
 * guard. That guard compares `import.meta.url` against `process.argv[1]`, which
 * does not match under any wrapper — pm2's fork container included. The failure
 * mode is silent: the process starts, runs no code, and exits 0, which pm2 then
 * restarts forever with an empty log. `apps/runner/src/main.ts` therefore has no
 * such guard at all.
 */
import { main } from '../apps/runner/src/main.ts'

main().catch((err) => {
  console.error('[runner] fatal', err)
  process.exit(1)
})
