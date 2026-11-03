/**
 * pm2 launcher for apps/watchdog (dx-watchdog).
 *
 * Calls `main()` EXPLICITLY, like every other launcher here: an "am I the
 * entry point?" guard never matches under pm2's fork container, and the
 * process would start, run nothing, and exit 0.
 */
import { main } from '../apps/watchdog/src/main.ts'

main().catch((err) => {
  console.error('[watchdog] fatal', err)
  process.exit(1)
})
