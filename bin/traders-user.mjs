/**
 * Traders account management — create the first admin, reset a password.
 *
 *   node bin/traders-user.mjs create-admin <username> [--password <pw>]
 *   node bin/traders-user.mjs reset <username> [--password <pw>]
 *   node bin/traders-user.mjs unlock <username>
 *   node bin/traders-user.mjs list
 *
 * Calls `main()` EXPLICITLY, as bin/desk-user.mjs does: the module's "am I the
 * entry point?" guard does not match under a wrapper such as pm2, and the
 * failure is silent.
 */
import { main, reportError } from '../apps/traders/src/user-cli.ts'

main(process.argv.slice(2)).catch((err) => {
  reportError(err)
  process.exit(1)
})
