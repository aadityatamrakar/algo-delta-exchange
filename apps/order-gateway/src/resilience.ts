/**
 * MOVED TO `@algomaker/core` (audit F-41). This file is now a re-export.
 *
 * The guards were written here, for this process, out of this process's two
 * incidents (G4 and G6 — the war stories moved with the code and are worth
 * reading before touching either function). They were then installed NOWHERE
 * ELSE: `apps/api` and `apps/runner` both awaited a bare `connectMongo`, so a
 * Mongo that came up 20 seconds late took the bridge down for the session while
 * the gateway rode it out. One copy in `packages/core` is what makes "install
 * them everywhere" a one-line change per app instead of a second copy.
 *
 * KEPT AS A FILE rather than rewriting the imports: `main.ts` and this app's
 * tests import `./resilience.ts`, and a re-export means the move cannot have
 * changed their behaviour — the gateway's own suite still exercises the real
 * implementation through this path.
 */

export {
  connectWithRetry,
  installCrashGuards,
  type ProcessLike,
  type RetryOptions,
} from '@algomaker/core'
