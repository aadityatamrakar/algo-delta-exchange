#!/usr/bin/env node
/**
 * Drop this deployment's desk data. For starting a server clean.
 *
 * WHY THIS EXISTS RATHER THAN A README LINE: the collections that must go and
 * the ones that must not are not guessable from their names. `positional` looks
 * like ours and is the LEGACY live order log — the old system's record, and
 * nothing new writes it. `instrument` looks precious and is a cache. Getting
 * that backwards either destroys history or leaves a test position on a
 * production desk.
 *
 * It refuses to run without `--yes`, and prints what it will do first, because
 * the failure mode is silent and permanent.
 */

import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

/** Wiped. Everything this deployment has done. */
const DESK_DATA = [
  'desk-books',
  'desk-decisions',
  'desk-submissions',
  'desk-gateway-orders',
  'desk-paper-trade',
  'desk-fills',
  'desk-order-events',
  'desk-declarations',
  'desk-pnl-snapshots',
  'desk-daily-reports',
  'desk-safety',
  'desk-strategy-runtime',
  'desk-subscriptions',
  'desk-marks',
  /**
   * THE NATIVE SUPERVISOR'S OWN STATE (spec §9), added with the D9 cutover.
   *
   * These four are what the retired Python supervisor kept in `data/desk/*` on
   * the box — file state a reset never touched, because a reset only ever knew
   * about Mongo. They are IN Mongo now, which means a "clean" deployment that
   * did not drop them would boot the supervisor onto the last run's protected
   * lots, its in-flight decision ids and a lease held by a process that no
   * longer exists. That is worse than the old gap, not better: a reset that
   * leaves half the desk's memory behind is one whose result nobody can
   * describe.
   *
   *   desk-supervisor-state    per-book protected lots, in-flight ids, latches
   *   desk-engine-decisions    what the supervisor asked for, in its own words
   *   desk-supervisor-lease    which process is steering — see the note below
   *   desk-book-marks          one row per book per 5-minute mark
   *
   * THE LEASE IS SAFE TO DROP AND NOT SAFE TO KEEP. It is a heartbeat with a
   * TTL, so a dropped one is re-acquired within seconds by whoever is running;
   * a KEPT one on a database that has been emptied is a claim over books that
   * no longer exist. And this script already refuses to run without `--yes`,
   * which is the point at which somebody has decided the deployment is going.
   */
  'desk-supervisor-state',
  'desk-engine-decisions',
  'desk-supervisor-lease',
  'desk-book-marks',
]

/** Wiped only with --all: accounts and broker credentials. */
const CREDENTIALS = ['desk-users', 'desk-sessions', 'desk-brokers']

/**
 * Wiped, and regenerated at the next boot from `registry-seed.ts`.
 *
 * Separate from DESK_DATA because dropping it is how you discard an operator's
 * switches — every row comes back OFF, in paper only. On a fresh server that is
 * exactly right; on a live one it is a silent mass-disable.
 */
const REGISTRY = ['desk-strategies']

/**
 * NEVER dropped here.
 *
 * `instrument` and `desk-freeze-limits` are caches — `make sync` rebuilds them
 * from the exchange, and dropping them just means the desk cannot resolve a
 * contract until it has. `positional` is the LEGACY live order log: historical
 * evidence of real trades, which nothing in the new system writes and nobody
 * can reconstruct.
 */
const NEVER = ['instrument', 'desk-freeze-limits', 'positional']

async function main() {
  const args = process.argv.slice(2)
  const yes = args.includes('--yes')
  const all = args.includes('--all')
  const url = process.env['DESK_MONGO_URL']

  if (url === undefined || url.trim() === '') {
    console.error('DESK_MONGO_URL is required')
    process.exit(1)
  }

  const targets = [...DESK_DATA, ...REGISTRY, ...(all ? CREDENTIALS : [])]

  const mongo = require('mongodb')
  const client = await mongo.MongoClient.connect(url, {
    useUnifiedTopology: true,
    serverSelectionTimeoutMS: 5000,
  })
  const db = client.db()

  const present = new Set((await db.listCollections().toArray()).map((c) => c.name))
  const counts = []
  for (const name of targets) {
    if (!present.has(name)) continue
    counts.push([name, await db.collection(name).countDocuments()])
  }

  console.log(`\ndatabase: ${url.replace(/\/\/[^@]*@/, '//***@')}\n`)
  if (counts.length === 0) {
    console.log('nothing to drop — this deployment is already clean\n')
  } else {
    console.log('WILL DROP:')
    for (const [name, n] of counts) console.log(`  ${String(n).padStart(8)}  ${name}`)
  }
  if (!all) {
    console.log('\nKEEPING (pass --all to drop these too):')
    for (const name of CREDENTIALS) {
      if (present.has(name)) console.log(`  ${String(await db.collection(name).countDocuments()).padStart(8)}  ${name}`)
    }
  }
  console.log('\nNEVER DROPPED — caches rebuilt by `make sync`, and the legacy order log:')
  for (const name of NEVER) {
    if (present.has(name)) console.log(`  ${String(await db.collection(name).countDocuments()).padStart(8)}  ${name}`)
  }

  if (!yes) {
    console.log('\nDry run. Re-run with --yes to actually drop.\n')
    await client.close()
    return
  }

  for (const [name] of counts) {
    await db.collection(name).drop()
    console.log(`dropped ${name}`)
  }
  await client.close()
  console.log(
    '\nDone. Next boot re-seeds the strategy registry (every row OFF, paper only).' +
      (all ? '\nCreate an operator: node bin/desk-user.mjs create <username>\n' : '\n'),
  )
}

main().catch((err) => {
  console.error('[reset] fatal', err)
  process.exit(1)
})
