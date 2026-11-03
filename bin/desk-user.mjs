/**
 * Operator account management — create the first login, reset a password.
 *
 *   node bin/desk-user.mjs create <username>
 *   node bin/desk-user.mjs reset  <username>
 *   node bin/desk-user.mjs unlock <username>
 *   node bin/desk-user.mjs list
 *
 * Calls `main()` EXPLICITLY rather than relying on the module's "am I the entry
 * point?" guard. That guard compares `import.meta.url` against `process.argv[1]`,
 * which does not match under any wrapper — pm2's fork container included. The
 * failure mode is silent: the process starts, runs no code, and exits 0.
 */
import { main, reportError } from '../apps/api/src/user-cli.ts'

main(process.argv.slice(2)).catch((err) => {
  reportError(err)
  process.exit(1)
})
