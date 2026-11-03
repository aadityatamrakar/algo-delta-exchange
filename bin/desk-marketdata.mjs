/**
 * pm2 launcher for apps/marketdata.
 *
 * Calls `main()` EXPLICITLY rather than relying on the module's
 * "am I the entry point?" guard. That guard compares `import.meta.url` against
 * `process.argv[1]`, which does not match under any wrapper — pm2's fork
 * container included. The failure mode is silent: the process starts, runs no
 * code, and exits 0, which pm2 then restarts forever with an empty log.
 */
import { main } from '../apps/marketdata/src/main.ts'

main().catch((err) => {
  console.error('[marketdata] fatal', err)
  process.exit(1)
})
