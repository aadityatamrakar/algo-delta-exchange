/**
 * Account management for the traders app.
 *
 *   create-admin <username> [--password <pw>]   the first admin (needs shell access, by design)
 *   reset <username> [--password <pw>]          new password, every session revoked, lockout cleared
 *   unlock <username>                           clear a lockout early
 *   list                                        accounts, never hashes
 *
 * There is no signup endpoint and there must not be one. Traders are created by
 * an admin on the admin page, not here. `TRADERS_MONGO_URL` is required: there
 * is no default, so this can never touch the desk's database by accident.
 */

import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hashPassword } from '@algomaker/auth'
import { connectMongo } from '../../api/src/mongo.ts'
import { SessionStore } from './auth/sessions.ts'
import {
  assertPassword, assertUsername, DuplicateUser, InvalidUsername, normaliseUsername, TraderStore, WeakPassword,
} from './auth/users.ts'
import { TradersDb } from './db.ts'

const USAGE = `usage:
  traders-user create-admin <username> [--password <pw>]
  traders-user reset <username> [--password <pw>]
  traders-user unlock <username>
  traders-user list`

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const cmd = argv[0]
  if (cmd === undefined || cmd === '--help' || cmd === '-h') {
    console.log(USAGE)
    return
  }
  if (!['create-admin', 'reset', 'unlock', 'list'].includes(cmd)) throw new Error(USAGE)
  const url = process.env['TRADERS_MONGO_URL']
  if (url === undefined || url === '') throw new Error('TRADERS_MONGO_URL is not set')
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(name)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const target = argv[1] !== undefined && !argv[1].startsWith('--') ? argv[1] : undefined
  if (cmd !== 'list' && target === undefined) throw new Error(USAGE)

  // Everything that can be refused is refused before Mongo is touched.
  let password = ''
  if (cmd === 'create-admin') assertUsername(target)
  if (cmd === 'create-admin' || cmd === 'reset') password = await obtainPassword(flag('--password'))

  const mongo = await connectMongo(url)
  try {
    const db = new TradersDb(mongo.db)
    await db.ensureIndexes()
    const users = new TraderStore(db)
    const sessions = new SessionStore(db)

    switch (cmd) {
      case 'create-admin': {
        const u = await users.create(target, await hashPassword(password), 'admin', Date.now())
        console.log(`created admin "${u.username}"`)
        break
      }
      case 'reset': {
        const name = normaliseUsername(target)
        if (!(await users.setPassword(name, await hashPassword(password)))) throw new Error(`no such user "${name}"`)
        await sessions.revokeAll(name)
        console.log(`password reset for "${name}"; every session for it has been revoked`)
        break
      }
      case 'unlock': {
        const u = await users.find(target)
        if (u === null) throw new Error(`no such user "${normaliseUsername(target)}"`)
        await users.clearLoginFailures(u.username)
        console.log(`lockout cleared for "${u.username}"`)
        break
      }
      case 'list': {
        const all = await users.list()
        if (all.length === 0) {
          console.log('no accounts — create one with: node bin/traders-user.mjs create-admin <username>')
          break
        }
        const now = Date.now()
        for (const u of all) {
          const locked = u.lockedUntil !== null && now < u.lockedUntil
          console.log(
            `${u.username.padEnd(20)} ${u.role.padEnd(7)} ` +
              `disabled=${u.disabled} ` +
              `lastLogin=${u.lastLoginAt === null ? 'never' : new Date(u.lastLoginAt).toISOString()}` +
              (locked ? ` LOCKED until ${new Date(u.lockedUntil ?? 0).toISOString()}` : ''),
          )
        }
        break
      }
    }
  } finally {
    await mongo.close()
  }
}

async function obtainPassword(fromFlag: string | undefined): Promise<string> {
  if (fromFlag !== undefined) {
    console.error('warning: --password is visible in shell history and in `ps`; prefer the prompt')
    return assertPassword(fromFlag)
  }
  const first = await readHidden('password: ')
  // Only a TTY is asked to confirm: piped stdin has already ended, a second read would hang.
  if (process.stdin.isTTY !== true) return assertPassword(first)
  const second = await readHidden('confirm : ')
  if (first !== second) throw new Error('passwords do not match')
  return assertPassword(first)
}

/** A line without echo (raw mode); piped input is taken as its first line. */
function readHidden(prompt: string): Promise<string> {
  const input = process.stdin
  if (input.isTTY !== true) {
    return new Promise<string>((resolve, reject) => {
      let data = ''
      input.setEncoding('utf8')
      input.on('data', (chunk: string) => { data += chunk })
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
        if (ch === '\r' || ch === '\n' || ch === '\u0004') { finish(() => resolve(buf)); return }
        // Ctrl-C in raw mode is not a SIGINT; handle it or the only exit is killing the terminal.
        if (ch === '\u0003') { finish(() => reject(new Error('cancelled'))); return }
        if (ch === '\u007f' || ch === '\b') buf = buf.slice(0, -1)
        else buf += ch
      }
    }
    input.on('data', onData)
  })
}

export function reportError(err: unknown): void {
  if (err instanceof DuplicateUser || err instanceof InvalidUsername || err instanceof WeakPassword) {
    console.error(err.message)
    return
  }
  console.error(err instanceof Error ? err.message : String(err))
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((err: unknown) => {
    reportError(err)
    process.exit(1)
  })
}
