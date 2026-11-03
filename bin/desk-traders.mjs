/**
 * pm2 launcher for apps/traders — the traders' analytics app (read-only; it
 * never places or changes an order).
 *
 * Calls `main()` EXPLICITLY rather than relying on an "am I the entry point?"
 * guard, which does not match under pm2's fork container: the process would
 * start, run nothing and exit 0, forever (see bin/desk-runner.mjs).
 */
import { main } from '../apps/traders/src/main.ts'

main().catch((err) => {
  console.error('[traders] fatal', err)
  process.exit(1)
})
