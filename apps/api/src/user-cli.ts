/**
 * Operator account management.
 *
 *   node bin/desk-user.mjs create <username>     the first (and usually only) account
 *   node bin/desk-user.mjs reset <username>      set a new password, revoking every session
 *   node bin/desk-user.mjs unlock <username>     clear a lockout early
 *   node bin/desk-user.mjs list                  accounts, never hashes
 *
 * THERE IS NO SIGNUP ENDPOINT AND THERE MUST NOT BE ONE. This service is
 * internet-facing and password-only (spec A2), so an HTTP path that creates an
 * account is a path that creates a full-control account. Creating one requires
 * shell access to the box, which is the same bar as reading `DESK_MASTER_KEY`.
 *
 * The password is read from a hidden prompt by default. `--password` is accepted
 * for automation but warned about: it lands in shell history and in `ps`.
 */

import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hashPassword } from '@algomaker/auth'
import { connectMongo } from './mongo.ts'
import { AuthStore, DuplicateUser, InvalidUsername } from './authstore.ts'

const MONGO = process.env['DESK_MONGO_URL'] ?? 'mongodb://127.0.0.1:27017/algomaker_dx'

/**
 * 8 characters, set by the operator on 2026-07-27 (was 12).
 *
 * What still stands behind it: argon2id at 19 MiB makes offline guessing
 * expensive, lockout is 5 attempts per 15 minutes and is now an atomic `$inc`
 * (so a concurrent burst gets 5 tries, not 200), and the two actions that can
 * move real money ask for the password again.
 *
 * What the shorter minimum costs, stated plainly so it is a known trade rather
 * than a forgotten one: online guessing is bounded by lockout at roughly 480
 * attempts a day, which no 8-character password of any composition falls to —
 * but OFFLINE guessing, if the `desk-users` collection ever leaks, is where the
 * four missing characters mattered. Length is the only dial that helps there.
 * A leaked hash plus a short password is full control of a live trading account.
 *
 * So: 8 is fine while the database is not exposed. If Mongo is ever reachable
 * from outside this host, raise this and rotate.
 */
const MIN_PASSWORD_LENGTH = 8

const USAGE = `usage:
  desk-user create <username> [--password <pw>]
  desk-user reset  <username> [--password <pw>]
  desk-user unlock <username>
  desk-user list`

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const cmd = argv[0]
  if (cmd === undefined || cmd === '--help' || cmd === '-h') {
    console.log(USAGE)
    return
  }

  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(name)
    return i >= 0 ? argv[i + 1] : undefined
  }

  const mongo = await connectMongo(MONGO)
  const store = new AuthStore(mongo.db)
  try {
    await store.ensureIndexes()

    switch (cmd) {
      case 'create': {
        const username = argv[1]
        if (username === undefined) throw new Error(USAGE)
        const password = await obtainPassword(flag('--password'))
        const user = await store.createUser(username, await hashPassword(password), Date.now())
        console.log(`created operator "${user.username}"`)
        const total = await store.countUsers()
        if (total > 1) {
          // Spec A1 is single-operator. A second account is not blocked — losing
          // access to the only one during a session would be worse — but it is
          // said out loud, because nothing in the UI will ever mention it.
          console.log(`note: this deployment now has ${total} accounts; the design assumes one operator`)
        }
        break
      }

      case 'reset': {
        const username = argv[1]
        if (username === undefined) throw new Error(USAGE)
        const password = await obtainPassword(flag('--password'))
        const ok = await store.setPassword(username, await hashPassword(password), Date.now())
        if (!ok) throw new Error(`no such user "${username}"`)
        console.log(`password reset for "${username}"; every session for it has been revoked`)
        break
      }

      case 'unlock': {
        const username = argv[1]
        if (username === undefined) throw new Error(USAGE)
        const user = await store.findUser(username)
        if (user === null) throw new Error(`no such user "${username}"`)
        await store.clearLoginFailures(user.username)
        console.log(`lockout cleared for "${user.username}"`)
        break
      }

      case 'list': {
        const users = await store.listUsernames()
        if (users.length === 0) {
          console.log('no operator accounts — create one with: node bin/desk-user.mjs create <username>')
          break
        }
        const now = Date.now()
        for (const u of users) {
          const locked = u.lockedUntil !== null && now < u.lockedUntil
          console.log(
            `${u.username.padEnd(20)} ` +
              `lastLogin=${u.lastLoginAt === null ? 'never' : new Date(u.lastLoginAt).toISOString()} ` +
              `failed=${u.failedAttempts}` +
              (locked ? ` LOCKED until ${new Date(u.lockedUntil ?? 0).toISOString()}` : ''),
          )
        }
        break
      }

      default:
        throw new Error(USAGE)
    }
  } finally {
    await mongo.close()
  }
}

async function obtainPassword(fromFlag: string | undefined): Promise<string> {
  if (fromFlag !== undefined) {
    console.error('warning: --password is visible in shell history and in `ps`; prefer the prompt')
    return assertStrong(fromFlag)
  }
  const first = await readHidden('password: ')
  // Only a TTY is asked to confirm. Piped stdin is a single stream that has
  // already ENDED by the time the first read resolves, so a second read never
  // fires its 'end' event and the command hangs forever with no output —
  // exactly the silent failure this CLI exists to avoid.
  if (process.stdin.isTTY !== true) return assertStrong(first)
  const second = await readHidden('confirm : ')
  if (first !== second) throw new Error('passwords do not match')
  return assertStrong(first)
}

function assertStrong(password: string): string {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`password must be at least ${MIN_PASSWORD_LENGTH} characters`)
  }
  return password
}

/**
 * Read a line without echoing it.
 *
 * Hand-rolled over raw mode rather than a readline hack: readline offers no
 * supported way to suppress echo, and every published workaround overwrites a
 * private method. When stdin is not a TTY the input is taken as a piped line, so
 * `echo pw | desk-user create x` works in a provisioning script.
 */
function readHidden(prompt: string): Promise<string> {
  const input = process.stdin
  if (input.isTTY !== true) {
    return new Promise<string>((resolve, reject) => {
      let data = ''
      input.setEncoding('utf8')
      input.on('data', (chunk: string) => {
        data += chunk
      })
      input.on('end', () => resolve(data.split('\n')[0] ?? ''))
      input.on('error', reject)
    })
  }

  return new Promise<string>((resolve, reject) => {
    process.stdout.write(prompt)
    input.setRawMode(true)
    input.resume()
    input.setEncoding('utf8')
    let buf = ''
    const finish = (fn: () => void): void => {
      input.off('data', onData)
      input.setRawMode(false)
      input.pause()
      process.stdout.write('\n')
      fn()
    }
    const onData = (chunk: string): void => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') {
          finish(() => resolve(buf))
          return
        }
        // Ctrl-C in raw mode does NOT produce SIGINT, so it has to be handled
        // here or the operator's only exit is killing the terminal.
        if (ch === '\u0003') {
          finish(() => reject(new Error('cancelled')))
          return
        }
        if (ch === '\u007f' || ch === '\b') buf = buf.slice(0, -1)
        else buf += ch
      }
    }
    input.on('data', onData)
  })
}

export function reportError(err: unknown): void {
  if (err instanceof DuplicateUser || err instanceof InvalidUsername) {
    console.error(err.message)
    return
  }
  console.error(err instanceof Error ? err.message : String(err))
}

// Only run when executed directly, so `bin/desk-user.mjs` — which calls `main()`
// explicitly — does not run it twice. Compared as resolved paths, matching
// `main.ts`.
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((err: unknown) => {
    reportError(err)
    process.exit(1)
  })
}
